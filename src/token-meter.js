/**
 * token 估算与窗口占比 —— 本仓的「token 感知」层。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 * 2026-10-31 之前，全仓所有上限都是**字符数**：
 *   `src/prompt.js` 的 `SYSTEM_TOTAL_MAX = 20000` / `USER_TOTAL_MAX = 16000`、
 *   `src/context-budget.js` 的 `quotaOf(seg.name, budget, 4000)`、
 *   `src/tool-result-budget.js` 的 `DEFAULT_MAX_CHARS = 12000`。
 * 字符数**不知道模型窗口有多大**，所以「快顶爆了」这件事从来没人算过。
 * 旁证：`grep -rn "contextWindow|context_window|maxContext|windowTokens|tokenBudget" src/*.js`
 * 在 2026-10-31 当天是**零命中**。
 *
 * ── 为什么换算系数是 1.0，不是行业默认的 1.5 ────────────────────────
 * 不猜，用本仓自己的真机数据校准（data/sessions/*.json 同时记了
 * `promptChars` 与 `usage.promptTokens`）：
 *   取 `usage.calls === 1` 的 13 个干净样本（calls>1 会把 chars 重复计多次，
 *   算出来的比值 0.59 是错的，不能用）：
 *     1.006 / 1.019 / 1.008 / 1.021 / 1.016 / 1.004 / 1.028 /
 *     1.009 / 1.007 / 1.018 / 1.016 / 1.034（另一个 0.742 是视觉轮，图片另计）
 *   → 平均 chars/token = 0.994，即 **token/字符 ≈ 1.006**。
 * 原因是本仓提示词以中文为主，中文 1 字 ≈ 1 token；行业常用的 ×1.5 是按
 * 英文 4 字符/token 反推的粗估，套到中文会高估 50%，导致过早触发压缩。
 * 系数仍留配置口（`api.charsPerToken`），换模型族时可以改。
 *
 * ── 为什么达不到窗口就什么都不做 ────────────────────────────────────
 * 实测压力并不大：单次调用 prompt token 的 p50 = 14224、p90 = 15429、
 * max = 20286（995 个样本）。真正的风险场景是 `maxRounds: 6` 每一轮都塞进
 * 上限 12000 字符的工具结果，理论上能堆到 ~7 万 token —— 撞上 64K/128K
 * 窗口的模型才会翻车。所以这一层是**兜底**，不是常态压缩：
 * 默认阈值 0.82（借 AstrBot 的实测值），不到阈值一律不打扰。
 */

/** 字符 → token 的倍率（中文 1 字 ≈ 1 token，见文件头校准过程）。 */
export const CHARS_PER_TOKEN = 1.0;

/** 窗口用量达到多少比例就该动手。0.82 来自 AstrBot 的实测默认值。 */
export const COMPACT_THRESHOLD = 0.82;

/** 不知道窗口大小时用的保守假设（128K）。只用来算"要不要报警"，不据此激进压缩。 */
export const FALLBACK_WINDOW = 128000;

/**
 * 估一段文本的 token 数。
 * 空输入给 0（不是 1）—— 调用方会累加，凭空 +1 会把空段也算成开销。
 * @param {string} text
 * @param {{ charsPerToken?: number }} [opts]
 * @returns {number}
 */
export function estimateTokens(text, { charsPerToken = CHARS_PER_TOKEN } = {}) {
  const s = String(text ?? '');
  if (!s) return 0;
  const ratio = Number(charsPerToken);
  const k = Number.isFinite(ratio) && ratio > 0 ? ratio : CHARS_PER_TOKEN;
  // 至少 1：有字就算 1 个 token，别让 1~2 个字的短消息估成 0
  return Math.max(1, Math.ceil(s.length / k));
}

/**
 * 一条 OpenAI 兼容消息的 token 估算。
 *
 * content 可能是字符串、可能是分段数组（视觉轮里那种 `[{type:'text'}, {type:'image_url'}]`）、
 * 也可能带 `tool_calls`。三种都要算到，否则工具轮会被系统性低估。
 *
 * 每条消息额外 +4 token 是各家 chat 模板的结构开销（role/分隔符）；
 * 这不是精确值，只是别让"几百条消息"的固定开销被忽略成 0。
 */
export function messageTokens(m, { charsPerToken = CHARS_PER_TOKEN } = {}) {
  if (!m || typeof m !== 'object') return 0;
  let n = 4;
  const content = m.content;
  if (typeof content === 'string') {
    n += estimateTokens(content, { charsPerToken });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (typeof part === 'string') { n += estimateTokens(part, { charsPerToken }); continue; }
      if (typeof part.text === 'string') n += estimateTokens(part.text, { charsPerToken });
      // 图片按固定块算（各家差异极大，这里只求"不是 0"）
      if (part.type === 'image_url' || part.image_url) n += 800;
    }
  }
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      n += estimateTokens(call?.function?.name, { charsPerToken });
      n += estimateTokens(call?.function?.arguments, { charsPerToken });
      n += 8;
    }
  }
  if (m.name) n += estimateTokens(m.name, { charsPerToken });
  return n;
}

