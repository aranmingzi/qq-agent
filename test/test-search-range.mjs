// search_messages 的 id 区间（翻页）自测（2026-10-26 P2）。
//
// 要修的问题：搜索只返回"最新 N 条"，再往前就没有入口了。
// 模型想把"上个月那个链接"翻出来，只能反复换关键词猜，或者干脆说没印象。
// 现在给它 `before` / `after`（按提示词里那个 #消息id 定位）+ 满页时回传 `nextBefore`。
//
// 断言要点（每条都对应一个真实的失败模式）：
//   ① 开区间：before 是"比它更早"，不含它自己（含了就会无限翻同一页）；
//   ② `beforeId: ''` / null **不等于 0** —— Number('')===0 会把搜索变成永远空结果；
//   ③ 同毫秒的多条消息不能被一起吞掉（所以按本地 id 而不是 ts 做区间）；
//   ④ 锚点找不到时要**说出来**，不能悄悄当成"没设边界"（模型会以为只有这么多）；
//   ⑤ 锚点已经滚进归档时，翻页仍然要接得上（findAnywhere 跨内存+归档）；
//   ⑥ 归档搜索本身也遵守区间。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-range-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { ChatStore } = await import('../src/store.js');
const { buildToolDefs } = await import('../src/tools.js');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name, '\n    ', error?.message ?? error);
    process.exitCode = 1;
  }
};
const okAsync = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name, '\n    ', error?.message ?? error);
    process.exitCode = 1;
  }
};

console.log('[search-range]');

const CHAT = 'group:700001';
const BASE = new Date(2026, 9, 20, 9, 0, 0).getTime();
const store = new ChatStore(0);
for (let i = 1; i <= 30; i += 1) {
  store.appendIncoming(CHAT, {
    mid: 900000 + i,
    ts: BASE + i * 1000,
    senderId: '10001',
    senderName: '张三',
    text: `第${i}条：这次聊的是季度报告`
  });
}
const ids = (hits) => hits.map((m) => m.id);
const tool = buildToolDefs().find((d) => d.name === 'search_messages');
const call = async (args, ctxStore = store, chatKey = CHAT) => {
  const r = await tool.execute({ chatKey, store: ctxStore }, args);
  const data = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
  return data?.data ?? data;
};

ok('① before 是开区间：只给"更早的"，不含锚点那条', () => {
  const all = store.search(CHAT, { keyword: '季度报告', limit: 5 });
  assert.deepEqual(ids(all), [30, 29, 28, 27, 26]);
  const older = store.search(CHAT, { keyword: '季度报告', limit: 5, beforeId: 26 });
  assert.deepEqual(ids(older), [25, 24, 23, 22, 21], '翻页第一页应该从锚点的前一条开始');
});

ok('② beforeId 传空串/null 不能退化成 0（否则搜索永远空）', () => {
  const a = store.search(CHAT, { keyword: '季度报告', limit: 3 });
  const b = store.search(CHAT, { keyword: '季度报告', limit: 3, beforeId: '' });
  const c = store.search(CHAT, { keyword: '季度报告', limit: 3, beforeId: null });
  assert.deepEqual(ids(b), ids(a), "beforeId='' 被当成了 0");
  assert.deepEqual(ids(c), ids(a), 'beforeId=null 被当成了 0');
});

ok('③ 同毫秒的多条不会被一起吞掉（按本地 id 而不是 ts 做区间）', () => {
  const K = 'group:700009';
  const S = new ChatStore(0);
  const t = BASE;
  const e1 = S.appendIncoming(K, { mid: 1, ts: t, senderId: '1', senderName: 'A', text: '同一秒报告一' });
  const e2 = S.appendIncoming(K, { mid: 2, ts: t, senderId: '1', senderName: 'A', text: '同一秒报告二' });
  const e3 = S.appendIncoming(K, { mid: 3, ts: t, senderId: '1', senderName: 'A', text: '同一秒报告三' });
  const got = S.search(K, { keyword: '报告', limit: 5, beforeId: e3.id });
  assert.deepEqual(got.map((m) => m.id), [e2.id, e1.id], '同毫秒的两条被区间一起吞了');
  assert.equal(S.search(K, { keyword: '报告', limit: 5, afterId: e1.id }).length, 2);
});

