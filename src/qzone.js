// QQ 空间说说（NapCat 扩展接口 /send_qzone_msg）：把她的日记发到自己的空间。
//
// 为什么要走协议端、不自己拼 Cookie：
//   直接拿 skey/p_skey 打 web 接口，既要做 g_tk 签名，又容易触发风控、掉登录态；
//   NapCat 本来就握着登录态，/send_qzone_msg 是它自己的扩展能力，失败时还会回人话。
//
// 三条铁律：
//   1. **只发已经落盘的日记**（data/diary/<会话>/<日期>.md）：日记是素材，发布不二次创作。
//   2. **默认只给自己看**（ugc_right=64）：日记里全是群友说过的话，公开发布就是隐私事故。
//      想公开得自己到控制台把 qzone.ugcRight 改成 1，改之前请先想清楚。
//   3. **发过就记账**（data/qzone-posts.json）：同一天同一篇不重复发，手滑点两次也不会刷屏。
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';
import { readEntry, readPublicEntry } from './diary.js';
import { todayKey } from './util.js';

const RECORD_FILE = path.join(DATA_DIR, 'qzone-posts.json');
const MAX_RECORDS = 300;

/** 可见范围：数字是 NapCat /send_qzone_msg 的 ugc_right 取值。 */
export const UGC_RIGHTS = [
  { value: 1, label: '所有人可见' },
  { value: 4, label: '好友可见' },
  { value: 64, label: '仅自己可见' }
];
const UGC_VALUES = new Set(UGC_RIGHTS.map((x) => x.value));

/** 只认 1/4/64；其它值（含 16/128 这种要带名单的）一律退回「仅自己可见」。 */
export function normalizeUgcRight(value, fallback = 64) {
  const n = Number(value);
  if (UGC_VALUES.has(n)) return n;
  const f = Number(fallback);
  return UGC_VALUES.has(f) ? f : 64;
}

export function ugcRightLabel(value) {
  const n = normalizeUgcRight(value);
  return UGC_RIGHTS.find((x) => x.value === n)?.label || `权限 ${n}`;
}

// ── 发布记录 ───────────────────────────────────────────────────────────────

function readRecords() {
  const data = readJsonSafe(RECORD_FILE, { posts: [] });
  const posts = Array.isArray(data?.posts) ? data.posts.filter((p) => p && p.tid) : [];
  return { posts };
}

function writeRecords(records) {
  const posts = (records.posts || [])
    .filter((p) => p && p.tid)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_RECORDS);
  writeJsonAtomic(RECORD_FILE, { posts });
}

export function listPosts({ limit = 50 } = {}) {
  return readRecords().posts.slice(0, Math.max(1, Number(limit) || 50));
}

/** 某一天发过几条（配额靠它算）。 */
export function countPostsOn(date) {
  const d = String(date || '');
  return readRecords().posts.filter((p) => p.date === d).length;
}

export function findPost(chatKey, date) {
  return readRecords().posts.find((p) => p.chatKey === chatKey && p.date === date) || null;
}

export function recordPost(post) {
  if (!post?.tid) return null;
  const records = readRecords();
  records.posts = records.posts.filter((p) => p.tid !== post.tid && !(p.chatKey === post.chatKey && p.date === post.date));
  records.posts.unshift({ ...post, at: Number(post.at) || Date.now() });
  writeRecords(records);
  return records.posts[0];
}

/** 说说被删掉之后清账，否则这一天永远显示「已发过」。 */
export function forgetPost(tid) {
  const records = readRecords();
  const before = records.posts.length;
  records.posts = records.posts.filter((p) => p.tid !== String(tid));
  if (records.posts.length !== before) writeRecords(records);
  return before - records.posts.length;
}

// ── 文本整形 ───────────────────────────────────────────────────────────────

/**
 * 兜底脱敏。真脱敏靠 diary.js 在生成时产出的「可发布版」，
 * 这里只兜住模型没照做的那几种明显泄露：邮箱、手机号、@QQ号、群号。
 */
export function redactForQzone(text) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, '***')
    .replace(/\b1[3-9]\d{9}\b/g, '***')
    .replace(/@\s*\d{5,12}/g, '一个群友')
    .replace(/(?:QQ|qq)\s*(?:号)?\s*[:：]?\s*\d{5,12}/g, '某个人')
    .replace(/(?:群号|群)\s*[:：]?\s*\d{5,12}/g, '某个群');
}

