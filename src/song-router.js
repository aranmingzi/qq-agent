// 点歌路由器：先看「手上有什么素材」，再决定这首歌该怎么唱。
//
// 为什么需要这一层
// ----------------
// 之前的工具是并列的：sing_lyrics（歌词→算法旋律）和 sing_cover（原曲→RVC）。
// 模型靠 description 自己猜该用哪个，结果很糟：
//   * 群友说「唱反方向的钟」，明明 songs/raw/ 里就有原曲，却走了 sing_lyrics，
//     用算法编一个完全不像的调 —— 听众第一反应是「这根本不是这首歌」；
//   * 反过来，只有歌词的时候模型偶尔会去调 cover，找不到文件再失败。
//
// 判据其实非常确定，不该交给模型猜：
//   有原曲音频  → 翻唱（RVC 跟原唱的音准/节奏/颤音，天然完美）
//   只有歌词    → DiffSinger；旋律库里有这首就按原曲旋律，没有才算法生成
//
// 这个模块只做决策，不执行。执行分别落在 song-jobs.js（队列）里。
//
// 匹配规则为什么这么写
// --------------------
// 群友不会精确报文件名：「唱个反方向的钟」「来首《反方向的钟》dj版」。
// 所以要剥掉书名号/标点/常见后缀，再做「完全相等 → 包含 → 二元组重合度」三级匹配。
// 二元组（bigram）重合度对中文短名字够用，且比 Levenshtein 更不容易被单字差异骗到。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { PLAYLIST_DIR, searchTracks } from './playlist.js';

const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.ape']);

// 扫描顺序即优先级：songs/raw 是「正式曲库」，songs/ 根目录是随手放的，
// background_music 里是历史分离产物（只剩伴奏，翻唱价值低，放最后兜底）。
const SONG_DIRS = [
  { dir: path.join(ROOT, 'songs', 'raw'), priority: 3 },
  { dir: path.join(ROOT, 'songs'), priority: 2 },
  { dir: path.join(ROOT, 'background_music'), priority: 1 },
];

// 这些是链路中间产物，不是「一首歌」。拿它们去翻唱只会得到一段破碎音频。
const ARTIFACT_RE = /(-vocal\d*|-vocals?\b|-seg\d*|-hp\b|-chorus|-rvc\b|-f0\b|_st\d+|_路线A_|\binst\b|^test-|\.norm\b|-16k\b|^queue-)/i;

const MELODY_DIR = path.join(ROOT, 'songs', 'melodies');

