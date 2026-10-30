// 实时扒谱：从「群友点的那首原曲」里提取旋律，直接喂给 DiffSinger。
//
// 为什么要有这一层
// ----------------
// 以前的顺序是「先有人手动扒好、放进 songs/melodies/，点歌才能按原曲唱」。
// 旋律库里永远只有两首，等于 99% 的歌只能走算法旋律——听起来根本不是那首歌。
//
// 现在改成：点歌时若只有歌名 + 歌词、旋律库里又没有这首，就在**队列作业里**
// 现场从原曲扒一段（Demucs 分离人声 → CREPE F0 → 音符切分 → melody v2），
// 拿到谱面后直接传给 sing_engine。用户不用知道「旋律库」这回事。
//
// 三个必须处理的现实问题
// ----------------------
// 1) **从哪一段扒**：群友不会报第几秒。默认从 0 秒开始扒到的是前奏，
//    谱面只有几个音，铺到整段歌词上会变成另一首歌。所以默认 `--auto-window`，
//    由 Python 侧按人声频段能量自动挑一段（见 melody_extract.pick_window）。
// 2) **扒得准不准**：说话式主歌的音高会卡在两个半音之间，量化必然抖。
//    脚本会给出 `pitch_fit`（帧 F0 与所属音符相差 <0.5 半音的比例），
//    低于 MIN_FIT 时宁可**不用**、回退算法旋律，也不要用一个跑调的谱糊弄。
// 3) **别重复烧 GPU**：同一首歌同一段扒过一次就落盘缓存（内容寻址），
//    第二次点歌 0 秒拿到；同时用 inflight 表防止并发重复跑。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { runProcess } from './sing-song.js';

const PY310 = path.join(ROOT, 'rvc', 'py310', 'python.exe');
const SCRIPT = path.join(ROOT, 'diffsinger-hutao', 'melody_extract.py');
const CACHE_DIR = path.join(ROOT, 'cache', 'melody');

/** 低于这个解释率就不值得用（宁可用算法旋律，至少不跑调）。 */
export const MIN_FIT = 0.62;
/** 高于这个解释率可以认为「这段能代表原曲」。 */
export const GOOD_FIT = 0.78;

const inflight = new Map();

export function melodyAutoReady() {
  return fs.existsSync(PY310) && fs.existsSync(SCRIPT);
}

