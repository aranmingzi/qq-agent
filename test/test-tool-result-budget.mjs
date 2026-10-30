// 工具结果头尾截断自测（上下文压缩 §四 L1）。
//
// 断言围绕"改这一下到底修了什么"：
//   ① 没超上限就一个字不动（changed:false 是调用方的判据）；
//   ② 尾巴必须留下 —— 列表类工具最新的消息在末尾，只留开头等于答非所问；
//   ③ 切在行边界上，不留半条消息；
//   ④ 丢了多少字要写在标记里（模型得知道这里缺东西）；
//   ⑤ 绝不"越截越长"。
import assert from 'node:assert';
import { clipToolResult, describeClip, DEFAULT_MAX_CHARS } from '../src/tool-result-budget.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[tool-result-budget]');

const lines = (n, tag = '行') => Array.from({ length: n }, (_, i) => `${tag}${i}：` + 'x'.repeat(38)).join('\n');

ok('未超上限：返回原引用，changed=false', () => {
  const s = lines(10);
  const r = clipToolResult(s, { maxChars: 10000 });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, s);
  assert.strictEqual(r.dropped, 0);
});

ok('空串/短串不炸', () => {
  assert.strictEqual(clipToolResult('').changed, false);
  assert.strictEqual(clipToolResult(undefined).changed, false);
  assert.strictEqual(clipToolResult('abc', { maxChars: 200 }).text, 'abc');
});

ok('超上限：头和尾都在，中间有省略标记', () => {
  const s = '【头】\n' + lines(400) + '\n【尾·结论在第400行】';
  const r = clipToolResult(s, { maxChars: 2000 });
  assert.strictEqual(r.changed, true);
  assert.ok(r.text.startsWith('【头】'), '开头必须保留');
  assert.ok(r.text.trimEnd().endsWith('【尾·结论在第400行】'), '结尾必须保留（这是只留开头时丢掉的东西）');
  assert.ok(/中间已省略 \d+ 字/.test(r.text), '标记要写清丢了多少');
  // 标记本身告诉模型"这不是完整结果"
  assert.ok(r.text.includes('这不是完整结果'));
});

ok('结果总长受控，但允许标记带来的少量余量', () => {
  const s = lines(1000);
  const r = clipToolResult(s, { maxChars: 3000 });
  assert.ok(r.after <= 3200, `实际 ${r.after}`);
  assert.ok(r.after > 1000, '不能截到只剩标记');
});

ok('切在行边界：头以整行结尾、尾以整行开头', () => {
  const s = lines(800);
  const r = clipToolResult(s, { maxChars: 2000 });
  const [head] = r.text.split('\n\n[⚠️ 工具结果过长');
  assert.ok(/\d+：x+$/.test(head.trimEnd()), `头被切半行了：${JSON.stringify(head.slice(-20))}`);
  const tail = r.text.split(']\n\n').pop();
  assert.ok(/^行\d+：x+/.test(tail), `尾没从整行开始：${JSON.stringify(tail.slice(0, 20))}`);
});

ok('dropped = 原文 - 保留部分（标记不计入 dropped）', () => {
  const s = lines(600);
  const r = clipToolResult(s, { maxChars: 2000 });
  const marker = r.text.length - (r.before - r.dropped);
  assert.ok(marker > 0 && marker < 400, `标记长度异常：${marker}`);
  assert.strictEqual(r.before - r.after, r.dropped - marker);
});

ok('headRatio 可调，且被夹在 0.1~0.9', () => {
  const s = lines(800);
  const mostlyTail = clipToolResult(s, { maxChars: 2000, headRatio: 0.1 });
  const mostlyHead = clipToolResult(s, { maxChars: 2000, headRatio: 0.9 });
  const headLen = (t) => t.indexOf('\n\n[⚠️');
  assert.ok(headLen(mostlyTail.text) < headLen(mostlyHead.text), 'headRatio 没生效');
  // 越界值不许炸，也不许变成 0 长度
  const lo = clipToolResult(s, { maxChars: 2000, headRatio: -5 });
  assert.ok(lo.changed && lo.text.length > 200);
});

ok('一整行几万字（无换行可切）：仍然头尾各留一半，不退化成只留头', () => {
  const s = 'A'.repeat(30000) + 'ZZZ尾部';
  const r = clipToolResult(s, { maxChars: 2000 });
  assert.strictEqual(r.changed, true);
  assert.ok(r.text.startsWith('AAA'));
  assert.ok(r.text.endsWith('ZZZ尾部'), '无行边界时尾巴更不能丢');
});

ok('绝不越截越长', () => {
  // maxChars 刚好略小于原文：标记比省下来的还长时必须原样返回
  const s = 'y'.repeat(230);
  const r = clipToolResult(s, { maxChars: 200 });
  assert.ok(r.after <= r.before || r.changed === false);
});

ok('默认上限与 config 出厂值一致', () => {
  assert.strictEqual(DEFAULT_MAX_CHARS, 12000);
});

ok('describeClip：没截断时返回空串', () => {
  assert.strictEqual(describeClip(null), '');
  assert.strictEqual(describeClip({ changed: false }), '');
  assert.ok(describeClip({ changed: true, before: 9000, after: 3000, dropped: 6100 }).includes('9000→3000'));
});

console.log(`\n[tool-result-budget] ${pass} 项通过`);
