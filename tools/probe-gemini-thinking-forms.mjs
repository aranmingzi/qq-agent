// 在「关不掉思考」的型号上，穷举所有可能被识别的字段写法，看有没有一条真能关。
// 判据：reasoning_tokens(thoughtsTokenCount) 是否显著低于 baseline。
import fs from 'node:fs';

const baseUrl = process.argv[2] || 'https://api.apibox.cc/v1';
const model = process.argv[3] || 'gemini-3.8-flash';
const cfg = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
const apiKey = cfg.api.apiKey;

// 简单题模型根本不思考，参数是否被识别完全测不出来（曾因此得出"都被忽略"的错结论）。
// 默认用硬题：只有它会稳定触发思考。
const EASY = '一个农夫有17只羊，除了9只以外全都跑了，后来又生了3只小羊，现在有几只？只回答数字。';
const HARD = [
  '请逐步推理后只给最终答案：某仓库有 A/B/C 三个货架。A 的箱子数是 B 的 3 倍，C 比 A 少 17 箱。',
  '若把 A 的 1/4 移到 C，则 A 与 C 相等。求原始总数。只输出最终数字。'
].join('\n');
const PROMPT = String(process.argv[4] || 'hard') === 'easy' ? EASY : HARD;

const CASES = [
  ['baseline', {}],
  ['reasoning_effort:none', { reasoning_effort: 'none' }],
  ['reasoning_effort:low', { reasoning_effort: 'low' }],
  ['thinking_level:low', { thinking_level: 'low' }],
  ['thinking_level:minimal', { thinking_level: 'minimal' }],
  ['thinking:{type:disabled}', { thinking: { type: 'disabled' } }],
  ['thinking:{budget_tokens:0}', { thinking: { type: 'enabled', budget_tokens: 0 } }],
  ['extra_body.thinkingConfig', { extra_body: { thinking_config: { thinking_level: 'low' } } }],
  ['extra_body.thinking_level', { extra_body: { thinking_level: 'low' } }],
  ['generationConfig.thinkingConfig', { generation_config: { thinking_config: { thinking_level: 'low' } } }],
  ['reasoning:{effort:none}', { reasoning: { effort: 'none' } }],
  ['thinking_budget:0', { thinking_budget: 0 }],
  ['enable_thinking:false', { enable_thinking: false }]
];

console.log(`model=${model}\n`);
for (const [name, extra] of CASES) {
  const t0 = Date.now();
  let out = '';
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 2000, temperature: 0, ...extra }),
      signal: AbortSignal.timeout(180000)
    });
    const j = await r.json().catch(() => null);
    const thoughts = j?.usage?.billing_usage?.gemini_usage_metadata?.thoughtsTokenCount
      ?? j?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
    const ans = (j?.choices?.[0]?.message?.content ?? '').toString().trim().slice(0, 12);
    out = r.status === 200
      ? `http=200 ${String(Date.now() - t0).padStart(6)}ms thoughts=${String(thoughts).padStart(4)} ans=${ans}`
      : `http=${r.status} ERR=${String(j?.error?.message || '').slice(0, 90)}`;
  } catch (e) {
    out = `EXC ${e.message.slice(0, 80)}`;
  }
  console.log(`${name.padEnd(32)} ${out}`);
}
