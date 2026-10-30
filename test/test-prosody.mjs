// 语速随语气（prosody）自测。
//
// 断言的重点不是"算得准不准"，而是三条纪律：
//   ① 倍数永远落在 0.88~1.26 —— 规则叠起来也不许离谱（原版注释：宁可保守）；
//   ② 它是**乘数**：音色基准 1.15 必须还在（不能把神里绫华的补偿吃掉）；
//   ③ 任何脏输入都不许产出 NaN（NaN 会让 speed_factor 变成 "NaN"，服务端直接 400）。
import assert from 'node:assert';
import { autoSpeedMultiplier, resolveSpeed, describeSpeed, SPEED_MIN, SPEED_MAX } from '../src/prosody.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[prosody]');

ok('① 平句 = 1.0，不硬造情绪', () => {
  const r = autoSpeedMultiplier('今天下班挺早的');
  assert.strictEqual(r.mult, 1);
  assert.deepStrictEqual(r.tags, []);
});

ok('① 感叹号让她快一点，连感叹更快', () => {
  const one = autoSpeedMultiplier('快点啊！');
  const two = autoSpeedMultiplier('快点啊！！');
  assert.ok(one.mult > 1, `单感叹应 >1，实得 ${one.mult}`);
  assert.ok(two.mult > one.mult, `连感叹应更快（${two.mult} vs ${one.mult}）`);
  assert.ok(one.tags.includes('感叹'));
  assert.ok(two.tags.includes('连感叹'));
});

ok('① 撒娇/犹豫要慢下来', () => {
  const soft = autoSpeedMultiplier('好呀嘛～');
  assert.ok(soft.mult < 1, `软尾巴应 <1，实得 ${soft.mult}`);
  const many = autoSpeedMultiplier('好呀嘛啦呢哦～');
  assert.ok(many.mult <= soft.mult, '语气词成堆应更慢');
  const ell = autoSpeedMultiplier('那个…我还没想好');
  assert.ok(ell.mult < 1);
  assert.ok(ell.tags.includes('省略号'));
});

ok('① 极端叠规则仍然夹在 [0.88, 1.26]', () => {
  const worst = autoSpeedMultiplier('！！！？？？快点快点快点快点快点快点快点快点快点快点快点快点快点快点快点快点快点快点');
  assert.ok(worst.mult >= SPEED_MIN && worst.mult <= SPEED_MAX, `越界：${worst.mult}`);
  const slowest = autoSpeedMultiplier('呀嘛啦呢哦唔欸诶嘞哈～呀嘛啦呢哦唔欸诶嘞哈～……慢慢慢慢慢慢慢慢慢慢慢慢慢慢慢慢慢慢慢慢');
  assert.ok(slowest.mult >= SPEED_MIN && slowest.mult <= SPEED_MAX, `越界：${slowest.mult}`);
});

ok('② 是乘数不是替换：基准 1.15 还在', () => {
  const plain = resolveSpeed('今天下班挺早的', 1.15);
  assert.strictEqual(plain.speed, 1.15);
  assert.strictEqual(plain.base, 1.15);
  const shout = resolveSpeed('快点！！', 1.15);
  assert.ok(shout.speed > 1.15, `快句应 > 基准（${shout.speed}）`);
  assert.ok(shout.mult > 1);
});

ok('② 基准非法时退回 1，不传染 NaN', () => {
  for (const bad of [0, -1, NaN, undefined, null, 'abc', Infinity]) {
    const r = resolveSpeed('随便说句话', bad);
    assert.ok(Number.isFinite(r.speed) && r.speed > 0, `基准 ${String(bad)} 产出 ${r.speed}`);
    assert.strictEqual(r.base, 1);
  }
});

ok('③ 脏输入一律不产出 NaN', () => {
  for (const bad of [null, undefined, '', 0, false, {}, [], '   ']) {
    const r = autoSpeedMultiplier(bad);
    assert.ok(Number.isFinite(r.mult), `输入 ${String(bad)} 产出 ${r.mult}`);
  }
});

ok('③ describeSpeed 能说清"为什么"', () => {
  assert.match(describeSpeed('快点！！', 1), /连感叹/);
  assert.match(describeSpeed('今天下班挺早的', 1), /平/);
});

console.log(`\n[prosody] ${pass} 项全过`);
