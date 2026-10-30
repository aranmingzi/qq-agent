// 点播交付：缓存音频 → mp3（带封面/ID3）→ 发到群里。
//
// 为什么必须先转码，不能直接发 .m4s
// ---------------------------------
//   ① QQ 不认 m4s 这个扩展名（文件发过去对方打不开/不能在线播）；
//   ② B站 PC 缓存的 m4s 前面有 9 字节私有头，播放器直接读会失败；
//   ③ 很多缓存是「音视频合流」，只取音轨能省 90% 体积（70MB → 5MB）。
// 所以统一转成 44.1kHz 立体声 mp3，并带上标题/歌手/封面 —— 群友点开就有封面，
// 存到手机里也不是一个无名的文件。
//
// 缓存策略：data/playlist/audio/<trackId>.mp3 + 同名 .json 签名。
// 签名里记「源文件路径 + 大小 + mtime + 码率」，缓存被 B站客户端重下/替换时会自动失效。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PLAYLIST_DIR, playlistConfig, recordPlay, formatDuration } from './playlist.js';
import { runProc, resolveFfmpeg, cleanedSource, probeMedia } from './media-tools.js';

const AUDIO_DIR = path.join(PLAYLIST_DIR, 'audio');
const VOICE_DIR = path.join(PLAYLIST_DIR, 'voice');
const MP3_VERSION = 2;

let logFn = () => {};
export function initPlayback({ log = null } = {}) {
  if (log) logFn = log;
}

function safeName(s, fallback = 'song') {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
  return out || fallback;
}

function fileNameFor(track) {
  const artist = track.artist && track.artist !== '未知' ? ` - ${track.artist}` : '';
  return safeName(`${track.title}${artist}`) + '.mp3';
}

export function isAudioCached(track) {
  if (!track?.id) return false;
  try {
    const out = path.join(AUDIO_DIR, `${track.id}.mp3`);
    const st = fs.statSync(out);
    if (st.size < 10 * 1024) return false;
    const sig = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
    return sig.version === MP3_VERSION
      && sig.src?.path === track.audio?.path
      && sig.src?.size === track.audio?.size;
  } catch {
    return false;
  }
}

/** 转码（或命中缓存）后返回 mp3 绝对路径。 */
export async function ensureMp3(track, { log = logFn } = {}) {
  if (!track?.audio?.path) throw new Error('这首歌没有可用的音频文件');
  try {
    const st = fs.statSync(track.audio.path);
    if (!st.size) throw new Error('音频文件是空的（缓存可能没下完）');
  } catch (error) {
    throw new Error(`缓存文件读不到：${path.basename(track.audio.path)}（${error?.message ?? error}）`);
  }

  const cfg = playlistConfig();
  const out = path.join(AUDIO_DIR, `${track.id}.mp3`);
  const sigFile = `${out}.json`;
  const sig = {
    version: MP3_VERSION,
    bitrate: cfg.bitrate,
    src: { path: track.audio.path, size: track.audio.size, mtimeMs: track.audio.mtimeMs || 0 },
  };

  if (isAudioCached(track)) return out;

  const ff = resolveFfmpeg();
  if (!ff) throw new Error('找不到 ffmpeg，无法转码 B站缓存');

  await fsp.mkdir(AUDIO_DIR, { recursive: true });
  const src = await cleanedSource(track.audio.path, { log });

  const cover = track.cover && fs.existsSync(track.cover) ? track.cover : '';
  const meta = [
    '-metadata', `title=${track.title}`,
    '-metadata', `artist=${track.artist || '未知'}`,
    '-metadata', `album=${track.album || '点歌台'}`,
    '-metadata', `comment=bilibili ${track.source?.bvid || ''}`.trim(),
    '-id3v2_version', '3',
  ];

  const baseArgs = [
    '-hide_banner', '-nostdin', '-y',
    '-i', src,
    '-vn', '-map', '0:a:0',
    '-c:a', 'libmp3lame', '-b:a', cfg.bitrate, '-ar', '44100', '-ac', '2',
    ...meta,
  ];

  const tmp = `${out}.${process.pid}.part.mp3`;
  const r = await runProc(ff, [...baseArgs, tmp]);
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const tail = (r.stderr || '').trim().split('\n').slice(-4).join(' ');
    throw new Error(`转码失败：${tail || `ffmpeg exit ${r.code}`}`);
  }

  // 封面单独走一遍：把 jpg 作为 attached_pic 写进 ID3（失败不影响音频）
  if (cover) await attachCover(tmp, cover, { log });

  await fsp.rename(tmp, out);
  sig.probed = await probeDuration(out);
  await fsp.writeFile(sigFile, JSON.stringify(sig, null, 2), 'utf8');
  log(`[playback] 已转码《${track.title}》 ${formatDuration(sig.probed || track.duration)} → ${path.basename(out)}`);
  return out;
}

