// P2 记忆增强自测（2026-10-26）：
//   · facts 相关性排序（核心项保底 + 相关×新鲜竞争）
//   · 关系记忆 kind='relation'（覆盖式、跨群、单条）
//   · 群级记忆 group-facts（按会话存的"这个群是什么地方"）
//
// 这一组要钉住的都是**不报错的错**：
//   ① 只按 weight/updatedAt 排 → 三个月没提的"对花生过敏"永远排在最后（记了等于没记）；
//   ② 让相关性裸奔 → 一句刚说的闲聊能压过一条保命的事实（把长期记忆做成短期记忆）；
//   ③ 关系记忆追加而不覆盖 → "刚认识很客气"和"熟到能互怼"同时输出，人设开始漂；
//   ④ 群记忆记进某个人的私事 → 那是整个群都看得见的位置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-p2-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const F = await import('../src/memory-facts.js');
const G = await import('../src/group-facts.js');
const budgetMod = await import('../src/context-budget.js');
const { USER_ORDER, USER_BUDGET } = budgetMod;
const {
  rememberFact, listFacts, formatFactsForPrompt, resetFactsCache,
  rankFactRecords, isCoreFact, CORE_WEIGHT, MAX_FACTS_PER_USER,
  rememberRelation, listRelation, formatRelationForPrompt, parseReflectionOutput,
  buildExtractionPrompt
} = F;
const {
  rememberGroupFact, listGroupFacts, formatGroupFactsForPrompt, parseGroupExtraction,
  buildGroupPrompt, decayGroupFacts, forgetWeakGroupFacts, resetGroupCache,
  groupFactCount, MAX_GROUP_FACTS, GROUP_KINDS
} = G;

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

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** 直接造记录，绕开磁盘（测排序本身）。 */
const rec = (text, { weight = 1, ageDays = 0, kind = 'fact' } = {}) => ({
  id: text, text, kind, weight,
  createdAt: NOW - ageDays * DAY,
  updatedAt: NOW - ageDays * DAY
});

console.log('\n[P2] facts 相关性排序');

ok('① 不传 query = 旧顺序（weight 降序，同权重按新旧）', () => {
  const list = [
    rec('轻的新的', { weight: 0.5, ageDays: 1 }),
    rec('重的旧的', { weight: 1.8, ageDays: 300 }),
    rec('中的最新的', { weight: 1.0, ageDays: 0 })
  ];
  const out = rankFactRecords(list, { limit: 3 });
  assert.deepEqual(out.map((f) => f.text), ['重的旧的', '中的最新的', '轻的新的']);
});

ok('② 有 query 时，高相关的旧事实能上浮到第一', () => {
  const list = [
    rec('今天聊到游戏一', { ageDays: 0 }),
    rec('今天聊到游戏二', { ageDays: 0 }),
    rec('对花生过敏', { ageDays: 200 })
  ];
  const out = rankFactRecords(list, { limit: 3, query: '这个花生能吃吗' });
  assert.equal(out[0].text, '对花生过敏', `相关项没上浮：${out.map((f) => f.text).join(' / ')}`);
});

ok('★ ③ 核心项不会被"一堆超相关的闲聊"挤没（rule 在 8 条新话题里仍然入选）', () => {
  const fresh = Array.from({ length: 8 }, (_, i) => rec(`啊啊啊新话题${i}`, { ageDays: 0 }));
  const rule = rec('群里不许发广告', { kind: 'rule', ageDays: 300 });
  const out = rankFactRecords([...fresh, rule], { limit: 8, query: '啊啊啊' });
  assert.equal(out.length, 8);
  assert.ok(out.some((f) => f.kind === 'rule'), `群规被挤掉了：${out.map((f) => f.text).join(' / ')}`);
  // 核心项**排在前面**（提示词里也是这个顺序）：保底不是"塞进去就行"，
  // 排在 8 条闲聊之后等于没保 —— 模型读到第 9 条时已经在组织回复了。
  assert.equal(out[0].kind, 'rule', `核心项没排在最前：${out.map((f) => f.kind).join(',')}`);
});

