// 提示词组装的单元自测：验证"零历史"成本模型的关键性质。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-prompt-'));
process.env.QQ_AGENT_DATA_DIR = testDataDir;

const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildSystemPrompt, buildSystemBundle, buildUserPrompt, buildPastState } = await import('../src/prompt.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { PERSONAS } = await import('../src/personas.js');

// 注入测试配置
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '测试机';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.persona.participation = 'medium';
cfg.store.pastStateLimit = 80;
cfg.store.pastStateMaxChars = 6000;
cfg.sticker.enabled = true;
setRuntimeConfig(cfg);

function makeStore() {
  const store = new ChatStore(0);
  // 造 100 条历史
  for (let i = 1; i <= 100; i++) {
    store.appendIncoming('group:123', {
      mid: 1000 + i,
      ts: Date.now() - (101 - i) * 60000,
      senderId: `u${i % 5}`,
      senderName: `群友${i % 5}`,
      text: i % 2 === 0 ? `这是第${i}条消息，比较长一点为了占用预算一点为了占用预算` : `消息${i}`,
      reply: i % 7 === 0 ? { sender: '某人', text: '引用内容' } : null
    });
  }
  store.appendSelf('group:123', { text: '我自己的一句话', ts: Date.now() - 30000 });
  // 历史消息视为已读
  store.drainUnread('group:123');
  // 3 条未读（触发批）
  for (let i = 1; i <= 3; i++) {
    store.appendIncoming('group:123', {
      mid: 2000 + i,
      ts: Date.now() - (4 - i) * 1000,
      senderId: `u${i}`,
      senderName: `群友${i}`,
      text: `未读消息${i}`
    });
  }
  return store;
}

// ── 1. 系统提示包含全部行为模块，且不包含已移除的沉睡/唤醒机制 ──
const sys = buildSystemPrompt();
for (const keyword of ['安全规则', '工作方式', '像真人说话', '别拿空格当标点', '该说/不该说', '引用与点名', '记忆', '表情包策略', '发送与汇报禁令']) {
  assert.ok(sys.includes(keyword), `系统提示缺少模块：${keyword}`);
}
for (const banned of ['沉睡前观察', 'qq_wait_for_messages', 'qq_set_wake_config', 'qq_mark_read', '[SILENT]', '会话令牌']) {
  assert.ok(!sys.includes(banned), `系统提示不应包含已废弃概念：${banned}`);
}

// ── 2. 用户提示：包含理想清单的全部段落，顺序正确 ──
const store = makeStore();
const memory = new MemoryStore();
memory.append('group:123', 'activeTopic', '测试话题：晚点吃什么');
memory.append('group:123', 'memberImpression', '喜欢猫', { target: '群友1' });

const unreadBefore = store.unreadCount('group:123');
assert.strictEqual(unreadBefore, 3, '应有 3 条未读');

const triggerEntries = store.drainUnread('group:123');
assert.strictEqual(triggerEntries.length, 3, '触发批应是 3 条未读');
assert.strictEqual(store.unreadCount('group:123'), 0, 'drain 后无未读');

const userPrompt = buildUserPrompt({
  chatKey: 'group:123',
  kind: 'group',
  chatId: '123',
  chatName: '测试群',
  triggerEntries,
  store,
  memory,
  stickerEntries: [{ id: 's1', desc: '滑稽', useCount: 3 }],
  selfNickname: '测试机',
  selfLastMessageAt: Date.now() - 30000,
  lastMessageAt: Date.now(),
  recentCount: 42,
  runSeq: 7,
  moreUnreadDuringRun: false,
  proactive: false
});

for (const section of ['【当前时间】', '【会话标识】', '【角色设定', '【此刻状态】', '【过去状态】', '【本次唤醒】', '【参与度参考】', '【记忆】', '【表情包】', '【引导说明】']) {
  assert.ok(userPrompt.includes(section), `用户提示缺少段落：${section}`);
}
for (const banned of ['沉睡前观察', 'qq_', '[SILENT]']) {
  assert.ok(!userPrompt.includes(banned), `用户提示不应包含：${banned}`);
}

// ── 3. 触发批不出现在"过去状态"里（避免重复） ──
const past = buildPastState(store, 'group:123', { excludeIds: triggerEntries.map((m) => m.id) });
assert.ok(!past.text.includes('未读消息1'), '过去状态不应包含触发批消息');
assert.ok(past.text.includes('第100条消息'), '过去状态应包含历史消息');
assert.ok(past.text.includes('我自己的一句话'), '过去状态应包含自己的发言');

// ── 4. 预算控制：把预算调小后过去状态被截断 ──
// ⚠️ 群聊从 2026-10-25 起用自己的一份预算（pastStateGroupLimit/MaxChars），
// 只调 pastStateMaxChars 已经管不到它了 —— 这里必须两个都调，否则测的是个空断言。
cfg.store.pastStateMaxChars = 1500;
cfg.store.pastStateGroupMaxChars = 1500;
setRuntimeConfig(cfg);
const tiny = buildPastState(store, 'group:123', {});
assert.ok(tiny.text.length <= 1600, `超预算：${tiny.text.length}`);
assert.ok(tiny.dropped.length > 0, '超预算时必须记录丢了什么（否则事后查不到）');
cfg.store.pastStateMaxChars = 6000;
cfg.store.pastStateGroupMaxChars = 6000;
setRuntimeConfig(cfg);

// ── 4b. 往事摘要段（P2）：有就在【过去状态】之前，没有就整段不出现 ──
const summaryPrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries, store, memory, stickerEntries: [],
  selfNickname: '测试机', selfLastMessageAt: 0, lastMessageAt: Date.now(),
  recentCount: 1, runSeq: 9, moreUnreadDuringRun: false,
  pastSummaryText: '- 张三上周约了周末聚餐，说好七点'
});
assert.ok(summaryPrompt.includes('【往事摘要】'), '传了摘要就必须出现');
assert.ok(summaryPrompt.includes('张三上周约了周末聚餐'));
assert.ok(summaryPrompt.indexOf('【往事摘要】') < summaryPrompt.indexOf('【过去状态】'),
  '往事摘要必须在【过去状态】之前（顺序反了会被当成刚发生的事）');
