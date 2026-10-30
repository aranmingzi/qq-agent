// Gemini 关思考探针：验证「关闭思考」在 Gemini 3 上到底有没有用。
//
// 用法：node tools/probe-gemini-thinking.mjs [baseUrl] [model] [runs]
// 输出每种参数写法的：HTTP 码 / 正文长度 / reasoning_tokens / 延迟。
//
// 判据不是"没报错"，而是 reasoning_tokens 是否真的降下来 ——
// 有的网关会**静默忽略**不认识的字段，返回 200 但思考照烧。

import fs from 'node:fs';

const baseUrl = process.argv[2] || 'https://api.apibox.cc/v1';
const model = process.argv[3] || 'gemini-3-flash';
const runs = Number(process.argv[4] || 1);

const cfg = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
const apiKey = cfg.api.apiKey;

// 用一道**需要想一下**的题：纯事实题模型几乎不思考，测不出差异。
const PROMPT = '一个农夫有17只羊，除了9只以外全都跑了，后来又生了3只小羊，现在有几只？只回答数字。';

const CASES = [
  { name: 'baseline（什么都不发）', extra: {} },
  { name: 'reasoning_effort: none', extra: { reasoning_effort: 'none' } },
  { name: 'reasoning_effort: minimal', extra: { reasoning_effort: 'minimal' } },
  { name: 'reasoning_effort: low', extra: { reasoning_effort: 'low' } },
  { name: 'thinking:{type:disabled}', extra: { thinking: { type: 'disabled' } } },
  { name: 'extra_body.thinking_config', extra: { thinking_config: { thinking_budget: 0 } } }
];

async function once(c) {
  const t0 = Date.now();
  const body = {
    model,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: 2000,
    temperature: 0,
    ...c.extra
  };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const ch = j?.choices?.[0]?.message;
  const content = typeof ch?.content === 'string' ? ch.content : JSON.stringify(ch?.content ?? '');
  const reasoning = ch?.reasoning_content || ch?.reasoning || '';
  const u = j?.usage || {};
  const det = u.completion_tokens_details || u.completion_tokens_details === undefined ? (u.completion_tokens_details || {}) : {};
  return {
    status: r.status,
    ms: Date.now() - t0,
    contentLen: content.trim().length,
    content: content.trim().slice(0, 40),
    reasoningChars: String(reasoning).length,
    reasoningTokens: det.reasoning_tokens ?? u.reasoning_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    promptTokens: u.prompt_tokens ?? null,
    finish: j?.choices?.[0]?.finish_reason ?? null,
    err: j?.error?.message ? String(j.error.message).slice(0, 160) : (j ? null : text.slice(0, 160))
  };
}

console.log(`endpoint=${baseUrl}  model=${model}  runs=${runs}\n`);
const rows = [];
for (const c of CASES) {
  for (let i = 0; i < runs; i++) {
    let res;
    try { res = await once(c); } catch (e) { res = { status: 'ERR', err: String(e.message).slice(0, 120), ms: 0 }; }
    rows.push({ case: c.name, ...res });
    console.log(
      `${c.name.padEnd(26)} http=${String(res.status).padEnd(4)} ${String(res.ms).padStart(6)}ms ` +
      `content=${String(res.contentLen ?? '-').padStart(4)}字 reason_tok=${String(res.reasoningTokens ?? '-').padStart(4)} ` +
      `completion=${String(res.completionTokens ?? '-').padStart(4)} finish=${res.finish ?? '-'}` +
      (res.err ? `  ERR=${res.err}` : '')
    );
  }
}

// 汇总：按写法求 reasoning_tokens 均值
const byCase = new Map();
for (const r of rows) {
  if (!byCase.has(r.case)) byCase.set(r.case, []);
  byCase.get(r.case).push(r);
}
console.log('\n—— 均值汇总 ——');
for (const [k, v] of byCase) {
  const ok = v.filter((x) => x.status === 200);
  const avg = (f) => {
    const nums = ok.map(f).filter((n) => typeof n === 'number' && !Number.isNaN(n));
    return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : '-';
  };
  console.log(`${k.padEnd(26)} 成功${ok.length}/${v.length}  reason_tok=${avg((x) => x.reasoningTokens)}  completion=${avg((x) => x.completionTokens)}  ${avg((x) => x.ms)}ms`);
}
