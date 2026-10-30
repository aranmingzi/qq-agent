// 过去状态窗口自测（P1）。
//
// 断言围绕"换判据到底换掉了什么"：
//   ① 没保护项时，输出必须与旧的「取最近 N 条 + 从头部丢」**逐字相同**（尤其私聊）；
//   ② 有保护项时，被丢的必须是更旧的无关键寒暄，而不是那句 @；
//   ③ 保护 ≠ 永不丢：只剩保护项且仍超预算时，还是要丢（否则预算失控）；
//   ④ 群聊折叠只合并"同一人连续极短消息"，带图/引用/自己的发言一律不动；
//   ⑤ 群聊与私聊各用各的预算。
import assert from 'node:assert';
import {
  isGroupChat, isPrivateChat, chatKindOf, windowLimitsOf,
  markProtected, foldFlood, downsampleSelf, selectPast, describePastWindow,
  valueOf, degradeByValue
} from '../src/past-window.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[past-window]');

const mk = (i, over = {}) => ({
  id: i, mid: 1000 + i, ts: 1700000000000 + i * 1000,
  senderId: over.senderId || '10001', senderName: over.senderName || '张三',
  text: over.text ?? `第${i}条消息`, self: false, media: [],
  ...over
});
const line = (t) => ({ line: t, protect: false });

// ── 会话类型与预算 ──────────────────────────────────────────────────────
ok('会话类型只认前缀（group_ / private: 两种写法都认）', () => {
  assert.strictEqual(chatKindOf('group_20000005'), 'group');
  assert.strictEqual(chatKindOf('group:123'), 'group');
  assert.strictEqual(chatKindOf('private_10000001'), 'private');
  assert.strictEqual(chatKindOf('private:10000001'), 'private');
  assert.strictEqual(chatKindOf('weird'), '');
  assert.ok(isGroupChat('group_1') && chatKindOf('private:1') === 'private');
  assert.ok(!isGroupChat('private:1') && chatKindOf('group_1') === 'group');
});

ok('群聊与私聊各用各的预算，未知类型回落到私聊（= 不缩小）', () => {
  const cfg = { pastStateLimit: 24, pastStateMaxChars: 2400, pastStateGroupLimit: 20, pastStateGroupMaxChars: 2000 };
  assert.deepStrictEqual(windowLimitsOf('private:1', cfg), { limit: 24, maxChars: 2400 });
  assert.deepStrictEqual(windowLimitsOf('group_1', cfg), { limit: 20, maxChars: 2000 });
  assert.deepStrictEqual(windowLimitsOf('unknown', cfg), { limit: 24, maxChars: 2400 });
});

ok('群聊预算没配时回落到私聊值（不静默变成 0 条）', () => {
  const r = windowLimitsOf('group_1', { pastStateLimit: 18, pastStateMaxChars: 1800 });
  assert.deepStrictEqual(r, { limit: 18, maxChars: 1800 });
});

// ── 保护项 ──────────────────────────────────────────────────────────────
ok('@我 的消息 + 前后各 2 条 被标记为保护项', () => {
  const list = [mk(1), mk(2), mk(3), mk(4, { text: '@我 明天几点集合' }), mk(5), mk(6), mk(7), mk(8)];
  const out = markProtected(list, { selfNickname: '大肥鱼', radius: 2 });
  // @ 在 index 3，radius 2 → index 1..5 受保护
  assert.deepStrictEqual(out.map((x) => x.protect), [false, true, true, true, true, true, false, false]);
  assert.strictEqual(out[3].protectReason, 'addressed');
  assert.strictEqual(out[1].protectReason, 'near');
});

ok('@别人 不算保护项（否则"@张三 帮我带饭"会把别人的事当自己的）', () => {
  const list = [mk(1), mk(2, { text: '@张三 帮我带个饭' }), mk(3)];
  const out = markProtected(list, { selfNickname: '大肥鱼', radius: 2 });
  assert.ok(out.every((x) => !x.protect));
});

