// 通话里「说一句 → 想一句 → 回一句」（src/voice-turn.js）。
//
// ── 这条为什么值得单独测 ───────────────────────────────────────────────
// 这个模块有两个致命失败模式，都不会抛异常：
//   ① **沉默** —— 模型报错/返回空字符串时如果直接把空串交出去，
//      用户听到的是"它没理我"。前几轮反复修的就是这一类 bug。
//   ② **念出 Markdown** —— `**重点**`、`- 第一`、`（笑）` 被 TTS 念出来，
//      听起来像机器在读代码。
// 所以这里钉的是：人设在、历史截断对、Markdown 被剥干净、
// 空回复/抛异常都必须变成一句能念出来的兜底话。
import assert from 'node:assert/strict';

const {
  runVoiceTurn, sanitizeSpoken, buildVoiceSystemPrompt,
  FALLBACK_REPLY, EMPTY_INPUT_REPLY, VOICE_STYLE_RULES
} = await import('../src/voice-turn.js');

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

const PERSONA = { botName: '小雅', roleText: '你是小雅，一个说话很轻的女孩子。', customRules: '别用感叹号。' };

/** 假 chat：记录收到的 messages，返回固定内容。 */
function fakeChat(reply) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return reply; };
  fn.calls = calls;
  return fn;
}

console.log('[voice-turn]');

// ── system 提示词 ──────────────────────────────────────────────────
await ok('system 里有人设的称呼与角色描述', () => {
  const s = buildVoiceSystemPrompt(PERSONA);
  assert.match(s, /你叫小雅/);
  assert.match(s, /说话很轻的女孩子/);
  assert.match(s, /别用感叹号/);
});

await ok('system 里有"打电话而不是打字"的说话规则', () => {
  const s = buildVoiceSystemPrompt(PERSONA);
  assert.match(s, /正在打电话/);
  assert.match(s, /不要 Markdown/);
  assert.match(s, /不要描述动作或表情/);
  assert.ok(VOICE_STYLE_RULES.length > 0);
});

await ok('system 里**没有** QQ 那套东西（群成员/发送额度/工具/表情包）', () => {
  const s = buildVoiceSystemPrompt(PERSONA);
  for (const banned of ['群成员', '发送额度', '表情包', '工具调用', 'send_message', '未读']) {
    assert.ok(!s.includes(banned), `通话提示词不该包含「${banned}」`);
  }
});

await ok('人设缺失时不崩，也不留下空段落', () => {
  const s = buildVoiceSystemPrompt({});
  assert.ok(s.length > 0);
  assert.match(s, /正在打电话/);
  assert.ok(!/\n\n\n/.test(s), '不该出现连续空行');
  assert.ok(!s.startsWith('\n'));
});

await ok('extraStyle 会追加到末尾，空的则完全不占位', () => {
  const withExtra = buildVoiceSystemPrompt(PERSONA, { extraStyle: '说四川话。' });
  assert.match(withExtra, /说四川话。$/);
  assert.equal(buildVoiceSystemPrompt(PERSONA, { extraStyle: '   ' }), buildVoiceSystemPrompt(PERSONA));
});

// ── 输出清洗 ────────────────────────────────────────────────────────
await ok('Markdown 被剥掉：粗体/斜体/代码/标题/列表', () => {
  assert.equal(sanitizeSpoken('**重点**是今天'), '重点是今天');
  assert.equal(sanitizeSpoken('`npm test` 跑一下'), 'npm test 跑一下');
  assert.equal(sanitizeSpoken('# 标题'), '标题');
  assert.equal(sanitizeSpoken('- 第一\n- 第二'), '• 第一 • 第二');
});

await ok('换行被折叠成空格（念出来时换行只会让 TTS 乱停顿）', () => {
  assert.equal(sanitizeSpoken('第一句。\n\n第二句。'), '第一句。 第二句。');
  assert.equal(sanitizeSpoken('a\r\nb'), 'a b');
});

