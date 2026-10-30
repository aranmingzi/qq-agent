// 多提供商模型目录：从 DSH 的 settings.yaml 导入模型列表，统一成 OpenAI 兼容调用。
// 说明：DSH 里 api: anthropic-messages 的提供商，本程序按 OpenAI 兼容模式调用
// （A6API 这类中转站两种协议都支持；baseURL 缺 /v1 时自动补上）。
// 密钥来源优先级：DSH .credentials.yaml 的 refs > 环境变量（含别名）。
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { getConfig, updateConfig } from './config.js';

// DSH 未写 baseURL 的提供商，按官方默认端点补全（可在 UI 修改）。
// 来源：
// - mimo.mi.com/docs Token Plan 快速接入（tp- 密钥专用网关，与 sk- 开放平台相互独立不可混用）
// - help.aliyun.com/zh/model-studio/token-plan-personal-quick-start（sk-sp- 密钥专用网关，与按量付费 sk- 不可混用）
// - opencode.ai/docs/go（OpenCode Go 订阅网关）
const PROVIDER_URL_DEFAULTS = {
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  'qwen-token-plan-cn': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1'
};

// 密钥环境变量的常见别名（如 DSH 写 A6API_API_KEY，本机实际是 A6API_APIKEY）
const KEY_ENV_ALIASES = {
  A6API_API_KEY: ['A6API_API_KEY', 'A6API_APIKEY']
};

function envApiKey(envName) {
  for (const name of KEY_ENV_ALIASES[envName] || [envName]) {
    const value = process.env[name];
    if (value) return { key: String(value), from: `环境变量 ${name}` };
  }
  return { key: '', from: '' };
}

/** 读取 DSH 的 .credentials.yaml（refs.<环境变量名> = 密钥）。 */
export function readDshCredentials(yamlPath) {
  const credPath = path.join(path.dirname(yamlPath), '.credentials.yaml');
  try {
    const doc = loadYaml(fs.readFileSync(credPath, 'utf8'));
    const refs = doc?.refs;
    return refs && typeof refs === 'object' ? refs : {};
  } catch {
    return {};
  }
}

function normalizeBaseURL(raw, { wasAnthropic, providerId }) {
  let url = String(raw || '').trim();
  if (!url) url = PROVIDER_URL_DEFAULTS[providerId] || '';
  if (!url) return '';
  if (wasAnthropic && !/\/v1\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/v1';
  return url.replace(/\/+$/, '');
}

/** 解析 DSH settings.yaml，返回规范化的提供商数组。 */
export function parseDshSettings(yamlPath) {
  const text = fs.readFileSync(yamlPath, 'utf8');
  const doc = loadYaml(text);
  const providers = doc?.['llm-pi-ai']?.providers ?? {};
  const creds = readDshCredentials(yamlPath);
  const out = [];
  for (const [id, p] of Object.entries(providers)) {
    const rawModels = Array.isArray(p?.models) ? p.models : [];
    const models = rawModels
      .map((m) => (typeof m === 'string' ? m : String(m?.id || m?.model || '')))
      .filter(Boolean);
    if (!models.length) continue;
    const wasAnthropic = String(p?.api || '').includes('anthropic');
    const envName = String(p?.apiKeyEnv || '');
    // 密钥优先级：DSH 凭据文件 > 环境变量
    let key = '';
    let keyFrom = '';
    if (creds[envName]) {
      key = String(creds[envName]);
      keyFrom = 'DSH 凭据文件';
    } else {
      ({ key, from: keyFrom } = envApiKey(envName));
    }
    const entry = {
      id,
      displayName: String(p?.displayName || id),
      api: 'openai',
      anthropicOrigin: wasAnthropic,
      baseURL: normalizeBaseURL(p?.baseURL, { wasAnthropic, providerId: id }),
      apiKey: key,
      apiKeyFrom: keyFrom,
      models,
      needsBaseUrl: false
    };
    if (!entry.baseURL) entry.needsBaseUrl = true;
    out.push(entry);
  }
  return out;
}

/** 从 DSH 导入并写入配置（整体替换 providers）。返回导入摘要。 */
export function importFromDsh(yamlPath) {
  const providers = parseDshSettings(yamlPath);
  updateConfig({ providers });
  return {
    imported: providers.length,
    models: providers.reduce((n, p) => n + p.models.length, 0),
    withKeys: providers.filter((p) => p.apiKey).length,
    providers: providers.map((p) => ({ id: p.id, models: p.models.length, hasKey: !!p.apiKey, baseURL: p.baseURL }))
  };
}

/** 当前生效的提供商目录（配置里的 providers）。 */
export function currentProviders() {
  return getConfig().providers || [];
}

/** 给指定提供商设置 API Key（存进配置）。 */
export function setProviderKey(providerId, apiKey) {
  const providers = currentProviders().map((p) =>
    p.id === providerId ? { ...p, apiKey: String(apiKey || '').trim(), apiKeyFrom: 'manual' } : p);
  updateConfig({ providers });
  return providers.find((p) => p.id === providerId) || null;
}

// ── 手动管理提供商/模型（设置页“模型 API”） ──────────────────────────────

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function hostDisplayName(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.hostname || '自定义提供商';
  } catch {
    return '自定义提供商';
  }
}

