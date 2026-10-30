// 唱歌 / 翻唱的成品交付：写盘 → 选「语音条 or 文件」→ 发送。
//
// 抽成独立模块的原因：同步路径（tools.js 直接调用）和异步路径（队列完成回调）
// 必须走同一套逻辑。历史上这两条路各写一遍，就会出现「16k 换算假设不一致 →
// 时长判断错 → 该发语音条的发了文件」这类漂移事故。
//
// 交付口径（2026-10-19 改）：
//   **默认发语音条**。群里点开就能听，不用下载；这才是"唱歌"这个场景的真实消费方式。
//   · ≤55 秒：一条语音条；
//   · 55~165 秒：按 55 秒切成 2~3 条连发（QQ 单条语音上限 60 秒）；
//   · 更长、或群友明确要「完整版 / 文件 / 下载 / 高音质」：发音频文件。
//   文件版保留原采样率，语音条才转 16k —— 想听无损的要文件。

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { toVoice16k } from './sing-song.js';
import { resolveFfmpeg, runProc } from './media-tools.js';

const VOICE_DIR = path.join(DATA_DIR, 'voice');
const MAX_VOICE_SEC = 55;      // QQ 语音条上限 60s，留 5s 余量
const MAX_VOICE_PARTS = 3;     // 最多连发 3 条（约 165 秒），再多就该发文件了

/** 只保留最近 200 个、且删除 3 天前的（避免 data/voice 无限增长）。 */
export function pruneVoiceDir(dir = VOICE_DIR) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /\.(mp3|wav|pcm|ogg|flac|aac)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); return { p, mtimeMs: st.mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
    files.forEach((f, i) => {
      if (i >= 200 || f.mtimeMs < cutoff) { try { fs.unlinkSync(f.p); } catch { /* ignore */ } }
    });
  } catch { /* ignore */ }
}

/** 把内存里的音频写成 data/voice 下的临时文件，返回路径。 */
export function saveVoiceBuffer(buffer, ext = 'wav', prefix = 'lyrics') {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const name = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const file = path.join(VOICE_DIR, name);
  fs.writeFileSync(file, buffer);
  pruneVoiceDir();
  return file;
}

/**
 * 把一段长音频切成若干段 16k 单声道 wav（给语音条用）。
 *
 * 用 ffmpeg 的 segment 复用器而不是自己切字节：wav 头/帧对齐、淡入
 * 都要它来做，手切会在接缝处"啪"一声（群里很明显）。
 *
 * @returns {Promise<{files:string[], error?:string}>} error='too-long' 表示段数超上限
 */
