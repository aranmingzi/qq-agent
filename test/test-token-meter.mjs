// token 感知自测（2026-10-31，P0-1，学自 AstrBot 的"上下文用量超过窗口 82% 才压缩"）。
//
// 这个仓库以前**全仓没有 contextWindow 概念**：所有上限都是字符数
// （SYSTEM_TOTAL_MAX=20000 / USER_TOTAL_MAX=16000），到期就静默截断，
// 而模型窗口是 8K 还是 1M 我们一无所知。这一层补的就是"先知道用了多少"。
//
// 要钉住的：
//   ① 1 字符 ≈ 1 token（本仓中文为主，真机 13 个样本校准出来的，不是拍脑袋）；
//   ② 窗口未知时**不许乱压**（assumed=true → 永远不触发压缩），宁可不动也别误删上下文；
//   ③ 阈值判断用"已用 / 窗口"，并且要扣掉本轮还要留给输出的预算（reserveTokens）；
//   ④ 窗口元信息要从各家五花八门的字段名里捞出来（context_length / max_model_len / …）。
import assert from 'node:assert/strict';

const T = await import('../src/token-meter.js');

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

console.log('\n[token] 估算');

ok('① 中文 1 字符 ≈ 1 token，空值不给 NaN', () => {
  assert.equal(T.estimateTokens('你好世界'), 4);
  assert.equal(T.estimateTokens(''), 0);
  assert.equal(T.estimateTokens(null), 0);
  assert.equal(T.estimateTokens(undefined), 0);
  assert.equal(T.estimateTokens(123), 3);
});

ok('② charsPerToken 可调（给英文/日文模型留口子）', () => {
  // charsPerToken 是"多少字符算 1 token"的倒数关系：1.0 = 1 字 1 token
  assert.equal(T.estimateTokens('abcdefgh', { charsPerToken: 4 }), 2);
  assert.equal(T.estimateTokens('abcdefgh', { charsPerToken: 1 }), 8);
  // 脏值要兜住（0 / NaN / 负数都不该变成 Infinity 或 NaN）
  for (const bad of [0, -1, NaN, null, 'x']) {
    const got = T.estimateTokens('abcdefgh', { charsPerToken: bad });
    assert.ok(Number.isFinite(got) && got > 0, `charsPerToken=${bad} → ${got}`);
  }
});

ok('③ 单条消息带结构开销；tool_calls 与图片另算', () => {
  const bare = T.messageTokens({ role: 'user', content: '你好' });
  assert.ok(bare >= 2 + 4, `纯文本消息至少要算上角色开销，实际 ${bare}`);

  const calls = T.messageTokens({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"天气"}' } }]
  });
  assert.ok(calls > bare, '带 tool_calls 的消息必须比纯文本消息贵');

  const withImage = T.messageTokens({
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:...' } }]
  });
  const withoutImage = T.messageTokens({ role: 'user', content: [{ type: 'text', text: '看图' }] });
  assert.ok(withImage - withoutImage >= 700, `图片块要按 ~800 计，差 ${withImage - withoutImage}`);
});

ok('④ messagesTokens 是逐条之和', () => {
  const msgs = [
    { role: 'system', content: 'x'.repeat(100) },
    { role: 'user', content: 'y'.repeat(50) },
    { role: 'assistant', content: 'z'.repeat(30) }
  ];
  const sum = msgs.reduce((n, m) => n + T.messageTokens(m), 0);
  assert.equal(T.messagesTokens(msgs), sum);
  assert.equal(T.messagesTokens([]), 0);
  assert.equal(T.messagesTokens(null), 0);
});

console.log('\n[token] 用量与阈值');

ok('⑤ windowUsageOf：比例与剩余，窗口未知时标 assumed', () => {
  const u = T.windowUsageOf({ promptChars: 82000, contextWindow: 100000 });
  assert.equal(u.tokens, 82000);
  assert.equal(u.window, 100000);
  assert.ok(Math.abs(u.ratio - 0.82) < 1e-9);
  assert.equal(u.assumed, false);
  assert.equal(u.free, 18000);

  const unknown = T.windowUsageOf({ promptChars: 82000, contextWindow: 0 });
  assert.equal(unknown.assumed, true, '没窗口就必须标 assumed');
  // 假设窗口下仍然要给出一个**有限的**比例（日志里要能打印"按 128K 估，用了 64%"），
  // 但绝不可能是 Infinity/NaN —— 那会让 describeUsage 打出 "Infinity%"。
  assert.ok(Number.isFinite(unknown.ratio), `assumed 时比例必须有限，实际 ${unknown.ratio}`);
  assert.equal(unknown.window, T.FALLBACK_WINDOW);
});

