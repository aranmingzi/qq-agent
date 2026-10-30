// 歌词 → 演唱 编排模块
//
// 能力边界（重要，勿伪造）：
//   当前有两套「唱歌」能力：
//   ① DiffSinger（SVS 真唱，首选）：歌词 + 旋律 → 胡桃按谱真唱。
//      声库在 diffsinger-hutao/hu2_tao2/，渲染走 diffsinger-env 的 sing_hutao.py。
//   ② TTS → SVC（降级）：歌词 → TTS 念词 → 换胡桃音色（念白式轻唱）。
//
// 降级优先级：
//   A. 有参考音频 → 直接 SVC 换音色（sing_convert 已覆盖）
//   B. 只有歌词   → DiffSinger 真唱（singLyrics 默认）；失败降级 TTS→SVC
//   C. 都失败      → 明说「只能念不能唱」+ 纯 TTS

import { synthesizeSpeech } from './qwen-audio.js';
import { convertSinging, svcConfig } from './svc-voice.js';
import { stopRvcService, ensureRvcService, rvcStatus } from './rvc-voice.js';
import { ddspConfig, ensureDdspService, stopDdspService } from './ddsp-voice.js';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './config.js';
import { wavDurationSec } from './util.js';
import { resolveFfmpeg } from './media-tools.js';

/**
 * 异步跑子进程，逐行回调输出。
 *
 * ★ 这里绝不能用 spawnSync：DiffSinger 渲染一句要 20~150 秒，
 *   spawnSync 会把 Node 的事件循环整个冻住 —— 期间收不到任何 QQ 消息、
 *   发不出任何进度、心跳也可能被判超时。改成 async spawn 是异步队列能成立的前提。
 *
 * Windows 注意：不要 detached（会导致 stdio 管道收不到输出），用 windowsHide。
 */
export function runProcess(cmd, args, { timeout = 600000, cwd = null, onLine = null, signal = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // PYTHONUTF8=1 必须显式给：diffsinger-env 的 voice_bank 读 character.txt 时
      // 用系统默认编码（中文 Windows=GBK），不设就会 UnicodeDecodeError。
      child = spawn(cmd, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      });
    } catch (e) {
      resolve({ status: -1, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let buf = '';
    const feed = (chunk) => {
      if (!onLine) return;
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (t) { try { onLine(t); } catch { /* 回调异常不能中断渲染 */ } }
      }
    };
    child.stdout?.on('data', (d) => { const s = String(d); stdout = (stdout + s).slice(-8000); feed(s); });
    child.stderr?.on('data', (d) => { const s = String(d); stderr = (stderr + s).slice(-8000); feed(s); });

    let timer = null;
    let timedOut = false;
    const kill = () => { try { child.kill(); } catch { /* ignore */ } };
    if (timeout > 0) {
      timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      timer.unref?.();
    }
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: stderr + '\n' + String(e?.message ?? e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim() && onLine) { try { onLine(buf.trim()); } catch { /* ignore */ } }
      resolve({ status: code, stdout, stderr, timedOut });
    });
  });
}

// DiffSinger 相关路径
const DS_DIR = path.join(ROOT, 'diffsinger-hutao');
const DS_PY = path.join(ROOT, 'diffsinger-env', 'Scripts', 'python.exe');
const DS_SING = path.join(DS_DIR, 'sing_engine.py');

// 可用角色（DiffSinger 声库）
export const SINGER_ALIASES = {
  'hutao': 'hutao', '胡桃': 'hutao',
  'nahida': 'nahida', '纳西妲': 'nahida', '草神': 'nahida',
  'robin': 'robin', '知更鸟': 'robin',
  'sparkle': null, '花火': null,  // 花火 DiffSinger 声库未下载
  'liuying': null, '流萤': null,   // 流萤/芙宁娜/神里绫华 只有 GPT-SoVITS 念白模型，没有 DiffSinger 唱歌声库
  'furina': null, '芙宁娜': null,
  'ayaka': null, '神里绫华': null,
};

/** DiffSinger 真唱引擎是否就绪（python + sing_engine.py + 声库）。 */
export function diffSingerReady() {
  try {
    return fs.existsSync(DS_PY) && fs.existsSync(DS_SING) && fs.existsSync(path.join(DS_DIR, 'hu2_tao2'));
  } catch {
    return false;
  }
}

