// 「淡化≠删除」自测（2026-10-29，对照《记忆模型-对外版》判据 3 / 方案 R4）：
//   · forgetWeakFacts 改休眠（dormant），不再物理删除
//   · forgetFact 显式遗忘打墓碑（tombstone），检索永不复活
//   · 休眠/墓碑不参与"重复提及=强化"，反思链重读归档也不会唤醒旧条
//   · 衰减与容量裁剪不碰终态条目；唤醒只走真实重提路径
//
// 这组要钉住的都是"删了像没删"的错：
//   ① 物理删除后反思链重新提取同一句话 → 删了也白删；
//   ② 休眠条被再次提取 → 原地唤醒 → 显式遗忘只管一轮；
//   ③ factCount 把忘掉的还数进去 → 面板说谎。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-forget-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const F = await import('../src/memory-facts.js');
const G = await import('../src/group-facts.js');
const {
  rememberFact, listFacts, resetFactsCache, factCount, factCountTotal, listAllFactsRaw,
  decayFacts, forgetWeakFacts, forgetFact, dormantRevive, MAX_FACTS_PER_USER
} = F;
const { rememberGroupFact, listGroupFacts, forgetWeakGroupFacts, forgetGroupFact, resetGroupCache, groupFactCount } = G;

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name, '\n    ', error?.message ?? error);
    process.exitCode = 1;
  }
};

const QQ = '10001';
const fresh = () => { resetFactsCache(); resetGroupCache(); };

console.log('\n[forget] 自然淡出 = 休眠，不是删除');

fresh();
ok('① 低于注入线 → dormant=true，记录本体保留', () => {
  rememberFact(QQ, '测试一爱聊天气', { weight: 0.2 });
  const r = forgetWeakFacts({ minWeight: 0.3, qq: QQ, now: Date.now() });
  assert.equal(r.dormant, 1);
  assert.equal(r.removed, 0);
  const raw = listAllFactsRaw(QQ);
  assert.equal(raw.length, 1, '物理删除了（不该发生）');
  assert.equal(raw[0].dormant, true);
  assert.ok(raw[0].dormantAt > 0);
  assert.ok(raw[0].dormantReason.length > 0);
});

ok('② 休眠条不再进召回（listFacts 看不到，factCount 不数它）', () => {
  assert.equal(listFacts(QQ, { limit: 8 }).length, 0);
  assert.equal(factCount(QQ), 0);
  assert.equal(factCountTotal(QQ), 1, '总量口径丢了记录');
});

ok('③ 衰减不碰休眠条（冻结在淡出那一刻）', () => {
  const before = listAllFactsRaw(QQ)[0].weight;
  decayFacts({ ratePerDay: 0.5, now: Date.now() });
  assert.equal(listAllFactsRaw(QQ)[0].weight, before);
});

ok('④ 雷点/规矩永不淡出（原有纪律保留）', () => {
  rememberFact(QQ, '测试一对花生过敏', { kind: 'negative', weight: 0.2 });
  rememberFact(QQ, '别叫测试一全名', { kind: 'rule', weight: 0.2 });
  const r = forgetWeakFacts({ minWeight: 0.3, qq: QQ, now: Date.now() });
  assert.equal(r.dormant, 0);
  const kinds = listAllFactsRaw(QQ).filter((f) => !f.dormant).map((f) => f.kind);
  assert.deepEqual(kinds.sort(), ['negative', 'rule']);
});

console.log('\n[forget] 显式遗忘 = 墓碑');

ok('⑤ forgetFact 打墓碑：时间、原因、退出召回', () => {
  rememberFact(QQ, '测试一住在杭州', { weight: 1.5 });
  const r = forgetFact(QQ, '杭州', { now: Date.now() });
  assert.equal(r.count, 1);
  const raw = listAllFactsRaw(QQ).find((f) => f.text.includes('杭州'));
  assert.equal(raw.tombstone, true);
  assert.ok(raw.tombstoneAt > 0);
  assert.equal(listFacts(QQ, { limit: 8 }).some((f) => f.text.includes('杭州')), false, '墓碑还能被召回');
});

ok('⑥ 墓碑不看 kind：主人要求忘雷点也照忘', () => {
  const r = forgetFact(QQ, '花生', { now: Date.now() });
  assert.equal(r.count, 1);
  assert.equal(listAllFactsRaw(QQ).find((f) => f.text.includes('花生')).tombstone, true);
});

ok('⑦ 重复提及不唤醒墓碑（反思链重读归档防复活）', () => {
  const before = listAllFactsRaw(QQ).find((f) => f.text.includes('杭州'));
  const res = rememberFact(QQ, '测试一住在杭州', { weight: 1.8, now: Date.now() });
  assert.equal(res.reawakened, true, '应该走"新增 candidate"而不是强化旧条');
  const after = listAllFactsRaw(QQ).find((f) => f.text.includes('杭州') && f.tombstone);
  assert.equal(after.weight, before.weight, '墓碑条被强化了');
  assert.equal(listFacts(QQ, { limit: 8 }).some((f) => f.text.includes('杭州')), false, '复活条直接进了召回');
});

ok('⑧ 休眠条被重提也不原地唤醒（新增 candidate，status=candidate）', () => {
  rememberFact(QQ, '测试一爱聊天气', { weight: 1.0, now: Date.now() });
  const raws = listAllFactsRaw(QQ).filter((f) => f.text.includes('爱聊天气'));
  assert.equal(raws.length, 2);
  assert.equal(raws.find((f) => f.dormant).dormant, true, '旧休眠条被动了');
  assert.equal(listFacts(QQ, { limit: 8 }).some((f) => f.text.includes('爱聊天气')), false,
    'candidate 不该直接进召回');
});

ok('⑨ dormantRevive 只认休眠条（墓碑/不存在返回 null）', () => {
  const dormantOne = listAllFactsRaw(QQ).find((f) => f.dormant);
  const revived = dormantRevive(QQ, dormantOne.id, { now: Date.now() });
  assert.ok(revived);
  assert.equal(listAllFactsRaw(QQ).find((f) => f.id === dormantOne.id).dormant, false);
  const tombOne = listAllFactsRaw(QQ).find((f) => f.tombstone);
  assert.equal(dormantRevive(QQ, tombOne.id, { now: Date.now() }), null);
  assert.equal(dormantRevive(QQ, '不存在', { now: Date.now() }), null);
});

ok('⑩ 容量裁剪不丢休眠/墓碑条', () => {
  fresh();
  for (let i = 0; i < MAX_FACTS_PER_USER + 3; i++) {
    rememberFact(QQ, `测试一填充条目第 ${i} 号`, { weight: 1 });
  }
  // 打两个终态
  forgetFact(QQ, '填充条目第 1 号', { now: Date.now() });
  rememberFact(QQ, '测试一会被挤的弱条', { weight: 0.1 });
  forgetWeakFacts({ minWeight: 0.3, qq: QQ, now: Date.now() });
  const raw = listAllFactsRaw(QQ);
  assert.ok(raw.some((f) => f.tombstone), '墓碑条被容量裁剪删了');
  assert.ok(raw.some((f) => f.dormant), '休眠条被容量裁剪删了');
  // 活跃数不超上限
  assert.ok(factCount(QQ) <= MAX_FACTS_PER_USER);
});

console.log('\n[forget] 群记忆同款纪律');

const CHAT = 'group:888';
ok('⑪ forgetWeakGroupFacts = 休眠；群规豁免；forgetGroupFact 打墓碑', () => {
  fresh();
  rememberGroupFact(CHAT, '这个群周五固定开黑', { kind: 'plan', weight: 0.2 });
  rememberGroupFact(CHAT, '这个群不许发广告', { kind: 'rule', weight: 0.2 });
  const r = forgetWeakGroupFacts({ minWeight: 0.3, chatKey: CHAT, now: Date.now() });
  assert.equal(r.dormant, 1);
  assert.equal(groupFactCount(CHAT), 1, '群规也被休眠了');
  const g = forgetGroupFact(CHAT, '发广告', { now: Date.now() });
  assert.equal(g.count, 1);
  assert.equal(listGroupFacts(CHAT, { limit: 6 }).some((f) => f.text.includes('广告')), false, '墓碑群规还能召回');
});

// 注：提取提示词的玩笑/弱句禁令（对照文档 P0-2）属于实施顺序第 2 步，单独一组测试。

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
