// 梗百科（移植自 AstrBot 插件 astrbot_plugin_memewiki，MIT，作者 in1t1a1）
//
// 一句话：**离线 6668 条词库打底，查不到才联网**。
// 它解决的是「模型遇到新梗会硬猜」这件事 —— 猜错的梗它下一轮会用得更自信。
//
// 和 memes.js 的分工（别混）：
//   · memes.js  = **这个群自己的梗**。候选/确认两级，人工点头才算数。
//   · 本文件    = **网上的梗**。全局、只读、公开词库，不需要谁批准。
// 查找顺序永远是：群梗 → 梗百科本地 → 梗百科在线 → 承认不懂。
//
// 三条铁律（都是上游真机踩出来的）：
//   1. **只认完整标题**：消息里必须出现完整标题，反过来（消息是标题的前缀）不算。
//      「你是什么」不该命中「你是什么冠军」—— 那是两条完全不同的梗。
//   2. **先接梗、别科普**：词条正文里「怎么用」排在最前面，出处往后放且标注
//      「仅用于理解，别照搬」。顺序反了模型就会念百科。
//   3. **查不到就查不到**：宁可说不知道，也不许把两个不相干的梗拼一起。
//
// 本地词库是 `data/memewiki/wiki.json`（`node tools/build-meme-wiki.mjs` 生成），
// 只在**第一次查梗**时加载一次（约 9MB，100ms 级），之后常驻内存。
// 不做启动时加载：绝大多数会话从头到尾不问梗，白占 20MB 堆。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { safeFetch } from './safe-fetch.js';

export const DEFAULT_FILE = path.join(DATA_DIR, 'memewiki', 'wiki.json');
export const API_BASE = 'https://cnmeme.wiki/api/v1/public/memes';

/** 给模型看的截断上限：和 build-meme-wiki.mjs 的导出上限一致。 */
export const USAGE_MAX = 600;
export const ORIGIN_MAX = 450;
export const OTHER_MAX = 400;

/** 同一条查询的答案缓存多久（秒）。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
/** 联网「查过但没查到」的冷却：同一个词 10 分钟内不再联网。 */
const MISS_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // query → { at, text }
const missAt = new Map(); // query → 时间戳

let wikiCache = null; // { file, mtimeMs, wiki }

// ── 本地词库 ────────────────────────────────────────────────────────────

/**
 * 读本地词库（带 mtime 校验：重新导出后不用重启）。
 * 坏文件不抛错、不当场崩 —— 词库没了退化成「只有在线检索」，聊天不该因为这个停摆。
 */
export function loadWiki({ file = DEFAULT_FILE, reload = false } = {}) {
  if (!reload && wikiCache && wikiCache.file === file) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
    if (mtimeMs === wikiCache.mtimeMs) return wikiCache.wiki;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  try {
    const wiki = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(wiki?.items)) return null;
    // 建一次索引：从 6668 条里线性扫完整标题可以接受，但精确命中要 O(1)。
    const byTitle = new Map();
    const byLower = new Map();
    for (const item of wiki.items) {
      if (!item?.t || byTitle.has(item.t)) continue;
      byTitle.set(item.t, item);
      // 大小写只对「精确命中」和「包含命中」兜底：YYDS / yyds 是同一条梗，
      // 但 lowering 后做包含判断会把无关键误伤，所以两条索引分开用。
      const lower = item.t.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, item.t);
    }
    wikiCache = { file, mtimeMs, wiki: { ...wiki, byTitle, byLower } };
    return wikiCache.wiki;
  } catch (error) {
    console.warn(`[meme-wiki] 词库读取失败（${path.basename(file)}）：${error?.message ?? error}`);
    return null;
  }
}

/** 词库状态（给控制台/状态接口看，不碰网络）。 */
export function wikiStatus({ file = DEFAULT_FILE } = {}) {
  const wiki = loadWiki({ file });
  if (!wiki) return { available: false, count: 0, builtAt: '', file };
  return {
    available: true,
    count: Number(wiki.count) || wiki.items.length,
    builtAt: String(wiki.built_at ?? ''),
    source: String(wiki.source ?? ''),
    file
  };
}

/**
 * 只认完整标题。
 *
 * 顺序：先精确、再「消息里包含的最长标题」。
 * 反方向（查询是标题的前缀）**故意不算** —— 上游原话：
 * 「你是什么」不能命中「你是什么冠军」。
 */
