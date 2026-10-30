// 思考/推理参数方言表（学自 TT 整合包 plugins/thinking-adapters/dialects.js）。
//
// ── 为什么需要这一层 ──────────────────────────────────────────────────────
// "让模型多想一想"在各家的参数名完全不同，而且**发错参数会被网关直接 400 拒绝**，
// 不是被忽略。我们以前只有一条硬编码：`body.thinking = { type: 'disabled' }`——
//   · 对 DeepSeek / 智谱是对的；
//   · 对百炼（qwen）是错的，它认 `enable_thinking`；
//   · 对本地网关是纯噪音，多数直接 400。
// 后果不是"少省一点钱"，是**触发一次 400 → 走降级链 → 悄悄换了模型**。
//
// ── 成本含义 ──────────────────────────────────────────────────────────────
// 思考 token 按**输出价**计（8 元/M），是输入未命中价（2 元/M）的 4 倍。
// 也就是说"多想一步"比"把整份上下文重发一遍"还贵。所以这不只是兼容性问题。
//
// 识别依据：域名优先，其次模型名前缀（同一个模型在不同网关行为不同）。

const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i;

/** 方言表：从上往下第一个命中者胜。host 与 model 至少命中一个（host 优先）。 */
export const MODEL_RULES = [
  { dialect: 'local', host: LOCAL_HOSTS, model: null, supports: [] },
  { dialect: 'qwen', host: /dashscope|aliyuncs|bailian/i, model: null, supports: ['off', 'on'] },
  { dialect: 'qwen', host: null, model: /qwen|qwq/i, supports: ['off', 'on'] },
  { dialect: 'deepseek', host: /deepseek\.com$/i, model: null, supports: ['off', 'on', 'effort'] },
  { dialect: 'deepseek', host: null, model: /deepseek/i, supports: ['off', 'on', 'effort'] },
  { dialect: 'glm', host: /bigmodel|zhipu/i, model: null, supports: ['off', 'on'] },
  { dialect: 'glm', host: null, model: /glm|chatglm/i, supports: ['off', 'on'] },
  // Gemini 只走 OpenAI 兼容层（/v1beta/openai）。它认 reasoning_effort，
  // 但「none」只有 2.5 系列接受 —— Gemini 3/4 明确不支持关闭思考，
  // 发 none 会 400 → isRetryableError 判成不可重试直接抛，或者更糟：换个档位继续。
  // 所以「关」这一档在 Gemini 上一律不发字段（走模型默认档），见 applyDialect。
  { dialect: 'gemini', host: /generativelanguage\.googleapis\.com$/i, model: null, supports: ['effort'] },
  { dialect: 'gemini', host: null, model: /gemini/i, supports: ['effort'] },
  { dialect: 'openai-reasoning', host: null, model: /^o\d|gpt-5|gpt5/i, supports: ['effort'] }
];

/**
 * 本机 **OpenAI 兼容网关**（默认 = DSH `dsh-providers-hub` 的 8326）。
 *
 * ⚠️⚠️ 为什么必须单独一档、而且必须排在 `LOCAL_HOSTS` **之前**：
 *   `local` 方言的 `supports` 是空数组 ⇒ `applyDialect` 一个字段都不发。
 *   而该网关实测（2026-10-25，deepseek-account 通道）**必须显式收到
 *   `reasoning_effort` 才吐正文**：
 *     什么都不发             → HTTP 200、finish_reason 正常、content = ""（2.98s）
 *     thinking:{type:'disabled'} → 同上，content = ""（2.91s）
 *     reasoning_effort:'none'    → 正常出字（1.18s）
 *   也就是说"当哑巴"在这里不是少省一点钱，是**把正文整条丢掉**，而且报错文案
 *   会是"没有返回文字结果"，排障方向会完全跑偏。
 *
 * ⚠️ 又因为生产的 `api.thinkingMode` 配的是 `off`，每个请求都会进
 *   `applyDialect`，所以这条必须**精确命中「本机 + 网关端口」**，
 *   绝不能顺手改 `case 'local'` —— 那会让所有指向 127.0.0.1 的端点
 *   （含将来别的本地 LLM）都收到这个字段。
 *
 * 端口可被 `DSH_OPENAI_GATEWAY_PORT` 覆盖（与网关侧同一个环境变量名）。
 */
const GATEWAY_PORT = String(process.env.DSH_OPENAI_GATEWAY_PORT || '8326').replace(/[^\d]/g, '') || '8326';
const LOCAL_OPENAI_HOSTS = new RegExp(`^(127\\.0\\.0\\.1|localhost):${GATEWAY_PORT}$`, 'i');

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname;
  } catch {
    return '';
  }
}

/** 含端口的 host（`hostOf` 只给 hostname，认不出「本机哪一个端口」）。 */
function hostWithPort(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).host;
  } catch {
    return '';
  }
}

/**
 * 选方言。
 * @returns {{ dialect:string, supports:string[], apply:(body:object, mode:string)=>void }}
 */
export function dialectFor({ baseUrl = '', model = '' } = {}) {
  // ⚠️ 必须排在 MODEL_RULES 之前：LOCAL_HOSTS 会先把 127.0.0.1 判成
  //    'local'（supports=[]），此后永远关不掉思考、网关正文直接空。
  if (LOCAL_OPENAI_HOSTS.test(hostWithPort(baseUrl))) {
    return {
      dialect: 'local-openai',
      supports: ['off', 'effort'],
      apply: (body, mode) => applyDialect('local-openai', body, mode)
    };
  }
  const host = hostOf(baseUrl);
  const id = String(model || '');
  const hit = MODEL_RULES.find((r) => (r.host && host && r.host.test(host)) || (r.model && r.model.test(id)));
  const dialect = hit?.dialect || 'generic';
  const supports = hit?.supports || ['off'];
  return { dialect, supports, apply: (body, mode) => applyDialect(dialect, body, mode) };
}

/**
 * 把"意图"（off / on / low / high / max）翻成该家的参数。
 * 未识别的方式一律**不发**，宁可少一个开关，也不发一个会被 400 的字段。
 */
export function applyDialect(dialect, body, mode) {
  const m = String(mode || '').toLowerCase();
  const on = m === 'on' || m === 'low' || m === 'high' || m === 'max';
  const off = m === 'off';
  if (!on && !off) return body;

  switch (dialect) {
    case 'deepseek':
      body.thinking = { type: on ? 'enabled' : 'disabled' };
      // 实测（deepseek-flash）：reasoning_effort:'high' 思维链 230/187 token，
      // low 是 118/113，不发是 136/107 —— 参数确实被接受且真的改变思考量。
      if (m === 'high' || m === 'max') body.reasoning_effort = 'high';
      else if (m === 'low') body.reasoning_effort = 'low';
      return body;
    case 'qwen':
      body.enable_thinking = on;
      return body;
    case 'glm':
      body.thinking = { type: on ? 'enabled' : 'disabled' };
      return body;
    case 'gemini':
      // ⚠️ 这里**不能**走 default 分支的 `thinking:{type:'disabled'}`：
      // Gemini 的 OpenAI 兼容层不认这个字段，Gemini 3/4 也无法关闭思考。
      // 「关」= 什么都不发（吃默认档），只剩费用问题，不会 400。
      if (off) return body;
      body.reasoning_effort = m === 'low' ? 'low' : 'high';
      return body;
    case 'openai-reasoning':
      if (m === 'high' || m === 'max') body.reasoning_effort = 'high';
      else if (m === 'low') body.reasoning_effort = 'low';
      else if (off) body.reasoning_effort = 'low';
      return body;
    case 'local-openai':
      // 网关（dsh-providers-hub）实测只认 reasoning_effort：none / low / high / max。
      // 发 thinking:{...} 不但无效，在部分通道还会被当成未知字段。
      // ⚠️ 任何"开"的意图都要落到一个**具体值**上：不发 = 正文空。
      if (off) body.reasoning_effort = 'none';
      else if (m === 'low') body.reasoning_effort = 'low';
      else body.reasoning_effort = 'high';        // on / high / max
      return body;
    case 'local':
      return body;                       // 自建网关一律不发花哨参数
    default:
      // 未知网关：只有"关思考"沿用旧行为（一条已被生产验证过的写法），其余不发。
      if (off) body.thinking = { type: 'disabled' };
      return body;
  }
}

/** 该方言能不能表达这个档位（给上层决定"要不要提示已降级"）。 */
export function supportsMode(dialect, mode) {
  const m = String(mode || '').toLowerCase();
  if (m === 'off' || m === 'on') return dialect.supports.includes(m);
  if (m === 'low' || m === 'high' || m === 'max') return dialect.supports.includes('effort');
  return false;
}
