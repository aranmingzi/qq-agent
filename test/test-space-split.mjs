// 出站「空格分句」纠正自测（2026-10-25）。
//
// 这一层最容易犯的错不是"没改"，而是**改坏了**：发出去了就收不回。
// 所以断言的重点是"哪些必须不动"，其次才是"哪些该改"：
//   · 短气泡（<10 字）不动 —— 人类那个长度几乎不用标点，「那行 给你配了」是真实写法；
//   · 30 字以上不动 —— 人类空格率 84.8%，她 9.1%，本来就比人干净，而且多半是整段粘贴；
//   · 夹着数字/英文的不动 —— "8.50 分""IG 打 GEN"里的空格不是逗号；
//   · 占位符/卡片/代码/链接整段不动 —— 那不是"她写给人看的一句话"；
//   · 没改时必须返回**原引用**（changed=false 是调用方的判据）。
//
// 最后一条断言是本文件存在的理由：把最近 7 天 1,131 条真实气泡跑一遍，
// 残留率必须落在人类基线（27.7%）以内，且改出来的每一句都得读得通。
import assert from 'node:assert';
import { despace, scanSplits, DEFAULT_MIN_CHARS, DEFAULT_MAX_CHARS } from '../src/space-split.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }
async function okAsync(name, fn) { await fn(); pass += 1; console.log('  ✓', name); }

console.log('[space-split]');

// ── 该改的 ────────────────────────────────────────────────────────
ok('10~29 字：中文之间的空格换成逗号', () => {
  assert.strictEqual(despace('十五下 你这是要凑整啊').text, '十五下，你这是要凑整啊');
  assert.strictEqual(despace('指我？行 那你也别跑了').text, '指我？行，那你也别跑了');
});

ok('多处空格：每一处各换一个逗号', () => {
  const r = despace('20了 凑整成功 可以收工了');
  assert.strictEqual(r.text, '20了，凑整成功，可以收工了');
  assert.strictEqual(r.fixed, 2);
});

ok('连续多个空格：并成一个逗号，不留 ",，"', () => {
  assert.strictEqual(despace('这头像想拿来糊弄我是吧   换张好看的').text, '这头像想拿来糊弄我是吧，换张好看的');
});

ok('全角空格（U+3000）同样算分隔', () => {
  // 群里真的出现过这条：半角正则漏掉全角空格，于是"看着改了其实没改"
  const r = despace('哟 今天这是黑话速成班啊　先数学刑具后LOL串子');
  assert.ok(r.changed, '全角空格没被认出来');
  assert.strictEqual(r.text, '哟，今天这是黑话速成班啊，先数学刑具后LOL串子');
});

ok('已经用逗号的地方不会被搞成双重标点', () => {
  assert.strictEqual(despace('行吧，它聪明 那你去跟它过').text, '行吧，它聪明，那你去跟它过');
});

// ── 不该改的（更重要）──────────────────────────────────────────────
ok('短气泡（<10 字）不动：人类在这个长度里就是拿空格断句', () => {
  for (const s of ['笑啥 说清楚', '哼 现在想起来夸了', '彳亍 那翻篇', '这张还像个人样 收了']) {
    const r = despace(s);
    assert.strictEqual(r.changed, false, `不该改：${s}`);
    assert.strictEqual(r.text, s);
  }
});

ok('30 字以上不动：那一段她本来就在用逗号，动它风险大于收益', () => {
  const s = '昨天还有人说叫我爸转账五块 今天直接白认亲 你们这价位越来越离谱了';
  assert.ok(s.replace(/\s/g, '').length >= DEFAULT_MAX_CHARS, '样本本身要够长，否则这条断言在测别的东西');
  assert.strictEqual(despace(s).changed, false);
});

ok('汉字两侧只要有一边不是汉字就不动（数字/英文/标点）', () => {
  // "8.50 分"、"IG 打 GEN"：空格在这里是排版，不是逗号
  assert.strictEqual(despace('我超 38.6 是真烧了 吃药了没').text, '我超 38.6 是真烧了，吃药了没');
  assert.strictEqual(despace('IG 打 GEN 啊 这局要是打满五十分钟你今晚就别睡了').text,
    'IG 打 GEN 啊，这局要是打满五十分钟你今晚就别睡了');
});

ok('行首/行尾的空格不动', () => {
  assert.strictEqual(despace(' 十五下 你这是要凑整啊 ').text, ' 十五下，你这是要凑整啊 ');
});

ok('占位符 / 卡片 / 多行 / 代码 / 链接：整段不动', () => {
  const cases = [
    '[表情包：鲸鱼（dayu_006）] 又是一张',
    '【正在播放】晴天 周杰伦 03:52 点歌人：小明',
    '第一行 说的是这个\n第二行 说的是那个',
    '```js\nconst a = 1; // 这里是代码\n```',
    '看这个 https://example.com/a b c 挺好的'
  ];
  for (const s of cases) {
    assert.strictEqual(despace(s).changed, false, `不该改：${s.replace(/\n/g, '\\n')}`);
  }
});

ok('汉字占比过低（英文/数据为主）不动', () => {
  const s = 'build passed in 12.3s with 4 warnings and 0 errors 好';
  assert.strictEqual(despace(s).changed, false);
});

// ── 契约 ──────────────────────────────────────────────────────────
ok('没改时返回原引用（调用方靠 !== 判断，省一次拷贝）', () => {
  const s = '太短了 真的';
  const r = despace(s);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.text, s);
});

ok('空串 / undefined / 数字不会炸', () => {
  assert.strictEqual(despace('').changed, false);
  assert.strictEqual(despace(undefined).changed, false);
  assert.strictEqual(despace(null).changed, false);
  assert.strictEqual(despace(12345).changed, false);
});

