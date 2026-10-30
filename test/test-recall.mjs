// 老消息回查（学自实施包 06 的"按关键词回查原片段"）：只测 store.search 与工具接线，
// 不碰网络、不碰真实 data/（用临时数据目录）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-recall-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { ChatStore } = await import('../src/store.js');
const { buildToolDefs } = await import('../src/tools.js');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const KEY = 'group:2002';
const store = new ChatStore(0);
const t0 = Date.now() - 3600 * 1000;
store.appendIncoming(KEY, { mid: 11, ts: t0, senderId: '10001', senderName: '小明', text: '我把那个链接发群里了 https://example.com/a' });
store.appendIncoming(KEY, { mid: 12, ts: t0 + 1000, senderId: '10002', senderName: '小红', text: '什么链接？我没看到' });
store.appendSelf(KEY, { text: '就那个 GitHub 的仓库啊', ts: t0 + 2000 });
store.appendIncoming(KEY, { mid: 13, ts: t0 + 3000, senderId: '10001', senderName: '小明', text: 'github.com/foo/bar 这个' });
store.appendIncoming('group:3003', { mid: 21, ts: t0 + 4000, senderId: '10001', senderName: '小明', text: '另一个群的 github 消息' });

const okAsync = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

console.log('老消息回查');

ok('单个关键词能搜到，新的在前', () => {
  const hits = store.search(KEY, { keyword: 'github' });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].mid, 13);
  assert.equal(hits[1].mid, null);       // 自己发的那条
});

ok('多个关键词是 AND（全部命中才算）', () => {
  assert.equal(store.search(KEY, { keyword: 'github 链接' }).length, 0);
  assert.equal(store.search(KEY, { keyword: '链接 发群里' }).length, 1);
});

ok('大小写不敏感', () => {
  assert.equal(store.search(KEY, { keyword: 'GITHUB' }).length, 2);
});

ok('按人过滤：只有他说的（"我"也是一等公民）', () => {
  const onlyMing = store.search(KEY, { keyword: 'github', sender: '小明' });
  assert.equal(onlyMing.length, 1);
  assert.equal(onlyMing[0].mid, 13);
  assert.equal(store.search(KEY, { keyword: 'github', sender: '10002' }).length, 0);
  assert.equal(store.search(KEY, { keyword: 'github', sender: '我' }).length, 1);
});

ok('绝不跨会话：别的群的同关键词搜不到', () => {
  const hits = store.search(KEY, { keyword: '另一个群' });
  assert.equal(hits.length, 0);
});

ok('limit 生效；scan 只扫最近 N 条', () => {
  assert.equal(store.search(KEY, { keyword: 'github', limit: 1 }).length, 1);
  assert.equal(store.search(KEY, { keyword: '链接', maxScan: 1 }).length, 0);   // 最近一条是 github
});

ok('空关键词直接返回空（不返回整份存档）', () => {
  assert.deepEqual(store.search(KEY, { keyword: '   ' }), []);
});

await okAsync('search_messages 工具已注册，且强制要 keyword', async () => {
  const defs = buildToolDefs();
  const tool = defs.find((d) => d.name === 'search_messages');
  assert.ok(tool, '缺 search_messages');
  assert.ok(tool.parameters.required.includes('keyword'));
  const ctx = { chatKey: KEY, store };
  const empty = await tool.execute(ctx, { keyword: '' });
  assert.match(String(empty.content ?? empty), /keyword|不能为空/);
});

await okAsync('search_messages 返回带 messageId 与发送者（可用来引用）', async () => {
  const tool = buildToolDefs().find((d) => d.name === 'search_messages');
  const r = await tool.execute({ chatKey: KEY, store }, { keyword: 'github', limit: 5 });
  const data = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
  const payload = data?.data ?? data;
  assert.equal(payload.count, 2);
  assert.equal(payload.messages[0].messageId, 13);
  assert.equal(payload.messages[0].sender, '小明');
});

await okAsync('search_messages 内存里不够时回落归档，并标注"更早的存档"', async () => {
  // 内存只留最近 maxMessagesPerChat 条，更早的进了 data/archive（store 侧已单测）。
  // 这里验工具层：内存搜到 0 条时必须去归档找，且结果里带 archived 标记 ——
  // 不然模型会以为"没这回事"，而其实只是滚出内存了。
  const tool = buildToolDefs().find((d) => d.name === 'search_messages');
  const fakeStore = {
    search: () => [],
    searchArchive: () => ([{
      mid: 77, ts: Date.now() - 86400000, senderId: '123', senderName: '老王',
      text: '上周发的那个 github 链接', self: false, archived: '2026-10-19'
    }])
  };
  const r = await tool.execute({ chatKey: KEY, store: fakeStore }, { keyword: 'github' });
  const data = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
  const payload = data?.data ?? data;
  assert.equal(payload.count, 1, '没有回落归档');
  assert.equal(payload.fromArchive, 1);
  assert.equal(payload.messages[0].messageId, 77);
  assert.match(String(payload.messages[0].archived || ''), /更早/);
});

await okAsync('search_messages 显式传 scan 时不回落归档（尊重"只搜最近"）', async () => {
  const tool = buildToolDefs().find((d) => d.name === 'search_messages');
  let archiveCalls = 0;
  const fakeStore = {
    search: () => [],
    searchArchive: () => { archiveCalls += 1; return []; }
  };
  await tool.execute({ chatKey: KEY, store: fakeStore }, { keyword: 'github', scan: 100 });
  assert.equal(archiveCalls, 0, '传了 scan 还去翻归档，等于无视用户意图');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项`);