/** 旋律库里已有的曲名（读 index.json，缺失时列目录）。 */
export function listMelodyNames() {
  try {
    const idx = path.join(MELODY_DIR, 'index.json');
    if (fs.existsSync(idx)) {
      return Object.keys(JSON.parse(fs.readFileSync(idx, 'utf8')));
    }
    return fs.readdirSync(MELODY_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * 读 flac 头里 STREAMINFO 的时长（秒）。非 flac / 读失败返回 0。
 *
 * 为什么要它：曲库现在会收无损 flac（酷狗解密出来的原文件就是 flac），
 * 而下面「<25 秒的明显是片段，别进曲库」这条过滤只对 wav 生效过 ——
 * 不补的话，一段 10 秒的 flac 试听也会被当成一首歌参与匹配。
 * 只读文件头 64 字节，扫描曲库时不会变慢。
 */
function flacSeconds(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    if (head.toString('ascii', 0, 4) !== 'fLaC') return 0;
    // head[4] = 首个 metadata block 头（1 bit last + 7 bit type），STREAMINFO 必须是 type 0；
    // 紧接 3 字节长度（固定 34）—— 所以 STREAMINFO 数据从 **head[8]** 开始，
    // 别再按「1 字节 header」去数，会整体错 3 字节，算出来的时长能差到几千万秒。
    if ((head[4] & 0x7f) !== 0) return 0;
    // min/max blocksize(2+2) + min/max framesize(3+3) 共 10 字节，采样信息在第 18 字节
    const b = head.subarray(18, 26);
    const sr = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
    // 36 bit 总采样数：高 4 位在 b[3] 低半字节，必须用乘法（<<32 会溢出成 32 位）
    const total = (b[3] & 0x0f) * 0x100000000 + b.readUInt32BE(4);
    if (!sr || !total) return 0;
    return total / sr;
  } catch {
    return 0;
  }
}

/** 读 wav 头里的时长（秒）。非 wav / 读失败返回 0。 */
function wavSeconds(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    if (head.toString('ascii', 0, 4) !== 'RIFF') return 0;
    let off = 12;
    let byteRate = 0;
    let dataLen = 0;
    // 只扫前 64 字节不够（fmt 块可能更靠后），退化为按文件大小估算
    if (head.toString('ascii', 12, 16) === 'fmt ') byteRate = head.readUInt32LE(28);
    const size = fs.statSync(file).size;
    if (byteRate > 0) {
      dataLen = size - 44;
      return dataLen / byteRate;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** 扫描本地可翻唱曲目。结果按优先级 + 时长降序，短于 25 秒的中间产物会被过滤。 */
let _songsCache = { at: 0, list: [] };

export function listLocalSongs({ ttlMs = 10000, fresh = false } = {}) {
  if (!fresh && Date.now() - _songsCache.at < ttlMs) return _songsCache.list;
  const out = [];
  const seen = new Set();
  for (const { dir, priority } of SONG_DIRS) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      if (ARTIFACT_RE.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const key = path.resolve(full);
      if (seen.has(key)) continue;
      const base = e.name.slice(0, -ext.length);
      // 同名的 raw 优先，不重复收录
      const nameKey = `${base}`.toLowerCase();
      if (seen.has('name:' + nameKey)) continue;
      const durSec = ext === '.wav' ? Math.round(wavSeconds(full) * 10) / 10
        : ext === '.flac' ? Math.round(flacSeconds(full) * 10) / 10
          : 0;
      if (durSec > 0 && durSec < 25) continue; // 明显是片段
      seen.add(key);
      seen.add('name:' + nameKey);
      out.push({ path: full, base, nameKey, ext, durSec, priority });
    }
  }
  const sorted = out.sort((a, b) => (b.priority - a.priority) || (b.durSec - a.durSec));
  _songsCache = { at: Date.now(), list: sorted };
  return sorted;
}

/** 归一化：去书名号/引号/标点/空白，小写，去掉「dj版」这类尾巴。 */
function normalize(s) {
  return String(s || '')
    .replace(/[《》「」【】《》"'“”‘’]/g, '')
    .replace(/\.(wav|mp3|flac|m4a|ogg|aac)$/i, '')
    .replace(/[_\-—]+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(dj|live|伴奏|翻唱|完整版|高音质|原唱|铃声)版?$/i, '')
    .replace(/[\s，。！？、；：,.!?;:~·…]/g, '')
    .toLowerCase()
    .trim();
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** 两个名字的相似度 0~1。1=完全相等。 */
export function nameScore(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return 0.78 + 0.12 * (Math.min(x.length, y.length) / Math.max(x.length, y.length));
  }
  const bx = bigrams(x);
  const by = bigrams(y);
  if (!bx.size || !by.size) return 0;
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter += 1;
  const dice = (2 * inter) / (bx.size + by.size);
  return dice >= 0.45 ? dice * 0.8 : 0;
}

/**
 * 在本地曲库里找这首歌。
 * @returns {{path, base, score, durSec}|null} 相似度 ≥ 阈值才返回。
 */
export function findLocalSong(title, { minScore = 0.55 } = {}) {
  if (!title) return null;
  let best = null;
  for (const s of listLocalSongs()) {
    const score = nameScore(title, s.base);
    if (score >= minScore && (!best || score > best.score)) best = { ...s, score: Math.round(score * 100) / 100 };
  }
  return best;
}

/**
 * 点歌台（B站缓存）也是曲库 —— 这是「群友报的歌名能唱成」的关键补强。
 *
 * 没有它时曲库只有 songs/raw 里那一两首，群友随便报个歌名 99% 命中不了，
 * 于是要么算法现编（=乱唱），要么让群友发文件（而群文件还常常取不到）。
 * 点歌台里躺着 20+ 首缓存好的原曲，本来就能直接当翻唱素材。
 *
 * 注意 ensureMp3 可能会当场转码（几秒到半分钟），所以这是异步的。
 * @returns {Promise<{path, base, title, artist, fromPlaylist:true, score}|null>}
 */
export async function findSongInPlaylist(title) {
  const q = String(title || '').trim();
  if (!q) return null;
  try {
    const { resolvePlayQuery } = await import('./playlist.js');
    const { ensureMp3 } = await import('./playback.js');
    const r = resolvePlayQuery(q, { includeCollections: false });
    // 只要「确认命中」的结果：宁可放过，也别把《A》翻成《B》
    if (!r?.track || (r.reason !== 'exact' && r.reason !== 'bvid' && r.reason !== 'index')) return null;
    const file = await ensureMp3(r.track);
    if (!file || !fs.existsSync(file)) return null;
    return {
      path: file,
      base: r.track.title,
      title: r.track.title,
      artist: r.track.artist || '',
      fromPlaylist: true,
      score: 1,
    };
  } catch {
    return null;   // 点歌台没起来/没缓存/转码失败 → 当作没有，不影响主流程
  }
}

/** 本地曲库优先，没有再退到点歌台缓存。 */
export async function resolveSongSource(title) {
  return findLocalSong(title) || await findSongInPlaylist(title);
}

/**
 * 同步版点歌台查找：只认「已经转好码躺在 data/playlist/audio 里」的，不触发转码。
 * 队列里（submitSing）要用它 —— 那里不能 await，否则工具就不是秒回了。
 * 转码由调用方（tools 层）先做完，队列这边只要能找到文件就行，
 * 否则会出现「工具说按原曲唱、队列里其实在现编」的不一致。
 */
export function findCachedPlaylistAudio(title) {
  const q = String(title || '').trim();
  if (!q) return null;
  try {
    const hits = searchTracks(q, { limit: 3, includeCollections: false });
    const top = hits[0];
    if (!top || top.score < 0.9) return null;
    const file = path.join(PLAYLIST_DIR, 'audio', `${top.track.id}.mp3`);
    if (!fs.existsSync(file)) return null;
    return { path: file, base: top.track.title, title: top.track.title, fromPlaylist: true, score: top.score };
  } catch {
    return null;
  }
}

/** 在旋律库里找这首歌。 */
export function findMelody(title, { minScore = 0.55 } = {}) {
  if (!title) return null;
  let best = null;
  for (const name of listMelodyNames()) {
    const score = nameScore(title, name);
    if (score >= minScore && (!best || score > best.score)) best = { name, score: Math.round(score * 100) / 100 };
  }
  return best;
}

/**
 * 决定这次点歌该怎么唱。
 *
 * @param {object} req
 * @param {string} [req.title]   群友报的歌名（可能很随意）
 * @param {string} [req.src]     已明确的音频路径/直链
 * @param {string} [req.lyrics]  已提供的歌词
 * @param {boolean}[req.forceLyrics] 明确要求「只唱这段词」（跳过原曲路由）
 * @returns {{route:'cover'|'sing', src?:string, title?:string, melody?:string,
 *            melodyTrans?:number, reason:string, confidence:number, local?:object}}
 */
export function planSongRequest({ title = '', src = '', lyrics = '', forceLyrics = false } = {}) {
  const wanted = String(title || '').trim();

  // 1) 明确指出音频 → 翻唱，不犹豫
  if (src) {
    return {
      route: 'cover',
      src,
      title: wanted || path.basename(String(src)).replace(/\.[^.]+$/, ''),
      reason: '已指定音频，走原曲翻唱（RVC 跟原唱的音准与节奏）',
      confidence: 1,
    };
  }

  // 2) 报了歌名 → 先看本地有没有原曲
  if (wanted) {
    const local = findLocalSong(wanted);
    if (local && !forceLyrics) {
      return {
        route: 'cover',
        src: local.path,
        title: local.base,
        local,
        reason: `本地曲库里有《${local.base}》（匹配度 ${local.score}），走原曲翻唱比算法旋律准得多`,
        confidence: local.score,
      };
    }
    const mel = findMelody(wanted);
    if (mel) {
      return {
        route: 'sing',
        title: wanted,
        melody: mel.name,
        reason: `旋律库里有《${mel.name}》（匹配度 ${mel.score}），按原曲旋律唱，但没有原曲音频所以不是 RVC 换声`,
        confidence: mel.score,
      };
    }
    if (local) {
      return {
        route: 'sing',
        title: wanted,
        melody: '',
        local,
        reason: `本地有原曲但这次要求按歌词唱，用算法旋律`,
        confidence: 0.6,
      };
    }
  }

  // 3) 什么都没有 → 算法旋律（并且必须如实告知听起来不像原曲）
  return {
    route: 'sing',
    title: wanted,
    melody: '',
    reason: wanted
      ? `本地曲库和旋律库都没有《${wanted}》，只能用算法生成旋律（如实告知不是原曲）`
      : '只有歌词没有歌名，用算法生成旋律',
    confidence: 0.2,
  };
}

/** 给日志/控制台用的一句话摘要。 */
export function describePlan(plan) {
  if (!plan) return '(无)';
  const t = plan.title ? `《${plan.title}》` : '这段';
  if (plan.route === 'cover') return `翻唱 ${t} ← ${path.basename(plan.src || '')}`;
  return `${t} 演唱${plan.melody ? `（旋律《${plan.melody}》）` : '（算法旋律）'}`;
}
