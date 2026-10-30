// 长期事实的「可见范围」与「遗忘」自测（2026-10-26）。
//
// 这一组针对两个真实缺陷：
//   ① facts 按 QQ 存（跨群共享是对的），但"他在 A 群说过什么"属于 A 群的语境。
//      以前注入只按 QQ 查、完全忽略来源，于是 A 在群里说的话会在他私聊时被端出来。
//   ② decayFacts / forgetWeakFacts 写好了却从未被调用 —— 事实永不衰减，
//      一条三年前的旧事和昨天的事等权。
//
// 另外钉住一个隐藏回归：load() 以前不读回 `source`，进程重启后来源就没了，
// 下一次 save 会把它从磁盘上一起抹掉。加了 scope 之后这不只是信息丢失 ——
// group 事实会变成"永远不可见"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-facts-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const F = await import('../src/memory-facts.js');
const {
  rememberFact, listFacts, formatFactsForPrompt, factVisibleIn, resetFactsCache,
  decayFacts, forgetWeakFacts, parseExtractionDetailed, parseExtraction,
  buildExtractionPrompt, factCount, MAX_WEIGHT, SCOPES
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

console.log('[memory-scope]');

const A = '20001';   // 这个人的 QQ
const GA = 'group:111111';
const GB = 'group:222222';
const PRIV = 'private:20001';
const DAY = 86400000;

ok('① person 级事实跨群可见（换个群还认识他）', () => {
  resetFactsCache();
  rememberFact(A, `${A}住在杭州`, { source: GA });
  assert.equal(listFacts(A, { chatKey: GB }).some((f) => f.text.includes('杭州')), true, 'B 群看不到 person 事实');
  assert.equal(listFacts(A, { chatKey: PRIV }).some((f) => f.text.includes('杭州')), true, '私聊看不到 person 事实');
});

ok('② group 级事实只在本群可见 —— 这就是"不串群"', () => {
  rememberFact(A, `${A}在A群答应周末帮群友修电脑`, { source: GA, scope: SCOPES.GROUP });
  const inA = listFacts(A, { chatKey: GA }).map((f) => f.text).join('\n');
  const inB = listFacts(A, { chatKey: GB }).map((f) => f.text).join('\n');
  const inPriv = listFacts(A, { chatKey: PRIV }).map((f) => f.text).join('\n');
  assert.ok(inA.includes('修电脑'), '本群看不到自己的群内事实');
  assert.ok(!inB.includes('修电脑'), `B 群看到了 A 群的事：\n${inB}`);
  assert.ok(!inPriv.includes('修电脑'), `私聊看到了群内的事：\n${inPriv}`);
});

ok('③ 不传 chatKey 时 group 一律不可见（保守方向）', () => {
  const rows = listFacts(A, {});
  assert.ok(!rows.some((f) => f.text.includes('修电脑')), '没给会话却漏出了群内事实');
  assert.equal(factVisibleIn({ text: 'x', scope: SCOPES.GROUP, source: GA }, ''), false);
});

ok('③b 身份模式后缀不影响可见性（group:111111:tutor 视为同一个群）', () => {
  assert.equal(factVisibleIn({ scope: SCOPES.GROUP, source: GA }, 'group:111111:tutor'), true);
});

ok('④ 重启后 scope 与 source 都还在（load 不丢字段）', () => {
  resetFactsCache();   // 模拟重启：内存清空，只能从磁盘读
  const rows = listFacts(A, { chatKey: GA });
  const hit = rows.find((f) => f.text.includes('修电脑'));
  assert.ok(hit, '重启后找不到那条群内事实（source 丢了 → 它变得永远不可见）');
  assert.equal(hit.scope, SCOPES.GROUP);
  // 再存一次（模拟后续任何一次写入），source 必须仍被写回磁盘
  rememberFact(A, `${A}喜欢喝美式`, { source: GB });
  const file = path.join(TMP, 'memory', 'facts', `${A}.json`);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const onDisk = disk.facts.find((f) => f.text.includes('修电脑'));
  assert.ok(onDisk?.source, '磁盘上的 source 被写没了');
  assert.equal(onDisk.scope, SCOPES.GROUP);
});

ok('⑤ 端到端：B 群的提示词里出现 0 次 A 群的私事', () => {
  const promptB = formatFactsForPrompt(A, { chatKey: GB });
  assert.ok(promptB.includes('杭州'), 'B 群连 person 事实都没了（过滤过头）');
  assert.equal(promptB.includes('修电脑'), false, `B 群提示词泄漏：\n${promptB}`);
  const promptA = formatFactsForPrompt(A, { chatKey: GA });
  assert.ok(promptA.includes('修电脑'), 'A 群提示词里没有自己的群内事实');
});

ok('⑥ 重复提及会补上缺失的 source/scope（老数据自愈）', () => {
  resetFactsCache();
  const B = '20002';
  rememberFact(B, `${B}不爱吃香菜`);                      // 老数据：没有 source
  rememberFact(B, `${B}不爱吃香菜`, { source: GB, scope: SCOPES.GROUP });
  const rows = listFacts(B, { chatKey: GB });
  assert.equal(rows.length, 1, '重复提及不该新增条目');
  assert.equal(rows[0].scope, SCOPES.GROUP, '重复提及没补 scope');
});

ok('⑦ 老格式（字符串数组）仍能解析 —— 向后兼容', () => {
  const out = parseExtraction('{"facts":["小明对花生过敏"]}', { name: '小明' });
  assert.deepEqual(out, ['小明对花生过敏']);
});

ok('⑧ 新格式带 scope', () => {
  const out = parseExtractionDetailed('{"facts":[{"text":"小明每周三晚打羽毛球","scope":"person"},{"text":"小明说本群周日晚开黑","scope":"group"}]}', { name: '小明' });
  assert.equal(out.length, 2);
  assert.equal(out[0].scope, 'person');
  assert.equal(out[1].scope, 'group');
});

ok('⑨ 模型没给 scope 时按关键词兜底猜（群规类 → group）', () => {
  const out = parseExtractionDetailed('{"facts":["小明说群里以后都十点后禁言"]}', { name: '小明' });
  assert.equal(out[0].scope, 'group');
  const out2 = parseExtractionDetailed('{"facts":["小明养了两只猫"]}', { name: '小明' });
  assert.equal(out2[0].scope, 'person', '拿不准时应该保守当 person');
});

ok('⑨b 格式坏掉 → 返回空数组，绝不编造', () => {
  assert.deepEqual(parseExtractionDetailed('模型抽风了', { name: '小明' }), []);
  assert.deepEqual(parseExtractionDetailed('{"facts": "不是数组"}', { name: '小明' }), []);
});

ok('⑩ 提取提示词里必须写明 scope 规则（否则模型永远不写 scope）', () => {
  const p = buildExtractionPrompt({ name: '小明', who: '20001', lines: ['小明：hi'] });
  assert.ok(p.includes('"scope"'), '提示词里没有 scope 字段');
  assert.ok(p.includes('group'), '提示词没解释 group 是什么');
  assert.ok(p.includes('别人说的事'), '提示词没写"别人说的事不要记"');
});

// ── 遗忘：以前这两件事写好了却没人调用 ──────────────────────────────

ok('⑪ decayFacts：50 天掉 1.0（半衰期思路，增量记账不重复扣）', () => {
  resetFactsCache();
  const C = '20003';
  const t0 = Date.now() - 50 * DAY;
  // 从 2.0 起扣：如果只从 1.0 起扣，扣到 0 之后就分不清"没重复扣"和"扣到地板"了
  rememberFact(C, `${C}以前用过安卓`, { now: t0, weight: 2 });
  assert.equal(listFacts(C, { limit: 1 })[0].weight, 2);
  // 第一次：50 天 × 0.02 = 1.0 → 2.0 掉到 1.0
  decayFacts({ ratePerDay: 0.02, now: Date.now() });
  const w1 = listFacts(C, { limit: 1 })[0].weight;
  assert.ok(Math.abs(w1 - 1) < 0.05, `50 天应掉 1.0（2→1），实际 ${w1}`);
  // 第二次（同一时刻）：已经记账到"今天"，天数=0 → 不能再扣
  decayFacts({ ratePerDay: 0.02, now: Date.now() });
  const w2 = listFacts(C, { limit: 1 })[0].weight;
  assert.ok(Math.abs(w2 - 1) < 0.05, `重复扣费了（应为 1.0，实际 ${w2}）—— updatedAt 没推进`);
});

ok('⑫ 重复提及能把权重强化回来（上限 2.0）', () => {
  resetFactsCache();
  const D = '20004';
  for (let i = 0; i < 10; i += 1) rememberFact(D, `${D}在准备考研`);
  const w = listFacts(D, { limit: 1 })[0].weight;
  assert.equal(w, MAX_WEIGHT, `应封顶在 ${MAX_WEIGHT}，实际 ${w}`);
});

ok('⑬ forgetWeakFacts：淡出的走、雷点/规则留（2026-10-29 起淡出=休眠）', () => {
  resetFactsCache();
  const E = '20005';
  const long = Date.now() - 60 * DAY;
  rememberFact(E, `${E}随口提过想学吉他`, { now: long, weight: 0.5 });   // 60 天后 → 0
  rememberFact(E, `${E}对芒果过敏`, { now: long, weight: 0.4, kind: 'negative' });
  decayFacts({ ratePerDay: 0.02, now: Date.now() });
  const { dormant } = forgetWeakFacts({ minWeight: 0.3 });
  const left = listFacts(E, { limit: 10 }).map((f) => f.text).join('\n');
  assert.ok(dormant >= 1, '该休眠的没休眠');
  assert.ok(!left.includes('吉他'), `弱事实没淡出：${left}`);
  assert.ok(left.includes('芒果'), '雷点（negative）被误删了');
});

ok('⑭ 凭据永远不落盘（回归）', () => {
  const G = '20006';
  const r = rememberFact(G, `${G}的 key 是 sk-abcdefghi${'jklmnopqrstu'}${'vwxyz'}`);
  assert.equal(r.ok, false);
  assert.equal(factCount(G), 0);
});

ok('⑮ loadAllFacts：每日维护前能把盘上所有人都装进缓存', () => {
  // 模拟重启：缓存清空，但磁盘上躺着好几个人的文件
  resetFactsCache();
  const loaded = F.loadAllFacts();
  assert.ok(loaded >= 5, `只载入了 ${loaded} 人，衰减会漏掉没被 @ 过的人`);
  // 载入后再衰减，盘上的弱事实才会真的被淡出（这里只验"能读到人"，不重复验衰减算法）
  assert.equal(F.loadAllFacts(), 0, '第二次不该重复载入');
});

// ── kind：核心项（雷点/规矩）通道（P4.2，2026-10-26）────────────────────
// 起因：102 条生产事实里 rule/negative 是 **0** —— 提示词只让模型输出 {text,scope}，
// 于是"不衰减/优先占位/永不删"三条保护一次都没触发过。
const kindOf = (list, text) => list.find((x) => x.text.includes(text))?.kind;

ok('⑯ 提取结果能带 kind，非法值一律归 fact', () => {
  const raw = JSON.stringify({
    facts: [
      { text: '张三对花生过敏', scope: 'person', kind: 'negative' },
      { text: '张三今年大三', scope: 'person', kind: 'fact' },
      { text: '张三讨厌被叫小张', scope: 'person', kind: 'whatever' }
    ]
  });
  const out = parseExtractionDetailed(raw, { name: '张三' });
  assert.equal(kindOf(out, '花生过敏'), 'negative');
  assert.equal(kindOf(out, '今年大三'), 'fact');
  assert.equal(kindOf(out, '被叫小张'), 'fact', '不认识的 kind 必须降级，不许原样带进库');
});

ok('⑰ 老格式（纯字符串数组）照样解析，kind 默认 fact', () => {
  const out = parseExtractionDetailed('{"facts": ["张三住在西安"]}', { name: '张三' });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'fact');
});

