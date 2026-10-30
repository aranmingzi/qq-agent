// 寻址判定自检（纯逻辑、不碰网络、不等真实时间）。
// 跑：node test/test-addressee.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 寻址三件套要真的落盘才算数（store 用的是导入时算好的 DATA_DIR，必须在 import 之前定好）
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-addressee-'));

const {
  TARGET, addresseeOf, targetsOf, targetOf, lastTargetOf, isSideTalk, describeTarget,
  parseTextTargets, looksLikeCallingName
} = await import('../src/addressee.js');
const { decideWake } = await import('../src/reply-gate.js');
const { formatGateLines, buildGateMessages, shouldGate } = await import('../src/wake-gate.js');
const { buildUserBundle } = await import('../src/prompt.js');
const { primarySpeaker } = await import('../src/speaker.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e?.message || e); process.exitCode = 1; }
}

// 机器人自称：小鱼（昵称）+ AI 酱（别名）
const OPTS = { aliases: ['小鱼', 'AI 酱'], selfIds: ['10000'], selfNickname: '小鱼' };
const E = (text, extra = {}) => ({ text, senderId: '20001', senderName: '小明', ...extra });

console.log('\n[1] 文本兜底：@ 了谁');
ok('@我 → self', () => assert.equal(targetOf(E('@我 在吗'), OPTS), TARGET.SELF));
ok('@全体成员 → all', () => assert.equal(targetOf(E('@全体成员 开会了'), OPTS), TARGET.ALL));
ok('@张三 → other（不是@我）', () => assert.equal(targetOf(E('@张三 晚上吃啥'), OPTS), TARGET.OTHER));
ok('@小鱼（昵称）→ self', () => assert.equal(targetOf(E('@小鱼 在吗'), OPTS), TARGET.SELF));
ok('@AI 酱（别名）→ self', () => assert.equal(targetOf(E('@AI 酱 讲个笑话'), OPTS), TARGET.SELF));
ok('叫名字（呼格）→ self', () => assert.equal(targetOf(E('小鱼帮我看看这个'), OPTS), TARGET.SELF));
ok('什么都不指 → none', () => assert.equal(targetOf(E('今天天气不错'), OPTS), TARGET.NONE));
ok('@后面是空格结尾能截断', () => {
  const info = addresseeOf(E('@张三 你好 世界'), OPTS);
  assert.equal(info.target, TARGET.OTHER);
  assert.deepEqual(info.atOthers, ['张三']);
});
ok('★ 昵称带空格（AI 酱）不会被切成另一个人', () => {
  const info = addresseeOf(E('@AI 酱 讲个笑话'), OPTS);
  assert.equal(info.target, TARGET.SELF);
  assert.deepEqual(info.atOthers, [], '"AI" 不该被当成别人');
});
ok('昵称带空格时，@别人 依然认得出', () => {
  const info = addresseeOf(E('@AI 酱 和 @张三 都来'), OPTS);
  assert.equal(info.target, TARGET.SELF);   // @我 优先
  assert.deepEqual(info.atOthers, ['张三']);
});

console.log('\n[2] 文本兜底：引用了谁');
ok('引用我的话 → self', () => assert.equal(targetOf(E('[引用 小鱼：今天天气不错] 真的吗'), OPTS), TARGET.SELF));
ok('引用别人的话 → other', () => assert.equal(targetOf(E('[引用 张三：晚上吃啥] 火锅'), OPTS), TARGET.OTHER));
ok('只有原文、没有冒号 → 不算引用别人', () => {
  const t = parseTextTargets('[引用 晚上吃啥]');
  assert.equal(t.replySender, '');
  assert.equal(targetOf(E('[引用 晚上吃啥]'), OPTS), TARGET.NONE);
});

console.log('\n[3] 结构化字段优先（入站写的那三个）');
ok('atSelf=true → self', () => assert.equal(targetOf(E('在吗', { atSelf: true }), OPTS), TARGET.SELF));
ok('atOthers=[张三] → other', () => assert.equal(targetOf(E('在吗', { atOthers: ['张三'] }), OPTS), TARGET.OTHER));
ok('reply.self=true → self', () => {
  assert.equal(targetOf(E('真的吗', { reply: { senderId: '10000', sender: '小鱼', text: '今天天气不错', self: true } }), OPTS), TARGET.SELF);
});
ok('reply 是别人的 → other', () => {
  assert.equal(targetOf(E('火锅', { reply: { senderId: '20002', sender: '张三', text: '晚上吃啥', self: false } }), OPTS), TARGET.OTHER);
});
ok('selfIds 比对不依赖 sender 名字', () => {
  assert.equal(targetOf(E('嗯', { reply: { senderId: '10000', sender: '', text: '' } }), OPTS), TARGET.SELF);
});

console.log('\n[4] ★ 优先级：提到名字 ≠ 叫名字');
ok('@别人 时提到它的名字 → 仍是 other', () => {
  const info = addresseeOf(E('@张三 你看小鱼多能说', { atOthers: ['张三'] }), OPTS);
  assert.equal(info.target, TARGET.OTHER);
  assert.equal(info.mentionSelf, true);      // 确实提到了
});
ok('@别人 时用到"我"字 → 不是 @我', () => {
  assert.equal(targetOf(E('@张三 我昨天说的那个'), OPTS), TARGET.OTHER);
});
ok('引用别人 时提到它 → 仍是 other', () => {
  const info = addresseeOf(E('[引用 张三：小鱼呢] 她在忙', { reply: { senderId: '20002', sender: '张三', self: false } }), OPTS);
  assert.equal(info.target, TARGET.OTHER);
});
ok('@我 和 @别人 同时出现 → 以 @我 为准', () => {
  assert.equal(targetOf(E('@我 @张三 一起吃饭', { atSelf: true, atOthers: ['张三'] }), OPTS), TARGET.SELF);
});

console.log('\n[5] 旁听判定：群友之间在对谈');
ok('最后一条对别人说 → 她在旁听', () => {
  const es = [E('在吗'), E('@张三 晚上吃啥', { atOthers: ['张三'] })];
  assert.equal(isSideTalk(es, targetsOf(es, OPTS)), true);
});
ok('最后两条来自不同的人 → 她在旁听', () => {
  const es = [E('你昨天去哪了'), E('在家', { senderId: '20002' })];
  assert.equal(isSideTalk(es, targetsOf(es, OPTS)), true);
});
ok('同一个人的连发 → 不算旁听', () => {
  const es = [E('我跟你说啊'), E('真的离谱')];
  assert.equal(isSideTalk(es, targetsOf(es, OPTS)), false);
});
ok('最后一条在叫它 → 不算旁听', () => {
  const es = [E('在吗', { senderId: '20002' }), E('@我 你说呢', { atSelf: true, senderId: '20001' })];
  assert.equal(isSideTalk(es, targetsOf(es, OPTS)), false);
});
ok('只有一条消息 → 不算旁听', () => {
  const es = [E('今天天气不错')];
  assert.equal(isSideTalk(es, targetsOf(es, OPTS)), false);
});
ok('空数组不会炸', () => assert.equal(isSideTalk([], []), false));

console.log('\n[6] 文案');
ok('describeTarget', () => {
  assert.equal(describeTarget(addresseeOf(E('@我 在吗'), OPTS)), '@我');
  assert.equal(describeTarget(addresseeOf(E('[引用 小鱼：x] 嗯', { reply: { senderId: '10000', self: true } }), OPTS)), '引用我');
  // ★ 2026-10-31：只是提到名字 → "聊到我"（以前写"提到我"，模型读成"在叫我"）
  assert.equal(describeTarget(addresseeOf(E('小鱼真好看'), OPTS)), '聊到我');
  assert.equal(describeTarget(addresseeOf(E('小鱼，帮我看看这个'), OPTS)), '叫我');
  assert.equal(describeTarget(addresseeOf(E('@张三 吃饭', { atOthers: ['张三'] }), OPTS)), '对张三');
  assert.equal(describeTarget(addresseeOf(E('@全体成员'), OPTS)), '对全体');
  assert.equal(describeTarget(addresseeOf(E('今天天气不错'), OPTS)), '');
});
ok('引用别人时叫得出那个人的名字（不只是"对别人说"）', () => {
  const info = addresseeOf(E('火锅', { reply: { senderId: '20002', sender: '小明', self: false } }), OPTS);
  assert.equal(info.otherName, '小明');
  assert.equal(describeTarget(info), '对小明');
});
ok('lastTargetOf 看最后一条', () => {
  assert.equal(lastTargetOf([E('@我 在吗', { atSelf: true }), E('@张三 吃啥', { atOthers: ['张三'] })], OPTS), TARGET.OTHER);
});

// ── 闸门：这才是"和群友说话她别接"真正生效的地方 ──────────────────────
const CFG = {
  gate: {
    enabled: true,
    probability: 0.9,          // 基线拉满，这样"没被叫醒"只能是寻址拦的
    activeWindowMs: 0, coldGapMs: 0,
    addressee: { enabled: true, toOtherFactor: 0.08, sideTalkFactor: 0.35 }
  }
};
const SELF = { selfId: '10000', selfNickname: '小鱼' };
const NO = () => 0.999;        // 掷骰子必不中 → 醒不醒只看判据

console.log('\n[7] 闸门：对别人说的消息叫不醒它');
ok('@别人 → 不唤醒（p 被降到 0.9×0.08）', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@张三 晚上吃啥', { atOthers: ['张三'] })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.wake, false);
  assert.equal(d.toOther, true);
  assert.ok(d.probability < 0.09);
});
ok('引用别人的话 → 不唤醒', () => {
  const d = decideWake({
    kind: 'group',
    entries: [E('火锅', { reply: { senderId: '20002', sender: '张三', self: false } })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.wake, false);
  assert.equal(d.toOther, true);
});
ok('★ @别人 但提到它的名字 → 不唤醒（这是本次要修的核心）', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@张三 你看小鱼多能说', { atOthers: ['张三'] })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.wake, false, '不该被"提到名字"叫起来');
  assert.equal(d.toOther, true);
});
ok('★ 引用别人的话但提到它的名字 → 不唤醒', () => {
  const d = decideWake({
    kind: 'group',
    entries: [E('小鱼昨天也是这么说的', { reply: { senderId: '20002', sender: '张三', self: false } })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.wake, false);
});
ok('被@了 → 照样唤醒（不许误伤）', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@我 在吗', { atSelf: true })],
    cfg: CFG, aliases: ['小鱼'], rng: NO, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'at');
});
ok('引用我的话 → 照样唤醒（以前是死代码，现在活了）', () => {
  const d = decideWake({
    kind: 'group',
    entries: [E('真的吗', { reply: { senderId: '10000', sender: '小鱼', self: true } })],
    cfg: CFG, aliases: ['小鱼'], rng: NO, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'reply-self');
});
ok('叫名字 → 照样唤醒', () => {
  const d = decideWake({
    kind: 'group', entries: [E('小鱼 在吗')], cfg: CFG, aliases: ['小鱼'], rng: NO, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'named');
});
ok('@全体成员 → 照样唤醒', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@全体成员 开会', { atOthers: ['all'] })],
    cfg: CFG, aliases: ['小鱼'], rng: NO, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'at-all');
});
ok('私聊一律唤醒（私聊里没有"对别人说"）', () => {
  const d = decideWake({
    kind: 'private', entries: [E('@张三 吃啥', { atOthers: ['张三'] })],
    cfg: CFG, aliases: ['小鱼'], rng: NO, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'private');
});

console.log('\n[8] 闸门：群友对谈时少接');
ok('AB 交替 → 概率被压到 0.9×0.35', () => {
  const d = decideWake({
    kind: 'group', entries: [E('你昨天去哪了'), E('在家', { senderId: '20002' })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.wake, false);
  assert.equal(d.sideTalk, true);
  assert.equal(d.toOther, false);
});
ok('同一个人的连发不受影响', () => {
  const d = decideWake({
    kind: 'group', entries: [E('我跟你说啊'), E('真的离谱')],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.sideTalk, false);
  assert.equal(d.wake, true);
});

console.log('\n[9] ★ 连续对话：换人聊了就别接');
const TALK = { active: true, closing: false, partnerId: '20001' };
ok('锚点接着说 → 接住（不变）', () => {
  const d = decideWake({
    kind: 'group', entries: [E('然后呢')], cfg: CFG, aliases: ['小鱼'],
    rng: NO, talk: TALK, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'continuation');
});
ok('★ 锚点转头 @ 别人 → 不接了', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@张三 你来说', { atOthers: ['张三'] })],
    cfg: CFG, aliases: ['小鱼'], rng: NO, talk: TALK, ...SELF
  });
  assert.equal(d.wake, false, '锚点这条是对别人说的');
  assert.notEqual(d.reason, 'continuation');
});
ok('★ 锚点引用别人的话 → 不接了', () => {
  const d = decideWake({
    kind: 'group',
    entries: [E('对对对', { reply: { senderId: '20002', sender: '张三', self: false } })],
    cfg: CFG, aliases: ['小鱼'], rng: NO, talk: TALK, ...SELF
  });
  assert.equal(d.wake, false);
});

console.log('\n[10] 开关与退化');
ok('addressee.enabled=false → 退回旧行为（@别人 也会叫醒）', () => {
  const cfg = { gate: { enabled: true, probability: 0.9, addressee: { enabled: false } } };
  const d = decideWake({
    kind: 'group', entries: [E('@张三 吃啥', { atOthers: ['张三'] })],
    cfg, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.toOther, false);
  assert.equal(d.sideTalk, false);
});
ok('没有结构化字段的老数据 → 靠文本兜底也能认出 @别人', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@张三 晚上吃啥')],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, selfId: '', selfNickname: ''
  });
  assert.equal(d.wake, false);
  assert.equal(d.toOther, true);
});
ok('toOtherFactor=0 → 彻底不接', () => {
  const cfg = { gate: { enabled: true, probability: 1, addressee: { enabled: true, toOtherFactor: 0, sideTalkFactor: 1 } } };
  const d = decideWake({
    kind: 'group', entries: [E('@张三 吃啥', { atOthers: ['张三'] })],
    cfg, aliases: ['小鱼'], rng: () => 0, ...SELF
  });
  assert.equal(d.wake, false);
  assert.equal(d.probability, 0);
});

console.log('\n[11] 省钱预判层也看得到寻址标注');
ok('formatGateLines 给对别人说的那条打标注', () => {
  const lines = formatGateLines(
    [E('在吗'), E('@张三 晚上吃啥', { atOthers: ['张三'] })],
    { aliases: ['小鱼'], selfId: '10000', selfNickname: '小鱼' }
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('（对张三说）'), lines[1]);
  assert.ok(!lines[0].includes('（对'), lines[0]);
});
ok('buildGateMessages 讲了这条规则', () => {
  const msgs = buildGateMessages({ botName: '小鱼', entries: [E('在吗')], aliases: ['小鱼'] });
  assert.ok(msgs[0].content.includes('（对某某说）'));
});

// ── 端到端：入站写的字段 → 落盘 → 闸门读得到 ──────────────────────────
console.log('\n[12] 端到端：入库 → 落盘 → 闸门');
const { ChatStore } = await import('../src/store.js');
const K = 'group:10001';
const store = new ChatStore();

// 模拟入站侧写入的三件套（和 app.js::ingestMessage 里那段一一对应）
store.appendIncoming(K, {
  mid: 111, ts: Date.now(), senderId: '20001', senderName: '小明',
  text: '@张三 晚上吃啥', atSelf: false, atOthers: ['张三'], reply: null
});
store.appendIncoming(K, {
  mid: 112, ts: Date.now(), senderId: '20001', senderName: '小明',
  text: '@我 在吗', atSelf: true, atOthers: null, reply: null
});
store.appendIncoming(K, {
  mid: 113, ts: Date.now(), senderId: '20002', senderName: '张三',
  text: '火锅', atSelf: false, atOthers: null,
  reply: { senderId: '20001', sender: '小明', text: '晚上吃啥', self: false }
});

ok('三个字段都落盘了（读回来还在）', () => {
  const rows = store.recent(K, { limit: 10 }).filter((m) => !m.self);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].atSelf, false);
  assert.deepEqual(rows[0].atOthers, ['张三']);
  assert.equal(rows[1].atSelf, true);
  assert.equal(rows[2].reply.self, false);
  assert.equal(rows[2].reply.sender, '小明');
});
ok('闸门读存档就能分出"对别人说"和"叫我"', () => {
  const rows = store.recent(K, { limit: 10 }).filter((m) => !m.self && !m.read);
  const tg = targetsOf(rows, OPTS);
  assert.deepEqual(tg, [TARGET.OTHER, TARGET.SELF, TARGET.OTHER]);
});
ok('★ 只有"@别人 + 提到它名字"那一批 → 闸门不唤醒', () => {
  const d = decideWake({
    kind: 'group',
    entries: [E('@张三 你看小鱼多能说', { atOthers: ['张三'] })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.equal(d.wake, false);
});
ok('旧存档（没有这三个字段）读回来不炸，退化到文本兜底', () => {
  store.appendIncoming(K, { mid: 114, ts: Date.now(), senderId: '20001', senderName: '小明', text: '@张三 走了' });
  const rows = store.recent(K, { limit: 10 }).filter((m) => !m.self);
  const last = rows[rows.length - 1];
  assert.equal(last.atSelf, false);
  assert.deepEqual(last.atOthers, []);
  assert.equal(targetOf(last, OPTS), TARGET.OTHER);   // 靠文本里的 @张三 认出来
});

// ── 2026-10-27：文本里的 "@我" 只是渲染出来的字符，有结构化字段时不能当真 ──────
// 下面这些字符串全部来自 data/messages 的真实存档（详见 addressee.js 里 hasStructured 注释）。
console.log('\n[13] ★ 有结构化字段时，文本里的 "@我" 不作数');
const S = (text, extra = {}) => ({ text, senderId: '20001', senderName: '小明', atSelf: false, atOthers: null, ...extra });

ok('@ 的昵称以"我"开头 → 不是叫我（实测 10 条）', () => {
  const info = addresseeOf(S('@我要看看多少盘盘能挡子弹 盘盘急麻了', { atOthers: ['我要看看多少盘盘能挡子弹'] }), OPTS);
  assert.equal(info.target, TARGET.OTHER);
  assert.equal(info.atSelf, false);
});
ok('在转述别人 @ 它 → 不是叫我（实测 9 条）', () => {
  assert.equal(targetOf(S('荷叶你@我干嘛'), OPTS), TARGET.NONE);
  assert.equal(targetOf(S('再@我就当你想我了'), OPTS), TARGET.NONE);
  assert.equal(targetOf(S('阿晨你光@我不说话，是卡壳了还是想让我猜'), OPTS), TARGET.NONE);
});
ok('真 @ 它（独立标记）照样认得出', () => {
  assert.equal(targetOf(S('@我 在吗'), OPTS), TARGET.SELF);
  assert.equal(targetOf(S('图里有几只奶龙@我'), OPTS), TARGET.SELF);
});
ok('★ selfId 拿不到时不会哑巴（结构化为假，但 @我 是独立标记）', () => {
  const info = addresseeOf(S('@我 快看这个'), { aliases: ['小鱼'], selfIds: [] });
  assert.equal(info.atSelf, true);
  assert.equal(info.target, TARGET.SELF);
});
ok('老数据（连字段都没有）保持原行为：宽松匹配', () => {
  assert.equal(targetOf({ text: '@我 在吗', senderId: '20001' }, OPTS), TARGET.SELF);
});
ok('闸门：昵称撞车不再走"明确触发 @我"那条路', () => {
  const d = decideWake({
    kind: 'group',
    entries: [S('@我要看看多少盘盘能挡子弹 盘盘急麻了', { atOthers: ['我要看看多少盘盘能挡子弹'] })],
    cfg: CFG, aliases: ['小鱼'], rng: () => 0.5, ...SELF
  });
  assert.notEqual(d.reason, 'at');
  assert.equal(d.wake, false);
});

console.log('\n[14] ★ 演练模式不再让预判层整层失效');
const CHEAP = { ...CFG, gate: { ...CFG.gate, cheapWakeGate: { enabled: true } } };
ok('dryRun + 本来会跳过 → 仍要预判（以前 reason 不是 probability，整层不跑）', () => {
  const cfg = { gate: { ...CFG.gate, dryRun: true, cheapWakeGate: { enabled: true } } };
  const d = decideWake({ kind: 'group', entries: [E('今天天气不错')], cfg, rng: NO, ...SELF });
  assert.equal(d.reason, 'dry-run');
  assert.equal(d.wouldSkip, true);
  assert.equal(shouldGate({ decision: d, kind: 'group', cfg }), true);
});
ok('dryRun + 本来就会唤醒 → 不白花一次预判', () => {
  const cfg = { gate: { ...CFG.gate, dryRun: true, probability: 1, cheapWakeGate: { enabled: true } } };
  const d = decideWake({ kind: 'group', entries: [E('今天天气不错')], cfg, rng: () => 0, ...SELF });
  assert.equal(d.wouldSkip, false);
  assert.equal(shouldGate({ decision: d, kind: 'group', cfg }), false);
});
ok('明确触发（@我）永不预判', () => {
  const d = decideWake({
    kind: 'group', entries: [E('@我 在吗', { atSelf: true })],
    cfg: CHEAP, aliases: ['小鱼'], rng: NO, ...SELF
  });
  assert.equal(d.wake, true);
  assert.equal(shouldGate({ decision: d, kind: 'group', cfg: CHEAP }), false);
});
ok('预判开关关着 → 一律不预判', () => {
  const cfg = { gate: { ...CFG.gate, dryRun: true, cheapWakeGate: { enabled: false } } };
  const d = decideWake({ kind: 'group', entries: [E('今天天气不错')], cfg, rng: NO, ...SELF });
  assert.equal(shouldGate({ decision: d, kind: 'group', cfg }), false);
});

console.log('\n[15] ★ 2026-10-31：「聊到它」不等于「在叫它」（m00001）');
ok('looksLikeCallingName：呼格 vs 提到', () => {
  const o = { aliases: ['小鱼', 'AI 酱'], selfNickname: '小鱼' };
  // 叫它
  assert.equal(looksLikeCallingName('小鱼', o), true, '单独一条名字');
  assert.equal(looksLikeCallingName('小鱼，这个怎么弄', o), true);
  assert.equal(looksLikeCallingName('小鲸鱼在吗', { aliases: ['小鲸鱼'] }), true);
  assert.equal(looksLikeCallingName('叫一下小鱼', o), true, '叫/喊/找 之后的名字');
  assert.equal(looksLikeCallingName('@小鱼 在吗', o), true, '@ 之后（@ 边界也算）');
  // 只是提到
  assert.equal(looksLikeCallingName('小鲸鱼今天怎么没来', { aliases: ['小鲸鱼'] }), false);
  assert.equal(looksLikeCallingName('我觉得小鲸鱼有点吵', { aliases: ['小鲸鱼'] }), false);
  assert.equal(looksLikeCallingName('听说小鲸鱼会写诗', { aliases: ['小鲸鱼'] }), false);
  assert.equal(looksLikeCallingName('小鱼真好看', o), false);
  assert.equal(looksLikeCallingName('小鱼什么都会', o), false);
  assert.equal(looksLikeCallingName('', o), false);
});
ok('★ 裸提到名字 → target=none，但 mentionSelf=true（供提示词标"聊到我"）', () => {
  for (const text of ['小鲸鱼今天怎么没来', '我觉得小鲸鱼有点吵', '听说小鲸鱼会写诗']) {
    const info = addresseeOf(E(text), { aliases: ['小鲸鱼'], selfIds: ['10000'], selfNickname: '小鲸鱼' });
    assert.equal(info.target, TARGET.NONE, text);
    assert.equal(info.mentionSelf, true, text);
    assert.equal(info.callSelf, false, text);
    assert.equal(describeTarget(info), '聊到我', text);
  }
});
ok('★ 裸提到名字不再叫醒它（以前 reason=named 满血唤醒）', () => {
  const d = decideWake({
    kind: 'group', entries: [E('小鲸鱼今天怎么没来')],
    cfg: CFG, aliases: ['小鲸鱼'], rng: NO, selfId: '10000', selfNickname: '小鲸鱼'
  });
  assert.notEqual(d.reason, 'named');
  assert.equal(d.wake, false, '闲聊里提到名字不该唤醒');
});
ok('★ 真叫它（呼格）仍然叫醒 —— 不许误伤', () => {
  for (const text of ['小鲸鱼', '小鲸鱼在吗', '小鲸鱼，这个怎么弄']) {
    const d = decideWake({
      kind: 'group', entries: [E(text)],
      cfg: CFG, aliases: ['小鲸鱼'], rng: NO, selfId: '10000', selfNickname: '小鲸鱼'
    });
    assert.equal(d.reason, 'named', text);
    assert.equal(d.wake, true, text);
  }
});
ok('★ primarySpeaker：没人叫它时 addressed=false', () => {
  const es = [E('今天好无聊'), E('是啊', { senderId: '20002', senderName: '小红' })];
  const sp = primarySpeaker(es, { kind: 'group', chatId: '123', aliases: ['小鱼'], selfIds: ['10000'], selfNickname: '小鱼' });
  assert.equal(sp.id, '20002', '仍然回退到最后一个说话的人');
  assert.equal(sp.addressed, false, '但必须标明"不是叫我"');
});
ok('★ primarySpeaker：有人叫它时 addressed=true', () => {
  const es = [E('今天好无聊'), E('@我 你说呢', { atSelf: true, senderId: '20003', senderName: '小刚' })];
  const sp = primarySpeaker(es, { kind: 'group', chatId: '123', aliases: ['小鱼'], selfIds: ['10000'], selfNickname: '小鱼' });
  assert.equal(sp.id, '20003');
  assert.equal(sp.addressed, true);
});
ok('★ primarySpeaker：私聊恒为 addressed=true', () => {
  const sp = primarySpeaker([E('在吗')], { kind: 'private', chatId: '20001', aliases: [], selfIds: ['10000'] });
  assert.equal(sp.addressed, true);
});
// 提示词上下文的最小骨架（buildUserBundle 会问 store/memory/crowd 要东西）
const promptCtx = (entries) => ({
  kind: 'group', chatKey: 'group:123', chatId: '123', chatName: '测试群',
  selfId: '10000', selfNickname: '小鱼', runSeq: 1,
  triggerEntries: entries,
  persona: { botName: '小鱼', masterQQ: '', participation: 'low' },
  crowd: null,
  store: { recent: () => [], activeMembers: () => [] },
  memory: { formatForPrompt: () => '' }
});

ok('★ 提示词：这批没人叫它 → 出【这批没有叫你】，不写"正在跟你说话的是"', () => {
  const b = buildUserBundle(promptCtx([E('今天好无聊'), E('是啊', { senderId: '20002', senderName: '小红' })]));
  assert.ok(b.text.includes('这批没有叫你'), b.text.slice(0, 600));
  assert.ok(!b.text.includes('正在跟你说话的是'), '没人叫它时不能这么写');
  // 段名必须已登记（没登记会进 budget.unregistered）
  assert.deepEqual(b.budget?.unregistered || [], [], '不能有未登记段');
});
ok('★ 提示词：有人叫它 → 不出【这批没有叫你】', () => {
  const b = buildUserBundle(promptCtx([E('@我 在吗', { atSelf: true })]));
  assert.ok(b.text.includes('正在跟你说话的是'), b.text.slice(0, 600));
  assert.ok(!b.text.includes('这批没有叫你'));
});
ok('★ 提示词：只是提到名字 → 标「聊到我，没叫我」+ 仍算"没叫你"', () => {
  const b = buildUserBundle(promptCtx([E('小鲸鱼今天怎么没来')]));
  assert.ok(b.text.includes('聊到我，没叫我'), b.text.slice(0, 800));
  assert.ok(b.text.includes('这批没有叫你'));
  assert.ok(b.text.includes('提到了你的名字'), '要点明"提到 ≠ 叫"');
});
ok('★ 省钱预判层：裸提到名字的消息带「聊到我，没叫我」标注', () => {
  const lines = formatGateLines([E('小鲸鱼今天怎么没来')], {
    aliases: ['小鲸鱼'], selfId: '10000', selfNickname: '小鲸鱼'
  });
  assert.ok(lines[0].includes('聊到我，没叫我'), lines[0]);
});

console.log(`\n通过 ${pass} 项`);
try { fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ }
