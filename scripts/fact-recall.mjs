// 召回看板（2026-10-27）：概率式召回到底跑起来没有？
//
// 这个脚本存在的唯一理由 —— 概率化之后有三种**完全静默**的失败：
//   ① 候选池比名额还小 → 抽样根本不触发（`full=true`），功能形同不存在；
//   ② 联想从来没成功过（`assocCandidates` 常年 0）→ 关键词过滤把什么都筛掉了；
//   ③ 注入条数悄悄变少 → 模型"记得的东西"变少了，但没有任何报错。
// 这三条都只能靠计数发现。`npm run recall:report`。
//
// 用法：
//   node scripts/fact-recall.mjs            最近 7 天
//   node scripts/fact-recall.mjs --days 30
//   node scripts/fact-recall.mjs --json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecallLedger, trimRecallLedger, RECALL_LEDGER_FILE } from '../src/recall-ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);
const DAYS = Math.max(1, Number(argOf('days', 7)) || 7);

const pct = (v) => `${(Number(v) || 0).toFixed(1)}%`;
const pad = (s, n) => String(s ?? '').padEnd(n, ' ');
const L = (s = '') => console.log(s);

function summarize(rows) {
  if (!rows.length) return null;
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const avg = (k) => sum(k) / rows.length;
  const full = rows.filter((r) => r.full).length;
  const sampledRows = rows.filter((r) => !r.full);
  const assocRows = rows.filter((r) => Number(r.assocBudget) > 0);
  const assocHit = assocRows.filter((r) => Number(r.associated) > 0).length;
  return {
    n: rows.length,
    people: new Set(rows.map((r) => r.qq || r.chatKey)).size,
    avgTotal: avg('total'),
    avgPool: avg('pool'),
    avgLimit: avg('limit'),
    fullRate: (full / rows.length) * 100,
    avgCore: avg('coreKept'),
    avgSampled: avg('sampled'),
    avgCandidates: sampledRows.length ? sampledRows.reduce((a, r) => a + (Number(r.candidates) || 0), 0) / sampledRows.length : 0,
    assocOpenRate: assocRows.length ? (assocHit / assocRows.length) * 100 : 0,
    avgAssociated: avg('associated'),
    avgAssocCands: avg('assocCandidates'),
    avgDropped: avg('droppedTokens')
  };
}

function printLayer(title, rows) {
  const s = summarize(rows);
  if (!s) {
    L(`## ${title}`);
    L('   （没有任何记录 —— 提醒：没有记录本身也是一种信息，');
    L('    说明上游开关关着，或者这条路径根本没被调用过）');
    L('');
    return null;
  }
  L(`## ${title}`);
  L(`   观测次数 ${s.n}，涉及 ${s.people} 个对象`);
  L(`   候选池平均 ${s.avgPool.toFixed(1)} 条 / 名额 ${s.avgLimit.toFixed(1)}，实际注入 ${s.avgTotal.toFixed(1)} 条`);
  L(`   其中：必入的核心项 ${s.avgCore.toFixed(1)} + 抽样选中 ${s.avgSampled.toFixed(1)} + 联想带来 ${s.avgAssociated.toFixed(1)}`);
  L('');
  L(`   ⚠️ 抽样没生效的占比（候选池 ≤ 名额，这些人**用不上**这个功能）: ${pct(s.fullRate)}`);
  L(`      抽样真正参与竞争的平均候选数: ${s.avgCandidates.toFixed(1)}`);
  L(`      联想：开放轮次里 ${pct(s.assocOpenRate)} 至少想起 1 条，平均 ${s.avgAssociated.toFixed(2)} 条；`);
  L(`            平均可用邻居 ${s.avgAssocCands.toFixed(1)} 个，被判为无区分力而剔除的关键词 ${s.avgDropped.toFixed(1)} 个`);
  L('');
  return s;
}

if (has('trim')) {
  const r = trimRecallLedger();
  L(`台账整理：${r.trimmed ? '已砍半' : '未超限'}，当前 ${Math.round(r.bytes / 1024)} KB`);
}

const since = Date.now() - DAYS * 86400000;
const all = readRecallLedger({ sinceMs: since });
const factsRows = all.filter((r) => r.layer === 'facts');
const groupRows = all.filter((r) => r.layer === 'group');

L('');
L(`召回台账 · 最近 ${DAYS} 天（${RECALL_LEDGER_FILE.replace(ROOT + path.sep, '')}）`);
L('═'.repeat(64));
L('');

const f = printLayer('按人记的事实（memory-facts）', factsRows);
const g = printLayer('群级记忆（group-facts）', groupRows);

// ── 结论：这三条是最容易长期看着没事、其实一直在输的地方 ───────────────
L('── 该看的三个数 ──');
if (f) {
  if (f.fullRate > 70) {
    L(`  ① fullRate ${pct(f.fullRate)} —— **大多数人身上的候选池还没填满名额**。
     概率化对这些人是 no-op。要么把 injectLimit 调小，要么承认现在的事实库太瘦
     （真机 27 人 131 条，中位数 2 条），下一步该做的是「多记」而不是「更巧地取」。`);
  } else {
    L(`  ① fullRate ${pct(f.fullRate)} —— 抽样在多数人身上是生效的，OK。`);
  }
  if (f.avgAssocCands < 0.5) {
    L(`  ② 联想可用邻居只有 ${f.avgAssocCands.toFixed(1)} 个 —— 共享关键词几乎没建立起来。
     先怀疑 recallMaxDocRatio 把有区分力的词一起筛掉了（事实一律以昵称开头这条纪律的副作用）。`);
  } else if (f.assocOpenRate > 95) {
    L(`  ② 联想命中率 ${pct(f.assocOpenRate)} —— 几乎每轮都能想起额外一条，随机味偏淡；
     可以调低 recallAssocMax 的邻居数上限，或抬高 α 的门槛让它更难被带出来。`);
  } else {
    L(`  ② 联想：${pct(f.assocOpenRate)} 的轮次会想起额外一条（平均 ${f.avgAssociated.toFixed(2)} 条）—— 手感正常。`);
  }
  const under = Math.abs(f.avgTotal - f.avgLimit) > 0.5;
  L(`  ③ 注入 ${f.avgTotal.toFixed(1)} / 名额 ${f.avgLimit.toFixed(1)} —— `
    + (under ? '**名额没填满**，查查核心项是不是被捞空了。' : '名额用满了。'));
} else {
  L('  没有 facts 层的观测数据。');
}
L('');

if (has('json')) {
  console.log(JSON.stringify({ days: DAYS, facts: summarize(factsRows), group: summarize(groupRows) }, null, 2));
}
