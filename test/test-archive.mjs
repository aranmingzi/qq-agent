// 滚动归档自测（2026-10-26）。
//
// 这条测试针对一个"听起来不报错、用起来却像失忆"的缺陷：
//   store 的 maxPerChat=2000，旧实现直接 splice 丢掉更早的消息，
//   于是 search_messages 号称"搜整份存档"，实际只能翻一周。
//
// 断言五条：
//   ① 被裁掉的消息必须能在归档里找到（第 1 条也要能找到）；
//   ② 归档是**追加**的：再裁一批不会把前面的覆盖掉，也不会重复写同一条；
//   ③ 关掉归档 = 回到旧行为（只裁不存），用来做对照；
//   ④ 新进程（重新 new ChatStore）也能搜到 —— 证明是落盘的，不是内存假象；
//   ⑤ 归档目录按天分片，stats 能看出跨了多少天。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-archive-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { ChatStore } = await import('../src/store.js');
const { DATA_DIR } = await import('../src/config.js');

assert.equal(path.resolve(DATA_DIR), path.resolve(TMP), '数据目录没被隔离，测试会写脏真实 data/');

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

console.log('[archive]');

const CHAT = 'group:900001';
const DAY = 86400000;
const BASE = new Date(2026, 9, 20, 9, 0, 0).getTime();   // 2026-10-20 09:00 本地时间

function mk(i, tsOverride) {
  return {
    mid: 500000 + i,
    ts: tsOverride ?? (BASE + i * 1000),
    senderId: '10001',
    senderName: '张三',
    text: `第${i}条：这次聊的是归档验证`
  };
}

const store = new ChatStore(2000);
for (let i = 1; i <= 3000; i += 1) store.appendIncoming(CHAT, mk(i));

ok('① 裁掉的最旧那条（第 1 条）能从归档里搜回来', () => {
  // 用精确词搜：`limit` 的语义是"最新 N 条"，用一个所有消息都命中的词会只命中尾部，
  // 那是 limit 在起作用，不是归档缺条。
  const hits = store.searchArchive(CHAT, { keyword: '第1条', limit: 10 });
  assert.equal(hits.length, 1, `应命中 1 条，实际 ${hits.length}`);
  assert.match(hits[0].text, /^第1条/, `命中的不是第 1 条：${hits[0].text}`);
  // 内存里应该已经没有第 1 条了（否则说明 trim 没生效，测试前提不成立）
  const inMem = store.search(CHAT, { keyword: '第1条', limit: 5 });
  assert.equal(inMem.length, 0, '第 1 条还在内存里，说明 maxPerChat 没生效 —— 测试前提不成立');
});

ok('①b 归档条数对得上：裁了 1000 条就存了 1000 条', () => {
  const file = path.join(TMP, 'archive', 'group_900001', '2026-10-20.jsonl');
  assert.ok(fs.existsSync(file), `归档文件不存在：${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1000, `归档行数错了：${lines.length}`);
});

ok('② 再裁一批是追加，不覆盖、不重复', () => {
  for (let i = 3001; i <= 4000; i += 1) store.appendIncoming(CHAT, mk(i));
  const file = path.join(TMP, 'archive', 'group_900001', '2026-10-20.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2000, `追加后行数应为 2000，实际 ${lines.length}`);
  // 第 1 条仍然在（没被覆盖）
  const ids = lines.map((l) => { try { return JSON.parse(l).mid; } catch { return null; } });
  assert.ok(ids.includes(500001), '第 1 条被覆盖了');
  // 没有重复归档同一条
  assert.equal(new Set(ids).size, ids.length, '归档里出现了重复条目');
});

ok('②b 同一条被重复 trim 也不会二次落盘（内存已移除）', () => {
  const before = fs.readFileSync(path.join(TMP, 'archive', 'group_900001', '2026-10-20.jsonl'), 'utf8')
    .split('\n').filter(Boolean).length;
  // 再追加 10 条，只会裁掉 10 条新的
  for (let i = 4001; i <= 4010; i += 1) store.appendIncoming(CHAT, mk(i));
  const after = fs.readFileSync(path.join(TMP, 'archive', 'group_900001', '2026-10-20.jsonl'), 'utf8')
    .split('\n').filter(Boolean).length;
  assert.equal(after - before, 10, `追加 10 条消息应只归档 10 条，实际 ${after - before}`);
});

ok('③ 关掉归档 = 旧行为（只裁不存）', () => {
  const CHAT2 = 'group:900002';
  const s2 = new ChatStore(50);
  s2.setArchiveEnabled(false);
  for (let i = 1; i <= 120; i += 1) s2.appendIncoming(CHAT2, mk(i));
  const hits = s2.searchArchive(CHAT2, { keyword: '归档验证', limit: 10 });
  assert.equal(hits.length, 0, '关掉归档后不该有归档文件');
  assert.equal(s2.archiveStats(CHAT2).days, 0, 'stats 应为空');
});

ok('④ 新进程重新读盘也能搜到（是落盘不是内存假象）', () => {
  const fresh = new ChatStore(2000);
  const hits = fresh.searchArchive(CHAT, { keyword: '第1条', limit: 5 });
  assert.equal(hits.length, 1, `新实例只搜到 ${hits.length} 条`);
  assert.match(hits[0].text, /^第1条/);
  assert.equal(hits[0].archived, '2026-10-20', '归档日期标注不对');
});

ok('⑤ 跨天分片 + stats 能看出来', () => {
  const CHAT3 = 'group:900003';
  const s3 = new ChatStore(2);
  // 三天的消息，每次都会裁 → 归档分三个文件
  for (let d = 0; d < 3; d += 1) {
    for (let i = 0; i < 4; i += 1) {
      s3.appendIncoming(CHAT3, mk(d * 10 + i, BASE + d * DAY + i * 60000));
    }
  }
  const st = s3.archiveStats(CHAT3);
  assert.equal(st.days, 3, `应有 3 天分片，实际 ${st.days}`);
  assert.ok(st.bytes > 0, 'bytes 应大于 0');
  assert.equal(st.oldest, '2026-10-20', `最早一天不对：${st.oldest}`);
  assert.equal(st.newest, '2026-10-22', `最晚一天不对：${st.newest}`);
});

ok('⑥ 搜归档支持按人过滤、且新的在前', () => {
  const CHAT4 = 'group:900004';
  const s4 = new ChatStore(3);
  for (let i = 1; i <= 12; i += 1) {
    s4.appendIncoming(CHAT4, {
      mid: 700000 + i,
      ts: BASE + i * 1000,
      senderId: i % 2 === 0 ? '20002' : '10001',
      senderName: i % 2 === 0 ? '李四' : '张三',
      text: `第${i}条：共同关键词`
    });
  }
  const lisi = s4.searchArchive(CHAT4, { keyword: '共同关键词', sender: '李四', limit: 20 });
  assert.ok(lisi.length > 0, '按人过滤没搜到');
  assert.ok(lisi.every((m) => m.senderName === '李四'), '混进了别人的消息');
  // maxPerChat=3 → 第 10/11/12 条还在内存，归档里最新的李四是第 8 条
  assert.match(lisi[0].text, /^第8条/, `归档里新的应该在前，实际第一条是 ${lisi[0].text}`);
});

console.log(`\n[archive] ${pass} 项通过`);
