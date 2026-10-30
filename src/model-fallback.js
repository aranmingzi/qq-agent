// 模型降级链：当前模型失败时，自动切换到备选模型（同提供商 → 跨提供商）。
//
// 设计（参考 Estrella Bot 的「降级链收敛」思路，但适配本项目的 providers 目录）：
//   - 降级链的唯一构建入口是 buildFallbackChain()，从 config.providers 里自动找
//   - 当前模型/提供商失败时，按顺序尝试：同提供商的其他模型 → 其他提供商的模型
//   - 每条链元素是 { baseUrl, apiKey, model }，chatCompletion 直接换这些字段重试
//
// 安全约束：
//   - 只降级到「有密钥」或「密钥可空」的提供商，不把请求发给没配密钥的端点
//   - 401/403（密钥问题）不无限重试：只试一次就换下一家
//   - 429（限流）也换下一家，但记录下来
import { getConfig } from './config.js';
import { currentProviders } from './providers.js';

/**
 * 判断一次失败是否值得换模型重试。
 * 可重试：网络错误、超时、5xx、429、401/403（密钥失效也值得换一家）。
 * 不可重试：400（请求本身有问题，换模型也没用）、404（模型名不存在，但可能是网关差异，仍可试）。
 */
export function isRetryableError(message = '') {
  const m = String(message || '');
  // 400 通常是请求体/参数错误，换模型大概率还是 400，不重试
  if (/HTTP 400\b/.test(m)) return false;
  // 404 可能是"该模型在此网关不存在"，换模型也许有用，试一次
  return true;
}

/**
 * 明显不是"能聊天/能调工具"的模型：嵌检索、重排、语音、图像、视频、OCR、翻译专用。
 * 放进降级链只会白等一轮超时（而且它们多半直接报 400/422，报错文案还会被当成
 * "换一家试试"的理由），所以构建链时先剔掉。
 */
const NON_CHAT_MODEL = /embedding|rerank|ttsd|tts|asr|diarize|sensevoice|cosyvoice|voice|ocr|kolors|wan2|image|hunyuan-mt|bge-|moss-|stable-diffusion|sdxl/i;

/** 单个提供商最多贡献几个候选：同家试 2 个够了，再多只是把等待时间拉长。 */
const MAX_PER_PROVIDER = 2;
/**
 * 整条链的端点上限：宁可快速失败并如实报错，也不要让用户等到天荒地老。
 *
 * 8 → 11（2026-10-25）：加了第 5 家（本机免费网关）后是「当前端点 + 5 家 × 2」= 11，
 * 而链长 8 会让排在最后的整家**被 slice 切光**——provider 加进目录却永远用不上，
 * 且没有任何报错，是最难发现的一类"配置生效了但没生效"。
 *
 * 11 → 13（2026-10-27）：目录里加了第 6 家（Google Gemini），它排在 providers 数组末尾。
 * 6 家 × 2 = 12，链长 11 会把**链尾那家的第二个候选**切掉；再加第 7 家就整家消失。
 * 这类缺口很阴：日志只说"所有端点都失败了"，不会提"你配的那家压根没被试全"。
 * 仍然是手算死的：现在取 13（12 + 1 格余量）。**下次加到第 7 家之前先回来改这个数。**
 *
 * ⚠️ 这个数是**手算死的**，不是动态的。动态（=1+每家2个）看着优雅，但
 * `importFromDsh()` 会整体替换 providers，可能一次导入十来家 → 链无限拉长，
 * 那就成了"每次故障都要等十几个超时"。所以宁可手算。
 * **加第 7 家之前，先决定砍掉谁**，否则又是静默截断。
 *
 * 为什么加到 13 不会拖慢：多出来的两家排最末，只有前面全挂才会走到；
 * 而本机网关"DSH 没开"时是 ECONNREFUSED（毫秒级），不吃满 180s 超时。
 */
export const MAX_CHAIN = 13;

function isNonChatModel(modelId) {
  return NON_CHAT_MODEL.test(String(modelId || ''));
}

/**
 * 从 providers 目录构建降级链。
 * 返回 [{ baseUrl, apiKey, model, providerId, displayName }]。
 * 顺序：当前模型（若属于某提供商）→ 同提供商其他模型 → 其他提供商（有密钥优先）。
 */
