// 时间段摘要自测（m00209）。
//
// 断言围绕"这层凭什么能便宜地补上背景，又不会变成新的故障源"：
//   ① 片键必须对齐钟点、可重算 —— 它是"一片只压一次"的全部依据（幂等的前提）；
//   ② 只在**真的要用**的那一轮才压，且只压**已经滑出热窗口**的片（不重复付钱）；
//   ③ 送模型的必须是本地挑出的代表句，不是整片原文（token 性价比的来源）；
//   ④ 归一化只认条目、绝不切半句（半句会被当成事实读）；
//   ⑤ 连续失败到阈值就停用，聊天照常 —— 补背景失败绝不能拖住她说话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

// 必须赶在 import config.js 之前改数据目录，否则会写进生产数据
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-digest-'));

const {
  slotKeyOf, slotBoundsOf, pickForSlot, planSlots, buildDigestMessages,
  normalizeDigest, renderSlotLine, TimeDigestStore, digestLead, DIGEST_DEFAULTS
} = await import('../src/time-digest.js');

let pass = 0;
function ok(name, fn) {
  fn();
  pass += 1;
  console.log('  ✓', name);
}

console.log('[time-digest]');

const SLOT = 15 * 60 * 1000;
// 一个整齐的时间基准：2023-11-15 12:00:00 本地时间那一格的开头
const BASE = Math.floor(new Date(2023, 10, 15, 12, 0, 0, 0).getTime() / SLOT) * SLOT;

const mk = (id, over = {}) => ({
  id,
  ts: BASE + id * 1000,
  senderId: '10001',
  senderName: '张三',
  text: `第${id}条消息`,
  self: false,
  media: [],
  ...over
});

// ── 片键 ────────────────────────────────────────────────────────────────
ok('片键向下对齐：同一格里的任何时刻 → 同一个键', () => {
  assert.equal(slotKeyOf(BASE), slotKeyOf(BASE + 1));
  assert.equal(slotKeyOf(BASE + SLOT - 1), slotKeyOf(BASE));
  assert.equal(slotKeyOf(BASE + SLOT), slotKeyOf(BASE) + 1);
});

ok('片键 → 起止时间：end - start 正好一片', () => {
  const b = slotBoundsOf(slotKeyOf(BASE + 1234), SLOT);
  assert.equal(b.start, BASE);
  assert.equal(b.end, BASE + SLOT);
  assert.equal(b.end - b.start, SLOT);
});

ok('坏输入不抛：ts=0 / 负 / 字符串都收成确定的键', () => {
  assert.equal(slotKeyOf(0), 0);
  assert.equal(Number.isSafeInteger(slotKeyOf(undefined)), true);
  const b = slotBoundsOf('abc');
  assert.equal(Number.isFinite(b.start), true);
});

// ── 挑代表句 ────────────────────────────────────────────────────────────
ok('占位符/单字符/空文本一律不进材料', () => {
  const lines = pickForSlot([
    mk(1, { text: '[表情13]' }),
    mk(2, { text: '[图片]' }),
    mk(3, { text: '1' }),
    mk(4, { text: '   ' }),
    mk(5, { text: '张三问了集合时间' })
  ]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /张三问了集合时间/);
});

ok('复读只留一次（群里刷"哈哈哈哈"不该占满预算）', () => {
  const lines = pickForSlot([
    mk(1, { text: '有人一起打本吗' }),
    mk(2, { text: '有人一起打本吗' }),
    mk(3, { text: '有人一起打本吗' }),
    mk(4, { text: '我也想打' })
  ]);
  assert.equal(lines.length, 2);
});

ok('自己的消息标成「我」', () => {
  const lines = pickForSlot([mk(1, { text: '我看了下时间是七点', self: true, senderName: '我' })]);
  assert.match(lines[0], /我：/);
  assert.doesNotMatch(lines[0], /self/);
});

ok('超上限时按信息量取前 N，但**按时间顺序**输出', () => {
  const raw = [
    mk(1, { text: '哈哈' }),
    mk(2, { text: '那就定在明天七点集合行不行' }),   // 高信息量
    mk(3, { text: '好的' }),
    mk(4, { text: '地点还是老地方吗' })              // 高信息量
  ];
  const lines = pickForSlot(raw, { limit: 2 });
  assert.equal(lines.length, 2);
  // 时间顺序 = 第 2 条在第 4 条之前
  assert.match(lines[0], /明天七点/);
  assert.match(lines[1], /老地方/);
});

ok('纯语气词得低分，不会被当成代表句', () => {
  const raw = [mk(1, { text: '哈哈哈哈' }), mk(2, { text: '明天七点在门口等' })];
  const lines = pickForSlot(raw, { limit: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /明天七点/);
});

// ── 切片规划 ────────────────────────────────────────────────────────────
ok('还在热窗口里的（id >= cutId）不压 —— 原文照旧给它，别重复付钱', () => {
  const msgs = [mk(1), mk(2), mk(3), mk(4)];
  const planned = planSlots(msgs, { now: BASE + 3 * SLOT, slotMs: SLOT, cutId: 3, minMessages: 1 });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].count, 2);      // 只有 id 1、2
});