/** wav 44.1kHz → 16kHz 单声道（QQ 语音条标准）。失败则原样返回。 */
export function toVoice16k(buffer) {
  const outFile = path.join(ROOT, 'data', 'voice', '_16k_' + Date.now() + '.wav');
  const inFile = path.join(ROOT, 'data', 'voice', '_in_' + Date.now() + '.wav');
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(inFile, buffer);
    // ffmpeg 走统一解析（media-tools），不再写死某台机器上的第三方路径
    const ff = resolveFfmpeg();
    const r = spawnSync(ff, ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', outFile], { timeout: 30000 });
    if (r.status === 0 && fs.existsSync(outFile)) return fs.readFileSync(outFile);
  } catch {
    // 忽略
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
  return buffer;
}

/** 用 DiffSinger 声库真唱一句歌词（自然旋律 + 自动伴奏 + 高音质 44.1kHz 输出）。
 *  @returns {Promise<{buffer, ext, seconds, costMs} | {reason}>}
 */
export async function singWithDiffSinger(text, { voice = 'hutao', key = 'B3', bpm = 92, scale = 'major', withAcc = true, log = null, vc = false, vcIndexRate = 0.8, vcProtect = 0.4, vcEnhance = 0, vcEngine = 'rvc', ddspUrl = 'http://127.0.0.1:3213', melody = '', melodyLabel = '', melodyTrans = 0, device = 'auto', onLine = null, signal = null } = {}) {
  if (!fs.existsSync(DS_PY) || !fs.existsSync(DS_SING)) {
    return { reason: 'DiffSinger 引擎未就绪（缺 python 或 sing_engine.py）' };
  }
  const outFile = path.join(DS_DIR, 'work', 'sing-' + Date.now() + '.wav');
  // 换音色引擎：ddsp=知更鸟 DDSP-SVC。显存只有 4GB，二者不能同时常驻：
  // 唱歌前停 RVC，DDSP 起不来就自动退回 RVC，唱完再把 RVC 拉回来。
  let engine = vc ? (vcEngine === 'ddsp' ? 'ddsp' : 'rvc') : 'rvc';
  let stoppedRvc = false;
  if (vc && engine === 'ddsp') {
    const pre = await rvcStatus().catch(() => null);
    if (pre && pre.health && pre.health.loaded) {
      stopRvcService({ force: true });
      stoppedRvc = true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const ready = await ensureDdspService({ log });
    if (!ready.ok) {
      engine = 'rvc';
      if (log) log('DDSP 不可用，改用 RVC：' + (ready.reason || ''));
      if (stoppedRvc) {
        await ensureRvcService({ log: null, force: true }).catch(() => null);
        stoppedRvc = false;
      }
    }
  }
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const args = [
      DS_SING,
      '--lyrics', text,
      '--voice', voice,
      '--key', key,
      '--scale', scale,
      '--out', outFile,
    ];
    // 有旋律时不要传 --bpm：让旋律自带的 BPM 说了算（v2 谱面是按原曲 tempo 记的拍）。
    // 传了会把 95.7 BPM 的谱按 92 唱，等于整首慢半拍。
    if (!melody) args.push('--bpm', String(bpm));
    if (!withAcc) args.push('--no-acc');
    // ONNX 推理设备：auto=能用 CUDA 就用（声学模型+声码器上 GPU，实测快 3~5 倍）
    if (device && device !== 'auto') args.push('--device', String(device));
    // 按指定旋律唱（旋律库里的歌名，或 melody json 路径）；不给就算法生成旋律
    if (melody) {
      args.push('--melody', String(melody));
      if (Number(melodyTrans)) args.push('--melody-trans', String(Math.round(Number(melodyTrans))));
    }
    // 干声过 RVC 换胡桃真人音色（在混伴奏之前，只换人声）
    if (vc) {
      args.push('--vc', '1', '--vc-index-rate', String(vcIndexRate),
        '--vc-protect', String(vcProtect), '--vc-enhance', String(vcEnhance));
      if (engine === 'ddsp') args.push('--vc-engine', 'ddsp', '--ddsp-url', ddspUrl);
    }
    const t0 = Date.now();
    // 超时放宽到 10 分钟：以前 180s，唱一整段（20+ 字）渲染要 150s+，
    // 一到点就被判失败降级成念白 —— 群里表现为「唱不出来」。
    const r = await runProcess(DS_PY, args, { timeout: 600000, cwd: DS_DIR, onLine, signal });
    const costMs = Date.now() - t0;
    if (r.status !== 0 || !fs.existsSync(outFile)) {
      const msg = (r.stderr || r.stdout || '').slice(-300);
      return { reason: (r.timedOut ? 'DiffSinger 渲染超时：' : 'DiffSinger 渲染失败：') + msg };
    }
    const buffer = fs.readFileSync(outFile);
    // 时长按 RIFF 头算（byteRate），不按位深假设。历史上按 16k 估算虚高 2.75 倍，
    // 导致 20 秒的歌被误判成 55 秒而转成文件发送。
    const sec = wavDurationSec(buffer) || buffer.length / 44100 / 2;
    return { buffer, ext: 'wav', seconds: Math.round(sec * 10) / 10, costMs, melodyUsed: !!melody };
  } catch (e) {
    return { reason: 'DiffSinger 异常：' + (e?.message ?? e) };
  } finally {
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    if (stoppedRvc) {
      try { await ensureRvcService({ log: null, force: true }); }
      catch (e) { if (log) log('RVC 服务重启失败：' + (e?.message || e)); }
    }
    if (engine === 'ddsp') stopDdspService();
  }
}

/** 把一句歌词变成「胡桃音色」的音频（可选套旋律模板）。
 *  @param {{withMelody?: boolean, melodyMode?: string}} opts
 */
export async function singLyrics(text, { trans = null, style = null, withMelody = false, melodyMode = 'wave', log = null, useDiffSinger = true, voice = 'hutao', key = 'B3', bpm = 92, scale = 'major', withAcc = true, vc = null, melody = '', melodyLabel = '', melodyTrans = 0, onLine = null, signal = null } = {}) {
  const t0 = Date.now();
  const cfg = svcConfig();
  const note = [];
  const singerName = { hutao: '胡桃', nahida: '纳西妲', robin: '知更鸟', sparkle: '花火' }[voice] || '胡桃';

  // ── 首选：DiffSinger 角色真唱（自然旋律 + 伴奏 + 16kHz）──
  // withMelody=false 是「只念不唱」（工具参数 noMelody），这时候不能走 DiffSinger，
  // 它一定会按谱唱；交给下面的 TTS 分支。
  if (useDiffSinger && withMelody) {
    // melody 可能是「旋律库里的歌名」，也可能是自动扒谱生成的 json 绝对路径。
    // 后者绝不能直接读给用户听（会变成《C:/QQagent/cache/melody/1a2b3c.json》），
    // 所以调用方可以用 melodyLabel 传一个人类可读的歌名。
    const mLabel = melodyLabel || melody;
    const ds = await singWithDiffSinger(text, {
      voice, key, bpm, scale, withAcc, log, melody, melodyLabel, melodyTrans, onLine, signal,
      vc: vc ?? cfg.vc, vcIndexRate: cfg.vcIndexRate,
      vcProtect: cfg.vcProtect, vcEnhance: cfg.vcEnhance,
      vcEngine: cfg.vcEngine === 'ddsp' ? 'ddsp' : 'rvc',
      ddspUrl: ddspConfig().url
    });
    if (ds.buffer) {
      if (log) {
        const tr = Math.round(Number(melodyTrans) || 0);
        const trTxt = tr ? ` 移调${tr > 0 ? '+' : ''}${tr}` : '';
        log(`[唱歌] DiffSinger ${singerName}真唱完成 ${(ds.costMs / 1000).toFixed(1)}s`
          + (melody ? `（旋律《${mLabel}》${trTxt}）` : ''));
      }
      return {
        buffer: ds.buffer,
        ext: ds.ext,
        source: melody ? 'lyrics-diffsinger-melody' : 'lyrics-diffsinger-svs',
        vocalSec: ds.seconds,
        ttsMs: 0,
        svcMs: ds.costMs,
        melodyUsed: true,
        melodyName: mLabel || '',
        engine: 'diffsinger',
        singer: singerName,
        note: melody
          ? `已按《${mLabel}》的旋律，用${singerName}的声音${withAcc ? '真唱' : '清唱'}这段歌词`
            + (withAcc ? '（旋律是扒谱来的，不是算法瞎编的）。' : '（干声，只有人声，没加伴奏）。')
          : `已用${singerName}的声音${withAcc ? '真唱' : '清唱'}这段歌词`
            + (withAcc
              ? '（自动配了旋律和伴奏，不是原曲）。想唱原曲请发歌名或哼唱参考。'
              : '（干声，只有人声，没加伴奏；想要带伴奏的说一声）。'),
      };
    }
    if (log) log('[唱歌] DiffSinger 失败，降级 TTS→SVC：' + (ds.reason || ''));
    note.push('（真唱引擎不可用，先用念白：' + (ds.reason || '') + '）');
  }
  // 被取消（队列 abort）时不要再往下走 TTS —— 否则「取消」会变成偷偷跑完
  if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'CANCELED', retryable: false });

  // ── 降级：TTS → SVC 换音色 ──
  const tts = await synthesizeSpeech({
    text,
    instruction: style || '带一点俏皮、轻快，像在哼唱；语速放慢，字与字之间留一点气口，尾音微微上扬，不要像朗读课文。'
  });
  const ttsMs = Date.now() - t0;
  if (log) log(`[唱歌] TTS 完成 ${tts.characters} 字 ${ttsMs}ms`);

  let vocalBuf = tts.buffer;
  let melodyUsed = false;
  if (withMelody) {
    const parsed = parseLyrics(text);
    const tm = applyMelodyTemplate(tts.buffer, {
      syllables: parsed.ok ? parsed.charCount : 12,
      mode: melodyMode
    });
    if (tm.buffer) {
      vocalBuf = tm.buffer;
      melodyUsed = true;
      if (log) log('[唱歌] 旋律模板已套用（' + melodyMode + '）');
    }
  }

  const t1 = Date.now();
  const conv = await convertSinging(vocalBuf, { trans: trans ?? cfg.trans });
  const svcMs = Date.now() - t1;
  if (log) log(`[唱歌] SVC 换胡桃音色完成 ${svcMs}ms`);

  note.push('已用胡桃的音色' + (melodyUsed ? '哼唱这段歌词。' : '念出/轻唱这段歌词。'));
  note.push('提示：当前是歌声转换（念白换音色），不是真按谱唱；想真唱请发哼唱或歌曲音频。');

  return {
    buffer: conv.buffer,
    ext: conv.ext,
    source: melodyUsed ? 'lyrics-tts-melody-svc' : 'lyrics-tts-svc',
    vocalSec: Math.round((wavDurationSec(conv.buffer) || conv.buffer.length / 44100) * 10) / 10,
    ttsMs,
    svcMs,
    melodyUsed,
    engine: 'tts-svc',
    note: note.join(''),
  };
}

