// 链接 → 本地音频：群友甩过来一个 B站视频 / 网易云 / QQ音乐 链接，直接拿去翻唱。
//
// 为什么需要这一层：这些链接打开的都是一张 HTML 页面（实测 B站 50KB、网易云 22KB），
// 以前的 url 参数只认「音频直链」，于是网页被当成 mp3 存进曲库，
// 翻唱在 5% 报「ffmpeg 解码失败：Output file #0 does not contain any stream」——
// 和当初酷狗加密文件一模一样的症状，排查时极容易误判成「下载失败」。
//
// 分流规则（全部实测过，见 docs/链接翻唱-2026-10-21.md）：
//   · 音频直链            → 直接下来
//   · B站 / YouTube / 抖音 → yt-dlp 取音轨（B站 1080P 要会员，但音轨 192k 匿名就能下）
//   · 网易云 / QQ音乐 …   → 页面只给歌名+歌手，音频要登录；退一步「提歌名 → B站找原曲」
//
// 两个必须知道的坑：
//   1. B站搜索接口不带 cookie 一律 412。先访问一次首页拿 buvid3 + b_nut 再搜，就能出结果。
//   2. yt-dlp 默认会调 ffmpeg 做 -x 转码，本机 ffmpeg 不在 PATH 里，所以这里**不转码**：
//      只下原始音轨（m4a/webm），要转交给后面统一的那条 ffmpeg 链路。

import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './config.js';
import { runProc, resolveFfmpeg } from './media-tools.js';
import { safeFetch, safeFetchBinary } from './safe-fetch.js';
import { findLocalSong, findCachedPlaylistAudio } from './song-router.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 能直接丢给翻唱引擎的扩展名（跟 tools.js 的 SONG_EXTS 保持一致）。 */
const AUDIO_EXTS = ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'ape'];

/** 要过一道 ffmpeg 的容器（yt-dlp 下 B站常见 opus/webm）。 */
const NEEDS_CONVERT = ['webm', 'mkv', 'opus', 'mp4', 'ts', 'flv'];

const MUSIC_HOSTS = [
  /(^|\.)music\.163\.com$/, /(^|\.)163cn\.tv$/, /(^|\.)music\.126\.net$/,
  /(^|\.)y\.qq\.com$/, /(^|\.)c\.y\.qq\.com$/, /(^|\.)i\.y\.qq\.com$/,
  /(^|\.)kugou\.com$/, /(^|\.)kuwo\.cn$/, /(^|\.)music\.migu\.cn$/,
  /(^|\.)music\.apple\.com$/, /(^|\.)open\.spotify\.com$/,
];

const VIDEO_HOSTS = [
  /(^|\.)bilibili\.com$/, /(^|\.)b23\.tv$/, /(^|\.)acfun\.cn$/,
  /(^|\.)youtube\.com$/, /(^|\.)youtu\.be$/, /(^|\.)music\.youtube\.com$/,
  /(^|\.)douyin\.com$/, /(^|\.)iesdouyin\.com$/, /(^|\.)kuaishou\.com$/,
  /(^|\.)ixigua\.com$/, /(^|\.)v\.qq\.com$/, /(^|\.)weibo\.com$/, /(^|\.)weibo\.cn$/,
  /(^|\.)xiaohongshu\.com$/, /(^|\.)xhslink\.com$/, /(^|\.)dailymotion\.com$/,
];

