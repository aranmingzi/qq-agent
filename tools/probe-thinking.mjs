// 通用「关思考」探针：任意 OpenAI 兼容端点 × 全部可能的关思考写法。
// 用法：node tools/probe-thinking.mjs <baseUrl> <model> [runs] [hard|easy]
//
// 判两件事，缺一不可：
//   ① HTTP 码（400 = 这条写法在该端点不可用）
//   ② 思考 token 是否真的降到 0（部分网关 200 但静默忽略字段，等于没关）
//
// ⚠️ 必须用硬题：简单题 baseline 也是 0 思考，会得出"参数全被忽略"的错结论。

import fs from 'node:fs';

const baseUrl = process.argv[2] || 'https://tokenrhythm.studio/v1';
const model = process.argv[3] || 'deepseek-v4.1-flash-1017';
const runs = Number(process.argv[4] || 1);
const mode = String(process.argv[5] || 'hard');

const cfg = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
// 按 baseUrl 匹配供应商取 key（同一模型在不同网关行为不同）
const prov = (cfg.providers || []).find((p) => String(p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
const apiKey = prov?.apiKey || cfg.api.apiKey;

const PROMPTS = {
  easy: '一个农夫有17只羊，除了9只以外全都跑了，后来又生了3只小羊，现在有几只？只回答数字。',
  hard: [
    '请逐步推理后只给最终答案：某仓库有 A/B/C 三个货架。A 的箱子数是 B 的 3 倍，C 比 A 少 17 箱。',
    '若把 A 的 1/4 移到 C，则 A 与 C 相等。求原始总数（正确值为 187/3≈62.33）。只输出最终数字。'
  ].join('\n')
};
const PROMPT = PROMPTS[mode] || PROMPTS.hard;

const CASES = [
  ['baseline（什么都不发）', {}],
  ['thinking:{type:disabled}', { thinking: { type: 'disabled' } }],
  ['thinking:{type:enabled}', { thinking: { type: 'enabled' } }],
  ['reasoning_effort:none', { reasoning_effort: 'none' }],
  ['reasoning_effort:minimal', { reasoning_effort: 'minimal' }],
  ['reasoning_effort:low', { reasoning_effort: 'low' }],
  ['reasoning_effort:high', { reasoning_effort: 'high' }],
  ['enable_thinking:false', { enable_thinking: false }],
  ['thinking_budget:0', { thinking_budget: 0 }],
  ['extra_body.thinking', { extra_body: { thinking: { type: 'disabled' } } }]
];

function thoughtsOf(j) {
  const u = j?.usage || {};
  return u.completion_tokens_details?.reasoning_tokens
    ?? u.billing_usage?.gemini_usage_metadata?.thoughtsTokenCount
    ?? u.reasoning_tokens
    ?? null;
}

async function once(extra) {
  const t0 = Date.now();
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 3000, temperature: 0, ...extra }),
    signal: AbortSignal.timeout(180000)
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  const ch = j?.choices?.[0]?.message || {};
  const content = String(ch.content ?? '').trim();
  const reas = String(ch.reasoning_content ?? ch.reasoning ?? '');
  return {
    status: r.status,
    ms: Date.now() - t0,
    thoughts: thoughtsOf(j),
    reasChars: reas.length,
    comp: j?.usage?.completion_tokens ?? null,
    ans: content.slice(0, 14).replace(/\n/g, ' '),
    finish: j?.choices?.[0]?.finish_reason ?? null,
    err: j?.error ? String(j.error.message || JSON.stringify(j.error)).slice(0, 110) : (j ? null : txt.slice(0, 110))
  };
}

console.log(`endpoint=${baseUrl}\nmodel=${model}  runs=${runs}  prompt=${mode}  key=${apiKey ? '✓' : '✗'}\n`);
for (const [name, extra] of CASES) {
  const rows = [];
  for (let i = 0; i < runs; i++) {
    let r; try { r = await once(extra); } catch (e) { r = { status: 'EXC', err: e.message.slice(0, 90), ms: 0 }; }
    rows.push(r);
  }
  const line = rows.map((r) => r.status === 200
    ? `${String(r.ms).padStart(6)}ms think=${String(r.thoughts ?? '-').padStart(4)} reas=${String(r.reasChars).padStart(5)}字 comp=${String(r.comp ?? '-').padStart(4)} ans=${r.ans}`
    : `http=${r.status}${r.err ? ' ERR=' + r.err : ''}`).join(' | ');
  console.log(`${name.padEnd(26)} ${line}`);
}
