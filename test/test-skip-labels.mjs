// 跳过阶段中文标签自测（第 13 轮）。
//
// 这张表存在的全部意义是回答"它刚才为什么没理我"。
// 所以测试的重点不是"函数能跑"，而是：
//   · 枚举里每个值都有标签 —— 少一个，面板上就多一格看不懂的英文；
//   · 标签必须是**人话**，不能把 stage 原文抄一遍冒充翻译；
//   · 排序/汇总这些消费方会各写一遍的逻辑，结果必须确定。
import assert from 'node:assert';

const {
  SKIP_LABELS, describeStage, stageLabel, stageTable, explainStats, summarizeStats
} = await import('../src/skip-labels.js');
const { SKIP_STAGES } = await import('../src/skip-log.js');

let pass = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (error) {
    failures.push({ name, error });
    console.error('  ✗', name, '\n      ', error?.message ?? error);
    process.exitCode = 1;
  }
}

console.log('[skip-labels]');

// ── 覆盖完整性 ──────────────────────────────────────────────────────────
await ok('枚举里每一个 stage 都有标签（加枚举必须加标签）', () => {
  const stages = Object.values(SKIP_STAGES);
  const missing = stages.filter((s) => !SKIP_LABELS[s]);
  assert.deepStrictEqual(missing, [], `这些 stage 没有中文标签：${missing.join(' / ')}`);
});

await ok('没有多余标签（枚举删了标签没删 → 面板图例会多出幽灵项）', () => {
  const stages = new Set(Object.values(SKIP_STAGES));
  const extra = Object.keys(SKIP_LABELS).filter((s) => !stages.has(s));
  assert.deepStrictEqual(extra, [], `这些标签对应的 stage 已经不在枚举里了：${extra.join(' / ')}`);
});

await ok('每个标签都有 label 与 hint，且 spent 是布尔', () => {
  for (const [stage, meta] of Object.entries(SKIP_LABELS)) {
    assert.ok(meta.label && meta.label.length > 0, `${stage} 缺 label`);
    assert.ok(meta.hint && meta.hint.length > 0, `${stage} 缺 hint`);
    assert.strictEqual(typeof meta.spent, 'boolean', `${stage} 的 spent 必须是布尔`);
  }
});

await ok('标签不能是 stage 原文的复读（那样等于没翻译）', () => {
  // `gate` → `gate` 这种"翻译"在面板上和没做一样，必须拦住。
  const lazy = Object.entries(SKIP_LABELS)
    .filter(([stage, meta]) => String(meta.label).trim().toLowerCase() === stage.replace(/-/g, ' ').trim().toLowerCase())
    .map(([stage]) => stage);
  assert.deepStrictEqual(lazy, [], `这些 stage 的 label 只是把原文抄了一遍：${lazy.join(' / ')}`);
});

await ok('标签里不许出现英文短横线串（否则等于没翻）', () => {
  const bad = Object.entries(SKIP_LABELS)
    .filter(([, meta]) => /^[a-z][a-z-]*$/.test(String(meta.label).trim()))
    .map(([stage]) => stage);
  assert.deepStrictEqual(bad, [], `这些 label 还是英文枚举串：${bad.join(' / ')}`);
});

// ── 语义正确性（这几条是最容易被改错的） ────────────────────────────────
await ok('"没花钱"的判定：额度满/退避/暂停/判据不接都是 spent=false', () => {
  for (const stage of ['send-quota', 'proactive-backoff', 'paused', 'gate', 'no-unread', 'concurrency', 'no-model']) {
    assert.strictEqual(describeStage(stage).spent, false, `${stage} 应该标记为没花模型钱`);
  }
});

await ok('"花了钱"的判定：整轮报错/出口拦截/模型沉默/判据自身出错都是 spent=true', () => {
  for (const stage of ['run-error', 'egress', 'model-silent', 'gate-error', 'send-fail', 'budget-retry', 'send-gate']) {
    assert.strictEqual(describeStage(stage).spent, true, `${stage} 应该标记为花过模型钱`);
  }
});

await ok('额度满的说明里点明了"没花模型钱"（这是用户最想知道的一句）', () => {
  const d = describeStage('send-quota');
  assert.match(d.hint, /没花模型钱/, '额度满的 hint 必须点明没花钱');
});