ok('④ after 同样是开区间', () => {
  const got = store.search(CHAT, { keyword: '季度报告', limit: 5, afterId: 28 });
  assert.deepEqual(ids(got), [30, 29]);
});

ok('⑤ before + after 组成区间', () => {
  const got = store.search(CHAT, { keyword: '季度报告', limit: 10, beforeId: 21, afterId: 11 });
  assert.deepEqual(ids(got), [20, 19, 18, 17, 16, 15, 14, 13, 12]);
});

await okAsync('⑥ 工具层：满一页时回传 nextBefore，且等于最旧命中那条的 mid', async () => {
  const p = await call({ keyword: '季度报告', limit: 5 });
  assert.equal(p.count, 5);
  assert.equal(p.nextBefore, `mid:${900000 + 26}`, `nextBefore 应该是第 26 条的 mid（带前缀），实际 ${p.nextBefore}`);
});

await okAsync('⑦ 工具层：拿 nextBefore 当 before 再搜，接着往前且不重叠', async () => {
  const p1 = await call({ keyword: '季度报告', limit: 5 });
  const p2 = await call({ keyword: '季度报告', limit: 5, before: p1.nextBefore });
  const set1 = new Set(p1.messages.map((m) => m.messageId));
  assert.ok(p2.messages.every((m) => !set1.has(m.messageId)), '第二页和第一页有重叠');
  assert.equal(p2.messages[0].messageId, 900000 + 25);
});

await okAsync('⑧ 工具层：before 接受带 # 的写法（模型会照抄提示词里的 #id）', async () => {
  const p = await call({ keyword: '季度报告', limit: 3, before: '#900027' });
  assert.equal(p.messages[0].messageId, 900000 + 26, `带 # 的锚点没解析出来：${JSON.stringify(p.messages[0])}`);
});

await okAsync('⑨ 工具层：锚点找不到时必须说出来，不能静默当成"没边界"', async () => {
  const p = await call({ keyword: '季度报告', limit: 3, before: '123456789' });
  assert.match(String(p.note || ''), /找不到/, '没有提示 = 模型会以为"就这么多"');
  assert.equal(p.count, 3, '找不到锚点时应退回第一页');
});

await okAsync('⑩ 工具层：翻到最后一页时不再给 nextBefore', async () => {
  const p = await call({ keyword: '季度报告', limit: 5, before: '#900003' });
  assert.equal(p.count, 2);
  assert.equal(p.nextBefore, undefined, '已经是最后一页了还给 nextBefore，会让模型一直翻');
});

// ── 撞号：QQ mid 与本地 id 都是数字，会重 ──────────────────────────────
// 真机翻页翻出来的 bug（group_20000001）：第 2 页和第 1 页重复了 3 条。
// 根因是上一页把本地序号 `4598` 原样回传，而库里真有一条 mid=4598、更靠后的消息，
// 解析时"先 mid 后 id"就选中了它 —— 锚点偏移，翻页原地打转。
ok('⑭ 两套 id 撞号时靠前缀区分：id:11 ≠ mid:11', () => {
  const K = 'group:700005';
  const S = new ChatStore(0);
  for (let i = 1; i <= 10; i += 1) {
    S.appendIncoming(K, { mid: 7000 + i, ts: BASE + i, senderId: '1', senderName: 'A', text: `撞号测试${i}` });
  }
  const self = S.appendSelf(K, { text: '撞号测试（我自己发的，没有 mid）', ts: BASE + 11 });
  const collide = S.appendIncoming(K, { mid: 11, ts: BASE + 12, senderId: '2', senderName: 'B', text: '撞号测试（mid 正好等于上一条的本地 id）' });
  assert.equal(self.id, 11, '测试前提变了：self 的本地 id 应该是 11');
  assert.equal(collide.id, 12);
  // 裸数字按老规矩先当 mid
  assert.equal(S.findAnywhere(K, '11').id, collide.id, '裸数字应该先按 mid 解析');
  // 加了前缀就必须各归各的
  assert.equal(S.findAnywhere(K, 'id:11').id, self.id, 'id: 前缀没生效');
  assert.equal(S.findAnywhere(K, 'mid:11').id, collide.id, 'mid: 前缀没生效');
  assert.equal(S.findAnywhere(K, 'id：11').id, self.id, '全角冒号也要认');
});