const AUDIO_URL_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma|ape|amr)(?:[?#]|$)/i;

/**
 * 判断一个链接该怎么处理。
 * @returns {{kind:'direct'|'video'|'music'|'unknown'|'invalid', site:string, url:string, reason?:string}}
 */
export function classifyUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'invalid', site: '', url: '', reason: '空链接' };
  if (!/^https?:\/\//i.test(s)) return { kind: 'invalid', site: '', url: s, reason: '不是 http/https 开头的链接' };
  let u;
  try { u = new URL(s); } catch { return { kind: 'invalid', site: '', url: s, reason: '链接格式不对' }; }
  const host = u.hostname.toLowerCase();
  if (AUDIO_URL_RE.test(u.pathname)) return { kind: 'direct', site: host, url: s };
  const isVideo = VIDEO_HOSTS.some((r) => r.test(host));
  const isMusic = MUSIC_HOSTS.some((r) => r.test(host));
  if (isVideo) return { kind: 'video', site: host, url: s };
  if (isMusic) return { kind: 'music', site: host, url: s };
  return { kind: 'unknown', site: host, url: s };
}

/** 文本里第一个能认出来的链接（模型常把链接塞进 title/lyrics）。 */
export function pickUrlFromText(text) {
  const m = String(text || '').match(/https?:\/\/[^\s，。、）)】"'<>]+/i);
  return m ? m[0].replace(/[，。、）)】"'<>]+$/, '') : '';
}

// ── yt-dlp ──────────────────────────────────────────────────────────────

const PY_CANDIDATES = [
  path.join(ROOT, 'diffsinger-env', 'Scripts', 'python.exe'),
  path.join(ROOT, 'rvc', 'py310', 'python.exe'),
];

let _ytdlp = null; // { python } | { python:null }

async function ytdlpPython() {
  if (_ytdlp) return _ytdlp.python;
  for (const py of PY_CANDIDATES) {
    if (!fs.existsSync(py)) continue;
    const r = await runProc(py, ['-m', 'yt_dlp', '--version'], { timeoutMs: 30000 });
    if (r.code === 0 && /\d{4}\.\d{2}\.\d{2}/.test(r.stdout)) {
      _ytdlp = { python: py };
      return py;
    }
  }
  _ytdlp = { python: null };
  return null;
}

/** yt-dlp 是否可用（设置页/提示词里要用这个说人话）。 */
export async function linkDowloaderReady() {
  return !!(await ytdlpPython());
}

// ── B站 cookie（搜索接口不带就 412）────────────────────────────────────

let _biliCookie = { value: '', at: 0 };
const BILI_COOKIE_TTL = 30 * 60 * 1000;

export async function biliCookie({ force = false } = {}) {
  if (!force && _biliCookie.value && Date.now() - _biliCookie.at < BILI_COOKIE_TTL) {
    return _biliCookie.value;
  }
  try {
    // 目标域名是写死的 bilibili.com（不是用户输入），所以这里直接用 fetch 读 Set-Cookie，
    // 不走 safe-fetch —— 那层只回身体，拿不到响应头。
    const r = await fetch('https://www.bilibili.com/', {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    });
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const kv = list.map((x) => x.split(';')[0]).filter((x) => /^(buvid3|b_nut)=/.test(x));
    if (kv.length) {
      _biliCookie = { value: kv.join('; '), at: Date.now() };
      return _biliCookie.value;
    }
  } catch { /* 拿不到就用空 cookie 试一次，412 了再说 */ }
  return _biliCookie.value;
}

// ── 搜索（按歌名找 B站 原曲）──────────────────────────────────────────

function stripNoise(title) {
  return String(title || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')   // emoji
    .replace(/[【\[（(][^】\]）)]{0,24}[】\]）)]/g, '')           // 各种前缀/后缀标签
    .replace(/[《》「」『』“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 明显不能拿来唱的结果：直播、翻唱（不是原唱）、伴奏、教学、reaction… */
function looksUnusable(title) {
  return /直播|回放|切片|翻唱|翻自|covered by|cover\s*by|伴奏|纯音乐|钢琴|吉他|教学|教程|tutorial|reaction|reacc?|混剪|鬼畜|合集|歌单|playlist|radio|电台|采访|花絮|字幕组招募/i
    .test(String(title || ''));
}

/** 标题里带这些的优先（音质好、是正经原曲搬运）。 */
function qualityBonus(title) {
  const t = String(title || '');
  let s = 0;
  if (/无损|Hi-?Res|高音质|无损音质|SQ|母带/i.test(t)) s += 0.12;
  if (/官方|MV|完整版|原唱|专辑/i.test(t)) s += 0.06;
  if (/4K|1080P|2160P/i.test(t)) s += 0.02;
  if (/现场|live/i.test(t)) s -= 0.06;
  if (/片段|短版|串烧|remix|dj/i.test(t)) s -= 0.2;
  return s;
}

/**
 * 给搜索结果打分，挑一条最像「原曲」的。
 * 判据都跟「能不能拿来翻唱」有关：时长够不够、是不是原唱、标题里有没有歌名。
 */
export function pickBestTrack(entries, { song = '', artist = '', minDur = 45, maxDur = 600 } = {}) {
  const wantSong = stripNoise(song);
  const wantArtist = stripNoise(artist);
  let best = null;
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    const dur = Number(e.duration) || 0;
    if (dur && (dur < minDur || dur > maxDur)) continue;
    if (looksUnusable(e.title)) continue;

    let score = 0;
    const t = stripNoise(e.title);
    if (wantSong && t.includes(wantSong)) {
      score += 0.5;
    } else if (wantSong) {
      // 歌名被拆开/带英文译名时给部分分，但**命中率不够就直接丢掉**：
      // 只靠歌手名对得上（搜「晴天 周杰伦」跳出来「七里香 周杰伦」）会给到 0.43 分，
      // 足够把真正的原曲挤下去 —— 结果就是「唱错歌」，比唱不出来更糟。
      const chars = [...new Set(wantSong.replace(/\s/g, ''))];
      const ratio = chars.filter((c) => t.includes(c)).length / Math.max(1, chars.length);
      if (ratio < 0.6) continue;
      score += 0.25 * ratio;
    }
    if (wantArtist && t.includes(wantArtist)) score += 0.25;
    score += qualityBonus(e.title);
    // 播放量对数权重：几百万的通常是对的那条
    const vc = Number(e.view_count) || 0;
    if (vc > 0) score += Math.min(0.15, Math.log10(vc) / 60);
    // 时长贴近 3~5 分钟更可能是完整原曲
    if (dur >= 150 && dur <= 360) score += 0.05;

    if (!best || score > best.score) {
      best = { ...e, score: Math.round(score * 1000) / 1000, url: e.webpage_url || `https://www.bilibili.com/video/${e.id}` };
    }
  }
  return best;
}

/**
 * B站站内搜索。
 * 注意 `bilisearchN:` 里的 N 只是「取前 N 条」，yt-dlp 会逐条解析，所以别开太大（3~6 最合适）。
 *
 * ★ 这个接口有**频率风控**：连着搜两三次就回 412（Precondition Failed）。
 *   所以这里做了两道缓冲：全局最小间隔 + 412 时换新 cookie 并退避重试。
 *   实测「网易云链接 + QQ音乐链接」连着测会触发，隔几秒就好。
 */
let _lastBiliSearchAt = 0;
const BILI_SEARCH_MIN_GAP = 2500;

export async function searchBilibili(keyword, { limit = 6, log = null } = {}) {
  const py = await ytdlpPython();
  if (!py) throw new Error('本机没有 yt-dlp，处理不了视频/音乐链接');
  const n = Math.max(1, Math.min(8, Number(limit) || 6));

  // 解析 stdout：yt-dlp 会把 warning/ERROR 混在 JSON 前面，别直接 JSON.parse 整串
  const parseOut = (stdout) => {
    const clean = String(stdout || '')
      .split('\n')
      .filter((l) => !/^(ERROR|WARNING|Deprecated|\[)/.test(l.trim()))
      .join('\n');
    const a = clean.indexOf('{');
    const b = clean.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(clean.slice(a, b + 1)); } catch { return null; }
  };

  const attempt = async () => {
    // 全局最小间隔：同一进程里连着搜时，先让风控窗口过去
    const gap = Date.now() - _lastBiliSearchAt;
    if (gap < BILI_SEARCH_MIN_GAP) {
      await new Promise((r) => setTimeout(r, BILI_SEARCH_MIN_GAP - gap));
    }
    _lastBiliSearchAt = Date.now();
    const cookie = await biliCookie();
    const args = [
      '-m', 'yt_dlp', '--no-warnings', '-J', '--socket-timeout', '20', '--retries', '1'
    ];
    if (cookie) args.push('--add-header', 'Cookie:' + cookie);
    args.push(`bilisearch${n}:${keyword}`);
    const r = await runProc(py, args, { timeoutMs: 120000 });
    return { r, data: parseOut(r.stdout) };
  };

  let { r, data } = await attempt();
  // 412 = 风控。换一个新身份 + 等一下再试，实测多数情况就过了。
  for (let i = 0; i < 2 && (r.code !== 0 || !data) && /412|Precondition/i.test(r.stderr); i++) {
    if (log) log(`[链接] B站搜索被风控（412），换 cookie 重试（${i + 1}/2）…`);
    _biliCookie = { value: '', at: 0 };
    await new Promise((res) => setTimeout(res, 3000 + i * 3000));
    ({ r, data } = await attempt());
  }

  if (!data) {
    const brief = String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' / ');
    if (/412|Precondition/i.test(r.stderr)) throw new Error('B站搜索被风控了（412），过几秒再试');
    throw new Error('B站搜索失败：' + (brief || '返回内容解析不了').replace(/\s+/g, ' ').slice(0, 200));
  }
  const entries = (data?.entries || []).filter(Boolean);
  if (log) log(`[链接] B站搜「${keyword}」→ ${entries.length} 条`);
  return entries;
}

/**
 * yt-dlp 取视频元数据（-J，不下载）：标题/简介/UP主/时长/章节/字幕轨…
 *
 * 单独抽出来是因为「看视频」（video-intel.js）也要同一份元数据 —— 各写一遍
 * 就会出现两套解析规则、两套报错文案，改一处漏一处。
 *
 * @returns {Promise<object>} 解析后的元数据对象；解析不出来就抛错（带 yt-dlp 的最后两行）
 */
export async function ytdlpJson(url, { log = null, headers = [], timeoutMs = 120000 } = {}) {
  const py = await ytdlpPython();
  if (!py) throw new Error('本机没有 yt-dlp，处理不了这个链接');
  const args = ['-m', 'yt_dlp', '--no-warnings', '-J', '--socket-timeout', '20', '--retries', '1'];
  for (const h of headers) if (h) args.push('--add-header', String(h));
  args.push(url);
  const r = await runProc(py, args, { timeoutMs });
  // yt-dlp 会把 warning/ERROR 混在 JSON 前面，别直接 JSON.parse 整串
  const clean = String(r.stdout || '')
    .split('\n')
    .filter((l) => !/^(ERROR|WARNING|Deprecated|\[)/.test(l.trim()))
    .join('\n');
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  let data = null;
  if (a >= 0 && b > a) {
    try { data = JSON.parse(clean.slice(a, b + 1)); } catch { data = null; }
  }
  if (!data) {
    const brief = String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' / ');
    if (/412|Precondition/i.test(r.stderr)) throw new Error('被站点风控了（412），过几秒再试');
    throw new Error('视频信息解析失败：' + (brief || '返回内容解析不了').replace(/\s+/g, ' ').slice(0, 200));
  }
  if (log) log(`[yt-dlp] 元数据：${data?.title || '?'}`);
  return data;
}

// ── 从音乐平台页面提歌名 ───────────────────────────────────────────────

const SITE_NOISE = /网易云音乐|QQ音乐|酷狗音乐|酷我音乐|咪咕音乐|Apple Music|Spotify|单曲|专辑|歌单|MV|在线试听|下载|音乐平台|千万正版|海量/i;

/**
 * 页面标题 → { song, artist }。
 * 网易云：`晴天（Sunny Day） - 周杰伦 - 单曲 - 网易云音乐`
 * QQ音乐：`晴天 - 周杰伦 - QQ音乐-千万正版音乐…`
 */
export function parseMusicTitle(title, { ogTitle = '' } = {}) {
  const parts = String(title || '')
    .split(/\s+[-|–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !SITE_NOISE.test(s));
  let song = parts[0] || '';
  let artist = parts[1] || '';
  // og:title 在网易云是干净歌名（"晴天"），在 QQ音乐是整串
  const og = String(ogTitle || '').trim();
  if (og && !SITE_NOISE.test(og)) {
    const ogParts = og.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
    if (ogParts[0]) song = ogParts[0];
    if (ogParts[1] && !SITE_NOISE.test(ogParts[1])) artist = ogParts[1];
  }
  // "晴天（Sunny Day）" → "晴天"，但保留纯英文歌名的括号（如 "Hello (Live)" 就砍掉）
  const bare = song.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (bare) song = bare;
  return { song: song.trim(), artist: artist.trim() };
}

export async function songInfoFromMusicPage(url, { log = null } = {}) {
  const r = await safeFetch(url, { maxChars: 8000 });
  const og = (r.rawBody.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    || r.rawBody.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i)
    || [])[1] || '';
  const info = parseMusicTitle(r.title, { ogTitle: og });
  if (log) log(`[链接] 平台页面解析：歌名「${info.song}」 歌手「${info.artist || '?'}」`);
  return { ...info, pageTitle: r.title, finalUrl: r.url };
}

// ── 下载 / 转码 ─────────────────────────────────────────────────────────

/**
 * 用 yt-dlp 下载。默认只取音轨（翻唱用）；视频理解要画面，自己传 format。
 *
 * ⚠️ format 留空 = 音轨。要画面必须显式传（如 'worst[height<=480]/worst'），
 *    别让"默认"悄悄变成下载整个视频 —— 群里一个链接就能拖进来几百 MB。
 */
export async function ytdlpDownload(url, { dir, stem, log = null, cookie = '', format = '' } = {}) {
  const py = await ytdlpPython();
  if (!py) throw new Error('本机没有 yt-dlp，处理不了这个链接');
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    '-m', 'yt_dlp', '--no-warnings', '--no-playlist',
    '--socket-timeout', '25', '--retries', '2', '--fragment-retries', '3',
    // 只下音轨，不转码：本机 ffmpeg 不在 PATH，-x 会直接失败（实测）
    '-f', format || 'ba[ext=m4a]/ba[ext=mp4]/ba/b',
    '-o', path.join(dir, `${stem}.%(ext)s`),
    // 一个分隔符里同时带出处标题和落盘路径：B站链接没给歌名时，
    // 拿视频标题当歌名比拿 link-17925… 当歌名有用得多。
    '--print', 'after_move:%(title)s|||%(filepath)s',
  ];
  if (cookie) args.push('--add-header', 'Cookie:' + cookie);
  args.push(url);

  if (log) log('[链接] yt-dlp 下载…');
  const r = await runProc(py, args, { timeoutMs: 300000 });
  let title = '';
  let file = '';
  for (const raw of String(r.stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line.includes('|||')) continue;
    const idx = line.lastIndexOf('|||');
    const t = line.slice(0, idx).trim();
    const p = line.slice(idx + 3).trim();
    if (p && fs.existsSync(p)) { file = p; title = t; }
  }
  if (!file) {
    const brief = String(r.stderr || '').split('\n')
      .filter((l) => /ERROR|error|Unsupported|404|403|Private|copyright/i.test(l))
      .slice(-2).join(' / ');
    throw new Error('下载音轨失败：' + (brief || '没有产出文件').replace(/\s+/g, ' ').slice(0, 240));
  }
  return { file, title: title.slice(0, 40) };
}

/** webm/opus 之类先用 ffmpeg 转成 m4a，否则进不了曲库（曲库只扫 wav/mp3/flac/m4a…）。 */
async function ensurePlayable(file, { log = null } = {}) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (AUDIO_EXTS.includes(ext)) return file;
  if (!NEEDS_CONVERT.includes(ext)) return file;
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('这个音轨要先转码才能唱，但本机没找到 ffmpeg');
  const out = file.replace(/\.[^.]+$/, '') + '.m4a';
  if (log) log(`[链接] ${ext} → m4a 转码…`);
  const r = await runProc(ff, [
    '-y', '-hide_banner', '-v', 'error', '-i', file, '-vn',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', out
  ], { timeoutMs: 300000 });
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error('音轨转码失败：' + String(r.stderr || '').slice(-160));
  }
  try { fs.unlinkSync(file); } catch { /* 临时件删不掉无所谓 */ }
  return out;
}

