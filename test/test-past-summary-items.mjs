// 往事摘要的「可寻址条目」自测（2026-10-31，P1-1/P1-2）。
//
// 断言围绕"为什么必须从整体重写改成增量编辑"：
//   ① 没被点名的条目**一个字都不能变** —— 这是 ACE 的 context collapse 防线；
//   ② 旧 id（内容已变 / 已被删）来改必须安全失败，不能顺手改错一条；
//   ③ 合并同类条目的真实动作（删几条 → 补一条汇总）必须能做对，不能留下重复；
//   ④ 来源（src）要能吃"删掉这几条消息"的传播，但**不能**连坐还有别的来源的条目；
//   ⑤ 超预算只在条目上丢，不改写正文，且承诺比事实活得久。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

// 必须赶在 import config.js 之前改数据目录，否则会写进生产数据
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-summary-items-'));

const {
  PastSummaryStore, itemsFromSummary, renderItems, itemIdOf,
  parseEdits, applyEdits, buildEditMessages, pruneItems, SUMMARY_SLOTS
} = await import('../src/past-summary.js');

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[past-summary-items]');

const SAMPLE = [
  '【谁在要什么】',
  '- 张三问周末还聚不聚',
  '【答应了什么】',
  '- 我说八点半叫李四'
].join('\n');

ok('摘要文本 → 条目：id 稳定、可渲染回原文', () => {
  const items = itemsFromSummary(SAMPLE);
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.deepEqual(items.map((i) => i.slot), ['asking', 'promised']);
  assert.equal(renderItems(items), SAMPLE, '条目渲染回去必须和原文逐字相同');
  // 同一句话无论解析多少次，id 都一样（内容寻址）
  assert.equal(itemsFromSummary(SAMPLE)[0].id, items[0].id);
  assert.ok(items[0].id.startsWith('asking:'));
});

ok('旧格式（平铺、无槽位标题）全部进 legacy，一条不少', () => {
  const items = itemsFromSummary('- 第一条\n- 第二条');
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.slot === 'legacy'));
  assert.equal(renderItems(items), '- 第一条\n- 第二条');
});

ok('没被点名的条目字字不变（整体重写的反面）', () => {
  const items = itemsFromSummary(SAMPLE);
  const keep = items[0];
  const r = applyEdits(items, [{ op: 'add', slot: 'decided', text: '定了周六三点' }]);
  const after = r.items.find((i) => i.id === keep.id);
  assert.ok(after, '老条目不该消失');
  assert.equal(after.text, keep.text, '老条目正文一个字都不该变');
  assert.equal(after.slot, keep.slot);
  assert.equal(r.added, 1);
});

ok('ADD 幂等：同一句话重复加只算一次', () => {
  const items = itemsFromSummary(SAMPLE);
  const r = applyEdits(items, [
    { op: 'add', slot: 'asking', text: '张三问周末还聚不聚' },
    { op: 'add', slot: 'asking', text: '张三问周末还聚不聚' }
  ]);
  assert.equal(r.added, 0, '已有的正文不该重复加');
  assert.equal(r.ignored, 2);
  assert.equal(r.items.length, 2);
});

ok('EDIT 改正文 → id 换新，拿旧 id 再改就是无效操作', () => {
  const items = itemsFromSummary(SAMPLE);
  const id = items[0].id;
  const r = applyEdits(items, [{ op: 'edit', id, text: '张三在等周末聚会的答复' }]);
  assert.equal(r.edited, 1);
  assert.equal(r.items[0].text, '张三在等周末聚会的答复');
  assert.notEqual(r.items[0].id, id, '内容变了 id 必须跟着变（内容寻址）');
  // 旧 id 已经不存在
  const again = applyEdits(r.items, [{ op: 'edit', id, text: '再改一次' }]);
  assert.equal(again.edited, 0);
  assert.equal(again.ignored, 1);
});

ok('REMOVE 不存在的 id → 静默忽略，不抛、不误删', () => {
  const items = itemsFromSummary(SAMPLE);
  const r = applyEdits(items, [{ op: 'remove', id: 'asking:deadbeef' }, { op: 'remove', id: '' }]);
  assert.equal(r.removed, 0);
  assert.equal(r.items.length, 2);
  assert.ok(r.ignored >= 2);
});