ok('④ 被重复提及过的事实（weight≥1.2）同样受保底保护', () => {
  assert.equal(isCoreFact(rec('x', { weight: CORE_WEIGHT })), true);
  assert.equal(isCoreFact(rec('x', { weight: 1.0 })), false);
  const fresh = Array.from({ length: 8 }, (_, i) => rec(`啊啊啊${i}`, { ageDays: 0 }));
  const old = rec('他的生日是 3 月 7 日', { weight: 1.6, ageDays: 400 });
  const out = rankFactRecords([...fresh, old], { limit: 8, query: '啊啊啊' });
  assert.ok(out.some((f) => f.text === '他的生日是 3 月 7 日'), '高权重旧事实被挤掉了');
});

ok('⑤ 核心项少于保底名额时，用剩下的核心项补齐（不会返回半页）', () => {
  const core = [rec('规则一', { kind: 'rule' }), rec('规则二', { kind: 'negative' })];
  const out = rankFactRecords(core, { limit: 6, query: '随便聊聊' });
  assert.equal(out.length, 2);
});

ok('⑥ limit 生效，且不重复返回同一条', () => {
  const list = Array.from({ length: 20 }, (_, i) => rec(`第${i}条`, { ageDays: i }));
  const out = rankFactRecords(list, { limit: 5, query: '第' });
  assert.equal(out.length, 5);
  assert.equal(new Set(out.map((f) => f.text)).size, 5);
});

ok('⑦ 端到端：listFacts 带 query 时"忌口"上浮（走磁盘）', () => {
  resetFactsCache();
  const Q = '31001';
  const old = NOW - 120 * DAY;
  rememberFact(Q, `${Q}对花生过敏`, { now: old });
  for (let i = 0; i < 7; i += 1) rememberFact(Q, `${Q}今天聊到游戏${i}`, { now: NOW - i * 1000 });
  const noQuery = listFacts(Q, { limit: 3 }).map((f) => f.text);
  assert.ok(!noQuery.includes(`${Q}对花生过敏`), `不传 query 时它本来就不该在前三：${noQuery.join(' / ')}`);
  const withQuery = listFacts(Q, { limit: 3, query: '花生能不能吃' }).map((f) => f.text);
  assert.equal(withQuery[0], `${Q}对花生过敏`, `带 query 没上浮：${withQuery.join(' / ')}`);
});

console.log('\n[P2] 关系记忆 kind=relation');

ok('⑧ 覆盖而不是追加：同一个人只留一条关系', () => {
  resetFactsCache();
  const Q = '31002';
  rememberRelation(Q, '他对你比较客气，保持距离');
  const before = F.factCount(Q);
  const r = rememberRelation(Q, '他跟你很随便，可以互怼');
  const rows = listRelation(Q);
  assert.equal(rows.length, 1, `留了 ${rows.length} 条关系：${rows.map((x) => x.text).join(' / ')}`);
  assert.equal(rows[0].text, '他跟你很随便，可以互怼');
  assert.equal(r.replaced, '他对你比较客气，保持距离');
  assert.equal(F.factCount(Q), before, '覆盖不该让条数变多（关系的价值不在数量）');
});

ok('⑨ 同一句话重复写 = unchanged，不刷新成两条', () => {
  resetFactsCache();
  const Q = '31003';
  rememberRelation(Q, '他把你当树洞');
  const r = rememberRelation(Q, '他把你当树洞');
  assert.equal(r.unchanged, true);
  assert.equal(listRelation(Q).length, 1);
});

ok('⑩ 空串/占位词不写（模型经常回"无"）', () => {
  resetFactsCache();
  const Q = '31004';
  for (const t of ['', '   ', '无', '没有', '暂无']) {
    const r = rememberRelation(Q, t);
    assert.equal(r.ok, false, `"${t}" 被当成关系记下来了`);
  }
  assert.equal(listRelation(Q).length, 0);
});

ok('⑪ person 与 group 各留一条，互不覆盖', () => {
  resetFactsCache();
  const Q = '31005';
  rememberRelation(Q, '他跟你说话很随便');
  rememberRelation(Q, '在这个群里他总让你唱歌', { scope: 'group', source: 'group:888' });
  const priv = listRelation(Q, { chatKey: 'private:1' });
  assert.equal(priv.length, 1, '私聊里不该看到群关系');
  const inGroup = listRelation(Q, { chatKey: 'group:888' });
  assert.equal(inGroup.length, 2, `群里应该两条都在，实际 ${inGroup.length}`);
  const other = listRelation(Q, { chatKey: 'group:999' });
  assert.equal(other.length, 1, '别的群不该看到 group 关系');
});

ok('⑫ 凭据不进关系（回归同一道闸）', () => {
  resetFactsCache();
  const r = rememberRelation('31006', '他给过你 sk-fakeabcde' + 'fghijklmnopq' + 'rstuvwxyz');
  assert.equal(r.ok, false);
});

ok('⑬ 关系段为空时一个字都不占；有内容时带"不是今天的情绪"护栏', () => {
  resetFactsCache();
  const Q = '31007';
  assert.equal(formatRelationForPrompt(Q), '');
  rememberRelation(Q, '他不太喜欢被追问');
  const text = formatRelationForPrompt(Q);
  assert.match(text, /【你和他之间的】/);
  assert.match(text, /不是今天的情绪/, '缺了护栏，模型会把关系当情绪播报');
  assert.match(text, /他不太喜欢被追问/);
});

ok('★ ⑭ 关系条目不会混进【长期事实】那段（否则会被当档案念出来）', () => {
  resetFactsCache();
  const Q = '31008';
  rememberFact(Q, `${Q}在杭州上班`);
  rememberRelation(Q, '他跟你说话很随便');
  const facts = formatFactsForPrompt(Q, { limit: 8 });
  assert.match(facts, /杭州/);
  assert.ok(!facts.includes('他跟你说话很随便'), `关系混进了事实段：\n${facts}`);
});

console.log('\n[P2] 反思输出解析（facts + relation 一次拿）');

ok('⑮ 同时解析 facts 与 relation', () => {
  const raw = '```json\n{"facts":[{"text":"小明养了只猫","scope":"person"}],"relation":"他跟你说话很随便"}\n```';
  const out = parseReflectionOutput(raw, { name: '小明' });
  assert.equal(out.facts.length, 1);
  assert.equal(out.facts[0].text, '小明养了只猫');
  assert.equal(out.relation, '他跟你说话很随便');
});

ok('⑯ relation 是"无/没有/null"时当没写', () => {
  for (const v of ['无', '没有', '暂无', 'null', 'N/A', '不确定']) {
    const out = parseReflectionOutput(JSON.stringify({ facts: [], relation: v }));
    assert.equal(out.relation, '', `"${v}" 被当成关系了`);
  }
});

ok('⑰ 没有 relation 字段（实时提取那种输出）也照常解析 facts', () => {
  const out = parseReflectionOutput('{"facts":["小红喜欢猫"]}', { name: '小红' });
  assert.equal(out.facts[0].text, '小红喜欢猫');
  assert.equal(out.relation, '');
});

ok('⑱ 提示词里 relation 开关真的起作用（关掉时不出现 relation 字样）', () => {
  const on = buildExtractionPrompt({ name: '小明', who: '1', lines: ['a'], relation: true });
  const off = buildExtractionPrompt({ name: '小明', who: '1', lines: ['a'] });
  assert.match(on, /"relation"/);
  assert.ok(!off.includes('"relation"'), '没开开关却要求了 relation —— 白烧 token 还会覆盖旧关系');
  assert.match(on, /覆盖/);
});

console.log('\n[P2] 群级记忆 group-facts');

ok('⑲ 记一条 / 去重加权 / 读回来', () => {
  resetGroupCache();
  const K = 'group:4101';
  assert.equal(formatGroupFactsForPrompt(K), '', '空群不该占位');
  const a = rememberGroupFact(K, '这个群爱用猫图接话', { kind: GROUP_KINDS.MEME });
  assert.equal(a.ok, true);
  const b = rememberGroupFact(K, '这个群爱用猫图接话', { kind: GROUP_KINDS.MEME });
  assert.equal(b.duplicate, true);
  assert.equal(groupFactCount(K), 1);
  assert.ok(listGroupFacts(K)[0].weight > 1, '重复提及应该加权');
  assert.match(formatGroupFactsForPrompt(K), /【这个群】/);
});

ok('★ ⑳ 某个人的私事不许写进群记忆', () => {
  resetGroupCache();
  const K = 'group:4102';
  for (const t of ['群里的老王离婚了', '小张工资一万二', '李四住院了，癌症', '某人手机号 13800000000']) {
    const r = rememberGroupFact(K, t);
    assert.equal(r.ok, false, `"${t}" 被写进了群记忆 —— 这是整个群都看得见的位置`);
  }
  assert.equal(groupFactCount(K), 0);
});

ok('㉑ 凭据同样拒绝', () => {
  resetGroupCache();
  const r = rememberGroupFact('group:4103', '群公告里的 token 是 sk-fakeabcde' + 'fghijklmnopq' + 'rst');
  assert.equal(r.ok, false);
});

ok('㉒ 超过上限丢最弱的，但群规永不丢', () => {
  resetGroupCache();
  const K = 'group:4104';
  rememberGroupFact(K, '这个群不许发广告', { kind: GROUP_KINDS.RULE, weight: 0.2 });
  for (let i = 0; i < MAX_GROUP_FACTS + 5; i += 1) {
    rememberGroupFact(K, `这个群的第${i}条闲聊特征`, { weight: 0.4 });
  }
  assert.ok(groupFactCount(K) <= MAX_GROUP_FACTS, `超上限了：${groupFactCount(K)}`);
  const texts = listGroupFacts(K, { limit: MAX_GROUP_FACTS }).map((f) => f.text);
  assert.ok(texts.includes('这个群不许发广告'), '群规被容量淘汰了');
});

ok('㉓ 衰减不动群规（rule 不该过期）', () => {
  resetGroupCache();
  const K = 'group:4105';
  const old = NOW - 100 * DAY;
  rememberGroupFact(K, '这个群周五一堆人开黑', { kind: GROUP_KINDS.PLAN, now: old, weight: 1 });
  rememberGroupFact(K, '这个群不许发广告', { kind: GROUP_KINDS.RULE, now: old, weight: 1 });
  decayGroupFacts({ ratePerDay: 0.02, now: NOW });
  const rows = listGroupFacts(K);
  const rule = rows.find((f) => f.kind === 'rule');
  const plan = rows.find((f) => f.kind === 'plan');
  assert.equal(rule.weight, 1, '群规被衰减了');
  assert.ok(plan.weight < 0.5, `周常安排该衰减，实际 ${plan.weight}`);
});

ok('㉔ 淡出弱群事实时保留群规（2026-10-29 起淡出=休眠）', () => {
  resetGroupCache();
  const K = 'group:4106';
  rememberGroupFact(K, '这个群的梗已经过气了', { weight: 0.1, kind: GROUP_KINDS.MEME });
  rememberGroupFact(K, '这个群不许发广告', { weight: 0.1, kind: GROUP_KINDS.RULE });
  const { dormant } = forgetWeakGroupFacts({ minWeight: 0.3, chatKey: K });
  assert.equal(dormant, 1, `该只休眠 1 条，实际 ${dormant}`);
  assert.ok(listGroupFacts(K).some((f) => f.kind === 'rule'));
});

ok('㉕ 解析群提取结果：kind 归一 + 再挡一次私事', () => {
  const raw = '{"facts":[{"text":"这个群爱用猫图接话","kind":"meme"},{"text":"群里的老王离婚了","kind":"vibe"},{"text":"这个群不许发广告","kind":"乱写的"}]}';
  const out = parseGroupExtraction(raw, { max: 3 });
  const texts = out.map((x) => x.text);
  assert.ok(texts.includes('这个群爱用猫图接话'));
  assert.ok(!texts.includes('群里的老王离婚了'), '私事没被解析层挡住');
  const rule = out.find((x) => x.text === '这个群不许发广告');
  assert.equal(rule.kind, GROUP_KINDS.VIBE, '非法 kind 该兜底成 vibe');
});

ok('㉖ 群提示词写清"不要记关于某个人的事"和四类 kind', () => {
  const p = buildGroupPrompt({ chatName: '测试群', lines: ['张三：哈哈哈'] });
  assert.match(p, /绝对不要记/);
  assert.match(p, /某个人/);
  for (const k of Object.values(GROUP_KINDS)) assert.match(p, new RegExp(k));
});

ok('★ ㉖b 已记条目作为"别重复"清单喂进去，且没要求重写（防漂移）', () => {
  const p1 = buildGroupPrompt({ chatName: '测试群', lines: ['张三：哈哈哈'] });
  assert.match(p1, /（无）/, '空清单要显式写（无），否则模型会以为那一段是空行漏了');
  const p2 = buildGroupPrompt({
    chatName: '测试群', lines: ['张三：哈哈哈'],
    known: ['这个群爱用拍一拍互相点名', '这个群爱玩原神']
  });
  assert.match(p2, /这个群爱用拍一拍互相点名/);
  assert.match(p2, /不要重复写/);
  // 一旦要求"合并重写"，每轮措辞都会漂；这条断言是给未来的自己看的
  assert.ok(!/重写|合并成/.test(p2.split('已经记过的')[1] || ''), '别让它变成"重写"任务');
});

ok('㉗ 排序核心项保底同样适用于群记忆（群规不会被一堆新梗挤掉）', () => {
  resetGroupCache();
  const K = 'group:4107';
  rememberGroupFact(K, '这个群不许发广告', { kind: GROUP_KINDS.RULE, weight: 1.2 });
  for (let i = 0; i < 6; i += 1) rememberGroupFact(K, `啊啊啊新梗${i}`, { weight: 1 });
  const rows = listGroupFacts(K, { limit: 6, query: '啊啊啊' });
  assert.ok(rows.some((f) => f.kind === 'rule'), `群规被新梗挤掉了：${rows.map((f) => f.text).join(' / ')}`);
});

ok('★ ㉘ 两个新段都已登记进 USER_ORDER（顺序：memory → groupFacts → facts → relation → diary）', () => {
  for (const name of ['groupFacts', 'relation']) {
    assert.ok(USER_ORDER.includes(name), `${name} 没登记 —— 会被静默排到末尾`);
    assert.ok(USER_BUDGET[name] > 0, `${name} 没配额 —— 会按 4000 兜底，随时可能把 past 挤掉`);
  }
  const idx = (n) => USER_ORDER.indexOf(n);
  assert.ok(idx('groupFacts') > idx('memory') && idx('groupFacts') < idx('facts'), '群记忆该在记忆之后、事实之前');
  assert.ok(idx('relation') > idx('facts') && idx('relation') < idx('diary'), '关系该在事实之后、日记之前');
});

ok('★ ㉙ 带人设后缀的会话键要归一：写入 group:4200:tutor，读 group:4200 也读得到', () => {
  resetGroupCache();
  rememberGroupFact('group:4200:tutor', '这个群半夜最热闹', { kind: GROUP_KINDS.VIBE });
  const rows = listGroupFacts('group:4200');
  assert.equal(rows.length, 1, '有效键写进去、物理键读不到 —— 群记忆会永远为空且不报错');
  assert.equal(rows[0].text, '这个群半夜最热闹');
  // 磁盘文件名也必须是物理键（否则重启后一样读不到）
  const files = fs.readdirSync(path.join(TMP, 'memory', 'groups'));
  assert.ok(files.includes('group_4200.json'), `没落成物理键：${files.join(',')}`);
  assert.ok(!files.includes('group_4200_tutor.json'), `落成有效键了：${files.join(',')}`);
});

ok('㉚ 三段同时存在时，装配顺序是 记忆 → 群 → 事实 → 关系（且都不算未登记）', () => {
  const { applyBudget } = budgetMod;
  const r = applyBudget(
    [
      { name: 'facts', text: '【你长期记得的、关于当前说话者本人的事】\n- 他在杭州' },
      { name: 'relation', text: '【你和他之间的】\n- 他要歌时直接给成品' },
      { name: 'groupFacts', text: '【这个群】\n- 这个群爱用猫图接话' },
      { name: 'memory', text: '【记忆】\n- 在聊原神' }
    ],
    { order: USER_ORDER, budget: USER_BUDGET, totalMax: 40000 }
  );
  assert.deepEqual(r.unregistered, [], `有段没登记：${r.unregistered.join(',')}`);
  assert.deepEqual(r.sections.map((s) => s.name), ['memory', 'groupFacts', 'facts', 'relation']);
});

console.log(`\n[P2] ${pass} 项通过`);
fs.rmSync(TMP, { recursive: true, force: true });
