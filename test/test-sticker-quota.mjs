// 表情前置判定（src/sticker-quota.js）——纯函数，假时钟，不碰磁盘。
//
// 这一份测的是"判定规则本身对不对"：三道闸门的顺序、边界、以及脏数据不能
// 把某个会话永久锁死。接线（orchestrator 有没有真的把这个状态喂给提示词）
// 由 test-sticker-quota-wire.mjs 负责 —— 分开是因为上一轮的教训：
// 规则测过了、接线没测，等于没测。
import assert from 'node:assert/strict';
import { assessSticker, scanOwnStickers, describeSticker, STICKER_SCOPE_SUFFIX } from '../src/sticker-quota.js';

let pass = 0;
async function ok(name, fn) {
  try { await fn(); } catch (e) { e.message = `[${name}] ${e.message}`; throw e; }
  pass += 1;
  console.log('  ✓', name);
}

const T0 = 1_700_000_000_000;
const MIN = 60 * 1000;

await ok('桶后缀与 sender 的 #checkRate 一致（两处必须同一个键）', async () => {
  assert.equal(STICKER_SCOPE_SUFFIX, '|sticker');
});

await ok('什么都没发过 → 能发', async () => {
  const s = assessSticker({ now: T0 });
  assert.equal(s.canSend, true);
  assert.equal(s.kind, 'ok');
  assert.equal(s.reason, '');
  assert.equal(s.waitMs, 0);
});

await ok('本轮已发满 → 挡下，理由是"本轮"', async () => {
  const s = assessSticker({ sentThisRun: 1, maxPerRun: 1, now: T0 });
  assert.equal(s.canSend, false);
  assert.equal(s.kind, 'run');
  assert.match(s.reason, /本轮已经发过 1 张/);
  assert.equal(s.waitMs, 0, '本轮的约束等一等也不会解除，不该给等待时间');
});

await ok('冷却中 → 挡下，waitMs 是剩余冷却', async () => {
  const s = assessSticker({ cooldownMs: 10 * MIN, lastStickerAt: T0 - 4 * MIN, now: T0 });
  assert.equal(s.canSend, false);
  assert.equal(s.kind, 'cooldown');
  assert.equal(s.waitMs, 6 * MIN);
  assert.match(s.reason, /还要等 6 分钟/);
});

await ok('冷却刚好走完 → 放行（边界不该多挡 1 毫秒）', async () => {
  const s = assessSticker({ cooldownMs: 10 * MIN, lastStickerAt: T0 - 10 * MIN, now: T0 });
  assert.equal(s.canSend, true);
});

await ok('cooldownMs = 0 → 关掉冷却', async () => {
  const s = assessSticker({ cooldownMs: 0, lastStickerAt: T0 - 1000, now: T0 });
  assert.equal(s.canSend, true);
});

await ok('分钟桶满了 → 挡下，waitMs 由最早那条算出', async () => {
  const s = assessSticker({
    minuteLimit: 1,
    stickerTimes: [T0 - 20_000],
    now: T0
  });
  assert.equal(s.canSend, false);
  assert.equal(s.kind, 'minute');
  assert.equal(s.waitMs, 40_000);
  assert.match(s.reason, /额度已满（1 张）/);
});

await ok('分钟桶滑出窗口 → 放行（59.9s 挡，60.1s 放）', async () => {
  const inWin = assessSticker({ minuteLimit: 1, stickerTimes: [T0 - 59_900], now: T0 });
  assert.equal(inWin.canSend, false);
  const outWin = assessSticker({ minuteLimit: 1, stickerTimes: [T0 - 60_100], now: T0 });
  assert.equal(outWin.canSend, true);
});

await ok('minuteLimit = 0 → 不限，remaining 是 Infinity 而不是 0', async () => {
  const s = assessSticker({ minuteLimit: 0, stickerTimes: [T0, T0, T0], now: T0 });
  assert.equal(s.canSend, true);
  assert.equal(s.remaining, Infinity);
  // 关键：Infinity <= 0 是 false，但 null <= 0 是 true —— 别用 null 表示不限。
  assert.ok(!(s.remaining <= 0));
});

await ok('闸门顺序：本轮 > 冷却 > 分钟（先撞哪道决定理由）', async () => {
  // 三道同时满足"挡下"的条件，必须报最前面那道，否则提示词和工具侧说法会打架。
  const s = assessSticker({
    sentThisRun: 1,
    maxPerRun: 1,
    cooldownMs: 10 * MIN,
    lastStickerAt: T0 - 1000,
    minuteLimit: 1,
    stickerTimes: [T0 - 1000],
    now: T0
  });
  assert.equal(s.kind, 'run');
});

await ok('脏时间戳不能让会话永久发不出去', async () => {
  const s = assessSticker({
    minuteLimit: 1,
    stickerTimes: ['abc', NaN, null, undefined, T0 + 999_999, T0 - 120_000],
    now: T0
  });
  assert.equal(s.canSend, true, '未来时间/垃圾值必须被丢掉，不能算进桶里');
});

await ok('stickerTimes 不是数组也不炸', async () => {
  const s = assessSticker({ minuteLimit: 1, stickerTimes: null, now: T0 });
  assert.equal(s.canSend, true);
});

await ok('remaining 不会算成负数', async () => {
  const s = assessSticker({ minuteLimit: 2, stickerTimes: [T0 - 1000, T0 - 2000, T0 - 3000], now: T0 });
  assert.equal(s.canSend, false);
  assert.equal(s.remaining, 0);
});

await ok('scanOwnStickers 只认自己发的、且能解析出 id 的', async () => {
  const own = [
    { self: true, text: '[表情包：猫（s1）]', ts: T0 - 5000 },
    { self: false, text: '[表情包：狗（s2）]', ts: T0 - 1000 },   // 别人发的，不算
    { self: true, text: '普通文字', ts: T0 - 500 },               // 不是表情
    { self: true, text: '[表情包：兔（s3）]', ts: T0 - 9000 }
  ];
  const r = scanOwnStickers(own, (t) => (String(t).match(/（(.+?)）/) || [])[1] || '');
  assert.equal(r.lastStickerAt, T0 - 5000, '取最近一次**自己**发的表情');
  assert.deepEqual([...r.recentStickerIds].sort(), ['s1', 's3']);
});

await ok('scanOwnStickers 输入不是数组也不炸', async () => {
  assert.deepEqual(scanOwnStickers(null, () => 'x'), { lastStickerAt: 0, recentStickerIds: new Set() });
});

await ok('describeSticker：能发时返回空串（不刷屏）', async () => {
  assert.equal(describeSticker({ canSend: true }), '');
  assert.equal(describeSticker(null), '');
});

await ok('describeSticker：三种挡下的说法都带得出信息', async () => {
  assert.match(describeSticker({ canSend: false, kind: 'run', reason: '本轮发过了' }), /本轮发过了/);
  assert.match(describeSticker({ canSend: false, kind: 'cooldown', reason: '刚发过表情', waitMs: 6 * MIN }), /6 分钟/);
  assert.match(describeSticker({ canSend: false, kind: 'minute', reason: '额度已满', waitMs: 40_000 }), /40 秒后滑出窗口/);
});

console.log(`\n[sticker-quota] ${pass} 项全部通过`);