ok('⑱ ★ 核心项占比封顶：滥标 negative 会被降级回 fact', () => {
  // 模型想"求别丢"把所有条都标 negative —— 全豁免衰减 = 全都不衰减，等于没有保护。
  // 注意 MAX_FACTS_PER_EXTRACT=3，一批最多解析 3 条。
  // 2026-10-30：占位文本从"张三a"换成两字词 —— 弱句闸门上线后单字后缀会被当纯应答丢弃
  //（那正是闸门该干的活），占位数据必须长到能通过它。
  const raw = JSON.stringify({
    facts: [
      { text: '张三喜欢下棋', kind: 'negative' }, { text: '张三喜欢跑步', kind: 'negative' },
      { text: '张三喜欢看书', kind: 'negative' }, { text: '张三喜欢唱歌', kind: 'negative' }
    ]
  });
  const out = parseExtractionDetailed(raw, { name: '张三' });
  assert.equal(out.length, 3, '每批上限 3 条');
  const core = out.filter((f) => f.kind !== 'fact');
  assert.equal(core.length, 2, `核心项该被压到 ceil(3/2)=2，实际 ${core.length}`);
  assert.ok(out.every((f) => f.text), '降级不许丢内容');
});

ok('⑲ ★ 雷点/规矩不衰减（以前只写在注释里，代码无差别衰减）', () => {
  resetFactsCache();
  const qq = '900001';
  rememberFact(qq, '他对芒果过敏', { kind: 'negative', now: Date.now() - 60 * 86400000 });
  rememberFact(qq, '他住在西安', { kind: 'fact', now: Date.now() - 60 * 86400000 });
  F.loadAllFacts();
  decayFacts({ ratePerDay: 0.02 });
  const rows = listFacts(qq, { limit: 10 });
  assert.equal(rows.find((r) => r.text.includes('芒果')).weight, 1, '雷点不该被衰减');
  assert.ok(rows.find((r) => r.text.includes('西安')).weight < 0.5, '普通事实该掉下去');
});

