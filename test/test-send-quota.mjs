// 发送额度前置感知：纯逻辑自测（src/send-quota.js）。
//
// 这一层被三处共用（sender.#checkRate 的上限取值、sender.quotaFor、
// orchestrator 的 checkSendQuota / 动作集预算），所以它算错 = 全线错。
// 重点钉：
//   ① 私聊独立额度与"0 = 不限"的语义不能漂移；
//   ② 窗口滑动的边界（59.9 秒还算数、60.1 秒不算）；
//   ③ 分钟与小时两个窗口取更紧的那个；
//   ④ 脏数据（未来时间、字符串、NaN）不能把会话永久判成"发满了"。
import assert from 'node:assert';

const {
  resolveMinuteLimit, quotaFrom, assessQuota, describeQuota, describeQuotaWait,
  MINUTE_MS, HOUR_MS
} = await import('../src/send-quota.js');

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

console.log('[send-quota]');

// ── ① 上限取值 ──────────────────────────────────────────────────────────
await ok('私聊用独立额度，群聊用公共额度', () => {
  const cfg = { maxPerMinute: 4, maxPerMinutePrivate: 15 };
  assert.strictEqual(resolveMinuteLimit('group:111', cfg), 4);
  assert.strictEqual(resolveMinuteLimit('private:222', cfg), 15);
});

await ok('私聊未配置时沿用公共额度（历史行为）', () => {
  assert.strictEqual(resolveMinuteLimit('private:222', { maxPerMinute: 4 }), 4);
  assert.strictEqual(resolveMinuteLimit('private:222', { maxPerMinute: 4, maxPerMinutePrivate: undefined }), 4);
  assert.strictEqual(resolveMinuteLimit('private:222', { maxPerMinute: 4, maxPerMinutePrivate: null }), 4);
});

await ok('显式 0 = 不限，且不会因为 || 兜底被吃掉', () => {
  assert.strictEqual(resolveMinuteLimit('private:222', { maxPerMinute: 4, maxPerMinutePrivate: 0 }), 0);
  assert.strictEqual(resolveMinuteLimit('group:111', { maxPerMinute: 0 }), 0);
  // 空配置 = 不限（默认 maxPerMinute 是 0）
  assert.strictEqual(resolveMinuteLimit('group:111', {}), 0);
});

// ── ② 单窗口用量 ────────────────────────────────────────────────────────
const T0 = 1_700_000_000_000;

await ok('不限时 remaining 是 Infinity，不能是 null', () => {
  const q = quotaFrom({ times: [T0], limit: 0, now: T0 });
  assert.strictEqual(q.unlimited, true);
  assert.strictEqual(q.remaining, Infinity);
  // 这是真踩过的坑：null <= 0 在 JS 里是 true，会把"不限"判成"发满了"
  assert.ok(!(q.remaining <= 0));
});

await ok('用了几条、还剩几条', () => {
  const q = quotaFrom({ times: [T0 - 1000, T0 - 2000], limit: 4, now: T0 });
  assert.strictEqual(q.used, 2);
  assert.strictEqual(q.remaining, 2);
  assert.strictEqual(q.resetInMs, 0, '还有余额就不该让人等');
});

await ok('窗口边界：59.9 秒算数，60.1 秒不算', () => {
  const inside = quotaFrom({ times: [T0 - 59_900], limit: 1, now: T0 });
  assert.strictEqual(inside.used, 1);
  assert.strictEqual(inside.remaining, 0);
  const outside = quotaFrom({ times: [T0 - 60_100], limit: 1, now: T0 });
  assert.strictEqual(outside.used, 0);
  assert.strictEqual(outside.remaining, 1);
});

await ok('满了以后 resetInMs = 最早那条滑出窗口还要多久', () => {
  const times = [T0 - 50_000, T0 - 10_000];
  const q = quotaFrom({ times, limit: 2, now: T0 });
  assert.strictEqual(q.remaining, 0);
  assert.strictEqual(q.resetInMs, 10_000, '最早那条还差 10 秒');
});

await ok('remaining 不会变成负数（用超了也只说 0）', () => {
  const q = quotaFrom({ times: [T0 - 1, T0 - 2, T0 - 3, T0 - 4, T0 - 5], limit: 2, now: T0 });
  assert.strictEqual(q.remaining, 0);
});

await ok('脏数据不会把会话永久判成发满', () => {
  const q = quotaFrom({
    times: ['abc', NaN, null, undefined, T0 + 999_999, T0 - 1000],
    limit: 2, now: T0
  });
  // 只有 T0-1000 是合法且已发生的
  assert.strictEqual(q.used, 1);
  assert.strictEqual(q.remaining, 1);
});

await ok('times 不是数组也不炸', () => {
  assert.strictEqual(quotaFrom({ times: null, limit: 3, now: T0 }).remaining, 3);
  assert.strictEqual(quotaFrom({ times: 'x', limit: 3, now: T0 }).remaining, 3);
});

// ── ③ 两个窗口取更紧的 ──────────────────────────────────────────────────
await ok('分钟没满、小时满了 → 判小时（否则照样撞墙）', () => {
  const q = assessQuota({
    chatKey: 'group:111',
    sendCfg: { maxPerMinute: 4, maxPerHour: 10 },
    minuteTimes: [],
    hourTimes: Array.from({ length: 10 }, (_, i) => T0 - i * 60_000),
    now: T0
  });
  assert.strictEqual(q.window, 'hour');
  assert.strictEqual(q.remaining, 0);
});

await ok('分钟满了、小时没满 → 判分钟', () => {
  const q = assessQuota({
    chatKey: 'group:111',
    sendCfg: { maxPerMinute: 2, maxPerHour: 100 },
    minuteTimes: [T0 - 1000, T0 - 2000],
    hourTimes: [T0 - 1000, T0 - 2000],
    now: T0
  });
  assert.strictEqual(q.window, 'minute');
  assert.strictEqual(q.remaining, 0);
});

await ok('两个都满了取剩余更少的（都是 0 时取等得更久的）', () => {
  const q = assessQuota({
    chatKey: 'group:111',
    sendCfg: { maxPerMinute: 1, maxPerHour: 1 },
    minuteTimes: [T0 - 55_000],
    hourTimes: [T0 - 55_000],
    now: T0
  });
  assert.strictEqual(q.remaining, 0);
  // 分钟窗口 5 秒后滑出，小时窗口 55 分钟 —— 必须报小时，否则 5 秒后重排又撞一次
  assert.strictEqual(q.window, 'hour');
  assert.ok(q.resetInMs > MINUTE_MS);
});

await ok('都不限时 unlimited=true 且 window=null', () => {
  const q = assessQuota({ chatKey: 'group:111', sendCfg: { maxPerMinute: 0, maxPerHour: 0 } });
  assert.strictEqual(q.unlimited, true);
  assert.strictEqual(q.window, null);
  assert.strictEqual(q.remaining, Infinity);
});

await ok('只限小时、不限分钟时也正常工作', () => {
  const q = assessQuota({
    chatKey: 'group:111',
    sendCfg: { maxPerMinute: 0, maxPerHour: 5 },
    minuteTimes: [],
    hourTimes: Array.from({ length: 5 }, (_, i) => T0 - i * 1000),
    now: T0
  });
  assert.strictEqual(q.unlimited, false);
  assert.strictEqual(q.window, 'hour');
  assert.strictEqual(q.remaining, 0);
});

// ── ④ 人话 ──────────────────────────────────────────────────────────────
await ok('describeQuota 不限时返回空串（不刷屏）', () => {
  assert.strictEqual(describeQuota({ unlimited: true, remaining: Infinity }), '');
  assert.strictEqual(describeQuota(null), '');
});

await ok('describeQuota 说清"还剩几条"与"多久滑出"', () => {
  assert.match(describeQuota({ unlimited: false, window: 'minute', limit: 4, remaining: 2 }), /还能发 2 条/);
  assert.match(
    describeQuota({ unlimited: false, window: 'minute', limit: 4, remaining: 0, resetInMs: 12_000 }),
    /已发满.*12 秒后滑出窗口/
  );
});

await ok('describeQuotaWait 三种量级都说得像人话', () => {
  assert.strictEqual(describeQuotaWait(0), '马上');
  assert.match(describeQuotaWait(12_000), /12 秒/);
  assert.match(describeQuotaWait(5 * MINUTE_MS), /5 分钟/);
  assert.match(describeQuotaWait(2 * HOUR_MS), /2\.0 小时/);
  // 向上取整：剩 1.2 秒要说"2 秒"，说"1 秒"会让人按着 1 秒去重试
  assert.match(describeQuotaWait(1200), /2 秒/);
});

console.log(`\n[send-quota] ${pass} 项全部通过`);
