// 概率式召回 + 联想链自测（2026-10-27，学自 dsh-rofm 的召回那一半）
//
// 这一组要钉住的都是**不报错的错**：
//   ① 检索是确定性的 → 每轮注入同一组，低分项永远排不上（既不像人，也会自锁）；
//   ② 概率化过头 → 雷点被忘掉（那不是拟人，是冒犯）／某轮一条都想不起来（看着像坏了）；
//   ③ 联想退化 —— 事实一律以昵称开头，同人的事实两两共享一大把二元组，
//      不做文档频率过滤的话联想图是一个完全图，"联想"变成"把剩下的全塞进来"；
//   ④ 改了行为却没留观测位 → 两个月后无法归因（第二自信 xxx 空转的教训）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-recall-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const R = await import('../src/fact-recall.js');
const F = await import('../src/memory-facts.js');
const G = await import('../src/group-facts.js');
const LEDGER = await import('../src/recall-ledger.js');
const CFG = await import('../src/config.js');
const { DEFAULT_MAX_DOC_RATIO } = R;

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

/** 确定性 rng（mulberry32）—— 这类代码不注入 rng 就永远只能"看着像对"。 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
let seq = 0;
/** 造记录。**刻意都带同一个昵称前缀** —— 这是真机数据的样子，联想的两道过滤网正是为它准备的。 */
const rec = (nick, body, { weight = 1, ageDays = 0, kind = 'fact', id = '' } = {}) => ({
  id: id || `r${(seq += 1)}`,
  text: `${nick}${body}`,
  kind,
  weight,
  createdAt: NOW - ageDays * DAY,
  updatedAt: NOW - ageDays * DAY
});

console.log('\n[概率召回] 数学部分：p(n) 与素材同源交叉验证');

ok('① erf 值正确（erf(1)≈0.8427，奇函数，|x|≥4 饱和）', () => {
  assert.ok(Math.abs(R.erf(1) - 0.842700792949715) < 1e-9, String(R.erf(1)));
  assert.ok(Math.abs(R.erf(-1) + 0.842700792949715) < 1e-9);
  assert.strictEqual(R.erf(0), 0);
  assert.strictEqual(R.erf(5), 1);
  assert.strictEqual(R.erf(-5), -1);
  assert.strictEqual(R.erf(Infinity), 1);
  assert.strictEqual(R.erf(NaN), 0);
});

ok('② p(n) 与 dsh-rofm 实测值逐位吻合（这是唯一照搬它的数学）', () => {
  // 期望值是用仓库自己的 engine/recall.js 实跑出来的：
  // https://github.com/wall1234567/dsh-rofm
  const expect = [1, 0.926, 0.823, 0.694, 0.550, 0.407, 0.278, 0.175, 0.100, 0.053];
  for (let n = 1; n <= 10; n += 1) {
    const got = R.recallProbability(n);
    assert.ok(Math.abs(got - expect[n - 1]) < 0.001, `p(${n}) = ${got.toFixed(4)}，期望 ${expect[n - 1]}`);
  }
});

ok('③ p(n) 单调递减、n≤1 恒为 1、脏参数不给 NaN', () => {
  let prev = Infinity;
  for (let n = 1; n <= 20; n += 1) {
    const p = R.recallProbability(n);
    assert.ok(p <= prev + 1e-12, `p(${n}) 不单调`);
    assert.ok(p >= 0 && p <= 1);
    prev = p;
  }
  assert.strictEqual(R.recallProbability(0), 1);
  assert.strictEqual(R.recallProbability(-5), 1);
  assert.strictEqual(R.recallProbability('x'), 0);
  assert.strictEqual(R.recallProbability(3, 5, 0), 0, 'sigma<=0 必须给 0 而不是 NaN');
});

ok('④ α 没有新字段：由 kind / weight 推，且 ALPHA_MAX_WEIGHT 与 MAX_WEIGHT 必须一致', () => {
  // 本项目刚吃过一次亏：给 kind 加了元数据位却没同步改提示词与解析 → 真机 0 条、保护空转。
  // 不要重蹈覆辙：α 是从"模型写入时已经表过的态"里推的，不要求它再表一次。
  assert.strictEqual(R.ALPHA_MAX_WEIGHT, F.MAX_WEIGHT);
  assert.strictEqual(R.alphaOf({ kind: 'negative', weight: 0.5 }), 1);
  assert.strictEqual(R.alphaOf({ kind: 'rule', weight: 0.1 }), 1);
  const normal = R.alphaOf({ kind: 'fact', weight: 1 });
  const strong = R.alphaOf({ kind: 'fact', weight: 2 });
  const decayed = R.alphaOf({ kind: 'fact', weight: 0 });
  assert.ok(normal > 0.5 && normal < 0.8, String(normal));
  assert.strictEqual(strong, 1);
  // 下限 0.35：一条被衰减到底的事实也必须有机会露脸，否则它永远不会再被提及 → 永远不会被强化
  assert.strictEqual(decayed, 0.35);
  const mid = R.alphaOf({ kind: 'fact', weight: 0.3 });
  assert.ok(Math.abs(mid - 0.4475) < 1e-9, `weight 0.3 → α 应为 0.4475，实际 ${mid}`);
  assert.ok(R.alphaOf({ kind: 'fact', weight: 1.5 }) > normal);
});

console.log('\n[概率召回] 关键词索引：昵称陷阱');

ok('⑤ 昵称前缀被判为无区分力，真正的话题词保留', () => {
  const list = [
    rec('小明', '是学生，上课时经常摸鱼'),
    rec('小明', '爱看B站内容'),
    rec('小明', '使用qoder编程'),
    rec('小明', '打算等qoder不忙了再问'),
    rec('小明', '喜欢花火这个角色'),
    rec('小明', '接触了这个模型和那个 Tutorial')
  ];
  const { tokens, dropped } = R.buildTokenIndex(list, { maxDocRatio: 0.5 });
  // 昵称二元组出现在 100% 的记录里 → 必须被剔除
  assert.ok(dropped.has('小明'), '昵称本身没被剔除');
  assert.ok(dropped.size >= 1, `没剔除任何词：${[...dropped]}`);
  // qoder 只出现在 2/6 条 → 保留，这正是"想起 A 顺带想起 B"该走的桥
  const cats = [...tokens.entries()].filter(([, ts]) => ts.has('qoder')).map(([id]) => id);
  assert.strictEqual(cats.length, 2, `qoder 应该把 2 条连起来，实际 ${cats.length}`);
});

ok('⑥ 单字一律剔除（"的/了/是"会把几乎所有人串在一起）', () => {
  const { tokens } = R.buildTokenIndex([rec('小明', '是这样的人'), rec('小明', '的了和很都就我')]);
  for (const set of tokens.values()) {
    for (const t of set) assert.ok(String(t).length >= 2, `单字漏网：${t}`);
  }
});

ok('⑦ neighborsOf：共同点多的排前面，已在手里的不再出现，无关的进不来', () => {
  const list = [
    rec('小明', '使用qoder编程', { id: 'a' }),
    rec('小明', '打算等qoder不忙了再问', { id: 'b' }),
    rec('小明', '不喜欢qoder的代码补全', { id: 'c' }),
    rec('小明', '昨天去看了电影', { id: 'd' })
  ];
  const index = R.buildTokenIndex(list);              // 默认 maxDocRatio = 0.8
  const neigh = R.neighborsOf(['a'], ['b', 'c', 'd'], index, { minShared: 1 });
  const ids = neigh.map((x) => x.id);
  assert.ok(ids.includes('b') && ids.includes('c'), `应当联想出 b/c：${ids}`);
  assert.ok(!ids.includes('d'), '完全不共享关键词的 d 不该被联想出来');
  assert.ok(!ids.includes('a'), '种子自己不该再出现在联想结果里');
  const fewer = R.neighborsOf(['a'], ['c', 'd'], index, { minShared: 1 });
  assert.ok(!fewer.map((x) => x.id).includes('b'), '不在候选列表里的不该被捞回来');
});