/** 说说只能发纯文本：把模型偶尔留下的 Markdown 痕迹抹掉。 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按字数截断，尽量停在句末（说说不该出现半句话）。 */
export function clampText(text, maxChars) {
  const s = String(text ?? '');
  const max = Math.max(40, Number(maxChars) || 900);
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('\n'), head.lastIndexOf('…')
  );
  return (cut > max * 0.6 ? head.slice(0, cut + 1) : head).replace(/[\s，、；：,;:]+$/, '') + '…';
}

/**
 * 把一篇日记渲染成说说正文。
 * preferPublic=true 时优先用「可发布版」（生成时就脱敏过），没有才退回原文 + 正则兜底。
 */
export function renderPostText(entry, { maxChars = 900, includeTitle = true, preferPublic = false } = {}) {
  if (!entry) return '';
  const usePublic = preferPublic && entry.publicBody;
  const title = stripMarkdown(entry.title || '');
  const body = stripMarkdown(usePublic ? entry.publicBody : entry.body);
  if (!body) return '';
  const head = includeTitle && title ? `【${redactForQzone(title)}】` : '';
  const text = head ? `${head}\n${body}` : body;
  return clampText(redactForQzone(text), maxChars);
}

// ── 发布 ───────────────────────────────────────────────────────────────────

/**
 * 发一条说说。返回 {ok, tid} 或 {ok:false, reason, error}。
 * reason 是给界面看的一句话，不是堆栈。
 */
export async function publishToQzone({ onebot, content, ugcRight = 64, images = [], log = () => {} } = {}) {
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (!onebot || typeof onebot.call !== 'function') return { ok: false, reason: 'no-onebot' };
  const params = { content: text, ugc_right: normalizeUgcRight(ugcRight), images: [], target_uins: [] };
  const pics = (Array.isArray(images) ? images : []).filter((x) => /^https?:\/\//i.test(String(x))).slice(0, 9);
  if (pics.length) params.images = pics;
  try {
    const data = await onebot.call('send_qzone_msg', params, 30000);
    const tid = String(data?.tid || data?.data?.tid || '');
    if (!tid) {
      // 传输和业务都成功、但没有 tid：结果不确定，不能报成功也不能自动重发
      return { ok: false, reason: 'uncertain', error: '接口没有返回说说 tid，无法确认是否已发布' };
    }
    log(`[qzone] 已发说说 tid=${tid}（${ugcRightLabel(params.ugc_right)}）`);
    return { ok: true, tid };
  } catch (error) {
    const code = error?.code || '';
    if (code === 'EPLATFORM_UNSUPPORTED') {
      return { ok: false, reason: 'unsupported', error: '当前 NapCat 没有 /send_qzone_msg 接口，请升级 NapCat' };
    }
    if (error?.uncertain) {
      return { ok: false, reason: 'uncertain', error: String(error?.message || error) };
    }
    log(`[qzone] 发布失败：${error?.message ?? error}`);
    return { ok: false, reason: 'failed', error: String(error?.message ?? error) };
  }
}

/**
 * 把某个会话某一天的日记发到空间（幂等）。
 * 已发过就返回 already（force 才重发），配额由调用方先算。
 */
export async function publishDiary({
  onebot, chatKey, date, cfg = {}, force = false, log = () => {}
} = {}) {
  const d = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, reason: 'bad-date' };
  const entry = readEntry(chatKey, d);
  if (!entry) return { ok: false, reason: 'no-entry', date: d };
  const prev = findPost(chatKey, d);
  if (prev && !force) return { ok: false, reason: 'already', date: d, tid: prev.tid };

  const publicEntry = readPublicEntry(chatKey, d);
  const preferPublic = cfg.publicSafe !== false;
  const content = renderPostText(
    { ...entry, publicBody: publicEntry?.body || '' },
    { maxChars: Number(cfg.maxChars) || 900, includeTitle: cfg.includeTitle !== false, preferPublic }
  );
  if (content.length < 10) return { ok: false, reason: 'empty', date: d };

  const r = await publishToQzone({
    onebot, content, ugcRight: cfg.ugcRight, images: cfg.images, log
  });
  if (!r.ok) return { ...r, date: d };
  recordPost({
    tid: r.tid, chatKey, date: d,
    title: entry.title || '', chars: content.length,
    ugcRight: normalizeUgcRight(cfg.ugcRight), account: onebot?.selfId ? String(onebot.selfId) : ''
  });
  return { ok: true, date: d, tid: r.tid, chars: content.length, content };
}

/** 今天还能发几条（qzone.maxPerDay=0 时不限）。 */
export function remainingQuota(cfg = {}, date = todayKey()) {
  const max = Number(cfg.maxPerDay);
  if (!Number.isFinite(max) || max <= 0) return Infinity;
  return Math.max(0, Math.floor(max) - countPostsOn(date));
}
