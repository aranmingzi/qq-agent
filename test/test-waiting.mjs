// 等待与合并自测（P1-6）。
//
// 这一层的判据全是"要等多久"，最容易被写成魔法数字散在调用点。
// 断言的重点不是"等得准不准"，而是**边界**：0、空、已超时、有上限。
import assert from 'node:assert';
import { mergeWindowMs, typingExtraMs, shouldHold, describeWait, MERGE_DEFAULTS } from '../src/waiting.js';
import { firstSendDelayMs } from '../src/rhythm.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[waiting]');

ok('合并窗口：被叫到走直通，否则等一个句子说完', () => {
  assert.strictEqual(mergeWindowMs({ urgent: true, normalMs: 1800, directMs: 500 }), 500);
  assert.strictEqual(mergeWindowMs({ urgent: false, normalMs: 1800, directMs: 500 }), 1800);
});

ok('合并窗口：directMs 比 normalMs 还大时取小（urgent 永远不该更慢）', () => {
  assert.strictEqual(mergeWindowMs({ urgent: true, normalMs: 500, directMs: 1800 }), 500);
});

ok('合并窗口：0 合法（用户就是想立刻唤醒，不能被 || 兜回默认值）', () => {
  assert.strictEqual(mergeWindowMs({ urgent: false, normalMs: 0, directMs: 500 }), 0);
  assert.strictEqual(mergeWindowMs({ urgent: true, normalMs: 1800, directMs: 0 }), 0);
});

ok('按字数附加：空文本不附加', () => {
  assert.strictEqual(typingExtraMs(''), 0);
  assert.strictEqual(typingExtraMs(null), 0);
});

ok('按字数附加：短文本线性，长文本撞上限', () => {
  assert.strictEqual(typingExtraMs('在吗', { perCharMs: 15, maxExtraMs: 1200 }), 30);
  const long = 'x'.repeat(500);
  assert.strictEqual(typingExtraMs(long, { perCharMs: 15, maxExtraMs: 1200 }), 1200, '长消息不该让人等更久');
});

ok('首条延迟 = 目标总延迟 + 按字数附加 − 已耗时，且不为负', () => {
  const rng = () => 0;                       // 取区间下界
  const noText = firstSendDelayMs('direct', 0, rng);
  const withText = firstSendDelayMs('direct', 0, rng, { text: '这是一句比较长的话' });
  assert.ok(withText > noText, '有正文时应该多等一点');
  assert.strictEqual(firstSendDelayMs('direct', 999999, rng), 0, '模型已经花掉的时间要扣掉，不能倒扣成负数');
});

ok('首条延迟：按字数附加也有上限（不会因为长消息等到十几秒）', () => {
  const a = firstSendDelayMs('direct', 0, () => 0, { text: 'x'.repeat(200) });
  const b = firstSendDelayMs('direct', 0, () => 0, { text: 'x'.repeat(4000) });
  assert.strictEqual(a, b, '超过上限后不再增加');
  assert.ok(a < 1200 + 2000 + 10);
});

ok('垫话：文案为空 = 关闭（默认关，属于风格决定）', () => {
  assert.strictEqual(shouldHold({ startedAt: 0, now: 999999, text: '' }), false);
  assert.strictEqual(shouldHold({ startedAt: 0, now: 999999, text: '   ' }), false);
});

ok('垫话：没到时间不垫', () => {
  assert.strictEqual(shouldHold({ startedAt: 1000, now: 1000 + 3000, holdMs: 6000, text: '我想想' }), false);
});

ok('垫话：到时间且一句没发 → 垫', () => {
  assert.strictEqual(shouldHold({ startedAt: 1000, now: 1000 + 6000, holdMs: 6000, text: '我想想' }), true);
});

ok('垫话：已经发过就不再垫（否则变刷屏）', () => {
  assert.strictEqual(shouldHold({ startedAt: 1000, now: 1000 + 9000, holdMs: 6000, sentCount: 1, text: '我想想' }), false);
});

ok('垫话：没有开始时间不垫（拿不到时间就不要猜）', () => {
  assert.strictEqual(shouldHold({ startedAt: 0, now: 999999, holdMs: 6000, text: '我想想' }), false);
});

ok('describeWait 只在有附加时多说一句（不刷日志）', () => {
  assert.ok(describeWait({ windowMs: 1800 }).includes('1800ms'));
  assert.ok(describeWait({ windowMs: 500, urgent: true }).includes('直通'));
  assert.ok(describeWait({ windowMs: 1800, charExtraMs: 60 }).includes('60ms'));
  assert.ok(!describeWait({ windowMs: 1800 }).includes('按字数'));
});

ok('默认值与 config 同源（不另立一套数字）', () => {
  assert.strictEqual(MERGE_DEFAULTS.normalMs, 1800);
  assert.strictEqual(MERGE_DEFAULTS.directMs, 500);
  assert.strictEqual(MERGE_DEFAULTS.holdMs, 6000);
  // 多人并发的两个数字：config.crowd.wakeDelayMs / maxWaitMs 必须与这里一致，
  // 否则"面板上调了 2600，代码里还是 1800"这种事没人发现。
  assert.strictEqual(MERGE_DEFAULTS.crowdMs, 2600);
  assert.strictEqual(MERGE_DEFAULTS.crowdMaxWaitMs, 6000);
});

console.log(`✓ waiting 自测通过（${pass} 项）`);
