// 发送额度前置感知的**接线**测试：证明 wake() 真的在开跑前挡住了满额度的轮次。
//
// 为什么单独一个文件：纯逻辑测试（test-send-quota.mjs）全绿也可能根本没接上
// —— 第 2 轮踩过这个坑（12 条断言全绿，但把接线那行删掉照样全绿）。
//
// 这里钉的是四个**行为**：
//   ① 额度满了 → 不开跑（不新建会话），且记一条 send-quota 跳过；
//   ② 关键：**未读消息没有被消费掉**（闸门在 drainUnread 之前），窗口滑过去还能处理；
//   ③ 额度满了 → 安排了重排（wakeTimers 里有条目），不是静默丢弃；
//   ④ 还有额度 / 不限 / 模块出错 / 开关关掉 → 一律放行。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-quota-wire-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { getConfig, updateConfig } = await import('../src/config.js');
await getConfig();
updateConfig({
  api: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model' },
  talk: { enabled: false },
  send: { maxPerMinute: 4, maxPerHour: 0 },
  proactive: { enabled: false },
  maxConcurrentRuns: 4
});

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { resetSkipMemory } = await import('../src/skip-log.js');

resetSkipMemory();

let pass = 0;
async function ok(name, fn) {
  try {
    await fn();
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
  pass += 1;
  console.log('  ✓', name);
}

const GROUP = 'group:20000005';
const FULL = { unlimited: false, window: 'minute', limit: 4, used: 4, remaining: 0, resetInMs: 30000 };
const FREE = { unlimited: false, window: 'minute', limit: 4, used: 1, remaining: 3, resetInMs: 0 };
const NONE = { unlimited: true, window: null, limit: 0, used: 0, remaining: Infinity, resetInMs: 0 };

const platform = { selfId: '99999', async sendText() { return { message_id: 'm1' }; } };

/** 造一个真的 Orchestrator，把 sender.quotaFor 换成脚本化的假实现。 */
function makeOrch(quota) {
  const store = new ChatStore();
  const sender = new SendQueue({ platform, store });
  let calls = 0;
  sender.quotaFor = function quotaFor() {
    calls += 1;
    if (typeof quota === 'function') return quota();
    return quota;
  };
  const sessions = new SessionRegistry(5);
  const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
  const bus = createEventBus();
  const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });
  const skips = [];
  bus.on('skip', (r) => skips.push(r));
  return {
    orch, store, sender, sessions, skips,
    quotaCalls: () => calls,
    quotaSkips: () => skips.filter((s) => s.stage === 'send-quota'),
    cleanup() { try { orch.aborted = true; } catch { /* 无所谓 */ } }
  };
}

/** 往群里塞一条未读，返回未读数。 */
function seedUnread(store, chatKey = GROUP) {
  store.appendIncoming(chatKey, { mid: `m${Math.random()}`, senderId: 'u1', senderName: '张三', text: '在吗', ts: Date.now() });
  return store.unreadCount(chatKey);
}

console.log('[send-quota-wire]');

// ── ① 满额度：挡住 + 留痕 + 不新建会话 ──────────────────────────────────
await ok('额度满了 → 不开跑，且记一条 send-quota 跳过', async () => {
  const t = makeOrch(FULL);
  seedUnread(t.store);
  const before = t.sessions.listSummaries().length;
  await t.orch.wake(GROUP);
  assert.strictEqual(t.sessions.listSummaries().length, before, '不应该新建会话');
  assert.ok(t.quotaCalls() >= 1, '应该真的问过额度');
  const hits = t.quotaSkips();
  assert.strictEqual(hits.length, 1, '应该正好留一条 send-quota 记录');
  assert.strictEqual(hits[0].detail.resetInMs, 30000);
  assert.strictEqual(hits[0].detail.used, 4);
  t.cleanup();
});