ok('⑦b ⚠️ maxDocRatio 调低会把联想之桥一起砍掉（踩过的坑，不许再犯）', () => {
  // 一开始默认设的是 0.5：四条事实里 qoder 占 3/4 = 0.75 > 0.5 → 判成"无区分力"剔除，
  // 结果**联想一次都没发生过**，而且没有任何报错 —— 通道空转，跟 kind 那次一样难查。
  // 语义想清楚就知道 0.5 是错的：**出现在好几条里的词恰恰是联想最该走的桥**，
  // 只有"几乎每条都有"的（昵称、人称代词）才是噪声。所以定在 0.8。
  const list = [
    rec('小明', '使用qoder编程', { id: 'a' }),
    rec('小明', '打算等qoder不忙了再问', { id: 'b' }),
    rec('小明', '不喜欢qoder的代码补全', { id: 'c' }),
    rec('小明', '昨天去看了电影', { id: 'd' })
  ];
  const loose = R.buildTokenIndex(list, { maxDocRatio: 0.5 });
  assert.ok(loose.dropped.has('qoder'), '0.5 时应把 qoder 判为无区分力（这正是它错的地方）');
  assert.deepStrictEqual(R.neighborsOf(['a'], ['b', 'c', 'd'], loose, { minShared: 1 }), [],
    '反过来验：正因为 qoder 被砍，才一条邻居都没有');
  const tight = R.buildTokenIndex(list, { maxDocRatio: DEFAULT_MAX_DOC_RATIO });
  assert.ok(!tight.dropped.has('qoder'), '0.8 时必须留下 qoder');
  assert.ok(tight.dropped.has('小明'), '昵称必须被剔除');
});

console.log('\n[概率召回] 加权无放回抽样');

ok('⑧ E-S 抽样：名额恰好填满、不重复、选中率正比于权重', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const weights = [1, 0.5, 0.2, 0.1, 0.05];
  const N = 4000;
  const hit = { a: 0, b: 0, c: 0, d: 0, e: 0 };
  for (let i = 0; i < N; i += 1) {
    const pick = R.weightedSample(items, { weights, limit: 2, rng: seeded(i * 31 + 7) });
    assert.strictEqual(pick.length, 2, '名额必须恰好填满');
    assert.strictEqual(new Set(pick).size, 2, '同一次里不能有重复');
    for (const p of pick) hit[p] += 1;
  }
  // 单调：权重大 → 更常出现（严格正比不需要精确到数值，但不许翻身）
  assert.ok(hit.a > hit.b && hit.b > hit.c && hit.c > hit.d && hit.d > hit.e,
    `选中次数没有按权重排序：${JSON.stringify(hit)}`);
  // 差距要足够明显：权重 20 倍不应该只差一点（差一点 = 测量失 Holmhypothesis）
  assert.ok(hit.a > hit.e * 2.5, `区分度不足：${JSON.stringify(hit)}`);
  // 但也不能变成确定性：最弱的也要偶尔赢一次
  assert.ok(hit.e > 0, '权重最低的永远赢不了 = 又退化成确定性 top-N');
});

ok('⑨ temperature 真的能调节随机度（†1 更平、<1 更偏向高分）', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const weights = [1, 0.8, 0.6, 0.4, 0.2, 0.1];
  const top = (T) => {
    let n = 0;
    const N = 1500;
    for (let i = 0; i < N; i += 1) {
      const pick = R.weightedSample(items, { weights, limit: 1, rng: seeded(i * 977 + 3), temperature: T });
      if (pick[0] === 'a') n += 1;
    }
    return n / N;
  };
  const cold = top(0.4);
  const warm = top(4);
  assert.ok(cold > warm, `冷（更偏向高分）应高于热：${cold} vs ${warm}`);
});

ok('⑩ limit 越界 / 空输入安全，rng 异常值不会 NaN', () => {
  assert.deepStrictEqual(R.weightedSample([], { weights: [], limit: 3 }), []);
  assert.deepStrictEqual(R.weightedSample(['a'], { weights: [1], limit: 0 }), []);
  const pick = R.weightedSample(['a', 'b'], { weights: [1, 1], limit: 2, rng: () => 0 });
  assert.strictEqual(pick.length, 2, 'rng 恒返回 0（边界值）也不能少给');
  const nan = R.weightedSample(['a', 'b'], { weights: [NaN, undefined], limit: 2, rng: () => 0.5 });
  assert.strictEqual(nan.length, 2, '脏权重不能崩');
});