await ok('句首的「名字：」前缀被去掉（模型很爱写"小雅：你好"）', () => {
  assert.equal(sanitizeSpoken('小雅：你好呀'), '你好呀');
  assert.equal(sanitizeSpoken('我: 在的'), '在的');
  // 但不能把正常内容误伤：冒号在中间的不动
  assert.equal(sanitizeSpoken('时间是 3:30'), '时间是 3:30');
});

await ok('括号里的动作/表情描写被去掉', () => {
  assert.equal(sanitizeSpoken('（笑）今天过得怎么样？'), '今天过得怎么样？');
  assert.equal(sanitizeSpoken('(小声) 我在呢'), '我在呢');
  assert.equal(sanitizeSpoken('[叹气] 好吧'), '好吧');
});

await ok('空白输入返回空串（由上层决定回什么）', () => {
  assert.equal(sanitizeSpoken(''), '');
  assert.equal(sanitizeSpoken('   \n\t '), '');
  assert.equal(sanitizeSpoken(null), '');
  assert.equal(sanitizeSpoken(undefined), '');
});

await ok('超长时在标点处断，而不是硬切半个词', () => {
  const long = '第一句话在这里。第二句话也在这里。第三句话还是在这里。第四句话。';
  const out = sanitizeSpoken(long, 20);
  assert.ok(out.length <= 21, `实际长度 ${out.length}: ${out}`);
  assert.match(out, /[。…]$/, '应该以标点或省略号收尾');
  assert.ok(out.startsWith('第一句话'), `不该丢掉开头: ${out}`);
});

await ok('超长但找不到合适断点时用省略号收尾，不留半个标点', () => {
  const noPunct = 'a'.repeat(200);
  const out = sanitizeSpoken(noPunct, 30);
  assert.ok(out.length <= 31);
  assert.match(out, /…$/);
});

await ok('没超长时原样返回，不加省略号', () => {
  const out = sanitizeSpoken('嗯，我在。', 120);
  assert.equal(out, '嗯，我在。');
});

// ── runVoiceTurn 主路径 ────────────────────────────────────────────
await ok('正常一轮：把用户的话交给模型，返回清洗后的回复', async () => {
  const chat = fakeChat('**在的**呀，怎么啦？');
  const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat });
  assert.equal(r.reply, '在的呀，怎么啦？');
  assert.equal(r.usedModel, true);
  assert.equal(r.failed, undefined);
});

await ok('交给模型的 messages：system 在首、用户的话在尾', async () => {
  const chat = fakeChat('嗯');
  await runVoiceTurn({ text: '在吗', persona: PERSONA, chat });
  const msgs = chat.calls[0].messages;
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /小雅/);
  assert.deepEqual(msgs[msgs.length - 1], { role: 'user', content: '在吗' });
});

await ok('模型调用参数：关思考、有 maxTokens、有温度（打电话等不起思考）', async () => {
  const chat = fakeChat('嗯');
  await runVoiceTurn({ text: '在吗', persona: PERSONA, chat });
  const call = chat.calls[0];
  assert.ok(call.maxTokens > 0 && call.maxTokens <= 512);
  assert.ok(call.temperature > 0 && call.temperature <= 1);
});

await ok('历史被带上，且顺序在 system 之后、本轮之前', async () => {
  const chat = fakeChat('嗯');
  const history = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好呀' }
  ];
  await runVoiceTurn({ text: '在吗', persona: PERSONA, history, chat });
  const msgs = chat.calls[0].messages;
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].content, '你好');
  assert.equal(msgs[2].content, '你好呀');
  assert.equal(msgs[3].content, '在吗');
});

await ok('历史被截断到 historyTurns 轮（不是无限长）', async () => {
  const chat = fakeChat('嗯');
  const history = [];
  for (let i = 0; i < 50; i += 1) {
    history.push({ role: 'user', content: `u${i}` });
    history.push({ role: 'assistant', content: `a${i}` });
  }
  await runVoiceTurn({ text: '在吗', persona: PERSONA, history, historyTurns: 3, chat });
  const msgs = chat.calls[0].messages;
  // system + 3轮*2 + 本轮 = 8
  assert.equal(msgs.length, 8);
  assert.equal(msgs[1].content, 'u47', '保留的是最近的，不是最早的');
  assert.equal(msgs[6].content, 'a49');
});

