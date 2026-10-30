// 工具结果清理自测（2026-10-31，P0-2，学自 Anthropic《Effective context engineering》：
// 「最轻的一种压缩就是 tool result clearing —— 深在历史里的工具原始结果没必要一直占着」）。
//
// 我们以前只在**当轮**截断（tool-result-budget：头 40% + 尾 60%），
// 一旦那轮进了历史，那几万字的原始结果就一直躺在 messages 里，每轮都要重发。
//
// 要钉住的：
//   ① 只清"深在历史里"的，最近 K 轮原文必须一个字不动（模型还要接着用它干活）；
//   ② 绝不能动 role / tool_call_id / name / 顺序 —— 动了后面那条 tool 消息就配不上 assistant 了；
//   ③ 占位符得说清"要的话重新取一次"，否则模型会当成"这个工具返回了空"；
//   ④ 入参数组不能被改（调用方可能在别处还拿着它），且重复清理不套娃。
import assert from 'node:assert/strict';

const T = await import('../src/tool-history.js');

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

/** 造一段真实形状的工具历史：system + user + N 轮 (assistant.tool_calls + tool)。 */
function history(rounds, { size = 1000, name = 'search' } = {}) {
  const msgs = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '帮我查点东西' }
  ];
  for (let i = 0; i < rounds; i += 1) {
    msgs.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name, arguments: `{"q":"第${i}问"}` } }]
    });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, name, content: 'x'.repeat(size) });
  }
  return msgs;
}

console.log('\n[工具历史] 切轮');

ok('① splitRounds：assistant.tool_calls + 紧随的 tool 算一轮，其余各自成轮', () => {
  const msgs = history(2);
  const rounds = T.splitRounds(msgs);
  // system, user, (assistant+tool), (assistant+tool)
  assert.equal(rounds.length, 4);
  assert.deepEqual(rounds[0], { start: 0, end: 1, toolIndexes: [] });
  assert.deepEqual(rounds[2], { start: 2, end: 4, toolIndexes: [3] });
  assert.deepEqual(rounds[3], { start: 4, end: 6, toolIndexes: [5] });
  // 覆盖完整、无空洞
  let cursor = 0;
  for (const r of rounds) {
    assert.equal(r.start, cursor, '轮之间不能有空洞');
    cursor = r.end;
  }
  assert.equal(cursor, msgs.length);
});

ok('② splitRounds 扛脏输入：空 / null / 无 tool_calls 的 assistant', () => {
  assert.deepEqual(T.splitRounds([]), []);
  assert.deepEqual(T.splitRounds(null), []);
  assert.deepEqual(T.splitRounds([{ role: 'user', content: 'x' }]), [{ start: 0, end: 1, toolIndexes: [] }]);
  assert.deepEqual(
    T.splitRounds([{ role: 'assistant', content: '纯回答' }]),
    [{ start: 0, end: 1, toolIndexes: [] }],
    '没有 tool_calls 的 assistant 不该被当成工具轮'
  );
  // tool_calls 是空数组也算没有
  assert.deepEqual(
    T.splitRounds([{ role: 'assistant', content: '', tool_calls: [] }]),
    [{ start: 0, end: 1, toolIndexes: [] }]
  );
});

console.log('\n[工具历史] 清理');

ok('③ 只清历史里的，最近 K 轮原文一字不动', () => {
  const msgs = history(4);
  const last = msgs[msgs.length - 1].content;
  const r = T.clearStaleToolResults(msgs, { keepRecentRounds: 2 });
  assert.equal(r.cleared, 2, `3 轮可用的情况下应清 2 条（4 轮 - 保留 2 轮 - 1 轮也不算？），实际 ${r.cleared}`);
  assert.equal(r.messages[r.messages.length - 1].content, last, '最近一轮被清了');
  assert.ok(r.savedChars > 0);
});

ok('④ role / tool_call_id / name / 顺序一个都不能变（变了配对就断了）', () => {
  const msgs = history(3);
  const r = T.clearStaleToolResults(msgs, { keepRecentRounds: 1 });
  assert.equal(r.messages.length, msgs.length, '条数变了');
  for (let i = 0; i < msgs.length; i += 1) {
    assert.equal(r.messages[i].role, msgs[i].role, `第 ${i} 条 role 变了`);
    if (msgs[i].tool_call_id) assert.equal(r.messages[i].tool_call_id, msgs[i].tool_call_id, `第 ${i} 条 tool_call_id 变了`);
    if (msgs[i].name) assert.equal(r.messages[i].name, msgs[i].name, `第 ${i} 条 name 丢了`);
    if (msgs[i].tool_calls) assert.deepEqual(r.messages[i].tool_calls, msgs[i].tool_calls, `第 ${i} 条 tool_calls 变了`);
  }
});

ok('⑤ 入参数组不能被改（调用方还拿着它）', () => {
  const msgs = history(3);
  const before = msgs.map((m) => m.content);
  T.clearStaleToolResults(msgs, { keepRecentRounds: 1 });
  assert.deepEqual(msgs.map((m) => m.content), before, '入参被就地改了');
  // 清出来的新数组是新对象，但未清理的消息允许共享引用（浅拷贝的应有之义）
  const r = T.clearStaleToolResults(msgs, { keepRecentRounds: 1 });
  assert.notEqual(r.messages, msgs, '应该返回新数组');
});

ok('⑥ 占位符说清"要的话重新取一次"（否则模型以为工具返回了空）', () => {
  const p = T.placeholderOf(1000, 'search');
  assert.match(p, /已清理/);
  assert.match(p, /search/);
  assert.match(p, /1000/);
  assert.match(p, /重新取/);
  const anon = T.placeholderOf(500);
  assert.match(anon, /500/);
  assert.ok(!anon.includes('「」'), '没名字时不该留个空引号');
});

ok('⑦ 重复清理不套娃（占位符不该越滚越长）', () => {
  const msgs = history(3);
  const once = T.clearStaleToolResults(msgs, { keepRecentRounds: 1 });
  const twice = T.clearStaleToolResults(once.messages, { keepRecentRounds: 1 });
  assert.equal(twice.cleared, 0, '第二次不该再清（也没有更大的东西可清了）');
  assert.equal(twice.savedChars, 0);
  assert.deepEqual(
    twice.messages.map((m) => m.content),
    once.messages.map((m) => m.content)
  );
});

ok('⑧ 太短的工具结果不清（换成占位符反而更费 token）', () => {
  const msgs = history(4, { size: 20 });
  const r = T.clearStaleToolResults(msgs, { keepRecentRounds: 1, minChars: 400 });
  assert.equal(r.cleared, 0, '20 字的结果不该被换成更长的占位符');
  assert.equal(r.savedChars, 0);
  // 阈值可调：调低就能清
  const low = T.clearStaleToolResults(msgs, { keepRecentRounds: 1, minChars: 5 });
  assert.ok(low.cleared > 0);
});

ok('⑨ 缩到 0 轮也安全；纯对话历史里退化成"最近 N 条"', () => {
  const chat = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }
  ];
  const r = T.clearStaleToolResults(chat, { keepRecentRounds: 2 });
  assert.equal(r.cleared, 0, '没有工具结果就什么都不做');
  assert.deepEqual(r.messages.map((m) => m.content), chat.map((m) => m.content));

  const empty = T.clearStaleToolResults([], {});
  assert.deepEqual(empty, { messages: [], cleared: 0, savedChars: 0, rounds: 0 });
  const nil = T.clearStaleToolResults(null, {});
  assert.deepEqual(nil.messages, []);
});

ok('⑩ protectLast 兜住尾部几条（万一调用方只想清"很老的那批"）', () => {
  const msgs = history(4);
  const r = T.clearStaleToolResults(msgs, { keepRecentRounds: 0, protectLast: 2 });
  // 尾部两条是 assistant + tool，最后那条 tool 不能被清
  assert.ok(r.messages[r.messages.length - 1].content.startsWith('x'.repeat(10)), '尾部被清了');
  assert.ok(r.cleared > 0, '前面该清的还是得清');
});

console.log('\n[工具历史] 日志');

ok('⑪ describeClearing：只清过才说话，说得清省了多少', () => {
  assert.equal(T.describeClearing({ cleared: 0, savedChars: 0 }), '');
  assert.equal(T.describeClearing(null), '');
  const line = T.describeClearing({ cleared: 1, savedChars: 953 }, { keepRecentRounds: 1 });
  assert.match(line, /清理旧工具结果 1 条/);
  assert.match(line, /953/);
  assert.match(line, /保留最近 1 轮原文/);
  // 不保留任何轮时不该硬说"保留最近 0 轮"
  assert.ok(!T.describeClearing({ cleared: 1, savedChars: 10 }, { keepRecentRounds: 0 }).includes('最近 0 轮'));
});

ok('⑫ 默认值：保留最近 2 轮，低于 400 字不值得清', () => {
  assert.equal(T.KEEP_RECENT_ROUNDS, 2);
  assert.equal(T.MIN_CLEAR_CHARS, 400);
});

console.log(`\n[tool-history] ${pass} 项通过`);
