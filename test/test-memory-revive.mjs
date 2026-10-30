// P2-2「遗忘后重新激活加权」自测（2026-10-31，学自 MaiMBot-LPMM 的拟人脑遗忘设计）。
//
// 这条借鉴的原文意思是：**忘掉的东西再想起来，会记得更牢**。
// 我们以前只做到"能复活"—— dormantRevive 把休眠位摘掉、权重拉回 0.6，
// 然后这条就跟"第一次听说"一模一样，等于什么都没学到。
//
// 这组要钉住的：
//   ① 复活次数要记下来，并且**读得回来**（2026-10-26 的 source 就是这么丢的）；
//   ② 权重按次数递增，但有软顶 —— 不能让"淡出又想起"涨成核心项去挤 rule/negative 的名额；
//   ③ 打分里复活只占 0.08 的一票：**是平局时的天平，不是翻盘的杠杆**；
//   ④ candidate 分支（休眠条被重提 → 新增 candidate）要把复活史继承过来，
//      否则一转正就把"忘过又想起"洗成"第一次听说"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-revive-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const F = await import('../src/memory-facts.js');
const {
  rememberFact, resetFactsCache, listAllFactsRaw, forgetWeakFacts, dormantRevive,
  reviveBoostOf, rankFactRecords, CORE_WEIGHT, MAX_WEIGHT
} = F;

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

const QQ = '20001';
const OTHER = '20002';
const fresh = () => resetFactsCache();
const dormant = (text, minWeight) => forgetWeakFacts({ minWeight, qq: QQ, now: Date.now() });
const rawOf = (qq, text) => listAllFactsRaw(qq).filter((f) => f.text.includes(text));

console.log('\n[复活加权] 次数与权重');

ok('① 复活记次数：第一次回 0.6，并写 reviveCount / reviveAt', () => {
  fresh();
  rememberFact(QQ, '测试二喜欢爬山', { weight: 0.1, now: Date.now() });
  dormant('爬山', 0.3);
  const one = rawOf(QQ, '爬山').find((f) => f.dormant);
  assert.ok(one, '前置条件：这条得先休眠');

  const r = dormantRevive(QQ, one.id, { now: Date.now() });
  assert.ok(r);
  assert.equal(r.reviveCount, 1);
  assert.ok(Math.abs(r.weight - 0.6) < 1e-9, `第一次复活权重应为 0.6，实际 ${r.weight}`);

  const after = rawOf(QQ, '爬山').find((f) => f.id === one.id);
  assert.equal(after.dormant, false);
  assert.equal(after.reviveCount, 1);
  assert.ok(after.reviveAt > 0, 'reviveAt 得记下来');
});

ok('② 每复活一次 +0.25，软顶 1.1（不给它涨成核心项的机会）', () => {
  const got = [];
  // 从 ② 开始接着 ① 的那条继续：0.6 → 0.85 → 1.1 → 1.1
  for (const minWeight of [0.7, 0.9, 1.15]) {
    dormant('爬山', minWeight);
    const one = rawOf(QQ, '爬山').find((f) => f.dormant);
    assert.ok(one, `minWeight=${minWeight} 时没能让它休眠（权重 ${got[got.length - 1]}）`);
    const r = dormantRevive(QQ, one.id, { now: Date.now() });
    got.push(Number(r.weight.toFixed(2)));
  }
  assert.deepEqual(got, [0.85, 1.1, 1.1], `权重序列不对：${got.join(' → ')}`);
  assert.ok(1.1 < CORE_WEIGHT, '软顶必须低于 CORE_WEIGHT，否则复活会把雷点的名额挤掉');
  assert.ok(1.1 <= MAX_WEIGHT);
});

ok('③ reviveCount 读得回来（重启不丢，这是 source 踩过的坑）', () => {
  const before = rawOf(QQ, '爬山').find((f) => f.reviveCount > 0);
  assert.ok(before, '前置条件：得有条复活过的');
  fresh();                                    // 清缓存 = 模拟重启后重新 load
  const after = rawOf(QQ, '爬山').find((f) => f.id === before.id);
  assert.equal(after.reviveCount, before.reviveCount, '重启后复活次数被清零了');
  assert.equal(after.reviveAt, before.reviveAt, '重启后 reviveAt 被清零了');
});

ok('④ 墓碑条照样不给复活（更强的终态）', () => {
  fresh();
  rememberFact(QQ, '测试二讨厌被叫外号', { weight: 0.1 });
  const F2 = F;
  assert.ok(F2.forgetFact);
  const t = F2.forgetFact(QQ, '讨厌被叫外号', { now: Date.now() });
  assert.ok(t.ok);
  const tomb = rawOf(QQ, '讨厌被叫外号').find((f) => f.tombstone);
  assert.equal(dormantRevive(QQ, tomb.id, { now: Date.now() }), null);
});

console.log('\n[复活加权] 打分里的一票');

ok('⑤ reviveBoostOf 的映射：0/1/2/3 次 → 0 / 0.4 / 0.7 / 1.0，封顶不溢出', () => {
  assert.equal(reviveBoostOf({}), 0);
  assert.equal(reviveBoostOf({ reviveCount: 0 }), 0);
  assert.ok(Math.abs(reviveBoostOf({ reviveCount: 1 }) - 0.4) < 1e-9);
  assert.ok(Math.abs(reviveBoostOf({ reviveCount: 2 }) - 0.7) < 1e-9);
  assert.equal(reviveBoostOf({ reviveCount: 3 }), 1);
  assert.equal(reviveBoostOf({ reviveCount: 99 }), 1, '必须封顶，不能溢出到 1 以上');
  assert.equal(reviveBoostOf(null), 0);
});

ok('⑥ 同分时复活过的排前面（这就是"记得更牢"的实际表现）', () => {
  fresh();
  const now = Date.now();
  const base = { kind: 'fact', weight: 1, createdAt: now, updatedAt: now };
  const plain = { ...base, id: 'plain', text: '小明喜欢甜口粽子' };
  const revived = { ...base, id: 'revived', text: '小明喜欢咸口粽子', reviveCount: 3, reviveAt: now };
  // query 对两条的命中数一样（"小明 喜欢 粽子"各中 3）
  const q = '小明喜欢粽子';
  const forward = rankFactRecords([plain, revived], { query: q, now, limit: 8 }).map((x) => x.id);
  const backward = rankFactRecords([revived, plain], { query: q, now, limit: 8 }).map((x) => x.id);
  assert.equal(forward[0], 'revived', `复活过的没排前面：${forward.join(',')}`);
  assert.equal(backward[0], 'revived', `入参顺序不该影响结果：${backward.join(',')}`);
});

ok('⑦ 复活加权只是天平，不是杠杆：相关 1.0 的那条仍然压过它', () => {
  const now = Date.now();
  const base = { kind: 'fact', weight: 1, createdAt: now, updatedAt: now };
  // 两条都是"非核心、同新鲜、同重要"，唯一差别是相关 vs 复活
  const onTopic = { ...base, id: 'on', text: '小明住在杭州' };
  const maxRevived = { ...base, id: 'rev', text: '小明养了一只乌龟', reviveCount: 99, reviveAt: now };
  const rows = rankFactRecords([maxRevived, onTopic], { query: '小明住在杭州吗', now, limit: 8 });
  assert.equal(rows[0].id, 'on', `复活 99 次也不该压过真正相关的：${rows.map((r) => r.id).join(',')}`);
});

ok('⑧ 无 query 时仍走旧顺序（权重→时间），复活不参与 —— 老调用方一个字节都不变', () => {
  const now = Date.now();
  const heavyRevived = { id: 'a', text: 'A', kind: 'fact', weight: 1, createdAt: now, updatedAt: now, reviveCount: 9 };
  const light = { id: 'b', text: 'B', kind: 'fact', weight: 2, createdAt: now - 1000, updatedAt: now - 1000 };
  const rows = rankFactRecords([heavyRevived, light], { query: '', now, limit: 8 });
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a'], '没 query 时只能按权重排');
});

console.log('\n[复活加权] candidate 分支的继承');

ok('⑨ 休眠条被重提 → 新增 candidate 时继承复活史（+1）', () => {
  fresh();
  const Q2 = OTHER;
  rememberFact(Q2, '测试三在学吉他', { weight: 0.1 });
  forgetWeakFacts({ minWeight: 0.3, qq: Q2, now: Date.now() });
  const one = rawOf(Q2, '学吉他').find((f) => f.dormant);
  assert.ok(one);
  dormantRevive(Q2, one.id, { now: Date.now() });          // 复活 1 次
  forgetWeakFacts({ minWeight: 0.7, qq: Q2, now: Date.now() });  // 又淡出

  const r = rememberFact(Q2, '测试三在学吉他', { weight: 0.5, now: Date.now() });
  assert.equal(r.reawakened, true, '前置条件：这应该是"旧条休眠 → 新增 candidate"分支');
  assert.equal(r.record.reviveCount, 2, `candidate 应继承 1 次再 +1，实际 ${r.record.reviveCount}`);

  // 旧休眠条自己的次数不能被改
  const old = rawOf(Q2, '学吉他').find((f) => f.id === one.id);
  assert.equal(old.reviveCount, 1, '旧条被动了 —— 它的休眠史必须原样留着');
  assert.equal(old.dormant, true);
});

ok('⑩ 没复活过的休眠条被重提，不凭空写 reviveCount', () => {
  fresh();
  const Q3 = '20003';
  rememberFact(Q3, '测试四在准备考试', { weight: 0.1 });
  forgetWeakFacts({ minWeight: 0.3, qq: Q3, now: Date.now() });
  const r = rememberFact(Q3, '测试四在准备考试', { weight: 0.5, now: Date.now() });
  assert.equal(r.reawakened, true);
  assert.equal(r.record.reviveCount, undefined, '一次都没复活过就不该有这个字段');
});

console.log(`\n[memory-revive] ${pass} 项通过`);
