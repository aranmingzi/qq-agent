// 量化 system 提示词各段的实际字数，以及段内每条的字数。
// 目的：找出"常驻但只在特定场景才用得上"的条目 —— 它们是按场景装载的候选。
// 只跑纯函数（不联网、不改配置）；数据取自真实 data/config.json。
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const { buildSystemBundle } = await import('../src/prompt.js');
const bundle = buildSystemBundle({ includeTools: false });

const segs = bundle.sections || [];
console.log('=== system 各段字数（按从大到小）===');
const rows = segs.map((s) => ({ name: s.name, chars: (s.text || '').length })).sort((a, b) => b.chars - a.chars);
const total = rows.reduce((n, r) => n + r.chars, 0);
for (const r of rows) {
  const pct = ((r.chars / total) * 100).toFixed(1);
  console.log(`  ${r.name.padEnd(14)} ${String(r.chars).padStart(5)} 字  ${pct.padStart(4)}%  ${'#'.repeat(Math.round(r.chars / 60))}`);
}
console.log(`  ${'合计'.padEnd(13)} ${String(total).padStart(5)} 字`);

// ── tools 段逐条字数 ──
const tools = segs.find((s) => s.name === 'tools');
if (tools) {
  console.log('\n=== tools 段逐条（找出技能 SOP 的开销）===');
  const lines = tools.text.split('\n').filter((x) => x.trim());
  let sum = 0;
  for (const ln of lines) {
    sum += ln.length;
    const tag = /^(\d+(\.\d+)?)[.、]/.exec(ln.trim());
    const label = tag ? `条 ${tag[1]}` : '  (头)';
    console.log(`  ${label.padEnd(8)} ${String(ln.length).padStart(4)} 字  ${ln.slice(0, 42)}…`);
  }
  console.log(`  段内合计 ${sum} 字`);
}

// ── 人类基线的位置：把"输出规范"条目单独拎出来 ──
const OUT_KEYS = ['空格', '分条', '≤30', '30 字', '内心', '思考'];
console.log('\n=== 与"输出形态"有关的条目（跨段）===');
let outChars = 0;
for (const s of segs) {
  for (const ln of s.text.split('\n')) {
    if (!ln.trim()) continue;
    if (OUT_KEYS.some((k) => ln.includes(k))) {
      outChars += ln.length;
      console.log(`  [${s.name}] ${String(ln.length).padStart(4)} 字  ${ln.slice(0, 50)}…`);
    }
  }
}
console.log(`  输出形态条目合计 ${outChars} 字（占 system ${((outChars / total) * 100).toFixed(1)}%）`);