assert.ok(summaryPrompt.includes('不是刚发生的事'), '尾注护栏不能少');
assert.ok(!userPrompt.includes('【往事摘要】'), '没摘要时整段不出现');

// ── 4b2. 按需工具段（P1）：只在"有包没装"时出现，私聊永远不出现 ──
const packsPrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries, store, memory, stickerEntries: [],
  selfNickname: '测试机', selfLastMessageAt: 0, lastMessageAt: Date.now(),
  recentCount: 1, runSeq: 10, moreUnreadDuringRun: false,
  toolPacksText: '【按需工具】……先调 load_tools 装载……目前没装：唱歌/点歌/语音'
});
assert.ok(packsPrompt.includes('【按需工具】'), '传了就必须出现');
assert.ok(packsPrompt.includes('load_tools'), '必须告诉它装回来的入口，否则它会答"我没有这个功能"');
assert.ok(!userPrompt.includes('【按需工具】'), '没传时整段不出现（私聊就是这条路 —— 一个字都不许变）');

// ── 4b3. 时段摘要段（m00209）：有就在【往事摘要】之后、【过去状态】之前 ──
const digestPrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries, store, memory, stickerEntries: [],
  selfNickname: '测试机', selfLastMessageAt: 0, lastMessageAt: Date.now(),
  recentCount: 1, runSeq: 11, moreUnreadDuringRun: false,
  pastSummaryText: '- 张三上周约了周末聚餐，说好七点',
  digestText: '【刚才那些时段】……\n12:00-12:15（18 条 / 5 人）：张三问了集合时间；说好七点在门口'
});
assert.ok(digestPrompt.includes('【刚才那些时段】'), '传了时段摘要就必须出现');
assert.ok(digestPrompt.includes('12:00-12:15'), '时段落款不能丢（它就是"哪段时间"）');
assert.ok(digestPrompt.indexOf('【往事摘要】') < digestPrompt.indexOf('【刚才那些时段】'),
  '更早的存量 → 刚才那几段，顺序反了就分不清时间深度');
