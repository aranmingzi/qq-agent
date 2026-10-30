// 看图双通道：按「这张图从哪来」决定交给哪家视觉模型。
//
// ── 为什么要两家 ──────────────────────────────────────────────────────────
// 2026-10-25 用 9 张真实生产图逐张核对真值（见工作区
// 《看图模型对比-deepseek-vs-千问-2026-10-25.md》），结论是两家各有硬伤，不能一刀切：
//   · deepseek-flash：便宜一半（¥1/¥4 vs ¥1/¥10）、快 40%（1329ms vs 2238ms）、
//     更守「不超过 120 字」的约束；但**小字 OCR 明显弱**（海报漏 3 处关键文字、
//     四格漫画把「拍！」读成「给！」、把「长大大」读成「长大长大」）。
//   · qwen3-vl-plus：小字准，但**跨帧比较会编**（3 帧 GIF 把吐舌头说成"眯眼笑"），
//     而且经常超字数、加戏编画外细节。
// 分工因此不是「谁更好」，而是「谁的短板碰不到这张图」：
//   · 表情包（sticker）= 字大、无小字、要求一句话说清情绪 → 交给 deepseek
//   · 群友发的图/截图/图表/远程 URL = OCR 是刚需 → 交给千问
//
// ── 与旧代码的关系 ────────────────────────────────────────────────────────
// `qwen-vision.js` 一个字没改（控制台的 `/api/vision/qwen` 还靠它），这里只是
// 在它外面加了一层路由 + 第二个实现 + 失败互备。
//
// ⚠️ **deepseek-flash 默认开思考**。不显式关掉时：HTTP 200、finish_reason 正常、
// `content` 是空字符串，200 个 completion token 全进 `reasoning_tokens`。
// 第一次冒烟就是这么空手而归的，日志里只会看到"模型没说话"。
// 这里统一走 `thinking-dialect.js` 的 'off'（deepseek 方言 = `thinking:{type:'disabled'}`）。

import { getConfig } from './config.js';
import { analyzeWithQwenVision, qwenVisionConfig, testQwenVision } from './qwen-vision.js';
import { dialectFor } from './thinking-dialect.js';

const PROVIDER_LABEL = { qwen: 'Qwen-VL', deepseek: 'DeepSeek' };

// 1×1 透明 PNG：只用来验证"能不能收到图"，不依赖任何本地文件。
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}${suffix}`;
}

/** 从 providers 里捞一把已经配好的 Key（默认不把密钥复制到第二处，避免两份不同步）。 */
function providerKeyByHost(hostRe) {
  const list = getConfig().providers;
  const arr = Array.isArray(list) ? list : Object.values(list || {});
  const hit = arr.find((p) => hostRe.test(String(p?.baseURL || p?.baseUrl || '')));
  return String(hit?.apiKey || '').trim();
}

/**
 * DeepSeek 视觉配置。apiKey 留空 = 复用 providers 里 api.deepseek.com 那把，
 * 再退环境变量；三处都没有才算未配置。
 */
export function deepseekVisionConfig(raw = null) {
  const cur = raw || getConfig().vision?.deepseek || {};
  const configuredKey = String(cur.apiKey || '').trim();
  const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  const fromProviders = providerKeyByHost(/^https?:\/\/api\.deepseek\.com/i);
  return {
    enabled: cur.enabled !== false,
    baseUrl: String(cur.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: configuredKey || fromProviders || envKey,
    keySource: configuredKey ? 'config' : (fromProviders ? 'providers' : (envKey ? 'DEEPSEEK_API_KEY' : '')),
    model: String(cur.model || 'deepseek-flash').trim(),
    timeoutMs: Math.max(5000, Number(cur.timeoutMs) || 30000),
    maxTokens: Math.max(32, Number(cur.maxTokens) || 400),
    // low = 先缩到 512×512，更快更便宜但小字更糊；默认 auto（等于原图）。
    detail: String(cur.detail || 'auto').trim() || 'auto'
  };
}

export function deepseekVisionInfo(raw = null) {
  const cfg = deepseekVisionConfig(raw);
  return {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    keySource: cfg.keySource,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    detail: cfg.detail
  };
}

/**
 * 选通道。kind 只有两个值：'sticker'（表情包）/'message'（其余一切）。
 * @returns {{ provider:'qwen'|'deepseek', reason:string }}
 */
export function visionRoute({ kind = 'message', rawConfig = null } = {}) {
  const vision = rawConfig || getConfig().vision || {};
  const forced = String(vision.route || 'auto').toLowerCase();
  const qwen = qwenVisionConfig(vision.qwen || null);
  const deepseek = deepseekVisionConfig(vision.deepseek || null);
  const qwenOk = !!qwen.apiKey;
  const deepseekOk = deepseek.enabled && !!deepseek.apiKey;

  if (forced === 'deepseek') {
    if (deepseekOk) return { provider: 'deepseek', reason: 'vision.route=deepseek 强制' };
    if (qwenOk) return { provider: 'qwen', reason: '强制 deepseek 但未配 Key，回退千问' };
    return { provider: 'deepseek', reason: '强制 deepseek，两家都没 Key（调用时会报错）' };
  }
  if (forced === 'qwen') {
    if (qwenOk) return { provider: 'qwen', reason: 'vision.route=qwen 强制' };
    if (deepseekOk) return { provider: 'deepseek', reason: '强制千问但未配 Key，回退 deepseek' };
    return { provider: 'qwen', reason: '强制千问，两家都没 Key' };
  }

  // auto：表情包走便宜的，其余（可能有小字）走准的。
  if (kind === 'sticker') {
    if (deepseekOk) return { provider: 'deepseek', reason: '表情包：字大无小字，deepseek 更省更快' };
    if (qwenOk) return { provider: 'qwen', reason: '表情包：deepseek 未就绪，用千问' };
    return { provider: 'qwen', reason: '表情包：两家都没 Key（调用时会报错）' };
  }
  if (qwenOk) return { provider: 'qwen', reason: '图片/截图：OCR 精度优先' };
  if (deepseekOk) return { provider: 'deepseek', reason: '图片/截图：千问未就绪，用 deepseek' };
  return { provider: 'qwen', reason: '图片/截图：两家都没 Key（调用时会报错）' };
}

/** 单次 DeepSeek 视觉调用。思考必须关，否则返空正文。 */
export async function analyzeWithDeepseekVision({ dataUrls, prompt, rawConfig = null, timeoutMs = null } = {}) {
  const cfg = deepseekVisionConfig(rawConfig);
  if (!cfg.apiKey) throw new Error('DeepSeek 视觉未配置 API Key（可留空复用模型 API 里那把 DeepSeek Key）');
  const images = (Array.isArray(dataUrls) ? dataUrls : []).map((u) => String(u || '').trim()).filter(Boolean);
  if (!images.length) throw new Error('没有可识别的图片');
  const startedAt = Date.now();

  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        ...images.map((url) => ({
          type: 'image_url',
          image_url: cfg.detail && cfg.detail !== 'auto' ? { url, detail: cfg.detail } : { url }
        })),
        { type: 'text', text: String(prompt || '') }
      ]
    }],
    max_tokens: cfg.maxTokens,
    stream: false
  };
  // 关思考：不发这个字段 = token 全烧在 reasoning，正文空。
  dialectFor({ baseUrl: cfg.baseUrl, model: cfg.model }).apply(body, 'off');

  const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || cfg.timeoutMs))
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = String(payload?.error?.message ?? payload?.message ?? '').slice(0, 300);
    throw new Error(`DeepSeek 视觉 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const text = String(payload?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('DeepSeek 视觉没有返回文字结果（思考模式没关掉时会这样）');
  return {
    text,
    provider: 'deepseek',
    label: PROVIDER_LABEL.deepseek,
    model: payload?.model || cfg.model,
    usage: payload?.usage || null,
    latencyMs: Date.now() - startedAt
  };
}

async function runQwen({ dataUrls, prompt, rawConfig }) {
  const r = await analyzeWithQwenVision({ dataUrls, prompt, rawConfig: rawConfig?.qwen ?? null });
  return { ...r, provider: 'qwen', label: PROVIDER_LABEL.qwen };
}

/**
 * 统一入口：按路由选家，选中的失败就换另一家再试一次。
 * 换家成功时返回值里的 provider/label 是**实际**出结果那家 —— 上层标签不会骗人。
 */
export async function analyzeWithVision({ dataUrls, prompt, kind = 'message', rawConfig = null } = {}) {
  // 没有图就别白跑两家：两家都会各自报"没有可识别的图片"，错误信息还长得像"两家都挂了"。
  if (!(Array.isArray(dataUrls) ? dataUrls : []).filter((u) => String(u || '').trim()).length) {
    throw new Error('没有可识别的图片');
  }
  const route = visionRoute({ kind, rawConfig });
  const order = route.provider === 'qwen' ? ['qwen', 'deepseek'] : ['deepseek', 'qwen'];
  const failures = [];
  for (const provider of order) {
    const cfg = provider === 'qwen'
      ? qwenVisionConfig(rawConfig?.qwen ?? null)
      : deepseekVisionConfig(rawConfig?.deepseek ?? null);
    const usable = provider === 'qwen' ? !!cfg.apiKey : (cfg.enabled && !!cfg.apiKey);
    if (!usable) { failures.push(`${provider}：未配置`); continue; }
    try {
      const result = provider === 'qwen'
        ? await runQwen({ dataUrls, prompt, rawConfig })
        : await analyzeWithDeepseekVision({ dataUrls, prompt, rawConfig: rawConfig?.deepseek ?? null });
      return { ...result, routeReason: route.reason, failures, fallbackFrom: provider === route.provider ? '' : route.provider };
    } catch (error) {
      const msg = String(error?.message ?? error);
      // ⚠️ 2026-10-26：超时/网络中断**不换家**。
      // 客户端断掉不代表服务端停了 —— 它多半已经跑起来了，照样计费。
      // 换一家再跑一次 = 一次识图付两次钱，而用户只看到"慢了一倍"。
      // 只有"确定没做出来"的错误（配置缺失、4xx、空正文）才值得换家。
      const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        || /超时|timeout|abort/i.test(msg);
      failures.push(`${provider}：${msg}`);
      if (isTimeout) {
        throw new Error(`识图失败（${provider} 超时，未换家以免重复计费）｜${failures.join('｜')}`);
      }
    }
  }
  throw new Error(`识图失败（两家都试过）｜${failures.join('｜')}`);
}

export async function testDeepseekVision(rawConfig = null) {
  const startedAt = Date.now();
  try {
    const result = await analyzeWithDeepseekVision({
      rawConfig,
      dataUrls: [`data:image/png;base64,${TINY_PNG}`],
      prompt: '只需确认你能收到图片，回复 pong。',
      timeoutMs: 25000
    });
    return { ok: true, model: result.model, note: `DeepSeek 视觉可用：${result.text.slice(0, 80)}`, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt };
  }
}

export { testQwenVision };
