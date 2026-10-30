// 发送限频自检（纯逻辑、不碰网络、不读写 data/）。
// 跑：node test/test-send-rate.mjs（约 4 秒，含真实的等待）
//
// 守护的是 2026-10-25 的私聊"走神"事故：
//   maxPerMinute=4，上一轮刚发 3 条，主人接着说「明天开始哦」，这一轮要发的 2 条
//   **整批被拒**；模型第二轮拿到"不要再重试"的错误，它并不知道一句都没送到，
//   于是补了一句「在的在的，刚刚走神了，主人你说啥？」发给主人。
//
// 由此定下三条行为：
//   ① 首条（这一轮真正的那句回应）额度差一点就**等**，不轻易失败；
//   ② 第 2 条起超限 → **安静省略**（dropped），不抛错 —— 否则模型会为一句废话再跑一轮；
//   ③ 私聊有独立额度 maxPerMinutePrivate：一对一对话跟群里"别刷屏"不是一回事。
import assert from 'node:assert/strict';

const { SendQueue } = await import('../src/sender.js');
const { getConfig } = await import('../src/config.js');

const cfg = getConfig();
const saved = { ...(cfg.send || {}) };
const savedSticker = { ...(cfg.sticker || {}) };

let pass = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name + '\n       ' + (error?.message ?? error));
    process.exitCode = 1;
  } finally {
    cfg.send = { ...saved };
    cfg.sticker = { ...savedSticker };
  }
}

function fakeOneBot() {
  let seq = 0;
  const calls = [];
  const stickers = [];
  return {
    calls,
    stickers,
    async sendText(kind, id, text) { calls.push(text); return { message_id: ++seq }; },
    // 表情必须有真实出口：缺了它，"表情被限流跳过"和"表情根本没发"看起来一样
    // （2026-10-28 改独立额度时就撞到过这个假绿：断言 skipped 通过，其实是一路抛错）
    async sendSticker(kind, id, file) { stickers.push(String(file)); return { message_id: ++seq }; },
  };
}

function senderWith() {
  const onebot = fakeOneBot();
  const sender = new SendQueue({ onebot, store: { appendSelf() {} } });
  return { sender, onebot };
}

// 关掉节奏（否则每条要等 1~3 秒），只留限频，让断言只受限频影响。
// 注意也要把 maxPerMinutePrivate 显式打回 undefined：生产 config.json 里配了它，
// 不重置的话私聊用例会一直不受限，测出来是假绿。
function rateCfg(over = {}) {
  cfg.send = {
    ...saved, minGapMs: 0, maxGapMs: 0, byLengthMs: 0, hardSplitAt: 0,
    pace: { enabled: false }, maxPerHour: 0, rateWaitMs: 200, rateWaitFirstMs: 200,
    maxPerMinutePrivate: undefined,
    ...over
  };
}

console.log('\n[1] 分条超限：首条照发，后面的安静省略');

await ok('3 条撞上限 2 条 → 发出 2 条、省略 1 条，不抛错', async () => {
  rateCfg({ maxPerMinute: 2 });
  const { sender, onebot } = senderWith();
  const r = await sender.sendTextBatch('group:1', ['一', '二', '三']);
  assert.equal(r.sent.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].reason, 'minute');
  assert.deepEqual(onebot.calls, ['一', '二']);
  assert.equal(r.failed.length, 0, '省略不该算失败（失败会让模型补话）');
});

await ok('首条就等不到额度 → 抛错，且文案点名禁止"走神了/你说啥"', async () => {
  rateCfg({ maxPerMinute: 1 });
  const { sender, onebot } = senderWith();
  await sender.sendTextBatch('group:2', ['先占一条']);
  await assert.rejects(
    () => sender.sendTextBatch('group:2', ['再一条']),
    (e) => /没有发出去/.test(e.message) && /走神/.test(e.message) && /你说啥/.test(e.message)
  );
  assert.deepEqual(onebot.calls, ['先占一条']);
});

console.log('\n[2] 首条差一点就滑出窗口 → 等一下，别失败');

await ok('额度 3 秒后才空出来 → 等 3 秒后照常发出（不报错、不省略）', async () => {
  rateCfg({ maxPerMinute: 1, rateWaitFirstMs: 12000 });
  const { sender, onebot } = senderWith();
  await sender.sendTextBatch('private:9', ['占掉额度']);
  // 把占额度那条的时间往前挪，模拟"再过 3 秒就滑出 60s 窗口"
  sender.minuteTimes.set('private:9', [Date.now() - 57000]);
  const t0 = Date.now();
  const r = await sender.sendTextBatch('private:9', ['明天开始哦']);
  assert.equal(r.sent.length, 1, '应该等到了额度');
  assert.ok(Date.now() - t0 >= 2500, `应该真的等过（实际 ${Date.now() - t0}ms，太短说明没等）`);
  assert.deepEqual(onebot.calls, ['占掉额度', '明天开始哦']);
});

console.log('\n[3] 私聊有独立额度');

