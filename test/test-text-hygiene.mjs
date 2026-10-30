// 请求体文本卫生（孤立代理项）自测。
//
// 这条 bug 的可怕之处是**静默**：JSON.stringify 不报错，服务端只回一个 400，
// 日志里看不出是哪个字。所以断言要直接盯"发出去的字节里还有没有 \ud83d"。
import assert from 'node:assert';
import { sanitizeString, sanitizeDeep, countLoneSurrogates } from '../src/text-hygiene.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[text-hygiene]');

const EMOJI = '😂';                       // "\uD83D\uDE02"
const LONE_HIGH = '\uD83D';               // 半个 emoji
const LONE_LOW = '\uDE02';

ok('① 成对代理项（emoji）原样保留', () => {
  const s = `哈哈哈${EMOJI}笑死`;
  assert.strictEqual(sanitizeString(s), s);
  assert.strictEqual(countLoneSurrogates(s), 0);
});

ok('① 孤立高代理项被摘掉', () => {
  const s = `哈哈哈${LONE_HIGH}`;
  assert.strictEqual(sanitizeString(s), '哈哈哈');
  assert.strictEqual(countLoneSurrogates(s), 1);
});

ok('① 孤立低代理项被摘掉', () => {
  assert.strictEqual(sanitizeString(`哈${LONE_LOW}哈`), '哈哈');
});

ok('① 多个 / 混排 / 相邻孤立项都能清干净', () => {
  // 只有「高代理项紧跟低代理项」才算一对；低在前 = 两个孤立项都要删。
  const s = `${LONE_HIGH}a${LONE_LOW}b${LONE_HIGH}${LONE_LOW}c${LONE_HIGH}`;
  const out = sanitizeString(s);
  assert.strictEqual(out, `ab${EMOJI}c`);
  assert.strictEqual(countLoneSurrogates(out), 0);
});

ok('② 没变化时返回**原引用**（省一次序列化，也让调用方能判断）', () => {
  const s = '普通中文没有代理项';
  assert.strictEqual(sanitizeString(s), s);
  const obj = { a: '普通', b: ['也是普通'] };
  assert.strictEqual(sanitizeDeep(obj), obj);
});

ok('② 变了就返回新对象，原对象不被改', () => {
  const obj = { messages: [{ role: 'user', content: `x${LONE_HIGH}` }] };
  const out = sanitizeDeep(obj);
  assert.notStrictEqual(out, obj);
  assert.strictEqual(out.messages[0].content, 'x');
  assert.strictEqual(obj.messages[0].content, `x${LONE_HIGH}`, '不许原地改调用方的对象');
});

ok('③ 真实故障复现：截断 emoji 后 JSON 里出现 \ud83d', () => {
  const text = `他说${EMOJI}好`;              // 他/说/😂(2码元)/好
  const broken = text.slice(0, 3);            // 切在 emoji 中间 → 留下孤立高代理项
  const payload = { messages: [{ role: 'tool', content: broken }] };

  const before = JSON.stringify(payload);
  assert.ok(before.includes('\\ud83d'), `前置条件：截断后应含 \\ud83d，实际 ${before}`);

  const after = JSON.stringify(sanitizeDeep(payload));
  assert.ok(!after.includes('\\ud83d'), `清洗后不应再有孤立代理项，实际 ${after}`);
  assert.ok(after.includes('他说'), '正文不许被吃掉');
});

ok('③ data URI（内联图片）直接跳过，不扫几 MB 的 base64', () => {
  const uri = `data:image/jpeg;base64,${'A'.repeat(200000)}`;
  const stats = { removed: 0 };
  assert.strictEqual(sanitizeString(uri, stats), uri);
  assert.strictEqual(stats.removed, 0);
});

ok('④ 非 plain object（Buffer/Date）原样放过', () => {
  const buf = Buffer.from('hi');
  assert.strictEqual(sanitizeDeep(buf), buf);
  const d = new Date();
  assert.strictEqual(sanitizeDeep(d), d);
  assert.strictEqual(sanitizeDeep(123), 123);
  assert.strictEqual(sanitizeDeep(null), null);
});

ok('④ stats 能累计出"删了几个"', () => {
  const stats = { removed: 0 };
  sanitizeDeep({ a: `x${LONE_HIGH}`, b: [`y${LONE_LOW}`] }, stats);
  assert.strictEqual(stats.removed, 2);
});

ok('④ 深嵌套不会卡死（超深直接放过）', () => {
  let deep = `x${LONE_HIGH}`;
  for (let i = 0; i < 40; i += 1) deep = [deep];
  assert.doesNotThrow(() => sanitizeDeep(deep));
});

console.log(`\n[text-hygiene] ${pass} 项全过`);
