// 拟人对话内核 v2 的自检（秒级、不碰网络、不等真实时间）。
// 跑：node test/test-talk-core.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DATA_DIR } from '../src/config.js';

const {
  startTalk, extendTalk, endTalk, talkOf, talkWindowOf, noteTalkReply,
  notePartnerText, stickerEndsTalk, TALK_MAX_TURNS, DEFAULT_WINDOW_MS, resetTalkState, flushTalkState
} = await import('../src/talk-session.js');
const { TIER_OF_KIND, contextLimitsOf, tierOfKind } = await import('../src/tier.js');
const { firstSendDelayMs, sendGapMs, REPLY_TARGET_MS } = await import('../src/rhythm.js');
const facts = await import('../src/memory-facts.js');
const { auditPersona, formatAuditReport, BUILTIN_DIMENSIONS } = await import('../src/persona-audit.js');
const { PERSONAS } = await import('../src/personas.js');
const { decideWake } = await import('../src/reply-gate.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e?.message || e); process.exitCode = 1; }
}

console.log('\n[1] 连续对话状态机');
resetTalkState();
const K = 'group:10001';
ok('没有对话时返回 null', () => assert.equal(talkOf(K), null));
ok('开始新对话 turns=1', () => {
  const t = startTalk(K, { userId: '20001', name: '小明', now: 1000 });
  assert.equal(t.turns, 1);
  assert.equal(t.partnerId, '20001');
});
ok('续聊 +1 轮', () => {
  const t = extendTalk(K, { now: 2000 });
  assert.equal(t.turns, 2);
});
ok('窗口内 active、刚过期就不 active', () => {
  assert.equal(talkWindowOf(K, { now: 3000, windowMs: DEFAULT_WINDOW_MS }).active, true);
  assert.equal(talkWindowOf(K, { now: 2000 + DEFAULT_WINDOW_MS + 1, windowMs: DEFAULT_WINDOW_MS }).active, false);
});
ok('第 12 轮前一轮提示软收尾', () => {
  for (let i = 0; i < TALK_MAX_TURNS - 3; i += 1) extendTalk(K, { now: 3000 + i });
  const w = talkWindowOf(K, { now: 4000, windowMs: DEFAULT_WINDOW_MS });
  assert.equal(w.turns, TALK_MAX_TURNS - 1);
  assert.equal(w.closing, true);
});
ok('closing 传 true → 结束', () => {
  noteTalkReply(K, { kind: 'continuation', sent: true, closing: true });
  assert.equal(talkOf(K), null);
});
ok('第三人插话只刷新窗口、不换锚点', () => {
  resetTalkState();
  startTalk(K, { userId: 'B', name: 'B', now: 1000 });
  noteTalkReply(K, { kind: 'named', userId: 'C', name: 'C', sent: true, fromPartner: false, hadTalk: true, now: 2000 });
  const t = talkOf(K);
  assert.equal(t.partnerId, 'B');
  assert.equal(t.turns, 1);
  assert.equal(t.lastBotAt, 2000);
});
ok('对新的人说话且没锚点 → 换锚点', () => {
  resetTalkState();
  noteTalkReply(K, { kind: 'named', userId: 'D', name: 'D', sent: true, fromPartner: false, hadTalk: false });
  assert.equal(talkOf(K).partnerId, 'D');
});
ok('一个字都没发出去 → 结束', () => {
  noteTalkReply(K, { kind: 'continuation', sent: false, fromPartner: true, hadTalk: true });
  assert.equal(talkOf(K), null);
});
ok('表情宽限：文字后 2.5 秒内不算收尾', () => {
  resetTalkState();
  startTalk(K, { userId: 'E', now: 1000 });
  notePartnerText(K, 5000);
  const t = talkOf(K);
  assert.equal(stickerEndsTalk(t, { now: 6000 }), false);
  assert.equal(stickerEndsTalk(t, { now: 5000 + 2600 }), true);
  assert.equal(stickerEndsTalk(t, { now: 5000, tolerant: false }), true);
});
ok('状态落盘后能读回', () => {
  flushTalkState();
  const file = path.join(DATA_DIR, 'talk-state.json');
  assert.ok(fs.existsSync(file), 'state 文件应存在');
  resetTalkState();
});
endTalk(K);

