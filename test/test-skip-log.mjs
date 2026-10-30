// 跳过记录 + 未读单点消费自测（P1-4 / P1-5）。
//
// 这两件事必须一起测，因为它们是同一个问题的两半：
//   · store 只"看见"不"消费" → 面板才知道哪些是没看见、哪些是看见了不回；
//   · skip-log 记下"为什么不回" → 否则"看见了不回"等于没有解释。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 落在项目 data/ 下而不是系统 temp：沙箱里 temp 常见 EPERM，
// 那样测试会**静默读到旧文件**后面通过（真空里通过比失败更糟）。
const tmp = path.join(process.cwd(), 'data', `test-skip-log-${process.pid}.jsonl`);
try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }

const { newTraceId, recordSkip, recentSkips, skipStats, describeSkip, resetSkipMemory, setSkipLogFile, flushSkips, SKIP_STAGES } =
  await import('../src/skip-log.js');
const { ChatStore } = await import('../src/store.js');

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }
async function okAsync(name, fn) { await fn(); pass += 1; console.log('  ✓', name); }

console.log('[skip-log / unread]');

// ── traceId ─────────────────────────────────────────────────────────────
ok('traceId 是 12 位十六进制，可注入 rng（测试能造确定的把手）', () => {
  const id = newTraceId();
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.strictEqual(newTraceId(() => 0), '000000000000');
  assert.notStrictEqual(newTraceId(), newTraceId(), '两次不该撞');
});

// ── 记账 ────────────────────────────────────────────────────────────────
setSkipLogFile(tmp);
resetSkipMemory();

ok('recordSkip 返回完整记录并把 traceId 落上', () => {
  const rec = recordSkip({
    stage: SKIP_STAGES.GATE, chatKey: 'group:1',
    reason: '无关群聊', detail: { p: 0.15 }
  });
  assert.ok(rec.traceId && rec.traceId.length === 12);
  assert.strictEqual(rec.stage, 'gate');
  assert.strictEqual(rec.chatKey, 'group:1');
  assert.ok(rec.at > 0);
});

ok('传进来的 traceId 原样沿用（一条链上同一个把手）', () => {
  const rec = recordSkip({ stage: SKIP_STAGES.MODEL_SILENT, chatKey: 'private:2', reason: '没接', traceId: 'abcdef123456' });
  assert.strictEqual(rec.traceId, 'abcdef123456');
});

ok('recentSkips 按时间正序返回', () => {
  resetSkipMemory();
  recordSkip({ stage: 'gate', chatKey: 'g:a', reason: '一' });
  recordSkip({ stage: 'egress', chatKey: 'g:b', reason: '二' });
  const list = recentSkips(10);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].reason, '一');
  assert.strictEqual(list[1].reason, '二');
});

ok('skipStats 按阶段聚合（面板"为什么没回"的数据源）', () => {
  resetSkipMemory();
  recordSkip({ stage: 'gate', chatKey: 'g:a', reason: 'x' });
  recordSkip({ stage: 'gate', chatKey: 'g:b', reason: 'x' });
  recordSkip({ stage: 'model-silent', chatKey: 'g:c', reason: 'x' });
  const stats = skipStats();
  assert.strictEqual(stats.gate, 2);
  assert.strictEqual(stats['model-silent'], 1);
});

ok('describeSkip 一行内带阶段/会话/原因/traceId', () => {
  const line = describeSkip({ stage: 'gate', chatKey: 'group:1', reason: '无关群聊', traceId: 'abc123abc123', detail: { p: 0.15 } });
  assert.ok(line.startsWith('[跳过·gate]'));
  assert.ok(line.includes('group:1'));
  assert.ok(line.includes('无关群聊'));
  assert.ok(line.includes('#abc123abc123'));
  assert.ok(line.includes('p=0.15'));
});

ok('stage 枚举不缺项（每个枚举值都是稳定的短横线串）', () => {
  for (const [k, v] of Object.entries(SKIP_STAGES)) {
    assert.match(v, /^[a-z][a-z-]*$/, `${k} 的枚举值不合法：${v}`);
  }
});

ok('每个枚举值都有人记账（没有空转的枚举项）', () => {
  // 枚举是为了让面板能统计"哪一类跳过最多"。加了一项却没人记，
  // 面板上就会多出一格永远是 0 的分类，读的人会以为是那类真没发生过。
  const files = ['orchestrator.js', 'sender.js', 'app.js'];
  const src = files.map((f) => fs.readFileSync(path.join('src', f), 'utf8')).join('\n');
  const dead = Object.entries(SKIP_STAGES)
    .filter(([, v]) => !src.includes(`SKIP_STAGES.${Object.entries(SKIP_STAGES).find(([, x]) => x === v)[0]}`))
    .map(([, v]) => v);
  assert.deepStrictEqual(dead, [], `这些枚举没有接线：${dead.join('/')}`);
});

ok('落盘是 jsonl（追加写，进程被杀不会毁掉整个文件）', () => {
  resetSkipMemory();
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  recordSkip({ stage: 'gate', chatKey: 'g:x', reason: '写盘验证一' });
  recordSkip({ stage: 'gate', chatKey: 'g:x', reason: '写盘验证二' });
  // 走真实缓冲 + flush（不是 sleep 等异步，等不到就会"真空里通过"）
  assert.strictEqual(flushSkips(), 2, 'flush 应写出两条');
  assert.ok(fs.existsSync(tmp), `跳过记录没有落盘：${tmp}`);
  const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, '每次 flush 一批，不该写出半行');
  const last = JSON.parse(lines[1]);
  assert.strictEqual(last.reason, '写盘验证二');
});

// ── 未读单点消费 ────────────────────────────────────────────────────────
const store = new ChatStore(0);
const KEY = 'group:990001';
const cleanup = () => {
  try { fs.rmSync(path.join(process.env.QQAGENT_DATA_DIR || '', ''), { force: true }); } catch { /* ignore */ }
};

function seed(n = 3) {
  // 每个测试自己造新消息，靠 id 递增区分，不依赖上一步的残留 read 状态
  for (let i = 0; i < n; i += 1) {
    store.appendIncoming(KEY, { mid: `m${Date.now()}-${i}-${Math.random()}`, ts: Date.now(), senderId: '111', senderName: '甲', text: `第${i}条` });
  }
}

ok('noteUnread 只读不消费（判定要能反复看同一批）', () => {
  seed(2);
  const before = store.unreadCount(KEY);
  const snap = store.noteUnread(KEY);
  assert.strictEqual(snap.length, before);
  assert.strictEqual(store.unreadCount(KEY), before, 'noteUnread 不许改状态');
});

ok('consume 只消费给定 id，其余仍是未读', () => {
  const snap = store.noteUnread(KEY);
  assert.ok(snap.length >= 2);
  const consumed = store.consume(KEY, [snap[0].id]);
  assert.strictEqual(consumed, 1);
  assert.strictEqual(store.unreadCount(KEY), snap.length - 1);
});

ok('drainUnread 之后新到的消息**必然留下**（快照-消费语义的核心）', () => {
  const snap = store.noteUnread(KEY);
  // 模拟"判定期间新到一条"：先消费旧快照，再写新消息
  store.consume(KEY, snap.map((m) => m.id));
  store.appendIncoming(KEY, { mid: 'new-arrival', ts: Date.now(), senderId: '222', senderName: '乙', text: '后来的' });
  const left = store.noteUnread(KEY);
  assert.strictEqual(left.length, 1, '新到的那条不能被顺手吃掉');
  assert.strictEqual(left[0].text, '后来的');
});

ok('没有 markAllRead / clearUnread 这类入口（结构上写不出"顺手全清"）', () => {
  assert.strictEqual(typeof store.markAllRead, 'undefined');
  assert.strictEqual(typeof store.clearUnread, 'undefined');
});

ok('consume 对不存在的 id 静默跳过，不改任何状态', () => {
  const before = store.unreadCount(KEY);
  assert.strictEqual(store.consume(KEY, [99999999]), 0);
  assert.strictEqual(store.unreadCount(KEY), before);
});

ok('drainUnread 返回值就是被消费的那批（顺序稳定）', () => {
  seed(2);
  const snap = store.drainUnread(KEY);
  assert.ok(snap.length >= 2);
  assert.strictEqual(store.unreadCount(KEY), 0);
  assert.ok(snap[0].ts <= snap[snap.length - 1].ts);
});

// 收尾：删掉测试写入的会话文件
try {
  const file = path.join('data', 'messages', `${KEY.replace(/[^a-z0-9_]/gi, '_')}.json`);
  fs.rmSync(file, { force: true });
} catch { /* ignore */ }
try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }

console.log(`✓ skip-log / unread 自测通过（${pass} 项）`);