await ok('群里上限 2，私聊上限 6 → 私聊连发 4 条全发出去', async () => {
  rateCfg({ maxPerMinute: 2, maxPerMinutePrivate: 6 });
  const { sender, onebot } = senderWith();
  const g = await sender.sendTextBatch('group:3', ['群一', '群二', '群三']);
  assert.equal(g.sent.length, 2);
  const p = await sender.sendTextBatch('private:3', ['私一', '私二', '私三', '私四']);
  assert.equal(p.sent.length, 4, '私聊额度独立，不该被群里那 2 条影响');
  assert.equal(p.dropped.length, 0);
  assert.deepEqual(onebot.calls, ['群一', '群二', '私一', '私二', '私三', '私四']);
});

await ok('没配 maxPerMinutePrivate → 沿用 maxPerMinute（历史行为不变）', async () => {
  rateCfg({ maxPerMinute: 1, maxPerMinutePrivate: undefined });
  const { sender } = senderWith();
  const p = await sender.sendTextBatch('private:4', ['甲', '乙']);
  assert.equal(p.sent.length, 1);
  assert.equal(p.dropped.length, 1);
});

await ok('私聊配 0 → 私聊完全不限速', async () => {
  rateCfg({ maxPerMinute: 1, maxPerMinutePrivate: 0 });
  const { sender } = senderWith();
  const p = await sender.sendTextBatch('private:5', ['甲', '乙', '丙', '丁', '戊']);
  assert.equal(p.sent.length, 5);
  assert.equal(p.dropped.length, 0);
});

console.log('\n[4] 表情有独立额度：文本打满不连累表情，表情自己超限才安静跳过');

// 2026-10-28 实测：1000 份会话里 62 次 send_sticker 有 14 次死在「这一分钟发得太多了」，
// 而同轮 send_message 成功只有 0~1 条 —— 额度是被**前几轮**的文字吃光的。
// 表情常常是那一轮唯一的表达，所以它改走自己的桶（key 加 |sticker 后缀）。
await ok('文本把名额用光 → 表情照样发得出去', async () => {
  rateCfg({ maxPerMinute: 1 });
  const { sender, onebot } = senderWith();
  await sender.sendTextBatch('group:6', ['先说一句']);
  const r = await sender.sendSticker('group:6', { id: 's1', url: 'https://example.com/s.png', desc: '狗头' });
  assert.notEqual(r.skipped, true, '表情不该被文本的额度连累');
  assert.ok(r.message_id, '表情应该真的发出去了');
  assert.equal(onebot.stickers.length, 1);
});

await ok('表情自己撞上限 → 返回 skipped，不抛出', async () => {
  rateCfg({ maxPerMinute: 4 });
  cfg.sticker = { ...savedSticker, maxPerMinute: 1 };
  const { sender, onebot } = senderWith();
  const a = await sender.sendSticker('group:7', { id: 's1', url: 'https://example.com/s.png', desc: '狗头' });
  assert.ok(a.message_id, '第一张该正常发出');
  const b = await sender.sendSticker('group:7', { id: 's2', url: 'https://example.com/s2.png', desc: '猫头' });
  assert.equal(b.skipped, true, '第二张该被表情自己的额度挡住');
  assert.equal(onebot.stickers.length, 1);
});

await ok('表情额度配 0 → 不限（与本文件其余 0 的语义一致）', async () => {
  rateCfg({ maxPerMinute: 4 });
  cfg.sticker = { ...savedSticker, maxPerMinute: 0 };
  const { sender, onebot } = senderWith();
  await sender.sendSticker('group:8', { id: 's1', url: 'https://example.com/s.png', desc: '狗头' });
  await sender.sendSticker('group:8', { id: 's2', url: 'https://example.com/s2.png', desc: '猫头' });
  assert.equal(onebot.stickers.length, 2, '配 0 时两张都该发出去');
});

console.log('\n[5] 正文不许被当成"多余的一条"省掉（群聊"答应了却不做"的正身）');

// 2026-10-25 实录：群友要 800 字作文，她一次 send_message 传了
// [「行，那我真写了啊」, <800 字正文>]。以前只有第 1 条算 final，
// 引子正常发出、正文被静默省掉，工具还告诉她"不用补说" ——
// 她以为作文发了，之后再没写。下面四条把这个行为钉死。
const LONG = '这是答应好要写的那篇作文正文，得凑够字数才行。'.repeat(30);   // ≈ 600 字

await ok('额度只剩 1 条 + [短引子, 600字正文] → 正文优先占名额，引子让位', async () => {
  rateCfg({ maxPerMinute: 1 });
  const { sender, onebot } = senderWith();
  const r = await sender.sendTextBatch('group:10', ['行，那我真写了啊', LONG]);
  assert.deepEqual(onebot.calls, [LONG], '应该发的是正文，不是那句"我写了啊"');
  assert.equal(r.sent.length, 1);
  assert.equal(r.failed.length, 0, '正文发出去了就不该算失败');
  assert.equal(r.dropped.length, 1, '让位的短句要报上来');
  assert.equal(r.dropped[0].reason, 'quota-short');
  assert.equal(r.dropped[0].text, '行，那我真写了啊');
});