export function matchTitle(query, wiki) {
  const q = String(query ?? '').trim();
  if (!q || !wiki?.byTitle) return null;
  if (wiki.byTitle.has(q)) return q;
  const lower = q.toLowerCase();
  if (wiki.byLower?.has(lower)) return wiki.byLower.get(lower);

  let best = null;
  for (const title of wiki.byTitle.keys()) {
    if (title.length < 2) continue;
    if (!q.includes(title)) continue;
    if (!best || title.length > best.length) best = title;
  }
  if (best) return best;

  // 大小写兜底：只在这一步把两边都 lowering。
  for (const title of wiki.byTitle.keys()) {
    if (title.length < 2) continue;
    if (!lower.includes(title.toLowerCase())) continue;
    if (!best || title.length > best.length) best = title;
  }
  return best;
}

function toEntry(item, { query = '', slug = '' } = {}) {
  const title = String(item?.t ?? '');
  const same = !query || title.trim() === String(query).trim();
  return {
    title,
    tags: Array.isArray(item?.g) ? item.g.slice(0, 8) : [],
    usage: String(item?.u ?? ''),
    origin: String(item?.o ?? ''),
    slug: slug || title,
    note: same ? '' : `（没有同名条目，这条标题是「${title}」）`
  };
}

/**
 * 查本地词库。毫秒级、不联网。
 * @returns {{title:string,tags:string[],usage:string,origin:string,slug:string,note:string}|null}
 */
export function lookupLocal(query, { file = DEFAULT_FILE } = {}) {
  const wiki = loadWiki({ file });
  if (!wiki) return null;
  const title = matchTitle(query, wiki);
  if (!title) return null;
  const item = wiki.byTitle.get(title);
  return item ? toEntry(item, { query }) : null;
}

