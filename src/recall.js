// 记忆检索打分：从"关键词是否出现"升级为"相关 × 新鲜 × 重要"。
//
// 为什么需要它（2026-10-22 生态调研的 P1-4）：
//   以前 formatForPrompt 直接把最后 N 条塞进提示词。群里聊得久之后，
//   "上周那个事"和"刚才那个事"权重一样，模型要么抓错，要么干脆忽略整段。
//
// 做法（不引 embedding、不加依赖，先把排序做对）：
//   score = 0.55 × 相关(命中词占比) + 0.30 × 新鲜(半衰期) + 0.15 × 重要(类别权重)
//   相关为 0 时仍可凭新鲜/重要入选 —— 记忆不能只在"被问到"时才出现。
//
// 纯函数，方便直接断言。

/** 中文按二元组切，英文/数字按词切，统一小写。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 类别权重：印象/长期事实比"进行中的话题"更值得留在上下文里。 */
const CATEGORY_WEIGHT = Object.freeze({
  memberImpression: 1.0,
  activeTopic: 0.8,
  pendingThought: 0.6,
  fact: 1.0,
  diary: 0.9,
});

/**
 * 单条记忆的打分（0..1）。
 * @param {object} entry  { content, createdAt, target? }
 * @param {object} opts
 * @param {Set<string>} [opts.queryTokens]
 * @param {number} [opts.now]
 * @param {number} [opts.halfLifeMs] 新鲜度半衰期（默认 7 天）
 * @param {number} [opts.importance] 0..1，缺省按类别
 * @param {string} [opts.category]
 */
export function scoreEntry(entry, {
  queryTokens = null,
  now = Date.now(),
  halfLifeMs = 7 * 24 * 60 * 60 * 1000,
  importance = null,
  category = '',
} = {}) {
  const content = String(entry?.content ?? '');
  if (!content) return 0;
  const created = Number(entry?.createdAt) || 0;
  const age = created > 0 ? Math.max(0, now - created) : halfLifeMs;
  const freshness = halfLifeMs > 0 ? Math.max(0, Math.min(1, 1 - age / (halfLifeMs * 2))) : 1;

  let relevance = 0;
  if (queryTokens && queryTokens.size) {
    const t = tokenize(`${content} ${entry?.target ?? ''}`);
    let hit = 0;
    for (const q of queryTokens) if (t.has(q)) hit += 1;
    relevance = Math.min(1, hit / Math.max(1, Math.min(queryTokens.size, 8)));
  }

  const imp = importance === null || importance === undefined
    ? (CATEGORY_WEIGHT[category] ?? 0.7)
    : Math.max(0, Math.min(1, Number(importance)));

  return Math.max(0, Math.min(1, 0.55 * relevance + 0.30 * freshness + 0.15 * imp));
}

/**
 * 排序并截断。
 * @returns {Array<{entry:object, score:number, category:string}>}
 */
export function rankEntries(entries, {
  query = '',
  now = Date.now(),
  halfLifeMs = 7 * 24 * 60 * 60 * 1000,
  limit = 5,
  minScore = 0.02,
  category = '',
} = {}) {
  const queryTokens = query ? tokenize(query) : null;
  const scored = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e) continue;
    const score = scoreEntry(e, { queryTokens, now, halfLifeMs, category: e.category || category });
    if (score < minScore) continue;
    scored.push({ entry: e, score, category: e.category || category });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Number(limit) || 5));
}