async function attachCover(mp3, cover, { log }) {
  const ff = resolveFfmpeg();
  if (!ff) return;
  const tmp = `${mp3}.cover.mp3`;
  const r = await runProc(ff, [
    '-hide_banner', '-nostdin', '-y',
    '-i', mp3, '-i', cover,
    '-map', '0:a', '-map', '1:v:0',
    '-c:a', 'copy', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic',
    '-id3v2_version', '3',
    tmp,
  ]);
  if (r.code === 0 && fs.existsSync(tmp)) {
    try { fs.renameSync(tmp, mp3); } catch { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  } else {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    log(`[playback] 封面写入失败（不影响播放）：${(r.stderr || '').split('\n').slice(-2).join(' ')}`);
  }
}

async function probeDuration(file) {
  const p = await probeMedia(file).catch(() => null);
  return p?.ok ? Math.round(p.duration || 0) : 0;
}

/**
 * 生成一段 16kHz 单声道语音条片段（QQ 语音上限 60s，整首歌只能截一段）。
 * 默认从 1/3 处开始 —— 多数流行歌那里正好是副歌，试听效果最好。
 */
export async function ensureSnippetWav(track, { seconds = null, startRatio = 0.32, log = logFn } = {}) {
  const cfg = playlistConfig();
  const sec = Math.max(5, Math.min(55, Number(seconds) || cfg.snippetSec));
  const mp3 = await ensureMp3(track, { log });
  const out = path.join(VOICE_DIR, `${track.id}.${sec}s.wav`);

  try {
    const st = fs.statSync(out);
    if (st.size > 1000 && Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000) return out;
  } catch { /* 生成 */ }

  await fsp.mkdir(VOICE_DIR, { recursive: true });
  const total = track.duration || (await probeDuration(mp3)) || 0;
  const start = total > sec ? Math.max(0, Math.min(total - sec, total * startRatio)) : 0;
  const ff = resolveFfmpeg();
  const r = await runProc(ff, [
    '-hide_banner', '-nostdin', '-y',
    '-ss', String(Math.round(start * 10) / 10), '-t', String(sec),
    '-i', mp3,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    out,
  ]);
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error(`生成试听片段失败：${(r.stderr || '').split('\n').slice(-2).join(' ')}`);
  }
  return out;
}

/** 点播信息卡：先在群里说清「放的是哪首」，再发音频。 */
export function nowPlayingCard(track, { requester = '' } = {}) {
  const dur = track.duration ? formatDuration(track.duration) : '时长未知';
  const up = track.artist && track.artist !== '未知' ? track.artist : (track.uploader || '');
  const who = requester ? `${requester} 点播：` : '';
  const lines = [`🎵 ${who}《${track.title}》`, `${dur}${up ? ` · ${up}` : ''}${track.kind === 'clip' ? ' · 片段' : ''}`];
  return lines.join('\n');
}

// 同一会话的音频串行发送：避免两个人同时点歌时两条上传交错、QQ 端顺序错乱。
const chains = new Map();
function chainOf(chatKey) {
  if (!chains.has(chatKey)) chains.set(chatKey, { tail: Promise.resolve(), pending: 0 });
  return chains.get(chatKey);
}

/**
 * 把一首歌发到会话里。
 * @param {object} sender SendQueue
 * @param {string} chatKey group:xxx / private:xxx
 * @param {object} track
 * @param {object} opts { mode:'file'|'voice'|'auto', requester, card, replyToMessageId }
 */
export async function playTrack(sender, chatKey, track, {
  mode = null, requester = '', card = true, replyToMessageId = null,
} = {}) {
  if (!sender) throw new Error('发送队列未初始化');
  if (!track?.audio) throw new Error('这首歌没有音频');
  const cfg = playlistConfig();
  const wrap = chainOf(chatKey);
  if (wrap.pending >= 3) throw new Error('这个会话还有几首在发，等发完再点');

  wrap.pending += 1;
  const run = wrap.tail.then(async () => {
    const t0 = Date.now();
    const wantMode = mode || cfg.sendMode;
    const asVoice = wantMode === 'voice'
      || (wantMode === 'auto' && track.duration > 0 && track.duration <= 55);

    if (card) {
      await sender.sendTextBatch(chatKey, [nowPlayingCard(track, { requester })], {
        replyToMessageId: replyToMessageId ?? null,
      });
    }

    let file;
    let sentMode;
    let transcodeMs = 0;
    if (asVoice) {
      const t1 = Date.now();
      file = await ensureSnippetWav(track);
      transcodeMs = Date.now() - t1;
      await sender.sendVoice(chatKey, { file, label: track.title });
      sentMode = 'voice';
    } else {
      const t1 = Date.now();
      file = await ensureMp3(track);
      transcodeMs = Date.now() - t1;
      const st = fs.statSync(file);
      if (st.size > cfg.maxFileMb * 1024 * 1024) {
        throw new Error(`文件太大（${Math.round(st.size / 1048576)}MB），超过设置上限 ${cfg.maxFileMb}MB`);
      }
      await sender.sendFile(chatKey, file, fileNameFor(track));
      sentMode = 'file';
    }

    recordPlay(track.id, { by: requester, chatKey });
    return {
      track,
      mode: sentMode,
      file,
      seconds: track.duration || 0,
      transcodeMs,
      totalMs: Date.now() - t0,
    };
  });

  // 无论成败都要把链条接下去，否则一次失败会让这个会话永久卡住
  wrap.tail = run.catch(() => {}).finally(() => { wrap.pending = Math.max(0, wrap.pending - 1); });
  return run;
}
