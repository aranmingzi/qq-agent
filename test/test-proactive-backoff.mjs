// 主动消息退避自测（src/proactive-backoff.js，2026-10-29 第 2 轮学自 MaiBot 的 idle_backoff 设计）。
//
// 这个模块的全部价值在**三个边界**：
//   · 连败计数只在"连续"时增长 —— 清不掉的话，冷场越久越沉默，最后永久闭嘴（那是坏掉）；
//   · 退避有上限 —— 没上限的话群三天后重新热起来，机器人还在睡；
//   · 说过话走短冷却、没说话走长退避 —— 混成一类就变成"说过一次话就消失半天"。
// 所以测的不是文案，是这三条边界。时钟注入，不碰真实时间和 data/。
import assert from 'node:assert';

const { ProactiveBackoff, describeWait } = await import('../src/proactive-backoff.js');

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

/** 假时钟：手动推进，测试不等真时间。 */
function clock(t0 = 1_000_000) {
  let t = t0;
  return { now: () => t, advance: (ms) => { t += ms; return t; }, set: (v) => { t = v; } };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

console.log('[proactive-backoff]');

// ── 退避曲线 ────────────────────────────────────────────────────────────
await ok('连败没到起点时不等（前两次照常试）', () => {
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2 });
  assert.strictEqual(b.waitFor(0), 0);
  assert.strictEqual(b.waitFor(1), 0);
});

await ok('到起点开始指数退避，逐次翻倍', () => {
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2 });
  assert.strictEqual(b.waitFor(2), 10 * MIN);
  assert.strictEqual(b.waitFor(3), 20 * MIN);
  assert.strictEqual(b.waitFor(4), 40 * MIN);
});

await ok('退避封顶，且大数不会算成 Infinity', () => {
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2 });
  assert.strictEqual(b.waitFor(10), 6 * HOUR);
  // 500 次连败：2^(498) 是 Infinity，夹一下必须还是 cap
  assert.strictEqual(b.waitFor(500), 6 * HOUR);
  assert.ok(Number.isFinite(b.waitFor(500)));
});

await ok('base/cap 配成 0 = 关掉退避（不收敛也能用）', () => {
  assert.strictEqual(new ProactiveBackoff({ baseMs: 0, capMs: 6 * HOUR }).waitFor(50), 0);
  assert.strictEqual(new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 0 }).waitFor(50), 0);
});

// ── 连续计数：纪律① ────────────────────────────────────────────────────
await ok('recordDeclined 累加，recordSent 也累加（说了没人接同样是没反应）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2, cooldownMs: 30 * MIN, now: c.now });
  assert.strictEqual(b.recordDeclined('group:1').streak, 1);
  assert.strictEqual(b.recordDeclined('group:1').streak, 2);
  const sent = b.recordSent('group:1');
  assert.strictEqual(sent.streak, 3, '说过话也要让下一次更晚');
});

await ok('正常对话（reset）把连败清零 —— 否则越冷场越沉默', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2, now: c.now });
  b.recordDeclined('group:1');
  b.recordDeclined('group:1');
  b.recordDeclined('group:1');
  assert.strictEqual(b.check('group:1').streak, 3);
  assert.strictEqual(b.reset('group:1'), true);
  const r = b.check('group:1');
  assert.strictEqual(r.streak, 0);
  assert.strictEqual(r.skip, false);
  assert.strictEqual(b.reset('group:1'), false, '没东西可清时返回 false，免得无谓落盘');
});

await ok('没记录过的会话可以直接开口', () => {
  const b = new ProactiveBackoff();
  const r = b.check('group:new');
  assert.strictEqual(r.skip, false);
  assert.strictEqual(r.kind, 'none');
});

// ── 等待生效与到期 ──────────────────────────────────────────────────────
await ok('退避期内 skip，到期自动放行（不需要谁去清状态）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 1, now: c.now });
  const r = b.recordDeclined('group:1');
  assert.strictEqual(r.waitMs, 10 * MIN);
  assert.strictEqual(b.check('group:1').skip, true);
  assert.strictEqual(b.check('group:1').kind, 'backoff');
  assert.strictEqual(b.check('group:1').waitMs, 10 * MIN);
  c.advance(10 * MIN);
  assert.strictEqual(b.check('group:1').skip, false, '时间到了就该放行');
});

