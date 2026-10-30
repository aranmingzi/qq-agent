// 内心独白拦截自检（纯逻辑、不碰网络、不读写 data/）。
// 跑：node test/test-monologue.mjs
//
// 守护的是 2026-10-24 的实机泄漏：私聊里模型先用 send_message 说完两句，
// 又吐了一句「（已经发完，结束。）」，被兜底路径原样发给了主人。
import assert from 'node:assert/strict';

const { looksLikeMonologue, looksSpokenToUser, looksLikeInternalNote, looksLikeFakeAbsence } = await import('../src/monologue-guard.js');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n    ', e?.message || e); process.exitCode = 1; }
}

console.log('\n[1] 事故原文必须被判为独白');
ok('「（已经发完，结束。）」→ 独白', () => assert.equal(looksLikeMonologue('（已经发完，结束。）').think, true));
ok('同一句 → 不算在对人说话', () => assert.equal(looksSpokenToUser('（已经发完，结束。）'), false));
ok('同一句 → 出站窄闸门拦下', () => assert.equal(looksLikeInternalNote('（已经发完，结束。）'), true));
ok('半角括号同款', () => assert.equal(looksLikeInternalNote('(已发完，结束)'), true));
ok('不带括号的收尾自言自语', () => assert.equal(looksLikeInternalNote('好了，已经发完，结束。'), true));

console.log('\n[2] 本轮已发过话 → content 一律不兜底');
ok('已发过话时任意文本都算独白', () => {
  assert.equal(looksLikeMonologue('（已经发完，结束。）', { hasSendMessage: true }).think, true);
  assert.equal(looksLikeMonologue('随便一句什么', { hasSendMessage: true }).think, true);
});

console.log('\n[3] 正常聊天不能被误伤');
for (const s of ['诶 出现了', '哪去了这两天', '嘿嘿 现在知道我的好了吧', '在的', '？']) {
  ok(`「${s}」不算独白`, () => assert.equal(looksLikeMonologue(s).think, false));
  ok(`「${s}」不被出站闸门拦`, () => assert.equal(looksLikeInternalNote(s), false));
}
ok('括号在句中（真话）不算旁白', () => {
  assert.equal(looksLikeMonologue('明天（周四）行不行').think, false);
  assert.equal(looksLikeInternalNote('明天（周四）行不行'), false);
});
ok('「（笑）」这种语气不被出站闸门吞掉', () => assert.equal(looksLikeInternalNote('（笑）'), false));

console.log('\n[4] 「假装没听见」的补偿话术（2026-10-25 私聊「走神」事故）');
// 经过：上一轮已正常回过 3 条，主人说「明天开始哦」，这一轮 2 条整批撞限流没送出去，
// 模型第二轮补了这句。它不是正文，是失败补偿 —— 拦住让重说才对。
ok('事故原句 → 判为补偿话术', () => assert.equal(looksLikeFakeAbsence('在的在的，刚刚走神了，主人你说啥？'), true));
ok('事故原句 → 判为独白（兜底路径也不会发）', () => assert.equal(looksLikeMonologue('在的在的，刚刚走神了，主人你说啥？').think, true));
ok('「没听清，你再说一遍」同款', () => assert.equal(looksLikeFakeAbsence('刚没听清，你再说一遍'), true));
ok('「我走神了一下 你说什么」同款', () => assert.equal(looksLikeFakeAbsence('我走神了一下 你说什么'), true));
// 2026-10-20 23:42 的同类实例（更早一次，同一个病）：也是"我缺席了 + 咋了"
ok('「啊刚才走神了没看见，咋了？」同款（10-20 实例）', () => assert.equal(looksLikeFakeAbsence('啊刚才走神了没看见，咋了？'), true));
ok('只说走神、没装没听见 → 放行（「我刚走神想你去了」）', () => assert.equal(looksLikeFakeAbsence('我刚走神想你去了'), false));
ok('只说你说啥、没提走神 → 放行（「你说啥呢」）', () => assert.equal(looksLikeFakeAbsence('你说啥呢'), false));
ok('长句里带这两个词 → 放行（判据只看 30 字内的短句）', () => {
  assert.equal(looksLikeFakeAbsence('刚才我走神了，脑子里全是你昨天说的那句明天开始，所以你说啥我都想听，慢慢说'), false);
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}\n`);