/** 歌词预处理：去标点、限制长度、按换行分句（供后续旋律模板使用）。 */
export function parseLyrics(text, maxChars = 200) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: '歌词为空' };
  if (raw.length > maxChars) return { ok: false, reason: `歌词太长（${raw.length} 字，上限 ${maxChars}）` };
  // 去标点（保留换行作乐句边界）
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/[，。！？、；：""''（）()【】\[\]…·,.!?;:'"“”\s]/g, '').trim())
    .filter(Boolean);
  const syllables = lines.join('').split('');
  return {
    ok: true,
    lines,
    syllables,
    charCount: syllables.length,
  };
}

/** 用默认旋律模板把念白「哼唱化」：调 Python 的 melody_template.py 做音高重映射。
 *  @returns {buffer, ext} 或 {reason}
 */
export function applyMelodyTemplate(wavBuffer, { syllables = 12, mode = 'wave', rootHz = 220 } = {}) {
  const py = path.join(ROOT, 'rvc', 'py310', 'python.exe');
  const script = path.join(ROOT, 'svc', 'melody_template.py');
  const inFile = path.join(ROOT, 'svc', 'work', 'tts-in-' + Date.now() + '.wav');
  const outFile = path.join(ROOT, 'svc', 'work', 'tts-out-' + Date.now() + '.wav');
  try {
    fs.mkdirSync(path.dirname(inFile), { recursive: true });
    fs.writeFileSync(inFile, wavBuffer);
    const r = spawnSync(py, [script, '--input', inFile, '--output', outFile,
      '--syllables', String(syllables), '--mode', mode, '--root', String(rootHz)],
      { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !fs.existsSync(outFile)) {
      return { reason: '旋律模板失败：' + (r.stderr || r.stdout || '未知').slice(0, 200) };
    }
    const buf = fs.readFileSync(outFile);
    return { buffer: buf, ext: 'wav' };
  } catch (e) {
    return { reason: '旋律模板异常：' + (e?.message ?? e) };
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}