await ok('说过话走短冷却，且冷却优先于长退避（不能被旧的 until 拖住）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 1, cooldownMs: 30 * MIN, now: c.now });
  // 先欠下一次 6 小时的退避
  for (let i = 0; i < 10; i += 1) b.recordDeclined('group:1');
  assert.strictEqual(b.check('group:1').skip, true);
  // 真的说了一句：until 清掉，改走 30 分钟冷却
  b.recordSent('group:1');
  const r = b.check('group:1');
  assert.strictEqual(r.kind, 'cooldown');
  assert.strictEqual(r.waitMs, 30 * MIN, '说过话之后不该被之前的 6 小时退避继续关着');
  assert.match(r.reason, /还没人接/);
});

await ok('cooldownMs=0 时不冷却（说过话马上可以再说）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 5, cooldownMs: 0, now: c.now });
  b.recordSent('group:1');
  assert.strictEqual(b.check('group:1').skip, false);
});

// ── 配置热改 ────────────────────────────────────────────────────────────
await ok('configure 改参数立即生效（面板改设置不必重启）', () => {
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2 });
  assert.strictEqual(b.waitFor(2), 10 * MIN);
  b.configure({ baseMs: MIN, capMs: 6 * HOUR, startCount: 2 });
  assert.strictEqual(b.waitFor(2), MIN);
});

await ok('cap 小于 base 时以 base 为准（别配出个负数窗口）', () => {
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: MIN });
  assert.strictEqual(b.waitFor(2), 10 * MIN);
});

// ── 落盘往返 ────────────────────────────────────────────────────────────
await ok('toJSON → 新实例能接上进度（重启不退避）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2, now: c.now });
  b.recordDeclined('group:1');
  b.recordDeclined('group:1');
  b.recordDeclined('group:1');
  const saved = JSON.parse(JSON.stringify(b.toJSON()));
  const b2 = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2, now: c.now, state: saved });
  const r = b2.check('group:1');
  assert.strictEqual(r.streak, 3);
  assert.strictEqual(r.skip, true);
});

await ok('落盘里过期太久的等待被丢掉（重启后不接着等三天前的退避）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2, now: c.now });
  const state = { chats: { 'group:old': { streak: 9, until: c.now() - 48 * HOUR, lastSentAt: 0 } } };
  const b2 = new ProactiveBackoff({ baseMs: 10 * MIN, capMs: 6 * HOUR, startCount: 2, now: c.now, state });
  assert.strictEqual(b2.check('group:old').skip, false);
});

await ok('落盘里的脏数据不会炸（null / 字符串 / 缺字段）', () => {
  const b = new ProactiveBackoff({ state: { chats: { 'group:a': null, 'group:b': { streak: 'x', until: 'y' } } } });
  const a = b.check('group:a');
  assert.strictEqual(a.skip, false);
  assert.strictEqual(a.streak, 0);
  const bb = b.check('group:b');
  assert.strictEqual(bb.skip, false);
  assert.strictEqual(bb.streak, 0);
});

await ok('干净的会话不进快照（免得快照越滚越大）', () => {
  const c = clock();
  const b = new ProactiveBackoff({ baseMs: 10 * MIN, startCount: 2, now: c.now });
  b.check('group:clean');
  b.recordDeclined('group:dirty');
  const snap = b.snapshot();
  assert.strictEqual(snap.length, 1);
  assert.strictEqual(snap[0].chatKey, 'group:dirty');
});

// ── 人话 ────────────────────────────────────────────────────────────────
await ok('describeWait 三种量级都说得像人话', () => {
  assert.match(describeWait(45 * 1000), /秒/);
  assert.match(describeWait(25 * MIN), /分钟/);
  assert.match(describeWait(3 * HOUR), /小时/);
  assert.strictEqual(describeWait(0), '0 秒');
});

await ok('空会话键不崩、也不记脏数据', () => {
  const b = new ProactiveBackoff();
  assert.strictEqual(b.check('').skip, true);
  assert.strictEqual(b.recordDeclined('').streak, 0);
  assert.strictEqual(b.snapshot().length, 0);
});

console.log(`\n[proactive-backoff] ${pass} 项全部通过`);
