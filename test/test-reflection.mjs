// 反思层自测（2026-10-26）。
//
// 反思层补的是这个洞：原来的长期事实提取只在"被 @ 时"跑，且只取 primarySpeaker 一个人，
// 于是群里其他人聊一年也进不了记忆。
//
// 断言六组：
//   ① 只处理游标之后的（幂等），且**从最旧的开始**（否则旧消息永远饿死）；
//   ② 按人分组、单独成批（防串人）；每人一次调用，人数有上限；
//   ③ 喂给某人的行里**只有他自己的话 + 紧跟着我的回复**，别人的话一句都不能进；
//   ④ 触发看"条数"或"空闲"，且每天有轮数上限（成本闸）；
//   ⑤ 积压太多只取最近一段（否则永远在补历史）；
//   ⑥ 游标跨天归零、不倒退。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-reflect-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const R = await import('../src/reflection.js');
const {
  pickUnprocessed, planRun, shouldReflect, buildPersonLines,
  ReflectionCursor, REFLECT_DEFAULTS, dayKeyOf, allowedRunsToday
} = R;

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

console.log('[reflection]');

let seq = 0;
const msg = (over = {}) => {
  seq += 1;
  return {
    id: seq,
    mid: 900000 + seq,
    ts: 1790000000000 + seq * 1000,
    senderId: '10001',
    senderName: '张三',
    text: `第${seq}条`,
    self: false,
    ...over
  };
};
const sys = (text, over = {}) => msg({ self: true, senderId: 'self', senderName: '我', text, ...over });

ok('① 只取游标之后的，且从最旧的开始（旧消息不能饿死）', () => {
  seq = 0;
  const list = [];
  for (let i = 0; i < 100; i += 1) list.push(msg());
  const pending = pickUnprocessed(list, 40);
  assert.equal(pending.length, 60);
  assert.equal(pending[0].id, 41, '起点应是游标后第一条');
  assert.equal(pending.at(-1).id, 100);
  const plan = planRun({ messages: list, uptoId: 40, cfg: { maxPerRun: 10 } });
  assert.equal(plan.batch.length, 10);
  assert.equal(plan.batch[0].id, 41, '应从最旧的开始，而不是最近的 10 条');
  assert.equal(plan.nextUptoId, 50);
});

ok('② 按人分组、按发言数排序、人数有上限', () => {
  seq = 0;
  const list = [];
  for (let i = 0; i < 5; i += 1) list.push(msg({ senderId: 'A', senderName: '阿A' }));
  for (let i = 0; i < 4; i += 1) list.push(msg({ senderId: 'B', senderName: '阿B' }));
  for (let i = 0; i < 3; i += 1) list.push(msg({ senderId: 'C', senderName: '阿C' }));
  const plan = planRun({ messages: list, uptoId: 0, cfg: { maxPerRun: 60, maxPeople: 2, minLinesPerPerson: 3 } });
  assert.equal(plan.people.length, 2, 'maxPeople 没生效');
  assert.equal(plan.people[0].id, 'A', '说话最多的应该排第一');
  assert.equal(plan.people[1].id, 'B');
  assert.ok(plan.skipped.includes('阿C(3)'), `C 应该被记为跳过，实际 skipped=${plan.skipped}`);
});

ok('②b 说话太少的人不单独烧一次调用', () => {
  seq = 0;
  const list = [msg({ senderId: 'A' }), msg({ senderId: 'A' }), msg({ senderId: 'A' }), msg({ senderId: 'D' })];
  const plan = planRun({ messages: list, uptoId: 0, cfg: { minLinesPerPerson: 3 } });
  assert.equal(plan.people.length, 1);
  assert.ok(plan.dropped.includes('张三(1)') || plan.dropped.some((x) => x.includes('(1)')), `dropped=${plan.dropped}`);
});