ok('幂等：改过一遍再跑一遍不会再动', () => {
  const once = despace('十五下 你这是要凑整啊').text;
  const twice = despace(once);
  assert.strictEqual(twice.changed, false);
  assert.strictEqual(twice.text, once);
});

ok('默认阈值就是文档里写的那两个数（改了要同步改注释里的表）', () => {
  assert.strictEqual(DEFAULT_MIN_CHARS, 10);
  assert.strictEqual(DEFAULT_MAX_CHARS, 30);
});

ok('minChars/maxChars 可覆盖（灰度时用）', () => {
  assert.strictEqual(despace('笑啥 说清楚', { minChars: 0 }).text, '笑啥，说清楚');
  assert.strictEqual(despace('十五下 你这是要凑整啊', { maxChars: 5 }).changed, false);
  assert.strictEqual(despace('十五下 你这是要凑整啊', { maxChars: 0 }).changed, true);
});

ok('mark 可覆盖（排查时想看清改了哪儿）', () => {
  assert.strictEqual(despace('十五下 你这是要凑整啊', { mark: '·' }).text, '十五下·你这是要凑整啊');
});

ok('scanSplits 报得出每一处的位置与上下文', () => {
  const r = scanSplits('十五下 你这是要凑整啊');
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.wouldFix, true);
  assert.strictEqual(r.hits[0].before, '十五下');
  assert.strictEqual(r.hits[0].after, '你这是要凑整');
});

ok('scanSplits 在短句上报 skipped=short（解释"为什么没改"）', () => {
  const r = scanSplits('笑啥 说清楚');
  assert.strictEqual(r.wouldFix, false);
  assert.strictEqual(r.skipped, 'short');
  assert.strictEqual(r.hits.length, 1, '"有几处"和"改不改"是两件事');
});

// ── 真数据回放 ─────────────────────────────────────────────────────
// 这一条是防"正则看着对、实际漏一半"：拿 data/sessions 里的真实气泡跑，
// 残留率必须低于人类基线。数据不在（新机器/清过档）时自动跳过。
await okAsync('真数据回放：残留率必须低于人类基线 27.7%', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(import.meta.dirname, '..', 'data', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
  const texts = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(j.sent)) continue;
    for (const s of j.sent) { const t = String(s.text || ''); if (t) texts.push(t); }
  }
  if (texts.length < 300) return;   // 样本太少，测了也没意义
  const re = /[\u4e00-\u9fff] +[\u4e00-\u9fff]/;
  const hit = texts.filter((t) => re.test(t));
  const left = hit.filter((t) => !despace(t).changed);
  const rate = (left.length / texts.length) * 100;
  assert.ok(rate < 27.7, `残留率 ${rate.toFixed(1)}% 没降到人类基线以下（${left.length}/${texts.length}）`);
  // 并且残留的应当基本都在"刻意不动"的两头（短气泡 / 超长段）
  const solid = (t) => t.replace(/\s/g, '').length;
  // 落在"该改区间"却仍没改的，只允许是 shouldSkip 主动放弃的（多行/英文为主/占位符）
  const drifted = left.filter((t) => solid(t) >= DEFAULT_MIN_CHARS && solid(t) < DEFAULT_MAX_CHARS && !despace(t).skipped);
  assert.strictEqual(drifted.length, 0, `这些落在该改区间却没改：${JSON.stringify(drifted.slice(0, 3))}`);
});

// ── 接线：真的走一遍 sendTextBatch ─────────────────────────────────
// 纯函数对不代表接线对。这里用假 platform 真跑一次发送队列，验三件事：
//   ① 发出去的是改过的；② 结果里带回 raw（看板靠它把"她写的"和"你看到的"分开）；
//   ③ 开关关掉就一点都不动（灰度/回滚的退路）。
const { SendQueue } = await import('../src/sender.js');
const { getConfig } = await import('../src/config.js');

function mkQueue(out) {
  return new SendQueue({
    platform: { sendText: async (kind, id, text) => { out.push(text); return { message_id: out.length }; } },
    store: { appendSelf() { /* 测试不落盘 */ } }
  });
}

await okAsync('sendTextBatch：发出去的是改过的，且带回 raw', async () => {
  const out = [];
  const r = await mkQueue(out).sendTextBatch('group:1', ['十五下 你这是要凑整啊', '笑啥 说清楚'], {});
  assert.deepStrictEqual(out, ['十五下，你这是要凑整啊', '笑啥 说清楚']);
  assert.strictEqual(r.sent[0].text, '十五下，你这是要凑整啊');
  assert.strictEqual(r.sent[0].raw, '十五下 你这是要凑整啊', 'raw 丢了，看板就只能看到被粉饰过的数');
  assert.strictEqual(r.sent[1].raw, undefined, '没改的不该带 raw（否则看板会以为改过）');
});

await okAsync('send.send.despaceSplit=false：一个字都不动', async () => {
  const cfg = getConfig();
  const prev = cfg.send?.despaceSplit;
  if (!cfg.send) throw new Error('配置里没有 send 段，测试环境不对');
  cfg.send.despaceSplit = false;
  try {
    const out = [];
    const r = await mkQueue(out).sendTextBatch('group:1', ['十五下 你这是要凑整啊'], {});
    assert.deepStrictEqual(out, ['十五下 你这是要凑整啊']);
    assert.strictEqual(r.sent[0].raw, undefined);
  } finally {
    cfg.send.despaceSplit = prev;
  }
});

console.log(`  ${pass} 项通过`);
