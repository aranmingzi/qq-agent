// 主动收敛接线自测（orchestrator 的 filterByProactiveBackoff / noteProactiveOutcome）。
//
// 纯逻辑在 test-proactive-backoff.mjs 里测过了；这里测的是**接线**——
// 一处接错，模块再对也没用，而且症状是"什么都不报，就是不主动了"或"退避从来没生效"。
//
// 重点钉四件事：
//   ① 被退避挡下的候选不进候选池，且**留下一条 skip 记录**（否则面板上无从排查）；
//   ② 主动说了话 → 走短冷却；主动没说话 → 走长退避；出错也算没反应；
//   ③ 正常对话跑完 → 连败清零（否则越冷场越沉默，最后永久闭嘴）；
//   ④ backoffEnabled=false 时整条链路完全不介入（老行为可回退）。
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pb-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { getConfig, updateConfig } = await import('../src/config.js');
await getConfig();
updateConfig({
  api: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model' },
  talk: { enabled: false },
  proactive: {
    enabled: true,
    backoffEnabled: true,
    backoffBaseMs: 60000,
    backoffCapMs: 600000,
    backoffStartCount: 1,
    cooldownMs: 120000
  }
});

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { resetSkipMemory } = await import('../src/skip-log.js');
const { resetProactiveBackoffForTest, getProactiveBackoff } = await import('../src/proactive-backoff.js');

resetSkipMemory();
resetProactiveBackoffForTest();

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

const sent = [];
const platform = {
  selfId: '99999',
  async sendText(kind, id, text) { sent.push({ kind, id, text }); return { message_id: 'm1' }; }
};

const store = new ChatStore();
const sender = new SendQueue({ platform, store });
const sessions = new SessionRegistry(5);
const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
const bus = createEventBus();
const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });

const skips = [];
const logs = [];
bus.on('skip', (r) => skips.push(r));
bus.on('log', (r) => logs.push(r?.text || ''));
const backoffSkips = () => skips.filter((s) => s.stage === 'proactive-backoff');

const cfg = () => getConfig();
const G1 = 'group:11111';
const G2 = 'group:22222';

console.log('[proactive-backoff-wire]');

// ── ① 候选过滤 ──────────────────────────────────────────────────────────
await ok('干净的会话原样通过（没记录的群不该被拦）', () => {
  const out = orch.filterByProactiveBackoff(cfg(), [G1, G2]);
  assert.deepStrictEqual(out, [G1, G2]);
  assert.strictEqual(backoffSkips().length, 0);
});

// ── ①b 端到端选目标（pickProactiveTarget）────────────────────────────────
// 这组是补上来的：之前只测了 filterByProactiveBackoff 自己，
// 把 tick 里那行接线删掉（`candidates = candidates`）测试照样全绿 —— 等于没测到接线。
await ok('pickProactiveTarget 真的会过滤（删掉接线这行就会红）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  // 两个群都"安静且允许"：直接把消息的时间戳设成 2 小时前（idleThreshold 默认 30 分钟）
  for (const key of [G1, G2]) {
    store.appendIncoming(key, {
      senderId: '20002', senderName: '群友', text: '哈哈', ts: Date.now() - 2 * 3600 * 1000
    });
    // 候选要求"没有未读"，所以这里要消费掉 —— 否则测的就不是退避而是未读
    store.drainUnread(key);
  }
  updateConfig({ allowAllWhenEmpty: true, allow: { groups: [] } });
  b.reset(G1);
  b.reset(G2);
  // 让 G1 进入退避，G2 保持干净 → 只能选出 G2
  b.recordDeclined(G1);
  const picked = orch.pickProactiveTarget(cfg());
  assert.strictEqual(picked, G2, `应只选出 G2，实际 ${picked}`);
  assert.ok(backoffSkips().some((s) => s.chatKey === G1), '被挡下的群要留痕');
});

await ok('pickProactiveTarget 全被挡时返回 null（不掷骰子）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.recordDeclined(G1);
  b.recordDeclined(G2);
  assert.strictEqual(orch.pickProactiveTarget(cfg()), null);
});

await ok('退避中的会话被剔出候选池，并留下一条 skip 记录', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G2);            // 上一个用例把 G2 也挡了，这里要先放开
  b.recordDeclined(G1);   // startCount=1 → 立刻进入 60 秒退避
  const out = orch.filterByProactiveBackoff(cfg(), [G1, G2]);
  assert.deepStrictEqual(out, [G2], 'G1 应被剔掉');
  assert.ok(backoffSkips().some((s) => s.chatKey === G1 && s.detail.kind === 'backoff'), '挡下必须留痕');
});

