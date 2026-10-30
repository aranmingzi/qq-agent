// 往事摘要自测（P2）。
//
// 断言围绕"这层新东西凭什么不会变成新的故障源"：
//   ① 归一化必须把模型的废话（代码块、开场白、小标题）摘干净 —— 它们会进提示词；
//   ② 只压"窗口外 + 没压过"的那一批（游标），绝不重复压、绝不压正在用的热窗口；
//   ③ 连续失败到阈值就**停用这个会话**，绝不能因为一行摘要把聊天卡住；
//   ④ 空摘要要当失败（否则游标前进了、这段历史永久消失却什么都没留下）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

// 必须赶在 import config.js 之前改数据目录，否则会写进生产数据
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-summary-'));

const {
  normalizeSummary, normalizeSlots, parseSlots, renderSlots, slotKeyOf,
  SUMMARY_SLOTS, pickPending, buildSummaryMessages, renderForSummary,
  PastSummaryStore, SUMMARY_DEFAULTS, looksIncomplete
} = await import('../src/past-summary.js');

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[past-summary]');

const mk = (i, over = {}) => ({
  id: i, ts: 1700000000000 + i * 60000, senderId: '10001', senderName: '张三',
  text: `第${i}条`, self: false, media: [], ...over
});

// ── 归一化 ──────────────────────────────────────────────────────────────
ok('摘掉代码块、开场白、小标题，只留条目', () => {
  const raw = '好的，以下是摘要：\n```\n# 往事\n* 张三问了集合时间\n· 说好七点\n```';
  const out = normalizeSummary(raw, { maxLines: 8, maxChars: 800 });
  assert.deepStrictEqual(out.split('\n'), ['- 张三问了集合时间', '- 说好七点']);
});

ok('模型漏写 "- " 的也当条目（不许整段丢失）', () => {
  const out = normalizeSummary('张三问了集合时间\n说好七点', { maxLines: 8 });
  assert.deepStrictEqual(out.split('\n'), ['- 张三问了集合时间', '- 说好七点']);
});

ok('条数上限生效，且保留的是靠前的（越重要越前）', () => {
  const raw = Array.from({ length: 12 }, (_, i) => `- 第${i}条要点`).join('\n');
  const out = normalizeSummary(raw, { maxLines: 3, maxChars: 800 });
  assert.strictEqual(out.split('\n').length, 3);
  assert.ok(out.startsWith('- 第0条要点'));
});

ok('超字数按**整条**丢（不能切出半条）', () => {
  const raw = Array.from({ length: 10 }, (_, i) => `- 第${i}条要点`.padEnd(40, '字')).join('\n');
  const out = normalizeSummary(raw, { maxLines: 10, maxChars: 120 });
  assert.ok(out.length <= 120, `超字数：${out.length}`);
  for (const l of out.split('\n')) assert.ok(l.startsWith('- '), '出现了残缺行');
});

ok('空输入 → 空串（调用方据此判失败，别推进游标）', () => {
  assert.strictEqual(normalizeSummary('', {}), '');
  assert.strictEqual(normalizeSummary('```\n```', {}), '');
});

// ── 截断保护（真机踩过：1200 输出预算被思维链吃光，摘要卡在半个引号上）──
ok('finish_reason=length 时丢掉最后那条半句', () => {
  const raw = '- 八点半的叫醒约定没兑现\n- 萌界一把刀说“';
  const out = normalizeSummary(raw, { truncated: true });
  assert.strictEqual(out, '- 八点半的叫醒约定没兑现');
});

ok('只剩一条又被截断：留着但标明没说完（不许清空）', () => {
  const out = normalizeSummary('- 大家在商量周末聚餐', { truncated: true });
  assert.ok(out.startsWith('- 大家在商量周末聚餐'), out);
  assert.ok(out.endsWith('…'), '必须看得出没说完');
});

ok('不依赖 finish_reason 的兜底：引号/括号不成对、停在逗号上的末条要丢', () => {
  assert.strictEqual(looksIncomplete('- 他说“明天见'), true);
  assert.strictEqual(looksIncomplete('- 结论是，'), true);
  assert.strictEqual(looksIncomplete('- 就差一个括号（'), true);
  assert.strictEqual(looksIncomplete('- 他说“明天见”'), false);
  assert.strictEqual(looksIncomplete('- 定了周六去爬山。'), false);
  const out = normalizeSummary('- 甲约了乙爬山\n- 丙说“到时候', {});
  assert.strictEqual(out, '- 甲约了乙爬山', '没有 finish_reason 也要能挡住半句');
});

ok('末条完整时不许误删（宁可多留，不能白丢事实）', () => {
  const raw = '- 甲约了乙爬山\n- 乙答应了';
  assert.strictEqual(normalizeSummary(raw, {}), raw);
  assert.strictEqual(normalizeSummary(raw, { truncated: false }), raw);
});

// ── 游标 ────────────────────────────────────────────────────────────────
ok('只压窗口外、没压过的，最旧的先，且受 maxBatch 限制', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => mk(i + 1));
  // 窗口 24 → 只有前 6 条在窗口外
  assert.deepStrictEqual(pickPending(msgs, { windowLimit: 24, uptoId: 0 }).map((m) => m.id), [1, 2, 3, 4, 5, 6]);
  // 游标已到 4 → 只剩 5、6
  assert.deepStrictEqual(pickPending(msgs, { windowLimit: 24, uptoId: 4 }).map((m) => m.id), [5, 6]);
  // maxBatch 截断
  assert.deepStrictEqual(pickPending(msgs, { windowLimit: 24, uptoId: 0, maxBatch: 2 }).map((m) => m.id), [1, 2]);
});

ok('消息还不够多（全在窗口内）时一条都不压', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => mk(i + 1));
  assert.deepStrictEqual(pickPending(msgs, { windowLimit: 24, uptoId: 0 }), []);
});

ok('游标已经跟上时不会重复压', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => mk(i + 1));
  assert.deepStrictEqual(pickPending(msgs, { windowLimit: 24, uptoId: 6 }), []);
});

// ── 压缩请求 ────────────────────────────────────────────────────────────
ok('压缩请求带上旧摘要与新记录，并把"不许编"写死', () => {
  const msgs = buildSummaryMessages({
    oldSummary: '- 张三约了周末聚餐',
    lines: ['[10:00] 张三：周末还聚吗'],
    maxLines: 6, maxChars: 500
  });
  const sys = msgs[0].content;
  const user = msgs[1].content;
  assert.ok(sys.includes('只做压缩') && sys.includes('绝不发明'));
  assert.ok(user.includes('张三约了周末聚餐'), '旧摘要必须进请求（增量，不从头总结）');
  assert.ok(user.includes('周末还聚吗'));
  assert.ok(user.includes('最多 6 条') && user.includes('不超过 500 字'));
  assert.ok(user.includes('是谁'), '必须要求写清是谁说的（否则压缩后张冠李戴）');
});

ok('没有旧摘要时明确写"（无）"，不留空段落', () => {
  const user = buildSummaryMessages({ oldSummary: '', lines: ['x'] })[1].content;
  assert.ok(user.includes('（无）'));
});

ok('喂给压缩器的行带时间和人（不带 #消息id，那个只在聊天提示词里用）', () => {
  const s = renderForSummary(mk(1, { text: '在吗', senderName: '李四', senderId: '2' }));
  assert.ok(/^\[\d{2}:\d{2}\] 李四：在吗$/.test(s), s);
  assert.ok(!s.includes('#'));
  assert.ok(renderForSummary(mk(2, { self: true })).includes('我：'));
});

// ── 存储 / 熔断 ─────────────────────────────────────────────────────────
ok('写入后能读回，并落盘到 data/summary/', () => {
  const store = new PastSummaryStore();
  const key = 'group_123456';
  store.commit(key, { summary: '- 张三约了周末聚餐', uptoId: 42 });
  const st = store.get(key);
  assert.strictEqual(st.summary, '- 张三约了周末聚餐');
  assert.strictEqual(st.uptoId, 42);
  assert.strictEqual(st.runs, 1);
  const file = path.join(process.env.QQ_AGENT_DATA_DIR, 'summary', 'group_123456.json');
  assert.ok(fs.existsSync(file), '应该落盘成 json');
  // 换一个实例读同一个文件（模拟重启）
  assert.strictEqual(new PastSummaryStore().get(key).summary, '- 张三约了周末聚餐');
});

ok('formatForPrompt：没摘要 → 空串（整段不出现），超长按上限裁', () => {
  const store = new PastSummaryStore();
  const key = 'group_empty';
  assert.strictEqual(store.formatForPrompt(key), '');
  store.commit(key, { summary: 'x'.repeat(2000), uptoId: 1 });
  const out = store.formatForPrompt(key, { maxChars: 200 });
  assert.ok(out.length <= 200 && out.endsWith('…'));
});

ok('formatForPrompt 超预算时按整条丢，不切半句（半句会被当成事实读）', () => {
  const store = new PastSummaryStore();
  const key = 'group_cut';
  const s = ['- 第一条要点' + '甲'.repeat(30), '- 第二条要点' + '乙'.repeat(30), '- 第三条要点' + '丙'.repeat(30)].join('\n');
  store.commit(key, { summary: s, uptoId: 1 });
  const out = store.formatForPrompt(key, { maxChars: 80 });
  for (const l of out.split('\n')) {
    assert.ok(l.startsWith('- 第'), `切出了半条：${l}`);
  }
  assert.ok(out.includes('第一条要点'), '第一条必须保住');
});

ok(`★ 连续失败 ${SUMMARY_DEFAULTS.failThreshold} 次 → 停用该会话，提示词里不再出现`, () => {
  const store = new PastSummaryStore();
  const key = 'group_fail';
  store.commit(key, { summary: '- 有内容', uptoId: 5 });
  const r1 = store.bumpFail(key);
  const r2 = store.bumpFail(key);
  assert.ok(!r1.disabled && !r2.disabled, '没到阈值不该停用');
  assert.strictEqual(store.formatForPrompt(key), '- 有内容', '停用前照常注入');
  const r3 = store.bumpFail(key);
  assert.strictEqual(r3.disabled, true);
  assert.strictEqual(r3.justDisabled, true, '只在刚停用那一次返回 justDisabled（日志只打一次）');
  assert.strictEqual(store.formatForPrompt(key), '', '停用后必须整段不出现');
  assert.strictEqual(store.bumpFail(key).justDisabled, false);
});

ok('成功一次就把失败计数清零（偶发失败不该累积成停用）', () => {
  const store = new PastSummaryStore();
  const key = 'group_recover';
  store.bumpFail(key); store.bumpFail(key);
  store.commit(key, { summary: '- 新摘要', uptoId: 9 });
  assert.strictEqual(store.get(key).failCount, 0);
  assert.strictEqual(store.get(key).disabled, false);
});

ok('reset 能手动恢复被停用的会话', () => {
  const store = new PastSummaryStore();
  const key = 'group_reset';
  for (let i = 0; i < 3; i += 1) store.bumpFail(key);
  assert.strictEqual(store.get(key).disabled, true);
  store.reset(key);
  const st = store.get(key);
  assert.ok(!st.disabled && !st.summary && st.uptoId === 0);
});

// ── 槽位化（P4，2026-10-26）───────────────────────────────────────────────
// 学 anchored iterative：**结构逼着保留**。四个槽位按"丢了会怎样"排序，
// 超预算时按槽位丢（先丢"发生了什么"），而不是从末尾整条丢。
// ⚠️ 磁盘上的旧摘要是平铺条目 —— 必须能无损读回（全部进 legacy），这是硬要求。
const GOOD = [
  '【谁在要什么】',
  '- 张三问周末还聚不聚',
  '【答应了什么】',
  '- 她答应周六早上八点半叫醒李四',
  '【定了什么】',
  '- 最后定了去西山爬山',
  '【发生了什么】',
  '- 大家聊了会儿天气',
  '- 王五发了个表情包'
].join('\n');
const OLD = ['- 张三约了周末聚餐', '- 李四说好七点到'].join('\n');
// 字数淘汰用的长版。⚠️ normalizeSlots 的 maxChars 有 **120 的下限**（防呆），
// 测试写 80 会被悄悄抬到 120 —— 压根不触发淘汰，测试变成假绿（P3 时踩过同样的坑）。
const LONG = [
  '【谁在要什么】',
  '- 张三问周末还聚不聚，还想知道几点集合合适',
  '【答应了什么】',
  '- 她答应周六早上八点半叫醒李四，别忘了',
  '【定了什么】',
  '- 最后定了去西山爬山，门票她来买',
  '【发生了什么】',
  '- 大家聊了会儿天气，都说最近挺热的',
  '- 王五发了个表情包，没人接话'
].join('\n');

ok('槽位标题四种写法都认（【】/##/冒号）', () => {
  assert.strictEqual(slotKeyOf('【谁在要什么】'), 'asking');
  assert.strictEqual(slotKeyOf('## 答应了什么'), 'promised');
  assert.strictEqual(slotKeyOf('定了什么：'), 'decided');
  assert.strictEqual(slotKeyOf('发生了什么'), 'happened');
  assert.strictEqual(slotKeyOf('- 张三问周末还聚不聚'), '', '普通条目不能被当成标题');
});

ok('parseSlots：四个槽位各归各位，标题行本身不进内容', () => {
  const p = parseSlots(GOOD);
  assert.deepStrictEqual(p.asking, ['张三问周末还聚不聚']);
  assert.deepStrictEqual(p.promised, ['她答应周六早上八点半叫醒李四']);
  assert.deepStrictEqual(p.decided, ['最后定了去西山爬山']);
  assert.deepStrictEqual(p.happened, ['大家聊了会儿天气', '王五发了个表情包']);
  assert.deepStrictEqual(p.legacy, []);
  assert.ok(!renderSlots(p).includes('【谁在要什么】\n- 【'), '标题不该变成条目');
});

ok('★ 旧摘要（磁盘上的平铺条目）读回来一条不少 —— 全部进 legacy', () => {
  const p = parseSlots(OLD);
  assert.deepStrictEqual(p.legacy, ['张三约了周末聚餐', '李四说好七点到']);
  assert.deepStrictEqual(p.asking, []);
  // 渲染出来必须还是原样（不带槽位标题，形态没变）
  assert.strictEqual(renderSlots(p), OLD);
});

ok('renderSlots：空槽位整块不写；legacy 排在最前', () => {
  const out = renderSlots({ asking: ['a'], promised: [], decided: [], happened: [], legacy: ['旧'] });
  assert.strictEqual(out, '- 旧\n【谁在要什么】\n- a', out);
  assert.strictEqual(renderSlots({ asking: [], promised: [], decided: [], happened: [], legacy: [] }), '');
});

ok('★ 超字数按**槽位**丢：先丢"发生了什么"，"答应了什么"必须保住', () => {
  assert.ok(LONG.length > 120, '用例前提：原文必须真超 120 字下限，否则不触发淘汰');
  const out = normalizeSlots(LONG, { maxLines: 8, maxChars: 120 });
  assert.ok(out.length <= 120, `超字数：${out.length}`);
  assert.ok(out.length < LONG.length, '没丢任何东西 —— 淘汰没生效：\n' + out);
  assert.ok(out.includes('八点半叫醒李四'), '承诺被丢了 —— 这正是槽位化要修的：\n' + out);
  assert.ok(out.includes('谁在要什么'), '请求也没了');
  assert.ok(!out.includes('王五发了个表情包'), '"发生了什么"该最先被丢');
});

ok('条数上限按重要性留：asking 先留，happened 先没', () => {
  const out = normalizeSlots(GOOD, { maxLines: 2, maxChars: 800 });
  assert.ok(out.includes('张三问周末还聚不聚'));
  assert.ok(out.includes('八点半叫醒李四'));
  assert.ok(!out.includes('西山爬山'), '第 3 重要的不该挤进来');
});

ok('槽位化也吃截断保护：最后一条半句要丢（不许当事实读）', () => {
  const raw = '【答应了什么】\n- 她答应周六八点半叫醒李四\n- 萌界一把刀说“';
  const out = normalizeSlots(raw, { truncated: true, maxLines: 8 });
  assert.ok(!out.includes('萌界'), out);
  assert.ok(out.includes('八点半'), out);
});

ok('模型没按槽位输出 → 自动退化成平铺（降级模型也安全）', () => {
  const out = normalizeSlots('好的，以下是摘要：\n```\n- 张三约了聚餐\n- 说好七点\n```', { maxLines: 8 });
  assert.ok(out.includes('张三约了聚餐') && out.includes('说好七点'), out);
  assert.ok(!out.includes('【'), '没分类就不该凭空造标题：' + out);
});

ok('空输入 → 空串（调用方据此判失败，别推进游标）', () => {
  assert.strictEqual(normalizeSlots('', {}), '');
  assert.strictEqual(normalizeSlots('```\n```', {}), '');
});

ok('压缩请求把四个槽位和要求都写进提示词', () => {
  const msgs = buildSummaryMessages({ oldSummary: OLD, lines: ['[10:00] 张三：周末还聚吗'], maxLines: 6, maxChars: 500 });
  const user = msgs[1].content;
  for (const t of SUMMARY_SLOTS.map((s) => s.title)) {
    assert.ok(user.includes(t), `提示词缺槽位「${t}」`);
  }
  assert.ok(user.includes('最多 6 条') && user.includes('不超过 500 字'));
  assert.ok(user.includes('是谁'), '必须要求写清是谁说的（否则压缩后张冠李戴）');
  assert.ok(user.includes(OLD.split('\n')[0]), '旧摘要必须进请求（增量，不从头总结）');
});

ok('★ formatForPrompt 超预算时保住承诺、先丢事实（端到端）', () => {
  const store = new PastSummaryStore();
  const key = 'group_slots';
  store.commit(key, { summary: LONG, uptoId: 7 });
  const out = store.formatForPrompt(key, { maxChars: 120 });
  assert.ok(out.length <= 120, `超预算：${out.length}`);
  assert.ok(out.includes('八点半叫醒李四'), '承诺丢了：\n' + out);
  assert.ok(!out.includes('王五发了个表情包'), '事实没先丢');
});

ok('★ 旧摘要走 formatForPrompt 时行为不变（兼容，一条不少地按整条丢）', () => {
  const store = new PastSummaryStore();
  const key = 'group_oldslots';
  const s = ['- 第一条要点' + '甲'.repeat(30), '- 第二条要点' + '乙'.repeat(30), '- 第三条要点' + '丙'.repeat(30)].join('\n');
  store.commit(key, { summary: s, uptoId: 1 });
  const out = store.formatForPrompt(key, { maxChars: 80 });
  for (const l of out.split('\n')) assert.ok(l.startsWith('- 第'), `切出了半条：${l}`);
  assert.ok(out.includes('第一条要点'), '第一条必须保住');
});

ok('slotMode=false 时退回平铺（开关可回退）', () => {
  const store = new PastSummaryStore();
  const key = 'group_noslot';
  store.commit(key, { summary: GOOD, uptoId: 7 });
  const out = store.formatForPrompt(key, { maxChars: 80, slotMode: false });
  assert.ok(!out.includes('【'), '关了槽位就不该有槽位标题');
  assert.ok(out.includes('张三问周末还聚不聚'), '旧路径也得有内容');
});

// ── 每槽限额（P4.1，2026-10-26 真机修）───────────────────────────────────
// 起因：生产里 group_20000001 的摘要**只剩一个槽** —— asking 一个人一条写了 8 条，
// 把 maxLines=8 的总配额吃满，承诺/决定/事实一条不剩。
// 断言必须能抓住"第一个槽通吃"这种形态，否则就是假绿。
const ASKING_BOMB = [
  '【谁在要什么】',
  ...Array.from({ length: 8 }, (_, i) => `- 第${i + 1}个人问东问西`),
  '【答应了什么】',
  '- 我答应帮他存话',
  '【定了什么】',
  '- 定了周六见'
].join('\n');

ok('perSlotMax：一个槽写爆也不会把别的槽挤没（真机复现）', () => {
  const out = normalizeSlots(ASKING_BOMB, { maxLines: 8, maxChars: 800, perSlotMax: 3 });
  const asking = out.split('\n').filter((l) => /^- 第\d+个人/.test(l));
  assert.equal(asking.length, 3, `asking 该被裁到 3 条，实际 ${asking.length}`);
  assert.ok(out.includes('我答应帮他存话'), '承诺必须还在');
  assert.ok(out.includes('定了周六见'), '决定必须还在');
});

