// 识人（speaker.js）的单元自测 —— 2026-10-25 修「QQ 群里不认识主人」的回归网。
//
// 现场故障（真实会话 group:20000005）：
//   主人 @ 它 → 后面又有人插了两句 → 这轮提示词写的是
//   「正在跟你说话的是 QQ 2423123586……他**不是**你的主人」，
//   主人被彻底抹掉，于是它当着主人的面回了一句「我哪来的主人」。
//
// 这里把三个必须成立的性质钉死：
//   ① 说话人优先取「真正在叫它」的那条，不是"最后一条"；
//   ② 主人这一批里说过话 → 提示词里必须出现主人 QQ + 他说的消息号；
//   ③ 没配主人时，任何号码都不能被当成主人（旧代码写死 123456789）。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-speaker-'));
process.env.QQ_AGENT_DATA_DIR = testDataDir;

const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { MemoryStore } = await import('../src/memory.js');
const { buildUserPrompt, buildTriggerBlock, renderCrowd } = await import('../src/prompt.js');
const { primarySpeaker, masterPresence, batchHasMaster, masterQQOf } = await import('../src/speaker.js');
const { crowdOf } = await import('../src/crowd.js');

const MASTER = '10000001';
const SELF_ID = '3889000001';

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.persona.botName = '小鲸鱼';
cfg.persona.roleText = '你是测试群里的测试机。';
cfg.persona.masterQQ = MASTER;
cfg.sticker.enabled = false;
cfg.diary.enabled = false;
setRuntimeConfig(cfg);

const now = Date.now();
const entry = (o) => ({
  mid: o.mid,
  ts: now - 1000 + (o.mid - 10),
  senderId: o.senderId,
  senderName: o.senderName,
  text: o.text,
  self: false,
  ...(o.atSelf ? { atSelf: true } : {}),
  ...(o.reply ? { reply: o.reply } : {})
});

function promptFor(entries, extra = {}) {
  const store = new ChatStore(0);
  const memory = new MemoryStore();
  return buildUserPrompt({
    chatKey: 'group:20000005',
    kind: 'group',
    chatId: '20000005',
    chatName: '测试群',
    triggerEntries: entries,
    store,
    memory,
    stickerEntries: [],
    selfId: SELF_ID,
    selfNickname: '小鲸鱼',
    selfLastMessageAt: 0,
    lastMessageAt: now,
    recentCount: entries.length,
    runSeq: 1,
    moreUnreadDuringRun: false,
    proactive: false,
    ...extra
  });
}

// ── 1. 主人 @ 它、后面又有人插话：说话人必须是主人 ──────────────────────
const batchA = [
  entry({ mid: 11, senderId: MASTER, senderName: '岁月永恒喵', text: '@我 你真狂啊', atSelf: true }),
  entry({ mid: 12, senderId: '2423123586', senderName: '早睡早起', text: '#sl' }),
  entry({ mid: 13, senderId: '3982107144', senderName: '疯狂的鹿', text: '真人假扮的吗' })
];
const spA = primarySpeaker(batchA, { kind: 'group', chatId: '20000005', selfIds: [SELF_ID] });
assert.strictEqual(spA?.id, MASTER, '被 @ 的是主人，说话人就不该是后面插话的人');

const promptA = promptFor(batchA);
assert.ok(promptA.includes(`QQ ${MASTER}`), '提示词里应出现主人 QQ');
assert.ok(promptA.includes('他**就是**你的主人'), '主人 @ 它时应明说"他就是你的主人"');
assert.ok(!promptA.includes('他**不是**你的主人'), '不能同时否认主人身份');

// ── 2. 主人先说话（没 @）、陌生人事后 @ 它：主人必须仍被点名 ───────────
const batchB = [
  entry({ mid: 21, senderId: MASTER, senderName: '岁月永恒喵', text: '难道这是真鱼？' }),
  entry({ mid: 22, senderId: '2423123586', senderName: '早睡早起', text: '@我 小鲸鱼你是真鱼吗', atSelf: true })
];
const spB = primarySpeaker(batchB, { kind: 'group', chatId: '20000005', selfIds: [SELF_ID] });
assert.strictEqual(spB?.id, '2423123586', '没人 @ 时说话人应是真正在叫它的那个陌生人');