assert.ok(digestPrompt.indexOf('【刚才那些时段】') < digestPrompt.indexOf('【过去状态】'),
  '时段摘要必须在【过去状态】之前（它就是"滑出窗口的那段"）');
assert.ok(!userPrompt.includes('【刚才那些时段】'), '没传时整段不出现（性价比的前提）');

// ── 4c. @我 的旧消息在群聊窗口被压缩后仍然保得住（P1 的核心） ──
const deepStore = new ChatStore(0);
deepStore.appendIncoming('group:123', {
  mid: 90001, ts: Date.now() - 3600000, senderId: 'u9', senderName: '群友9',
  text: '@我 明天七点集合，别迟到'
});
for (let i = 1; i <= 60; i += 1) {
  deepStore.appendIncoming('group:123', {
    mid: 91000 + i, ts: Date.now() - (60 - i) * 30000,
    senderId: `u${i % 3}`, senderName: `群友${i % 3}`,
    text: `寒暄第${i}条，随便聊聊天气和吃饭`
  });
}
const keptDeep = buildPastState(deepStore, 'group:123', { selfNickname: '测试机' });
assert.ok(keptDeep.text.includes('明天七点集合'), '@我的关键需求被寒暄冲掉了 —— 这正是 P1 要修的故障');
assert.ok(keptDeep.protectKept >= 1, '保护计数要能被日志看见');

// ── 4d. 铁律：**私聊**输出必须与 P1 之前的老算法逐字相同 ──
// 老算法 = 取最近 N 条 + 从头部按字符丢。私聊不许因为"保护项/折叠"这两个新特性变一个字。
const { formatShortTime } = await import('../src/util.js');
const oldPastText = (store, chatKey, { limit, maxChars }) => {
  // 老实现里有两条下限（Math.max(10, ...) / Math.max(1000, ...)），复刻时必须带上，
  // 否则比的是"我手写的宽容版本"而不是"线上那个版本"。
  const msgs = store.recent(chatKey, { limit: Math.max(10, limit) }).slice(-Math.max(10, limit));
  const lines = msgs.map((m) => {
    const who = m.self ? '我' : (m.senderId ? `${m.senderName || '未知'}(QQ:${m.senderId})` : (m.senderName || '未知'));
    const replyPrefix = m.reply?.text || m.reply?.sender
      ? `[引用 ${[m.reply?.sender, m.reply?.text].filter(Boolean).join('：')}]` : '';
    const idPrefix = (m.media || []).length && m.mid != null && String(m.mid) !== '' ? `#${m.mid} ` : '';
    return `[${formatShortTime(m.ts)}] ${idPrefix}${who}：${replyPrefix}${m.text}`;
  });
  while (lines.length > 1 && lines.reduce((s, l) => s + l.length + 1, 0) > maxChars) lines.shift();
  return lines.join('\n');
};
const privStore = new ChatStore(0);
for (let i = 1; i <= 60; i += 1) {
  // 刻意塞大量"同一人连续短句"，验证折叠**不会**在私聊生效
  privStore.appendIncoming('private:777', {
    mid: 70000 + i, ts: Date.now() - (61 - i) * 20000, senderId: '777', senderName: '主人',
    text: i % 3 ? '嗯' : `第${i}条稍微长一点的消息，用来占预算`
  });
}
for (const budget of [{ limit: 24, maxChars: 2400 }, { limit: 12, maxChars: 1000 }, { limit: 6, maxChars: 400 }]) {
  cfg.store.pastStateLimit = budget.limit;
  cfg.store.pastStateMaxChars = budget.maxChars;
  setRuntimeConfig(cfg);
  const now = buildPastState(privStore, 'private:777', {});
  assert.strictEqual(now.text, oldPastText(privStore, 'private:777', budget),
    `私聊历史被改动（limit=${budget.limit}）—— 私聊提示词一个字都不许变`);
  assert.strictEqual(now.folded, 0, '私聊不该折叠连发');
  assert.strictEqual(now.selfFolded, 0, '私聊不该降采样她自己的发言（那里的逐句原话就是语感）');
}

