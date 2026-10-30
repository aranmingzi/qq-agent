// 口头禅抑制自检（纯逻辑，不碰网络）。
// 跑：node test/test-phrase-guard.mjs
//
// 守护的是 2026-10-24 的实机现象：她老把"给钱/转账/红包"挂嘴上。
// 样本全部取自真实存档（group_20000005 / group_20000001）。
//
// ⚠️ 屡犯记录会落盘，所以先把 DATA_DIR 指到临时目录 —— 否则跑个测试就把
// 生产的"拉黑名单"改了（这是最难查的一类假象）。
// ⚠️ 除 [8] 之外全部传 persist:false：那些用例要的是纯函数语义，
// 一旦被上一例写下的屡犯记录降了阈值，"2 条不提醒"就会莫名其妙变成"提醒"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-phrase-'));

const { detectPhraseAddiction, renderPhraseGuard } = await import('../src/phrase-guard.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e?.message || e); process.exitCode = 1; }
}

const NOW = 1792846000000;
const H = 3600000;
const me = (text, minutesAgo = 5) => ({ text, self: true, ts: NOW - minutesAgo * 60000 });
const other = (text, minutesAgo = 5) => ({ text, self: false, senderName: '群友', ts: NOW - minutesAgo * 60000 });
const pure = (entries, opts = {}) => detectPhraseAddiction(entries, { now: NOW, persist: false, ...opts });

console.log('\n[1] 真机样本：同一个梗换着说法，也要认出来');
ok('四条讨钱变体 → 命中 money', () => {
  const r = pure([
    me('先转账五块 老规矩', 40),
    me('想看先转账 十块一次', 30),
    me('光笑不给钱啊', 20),
    me('红包呢 一个表情想当爹', 10),
    me('诶 出现了', 5)
  ]);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].id, 'money');
  assert.equal(r.hits[0].count, 4);
  assert.match(r.text, /这轮别犯/);
  assert.match(r.text, /讨钱/);
});

ok('只有 2 条（没到阈值 3）→ 不提醒', () => {
  const r = pure([me('先转账五块', 30), me('光笑不给钱啊', 20), me('哪去了这两天', 10), me('哦好', 5)]);
  assert.equal(r.hits.length, 0);
  assert.equal(r.text, '');
});

console.log('\n[2] 别人的话不算她的口癖');
ok('群友狂说"付钱" → 她没毛病就不提醒', () => {
  const r = pure([
    other('没码还想让我付钱'),
    other('你戳我这么多下是不是也要付钱'),
    other('不付钱我继续戳'),
    me('诶 出现了'),
    me('哪去了这两天'),
    me('哦好'),
    me('在的')
  ]);
  assert.equal(r.hits.length, 0);
  assert.equal(r.text, '');
});

console.log('\n[3] 时间窗：昨天的口癖不算今天的口癖');
ok('超过 12 小时的不计入', () => {
  const old = NOW - 20 * H;
  const r = pure([
    { text: '先转账五块', self: true, ts: old },
    { text: '光笑不给钱啊', self: true, ts: old + 60000 },
    { text: '红包呢', self: true, ts: old + 120000 },
    me('诶 出现了')
  ]);
  assert.equal(r.hits.length, 0);
});

console.log('\n[4] 通用复读：短句反复出现');
ok('同一句短话说了 5 次 → 报出来', () => {
  const r = pure([me('哦豁绝了'), me('哦豁绝了'), me('哦豁绝了'), me('哦豁绝了'), me('哦豁绝了')]);
  assert.ok(r.repeats.length >= 1, '应至少报一个复读片段');
  assert.match(r.text, /说了/);
});

console.log('\n[5] 正常聊天不能被误伤');
ok('语气词高频（哈哈/？/草）不算口癖', () => {
  const r = pure([
    me('哈哈哈'), me('哈哈哈'), me('哈哈哈'), me('哈哈哈'),
    me('？'), me('？'), me('？'), me('草'), me('草'), me('草')
  ]);
  assert.equal(r.hits.length, 0);
  assert.equal(r.repeats.length, 0, '语气词不该进复读榜：' + JSON.stringify(r.repeats));
  assert.equal(r.text, '');
});

ok('长句里重复的三字组合不算口癖', () => {
  const long = '我觉得这个问题其实还得再想想别的办法才行';
  const r = pure([me(long), me(long), me(long), me(long), me(long)]);
  assert.equal(r.repeats.length, 0);
});

ok('样本太少（<4 条）不硬判', () => {
  const r = pure([me('给钱'), me('打钱')]);
  assert.equal(r.text, '');
  assert.equal(r.checked, 2);
});

console.log('\n[6] 配置与容错');
ok('enabled=false → 完全关掉', () => {
  const r = pure([me('给钱'), me('打钱'), me('转账')], { config: { enabled: false } });
  assert.equal(r.enabled, false);
  assert.equal(r.text, '');
});

ok('正则写坏了只作废那一簇，不抛错', () => {
  const r = pure([me('给钱'), me('打钱'), me('转账'), me('红包')], {
    config: { watch: [{ id: 'bad', label: '坏正则', pattern: '([未闭合' }] }
  });
  assert.equal(r.hits.length, 0);
});

ok('可自定义簇（比如"拍我"梗）', () => {
  const r = pure([me('拍我一下'), me('又拍我'), me('别拍我'), me('在吗')], {
    config: { watch: [{ id: 'poke', label: '拍一拍', pattern: '拍我' }] }
  });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].id, 'poke');
});

console.log('\n[7] 渲染：空手不占预算');
ok('没毛病 → 空串', () => assert.equal(renderPhraseGuard({ hits: [], repeats: [] }), ''));
ok('有毛病 → 明确点名且给替代动作', () => {
  const t = renderPhraseGuard({ hits: [{ id: 'money', label: '钱', count: 4 }] }, { checked: 14 });
  assert.match(t, /14 条发言里，你有 4 条/);
  assert.match(t, /一个字都别再提/);
  assert.match(t, /接对方话里最具体的那一点/);
});

console.log('\n[8] 屡犯记录：被抓过一次之后更容易被抓');
ok('第一次 3 条才抓；之后 2 条就抓，且措辞升级', () => {
  const first = detectPhraseAddiction(
    [me('给钱', 30), me('打钱', 20), me('转账', 10), me('在吗', 5)],
    { now: NOW, chatKey: 'group:9' }
  );
  assert.equal(first.hits.length, 1, '第一次应命中');
  assert.equal(first.hits[0].chronic, false);

  const second = detectPhraseAddiction(
    [me('给钱', 30), me('红包', 20), me('在吗', 10), me('哦好', 5)],
    { now: NOW + 60000, chatKey: 'group:9' }
  );
  assert.equal(second.hits.length, 1, '屡犯时应降到 2 条即命中');
  assert.equal(second.hits[0].chronic, true);
  assert.match(second.text, /犯过/);
});

ok('记录落盘在 DATA_DIR 下（不是散在别处）', () => {
  assert.ok(fs.existsSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'phrase-guard.json')));
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}\n`);