await ok('全部被挡时返回空数组（调用方据此直接 return，不掷骰子）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.recordDeclined(G2);
  const out = orch.filterByProactiveBackoff(cfg(), [G1, G2]);
  assert.deepStrictEqual(out, []);
});

await ok('backoffEnabled=false 时完全不介入（老行为可回退）', () => {
  updateConfig({ proactive: { backoffEnabled: false } });
  const out = orch.filterByProactiveBackoff(cfg(), [G1, G2]);
  assert.deepStrictEqual(out, [G1, G2], '关掉开关就该原样放行');
  updateConfig({ proactive: { backoffEnabled: true } });
});

// ── ② 结果记账 ──────────────────────────────────────────────────────────
await ok('主动说了话 → 走短冷却，不是长退避', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G1);
  orch.noteProactiveOutcome(G1, 'done', true);
  const v = b.check(G1);
  assert.strictEqual(v.skip, true);
  assert.strictEqual(v.kind, 'cooldown');
  assert.ok(v.waitMs <= 120000, `冷却应是 120 秒，实际 ${v.waitMs}`);
  assert.ok(logs.some((t) => t.includes('[主动]') && t.includes('开了话题')));
});

await ok('主动没说话（noreply）→ 记一次连败', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G1);
  orch.noteProactiveOutcome(G1, 'noreply', true);
  const v = b.check(G1);
  assert.strictEqual(v.skip, true);
  assert.strictEqual(v.streak, 1);
  assert.strictEqual(v.kind, 'backoff');
});

await ok('主动出错也算没反应（否则每次超时的群会被无限重试）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G1);
  orch.noteProactiveOutcome(G1, 'error', true);
  assert.strictEqual(b.check(G1).streak, 1);
});

await ok('连败递增：第三次的等待比第一次长', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G1);
  orch.noteProactiveOutcome(G1, 'noreply', true);
  const w1 = b.check(G1).waitMs;
  b.reset(G1);
  orch.noteProactiveOutcome(G1, 'noreply', true);
  orch.noteProactiveOutcome(G1, 'noreply', true);
  const w3 = b.check(G1).waitMs;
  assert.ok(w3 > w1, `第三次(${w3}) 应比第一次(${w1}) 等更久`);
});

// ── ③ 正常对话清零 ──────────────────────────────────────────────────────
await ok('正常对话跑完一轮 → 连败清零（纪律①，否则永久闭嘴）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G1);
  orch.noteProactiveOutcome(G1, 'noreply', true);
  orch.noteProactiveOutcome(G1, 'noreply', true);
  assert.strictEqual(b.check(G1).skip, true);
  orch.noteProactiveOutcome(G1, 'done', false);   // 群里有人说话，正常跑完一轮
  const v = b.check(G1);
  assert.strictEqual(v.skip, false, '有人说话了就该立刻放行');
  assert.strictEqual(v.streak, 0);
});

await ok('没记录过的会话跑正常对话 → 不报错、不写脏数据', () => {
  const b = getProactiveBackoff(cfg().proactive);
  orch.noteProactiveOutcome('group:clean', 'done', false);
  assert.strictEqual(b.snapshot().some((x) => x.chatKey === 'group:clean'), false);
});

// ── ④ 落盘 ──────────────────────────────────────────────────────────────
await ok('记账结果落盘（重启后接着退避）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  b.reset(G2);
  orch.noteProactiveOutcome(G2, 'noreply', true);
  const file = path.join(tmp, 'proactive-backoff.json');
  assert.ok(fs.existsSync(file), '应写出 proactive-backoff.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.chats[G2].streak, 1);
});

await ok('记账出错不外抛（磁盘不可写也不能拖垮主流程）', () => {
  const b = getProactiveBackoff(cfg().proactive);
  const orig = b.recordDeclined;
  b.recordDeclined = () => { throw new Error('故意炸'); };
  assert.doesNotThrow(() => orch.noteProactiveOutcome('group:boom', 'noreply', true));
  b.recordDeclined = orig;
});

console.log(`\n[proactive-backoff-wire] ${pass} 项全部通过`);

// 显式退出：Orchestrator 构造时会挂上若干 setTimeout，不 exit 会让 node 一直挂着
// （症状是"测试跑完了但命令不返回"，在 npm test 里表现为超时）。
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