/**
 * 整个 messages 数组的 token 估算（含末尾回复预留不算在内 —— 那是输出预算的事）。
 * @param {Array} messages
 */
export function messagesTokens(messages, { charsPerToken = CHARS_PER_TOKEN } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  for (const m of list) total += messageTokens(m, { charsPerToken });
  return total;
}

/**
 * 算出「用了窗口的多少」。
 *
 * `contextWindow <= 0`（没配、也没从 /models 拿到）时用 FALLBACK_WINDOW，
 * 并把 `assumed: true` 暴露给调用方 —— 调用方据此只警告、不据此激进压缩。
 *
 * @param {{ messages?: Array, promptChars?: number, promptTokens?: number, contextWindow?: number, charsPerToken?: number, reserveTokens?: number }} opts
 * @returns {{ tokens: number, window: number, ratio: number, assumed: boolean, free: number }}
 */
export function windowUsageOf({
  messages = null,
  promptChars = null,
  promptTokens = null,
  contextWindow = 0,
  charsPerToken = CHARS_PER_TOKEN,
  reserveTokens = 0
} = {}) {
  let tokens;
  if (Number.isFinite(promptTokens) && promptTokens > 0) {
    tokens = Number(promptTokens);
  } else if (Number.isFinite(promptChars) && promptChars > 0) {
    // 直接对字符数换算 —— 不要 `'x'.repeat(promptChars)` 造一个假字符串，
    // 那是几万字符的无谓内存分配（而且看起来像 bug）。
    const k = Number(charsPerToken);
    const ratio = Number.isFinite(k) && k > 0 ? k : CHARS_PER_TOKEN;
    tokens = Math.max(1, Math.ceil(Number(promptChars) / ratio));
  } else {
    tokens = messagesTokens(messages, { charsPerToken });
  }
  const win = Number(contextWindow);
  const assumed = !(Number.isFinite(win) && win > 0);
  const window = assumed ? FALLBACK_WINDOW : win;
  const reserve = Math.max(0, Number(reserveTokens) || 0);
  const free = Math.max(0, window - tokens - reserve);
  return {
    tokens,
    window,
    ratio: window > 0 ? tokens / window : 0,
    assumed,
    free
  };
}

/**
 * 要不要动手压缩。
 * 窗口是假设值（不知道真实窗口）时**永远返回 false** —— 宁可漏一次，
 * 也不能因为一个猜出来的 128K 去砍用户真实的历史。
 *
 * @param {{ ratio: number, assumed?: boolean }} usage
 * @param {{ threshold?: number, enabled?: boolean }} [opts]
 */
export function shouldCompact(usage, { threshold = COMPACT_THRESHOLD, enabled = true } = {}) {
  if (!enabled) return false;
  if (!usage || typeof usage !== 'object') return false;
  if (usage.assumed) return false;
  const t = Number(threshold);
  const lim = Number.isFinite(t) && t > 0 && t < 1 ? t : COMPACT_THRESHOLD;
  return Number(usage.ratio) >= lim;
}

/**
 * 给日志用的一行。**只在真做了什么时打印** —— 天天输出"一切正常"等于没有日志
 * （这条是 `src/orchestrator.js` 里既有的日志纪律，沿用）。
 */
export function describeUsage(usage, label = '上下文') {
  if (!usage || typeof usage !== 'object') return '';
  const pct = Math.round((Number(usage.ratio) || 0) * 1000) / 10;
  const tok = formatTokens(usage.tokens);
  const win = formatTokens(usage.window);
  const head = `${label}用量 ${pct}%（≈${tok} / 窗口 ${win}${usage.assumed ? '，窗口未知，按 128K 估' : ''}）`;
  return head;
}

/** 数字 → "1.2万 / 12.4万 / 128K" 这种人看的形态。 */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}

/**
 * 从一堆候选里挑出真实窗口大小。
 * 优先级：手配（config.api.contextWindow）> /models 元信息 > 0（未知）。
 * 手配永远赢：`listModels()` 给的值来自各家五花八门的字段，不一定可信。
 *
 * @param {{ configured?: number|string, discovered?: number|string }} opts
 * @returns {number} 0 表示未知
 */
export function resolveContextWindow({ configured = 0, discovered = 0 } = {}) {
  const c = Number(configured);
  if (Number.isFinite(c) && c > 0) return Math.floor(c);
  const d = Number(discovered);
  if (Number.isFinite(d) && d > 0) return Math.floor(d);
  return 0;
}

/**
 * 各家 /models 返回的窗口字段名不统一，这里按已知顺序捞。
 * 全部取不到返回 0。
 */
export function pickContextWindow(meta) {
  if (!meta || typeof meta !== 'object') return 0;
  const keys = [
    'contextWindow', 'context_window', 'context_length', 'contextLength',
    'max_context', 'max_context_length', 'maxContextLength',
    'max_model_len', 'maxModelLen', 'max_input_tokens', 'maxInputTokens'
  ];
  for (const k of keys) {
    const v = Number(meta[k]);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  // 有些网关把窗口塞在嵌套对象里
  const nested = meta.limits || meta.limit || meta.meta || null;
  if (nested && typeof nested === 'object') {
    for (const k of keys) {
      const v = Number(nested[k]);
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return 0;
}