ok('@全体 也算在叫它', () => {
  const out = markProtected([mk(1, { text: '@全体成员 今晚开会' })], { radius: 0 });
  assert.strictEqual(out[0].protect, true);
});

ok('只保最近的 maxHits 处 @ —— 更早的退回正常淘汰', () => {
  const hits = new Set([2, 6, 10, 14, 18]);
  const list = Array.from({ length: 20 }, (_, i) => mk(i + 1, { text: hits.has(i) ? '@我 叫我' : `闲聊${i}` }));
  const out = markProtected(list, { radius: 0, maxHits: 2 });
  assert.deepStrictEqual(out.filter((x) => x.protect).map((x) => x.id), [15, 19], '应该保最近的两处（id 19、15）');
});

ok('★ 保护项总量有上限（默认 6）—— 不许把"当前在聊的"挤空，但 3 处 @ 本身必须都在', () => {
  const ats = new Set([10, 14, 18]);
  const list = Array.from({ length: 30 }, (_, i) => mk(i + 1, { text: ats.has(i) ? '@我 在吗' : `闲聊${i}` }));
  const out = markProtected(list, { radius: 2, maxHits: 3, maxProtected: 6 });
  assert.strictEqual(out.filter((x) => x.protect).length, 6);
  assert.deepStrictEqual(
    out.filter((x) => x.protectReason === 'addressed').map((x) => x.id),
    [11, 15, 19],
    '被舍掉的必须是离 @ 最远的邻居，不能是 @ 本身'
  );
});

ok('radius=0 时只保护那一句本身', () => {
  const out = markProtected([mk(1), mk(2, { text: '@我 在吗' }), mk(3)], { radius: 0 });
  assert.deepStrictEqual(out.map((x) => x.protect), [false, true, false]);
});

ok('不改原数组（纯函数）', () => {
  const list = [mk(1, { text: '@我 在吗' })];
  markProtected(list, { radius: 1 });
  assert.strictEqual(list[0].protect, undefined);
});

// ── 折叠 ────────────────────────────────────────────────────────────────
ok('同一人连续 4 条短句折叠成一条，并记条数', () => {
  const list = [mk(1, { text: '在吗' }), mk(2, { text: '出来' }), mk(3, { text: '说话' }), mk(4, { text: '快来' })];
  const out = foldFlood(list, { enabled: true, minRun: 4, maxTextChars: 10 });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].count, 4);
  assert.strictEqual(out[0].text, '在吗 / 出来 / 说话 / 快来');
  assert.strictEqual(out[0].id, 4, '合并后保留最后一条的 id（游标要用）');
});

ok('不足 minRun 条不折叠', () => {
  const list = [mk(1, { text: '在吗' }), mk(2, { text: '出来' })];
  const out = foldFlood(list, { enabled: true, minRun: 4, maxTextChars: 10 });
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((x) => !x.count));
});

ok('换人说话就断开（不能把两个人的话并成一条）', () => {
  const list = [
    mk(1, { text: '在吗' }), mk(2, { text: '出来' }), mk(3, { text: '说话' }),
    mk(4, { text: '在吗', senderId: '20002', senderName: '李四' }),
    mk(5, { text: '出来', senderId: '20002' }), mk(6, { text: '说话', senderId: '20002' })
  ];
  const out = foldFlood(list, { enabled: true, minRun: 3, maxTextChars: 10 });
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((x) => x.count), [3, 3]);
  assert.deepStrictEqual(out.map((x) => x.senderId), ['10001', '20002']);
});

ok('带图 / 引用 / 自己的发言 / 长句 / 换行 —— 一律不折叠', () => {
  const base = [mk(1, { text: '在吗' }), mk(2, { text: '出来' }), mk(3, { text: '说话' })];
  const cases = [
    [...base, mk(4, { text: '嗯', media: ['img'] })],
    [...base, mk(4, { text: '嗯', reply: { text: '上一句' } })],
    [...base, mk(4, { text: '嗯', self: true })],
    [...base, mk(4, { text: '这句话明显超过十个字了吧' })],
    [...base, mk(4, { text: '第一行\n第二行' })]
  ];
  for (const c of cases) {
    const out = foldFlood(c, { enabled: true, minRun: 4, maxTextChars: 10 });
    assert.strictEqual(out.length, 4, `不该折叠：${JSON.stringify(c[3])}`);
    assert.ok(!out.some((x) => x.count));
  }
});