await ok('模型沉默的说明里点明了"这是正常结果，不是故障"', () => {
  // 这条最重要：model-silent 是花钱的正常结果，不能被当成故障报给用户
  const d = describeStage('model-silent');
  assert.match(d.hint, /正常/, 'model-silent 必须说明是正常结果');
  assert.strictEqual(d.action, '', 'model-silent 不该给"怎么办"，因为它不用管');
});

// ── 兜底 ────────────────────────────────────────────────────────────────
await ok('未知 stage 也给人话，不留空白', () => {
  const d = describeStage('some-plugin-stage');
  assert.strictEqual(d.label, 'some-plugin-stage', '未知 stage 的 label 退回原文（有信息量）');
  assert.match(d.hint, /未知/);
  assert.strictEqual(d.spent, false, '未知默认当没花钱（宁可少报警）');
});

await ok('空 / null / undefined 不炸，且 label 是"未知"而不是空串', () => {
  for (const v of ['', null, undefined, '   ']) {
    const d = describeStage(v);
    assert.strictEqual(d.label, '未知', `${String(v)} 应该显示"未知"`);
    assert.match(d.hint, /没有阶段字段/);
  }
});

await ok('describeStage 返回副本，改它不会污染全局表', () => {
  const d = describeStage(SKIP_STAGES.GATE);
  d.label = '被改坏了';
  assert.notStrictEqual(describeStage(SKIP_STAGES.GATE).label, '被改坏了', '全局表被改动了');
});

await ok('stageLabel 是短标签，未知时退回原文', () => {
  assert.strictEqual(stageLabel('send-quota'), describeStage('send-quota').label);
  assert.strictEqual(stageLabel('whatever'), 'whatever');
});

// ── 面板用的表 ──────────────────────────────────────────────────────────
await ok('stageTable 覆盖全部枚举，顺序与枚举一致', () => {
  const table = stageTable();
  assert.strictEqual(table.length, Object.values(SKIP_STAGES).length);
  assert.deepStrictEqual(table.map((r) => r.stage), Object.values(SKIP_STAGES));
  for (const row of table) {
    assert.ok(row.label && row.label.length > 0, `${row.stage} 在表里没有 label`);
  }
});

// ── 统计翻译 ────────────────────────────────────────────────────────────
await ok('explainStats 按次数降序，且过滤掉 0 与脏值', () => {
  const rows = explainStats({ gate: 3, 'send-quota': 9, paused: 0, 'model-silent': 'abc' });
  assert.deepStrictEqual(rows.map((r) => r.stage), ['send-quota', 'gate']);
  assert.strictEqual(rows[0].count, 9);
  assert.ok(rows[0].label, '统计行也要带 label，面板不该自己查表');
});

await ok('explainStats 同次数时按枚举顺序，两次调用结果一致', () => {
  const a = explainStats({ 'send-quota': 2, gate: 2 });
  const b = explainStats({ gate: 2, 'send-quota': 2 });
  assert.deepStrictEqual(a.map((r) => r.stage), b.map((r) => r.stage), '同输入不同 key 顺序应得到同结果');
  const order = Object.values(SKIP_STAGES);
  assert.ok(order.indexOf(a[0].stage) < order.indexOf(a[1].stage), '同次数应按枚举顺序');
});

await ok('explainStats 对空 / undefined 返回空数组', () => {
  assert.deepStrictEqual(explainStats(), []);
  assert.deepStrictEqual(explainStats({}), []);
  assert.deepStrictEqual(explainStats(null), []);
});

await ok('summarizeStats 区分"都花了钱"与"有省下的"', () => {
  assert.match(summarizeStats({}), /没有记录到/);
  assert.match(summarizeStats({ 'send-quota': 5, gate: 3 }), /8 次没开口，其中 8 次没花模型钱/);
  assert.match(summarizeStats({ 'run-error': 2 }), /都花过模型钱/);
  // 混合：这是最真实的形态
  const mixed = summarizeStats({ 'send-quota': 7, 'run-error': 2, gate: 1 });
  assert.match(mixed, /共 10 次没开口，其中 8 次没花模型钱/);
});

await ok('summarizeStats 忽略 0 与负数（脏数据不该把总数抬起来）', () => {
  assert.match(summarizeStats({ gate: 0, 'run-error': -5 }), /没有记录到/);
});

console.log(`\n[skip-labels] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
