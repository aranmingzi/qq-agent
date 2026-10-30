// 表情前置判定的**接线**测试：orchestrator 有没有真的把这个状态送进动作集。
//
// 为什么要单独一份（上一轮的教训）：test-sticker-quota.mjs 只证明"规则算得对"，
// 而第 3 轮出现过"规则 18 项全绿、接线断了却没人发现"的情况 ——
// 那时候把 planActions 的 sendQuota 写死成 -1，只有端到端测试抓到了。
//
// 这里用真实的 Orchestrator 实例（真 store / 真 sender 桶），只替换
// sender.stickerQuotaFor 的返回值，断言三件事：
//   ① 冷却中 → actionPlan 里没有"发表情包"，note 里写了理由；
//   ② 分钟桶满 → 同上，且理由来自额度而不是冷却；
//   ③ 一切正常 → 有"发表情包"，且 note 里不提表情。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-wire-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { planActions } = await import('../src/action-planner.js');
const { updateConfig } = await import('../src/config.js');

let pass = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); } catch (e) {
    failures.push(`${name}: ${e?.message ?? e}`);
    console.error('  ✗', name, '\n     ', e?.message ?? e);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('  ✓', name);
}

const GROUP = 'group:20000005';
const platform = { selfId: '99999', async sendText() { return { message_id: 'm1' }; } };
// 库里的图：isStickerSendable 要求有本地副本或 http(s) 地址，所以必须带 url。
const IMG = [{ id: 's1', url: 'https://example.com/a.png' }];

function buildOrch() {
  const store = new ChatStore();
  const sender = new SendQueue({ platform, store });
  const sessions = new SessionRegistry(5);
  const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
  const bus = createEventBus();
  const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });
  return { orch, store, sender };
}

const { orch, store, sender } = buildOrch();
store.appendIncoming(GROUP, { senderId: '20001', senderName: '甲', text: '在吗' });

// 让 store.recent 返回一条"自己刚发过表情"的记录 —— 冷却就是靠它判的。
function seedOwnSticker(ts) {
  store.appendSelf(GROUP, { text: '[表情包：猫（s1）]', ts });
}

await ok('冷却中 → 动作集里没有"发表情包"，且 note 写明理由', async () => {
  seedOwnSticker(Date.now() - 60 * 1000);           // 1 分钟前发过
  updateConfig({ sticker: { enabled: true, cooldownMs: 30 * 60 * 1000, maxPerRun: 1 } });
  const st = orch.stickerState(GROUP, { stickerEntries: IMG });
  assert.equal(st.canSend, false, '1 分钟前发过、冷却 30 分钟 → 应该挡下');
  assert.equal(st.kind, 'cooldown');

  const plan = planActions({ kind: 'group', tier: 'direct', moodScore: 60, hasSticker: true, sticker: st });
  assert.equal(plan.allowed.some((a) => a.name === 'sticker'), false, '挡下时不该把表情列进动作集');
  assert.equal(plan.budgets.sticker, 0);
  assert.match(plan.note, /别试图发表情/);
});

await ok('分钟桶满 → 挡下，且理由来自额度（不是冷却）', async () => {
  const fresh = buildOrch();                          // 新 store，没有冷却记录
  fresh.sender.stickerQuotaFor = () => ({ limit: 1, used: 1, remaining: 0, resetInMs: 40_000, unlimited: false });
  updateConfig({ sticker: { enabled: true, cooldownMs: 0, maxPerRun: 1 } });
  const st = fresh.orch.stickerState(GROUP, { stickerEntries: IMG });
  assert.equal(st.canSend, false);
  assert.equal(st.kind, 'minute', '应该是分钟额度挡的，不是冷却');
  assert.equal(st.waitMs, 40_000);
  assert.match(st.reason, /额度已满/);
});

await ok('一切正常 → 能发，动作集里有"发表情包"，note 不提表情', async () => {
  const fresh = buildOrch();
  fresh.sender.stickerQuotaFor = () => ({ limit: 1, used: 0, remaining: 1, resetInMs: 0, unlimited: false });
  updateConfig({ sticker: { enabled: true, cooldownMs: 0, maxPerRun: 1 } });
  const st = fresh.orch.stickerState(GROUP, { stickerEntries: IMG });
  assert.equal(st.canSend, true);
  const plan = planActions({ kind: 'group', tier: 'direct', moodScore: 60, hasSticker: true, sticker: st });
  assert.equal(plan.allowed.some((a) => a.name === 'sticker'), true, '能发时必须列进动作集');
  assert.equal(plan.budgets.sticker, 1);
  assert.doesNotMatch(plan.note, /别试图发表情/);
});

await ok('库里没有能发的图 → 说"没图"而不是"冷却中"（理由不能骗人）', async () => {
  const st = orch.stickerState(GROUP, { stickerEntries: [] });
  assert.equal(st.canSend, false);
  assert.equal(st.kind, 'empty');
  assert.match(st.reason, /没有能发的图/);
});

await ok('表情功能关掉 → kind=off，理由说明是功能关了', async () => {
  updateConfig({ sticker: { enabled: false } });
  const st = orch.stickerState(GROUP, { stickerEntries: IMG });
  assert.equal(st.canSend, false);
  assert.equal(st.kind, 'off');
  updateConfig({ sticker: { enabled: true } });
});

await ok('sender 没有 stickerQuotaFor（老版本/未接线）→ 按能发处理，不崩', async () => {
  const saved = sender.stickerQuotaFor;
  delete sender.stickerQuotaFor;
  updateConfig({ sticker: { enabled: true, cooldownMs: 0 } });
  const st = orch.stickerState(GROUP, { stickerEntries: IMG });
  assert.equal(st.canSend, true, '算不出来就该放行，让工具侧兜底');
  sender.stickerQuotaFor = saved;
});

await ok('sender.stickerQuotaFor 抛错 → 按能发处理（一个提示词字段不能削掉表情）', async () => {
  const saved = sender.stickerQuotaFor;
  sender.stickerQuotaFor = () => { throw new Error('boom'); };
  const st = orch.stickerState(GROUP, { stickerEntries: IMG });
  assert.equal(st.canSend, true);
  sender.stickerQuotaFor = saved;
});

await ok('sender.stickerQuotaFor 读的是 |sticker 独立桶（不占文本名额）', async () => {
  const fresh = buildOrch();
  updateConfig({ sticker: { enabled: true, maxPerMinute: 1, cooldownMs: 0 } });
  // 文本桶塞满 4 条，表情桶空 —— 表情必须仍然可用。
  fresh.sender.minuteTimes.set(GROUP, [Date.now(), Date.now(), Date.now(), Date.now()]);
  const q = fresh.sender.stickerQuotaFor(GROUP);
  assert.equal(q.remaining, 1, '表情不该被文本桶吃掉');
  assert.equal(fresh.sender.minuteTimes.has(GROUP + '|sticker'), false, '只读操作不该往桶里写');
});

await ok('读操作不写桶：连续调用两次结果一致', async () => {
  updateConfig({ sticker: { enabled: true, maxPerMinute: 1, cooldownMs: 0 } });
  const a = sender.stickerQuotaFor(GROUP);
  const b = sender.stickerQuotaFor(GROUP);
  assert.equal(a.remaining, b.remaining);
  assert.equal(a.used, b.used);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
console.log(`\n[sticker-quota-wire] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
// Orchestrator 的构造函数留下了 setTimeout 句柄，进程不会自己退出 —— 必须显式退出，
// 否则测试跑完了命令却不返回（第 2 轮踩过一次，白等 120 秒超时）。
process.exit(failures.length ? 1 : 0);
