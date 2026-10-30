// OpenAI 兼容 Chat Completions 客户端（非流式；QQ 本身不支持流式，没必要）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig } from './config.js';
import { priceOf, ratesOf } from './prices.js';
import { dialectFor } from './thinking-dialect.js';
import { sanitizeDeep } from './text-hygiene.js';
import { pickContextWindow } from './token-meter.js';

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, model = null, maxTokens = null, thinking = null, baseUrl = null, apiKey = null }) {
  const cfg = getConfig().api;
  const modelId = String(model || cfg.model || '').trim();
  // 支持端点覆盖：降级链（model-fallback.js）会传入备选 baseUrl/apiKey
  const endpointBase = String(baseUrl || cfg.baseUrl || '').trim();
  const endpointKey = apiKey === null || apiKey === undefined ? cfg.apiKey : apiKey;
  const body = {
    model: modelId,
    messages,
    stream: false
  };
  // thinking：'off' 关思考、'on' 开、'low'/'high'/'max' 调档。
  // 具体发哪个字段交给方言表（各家参数名不同，发错会被网关 400 而不是忽略）。
  // 历史背景：'off' 以前是硬编码 `thinking:{type:'disabled'}`，对百炼是错的写法，
  // 会触发 400 → 走降级链 → 悄悄换模型。现在由 dialect 按域名+模型名决定。
  if (thinking) {
    try {
      dialectFor({ baseUrl: endpointBase, model: modelId }).apply(body, thinking);
    } catch {
      if (String(thinking) === 'off') body.thinking = { type: 'disabled' };
    }
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const outputLimit = Number(maxTokens ?? cfg.maxOutputTokens) || 0;
  if (outputLimit > 0) body.max_tokens = outputLimit;
  const temp = temperature === null ? (cfg.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), Math.max(5000, Number(cfg.timeoutMs) || 180000));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  // 出站前统一摘掉孤立代理项（见 text-hygiene.js）。
  // 必须在 stringify **之前**清对象：JSON.stringify 会把孤立代理项转义成
  // `\ud83d` 这样的合法 ASCII，事后就扫不出来了，而服务端解析完仍是非法字符串。
  // 正常请求 999/1000 次这里什么都不改（sanitizeDeep 无变化时返回原引用）。
  const hygiene = { removed: 0 };
  const safeBody = sanitizeDeep(body, hygiene);
  if (hygiene.removed > 0) {
    console.warn(`[text-hygiene] 请求体里有 ${hygiene.removed} 个孤立代理项已摘掉（多半是某处按字符截断了 emoji）`);
  }

  let res;
  try {
    res = await fetch(joinUrl(endpointBase, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(endpointKey) },
      body: JSON.stringify(safeBody),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new Error(`模型请求超时（${cfg.timeoutMs}ms）`);
    throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
  }
  const data = await res.json().catch(() => { throw new Error('模型 API 返回了无法解析的 JSON'); });
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  return {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? modelId,
    raw: data
  };
}

/**
 * 获取模型列表（GET /models）。返回 [{ id, contextWindow }]；失败抛错。
 *
 * 2026-10-31：以前只留 `id`，把窗口大小这类元信息**全丢了** ——
 * 后果是全仓没有一个地方知道模型窗口多大（所有上限都是字符数）。
 * 现在顺手把窗口捞出来（各家字段名不统一，见 token-meter.js 的 pickContextWindow），
 * 取不到就是 0 = 未知。`id` 字段名不变，别的地方不用改。
 */
export async function listModels() {
  const cfg = getConfig().api;
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list
    .map((m) => {
      const raw = (m && typeof m === 'object') ? m : {};
      return { id: String(raw.id ?? raw.model ?? m), contextWindow: pickContextWindow(raw) };
    })
    .filter((m) => m.id);
}

/**
 * 从各家不同形状的 usage 里抠出「输入中命中前缀缓存」的 token 数。
 *
 * ⚠️ 这是一条修过的硬 bug（2026-10-25）：原来只读
 * `usage.prompt_cache_hit_tokens ?? usage.cached_tokens`，而**硅基流动返回的是
 * `prompt_tokens_details.cached_tokens`** —— 两个键都读不到，于是每次调用都把
 * 命中数记成 0。
 *
 * 后果不是多花钱，是**尺子坏了**：`data/usage/` 把所有输入按全价计，
 * 于是"该不该省 token""缓存有没有生效"这类判断全部建在错数上。
 * 实测同一份前缀第二次请求的真实命中是 2688/2713 ≈ 99%，
 * 而报表显示 0% —— 差点据此去开一个不存在的大优化。
 *
 * 各家字段（从实测和文档里收齐，读不到就退回 0，绝不猜）：
 *   · OpenAI / 硅基流动：`prompt_tokens_details.cached_tokens`
 *   · DeepSeek 官方：`prompt_cache_hit_tokens`（miss 侧另有 prompt_cache_miss_tokens）
 *   · 部分中转网关：`cached_tokens` / `prompt_cache_hit`
 *   · Anthropic 风格：`cache_read_input_tokens`（顶层或 details 内）
 *
 * 注意：`prompt_tokens` 通常**已包含**命中部分（hit + miss = prompt），
 * 所以计价要写成 `(prompt - cached) × 输入价 + cached × 缓存价`，不能相加。
 */
export function cachedTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const d = (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object')
    ? usage.prompt_tokens_details
    : ((usage.promptTokensDetails && typeof usage.promptTokensDetails === 'object') ? usage.promptTokensDetails : {});
  const cands = [
    d.cached_tokens,                  // OpenAI / 硅基流动（实测走这条）
    usage.prompt_cache_hit_tokens,    // DeepSeek 官方
    usage.cached_tokens,
    usage.prompt_cache_hit,
    d.cache_read_input_tokens,        // Anthropic 风格
    usage.cache_read_input_tokens
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** 累加 usage。 */
export function addUsage(target, usage, { model = null, at = new Date() } = {}) {
  if (!usage) return target;
  const prompt = Number(usage.prompt_tokens ?? usage.promptTokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.completionTokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  // 前缀缓存命中的 token —— 键名各家不同，统一走 cachedTokensOf()。
  // 不记这一项，成本就只能按全价算；这个系统的 system 提示逐字节稳定，
  // 实测同一份前缀第二次请求命中 ≈99%，按全价算会把账单高估一个数量级
  // （缓存价是输入价的 1/50，见 data/prices.json）。
  const rawHit = cachedTokensOf(usage);
  const hit = prompt > 0 ? Math.min(rawHit, prompt) : rawHit;
  if (hit > 0) target.cachedTokens = (Number(target.cachedTokens) || 0) + hit;
  target.totalTokens += Number(usage.total_tokens) || prompt + completion;

  // 按「当时是高峰还是闲时」分桶。不分局:同一个日账里既有凌晨的半价调用、
  // 又有白天的高峰调用，用哪一个价乘总量都是错的（差的是一倍，不是几个点）。
  if (model) {
    let peak = false;
    try {
      peak = priceOf(model, { at }).peak;
    } catch { /* 价格表读不出来就一律按闲时桶，宁可少算不高估 */ }
    const byRate = target.byRate && typeof target.byRate === 'object' ? target.byRate : { peak: null, off: null };
    const key = peak ? 'peak' : 'off';
    const cur = byRate[key] || { prompt: 0, completion: 0, cached: 0 };
    cur.prompt += prompt;
    cur.completion += completion;
    cur.cached += hit;
    byRate[key] = cur;
    target.byRate = byRate;
  }
  return target;
}

export function addUsageForModel(target, model, usage) {
  const id = String(model || 'unknown');
  if (!target || typeof target !== 'object') return target;
  target.models = target.models && typeof target.models === 'object' ? target.models : {};
  target.models[id] = target.models[id] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
  addUsage(target.models[id], usage, { model: id });
  target.models[id].calls += 1;
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
}

/**
 * 按价格表折算成本（元）。
 *
 * 三段计价，缺一段就会算错：命中缓存的那部分输入、没命中的输入、输出。
 * 只按"输入总量 × 输入价"算的话，像我们这种 system 提示固定不变、每轮都吃的
 * 长前缀会被按全价收费，账单虚高一个数量级（实测命中价是输入价的 1/50）。
 *
 * 有 byRate 分桶时按"当时的档位"算（凌晨半价、白天高峰不会混）；
 * 没有分桶（历史数据 / 老格式）时按此刻档位估 —— 会有一点偏差，但不会再虚高。
 */
export function estimateCost(usage, { model = null, at = new Date() } = {}) {
  const rates = ratesOf(model || getConfig().api?.model);
  const sum = (part, price) => {
    if (!part) return 0;
    const prompt = Number(part.prompt) || 0;
    const cached = Math.min(Math.max(0, Number(part.cached) || 0), prompt);
    return ((prompt - cached) / 1e6) * price.in
      + (cached / 1e6) * price.cached
      + ((Number(part.completion) || 0) / 1e6) * price.out;
  };

  const by = usage.byRate;
  let cost = 0;
  if (by && (by.peak || by.off)) {
    cost += sum(by.peak, rates.peak || rates.off);
    cost += sum(by.off, rates.off);
  } else {
    const now = priceOf(model || getConfig().api?.model, { at });
    cost = sum({
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      cached: usage.cachedTokens
    }, now);
  }
  return Math.round(cost * 1e4) / 1e4;
}