ok('关闭折叠时原样返回', () => {
  const list = [mk(1, { text: '在吗' }), mk(2, { text: '出来' }), mk(3, { text: '说话' }), mk(4, { text: '快来' })];
  assert.strictEqual(foldFlood(list, { enabled: false }).length, 4);
});

// ── 选择（换判据的核心）──────────────────────────────────────────────────
ok('没有保护项时 = 旧的「取最近 N 条」行为', () => {
  const items = Array.from({ length: 30 }, (_, i) => line(`L${i}`));
  const r = selectPast(items, { limit: 5, maxChars: 10000 });
  assert.strictEqual(r.kept, 5);
  assert.deepStrictEqual(r.text.split('\n'), ['L25', 'L26', 'L27', 'L28', 'L29']);
});

ok('没有保护项时 = 旧的「超字数从头部丢」行为', () => {
  // 注意 maxChars 有 200 的下限（防呆），所以这里用 200 而不是更小的数
  const items = Array.from({ length: 10 }, (_, i) => line(`第${i}条消息内容` + 'x'.repeat(15)));
  const r = selectPast(items, { limit: 10, maxChars: 200 });
  assert.ok(r.text.length <= 200, `超预算：${r.text.length}`);
  assert.ok(r.text.endsWith('x'.repeat(15)), '最新的必须留到最后');
  assert.ok(r.dropped.length > 0 && r.dropped[0].reason === 'budget', JSON.stringify(r.dropped));
});

ok('★ 有保护项时：丢的是更旧的无关键寒暄，@ 那句留住', () => {
  // 第 0 条是 @我，后面 29 条寒暄；旧实现里第 0 条早被冲掉了
  const items = Array.from({ length: 30 }, (_, i) => ({ line: `L${i}`, protect: i === 0 }));
  const r = selectPast(items, { limit: 5, maxChars: 10000 });
  assert.ok(r.text.includes('L0'), '保护项被丢掉了 —— 这正是 P1 要修的故障');
  assert.strictEqual(r.kept, 5);
  assert.strictEqual(r.protectKept, 1);
  assert.deepStrictEqual(r.text.split('\n'), ['L0', 'L26', 'L27', 'L28', 'L29']);
});

ok('★ 保护项不是"永不丢"：全是保护项且超限时仍然丢最旧的', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ line: `P${i}`, protect: true }));
  const r = selectPast(items, { limit: 3, maxChars: 10000 });
  assert.strictEqual(r.kept, 3);
  assert.deepStrictEqual(r.text.split('\n'), ['P5', 'P6', 'P7']);
  assert.ok(r.dropped.every((d) => d.protect), '这次丢的确实是保护项，要能在日志里看见');
});

ok('极端：只有 1 条时不再丢（至少留一条）', () => {
  const r = selectPast([{ line: 'x'.repeat(5000), protect: false }], { limit: 3, maxChars: 100 });
  assert.strictEqual(r.kept, 1);
});

ok('空输入不炸', () => {
  assert.strictEqual(selectPast([], {}).text, '');
  assert.strictEqual(selectPast(null, {}).kept, 0);
});

ok('describePastWindow：没事时不说话，有事时说清楚', () => {
  assert.strictEqual(describePastWindow({ kept: 5 }), '');
  const s = describePastWindow({ kept: 5, protectKept: 1, folded: 4, dropped: [{ protect: false }, { protect: true }] });
  assert.ok(s.includes('保住 1 条') && s.includes('折叠 4 条') && s.includes('含 1 条保护项'), s);
});