console.log('\n[2] 档位 → 上下文预算');
ok('映射表完整', () => {
  for (const k of ['private', 'named', 'keyword', 'continuation', 'interject']) assert.ok(TIER_OF_KIND[k]);
  assert.equal(tierOfKind('continuation'), 'direct');
  assert.equal(tierOfKind('nope'), undefined);
});
ok('direct 一个字都不改', () => {
  const base = { limit: 24, maxChars: 2400 };
  assert.deepEqual(contextLimitsOf('direct', base), base);
});
ok('插话档只压不放宽（用户调小后不被放大）', () => {
  const base = { limit: 24, maxChars: 2400 };
  const shrunk = contextLimitsOf('interject', base);
  assert.ok(shrunk.limit < base.limit && shrunk.maxChars < base.maxChars);
  const small = contextLimitsOf('interject', { limit: 4, maxChars: 800 });
  assert.ok(small.limit <= 4 && small.maxChars <= 800);
});

console.log('\n[3] 发言节奏');
ok('模型已经超时 → 不再等', () => {
  assert.equal(firstSendDelayMs('direct', 999999, () => 0), 0);
});
ok('首条落在目标区间内（含已耗时）', () => {
  const spent = 600;
  const d = firstSendDelayMs('direct', spent, () => 0);
  assert.equal(d + spent, REPLY_TARGET_MS.direct.min);
});
ok('接话比首次触发更快', () => {
  assert.ok(firstSendDelayMs('continuation', 0, () => 0.5) < firstSendDelayMs('direct', 0, () => 0.5));
});
ok('条间间隔有下限、按字数增加', () => {
  const a = sendGapMs('嗯', { minGapMs: 1000, pace: { minMs: 1000, maxMs: 1000, perCharMs: 20 } }, () => 0);
  const b = sendGapMs('嗯嗯嗯嗯嗯', { minGapMs: 1000, pace: { minMs: 1000, maxMs: 1000, perCharMs: 20 } }, () => 0);
  assert.ok(a >= 1000);
  assert.ok(b > a);
});
ok('pace.enabled=false 回落旧行为', () => {
  const g = sendGapMs('随便', { minGapMs: 500, maxGapMs: 500, pace: { enabled: false } }, () => 0);
  assert.equal(g, 500);
});

console.log('\n[4] 长期事实');
const TEST_QQ = '999999999999';
const factFile = path.join(DATA_DIR, 'memory', 'facts', `${TEST_QQ}.json`);
try { fs.rmSync(factFile, { force: true }); } catch { /* 首次 */ }
facts.resetFactsCache();
ok('记一条 + 读回来', () => {
  const r = facts.rememberFact(TEST_QQ, '小明住在杭州', { now: 1000 });
  assert.equal(r.ok, true);
  assert.equal(facts.listFacts(TEST_QQ).length, 1);
});
ok('重复事实 = 强化而不是再存一条', () => {
  const r = facts.rememberFact(TEST_QQ, '小明住在杭州', { now: 2000 });
  assert.equal(r.duplicate, true);
  assert.equal(facts.listFacts(TEST_QQ).length, 1);
  assert.ok(r.record.weight > 1);
});
ok('凭据拒写', () => {
  const r = facts.rememberFact(TEST_QQ, `apiKey=${'sk-' + 'x'.repeat(24)}`);
  assert.equal(r.ok, false);
});
ok('提示词分段带"不是别人的"', () => {
  const text = facts.formatFactsForPrompt(TEST_QQ);
  assert.ok(text.includes('不是别人的'));
  assert.ok(text.includes('小明住在杭州'));
});
ok('衰减 → 低权重转休眠（2026-10-29 起，不再物理删除）', () => {
  facts.rememberFact(TEST_QQ, '小明最近在玩什么游戏不重要', { kind: 'fact', now: 0, weight: 0.5 });
  facts.decayFacts({ ratePerDay: 1, now: 30 * 86400000 });
  const { dormant } = facts.forgetWeakFacts({ minWeight: 0.3, qq: TEST_QQ });
  assert.ok(dormant >= 1);
});
ok('解析带围栏的 JSON，并自动补主语', () => {
  const out = facts.parseExtraction('```json\n{"facts":["对花生过敏","明天要考试"]}\n```', { name: '小明' });
  assert.deepEqual(out, ['小明对花生过敏', '小明明天要考试']);
});
ok('解析失败 → 空数组（不编造）', () => {
  assert.deepEqual(facts.parseExtraction('我觉得他挺有意思的', { name: '小明' }), []);
});
try { fs.rmSync(factFile, { force: true }); } catch { /* 忽略 */ }

console.log('\n[5] 人设十维体检');
ok('内置十维齐了', () => assert.equal(BUILTIN_DIMENSIONS.length, 10));
ok('默认小鲸鱼能打分且覆盖不低', () => {
  const a = auditPersona({ roleText: PERSONAS.xiaojingyu.text, botName: '小鲸鱼' });
  assert.ok(a.cell > 0.4, `cell=${a.cell}`);
  assert.ok(a.coverage >= 0.6, `coverage=${a.coverage}`);
  assert.ok(a.dims.length === 10);
  assert.ok(a.dims.every((d) => d.score >= 0 && d.score <= 1));
});
ok('空白模板分数低、缺口带问题', () => {
  const a = auditPersona({ roleText: PERSONAS.blank.text, botName: '机器人' });
  assert.ok(a.cell < 0.9);
  assert.ok(a.gaps.length > 0);
  assert.ok(a.gaps.every((g) => typeof g.question === 'string' && g.question.length > 0));
});
ok('报告能渲染', () => {
  const text = formatAuditReport(auditPersona({ roleText: PERSONAS.xiaojingyu.text }), { name: '小鲸鱼' });
  assert.ok(text.includes('十维体检'));
  assert.ok(text.includes('总评'));
});

console.log('\n[6] 闸门：接话窗口 / 档位');
const G = { gate: { enabled: true, probability: 0, keywords: [], activeWindowMs: 0, coldGapMs: 0 } };
const never = () => 0.99;
ok('锚点在窗口内继续说 → 必接，kind=continuation', () => {
  const d = decideWake({
    kind: 'group', entries: [{ text: '然后呢', senderId: 'B' }], cfg: G, rng: never,
    talk: { active: true, partnerId: 'B', turns: 2, closing: false }
  });
  assert.equal(d.wake, true);
  assert.equal(d.kind, 'continuation');
  assert.equal(d.tier, 'direct');
});
ok('陌生人说话不能替锚点续命', () => {
  const d = decideWake({
    kind: 'group', entries: [{ text: '哈哈哈', senderId: 'C' }], cfg: G, rng: never,
    talk: { active: true, partnerId: 'B', turns: 2, closing: false }
  });
  assert.equal(d.wake, false);
});
ok('软收尾后不再自动接', () => {
  const d = decideWake({
    kind: 'group', entries: [{ text: '然后呢', senderId: 'B' }], cfg: G, rng: never,
    talk: { active: true, partnerId: 'B', turns: 11, closing: true }
  });
  assert.equal(d.wake, false);
});
ok('关键词给 keyword 档', () => {
  const d = decideWake({ kind: 'group', entries: [{ text: '这里有必回' }], cfg: { gate: { ...G.gate, keywords: ['必回'] } }, rng: never });
  assert.equal(d.kind, 'keyword');
  assert.equal(d.tier, 'keyword');
});

console.log(`\n全部通过：${pass} 项`);