// ── ② 最关键：未读不能被吃掉 ─────────────────────────────────────────────
await ok('额度满了时未读消息保持未读（闸门必须在 drainUnread 之前）', async () => {
  const t = makeOrch(FULL);
  const unreadBefore = seedUnread(t.store);
  assert.ok(unreadBefore > 0, '前置：应该有未读');
  await t.orch.wake(GROUP);
  assert.strictEqual(t.store.unreadCount(GROUP), unreadBefore, '被额度挡下的轮次绝不能消费未读');
  t.cleanup();
});

// ── ③ 挡住时要重排，不是静默丢弃 ─────────────────────────────────────────
await ok('额度满了 → 挂了一个重排定时器（窗口滑过后自动再处理）', async () => {
  const t = makeOrch(FULL);
  seedUnread(t.store);
  await t.orch.wake(GROUP);
  assert.ok(t.orch.wakeTimers.size > 0, '应该挂重排定时器，否则消息就一直躺着');
  t.cleanup();
});

// ── ④ 放行的各种情况 ─────────────────────────────────────────────────────
await ok('还有额度 → 放行', () => {
  const t = makeOrch(FREE);
  assert.strictEqual(t.orch.checkSendQuota(GROUP), true);
  t.cleanup();
});

await ok('不限额度 → 放行', () => {
  const t = makeOrch(NONE);
  assert.strictEqual(t.orch.checkSendQuota(GROUP), true);
  t.cleanup();
});

await ok('quotaFor 抛错 → 放行（额度模块坏了不能变成不回复）', () => {
  const t = makeOrch(() => { throw new Error('boom'); });
  assert.strictEqual(t.orch.checkSendQuota(GROUP), true);
  t.cleanup();
});

await ok('sender 没有 quotaFor → 放行（老 sender / 测试替身）', () => {
  const t = makeOrch(FREE);
  t.orch.sender = { endRun() {} };
  assert.strictEqual(t.orch.checkSendQuota(GROUP), true);
  t.cleanup();
});

await ok('逃生阀 send.preflightQuota:false → 一律放行', () => {
  updateConfig({ send: { preflightQuota: false } });
  const t = makeOrch(FULL);
  assert.strictEqual(t.orch.checkSendQuota(GROUP), true);
  // 显式写回 true：deepMerge 会跳过 undefined，写 undefined 等于没写。
  updateConfig({ send: { preflightQuota: true } });
  t.cleanup();
});

// ── ⑤ 主动机会：放弃而不是排队 ───────────────────────────────────────────
await ok('主动机会被额度挡下时不重排（窗口一开就挤掉正常对话更糟）', () => {
  const t = makeOrch(FULL);
  assert.strictEqual(t.orch.checkSendQuota(GROUP, { proactive: true }), false);
  assert.strictEqual(t.orch.wakeTimers.size, 0, '主动机会不该挂重排');
  assert.strictEqual(t.quotaSkips().length, 1, '但依然要留痕');
  t.cleanup();
});

// ── ⑥ 动作集预算与真实额度同一个数 ───────────────────────────────────────
await ok('剩余 1 条 → 预算信号是 1（模型据此把话并成一条）', () => {
  const t = makeOrch({ ...FREE, used: 3, remaining: 1 });
  assert.strictEqual(t.orch.sendQuotaRemaining(GROUP), 1);
  t.cleanup();
});

await ok('不限额度 → 预算信号是 -1（不干扰档位给的数）', () => {
  const t = makeOrch(NONE);
  assert.strictEqual(t.orch.sendQuotaRemaining(GROUP), -1);
  t.cleanup();
});

await ok('quotaFor 抛错 → 预算信号 -1（不能把轮次规划成 0 条）', () => {
  const t = makeOrch(() => { throw new Error('boom'); });
  assert.strictEqual(t.orch.sendQuotaRemaining(GROUP), -1);
  t.cleanup();
});

console.log(`\n[send-quota-wire] ${pass} 项全部通过`);

// Orchestrator 构造会留下 setTimeout 句柄，node 不会自己退出
// （表现为"测试跑完了但命令不返回"，第 2 轮踩过）。收尾必须显式清场。
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
process.exit(0);