ok('当前这一片还没结束 → 不压（还在长）', () => {
  const msgs = [mk(1), mk(2), mk(3)];
  const planned = planSlots(msgs, { now: BASE + 30 * 1000, slotMs: SLOT, minMessages: 1 });
  assert.deepEqual(planned, []);
});

ok('太稀疏的片不压（寒暄两句没有"大概"可言）', () => {
  const msgs = [mk(1), mk(2)];
  const planned = planSlots(msgs, { now: BASE + SLOT, slotMs: SLOT, minMessages: 3 });
  assert.deepEqual(planned, []);
  const planned2 = planSlots(msgs, { now: BASE + SLOT, slotMs: SLOT, minMessages: 2 });
  assert.equal(planned2.length, 1);
});

ok('最多回看 maxSlots 片，且按时间升序返回', () => {
  const msgs = [];
  for (let s = 0; s < 6; s += 1) {
    for (let i = 0; i < 3; i += 1) msgs.push(mk(s * 3 + i, { ts: BASE + s * SLOT + i * 1000 }));
  }
  const planned = planSlots(msgs, { now: BASE + 6 * SLOT, slotMs: SLOT, maxSlots: 4, minMessages: 1 });
  assert.equal(planned.length, 4);
  for (let i = 1; i < planned.length; i += 1) assert.ok(planned[i].start > planned[i - 1].start);
  // 取的是最近的 4 片（s=2..5）
  assert.equal(planned[planned.length - 1].start, BASE + 5 * SLOT);
});

ok('片里带上人数与代表句（供 renderSlotLine 用）', () => {
  const msgs = [
    mk(1, { senderName: '张三', text: '明天七点在门口等' }),
    mk(2, { senderName: '李四', text: '收到' }),
    mk(3, { senderName: '王五', text: '我也来' })
  ];
  const [slot] = planSlots(msgs, { now: BASE + SLOT, slotMs: SLOT, minMessages: 1 });
  assert.deepEqual(slot.senders, ['张三', '李四', '王五']);
  assert.equal(slot.count, 3);
  assert.ok(slot.lines.length >= 1);
});

// ── 组请求 ──────────────────────────────────────────────────────────────
ok('压缩请求：system 只管压缩，格式要求写在材料之前', () => {
  const [sys, user] = buildDigestMessages({ start: BASE, end: BASE + SLOT, lines: ['[12:01] 张三：明天七点'], perSlotChars: 120 });
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /只做压缩/);
  assert.match(sys.content, /绝不发明/);
  assert.match(user.content, /【时段】12:00 — 12:15/);
  assert.match(user.content, /不超过 120 字/);
  // 格式要求在材料之后属于"模型读不到"的经典坑，这里断言它排在规则段
  assert.ok(user.content.indexOf('请把这段时间压缩') > user.content.indexOf('[12:01] 张三'));
});

// ── 归一化 ──────────────────────────────────────────────────────────────
ok('摘掉代码块、开场白、小标题，只留条目', () => {
  const raw = '好的，以下是摘要：\n```\n# 这一段时间\n* 张三问了集合时间\n· 说好七点在门口\n```';
  const out = normalizeDigest(raw, { maxChars: 200, maxLines: 5 });
  assert.deepEqual(out.split('\n'), ['- 张三问了集合时间', '- 说好七点在门口']);
});

ok('模型漏写 "- " 的也当条目（不许整段丢失）', () => {
  const out = normalizeDigest('张三问了集合时间\n说好七点', { maxChars: 200 });
  assert.deepEqual(out.split('\n'), ['- 张三问了集合时间', '- 说好七点']);
});

ok('条数受限：maxLines 之后一律丢弃', () => {
  const out = normalizeDigest('- 一\n- 二\n- 三\n- 四\n- 五\n- 六\n- 七', { maxChars: 500, maxLines: 3 });
  assert.equal(out.split('\n').length, 3);
});

ok('字数受限时**整条丢**，绝不切半句', () => {
  const long1 = '- 张三说好明天七点在老地方集合';
  const long2 = '- 李四说明天可能来不了要去医院';
  const out = normalizeDigest(`${long1}\n${long2}`, { maxChars: 20, maxLines: 5 });
  assert.equal(out, long1);
  assert.doesNotMatch(out, /…/);      // 没有半句
});

ok('单条就超预算时才截断（且带省略号）', () => {
  const out = normalizeDigest('- 张三说好明天七点在老地方集合并且带上了所有人一起出发', { maxChars: 20, maxLines: 5 });
  assert.ok(out.length <= 22);
  assert.match(out, /…$/);
});

ok('空输出 / 纯开场白 → 空串（调用方按失败处理）', () => {
  assert.equal(normalizeDigest(''), '');
  assert.equal(normalizeDigest('好的'), '');
  assert.equal(normalizeDigest(null), '');
});

