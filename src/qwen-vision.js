import { getConfig } from './config.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABACAYAAACdi3yvAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAOJSURBVHhe7ZnRceMwDERdngpSOe7FrbgTnWI7ieTDggBI30pz+2bwlZASyEeIpC+LEEQkoKAiAQUVCSioSEBBRQIKKhJQUJGAgooEFFQkoKAiAQUVCSioSEBBRQIKKhJQUJGAgooEFFQkoKAyTsDbvFwul2LMy+3VTQ+32er7N+bKQ0Be4b7u12V6bz9dl/vrzykCY1zKkchBBPyOgoiV52YEQP1H++gW8LbM7+1DMWZRf5qDCfgV0YG7L9fJah+P6RrQwMkr1L5DwPt12rcrROgdiRxQwDWaE9Qv30+0vlluXoHFUhSwtZ3IxJEl/KyAjYH2Btnzwp0cs6EvrDtBrYXVErggoF/5gPTWc35iWo7qIFXAB2iC0cRCIYrV6BHOBLUEXMN1MCtg5R03QHlbC4UEX0BUncy2aEOe2HCjCU4Lv4msUPD/UaVO5LdifyFyffwrDiAgWrXGgAEZsovbfh6oMBEB14Cf8YyAg/LbPfOgle+bUwloruzgM3aAKmhKFBQQVpiEgMPyOxEnEtD+/NZOeInPfljANaxqExZwZH7n4Tx7QFC1ql+Y8D4J5HUDm/2/3icq4OD8zgJdwPCpzaxE9euF8D4Q5gUORJGFY43L4PzOAlFA724uKELPBEX78/Iy+3j7bH5SQFA1URyxmn5WwGpYI1WZII9of9b/bQRqfsoloMvxBERV86ACQgm+Z1sCuhxLQG+EBgvYvwf8Be1jH+lEBQQyudJIwA0dAoauGioT5NB7Ct6/sXOS/6SAEPuA9P8JaA10GXDqLI1q5z1g9P/WmOY5JiB6p1J+EvAZQwX8esRb/48Av0B4gGoT/iUE5GW/nxGgfexCPoIEfMZgAc1nrJH9tcAWBewnM3lF92TJ9vlfQyTgM0YLCAY2dRgBEsN3TeYFL9a34bRPLQ4EyFECDgBPcGCSkHxe23Re3gX7K7z2sIrGJPS2ARJwEO5ey3wmqpzPcD9xlbyg6K9otHerKGgb2X9KwGEEqkw0WrNSzCu/SPaEPuXJkICDiax6L0Kb+2pe3oEkOi6tShqND89DD6cW8EH05LmLxNVGR16wiqXGpaPaH7HkvXF+ATe0KmL+OmOlK6/EhXeEwGIr5UhknIBCFJCAgooEFFQkoKAiAQUVCSioSEBBRQIKKhJQUJGAgooEFFQkoKAiAQUVCSioSEBBRQIKKhJQUJGAgooEFESW5Q987Pk/Es1JAwAAAABJRU5ErkJggg==';

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}${suffix}`;
}

export function qwenVisionConfig(raw = null) {
  const current = raw || getConfig().vision?.qwen || {};
  const envKey = process.env.DASHSCOPE_API_KEY || process.env.QIANWEN_API_KEY || '';
  const configuredKey = String(current.apiKey || '').trim();
  return {
    baseUrl: String(current.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    apiKey: configuredKey || String(envKey || '').trim(),
    keySource: configuredKey ? 'config' : (process.env.DASHSCOPE_API_KEY ? 'DASHSCOPE_API_KEY' : (process.env.QIANWEN_API_KEY ? 'QIANWEN_API_KEY' : '')),
    model: String(current.model || 'qwen3-vl-plus').trim(),
    timeoutMs: Math.max(5000, Number(current.timeoutMs) || 60000),
    maxTokens: Math.max(64, Number(current.maxTokens) || 1200),
    maxImages: Math.max(1, Math.min(8, Number(current.maxImages) || 4))
  };
}

export function qwenVisionInfo(raw = null) {
  const cfg = qwenVisionConfig(raw);
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    keySource: cfg.keySource,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    maxImages: cfg.maxImages
  };
}

export function buildQwenVisionMessages({ dataUrls, prompt }) {
  const images = (Array.isArray(dataUrls) ? dataUrls : [])
    .map((url) => String(url || '').trim())
    .filter(Boolean);
  if (!images.length) throw new Error('没有可识别的图片');
  const content = images.map((url) => ({ type: 'image_url', image_url: { url } }));
  content.push({
    type: 'text',
    text: String(prompt || '用不超过 120 字说清这是什么、图上的关键文字；看不清就说看不清，不要编造。')
  });
  return [{ role: 'user', content }];
}

export async function analyzeWithQwenVision({ dataUrls, prompt, rawConfig = null, timeoutMs = null } = {}) {
  const cfg = qwenVisionConfig(rawConfig);
  if (!cfg.apiKey) {
    throw new Error('Qwen-VL 未配置 API Key，请在 设置 → 模型 API → 识图模式 中填写');
  }
  if (!cfg.baseUrl || !cfg.model) {
    throw new Error('Qwen-VL Base URL 或模型名未配置');
  }
  const images = (Array.isArray(dataUrls) ? dataUrls : []).filter(Boolean).slice(0, cfg.maxImages);
  const startedAt = Date.now();
  const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: buildQwenVisionMessages({ dataUrls: images, prompt }),
      max_tokens: cfg.maxTokens,
      stream: false
    }),
    signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || cfg.timeoutMs))
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = String(body?.error?.message ?? body?.message ?? '').slice(0, 300);
    throw new Error(`Qwen-VL HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }
  const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('Qwen-VL 没有返回文字结果');
  return {
    text,
    model: body?.model || cfg.model,
    usage: body?.usage || null,
    latencyMs: Date.now() - startedAt
  };
}

export async function testQwenVision(rawConfig = null) {
  const startedAt = Date.now();
  try {
    const result = await analyzeWithQwenVision({
      rawConfig,
      dataUrls: [`data:image/png;base64,${TINY_PNG}`],
      prompt: '只需确认你能收到图片，回复 pong。',
      timeoutMs: 25000
    });
    return {
      ok: true,
      model: result.model,
      note: `Qwen-VL 可用：${result.text.slice(0, 80)}`,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      latencyMs: Date.now() - startedAt
    };
  }
}
