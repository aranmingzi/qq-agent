// 群梗库：查询 + 候选/确认两级写入。
//
// 为什么要有两级（学自 Estrella 社区包 gm-meme-archive）：
//   梗这种东西，"有人提一句"和"它真是个梗"是两件事。群友随口一句谐音、
//   某个词的临场用法，模型听一耳朵就当已知事实用，下次就会在别的群里
//   一本正经地用错的梗 —— 而且它会把这个错误越用越自信。
//
// 所以纪律只有一条，别绕：
//   **候选池（data/memes-pending.json）永远不进提示词、永远不被 search 命中。**
//   只有确认过的（data/memes.json）才算"它知道"。没确认的，就当没听过。
//
// 谁能做什么：
//   · 模型：只能 proposeMeme()（提候选，不许自己转正）
//   · 人（控制台/令牌 API/slash 命令）：confirmMeme() / rejectMeme()
//   · 被拒的进 rejected 名单，之后同一个梗再提直接挡掉（否则它会反复烦人）

import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

const DEFAULT_FILE = path.join(DATA_DIR, 'memes.json');
const DEFAULT_PENDING_FILE = path.join(DATA_DIR, 'memes-pending.json');

/** 候选池上限。满了之后拒绝新提案（不是丢最旧的：丢最旧的会让它不停重提）。 */
export const PENDING_MAX = 50;

/** 被拒名单上限（只留最近这些，防文件无限长）。 */
const REJECTED_MAX = 100;

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

// 读：坏文件会被改名留档（data/memes.json.corrupt-<时间戳>）再当空库，
// 不是静默清零 —— 15 条人工梗被一条坏 JSON 抹掉是不可接受的。
function readJson(file, fallback) {
  return readJsonSafe(file, fallback, { tag: 'memes' });
}

/** 原子写：先写 .tmp 再 rename，避免进程被杀时留下半个 JSON。 */
function writeJson(file, data) {
  writeJsonAtomic(file, data);
}

function loadEntries(file) {
  const data = readJson(file, null);
  return Array.isArray(data?.memes) ? data.memes : [];
}

function scoreEntry(entry, query) {
  const q = normalize(query);
  if (!q) return 0;
  const key = normalize(entry.key);
  const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(normalize) : [];
  const tags = Array.isArray(entry.tags) ? entry.tags.map(normalize) : [];
  if (key === q || aliases.includes(q)) return 100;
  if (aliases.some((a) => a.includes(q) || q.includes(a))) return 80;
  if (key.includes(q) || q.includes(key)) return 70;
  if (tags.some((tag) => tag.includes(q) || q.includes(tag))) return 50;
  const haystack = [entry.meaning, entry.usage, entry.tone].map(normalize).join('|');
  return haystack.includes(q) ? 20 : 0;
}

function cleanEntry(entry) {
  return {
    key: String(entry.key || '').slice(0, 40),
    aliases: Array.isArray(entry.aliases) ? entry.aliases.map((x) => String(x).slice(0, 40)).slice(0, 8) : [],
    meaning: String(entry.meaning || '').slice(0, 300),
    usage: String(entry.usage || '').slice(0, 300),
    tone: String(entry.tone || '').slice(0, 40),
    tags: Array.isArray(entry.tags) ? entry.tags.map((x) => String(x).slice(0, 30)).slice(0, 10) : []
  };
}

/**
 * 查梗。**只读已确认的库** —— 候选池不在这里出现，这是本文件的立身之本。
 * @returns {{query:string, results:Array, found:boolean}}
 */
export function searchMemes(keyword, { file = DEFAULT_FILE, limit = 5 } = {}) {
  const query = String(keyword || '').trim();
  if (!query) return { query, results: [], found: false };
  const results = loadEntries(file)
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(5, Number(limit) || 5)))
    .map((item) => cleanEntry(item.entry));
  return { query, results, found: results.length > 0 };
}

// ── 候选池 ───────────────────────────────────────────────────────────────

function loadPending(file) {
  const data = readJson(file, null);
  return {
    pending: Array.isArray(data?.pending) ? data.pending : [],
    rejected: Array.isArray(data?.rejected) ? data.rejected : []
  };
}

/** 两个梗是不是"同一个"（key 或任一别名撞上）。 */
function sameMeme(a, b) {
  const keysOf = (x) => [x?.key, ...(Array.isArray(x?.aliases) ? x.aliases : [])]
    .map(normalize).filter(Boolean);
  const ka = keysOf(a);
  const kb = keysOf(b);
  return ka.some((x) => kb.includes(x));
}

/**
 * 提一个候选梗。模型唯一的写入口。
 *
 * 拒绝的情况都带一句为什么（模型会读到，能自己收敛）：
 *   · 已经收录过 → 直接告诉它"这个梗已经在库里了，正常用就行"
 *   · 被拒过 → "有人判断过这个不算梗，别再提"
 *   · 池子满了 → "候选池满了，等人清一清"
 *
 * @returns {{ok:boolean, status:'pending'|'duplicate'|'rejected-before'|'full'|'bad', reason:string, entry?:object}}
 */