// ── 主入口 ─────────────────────────────────────────────────────────────

/**
 * 把一条链接变成「本地能翻唱的音频文件」。
 *
 * 顺序是刻意这么排的：先查本地（0 网络、0 风险），再查点歌台缓存，
 * 最后才上网找。音乐平台的歌如果曲库里就有，根本不用碰 B站。
 *
 * @returns {Promise<{file:string, title:string, artist:string, source:string, via:string}>}
 */
export async function resolveLinkAudio(url, { dir, stem = 'link', log = null } = {}) {
  const c = classifyUrl(url);
  if (c.kind === 'invalid') throw new Error(c.reason || '链接无效');
  fs.mkdirSync(dir, { recursive: true });
  const base = String(stem || 'link').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);

  // ① 音频直链：直接下
  if (c.kind === 'direct') {
    if (log) log('[链接] 音频直链，直接下载…');
    const { buffer } = await safeFetchBinary(c.url, 100 * 1024 * 1024);
    const ext = (path.extname(new URL(c.url).pathname).slice(1) || 'mp3').toLowerCase();
    const file = path.join(dir, `${base}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, title: '', artist: '', source: c.url, via: 'direct' };
  }

  // ② 音乐平台：先看本地/缓存，省一次外网折腾
  if (c.kind === 'music') {
    let info = { song: '', artist: '' };
    try {
      info = await songInfoFromMusicPage(c.url, { log });
    } catch (e) {
      if (log) log('[链接] 平台页面解析失败：' + (e?.message || e));
    }
    if (info.song) {
      const local = findLocalSong(info.song);
      if (local?.path && fs.existsSync(local.path)) {
        if (log) log(`[链接] 曲库已有「${info.song}」，直接用`);
        return { file: local.path, title: local.base || info.song, artist: info.artist, source: c.url, via: 'library' };
      }
      const cached = findCachedPlaylistAudio(info.song);
      if (cached?.path && fs.existsSync(cached.path)) {
        if (log) log(`[链接] 点歌台缓存已有「${info.song}」，直接用`);
        return { file: cached.path, title: cached.title || info.song, artist: info.artist, source: c.url, via: 'playlist' };
      }
    }
    // 平台音频要登录（网易云匿名接口已关、QQ音乐要 cookie），退一步去 B站找原曲搬运
    if (!info.song) {
      throw new Error('这个音乐平台链接解析不出歌名，换个链接或直接发音频文件');
    }
    const keyword = [info.song, info.artist].filter(Boolean).join(' ');
    if (log) log(`[链接] 平台音频要登录，改为在 B站找「${keyword}」的原曲…`);
    const entries = await searchBilibili(keyword, { limit: 6, log });
    const best = pickBestTrack(entries, { song: info.song, artist: info.artist });
    if (!best) throw new Error(`B站也没找到「${keyword}」能用的原曲`);
    if (log) log(`[链接] 选中：${best.title}（${Math.round(best.duration || 0)}s，匹配 ${best.score}）`);
    const dl = await ytdlpDownload(best.url, { dir, stem: `${base}-bili`, log, cookie: await biliCookie() });
    const file = await ensurePlayable(dl.file, { log });
    return { file, title: info.song, artist: info.artist, source: best.url, via: 'bilibili-search' };
  }

  // ③ 视频站：B站/YouTube/抖音… 直接取音轨
  if (c.kind === 'video') {
    const cookie = /bilibili|b23\.tv/.test(c.site) ? await biliCookie() : '';
    const dl = await ytdlpDownload(c.url, { dir, stem: base, log, cookie });
    const file = await ensurePlayable(dl.file, { log });
    // 视频页没给歌名时用视频标题（去掉【】前缀、平台后缀），比 "link-17925…" 有用
    const cleanTitle = String(dl.title || '')
      .replace(/[【\[][^】\]]{0,16}[】\]]/g, '')
      .replace(/[-_|]\s*(哔哩哔哩|bilibili).*$/i, '')
      .trim();
    return { file, title: cleanTitle || base, artist: '', source: c.url, via: 'yt-dlp' };
  }

  throw new Error(`认不出这个站点的链接（${c.site}），把歌发成文件更快`);
}

/** 给提示词用的一句话说明（哪种链接能直接吃）。 */
export function linkSupportSummary() {
  return 'B站/YouTube/抖音视频链接、网易云/QQ音乐/酷狗/酷我歌曲页链接、音频直链都能直接翻唱';
}
