// 上下文预算表自测（P0-1）。
//
// 这张表的价值全在"它砍了什么能被查到"，所以断言也围绕三件事：
//   ① 顺序只由 ORDER 决定（不靠 push 先后）；
//   ② 淘汰有固定次序，NEVER_DROP 砍不动；
//   ③ 未登记的段名必须被点名 —— 否则就是 Estrella 那次"扩展包提示词被静默丢掉"的重演。
import assert from 'node:assert';
import {
  applyBudget, clipSection, describeBudget, isDroppable,
  SYSTEM_ORDER, SYSTEM_BUDGET, USER_ORDER, USER_BUDGET, NEVER_DROP, EVICTION_ORDER
} from '../src/context-budget.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[context-budget]');

// ── 顺序 ────────────────────────────────────────────────────────────────
ok('顺序由 ORDER 决定，与传入先后无关', () => {
  const r = applyBudget([
    { name: 'reportBan', text: 'C' },
    { name: 'base', text: 'A' },
    { name: 'security', text: 'B' }
  ], { order: SYSTEM_ORDER });
  assert.strictEqual(r.text, 'A\n\nB\n\nC');
});

ok('未登记的段排在最后，并被 unregistered 点名', () => {
  const r = applyBudget([
    { name: 'base', text: 'A' },
    { name: 'never-registered', text: 'Z' }
  ], { order: SYSTEM_ORDER });
  assert.strictEqual(r.text, 'A\n\nZ');
  assert.deepStrictEqual(r.unregistered, ['never-registered']);
});

ok('空段不占位（关闭的功能不该在提示词里留空行）', () => {
  const r = applyBudget([
    { name: 'base', text: 'A' },
    { name: 'voice', text: '   ' },
    { name: 'security', text: 'B' }
  ], { order: SYSTEM_ORDER });
  assert.strictEqual(r.text, 'A\n\nB');
});

ok('同名段各自保留（vibe / mood 互斥分支不会互相吃掉）', () => {
  const r = applyBudget([
    { name: 'vibe', text: 'V1' },
    { name: 'vibe', text: 'V2' }
  ], { order: USER_ORDER });
  assert.strictEqual(r.text, 'V1\n\nV2');
});

// ── 截断 ────────────────────────────────────────────────────────────────
ok('超配额的段从尾部截断，保留段头并带省略号', () => {
  const clipped = clipSection('0123456789', 5);
  assert.strictEqual(clipped.text, '0123…');
  assert.strictEqual(clipped.clipped, 6, 'clipped = 原长 − 保留正文长（省略号占了 1 个字）');
});

ok('截断会出现在 clipped 明细里（不是静默）', () => {
  const r = applyBudget([{ name: 'base', text: 'x'.repeat(2000) }], {
    order: SYSTEM_ORDER, budget: { base: 100 }, totalMax: 99999
  });
  assert.strictEqual(r.clipped.length, 1);
  assert.strictEqual(r.clipped[0].name, 'base');
  assert.ok(r.clipped[0].clipped > 1800);
});

// ── 淘汰 ────────────────────────────────────────────────────────────────
ok('总量超限时按 EVICTION_ORDER 淘汰（先砍 humanVoice，不碰 base/security）', () => {
  const r = applyBudget([
    { name: 'base', text: 'A'.repeat(100) },
    { name: 'security', text: 'B'.repeat(100) },
    { name: 'humanVoice', text: 'C'.repeat(100) }
  ], { order: SYSTEM_ORDER, totalMax: 260 });
  const names = r.dropped.map((d) => d.name);
  assert.strictEqual(names[0], 'humanVoice', `第一个被砍的应是 humanVoice，实际 ${JSON.stringify(names)}`);
  assert.ok(!names.includes('base') && !names.includes('security'));
});

ok('NEVER_DROP 里的段即使超预算也不砍，而是标 over', () => {
  const r = applyBudget([
    { name: 'base', text: 'A'.repeat(500) },
    { name: 'security', text: 'B'.repeat(500) }
  ], { order: SYSTEM_ORDER, totalMax: 100 });
  assert.strictEqual(r.dropped.length, 0);
  assert.strictEqual(r.over, true, '砍不动时必须标 over，不能静默超限');
  assert.ok(r.text.includes('A') && r.text.includes('B'));
});

