// 工具名拼错复原（src/tool-name-hint.js）+ `executeTool` 接线。
//
// ── 这条为什么值得单独测 ───────────────────────────────────────────────
// 真实数据里出现过一次 `未知工具 get_ message_images`（名字里插了一个空格）。
// 模型意图完全正确、参数也对，但只拿到"未知工具"就放弃了那一轮 ——
// 用户看到的是"它没理我"，而日志里只有一行"未知工具"。
//
// 所以这里钉的是三件事：
//   ① 差一点点（空格/下划线/大小写）必须能认出来；
//   ② 认不出来（完全不相干）时**绝不乱猜** —— 编一个不存在的名字比不猜更糟；
//   ③ 接线：executeTool 真的把这个提示当作错误回给模型，而不是继续只说"未知"。
import assert from 'node:assert/strict';

const { normalizeToolName, suggestToolName, describeToolSuggestion, editSimilarity } = await import('../src/tool-name-hint.js');
const { executeTool, buildToolDefs } = await import('../src/tools.js');

let pass = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); } catch (e) {
    failures.push(`${name}: ${e?.message ?? e}`);
    console.error('  ✗', name, '\n     ', e?.message ?? e);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('  ✓', name);
}

const TOOLS = [
  'send_message', 'send_sticker', 'get_message_images', 'send_image',
  'finish', 'load_tools', 'web_search', 'web_fetch', 'get_sticker_image'
];

console.log('[tool-name-hint]');

// ── 归一化 ──────────────────────────────────────────────────────────
await ok('空格 / 连字符 / 大小写都归一到同一个键', () => {
  const a = normalizeToolName('get_ message_images');
  const b = normalizeToolName('get_message_images');
  const c = normalizeToolName('getMessageImages');
  const d = normalizeToolName('get-message-images');
  assert.equal(a, b, '空格版必须与正确版相等');
  assert.equal(c, b, '驼峰版必须与下划线版相等');
  assert.equal(d, b, '连字符版必须与下划线版相等');
});

await ok('空值不炸', () => {
  assert.equal(normalizeToolName(undefined), '');
  assert.equal(normalizeToolName(null), '');
  assert.equal(normalizeToolName('   '), '');
});

// ── 精确归一化命中（最高优先级，不受 minScore 约束）──────────────────
await ok('多一个空格 → 认出来，且 via=normalized', () => {
  const s = suggestToolName('get_ message_images', TOOLS, {});
  assert.equal(s?.name, 'get_message_images');
  assert.equal(s?.via, 'normalized');
  assert.equal(s?.score, 1);
});

await ok('大小写不同 → 认出来', () => {
  const s = suggestToolName('Send_Message', TOOLS, {});
  assert.equal(s?.name, 'send_message');
  assert.equal(s?.via, 'normalized');
});

await ok('少一个下划线 → 认出来', () => {
  const s = suggestToolName('sendmessage', TOOLS, {});
  assert.equal(s?.name, 'send_message');
});

// ── 不乱猜 ──────────────────────────────────────────────────────────
await ok('完全不相干的名字 → null（绝不编候选）', () => {
  assert.equal(suggestToolName('zzzzzz', TOOLS, {}), null);
  assert.equal(suggestToolName('', TOOLS, {}), null);
  assert.equal(suggestToolName('send_message', [], {}), null, '没有可用工具就没有候选');
});

await ok('已经正确的名字不算拼错（调用方先查表，这里返回 null）', () => {
  assert.equal(suggestToolName('send_message', TOOLS, {}), null);
});

await ok('不传 score 时只做归一化匹配（不做模糊）', () => {
  assert.equal(suggestToolName('zzzzzz', TOOLS), null);
  assert.equal(suggestToolName('sendmessage', TOOLS)?.name, 'send_message');
});

// ── 模糊相似度的门槛 ─────────────────────────────────────────────────
await ok('门槛必须高：send_sticker 不能被猜成 send_message', () => {
  // 这两个名字编辑距离很近，正是"门槛一松就误导"的典型。
  const s = suggestToolName('send_stickr', TOOLS, { minScore: 0.82 });
  // 归一化不等 → 落到模糊。编辑距离对 send_stickr/send_sticker 给 0.917。
  assert.equal(s?.name, 'send_sticker', `应猜 send_sticker，实际 ${s?.name}`);
});

await ok('模糊候选只取最高分，且必须过门槛', () => {
  // ⚠️ 这里必须用**首 token 能对上**的名字（`send_…`），否则会被首 token 硬闸先筛掉，
  //    测到的就不是"门槛"而是"闸门"了 —— 第一版用 'x' 就踩了这个坑。
  const s = suggestToolName('send_xxx', TOOLS, { score: () => 0.1 });
  assert.equal(s, null, '全部低于门槛 → 不猜');
  const s2 = suggestToolName('send_xxx', TOOLS, { score: () => 0.95 });
  assert.ok(s2, '过门槛 → 应给出一个（分最高的那个）');
  assert.equal(s2.score, 0.95);
});

await ok('首 token 不同 → 绝不跨动作族乱猜（哪怕分数很高）', () => {
  // `web_xxx` 与 `send_message` 的编辑距离可能不低，但动作族完全不同，
  // 猜错会让模型去发一条消息 —— 比不猜糟得多。
  const s = suggestToolName('web_xxx', TOOLS, { score: () => 0.99 });
  assert.ok(s, 'web_ 族里有候选');
  assert.ok(String(s.name).startsWith('web_'), `只能猜 web_ 族，实际 ${s.name}`);
});

await ok('score 抛错不会把整个提示搞崩', () => {
  const s = suggestToolName('zzz', TOOLS, { score: () => { throw new Error('boom'); } });
  assert.equal(s, null);
});

// ── 文案 ────────────────────────────────────────────────────────────
await ok('提示里点名了正确工具，并说明"改用它重试"', () => {
  const s = suggestToolName('get_ message_images', TOOLS, {});
  const text = describeToolSuggestion('get_ message_images', s);
  assert.match(text, /没有叫「get_ message_images」的工具/);
  assert.match(text, /`get_message_images`/);
  assert.match(text, /改用它重试/);
});

await ok('没有候选时文案是空串（调用方照旧说"未知工具"）', () => {
  assert.equal(describeToolSuggestion('zzz', null), '');
});

// ── 接线：executeTool 真的把提示回给模型 ─────────────────────────────────
await ok('executeTool：拼错的名字 → isError 且带正确工具名', async () => {
  const defs = [
    { name: 'send_message', description: 'x', parameters: {}, async execute() { return { content: 'ok' }; } },
    { name: 'get_message_images', description: 'x', parameters: {}, async execute() { return { content: 'ok' }; } }
  ];
  const r = await executeTool(defs, {}, 'get_ message_images', '{}');
  assert.equal(r.isError, true);
  assert.match(r.content, /你是想调 `get_message_images`/);
  assert.doesNotMatch(r.content, /^错误：未知工具/);
});

await ok('executeTool：完全未知的名字 → 照旧"未知工具"（不编候选）', async () => {
  const defs = [
    { name: 'send_message', description: 'x', parameters: {}, async execute() { return { content: 'ok' }; } }
  ];
  const r = await executeTool(defs, {}, 'totally_unknown_tool', '{}');
  assert.equal(r.isError, true);
  assert.match(r.content, /^错误：未知工具 totally_unknown_tool/);
});

await ok('executeTool：正确名字照旧正常执行（修复不能影响正常路径）', async () => {
  const defs = [
    { name: 'send_message', description: 'x', parameters: {}, async execute() { return { content: 'sent' }; } }
  ];
  const r = await executeTool(defs, {}, 'send_message', '{}');
  assert.equal(r.isError, undefined);
  assert.equal(r.content, 'sent');
});

await ok('真实工具集里也能认出那个历史错名', async () => {
  const real = buildToolDefs().map((d) => d.name);
  const r = await executeTool(buildToolDefs(), {}, 'get_ message_images', '{}');
  assert.equal(r.isError, true);
  assert.match(r.content, /get_message_images/);
  assert.ok(real.includes('get_message_images'));
});

console.log(`\n[tool-name-hint] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