ok('★ 合并同类条目的真实动作：删几条 + 补一条汇总，不留重复', () => {
  const items = itemsFromSummary([
    '【谁在要什么】', '- 张三问周末还聚不聚', '- 李四问几点开始'
  ].join('\n'));
  const r = applyEdits(items, [
    { op: 'remove', id: items[0].id },
    { op: 'remove', id: items[1].id },
    { op: 'add', slot: 'asking', text: '张三、李四都在问周末聚会几点' }
  ]);
  assert.equal(r.removed, 2);
  assert.equal(r.added, 1);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, '张三、李四都在问周末聚会几点');
});

ok('先删除再 ADD 回同一句话：只留一条（不能既进又留）', () => {
  const items = itemsFromSummary(SAMPLE);
  const r = applyEdits(items, [
    { op: 'remove', id: items[1].id },
    { op: 'add', slot: 'promised', text: '我说八点半叫李四' }
  ]);
  assert.equal(r.items.length, 2);
  assert.equal(r.items.filter((i) => i.text === '我说八点半叫李四').length, 1);
});

ok('EDIT 撞上同槽位已存在的条目 → 丢掉重复的那条，不留两份', () => {
  const items = itemsFromSummary(['【谁在要什么】', '- 张三问周末还聚不聚', '- 李四问几点开始'].join('\n'));
  const r = applyEdits(items, [{ op: 'edit', id: items[1].id, text: '张三问周末还聚不聚' }]);
  assert.equal(r.items.length, 1, '改完和另一条一模一样，就该只剩一条');
  assert.equal(r.items[0].text, '张三问周末还聚不聚');
});

ok('EDIT 改到别的槽位已存在的正文 → 不合并（槽位不同 = 不同条目，各自留着）', () => {
  const items = itemsFromSummary(SAMPLE);
  const r = applyEdits(items, [{ op: 'edit', id: items[1].id, text: '张三问周末还聚不聚' }]);
  assert.equal(r.items.length, 2, 'id 含槽位，跨槽同文不算重复');
});

// ── 解析指令 ────────────────────────────────────────────────────────────
ok('解析三种指令（含全角竖线、方括号、中英动词）', () => {
  const e = parseEdits([
    'ADD 【定了什么】 | 定了周六下午三点',
    'EDIT asking:ab12 | 张三在等答复',
    'REMOVE promised:cd34',
    '- ADD 【谁在要什么】 | 李四在问路'
  ].join('\n'));
  assert.deepEqual(e.map((x) => x.op), ['add', 'edit', 'remove', 'add']);
  assert.equal(e[0].slot, 'decided');
  assert.equal(e[0].text, '定了周六下午三点');
  assert.equal(e[1].id, 'asking:ab12');
  assert.equal(e[1].text, '张三在等答复');
  assert.equal(e[2].id, 'promised:cd34');
  assert.equal(e[3].slot, 'asking');
});

ok('解析：不认识的动词/纯文本行一律不产生指令（宁可少做，不可乱做）', () => {
  assert.deepEqual(parseEdits('好的，以下是摘要：\n- 张三问周末'), []);
  assert.deepEqual(parseEdits('ADDITION 是个英文词'), [], 'ADDITION 不该被当成 ADD');
  assert.deepEqual(parseEdits('```\nADD 【定了什么】 | x\n```').length, 1, '代码块围栏本身不该被当成指令');
});

ok('未知槽位标题 → 落 legacy，不丢内容', () => {
  const e = parseEdits('ADD 【乱七八糟的标题】 | 一句话');
  assert.equal(e.length, 1);
  assert.equal(e[0].slot, 'legacy');
});

// ── store：provenance / dropEpisodes / 预算 ──────────────────────────────
ok('★ applyEdits 把本批消息 id 记到新条目上（来源，学自 Zep 的 provenance）', () => {
  const store = new PastSummaryStore();
  const key = 'group_items_src';
  const r = store.applyEdits(key, {
    edits: [{ op: 'add', slot: 'asking', text: '张三问周末还聚不聚' }],
    uptoId: 9,
    sources: [3, 4]
  });
  assert.equal(r.added, 1);
  assert.deepEqual(r.items[0].src, [3, 4]);
  // 第二批：老条目的来源不该被新批次的 id 污染
  const r2 = store.applyEdits(key, {
    edits: [{ op: 'add', slot: 'decided', text: '定了周六三点' }],
    uptoId: 12,
    sources: [9, 10]
  });
  const old = r2.items.find((i) => i.text === '张三问周末还聚不聚');
  assert.deepEqual(old.src, [3, 4], '老条目来源必须原样');
  const fresh = r2.items.find((i) => i.text === '定了周六三点');
  assert.deepEqual(fresh.src, [9, 10]);
});

