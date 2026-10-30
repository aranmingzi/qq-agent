/**
 * user 段逐条字数统计。
 *
 * 为什么单独统计 user：**成本主体在 user**。
 * system 逐字节稳定 = 走前缀缓存命中价；user 每轮都变（时间/past/新消息），
 * 是**全价区**。所以砍 system 省的是命中价（很少），砍 user 才真的省钱。
 * 想优化提示词成本，先看这张表。
 *
 * 用法：node tools/user-section-stats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const { buildUserPrompt } = await import('../src/prompt.js');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

// 真机存档：把它们的 userPrompt 直接拿来切段（段之间是空行+【xx】分隔）
const sessDir = path.join(ROOT, 'data', 'sessions');
const files = fs.existsSync(sessDir)
  ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')).sort().slice(-200)
  : [];

const agg = new Map(); // 段名 -> {sum, n}
let total = 0;
let samples = 0;

for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch { continue; }
  const up = String(s.userPrompt || '');
  if (!up) continue;
  samples++;
  total += up.length;
  // 切段：形如 【当前时间】... 到下一个 【 之前
  const parts = up.split(/\n(?=【)/);
  for (const p of parts) {
    const m = /^【([^】]{1,12})】/.exec(p);
    const name = m ? m[1] : '(首段)';
    const cur = agg.get(name) || { sum: 0, n: 0 };
    cur.sum += p.length;
    if (p.trim()) cur.n++;
    agg.set(name, cur);
  }
}

if (!samples) {
  console.log('没有可用的 userPrompt 存档');
  process.exit(0);
}

const rows = [...agg.entries()]
  .map(([k, v]) => ({ name: k, avg: Math.round(v.sum / samples), rate: v.n / samples }))
  .sort((a, b) => b.avg - a.avg);

console.log(`=== user 段平均字数（${samples} 份真机存档，user 总均 ${Math.round(total / samples)} 字）===\n`);
const max = rows[0]?.avg || 1;
for (const r of rows) {
  const bar = '█'.repeat(Math.max(1, Math.round((r.avg / max) * 44)));
  console.log(
    `  ${r.name.padEnd(14)} ${String(r.avg).padStart(5)} 字  出现 ${(r.rate * 100).toFixed(0).padStart(3)}%  ${bar}`
  );
}

// 经济账
const HIT = 0.02, MISS = 1.0; // 元 / 百万 token
const tk = (n) => n / 1.6;
const userAvg = Math.round(total / samples);
console.log('\n=== 经济账（1.6 字/token；命中 0.02 元/M、未命中 1 元/M）===');
console.log(`  user 全价：每轮 ${(tk(userAvg) / 1e6 * MISS).toFixed(6)} 元 → 每天 500 轮 ≈ ${(tk(userAvg) / 1e6 * MISS * 500 * 365).toFixed(1)} 元/年`);
const sysAvg = 10030;
console.log(`  system 命中：每轮 ${(tk(sysAvg) / 1e6 * HIT).toFixed(6)} 元 → 每天 500 轮 ≈ ${(tk(sysAvg) / 1e6 * HIT * 500 * 365).toFixed(1)} 元/年`);
console.log('\n  ⚠️ 结论：砍 1 字 user ≈ 砍 50 字 system。先砍 user 里出现率低却常驻的段。');
for (const r of rows) {
  if (r.rate < 0.5 && r.avg > 100) {
    console.log(`    · 候选：${r.name} 平均 ${r.avg} 字但只有 ${(r.rate * 100).toFixed(0)}% 轮次出现`);
  }
}
