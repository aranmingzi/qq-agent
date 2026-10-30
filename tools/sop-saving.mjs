// 用真机每一轮的入站文本装配 system，量出"技能 SOP 按需装载"的真实收益。
// 只跑纯函数：selectPacks（真实判据）+ buildSystemBundle。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const { selectPacks } = await import('../src/tool-scene.js');
const { buildSystemBundle } = await import('../src/prompt.js');

const dir = path.join(ROOT, 'data', 'sessions');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

const OLD_LEN = 11474;      // 改动前的实测 system 字数
let sum = 0;
let n = 0;
let withSop = 0;
const buckets = {};

for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  const t = String(s.triggerText || '');
  if (!t) continue;
  const { active } = selectPacks({ text: t, prev: {} });
  const len = buildSystemBundle({ packs: active }).text.length;
  sum += len;
  n += 1;
  if (active.has('song') || active.has('webRead')) withSop += 1;
  const k = String(Math.floor(len / 500) * 500);
  buckets[k] = (buckets[k] || 0) + 1;
}

const avg = Math.round(sum / n);
console.log(`样本轮次 ${n}`);
console.log(`改动前 system 固定 ${OLD_LEN} 字`);
console.log(`改动后 平均 ${avg} 字（省 ${OLD_LEN - avg} 字，${(((OLD_LEN - avg) / OLD_LEN) * 100).toFixed(1)}%）`);
console.log(`带上 SOP 的轮次 ${withSop} 轮 = ${((withSop / n) * 100).toFixed(2)}%`);
console.log(`每轮平均省下的输入 ${OLD_LEN - avg} 字 ≈ ${Math.round((OLD_LEN - avg) / 1.6)} token（中文约 1.6 字/token）`);
console.log('\n按长度分布：');
for (const k of Object.keys(buckets).sort((a, b) => a - b)) {
  console.log(`  ${k}~${Number(k) + 499} 字: ${buckets[k]} 轮 ${'#'.repeat(Math.round(buckets[k] / 20))}`);
}
