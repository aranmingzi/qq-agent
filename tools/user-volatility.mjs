/**
 * user 段「稳定性」测量 —— 找出误放在全价区的稳定段。
 *
 * 原理：system 走前缀缓存（命中价 0.02 元/M），user 每轮都变（全价 1 元/M），
 * 差 50 倍。所以 **user 里凡是内容不随会话/轮次变化的段，都是放错了位置** ——
 * 搬进 system 就能拿 50 倍杠杆。
 *
 * 判据：对每个段名，收集它在多份存档里的文本，看指纹有几种。
 *   · 1 种 = 完全稳定 → 可以搬进 system（但要确认它不依赖 chatKey/persona）
 *   · 多种 = 真的易变 → 留在 user
 *
 * 用法：node tools/user-volatility.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const sessDir = path.join(ROOT, 'data', 'sessions');
const files = fs.existsSync(sessDir)
  ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')).sort().slice(-300)
  : [];

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 10);

const seen = new Map(); // 段名 -> { digests:Set, samples:[], sumLen }
let n = 0;

for (const f of files) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch { continue; }
  const up = String(s.userPrompt || '');
  if (!up) continue;
  n++;
  // 每段：以行首的【xxx】开头，到下一个行首【 或结尾
  const parts = up.split(/\n(?=【)/);
  for (const p of parts) {
    const m = /^【([^】]{1,14})】/.exec(p);
    const name = m ? m[1] : '(无标题段)';
    const rec = seen.get(name) || { digests: new Set(), samples: [], sumLen: 0 };
    rec.digests.add(md5(p));
    rec.sumLen += p.length;
    if (rec.samples.length < 2) rec.samples.push(p.slice(0, 120));
    seen.set(name, rec);
  }
}

console.log(`=== user 段稳定性（${n} 份真机存档）===\n`);
console.log('  段名'.padEnd(22) + ' 指纹数  样本数  平均字数  判定');
const rows = [];
for (const [name, r] of seen) {
  const avg = Math.round(r.sumLen / n);
  rows.push({ name, digests: r.digests.size, avg });
}
rows.sort((a, b) => b.avg - a.avg);

for (const r of rows) {
  const stable = r.digests === 1;
  // 只出现过一次的段（样本少）不能下结论
  const enough = n >= 20;
  const verdict = !enough ? '样本不足' : (stable ? '✅ 稳定 → 可搬 system' : `易变（${r.digests} 种）`);
  console.log(
    `  ${r.name.padEnd(18)} ${String(r.digests).padStart(5)}  ${String(n).padStart(5)}  ${String(r.avg).padStart(7)}  ${verdict}`
  );
}

// 候选清单：稳定且平均字数 > 80 的段，就是搬家收益最大的
const movable = rows.filter((r) => r.digests === 1 && r.avg > 80);
const gain = movable.reduce((s, r) => s + r.avg, 0);
console.log(`\n=== 可搬进 system 的稳定段（平均 > 80 字）===`);
for (const r of movable) {
  const perRound = (r.avg / 1.6) / 1e6;
  console.log(
    `  ${r.name.padEnd(18)} ${String(r.avg).padStart(5)} 字 → 每轮全价 ${perRound.toFixed(6)} 元 → 命中后 ${(perRound * 0.02).toFixed(6)} 元，省 ${((perRound * 0.98) * 500 * 365).toFixed(1)} 元/年`
  );
}
console.log(`\n  合计可搬 ${gain} 字/轮。省：${((gain / 1.6) / 1e6 * 0.98 * 500 * 365).toFixed(1)} 元/年（按每天 500 轮）`);

// 打印最稳那几个的样例内容，人工确认它确实与会话无关
console.log('\n=== 稳定段内容抽样（确认与会话无关）===');
for (const r of movable.slice(0, 6)) {
  const rec = seen.get(r.name);
  console.log(`\n【${r.name}】${r.avg} 字`);
  console.log('  ' + rec.samples[0].replace(/\n/g, ' ').slice(0, 160));
}