ok('②c 系统事件不算人（拍一拍 / 空名字 / 无 id 都不许进人名单）', () => {
  seq = 0;
  const list = [
    msg({ senderId: 'A', senderName: '阿A' }),
    msg({ senderId: 'A', senderName: '阿A' }),
    msg({ senderId: 'A', senderName: '阿A' }),
    msg({ senderId: '9001', senderName: '（拍一拍事件）' }),
    msg({ senderId: '9001', senderName: '（拍一拍事件）' }),
    msg({ senderId: '9001', senderName: '（拍一拍事件）' }),
    msg({ senderId: '9002', senderName: '   ' }),
    msg({ senderId: '9002', senderName: '   ' }),
    msg({ senderId: '9002', senderName: '   ' }),
    msg({ senderId: '', senderName: '匿名' }),
    msg({ senderId: '', senderName: '匿名' }),
    msg({ senderId: '', senderName: '匿名' })
  ];
  const plan = planRun({ messages: list, uptoId: 0, cfg: { minLinesPerPerson: 3, maxPeople: 4 } });
  assert.equal(plan.people.length, 1, `只该有阿A，实际 ${plan.people.map((p) => p.name).join(',')}`);
  assert.equal(plan.people[0].id, 'A');
  assert.equal(R.isHumanSender({ self: true, senderId: '123', senderName: '我' }), false, '自己发的不算');
  assert.equal(R.isHumanSender({ self: false, senderId: '456', senderName: '群主撤回了一条消息' }), false);
});

ok('③ 喂给某人的行里只有他自己的话 + 紧跟我的回复（别人的话一句不进）', () => {
  seq = 0;
  const a = msg({ senderId: 'A', senderName: '阿A', text: '我下周搬去成都' });
  const s1 = sys('成都好啊');
  const b = msg({ senderId: 'B', senderName: '阿B', text: 'B 老婆跑了这是秘密' });
  const s2 = sys('这话别乱说');
  const a2 = msg({ senderId: 'A', senderName: '阿A', text: '我又养了只猫' });
  const s3 = sys('什么猫');
  const batch = [a, s1, b, s2, a2, s3];

  const linesA = buildPersonLines(batch, 'A');
  assert.ok(linesA.some((l) => l.includes('搬去成都')), 'A 自己的话没进去');
  assert.ok(linesA.some((l) => l.includes('成都好啊')), '紧跟着 A 的回复应该进去（提供上下文）');
  assert.ok(linesA.some((l) => l.includes('养了只猫')));
  assert.ok(!linesA.some((l) => l.includes('老婆跑了')), `A 的批次里混进了 B 的话：\n${linesA.join('\n')}`);
  assert.ok(!linesA.some((l) => l.includes('这话别乱说')), 'A 的批次里混进了"我对 B 说的话"');

  const linesB = buildPersonLines(batch, 'B');
  assert.deepEqual(linesB, ['阿B：B 老婆跑了这是秘密', '我：这话别乱说']);
});

ok('③b 连续两条我的回复仍归属前一个人（不会因为中间没别人就断掉）', () => {
  seq = 0;
  const batch = [msg({ senderId: 'A', senderName: '阿A', text: '在吗' }), sys('在'), sys('怎么了')];
  const lines = buildPersonLines(batch, 'A');
  assert.deepEqual(lines, ['阿A：在吗', '我：在', '我：怎么了']);
});

