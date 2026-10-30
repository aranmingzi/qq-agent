// 同上探针，但用**强制多步推理**的题，并把原始 usage / 字段打出来。
// 目的：先确认 baseline 真的会思考，再谈"关掉有没有用"。

import fs from 'node:fs';

const baseUrl = process.argv[2] || 'https://api.apibox.cc/v1';
const model = process.argv[3] || 'gemini-3-flash';
const runs = Number(process.argv[4] || 2);

const cfg = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
const apiKey = cfg.api.apiKey;

const PROMPT = [
  '请逐步推理后只给最终答案：',
  '某仓库有 A/B/C 三个货架。A 的箱子数是 B 的 3 倍，C 比 A 少 17 箱。',
  '若把 A 的 1/4 移到 C，则 A 与 C 相等。求原始总数。',
  '（要求：只输出最终数字，不要过程。）'
].join('\n');

const CASES = [
  { name: 'baseline', extra: {} },
  { name: 'effort:none', extra: { reasoning_effort: 'none' } },
  { name: 'effort:minimal', extra: { reasoning_effort: 'minimal' } },
  { name: 'effort:low', extra: { reasoning_effort: 'low' } },
  { name: 'effort:high', extra: { reasoning_effort: 'high' } },
  { name: 'thinking:disabled', extra: { thinking: { type: 'disabled' } } },
  { name: 'thinkingConfig(budget0)', extra: { thinking_config: { thinking_budget: 0 } } }
];

async function once(c) {
  const t0 = Date.now();
  const body = { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 3000, temperature: 0, ...c.extra };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  const ch = j?.choices?.[0]?.message || {};
  const content = typeof ch.content === 'string' ? ch.content : JSON.stringify(ch.content ?? '');
  const reas = ch.reasoning_content || ch.reasoning || ch.thinking || '';
  const u = j?.usage || {};
  const det = u.completion_tokens_details || u.completion_tokens_details_details || {};
  return {
    status: r.status, ms: Date.now() - t0,
    content: content.trim().slice(0, 24), contentLen: content.trim().length,
    reasoningChars: String(reas).length,
    reasoningTokens: det.reasoning_tokens ?? u.reasoning_tokens ?? null,
    completionTokens: u.completion_tokens ?? null,
    finish: j?.choices?.[0]?.finish_reason ?? null,
    rawUsage: JSON.stringify(u),
    err: j?.error?.message ? String(j.error.message).slice(0, 200) : (j ? null : text.slice(0, 200))
  };
}

console.log(`endpoint=${baseUrl} model=${model} runs=${runs}\n`);
for (const c of CASES) {
  for (let i = 0; i < runs; i++) {
    let r;
    try { r = await once(c); } catch (e) { r = { status: 'ERR', err: e.message.slice(0, 120), ms: 0 }; }
    console.log(`${c.name.padEnd(24)} #${i + 1} http=${r.status} ${String(r.ms).padStart(6)}ms ans=${String(r.content ?? '-').padEnd(10)} reason_tok=${String(r.reasoningTokens ?? '-').padStart(4)} reas_chars=${String(r.reasoningChars ?? '-').padStart(5)} usage=${r.rawUsage ?? '-'}${r.err ? ' ERR=' + r.err : ''}`);
  }
}