console.log('\n[概率召回] 整体：不许忘掉雷点、名额要填满、结果要有变化');

ok('⑪ 雷点/规矩不参与掷骰 —— 无论什么种子都一定出现', () => {
  // 这是与 ROFM 最大的分歧：它服务工具型 agent，忘掉一段旧代码无伤大雅；
  // 这里是社交场景，忘掉"对花生过敏"是事故。拟人不能建立在冒犯之上。
  const list = Array.from({ length: 20 }, (_, i) => rec('小明', `偏好第${i}件事`, { weight: 1, id: `f${i}` }));
  list.push(rec('小明', '对花生过敏', { kind: 'negative', weight: 1, id: 'allergy' }));
  list.push(rec('小明', '别叫他狗剩', { kind: 'rule', weight: 1, id: 'rule1' }));
  const pool = list.concat(Array.from({ length: 14 }, (_, i) => rec('小明', `琐事${i}`, { id: `t${i}` })));
  for (let s = 1; s <= 60; s += 1) {
    const { rows } = F.recallFactRecords(pool, { query: '今天聊点别的', now: NOW, limit: 8, rng: seeded(s) });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes('allergy'), `第 ${s} 次把雷点忘了：${ids}`);
    assert.ok(ids.includes('rule1'), `第 ${s} 次把规矩忘了：${ids}`);
  }
});

ok('⑫ 名额一定填满（池够的情况下），绝不会某轮想起 0 条', () => {
  const list = Array.from({ length: 30 }, (_, i) => rec('小明', `第${i}件事`, { weight: 1, id: `f${i}` }));
  for (let s = 1; s <= 40; s += 1) {
    const { rows } = F.recallFactRecords(list, { query: '', now: NOW, limit: 8, rng: seeded(s) });
    assert.strictEqual(rows.length, 8, `第 ${s} 次只想起 ${rows.length} 条`);
    assert.strictEqual(new Set(rows.map((r) => r.id)).size, 8, '同一轮里不能有重复的记忆');
  }
});

ok('⑬ 逐轮结果必须有变化 —— 200 轮里几乎不该出现同一组合（这就是"不再自锁"的判据）', () => {
  const list = Array.from({ length: 30 }, (_, i) => rec('小明', `第${i}件事`, { weight: 1, id: `f${i}` }));
  const sets = new Set();
  for (let s = 1; s <= 200; s += 1) {
    const { rows } = F.recallFactRecords(list, { query: '', now: NOW, limit: 8, rng: seeded(s * 7919) });
    sets.add(rows.map((r) => r.id).sort().join(','));
  }
  // 200 轮全部不同的概率极低；真自锁的话这里只有 1 种
  assert.ok(sets.size >= 190, `只有 ${sets.size} 种组合 —— 说明抽样没有真正生效`);
});

ok('⑭ 相关性强的时候也要体现：query 命中的那条被想起的频率显著高于随机', () => {
  // 概率化不是为了"随机"，是为了"相关的更可能、但不必定"。相关的那条必须明显占优。
  const others = Array.from({ length: 24 }, (_, i) => rec('小明', `偏好第${i}件事`, { weight: 1, id: `f${i}` }));
  const target = rec('小明', '大学在清水河校区读书', { weight: 1, id: 'campus' });
  const list = others.concat([target]);
  let hit = 0;
  const N = 300;
  for (let s = 1; s <= N; s += 1) {
    const { rows } = F.recallFactRecords(list, { query: '清水河校区在哪边', now: NOW, limit: 8, rng: seeded(s * 131) });
    if (rows.some((r) => r.id === 'campus')) hit += 1;
  }
  // 随机基线：8/25 = 32%
  assert.ok(hit / N > 0.6, `相关的那条只有 ${(hit / N * 100).toFixed(1)}% 被想起，跟随机基线 32% 差不多`);
});

console.log('\n[概率召回] 联想');

ok('⑮ 联想能把"分数不够但有共同点"的记忆捞回来', () => {
  // 联想只在**还没想起的**记录里找 —— 直接召回已经把相关的都捞走时它自然无事可做，
  // 这不是 bug。它真正的价值是下面这种：一条**很久没提**（freshness 低、排不上号）
  // 但和刚想起的这条聊的是同一件事的记忆，靠排序永远轮不到它，靠联想才能回来。
  const fresh = [
    rec('小明', '使用qoder编程', { id: 'a' }),
    rec('小明', '昨天去看了电影', { id: 'c' }),
    rec('小明', '喜欢看纪录片', { id: 'd' }),
    rec('小明', '常熬夜写代码', { id: 'e' }),
    rec('小明', '偏好番茄鸡蛋', { id: 'f' }),
    rec('小明', '讨厌香菜', { id: 'g' }),
    rec('小明', '养了一只猫', { id: 'h' }),
    rec('小明', '经常看搞笑视频', { id: 'i' })
  ];
  const stale = rec('小明', '打算等qoder不忙了再问', { id: 'b', ageDays: 120 });
  const list = fresh.concat([stale]);

  // 对照组：完全关掉联想
  let viaAssoc = 0;
  let without = 0;
  const N = 200;
  for (let s = 1; s <= N; s += 1) {
    const on = F.recallFactRecords(list, { now: NOW, limit: 6, assocMax: 1, rng: seeded(s * 17) });
    assert.strictEqual(on.rows.length, 6, '联想不能再把总数撑破 limit');
    // b 也可能碰巧被随机抽样选中；这里量的是**出现频率的抬升**，不是"只能靠联想"
    if (on.rows.some((r) => r.id === 'b')) viaAssoc += 1;
    const off = F.recallFactRecords(list, { now: NOW, limit: 6, assocMax: 0, rng: seeded(s * 17) });
    if (off.rows.some((r) => r.id === 'b')) without += 1;
  }
  assert.ok(viaAssoc > without, `联想应该让这条旧事出现得更频繁：开 ${viaAssoc} vs 关 ${without}`);
  assert.ok(viaAssoc > N * 0.15, `联想命中太少：${viaAssoc}/${N}`);
});

ok('⑮b 联想来了也不超过 assocBudget，且掷骰失败不占名额', () => {
  const list = [
    rec('小明', '使用qoder编程', { id: 'a' }),
    rec('小明', '打算等qoder不忙了再问', { id: 'b' }),
    rec('小明', '给qoder提了个issue', { id: 'c' }),
    rec('小明', '昨天去看了电影', { id: 'd' }),
    rec('小明', '喜欢看纪录片', { id: 'e' })
  ];
  for (let s = 1; s <= 50; s += 1) {
    const { stats } = F.recallFactRecords(list, { now: NOW, limit: 4, assocMax: 2, rng: seeded(s) });
    assert.ok(stats.associated <= 2, `超了联想预算：${stats.associated}`);
    assert.strictEqual(stats.total, 4, '不管联想成不成，名额都得填满');
  }
});

ok('⑯ assocMax=0 时彻底关闭联想（灰度/回滚的退路）', () => {
  const list = [
    rec('小明', '使用qoder编程', { id: 'a' }),
    rec('小明', '打算等qoder不忙了再问', { id: 'b' }),
    rec('小明', '昨天去看了电影', { id: 'c' })
  ];
  for (let s = 1; s <= 20; s += 1) {
    const { stats } = F.recallFactRecords(list, { now: NOW, limit: 3, assocMax: 0, rng: seeded(s) });
    assert.strictEqual(stats.assocBudget, 0);
    assert.strictEqual(stats.associated, 0);
    assert.strictEqual(stats.total, 3, '关掉联想后名额应全部给直接召回');
  }
});