ok('★ 条数读得到：buildPastState 返回的是 count，不是 kept（原来日志一直打「0 条」）', () => {
  assert.ok(describePastWindow({ count: 11, protectKept: 6 }).startsWith('[过去状态] 11 条'), describePastWindow({ count: 11, protectKept: 6 }));
  assert.ok(describePastWindow({ kept: 7, count: 11, protectKept: 1 }).includes('7 条'), 'kept 优先（测试里用这个形状）');
});

// ── 自己的旧发言降采样（P2）────────────────────────────────────────────
// 交替发言的窗口：user 一句、她一句。这是真实形态（实测连续段平均只有 1.6 条），
// 也正是"按连续段折叠无效、必须按总量压"的依据。
const alternating = (n, { selfText = (i) => `我说的第${i}句比较长的话，带着点情绪` } = {}) =>
  Array.from({ length: n }, (_, i) => mk(i, i % 2 === 1
    ? { self: true, senderName: '小鲸鱼儿', text: selfText(i) }
    : { text: `用户第${i}句` }));

ok('★ 交替发言也能压：最近 3 句原样留，更早的并成 1 行', () => {
  const list = alternating(12);            // 6 条自己的
  const r = downsampleSelf(list, { keepRecent: 3, fragChars: 10 });
  assert.strictEqual(r.folded, 3, '6 条自己 − 保留 3 条 = 3 条被并');
  assert.strictEqual(r.list.length, 10, `12 条应变成 10 项，实际 ${r.list.length}`);
  const batch = r.list.filter((x) => x.selfBatch);
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].count, 3);
  // 最近 3 句必须逐字还在
  const keptSelf = r.list.filter((x) => x.self && !x.selfBatch);
  assert.strictEqual(keptSelf.length, 3);
  keptSelf.forEach((m) => assert.ok(!m.text.includes('…'), '保留的那几句不许被截断'));
});

ok('★ 片段截到 fragChars：记得「聊过什么」，但拿不到可复读的整句', () => {
  const list = alternating(12);
  const r = downsampleSelf(list, { keepRecent: 3, fragChars: 10 });
  const batch = r.list.find((x) => x.selfBatch);
  const parts = batch.text.split(' / ');
  assert.strictEqual(parts.length, 3);
  parts.forEach((p) => assert.ok(p.length <= 11, `片段超长：${p}`));
  assert.ok(batch.text.endsWith('…'), '截断要有省略号，别让人以为话说完了');
});

ok('合并行总长有上限（10 句片段不许拼成一坨）', () => {
  const list = alternating(40);
  const r = downsampleSelf(list, { keepRecent: 3, fragChars: 20, lineMaxChars: 60 });
  const batch = r.list.find((x) => x.selfBatch);
  assert.ok(batch.text.length <= 60, `合并行 ${batch.text.length} 字，超了 60`);
});

ok('★ 位置：合并行落在「最早那条被并列」处，时间顺序不乱', () => {
  const list = alternating(12);
  const r = downsampleSelf(list, { keepRecent: 3, fragChars: 10 });
  const idx = r.list.findIndex((x) => x.selfBatch);
  assert.strictEqual(idx, 1, 'alternating() 里第一条自己的发言在下标 1，合并行就该在那儿');
  assert.strictEqual(r.list[idx].ts, list[1].ts, '时间戳要用最早的，别让旧话看着像刚说的');
  // 顺序单调不减
  for (let i = 1; i < r.list.length; i += 1) assert.ok(r.list[i].ts >= r.list[i - 1].ts);
});

ok('只有 1 条可并时不并（截断内容却没省下行数 = 纯亏）', () => {
  const list = [
    mk(0, { self: true, text: '很早以前说的一句话' }),
    mk(1, { text: '用户' }), mk(2, { text: '用户' }),
    mk(3, { self: true, text: 'a' }), mk(4, { self: true, text: 'b' }), mk(5, { self: true, text: 'c' })
  ];
  const r = downsampleSelf(list, { keepRecent: 3 });
  assert.strictEqual(r.folded, 0);
  assert.strictEqual(r.list.length, 6);
});