// ── 4d-2. 私聊里**她自己发言**也不许被降采样（P2 的门控断言）──
// 上一条用的是纯 incoming 的私聊，压不到这个点：私聊里她和主人是一句一句交替的，
// 如果 downsampleSelf 忘了按 isGroupChat 门控，会先在这儿炸。
const privSelfStore = new ChatStore(0);
for (let i = 1; i <= 40; i += 1) {
  const ts = Date.now() - (41 - i) * 15000;
  if (i % 2) {
    privSelfStore.appendIncoming('private:777', {
      mid: 80000 + i, ts, senderId: '777', senderName: '主人', text: `主人第${i}句：你说说这个怎么办`
    });
  } else {
    privSelfStore.appendSelf('private:777', { text: `我说的第${i}句，带着点情绪和口癖`, ts });
  }
}
for (const budget of [{ limit: 24, maxChars: 2400 }, { limit: 10, maxChars: 800 }]) {
  cfg.store.pastStateLimit = budget.limit;
  cfg.store.pastStateMaxChars = budget.maxChars;
  setRuntimeConfig(cfg);
  const now = buildPastState(privSelfStore, 'private:777', {});
  assert.strictEqual(now.text, oldPastText(privSelfStore, 'private:777', budget),
    `私聊里她自己的发言被改动了（limit=${budget.limit}）—— 一个字都不许变`);
  assert.strictEqual(now.selfFolded, 0);
}
cfg.store.pastStateLimit = 80;
cfg.store.pastStateMaxChars = 6000;
setRuntimeConfig(cfg);

// ── 4d-3. 引用前缀只渲染一次（这是"私聊一个字都不许变"的唯一刻意例外）──
// 故障形态：onebot 解析 reply 段时已经把 `[引用 张三：原文]` 拼进了消息文本，
// app.js 又把同一条引用另存成结构化 m.reply，而 formatEntry 见到 m.reply 又拼一遍
// → 同一条引用被打印两次：`[引用 A：B][引用 A：B]正文`。
// 实测 data/messages：218 条带引用，其中 196 条（89.9%）命中重复，平均每条白烧 18.4 字；
// 比字符更糟的是语义 —— 模型读到的是"这句话被引用了两遍"。
// 注意：ChatStore 会按 chatKey 从共享的临时目录**回读**别的用例写过的历史，
// 所以每条断言必须用全新的 chatKey（否则会把 4a 那 100 条里的引用一起数进来）。
let qCase = 0;
const quoteRender = (kind, entry) => {
  const chatKey = `${kind}:qcase${++qCase}`;
  const s = new ChatStore(0);
  s.appendIncoming(chatKey, { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '群友', ...entry });
  s.drainUnread(chatKey);
  return buildPastState(s, chatKey, {}).text;
};
const countQuote = (t) => (t.match(/\[引用 /g) || []).length;

const bothSrc = { text: '[引用 小明：你昨天说啥]我说没事', reply: { sender: '小明', text: '你昨天说啥' } };
for (const kind of ['group', 'private']) {
  const out = quoteRender(kind, bothSrc);
  assert.strictEqual(countQuote(out), 1, `${kind} 引用被重复渲染了：${out}`);
  assert.ok(out.includes('[引用 小明：你昨天说啥]我说没事'), '去重不能把引用整个吃掉：' + out);
}

// 文本里没有、只有结构化 m.reply（老记录 / 解析失败 / 引用段在正文之后）→ 仍要兜底补上
const onlyStruct = quoteRender('group', { text: '我说没事', reply: { sender: '小明', text: '你昨天说啥' } });
assert.strictEqual(countQuote(onlyStruct), 1, '结构化兜底丢了：' + onlyStruct);
assert.ok(onlyStruct.includes('[引用 小明：你昨天说啥]我说没事'), onlyStruct);

// 只有文本自带、没有结构化 → 原样一次
const onlyText = quoteRender('group', { text: '[引用 小明：你昨天说啥]我说没事' });
assert.strictEqual(countQuote(onlyText), 1, onlyText);
assert.ok(onlyText.includes('[引用 小明：你昨天说啥]我说没事'), onlyText);

// ── 4e. 群聊连发折叠（集成）：同一人 5 条短句合成一条 ──
const foldStore = new ChatStore(0);
for (let i = 1; i <= 5; i += 1) {
  foldStore.appendIncoming('group:123', {
    mid: 95000 + i, ts: Date.now() - (6 - i) * 3000,
    senderId: 'u7', senderName: '刷屏的', text: ['在吗', '出来', '说话', '看群', '急'][i - 1]
  });
}
const foldedPast = buildPastState(foldStore, 'group:123', {});
assert.ok(foldedPast.text.includes('（连发 5 条）'), '群聊连发应当折叠：' + foldedPast.text);
assert.ok(foldedPast.text.includes('在吗') && foldedPast.text.includes('急'), '折叠不能丢内容');
assert.strictEqual(foldedPast.folded, 4, '5 条折成 1 条 = 少 4 条');

// ── 4f. 群聊里她自己的旧发言降采样（P2，集成）──
// 真实形态：user 一句、她一句交替。最近 3 句原样，更早的并成一行片段。
const selfFoldStore = new ChatStore(0);
for (let i = 1; i <= 24; i += 1) {
  const ts = Date.now() - (25 - i) * 20000;
  if (i % 2) {
    selfFoldStore.appendIncoming('group:888', {
      mid: 96000 + i, ts, senderId: 'u9', senderName: '群友', text: `群友第${i}句：你们在聊啥`
    });
  } else {
    selfFoldStore.appendSelf('group:888', { text: `我说的第${i}句比较长的话，带着点情绪`, ts });
  }
}
cfg.store.pastStateLimit = 40;
cfg.store.pastStateMaxChars = 6000;
cfg.store.pastStateGroupLimit = 40;
cfg.store.pastStateGroupMaxChars = 6000;
setRuntimeConfig(cfg);
const selfFolded = buildPastState(selfFoldStore, 'group:888', {});
assert.ok(selfFolded.selfFolded > 0, '群聊里她的旧发言应当被降采样：' + JSON.stringify(selfFolded));
assert.ok(selfFolded.text.includes('前面还说过'), '并出来的那行要说清楚是"前面还说过"：' + selfFolded.text);
assert.ok(/我（前面还说过 \d+ 句）：/.test(selfFolded.text), '合并行的格式要稳定：' + selfFolded.text);
assert.ok(!selfFolded.text.includes('我（前面还说过 0 句）'));
assert.strictEqual(selfFolded.selfBatchKept, true, '窗口没被顶满时，合并行应当留在文本里');
// 最近 3 句必须还是完整原文，不许被截成片段
const lastThreeSelf = ['第24句', '第22句', '第20句'];
for (const tag of lastThreeSelf) {
  assert.ok(selfFolded.text.includes(tag), `最近说的「${tag}」应当原样保留`);
}
cfg.store.pastStateLimit = 80;
cfg.store.pastStateGroupLimit = 20;
cfg.store.pastStateGroupMaxChars = 2000;
setRuntimeConfig(cfg);

// ── 5. 零历史性质：整个用户提示里不出现"assistant 说过的话"这种 LLM 轮次结构 ──
// （用户消息是单个字符串，不含 OpenAI messages 数组的历史角色）
assert.ok(!userPrompt.includes('role'), '用户提示不应包含角色结构标记');

// ── 6. 主动机会模式 ──
const proactivePrompt = buildUserPrompt({
  chatKey: 'group:123', kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries: [], store, memory, stickerEntries: [],
  selfNickname: '测试机', selfLastMessageAt: 0, lastMessageAt: Date.now() - 3600000,
  recentCount: 0, runSeq: 8, moreUnreadDuringRun: false, proactive: true
});
assert.ok(proactivePrompt.includes('【过去状态】'), '主动模式也带过去状态');

// ── 7. 默认人设 = 原版小鲸鱼角色卡（已适配新架构，不含旧机制指令） ──
assert.ok(DEFAULT_CONFIG.persona.roleText.includes('DeepSeek 小鲸鱼'), '默认人设为原版小鲸鱼角色卡');
assert.ok(PERSONAS.xiaojingyu_tsundere_v1?.text.includes('傲娇改版'), '新增小鲸鱼傲娇改版人设');
assert.ok(PERSONAS.xiaojingyu?.text.includes('DeepSeek 小鲸鱼'), '原版小鲸鱼人设仍保留');
for (const banned of ['[SILENT]', 'mcp__snowluma', 'qq_set_wake_config', 'qq_mark_read', 'qq_wait_for_messages', 'qq_send_message', '空格分隔（例如']) {
  assert.ok(!DEFAULT_CONFIG.persona.roleText.includes(banned), `默认人设不应包含旧架构指令：${banned}`);
}

// ── 8. 说话风格画像（纯本地统计，零模型调用）────────────────────
const { buildStyleProfile, formatStyleProfile } = await import('../src/style-profile.js');
const prof = buildStyleProfile([
  { text: '草' }, { text: '草 太离谱了' }, { text: '哈哈哈' }, { text: '哈哈哈又是你' },
  { text: '这题会吗？' }, { text: '离谱' }, { text: '哈哈哈哈' }, { text: '在吗？' }
]);
assert.ok(prof.enough, '样本足够时应给出画像');
assert.ok(prof.medianChars > 0 && prof.medianChars <= 12, `中位字数应在合理区间：${prof.medianChars}`);
assert.ok(prof.askRatio >= 0.2, `提问占比应被算出来：${prof.askRatio}`);
assert.ok(prof.catchphrases.includes('离谱') || prof.catchphrases.includes('哈哈哈'), `口癖应被识别：${JSON.stringify(prof.catchphrases)}`);
assert.ok(buildStyleProfile([{ text: '在吗' }]).enough === false, '样本不足时不硬给画像');
const styleLine = formatStyleProfile(prof);
assert.ok(styleLine.startsWith('【对方说话风格') && styleLine.length <= 200, '风格行格式稳定且简短');
assert.ok(userPrompt.includes('【对方说话风格'), '用户提示应包含说话风格参考行');

// ── 9. 唤醒闸门（纯函数判据）───────────────────────────────────────
const { decideWake } = await import('../src/reply-gate.js');
const G = { gate: { enabled: true, dryRun: false, probability: 0.5, keywords: ['必回'], activeWindowMs: 600000, activeBoost: 3, coldGapMs: 600000, coldFactor: 0.2 } };
const never = () => 0.99;
const always = () => 0;
assert.ok(decideWake({ kind: 'private', entries: [{ text: '在吗' }], cfg: G, rng: never }).wake, '私聊必唤醒');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '@我 在吗' }], cfg: G, rng: never }).reason === 'at', '@我 必唤醒');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '你拍了拍（来自 5）' }], cfg: G, rng: never }).reason === 'at', '被拍也算 at');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '小鲸鱼在不在' }], cfg: G, aliases: ['小鲸鱼'], rng: never }).reason === 'named', '叫名字必唤醒');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '怎么这样', reply: { self: true, sender: '我' } }], cfg: G, rng: never }).reason === 'reply-self', '引用我的话必唤醒');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '这里有必回两个字' }], cfg: G, rng: never }).reason === 'keyword', '关键词必唤醒');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '今天天气不错' }], cfg: G, rng: never }).wake === false, '无关群聊按概率跳过');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '今天天气不错' }], cfg: G, rng: always }).wake === true, '概率命中时唤醒');
const t0 = Date.now();
const boosted = decideWake({ kind: 'group', entries: [{ text: '随便说说' }], cfg: G, rng: never, now: t0, lastSelfAt: t0 - 1000 });
assert.ok(boosted.boosted && boosted.probability > 0.5, '刚说过话 → 提权');
const cooled = decideWake({ kind: 'group', entries: [{ text: '随便说说' }], cfg: G, rng: never, now: t0, lastOtherAt: t0 - 3600000 });
assert.ok(cooled.cooled && cooled.probability < 0.5, '冷场 → 降权');
const dry = decideWake({ kind: 'group', entries: [{ text: '随便说说' }], cfg: { gate: { ...G.gate, dryRun: true } }, rng: never });
assert.ok(dry.wake === true && dry.wouldSkip === true && dry.reason === 'dry-run', 'dryRun：只标记本来会跳过，不真拦');
assert.ok(decideWake({ kind: 'group', entries: [{ text: '随便说说' }], cfg: { gate: { ...G.gate, enabled: false } }, rng: never }).reason === 'gate-off', '关掉闸门 = 老行为');