ok('④ 触发：条数够就跑、条数不够就看空闲、每天有轮数上限', () => {
  const now = 1790000000000;
  const today = dayKeyOf(now);
  const base = { cfg: { minPending: 20, minLinesPerPerson: 3, idleMs: 600000, maxRunsPerDay: 3 }, now };
  assert.equal(shouldReflect({ ...base, pending: 20, idleMs: 0, state: {} }).reason, 'count');
  assert.equal(shouldReflect({ ...base, pending: 5, idleMs: 0, state: {} }).go, false, '才 5 条不该跑');
  assert.equal(shouldReflect({ ...base, pending: 5, idleMs: 700000, state: {} }).reason, 'idle', '安静够久应该跑');
  assert.equal(shouldReflect({ ...base, pending: 2, idleMs: 700000, state: {} }).go, false, '2 条不值得调模型');
  const tired = { dayKey: today, runs: 3 };
  assert.equal(shouldReflect({ ...base, pending: 50, idleMs: 0, state: tired }).reason, 'budget');
  // 昨天的 3 轮不该压到今天
  assert.equal(shouldReflect({ ...base, pending: 50, idleMs: 0, state: { dayKey: '2000-01-01', runs: 3 } }).reason, 'count');
});

ok('⑤ 积压太多只取最近一段（不会永远在补历史）', () => {
  seq = 0;
  const list = [];
  for (let i = 0; i < 1000; i += 1) list.push(msg());
  const plan = planRun({ messages: list, uptoId: 0, cfg: { maxPerRun: 60, backlogSkip: 600 } });
  assert.equal(plan.jumped, true, '积压 1000 条应判定为 jumped');
  assert.equal(plan.batch.length, 60);
  assert.equal(plan.batch.at(-1).id, 1000, '应该取最近那一段');
  assert.equal(plan.batch[0].id, 941);
  assert.equal(plan.nextUptoId, 1000);
});

ok('⑤b 空会话 / 全是自己说的 → 不产生任何调用', () => {
  assert.deepEqual(planRun({ messages: [], uptoId: 0 }).people, []);
  seq = 0;
  const onlySelf = [sys('自言自语一'), sys('自言自语二'), sys('自言自语三')];
  const plan = planRun({ messages: onlySelf, uptoId: 0, cfg: { minLinesPerPerson: 3 } });
  assert.equal(plan.people.length, 0);
  assert.equal(plan.batch.length, 3, '游标仍要推进（否则每轮都重看）');
});

ok('⑥ 游标：推进、不倒退、跨天把今日轮数归零', () => {
  const dir = path.join(TMP, 'reflection');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'group_777.json');
  fs.writeFileSync(file, JSON.stringify({ uptoId: 100, dayKey: '2000-01-01', runs: 3, lastRunAt: 1 }), 'utf8');

  const cur = new ReflectionCursor();
  const st0 = cur.get('group:777');
  assert.equal(st0.uptoId, 100);
  assert.equal(st0.runs, 3);
  assert.equal(st0.dayKey, '2000-01-01');

  // 跨天：runs 归零
  const now = 1790000000000;
  const st1 = cur.commit('group:777', { uptoId: 120, now });
  assert.equal(st1.runs, 1, `跨天应重新计数，实际 ${st1.runs}`);
  assert.equal(st1.dayKey, dayKeyOf(now));
  assert.equal(st1.uptoId, 120);

  // 不倒退：给一个更小的 uptoId 不能把游标拉回去（否则会重复烧钱）
  const st2 = cur.commit('group:777', { uptoId: 50, now });
  assert.equal(st2.uptoId, 120, '游标倒退了 —— 同一批消息会被重复处理');

  // counted:false 不占今日额度（"没人可提取"那种空跑）
  const before = st2.runs;
  const st3 = cur.commit('group:777', { uptoId: 130, now, counted: false });
  assert.equal(st3.runs, before, `空跑不该占每日额度（应保持 ${before}，实际 ${st3.runs}）`);

  // 落盘了
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.uptoId, 130);
});

ok('⑥b 坏游标文件当成"从没反思过"，不炸', () => {
  const dir = path.join(TMP, 'reflection');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'group_888.json'), '{坏掉的 json', 'utf8');
  const cur = new ReflectionCursor();
  const st = cur.get('group:888');
  assert.equal(st.uptoId, 0);
  assert.equal(st.runs, 0);
});