ok('保护项不并（那是对 @ 的回应，是当前对话的一部分）', () => {
  const list = alternating(12).map((m, i) => (i === 1 ? { ...m, protect: true } : m));
  const r = downsampleSelf(list, { keepRecent: 1, fragChars: 10 });
  assert.ok(r.list.some((x) => x.protect && !x.selfBatch), '被保护的那句要原样留着');
});

ok('带图的不并（提示词要用 #消息id 去取图）', () => {
  const list = alternating(12).map((m, i) => (i === 1 ? { ...m, media: [{ type: 'image', file: 'a.jpg' }] } : m));
  const r = downsampleSelf(list, { keepRecent: 1, fragChars: 10 });
  const withMedia = r.list.filter((x) => x.self && !x.selfBatch && (x.media || []).length);
  assert.strictEqual(withMedia.length, 1);
});

ok('全是自己的发言：至少留 keepRecent 条原文', () => {
  const list = Array.from({ length: 8 }, (_, i) => mk(i, { self: true, text: `第${i}句` }));
  const r = downsampleSelf(list, { keepRecent: 3, fragChars: 10 });
  const kept = r.list.filter((x) => x.self && !x.selfBatch);
  assert.strictEqual(kept.length, 3);
  assert.strictEqual(r.folded, 5);
});

ok('不改原数组（纯函数）＋ enabled=false 原样返回', () => {
  const list = alternating(12);
  const snapshot = JSON.stringify(list);
  downsampleSelf(list, { keepRecent: 3 });
  assert.strictEqual(JSON.stringify(list), snapshot, '原数组被改了');
  const off = downsampleSelf(list, { enabled: false, keepRecent: 1 });
  assert.strictEqual(off.list.length, 12);
  assert.strictEqual(off.folded, 0);
});

ok('空输入 / 只有 2 条时不炸', () => {
  assert.strictEqual(downsampleSelf([]).list.length, 0);
  assert.strictEqual(downsampleSelf(null).folded, 0);
  assert.strictEqual(downsampleSelf(alternating(2), { keepRecent: 1 }).list.length, 2);
});

ok('describePastWindow 会说清楚自己那行是怎么来的（并进来了 vs 被挤掉了）', () => {
  const joined = describePastWindow({ kept: 8, selfFolded: 4, selfBatchKept: true });
  assert.ok(joined.includes('并成 1 行') && joined.includes('4 句'), joined);
  const dropped = describePastWindow({ kept: 8, selfFolded: 4, selfBatchKept: false });
  assert.ok(dropped.includes('已省略'), '合并行被淘汰时必须说"省略"，不能谎报"并成 1 行"：' + dropped);
  assert.ok(!dropped.includes('并成 1 行'));
});

// ── 信息价值分（P3，2026-10-26）───────────────────────────────────────────
// 学 fast-jev：判据从"时间 + 保护"二值升级为"＋价值"三级。三条红线：
//   ① 装得下就一个字都不改（窗口没触顶时压缩是纯损失）；
//   ② 单次收益低于 minGainChars 不动手（省 50 字丢半句话不划算）；
//   ③ 保护项 / 带图 / 引用 / 自己的，一律不动。
const withVal = (lineText, value, over = {}) => ({
  line: lineText,
  shortLine: over.shortLine ?? (lineText.length > 20 ? `${lineText.slice(0, 14)}…` : null),
  protect: false,
  value,
  ...over
});
const totalLen = (arr) => arr.reduce((s, x) => s + x.line.length + 1, 0);

ok('valueOf：提问 / 承诺 / 时间事实 = high，噪声与极短 = low', () => {
  assert.strictEqual(valueOf(mk(1, { text: '这到底是怎么弄的？' })), 'high');
  assert.strictEqual(valueOf(mk(2, { text: '明天下午三点老地方见' })), 'high');
  assert.strictEqual(valueOf(mk(3, { text: '记得帮我提醒一下' })), 'high');
  assert.strictEqual(valueOf(mk(4, { text: '哈哈哈' })), 'low');
  assert.strictEqual(valueOf(mk(5, { text: '哦' })), 'low');
  assert.strictEqual(valueOf(mk(6, { text: '666' })), 'low');
  assert.strictEqual(valueOf(mk(7, { text: '今天天气不错去吃了个饭' })), 'mid');
});

ok('valueOf：带图（要 #id 取图）与引用（在回谁）永不参与压缩', () => {
  assert.strictEqual(valueOf(mk(8, { text: '哦', media: [{ type: 'image' }] })), 'high');
  assert.strictEqual(valueOf(mk(9, { text: '嗯', reply: { sender: '李四', text: 'xxx' } })), 'high');
});

ok('★ 红线①：窗口装得下时一个字都不改（changed:false 且逐字相同）', () => {
  // ⚠️ 这里必须给 shortLine：行太短（≤20 字）时根本没得截，
  //    测试会变成"因为没候选所以没动"的假绿 —— 拆了闸也不会红。
  const items = [
    withVal('x'.repeat(60), 'low', { shortLine: 'x'.repeat(20) }),
    withVal('y'.repeat(60), 'low', { shortLine: 'y'.repeat(20) }),
    withVal('z'.repeat(60), 'mid', { shortLine: 'z'.repeat(20) })
  ];
  const r = degradeByValue(items, { limit: 24, maxChars: 2400, minGainChars: 20 });
  assert.ok(items.every((x) => x.shortLine), '用例前提：每行都得有得可截');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.degraded, 0);
  assert.deepStrictEqual(r.list.map((x) => x.line), items.map((x) => x.line));
  // 条数正好等于 limit 也不算"装不下"
  const byCount = degradeByValue(items, { limit: 3, maxChars: 2400, minGainChars: 20 });
  assert.strictEqual(byCount.changed, false, '条数正好等于 limit 也不该动');
});

ok('★ 装不下时：先截 low，high 一个字不动', () => {
  const long = (t) => `${t}`.padEnd(200, '啊');
  const items = [
    withVal(long('低价值闲聊一'), 'low'),
    withVal(long('高价值：明天几点集合？'), 'high'),
    withVal(long('低价值闲聊二'), 'low')
  ];
  const r = degradeByValue(items, { limit: 24, maxChars: 300, minGainChars: 120 });
  assert.ok(r.changed && r.degraded >= 1, '超预算了却没截');
  assert.ok(totalLen(r.list) <= 300 + 3, `截完仍超预算：${totalLen(r.list)}`);
  const highRow = r.list.find((x) => x.value === 'high');
  assert.strictEqual(highRow.degraded, undefined, 'high 被截了 —— 承诺/提问不许动');
  assert.ok(highRow.line.includes('明天几点集合？'), 'high 的原文必须完整');
});

ok('★ 红线②：单次省不到 minGainChars 就不动手（Jev 的 reductionRatio 门槛）', () => {
  // ⚠️ 用例前提有两个，缺一个就是假绿：
  //   ① 总长必须真的超过 capChars —— 它有 **200 的下限**（防呆），
  //      写 40 会被悄悄抬到 200，压根进不了压缩路径（第一次就是这么假绿的）；
  //   ② 省下的字数必须小于 minGain（300-250=50 < 120）。
  const items = [withVal('x'.repeat(300), 'low', { shortLine: 'x'.repeat(250) })];
  const r = degradeByValue(items, { limit: 24, maxChars: 200, minGainChars: 120 });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.degraded, 0);
  assert.strictEqual(r.list[0].line.length, 300, '省不够还改 = 白担丢失风险');
});

ok('★ 红线③：保护项不动（保护 > 任何价值分）', () => {
  const long = (t) => `${t}`.padEnd(200, '啊');
  const items = [
    withVal(long('被@的那句'), 'low', { protect: true }),
    withVal(long('普通闲聊'), 'low')
  ];
  const r = degradeByValue(items, { limit: 24, maxChars: 150, minGainChars: 120 });
  assert.strictEqual(r.list[0].degraded, undefined, '保护项被截了');
  assert.strictEqual(r.list[1].degraded, true, '该截的是非保护的那一句');
});

ok('没有 shortLine（本来就不长）的行不参与截短', () => {
  const items = [{ line: '短句', protect: false, value: 'low' }];
  const r = degradeByValue(items, { limit: 1, maxChars: 200, minGainChars: 20 });
  assert.strictEqual(r.degraded, 0);
  assert.strictEqual(r.changed, false);
});

ok('enabled=false 时原样返回（私聊走的就是这条路）', () => {
  const items = [withVal('x'.repeat(300), 'low')];
  const r = degradeByValue(items, { limit: 1, maxChars: 50, enabled: false });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.degraded, 0);
});

ok('★ selectPast 淘汰加第三级：先丢低价值的，不是只丢最旧的', () => {
  const items = [
    withVal('A-普通', 'mid'),
    withVal('B-低价值', 'low'),
    withVal('C-高价值', 'high'),
    withVal('D-普通', 'mid'),
    withVal('E-高价值', 'high')
  ];
  const r = selectPast(items, { limit: 4, maxChars: 10000 });
  assert.strictEqual(r.kept, 4);
  assert.ok(!r.text.includes('B-低价值'), '低价值的没被优先丢掉，第三级判据没生效');
  assert.ok(r.text.includes('A-普通'), '最旧的普通行应该保住（旧实现会先丢它）');
  assert.strictEqual(r.dropped[0].value, 'low', 'dropped 要能看出丢的是低价值：' + JSON.stringify(r.dropped[0]));
});

ok('★ 没带 value 的调用方：淘汰行为与旧实现逐字相同（私聊铁律）', () => {
  const items = Array.from({ length: 30 }, (_, i) => line(`L${i}`));
  const r = selectPast(items, { limit: 5, maxChars: 10000 });
  assert.deepStrictEqual(r.text.split('\n'), ['L25', 'L26', 'L27', 'L28', 'L29']);
  // 保护项那条老断言也要照旧
  const p = Array.from({ length: 30 }, (_, i) => ({ line: `L${i}`, protect: i === 0 }));
  const r2 = selectPast(p, { limit: 5, maxChars: 10000 });
  assert.deepStrictEqual(r2.text.split('\n'), ['L0', 'L26', 'L27', 'L28', 'L29']);
});

ok('describePastWindow 会说清"截短了多少、省了多少字"', () => {
  assert.strictEqual(describePastWindow({ kept: 8 }), '');
  const s = describePastWindow({ kept: 8, degraded: 3, degradedChars: 420 });
  assert.ok(s.includes('截短 3 条') && s.includes('420 字'), s);
});

ok('isPrivateChat：两种分隔符都认（文件名下划线 / chatKey 冒号）', () => {
  assert.strictEqual(isPrivateChat('private:10000001'), true);
  assert.strictEqual(isPrivateChat('private_10000001'), true);
  assert.strictEqual(isPrivateChat('group:20000005'), false);
  assert.strictEqual(isPrivateChat('group_20000005'), false);
  assert.strictEqual(isPrivateChat(''), false);
  assert.strictEqual(isPrivateChat('weird'), false);
});

// 6 处硬编码统一为 isPrivateChat 时的等价性钉子：
// 对**现有的真实 chatKey**（冒号）取值必须与旧写法一字不差，否则就是改出了行为变化。
ok('isPrivateChat 对冒号 chatKey 与旧写法 startsWith 完全等价', () => {
  for (const k of ['private:10000001', 'group:20000005', 'private:123456789:tutor', '']) {
    assert.strictEqual(isPrivateChat(k), String(k).startsWith('private:'), k);
  }
  // 旧写法在下划线形状上会漏判 —— 这正是统一的价值（HTTP 端点可传任意字符串）
  assert.strictEqual(String('private_10000001').startsWith('private:'), false);
  assert.strictEqual(isPrivateChat('private_10000001'), true);
  // 带身份模式后缀不能误判
  assert.strictEqual(isPrivateChat('private:10000001:tutor'), true);
  assert.strictEqual(isPrivateChat('group:123:tutor'), false);
});

console.log(`\n[past-window] ${pass} 项通过`);