await okAsync('⑮ nextBefore 带前缀，撞号也不会翻页打转', async () => {
  // 用新的会话键：上面那个已经把数据写盘了，复用会接着 load，本地 id 不是从 1 开始
  const K = 'group:700006';
  const S = new ChatStore(0);
  for (let i = 1; i <= 10; i += 1) {
    S.appendIncoming(K, { mid: 7000 + i, ts: BASE + i, senderId: '1', senderName: 'A', text: `撞号测试${i}` });
  }
  S.appendSelf(K, { text: '撞号测试（我自己发的，没有 mid）', ts: BASE + 11 });
  S.appendIncoming(K, { mid: 11, ts: BASE + 12, senderId: '2', senderName: 'B', text: '撞号测试（mid 正好等于上一条的本地 id）' });
  const p1 = await call({ keyword: '撞号测试', limit: 2 }, S, K);
  assert.match(String(p1.nextBefore), /^(mid|id):/, `nextBefore 必须带前缀，实际 ${p1.nextBefore}`);
  assert.equal(p1.nextBefore, 'id:11', '最旧那条是我自己发的，应该回传 id:11');
  const p2 = await call({ keyword: '撞号测试', limit: 2, before: p1.nextBefore }, S, K);
  const set1 = new Set(p1.messages.map((m) => m.text));
  assert.ok(p2.messages.every((m) => !set1.has(m.text)), `第二页和第一页重复了：${p2.messages.map((m) => m.text).join(' / ')}`);
  assert.equal(p2.count, 2, '撞号把中间几条跳过了');
});

// ── 归档：锚点滚出内存后仍要接得上 ─────────────────────────────────────
const ARCH = 'group:700002';
const small = new ChatStore(20);
for (let i = 1; i <= 60; i += 1) {
  small.appendIncoming(ARCH, {
    mid: 800000 + i,
    ts: BASE + i * 1000,
    senderId: '10002',
    senderName: '李四',
    text: `第${i}条：归档里的报告`
  });
}
// 内存只剩最后 20 条（id 41..60），第 1..40 条已进归档
ok('⑪ findAnywhere 能在归档里定位锚点（否则翻到边界就断页）', () => {
  const hit = small.findAnywhere(ARCH, '#800010');
  assert.ok(hit, '归档里的锚点没找到');
  assert.equal(hit.where, 'archive');
  assert.equal(hit.id, 10);
});

ok('⑫ 归档搜索遵守 beforeId 区间', () => {
  const got = small.searchArchive(ARCH, { keyword: '归档里', limit: 5 });
  assert.deepEqual(got.map((m) => m.id), [40, 39, 38, 37, 36]);
  const older = small.searchArchive(ARCH, { keyword: '归档里', limit: 5, beforeId: 36 });
  assert.deepEqual(older.map((m) => m.id), [35, 34, 33, 32, 31]);
});

await okAsync('⑬ 工具层：内存->归档跨边界翻页不重叠、不重复', async () => {
  const p1 = await call({ keyword: '归档里的报告', limit: 25 }, small, ARCH);
  assert.equal(p1.count, 25);
  const p2 = await call({ keyword: '归档里的报告', limit: 25, before: p1.nextBefore }, small, ARCH);
  const set1 = new Set(p1.messages.map((m) => m.messageId));
  assert.ok(p2.count > 0 && p2.messages.every((m) => !set1.has(m.messageId)), '跨边界翻页出现重复');
  // 第一页最旧的是内存里的第 36 条，第二页必须一路接进归档
  assert.equal(p2.messages[0].messageId, 800000 + 35);
  assert.ok(p2.messages.some((m) => m.archived), '第二页应该已经翻进归档了');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[search-range] ${pass} 项通过`);