// ── 渲染 ────────────────────────────────────────────────────────────────
ok('一段压一行：时间 + 条数/人数 + 正文', () => {
  const rec = {
    key: 0, start: BASE, end: BASE + SLOT, count: 18, senders: ['张三', '李四'],
    summary: '- 张三问了集合时间\n- 说好七点在门口'
  };
  const line = renderSlotLine(rec);
  assert.equal(line, '12:00-12:15（18 条 / 2 人）：张三问了集合时间；说好七点在门口');
});

ok('没有摘要的片不渲染', () => {
  assert.equal(renderSlotLine(null), '');
  assert.equal(renderSlotLine({ start: BASE, end: BASE + SLOT, summary: '' }), '');
});

// ── 缓存 ────────────────────────────────────────────────────────────────
ok('落盘：commit 之后 slot() 取得到，键是字符串化的片键', () => {
  const store = new TimeDigestStore();
  const chat = 'group_999';
  store.commit(chat, { key: 100, start: BASE, end: BASE + SLOT, count: 5, senders: ['张三'], summary: '- 说好七点' });
  const rec = store.slot(chat, 100);
  assert.equal(rec.summary, '- 说好七点');
  assert.equal(store.slot(chat, 101), null);
});

ok('重现（新实例）仍然是同一片 —— 一片只压一次的落盘保证', () => {
  const chat = 'group_998';
  new TimeDigestStore().commit(chat, { key: 7, start: BASE, end: BASE + SLOT, count: 3, senders: [], summary: '- 聊了打本' });
  const again = new TimeDigestStore();
  assert.equal(again.slot(chat, 7).summary, '- 聊了打本');
});

ok('formatForPrompt：按传入顺序出，超预算丢最旧的（新的一段更贴现在）', () => {
  const store = new TimeDigestStore();
  const chat = 'group_997';
  for (let k = 0; k < 3; k += 1) {
    store.commit(chat, {
      key: k, start: BASE + k * SLOT, end: BASE + (k + 1) * SLOT, count: 4, senders: ['张三'],
      summary: `- 第${k}段他们聊了很久关于周末几点在哪集合以及带什么东西`
    });
  }
  const text = store.formatForPrompt(chat, [0, 1, 2], { maxChars: 120, perSlotChars: 200 });
  const lines = text.split('\n');
  assert.ok(lines.length >= 1);
  // 丢的是最旧的
  assert.ok(!lines[0].includes('第0段'), `实际首行: ${lines[0]}`);
  assert.ok(lines.join('\n').includes('第2段'));
});

ok('formatForPrompt：没有缓存记录 → 空串（整段不出现）', () => {
  const store = new TimeDigestStore();
  assert.equal(store.formatForPrompt('group_empty', [1, 2, 3]), '');
});

ok('熔断：连续失败到阈值就停用，之后不再进提示词', () => {
  const store = new TimeDigestStore();
  const chat = 'group_996';
  store.commit(chat, { key: 1, start: BASE, end: BASE + SLOT, count: 3, senders: [], summary: '- 旧摘要' });
  const r1 = store.bumpFail(chat, 3);
  assert.equal(r1.justDisabled, false);
  store.bumpFail(chat, 3);
  const r3 = store.bumpFail(chat, 3);
  assert.equal(r3.justDisabled, true);
  assert.equal(r3.disabled, true);
  assert.equal(store.formatForPrompt(chat, [1]), '');
  // 停用后再成功一次要能复活（片是被重压出来的，不是运气）
  store.commit(chat, { key: 2, start: BASE, end: BASE + SLOT, count: 3, senders: [], summary: '- 新摘要' });
  assert.equal(store.slot(chat, 2).summary, '- 新摘要');
  assert.equal(store.get(chat).failCount, 0);
});

ok('prune：只留最近 keep 片，磁盘不会无限长', () => {
  const store = new TimeDigestStore();
  const chat = 'group_995';
  for (let k = 0; k < 10; k += 1) {
    store.commit(chat, { key: k, start: BASE + k * SLOT, end: BASE + (k + 1) * SLOT, count: 3, senders: [], summary: `- 第${k}段` });
  }
  const dropped = store.prune(chat, 4);
  assert.equal(dropped, 6);
  assert.equal(store.slot(chat, 0), null);
  assert.ok(store.slot(chat, 9));
});

// ── 引导语与默认值 ──────────────────────────────────────────────────────
ok('引导语明确说了"不是原文、别复述"', () => {
  const lead = digestLead();
  assert.match(lead, /刚才那些时段/);
  assert.match(lead, /别复述/);
  assert.match(lead, /15 分钟/);
});

ok('默认值：15 分钟一片、回看 4 片、单次最多压 2 片', () => {
  assert.equal(DIGEST_DEFAULTS.slotMs, 15 * 60 * 1000);
  assert.equal(DIGEST_DEFAULTS.slots, 4);
  assert.equal(DIGEST_DEFAULTS.maxPerWake, 2);
  assert.ok(DIGEST_DEFAULTS.perSlotChars < DIGEST_DEFAULTS.maxChars);
  assert.ok(DIGEST_DEFAULTS.timeoutMs <= 15000);   // 回复链路上的硬超时不能太长
});

console.log(`\n✅ 时间段摘要 ${pass} 项通过`);