ok('⑳ ★ 重复提及能把 fact 升级成 negative（只升不降）', () => {
  resetFactsCache();
  const qq = '900002';
  rememberFact(qq, '他讨厌开会', { kind: 'fact' });
  rememberFact(qq, '他讨厌开会', { kind: 'negative' });          // 这次才认出来是雷点
  assert.equal(listFacts(qq, { limit: 5 })[0].kind, 'negative', '该升上去');
  rememberFact(qq, '他讨厌开会', { kind: 'fact' });              // 模型这次没标
  assert.equal(listFacts(qq, { limit: 5 })[0].kind, 'negative', '不该被一次没标降级');
});

ok('㉑ forgetWeakFacts 同时保 negative 和 rule（普通弱事实转休眠，记录保留）', () => {
  resetFactsCache();
  const qq = '900003';
  const old = Date.now() - 400 * 86400000;
  rememberFact(qq, '他在戒烟', { kind: 'fact', weight: 0.1, now: old });
  rememberFact(qq, '别叫他老王', { kind: 'rule', weight: 0.1, now: old });
  rememberFact(qq, '他怕狗', { kind: 'negative', weight: 0.1, now: old });
  forgetWeakFacts({ minWeight: 0.3, qq });
  const texts = listFacts(qq, { limit: 10 }).map((r) => r.text).join('|');
  assert.ok(texts.includes('别叫他老王'), '规矩不该被删');
  assert.ok(texts.includes('怕狗'), '雷点不该被删');
  assert.ok(!texts.includes('在戒烟'), '普通弱事实该退出召回');
});

ok('㉒ 提取提示词写明 kind 三档，并警告别滥标', () => {
  const p = buildExtractionPrompt({ name: '张三', who: '10001', lines: ['[10:00] 张三：我对花生过敏'] });
  assert.ok(p.includes('"kind"'), '模板里得有 kind 字段');
  assert.ok(p.includes('negative') && p.includes('rule'), '两档都得点名');
  assert.ok(/冒犯|降级/.test(p), '得写清"只有真会冒犯才标"，否则模型全标 negative');
});

console.log(`\n[memory-scope] ${pass} 项通过`);
