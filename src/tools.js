// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, ROOT, DATA_DIR, resolvePersona } from './config.js';
import { synthesizeSpeech, qwenAudioConfig, transcribeSpeech, qwenAsrConfig, isCosyvoice } from './qwen-audio.js';
import { convertVoice, rvcConfig, rvcModelForVoice } from './rvc-voice.js';
import { singSong, convertSinging, svcConfig, svcHealth, ensureSvcService } from './svc-voice.js';
import { singLyrics, parseLyrics, toVoice16k, diffSingerReady } from './sing-song.js';
import { coverSong, coverReady } from './cover-song.js';
import {
  submitSing, submitCover, songQueueReady, listSongJobs, cancelSongJob, cancelSongJobsByChat,
} from './song-jobs.js';
import {
  planSongRequest, findLocalSong, findMelody, listLocalSongs, listMelodyNames,
  describePlan, resolveSongSource, findSongInPlaylist,
} from './song-router.js';
import { suggestToolName, describeToolSuggestion } from './tool-name-hint.js';
import { ensureLibrary, resolvePlayQuery, playlistConfig } from './playlist.js';
import { playTrack } from './playback.js';
import { saveVoiceBuffer, deliverSing, deliverCover, pruneVoiceDir } from './song-deliver.js';
import { resolveFfmpeg, runProc } from './media-tools.js';
import { imageSize, parseDataUrl } from './image-meta.js';
import { VISION_STRUCT, VISION_BRIEF, planImageSegments, segmentNote, segmentLabel } from './vision-prompt.js';
import { splitGifFrames } from './gif-frames.js';
import { isKgm, decryptKgmToAudio } from './kgm.js';
import { classifyUrl, resolveLinkAudio, pickUrlFromText } from './link-audio.js';
import { decryptEncryptedAudio } from './audio-decrypt.js';
import { gsvSpeak, gsvHealth, GSV_VOICES } from './gpt-sovits.js';
import { resolveTone, describeTone, guessTone } from './voice-delivery.js';
import { EMOTION_NAMES } from './vibe.js';
import { seedVcConvert, seedVcHealth } from './seed-vc.js';
import { toSpeechText } from './colloquial.js';
import { normalizeMessageList, unquoteJsonString, wavDurationSec, todayKey } from './util.js';
import { looksLikeInternalNote, looksLikeFakeAbsence } from './monologue-guard.js';
import { formatStickerList, stickerLocalCopy, parseStickerLogId, isStickerSendable } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { listEntries as listDiaryEntries, readEntry as readDiaryEntry, writeDiaryFor } from './diary.js';
import { chatCompletion } from './llm.js';
import { looksEmptyBody, normalizeUrl, firstUrlIn } from './html-text.js';
import { pokeBudget, atBudget, matchMember } from './gesture.js';
import { webSearch, webFetch, anysearchSearch } from './web-search.js';
import { watchVideo, videoConfig, findVideoUrl } from './video-intel.js';
import { searchMemes, proposeMeme } from './memes.js';
import { forgetFact } from './memory-facts.js';
import { forgetGroupFact } from './group-facts.js';
import { lookupMemeWiki } from './meme-wiki.js';
import { getMentionWait } from './action-planner.js';
import { analyzeWithVision } from './vision-client.js';

// 本工具允许读发的本地目录：项目内的 workspace/ 与 dsh-work/，外加系统临时目录。
// 不写死部署路径（历史上是 /root/qq-agent-v2/...），换机器/换目录自动跟着走。
const WORKSPACE_DIR = path.join(ROOT, 'workspace');
const DSH_WORK_DIR = path.join(ROOT, 'dsh-work');
const TEMP_DIRS = ['/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])];
const LOCAL_PATH_PREFIXES = [WORKSPACE_DIR, DSH_WORK_DIR, ...TEMP_DIRS];

// 旋律库：从原曲扒谱来的真实旋律（songs/melodies/<歌名>.json）。
// 启动时读一次，把可用曲名写进 sing_lyrics 的工具描述里，模型才知道能「按原曲的调唱」。
// 路由/曲库扫描统一放在 song-router.js（有原曲就翻唱，只有旋律就按谱唱）。
const MELODY_NAMES = listMelodyNames();

// 默认曲目：群友只说「唱首歌」「你来一首」但没点名唱哪首时，就唱这一首
// （settings → audio.svc.defaultSong 里配的歌名）。
// 只在 title/name 完全为空时兜底 —— 明确点了歌、给了歌词都不受影响。
// 配置指向的歌在曲库/旋律库里查不到时当「没配」处理：否则会把「素材缺失」
// 伪装成「点了这首歌」，下游报错反而更难懂。
function defaultSingTitle() {
  let wants = '';
  try { wants = String(svcConfig().defaultSong || '').trim(); } catch { wants = ''; }
  if (!wants) return '';
  const hit = findLocalSong(wants) || findMelody(wants);
  return hit ? wants : '';
}

// 下载图片并转成 dataURL（供视觉模型读图）。
//
// ⚠️ 为什么要重试（2026-09-15 事故）：用户在私聊发图后，机器人回了"图片还没同步出来"。
//    复盘发现：消息入库到触发运行只隔 **2.9 秒**，此时 QQ 的 CDN（multimedia.nt.qq.com.cn）
//    往往还没把图片准备好，首次 GET 会失败；而当时**没有任何重试**，一次失败就永久放弃，
//    于是模型只能如实说"看不到图"。同一 URL 几分钟后手工再拉是成功的 —— 典型的瞬时失败。
//    现在改为指数退避重试 3 次（0.6s / 1.5s / 3s），足以覆盖 CDN 就绪延迟。
async function downloadImageBuffer(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const delays = [600, 1500, 3000];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const { buffer, contentType } = await safeFetchBinary(safeUrl, 12 * 1024 * 1024, { timeoutMs });
      if (!buffer || !buffer.length) throw new Error("图片内容为空");
      const mime = detectMime(buffer);
      const declared = String(contentType || "").split(";")[0].trim();
      // 服务器明确说了不是图片（常见：CDN 过期返回 HTML 错误页），就别把它当图片发出去 ——
      // 既浪费一次识图，也会让模型"看图"一本正经地描述一段 HTML。
      if (!mime && declared && !declared.startsWith("image/")) {
        throw new Error(`下载到的不是图片（Content-Type: ${declared}）`);
      }
      return { buffer, mime: mime || declared || "image/jpeg" };
    } catch (e) {
      lastError = e;
      if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastError ?? new Error("图片下载失败");
}

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif)$/i;

/**
 * 本地文件 → 图片字节。
 *
 * ⚠️ 2026-10-26 修：`file` 字段来自**消息内容**，是外部可控的。
 * 旧写法是「只要是存在的绝对路径就读出来」，再用 `detectMime() || 'image/jpeg'`
 * 把识别不出来的兜底成 jpeg —— 于是 `data/config.json`（含各家 API key）
 * 会被原样 base64 后发给视觉供应商。等于把密钥发给第三方。
 *
 * 两道闸：
 *   ① 扩展名（外部给的 file 才查；NapCat 自己 `get_image` 返回的路径常常没有扩展名，所以可关）
 *   ② **魔数必须真命中**（png/jpeg/gif/webp）—— 本地文件**不允许**兜底成 jpeg。
 */
function localImageBuffer(filePath, maxBytes = 12 * 1024 * 1024, { requireImageExt = true } = {}) {
  const resolved = path.resolve(String(filePath || ''));
  if (requireImageExt && !IMAGE_EXT.test(resolved)) throw new Error('不是图片文件名（拒绝读取非图片文件）');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('图片路径不是文件');
  if (stat.size <= 0) throw new Error('图片内容为空');
  if (stat.size > maxBytes) throw new Error(`图片过大（${Math.round(stat.size / 1024)}KB）`);
  const buffer = fs.readFileSync(resolved);
  const mime = detectMime(buffer);
  if (!mime) throw new Error('文件内容不是图片（只认 jpeg/png/webp/gif）');
  return { buffer, mime };
}

/**
 * 图片字节 → 1..N 张 dataURL。
 *
 * GIF 要拆（见 gif-frames.js）：视觉模型只吃 jpeg/png/webp，`image/gif` 原样塞过去
 * 要么被拒、要么「看到」一片空白 —— 而 QQ 的动图表情和转发的动图几乎全是 GIF。
 * 拆帧失败就退回原图：宁可模型看不清，也不能因为拆帧把整条消息变成失败。
 * `gifFrames` 回传给调用方，好在提示词里说一句「这几张是同一张动图的帧」，
 * 否则模型会把三帧当成三个人发的三张图。
 */
async function imageBufferToDataUrls(buffer, mime) {
  if (mime === 'image/gif') {
    const { frames } = await splitGifFrames(buffer);
    if (frames.length) {
      return { urls: frames.map((b) => `data:image/jpeg;base64,${b.toString('base64')}`), gifFrames: frames.length };
    }
  }
  return { urls: [`data:${mime};base64,${buffer.toString('base64')}`], gifFrames: 0 };
}

async function downloadImageDataUrls(url, timeoutMs = 30000) {
  const { buffer, mime } = await downloadImageBuffer(url, timeoutMs);
  return imageBufferToDataUrls(buffer, mime);
}

async function localImageDataUrls(filePath, opts = {}) {
  const { buffer, mime } = localImageBuffer(filePath, 12 * 1024 * 1024, opts);
  return imageBufferToDataUrls(buffer, mime);
}

/** QQ 图片 CDN 链接可能已过期，优先让 NapCat 调 get_image 返回本地缓存文件。 */
async function mediaImageDataUrls(ctx, media) {
  let lastError = null;
  const remoteUrl = String(media?.url || '').trim();
  if (remoteUrl) {
    try {
      return await downloadImageDataUrls(remoteUrl);
    } catch (error) {
      lastError = error;
    }
  }

  const fileRef = String(media?.file || media?.fileId || '').trim();
  if (fileRef && ctx?.onebot) {
    try {
      if (path.isAbsolute(fileRef) && fs.existsSync(fileRef)) {
        return await localImageDataUrls(fileRef);
      }
      const info = await ctx.onebot.call('get_image', { file: fileRef }, 30000);
      const localPath = String(info?.file || '').trim();
      if (localPath && path.isAbsolute(localPath) && fs.existsSync(localPath)) {
        // NapCat 自己给的路径可信度高，且常常没有扩展名 → 免检扩展名，但**魔数仍要验**
        return await localImageDataUrls(localPath, { requireImageExt: false });
      }
      const freshUrl = String(info?.url || '').trim();
      if (freshUrl) return await downloadImageDataUrls(freshUrl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('图片下载失败');
}

/** 拆帧后的口头补充：告诉模型这些图是同一条动图的不同时刻，别当成分开发的三张图。 */
function gifFramesNote(count) {
  if (!count) return '';
  return count > 1 ? `（其中有一张 GIF 动图，已拆成 ${count} 个静帧，按顺序看是同一张图的动作过程）` : '（其中有一张 GIF 动图，已转成静帧）';
}

// ── 视频取一帧：先找 QQ 自己生成好的封面帧，再退到 ffmpeg 抽帧 ────────────────
//
// 2026-10-26 事故复盘（群里发视频，她回「视频我这边只看到个壳」）：
//   ① 模型压根没调 get_message_images —— 工具描述只写「图片/表情」，看到 [视频] 想不到它；
//   ② 就算调了也大概率失败 —— NapCat 给的 url 常是 QQ 客户端的**本地路径**
//      （...\nt_qq\nt_data\Video\2026-10\Ori\<hash>.mp4），而 QQ 根本不为每条视频下原文件：
//      Ori/ 目录是空的。偏偏同级的 ..\Thumb\<hash>_0.png 一直在，而且**就是视频的真实一帧**
//      （实测 1094×500，无水印无播放按钮，比 -ss 3 抽出来的还准）。
//   所以取帧顺序改为：本地封面帧 → 本地原文件抽帧 → 网络地址抽帧。
//   封面帧不联网、不看 rkey 脸色（CDN 的 rkey 十分钟就过期）。
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'ts', '3gp', 'mpg', 'mpeg']);

/** 这条 media 是不是一段视频（[视频] 段，或扩展名像视频的[文件] 消息）。 */
export function isVideoMedia(m = {}) {
  if (m.kind === 'video') return true;
  if (m.kind !== 'file') return false;
  return [m.name, m.file, m.url].some((x) => VIDEO_EXTS.has(String(x || '').split('.').pop().toLowerCase()));
}

/** QQ 把同一个 hash 同时用在 Ori/<hash>.mp4 和 Thumb/<hash>_0.png 上。 */
function videoHashOf(media = {}) {
  const raw = String(media.file || media.url || media.name || '');
  const hit = raw.match(/([0-9a-f]{32})/i);
  if (hit) return hit[1].toLowerCase();
  const base = path.basename(raw.replace(/\\/g, '/'), path.extname(raw));
  return /^[0-9a-f]{16,64}$/i.test(base) ? base.toLowerCase() : '';
}

/** 由本地路径直接推出同级 Thumb 目录：...\Video\2026-10\Ori\x.mp4 → ...\Video\2026-10\Thumb\x_0.png */
function thumbPathsFromLocalPath(raw) {
  const norm = String(raw || '').replace(/\\/g, '/');
  if (!/\/Ori\//i.test(norm)) return [];
  const dir = norm.replace(/\/Ori\/[^/]*$/i, '/Thumb');
  const hash = videoHashOf({ file: norm.split('/').pop() });
  if (!hash) return [];
  return [`${dir}/${hash}_0.png`, `${dir}/${hash}.png`, `${dir}/${hash}_1.jpg`, `${dir}/${hash}_0.jpg`];
}

/** 找 QQ 的 nt_data/Video 目录（懒加载 + 5 分钟缓存）。换机器/换 QQ 号自动跟着走。 */
let _qqVideoDirs = null;
let _qqVideoDirsAt = 0;
function qqVideoDirs() {
  if (_qqVideoDirs && Date.now() - _qqVideoDirsAt < 5 * 60 * 1000) return _qqVideoDirs;
  const filesRoots = [];
  const addFilesRoot = (p) => { if (p && !filesRoots.includes(p)) filesRoots.push(p); };
  for (const env of [process.env.QQ_FILES_DIR, process.env.QQ_DATA_DIR]) addFilesRoot(env);
  let home = '';
  try { home = os.homedir(); } catch { home = ''; }
  for (const doc of ['Documents', '文档']) {
    if (home) addFilesRoot(path.join(home, doc, 'Tencent Files'));
  }
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F']) {
      for (const doc of ['Documents', '文档']) addFilesRoot(`${drive}:\\${doc}\\Tencent Files`);
    }
  }
  const dirs = [];
  const pushVideoDir = (base) => {
    const v = path.join(base, 'nt_qq', 'nt_data', 'Video');
    try { if (fs.existsSync(v) && fs.statSync(v).isDirectory()) dirs.push(v); } catch { /* ignore */ }
  };
  for (const root of filesRoots) {
    try { if (!fs.existsSync(root)) continue; } catch { continue; }
    pushVideoDir(root);                       // 新版 NTQQ：Tencent Files/nt_qq/...
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch { subs = []; }
    for (const ent of subs) {
      if (!ent.isDirectory()) continue;
      pushVideoDir(path.join(root, ent.name)); // 老布局：Tencent Files/<QQ号>/nt_qq/...
    }
  }
  _qqVideoDirs = dirs;
  _qqVideoDirsAt = Date.now();
  return dirs;
}

/** 找这段视频的本地封面帧。返回绝对路径，找不到返回 ''。 */
function findVideoThumbFile(media = {}) {
  const direct = [];
  for (const raw of [media.url, media.path, media.file]) {
    if (raw && (path.isAbsolute(String(raw)) || /^[a-z]:[\\/]/i.test(String(raw)))) {
      direct.push(...thumbPathsFromLocalPath(String(raw)));
      // url 已经是 Thumb 图本身
      if (/\/Thumb\/[^/]+\.(png|jpg|jpeg)$/i.test(String(raw).replace(/\\/g, '/'))) direct.unshift(String(raw));
    }
  }
  for (const p of direct) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  const hash = videoHashOf(media);
  if (!hash) return '';
  for (const videoDir of qqVideoDirs()) {
    let months = [];
    try { months = fs.readdirSync(videoDir); } catch { continue; }
    for (const m of months) {
      for (const name of [`${hash}_0.png`, `${hash}_0.jpg`, `${hash}.png`, `${hash}_1.png`]) {
        const p = path.join(videoDir, m, 'Thumb', name);
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
      }
    }
  }
  return '';
}

/** 抽一帧到临时 jpg，返回 dataURL。 */
async function ffmpegFrameDataUrl(src) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('本机没找到 ffmpeg');
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `frame-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
  const tail = ['-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '4', out];
  // -ss 3 跳过片头黑帧；不足 3 秒 / 网络流不认前置 -ss 时退回第 0 秒。
  // （旧代码只在「非绝对路径」时重试，于是本地文件一旦 <3s 就永远失败。）
  let r = await runProc(ff, ['-y', '-ss', '3', '-i', src, ...tail], { timeoutMs: 90000 });
  if (r.code !== 0 || !fs.existsSync(out)) {
    r = await runProc(ff, ['-y', '-i', src, ...tail], { timeoutMs: 90000 });
  }
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error('ffmpeg 抽帧失败：' + String(r.stderr || '').split('\n').slice(-2).join(' ').slice(0, 120));
  }
  try {
    // 抽出来的是 jpeg，一张就够（这里不会走 GIF 拆帧分支）
    const { urls } = await localImageDataUrls(out);
    return urls[0];
  } finally {
    try { fs.unlinkSync(out); } catch { /* 临时帧删不掉无所谓 */ }
  }
}

/**
 * 视频 → 一张静止画面。
 * QQ 的视频模型看不了，但「这段视频拍的是什么」用一帧就能回答大半。
 * 取不到才抛错（没 ffmpeg / 地址失效 / 编码不支持），让调用方如实说看不到。
 */
export async function videoFirstFrameDataUrl(ctx, media) {
  const tried = [];
  // ① QQ 客户端已生成好的封面帧：不联网、不怕 rkey 过期，分辨率还比抽帧高
  try {
    const thumbPath = findVideoThumbFile(media);
    if (thumbPath) {
      const { urls } = await localImageDataUrls(thumbPath);
      if (urls?.length) return urls[0];
    }
  } catch (error) {
    tried.push(`封面帧 ${String(error?.message ?? error).slice(0, 60)}`);
  }

  // ② 抽帧：本地原文件 → 群文件 file_id → 网络地址
  const sources = [];
  for (const raw of [media?.path, media?.url, media?.file]) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (/^https?:/i.test(s)) { if (!sources.includes(s)) sources.push(s); continue; }
    if (/^[a-z]:[\\/]/i.test(s) || path.isAbsolute(s)) {
      try { if (fs.existsSync(s) && !sources.includes(s)) sources.push(s); } catch { /* ignore */ }
    }
  }
  const fid = String(media?.fileId || '').trim();
  if (!sources.length && fid && ctx?.onebot) {
    // 群文件/群视频只有 file_id：先问 NapCat 换下载地址（可能给 URL，也可能给本地缓存路径）
    try {
      const info = await ctx.onebot.call('get_file', { file_id: fid }, 30000).catch(() => null);
      const u = [info?.url, info?.data?.url, info?.file]
        .find((x) => typeof x === 'string' && (/^https?:/i.test(x) || (/^[a-z]:[\\/]/i.test(x) && fs.existsSync(x))));
      if (u) sources.push(u);
    } catch { /* 下面统一报错 */ }
  }
  const hasFileFallback = !!(fid && ctx?.onebot && media?.kind === 'file');
  if (!sources.length && !hasFileFallback) {
    throw new Error(tried.length ? `拿不到视频画面（${tried.join('；')}）` : '拿不到视频画面：协议端只给了文件名，本地缓存里也没有封面帧');
  }
  for (const src of sources) {
    try {
      return await ffmpegFrameDataUrl(src);
    } catch (error) {
      const msg = String(error?.message ?? error);
      tried.push(/^https?:/i.test(src) ? `网络地址失效（可能是链接过期，让重发一遍）：${msg.slice(0, 60)}` : msg.slice(0, 80));
    }
  }

  // ③ 最后的兜底：群文件消息只有 file_id（没有可直读的地址），就把文件整个拉下来再抽。
  //    视频可能几十 MB，所以只在 file 类消息上做，且卡 40MB —— 群友转的短片够用。
  if (fid && ctx?.onebot && media?.kind === 'file') {
    try {
      const got = await fetchFileById(ctx, fid, 40 * 1024 * 1024, media?.name || '');
      const ext = String(got?.ext || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
      const tmp = path.join(DATA_DIR, 'tmp', `vsrc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, got.buffer);
      try { return await ffmpegFrameDataUrl(tmp); } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    } catch (error) {
      tried.push(`群文件下载失败：${String(error?.message ?? error).slice(0, 70)}`);
    }
  }
  throw new Error(tried.length ? `拿不到视频画面（${tried.join('；')}）` : '拿不到视频画面');
}

/**
 * 取回一条语音的音频字节：① 本地音频文件 → ② 协议端转码后取回（QQ 语音是 SILK，
 * 我们不解码，交给 NapCat 的 get_record { out_format } 转成 mp3）→ ③ 退回段里的 URL 下载。
 */
export async function loadVoiceBytes(ctx, rec) {
  const want = String(getConfig().audio?.transcodeFormat || 'mp3').toLowerCase();
  const maxBytes = Number(getConfig().audio?.asr?.maxBytes) || 8 * 1024 * 1024;
  const refs = [rec?.file, rec?.fileId].map((x) => String(x || '').trim()).filter(Boolean);
  for (const r of refs) {
    try {
      if (path.isAbsolute(r) && /\.(mp3|wav|m4a|ogg|flac|aac|amr)$/i.test(r) && fs.existsSync(r)) {
        return { buffer: fs.readFileSync(r), format: r.split('.').pop().toLowerCase() };
      }
    } catch { /* 继续下一种 */ }
  }
  for (const r of refs) {
    try {
      const info = await ctx.onebot.call('get_record', { file: r, out_format: want }, 30000);
      const p = String(info?.file || '').trim();
      if (p && path.isAbsolute(p) && fs.existsSync(p)) return { buffer: fs.readFileSync(p), format: want };
      const u = String(info?.url || '').trim();
      if (/^https?:/i.test(u)) {
        // 地址来自 NapCat 自己的服务（常在本机端口），放行内网
        const { buffer } = await safeFetchBinary(u, maxBytes, { allowPrivate: true });
        return { buffer, format: want };
      }
    } catch { /* 继续下一种 */ }
  }
  const u = String(rec?.url || '').trim();
  if (/^https?:/i.test(u)) {
    const { buffer } = await safeFetchBinary(u, maxBytes, { allowPrivate: true });
    const m = u.match(/\.(mp3|wav|m4a|ogg|flac|amr)(?:$|[?#])/i);
    return { buffer, format: m ? m[1].toLowerCase() : 'silk' };
  }
  throw new Error('取不到语音文件：协议端没缓存，或格式不支持转换');
}

// ── 群友发来的音频 → 正式曲库 ────────────────────────────────────────
//
// 为什么必须有这一段
// ------------------
// 翻唱是「音色迁移」：RVC 用原唱干声的音高曲线重建，只换音色。所以**没有原曲音频
// 就翻唱不了** —— 不是模型没训练这首歌，是 AI 压根没听过，不知道旋律长什么样。
// （要澄清一个常见误解：RVC 训练的是「胡桃的音色」，不是某一首歌；歌不需要训练。）
//
// 于是曲库里没有的歌（群友随口报的新歌）只有两条路：
//   A. 拿到音频 → 原样翻唱（音准节奏跟原唱，不乱唱）
//   B. 拿不到   → 只能算法现编旋律 = 听众耳里的「乱唱」
//
// 这段代码把 A 变成默认：群友发过来（或给直链）→ 落进 songs/raw → 这首歌**永久进曲库**，
// 这次能翻唱，以后再报歌名也直接命中，不用再发第二次。
const RAW_SONG_DIR = path.join(ROOT, 'songs', 'raw');
// 参考音频（哼唱/片段）不进曲库：它不是一首完整的歌，混进 songs/raw 会被点歌误命中
const INCOMING_DIR = path.join(ROOT, 'cache', 'incoming');
const SONG_EXTS = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'ape'];

function safeFileBase(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** 从文件头猜格式：QQ 语音可能是 silk，扩展名/URL 都不可信。 */
export function sniffExt(buf) {
  if (!buf || buf.length < 16) return '';
  const b = buf.toString('ascii', 0, 4);
  if (b === 'RIFF') return 'wav';
  if (b === 'fLaC') return 'flac';
  if (b === 'OggS') return 'ogg';
  if (b === 'ID3!' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (b === '#!AM') return 'amr';
  return '';
}

/** silk / amr 之类 Python 侧读不了的格式，先用 ffmpeg 转成 wav 再入库。 */
async function transcodeToSongWav(file) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('这个音频格式要先转码才能唱，但本机没找到 ffmpeg');
  const out = file.replace(/\.[^.]+$/, '') + '.wav';
  const r = await runProc(ff, ['-y', '-i', file, '-ar', '44100', '-ac', '2', out], { timeoutMs: 300000 });
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error('音频转码失败：' + String(r.stderr || '').split('\n').slice(-3).join(' ').slice(0, 200));
  }
  try { if (out !== file) fs.unlinkSync(file); } catch { /* 转码产物已够用，删不掉无所谓 */ }
  return out;
}

/**
 * 把一段音频存成唱歌链路能读的本地文件。
 * 默认存进正式曲库 songs/raw/（存进去以后，再报这首歌名就能直接命中）；
 * 传 dir 可以改存别处 —— 参考音频/哼唱片段放 cache/incoming，不污染曲库。
 * 同名且字节数一致视为同一段（直接复用，不重复写盘）；
 * 同名但内容不同则加序号 —— 绝不覆盖已有文件。
 */
export async function saveIncomingSong(buffer, name, hintExt = '', { dir = RAW_SONG_DIR, log = null } = {}) {
  if (!buffer || !buffer.length) throw new Error('拿到的音频是空的');

  // ── 酷狗加密音频（.kgm / .kgma，常见于「侧脸.kgm.flac」这种改名文件）──
  // 扩展名写着 flac，内容是加密流，直接入库会让翻唱在 5% 就抛
  // 「ffmpeg 解码失败：Output file #0 does not contain any stream」。
  // 这里先解密成 wav 再入库，群友发什么都能唱。
  if (isKgm(buffer)) {
    const stem = (safeFileBase(name) || '酷狗解密').replace(/\.(kgm|kgma|flac|mp3|wav)$/i, '');
    if (log) log(`[KGM]「${stem}」是酷狗加密格式，先解密…`);
    const got = await decryptKgmToAudio(buffer, { stem: `kgm-${Date.now()}`, dir: INCOMING_DIR, log });
    fs.mkdirSync(dir, { recursive: true });
    // 解密成功一般是原始 flac（无损），只在遇到坏帧时才退化成 wav，扩展名跟着走
    const ext = path.extname(got.file) || '.flac';
    const file = uniqueName(dir, stem, ext, fs.statSync(got.file).size);
    if (!fs.existsSync(file)) fs.renameSync(got.file, file);
    else { try { fs.unlinkSync(got.file); } catch { /* 已有同尺寸文件，临时件删不掉无所谓 */ } }
    return file;
  }

  // ── 网易云 NCM / 酷我 KWM：算法确定性，直接解开当普通音频入库 ──
  const enc = decryptEncryptedAudio(buffer);
  if (enc) {
    const stem = (safeFileBase(name) || '解密音频').replace(/\.(ncm|kwm|flac|mp3|wav|m4a)$/i, '');
    const encExt = sniffExt(enc.buffer)
      || (enc.kind === 'ncm' ? String(enc.meta?.format || '').toLowerCase() : '')
      || 'mp3';
    const title = enc.meta?.musicName ? `《${enc.meta.musicName}》` : '';
    if (log) log(`[解密]「${stem}」是 ${enc.kind.toUpperCase()} 加密格式${title}，已解开（${encExt}）`);
    fs.mkdirSync(dir, { recursive: true });
    const file = uniqueName(dir, stem, encExt, enc.buffer.length);
    if (!fs.existsSync(file)) fs.writeFileSync(file, enc.buffer);
    return SONG_EXTS.includes(encExt) ? file : transcodeToSongWav(file);
  }

  fs.mkdirSync(dir, { recursive: true });
  let ext = String(hintExt || '').toLowerCase().replace(/^\./, '');
  if (!SONG_EXTS.includes(ext)) ext = sniffExt(buffer) || 'mp3';
  const base = safeFileBase(name) || (dir === RAW_SONG_DIR ? '群友发的歌' : '参考音频');
  let file = path.join(dir, `${base}.${ext}`);
  let i = 2;
  while (fs.existsSync(file) && fs.statSync(file).size !== buffer.length) {
    file = path.join(dir, `${base}-${i}.${ext}`);
    i += 1;
  }
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  return SONG_EXTS.includes(ext) ? file : transcodeToSongWav(file);
}

/** 同名但内容不同的文件不覆盖，加序号 —— 曲库里同名的两首歌都要留着。 */
function uniqueName(dir, stem, ext, size) {
  let file = path.join(dir, `${stem}${ext}`);
  let i = 2;
  while (fs.existsSync(file) && fs.statSync(file).size !== size) {
    file = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return file;
}

/**
 * 群文件 → 内容：NapCat 的 file 消息段只给 file_id，下载地址要调 get_file 现问。
 * 群里实测的失败点：群友发了 8.7MB 的 mp3，模型翻 entry.media 只找到协议端的
 * 相对路径，于是回「文件我拿不到，协议那边没给地址」—— 其实一次 get_file 就能换回 URL。
 * @returns {Promise<{buffer:Buffer, ext:string, name:string}>}
 */
export async function fetchFileById(ctx, fileId, maxBytes = 60 * 1024 * 1024, fallbackName = '') {
  if (!ctx?.onebot?.call) throw new Error('协议端不可用，取不到群文件内容');
  const info = await ctx.onebot.call('get_file', { file_id: fileId }, 30000)
    .catch((e) => { throw new Error('get_file 失败：' + (e?.message ?? e)); });
  // NapCat 两种回法：① 直接给本机绝对路径（最常见，直接用）；② 给下载地址（多在本机端口上）
  const localPath = [info?.file, info?.data?.file].find((p) => typeof p === 'string' && path.isAbsolute(p));
  if (localPath && fs.existsSync(localPath)) {
    const buf = fs.readFileSync(localPath);
    const nm = String(info?.file_name || info?.name || fallbackName || '').trim() || path.basename(localPath);
    return { buffer: buf, ext: path.extname(nm).slice(1).toLowerCase(), name: nm };
  }
  const urls = [info?.url, info?.file, info?.data?.url, info?.data?.file]
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  if (!urls.length) {
    throw new Error('NapCat 没返回可下载地址（文件可能已过期）：' + JSON.stringify(info).slice(0, 160));
  }
  // allowPrivate：这个地址是 NapCat 给的（本机协议端端口），不是群友控制的输入，
  // 不放行内网的话 SSRF 防护会直接把它拦掉 —— 群里「文件下不下来」就是这个原因。
  const got = await safeFetchBinary(urls[0], maxBytes, { allowPrivate: true });
  if (!got?.buffer?.length) throw new Error('群文件下载下来是空的');
  const nm = String(info?.file_name || info?.name || fallbackName || '').trim();
  const ext = path.extname(nm).slice(1).toLowerCase()
    || urlAudioExt(urls[0]) || sniffExt(got.buffer) || '';
  return { buffer: got.buffer, ext, name: nm || urlAudioName(urls[0]) || '群文件' };
}

/**
 * 从 messageId（群友发的语音/文件）或 url（音频直链）取音频。
 * @returns {Promise<{buffer, ext, note, title}>}
 */
export async function fetchAudioFromRef(ctx, args, { maxBytes = 60 * 1024 * 1024 } = {}) {
  const mid = args?.messageId;
  if (mid !== undefined && mid !== null && String(mid).trim() !== '') {
    const entry = ctx.store.findByMid(ctx.chatKey, mid);
    if (!entry) throw new Error(`当前会话找不到消息 ${mid}。${midHint(ctx)}`);
    const media = Array.isArray(entry.media) ? entry.media : [];
    const rec = media.find((m) => m.kind === 'record');
    if (rec) {
      const got = await loadVoiceBytes(ctx, rec);
      return { buffer: got.buffer, ext: got.format, note: '群友发的语音', title: '' };
    }
    const fileMedia = media.find((m) => m.kind === 'file' || m.kind === 'video');
    if (!fileMedia) {
      throw new Error(`消息 ${mid} 里没有音频/文件。让群友先把歌发过来，或直接给我一个音频直链（url）。`);
    }
    const local = String(fileMedia.file || '');
    if (path.isAbsolute(local) && fs.existsSync(local)) {
      return {
        buffer: fs.readFileSync(local), ext: path.extname(local).slice(1),
        note: path.basename(local), title: path.basename(local).replace(/\.[^.]+$/, ''),
      };
    }
    const fu = String(fileMedia.url || '');
    if (/^https?:/i.test(fu)) {
      const got = await safeFetchBinary(fu, maxBytes);
      return { buffer: got.buffer, ext: urlAudioExt(fu), note: '群文件', title: urlAudioName(fu) };
    }
    // ── 群友发的「文件」消息：NapCat 只给 file_id，下载地址要现问 get_file 要 ──
    // 这是群里最常见的失败点：模型看到 [文件：xxx.mp3 8.7MB] 就去翻本地路径，
    // 结果拿到的是协议端的相对路径，于是回「文件我拿不到，协议那边没给地址」——
    // 其实只要有 file_id，调一次 get_file 就能换回下载地址。
    const fid = String(fileMedia.fileId || '').trim();
    if (fid) {
      const got = await fetchFileById(ctx, fid, maxBytes, fileMedia.name);
      return {
        buffer: got.buffer, ext: got.ext, note: got.name || '群文件',
        title: (fileMedia.name || got.name || '').replace(/\.[^.]+$/, ''),
      };
    }
    throw new Error(`消息 ${mid} 的音频拿不到（协议端没给下载地址，也没有 file_id），让群友重新发一遍或给 url。`);
  }
  const u = String(args?.url || '').trim();
  if (u) {
    // 不再是「只认音频直链」：B站/网易云这些链接打开的是一张 HTML 页面，
    // 直接当二进制下回来存成 mp3，翻唱会在 5% 报「Output file #0 does not contain any stream」。
    // 按站点分流交给 link-audio（视频站走 yt-dlp，音乐平台提歌名再去 B站找原曲）。
    return fetchAudioBufferFromUrl(u, maxBytes, typeof args?.log === 'function' ? args.log : null);
  }
  throw new Error('要给我音频来源：messageId（群友发的语音/文件）或 url（B站/音乐平台链接、音频直链）');
}

export function urlAudioExt(u) {
  const m = String(u).match(/\.(mp3|wav|m4a|ogg|flac|aac|ape)(?:$|[?#])/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 链接 → buffer。直链 / 视频站 / 音乐平台统一走这里。
 *
 * 视频站和音乐平台要落盘再读回来（yt-dlp 直接写文件），所以这里多一次 IO；
 * 换来的是「什么链接都能吃」——以前只认 .mp3 结尾的 URL，
 * 群友贴个 B站链接进来，存下来的是 50KB 的网页，翻唱在 5% 才炸。
 */
export async function fetchAudioBufferFromUrl(u, maxBytes = 60 * 1024 * 1024, log = null) {
  const kind = classifyUrl(u);
  if (kind.kind === 'invalid') throw new Error(kind.reason || 'url 必须是 http/https 链接');
  if (kind.kind === 'unknown') {
    throw new Error(`认不出 ${kind.site} 的链接。给 B站/YouTube/抖音的视频页、网易云/QQ音乐/酷狗/酷我的歌曲页，或音频直链；也可以直接发文件。`);
  }
  if (kind.kind === 'direct') {
    const got = await safeFetchBinary(u, maxBytes);
    return { buffer: got.buffer, ext: urlAudioExt(u), note: '直链', title: urlAudioName(u) };
  }
  const got = await resolveLinkAudio(u, { dir: INCOMING_DIR, stem: `link-${Date.now()}`, log });
  const size = fs.statSync(got.file).size;
  if (size > Math.max(maxBytes, 150 * 1024 * 1024)) {
    try { fs.unlinkSync(got.file); } catch { /* 临时件 */ }
    throw new Error('这个链接的音频太大了（' + Math.round(size / 1048576) + 'MB），换一段短的或直接发文件');
  }
  return {
    buffer: fs.readFileSync(got.file),
    ext: path.extname(got.file).slice(1).toLowerCase(),
    note: `链接（${got.via}）`,
    title: got.title || '',
  };
}

function urlAudioName(u) {
  try {
    const last = decodeURIComponent(String(u).split('?')[0].split('/').pop() || '');
    return last.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 40);
  } catch { return ''; }
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 翻唱作业的等待文案。翻唱动辄几分钟，说「预计 1 分半」结果等 4 分钟
 * 是最伤信任的 —— 所以把排队等待算进去，并统一用「x 分钟」这种人话口径。
 */
function coverEta(sub) {
  const eta = Math.max(10, Math.round((sub.etaMs || 0) / 1000));
  const wait = Math.max(0, Number(sub.waitMs) || 0);
  const total = eta + wait;
  const min = Math.round(total / 60 * 10) / 10;
  const text = wait > 5
    ? `前面还有歌在唱，等 ${wait} 秒轮到，全程约 ${min} 分钟`
    : `预计 ${min} 分钟`;
  return { eta, wait, total, text };
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
// 读 wav 时长见 util.wavDurationSec（按 RIFF byteRate 算，不假设位深）

// 语音临时文件清理见 song-deliver.js（同步/异步两条交付路径共用一份实现）

function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

/**
 * 拍一拍的历史证据 —— 全部从会话存档推出来，不另存状态。
 *
 * 为什么不用内存账本：机器重启/应用重开之后，"刚拍过谁"必须还记得，
 * 否则重启一次就能连拍十下。存档本来就在盘上，读它是最省的做法。
 * @returns {{lastPokeAt:number, lastPokeToTargetAt:number, inboundAt:number}}
 */
function pokeHistory(ctx, targetId = '') {
  let lastPokeAt = 0;
  let lastPokeToTargetAt = 0;
  let inboundAt = 0;
  // 这个人最近连戳了你几下（判"连戳炸毛"用，窗口与 gesture.pokeStreakResetMs 同源）
  let inboundPokes = 0;
  const streakWindow = Math.max(1000, Number(getConfig().gesture?.pokeStreakResetMs ?? 5 * 60 * 1000));
  const now = Date.now();
  let recent = [];
  try { recent = ctx.store.recent(ctx.chatKey, { limit: 40 }) || []; } catch { recent = []; }
  for (const m of recent) {
    const text = String(m?.text ?? '');
    const ts = Number(m?.ts) || 0;
    if (m?.self && text.startsWith('[拍一拍]')) {
      if (ts > lastPokeAt) lastPokeAt = ts;
      // 自己拍的那条里带目标号码（sender.poke 写的格式：你拍了拍 名字(QQ:123)）
      if (targetId && text.includes(`QQ:${targetId}`) && ts > lastPokeToTargetAt) lastPokeToTargetAt = ts;
    } else if (!m?.self && text.includes('拍了拍你') && targetId && String(m?.senderId) === String(targetId)) {
      if (ts > inboundAt) inboundAt = ts;
      if (now - ts <= streakWindow) inboundPokes += 1;
    }
  }
  return { lastPokeAt, lastPokeToTargetAt, inboundAt, inboundPokes };
}

/** 这一轮已经 @ 过谁（同一轮里别连着点名）。 */
function atCountThisRun(ctx) {
  return Number(ctx.atsThisRun || 0);
}

/**
 * 解析 "@谁"，并过一遍分寸（gesture.atBudget）。
 *
 * 三种结局：
 *   · `{id}` —— 真的要 @ 这个号；
 *   · `{id:'', note}` —— 私聊 / 本轮已 @ 过：**降级成普通消息**，但把原因说给模型；
 *   · `{error}` —— 名字对不上人/号码非法：整条不发，让它改成直接说话。
 *
 * 为什么私聊不报错而是降级：模型在私聊里传 atUserId 很常见（它只是"想叫一下这个人"），
 * 报错会让它重试、绕圈，而用户那边只是一句话发不出来。
 */
function resolveAtTarget(ctx, args) {
  const rawId = args?.atUserId === undefined || args.atUserId === null ? '' : String(args.atUserId).trim();
  const rawName = String(args?.atName ?? '').trim();
  if (!rawId && !rawName) return { id: '' };

  if (ctx.kind !== 'group') return { id: '', note: '（私聊没有 @ 这回事，已按普通消息发出）' };

  let target = null;
  if (rawId) {
    const n = Number(rawId);
    if (!Number.isInteger(n) || n <= 0) return { error: `atUserId 必须是正整数 QQ 号（收到：${JSON.stringify(args.atUserId)}）。${memberHint(ctx)}` };
    target = { id: String(n), name: '' };
  } else {
    const members = (ctx.store.activeMembers(ctx.chatKey, 40) || []).map((m) => ({ id: m.userId, name: m.name }));
    target = matchMember(rawName, members);
    if (!target) return { error: `没找到「${rawName}」对应的 QQ 号，别自己编一个。${memberHint(ctx)}` };
  }

  const verdict = atBudget({
    kind: ctx.kind,
    targetId: target.id,
    atsThisRun: atCountThisRun(ctx),
    cfg: getConfig().gesture || {}
  });
  if (!verdict.allow) return { id: '', note: `（这次没 @：${verdict.reason}；已按普通消息发出）` };
  return { id: target.id };
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

function usingQwenVision() {
  return getConfig().vision?.mode === 'qwen';
}

// 识图输出契约（2026-10-26 换成分档，见 vision-prompt.js 的实测说明）：
//   · 表情包/梗图 → VISION_BRIEF：一句话说梗 + 关键文字，80 字内
//   · 其余（截图/表格/照片/长图）→ VISION_STRUCT：主旨 → 有界要点 → 必须原样照抄的原文
// 旧的「120 字、不分点、只说这是什么和关键文字」已废止：它把任务定义成念关键字，
// 信息一多主模型只能拿到一堆碎片，自然会「理解不了主要意思」。

/**
 * 识图出口。kind 决定走哪家视觉模型（见 vision-client.js）：
 *   'sticker' 表情包 → 默认 deepseek（字大无小字，便宜快）
 *   'message' 其余图/截图 → 默认千问（小字 OCR 准）
 * 标题用**实际**出结果那家的名字，换家兜底时不会骗人。
 *
 * 长图/高像素图会先纵向切段再并行识别：整张塞进视觉模型会被降采样，
 * 上半部分内容会整段消失（实测 1094×2214 的长图，三段内容只认出后两段）。
 */
export async function describeImage(dataUrls, prompt, kind = 'message') {
  const asked = String(prompt || '').trim();
  // 调用方（模型）自己给的 prompt 也一起压：它经常写"描述这张图的内容和文字"，
  // 光改工具描述拦不住，必须在出口统一加约束。
  const contract = kind === 'sticker' ? VISION_BRIEF : VISION_STRUCT;
  const finalPrompt = asked ? `${asked}\n\n（输出要求：\n${contract}）` : contract;
  const urls = (Array.isArray(dataUrls) ? dataUrls : []).filter((u) => String(u || '').trim());

  // 只在「单图」时切段：多图（GIF 三帧、同一条消息里的几张图）平铺是有意义的，
  // 切了反而丢掉"这几张是同一时刻"的关系。
  if (urls.length === 1) {
    const split = await splitLongImage(urls[0]).catch(() => null);
    if (split) {
      const parts = await Promise.all(split.segments.map(async (seg) => {
        try {
          const r = await analyzeWithVision({
            dataUrls: [seg.dataUrl],
            prompt: `${segmentNote(seg.index, seg.total)}\n\n${finalPrompt}`,
            kind
          });
          return { label: seg.label, text: String(r.text || '').trim(), provider: r.label || '' };
        } catch (error) {
          return { label: seg.label, error: String(error?.message ?? error) };
        }
      }));
      const got = parts.filter((p) => p.text);
      if (got.length) {
        const who = got[0].provider || '视觉模型';
        const body = parts.map((p) => `${p.label}：${p.text || `（这一段没读出来：${String(p.error || '').slice(0, 60)}）`}`).join('\n');
        return `【${who} 识图结果】（长图，已分 ${parts.length} 段识别）\n${body}`;
      }
      // 全段都失败才退到原图整张再试一次
    }
  }

  const result = await analyzeWithVision({ dataUrls: urls, prompt: finalPrompt, kind });
  return `【${result.label} 识图结果】\n${result.text}`;
}

/**
 * 长图 → 若干段（每段一个 dataURL）。不需要切/切失败都返回 null（调用方就用原图）。
 * 切段失败必须**退回原图**而不是报错：宁可少看清一点，也不能因为切图把这条消息变成失败。
 */
async function splitLongImage(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed?.isBase64) return null;
  const buffer = Buffer.from(parsed.base64, 'base64');
  const size = imageSize(buffer);
  if (!size) return null;
  const plan = planImageSegments(size);
  if (plan.count <= 1) return null;
  const ff = resolveFfmpeg();
  if (!ff) return null;
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const srcExt = size.format === 'jpeg' ? 'jpg' : size.format;
  const src = path.join(tmpDir, `seg-src-${stamp}.${srcExt}`);
  const segments = [];
  try {
    fs.writeFileSync(src, buffer);
    const segH = Math.floor(size.height / plan.count);
    for (let i = 0; i < plan.count; i++) {
      const y = i * segH;
      const h = i === plan.count - 1 ? size.height - y : segH;
      const dst = path.join(tmpDir, `seg-${stamp}-${i}.jpg`);
      const r = await runProc(ff, [
        '-y', '-i', src, '-vf', `crop=${size.width}:${h}:0:${y}`, '-frames:v', '1', '-q:v', '3', dst
      ], { timeoutMs: 20000 });
      if (r.code !== 0 || !fs.existsSync(dst)) { segments.length = 0; break; }
      const bytes = fs.readFileSync(dst);
      try { fs.unlinkSync(dst); } catch { /* ignore */ }
      segments.push({
        index: i,
        total: plan.count,
        label: segmentLabel(i, plan.count),
        dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`
      });
    }
  } finally {
    try { fs.unlinkSync(src); } catch { /* ignore */ }
  }
  if (segments.length !== plan.count) return null;
  return { segments, reason: plan.reason };
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
export function buildToolDefs() {
  return [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId / atName（一轮最多点一个人，私聊不用 @）。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' },
          atName: { type: 'string', description: '要 @ 的人的昵称/群名片（不知道 QQ 号时填这个，系统自己找号；重名会失败）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const raw = normalizeMessageList(args.messages);
          if (!raw.length) return err('消息内容为空');
          // 出站窄闸门（2026-10-24 实机泄漏：模型把「（已经发完，结束。）」当消息发了出去）：
          // 只拦"整段括号旁白 + 内部收尾语义"这种铁证，正常短句一律放行。
          // 被拦时返回错误让模型重说 —— 它重说的那句通常才是真正想说的话。
          //
          // 2026-10-25 追加「假装没听见」：限流把一整轮回复吞掉后，模型补了一句
          // 「在的在的，刚刚走神了，主人你说啥？」。那是失败补偿话术，不是正文，
          // 拦住让重说，它就会把真正想接的话（"行 明天开始"）说出来。
          const faked = raw.filter((t) => looksLikeFakeAbsence(t));
          const messages = raw.filter((t) => !looksLikeInternalNote(t) && !looksLikeFakeAbsence(t));
          if (!messages.length) {
            if (faked.length) {
              return err('这句"走神了/没听清/你说啥"是补救话术，别说这种话 —— 你并没有错过什么，直接把你真正想接的那句话说出来，或者这一轮就不说。');
            }
            return err('这句是写给自己看的收尾旁白（"已经发完/结束"这类），不要发给对方。想说话就说想说的那句，也不用汇报"已发送/已结束"。');
          }

          // @ 谁：号码优先，其次按名字在活跃成员里找（重名不猜）。
          const at = resolveAtTarget(ctx, args);
          if (at.error) return err(at.error);

          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: at.id || null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at, raw: s.raw })));
          ctx.emit('session-update', ctx.session.id);
          if (at.id) ctx.atsThisRun = atCountThisRun(ctx) + 1;
          const note = ['已发送。不用汇报"已发送"，也不用再调 finish 收尾——这次处理可以就此结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条没发出去：${result.failed.map((f) => f.error).join('；')}）成功的不重发；没发出去的不要再试，本轮到此为止。`);
          // 按节奏省略（2026-10-25）：分条的第 2、3 条撞上限时**不当失败**。
          // 以前这里回的是错误，模型就以为"主人没听见我说话"，补一句「我走神了你说啥」。
          //
          // 但"省掉的是长文"是另一回事（同日第二次踩）：群友要 800 字作文，她发了
          // 「行，那我真写了啊」+ 正文两段，正文被静默省掉，而这句话术告诉她"不用补说"——
          // 她以为作文已经发了，下一轮就去聊别的，用户看到的就是"答应了不做"。
          // 所以在 sender 侧把长文划成 critical（只会等/报错，不会被省）之后，
          // 这里仍留一道兜底：万一真丢了实质内容，必须说"没发出去"，不能说"不用补说"。
          if (result.dropped?.length) {
            const lostLong = result.dropped.filter((d) => String(d.text || '').length >= 60);
            if (lostLong.length) {
              note.push(`（那段 ${lostLong[0].text ? String(lostLong[0].text).length : ''} 字的内容因为这一分钟发得太密，**没有发出去**，还在你手里：别道歉、别编"走神/没听清"，也先别马上重发（会再撞上限）；下一轮或拆成短一点的几段再说。）`);
            }
            const shortDrop = result.dropped.length - lostLong.length;
            if (shortDrop > 0) note.push(`（另有 ${shortDrop} 条短句按节奏省了，不用补说，也别解释为什么少说了一条。）`);
          }
          if (at.note) note.push(at.note);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 从 list_stickers 获取。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const cfgSticker = getConfig().sticker || {};
          const maxPerRun = Math.max(1, Number(cfgSticker.maxPerRun) || 1);
          const cooldownMs = Math.max(0, Number(cfgSticker.cooldownMs) || 0);
          const recentWindow = Math.max(10, Number(cfgSticker.recentWindow) || 40);

          // 硬约束 1：同一轮处理最多发 maxPerRun 张，防止刷屏
          const sentThisRun = (ctx.session?.sent || []).filter((x) => x.type === 'sticker').length;
          if (sentThisRun >= maxPerRun) {
            return err(`本轮已经发过表情了（一轮最多 ${maxPerRun} 张），别再刷屏，想说话就用 send_message`);
          }

          // 硬约束 2：同一会话冷却期内不再发；刚发过的那张也不重复发
          const ownRecent = ctx.store.recent(ctx.chatKey, { limit: recentWindow }).filter((m) => m.self);
          const recentStickerIds = new Set();
          let lastStickerAt = 0;
          for (const m of ownRecent) {
            const prevId = parseStickerLogId(m.text);
            if (!prevId) continue;
            recentStickerIds.add(prevId);
            lastStickerAt = Math.max(lastStickerAt, Number(m.ts) || 0);
          }
          if (cooldownMs > 0 && lastStickerAt && Date.now() - lastStickerAt < cooldownMs) {
            const waitMin = Math.max(1, Math.ceil((cooldownMs - (Date.now() - lastStickerAt)) / 60000));
            return err(`刚发过表情了（冷却中，约 ${waitMin} 分钟后才能再发），这次用文字回复`);
          }

          let sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
          if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);

          // 硬约束 3：同一张表情一天最多 dailyPerIdCap 次（跨会话，默认 1）。实测同一张「嫌弃脸」
          // 两天发了 21 次，成了招牌口癖 —— 3 分钟会话冷却拦不住这种频率。
          // 上限 2 时是三张招牌轮着刷，所以降到 1：一天想发第二张，只能换图。
          // 发送记录就在消息存档里（self + [表情包：…（id）]），扫一遍即可，不需要新状态文件。
          const dailyCap = Math.max(1, Number(cfgSticker.dailyPerIdCap) || 1);
          // 复用冷却（默认 3 天）：dailyPerIdCap 只管"当天"，跨天照旧撞见同一张 ——
          // 近 3 天 28 次发送里 7 张各发了 2 次，全是隔天复发。这就是"老用同一张"的真来源。
          const reuseMs = Math.max(0, Number(cfgSticker.reuseCooldownMs) || 0);
          // 命中**不再直接报错**：2026-10-28 实测 62 次调用里 2 次死在"今天已经发过"，
          // 而退路本来就有一条（下面"发不出去自动换发"）。让模型拿着一句错误去改口/放弃，
          // 不如让它无感换一张图。
          const usedTodayById = new Map();
          const usedRecently = new Set();
          {
            const dayStart = new Date();
            dayStart.setHours(0, 0, 0, 0);
            const reuseStart = reuseMs > 0 ? Date.now() - reuseMs : 0;
            const scanFrom = reuseStart ? Math.min(reuseStart, dayStart.getTime()) : dayStart.getTime();
            for (const otherChat of ctx.store.listChats()) {
              for (const m of ctx.store.recent(otherChat, { limit: 1000 })) {
                const ts = Number(m.ts) || 0;
                if (!m.self || ts < scanFrom) continue;
                const prevId = parseStickerLogId(m.text);
                if (!prevId) continue;
                if (ts >= dayStart.getTime()) usedTodayById.set(prevId, (usedTodayById.get(prevId) || 0) + 1);
                if (reuseStart && ts >= reuseStart) usedRecently.add(prevId);
              }
            }
          }
          const overDailyCap = (id) => (usedTodayById.get(String(id || '')) || 0) >= dailyCap;
          const reusedRecently = (id) => reuseMs > 0 && usedRecently.has(String(id || ''));
          const blockedSticker = (id) => overDailyCap(id) || reusedRecently(id);

          // 候选序列：先试指定那张；不可用/发不出去/今天或最近发过了就自动换发（标签重合 → 常用 → 任取）
          const attempts = [];
          const dayCapHit = overDailyCap(sticker.id) ? sticker.id : null;
          const reuseHit = !dayCapHit && reusedRecently(sticker.id) ? sticker.id : null;
          if (!dayCapHit && !reuseHit && isStickerSendable(sticker) && !recentStickerIds.has(sticker.id)) attempts.push(sticker);
          // 换发候选多取一张再筛：日上限/复用冷却还会剔掉一部分，取 2 可能一个都不剩
          attempts.push(...ctx.stickers.alternatives({
            excludeIds: [sticker.id, ...recentStickerIds],
            wantTags: sticker.tags || [],
            limit: 3
          }).filter((cand) => !blockedSticker(cand.id)).slice(0, 2));
          if (!attempts.length) {
            const why = dayCapHit
              ? `「${sticker.id}」今天已经发过 ${dailyCap} 次了`
              : (reuseHit ? `「${sticker.id}」最近几天刚发过` : `「${sticker.id}」现在没有能发的图（没地址或刚发过）`);
            return err(`${why}，同场景也没有别的可换 —— 这轮就纯文字吧`);
          }

          let result = null;
          let sentSticker = null;
          let lastError = null;
          let invalidError = null;
          for (const cand of attempts.slice(0, 3)) {
            let localPath = stickerLocalCopy(cand);
            // 本地副本优先：QQ 图片地址是临时链接，过期后 OneBot 只会回"下载文件失败"。
            // 没有副本（老条目 / 刚同步的 QQ 收藏表情）就先试着补一份，补不上再退回 URL。
            if (!localPath && /^https?:\/\//i.test(String(cand.url || ''))) {
              const healed = await ctx.stickers.ensureLocalCopy(cand.id).catch(() => null);
              if (healed) localPath = stickerLocalCopy(healed);
            }
            if (!localPath) {
              if (!cand.url) {
                lastError = new Error('没有可发送的图片地址');
                continue;
              }
              try {
                await validateImageUrl(cand.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
              } catch (error) {
                invalidError = { id: cand.id, message: String(error?.message ?? error) };
                lastError = error;
                continue;
              }
            }
            try {
              result = await ctx.sender.sendSticker(ctx.chatKey, { ...cand, localPath: localPath || '' }, {
                replyToMessageId: args.replyToMessageId ?? null,
                atUserId: args.atUserId ?? null
              });
              // 额度不够时 sender 会安静跳过（不抛错）：不能当成发成功，换张图也没用
              if (result?.skipped) {
                lastError = new Error('这一分钟发得太多了，表情没发出去（不是图的问题，换一张也一样）');
                break;
              }
              sentSticker = cand;
              break;
            } catch (error) {
              lastError = error;
            }
          }

          if (!sentSticker) {
            if (invalidError) return err(`表情 ${invalidError.id} 的图片地址不合法，已拒绝发送：${invalidError.message}`);
            const failMsg = String(lastError?.message ?? lastError ?? '没有可用表情');
            if (/下载文件失败|Not Found|HTTP 40[34]/i.test(failMsg)) {
              return err(`表情没发出去：${failMsg}（链接已失效，可用 collect_sticker 重新收藏，或换一张）`);
            }
            return err(`表情 ${sticker.id} 发不出去：${failMsg}`);
          }

          ctx.stickers.markUsed(sentSticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          const sentLabel = sentSticker.desc || sentSticker.localNote || sentSticker.id;
          ctx.session.sent.push({ type: 'sticker', text: `[表情包：${sentLabel}（${sentSticker.id}）]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          const swapped = sentSticker.id !== sticker.id;
          return ok({
            sent: true,
            stickerId: sentSticker.id,
            messageId: result?.message_id ?? null,
            note: swapped
              ? (dayCapHit
                ? `原选的 ${sticker.id} 今天已经发过了，已自动换发 ${sentSticker.id}（不要向群友解释这个替换过程）`
                : (reuseHit
                  ? `原选的 ${sticker.id} 最近几天刚发过，已自动换发 ${sentSticker.id}（不要向群友解释这个替换过程）`
                  : `原选的 ${sticker.id} 发不出去，已自动换发 ${sentSticker.id}（不要向群友解释这个替换过程）`))
              : '表情已发送。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_image',
      description: '发送一张图片到当前聊天（URL 或本地 workspace/ 下的路径）。图片来自网页搜索/群友要求/本地生成时用。发送前会校验公网地址安全（拒绝内网）。',
      parameters: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string', description: '图片地址：公网 http(s) URL 或本地文件绝对路径（限 workspace/ 或 dsh-work/ 或 /tmp）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['imageUrl']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.imageUrl ?? '').trim();
          if (!raw) return err('imageUrl 不能为空');
          // 本地路径检查（workspace 内）
          const isLocal = raw.startsWith('/');
          if (isLocal) {
            const allowedPrefixes = LOCAL_PATH_PREFIXES;
            const okPath = allowedPrefixes.some((p) => raw.startsWith(p)) && !raw.includes('..');
            if (!okPath) return err('本地图片路径不在允许范围（仅 workspace 或 /tmp）');
            try {
              const fs2 = await import('node:fs');
              if (!fs2.existsSync(raw)) return err(`图片文件不存在: ${raw}`);
            } catch (e) { return err('无法访问本地文件: ' + (e?.message || e)); }
          } else {
            try {
              await validateImageUrl(raw); // 公网 http(s) 校验（拒绝内网）
            } catch (error) {
              return err(`图片地址不合法，已拒绝发送：${error?.message ?? error}`);
            }
          }
          const result = await ctx.sender.sendImage(ctx.chatKey, raw, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          if (result?.skipped) {
            return err('这一分钟发得太多了，这张图没发出去（不是图的问题）。别重试，也别解释，直接把这轮说完。');
          }
          ctx.session.sent.push({ type: 'image', text: `[图片:${String(raw).split('/').pop().slice(0, 50)}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'schedule_task',
      description: '【主人专属】设置/查看/取消**定时任务**：到点机器人会主动发消息给主人，或执行提醒。主人说「X点提醒我…」「每天X点告诉我…」「每周X提醒我…」「N分钟后叫我…」「监督我一星期」时用它。\n⚠️ 你只要答应了"以后/每天/每周/到点"要主动做的事，就必须当场调用本工具建好任务再回话 —— 只口头说"记好了"而没建任务，到点什么都不会发生。\n时间由你来理解并换算成绝对时间：now 是当前时间，把「明天早上8点」「3小时后」等换算成 at（ISO 本地时间字符串，如 2026-09-14T08:00:00）；说好持续几天就把 days 填上（daily + days=7 = 连续七天）。\naction=create（默认）新建；list 查看；cancel 取消（配 taskId）；clear 清空当前会话全部。',
      masterOnly: true,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create（默认）| list | cancel | clear' },
          text: { type: 'string', description: '到点要做什么/要说什么（自然语言，如"提醒我交作业"、"问他今天有没有熬夜"）' },
          at: { type: 'string', description: '触发时间，ISO 本地格式 YYYY-MM-DDTHH:MM:SS（由你把自然语言换算好）' },
          repeat: { type: 'string', description: 'none（默认，一次性）| daily（每天）| weekly（每周）' },
          days: { type: 'number', description: '重复几天（可选）。repeat=daily/weekly 时有效，如"监督一星期/连续七天"填 7；不填 = 一直重复' },
          taskId: { type: 'string', description: 'action=cancel 时的任务 id' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const ST = await import('./scheduled-tasks.js');
          const action = String(args.action || 'create').toLowerCase();
          const now = new Date();

          if (action === 'list') {
            const list = ST.tasksOf(ctx.chatKey);
            if (!list.length) return ok('当前没有待触发的定时任务。');
            return ok('【待触发的定时任务】\n' + list.map((t) => '· ' + ST.describeTask(t) + '（id: ' + t.id + '）').join('\n'));
          }
          if (action === 'cancel') {
            const id = String(args.taskId || '').trim();
            if (!id) return err('取消任务需要 taskId（可先用 action=list 查看）');
            return ST.removeTask(id) ? ok('已取消任务 ' + id) : err('没找到任务 ' + id);
          }
          if (action === 'clear') {
            const n = ST.clearTasks(ctx.chatKey);
            return ok('已清空 ' + n + ' 条定时任务。');
          }

          // create
          const text = String(args.text || '').trim();
          if (!text) return err('需要 text（到点要做什么）');
          const atStr = String(args.at || '').trim();
          if (!atStr) return err('需要 at（触发时间，ISO 格式如 2026-09-14T08:00:00）');
          const at = new Date(atStr).getTime();
          if (!Number.isFinite(at)) return err('at 格式不对，应为 YYYY-MM-DDTHH:MM:SS');
          if (at <= now.getTime()) return err('at 是过去的时间，请给未来的时间');
          const repeat = String(args.repeat || 'none').toLowerCase();
          // 持续天数：daily/weekly + days → 换算成截止时间（第 days 次之后停）。
          // "监督我一星期"以前只能建成永久 daily，一周后她还在问，就成了骚扰。
          const days = Math.max(0, Math.min(60, Math.floor(Number(args.days) || 0)));
          const stepMs = repeat === 'weekly' ? 7 * 86400000 : 86400000;
          const until = days >= 1 && repeat !== 'none' ? at + (days - 1) * stepMs : 0;
          const t = ST.addTask({ chatKey: ctx.chatKey, text, at, repeat, until });
          const diffMin = Math.round((at - now.getTime()) / 60000);
          const spanText = until
            ? `，连续 ${days} 次，到 ${new Date(until).toLocaleDateString('zh-CN')} 为止`
            : '';
          return ok({
            created: true,
            id: t.id,
            when: ST.describeTask(t),
            note: '任务已记下，到点我会主动发消息。可以告诉主人「好，' + diffMin + ' 分钟后提醒你」，'
              + (repeat === 'none' ? '就这一次。' : `之后${repeat === 'daily' ? '每天' : '每周'}这个时候都会说${spanText}。`)
          });
        } catch (error) {
          return err(`定时任务操作失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'wait_for_mention',
      description: '【暂时安静，等被点名再开口】群聊里这一轮没什么好接的，但又不想彻底失联时用它：接下来一段时间（默认 20 分钟）除非有人 @你、叫你名字、引用你，否则不会被叫醒。私聊不要用。用完之后这一轮直接结束，不要再发消息。',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '安静多久（1–60 分钟，默认 20）' },
          note: { type: 'string', description: '给自己留一句话：等什么（例如「等他们聊到考试再插嘴」）' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind !== 'group') return err('私聊不能"等被叫"：私聊里对方说话就是要回。');
          const minutes = Math.max(1, Math.min(60, Number(args?.minutes) || 20));
          const last = Array.isArray(ctx.triggerEntries) && ctx.triggerEntries.length
            ? ctx.triggerEntries[ctx.triggerEntries.length - 1] : null;
          const r = getMentionWait().set(ctx.chatKey, {
            ttlMs: minutes * 60 * 1000,
            speakerId: String(last?.senderId || ''),
            note: String(args?.note || ''),
          });
          return ok({
            waiting: true,
            until: new Date(Number(r?.until) || (Date.now() + minutes * 60000)).toLocaleTimeString('zh-CN', { hour12: false }),
            note: `接下来 ${minutes} 分钟只在被 @/点名时才会叫你。这一轮请直接结束，不要发消息。`
          });
        } catch (error) {
          return err(`设置"等被叫"失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'receive_file',
      description: '把主人发来的 QQ 文件（[文件：xxx] 占位符的消息）下载到工作目录，得到本地路径后就可以读取/解析/转交 DSH。id 用聊天记录里每条消息前的 #数字（没有 #数字时先用 get_recent_messages 查）。传了 messageId 会列出该消息里所有文件。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' },
          fileIndex: { type: 'number', description: '同一条消息里有多个文件时指定第几个（从 0 开始），默认 0' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const files = (entry.media || []).filter((m) => m.kind === 'file');
          if (!files.length) return err('这条消息里没有文件（可能只有图片或文字）');
          const idx = Math.max(0, Math.min(Number(args.fileIndex) || 0, files.length - 1));
          const f = files[idx];
          if (!f.fileId) return err('这个文件缺少 file_id，无法下载（可能是旧消息或 NapCat 未提供）');

          // 下载目录：工作区固定子目录，方便交给 DSH
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          const cfgmod = await import('./config.js');
          const inbox = pathmod.join(cfgmod.DATA_DIR, 'inbox');
          fsmod.mkdirSync(inbox, { recursive: true });
          const safeName = String(f.name || 'file').replace(/[\/:*?"<>|]/g, '_');
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const dest = pathmod.join(inbox, `${stamp}_${safeName}`);

          // NapCat get_file：拿下载地址，再取回文件
          const info = await ctx.onebot.call('get_file', { file_id: f.fileId }, 30000).catch((e) => {
            throw new Error('get_file 失败：' + (e?.message || e));
          });
          const urls = [info?.url, info?.file, info?.data?.url, info?.data?.file].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
          if (!urls.length) return err('NapCat 没有返回可下载地址：' + JSON.stringify(info).slice(0, 200));
          const res = await fetch(urls[0], { signal: AbortSignal.timeout(120000) });
          if (!res.ok) return err('下载失败 HTTP ' + res.status);
          const buf = Buffer.from(await res.arrayBuffer());
          fsmod.writeFileSync(dest, buf);

          return ok({
            saved: dest,
            name: f.name || safeName,
            size: buf.length,
            note: '文件已下载到本地。可以直接读取内容，或用 dsh_task 让 DSH 处理（把上面这个 saved 路径写进任务描述）。'
          });
        } catch (error) {
          return err(`接收文件失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'send_file',
      masterOnly: true,
      description: '【主人专属】把本地文件（DSH 任务产物，位于本项目 dsh-work/ 下）作为文件消息发送到当前聊天。主人任务完成后要文件时用。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '本地文件绝对路径（限 dsh-work/ 或 workspace/ 或 /tmp）' },
          fileName: { type: 'string', description: '可选：发送时显示的文件名' }
        },
        required: ['filePath']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.filePath ?? '').trim();
          if (!raw) return err('filePath 不能为空');
          const allowedPrefixes = [DSH_WORK_DIR, WORKSPACE_DIR, ...TEMP_DIRS];
          const okPath = allowedPrefixes.some((p) => raw.startsWith(p)) && !raw.includes('..');
          if (!okPath) return err('文件路径不在允许范围（仅 dsh-work/workspace/tmp）');
          const fs2 = await import('node:fs');
          if (!fs2.existsSync(raw)) return err(`文件不存在: ${raw}`);
          const stat = fs2.statSync(raw);
          if (!stat.isFile()) return err('目标不是文件');
          if (stat.size > 50 * 1024 * 1024) return err('文件超过 50MB 上限');
          const result = await ctx.sender.sendFile(ctx.chatKey, raw, String(args.fileName || '').trim() || undefined);
          ctx.session.sent.push({ type: 'file', text: `[文件:${String(args.fileName || raw.split('/').pop())}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, fileId: result?.file_id ?? null, note: '文件已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索表情库（含备注、场景标签和用法）。query 直接填场景词最有效，例如 嘲讽/无语/夸赞/撒娇/吐槽/AI话题/笑/哭。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词：场景标签（推荐）或任意关键词，匹配备注/笔记/用法/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          let sticker = await ctx.stickers.find(args.stickerId);
          if (!sticker) return err(`找不到表情 ${args.stickerId}`);
          let localPath = stickerLocalCopy(sticker);
          if (!localPath && /^https?:\/\//i.test(String(sticker.url || ''))) {
            const healed = await ctx.stickers.ensureLocalCopy(sticker.id).catch(() => null);
            if (healed) {
              sticker = healed;
              localPath = stickerLocalCopy(healed);
            }
          }
          if (!localPath && !sticker.url) return err('该表情没有图片地址');
          const { urls, gifFrames } = localPath ? await localImageDataUrls(localPath) : await downloadImageDataUrls(sticker.url);
          // 表情包大半是 GIF 动图：拆帧后要说明「这是同一张图的几帧」，
          // 否则模型会照着三帧描述成「三个表情」。
          const gifNote = gifFrames ? `（这是动图，已拆成 ${gifFrames} 帧）` : '';
          if (usingQwenVision()) {
            return ok(await describeImage(
              urls,
              `这是一个 QQ 表情（备注：${sticker.desc || '无'}）。${gifNote}请描述画面和它适合表达的情绪/语境，简短准确。`,
              'sticker'
            ));
          }
          return { content: imageParts(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：${gifNote}`, urls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
          if (!entry) return err(`找不到表情 ${args.stickerId}`);
          return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          const saved = await ctx.stickers.collect(args.messageId, {
            url: imageMedia.url,
            note: String(args.note ?? ''),
            fileName: imageMedia.file || ''
          });
          const cached = !!stickerLocalCopy(saved);
          return ok({
            collected: true,
            id: saved.id,
            note: saved.localNote,
            localCopy: cached,
            hint: cached
              ? '已保存本地副本，之后可以稳定发送'
              : '本地副本没存下来（图片地址可能是临时链接），之后发送可能失败'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_voice',
      description: '把一句话用语音发出去（作为 QQ 语音消息）。优先用角色本音（胡桃/纳西妲/花火/流萤/芙宁娜/神里绫华，来自官方微调模型），失败时降级普通 TTS+音色转换。一条消息只能一条语音、不能带文字：想同时说话就先用 send_message 单独发文字。文本要短（建议 ≤120 字，最多 300 字），别拿它念长文；被要求"说句话/用语音"、或想带情绪语气时用它，别频繁发。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话（短句）' },
          voice: { type: 'string', enum: ['robin', 'hutao', 'nahida', 'sparkle', 'liuying', 'furina', 'ayaka'], description: '一般不用传：发语音的音色由「设置 → 语音音色 → 角色本音」决定（默认忽略本参数）。只有设置里打开了「允许模型临时换音色」时才生效。' },
          style: { type: 'string', description: '可选：补充说明，短一点。真正的语气由 emotion 决定（见下），这里只写 emotion 表达不出来的细节，如“带点鼻音”“像在耳边小声说”。' },
          emotion: {
            type: 'string',
            enum: [...EMOTION_NAMES, '吃惊', '恐惧', 'auto'],
            description: '可选：这句话的语气。默认 auto = 用你此刻的心情（提示词里【此刻的语气】会告诉你填什么）。'
              + '填了会真的换情绪参考音频（该音色有的话）+ 调语速和韵律，比 style 有效得多。'
              + '开心/兴奋/得意/好奇/害羞/别扭/委屈/失落/没劲/嫌弃/假生气/心疼/累/平静/吃惊/恐惧。'
              + '连续几条语音别用同一个——语气要跟着话题走。'
          },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          const cfg = qwenAudioConfig();
          const rawText = String(args.text ?? '').trim();
          if (!rawText) return err('text 不能为空：要说的话得先写出来');
          const text = toSpeechText(rawText, { maxLen: cfg.maxChars || 300 });
          // ★ 音色由「设置 → 语音音色 → 角色本音」决定（config.audio.gsvVoice）。
          //   默认 gsvAllowModelPick=false：模型传的 voice 一律忽略 —— 否则设置里选了流萤，
          //   模型自己挑个胡桃，用户听到的还是胡桃，表现为"设置里根本切不了"。
          const cfgVoice = String(qwenAudioConfig().voiceKey || 'hutao').trim().toLowerCase();
          const modelVoice = String(args.voice || '').trim().toLowerCase();
          const voiceKey = (cfg.allowModelPick && modelVoice) || cfgVoice || modelVoice || 'hutao';
          const rvNow = rvcConfig();
          // 知更鸟没有 GPT-SoVITS 模型：voice=robin 走 RVC。
          // ★ preferOverGsv 只对胡桃生效：它当初是为了绕开"胡桃 v4 太慢（RTF 3.6~6.9）"。
          //   RVC 换的是配置里那**一个**模型（默认胡桃），如果对所有音色都套用它，
          //   请求纳西妲/流萤/芙宁娜/神里绫华时发出去的全是胡桃的声音 —— 音色参数形同虚设。
          //   新装的几个 v2ProPlus/v4 音色 RTF 约 0.5，没必要再绕。
          const gsvKnown = Object.prototype.hasOwnProperty.call(GSV_VOICES, voiceKey);
          const useRvcOnly = voiceKey === 'robin'
            || (rvNow.preferOverGsv === true && (voiceKey === 'hutao' || !gsvKnown));
          let spoken = null;
          let engineNote = useRvcOnly ? 'TTS→RVC（知更鸟）' : '';

          // ── 语气计划（voice-delivery.js）────────────────────────────────
          // 一句话的语气 = 情绪标签 → 参考音频 + 语速偏置 + 韵律参数 + 写法提示。
          // 优先级：模型显式传的 emotion > 它此刻的心情（ctx.vibeEmotion）> 中性档。
          // ★ 这里用**实际** voiceKey 再算一次（而不是直接用编排层算好的那份）：
          //   gsvAllowModelPick 打开时模型可能临时换音色，而"能不能换参考音频"取决于
          //   该音色有没有这条情绪参考 —— 胡桃只有 1 条，流萤有 6 条，必须现算。
          const toneRefs = Object.keys(GSV_VOICES[voiceKey]?.emotions || {});
          const tonePlan = resolveTone({
            emotion: args.emotion,
            vibeEmotion: ctx.vibeEmotion,
            voice: voiceKey,
            availableRefs: toneRefs,
            moodScore: ctx.moodScore,
            strength: cfg.toneStrength,
            enabled: cfg.toneAuto !== false
          });
          // style 仍然有用：它只在"情绪没命中"时补位（见 gsvSpeak 里的优先级），
          // 命中时仅作日志，方便排查"我说了语气但听感没变"。
          const styleNote = args.style ? ` style=${String(args.style).slice(0, 20)}` : '';
          if (tonePlan.enabled) console.log(`[voice] ${describeTone(tonePlan)}${styleNote}`);

          // ① 首选：GPT-SoVITS 角色本音（不依赖千问）
          if (!useRvcOnly) {
            try {
              const gsv = await gsvSpeak(text, { voice: voiceKey, style: args.style, plan: tonePlan });
              spoken = { buffer: gsv.buffer, ext: gsv.ext, characters: text.length, voice: gsv.voice, model: 'gpt-sovits' };
              const toneTag = gsv.emotion ? `/${gsv.emotion}${gsv.mode === 'ref' ? '（换参考音频）' : '（仅参数）'}` : '';
              engineNote = `角色本音=${gsv.voice}${toneTag}（${(gsv.costMs / 1000).toFixed(1)}s）`;
            } catch (e) {
              engineNote = '角色本音不可用（' + String(e?.message ?? e).slice(0, 80) + '），降级普通 TTS';
            }
          }

          // ② 降级：千问 TTS + RVC 换音色
          if (!spoken) {
            if (!cfg.enabled) return err('语音功能没开：请到 设置 → 模型 API 打开"语音"');
            // ★ instruction 的取法变了（2026-10-29）：
            //   以前直接把模型的自由文本 style 塞进 instruction。在 cosyvoice-* 上，
            //   自由描述会被 normalizeCosyvoiceInstruction 归一化成固定句式，
            //   认不出情绪就落到 happy —— 于是"语气指令"在兜底链上等于不存在，
            //   而且**整个请求会失败**（418）。现在优先用情绪表里的 cosyvoice 标签，
            //   保证落到合法句式上；配置里的 instruction 只作为风格前缀。
            const baseInstruction = String(cfg.instruction || '').trim();
            const styleText = String(args.style || '').trim();
            let instruction;
            if (tonePlan.enabled && isCosyvoice(cfg.model)) {
              // CosyVoice 只认「你说话的情感是X。」这一种句式。与其把中文描述丢给
              // normalizeCosyvoiceInstruction 去猜关键词（"心疼"里没有 sad 的词，
              // 会被猜成 happy），不如直接把情绪表算好的标签给它 —— 确定、不猜。
              instruction = `你说话的情感是${tonePlan.cosyvoice}。`;
            } else {
              instruction = [baseInstruction, tonePlan.enabled ? tonePlan.line : '', styleText]
                .filter(Boolean).join('；') || undefined;
            }
            spoken = await synthesizeSpeech({ text, instruction });
            if (tonePlan.enabled) engineNote += `；语气=${tonePlan.emotion}/${tonePlan.cosyvoice}`;

            try {
              const rv = rvcConfig();
              // RVC 现在按角色找同名模型（rvc/models/<voice>.pth，花火=huahuo）。
              // 找不到就宁可不换：换成胡桃再发，等于把别人的台词演成胡桃。
              const targetModel = rvcModelForVoice(voiceKey);
              if (rv.enabled && targetModel) {
                const conv = await convertVoice(spoken.buffer, { format: 'wav', model: targetModel });
                if (conv.converted) {
                  spoken = { ...spoken, buffer: conv.buffer, ext: conv.ext };
                  engineNote += `；RVC=${conv.model || targetModel}`;
                }
              } else if (rv.enabled && !targetModel) {
                engineNote += `；RVC 跳过（rvc/models 里没有 ${voiceKey}.pth）`;
              }
            } catch (error) {
              engineNote += '；RVC 失败';
            }
          }
          const dir = path.join(DATA_DIR, 'voice');
          fs.mkdirSync(dir, { recursive: true });
          const name = 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + spoken.ext;
          const file = path.join(dir, name);
          fs.writeFileSync(file, spoken.buffer);
          pruneVoiceDir(dir);
          const source = cfg.sendAsBase64 ? 'base64://' + spoken.buffer.toString('base64') : file;
          const label = text.slice(0, 40);
          let result = null;
          let fallbackNote = '';
          try {
            result = await ctx.sender.sendVoice(ctx.chatKey, { file: source, label }, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            ctx.session.sent.push({ type: 'voice', text: '[语音：' + label + ']', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          } catch (sendError) {
            // 语音这条路彻底走不通时**别把话咽回去**：改成文字发出去，并如实告诉模型
            // 是"发的形式"失败了，不是内容失败。以前这里直接抛错，模型以为没说话，
            // 用户那边就是"它用语音回复不了/干脆不理我"。
            const reason = String(sendError?.message ?? sendError).slice(0, 120);
            await ctx.sender.sendTextBatch(ctx.chatKey, [rawText], {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            ctx.session.sent.push({ type: 'text', text: rawText, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
            fallbackNote = `语音没能发出去（${reason}），这句话已经改用文字发出去了。别再说"我用语音说"，也别重试。`;
          }
          ctx.emit('session-update', ctx.session.id);
          return ok({
            sent: true,
            mode: result ? 'voice' : 'text-fallback',
            messageId: result?.message_id ?? null,
            chars: spoken.characters,
            model: spoken.model,
            voice: spoken.voice,
            engine: engineNote,
            note: fallbackNote || '语音已发送。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sing_convert',
      description: '用「胡桃的歌声」唱一段音频（歌声音色转换）。来源二选一：messageId=群友发的语音/音频文件（聊天记录里的 #数字），url=音频直链。默认会把人声分离出来换成胡桃的声音、再和伴奏混好，作为语音消息发出。整首歌处理较慢（1 分钟的歌约 20~60 秒），只在有人明确要求“用胡桃声音唱/翻唱/唱这首歌”时用，不要主动频繁调用。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '音频所在消息 id（聊天记录里的 #数字）' },
          url: { type: 'string', description: '音频链接：B站/YouTube/抖音视频页、网易云/QQ音乐/酷狗/酷我歌曲页、或音频直链都行（mp3/wav/flac/m4a 等）。不用自己先下载' },
          trans: { type: 'integer', description: '升降调（半音），默认 0；男声转女声可试 +5~+12' },
          mix: { type: 'boolean', description: '是否保留伴奏（默认 true）。false=只要人声' },
          engine: { type: 'string', enum: ['svc', 'seedvc'], description: '转换引擎：svc=so-vits-svc（默认，快但要胡桃模型）；seedvc=Seed-VC（零样本，慢，CPU 约 5 分钟/段，音质更自然）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id' }
        }
      },
      async execute(ctx, args) {
        try {
          const c = svcConfig();
          if (!c.enabled) return err('唱歌功能没开：请到 设置 → 语音 打开"唱歌"');

          // ── 1. 取音频 ────────────────────────────────────────────────
          let buffer = null;
          let srcNote = '';
          if (args.messageId !== undefined && args.messageId !== null && String(args.messageId).trim() !== '') {
            const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
            if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
            const media = Array.isArray(entry.media) ? entry.media : [];
            const rec = media.find((m) => m.kind === 'record');
            if (rec) {
              const got = await loadVoiceBytes(ctx, rec);
              buffer = got.buffer;
              srcNote = '群友的语音';
            } else {
              const fileMedia = media.find((m) => m.kind === 'file' || m.kind === 'video');
              if (!fileMedia) {
                return err(`消息 ${args.messageId} 里没有音频/文件。让它先把歌发过来，或直接给我一个音频直链（url）。`);
              }
              const local = String(fileMedia.file || '');
              if (path.isAbsolute(local) && fs.existsSync(local)) {
                buffer = fs.readFileSync(local);
                srcNote = path.basename(local);
              } else if (/^https?:/i.test(String(fileMedia.url || ''))) {
                const got = await safeFetchBinary(String(fileMedia.url), 60 * 1024 * 1024);
                buffer = got.buffer;
                srcNote = '群文件';
              } else if (String(fileMedia.fileId || '').trim()) {
                // 群文件消息只有 file_id，下载地址要现问 NapCat 要（见 fetchFileById）
                const got = await fetchFileById(ctx, String(fileMedia.fileId).trim(), 60 * 1024 * 1024, fileMedia.name);
                buffer = got.buffer;
                srcNote = got.name || '群文件';
              } else {
                return err(`消息 ${args.messageId} 的音频拿不到（协议端既没给下载地址也没给 file_id），试试让它重新发一遍或给 url。`);
              }
            }
          } else if (String(args.url || '').trim()) {
            const u = String(args.url).trim();
            const got = await fetchAudioBufferFromUrl(u, 60 * 1024 * 1024);
            buffer = got.buffer;
            srcNote = got.note || '链接';
          } else {
            return err('要给我音频来源：messageId（群友发的语音/文件）或 url（B站/音乐平台链接、音频直链）');
          }
          if (!buffer || !buffer.length) return err('取到的音频是空的');

          // 粗估时长（mp3 192kbps≈24KB/s；wav 44.1k 16bit≈88KB/s），防止超长音频把 GPU 占死
          const estSec = Math.round(buffer.length / (buffer.slice(0, 4).toString('ascii') === 'RIFF' ? 88000 : 24000));
          if (estSec > c.maxSeconds) {
            return err(`音频太长（约 ${estSec} 秒，上限 ${c.maxSeconds} 秒）。让它发一段 3 分钟以内的，或先剪短。`);
          }

          // ── 2. 转换 ────────────────────────────────────────────────
          if (typeof ctx.emit === 'function') ctx.emit('log', { text: `[唱歌] ${srcNote} 约 ${estSec}s，开始转换…` });
          const doMix = args.mix === undefined || args.mix === null ? true : args.mix !== false;
          let r;
          if (args.engine === 'seedvc') {
            // Seed-VC 零样本转换：直接把整段音频换成胡桃音色（不分离伴奏）
            const h = await seedVcHealth(5000);
            if (!h.ok) return err('Seed-VC 引擎不可用：' + (h.reason || h.status || '未运行'));
            if (typeof ctx.emit === 'function') ctx.emit('log', { text: `[唱歌] 用 Seed-VC 零样本转换（CPU 约 3~5 分钟，请耐心）…` });
            const sv = await seedVcConvert(buffer, { diffusionSteps: 20, f0Condition: true, pitchShift: args.trans ?? 0 });
            r = { buffer: sv.buffer, ext: 'wav', model: 'seed-vc', vocalSec: sv.seconds };
          } else {
            r = doMix
              ? await singSong(buffer, { trans: args.trans ?? null, mix: true, log: null })
              : await convertSinging(buffer, { trans: args.trans ?? null });
          }

          // ── 3. 发出 ────────────────────────────────────────────────
          const dir = path.join(DATA_DIR, 'voice');
          fs.mkdirSync(dir, { recursive: true });
          const name = 'sing-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + r.ext;
          const file = path.join(dir, name);
          fs.writeFileSync(file, r.buffer);
          pruneVoiceDir(dir);
          const label = '胡桃翻唱';
          // QQ 语音消息有时长上限（超了协议端会拒收），整首歌就走文件发送。
          const maxVoiceSec = Math.max(10, Number(getConfig()?.audio?.svc?.maxVoiceSeconds) || 60);
          const outSec = Math.round(wavDurationSec(r.buffer) * 10) / 10;
          const asFile = outSec > maxVoiceSec;
          let sent = null;
          if (asFile) {
            sent = await ctx.sender.sendFile(ctx.chatKey, file, '胡桃翻唱-' + Math.round(outSec) + 's.wav');
            ctx.session.sent.push({ type: 'file', text: `[文件：胡桃翻唱 ${Math.round(outSec)}s]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          } else {
            // 与 send_voice 一致：NapCat 在别的机器时用 base64 内联
            const useB64 = getConfig()?.audio?.sendAsBase64 === true;
            const source = useB64 ? 'base64://' + r.buffer.toString('base64') : file;
            sent = await ctx.sender.sendVoice(ctx.chatKey, { file: source, label }, {
              replyToMessageId: args.replyToMessageId ?? null
            });
            ctx.session.sent.push({ type: 'voice', text: '[语音：' + label + ']', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          }
          if (typeof ctx.emit === 'function') ctx.emit('session-update', ctx.session.id);
          return ok({
            sent: true,
            messageId: sent?.message_id ?? null,
            model: r.model,
            source: srcNote,
            asFile,
            seconds: outSec,
            note: asFile
              ? `音频约 ${Math.round(outSec)} 秒，超过 QQ 语音上限 ${maxVoiceSec} 秒，已作为音频文件发出。跟群友说一句"整首太长，发文件了"即可。`
              : '已用胡桃的歌声发出。不要向群友解释处理过程，就当自己唱的。',
            mix: doMix,
            trans: args.trans ?? c.trans,
            costSec: Math.round((r.costMs || 0) / 100) / 10
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'play_song',
      description: '从「点歌台」（B站缓存整理出来的本地歌单）里点播一首原曲，直接把音频文件发到群里。'
        + '★ 这是「放原曲」，不是让角色翻唱：群友说「放首歌」「点播」「听听XX」「来首XX的原版」用这个；'
        + '说「唱XX」「你来唱」才用 sing_lyrics / sing_cover。'
        + '★ 匹配不唯一时会返回候选列表，不要自己猜：把序号和歌名用一句话念给群友，让他回「#点歌 序号」。'
        + '★ 发送是即时的（命中缓存 1 秒内，首次转码约 3~6 秒），不需要排队，也不要说「稍等几分钟」。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '歌名、歌手或关键词。群友直接粘 B站链接/BV号时，把这个链接或 BV 号原样传进来（按 BV 精确匹配缓存）。群友只说了「随便来一首」时留空并把 random 设为 true' },
          random: { type: 'boolean', description: '可选：true=从歌单里随机挑一首' },
          asVoice: { type: 'boolean', description: '可选：true=发一条 45 秒语音条试听，而不是整首文件' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          if (!playlistConfig().enabled) return err('点歌台没开：请到 设置 → 点歌台 打开');
          const lib = await ensureLibrary({ log: (m) => ctx.emit?.('log', { text: m }) });
          if (!lib) return err('点歌台还没建好，请主人先重扫歌单');

          const kw = String(args.keyword || '').trim();
          if (!kw && args.random !== true) return err('要点哪首？给个歌名或关键词');

          const r = resolvePlayQuery(args.random === true ? '随机' : kw, { lib });
          if (!r.track) {
            if (r.reason === 'ambiguous') {
              return ok({
                found: false,
                candidates: r.candidates.map((c) => ({
                  no: c.track.no, title: c.track.title, artist: c.track.artist, score: c.score,
                })),
                note: '匹配到多首。用一句话把序号和歌名报给群友，让他回「#点歌 序号」；不要自己替他挑。',
              });
            }
            if (r.reason === 'notCached') {
              return ok({
                found: false, candidates: [], bvid: r.bvid,
                note: `这个 BV 号（${r.bvid}）不在缓存歌单里，点不了原曲。`
                  + '如实告诉群友「这首还没缓存下来」，不要假装在准备。',
              });
            }
            if (r.reason === 'collection') {
              const t = r.candidates[0].track;
              return ok({
                found: false,
                candidates: [{ no: t.no, title: t.title, kind: t.kind }],
                note: `《${t.title}》是合集/语音包（约 ${Math.round(t.duration / 60)} 分钟），整段发太大。`
                  + `如果群友确实要，让他回「#点歌 ${t.no}」确认。`,
              });
            }
            return ok({
              found: false, candidates: [],
              note: `歌单里没有《${kw}》。可以换个关键词，或如实告诉群友没有这首；不要编造。`,
            });
          }

          const out = await playTrack(ctx.sender, ctx.chatKey, r.track, {
            mode: args.asVoice === true ? 'voice' : undefined,
            replyToMessageId: args.replyToMessageId ?? null,
          });
          return ok({
            played: true,
            no: r.track.no,
            title: r.track.title,
            artist: r.track.artist,
            mode: out.mode,
            seconds: out.seconds,
            note: '已经发到群里了。用一句话接住即可（比如「放上了」），不要解释转码/缓存过程。',
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sing_lyrics',
      description: '群友点歌/让角色唱歌时用这个，有两种用法：①「唱：歌词」这种给了具体歌词 → 填 lyrics；②「唱个反方向的钟」只报了歌名 → 把歌名填 title、lyrics 留空。'
        + '★ 只给歌名时系统会自动选路：本地曲库有原曲就直接原曲翻唱（RVC，音准节奏跟原唱一致，最像）；只有旋律就按原曲旋律唱；都没有才用算法旋律。所以你不用自己判断用哪个工具。'
        + '★ 给了歌词又给了歌名、而旋律库里没有这首时，系统会**现场从原曲扒一段旋律**再唱（约多花 1 分钟，自动完成）。所以「唱：xxx」+ 歌名是最像原曲的唱法，鼓励这么用；只有歌词没有歌名才是纯算法旋律。'
        + '★ 连原曲都没有的歌（曲库里查不到）：让群友**哼一段或发一小段原曲**（语音、文件、音乐链接都行），下次调用时把那条消息填进 messageId，系统从这段音频里扒出旋律再唱 —— 这样唱出来的调是真的，不是现编的。'
        + '★★★【没有调就不唱】群友既不给音频也不肯哼，而曲库/旋律库里又没有这首歌时，本工具会直接返回 needsMelody=true 拒绝开唱 —— 算法现编的旋律在听众耳朵里就是乱唱。'
        + '收到 needsMelody 时：用一句话老实要素材（发文件或哼一段都行），【不许说「我唱了」「排上了」】，也不许自己编歌词凑数。'
        + '★ 默认出干声（清唱人声，不混伴奏）——这样能听清音准和咬字。群友明确要「带伴奏/背景音乐」时传 noAcc=false。'
        + (MELODY_NAMES.length
          ? `旋律库现有：${MELODY_NAMES.join('、')}（给了歌词又报了这些歌名时会自动按对应旋律唱）。`
          : '')
        + '可用角色：胡桃(hutao)、纳西妲(nahida)、知更鸟(robin)。真唱引擎不可用时会自动降级为念白并如实告知。'
        + '★ 群友只说「唱首歌」「你来一首」却没点名唱哪首：title 留空即可（系统会唱设置里的默认曲目），别反问「想听什么」。'
        + '★ 本工具是异步的：调用后立即返回排队结果（queued=true，含预计秒数），不会卡住对话。'
        + '拿到排队结果后，只用一句话告诉对方「排上了、大概多久」，绝不要说「马上就好」，也绝不重复调用；成品由系统稍后自动发到本会话。'
        + '如果返回 needsLyrics=true，说明这首歌只有旋律没有词，要用一句话问群友「要唱哪段词」。',
      parameters: {
        type: 'object',
        properties: {
          lyrics: { type: 'string', description: '要唱的歌词文本（去标点，≤200 字）。群友只报歌名、没给具体歌词时留空' },
          title: { type: 'string', description: '歌名。群友说「唱个X」但没给歌词时填这里；给了歌词也可以填，系统会自动配上这首歌的原曲旋律' },
          dur: { type: 'number', description: '仅点歌模式（只给歌名、走原曲翻唱）时有用：要唱多少秒，默认 60，建议 30~90' },
          start: { type: 'number', description: '仅点歌模式有用：从原曲第几秒开始，默认 0。主歌/副歌常不在开头' },
          voice: { type: 'string', enum: ['hutao', 'nahida', 'robin'], description: '用谁的声音唱：hutao=胡桃（默认）、nahida=纳西妲、robin=知更鸟（音色更亮更清，唱高音更稳）' },
          style: { type: 'string', description: '可选：语气/情绪，如“俏皮轻快”“温柔”' },
          bpm: { type: 'number', description: '可选：速度，默认 92。慢歌 70-85，快歌 100-120' },
          key: { type: 'string', description: '可选：调性根音，默认 B3（最接近胡桃音区）' },
          noAcc: { type: 'boolean', description: '可选：true=只要干声（清唱人声，不加自动伴奏），false=带伴奏。不传按设置里的默认（默认干声）。群友说「清唱/不要伴奏/只听人声」就传 true，说「带伴奏/加点背景」就传 false' },
          hq: { type: 'boolean', description: '可选：true=发高音质音频文件（44.1kHz）而不是语音条。群友要「高音质」时传' },
          full: { type: 'boolean', description: '可选：true=发完整音频文件。群友说「要完整版/发文件/下载给我/这段太短」时传。不传默认发语音条（超过约 2 分钟会自动改成文件）' },
          noMelody: { type: 'boolean', description: '可选：true=只念不唱（跳过旋律）' },
          dry: { type: 'boolean', description: '可选：仅点歌模式（只给歌名、走原曲翻唱）时有用：true=只要干声（清唱人声），false=带原曲伴奏的混音成品。不传按设置默认（默认干声）' },
          melody: {
            type: 'string',
            description: MELODY_NAMES.length
              ? `可选：按哪首曲子的旋律唱（${MELODY_NAMES.join(' / ')}）。报了 title 时会自动匹配，一般不用手填`
              : '可选：按指定旋律唱（旋律库为空，留空即可）',
            ...(MELODY_NAMES.length ? { enum: MELODY_NAMES } : {}),
          },
          melodyTrans: { type: 'number', description: '可选：旋律整体移调（半音，可负）。原调太高/太低导致唱不上去时给 -12~12' },
          noVc: { type: 'boolean', description: '可选：true=跳过真人音色转换（RVC），直接用 DiffSinger 声库的原音色' },
          messageId: { type: ['integer', 'string'], description: '可选：群友发来的「参考音频」所在消息 id（聊天记录里的 #数字）。曲库/旋律库都没有这首歌时，让群友哼一段或发一小段原曲，系统从这段音频里扒出旋律再唱，就不会是乱编的调' },
          url: { type: 'string', description: '可选：参考音频链接。B站/YouTube/抖音的视频页、网易云/QQ音乐/酷狗/酷我的歌曲页、音频直链都能直接吃，不用自己先下载。与 messageId 二选一' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const c = svcConfig();
          // SVC 服务已封存，真唱走 DiffSinger，所以只要真唱引擎在就放行；
          // 两者都不用才提示去设置里开开关。
          if (!c.enabled && !diffSingerReady()) return err('唱歌功能没开：请到 设置 → 语音 打开"唱歌"');

          let title = String(args.title || '').trim();
          let lyrics = String(args.lyrics || '').trim();

          // 模型经常不守参数规矩，把链接直接塞进 title/lyrics（"唱：https://b23.tv/xxx"）。
          // 不抽出来的话，这个链接会被当成歌名去曲库匹配，匹配不到就走到「没有调就不唱」，
          // 群友看着像「给了链接也不认」。这里统一捞一次，塞回 args.url。
          if (!String(args.url || '').trim()) {
            const fromTitle = pickUrlFromText(title);
            const fromLyrics = fromTitle ? '' : pickUrlFromText(lyrics);
            const found = fromTitle || fromLyrics;
            if (found) {
              args = { ...args, url: found };
              if (fromTitle) title = title.replace(found, '').replace(/[：:，,\s]+$/, '').trim();
              if (fromLyrics) lyrics = lyrics.replace(found, '').trim();
              ctx.emit?.('log', { text: `[点歌] 从参数文本里捞到链接：${found}` });
            }
          }

          // ── 0) 群友发来的参考音频（哼唱 / 一小段原曲）→ 落盘待扒谱 ──
          // 曲库、旋律库都没有的歌，只要有「一段能听出调的音频」就能按谱唱；
          // 这比让群友发完整原曲轻得多（哼一句即可），代价是唱出来的是胡桃的音色
          // 而不是原唱音色（翻唱才保留原唱音色）。
          let refAudio = '';
          const hasRef = (args.messageId !== undefined && args.messageId !== null
            && String(args.messageId).trim() !== '') || String(args.url || '').trim();
          if (hasRef) {
            const got = await fetchAudioFromRef(ctx, args);
            // 给了歌词 → 这段音频只是「旋律参考」，放 cache/incoming（不污染曲库）；
            // 没给歌词 → 群友是拿它当「一首歌」点播的，直接进 songs/raw，
            //   以后再报这个名字就能命中曲库，不用重发。
            const wantSong = !String(args.lyrics || '').trim();
            refAudio = await saveIncomingSong(
              got.buffer, `${title || got.title || (wantSong ? '群友发的歌' : '参考音频')}`, got.ext,
              { dir: wantSong ? RAW_SONG_DIR : INCOMING_DIR },
            );
            if (wantSong && !title) title = path.basename(refAudio).replace(/\.[^.]+$/, '');
          }

          // 兜底：模型常把歌名当歌词塞进 lyrics（「唱个反方向的钟」→ lyrics="反方向的钟"）。
          // 短文本且能高置信度匹配到曲库/旋律库时，改判成歌名，否则会去唱「反方向的钟」五个字。
          if (!title && lyrics && lyrics.length <= 12) {
            const guess = planSongRequest({ title: lyrics });
            if (guess.confidence >= 0.9 && (guess.route === 'cover' || guess.melody)) {
              title = lyrics;
              lyrics = '';
            }
          }

          // ── 点歌模式：只有歌名，没有歌词 ──
          if (!lyrics) {
            // 「唱首歌」但没说唱哪首 → 唱默认曲目，不反问（连歌词也没有才算「什么都没有」）。
            if (!title) {
              title = defaultSingTitle();
              if (title) ctx.emit?.('log', { text: `[点歌] 没点名 → 默认唱《${title}》` });
            }
            if (!title) return err('要么给 lyrics（要唱的歌词），要么给 title（歌名）');

            // 群友直接把歌发过来了：不管曲库里有没有，拿这段音频当原曲翻唱 ——
            // 这是「曲库里没有的歌」最直接的唱法，不需要歌词（旋律照抄原唱）。
            if (refAudio && songQueueReady()) {
              const sub = submitCover({
                chatKey: ctx.chatKey,
                args: {
                  src: refAudio,
                  name: title,
                  start: Number(args.start) || 0,
                  dur: Number(args.dur) || 60,
                  dry: args.dry,
                },
              });
              if (sub.cached) {
                return ok({
                  queued: false, cached: true, routed: 'cover',
                  note: '这首之前翻唱过，成品已经直接发到本会话了，不用再等。不要再重复调用本工具。'
                });
              }
              const eta2 = coverEta(sub);
              return ok({
                queued: true, routed: 'cover', jobId: sub.id, position: sub.position,
                etaSec: eta2.eta, waitSec: eta2.wait, etaTotalSec: eta2.total,
                dupOf: sub.dupOf || '',
                savedTo: refAudio,
                note: `拿到音频了，已按原曲翻唱排上队（${eta2.text}）。`
                  + '这首歌已存进曲库，以后报歌名就不用再发。'
                  + '你只需要用一句话告诉对方「排上了、大概几分钟」，不要说"马上就好"，也不要重复调用本工具。'
                  + (sub.dupOf ? '注意：同一首已经在排队了，别再排，告诉对方等一下就行。' : '')
              });
            }

            const plan = planSongRequest({ title });
            if (typeof ctx.emit === 'function') ctx.emit('log', { text: `[点歌] 路由：${describePlan(plan)}` });

            // 曲库（songs/raw）没有、但点歌台的 B站缓存里有 → 那也是原曲，一样能翻唱。
            // 这一步把「能唱的歌」从一两首扩到二十几首，省掉「让群友发文件」这个最容易卡住的环节。
            let playlistHit = null;
            if (plan.route !== 'cover' && !plan.melody) {
              playlistHit = await resolveSongSource(title);
              if (playlistHit?.fromPlaylist) {
                ctx.emit?.('log', { text: `[点歌] 点歌台缓存命中：${playlistHit.title}` });
              }
            }

            if (playlistHit && songQueueReady()) {
              const sub = submitCover({
                chatKey: ctx.chatKey,
                args: {
                  src: playlistHit.path,
                  name: playlistHit.title || title,
                  start: Number(args.start) || 0,
                  dur: Number(args.dur) || 60,
                  dry: args.dry,
                },
              });
              if (sub.cached) {
                return ok({
                  queued: false, cached: true, routed: 'cover',
                  note: '这首之前翻唱过，成品已经直接发到本会话了，不用再等。不要再重复调用本工具。'
                });
              }
              const e = coverEta(sub);
              return ok({
                queued: true, routed: 'cover', jobId: sub.id, position: sub.position,
                etaSec: e.eta, waitSec: e.wait, etaTotalSec: e.total, dupOf: sub.dupOf || '',
                note: `点歌台的缓存里有这首，已经按原曲翻唱排上队（${e.text}）。`
                  + '你只需要用一句话告诉对方「排上了、大概几分钟」，不要说"马上就好"，也不要重复调用本工具。'
                  + (sub.dupOf ? '注意：同一首已经在排队了，别再排，告诉对方等一下就行。' : '')
              });
            }

            if (plan.route === 'cover') {
              if (!songQueueReady()) return err('点歌队列还没起来，稍后再试');
              const sub = submitCover({
                chatKey: ctx.chatKey,
                args: {
                  src: plan.src,
                  name: plan.title,
                  start: Number(args.start) || 0,
                  dur: Number(args.dur) || 60,
                  dry: args.dry,   // 没传就由队列按设置默认（默认干声）
                },
              });
              if (sub.cached) {
                return ok({
                  queued: false, cached: true, routed: 'cover',
                  note: '这首之前翻唱过，成品已经直接发到本会话了，不用再等。不要再重复调用本工具。'
                });
              }
              const e = coverEta(sub);
              return ok({
                queued: true, routed: 'cover', jobId: sub.id, position: sub.position,
                etaSec: e.eta, waitSec: e.wait, etaTotalSec: e.total, dupOf: sub.dupOf || '',
                note: `曲库里有原曲，已经按原曲翻唱排上队（${e.text}）。`
                  + '你只需要用一句话告诉对方「排上了、大概几分钟」，不要说"马上就好"，也不要重复调用本工具。'
                  + (sub.dupOf ? '注意：同一首已经在排队了，别再排，告诉对方等一下就行。' : '')
              });
            }

            // 没有原曲音频 → DiffSinger 需要歌词才能唱，不能凭空生成
            const hint = plan.melody
              ? `《${plan.melody}》的旋律我这里存着，但还缺歌词`
              : `《${title}》我这里既没有原曲也没有歌词`;
            return ok({
              needsLyrics: true,
              title,
              melody: plan.melody || '',
              note: `${hint}。用一句话跟群友要素材（发文件/语音/链接最快，下次调用填 messageId 或 url）—— `
                + '有音频我就能按原曲翻唱，连歌词都不用；或者让他哼一段，我照哼的调唱。'
                + '别自己编歌词，也别说「我唱了/排上了」。'
            });
          }

          // ── 有歌词：自动补旋律（报了歌名且旋律库有，就按原曲的调唱）──
          let melody = String(args.melody || '').trim();
          let melodyAuto = false;
          if (!melody && title) {
            const m = findMelody(title);
            if (m) { melody = m.name; melodyAuto = true; }
          }

          // 旋律库里没有、但曲库里有原曲 → 作业里会现场扒一段（见 melody-auto.js）。
          // 这里只是把「会多花一分钟」提前告诉模型，让它回执时说得准。
          let melodyHint = '';
          // 曲库没有再退到点歌台缓存（B站缓存里的原曲也能现场扒谱）
          const localSong = title ? (findLocalSong(title) || await findSongInPlaylist(title)) : null;
          if (!melody && localSong) {
            melodyHint = '，先从原曲现场扒一段旋律（约多花 1 分钟）';
          } else if (!melody && refAudio) {
            melodyHint = '，先从你发的这段音频里扒一段旋律（不分离，快一些）';
          }

          // ── 没有「调」就不唱 ──
          // 算法现编的旋律在听众耳朵里就是乱唱（群里实测：唱完被说「别唱了」）。
          // 所以默认只在有旋律来源时才开口：旋律库有谱 / 曲库有原曲（现场扒）/
          // 群友发了音频（哼唱也行）。三者都没有 → 如实要素材，不排队。
          // 想放开就在 设置 → 语音 → 唱歌 里勾「没有原曲时允许现编」。
          const melodySource = melody ? 'melody' : (localSong ? 'song' : (refAudio ? 'ref' : ''));
          if (!melodySource && args.noMelody !== true && !svcConfig().allowImprovise) {
            const what = title ? `《${title}》` : '这段词';
            return ok({
              needsMelody: true,
              improviseOff: true,
              title: title || '',
              note: `${what}我这里既没有原曲也没有谱，你也没发音频 —— 没有调我不乱唱，编出来的调听着就是跑调。`
                + '用一句话跟群友要素材（二选一，都行）：① 把歌当文件或语音发过来；② 自己哼一段（10~30 秒就够，走音也没关系）。'
                + '下次调用把那条消息的 id 填进 messageId，我就能按真的调唱。'
                + '绝对不要自己编歌词、也不要说「我唱了 / 排上了」。'
            });
          }

          const parsed = parseLyrics(lyrics);
          if (!parsed.ok) return err(parsed.reason);

          const withMelody = !(args.noMelody === true);
          const voice = args.voice || 'hutao';
          // 干声（清唱）还是带伴奏：模型没明说就用设置默认值（默认干声）
          const singDry = (args.noAcc === undefined || args.noAcc === null)
            ? svcConfig().singDry : args.noAcc !== true;
          // singDry = 是否干声；传给队列的语义是 noAcc（不要伴奏），两者同义
          const callArgs = { ...args, lyrics, melody, noAcc: singDry, ...(refAudio ? { refAudio } : {}) };

          // ── 首选：异步队列。0.1s 回执，成品由队列完成后主动推送到本会话 ──
          // 群里等 3 分钟等同于失败，所以这里绝不 await 渲染。
          if (songQueueReady()) {
            const sub = submitSing({
              chatKey: ctx.chatKey,
              parsed,
              args: callArgs,
              replyToMessageId: args.replyToMessageId ?? null,
            });
            if (sub.cached) {
              return ok({
                queued: false,
                cached: true,
                note: '这段之前唱过，成品已经直接发到本会话了，不用再等。不要再重复调用本工具。'
              });
            }
            const eta = Math.max(5, Math.round(sub.etaMs / 1000));
            // 前面还有别的歌在跑时，用户真正要等的时间 = 排队 + 自己这首
            const wait = Math.max(0, Number(sub.waitMs) || 0);
            const total = eta + wait;
            const ahead = wait > 5 ? `前面还有歌在唱，等 ${wait} 秒才轮到，` : '';
            return ok({
              queued: true,
              routed: 'sing',
              dry: singDry,
              melody: melody || null,
              jobId: sub.id,
              position: sub.position,
              etaSec: eta,
              waitSec: wait,
              etaTotalSec: total,
              dupOf: sub.dupOf || '',
              note: `已排上队（${ahead}预计 ${total} 秒${singDry ? '，清唱版只要人声' : '，带伴奏'}）。成品好了会由系统自动发到本会话，`
                + '你只需要用一句话告诉对方已经排上，不要说"马上就好"，也不要重复调用本工具。'
                + (sub.dupOf ? '注意：同一个会话已经有一首同名在排队了，别再排，直接告诉对方等一下就行。' : '')
                + (melodyAuto
                  ? `这首歌库里没有，正在现场扒谱（要先听一遍原曲找旋律）。可以这么说：`
                    + `「《${melody}》库里没有谱，我正趴桌上听原曲扒旋律——大约 ${total} 秒开口，先来把斗地主？」`
                  : `可以这么说：「排上了，大约 ${total} 秒开口，先去喝口水。」`)
                + (melodyHint ? `（会按原曲旋律唱${melodyHint}）` : '')
            });
          }

          if (typeof ctx.emit === 'function') ctx.emit('log', { text: `[唱歌] ${parsed.charCount} 字，${voice} 真唱…` });
          const r = await singLyrics(lyrics, {
            style: args.style,
            withMelody,
            melodyMode: args.melodyMode || 'wave',
            useDiffSinger: true,
            voice,
            bpm: args.bpm || 92,
            key: args.key || 'B3',
            withAcc: !singDry,
            vc: args.noVc === true ? false : undefined,
            melody,
            melodyTrans: Number(args.melodyTrans) || 0,
            log: (m) => ctx.emit && ctx.emit('log', { text: m })
          });

          const file = saveVoiceBuffer(r.buffer, r.ext || 'wav', 'lyrics');
          const d = await deliverSing(ctx.sender, ctx.chatKey, {
            file,
            seconds: r.vocalSec || 0,
            engine: r.engine,
            melodyName: r.melodyName || '',
            singer: r.singer || '胡桃',
            hq: args.hq === true,
            full: args.full === true,
            replyToMessageId: args.replyToMessageId ?? null,
          });
          const label = d.label;
          const mode = d.mode;
          ctx.session.sent.push({ type: mode, text: `[${mode === 'voice' ? '语音' : '音频文件'}：${label}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          if (typeof ctx.emit === 'function') ctx.emit('session-update', ctx.session.id);
          return ok({
            sent: true,
            messageId: d.messageId,
            source: r.source,
            seconds: r.vocalSec,
            ttsMs: r.ttsMs,
            svcMs: r.svcMs,
            mode,
            note: r.note + (mode === 'file'
              ? '（已发高音质音频文件，44.1kHz）'
              : '（发的是语音条；群友要完整文件时说一声，再用 full=true 发文件版）')
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sing_cover',
      description: '按原曲「真翻唱」一首歌：把群友指定的原曲（或发来的音频）分离出伴奏，用原唱的真实旋律 + RVC 换成胡桃的音色，再专业混音母带成 44.1kHz 真立体声成品。与 sing_lyrics（歌词→算法旋律）不同，这是「唱原曲」，音准、节奏、颤音都跟原唱走。'
        + '★ 群友只报歌名、没给音频文件时不必自己找文件：name 填歌名即可，系统会自动在本地曲库（songs/raw/ 等）里找；找到了就翻唱，找不到会告诉你现有曲目。'
        + '★ 曲库里没有的歌（群友报了新歌名）要翻唱，就让它把歌发过来：messageId 填那条音频消息，或给 url 直链。拿到音频后系统会存进曲库再翻唱，以后报歌名就能直接唱、不用再发。'
        + '★ 只有歌名又拿不到音频：不是模型没训练这首歌（RVC 训练的是音色不是歌），而是没有旋律来源 —— 这时【别硬用本工具，也别改 sing_lyrics 现编】，如实跟群友要音频（文件/语音/链接都行：发文件就填 messageId，给链接就填 url）。'
        + '★ 群友只说「唱首歌」「你来一首」却没点名唱哪首：name 留空即可（系统会唱设置里的默认曲目），别反问「想听什么」。'
        + '整首约 2~5 分钟（同一首歌重复点会命中缓存，秒级返回）。'
        + '★ 异步：调用后立即返回排队结果，成品稍后自动发到本会话，拿到排队结果就只回一句「排上了、大概几分钟」，不要重复调用，也不要干等。引擎不可用时会如实告知。',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '可选：原曲音频路径或直链（wav/flac/mp3/m4a）。群友发了音频才填；只知道歌名就留空、填 name' },
          messageId: { type: ['integer', 'string'], description: '可选：群友发来的音频所在消息 id（聊天记录里的 #数字）。曲库里没有这首歌时用它，系统会把音频存进曲库再翻唱' },
          url: { type: 'string', description: '可选：音频直链（http/https，mp3/wav/flac/m4a 等）。群友给链接时用' },
          name: { type: 'string', description: '歌名（会用于在本地曲库找原曲，也用于输出命名）。知道歌名就填' },
          start: { type: 'number', description: '起始秒，默认 0；主歌/副歌常不在开头，可指到要翻唱的那段' },
          dur: { type: 'number', description: '翻唱时长秒，默认 60（太长会很久，建议 30~90）' },
          dry: { type: 'boolean', description: '可选：true=只要干声（清唱人声，不混原曲伴奏），false=要带伴奏的混音成品。不传按设置里的默认（默认干声）。群友说「清唱/不要伴奏/只听人声」就传 true，说「带伴奏/要原曲那种」就传 false' },
          full: { type: 'boolean', description: '可选：true=发完整音频文件。群友说「要完整版/发文件/下载」时传。不传默认发语音条（超过约 2 分钟会自动改成文件）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id' }
        }
      },
      async execute(ctx, args) {
        try {
          if (!coverReady()) return err('原曲翻唱引擎未就绪（缺 python 或 route_a.py）');

          // src 解析三档：群友发来的音频 → 明确的路径 → 模型把歌名当路径传 → 用 name 找曲库。
          // 群聊里最常见的失败就是「模型知道歌名但给不出路径」，这里兜住。
          let src = String(args.src || '').trim();
          let name = String(args.name || '').trim();
          let ingested = '';   // 本次新入库的路径（回执里要告诉对方「以后报歌名就行」）

          // ── 0) 群友发来的音频 / 直链 → 落进正式曲库 ────────────────
          // 曲库里没有的歌只靠歌名翻唱不了（没有旋律来源），这一步把它变成可翻唱。
          const hasRef = (args.messageId !== undefined && args.messageId !== null
            && String(args.messageId).trim() !== '') || String(args.url || '').trim();
          // 「唱首歌」但没说唱哪首、也没发音频 → 唱默认曲目（与 sing_lyrics 同一个配置项）
          if (!src && !name && !hasRef) {
            name = defaultSingTitle();
            if (name) ctx.emit?.('log', { text: `[翻唱] 没点名 → 默认唱《${name}》` });
          }
          if (!src && hasRef) {
            const got = await fetchAudioFromRef(ctx, args);
            const songName = name || got.title || '';
            src = await saveIncomingSong(got.buffer, songName, got.ext);
            if (!name) name = path.basename(src).replace(/\.[^.]+$/, '');
            ingested = src;
            // 曲库扫描有 10s 缓存，入库后立刻刷新，本次后续查找才看得到
            try { listLocalSongs({ fresh: true }); } catch { /* 刷新失败不影响本次 */ }
          }
          if (src && !fs.existsSync(src) && !/^(https?:|file:)/i.test(src)) {
            const byName = findLocalSong(src) || findLocalSong(name) || await findSongInPlaylist(name || src);
            if (byName) { src = byName.path; name = name || byName.base; }
          }
          if (!src && name) {
            const byName = findLocalSong(name) || await findSongInPlaylist(name);
            if (byName) src = byName.path;
          }
          if (!src) {
            const avail = listLocalSongs().slice(0, 10).map((s) => s.base);
            return err('要翻唱的原曲没给。'
              + (avail.length ? `本地曲库现有：${avail.join('、')}。` : '')
              + '曲库里没有这首歌的话，让群友把歌发过来（再调用本工具时填 messageId）或给 url 直链 —— '
              + '拿到音频就能原样翻唱，并且会存进曲库，以后报歌名就行。'
              + '实在拿不到音频就如实跟群友要素材（文件/语音/链接），别硬翻唱、也别改 sing_lyrics 现编一段调去唱 —— 那听着就是乱唱。');
          }

          // ── 首选：异步队列。翻唱动辄 3~5 分钟，同步等必然超时 ──
          if (songQueueReady()) {
            const sub = submitCover({ chatKey: ctx.chatKey, args: { ...args, src, name: name || 'cover' } });
            if (sub.cached) {
              return ok({
                queued: false,
                cached: true,
                note: '这段之前已经翻唱过，成品直接发到本会话了，不用再等。不要再重复调用本工具。'
              });
            }
            const eta = Math.max(10, Math.round(sub.etaMs / 1000));
            const ahead = sub.position > 1 ? `前面还有 ${sub.position - 1} 首，` : '';
            return ok({
              queued: true,
              jobId: sub.id,
              position: sub.position,
              etaSec: eta,
              savedTo: ingested || undefined,
              note: `已排上队（${ahead}预计 ${Math.round(eta / 60 * 10) / 10} 分钟）。`
                + '成品好了会由系统自动发到本会话，你先用一句话告诉对方已排上，'
                + '不要说"马上就好"，也不要重复调用本工具。'
                + (ingested ? `（这首歌已存进曲库，以后报《${name}》就不用再发音频了）` : '')
            });
          }

          if (typeof ctx.emit === 'function') ctx.emit('log', { text: `[翻唱] ${name || '原曲'} 路线 A 启动…` });

          const coverDry = (args.dry === undefined || args.dry === null)
            ? svcConfig().coverDry : args.dry !== false;
          const r = await coverSong({
            src,
            name: name || 'cover',
            start: args.start || 0,
            dur: args.dur || 60,
            dry: coverDry,
            log: (m) => ctx.emit && ctx.emit('log', { text: m }),
          });

          const file = saveVoiceBuffer(r.buffer, 'wav', 'cover-' + String(name || 'cover').slice(0, 20).replace(/[\\/:*?"<>|]/g, '_'));

          // 翻唱成品是 44.1kHz 真立体声，直接发音频文件（语音条会压坏混音）
          const d = await deliverCover(ctx.sender, ctx.chatKey, {
            file, seconds: r.seconds || 0, name: name || '翻唱',
            full: args.full === true,
          });
          ctx.session.sent.push({ type: 'file', text: `[音频文件：${name || '翻唱'}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          if (typeof ctx.emit === 'function') ctx.emit('session-update', ctx.session.id);

          const qc = r.report?.qc;
          // 2026-10-24 剃刀：note 是给模型看的人话，不放内部指标（质检/相似度）——
          // 模型会把 note 原样转述给群友（实测泄漏「质检 9/9」「调性一致 0.92」）。
          // qc 数值保留在结构化字段里，模型要判断质量仍看得到。
          const tail = coverDry ? '清唱版（只有人声，没混伴奏）' : '';
          return ok({
            sent: true,
            messageId: d.messageId,
            seconds: r.seconds,
            costMs: r.costMs,
            dry: coverDry,
            savedTo: ingested || undefined,
            cached: r.report?.cache && String(r.report.cache).includes('hit') ? true : undefined,
            qc: qc ? { passed: qc.passed, total: qc.total, ok: qc.ok } : null,
            mode: d.mode,
            note: `已按原曲翻唱《${name || '这首歌'}》并${d.mode === 'voice' ? '发语音条' : '发音频文件'}（胡桃音色，${Math.round(r.seconds || 0)} 秒，${tail}）。`
              + (d.mode === 'voice' ? '想要完整版文件就说一声。' : '')
              + (ingested ? `这首歌已存进曲库，以后报歌名就能直接唱。` : ''),
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群里"戳"某个人）。什么时候用：想催一句、想引起注意、想表达"我在等你回"、想撒娇/闹一下，或者别人刚拍了你、你回敬一下——这比多发一条文字更像真人。不用什么时候：一句话就能说清的事、正经问题、对方正在难过、刚拍过（系统会拦）、连拍同一个人。targetUserId 或 targetName 二选一：有 QQ 号就填号，只知道名字就填名字（重名会失败，不会拍错人）。',
      parameters: {
        type: 'object',
        properties: {
          targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字）。知道号就填它' },
          targetName: { type: 'string', description: '对方昵称/群名片（不知道 QQ 号时填这个，系统自己找号）' },
          reason: { type: 'string', description: '可选：一句话说明你为什么想拍（只记录，不发出去）' }
        }
      },
      async execute(ctx, args) {
        try {
          // 总闸：设置里关掉拍一拍时，别让模型还能从这里拍出去
          if (getConfig().gesture?.enabled === false) {
            return err('拍一拍功能已关闭（设置 → 手势 → 拍一拍）。想说话就直接说，别拍。');
          }

          // ── 1. 谁是目标 ──────────────────────────────────────────────
          const members = ctx.kind === 'group'
            ? (ctx.store.activeMembers(ctx.chatKey, 40) || []).map((m) => ({ id: m.userId, name: m.name }))
            : [];
          let target = null;
          const rawId = args.targetUserId === undefined || args.targetUserId === null ? '' : String(args.targetUserId).trim();
          const rawName = String(args.targetName ?? '').trim();

          if (rawId) {
            const n = Number(rawId);
            if (!Number.isInteger(n) || n <= 0) {
              return err(`targetUserId 必须是正整数 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            target = { id: String(n), name: members.find((m) => m.id === String(n))?.name || '' };
          } else if (rawName) {
            target = matchMember(rawName, members);
            if (!target) {
              return err(`没找到「${rawName}」对应的 QQ 号，拍不了。${memberHint(ctx)}`);
            }
          } else if (ctx.kind === 'group') {
            return err(`群聊里要说明拍谁。${memberHint(ctx)}`);
          } else {
            // 私聊：拍对方（协议端自己知道对方是谁）
            target = { id: '', name: '' };
          }

          // ── 2. 该不该拍（频率 / 心情 / 时间）────────────────────────
          const hist = pokeHistory(ctx, target.id);
          const gCfg = getConfig().gesture || {};

          // 连戳炸毛：这个人刚连着戳了你好几下，这时候再拍回去就像个弹簧。
          // 与入站那条判据同源（app.js 用内存 streak，这里数存档，语义一致）。
          const angryAt = Math.max(2, Number(gCfg.pokeAngryAt ?? 4));
          if (target.id && hist.inboundPokes >= angryAt) {
            return err(
              `这次不拍：他刚连着戳了你 ${hist.inboundPokes} 下，你正毛着呢 —— 回拍反而像没脾气。`
              + '想反应就直接说一句（可以烦、可以损他、可以晾着不理），别动手。'
            );
          }

          const inbound = !!target.id && hist.inboundAt > 0 && Date.now() - hist.inboundAt <= 60000;
          const verdict = pokeBudget({
            now: Date.now(),
            moodScore: Number(ctx.moodScore ?? 50),
            lastPokeAt: hist.lastPokeAt,
            lastPokeToTargetAt: hist.lastPokeToTargetAt,
            pokesThisRun: Number(ctx.pokesThisRun || 0),
            inbound,
            targetId: target.id,
            cfg: gCfg
          });
          if (!verdict.allow) {
            return err(`这次不拍：${verdict.reason}。想说话就直接说，别硬拍。`);
          }

          // ── 3. 拍 ────────────────────────────────────────────────────
          if (verdict.delayMs > 0) await new Promise((r) => setTimeout(r, verdict.delayMs));
          await ctx.sender.poke(ctx.chatKey, target.id ? Number(target.id) : null, { targetName: target.name });
          ctx.pokesThisRun = Number(ctx.pokesThisRun || 0) + 1;
          if (typeof ctx.emit === 'function' && args.reason) {
            ctx.emit('log', { text: `[拍一拍] ${target.name || target.id || '对方'}（${String(args.reason).slice(0, 40)}）` });
          }
          return ok({ poked: true, target: target.name || target.id || '对方' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'queue_status',
      description: '查当前会话的点歌队列：正在唱哪首、进度、还要多久，以及后面排了几首。'
        + '群友问「还要多久」「排队排到哪了」「唱到哪首了」时用；自己不用主动查。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        if (!songQueueReady()) return ok({ ready: false, note: '点歌队列还没启动，现在点不了歌。' });
        const jobs = listSongJobs({ group: ctx.chatKey, limit: 20 })
          .filter((j) => j.status === 'queued' || j.status === 'running');
        if (!jobs.length) {
          return ok({ count: 0, note: '队列是空的，现在点歌立刻就能开唱。' });
        }
        const fmt = (j) => ({
          label: j.label || '一首歌',
          progress: j.progress,
          stage: j.stage || undefined,
          etaSec: Math.max(1, Math.round(j.etaMs / 1000)),
        });
        const running = jobs.filter((j) => j.status === 'running').map(fmt);
        const queued = jobs.filter((j) => j.status === 'queued').map(fmt);
        const totalEta = Math.round(
          jobs.reduce((s, j) => s + (j.etaMs || 0), 0) / 1000
        );
        return ok({
          count: jobs.length,
          running,
          queued,
          totalEtaSec: totalEta,
          note: running.length
            ? `正在唱 ${running[0].label}（${running[0].progress}%），后面还有 ${queued.length} 首。`
            : `${queued.length} 首在排队。`
              + '回话时给个大概时间就行（比如「还有一首，两分钟左右」），别报秒数。'
        });
      }
    },
    {
      name: 'cancel_song',
      description: '取消当前会话正在排队/正在唱的点歌作业。'
        + '★ 群友说「别唱了」「算了」「不用了」「不唱了」时必须调用本工具 —— 只在话里答应「那我不唱了」'
        + '是骗人：队列里的歌照样会跑完、两分钟后照样发出来（群里已经翻过一次车）。'
        + '★ 也可以只取消某一首：传 jobId（queue_status 里能查到）。不传就取消本会话全部在途。',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: '可选：只取消这一首（queue_status 返回的 jobId）。不传=取消本会话所有在途' }
        }
      },
      async execute(ctx, args) {
        try {
          if (!songQueueReady()) return ok({ canceled: 0, note: '队列没启动，本来也没有在唱的。' });
          const id = String(args.jobId || '').trim();
          if (id) {
            const r = cancelSongJob(id);
            if (!r?.ok) {
              return ok({ canceled: 0, reason: r?.reason || 'not_found', note: '这首已经唱完或已经取消了，不用再取消。' });
            }
            return ok({ canceled: 1, note: '已经喊停了，这首不会再发出来。回一句话就行（比如「好，不唱了」），别解释技术细节。' });
          }
          const r = cancelSongJobsByChat(ctx.chatKey);
          if (!r.canceled) {
            return ok({ canceled: 0, note: '现在没有在排队/在唱的歌。' });
          }
          return ok({
            canceled: r.canceled,
            labels: r.labels,
            note: `已经喊停了（${r.labels.join('、')}），不会再发出来。`
              + '回一句话就行（比如「好，不唱了」），别解释队列/任务这些技术细节。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。只想找某句话/某个链接时，用 search_messages 更快。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        // ── 单轮累计上限（省钱层移植：命中率修复）──
        // 防止模型并行调 10 次本工具（每次 100 条）去"总结上 1000 条"，把 prompt 顶爆。
        // 只限单轮（一次唤醒）累计条数；超限明确告诉模型换路子。
        const cap = Math.max(50, Number(getConfig()?.tools?.recentMessagesCapPerRun) || 300);
        const pulled = Math.max(0, Number(ctx.session?.recentPulled) || 0);
        const remain = cap - pulled;
        if (remain <= 0) {
          return ok({
            count: 0,
            messages: [],
            pullCapReached: true,
            pulledThisRun: pulled,
            note: `本轮已经翻过 ${pulled} 条历史（单轮上限 ${cap} 条），不再继续拉。要总结大量历史请分页逐段处理，别再一口气拉。`
          });
        }
        const effLimit = Math.min(limit, remain);
        const messages = ctx.store.recent(ctx.chatKey, { limit: effLimit, offset: offset + (ctx.session.pastStateCount || 0) });
        const pulledNow = pulled + messages.length;
        if (ctx.session) ctx.session.recentPulled = pulledNow;
        return ok({
          count: messages.length,
          pulledThisRun: pulledNow,
          pullCap: cap,
          note: pulledNow >= cap ? `已达单轮累计上限 ${cap} 条；继续翻更早的请等下一轮。` : undefined,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : m.senderName,
            text: m.text
          }))
        });
      }
    },
    {
      name: 'search_messages',
      description: '按关键词搜当前会话的历史（比一页页翻 get_recent_messages 省 token）。多个关键词用空格分隔，全部命中才算；返回新的在前。想起「上次那个链接/那个人说的那句话」时用它——内存里只有最近 2000 条，更早的会自动去归档里找。命中满页会给 nextBefore，把它填回 before 就是再往前一页。搜不到就如实说没印象，绝对不要编。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词，多个用空格分隔（全部命中）' },
          sender: { type: 'string', description: '可选：只搜某个人说的（名字或 QQ 号）' },
          limit: { type: 'integer', description: '最多返回几条，默认 15，最大 30' },
          before: { type: 'string', description: '可选：只搜比这条更早的（消息 id，或上一页的 nextBefore）' },
          after: { type: 'string', description: '可选：只搜比这条更新的' },
          scan: { type: 'integer', description: '可选：最多往回翻多少条（默认搜整份存档）' }
        },
        required: ['keyword']
      },
      async execute(ctx, args) {
        const keyword = String(args.keyword || '').trim();
        if (!keyword) return err('keyword 不能为空');
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 15));
        const scan = Number(args.scan) || 0;
        // 锚点：模型给的是 QQ 消息 id（#后面的那串），这里翻译成本地序号再往下传。
        // 翻译失败**不能当成"没设边界"**——那会把第一页原样再给一遍，模型会以为"就这么多"。
        const anchorOf = (v) => {
          const raw = String(v ?? '').trim();
          if (!raw) return { id: null, missing: '' };
          const hit = typeof ctx.store.findAnywhere === 'function' ? ctx.store.findAnywhere(ctx.chatKey, raw) : null;
          return hit ? { id: hit.id, missing: '' } : { id: null, missing: raw };
        };
        const b = anchorOf(args.before);
        const a = anchorOf(args.after);
        const hits = ctx.store.search(ctx.chatKey, {
          keyword,
          sender: String(args.sender || ''),
          limit,
          maxScan: scan,
          beforeId: b.id,
          afterId: a.id
        });
        // 内存里不够就回落归档（2026-10-26）：内存只留最近 maxMessagesPerChat 条，
        // "上周那个链接"往往已经滚出去了。不回落 = 她只能说没印象，而那是可修的"失忆"。
        // 显式传了 scan 就尊重他（那是"我只想搜最近这一段"的意思）。
        let old = [];
        if (hits.length < limit && !scan && typeof ctx.store.searchArchive === 'function') {
          try {
            old = ctx.store.searchArchive(ctx.chatKey, {
              keyword,
              sender: String(args.sender || ''),
              limit: limit - hits.length,
              beforeId: b.id,
              afterId: a.id
            });
          } catch { /* 归档读失败就只给内存结果，不能让搜索整体报错 */ }
        }
        const all = [...hits, ...old];
        // 满一页 = 后面很可能还有；把最旧那条的 id 交回去当下一页锚点。
        // ⚠️ 必须带前缀（mid:/id:）：两套 id 都是数字、会撞号，裸数字回传过会让第 2 页跟第 1 页重复。
        const last = all.at(-1);
        const nextBefore = all.length >= limit && last
          ? (last.mid !== null && last.mid !== undefined ? `mid:${last.mid}` : `id:${last.id}`)
          : '';
        const notes = [];
        if (b.missing) notes.push(`before=${b.missing} 在记录里找不到，这次没按它截断（可能记错了 id）`);
        if (a.missing) notes.push(`after=${a.missing} 在记录里找不到，这次没按它截断（可能记错了 id）`);
        if (!all.length) notes.push('没搜到。聊天记录里没有这句话，别当成"我记得"。');
        return ok({
          count: all.length,
          fromArchive: old.length || undefined,
          nextBefore: nextBefore || undefined,
          note: notes.length ? notes.join('；') : undefined,
          messages: all.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : m.senderName,
            ...(m.archived ? { archived: `${m.archived}（更早的存档）` } : {}),
            text: String(m.text || '').slice(0, 200)
          }))
        });
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: entry.text,
          atSelf: entry.atSelf === true,
          atOthers: entry.atOthers || [],
          reply: entry.reply
        });
      }
    },
    {
      name: 'qwen_vision',
      description: '使用独立的视觉模型识别图片并返回文字结果（截图/图表/OCR 走精度优先通道）。可用 messageId 读取当前会话图片，或直接传 imageUrl。适合主模型不支持图片输入、需要准确念出图上文字时。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '当前会话消息 id（聊天记录里的 #数字），可选' },
          imageUrl: { type: 'string', description: '公网图片 URL，可选；messageId 与 imageUrl 至少传一个' },
          prompt: { type: 'string', description: '希望 Qwen-VL 重点识别的内容，可选' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const dataUrls = [];
          let gifFrames = 0;
          if (args.messageId !== undefined && args.messageId !== null && String(args.messageId).trim() !== '') {
            const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
            if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
            const media = (entry.media || []).filter((m) => m.kind === 'image' && (m.url || m.file || m.fileId));
            for (const item of media) {
              const picked = await mediaImageDataUrls(ctx, item);
              dataUrls.push(...picked.urls);
              gifFrames += picked.gifFrames;
            }
          }
          if (args.imageUrl) {
            await validateImageUrl(String(args.imageUrl));
            const picked = await downloadImageDataUrls(String(args.imageUrl));
            dataUrls.push(...picked.urls);
            gifFrames += picked.gifFrames;
          }
          if (!dataUrls.length) return err('没有可识别的图片：请传 messageId 或 imageUrl');
          return ok(await describeImage(dataUrls, `${String(args.prompt || '').trim()}${gifFramesNote(gifFrames)}`.trim(), 'message'));
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情/视频（视觉模型可以直接看懂）。消息文本出现 [图片] 或 [视频] 时就用它：视频会取一帧画面（看得到拍的是什么，听不到声音、看不到过程）。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' },
          focus: { type: 'string', description: '可选：你特别想弄清的点（如"表格里的数字""右下角按钮写什么""这段话的主语是谁"）。不填就整图读懂后给主旨+要点+关键原文；填了会只针对这一点细看' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const images = (entry.media || []).filter((m) => m.kind === 'image' && (m.url || m.file || m.fileId));
          // 视频：既包括 [视频] 段，也包括扩展名像视频的 [文件] 消息（有人直接把 mp4 当文件发）
          const videos = (entry.media || []).filter((m) => isVideoMedia(m) && (m.url || m.file || m.fileId || m.path));
          if (!images.length && !videos.length) return ok(`消息 ${args.messageId} 没有可查看的图片/视频`);
          const dataUrls = [];
          const failed = [];
          let gifFrames = 0;
          for (const item of images) {
            try {
              const picked = await mediaImageDataUrls(ctx, item);
              dataUrls.push(...picked.urls);
              gifFrames += picked.gifFrames;
            } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          // 视频本身看不了，但取一帧画面给视觉模型，至少知道「这段视频拍的是什么」。
          // 取不到就老实说取不到（并把原因带回去，让她能说"重发一遍"），绝不编造画面。
          let videoNote = '';
          for (const item of videos.slice(0, 2)) {
            try { dataUrls.push(await videoFirstFrameDataUrl(ctx, item)); } catch (e) { failed.push(`视频画面取不到：${String(e?.message ?? e)}`); }
          }
          if (videos.length) videoNote = `（含 ${videos.length} 段视频，只能看到其中一帧画面；视频里的声音和过程看不到）`;
          if (!dataUrls.length) return err(`没拿到画面：${failed.join('；')}`);
          const note = (failed.length ? `（另有 ${failed.length} 个获取失败）` : '') + videoNote + gifFramesNote(gifFrames);
          if (usingQwenVision()) {
            const focus = String(args.focus || '').trim();
            const ask = focus
              ? `消息 ${args.messageId} 的图片${note}。重点回答这个问题：${focus}`
              : `消息 ${args.messageId} 的图片${note}。先读懂这张图在说什么；看不清就明确说。`;
            return ok(await describeImage(dataUrls, ask, 'message'));
          }
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${note}：`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'voice_to_text',
      description: '把一条语音消息转成文字（语音识别）。消息里出现 [语音] 时用它看内容；messageId 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const asr = qwenAsrConfig();
          if (!asr.enabled) return err('语音识别没开：请到 设置 → 模型 API 打开"语音"');
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const rec = (entry.media || []).find((m) => m.kind === 'record');
          if (!rec) return err(`消息 ${args.messageId} 里没有语音`);
          const audio = await loadVoiceBytes(ctx, rec);
          const text = await transcribeSpeech({ buffer: audio.buffer, format: audio.format });
          const secs = Number(rec.seconds) > 0 ? `，约 ${Math.round(Number(rec.seconds))} 秒` : '';
          return ok(`【语音转文字】${text}\n（识别模型 ${asr.model}${secs}；可能有错字，理解大意即可）`);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条轻量记忆（下次运行会自动看到）：activeTopic=进行中的话题；pendingThought=想说但还没说的话；memberImpression=对某位群友的印象。偶尔用，别当笔记本。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'] },
          content: { type: 'string', description: '记忆内容' },
          target: { type: 'string', description: 'memberImpression 时的群友名字' }
        },
        required: ['category', 'content']
      },
      async execute(ctx, args) {
        const extra = {};
        if (args.target) extra.target = String(args.target).slice(0, 50);
        const entry = ctx.memory.append(ctx.chatKey, String(args.category), String(args.content ?? ''), extra);
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: '查看当前会话的轻量记忆。',
      parameters: {
        type: 'object',
        properties: { category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'], description: '可选：只看某一类' } }
      },
      async execute(ctx, args) {
        return ok(ctx.memory.query(ctx.chatKey, args.category ? String(args.category) : ''));
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再重要的记忆。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'] },
          content: { type: 'string', description: '要删除的话题/想法原文（memberImpression 用 target）' },
          target: { type: 'string', description: 'memberImpression 时要删除的群友名字' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, String(args.category), { content: String(args.content ?? ''), target: String(args.target ?? '') });
        return ok({ removed });
      }
    },
    {
      name: 'memory_forget',
      description: [
        '把某条长期记忆（对某个人的事实 / 对某个群的印象）打上墓碑：她从此不再想起，也不再被重新学到。',
        '**只有对方本人明确说"忘掉/删掉/别记着"时才能调用** —— 主动替人遗忘是越权。',
        '传 match=要忘掉的内容关键词（按原文包含匹配）。已经淡出休眠的条目同样可以被显式忘掉。',
        '记录本体保留（不物理删除），但永远退出召回。'
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: '要忘掉的内容关键词，如"生日""对花生过敏"' },
          target: { type: 'string', description: '可选：忘"谁"的记忆；不传=当前说话人' }
        },
        required: ['match']
      },
      async execute(ctx, args) {
        const match = String(args.match ?? '').trim();
        if (!match) return err('要忘掉什么？给一个关键词。');
        // 主语纪律：只能忘"当前说话人自己的"，或者群记忆。拿不到 speakerId 就拒绝 ——
        // 拿 QQ 去猜是防串人纪律不允许的（"替 A 忘掉关于 B 的事"这类请求一律不做）。
        const speakerId = String(ctx.speakerId || '');
        if (!speakerId) {
          return err('拿不到当前说话人的 QQ，无法定位要忘的记忆（宁可不办，不办错人）。');
        }
        const who = String(args.target || '').trim();
        if (who && who !== ctx.senderName && who !== speakerId) {
          return err('只能忘掉当前说话人自己的记忆；要忘别人的，请让本人来说。');
        }
        const r = forgetFact(speakerId, match, { reason: `用户在 ${ctx.chatKey || '会话'} 中明确要求遗忘` });
        let g = { ok: false, count: 0 };
        if (String(ctx.chatKey || '').startsWith('group:')) {
          g = forgetGroupFact(ctx.chatKey, match, { reason: `用户在 ${ctx.chatKey} 中明确要求遗忘` });
        }
        const total = r.count + g.count;
        return ok({
          forgotten: total,
          personal: r.count,
          group: g.count,
          note: total
            ? '已遗忘（打了墓碑，不会再想起，也不会被重新学到）。回复时自然接受"忘掉了"这个状态即可，不用宣布技术细节。'
            : `没有找到匹配「${match}」的记忆。她可能本来就没记住，或者说法不一样——可以问清楚再试一次。`
        });
      }
    },
    {
      name: 'diary',
      description: '你自己的日记（每天一篇，程序自动写）。action=read：读最近几天的日记，days 默认 3，也可传 date（YYYY-MM-DD）；action=write：让程序把某天（默认今天）的聊天整理成一篇日记，同一天已写过就不会重写。别人问「你昨天日记写了啥」「你还记得昨天吗」时用 read 拿真内容，绝对不要凭空编日记。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'], description: 'read=读日记 / write=写一篇' },
          days: { type: 'integer', description: 'read 时读最近几天（默认 3）' },
          date: { type: 'string', description: 'read/write 的日期 YYYY-MM-DD（write 默认今天）' }
        },
        required: ['action']
      },
      async execute(ctx, args) {
        try {
          const action = String(args.action || 'read').toLowerCase();
          if (action === 'write') {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || '')) ? String(args.date) : todayKey();
            const cfg = getConfig();
            const persona = resolvePersona(ctx.chatKey).persona;
            const r = await writeDiaryFor(ctx.chatKey, {
              store: ctx.store, persona, kind: ctx.kind, date, cfg: cfg.diary || {},
              log: () => {}, chatCompletion
            });
            if (r.ok) return ok({ written: true, date: r.date, title: r.title, note: '日记写好了（已经存到本地）。要不要顺手跟对方提一句，你自己决定。' });
            const why = {
              exists: '这天的日记已经写过了，不重写。',
              'too-quiet': '这天的消息太少，没什么可写的。',
              'no-engine': '现在没有可用的模型，写不了。',
              'bad-draft': '这次没写出像样的东西，算了吧。'
            }[r.reason] || `没写成（${r.reason}）`;
            return err(why);
          }
          const list = args.date
            ? [readDiaryEntry(ctx.chatKey, String(args.date))].filter(Boolean)
            : listDiaryEntries(ctx.chatKey, { limit: Math.max(1, Math.min(10, Number(args.days) || 3)) });
          if (!list.length) return ok({ entries: [], note: '这几天还没有日记。' });
          return ok({
            entries: list.map((e) => ({ date: e.date, title: e.title, body: String(e.body).slice(0, 1200) }))
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'search_meme',
      description:
        '查梗。三级顺序：①这个群自己确认过的梗 → ②梗百科（6668 条公开词条，离线毫秒级）→ ③本地没有才联网。'
        + '遇到没有十足把握的网络新词、缩写、谐音、黑话，先调它再决定怎么回 —— 别硬猜、别把两个不相干的梗拼一起。'
        + '查到之后**先接梗、别科普**：照【怎么用 / 怎么接】用一句，像本来就会；'
        + '只有对方明确问「这是什么梗/啥意思」才解释出处，一两句就够。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '梗词、别名或相关关键词' },
          online: { type: 'boolean', description: '词库没有收录时是否联网查（默认 true；已知不需要就别传）' }
        },
        required: ['keyword']
      },
      async execute(ctx, args) {
        const keyword = String(args.keyword ?? '');

        // ① 群梗（人工确认过的）永远排第一：它最贴近这个群，而且不会被公开词库覆盖。
        const group = searchMemes(keyword);
        if (group.found) return ok({ source: '群梗', query: group.query, results: group.results });

        // ②③ 梗百科：本地 → 联网。是否联网用「预查闸门」判（详见 meme-wiki.js::worthSearch）：
        // 模型偶尔会拿「我是谁」这种整句来查，联网纯属浪费。
        const raw = String(ctx?.session?.triggerText ?? '') || keyword;
        const wiki = await lookupMemeWiki(keyword, { online: args.online !== false, raw });
        if (wiki.found) {
          return ok({
            source: wiki.tier === 'wiki' ? '梗百科（本地词库）' : '梗百科（联网）',
            query: keyword,
            text: wiki.text,
            hint: '照着【怎么用 / 怎么接】用一句就行（像本来就会）；对方没明确问「这是什么梗」就别解释出处，也别念词条、别说"我查了一下"。'
          });
        }

        return ok({
          query: keyword,
          results: [],
          source: 'none',
          note: '群梗库和梗百科（6668 条）都没有收录。可以继续 web_search；'
            + '如果这词确实是群里有人在用、你也说得清它什么意思，可以用 propose_meme 记成候选（等人确认，'
            + '这一轮仍然不许拿它玩梗）。查不到又说不清就如实说不懂，不要编造。'
        });
      }
    },
    {
      name: 'propose_meme',
      // 候选 ≠ 已知。这个工具写的是候选池，不写正式梗库 —— 越权转正在代码层就不会发生。
      description:
        '把一个新出现的网络梗记成「候选」。只有群里确实有人用、且你能说清意思和用法时才提；'
        + '提了也**不算你会了**，要等人工确认。日常聊天不需要调它，遇到真没见过的梗才用。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '梗词本身（尽量短，就是群里说的那个词）' },
          meaning: { type: 'string', description: '它是什么意思（一两句，别写成词典条目）' },
          usage: { type: 'string', description: '什么场合能接、什么场合不能，可选' },
          aliases: { type: 'array', items: { type: 'string' }, description: '同义写法，可选' },
          tone: { type: 'string', description: '语气（调侃/夸/阴阳…），可选' }
        },
        required: ['key', 'meaning']
      },
      async execute(ctx, args) {
        const r = proposeMeme(
          {
            key: args.key,
            meaning: args.meaning,
            usage: args.usage,
            aliases: Array.isArray(args.aliases) ? args.aliases : [],
            tone: args.tone,
            source: ctx.senderName || ctx.senderId || '',
            chatKey: ctx.chatKey || ''
          },
          {}
        );
        return ok({
          recorded: r.ok,
          status: r.status,
          note: r.reason,
          // 这一条是给模型的硬约束，别删：候选内容是"有人说它是个梗"，不是"它是梗"。
          reminder: r.ok
            ? '这条现在只是候选：**不许**在回复里表现得你已经懂了它，也别拿它玩梗。等人工确认后会自然出现在你的梗库里。'
            : ''
        });
      }
    },
    {
      name: 'escalate_reasoning',
      description: '当普通聊天模型发现当前问题需要更深的代码、数学、长文、文件或多步推理时，调用一次请求切换到复杂任务模型；简单闲聊不要调用。',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '需要更深推理的简短原因' } },
        required: ['reason']
      },
      async execute(ctx, args) {
        if (!ctx.routingEnabled || !ctx.allowModelEscalation) {
          return ok({ escalated: false, note: '当前未启用复杂模型升级，继续用现有模型认真回答。' });
        }
        if (ctx.modelEscalated) {
          return ok({ escalated: false, note: '本次运行已经升级过，不要重复调用。' });
        }
        if (typeof ctx.escalateModel !== 'function') {
          return ok({ escalated: false, note: '当前运行不支持模型升级。' });
        }
        const changed = ctx.escalateModel(String(args.reason ?? '').slice(0, 200));
        return ok({
          escalated: changed,
          note: changed ? '下一轮将使用复杂任务模型。' : '没有可用的复杂任务模型。'
        });
      }
    },
    {
      name: 'web_search',
      description: '联网搜索，返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const q = String(args.query ?? '');
          const provider = String(getConfig().webSearch?.provider || 'auto').toLowerCase();
          // bing：直接走 Bing 网页抓取
          if (provider === 'bing') {
            const r = await webSearch(q);
            if (!r.results.length) return ok({ query: r.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
            return ok({ ...r, engine: 'bing' });
          }
          // anysearch：只用 AnySearch（失败则如实报错，不回退）
          if (provider === 'anysearch') {
            const any = await anysearchSearch(q, { maxResults: 8 });
            if (any && any.results.length) return ok(any);
            return err('AnySearch 没有返回结果（可能 key 未配置或额度用尽）。可在设置 → 模型 API → 联网搜索里切换搜索引擎。');
          }
          // auto（默认）：有 key 优先 AnySearch，失败自动回退 Bing
          try {
            const any = await anysearchSearch(q, { maxResults: 8 });
            if (any && any.results.length) return ok(any);
          } catch (e) {
            // AnySearch 失败（429/超时等）→ 回退 Bing
          }
          const result = await webSearch(q);
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符，已自动去广告/脚本、已处理中文站编码）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。URL 可以直接粘贴（缺 http:// 也行，带标点也行）。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const result = await webFetch(String(args.url ?? ''));
          const body = String(result.body || '');
          const empty = looksEmptyBody(body);
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            title: result.title || undefined,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000),
            note: empty
              ? '正文很短（可能是需要登录/靠 JS 渲染的页面，或只有图片）。如实说"这个页面打不开内容"，不要凭空编。'
              : undefined
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'watch_video',
      description: '看懂一个视频链接大概讲了什么（B站 / YouTube / 抖音 / 西瓜 / 微博等）。群友甩链接、或有人问「这视频讲了啥」「这个值得看吗」时用。会去抓标题、简介、章节、字幕、弹幕、热评再归纳；拿到什么材料、缺什么材料一并告诉你——缺的部分不要自己脑补。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '视频链接；也可以直接给 B站的 BV 号' },
          focus: { type: 'string', description: '可选：想重点知道什么（例：值不值得看 / 有没有讲 XX）' },
          keyframes: { type: 'boolean', description: '可选：true=连画面一起看（会下载视频抽几帧，慢，只在文字材料不够时用）' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const cfg = videoConfig();
          if (!cfg.enabled) return err('看视频功能关着呢（设置 → video.enabled）');
          const rawUrl = String(args.url ?? '').trim();
          const hit = findVideoUrl(rawUrl);
          // 模型有时会直接把整句话塞进来，先从里面找链接；实在没有再原样试一次。
          //
          // ⚠️ 2026-10-29 第 6 轮修：以前这里 `hit?.url || rawUrl`，于是
          // `watch_video({url:'2137847126'})` 会把一个**裸消息 id 当链接**丢给 yt-dlp，
          // 拿回 `ERROR: [generic] '2137847126' is not a valid URL` ——
          // 实测 3 次全是这个形态（`2137847126` / `53431312` / `#1510279327`）。
          // 那是模型把"消息 id"和"链接"搞混了，而错误文案完全指不到正确做法。
          // 现在先认出"这看起来是个消息 id"，直接告诉它该用哪个工具。
          const bareId = /^#?\d{4,20}$/.test(rawUrl);
          if (bareId && !hit) {
            return err(`「${rawUrl}」看起来是消息 id，不是视频链接。`
              + '要拿那条消息里的视频，用 get_message_images（图片/视频都走它）；'
              + '真正要看视频内容，就给我 B站视频链接或 BV 号。');
          }
          const target = hit?.url || rawUrl;
          if (!target) return err('没给我链接（B站链接或 BV 号都行）');
          const res = await watchVideo(target, {
            log: (m) => { try { ctx?.log?.(m); } catch { /* 日志不影响结果 */ } },
            personaName: '',
            focus: String(args.focus ?? '').slice(0, 200),
            keyframes: args.keyframes === true,
            timeoutMs: 90000
          });
          if (!res.ok) return err(res.error || '这个视频没看懂');
          return ok({
            title: res.title,
            site: res.site,
            duration: res.duration ? `${Math.round(res.duration)} 秒` : undefined,
            materials: res.materials,
            missing: res.missing,
            fromCache: res.fromCache || undefined,
            summary: res.text,
            note: res.missing?.length
              ? '上面是抓到的材料能支撑的说法；没拿到的部分别脑补，别人追问就老实说看不到。'
              : undefined
          });
        } catch (error) {
          return err(`看视频失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理。**只在你决定不说话时用**（summary 写一句给自己的理由）；已经发过消息就直接结束，不要再调它。不调用也完全可以——文本输出结束本身就代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    },
    {
      name: 'dsh_task',
      masterOnly: true,
      description: '【主人专属】把耗时/复杂 agent 任务（做网页/PPT/文档/画图/批量处理/写代码等）转发给本机 DSH 执行。调用后立即返回任务已提交，然后向 master 说明已开工；DSH 完成后会自动向 master 汇报。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要 DSH 完成的任务描述（尽量具体：做什么、什么格式、放哪）' },
          taskName: { type: 'string', description: '可选：任务名（用于工作目录命名，简短英文/数字）' }
        },
        required: ['task']
      },
      async execute(ctx, args) {
        try {
          const { submitDshTask } = await import('./dsh-task.js');
          const result = await submitDshTask(String(args.task ?? ''), {
            taskName: String(args.taskName || '')
          });
          // 注册待汇报任务（orchestrator watcher 轮询此表）
          const { registerDshTask } = await import('./dsh-task.js');
          // taskText/taskName 记下来：任务完成后唤醒汇报时要用它们说明"当初交待了什么"
          registerDshTask({
            sessionId: result.sessionId,
            workDir: result.workDir,
            chatKey: ctx.chatKey,
            taskText: String(args.task ?? '').slice(0, 400),
            taskName: String(args.taskName || ''),
            submittedAt: Date.now()
          });
          ctx.session.dshTask = { sessionId: result.sessionId, workDir: result.workDir, chatKey: ctx.chatKey, submittedAt: Date.now() };
          return ok({
            submitted: true,
            sessionId: result.sessionId,
            workDir: result.workDir,
            note: '任务已提交 DSH 后台执行。请立即回复 master「收到，已开工，DSH 正在做，完成后本鲸汇报」，然后正常结束本次处理。'
          });
        } catch (error) {
          return err(`任务提交失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'load_tools',
      description: '装载暂时没挂出来的工具包。群聊里为了省上下文，唱歌/点歌、表情库管理、网页正文、看视频、查梗这些工具默认不挂着 —— 需要时先调本工具装载，**下一轮就能直接调那些工具**。pack：song=唱歌点歌翻唱发语音；stickerBox=翻/记/收藏表情；webRead=打开链接正文、看视频；meme=查梗记梗；all=全装。别为了"试试"乱装，真要用的时候才装。',
      parameters: {
        type: 'object',
        properties: {
          pack: {
            description: '要装载的包：song / stickerBox / webRead / meme / all（数组=一次装多个）',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
          }
        },
        required: ['pack']
      },
      async execute(ctx, args) {
        const raw = args?.pack;
        const wanted = (Array.isArray(raw) ? raw : [raw])
          .map((x) => String(x ?? '').trim())
          .filter(Boolean);
        if (!wanted.length) return err('pack 为空：填 song / stickerBox / webRead / meme / all');
        if (typeof ctx?.enablePack !== 'function') {
          return err('当前会话不支持按需装载（私聊与主人会话默认工具全挂，直接调用即可）');
        }
        const res = ctx.enablePack(wanted);
        if (!res || !res.added?.length) {
          return ok({
            loaded: [],
            note: `这些包本来就在，或者被其他开关关着（${(res?.reason || '无需装载')}）。要用哪个直接调就行。`
          });
        }
        return ok({
          loaded: res.added,
          note: `已装载 ${res.packs.join('、')}：${res.added.join('、')}。下一轮开始就能调用了，现在继续做你刚才想做的事。`
        });
      }
    }
  ];
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) {
    // ── 拼错复原（2026-10-29 第 6 轮）────────────────────────────────
    // 实测 1000 份会话里出现过 `未知工具 get_ message_images`（名字里插了一个空格）。
    // 模型意图完全正确、参数也对，但只拿到"未知"就放弃了那一轮 —— 用户看到的是"它没理我"。
    // 现在先从**当前实际挂着的工具**里猜一个最像的，猜得到就点名告诉它改哪一个。
    // 猜不到照旧说"未知工具"，绝不编一个不存在的名字（编了它会更糊涂）。
    //
    // ⚠️ 不要传 `nameScore`（中文歌名的 CJK 二元组）：它对非精确匹配乘了 0.8 折扣，
    //    上限就是 0.8，永远过不了 0.82 的门槛 —— 第一版这么写，整条模糊通道是死代码。
    //    工具名是纯 ASCII snake_case，用 tool-name-hint 里的编辑距离才对。
    const guess = suggestToolName(name, defs.map((d) => d.name));
    const hint = describeToolSuggestion(name, guess);
    return {
      content: hint ? `错误：${hint}` : `错误：未知工具 ${name}`,
      isError: true
    };
  }
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
