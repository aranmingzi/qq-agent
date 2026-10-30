/**
 * 前缀缓存到底命中了没有？
 *
 * 之前所有"省 system 只省命中价、省钱要砍 user"的经济账，
 * 全部建立在「system 逐字节稳定 → 命中 0.02 元/M」这个前提上。
 * 这条脚本用真机 usage 直接检验前提：cachedTokens 是不是真的 > 0。
 *
 * 前提不成立的话，经济账整个反过来 —— 砍 system 与砍 user 等价（都是全价），
 * 而 system 有 10030 字、user 只有 3892 字，**大头反而在 system**。
 *
 * 用法：node tools/cache-reality.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const sessDir = path.join(ROOT, 'data', 'sessions');
const files = fs.existsSync(sessDir)
  ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')).sort()
  : [];

const byModel = new Map();
let n = 0;
let sumPrompt = 0, sumCached = 0, sumCompletion = 0;
let anyCached = 0;

for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch { continue; }
  const u = s.usage;
  if (!u || typeof u.promptTokens !== 'number') continue;
  n++;
  sumPrompt += u.promptTokens;
  sumCached += u.cachedTokens || 0;
  sumCompletion += u.completionTokens || 0;
  if ((u.cachedTokens || 0) > 0) anyCached++;

  const model = String(s.model || '(未知)');
  const rec = byModel.get(model) || { n: 0, prompt: 0, cached: 0, completion: 0, hitRounds: 0 };
  rec.n++;
  rec.prompt += u.promptTokens;
  rec.cached += u.cachedTokens || 0;
  rec.completion += u.completionTokens || 0;
  if ((u.cachedTokens || 0) > 0) rec.hitRounds++;
  byModel.set(model, rec);
}

if (!n) { console.log('没有 usage 记录'); process.exit(0); }

console.log(`=== 真机 token 实测（${n} 轮）===\n`);
console.log(`  平均 prompt:     ${Math.round(sumPrompt / n)} token/轮`);
console.log(`  平均 cached:     ${Math.round(sumCached / n)} token/轮  ← 前缀缓存命中量`);
console.log(`  平均 completion: ${Math.round(sumCompletion / n)} token/轮`);
console.log(`  有缓存命中的轮数: ${anyCached}/${n} = ${(anyCached / n * 100).toFixed(1)}%`);
console.log(`  缓存命中率: ${(sumCached / sumPrompt * 100).toFixed(2)}%`);

console.log('\n=== 分模型 ===');
for (const [m, r] of [...byModel].sort((a, b) => b[1].n - a[1].n)) {
  const rate = r.prompt ? (r.cached / r.prompt * 100) : 0;
  console.log(
    `  ${m.padEnd(22)} ${String(r.n).padStart(4)} 轮 | prompt ${String(Math.round(r.prompt / r.n)).padStart(6)} | cached ${String(Math.round(r.cached / r.n)).padStart(6)} | 命中率 ${rate.toFixed(2).padStart(6)}% | 有命中 ${r.hitRounds} 轮`
  );
}

// 结论
const hitRate = sumCached / sumPrompt;
console.log('\n=== 结论 ===');
if (hitRate < 0.01) {
  console.log('  ❌ 前缀缓存**实际没有命中**（命中率 < 1%）。');
  console.log('     → 「砍 system 只省命中价」是错的：system 也是全价。');
  console.log('     → system 10030 字 >> user 3892 字，**优化重点应该回到 system**。');
  console.log('     → 上一轮把 1293 字 SOP 改成按需，是真省钱，不是"省了命中价"。');
} else {
  console.log(`  ✅ 缓存确实命中（${(hitRate * 100).toFixed(1)}%），原经济账成立。`);
}

// 每轮全价成本（按 DeepSeek 输入 2 元/M 口径；项目里习惯用 1 元/M）
const RATE = Number(process.env.IN_RATE || 2); // 元/百万 token
const perRound = (sumPrompt / n) / 1e6 * RATE;
console.log(`\n  每轮输入成本 ≈ ${perRound.toFixed(6)} 元（按 ${RATE} 元/M、${Math.round(sumPrompt / n)} token）`);
console.log(`  按 274 轮/天 → ${(perRound * 274 * 365).toFixed(0)} 元/年`);
console.log(`  每省 1000 token → 每年省 ${((1000 / 1e6 * RATE) * 274 * 365).toFixed(0)} 元`);