ok('⑰ 观测位：full 标记能识别"池没填满 ⇒ 这个人对抽样免疫"', () => {
  const few = [rec('小明', '是学生', { id: 'a' }), rec('小明', '对花生过敏', { kind: 'negative', id: 'b' })];
  const { stats: s1 } = F.recallFactRecords(few, { now: NOW, limit: 8, rng: seeded(1) });
  assert.strictEqual(s1.full, true, '池 ≤ 名额时必须标记 full');
  assert.strictEqual(s1.pool, 2);
  assert.strictEqual(s1.total, 2);

  const many = Array.from({ length: 20 }, (_, i) => rec('小明', `第${i}件事`, { id: `f${i}` }));
  const { stats: s2 } = F.recallFactRecords(many, { now: NOW, limit: 8, rng: seeded(1) });
  assert.strictEqual(s2.full, false);
  assert.ok(s2.sampled > 0);
  // 名额守恒：核心 + 抽样 + 联想 = 总数
  assert.strictEqual(s2.coreKept + s2.guaranteed + s2.sampled + s2.associated, s2.total, 'stats 四个来源加起来必须等于总数');
});

console.log('\n[概率召回] 接线：listFacts / groupFacts / 台账');

ok('⑱ listFacts 默认不走抽样（老调用方与既有断言一个字节都不变）', () => {
  F.resetFactsCache();
  const qq = '21001';
  for (let i = 0; i < 12; i += 1) {
    F.rememberFact(qq, `小明第${i}件事`, { weight: 1, source: 'group:9' });
  }
  const nowPure = F.listFacts(qq, { limit: 8, chatKey: 'group:9', query: '第1件' });
  const pure2 = F.listFacts(qq, { limit: 8, chatKey: 'group:9', query: '第1件' });
  assert.deepStrictEqual(nowPure, pure2, '同一输入两次调用必须完全一致（默认确定性）');
  assert.strictEqual(nowPure.length, 8);
});

ok('⑲ sample=true 时同一输入两次可以有不同结果，且 stats 被填充出去', () => {
  F.resetFactsCache();
  const qq = '21002';
  for (let i = 0; i < 20; i += 1) F.rememberFact(qq, `小明第${i}件事`, { weight: 1, source: 'group:9' });
  F.rememberFact(qq, '小明对花生过敏', { weight: 1, kind: 'negative', source: 'group:9' });
  const stats = {};
  const a = F.listFacts(qq, {
    limit: 8, chatKey: 'group:9', query: '', sample: true, stats,
    recallOpts: { rng: seeded(1) }
  });
  assert.ok(stats.pool === 21, `stats 没被填充：${JSON.stringify(stats)}`);
  assert.strictEqual(a.length, 8);
  assert.ok(a.some((f) => f.text.includes('花生过敏')), '雷点必入');
  const sets = new Set();
  for (let s = 1; s <= 30; s += 1) {
    const row = F.listFacts(qq, {
      limit: 8, chatKey: 'group:9', query: '', sample: true, recallOpts: { rng: seeded(s * 13) }
    });
    sets.add(row.map((f) => f.id).join(','));
  }
  assert.ok(sets.size >= 25, `只有 ${sets.size} 种组合`);
});

ok('⑳ 群级记忆同样可抽样（群开久了有十几条印象，一样会自锁）', () => {
  G.resetGroupCache();
  const ck = 'group:9021';
  for (let i = 0; i < 12; i += 1) G.rememberGroupFact(ck, `这个群第${i}条规矩`, { kind: 'vibe' });
  G.rememberGroupFact(ck, '这个群不许发广告', { kind: 'rule' });
  const stats = {};
  const rows = G.listGroupFacts(ck, {
    limit: 6, query: '', sample: true, stats, recallOpts: { rng: seeded(5) }
  });
  assert.strictEqual(rows.length, 6);
  assert.ok(stats.pool === 13);
  assert.ok(rows.some((f) => f.kind === 'rule'), '群规必须出现（忘了会在别人地盘上说错话）');
  const old = G.listGroupFacts(ck, { limit: 6, query: '' });
  assert.strictEqual(old.length, 6, '不传 sample 时保持原行为');
});

ok('㉑ 台账：写得进、读得出、坏行跳过、写失败不抛', () => {
  LEDGER.recordRecall('facts', { pool: 10, total: 8, full: false, associated: 1 }, { qq: '21003', chatKey: 'group:9' });
  LEDGER.recordRecall('group', { pool: 3, total: 3, full: true, associated: 0 }, { chatKey: 'group:9' });
  const rows = LEDGER.readRecallLedger({ sinceMs: Date.now() - 60000 });
  assert.strictEqual(rows.length, 2, `读到 ${rows.length} 条`);
  const f = rows.find((r) => r.layer === 'facts');
  assert.strictEqual(f.qq, '21003');
  assert.strictEqual(f.total, 8);
  // layer 过滤
  assert.strictEqual(LEDGER.readRecallLedger({ layer: 'group' }).length, 1);
  // 残缺行必须被跳过，而不是让整个台账报废
  const file = LEDGER.RECALL_LEDGER_FILE;
  fs.appendFileSync(file, '{"broken":\n', 'utf8');
  const after = LEDGER.readRecallLedger({ sinceMs: Date.now() - 60000 });
  assert.strictEqual(after.length, 2, '坏行污染了整个台账');
});

ok('㉒ formatFactsForPrompt 带 sample 时不改变段标题（提示词格式一行不许变）', () => {
  F.resetFactsCache();
  const qq = '21004';
  for (let i = 0; i < 15; i += 1) F.rememberFact(qq, `小明第${i}件事`, { weight: 1, source: 'group:9' });
  const stats = {};
  const text = F.formatFactsForPrompt(qq, {
    limit: 8, chatKey: 'group:9', query: '', sample: true, stats,
    recallOpts: { rng: seeded(9) }
  });
  assert.ok(text.startsWith('【你长期记得的、关于当前说话者本人的事】'), text.slice(0, 40));
  const lines = text.split('\n');
  assert.strictEqual(lines.length, 9, `1 行标题 + 8 条，实际 ${lines.length}`);
  assert.ok(stats.total === 8, JSON.stringify(stats));
  for (const line of lines.slice(1)) assert.ok(line.startsWith('- '), line);
  assert.strictEqual(F.formatFactsForPrompt('不存在的QQ', { chatKey: 'group:9' }), '');
});

ok('㉓ 配置 ↔ 代码必须对齐（不对齐就是 kind 那次的下场）', () => {
  // `kind` 的教训：加了元数据位，但提示词没要求、解析层没默认值 → 真机 102 条里
  // rule/negative 是 0，三条保护逻辑一次都没触发过。这类"全都写好了、互相没接上"
  // 的错不报错，只能靠**双向**一致性检查钉住：
  //   正向：orchestrator 读的每个键在 DEFAULT_CONFIG 里都得存在（防拼错名）；
  //   反向：DEFAULT_CONFIG 里每个 recall* 键都得真被 orchestrator 引用（防加了没人读）。
  const { DEFAULT_CONFIG } = CFG;
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'orchestrator.js'), 'utf8');
  const mf = DEFAULT_CONFIG.memoryFacts || {};
  const gf = DEFAULT_CONFIG.groupFacts || {};
  const keys = ['recallSampling', 'recallTemperature', 'recallTopShare', 'recallAssocMax',
    'recallMaxGeneration', 'recallMinShared', 'recallMaxDocRatio'];
  for (const k of keys) {
    assert.ok(k in mf, `DEFAULT_CONFIG.memoryFacts 缺 ${k} —— orchestrator 会读到 undefined`);
    assert.ok(src.includes(k), `${k} 在 config 里写了，但 orchestrator.js 里没有引用它`);
  }
  for (const k of ['recallSampling', 'recallAssocMax', 'recallMaxGeneration']) {
    assert.ok(k in gf, `DEFAULT_CONFIG.groupFacts 缺 ${k}`);
  }
  for (const k of Object.keys(mf).filter((x) => x.startsWith('recall'))) {
    assert.ok(keys.includes(k), `配置项 ${k} 没有任何代码在用它（dead knob）`);
  }
});

console.log(`\n[fact-recall] ${pass} 项通过`);