// ── 技能 SOP 按需装载（唱歌 0.20% / 视频链接 2.21%，其余 97.7% 的轮次不该出现）──
const SOP_MARK = '没有调就不唱';
const sysPlain = buildSystemBundle({});
const sysSong = buildSystemBundle({ packs: new Set(['song']) });
const sysWeb = buildSystemBundle({ packs: new Set(['webRead']) });
const sysOther = buildSystemBundle({ packs: new Set(['stickerBox', 'meme']) });

assert.ok(!sysPlain.text.includes(SOP_MARK), '没有唱歌/链接意图时，唱歌 SOP 整段不出现');
assert.ok(sysSong.text.includes(SOP_MARK), 'song 包激活时必须有唱歌 SOP');
assert.ok(sysWeb.text.includes('视频链接：你已经看过了'), 'webRead 包激活时必须有视频 SOP');
assert.ok(!sysOther.text.includes(SOP_MARK), '别的包（表情库/查梗）激活时不能带出唱歌 SOP');
assert.ok(
  sysSong.text.length - sysPlain.text.length > 1000,
  `按需省下的字数应该上千，实测 ${sysSong.text.length - sysPlain.text.length}`
);

// ⚠️ 最关键的一条：mediaSOP 必须**排在最后**，且它出现与否不改变前面的任何字节。
//    system 是前缀缓存的命中区，可变段放在中间会把后面全部打落缓存。
const names = (b) => b.sections.map((x) => x.name);
assert.strictEqual(names(sysSong)[names(sysSong).length - 1], 'mediaSOP', 'mediaSOP 必须是最后一段');
assert.strictEqual(names(sysWeb)[names(sysWeb).length - 1], 'mediaSOP', 'mediaSOP 必须是最后一段');
assert.strictEqual(
  sysSong.text.slice(0, sysPlain.text.length), sysPlain.text,
  'SOP 出现时，它前面的部分必须与无 SOP 时逐字一致（否则前缀缓存失效）'
);

// 输出规范：同一条规则不许在两处说
assert.ok(sysPlain.text.includes('别拿空格当标点'), '空格规范保留');
assert.ok(sysPlain.text.includes('空格不是分句符号'), '空格规范保留（rule-audit 靠它定位）');
assert.strictEqual(
  (sysPlain.text.match(/空格不是分句符号/g) || []).length, 1,
  '空格规范只允许出现一次（以前 tools 段和 humanVoice 各说一遍）'
);

console.log('✓ 提示词自测全部通过');
fs.rmSync(testDataDir, { recursive: true, force: true });