export function proposeMeme(
  { key = '', meaning = '', usage = '', aliases = [], tone = '', tags = [], source = '', chatKey = '' } = {},
  { file = DEFAULT_PENDING_FILE, memeFile = DEFAULT_FILE, now = Date.now() } = {}
) {
  const k = String(key || '').trim().slice(0, 40);
  if (!k) return { ok: false, status: 'bad', reason: '梗词不能为空' };
  const m = String(meaning || '').trim().slice(0, 300);
  if (!m) return { ok: false, status: 'bad', reason: '至少要说清它是什么意思，否则记下来也没用' };

  const candidate = cleanEntry({ key: k, meaning: m, usage, aliases, tone, tags });

  // ① 已经确认过的，不必再提
  if (loadEntries(memeFile).some((e) => sameMeme(e, candidate))) {
    return { ok: false, status: 'duplicate', reason: `「${k}」已经在梗库里了，正常用就行，不用再提` };
  }

  const pool = loadPending(file);

  // ② 被拒过的不再收（否则它会记住又忘、忘了又提）
  if (pool.rejected.some((e) => sameMeme(e, candidate))) {
    return { ok: false, status: 'rejected-before', reason: `「${k}」之前被判定过不是梗，别再提了` };
  }

  // ③ 池子里已有 → 只累计出现次数（同一个梗被三个人说，是"更像梗"的证据）
  const exist = pool.pending.find((e) => sameMeme(e, candidate));
  if (exist) {
    exist.hits = Math.max(1, Number(exist.hits) || 1) + 1;
    exist.lastSeenAt = now;
    if (source && !exist.source) exist.source = String(source).slice(0, 120);
    writeJson(file, pool);
    return {
      ok: true,
      status: 'pending',
      reason: `「${k}」之前已经提过一次了，这次记到第 ${exist.hits} 次`,
      entry: exist
    };
  }

  // ④ 池子满了：拒绝，不淘汰旧的（淘汰会让它重新提，变成拉锯）
  if (pool.pending.length >= PENDING_MAX) {
    return { ok: false, status: 'full', reason: `候选已经攒了 ${pool.pending.length} 条没人看，先别加了` };
  }

  const entry = {
    ...candidate,
    status: 'pending',
    hits: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    chatKey: String(chatKey || '').slice(0, 60),
    source: String(source || '').slice(0, 120)
  };
  pool.pending.push(entry);
  writeJson(file, pool);
  return {
    ok: true,
    status: 'pending',
    reason: '记成候选了。**这一轮别拿它当已知的梗用**，等人确认过才算数',
    entry
  };
}

/** 候选列表（给控制台/手机端看）。按最近出现排序。 */
export function listPending({ file = DEFAULT_PENDING_FILE } = {}) {
  const pool = loadPending(file);
  const list = [...pool.pending].sort((a, b) => (Number(b.lastSeenAt) || 0) - (Number(a.lastSeenAt) || 0));
  return { pending: list, rejectedCount: pool.rejected.length };
}

/**
 * 确认一个候选：进正式梗库。
 * @returns {{ok:boolean, reason:string, entry?:object}}
 */
export function confirmMeme(
  key,
  { file = DEFAULT_PENDING_FILE, memeFile = DEFAULT_FILE, now = Date.now(), patch = {} } = {}
) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, reason: '要确认哪个梗？' };
  const pool = loadPending(file);
  const idx = pool.pending.findIndex((e) => normalize(e.key) === normalize(k));
  if (idx < 0) return { ok: false, reason: `候选里没有「${k}」` };

  const src = pool.pending[idx];
  const entry = cleanEntry({
    ...src,
    ...patch,
    // 人确认时可以顺手改释义/用法；没改就用模型提的
  });
  if (!entry.key || !entry.meaning) return { ok: false, reason: '这条缺 key 或释义，没法入库' };

  const data = readJson(memeFile, null) || {};
  const memes = Array.isArray(data.memes) ? data.memes : [];
  if (memes.some((e) => sameMeme(e, entry))) {
    pool.pending.splice(idx, 1);
    writeJson(file, pool);
    return { ok: false, reason: `「${k}」已经在梗库里了，候选已清掉` };
  }
  memes.push(entry);
  writeJson(memeFile, { ...data, memes });
  pool.pending.splice(idx, 1);
  writeJson(file, pool);
  return { ok: true, reason: `「${entry.key}」已收录`, entry };
}

/** 拒绝一个候选：清出池子，并进"别再现"名单。 */
export function rejectMeme(key, { file = DEFAULT_PENDING_FILE, now = Date.now(), note = '' } = {}) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, reason: '要拒绝哪个梗？' };
  const pool = loadPending(file);
  const idx = pool.pending.findIndex((e) => normalize(e.key) === normalize(k));
  if (idx < 0) return { ok: false, reason: `候选里没有「${k}」` };
  const [gone] = pool.pending.splice(idx, 1);
  pool.rejected.push({
    key: gone.key,
    aliases: Array.isArray(gone.aliases) ? gone.aliases : [],
    rejectedAt: now,
    note: String(note || '').slice(0, 120)
  });
  if (pool.rejected.length > REJECTED_MAX) {
    pool.rejected = pool.rejected.slice(-REJECTED_MAX);
  }
  writeJson(file, pool);
  return { ok: true, reason: `「${gone.key}」已拒绝，之后不会再收` };
}