ok('⑦ 默认值都在（配置没写时也能跑）', () => {
  assert.equal(REFLECT_DEFAULTS.minPending, 20);
  assert.equal(REFLECT_DEFAULTS.maxPeople, 6, '冷启动期名额放宽（新面孔才轮得到）');
  assert.equal(REFLECT_DEFAULTS.refreshPeoplePerRun, 2, '都覆盖过之后每轮只刷 2 个熟人');
  assert.equal(REFLECT_DEFAULTS.maxRunsPerDay, 8, '日上限是硬顶，不是常态额度');
  assert.equal(REFLECT_DEFAULTS.minRunsPerDay, 3, '保底要等于旧的固定 3，冷清会话不多花钱');
  assert.ok(REFLECT_DEFAULTS.backlogSkip >= REFLECT_DEFAULTS.maxPerRun, '积压阈值不该比单批还小');
});

// ── 冷启动优先（P4.4，2026-10-26）────────────────────────────────────────
// 起因：真机存量 5 条关系记忆、但最近 90 轮提示词里**一次都没出现**。
// 根因不是渲染（直调 formatRelationForPrompt 正常），而是每轮都取"发言最多的 4 个人"，
// 熟面孔反复被提取、新面孔永远轮不到 —— 那 5 个有关系的人恰好都没在说话。
ok('⑦f ★ 还没有关系记忆的人优先占名额（不是发言最多的通吃）', () => {
  seq = 0;
  const list = [];
  // A 说 6 句、B 5 句、C 4 句、D 3 句、E 3 句；A、B 已经有关系记忆
  for (const [id, n] of [['A', 6], ['B', 5], ['C', 4], ['D', 3], ['E', 3]]) {
    for (let i = 0; i < n; i += 1) list.push(msg({ senderId: id, senderName: `阿${id}` }));
  }
  const withRel = new Set(['A', 'B']);
  const plan = planRun({
    messages: list, uptoId: 0,
    cfg: { maxPerRun: 60, maxPeople: 3, minLinesPerPerson: 3 },
    hasRelation: (id) => withRel.has(id)
  });
  assert.deepEqual(plan.people.map((p) => p.id), ['C', 'D', 'E'],
    '已经有关系的 A/B 该让位给 C/D/E');
});

ok('⑦g 都覆盖过之后每轮只刷新少数熟人（覆盖式，刷多了纯浪费）', () => {
  seq = 0;
  const list = [];
  for (const [id, n] of [['A', 6], ['B', 5], ['C', 4], ['D', 3]]) {
    for (let i = 0; i < n; i += 1) list.push(msg({ senderId: id, senderName: `阿${id}` }));
  }
  const plan = planRun({
    messages: list, uptoId: 0,
    cfg: { maxPerRun: 60, maxPeople: 6, refreshPeoplePerRun: 2, minLinesPerPerson: 3 },
    hasRelation: () => true
  });
  assert.equal(plan.people.length, 2, '全都认识时不该一次刷 6 个');
  assert.deepEqual(plan.people.map((p) => p.id), ['A', 'B'], '刷新也按发言量挑');
});

ok('⑦h 不传 hasRelation 时行为与旧版逐字一致（老调用方安全）', () => {
  seq = 0;
  const list = [];
  for (const [id, n] of [['A', 6], ['B', 5], ['C', 4]]) {
    for (let i = 0; i < n; i += 1) list.push(msg({ senderId: id, senderName: `阿${id}` }));
  }
  const plan = planRun({ messages: list, uptoId: 0, cfg: { maxPeople: 2, minLinesPerPerson: 3 } });
  assert.deepEqual(plan.people.map((p) => p.id), ['A', 'B']);
});

// ── 每日额度按处理量给（P4.3，2026-10-26）────────────────────────────────
// 起因：真机 19:51 三个会话 runs 全撞到 3，之后一小时群里 20+ 条消息**一条都没学到**。
// 固定 3 次对热闹的群太小、对冷清的群太多。
// 起因：真机 19:51 三个会话 runs 全撞到 3，之后一小时群里 20+ 条消息**一条都没学到**。
// 固定 3 次对热闹的群太小、对冷清的群太多。
ok('⑦b ★ 额度按当天处理量增长：聊得越多越能反思', () => {
  assert.equal(allowedRunsToday({ processed: 0 }), 3, '没消化过也保底 3 次');
  assert.equal(allowedRunsToday({ processed: 40 }), 3, '40 条只挣到 1 次，被保底兜住');
  assert.equal(allowedRunsToday({ processed: 120 }), 4, '1+⌊120/40⌋=4');
  assert.equal(allowedRunsToday({ processed: 280 }), 8, '1+7=8，正好顶到硬上限');
  assert.equal(allowedRunsToday({ processed: 9999 }), 8, '再多也不许超过硬上限');
});

ok('⑦c ★ 撞额度才算 budget，没撞要继续学（真机复现）', () => {
  const now = Date.now();
  const today = dayKeyOf(now);
  // 真机形态：跑了 3 轮、消化 200 条 → 额度 6 → 还该继续
  const hot = shouldReflect({
    pending: 25, idleMs: 0, now,
    state: { dayKey: today, runs: 3, processed: 200 }
  });
  assert.equal(hot.go, true, `跑了 3 轮但只消化 200 条时额度是 ${hot.allowed}，不该停`);
  assert.equal(hot.reason, 'count');
  // 真跑到额度上限才停
  const full = shouldReflect({
    pending: 25, idleMs: 0, now,
    state: { dayKey: today, runs: 6, processed: 200 }
  });
  assert.equal(full.go, false);
  assert.equal(full.reason, 'budget');
});

ok('⑦d 跨天额度重算：昨天的 processed 不算今天', () => {
  const now = Date.now();
  const gate = shouldReflect({
    pending: 30, idleMs: 0, now,
    state: { dayKey: '2000-01-01', runs: 8, processed: 9999 }
  });
  assert.equal(gate.go, true, '昨天的额度不该压到今天');
  assert.equal(gate.allowed, 3, '新的一天从保底开始');
});

ok('⑦e 游标提交累加 processed，且跨天归零', () => {  const cur = new ReflectionCursor();
  const key = 'group_p4run';
  const now = Date.now();
  cur.commit(key, { uptoId: 10, processed: 25, now });
  assert.equal(cur.get(key).processed, 25);
  cur.commit(key, { uptoId: 20, processed: 15, now });
  assert.equal(cur.get(key).processed, 40, '同日要累加');
  // 换天：runs 与 processed 一起归零
  const tomorrow = now + 26 * 3600 * 1000;
  cur.commit(key, { uptoId: 30, processed: 5, now: tomorrow });
  const st = cur.get(key);
  assert.equal(st.processed, 5, '跨天只算今天这 5 条');
  assert.equal(st.runs, 1, '跨天 runs 归零后从 1 开始');
});

ok('⑦i ★ 老游标没有 processed 字段时能迁移出额度（否则新机制今天无效）', () => {
  const cur = new ReflectionCursor();
  const key = 'group_legacy_cursor';
  const today = dayKeyOf(Date.now());
  fs.mkdirSync(path.dirname(cur.fileOf(key)), { recursive: true });
  // 真机盘上的形态：跑过 3 轮，但没有 processed
  fs.writeFileSync(cur.fileOf(key), JSON.stringify({ uptoId: 500, dayKey: today, runs: 3 }));
  cur.reset();
  const st = cur.get(key);
  assert.equal(st.processed, 120, '3 轮 × 40 条 = 120（迁移估算）');
  const gate = shouldReflect({ pending: 30, idleMs: 0, state: st, now: Date.now() });
  assert.equal(gate.allowed, 4, '1+⌊120/40⌋=4');
  assert.equal(gate.go, true, 'runs=3 < allowed=4，今天不该就此停手');
});

console.log(`\n[reflection] ${pass} 项通过`);