await ok('历史里的脏数据被过滤（system/tool 角色、空内容）', async () => {
  const chat = fakeChat('嗯');
  const history = [
    { role: 'system', content: '不该出现' },
    { role: 'tool', content: '也不该' },
    { role: 'user', content: '   ' },
    { role: 'user', content: '保留我' },
    { role: 'assistant', content: null }
  ];
  await runVoiceTurn({ text: '在吗', persona: PERSONA, history, chat });
  const msgs = chat.calls[0].messages;
  assert.equal(msgs.length, 3, 'system + 1条有效历史 + 本轮');
  assert.equal(msgs[1].content, '保留我');
});

// ── 失败路径：绝不沉默 ─────────────────────────────────────────────
await ok('模型抛异常 → 返回兜底话，且**不把异常抛出去**', async () => {
  const chat = async () => { throw new Error('429 rate limited'); };
  const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat });
  assert.equal(r.reply, FALLBACK_REPLY);
  assert.equal(r.failed, true);
  assert.equal(r.usedModel, false);
  assert.match(r.error, /429/);
});

await ok('模型返回空字符串 → 兜底话（沉默是最差的选择）', async () => {
  const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat: fakeChat('') });
  assert.equal(r.reply, FALLBACK_REPLY);
  assert.equal(r.failed, true);
  assert.equal(r.error, 'empty-reply');
});

await ok('模型只返回 Markdown 符号/空白 → 也算空，走兜底', async () => {
  const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat: fakeChat('**\n\n  ') });
  assert.equal(r.reply, FALLBACK_REPLY);
  assert.equal(r.failed, true);
});

await ok('用户主动挂断（AbortError）→ 安静结束，不念兜底话', async () => {
  const chat = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat });
  assert.equal(r.reply, '', '挂断了就别再说话了');
  assert.equal(r.error, 'aborted');
});

await ok('用户没说话（空文本）→ 不调模型，回一句轻轻的确认', async () => {
  const chat = fakeChat('不该被调用');
  const r = await runVoiceTurn({ text: '   ', persona: PERSONA, chat });
  assert.equal(r.reply, EMPTY_INPUT_REPLY);
  assert.equal(r.usedModel, false);
  assert.equal(r.empty, true);
  assert.equal(chat.calls.length, 0, '空输入不该花钱调模型');
});

await ok('没传 persona / history / chat 也不崩（默认值可用）', async () => {
  // 只验证不会因为缺参数而抛 —— 这里不真的联网，所以给个假 chat
  const r = await runVoiceTurn({ text: '你好', chat: fakeChat('嗯嗯') });
  assert.equal(r.reply, '嗯嗯');
});

await ok('maxChars 生效：回复被截断并标记 truncated', async () => {
  const long = '这是一句很长很长的话，'.repeat(20);
  const r = await runVoiceTurn({ text: '说点啥', persona: PERSONA, chat: fakeChat(long), maxChars: 30 });
  assert.ok(r.reply.length <= 31, `实际 ${r.reply.length}`);
  assert.equal(r.truncated, true);
});

await ok('没超长时 truncated 为 false', async () => {
  const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat: fakeChat('在的'), maxChars: 120 });
  assert.equal(r.truncated, false);
});

await ok('返回的 reply 永远是字符串（下游 TTS 不会拿到 undefined）', async () => {
  for (const reply of ['', '   ', null, undefined, 0]) {
    const r = await runVoiceTurn({ text: '在吗', persona: PERSONA, chat: async () => reply });
    assert.equal(typeof r.reply, 'string');
    assert.ok(r.reply.length > 0, `reply=${JSON.stringify(reply)} 时也必须给出非空的话`);
  }
});

console.log(`\n[voice-turn] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