/** 文件指纹：路径 + 大小 + mtime（改文件即失效）。 */
function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${Math.round(st.size)}_${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

/**
 * 缓存键：原曲指纹 + 窗口 + 扒谱参数版本。
 * 不含歌词——谱面只跟音频和窗口有关，换一段词可以复用同一份旋律。
 */
export function melodyCacheKey({ src, start = 0, dur = 24, separate = true }) {
  // separate 必须进键：同一段音频「先分离再扒」和「直接当人声扒」结果不同，
  // 不区分的话哼唱（不分离）会命中原曲（分离）的旧谱。
  const raw = ['mel-v2', path.resolve(String(src)), stamp(src), start, dur,
    separate ? 'sep' : 'raw'].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * 自动选一个窗口长度：按字数估，够唱完就行。
 * 太长浪费 Demucs 时间，太短会把歌词循环太多遍（听起来像卡带）。
 */
export function windowForLyrics(charCount = 20) {
  const sec = Math.round(charCount * 0.8 + 6);
  return Math.min(36, Math.max(14, sec));
}

function readMeta(key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${key}.meta.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 谱面里的 name 决定日志/文案怎么称呼它。缓存是按音频算的、不含歌名，
 * 所以同一段音频换个歌名点歌时，这里把显示名改过来即可，不用重扒。
 */
function ensureMelodyName(jsonPath, title) {
  try {
    const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (d.name === title) return;
    d.name = title;
    fs.writeFileSync(jsonPath, JSON.stringify(d, null, 1), 'utf8');
  } catch { /* 显示名不影响渲染，失败就算了 */ }
}

function writeMeta(key, meta) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${key}.meta.json`), JSON.stringify(meta, null, 1));
  } catch { /* 缓存写失败不影响主流程 */ }
}

/**
 * 从原曲扒一段旋律。
 *
 * @param {object} p
 * @param {string} p.src        原曲路径（本地文件）
 * @param {string} [p.title]    歌名（只用于日志/文案）
 * @param {number} [p.start]    明确起点；不给就自动选段
 * @param {number} [p.dur]      窗口长度
 * @param {AbortSignal} [p.signal]
 * @param {function} [p.log]
 * @param {function} [p.onProgress]  ({pct, msg})
 * @returns {Promise<{ok:boolean, path?:string, title?:string, bpm?:number,
 *                    notes?:number, quality?:object, cached?:boolean,
 *                    costMs?:number, reason?:string}>}
 */
export async function extractMelodyForSong({
  src, title = '', start = null, dur = null, signal = null, log = () => {}, onProgress = null,
  // separate=false：输入已经是纯人声（群友哼唱/清唱片段），跳过 Demucs 直接扒，省 1 分钟
  separate = true,
} = {}) {
  if (!melodyAutoReady()) {
    return { ok: false, reason: '扒谱环境未就绪（缺 rvc/py310 或 melody_extract.py）' };
  }
  if (!src || !fs.existsSync(src)) {
    return { ok: false, reason: `找不到原曲文件：${src || '(空)'}` };
  }

  const win = Number(dur) || windowForLyrics(20);
  const auto = start === null || start === undefined || Number.isNaN(Number(start));
  const key = melodyCacheKey({ src, start: auto ? 'auto' : Number(start), dur: win, separate });
  const jsonPath = path.join(CACHE_DIR, `${key}.json`);
  const label = title || path.basename(src).replace(/\.[^.]+$/, '');

  // ── 1) 命中缓存 ──
  const cachedMeta = readMeta(key);
  if (cachedMeta && fs.existsSync(jsonPath)) {
    const fit = Number(cachedMeta.quality?.pitch_fit ?? 0);
    if (fit >= MIN_FIT) {
      ensureMelodyName(jsonPath, label);
      log(`[扒谱] 复用上次结果《${label}》（解释率 ${Math.round(fit * 100)}%）`);
      onProgress?.({ pct: 30, msg: '复用上次扒的旋律' });
      return {
        ok: true, cached: true, path: jsonPath, title: label,
        bpm: cachedMeta.bpm, notes: cachedMeta.notes, quality: cachedMeta.quality,
        costMs: 0,
      };
    }
    log(`[扒谱] 上次这段只有 ${Math.round(fit * 100)}% 解释率，换一段重扒`);
  }

  // ── 2) 同一段已经在跑：等它，不重复开一个 Demucs ──
  if (inflight.has(key)) {
    log('[扒谱] 已有相同任务在跑，等它完成');
    return inflight.get(key);
  }

  const task = (async () => {
    const t0 = Date.now();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const reportPath = path.join(CACHE_DIR, `${key}.quality.json`);
    const args = [
      SCRIPT,
      '--src', path.resolve(src),
      // 已经是纯人声就别再跑 Demucs（省 40~60 秒，也避免分离把哼唱削坏）
      ...(separate ? ['--separate'] : []),
      '--name', `mel-${key}`,          // 分离目录名，用 hash 避免不同歌互相覆盖
      '--title', label,                 // 谱面里显示的歌名
      '--dur', String(win),
      '--out', jsonPath,
      '--report', reportPath,
      '--no-index',
    ];
    if (auto) args.push('--auto-window');
    else args.push('--start', String(Number(start)));

    onProgress?.({ pct: 10, msg: auto ? '找原曲里最像副歌的一段' : '准备扒谱' });

    // 超时按窗口长度放宽：Demucs 约 1×实时，CREPE 约 0.3×实时（不分离时省掉 Demucs）
    const timeout = (separate ? 180000 : 60000) + win * 2500;
    const r = await runProcess(PY310, args, {
      timeout,
      cwd: path.join(ROOT, 'diffsinger-hutao'),
      signal,
      onLine: (line) => {
        log(line);
        if (/自动选段/.test(line)) onProgress?.({ pct: 16, msg: '选定扒谱段落' });
        else if (/分离人声/.test(line)) onProgress?.({ pct: 22, msg: '分离人声（Demucs）' });
        else if (/F0|调音偏差/.test(line)) onProgress?.({ pct: 62, msg: '提取音高（CREPE）' });
        else if (/切出|含 rest/.test(line)) onProgress?.({ pct: 78, msg: '切分音符' });
        else if (/✅ 写入/.test(line)) onProgress?.({ pct: 90, msg: '生成谱面' });
      },
    });

    if (r.status !== 0 || !fs.existsSync(jsonPath)) {
      const tail = String(r.stderr || r.stdout || '').replace(/\s+/g, ' ').slice(-180);
      return { ok: false, reason: (r.timedOut ? '扒谱超时：' : '扒谱失败：') + tail };
    }

    ensureMelodyName(jsonPath, label);
    let mel = null;
    let q = null;
    try { mel = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { /* 下面兜底 */ }
    try { q = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { q = mel?.source?.quality || null; }

    const fit = Number(q?.pitch_fit ?? 0);
    const meta = {
      key, title: label, src: path.resolve(src), auto, dur: win, separate,
      bpm: mel?.bpm ?? null,
      notes: (mel?.notes || []).filter((n) => !n.rest).length,
      quality: q || {},
      at: new Date().toISOString(),
    };
    writeMeta(key, meta);

    if (fit < MIN_FIT) {
      log(`[扒谱] 解释率 ${Math.round(fit * 100)}% 太低，不用这段谱`);
      return {
        ok: false,
        reason: q?.warnings?.length ? q.warnings.join('；') : '这一段扒不准（音高解释率过低）',
        quality: q,
      };
    }

    log(`[扒谱] 完成《${label}》：${meta.notes} 音，解释率 ${Math.round(fit * 100)}%，`
      + `BPM ${meta.bpm}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    onProgress?.({ pct: 92, msg: '谱面就绪' });
    return {
      ok: true, cached: false, path: jsonPath, title: label,
      bpm: meta.bpm, notes: meta.notes, quality: q, costMs: Date.now() - t0,
    };
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}