const promptB = promptFor(batchB);
assert.ok(promptB.includes('他**不是**你的主人'), '陌生人说话时要明确否认他是主人');
assert.ok(promptB.includes('你有主人'), '要告诉它"你有主人"，否则它会回"我哪来的主人"');
assert.ok(promptB.includes(`你的主人 QQ ${MASTER}`), '主人也在这批里时必须单独点名');
assert.ok(promptB.includes('#21'), '要点出主人说的是哪几条（靠消息号对上下面那串消息）');
assert.ok(promptB.includes('（你的主人'), '主人自己的那条消息行要带（你的主人）标注');

const blockB = buildTriggerBlock(batchB, { selfNickname: '小鲸鱼', selfId: SELF_ID, persona: cfg.persona });
assert.ok(/#21 .*（你的主人/.test(blockB), `主人那条消息必须带标注：\n${blockB}`);

// ── 3. 拿不到 QQ 就不出现识人段（绝不猜）──────────────────────────────
const promptC = promptFor([entry({ mid: 31, senderId: '', senderName: '匿名', text: '在吗' })]);
assert.ok(!promptC.includes('【当前对话】'), '没有 QQ 号码时不该凭空生成识人行');

// ── 4. 没配主人：任何号码都不是主人，写死的 123456789 也不能 ────────────
const cfgNoMaster = structuredClone(DEFAULT_CONFIG);
cfgNoMaster.persona.masterQQ = '';
cfgNoMaster.sticker.enabled = false;
cfgNoMaster.diary.enabled = false;
setRuntimeConfig(cfgNoMaster);

assert.strictEqual(masterQQOf({}), '', '没配主人时 masterQQOf 必须是空串');
const legacy = [entry({ mid: 41, senderId: '123456789', senderName: '老默认值', text: '@我 发文件' , atSelf: true })];
assert.strictEqual(batchHasMaster(legacy, { kind: 'group', chatId: '1' }), false, '123456789 不能顶替主人');
const promptD = promptFor(legacy);
assert.ok(!promptD.includes('你的主人/管理员'), '没配主人时不能承认任何人是主人');
assert.ok(promptD.includes('现在还没有配置主人 QQ'), '没配主人时应明说未配置');

// 恢复有主人的配置，后面的用例要用
setRuntimeConfig(cfg);

// ── 5. masterPresence：按 QQ 精确匹配，昵称相同也不算 ──────────────────
const sameNick = [
  entry({ mid: 51, senderId: MASTER, senderName: '岁月永恒喵', text: '一' }),
  entry({ mid: 52, senderId: '999999999', senderName: '岁月永恒喵', text: '二' })
];
const mp = masterPresence(sameNick, MASTER);
assert.strictEqual(mp.entries.length, 1, '只认号码，不认同名');
assert.deepStrictEqual(mp.mids, ['51']);

// ── 6. 主人在场 → 主人专属工具可以挂；主人不在场 → 不挂 ────────────────
assert.strictEqual(batchHasMaster(batchB, { kind: 'group', chatId: '20000005', persona: cfg.persona }), true, '主人不在第一条也要算在场');
assert.strictEqual(
  batchHasMaster([entry({ mid: 61, senderId: '2423123586', senderName: '早睡早起', text: '在吗' })],
    { kind: 'group', chatId: '20000005', persona: cfg.persona }),
  false, '主人没说话就不该挂主人工具'
);

// ── 7. 多人同时在找它：主人要标出来，别混成"两个普通群友" ──────────────
const batchE = [
  entry({ mid: 71, senderId: MASTER, senderName: '岁月永恒喵', text: '@我 帮我查下余额', atSelf: true }),
  entry({ mid: 72, senderId: '3982107144', senderName: '疯狂的鹿', text: '@我 看看小鲸鱼', atSelf: true })
];
const crowd = crowdOf(batchE, { kind: 'group', masterId: MASTER, aliases: [], selfIds: [SELF_ID], selfNickname: '', maxAskers: 4 });
const masterAsker = crowd.askers.find((a) => String(a.id) === MASTER);
assert.ok(masterAsker?.master === true, 'crowd 里主人应带 master 标记');
const crowdText = renderCrowd(crowd);
assert.ok(crowdText.includes('（你的主人）'), `多人段里应标出主人：\n${crowdText}`);

// ── 8. 私聊：会话号就是对方，不依赖 senderId ───────────────────────────
const spPrivate = primarySpeaker([{ mid: 81, ts: now, senderName: '主人', text: '在吗' }], { kind: 'private', chatId: MASTER });
assert.strictEqual(spPrivate?.id, MASTER, '私聊应直接拿会话号认人');
assert.strictEqual(batchHasMaster([], { kind: 'private', chatId: MASTER, persona: cfg.persona }), true, '私聊对端是主人');

console.log('speaker 识人自测通过 ✅');