// ── 正文处理 ────────────────────────────────────────────────────────────

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** content_html → 纯文本，小标题变成 `## ` 行（和上游同一套替换顺序）。 */
export function htmlToText(raw) {
  let s = String(raw ?? '');
  // 开闭标签都要处理：真实数据里 `</h2>` 后面常常紧跟 `<p>`（没有换行），
  // 只替换开标签会把小标题和正文粘成一行 —— 于是「用法」段整个错位到「其它」里。
  s = s.replace(/<h[2-4][^>]*>/gi, '\n## ');
  s = s.replace(/<\/h[2-4]>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/p>|<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&([a-z#0-9]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 按小标题把正文分成「怎么用 / 出处 / 其它」。
 * 判据用**包含**而不是相等：上游词条的小标题长得五花八门（用法/怎么用/接梗/来源/出处/背景…）。
 */
export function splitSections(text) {
  const parts = `\n${String(text ?? '')}`.split(/\n##\s*/);
  const usage = [];
  const origin = [];
  const other = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const rest = nl < 0 ? '' : part.slice(nl + 1).trim();
    if (/用法|怎么用|如何用|例句|接梗/.test(head)) usage.push(rest || head);
    else if (/来源|出处|背景|起源|介绍/.test(head)) origin.push(rest || head);
    else other.push(rest ? `${head}\n${rest}` : head);
  }
  return { usage: usage.join('\n').trim(), origin: origin.join('\n').trim(), other: other.join('\n').trim() };
}

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 给模型看的词条文本。
 *
 * **顺序是有讲究的**：怎么用 → 出处。上游实测，出处在前模型就会念百科。
 * 出处上还挂了「仅用于理解，别照搬」，因为模型看到「来源」两个字就忍不住复述。
 */
export function formatEntry(entry, { forLlm = true } = {}) {
  const lines = [`【梗百科】${entry.title}`];
  if (entry.note) lines.push(entry.note);
  if (entry.tags?.length) lines.push(`标签：${entry.tags.join('、')}`);
  const usageHead = '【怎么用 / 怎么接】';
  const originHead = '【出处（仅用于理解，别照搬）】';
  if (forLlm) {
    if (entry.usage) lines.push(`${usageHead}\n${clip(entry.usage, USAGE_MAX)}`);
    if (entry.origin) lines.push(`${originHead}\n${clip(entry.origin, ORIGIN_MAX)}`);
  } else {
    if (entry.origin) lines.push(`【来源】\n${clip(entry.origin, ORIGIN_MAX)}`);
    if (entry.usage) lines.push(`【用法】\n${clip(entry.usage, USAGE_MAX)}`);
  }
  if (entry.other) lines.push(clip(entry.other, OTHER_MAX));
  return lines.join('\n');
}

// ── 预查闸门 ────────────────────────────────────────────────────────────

/** 「杂鱼杂鱼」「666666」折叠成基词 —— 群里连刷同一个词时只联网一次。 */
export function normalizeQuery(query) {
  const q = String(query ?? '').trim().replace(/^[ ，,。.！!？?、~～]+|[ ，,。.！!？?、~～]+$/g, '');
  const n = q.length;
  if (n >= 4) {
    for (let size = Math.min(4, Math.floor(n / 2)); size >= 2; size -= 1) {
      if (n % size === 0 && q === q.slice(0, size).repeat(n / size)) return q.slice(0, size);
    }
  }
  return q;
}

const INTENT_WORDS = ['什么梗', '啥梗', '这梗', '那梗', '梗是', '出处', '什么来头', '啥意思', '什么意思', '谐音', '缩写', '黑话', '梗百科', '查一下梗'];
const CHAT_PHRASES = new Set(['你好', '在吗', '干嘛', '晚安', '早上好', '哈哈哈', '谢谢', '怎么了', '没事']);
const SENTENCE_WORDS = /[，,。！!？?；;：:]|吗$|呢$|吧$|了$|啊$/;
const PRONOUN_WORDS = ['你', '我', '他', '她', '它', '这', '那', '咱们', '大家'];
const LEAD_PRONOUNS = '我你他她它这那';
const LEAD_FUNCTION = '不没别请快都还就再又也';

/**
 * 本地没收录时，判断这条查询**值不值得联网**。
 *
 * 上游实测：27 次搜索里 22 次是「我是谁」「你今天怎么样」这类闲聊整句，
 * 每次白花 0.4–1.4 秒。所以只放行「明确在问梗」或「像词条的短词」。
 */
export function worthSearch(raw, query, { maxChars = 10 } = {}) {
  const text = String(raw ?? '').trim();
  if (INTENT_WORDS.some((k) => text.includes(k))) return true;
  const q = String(query ?? '').trim();
  const max = Math.max(2, Math.min(Number(maxChars) || 10, 20));
  if (!q || q.length > max) return false;
  if (CHAT_PHRASES.has(q)) return false;
  if (SENTENCE_WORDS.test(q)) return false;
  if (PRONOUN_WORDS.some((k) => q.includes(k))) return false;
  if (q.length >= 3 && LEAD_PRONOUNS.includes(q[0])) return false;
  if (q.length >= 4 && LEAD_FUNCTION.includes(q[0])) return false;
  return true;
}

// ── 在线兜底 ────────────────────────────────────────────────────────────

/**
 * 联网查词条（cnmeme.wiki 公开只读接口）。
 *
 * 两步：列表接口找到**标题最接近**的那条（优先精确同名），再取详情拿正文。
 * 全程 6 秒超时；任何异常都返回 null —— 查梗失败不该变成一轮对话的报错。
 *
 * @param {string} query
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts] fetchImpl 供测试注入
 */
export async function lookupOnline(query, { fetchImpl = null, timeoutMs = 6000 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const get = fetchImpl || (async (url) => {
    const r = await safeFetch(url, { maxChars: 200000 });
    return { status: r.statusCode, text: r.body };
  });

  const listUrl = `${API_BASE}?q=${encodeURIComponent(q)}&limit=5`;
  const list = await withTimeout(get, listUrl, timeoutMs);
  const items = Array.isArray(list?.items) ? list.items : [];
  if (!items.length) return null;

  const exact = items.find((it) => String(it?.title ?? '').trim() === q);
  const pick = exact || items[0];
  const slug = String(pick?.slug ?? pick?.title ?? '').trim();
  if (!slug) return null;

  const detail = await withTimeout(get, `${API_BASE}/${encodeURIComponent(slug)}`, timeoutMs);
  const item = detail?.item;
  if (item) {
    const body = htmlToText(item.content_html || '') || String(item.summary ?? '');
    const sections = splitSections(body);
    const usage = sections.usage || (sections.origin ? '' : body);
    return {
      title: String(item.title ?? q),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 8).map(String) : [],
      usage: clip(usage, USAGE_MAX),
      origin: clip(sections.origin, ORIGIN_MAX),
      other: clip(sections.other, OTHER_MAX),
      slug,
      note: ''
    };
  }

  // 详情挂了也别浪费：列表里的 summary 就是正文节选。
  return {
    title: String(pick.title ?? q),
    tags: Array.isArray(pick.tags) ? pick.tags.slice(0, 8).map(String) : [],
    usage: clip(pick.summary, USAGE_MAX),
    origin: '',
    other: '',
    slug,
    note: ''
  };
}

async function withTimeout(get, url, timeoutMs) {
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const data = await Promise.race([get(url), timeout]);
    if (!data) return null;
    if (typeof data === 'object' && data.__raw !== undefined) return JSON.parse(String(data.__raw));
    // safeFetch 包出来的是 { status, text }，测试注入的是对象 —— 两种都认。
    if (typeof data.text === 'string') {
      if (Number(data.status) && Number(data.status) !== 200) return null;
      return JSON.parse(data.text);
    }
    return data;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 对外主入口 ──────────────────────────────────────────────────────────

/**
 * 群梗之外的总查询：本地词库 → （值得的话）在线。
 *
 * @param {string} query
 * @param {{file?:string, online?:boolean, raw?:string, fetchImpl?:Function, now?:number}} [opts]
 *   `raw` 是这条消息原文，用于判断「值不值得联网」；不传就只查本地。
 * @returns {Promise<{found:boolean, tier:'wiki'|'online'|'', text:string, entry:object|null, cached?:boolean}>}
 */
export async function lookupMemeWiki(query, opts = {}) {
  const { file = DEFAULT_FILE, online = false, raw = '', fetchImpl = null, now = Date.now() } = opts;
  const q = String(query ?? '').trim();
  if (!q) return { found: false, tier: '', text: '', entry: null };

  const cached = cache.get(q);
  if (cached && cached.at + CACHE_TTL_MS > now) {
    return { found: true, tier: cached.tier, text: cached.text, entry: cached.entry, cached: true };
  }

  const local = lookupLocal(q, { file });
  if (local) {
    const text = formatEntry(local);
    remember(q, text, 'wiki', local, now);
    return { found: true, tier: 'wiki', text, entry: local };
  }

  if (!online) return { found: false, tier: '', text: '', entry: null };
  if (!worthSearch(raw || q, q)) return { found: false, tier: '', text: '', entry: null };
  const lastMiss = missAt.get(q) || 0;
  if (lastMiss && lastMiss + MISS_TTL_MS > now) return { found: false, tier: '', text: '', entry: null };

  const remote = await lookupOnline(q, { fetchImpl });
  if (!remote) {
    missAt.set(q, now);
    if (missAt.size > CACHE_MAX) {
      for (const [k, at] of missAt) if (at + MISS_TTL_MS <= now) missAt.delete(k);
    }
    return { found: false, tier: '', text: '', entry: null };
  }
  const text = formatEntry(remote);
  remember(q, text, 'online', remote, now);
  return { found: true, tier: 'online', text, entry: remote };
}

function remember(query, text, tier, entry, now) {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(query, { at: now, text, tier, entry });
}

/** 测试用：清掉内存缓存/词库缓存。 */
export function _resetForTest() {
  cache.clear();
  missAt.clear();
  wikiCache = null;
}

/**
 * 只读文件前 N 个字节（不是"整份读进来再截断" —— 那是 9MB 的一次无谓 IO）。
 */
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 轻量状态：**不加载词库**，只 stat + 读文件头几十个字节。
 *
 * 为什么单独做这个：/api/status 会被面板每隔几秒轮询一次，
 * 为了显示"词库有没有装好"而每次把 9MB JSON 解析一遍是把懒加载白做了。
 * 元信息（built_at/count）就写在文件开头，读 512 字节足够。
 */
export function wikiStatusLite({ file = DEFAULT_FILE } = {}) {
  try {
    const st = fs.statSync(file);
    const head = readHead(file, 512);
    const builtAt = head.match(/"built_at"\s*:\s*"([^"]*)"/)?.[1] ?? '';
    const count = Number(head.match(/"count"\s*:\s*(\d+)/)?.[1] ?? 0);
    return { available: true, count, builtAt, sizeMB: Number((st.size / 1024 / 1024).toFixed(2)), loaded: !!wikiCache };
  } catch {
    return { available: false, count: 0, builtAt: '', sizeMB: 0, loaded: !!wikiCache };
  }
}