function normalizeModelInput(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m) continue;
    if (typeof m === 'string') {
      const id = m.trim();
      if (id) out.push({ id, name: id });
    } else if (typeof m === 'object') {
      const id = String(m.id ?? m.model ?? '').trim();
      if (id) out.push({ id, name: String(m.name ?? m.id ?? id).trim() || id });
    }
  }
  return out;
}

/** 用指定 baseUrl/key 获取模型列表（OpenAI /models）。 */
export async function fetchModelsFrom(baseUrl, apiKey, timeoutMs = 15000) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先填写 Base URL');
  const res = await fetch(`${base}/models`, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => String(m.id ?? m.model ?? m)).filter(Boolean);
}

/**
 * 把 429 / 503 这类"不是配置错"的状态翻成人话。
 * 两个调用方（testModelChat 测单个模型、testProvider 测端点）都会碰到，
 * **判据只写这一处** —— 写两遍的后果是 A/B 拆一处另一处兜住，测试永远绿。
 *
 * 几个必须处理的细节（2026-10-27 实测）：
 * - Gemini 的错误体是**数组包裹**的 `[{error:{...}}]`，直接读 `.error` 只能拿到 undefined；
 * - 429 的 message 里带 `limit: 0` 表示"免费层没这个模型的配额"，和"今天用超了"不是一回事；
 * - 503 是服务端高需求（"Spikes in demand are usually temporary"），不是配置问题。
 * @returns {{ verdict: string, note: string } | null} 认不出来返回 null，交回调用方兜底
 */
function explainHttpError(status, rawText) {
  let message = '';
  let body = null;
  try {
    body = JSON.parse(rawText);
    if (Array.isArray(body)) body = body[0];
    message = String(body?.error?.message ?? '');
  } catch {
    message = String(rawText || '');
  }
  if (status === 429) {
    const freeTier = /free[ _-]?tier/i.test(rawText);
    const zeroQuota = /limit:\s*0\b/.test(message);
    const model = (String(rawText).match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const which = model ? `${model} ` : '';
    const note = zeroQuota
      ? `额度为 0：${which}在当前层级（免费层）日额度 limit: 0，需在 AI Studio 开 Cloud Billing 才能调用`
      : freeTier
        ? `额度用尽：${which}免费层额度已用完，可在 /rate-limit 查看，或开 Cloud Billing 提额`
        : `额度用尽（HTTP 429）${message ? '：' + message.slice(0, 100) : ''}`;
    return { verdict: 'quota', note };
  }
  if (status === 503) {
    return { verdict: 'model-busy', note: 'HTTP 503：模型当前过载（服务端高需求，非配置问题），稍后重试或换低一档模型' };
  }
  return null;
}

/** 用用户提供的 baseUrl + apiKey + modelId 发送一次最小 chat 测试请求。 */
export async function testModelChat({ baseUrl, apiKey, model }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先填写 Base URL');
  if (!String(model || '').trim()) throw new Error('请先填写模型 ID');
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), 20000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: String(model).trim(),
        messages: [{ role: 'user', content: '只输出 pong 这一个词，不要任何解释或引号。' }],
        // 16 太小：Gemini 3 系**关不掉思考**，思考 token 算在 max_tokens 里，
        // 16 会被思考吃光 → HTTP 200 但 content 空（2026-10-27 实测 3.6-flash）。
        // 探针于是显示"请求成功（无文本返回）"，看着像没接通，实际只是额度喂了思考。
        max_tokens: 400,
        stream: false
      }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    // 先读文本再解析：429 的错误体是数组包裹的，直接 res.json() 后读 .error 会得到空串，
    // 于是 note 只剩"HTTP 429"，用户会去怀疑网络和 key（实测就是这么显示的）。
    const raw = await res.text().catch(() => '');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 非 JSON，留着 raw 给下面兜底 */ }
    if (Array.isArray(body)) body = body[0] || {};
    if (!res.ok) {
      const explained = explainHttpError(res.status, raw);
      if (explained) return { ok: false, httpStatus: res.status, latencyMs, ...explained };
      const errText = String(body?.error?.message ?? body?.message ?? '').slice(0, 200);
      return { ok: false, httpStatus: res.status, latencyMs, note: `HTTP ${res.status}${errText ? `：${errText}` : ''}` };
    }
    const reply = String(body?.choices?.[0]?.message?.content ?? '').trim().slice(0, 60);
    return { ok: true, httpStatus: res.status, latencyMs, note: reply ? `模型回复：「${reply}」` : '请求成功（无文本返回）' };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 测试一个提供商端点（按 providerId 查目录，或直接给 baseUrl/apiKey）。 */
export async function testOneProvider({ providerId = '', baseUrl = '', apiKey = '' } = {}) {
  let p = currentProviders().find((x) => x.id === providerId);
  if (!p) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
    p = { id: providerId || '__tmp__', displayName: hostDisplayName(base), baseURL: base, apiKey: apiKey || '', models: [] };
  }
  return testProvider(p);
}

/**
 * 新建提供商；若同 baseURL（或同 id）已存在则合并模型。返回 { provider, created }。
 * id / displayName 可选：不传则 id 自动生成、显示名取域名。
 * 预置供应商（如基元律动）用固定 id 建，后续就能按 id 直接引用，不必记随机串。
 */
export function upsertProvider({ baseUrl, apiKey, models = [], id = '', displayName = '' }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Base URL 不能为空');
  const wantId = String(id || '').trim();
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const existing = providers.find((p) => (wantId && p.id === wantId) || normalizeBaseUrl(p.baseURL) === base);
  if (existing && displayName) existing.displayName = String(displayName).trim();
  const entries = normalizeModelInput(models);
  if (existing) {
    for (const m of entries) {
      if (!existing.models.includes(m.id)) existing.models.push(m.id);
    }
    existing.apiKey = String(apiKey || existing.apiKey || '').trim();
    existing.apiKeyFrom = 'manual';
    existing.modelNames = { ...(existing.modelNames || {}) };
    for (const m of entries) existing.modelNames[m.id] = m.name;
    updateConfig({ providers });
    return { provider: existing, created: false };
  }
  const newId = wantId && !providers.some((p) => p.id === wantId)
    ? wantId
    : `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const modelNames = {};
  for (const m of entries) modelNames[m.id] = m.name;
  const provider = {
    id: newId,
    displayName: String(displayName || '').trim() || hostDisplayName(base),
    api: 'openai',
    anthropicOrigin: false,
    baseURL: base,
    apiKey: String(apiKey || '').trim(),
    apiKeyFrom: 'manual',
    models: entries.map((m) => m.id),
    modelNames,
    needsBaseUrl: false
  };
  providers.push(provider);
  updateConfig({ providers });
  return { provider, created: true };
}

/** 给指定提供商追加模型（合并 modelNames）。 */
export function addModelsToProvider(providerId, models = []) {
  const entries = normalizeModelInput(models);
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.modelNames = { ...(p.modelNames || {}) };
  for (const m of entries) {
    if (!p.models.includes(m.id)) p.models.push(m.id);
    p.modelNames[m.id] = m.name;
  }
  updateConfig({ providers });
  return p;
}

/** 从提供商移除一个模型。 */
export function removeModelFromProvider(providerId, modelId) {
  return removeModelsFromProvider(providerId, [modelId]);
}

/**
 * 批量移除模型：一次 `updateConfig` 落一次盘。
 * 为什么批量：逐个删会中间态落盘 N 次，中途崩了就是"删了一半"，
 * 而且 `modelNames` 会残留——界面上模型没了、名字表里还留着。
 */
export function removeModelsFromProvider(providerId, modelIds = []) {
  const ids = new Set((Array.isArray(modelIds) ? modelIds : []).map((x) => String(x || '').trim()).filter(Boolean));
  if (!ids.size) return null;
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.models = p.models.filter((id) => !ids.has(id));
  if (p.modelNames) {
    p.modelNames = { ...p.modelNames };
    for (const id of ids) delete p.modelNames[id];
  }
  updateConfig({ providers });
  return p;
}

/**
 * 重排模型。**这个顺序就是降级链的链位**：`model-fallback.js` 按 models 数组
 * 取前 `MAX_PER_PROVIDER`（=2）个，改顺序就等于改"先试谁"。
 *
 * ⚠️ 只传了部分 id 是正常用法（拖拽/上移下移组件通常只交出变动项），
 * 所以**没传到的必须保留并接在末尾**。不这么做的话，"把第 3 个提到第 1 个"
 * 会把第 4 个以后的模型静默删光——不报错，只是某天发现模型没了。
 * ⚠️ 未知 id（不属于这家）直接忽略，不能写进 models。
 */
export function reorderProviderModels(providerId, orderedIds = []) {
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  const existed = new Set(p.models);
  const seen = new Set();
  const next = [];
  for (const raw of Array.isArray(orderedIds) ? orderedIds : []) {
    const id = String(raw || '').trim();
    if (!id || !existed.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  for (const id of p.models) if (!seen.has(id)) next.push(id);
  p.models = next;
  updateConfig({ providers });
  return p;
}

/**
 * 改名 / 改地址 / 换密钥。**空值不覆盖**（调用方负责把掩码转成空串）。
 *
 * 地址改动要挡两件事：
 *   ① 新旧地址归一化后相同 → 视为没改，别把 baseURL 写成一个斜杠不同的变体；
 *   ② 与别家撞车 → 报错。降级链按 `baseUrl + model` 去重，两家同地址会让
 *      "跨提供商切换"变成"原地重试同一个端点"，看着配了 5 家其实只有 4 家能用。
 */
export function updateProviderMeta(providerId, { displayName, baseUrl, apiKey } = {}) {
  const providers = currentProviders().map((p) => ({ ...p }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;

  const nextName = String(displayName ?? '').trim();
  if (nextName) p.displayName = nextName;

  const nextBaseRaw = String(baseUrl ?? '').trim();
  if (nextBaseRaw) {
    const base = normalizeBaseUrl(nextBaseRaw);
    if (!base) throw new Error('Base URL 不合法');
    const clash = providers.find((x) => x.id !== providerId && normalizeBaseUrl(x.baseURL) === base);
    if (clash) throw new Error(`Base URL 已被「${clash.displayName || clash.id}」占用`);
    p.baseURL = base;
  }

  const nextKey = String(apiKey ?? '').trim();
  if (nextKey) {
    p.apiKey = nextKey;
    p.apiKeyFrom = 'manual';
  }

  updateConfig({ providers });
  return p;
}

/**
 * 删除整个提供商。
 *
 * ⚠️ 当前 `api.provider` 指向它时必须一并清空：留一个悬空 id 的话，
 * `buildFallbackChain()` 按 providerId 找不到家，会退化成"只有当前端点 + 其他家"——
 * 表面上还能跑，实际这家被删了却仍在链里占位，排查时极易误判。
 * （`api.baseUrl` / `api.apiKey` 不动：那是实际调用用的，删目录不等于改接入点。）
 */
export function deleteProvider(providerId) {
  const id = String(providerId || '').trim();
  if (!id) return null;
  const all = currentProviders();
  const target = all.find((p) => p.id === id);
  if (!target) return null;
  const providers = all.filter((p) => p.id !== id);
  const apiProviderCleared = String(getConfig().api?.provider || '') === id;
  updateConfig(apiProviderCleared ? { providers, api: { provider: '' } } : { providers });
  return { provider: target, apiProviderCleared };
}

// ── 连通性测试：GET {baseURL}/models（OpenAI 兼容探测） ────────────────────

/**
 * 测试一个提供商的端点连通性与密钥有效性。
 * 返回 { ok, httpStatus, modelCount, latencyMs, verdict, note }。
 * verdict: ok（可用）/ bad-key（密钥被拒）/ no-models-route（端点可达但无 /models 路由）
 *          / quota（429 额度用尽或为 0）/ model-busy（503 模型过载）/ no-endpoint / error
 */
export async function testProvider(p, timeoutMs = 12000) {
  if (!p.baseURL) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), timeoutMs);
  try {
    const res = await fetch(`${p.baseURL}/models`, {
      headers: {
        ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {})
      },
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      let count = 0;
      try {
        const data = await res.json();
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        count = list.length;
      } catch { /* body 不是 JSON */ }
      return { ok: true, httpStatus: res.status, modelCount: count, latencyMs, verdict: 'ok', note: count ? `列到 ${count} 个模型` : '端点可用（未返回模型列表）' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, httpStatus: res.status, latencyMs, verdict: 'bad-key', note: `HTTP ${res.status}：密钥无效或无权限` };
    }
    // ⚠️ Google Gemini 对**无效密钥**返 400 而不是 401，文案是
    // "Please pass a valid API key"（2026-10-27 实测）。
    // 只看状态码会把它归成 verdict:'error' → 用户看到「HTTP 400」，
    // 排障方向会变成"端点是不是抽风了"，而不是"key 填错了"。
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      if (/api[ _-]?key|invalid.*key|unauthor|permission|credential/i.test(text)) {
        return { ok: false, httpStatus: 400, latencyMs, verdict: 'bad-key', note: 'HTTP 400：密钥无效（Gemini 系用 400 表达"key 不对"，不是 401）' };
      }
      return { ok: false, httpStatus: 400, latencyMs, verdict: 'error', note: `HTTP 400：${text.slice(0, 120) || '请求被拒'}` };
    }
    // ⚠️ 429 / 503 不能并进 'error'：前者是"这个模型你没额度"，后者是"服务端过载"，
    // 都不是"端点坏了"。判据在 explainHttpError 里（与 testModelChat 共用，只写一处）。
    if (res.status === 429 || res.status === 503) {
      const text = await res.text().catch(() => '');
      const explained = explainHttpError(res.status, text) || { verdict: 'error', note: `HTTP ${res.status}` };
      return { ok: false, httpStatus: res.status, latencyMs, ...explained };
    }
    if (res.status === 404) {
      // Gemini 的 OpenAI 兼容层在**没带 Authorization 头**时也返 404（不是 401）。
      // 别把它读成"没有 /models 路由"——配上 key 就有。
      const needKey = !p.apiKey;
      return {
        ok: false,
        httpStatus: 404,
        latencyMs,
        verdict: 'no-models-route',
        note: needKey
          ? '端点可达，但没有密钥时它不肯列模型（先填 key 再测）'
          : '端点可达但没有 /models 路由（chat/completions 未必不可用）'
      };
    }
    return { ok: false, httpStatus: res.status, latencyMs, verdict: 'error', note: `HTTP ${res.status}` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    // 超时基本只有两种原因：端点慢，或者境外端点根本没通（fetch 不走 HTTP_PROXY）。
    // 不把排查方向写进提示，用户只能在"key 是不是错了"里打转。
    const hint = '（若端点在境外：fetch 不读 HTTP_PROXY，需配 net.proxyUrl，见 /api/status 的 net 字段）';
    return {
      ok: false,
      latencyMs,
      verdict: 'error',
      note: msg === '超时' || /CONNECT_TIMEOUT|ETIMEDOUT|timeout/i.test(msg) ? `连接超时${hint}` : `网络错误：${msg}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发测试全部提供商（限 4 并发）。 */
export async function testAllProviders(providers, limit = 4) {
  const results = {};
  const queue = [...providers];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      results[p.id] = { ...(await testProvider(p)), displayName: p.displayName };
    }
  });
  await Promise.all(workers);
  return results;
}
