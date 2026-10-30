// 规则违规率看板自测（P4）。
//
// 断言围绕"这个数字能不能拿来删规则"：
//   ① **每条规则必须有样本**，且自检通过 —— 没有样本的 0% 是安慰剂，
//      它会让你放心删掉一条真正在起作用的规则；
//   ② **分母口径**必须对：气泡级 / 轮次级 / 表情级的率不能混着比；
//   ③ **只统计真的发出去的气泡**（session.sent），不数模型内心正文；
//   ④ 定位失败要如实返回 null，不能瞎指一段 —— 手写的段名映射会过期，
//      过期映射比没有映射更糟（你会照着错误的字数去删一段）。
import assert from 'node:assert';
import {
  RULES, isGauge, shapeRun, measure, selfTest, auditRuns, locateRules, dayKeyOf,
  bucketOf, bucketRates, LEN_BUCKETS
} from '../src/rule-audit.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[rule-audit]');

const ruleOf = (id) => RULES.find((r) => r.id === id);
const run = (texts, stickers = [], at = 0) => ({ texts, stickers, spoke: texts.length + stickers.length > 0, at });

// ── 1. 规则表自身的纪律 ─────────────────────────────────────
ok('① 每条规则都有 id / 名称 / 口径 / 目标 / 原文探针 / 样本', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.ok(r.id && !ids.has(r.id), `id 重复或缺失：${r.id}`);
    ids.add(r.id);
    for (const k of ['name', 'unit', 'quote', 'probe']) assert.ok(r[k], `${r.id} 缺 ${k}`);
    assert.ok(['bubble', 'run', 'run-all', 'sticker'].includes(r.unit), `${r.id} 口径非法：${r.unit}`);
    assert.ok(Number.isFinite(Number(r.target)), `${r.id} 缺 target`);
    assert.ok(r.sample, `${r.id} 没有样本 —— 它的 0% 不可信`);
  }
});

ok('② 检出器自检全部通过（坏样本抓得到、好样本不误判）', () => {
  const r = selfTest();
  assert.ok(r.ok, JSON.stringify(r.failures, null, 1));
});

ok('③ 自检能抓出"正则写错了"的检出器（否则 0% 无法证伪）', () => {
  const broken = [{
    id: 'x', probe: 'x', name: 'x', unit: 'bubble', target: 0, quote: '',
    detect: () => false,                      // 永远不命中 = 典型的写错的检出器
    sample: { bad: '该被抓住的', good: '不该被抓住的' }
  }];
  const r = selfTest(broken);
  assert.ok(!r.ok);
  assert.strictEqual(r.failures[0].kind, 'bad-sample');
});

ok('④ 没有样本的规则会被自检点名', () => {
  const r = selfTest([{ id: 'y', name: 'y', unit: 'bubble', target: 0, detect: () => false }]);
  assert.ok(!r.ok);
  assert.strictEqual(r.failures[0].kind, 'no-sample');
});

// ── 2. 口径与分母 ────────────────────────────────────────────
ok('⑤ 气泡级：分母 = 文本气泡数（不是轮数）', () => {
  const runs = [run(['在的 咋了', '好']), run(['嗯', '行 吧', '走'])];
  const m = measure(ruleOf('space-split'), runs);
  assert.strictEqual(m.total, 5);
  assert.strictEqual(m.hits, 2);
});

ok('⑥ 轮次级：分母 = 轮数', () => {
  const runs = [run(['a', 'b', 'c']), run(['a']), run([])];
  const m = measure(ruleOf('bubbles-over-2'), runs);
  assert.strictEqual(m.total, 3);
  assert.strictEqual(m.hits, 1);
});

ok('⑦ 表情级：同一 id 同一天超过 2 张才算违规（超出部分计数）', () => {
  const day = Date.parse('2026-10-24T10:00:00');
  const runs = [run([], ['x', 'x'], day), run([], ['x', 'x', 'x'], day)];
  const m = measure(ruleOf('sticker-repeat'), runs);
  assert.strictEqual(m.total, 5, '分母是表情总次数');
  assert.strictEqual(m.hits, 3, '5 张同 id，上限 2，超出 3');
});

ok('⑧ 同一 id 分散在不同天不算违规（不然换日不换表情会被误判）', () => {
  const a = Date.parse('2026-10-23T10:00:00');
  const b = Date.parse('2026-10-24T10:00:00');
  const runs = [run([], ['x', 'x'], a), run([], ['x', 'x'], b)];
  assert.strictEqual(measure(ruleOf('sticker-repeat'), runs).hits, 0);
});

ok('⑨ 观测量（说话率）只记水位，不判达标', () => {
  const r = ruleOf('speak-rate');
  assert.ok(isGauge(r));
  const m = measure(r, [run(['a']), run([], ['s']), run([])]);
  assert.strictEqual(m.total, 3);
  assert.strictEqual(m.hits, 2, '发过消息（含只发表情）才算开口');
});

// ── 3. 只数真的发出去的东西 ─────────────────────────────────
ok('⑩ shapeRun 只认 sent，不认模型正文', () => {
  const s = shapeRun({
    sent: [{ type: 'text', text: '在的' }, { type: 'sticker', text: '[表情包：鲸鱼（dayu_006）]' }],
    messages: [{ role: 'assistant', content: '想了很长一段但没发' }],
    chatKey: 'group:1', startedAt: 1, id: 'x'
  });
  assert.deepStrictEqual(s.texts, ['在的']);
  assert.deepStrictEqual(s.stickers, ['dayu_006']);
  assert.ok(s.spoke);
});

ok('⑪ 表情 id 从「（dayu_006）」里抽出来，抽不到就退回前 24 字', () => {
  const s = shapeRun({ sent: [{ type: 'sticker', text: '随便一张图' }] });
  assert.strictEqual(s.stickers[0], '随便一张图');
});

ok('⑫ 空会话 / 缺字段不炸', () => {
  assert.deepStrictEqual(shapeRun({}).texts, []);
  assert.deepStrictEqual(shapeRun(null).stickers, []);
  const rep = auditRuns([]);
  assert.strictEqual(rep.runs, 0);
  assert.ok(rep.rules.every((r) => r.rate === 0));
});

ok('⑬ 没有 sent 的旧会话被跳过（别把"没存档"算成"没违规"）', () => {
  const rep = auditRuns([{ startedAt: 1, messages: [] }, { startedAt: 2, sent: [], chatKey: 'group:1' }]);
  assert.strictEqual(rep.runs, 1, '只有带 sent 数组的那轮算进来');
});

// ── 4. 汇总与趋势 ───────────────────────────────────────────
ok('⑭ byDay 按本地日分组，趋势才对得上"昨天"', () => {
  const t1 = Date.parse('2026-10-23T23:00:00');
  const t2 = Date.parse('2026-10-24T01:00:00');
  const rep = auditRuns([
    { sent: [{ type: 'text', text: '在的 咋了' }], startedAt: t1 },
    { sent: [{ type: 'text', text: '在的' }], startedAt: t2 }
  ]);
  assert.deepStrictEqual(Object.keys(rep.byDay).sort(), ['2026-10-23', '2026-10-24']);
  assert.strictEqual(rep.byDay['2026-10-23']['space-split'].rate, 100);
  assert.strictEqual(rep.byDay['2026-10-24']['space-split'].rate, 0);
});

ok('⑮ dayKeyOf 用本地时区（跨时区不该差一天）', () => {
  const d = new Date(2026, 9, 24, 3, 0, 0);
  assert.strictEqual(dayKeyOf(d.getTime()), '2026-10-24');
});

ok('⑯ 超标/达标按 target 判，观测量给 null', () => {
  const rep = auditRuns([{ sent: [{ type: 'text', text: '在的 咋了' }], startedAt: Date.now() }]);
  const sp = rep.rules.find((r) => r.id === 'space-split');
  assert.strictEqual(sp.ok, false);
  assert.strictEqual(rep.rules.find((r) => r.id === 'speak-rate').ok, null);
});

// ── 5. 定位 ─────────────────────────────────────────────────
ok('⑰ 定位到真实段落；找不到返回 null（不许瞎指一段）', () => {
  const sections = [
    { name: 'tools', text: '……【空格不是分句符号】想说两句就传数组……', where: 'system' },
    { name: 'roleText', text: '不用 Markdown 标题/列表', where: 'persona' }
  ];
  const m = locateRules(RULES, sections);
  assert.strictEqual(m.get('space-split').where, 'system:tools');
  assert.strictEqual(m.get('markdown').where, 'persona:roleText');
  assert.strictEqual(m.get('sales-talk'), null, '找不到就该是 null');
});

ok('⑱ 同一句出现在两段里 → 标记 ambiguous（重复规则是通胀来源之一）', () => {
  const sections = [
    { name: 'a', text: '必回铁律', where: 'system' },
    { name: 'b', text: '必回铁律', where: 'system' }
  ];
  const m = locateRules([ruleOf('speak-rate')], sections);
  assert.ok(m.get('speak-rate').ambiguous);
  assert.strictEqual(m.get('speak-rate').ambiguous.length, 2);
});

// ── 6. 容易误判的边界（都是实测踩过的）────────────────────────
ok('⑲ 空格分句不误判英文单词/型号之间的必要空格', () => {
  const d = ruleOf('space-split').detect;
  assert.ok(!d('DeepSeek V3 挺好用'), '英文之间空格是允许的');
  assert.ok(d('在的 咋了'), '中文之间空格才算');
});

ok('⑳ 颜文字不算括号旁白，含中文的才算', () => {
  const d = ruleOf('paren-aside').detect;
  assert.ok(!d('困了(≧▽≦)'), '颜文字放行');
  assert.ok(!d('x(123)'), '符号/数字放行');
  assert.ok(d('（伸了个懒腰）困了'), '中文动作要抓');
});

ok('㉑ 内部评分泄漏不误判普通打分和"聊自己的用量"', () => {
  const d = ruleOf('metric-leak').detect;
  assert.ok(!d('8.50 分也太低了吧'), '普通评分不是泄漏');
  assert.ok(!d('68亿token 你这是把整个群的脑细胞都喂进去了'), '拿用量开玩笑不是泄漏（实测误报）');
  assert.ok(d('这轮质检 9/9 项通过'), '念自己的成绩单才是泄漏');
});

// ── 2026-10-25：原稿 vs 发出去的、长度分档 ───────────────────────
// 起因：出站闸门会把空格分句改成逗号，于是 space-split 一定掉下来。
// 但"掉下来"不等于"提示词那条规则起作用了" —— 必须能分别看到两个数。

ok('㉒ shapeRun 同时给出 texts 和 rawTexts（raw 缺失时回落成 text）', () => {
  const r = shapeRun({
    sent: [
      { type: 'text', text: '十五下，你这是要凑整啊', raw: '十五下 你这是要凑整啊' },
      { type: 'text', text: '笑啥 说清楚' }
    ]
  });
  assert.deepStrictEqual(r.texts, ['十五下，你这是要凑整啊', '笑啥 说清楚']);
  assert.deepStrictEqual(r.rawTexts, ['十五下 你这是要凑整啊', '笑啥 说清楚'], '没 raw 的必须回落，不能少一格导致下标错位');
  assert.strictEqual(r.texts.length, r.rawTexts.length);
});

ok('㉓ source=raw 的规则量原稿，其余规则量发出去的', () => {
  const run = shapeRun({ sent: [{ type: 'text', text: '十五下，你这是要凑整啊', raw: '十五下 你这是要凑整啊' }] });
  assert.strictEqual(measure(ruleOf('space-split'), [run]).hits, 0, '发出去的已经改好了');
  assert.strictEqual(measure(ruleOf('space-split-raw'), [run]).hits, 1, '原稿仍然是空格分句');
  assert.strictEqual(measure(ruleOf('space-split-raw'), [run]).total, 1, '分母必须一样，否则两个数没法相减');
});

ok('㉔ 新规则同样要过自检（没样本的 0% 不算数）', () => {
  const r = RULES.find((x) => x.id === 'space-split-raw');
  assert.ok(r, '规则不存在');
  assert.ok(r.sample?.bad && r.sample?.good, '必须自带正负样本');
  const failures = selfTest().failures.filter((f) => f.id === 'space-split-raw');
  assert.deepStrictEqual(failures, []);
});

ok('㉕ space-split 的目标不能低于人类基线（否则是要求她比人更规整）', () => {
  // 人类基线实测 27.7%；目标写成 5% 时这条规则永远"超标"，而解释是"目标拍错了"。
  const r = ruleOf('space-split');
  assert.ok(r.target >= 20, `目标 ${r.target}% 太严：真人自己就有 27.7% 这么写`);
});

ok('㉖ bucketOf 按去掉空白后的字数归档', () => {
  assert.strictEqual(bucketOf('短 句'), 'short');
  assert.strictEqual(bucketOf('十五下 你这是要凑整啊'), 'mid');   // 11 字
  assert.strictEqual(bucketOf('x'.repeat(29)), 'long');
  assert.strictEqual(bucketOf('x'.repeat(30)), 'para');
  assert.strictEqual(bucketOf(''), 'short');
});

ok('㉗ bucketRates：四档都在、样本数对、空档不除零', () => {
  const rows = bucketRates(['在的 咋了', 'xxx', ''], (t) => / /.test(t));
  assert.strictEqual(rows.length, LEN_BUCKETS.length, '空档也要占一行，否则并排打印会错位');
  const total = rows.reduce((a, r) => a + r.n, 0);
  assert.strictEqual(total, 2, '空串不该计样本');
  const short = rows.find((r) => r.id === 'short');
  assert.strictEqual(short.n, 2);
  assert.strictEqual(short.hits, 1);
  const para = rows.find((r) => r.id === 'para');
  assert.strictEqual(para.n, 0);
  assert.strictEqual(para.rate, 0, 'n=0 时不能出 NaN');
});


console.log(`\n[rule-audit] ${pass} 项通过`);