ok('★ dropEpisodes：只删"唯一支撑被撤"的条目，还有别的来源就只摘掉那一条', () => {
  const store = new PastSummaryStore();
  const key = 'group_items_drop';
  store.applyEdits(key, {
    edits: [
      { op: 'add', slot: 'asking', text: '只有第 3 条撑着' },
      { op: 'add', slot: 'decided', text: '第 3、4 条都撑着' },
      { op: 'add', slot: 'happened', text: '第 4 条撑着' }
    ],
    uptoId: 9,
    sources: [3, 4]
  });
  // 手工把第二条的来源缩成只有 [3,4]，前面 applyEdits 给三条都标了 [3,4]
  const st = store.get(key);
  assert.equal(st.items.length, 3);
  const d = store.dropEpisodes(key, [3]);
  // 三条都还有 4 撑着 → 一条都不该删，只是 src 里少个 3
  assert.equal(d.removed, 0, JSON.stringify(d.items.map((i) => i.src)));
  assert.ok(d.items.every((i) => Array.isArray(i.src) && i.src.length === 1 && i.src[0] === 4));
  // 再撤 4 → 全都没支撑了，全删
  const d2 = store.dropEpisodes(key, [4]);
  assert.equal(d2.removed, 3);
  assert.equal(d2.items.length, 0);
});

ok('dropEpisodes：没有来源信息的老条目一律不动（不知道来源就别猜着删）', () => {
  const store = new PastSummaryStore();
  const key = 'group_items_legacy';
  store.commit(key, { summary: '- 老条目一\n- 老条目二', uptoId: 3 });
  const d = store.dropEpisodes(key, [3, 4, 5]);
  assert.equal(d.removed, 0);
  assert.equal(d.items.length, 2);
});

ok('★ 超预算只在条目上丢：每槽限额优先，事实最先死', () => {
  const items = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `asking:${i}`, slot: 'asking', text: `第${i + 1}个人问东问西` })),
    { id: 'promised:x', slot: 'promised', text: '我答应了八点半叫李四' },
    { id: 'happened:y', slot: 'happened', text: '王五发了个表情包' }
  ];
  const out = pruneItems(items, { maxLines: 6, maxChars: 800, perSlotMax: 2 });
  assert.equal(out.filter((i) => i.slot === 'asking').length, 2, '每槽 2 条');
  assert.ok(out.some((i) => i.text === '我答应了八点半叫李四'), '承诺必须活');
  // 字数紧张时按 SLOT_DROP_ORDER 丢：happened 第一个死（既有语义，与 normalizeSlots 一致）。
  // 注意 capChars 有 120 的下限（与 formatPrompt 一致），正文要足够长才会触发淘汰。
  const fat = [
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `asking:f${i}`, slot: 'asking',
      text: `第${i + 1}个人在问一件非常麻烦而且还没说清楚的事情`
    })),
    { id: 'promised:x', slot: 'promised', text: '我答应了八点半叫李四起床别忘了' },
    { id: 'happened:y', slot: 'happened', text: '王五发了个表情包' }
  ];
  const tight = pruneItems(fat, { maxLines: 20, maxChars: 120, perSlotMax: 0 });
  const joined = tight.map((i) => i.text).join('\n');
  assert.ok(!joined.includes('王五发了个表情包'), '事实先丢：' + joined);
  assert.ok(joined.includes('我答应了八点半叫李四起床别忘了'), '承诺必须活：' + joined);
  assert.ok(tight.length >= 1, '不能把自己裁空');
});

ok('pruneItems 不动正文（不切半句），超到只剩一条才截断且带省略号', () => {
  // capChars 有 120 的下限（与 formatPrompt 一致），传 50 也按 120 算
  const out = pruneItems(
    [{ id: 'asking:a', slot: 'asking', text: '甲'.repeat(300) }],
    { maxLines: 8, maxChars: 50, perSlotMax: 0 }
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].text.length <= 120, String(out[0].text.length));
  assert.ok(out[0].text.endsWith('…'), '截断必须带省略号，不能看起来像说完了');
  // 装得下的正文一个字都不动
  const small = pruneItems([{ id: 'asking:b', slot: 'asking', text: '短句' }], { maxChars: 800 });
  assert.equal(small[0].text, '短句');
});

