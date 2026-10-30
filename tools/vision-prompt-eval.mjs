// 识图提示词 A/B：验证「念关键字」vs「先给主旨」对复杂图的实际差别。
// 只跑 DashScope，成本几分钱。用法：node tools/vision-prompt-eval.mjs [图路径...]
import fs from 'node:fs';
import path from 'node:path';

const cfgRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'config.json'), 'utf8'));
const q = cfgRaw.vision?.qwen || {};
const BASE = String(q.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const KEY = String(q.apiKey || '');
const MODEL = String(q.model || 'qwen3-vl-plus');
if (!KEY) throw new Error('没有 vision.qwen.apiKey');

const OLD = '用不超过 120 字说清这是什么、图上的关键文字；不要分点、不要小标题、不要描述配色构图和画面细节；看不清就说看不清，不要编造。';
const NEW = [
  '先读懂这张图想表达什么，再写结论。按三行给：',
  '① 主旨：一句话说这张图在说什么（谁/什么事/结论）；',
  '② 要点：最多 4 条，每条不超过 20 字，优先人物、动作、数字、结论；',
  '③ 关键原文：图里必须原样引用的文字（标题/金额/错误码/命令/榜单名），没有就写"无"，不要硬凑。',
  '总长不超过 220 字，不要 Markdown、不要小标题、不要描述配色构图。看不清就读作"不清楚"，绝不编造。'
].join('\n');

const files = process.argv.slice(2);
if (!files.length) throw new Error('给几张图');

function dataUrlOf(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function call({ prompt, url, maxTokens, highRes }) {
  const body = { model: MODEL, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: prompt }] }], max_tokens: maxTokens, stream: false };
  if (highRes) body.vl_high_resolution_images = true;
  const t = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, err: `HTTP ${res.status} ${String(j?.error?.message || j?.message || '').slice(0, 160)}`, ms: Date.now() - t };
  const ch = j?.choices?.[0];
  return {
    ok: true, ms: Date.now() - t,
    text: String(ch?.message?.content ?? '').trim(),
    finish: ch?.finish_reason,
    inTok: j?.usage?.prompt_tokens, outTok: j?.usage?.completion_tokens
  };
}

const variants = [
  { name: 'A 现状(120字念字/max400)', prompt: OLD, maxTokens: 400, highRes: false },
  { name: 'B 主旨式/max400', prompt: NEW, maxTokens: 400, highRes: false },
  { name: 'C 主旨式/max900', prompt: NEW, maxTokens: 900, highRes: false },
  { name: 'D 主旨式/max900/高清', prompt: NEW, maxTokens: 900, highRes: true },
];

for (const f of files) {
  const url = dataUrlOf(f);
  console.log(`\n${'='.repeat(70)}\n图：${f}\n${'='.repeat(70)}`);
  for (const v of variants) {
    const r = await call({ prompt: v.prompt, url, maxTokens: v.maxTokens, highRes: v.highRes });
    if (!r.ok) { console.log(`\n【${v.name}】❌ ${r.err} (${r.ms}ms)`); continue; }
    console.log(`\n【${v.name}】${r.ms}ms in=${r.inTok} out=${r.outTok} finish=${r.finish} 字数=${r.text.length}`);
    console.log(r.text);
  }
}
