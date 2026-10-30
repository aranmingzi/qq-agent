// 统计真机各工具包的激活率 = 提示词里按需段能被省掉的比例。
// 用 selectPacks 的真实判据（含 patterns），输入是每轮的入站文本 triggerText。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { selectPacks, PACK_NAMES, PACKS } = await import('../src/tool-scene.js');

const dir = path.join(ROOT, 'data', 'sessions');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const cnt = Object.fromEntries(PACK_NAMES.map((n) => [n, 0]));
const both = { songOrWeb: 0 };
let n = 0;

for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const t = String(s.triggerText || '');
    if (!t) continue;
    n += 1;
    const { active } = selectPacks({ text: t, prev: {} });
    for (const name of PACK_NAMES) if (active.has(name)) cnt[name] += 1;
    if (active.has('song') || active.has('webRead')) both.songOrWeb += 1;
  } catch { /* 坏存档跳过 */ }
}

console.log(`样本轮次 ${n}`);
for (const name of PACK_NAMES) {
  const r = ((cnt[name] / n) * 100).toFixed(2);
  console.log(`  ${name.padEnd(11)} ${String(cnt[name]).padStart(4)} 轮  ${r.padStart(5)}%   ${PACKS[name].label}`);
}
const r = ((both.songOrWeb / n) * 100).toFixed(2);
console.log(`\n  song 或 webRead 任一激活: ${both.songOrWeb} 轮 = ${r}%`);
console.log(`  => 这两个包的 SOP（1293 字）可省于 ${(100 - Number(r)).toFixed(1)}% 的轮次`);