export async function splitForVoice(file, { segmentSec = MAX_VOICE_SEC, maxParts = MAX_VOICE_PARTS } = {}) {
  const ff = resolveFfmpeg();
  if (!ff) return { files: [], error: '找不到 ffmpeg' };
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const dir = path.join(VOICE_DIR, `seg-${stamp}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const r = await runProc(ff, [
      '-y', '-v', 'error', '-i', file,
      '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
      '-af', 'afade=t=in:st=0:d=0.02',
      '-f', 'segment', '-segment_time', String(Math.max(10, segmentSec)),
      '-reset_timestamps', '1',
      path.join(dir, 'part-%02d.wav')
    ], { timeoutMs: 120000 });
    if (r.code !== 0) return { files: [], error: String(r.stderr || '切分失败').slice(0, 160) };

    const names = fs.readdirSync(dir).filter((f) => /^part-\d+\.wav$/.test(f)).sort();
    if (!names.length) return { files: [], error: '切分结果为空' };
    if (names.length > maxParts) {
      cleanupDir(dir);
      return { files: [], error: 'too-long' };
    }
    return { files: names.map((f) => path.join(dir, f)) };
  } catch (error) {
    return { files: [], error: String(error?.message ?? error).slice(0, 160) };
  }
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanupFiles(files = []) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    cleanupDir(path.dirname(f));
  }
}

/** 逐条发语音条（已经转好 16k）。第一条挂引用，后面的不挂。 */
async function sendVoiceParts(sender, chatKey, files, { label, replyToMessageId = null } = {}) {
  const ids = [];
  const useB64 = getConfig()?.audio?.sendAsBase64 === true;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const source = useB64 ? 'base64://' + fs.readFileSync(f).toString('base64') : f;
    const partLabel = files.length > 1 ? `${label}（${i + 1}/${files.length}）` : label;
    const r = await sender.sendVoice(chatKey, { file: source, label: partLabel }, {
      replyToMessageId: i === 0 ? (replyToMessageId ?? null) : null
    });
    ids.push(r?.message_id ?? null);
  }
  return ids;
}

/**
 * 交付一段「唱」的成品。
 *
 * @param {object} p
 * @param {string} p.file 成品音频（原始采样率）
 * @param {number} [p.seconds] 时长（秒）
 * @param {boolean} [p.full] 群友明确要「完整/文件/下载/高音质」→ 发文件
 * @returns {Promise<{mode:'voice'|'file', messageId:string|null, parts:number, label:string, note:string}>}
 */
export async function deliverSing(sender, chatKey, {
  file, seconds = 0, engine = '', melodyName = '', singer = '胡桃',
  hq = false, full = false, replyToMessageId = null,
} = {}) {
  const label = engine === 'diffsinger'
    ? (melodyName ? `按《${melodyName}》真唱` : `${singer}真唱`)
    : (engine === 'cover' ? `${singer}翻唱《${melodyName || '这首'}》` : `${singer}哼唱`);
  const sec = Number(seconds) || 0;
  const wantFile = full === true || hq === true || sec > MAX_VOICE_SEC * MAX_VOICE_PARTS;
  const fileName = `${singer}${melodyName ? '《' + melodyName + '》' : ''}${engine === 'cover' ? '翻唱' : '真唱'}-${Math.round(sec)}s.wav`;

  if (wantFile) {
    const sent = await sender.sendFile(chatKey, file, fileName);
    return {
      mode: 'file', messageId: sent?.message_id ?? null, parts: 1, label,
      note: sec > MAX_VOICE_SEC * MAX_VOICE_PARTS
        ? '这段太长，语音条装不下，按完整音频发文件了。'
        : '按完整音频发了文件。'
    };
  }

  // ① ≤55 秒：一条语音条（先转 16k 单声道，QQ 只吃这个）
  if (sec > 0 && sec <= MAX_VOICE_SEC) {
    const small = toVoice16k(fs.readFileSync(file));
    const useB64 = getConfig()?.audio?.sendAsBase64 === true;
    const p16 = file.replace(/\.wav$/, '.16k.wav');
    let source = p16;
    if (useB64) source = 'base64://' + small.toString('base64');
    else fs.writeFileSync(p16, small);
    const ids = await sendVoiceParts(sender, chatKey, [source], { label, replyToMessageId });
    if (!useB64) { try { fs.unlinkSync(p16); } catch { /* ignore */ } }
    return { mode: 'voice', messageId: ids[0] ?? null, parts: 1, label, note: '语音条已发。' };
  }

  // ② 55~165 秒：切段连发
  const split = await splitForVoice(file, { segmentSec: MAX_VOICE_SEC, maxParts: MAX_VOICE_PARTS });
  if (split.files.length) {
    const ids = await sendVoiceParts(sender, chatKey, split.files, { label, replyToMessageId });
    cleanupFiles(split.files);
    return {
      mode: 'voice', messageId: ids[0] ?? null, parts: split.files.length, label,
      note: `这段 ${Math.round(sec)} 秒，切成 ${split.files.length} 条语音条发过去了。`
    };
  }

  // ③ 切不开 → 老实发文件，别塞一条半截的语音
  const sent = await sender.sendFile(chatKey, file, fileName);
  return {
    mode: 'file', messageId: sent?.message_id ?? null, parts: 1, label,
    note: `语音条切分失败（${split.error || '未知原因'}），已按文件发送。`
  };
}

/**
 * 交付翻唱成品。
 *
 * 以前这里一律发文件（理由是"44.1kHz 立体声语音条会压坏混音"）。但群友点歌
 * 要的是"立刻听到"，不是"下载一个 wav"。所以改成和清唱同一套口径：
 * 默认语音条（转 16k 单声道），要完整/高音质才发文件。
 */
export async function deliverCover(sender, chatKey, { file, seconds = 0, name = '翻唱', full = false, replyToMessageId = null } = {}) {
  return deliverSing(sender, chatKey, {
    file,
    seconds,
    engine: 'cover',
    singer: '胡桃',
    melodyName: name,
    full,
    replyToMessageId
  });
}