ok('perSlotMax=0 就是旧行为：一个槽可以吃满总配额', () => {
  // 只有 asking 一个槽时不限就该全留（这才是旧行为的样子）
  const only = ['【谁在要什么】', ...Array.from({ length: 8 }, (_, i) => `- 第${i + 1}个人问东问西`)].join('\n');
  const out = normalizeSlots(only, { maxLines: 8, maxChars: 800, perSlotMax: 0 });
  const asking = out.split('\n').filter((l) => /^- 第\d+个人/.test(l));
  assert.equal(asking.length, 8, `不限就该全留，实际 ${asking.length}`);
  // 有别的槽时轮转仍会分名额给它们（这条是 round-robin 的附带效果，不是旧行为）
  const mixed = normalizeSlots(ASKING_BOMB, { maxLines: 8, maxChars: 800, perSlotMax: 0 });
  assert.ok(mixed.includes('我答应帮他存话'), '轮转下承诺反而有机会');
});

ok('四个槽都写满时按轮转分配，不是一个槽通吃', () => {
  const raw = [
    '【谁在要什么】', ...Array.from({ length: 5 }, (_, i) => `- a${i + 1}`),
    '【答应了什么】', ...Array.from({ length: 5 }, (_, i) => `- b${i + 1}`),
    '【定了什么】', ...Array.from({ length: 5 }, (_, i) => `- c${i + 1}`),
    '【发生了什么】', ...Array.from({ length: 5 }, (_, i) => `- d${i + 1}`)
  ].join('\n');
  const out = normalizeSlots(raw, { maxLines: 8, maxChars: 800, perSlotMax: 0 });
  for (const [tag, want] of [['a', 2], ['b', 2], ['c', 2], ['d', 2]]) {
    const n = out.split('\n').filter((l) => new RegExp(`^- ${tag}\\d`).test(l)).length;
    assert.equal(n, want, `${tag} 槽该分到 ${want} 条（轮转），实际 ${n}`);
  }
});

ok('每槽限额不会把摘要清空（只剩一个槽也留一条）', () => {
  const out = normalizeSlots('【谁在要什么】\n- 就一条', { maxLines: 8, perSlotMax: 3 });
  assert.ok(out.includes('就一条'));
  const one = normalizeSlots('【谁在要什么】\n- 一\n- 二', { maxLines: 8, perSlotMax: 1 });
  assert.ok(one.includes('一') && !one.includes('二'), one);
});

ok('压缩请求写明每块上限（让模型自己合并，代码只是兜底）', () => {
  const on = buildSummaryMessages({ maxLines: 8, maxChars: 800, perSlotMax: 3 })[1].content;
  assert.ok(on.includes('每块最多 3 条'), '提示词里得有这条约束');
  assert.ok(on.includes('合并成一条'), '得告诉它超了怎么处理');
  const off = buildSummaryMessages({ maxLines: 8, maxChars: 800, perSlotMax: 0 })[1].content;
  assert.ok(!off.includes('每块最多'), '关了就不该提每块上限（否则和 maxLines 打架）');
});

ok('formatForPrompt 也按每槽裁（磁盘上的旧摘要兜一道）', () => {
  const store = new PastSummaryStore();
  const key = 'group_slotcap';
  store.commit(key, { summary: ASKING_BOMB, uptoId: 5 });
  // 摘要本身没超 maxChars，走的是"装得下直接返回"分支 —— 这条路径不该动手
  const fit = store.formatForPrompt(key, { maxChars: 800, perSlotMax: 3 });
  assert.equal(fit.split('\n').filter((l) => /^- 第\d+个人/.test(l)).length, 8, '装得下就不该裁');
  // 超字数才进槽位淘汰，这时按每槽裁
  const tight = store.formatForPrompt(key, { maxChars: 120, perSlotMax: 3 });
  assert.ok(tight.length <= 120, `超预算必须真裁：${tight.length}`);
});

console.log(`\n[past-summary] ${pass} 项通过`);
try { fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ }
