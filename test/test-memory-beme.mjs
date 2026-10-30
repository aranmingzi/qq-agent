// dsh-beme 四样借鉴的自测（2026-10-30，配套 docs/dsh-beme借鉴评估-2026-10-30.md）：
//   ② 提取禁令：四条规则进提示词 + 解析层弱句闸门
//   ③ 四态出口：没记到就说没记到（不再让模型对着空档案编）
//   ④ 隐私护栏：查询像打听 × 内容含敏感 → 注入规矩句而非原文
//   ① 版本链：content_hash / supersedes / origin 血统 / 被替代条退出召回
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-beme-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const F = await import('../src/memory-facts.js');
const {
  rememberFact, listFacts, formatFactsForPrompt, resetFactsCache, factCount,
  listAllFactsRaw, buildExtractionPrompt, parseExtractionDetailed, isWeakUtterance,
  findConflict, privacyGuardHit, decayFacts
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

const QQ = '30001';
const fresh = () => resetFactsCache();

console.log('\n[beme②] 提取禁令');

ok('②a 提示词带四条规则（一事一条/玩笑反讽/原话口气/叫法归一）', () => {
  const p = buildExtractionPrompt({ name: '小明', who: QQ, lines: ['小明：我明天就把你卖了'] });
  assert.ok(p.includes('只写一件事'), '缺"一条只写一件事"');
  assert.ok(p.includes('玩笑、反讽、气话'), '缺玩笑反讽禁令');
  assert.ok(p.includes('宁可少记一条'), '缺宁缺毋滥表述');
  assert.ok(p.includes('不改写成书面语'), '缺保留原话口气');
  assert.ok(p.includes('不同叫法'), '缺叫法归一');
  assert.ok(p.includes('嗯/哦/行'), '缺弱句不语料');
});

ok('②b 弱句闸门：纯应答/单字/纯标点被解析层丢弃', () => {
  const out = parseExtractionDetailed(
    JSON.stringify({ facts: [
      { text: '小明嗯嗯', scope: 'person' },
      { text: '小明对花生过敏', scope: 'person' },
      { text: '小明住在杭州', scope: 'person' }
      // 注：MAX_FACTS_PER_EXTRACT=3，弱句必须放在配额内测；第 4 条起会被截断，测不到
    ] }),
    { name: '小明' }
  );
  const texts = out.map((x) => x.text);
  assert.ok(!texts.some((t) => t.includes('嗯嗯')), '纯应答漏过去了');
  assert.ok(texts.includes('小明对花生过敏'), '真事实被误杀');
  assert.ok(texts.includes('小明住在杭州'), '真事实被误杀');
  // 纯语气单独再测一批（不受配额挤压）
  const out2 = parseExtractionDetailed(
    JSON.stringify({ facts: [{ text: '小明哈哈' }, { text: '小明说好' }] }),
    { name: '小明' }
  );
  assert.equal(out2.length, 0, '纯语气批没被清空');
});

ok('②c isWeakUtterance 边界（真承诺不误杀）', () => {
  assert.equal(isWeakUtterance('小明嗯嗯', '小明'), true);
  assert.equal(isWeakUtterance('小明？？', '小明'), true);
  assert.equal(isWeakUtterance('小明', '小明'), true);
  assert.equal(isWeakUtterance('小明ok', '小明'), true);
  assert.equal(isWeakUtterance('小明答应周四交报告', '小明'), false, '真承诺被误杀');
  assert.equal(isWeakUtterance('小明说周四交报告', '小明'), false, '过程陈述被误杀');
});

console.log('\n[beme③] 没记到就说没记到');

ok('③a 有 query、有档案、无相关事实 → 注入"没记到"定位句（空库或偏题两种文案）', () => {
  fresh();
  rememberFact('30103', '小明爱喝奶茶', { weight: 1 });
  const text = formatFactsForPrompt('30103', { query: '你喜欢什么游戏', limit: 8 });
  const isLocator = text.includes('没有与这句话相关的记录') || text.includes('没有与这句话直接相关的记录');
  assert.ok(isLocator, `缺定位句：${text}`);
  assert.ok(text.includes('别顺着编') || text.includes('别拿不相关的旧事顶'), '缺"别编"指令');
});

ok('③b 陌生人（无档案）+ query → 仍然空串（不每轮背定位句）', () => {
  fresh();
  assert.equal(formatFactsForPrompt('99909', { query: '你喜欢什么' }), '');
});

ok('③c 无 query → 保持旧行为（空 = 空串，有 = 正常段）', () => {
  fresh();
  assert.equal(formatFactsForPrompt('30104', {}), '');
  rememberFact('30104', '小明爱喝奶茶', { weight: 1 });
  const text = formatFactsForPrompt('30104', {});
  assert.ok(text.includes('爱喝奶茶'));
  assert.ok(!text.includes('没有与这句话相关'), '无 query 不该出定位句');
});

console.log('\n[beme④] 隐私护栏');

ok('④a 打听式 query × 敏感内容 → 整段换规矩句，原文不出上下文', () => {
  fresh();
  rememberFact(QQ, '小明家住幸福小区3栋', { weight: 1.5 });
  rememberFact(QQ, '小明爱喝奶茶', { weight: 1 });
  const text = formatFactsForPrompt(QQ, { query: '他家住哪啊，能不能告诉我', limit: 8 });
  assert.ok(text.includes('不复述') || text.includes('不便说'), `缺规矩句：${text}`);
  assert.ok(!text.includes('幸福小区'), '原文泄漏进了上下文');
});

ok('④b 普通查询 × 敏感内容 → 正常注入（护栏只在打听时上）', () => {
  fresh();
  rememberFact(QQ, '小明家住幸福小区3栋', { weight: 1.5 });
  const text = formatFactsForPrompt(QQ, { query: '他住哪个区来着', limit: 8 });
  assert.ok(text.includes('幸福小区'), '自己人正常问也被拦了');
});

ok('④c privacyGuardHit 纯函数边界', () => {
  assert.equal(privacyGuardHit('能不能告诉大家', ['小明住在杭州']), false, '无敏感内容不该命中');
  assert.equal(privacyGuardHit('今天天气如何', ['小明手机号是138']), false, '非打听不该命中');
  assert.equal(privacyGuardHit('把他的地址发到群里', ['小明住幸福小区']), true);
});

console.log('\n[beme①] 版本链');

// 版本链一组用独立 QQ（磁盘状态跨用例泄漏：resetFactsCache 只清内存，同 QQ 的 JSON 还在）
const Q1 = '31001', Q2 = '31002', Q3 = '31003', Q4 = '31004', Q5 = '31005', Q6 = '31006';

ok('①a 冲突检测：同主语同宾语域的新说法被识别', () => {
  fresh();
  rememberFact(Q1, '小明住在杭州', { weight: 1.2 });
  const old = listAllFactsRaw(Q1).find((f) => f.text.includes('杭州'));
  const r = rememberFact(Q1, '小明搬到上海住了', { weight: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.record.supersedes, '新条没带 supersedes');
  assert.equal(r.record.supersedes, old.id);
  const raw = listAllFactsRaw(Q1);
  const oldNow = raw.find((f) => f.id === old.id);
  assert.equal(oldNow.supersededAt > 0, true, '旧条没打被替代标记');
  assert.equal(oldNow.supersededBy, r.record.id);
});

ok('①b 被替代条退出召回：矛盾说法不再并出', () => {
  const rows = listFacts(Q1, { limit: 8 });
  assert.ok(rows.some((f) => f.text.includes('上海')), '新条不在');
  assert.ok(!rows.some((f) => f.text.includes('杭州')), '被替代条还在召回里');
});

ok('①c origin 血统继承：替代链可回答"这事多久了"', () => {
  const rec = listAllFactsRaw(Q1).find((f) => f.text.includes('上海'));
  assert.ok(rec.origin, '没继承 origin');
  assert.ok(rec.originAt > 0 && rec.originAt <= Date.now());
  // origin 指向最初那条（或它自己）
  const originOne = listAllFactsRaw(Q1).find((f) => f.id === rec.origin);
  assert.ok(originOne || rec.origin === rec.id);
});

ok('①d content_hash 落盘且读回（幂等层的地基）', () => {
  fresh();
  const r = rememberFact(Q2, '小明生日是三月七号', {});
  assert.ok(r.record.hash, '新条没算 hash');
  // 重新载入（模拟重启）
  resetFactsCache();
  const back = listAllFactsRaw(Q2).find((f) => f.id === r.record.id);
  assert.ok(back, '重启后丢了');
});

ok('①e 无冲突的新事实照常落库（不误分流）', () => {
  fresh();
  rememberFact(Q3, '小明对花生过敏', { weight: 1 });
  rememberFact(Q3, '小明爱打乒乓球', { weight: 1 });
  assert.equal(factCount(Q3), 2, '不相关事实被误判成冲突');
});

ok('①f 被替代条被重提：不复活、强化不到它（归档重读防线）', () => {
  fresh();
  rememberFact(Q4, '小明住在杭州', { weight: 1.2 });
  rememberFact(Q4, '小明搬到上海住了', { weight: 1 });
  const before = listAllFactsRaw(Q4).find((f) => f.text.includes('杭州'));
  rememberFact(Q4, '小明住在杭州', { weight: 2 });
  const after = listAllFactsRaw(Q4).find((f) => f.text.includes('杭州') && f.id === before.id);
  assert.equal(after.weight, before.weight, '被替代条被强化了');
  assert.ok(listFacts(Q4, {}).every((f) => !f.text.includes('杭州')));
});

ok('①g 被替代条不衰减、不占容量（终态纪律同休眠/墓碑）', () => {
  fresh();
  rememberFact(Q5, '小明住在杭州', { weight: 1.2 });
  rememberFact(Q5, '小明搬到上海住了', { weight: 1 });
  const raw = listAllFactsRaw(Q5);
  const count0 = raw.length;
  decayFacts({ ratePerDay: 0.5, now: Date.now() });
  const raw2 = listAllFactsRaw(Q5);
  assert.equal(raw2.length, count0);
  const old = raw2.find((f) => f.text.includes('杭州'));
  const freshW = raw.find((f) => f.text.includes('杭州')).weight;
  assert.equal(old.weight, freshW, '被替代条还在被衰减');
});

ok('①h findConflict 不看休眠/墓碑/candidate', () => {
  fresh();
  const { forgetWeakFacts } = F;
  rememberFact(Q6, '小明住在杭州', { weight: 0.1 });
  forgetWeakFacts({ minWeight: 0.3, qq: Q6 });
  // 休眠后再来一个不同说法：不应把休眠条当冲突对象（它已退场）
  const r = rememberFact(Q6, '小明搬到上海住了', { weight: 1 });
  assert.equal(r.record.supersedes, undefined, '休眠条被当成冲突对象了');
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