ok('isDroppable 与人设/安全段一致（人格永远最后才被考虑）', () => {
  for (const name of ['base', 'security', 'tools', 'speakOrNot', 'scene', 'role']) {
    assert.strictEqual(isDroppable(name), false, `${name} 不该可淘汰`);
  }
  for (const name of ['humanVoice', 'quoteAt', 'stickers']) {
    assert.strictEqual(isDroppable(name), true, `${name} 应该可淘汰`);
  }
});

ok('预算表与淘汰表互相自洽（写进淘汰表却没登记的段会被点名）', () => {
  const known = new Set([...SYSTEM_ORDER, ...USER_ORDER]);
  for (const name of EVICTION_ORDER) {
    assert.ok(known.has(name), `淘汰表里的 ${name} 没有出现在任何 ORDER 里`);
  }
  for (const name of NEVER_DROP) {
    assert.ok(known.has(name), `NEVER_DROP 里的 ${name} 没有出现在任何 ORDER 里`);
  }
  for (const name of Object.keys(SYSTEM_BUDGET)) {
    assert.ok(SYSTEM_ORDER.includes(name), `SYSTEM_BUDGET 有 ${name}，SYSTEM_ORDER 没有`);
  }
  for (const name of Object.keys(USER_BUDGET)) {
    assert.ok(USER_ORDER.includes(name), `USER_BUDGET 有 ${name}，USER_ORDER 没有`);
  }
});

ok('每段都有配额（没有"无限"的段）', () => {
  for (const [name, n] of Object.entries({ ...SYSTEM_BUDGET, ...USER_BUDGET })) {
    assert.ok(Number.isFinite(n) && n > 0, `${name} 的配额不合法：${n}`);
  }
});

// ── 时段摘要段的位置（m00209）────────────────────────────────────────────
ok('digest 排在 pastSummary 之后、past 之前（三者是三个时间深度）', () => {
  const iSummary = USER_ORDER.indexOf('pastSummary');
  const iDigest = USER_ORDER.indexOf('digest');
  const iPast = USER_ORDER.indexOf('past');
  assert.ok(iSummary >= 0 && iDigest >= 0 && iPast >= 0, '段名必须都登记过');
  assert.ok(iSummary < iDigest && iDigest < iPast,
    `顺序错了模型会把"刚才"读成"很久以前"（现为 ${iSummary}/${iDigest}/${iPast}）`);
});

ok('digest 与 past/pastSummary 一样不登记配额（上限由生产侧派生，不设两个真相源）', () => {
  for (const name of ['past', 'pastSummary', 'digest']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(USER_BUDGET, name),
      `${name} 一旦登记配额，就会和它自己的 maxChars 打架 —— 实测会静默截掉尾巴`);
  }
});

ok('digest 可淘汰，且先于 past 被砍（磁盘有原文、片键还能重算）', () => {
  assert.strictEqual(isDroppable('digest'), true, '它是能重算的背景，不该永不淘汰');
  const names = EVICTION_ORDER.map((n, i) => [n, i]);
  const idx = (n) => names.find(([x]) => x === n)?.[1] ?? -1;
  assert.ok(idx('digest') >= 0, 'digest 必须出现在淘汰表里，否则超预算时它砍不动');
  assert.ok(idx('digest') < idx('past'), 'digest 应先于 past 被砍（past 是"接话"的直接依据）');
});

// ── 留痕 ────────────────────────────────────────────────────────────────
ok('describeBudget：没事时不说话', () => {
  assert.strictEqual(describeBudget({ chars: 100, dropped: [], clipped: [], unregistered: [], over: false }), '');
});

ok('describeBudget：三种异常各说各的', () => {
  const line = describeBudget({
    chars: 900,
    dropped: [{ name: 'memes', chars: 100, reason: 'overflow' }],
    clipped: [{ name: 'role', clipped: 20, kept: 80 }],
    unregistered: ['foo'],
    over: true
  }, '系统提示');
  assert.ok(line.includes('淘汰 memes'));
  assert.ok(line.includes('截断 role'));
  assert.ok(line.includes('未登记段 foo'));
  assert.ok(line.includes('超预算'));
});

console.log(`✓ context-budget 自测通过（${pass} 项）`);