export function buildFallbackChain({ currentBaseUrl = '', currentApiKey = '', currentModel = '', providerId = '' } = {}) {
  const cfg = getConfig();
  const providers = currentProviders();
  const chain = [];

  // 1. 当前生效的端点（api.baseUrl/apiKey/model）永远是第一项
  const curBase = String(currentBaseUrl || cfg.api?.baseUrl || '').trim();
  const curKey = String(currentApiKey || cfg.api?.apiKey || '').trim();
  const curModel = String(currentModel || cfg.api?.model || '').trim();
  if (curBase && curModel) {
    chain.push({ baseUrl: curBase, apiKey: curKey, model: curModel, providerId: providerId || '', displayName: '当前端点' });
  }

  // 2. 找出当前模型所属的提供商（按 model 匹配，或按 providerId）
  let currentProv = null;
  if (providerId) {
    currentProv = providers.find((p) => p.id === providerId) || null;
  }
  if (!currentProv && curModel) {
    currentProv = providers.find((p) => (p.models || []).includes(curModel)) || null;
  }

  // 3. 同提供商的其他模型（排在跨提供商之前：同一家网关切换模型最快）
  if (currentProv) {
    let taken = 0;
    for (const m of currentProv.models || []) {
      if (m === curModel) continue;
      if (isNonChatModel(m)) continue;
      if (taken >= MAX_PER_PROVIDER) break;
      const entry = { baseUrl: currentProv.baseURL, apiKey: currentProv.apiKey, model: m, providerId: currentProv.id, displayName: currentProv.displayName };
      if (!chain.some((c) => c.baseUrl === entry.baseUrl && c.model === entry.model)) {
        chain.push(entry);
        taken += 1;
      }
    }
  }

  // 4. 其他提供商（有密钥优先，其次能空密钥访问的）
  const others = providers
    .filter((p) => p.id !== (currentProv?.id || providerId))
    .sort((a, b) => {
      const ka = a.apiKey ? 1 : 0;
      const kb = b.apiKey ? 1 : 0;
      return kb - ka; // 有密钥的排前面
    });
  for (const p of others) {
    // 没有密钥的提供商也放进去（本地网关/免费端点可能不需要密钥），但排在最后
    let taken = 0;
    for (const m of p.models || []) {
      if (isNonChatModel(m)) continue;
      if (taken >= MAX_PER_PROVIDER) break;
      const entry = { baseUrl: p.baseURL, apiKey: p.apiKey, model: m, providerId: p.id, displayName: p.displayName };
      if (!chain.some((c) => c.baseUrl === entry.baseUrl && c.model === entry.model)) {
        chain.push(entry);
        taken += 1;
      }
    }
  }

  return chain.slice(0, MAX_CHAIN);
}

/**
 * 带降级链的单次对话请求。
 * 依次尝试 chain 里的每个端点，失败（可重试）就换下一个；全部失败抛最后一个错误。
 * 返回 { message, usage, raw, model, usedEndpoint, attempts }。
 */
export async function chatCompletionWithFallback({ chain = [], messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, maxTokens = null, thinking = null, onFallback = null } = {}) {
  if (!chain.length) throw new Error('没有可用的模型端点（降级链为空）');

  let lastError = null;
  const attempts = [];

  for (let i = 0; i < chain.length; i++) {
    const endpoint = chain[i];
    // 用动态 import 避免循环依赖（llm.js 也会 import 本模块）
    const { chatCompletion } = await import('./llm.js');
    try {
      const result = await chatCompletion({
        messages,
        tools,
        toolChoice,
        temperature,
        signal,
        maxTokens,
        thinking,
        // 关键：把当前端点的 baseUrl/apiKey/model 传进去覆盖默认
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model
      });
      attempts.push({ endpoint: endpoint.displayName, model: endpoint.model, ok: true });
      if (i > 0 && typeof onFallback === 'function') {
        onFallback({ from: chain[0], to: endpoint, attemptIndex: i });
      }
      return { ...result, usedEndpoint: endpoint, attempts };
    } catch (error) {
      const msg = String(error?.message ?? error);
      attempts.push({ endpoint: endpoint.displayName, model: endpoint.model, ok: false, error: msg });
      lastError = error;
      // 不可重试的错误（如 400）直接抛，不继续降级
      if (!isRetryableError(msg)) {
        throw error;
      }
      // 用户手动中止：立即抛，不降级
      if (error?.name === 'AbortError') throw error;
    }
  }

  throw lastError || new Error('所有模型端点都失败了');
}