await ok('长文排在最后也一样保正文（不是"只保第一条"）', async () => {
  rateCfg({ maxPerMinute: 2 });
  const { sender, onebot } = senderWith();
  const r = await sender.sendTextBatch('group:11', ['短句甲', '短句乙', LONG]);
  // 额度 2 < 3 条，有长文 → 按长度保前 2：正文 + 最长的短句
  assert.ok(onebot.calls.includes(LONG), '正文必须在发出去的那批里');
  assert.equal(r.sent.length, 2);
  assert.equal(r.dropped.length, 1);
});

await ok('额度够用时一个字都不许动（顺序、条数原样）', async () => {
  rateCfg({ maxPerMinute: 5 });
  const { sender, onebot } = senderWith();
  const r = await sender.sendTextBatch('group:12', ['行，那我真写了啊', LONG]);
  assert.deepEqual(onebot.calls, ['行，那我真写了啊', LONG], '额度够就必须按原顺序全发');
  assert.equal(r.dropped.length, 0);
});

await ok('整批都是短句 → 保持原顺序（额度预检不许干预闲聊）', async () => {
  rateCfg({ maxPerMinute: 2 });
  const { sender, onebot } = senderWith();
  const r = await sender.sendTextBatch('group:13', ['一', '二', '三']);
  assert.deepEqual(onebot.calls, ['一', '二'], '没有长文时应该发前两条，不是"选最长的"');
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].reason, 'minute');
});

await ok('额度已经打满 + 正文 → 明确报"没有发出去"（不能静默消失）', async () => {
  rateCfg({ maxPerMinute: 1, rateWaitFirstMs: 200 });
  const { sender } = senderWith();
  await sender.sendTextBatch('group:14', ['先占掉唯一额度']);
  await assert.rejects(
    () => sender.sendTextBatch('group:14', [LONG]),
    (e) => /没有发出去/.test(e.message)
  );
});

await ok('长文阈值：59 字不算实质内容（仍可让位），60 字算', async () => {
  rateCfg({ maxPerMinute: 1 });
  const { sender, onebot } = senderWith();
  const almost = '这'.repeat(59);
  const r = await sender.sendTextBatch('group:15', [almost, '短']);
  // 没有 ≥60 字的内容 → 不干预，按顺序发第一条
  assert.deepEqual(onebot.calls, [almost]);
  assert.equal(r.dropped[0].text, '短');
});

// ── [6] 撞上限的报错必须给"补说"的出口 ────────────────────────────────
// 2026-10-25 群聊实录：她写完 800 字作文的第二段撞上限，拿到
// "本轮到此为止"就彻底闭嘴 —— 对方等的是作文，只等到一句「这题我知道」。
// 报错文案要是哪天被改回"到此为止"，这个 bug 会原样复活且零报错。
await ok('撞上限的报错允许说一句"剩下的补给你"（不许写成"到此为止"）', async () => {
  rateCfg({ maxPerMinute: 1, rateWaitFirstMs: 200 });
  const { sender } = senderWith();
  await sender.sendTextBatch('group:16', ['占满']);
  let msg = '';
  await assert.rejects(() => sender.sendTextBatch('group:16', [LONG]), (e) => { msg = e.message; return true; });
  assert.match(msg, /没有发出去/);
  assert.match(msg, /走神/);           // 仍然禁止"走神了/你说啥"
  assert.match(msg, /剩下的|补给/);    // 但必须留告知出口
  assert.doesNotMatch(msg, /到此为止/);
});

// ── [7] 长文硬切分：额度不够时，丢掉的后半截必须报"没发出去" ────────────
// 800 字作文切成 N 段、一分钟只剩 2 条额度时，前半截发出去、后半截丢掉。
// 丢掉的那几段每段都可能 ≥60 字 —— tools.js 靠这个长度判定"实质内容没发出去"，
// 于是告诉她"还在你手里，下一轮接着发"，而不是"按节奏省了，不用补说"。
await ok('硬切分长文额度不够 → 后半截进 dropped 且长度达标（会被判为"没发出去"）', async () => {
  rateCfg({ maxPerMinute: 2, hardSplitAt: 100 });
  const { sender, onebot } = senderWith();
  const essay = '这是一篇作文的内容。'.repeat(30);   // 300 字 → 切成 3 段
  const r = await sender.sendTextBatch('group:17', [essay]);
  assert.ok(onebot.calls.length >= 2, '至少发出前两段');
  const lost = r.dropped.filter((d) => String(d.text || '').length >= 60);
  assert.ok(lost.length >= 1, '丢掉的后半截每段都该 ≥60 字，才能被判成"实质内容没发出去"');
  // 真发出去的拼起来应该是作文的开头，不是中间某段
  assert.ok(essay.startsWith(onebot.calls[0].slice(0, 6)), '发出的是开头，顺序没乱');
});

cfg.send = { ...saved };
console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}\n`);