ok('store.applyEdits 端到端：条目 → 渲染 → 落盘重读，全部一致', () => {
  const store = new PastSummaryStore();
  const key = 'group_items_e2e';
  store.applyEdits(key, {
    edits: [
      { op: 'add', slot: 'asking', text: '张三问周末还聚不聚' },
      { op: 'add', slot: 'promised', text: '我答应八点半叫李四' }
    ],
    uptoId: 20,
    sources: [18, 19]
  });
  const fresh = new PastSummaryStore();
  const got = fresh.get(key);
  assert.equal(got.items.length, 2);
  assert.equal(got.uptoId, 20);
  assert.deepEqual(got.items.map((i) => i.src), [[18, 19], [18, 19]]);
  assert.equal(got.summary, renderItems(got.items));
  assert.ok(got.summary.includes('【谁在要什么】') && got.summary.includes('【答应了什么】'));
});

ok('store.commit（老路径）也会把 summary 解析成 items，两条路径共享真源', () => {
  const store = new PastSummaryStore();
  const key = 'group_items_commit';
  store.commit(key, { summary: SAMPLE, uptoId: 5 });
  const st = store.get(key);
  assert.equal(st.items.length, 2);
  // 接着用增量编辑，老条目照样可寻址
  const r = store.applyEdits(key, { edits: [{ op: 'remove', id: st.items[0].id }], uptoId: 8 });
  assert.equal(r.removed, 1);
  assert.ok(!r.summary.includes('张三问周末还聚不聚'));
  assert.ok(r.summary.includes('我说八点半叫李四'));
});

ok('reset 连 items 一起清（否则下次编辑会拿旧 id 对不上）', () => {
  const store = new PastSummaryStore();
  const key = 'group_items_reset';
  store.applyEdits(key, { edits: [{ op: 'add', slot: 'asking', text: '一句话' }], uptoId: 3 });
  const r = store.reset(key);
  assert.equal(r.items.length, 0);
  assert.equal(r.summary, '');
  assert.equal(r.uptoId, 0);
});

// ── 编辑请求的提示词 ────────────────────────────────────────────────────
ok('编辑请求：带 id、带槽位清单、明确"不许重写整份"', () => {
  const items = itemsFromSummary(SAMPLE);
  const msgs = buildEditMessages({ items, lines: ['[10:00] 张三：周末还聚吗'], maxLines: 6, maxChars: 500 });
  const sys = msgs[0].content;
  const user = msgs[1].content;
  assert.ok(sys.includes('不能重写整份摘要'), sys);
  assert.ok(sys.includes('ADD') && sys.includes('EDIT') && sys.includes('REMOVE'));
  for (const s of SUMMARY_SLOTS) assert.ok(user.includes(s.title), `缺槽位「${s.title}」`);
  for (const it of items) assert.ok(user.includes(`[${it.id}]`), `缺条目 id ${it.id}`);
  assert.ok(user.includes('张三：周末还聚吗'), '新材料必须在');
  assert.ok(user.includes('最多 6 条') && user.includes('不超过 500 字'));
  assert.ok(user.includes('是谁'), '必须要求写清是谁说的');
});

ok('编辑请求：没有旧条目时写"（无）"，不留空段落', () => {
  const user = buildEditMessages({ items: [], lines: ['[10:00] 张三：在吗'] })[1].content;
  assert.ok(user.includes('（无）'));
});

ok('编辑请求：perSlotMax 开关只影响"每块上限"那句', () => {
  const on = buildEditMessages({ items: [], lines: ['x'], perSlotMax: 3 })[1].content;
  assert.ok(on.includes('每块最多 3 条'));
  assert.ok(on.includes('合并成一条'));
  const off = buildEditMessages({ items: [], lines: ['x'], perSlotMax: 0 })[1].content;
  assert.ok(!off.includes('每块最多'), '关了就不该提每块上限（否则和 maxLines 打架）');
});

console.log(`\n[past-summary-items] ${pass} 项通过`);
try { fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ }
