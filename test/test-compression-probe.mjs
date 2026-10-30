// 压缩质量探针（P1，2026-10-26）。
//
// ── 为什么不是再写一堆"字段对不对"的断言 ──────────────────────────────────
// ROUGE / 向量相似度测不出**功能性**质量：摘要可以字面很像，却偏偏漏了那句承诺。
// 学 `Agent-Skills-for-Context-Engineering` 的做法：压缩完之后**直接提问**，
// 答得出来 = 压对了；开始猜 = 压坏了。（它那边的四类探针是 Recall / Artifact /
// Continuation / Decision；这里是聊天场景，Artifact 换成"承诺"。）
//
// ── 两条自我约束（否则这套测试自己就是假的）───────────────────────────────
//   ① **人类基线列**：同一批探针先跑未压缩的原文，必须 4/4 —— 证明探针是**可满足**的，
//      不是我编了一组谁都答不出的题。
//   ② **坏样本必须红**：喂一份明显压坏的文本，探针必须失败 —— 证明探针不是**恒真**
//      （仿 rule-audit 的 `sample{bad,good}`：先证明探针有效，再谈得分）。
//
// 语料是手写的一段群聊（聚餐邀约），刻意塞进四类信息：谁在要、答应了什么、
// 定了什么、下一步做什么。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-probe-'));

const { PastSummaryStore } = await import('../src/past-summary.js');
const { valueOf, degradeByValue, selectPast } = await import('../src/past-window.js');

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[compression-probe]');

// ── 语料 ──────────────────────────────────────────────────────────────────
/** 未压缩的原文（人类基线：这四件事都在这里，探针必须问得出来）。 */
const FULL = [
  '[10:02] 张三：周末还聚不聚啊',
  '[10:03] 李四：聚吧，去哪',
  '[10:05] 王五：西山怎么样',
  '[10:06] 我：我可以，就是早上起不来',
  '[10:07] 李四：那我八点半叫你',
  '[10:08] 我：好，你记得叫我',
  '[10:09] 张三：那就定西山了',
  '[10:10] 王五：门票谁买',
  '[10:11] 我：门票我来买吧',
  '[10:12] 张三：哈哈哈',
  '[10:13] 王五：666'
].join('\n');

/** 好的槽位化压缩（模拟模型按四个槽位输出后 normalizeSlots 的结果）。 */
const GOOD = [
  '【谁在要什么】',
  '- 张三问周末还聚不聚',
  '- 王五问门票谁买',
  '【答应了什么】',
  '- 李四答应八点半叫我',
  '- 我答应门票我来买',
  '【定了什么】',
  '- 定了去西山',
  '【发生了什么】',
  '- 大家聊了周末安排'
].join('\n');

/**
 * 旧行为模拟：平铺条目 + 超预算从末尾整条丢。
 * 丢完正好没的就是"答应了什么"（它排在中间）—— 这正是槽位化要修的故障。
 */
const OLD_STYLE = [
  '- 张三问周末还聚不聚',
  '- 大家聊了周末安排，气氛不错'
].join('\n');

/** 压坏的那份：笼统一句，什么都沾点又什么都不具体。 */
const BAD = '- 大家聊了周末聚餐的事，聊得挺开心的';

// ── 探针 ──────────────────────────────────────────────────────────────────
// expect 里所有关键词都出现才算答得出来（AND，不是 OR）。
const PROBES = [
  { id: 'recall', ask: '谁提的周末聚餐？', expect: ['张三', '聚'] },
  { id: 'promise', ask: '八点半是谁答应叫谁的？', expect: ['李四', '八点半'] },
  { id: 'decision', ask: '最后定了去哪？', expect: ['西山'] },
  { id: 'continuation', ask: '下一步该做什么？', expect: ['门票'] }
];

function runProbes(text) {
  const src = String(text ?? '');
  const passed = [];
  const failed = [];
  for (const p of PROBES) {
    (p.expect.every((kw) => src.includes(kw)) ? passed : failed).push(p.id);
  }
  return { passed, failed };
}

const rows = [];
for (const [label, text] of [['原文(基线)', FULL], ['好压缩', GOOD], ['旧行为', OLD_STYLE], ['压坏', BAD]]) {
  rows.push([label, runProbes(text)]);
}

// ── 断言 ──────────────────────────────────────────────────────────────────
ok('★ 人类基线：未压缩的原文 4/4 答得出来（证明探针可满足，不是我编的死题）', () => {
  const r = runProbes(FULL);
  assert.deepStrictEqual(r.failed, [], `基线都没过，探针本身有问题：${r.failed}`);
  assert.strictEqual(r.passed.length, PROBES.length);
});

ok('★ 好压缩 4/4 保住（槽位化没把承诺压没）', () => {
  const r = runProbes(GOOD);
  assert.deepStrictEqual(r.failed, [], `压完丢了：${r.failed}`);
});

ok('★ 坏样本必须红：笼统摘要一个探针都过不了（证明探针不是恒真）', () => {
  const r = runProbes(BAD);
  assert.strictEqual(r.passed.length, 0, `坏样本竟然过了 ${r.passed} —— 探针是恒真的，等于没测`);
  assert.strictEqual(r.failed.length, PROBES.length);
});

ok('★ 旧行为确实会丢承诺（这就是槽位化的理由，不是空谈）', () => {
  const r = runProbes(OLD_STYLE);
  assert.ok(r.failed.includes('promise'), '旧行为没丢承诺 —— 那槽位化就没必要了');
  assert.ok(r.failed.includes('decision'), '决定也该丢');
  assert.ok(r.passed.includes('recall'), '谁提的还在（说明不是全丢，只是丢了关键的）');
});

ok('★ 端到端：摘要塞进 formatForPrompt 压到 120 字，承诺仍在、事实先没', () => {
  const store = new PastSummaryStore();
  const key = 'group_probe';
  store.commit(key, { summary: GOOD, uptoId: 9 });
  const out = store.formatForPrompt(key, { maxChars: 120 });
  assert.ok(out.length <= 120, `超预算：${out.length}`);
  const r = runProbes(out);
  assert.ok(!r.failed.includes('promise'), '压完把承诺丢了：\n' + out);
  assert.ok(!r.failed.includes('recall'), '压完把"谁在要"丢了：\n' + out);
});

ok('★ 窗口侧：装不下时承诺行留下、噪声先走（第三级判据）', () => {
  const item = (t, value, short) => ({
    line: `[10:0${item.n = (item.n || 0) + 1}] 群友：${t}`,
    shortLine: short ? `[10:00] 群友：${short}` : null,
    protect: false,
    value: valueOf({ text: t, media: [], senderName: '群友' })
  });
  const items = [
    item('哈哈哈', 'x'),
    item('早上好呀大家', 'x'),
    item('那我八点半叫你起床，记得', 'x'),
    item('666', 'x'),
    item('今天天气真不错，适合出去玩', 'x')
  ];
  const r = selectPast(items, { limit: 2, maxChars: 100000 });
  assert.ok(r.text.includes('八点半'), '承诺行被丢了：\n' + r.text);
  assert.ok(!r.text.includes('哈哈哈'), '噪声没被优先丢');
  assert.strictEqual(r.dropped.filter((d) => d.value === 'low').length >= 2, true, '丢的应该多数是 low');
});

ok('★ 中文数字时间要算高价值（"八点半"是承诺，不是闲聊）', () => {
  assert.strictEqual(valueOf({ text: '那我八点半叫你', media: [] }), 'high');
  assert.strictEqual(valueOf({ text: '三点集合怎么样', media: [] }), 'high');
  assert.strictEqual(valueOf({ text: '今天天气真不错', media: [] }), 'mid');
});

// ── 打印对照表（人类基线列必须看得见，否则这份测试没人信）────────────────
console.log('\n  探针对照（✓=答得出来，✗=丢了）');
console.log('  探针          ' + rows.map(([l]) => l.padEnd(12)).join(''));
for (const p of PROBES) {
  const cells = rows.map(([, r]) => (r.passed.includes(p.id) ? '✓' : '✗').padEnd(12)).join('');
  console.log(`  ${p.id.padEnd(13)}${cells}`);
}
console.log('');

console.log(`[compression-probe] ${pass} 项通过`);
try { fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true }); } catch { /* 清不掉不影响结果 */ }