ok('⑥ reserveTokens 要扣掉（那是留给输出的，不能算进可用空间）', () => {
  const withReserve = T.windowUsageOf({ promptChars: 80000, contextWindow: 100000, reserveTokens: 1200 });
  assert.equal(withReserve.free, 20000 - 1200);
  assert.equal(withReserve.ratio, withReserve.tokens / withReserve.window, '比例仍按"已用/窗口"算，不因 reserve 变');
});

ok('⑦ shouldCompact：过阈值才压，窗口未知永远不压', () => {
  const at82 = T.windowUsageOf({ promptChars: 82000, contextWindow: 100000 });
  assert.equal(T.shouldCompact(at82), true);
  const at81 = T.windowUsageOf({ promptChars: 81000, contextWindow: 100000 });
  assert.equal(T.shouldCompact(at81), false);
  const unknown = T.windowUsageOf({ promptChars: 999999, contextWindow: 0 });
  assert.equal(T.shouldCompact(unknown), false, '不知道窗口就绝不压缩 —— 这是本模块最重要的纪律');
  assert.equal(T.shouldCompact(at82, { enabled: false }), false, '灰度开关');
  assert.equal(T.shouldCompact(at82, { threshold: 0.95 }), false, '阈值可调');
  assert.equal(T.shouldCompact(null), false);
});

ok('⑧ 直接给 promptTokens 也行（真机 usage 回来时用它更准）', () => {
  const u = T.windowUsageOf({ promptTokens: 50000, contextWindow: 100000 });
  assert.equal(u.tokens, 50000);
  assert.ok(Math.abs(u.ratio - 0.5) < 1e-9);
});

console.log('\n[token] 展示与窗口发现');

ok('⑨ describeUsage / formatTokens', () => {
  const u = T.windowUsageOf({ promptChars: 82000, contextWindow: 100000 });
  const s = T.describeUsage(u);
  assert.match(s, /82%/);
  assert.match(s, /8\.2万/);
  assert.match(T.describeUsage(u, '上下文'), /^上下文/);
  assert.equal(T.formatTokens(999), '999');
  assert.equal(T.formatTokens(124000), '12.4万');
  assert.equal(T.formatTokens(0), '0');
  assert.ok(T.describeUsage(T.windowUsageOf({ promptChars: 1, contextWindow: 0 })).length > 0, 'assumed 也得能打印');
});

ok('⑩ pickContextWindow 从各家字段名里捞窗口', () => {
  assert.equal(T.pickContextWindow({ context_length: 131072 }), 131072);
  assert.equal(T.pickContextWindow({ contextWindow: 64000 }), 64000);
  assert.equal(T.pickContextWindow({ max_model_len: 32768 }), 32768);
  assert.equal(T.pickContextWindow({ max_context_length: 200000 }), 200000);
  assert.equal(T.pickContextWindow({ limits: { max_model_len: 8192 } }), 8192);
  assert.equal(T.pickContextWindow({ max_input_tokens: 99000 }), 99000);
  // 一个都没有 → 0，不许瞎猜
  assert.equal(T.pickContextWindow({ id: 'some-model' }), 0);
  assert.equal(T.pickContextWindow(null), 0);
  assert.equal(T.pickContextWindow('x'), 0);
  // 脏值不认
  assert.equal(T.pickContextWindow({ context_length: 'x' }), 0);
  assert.equal(T.pickContextWindow({ context_length: -5 }), 0);
});

ok('⑪ resolveContextWindow：手配优先（用户填了就以他为准）', () => {
  assert.equal(T.resolveContextWindow({ configured: 32768, discovered: 128000 }), 32768);
  assert.equal(T.resolveContextWindow({ configured: 0, discovered: 128000 }), 128000);
  assert.equal(T.resolveContextWindow({ configured: 0, discovered: 0 }), 0);
  assert.equal(T.resolveContextWindow({}), 0);
  assert.equal(T.resolveContextWindow({ configured: 'x', discovered: 5000 }), 5000);
});

ok('⑫ 默认值：阈值 0.82（与 AstrBot 实测值同档），1 字符 1 token', () => {
  assert.ok(Math.abs(T.COMPACT_THRESHOLD - 0.82) < 1e-9);
  assert.equal(T.CHARS_PER_TOKEN, 1.0);
  assert.ok(T.FALLBACK_WINDOW > 0);
});

console.log(`\n[token-meter] ${pass} 项通过`);
