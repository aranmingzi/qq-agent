// 看视频：群友甩一个视频链接，先把它变成「能读的材料」，再让模型说人话总结。
//
// 为什么要有这一层（而不是把链接丢给模型自己编）：
//   模型拿到的只有一个 URL，它要么编造内容（最糟），要么老实说"我看不了"。
//   真正能拿到的是**这层代码去抓的材料**：标题/简介/UP主/章节/字幕/弹幕/热评/关键帧画面。
//   材料的多少决定总结能说到几分 —— 所以每一步都记进 intel.materials / intel.missing，
//   最后总结不出来时，说清楚"缺什么"，而不是糊一句"大概是个讲XX的视频"。
//
// 三条硬规矩：
//   1. 只认材料，不编内容。材料只有标题时，总结必须说"只看到标题，内容猜不准"。
//   2. 缺材料要留痕（intel.missing），不许静默降级 —— 否则"总结得挺像"其实全是模型脑补。
//   3. 每一步都能单独失败。字幕拿不到不影响弹幕，弹幕拿不到不影响标题；
//      最后只要还有一点点材料就返回，全没有才算失败。
//
// 站点顺序（实测，见 docs/视频理解-2026-10-22.md）：
//   · B站  → 官方 API 最快最全（view / player/v2 / 弹幕 / 热评 / 标签）
//             ⚠️ AI 字幕要登录（player/v2 的 need_login_subtitle），匿名拿不到，别硬试。
//   · 其余（YouTube / 抖音 / 西瓜 / 微博 / A站…）→ yt-dlp -J（有字幕轨就顺下来）
//   · 都不行 → 抓页面 og:title / og:description 兜底（只够说"这是个什么标题的视频"）

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';
import { chatCompletion } from './llm.js';
import { validateFetchUrl } from './safe-fetch.js';
import { resolveFfmpeg, runProc } from './media-tools.js';
import { classifyUrl, biliCookie, ytdlpJson, ytdlpDownload } from './link-audio.js';
import { analyzeWithQwenVision, qwenVisionInfo } from './qwen-vision.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 抓过的视频存这里（同一个链接被转好几遍时不用重复抓）
const CACHE_FILE = path.join(DATA_DIR, 'video-cache.json');
const FRAME_DIR = path.join(DATA_DIR, 'video', 'frames');

// ── 小工具 ─────────────────────────────────────────────────────────────

/** 数字兜底。⚠️ Number('') / Number(null) 都是 0 —— 先判空，否则缺省字段会静默变 0。 */
function num(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** 秒 → mm:ss（超过一小时给 h:mm:ss）。 */
export function mmss(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0 ? `${h}:${mm}:${String(r).padStart(2, '0')}` : `${mm}:${String(r).padStart(2, '0')}`;
}

function hostSite(host) {
  const h = String(host || '').toLowerCase();
  if (/bilibili\.com|b23\.tv|bili2233\.cn/.test(h)) return 'bilibili';
  if (/acfun\.cn/.test(h)) return 'acfun';
  if (/youtube\.com|youtu\.be/.test(h)) return 'youtube';
  if (/douyin\.com|iesdouyin\.com/.test(h)) return 'douyin';
  if (/kuaishou\.com|chenzhongtech/.test(h)) return 'kuaishou';
  if (/ixigua\.com/.test(h)) return 'ixigua';
  if (/v\.qq\.com/.test(h)) return '腾讯视频';
  if (/xiaohongshu\.com|xhslink\.com/.test(h)) return '小红书';
  if (/weibo\.com|weibo\.cn/.test(h)) return '微博';
  return h || '未知站点';
}

// ── 配置 ───────────────────────────────────────────────────────────────

export function videoConfig(raw = null) {
  const c = (raw || getConfig()).video || {};
  return {
    enabled: c.enabled !== false,
    autoReply: c.autoReply !== false,
    keyframes: c.keyframes === true,          // 默认关：要下整个视频，群里一个链接几百 MB 受不了
    maxFrameDurationSec: clamp(num(c.maxFrameDurationSec, 900), 60, 3600),
    frameCount: clamp(num(c.frameCount, 4), 1, 6),
    maxChars: clamp(num(c.maxChars, 6000), 1000, 30000),   // 喂给模型的材料上限
    cacheHours: clamp(num(c.cacheHours, 12), 0, 720),
    danmakuTop: clamp(num(c.danmakuTop, 12), 0, 40),
    commentTop: clamp(num(c.commentTop, 8), 0, 20),
    summaryMaxChars: clamp(num(c.summaryMaxChars, 400), 80, 1200),
    quietFromHour: clamp(num(c.quietFromHour, 0), 0, 23),
    quietToHour: clamp(num(c.quietToHour, 6), 0, 23),
    perChatCooldownMs: Math.max(0, num(c.perChatCooldownMs, 60000)),
    maxPerHour: clamp(num(c.maxPerHour, 4), 1, 30),
    timeoutMs: clamp(num(c.timeoutMs, 30000), 8000, 180000)
  };
}

/** 深夜不自动开口（跟 gesture 一个道理：凌晨自动发一段总结，是骚扰不是贴心）。 */
export function isQuietHour(cfg = videoConfig(), now = new Date()) {
  const h = now.getHours();
  const from = cfg.quietFromHour;
  const to = cfg.quietToHour;
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// ── 自动看视频的预算（纯内存，重启清零：这是"防抖"，不是配额账本）────────

const autoRecent = new Map();   // `${chatKey}|${url}` -> ts（同一个链接别重复抓）
const autoTimes = new Map();    // chatKey -> [ts]
const AUTO_SAME_URL_MS = 30 * 60 * 1000;

/**
 * 这一条要不要自动看。
 * 返回 { ok:false, reason } 时 reason 是**能直接进日志/给人看的话**，不许返回空原因。
 */
export function canAutoWatch(chatKey, url, cfg = videoConfig(), now = Date.now()) {
  if (!cfg.enabled) return { ok: false, reason: '视频功能已关闭' };
  const key = String(chatKey || '');
  const norm = normalizeVideoUrl(String(url || ''));
  const last = autoRecent.get(`${key}|${norm}`) || 0;
  if (last && now - last < AUTO_SAME_URL_MS) {
    return { ok: false, reason: `这个链接 ${Math.round((now - last) / 60000)} 分钟前刚看过` };
  }
  const times = (autoTimes.get(key) || []).filter((t) => now - t < 3600000);
  if (times.length >= cfg.maxPerHour) {
    return { ok: false, reason: `这个会话一小时已经自动看了 ${times.length} 个视频` };
  }
  const lastAt = times.length ? times[times.length - 1] : 0;
  if (lastAt && now - lastAt < cfg.perChatCooldownMs) {
    return { ok: false, reason: '刚看过一个，缓一下' };
  }
  return { ok: true, reason: '' };
}

/** 记账。**先记再干活**（canAutoWatch → noteAutoWatch → 抓取）：并发消息不会重复抓同一个链接。 */
export function noteAutoWatch(chatKey, url, now = Date.now()) {
  const key = String(chatKey || '');
  const norm = normalizeVideoUrl(String(url || ''));
  autoRecent.set(`${key}|${norm}`, now);
  const times = (autoTimes.get(key) || []).filter((t) => now - t < 3600000);
  times.push(now);
  autoTimes.set(key, times.slice(-30));
  if (autoRecent.size > 200) {
    for (const [k, t] of autoRecent) if (now - t > AUTO_SAME_URL_MS) autoRecent.delete(k);
  }
}

// ── URL ────────────────────────────────────────────────────────────────

const SHORT_HOSTS = /^(b23\.tv|bili2233\.cn|youtu\.be|v\.douyin\.com|www\.iesdouyin\.com|xhslink\.com|dwz\.cn|t\.cn|url\.cn|sourl\.cn|m\.toutiao\.com)$/i;

/** 缓存键：去掉查询串和末尾斜杠（同一视频带不同 p / 不同追踪参数算一条）。 */
export function normalizeVideoUrl(raw) {
  const s = String(raw || '').trim();
  try {
    const u = new URL(s);
    let p = u.pathname.replace(/\/+$/, '');
    // 分 P 单独成键（p=2 讲的内容和 p=1 不是一回事）
    const page = u.searchParams.get('p');
    return `${u.hostname.toLowerCase()}${p}${page ? `?p=${page}` : ''}`;
  } catch {
    return s;
  }
}

/**
 * 一段话里找视频链接。
 * 群里常见三种：① 完整链接 ② 短链（b23.tv / youtu.be）③ 直接甩 BV 号（连 http 都没有）。
 * 音乐平台链接不算（那是翻唱的地盘，见 link-audio）。
 *
 * @returns {{url:string, site:string, raw:string, bare:boolean}|null}
 */
export function findVideoUrl(text) {
  const s = String(text || '');
  if (!s) return null;
  // ① 裸 BV 号：B站分享文案里常把链接和标题一起甩，BV 号一定在里面
  const bv = s.match(/(BV[0-9A-Za-z]{10})/);
  if (bv) {
    return { url: `https://www.bilibili.com/video/${bv[1]}`, site: 'bilibili', raw: bv[1], bare: true };
  }
  const m = s.match(/https?:\/\/[^\s，。、；;）)】"'<>]+/i);
  if (!m) return null;
  const url = m[0].replace(/[，。、；;）)】"'<>]+$/, '');
  const c = classifyUrl(url);
  if (c.kind === 'video') {
    let host = '';
    try { host = new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname; } catch { /* 认不出就算了 */ }
    return { url: c.url, site: hostSite(host), raw: url, bare: false };
  }
  return null;
}

/** B站链接 → { bvid, aid, page }。av 号 / BV 号 / 短链里的 BV 都认。 */
export function parseBiliRef(raw) {
  const s = String(raw || '');
  let page = 1;
  try {
    const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    page = Math.max(1, Number(u.searchParams.get('p')) || 1);
  } catch { /* 不是 URL 就当纯 ID */ }
  const bv = s.match(/(BV[0-9A-Za-z]{10})/);
  if (bv) return { bvid: bv[1], aid: 0, page };
  const av = s.match(/\bav(\d{1,15})\b/i);
  if (av) return { bvid: '', aid: Number(av[1]), page };
  return { bvid: '', aid: 0, page };
}

// ── 抓取小件（都带超时，都 fail-soft：拿不到就返回空，不抛）─────────────

async function getJson(url, { headers = {}, timeoutMs = 12000 } = {}) {
  const { url: safe } = await validateFetchUrl(url);   // SSRF 防护复用同一层，别自己 new URL 就 fetch
  const res = await fetch(safe.toString(), {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function getText(url, { headers = {}, timeoutMs = 12000 } = {}) {
  const { url: safe } = await validateFetchUrl(url);
  const res = await fetch(safe.toString(), {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ── B站 ────────────────────────────────────────────────────────────────

/**
 * 弹幕 XML → { count, top:[{text,n}], timeline:[{at,text}] }
 *
 * 为什么要「时间线」：高频弹幕只能说明"大家都在刷什么梗"，
 * 按时间桶取每段的代表弹幕，才能看出"这个视频从头到尾在讲什么"。
 * 短视频（<2 分钟）不切桶 —— 桶里没东西，切了反而更看不懂。
 */
export function aggregateDanmaku(xml, { duration = 0, topN = 12, buckets = 6 } = {}) {
  const out = { count: 0, top: [], timeline: [] };
  const text = String(xml || '');
  const re = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
  const counter = new Map();
  const byTime = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = String(m[1] || '').split(',');
    const t = Number(p[0]);
    const body = String(m[2] || '').replace(/[\r\n]+/g, ' ').trim();
    // B站单条弹幕上限 50 字，超过的一定是拼接/刷屏，留着只会污染高频榜
    if (!body || body.length > 50) continue;
    out.count++;
    counter.set(body, (counter.get(body) || 0) + 1);
    if (Number.isFinite(t)) byTime.push({ t, text: body });
  }
  // 高频：重复 2 次以上才算"大家都在说"；弹幕太少时放宽到 1 次
  const minRepeat = out.count > 200 ? 2 : 1;
  out.top = [...counter.entries()]
    .filter(([, n]) => n >= minRepeat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, topN))
    .map(([text, n]) => ({ text, n }));

  const dur = Number(duration) || 0;
  if (dur >= 120 && byTime.length) {
    const size = dur / Math.max(1, buckets);
    for (let i = 0; i < buckets; i++) {
      const lo = i * size;
      const hi = lo + size;
      const inBucket = byTime.filter((x) => x.t >= lo && x.t < hi);
      if (!inBucket.length) continue;
      const freq = new Map();
      for (const x of inBucket) freq.set(x.text, (freq.get(x.text) || 0) + 1);
      const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      out.timeline.push({ at: Math.round(lo), text: best ? best[0] : '' });
    }
    out.timeline = out.timeline.filter((x) => x.text);
  }
  return out;
}

/** 章节/看点文案：B站有的给纯文本，有的塞一段 JSON。 */
export function chapterText(content) {
  const s = String(content || '').trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      return String(j?.title || j?.content || j?.text || '').trim();
    } catch { /* 不是 JSON 就当纯文本 */ }
  }
  return s;
}

/** 热评（sort=2 = 按热度）。评论是"观众看完在聊什么"，比简介更能说明视频是什么气质。 */
async function biliHotComments(aid, { limit = 8, timeoutMs = 12000 } = {}) {
  try {
    const j = await getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=10&pn=1`, { timeoutMs });
    const list = (j?.data?.replies || []).map((r) => String(r?.content?.message || '').replace(/\s+/g, ' ').trim());
    return list.filter((t) => t && t.length <= 140).slice(0, limit);
  } catch {
    return [];
  }
}

async function biliTags(bvid, { limit = 10, timeoutMs = 12000 } = {}) {
  try {
    const j = await getJson(`https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`, { timeoutMs });
    return (j?.data || []).map((t) => String(t?.tag_name || '').trim()).filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

async function intelBilibili(url, { log = null, cfg = videoConfig(), timeoutMs = 0 } = {}) {
  // 单次接口超时：整体预算紧就跟着紧，但给个下限（4s 以下连握手都不够）
  const per = timeoutMs ? clamp(timeoutMs, 4000, 15000) : 12000;
  const ref = parseBiliRef(url);
  if (!ref.bvid && !ref.aid) throw new Error('这个 B站链接里没有 BV 号/av 号');
  // 匿名也要带 buvid3：B站接口不带 cookie 一律 412（link-audio 里踩过同一个坑）
  let cookie = '';
  try { cookie = await biliCookie(); } catch { /* 拿不到就空着试一次 */ }
  const H = { referer: 'https://www.bilibili.com/' };
  if (cookie) H.cookie = cookie;

  const q = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?${q}`, { headers: H, timeoutMs: per });
  if (view?.code !== 0) throw new Error(`B站接口 ${view?.code}：${view?.message || '拿不到视频信息'}`);
  const d = view.data || {};
  const page = Math.min(ref.page, Math.max(1, Number(d.videos) || 1));
  const cid = page > 1 && Array.isArray(d.pages) ? (d.pages[page - 1]?.cid || d.cid) : d.cid;

  const intel = {
    site: 'B站',
    url: `https://www.bilibili.com/video/${d.bvid || ref.bvid}${page > 1 ? `?p=${page}` : ''}`,
    title: String(d.title || '').trim(),
    author: String(d.owner?.name || '').trim(),
    duration: Number(d.duration) || 0,
    desc: String(d.desc || '').replace(/\s*\n\s*/g, ' ').trim(),
    dynamic: String(d.dynamic || '').replace(/\s*\n\s*/g, ' ').trim(),
    publishedAt: Number(d.pubdate) ? new Date(Number(d.pubdate) * 1000).toISOString().slice(0, 10) : '',
    stats: {
      view: Number(d.stat?.view) || 0,
      like: Number(d.stat?.like) || 0,
      reply: Number(d.stat?.reply) || 0,
      danmaku: Number(d.stat?.danmaku) || 0
    },
    cover: String(d.pic || '').trim(),
    pages: Array.isArray(d.pages) && d.pages.length > 1
      ? d.pages.map((p, i) => ({ no: i + 1, title: String(p.part || '').trim(), duration: Number(p.duration) || 0 }))
      : [],
    chapters: [],
    tags: [],
    subtitle: null,
    danmaku: null,
    comments: [],
    frames: [],
    materials: ['标题', '简介'],
    missing: []
  };

  // 字幕 + 章节（player/v2 一次给齐）
  try {
    const p = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${d.bvid || ref.bvid}&cid=${cid}`, { headers: H, timeoutMs: per });
    const subs = p?.data?.subtitle?.subtitles || [];
    const picked = subs.find((s) => /^zh/i.test(String(s.lan || ''))) || subs[0];
    if (picked?.subtitle_url) {
      const u = String(picked.subtitle_url).startsWith('//') ? `https:${picked.subtitle_url}` : picked.subtitle_url;
      const j = await getJson(u, { timeoutMs: Math.max(per, 15000) });
      const body = Array.isArray(j?.body) ? j.body : [];
      if (body.length) {
        intel.subtitle = {
          lang: String(picked.lan_doc || picked.lan || '字幕'),
          text: body.map((b) => String(b?.content || '')).filter(Boolean).join(' ')
        };
        intel.materials.push('字幕');
      }
    } else {
      // 不是"没字幕"就是"没登录" —— 这两种在日志里必须分得开，否则会一直以为是接口坏了
      intel.missing.push(p?.data?.subtitle?.need_login_subtitle ? 'AI字幕（要登录，匿名拿不到）' : '字幕');
    }
    const vps = p?.data?.view_points || [];
    intel.chapters = vps
      .map((v) => ({ from: Number(v.from) || 0, to: Number(v.to) || 0, title: chapterText(v.content) }))
      .filter((c) => c.title);
    if (intel.chapters.length) intel.materials.push('章节');
  } catch (e) {
    intel.missing.push(`字幕/章节（${String(e?.message || e).slice(0, 40)}）`);
  }

  // 弹幕
  if (cfg.danmakuTop > 0 && cid) {
    try {
      const xml = await getText(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, { headers: H, timeoutMs: Math.max(per, 15000) });
      const agg = aggregateDanmaku(xml, { duration: intel.duration, topN: cfg.danmakuTop });
      if (agg.count) {
        intel.danmaku = agg;
        intel.materials.push('弹幕');
      }
    } catch (e) {
      intel.missing.push(`弹幕（${String(e?.message || e).slice(0, 40)}）`);
    }
  }

  // 标签 + 热评（顺便拿的，失败无所谓）
  intel.tags = await biliTags(d.bvid || ref.bvid, { limit: 10, timeoutMs: per });
  if (intel.tags.length) intel.materials.push('标签');
  intel.comments = await biliHotComments(d.aid || ref.aid, { limit: cfg.commentTop, timeoutMs: per });
  if (intel.comments.length) intel.materials.push('热评');

  if (!intel.title) throw new Error('B站没返回标题');
  if (log) log(`[视频] B站：${intel.title.slice(0, 30)}（材料：${intel.materials.join('/')}）`);
  return intel;
}

// ── yt-dlp（YouTube / 抖音 / 西瓜…）────────────────────────────────────

const SUB_LANGS = ['zh-Hans', 'zh-CN', 'zh', 'zh-TW', 'zh-HK', 'en'];

/** 从 yt-dlp 元数据里挑一条最合适的字幕轨（人工字幕优先于自动字幕）。 */
export function pickSubtitleTrack(meta) {
  const pools = [meta?.subtitles, meta?.automatic_captions];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const lang of SUB_LANGS) {
      const list = pool[lang];
      if (!Array.isArray(list) || !list.length) continue;
      const fmt = list.find((x) => x?.ext === 'json3') || list.find((x) => x?.ext === 'vtt') || list[0];
      if (fmt?.url) return { url: fmt.url, ext: String(fmt.ext || ''), lang, auto: pool === meta.automatic_captions };
    }
  }
  return null;
}

export function vttToText(vtt) {
  return String(vtt || '')
    .replace(/^WEBVTT[^\n]*\n/, '')
    .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}[^\n]*\n/gm, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

export function json3ToText(j) {
  const events = Array.isArray(j?.events) ? j.events : [];
  const parts = [];
  for (const ev of events) {
    const segs = Array.isArray(ev?.segs) ? ev.segs : [];
    const line = segs.map((s) => String(s?.utf8 || '')).join('').replace(/\n/g, ' ').trim();
    if (line) parts.push(line);
  }
  return parts.join(' ');
}

async function intelYtdlp(url, { log = null, cookie = '', timeoutMs = 0 } = {}) {
  const headers = [];
  if (cookie) headers.push('Cookie:' + cookie);
  const meta = await ytdlpJson(url, { log, headers, timeoutMs: timeoutMs || 120000 });
  const intel = {
    site: hostSite(meta?.extractor_key || meta?.webpage_url || url),
    url: String(meta?.webpage_url || url),
    title: String(meta?.title || meta?.fulltitle || '').trim(),
    author: String(meta?.uploader || meta?.channel || meta?.artist || '').trim(),
    duration: Number(meta?.duration) || 0,
    desc: String(meta?.description || '').replace(/\s*\n\s*/g, ' ').trim(),
    dynamic: '',
    publishedAt: String(meta?.upload_date || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
    stats: {
      view: Number(meta?.view_count) || 0,
      like: Number(meta?.like_count) || 0,
      reply: Number(meta?.comment_count) || 0,
      danmaku: 0
    },
    cover: String(meta?.thumbnail || '').trim(),
    pages: [],
    chapters: Array.isArray(meta?.chapters)
      ? meta.chapters.map((c) => ({ from: Number(c?.start_time) || 0, to: Number(c?.end_time) || 0, title: String(c?.title || '').trim() })).filter((c) => c.title)
      : [],
    tags: Array.isArray(meta?.tags) ? meta.tags.map(String).filter(Boolean).slice(0, 10) : [],
    subtitle: null,
    danmaku: null,
    comments: [],
    frames: [],
    materials: ['标题'],
    missing: []
  };
  if (intel.desc) intel.materials.push('简介');
  if (intel.chapters.length) intel.materials.push('章节');
  if (intel.tags.length) intel.materials.push('标签');

  const track = pickSubtitleTrack(meta);
  if (track) {
    try {
      const raw = await getText(track.url, { timeoutMs: 20000 });
      const text = track.ext === 'json3' ? json3ToText(JSON.parse(raw)) : vttToText(raw);
      if (text) {
        intel.subtitle = { lang: track.auto ? `${track.lang}（自动字幕）` : track.lang, text };
        intel.materials.push('字幕');
      }
    } catch {
      intel.missing.push('字幕（下载失败）');
    }
  } else {
    intel.missing.push('字幕');
  }

  if (!intel.title) throw new Error('yt-dlp 没解析出标题');
  return intel;
}

// ── 兜底：只看页面 ──────────────────────────────────────────────────────

async function intelFromPage(url, { log = null, timeoutMs = 0 } = {}) {
  const { safeFetch } = await import('./safe-fetch.js');
  const r = await safeFetch(url, { maxChars: 4000 });
  const og = (r.rawBody.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    || r.rawBody.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i)
    || [])[1] || '';
  const ogDesc = (r.rawBody.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
    || r.rawBody.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || [])[1] || '';
  const title = String(og || r.title || '').trim();
  if (!title) throw new Error('这个页面里连标题都没找着');
  return {
    site: hostSite(new URL(r.url).hostname),
    url: r.url,
    title,
    author: '',
    duration: 0,
    desc: String(ogDesc || '').replace(/\s+/g, ' ').trim(),
    dynamic: '',
    publishedAt: '',
    stats: { view: 0, like: 0, reply: 0, danmaku: 0 },
    cover: '',
    pages: [],
    chapters: [],
    tags: [],
    subtitle: null,
    danmaku: null,
    comments: [],
    frames: [],
    materials: ['标题'].concat(ogDesc ? ['简介'] : []),
    missing: ['字幕', '弹幕', '热评']
  };
}

// ── 关键帧（真的"看"一眼画面）──────────────────────────────────────────

/**
 * 抽 N 帧画面 → 视觉模型描述。
 *
 * 只在显式要求时做（config.video.keyframes 或工具传 keyframes:true）：
 * 要先下整个视频，群友随手一个链接就可能拖进来几百 MB，所以默认关。
 * 三道闸：时长上限、ffmpeg 存在、视觉模型配了 key —— 缺一个就明说缺什么，不静默跳过。
 */
export async function extractFrames(url, { duration = 0, count = 4, log = null, cookie = '' } = {}) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('本机没找到 ffmpeg，抽不了帧');
  const info = qwenVisionInfo();
  if (!info?.hasKey) throw new Error('没配视觉模型（设置 → 模型 API → 识图模式），看不了画面');

  fs.mkdirSync(FRAME_DIR, { recursive: true });
  const stem = 'vframe-' + Date.now();
  const dl = await ytdlpDownload(url, {
    dir: FRAME_DIR,
    stem,
    log,
    cookie,
    // 只要画面：清晰度够认内容就行。⚠️ 必须 worstvideo —— 只写 worst 会挑到纯音轨
    // （B站音视频是分开的流），下完 ffmpeg 抽帧直接报 "Requested format is not available"。
    format: 'worstvideo[height<=480]/worstvideo/worst[height<=480]/worst'
  });
  const file = dl?.file;
  if (!file || !fs.existsSync(file)) throw new Error('视频没下载下来，抽不了帧');

  const dur = Number(duration) > 0 ? Number(duration) : 0;
  const n = clamp(count, 1, 6);
  const shots = [];
  try {
    for (let i = 0; i < n; i++) {
      // 均匀分布，但躲开片头（前 3%）和片尾（后 3%）—— 那里通常是黑屏和 UP 主 logo
      const at = dur > 0 ? dur * (0.03 + 0.94 * (i / Math.max(1, n - 1 || 1))) : 0;
      const out = path.join(FRAME_DIR, `${stem}-${i}.jpg`);
      const args = ['-y', '-hide_banner', '-v', 'error'];
      if (at > 0) args.push('-ss', String(Math.round(at)));
      args.push('-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out);
      const r = await runProc(ff, args, { timeoutMs: 60000 });
      if (r.code === 0 && fs.existsSync(out)) shots.push({ at: Math.round(at), file: out });
    }
  } finally {
    try { fs.unlinkSync(file); } catch { /* 临时视频删不掉无所谓 */ }
  }
  if (!shots.length) throw new Error('一帧都没抽出来');

  const dataUrls = shots.map((s) => {
    const buf = fs.readFileSync(s.file);
    return { at: s.at, url: `data:image/jpeg;base64,${buf.toString('base64')}` };
  });
  for (const s of shots) {
    try { fs.unlinkSync(s.file); } catch { /* ignore */ }
  }
  const prompt = `这是同一个视频里按时间顺序抽出的 ${dataUrls.length} 个画面（时间点分别约 ${dataUrls.map((d) => mmss(d.at)).join('、')}）。`
    + '请分别描述每个画面里**看得清**的内容：场景、人物/物体、画面上的文字。'
    + '看不清就写"看不清"，绝不许编造。最后用一句话总结这个视频大概在拍什么。';
  // 视觉接口回的是 { text, model, usage, latencyMs }，不是字符串
  const r = await analyzeWithQwenVision({ dataUrls: dataUrls.map((d) => d.url), prompt, timeoutMs: 90000 });
  return { count: dataUrls.length, text: String(r?.text || '').trim() };
}

// ── 材料 → 文本 ────────────────────────────────────────────────────────

/**
 * 把抓到的材料压成一段给模型读的文本。
 * 顺序 = 信息密度：标题/UP主 → 章节 → 字幕 → 弹幕 → 热评 → 简介。
 * 每段有自己的上限，总长度再按 maxChars 硬裁 —— 长视频的弹幕能上万条，不裁就是爆 token。
 */
export function buildDigest(intel, { maxChars = 6000 } = {}) {
  const lines = [];
  const push = (s) => { if (s) lines.push(s); };

  push(`【视频】${intel.title || '（没拿到标题）'}`);
  const head = [];
  if (intel.author) head.push(`UP主/作者：${intel.author}`);
  if (intel.duration) head.push(`时长：${mmss(intel.duration)}`);
  if (intel.site) head.push(`站点：${intel.site}`);
  if (intel.publishedAt) head.push(`发布：${intel.publishedAt}`);
  if (intel.stats?.view) head.push(`播放：${intel.stats.view}`);
  if (head.length) push(head.join(' ｜ '));

  if (intel.chapters?.length) {
    push('\n【章节】');
    for (const c of intel.chapters.slice(0, 20)) {
      push(`  ${mmss(c.from)} ${c.title}${c.to ? `（到 ${mmss(c.to)}）` : ''}`);
    }
  }
  if (intel.pages?.length) {
    push('\n【分P】' + intel.pages.slice(0, 20).map((p) => `${p.no}. ${p.title}`).join('；'));
  }
  if (intel.tags?.length) push('\n【标签】' + intel.tags.join('、'));

  if (intel.subtitle?.text) {
    const cap = Math.max(400, Math.round(maxChars * 0.5));
    const t = intel.subtitle.text.replace(/\s+/g, ' ').trim();
    push(`\n【${intel.subtitle.lang || '字幕'}摘录】\n  ` + (t.length > cap ? t.slice(0, cap) + '…（字幕太长，已截断）' : t));
  }
  if (intel.danmaku) {
    if (intel.danmaku.timeline?.length) {
      push('\n【弹幕按时间】');
      for (const x of intel.danmaku.timeline) push(`  ${mmss(x.at)} ${x.text}`);
    }
    if (intel.danmaku.top?.length) {
      push('\n【弹幕高频】' + intel.danmaku.top.map((x) => `${x.text}（${x.n}）`).join('、'));
    }
  }
  if (intel.comments?.length) {
    push('\n【热评】');
    for (const c of intel.comments.slice(0, 10)) push(`  - ${c}`);
  }
  if (intel.frames?.text) push('\n【画面（关键帧描述）】\n  ' + intel.frames.text.replace(/\s+/g, ' ').trim());
  if (intel.desc) {
    const cap = 400;
    const t = intel.desc.replace(/\s+/g, ' ').trim();
    push('\n【简介】' + (t.length > cap ? t.slice(0, cap) + '…' : t));
  }
  if (intel.dynamic && intel.dynamic !== intel.desc) {
    push('\n【UP主置顶】' + intel.dynamic.slice(0, 200));
  }
  if (intel.missing?.length) {
    push(`\n【没拿到的材料】${intel.missing.join('、')} —— 这些部分不要猜。`);
  }

  let text = lines.join('\n').trim();
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（材料过长已截断）';
  return text;
}

// ── 总结 ───────────────────────────────────────────────────────────────

const SUMMARY_SYSTEM = [
  '你是群里的视频课代表：群友甩一个视频链接，你负责说清它大概讲了什么。',
  '四条规矩：',
  '1. 只依据给定材料。材料里没有的，不许脑补；材料只有标题/简介时，必须明说"只看得到标题和简介，具体内容我不确定"。',
  '2. 说人话，3~5 句，像跟朋友转述，不要列小标题、不要写"综上所述"、不要复述链接。',
  '3. 有章节/时间点时，顺手提一句"大概几分几秒那里在讲什么"——这对"要不要点开看"最有用。',
  '4. 弹幕/热评只用来判断氛围和笑点，不要当成视频内容。'
].join('\n');

export async function summarizeIntel(intel, { personaName = '', focus = '', maxChars = 6000, summaryMaxChars = 400, log = null, timeoutMs = 60000 } = {}) {
  const digest = buildDigest(intel, { maxChars });
  const sys = personaName
    ? `${SUMMARY_SYSTEM}\n\n你是${personaName}，用你自己平时说话的语气讲，但信息必须准。`
    : SUMMARY_SYSTEM;

  // ⚠️ max_tokens 要留够：推理模型的**思考过程也占这个额度**（实测 DeepSeek 一条
  // 6000 字的材料，光思考就用掉几百 token，只给 400 就会"思考完就没额度了" →
  // 返回 content 为空。看起来像"模型拒答"，其实是自己把输出掐了）。
  const ask = async (body, tokens) => {
    const r = await chatCompletion({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: body }],
      temperature: 0.4,
      maxTokens: tokens,
      signal: AbortSignal.timeout(timeoutMs)
    });
    return String(r?.message?.content || '').trim();
  };

  const tail = focus ? `\n\n另外：${focus}` : '';
  const tokens = Math.max(800, Math.round(summaryMaxChars * 1.5) + 400);
  let text = '';
  try {
    text = await ask(digest + tail, tokens);
  } catch (e) {
    if (log) log(`[视频] 总结第一次没成：${e?.message || e}`);
  }
  if (!text) {
    // 退一步：材料砍掉一半再问一次。材料少一点，总比"我看不了"强。
    try {
      text = await ask(digest.slice(0, Math.round(maxChars / 3)) + tail, Math.max(600, tokens));
    } catch (e) {
      throw new Error(String(e?.message || e));
    }
  }
  if (!text) throw new Error('模型没给出总结（可能额度被思考用完了）');
  return { text, digest };
}

// ── 缓存 ───────────────────────────────────────────────────────────────

export function readVideoCache() {
  const j = readJsonSafe(CACHE_FILE, {});
  return j && typeof j === 'object' ? j : {};
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    writeJsonAtomic(CACHE_FILE, data);
  } catch (e) {
    // 缓存写失败不能让"看视频"整体失败 —— 最多是下次重新抓一遍
    console.warn(`[视频] 缓存写入失败：${e?.message ?? e}`);
  }
}

function cacheGet(url, cfg) {
  if (!cfg.cacheHours) return null;
  const key = normalizeVideoUrl(url);
  const hit = readVideoCache()[key];
  if (!hit?.summary) return null;
  if (Date.now() - Number(hit.at || 0) > cfg.cacheHours * 3600000) return null;
  return hit;
}

/**
 * 写缓存。传数组可以同时挂在多个键上 —— 短链和它还原后的长链是同一个视频，
 * 只存一个的话，下次从短链进来会永远 miss（每次都重新抓一遍）。
 */
function cachePut(urls, payload) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list.length) return;
  const data = readVideoCache();
  const keys = Object.keys(data);
  if (keys.length > 200) {
    // 按时间淘汰最老的一半：缓存是"别重复抓"，不是存档
    for (const k of keys.sort((a, b) => (data[a]?.at || 0) - (data[b]?.at || 0)).slice(0, Math.floor(keys.length / 2))) {
      delete data[k];
    }
  }
  for (const u of list) data[normalizeVideoUrl(u)] = { at: Date.now(), ...payload };
  writeCache(data);
}

// ── 抓材料（总入口的下半段，单独导出便于自检/控制台只看材料不总结）──────

/**
 * 抓一个视频的全部材料（不调模型）。
 * 站点顺序：B站官方 API → yt-dlp → 页面 og 兜底，每步失败都记进 intel.missing。
 */
export async function fetchIntel(url, { log = null, cfg = null, keyframes = null, timeoutMs = null } = {}) {
  const conf = cfg || videoConfig();
  const startedAt = Date.now();
  // 整体截止时刻：抓不到就抓不到，群里一句话等两分钟比"没看懂"更糟。
  const deadlineAt = timeoutMs ? startedAt + Math.max(3000, timeoutMs) : 0;
  const outOfTime = () => deadlineAt && Date.now() > deadlineAt;
  const left = () => (deadlineAt ? Math.max(3000, deadlineAt - Date.now()) : 0);
  let target = String(url || '').trim();
  if (!target) throw new Error('没给链接');

  // 短链先还原（b23.tv / youtu.be / v.douyin.com…），否则后面认不出站点
  try {
    if (SHORT_HOSTS.test(new URL(target).hostname)) {
      const { safeFetch } = await import('./safe-fetch.js');
      const r = await safeFetch(target, { maxChars: 2000 });
      if (r?.url) target = r.url;
    }
  } catch { /* 认不出就当普通链接继续 */ }

  const errors = [];
  const host = (() => {
    try { return new URL(target).hostname.toLowerCase(); } catch { return ''; }
  })();
  const isBili = /bilibili\.com|b23\.tv|bili2233\.cn/.test(host);

  let intel = null;
  if (isBili) {
    try {
      intel = await intelBilibili(target, { log, cfg: conf, timeoutMs: left() || undefined });
    } catch (e) {
      errors.push(`B站接口：${e?.message || e}`);
    }
  }
  if (!intel && !outOfTime()) {
    try {
      const cookie = isBili ? await biliCookie().catch(() => '') : '';
      intel = await intelYtdlp(target, { log, cookie, timeoutMs: left() || undefined });
    } catch (e) {
      errors.push(`yt-dlp：${e?.message || e}`);
    }
  }
  if (!intel && !outOfTime()) {
    try {
      intel = await intelFromPage(target, { log, timeoutMs: left() || undefined });
    } catch (e) {
      errors.push(`页面：${e?.message || e}`);
    }
  }
  if (!intel) {
    const why = outOfTime() ? `超过 ${Math.round((Date.now() - startedAt) / 1000)} 秒还没抓到` : errors.join('；');
    throw new Error(`这个视频看不了：${why.slice(0, 240)}`);
  }

  // 关键帧：默认关，但调用方可以显式要求"真看一眼画面"
  const wantFrames = keyframes === true || (keyframes === null && conf.keyframes);
  if (wantFrames) {
    if (intel.duration && intel.duration > conf.maxFrameDurationSec) {
      intel.missing.push(`画面（视频 ${mmss(intel.duration)} 超过上限 ${mmss(conf.maxFrameDurationSec)}，没抽帧）`);
    } else {
      try {
        intel.frames = await extractFrames(target, {
          duration: intel.duration,
          count: conf.frameCount,
          log,
          cookie: isBili ? await biliCookie().catch(() => '') : ''
        });
        intel.materials.push('画面');
      } catch (e) {
        intel.missing.push(`画面（${String(e?.message || e).slice(0, 60)}）`);
      }
    }
  }
  if (timeoutMs && Date.now() - startedAt > timeoutMs) {
    // 超时不抛：材料已经抓到了，后面总结那步自己会更快（或退回材料摘要）
    intel.missing.push('部分材料（整体超时）');
  }
  return intel;
}

// ── 总入口 ─────────────────────────────────────────────────────────────

/**
 * 看一个视频：抓材料 → 让模型说人话。
 *
 * @returns {Promise<{ok:boolean, text:string, title:string, site:string, duration:number,
 *                    materials:string[], missing:string[], fromCache:boolean, error?:string}>}
 * 失败**不抛**，返回 ok:false + 人话原因 —— 调用方（入站自动看 / 工具）都要能直接把 error 说出去。
 */
export async function watchVideo(url, { log = null, personaName = '', focus = '', keyframes = null, timeoutMs = null, cfg = null } = {}) {
  const conf = cfg || videoConfig();
  const startedAt = Date.now();
  const deadline = timeoutMs || conf.timeoutMs;
  let target = String(url || '').trim();
  if (!target) return { ok: false, text: '', error: '没给链接' };

  const cached = cacheGet(target, conf);
  if (cached) {
    return {
      ok: true,
      text: cached.summary,
      title: cached.title || '',
      site: cached.site || '',
      duration: Number(cached.duration) || 0,
      materials: cached.materials || [],
      missing: cached.missing || [],
      fromCache: true
    };
  }

  let intel = null;
  try {
    // 抓取最多占六成预算：剩下的留给模型总结（材料抓到了却没额度总结，等于白抓）
    intel = await fetchIntel(target, { log, cfg: conf, keyframes, timeoutMs: Math.round(deadline * 0.6) });
  } catch (e) {
    return { ok: false, text: '', error: String(e?.message || e).slice(0, 240) };
  }

  let summary = '';
  let digest = '';
  let summaryError = '';
  try {
    const r = await summarizeIntel(intel, {
      personaName, focus,
      maxChars: conf.maxChars,
      summaryMaxChars: conf.summaryMaxChars,
      log,
      timeoutMs: Math.max(15000, deadline - (Date.now() - startedAt))
    });
    summary = r.text;
    digest = r.digest;
  } catch (e) {
    summaryError = String(e?.message || e);
  }
  if (!summary) {
    // 模型这一步挂了，材料还在 —— 退回"材料摘要"，总比"我看不了"强。
    // 但必须说清这是材料不是总结，免得它看起来像一段正经总结。
    digest = digest || buildDigest(intel, { maxChars: conf.maxChars });
    summary = `（没能让模型总结：${summaryError.slice(0, 80)}）\n${digest.slice(0, 1200)}`;
  } else {
    cachePut([target, intel.url], {
      summary,
      title: intel.title,
      site: intel.site,
      duration: intel.duration,
      materials: intel.materials,
      missing: intel.missing
    });
  }

  return {
    ok: true,
    text: summary,
    title: intel.title,
    site: intel.site,
    duration: intel.duration,
    materials: intel.materials,
    missing: intel.missing,
    fromCache: false
  };
}

/** 给工具/提示词用的一句话说明（能看哪些站、看到什么程度）。 */
export function videoSupportSummary() {
  return 'B站链接能拿到标题/简介/章节/弹幕/热评（AI字幕要登录，匿名拿不到）；YouTube/抖音等靠 yt-dlp 取标题简介和字幕；必要时可以抽几帧画面真看一眼';
}
