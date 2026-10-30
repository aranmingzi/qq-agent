// 2026-10-22 生态调研"可借鉴项"的回归测试。
//
// 覆盖：可靠性（重连预算 / SSE 游标 / 发送台账）、拟人（闸门打分 / 动作集 / 等被叫）、
// 记忆检索打分、表达学习两级库、插件 engines/requires/热重载、风控自检、提示词分段。
//
// 全部离线：不起服务、不连 QQ、不调模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-eco-'));
let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}

const { RestartBudget } = await import('../src/restart-budget.js');
const { EventLog, formatSse, cursorFrom } = await import('../src/event-log.js');
const { SendLedger, classifySendFailure, fingerprint } = await import('../src/send-ledger.js');
const { tokenize, rankEntries, scoreEntry } = await import('../src/recall.js');
const { ExpressionLearner, extractCandidates, isLearnable, decayWeight } = await import('../src/expression-learner.js');
const { planActions, isQuietHour, MentionWait } = await import('../src/action-planner.js');
const { auditRisk } = await import('../src/risk-audit.js');
const { normalizeManifest, planLoad, satisfies, HOST_VERSION } = await import('../src/plugin-manifest.js');
const { renderExtensionSections, renderConditionalSections, renderActionPlan, renderExpressions } = await import('../src/prompt.js');
const { decideWake } = await import('../src/reply-gate.js');
const { createPlatform, UnsupportedPlatformAction } = await import('../src/platform.js');
const { createExtensionHost } = await import('../src/plugin-host.js');
const { createHookBus } = await import('../src/hook-bus.js');
const { createToolRegistry } = await import('../src/tool-registry.js');
const { SendQueue } = await import('../src/sender.js');

console.log('── 1. 重连预算（P0-3）──');

await ok('退避指数增长且封顶', () => {
  let t = 0;
  const b = new RestartBudget({ baseDelayMs: 1000, maxDelayMs: 8000, jitter: 0, now: () => t, rand: () => 0.5 });
  const d = [];
  for (let i = 0; i < 5; i++) { t += 10; const v = b.recordFailure(); d.push(v.delayMs); }
  assert.deepEqual(d.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(d[4], 8000, '封顶后不再增长');
});

await ok('窗口内超上限 → 停止自动重启', () => {
  let t = 0;
  const b = new RestartBudget({ max: 3, jitter: 0, windowMs: 60000, now: () => t, rand: () => 0.5 });
  const a = b.recordFailure();
  const c = b.recordFailure();
  const e = b.recordFailure();
  const f = b.recordFailure();
  assert.equal(a.allowed, true);
  assert.equal(c.allowed, true);
  assert.equal(e.allowed, true);
  assert.equal(f.allowed, false);
  assert.equal(f.exhausted, true);
  assert.match(f.reason, /停止自动重启/);
  assert.equal(b.snapshot().exhausted, true);
});

await ok('稳定 60s 才清零；窗口过期也会自然回满', () => {
  let t = 0;
  const b = new RestartBudget({ max: 2, stableMs: 60000, windowMs: 600000, jitter: 0, now: () => t, rand: () => 0.5 });
  b.recordFailure(); b.recordFailure();
  assert.equal(b.snapshot().remaining, 0);
  assert.equal(b.recordStable(10000).cleared, 0, '10s 不算稳定');
  assert.equal(b.recordStable(61000).cleared, 2, '61s 才清零');
  b.recordFailure();
  assert.equal(b.snapshot().remaining, 1);
  t += 600001;
  assert.equal(b.snapshot().remaining, 2, '窗口过期自动回满');
});

console.log('── 2. SSE 游标（P0-2）──');

await ok('seq 单调、since 只回之后的事件', () => {
  const log = new EventLog({ capacity: 10 });
  const a = log.push('log', { text: 'a' });
  const b = log.push('log', { text: 'b' });
  assert.equal(a.seq + 1, b.seq);
  const r = log.since(a.seq);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].payload.text, 'b');
  assert.equal(r.cursor, b.seq);
  assert.equal(r.gap, false);
});

await ok('缓冲区溢出 → gap=true（明说丢了）', () => {
  const log = new EventLog({ capacity: 3 });
  for (let i = 0; i < 6; i++) log.push('log', { i });
  const r = log.since(1);
  assert.equal(r.gap, true);
  assert.equal(r.items.length, 3);
});

await ok('SSE 帧带 id；hello 帧不带 id', () => {
  const withId = formatSse({ seq: 7, type: 'log', payload: { a: 1 } });
  assert.match(withId, /^id: 7\nevent: log\ndata: \{"a":1\}\n\n$/);
  const hello = formatSse({ type: 'hello', payload: { cursor: 3 } });
  assert.ok(!hello.startsWith('id:'));
});

await ok('cursorFrom 查询串优先于 Last-Event-ID', () => {
  const url = new URL('http://x/api/events?after=12');
  assert.equal(cursorFrom({ headers: { 'last-event-id': '9' } }, url), 12);
  assert.equal(cursorFrom({ headers: {} }, new URL('http://x/api/events')), null);
  assert.equal(cursorFrom({ headers: { 'last-event-id': '9' } }, new URL('http://x/api/events')), 9);
});

console.log('── 3. 发送台账（P0-1）──');

await ok('错误性质分类', () => {
  assert.equal(classifySendFailure(new Error('OneBot send_msg HTTP 400')), 'failed');
  assert.equal(classifySendFailure(new Error('OneBot send_msg 失败: retcode=100 频率超限')), 'failed');
  assert.equal(classifySendFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' })), 'failed');
  assert.equal(classifySendFailure(Object.assign(new Error('The operation was aborted due to timeout'), { code: 'ETIMEDOUT' })), 'unknown');
  assert.equal(classifySendFailure(new Error('socket hang up')), 'unknown');
  assert.equal(classifySendFailure(new Error('莫名其妙的错误')), 'unknown');
});

await ok('不确定 → 落账；未结清时同内容判重；resolve 后放行', () => {
  const dir = path.join(tmpRoot, 'ledger');
  const l = new SendLedger({ dir });
  l.recordUnknown({ chatKey: 'group:1', text: '在的', error: 'timeout' });
  assert.ok(l.isPending('group:1', '在的'));
  assert.equal(l.pending().length, 1);
  assert.equal(l.stats().open, 1);
  const fp = fingerprint('group:1', '在的');
  assert.equal(l.resolve(fp, 'manual'), true);
  assert.equal(l.isPending('group:1', '在的'), null);
  assert.equal(l.stats().open, 0);
  // 落盘后重新加载仍然一致
  const l2 = new SendLedger({ dir });
  assert.equal(l2.stats().open, 0);
});

await ok('超时未结清会过期（不再拦重复）', () => {
  const dir = path.join(tmpRoot, 'ledger-ttl');
  let now = 1000;
  const l = new SendLedger({ dir, ttlMs: 60000, now: () => now });
  l.recordUnknown({ chatKey: 'group:1', text: '嗯' });
  assert.ok(l.isPending('group:1', '嗯'));
  now += 61000;
  assert.equal(l.isPending('group:1', '嗯'), null);
  assert.equal(l.pending().length, 0);
});

await ok('SendQueue：超时 → 报"不确定"且绝不重发第二次', async () => {
  const dir = path.join(tmpRoot, 'send-queue');
  const ledger = new SendLedger({ dir });
  let calls = 0;
  const onebot = {
    sendText: async () => { calls++; const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; },
    sendImage: async () => ({}), sendFile: async () => ({}), sendRecord: async () => ({}),
    sendSticker: async () => ({}), sendPoke: async () => ({}),
  };
  const q = new SendQueue({ onebot, store: { appendSelf() {} }, ledger });
  let msg1 = '';
  try { await q.sendTextBatch('group:1', ['在的']); } catch (e) { msg1 = String(e.message); }
  assert.match(msg1, /不确定/);
  assert.equal(calls, 1);
  assert.equal(ledger.pending().length, 1);

  let msg2 = '';
  try { await q.sendTextBatch('group:1', ['在的']); } catch (e) { msg2 = String(e.message); }
  assert.match(msg2, /没有再发/);
  assert.equal(calls, 1, '判重命中后不该再打一次协议端');
});

await ok('SendQueue：明确失败（400）不落账、可正常重试', async () => {
  const dir = path.join(tmpRoot, 'send-queue-400');
  const ledger = new SendLedger({ dir });
  let calls = 0;
  const onebot = {
    sendText: async () => { calls++; throw new Error('OneBot send_msg HTTP 400'); },
    sendImage: async () => ({}), sendFile: async () => ({}), sendRecord: async () => ({}),
    sendSticker: async () => ({}), sendPoke: async () => ({}),
  };
  const q = new SendQueue({ onebot, store: { appendSelf() {} }, ledger });
  try { await q.sendTextBatch('group:1', ['嗯']); } catch { /* 预期失败 */ }
  assert.equal(ledger.pending().length, 0, '明确失败不落账');
  try { await q.sendTextBatch('group:1', ['嗯']); } catch { /* 预期失败 */ }
  assert.equal(calls, 2, '明确失败的可以再试');
});

await ok('SendQueue：成功后结清同内容的历史待确认', async () => {
  const dir = path.join(tmpRoot, 'send-queue-ok');
  const ledger = new SendLedger({ dir });
  ledger.recordUnknown({ chatKey: 'group:1', text: '好' });
  const onebot = {
    sendText: async () => ({ message_id: 1 }),
    sendImage: async () => ({}), sendFile: async () => ({}), sendRecord: async () => ({}),
    sendSticker: async () => ({}), sendPoke: async () => ({}),
  };
  const q = new SendQueue({ onebot, store: { appendSelf() {} }, ledger });
  // 直接结清（模拟人工确认后重新发送成功）
  ledger.resolveByFingerprint('group:1', '好', 'manual');
  const r = await q.sendTextBatch('group:1', ['好']);
  assert.equal(r.sent.length, 1);
  assert.equal(ledger.pending().length, 0);
});

console.log('── 4. 记忆检索打分（P1-4）──');

await ok('中文二元组切词', () => {
  const t = tokenize('今天加班到十点');
  assert.ok(t.has('加班'));
  assert.ok(t.has('十点'));
});

await ok('相关 + 新鲜 优先于单纯靠后', () => {
  const now = Date.parse('2026-10-22T20:00:00+08:00');
  const entries = [
    { content: '上周说过要去看牙', createdAt: now - 9 * 86400000 },
    { content: '牙医约在明天下午三点', createdAt: now - 2 * 3600000 },
    { content: '今天食堂的饭很难吃', createdAt: now - 60000 },
  ];
  const r = rankEntries(entries, { query: '牙医 明天', now, limit: 2 });
  assert.match(r[0].entry.content, /牙医/);
  assert.ok(r[0].score > r[1].score);
});

await ok('空相关时仍按新鲜度兜底（不会整段消失）', () => {
  const now = Date.now();
  const s = scoreEntry({ content: '随便一句', createdAt: now - 1000 }, { now, category: 'memberImpression' });
  assert.ok(s > 0.2);
});

console.log('── 5. 表达学习（P1-3）──');

await ok('可学判定：过滤纯语气词/问句/英文', () => {
  assert.equal(isLearnable('绝了'), true);
  assert.equal(isLearnable('哈哈哈'), false);
  assert.equal(isLearnable('这是啥？'), false);
  assert.equal(isLearnable('awsl'), false);
  assert.equal(isLearnable('一'), false);
});

await ok('同句出现 ≥2 次才算候选', () => {
  const entries = [
    { text: '绝了', senderId: '1', ts: 1 },
    { text: '绝了', senderId: '2', ts: 2 },
    { text: '就这', senderId: '1', ts: 3 },
  ];
  const c = extractCandidates(entries);
  assert.equal(c.length, 1);
  assert.equal(c[0].text, '绝了');
  assert.equal(c[0].count, 2);
});

await ok('红线：候选永不进提示词；转正后才 pick 得到', () => {
  const dir = path.join(tmpRoot, 'expr');
  const l = new ExpressionLearner({ dir });
  const now = Date.now();
  const entries = [
    { text: '绝了', senderId: '1', ts: now - 2000 },
    { text: '绝了', senderId: '2', ts: now - 1000 },
  ];
  const r = l.observe('group:1', entries);
  assert.equal(r.learned, 1);
  assert.equal(l.pendingList().length, 1);
  assert.equal(l.pick('group:1').length, 0, '候选库不许被 pick 读到');

  const id = l.pendingList()[0].id;
  assert.equal(l.promote(id).ok, true);
  const picked = l.pick('group:1');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].text, '绝了');
  assert.equal(l.pendingList().length, 0);
});

await ok('二次衰减：15 天后权重归零并被 prune', () => {
  let now = 1000;
  const dir = path.join(tmpRoot, 'expr-decay');
  const l = new ExpressionLearner({ dir, now: () => now });
  l.add('绝了');
  const id = l.libraryList()[0].id;
  assert.equal(l.pick('group:1', { limit: 3 }).length, 1);
  now += 16 * 86400000;
  assert.equal(l.pick('group:1', { limit: 3 }).length, 0, '过期不该再被 pick');
  const pr = l.prune();
  assert.ok(pr.removed >= 1);
  assert.equal(l.stats().library, 0);
  assert.ok(decayWeight({ count: 1, lastSeen: 0 }, now) >= 0);
  assert.ok(id);
});

console.log('── 6. 动作集与"等被叫"（P1-2）──');

await ok('深夜不拍人、不发语音；档位决定气泡数', () => {
  // rng 传 0.99 = 不触发"随机少一条"，断言的是档位基准值
  const night = planActions({ kind: 'group', tier: 'interject', hour: 2, moodScore: 80, hasSticker: true, canVoice: true, rng: () => 0.99 });
  assert.equal(night.budgets.poke, 0);
  assert.equal(night.budgets.voice, 0);
  assert.equal(night.budgets.bubbles, 2);
  assert.ok(night.note.includes('深夜'));

  const day = planActions({ kind: 'group', tier: 'direct', hour: 15, moodScore: 60, hasSticker: true, canVoice: true, rng: () => 0.99 });
  assert.equal(day.budgets.poke, 1);
  assert.equal(day.budgets.bubbles, 4);
  assert.ok(day.allowed.some((a) => a.name === 'reply_multi'));
  assert.equal(isQuietHour(23), true);
  assert.equal(isQuietHour(7), false);
});

await ok('气泡预算随机收一点（35% 概率少一条，不再恒定答满）', () => {
  const shrunk = planActions({ kind: 'group', tier: 'direct', hour: 15, moodScore: 60, rng: () => 0.1 });
  assert.equal(shrunk.budgets.bubbles, 3, 'direct 基准 4，rng<0.35 应收成 3');
  const floorOne = planActions({ kind: 'group', tier: 'keyword', hour: 15, moodScore: 60, rng: () => 0 });
  assert.equal(floorOne.budgets.bubbles, 1, 'keyword 基准 2，应收成 1，且下限 1');
});

await ok('心情低不拍人；私聊没有"等被叫"', () => {
  const low = planActions({ kind: 'group', tier: 'direct', hour: 15, moodScore: 20, hasSticker: false, canVoice: false });
  assert.equal(low.budgets.poke, 0);
  assert.ok(low.note.includes('心情'));
  const priv = planActions({ kind: 'private', tier: 'direct', hour: 15, moodScore: 80, hasSticker: false, canVoice: false });
  assert.ok(!priv.allowed.some((a) => a.name === 'wait_for_mention'));
});

await ok('MentionWait：过期自动清、可手动清', () => {
  const dir = path.join(tmpRoot, 'wait');
  let now = 1000;
  const w = new MentionWait({ dir, now: () => now });
  const r = w.set('group:1', { ttlMs: 60000, speakerId: '7' });
  assert.ok(r.until > now);
  assert.ok(w.get('group:1'));
  now += 61000;
  assert.equal(w.get('group:1'), null, '过期即为空');
  w.set('group:2', { ttlMs: 60000 });
  assert.equal(w.clear('group:2'), true);
  assert.equal(w.get('group:2'), null);
});

await ok('闸门：等待期内弱触发不唤醒，@ 立刻穿透', () => {
  const config = { gate: { enabled: true, probability: 1 } };
  const wait = { until: Date.now() + 60000 };
  const quiet = decideWake({ kind: 'group', entries: [{ text: '今天好热', senderId: '1' }], cfg: config, wait, rng: () => 0.99 });
  assert.equal(quiet.wake, false);
  assert.equal(quiet.reason, 'waiting-mention');
  const at = decideWake({ kind: 'group', entries: [{ text: '@我 出来', senderId: '1' }], cfg: config, wait, rng: () => 0.99 });
  assert.equal(at.wake, true);
  assert.equal(at.reason, 'at');
});

console.log('── 7. 闸门打分（P1-1）──');

await ok('问句 + 多人在聊 → 分更高', () => {
  const base = { gate: { enabled: true, probability: 0.05, mode: 'score', threshold: 0.5 } };
  const ask = decideWake({
    kind: 'group',
    entries: [{ text: '这个怎么办？', senderId: '1' }, { text: '我也不知道', senderId: '2' }],
    cfg: base, rng: () => 0.99,
  });
  const idle = decideWake({
    kind: 'group',
    entries: [{ text: '哈哈', senderId: '1' }],
    cfg: base, rng: () => 0.99,
  });
  assert.ok(ask.score > idle.score);          // 信号本身照旧
  assert.ok(ask.signals.question === 1);
  assert.ok(ask.signals.multiParty === 1);
  assert.equal(idle.wake, false);
  // ★ 寻址层（v4）：A 问 B 答 = 那两个人在对话，她是旁人 → 不唤醒。
  //   分还是那个分（0.84），只是被打了对折 —— 这也是「和群友说话她别插嘴」的另一半。
  assert.equal(ask.sideTalk, true);
  assert.equal(ask.wake, false, '两个群友在对谈时不该插嘴');
  assert.equal(ask.reason, 'to-others');
  assert.ok(ask.probability < ask.score, '降权必须体现在真正用来判定的那个数上');
  // 同一个人连着问（不是在对谈）→ 照旧唤醒：分高的提问本来就该接
  const solo = decideWake({
    kind: 'group',
    entries: [{ text: '这个怎么办？', senderId: '1' }],
    cfg: base, rng: () => 0.99,
  });
  assert.equal(solo.sideTalk, false);
  assert.equal(solo.wake, true);
});

await ok('probability 模式：分只做小幅调制，p=0 仍然不唤醒', () => {
  const zero = decideWake({
    kind: 'group',
    entries: [{ text: '这个怎么办？', senderId: '1' }, { text: '急', senderId: '2' }],
    cfg: { gate: { enabled: true, probability: 0 } }, rng: () => 0.0,
  });
  assert.equal(zero.wake, false);
  assert.equal(zero.probability, 0);
  assert.ok(typeof zero.score === 'number');
});

console.log('── 8. 风控自检（P3-2）──');

await ok('不限速 + 没设主人 + 对外无令牌 → 有 warn/critical', () => {
  const r = auditRisk({
    send: { maxPerMinute: 0, maxPerHour: 0 },
    gate: { enabled: true, dryRun: false },
    persona: { masterQQ: '' },
    server: { bindHost: '0.0.0.0', token: '' },
    proactive: { enabled: false },
    budget: { dailyCostYuan: 0 },
  });
  assert.equal(r.level, 'critical');
  assert.ok(r.items.some((i) => i.code === 'no-rate-limit' && i.level === 'warn'));
  assert.ok(r.items.some((i) => i.code === 'no-master'));
  assert.ok(r.items.some((i) => i.code === 'open-console' && i.level === 'critical'));
});

await ok('配置齐全 → ok', () => {
  const r = auditRisk({
    send: { maxPerMinute: 3, maxPerHour: 80 },
    gate: { enabled: true, dryRun: false },
    persona: { masterQQ: '10001' },
    server: { bindHost: '127.0.0.1', token: '' },
    proactive: { enabled: true, probability: 0.2 },
    budget: { dailyCostYuan: 5 },
  }, { todaySent: 20 });
  assert.equal(r.level, 'ok');
  assert.match(r.summary, /正常/);
});

console.log('── 9. 清单兼容约束（P2-2）──');

await ok('semver 区间判断', () => {
  assert.equal(satisfies(HOST_VERSION, '>=1.0.0'), true);
  assert.equal(satisfies(HOST_VERSION, '^1.0.0'), true);
  assert.equal(satisfies(HOST_VERSION, '>=2.0.0'), false);
  assert.equal(satisfies('1.2.3', '~1.2.0'), true);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('1.2.3', '>=1.0 <2'), true);
});

await ok('engines 不符 → 致命；requires 未启用 → reject', () => {
  const nm = normalizeManifest({ id: 'x', apiVersion: 1, engines: { qqagent: '>=9.0.0' } });
  assert.ok(nm.fatal.some((f) => f.code === 'engine-mismatch'));
  assert.match(nm.fatal.find((f) => f.code === 'engine-mismatch').text, /当前是/);

  const entry = {
    dir: tmpRoot, dirName: 'x', kind: 'plugin',
    manifest: normalizeManifest({ id: 'x', apiVersion: 1, requires: ['dep'] }).manifest,
    fatal: [], problems: [],
  };
  const plan = planLoad([entry], ['x'])[0];
  assert.equal(plan.action, 'reject');
  assert.equal(plan.reason, 'missing-requires');
  assert.match(plan.detail, /dep/);
});

await ok('prompt.sections 的 when 被保留', () => {
  const nm = normalizeManifest({
    id: 'x', apiVersion: 1,
    prompt: { sections: [{ title: 'T', body: 'B', when: ['抽卡', '  ', '原神'] }] },
  });
  const sec = nm.manifest.promptSections[0];
  assert.deepEqual(sec.when, ['抽卡', '原神']);
});

console.log('── 10. 提示词分段（P1-5 / P2-6）──');

await ok('带 when 的段落不进系统提示，只在命中时进用户消息', () => {
  const sections = [
    { title: '静态', body: '永远在' },
    { title: '抽卡', body: '别提概率', when: ['抽卡'] },
  ];
  const sys = renderExtensionSections(sections);
  assert.ok(sys.includes('永远在'));
  assert.ok(!sys.includes('别提概率'), '条件段不许进系统提示（会破坏缓存）');

  assert.equal(renderConditionalSections(sections, { text: '今天聊加班' }), '');
  const hit = renderConditionalSections(sections, { text: '这游戏抽卡概率多少' });
  assert.ok(hit.includes('别提概率'));
  assert.ok(!hit.includes('永远在'));
});

await ok('动作集与表达渲染不会空占字数', () => {
  assert.equal(renderActionPlan({}), '');
  assert.equal(renderExpressions([]), '');
  const plan = planActions({ kind: 'group', tier: 'direct', hour: 15, moodScore: 60, hasSticker: false, canVoice: false, rng: () => 0.99 });
  const text = renderActionPlan(plan);
  assert.match(text, /这一轮能做的动作/);
  assert.match(text, /范围外/);
  assert.match(text, /最多 4 条/);
  assert.match(renderExpressions([{ text: '绝了' }]), /绝了/);
});

console.log('── 11. 平台薄接口（P2-5）──');

await ok('能力表按方法存在与否算，缺方法抛可识别错误', () => {
  const adapter = {
    sendText: async () => ({ message_id: 1 }),
    sendImage: async () => ({}),
  };
  const p = createPlatform(adapter, { name: 'mock' });
  assert.equal(p.supports('sendText'), true);
  assert.equal(p.supports('sendRecord'), false);
  assert.equal(p.capabilities().sendRecord, false);
  assert.throws(() => p.sendRecord('group', '1', 'x'), (e) => e instanceof UnsupportedPlatformAction && e.code === 'EPLATFORM_UNSUPPORTED');
});

console.log('── 12. 插件热重载（P2-1）──');

await ok('reload 换掉旧实例：旧工具消失、新工具出现', async () => {
  const root = path.join(tmpRoot, 'root');
  const dir = path.join(root, 'plugins', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: 1, entry: 'index.js',
  }, null, 2));
  const writeEntry = (tag) => fs.writeFileSync(path.join(dir, 'index.js'),
    `export function setup(api) {\n  api.registerTool({ id: '${tag}_tool', description: '${tag}', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: '${tag}' }] }) });\n}\n`, 'utf8');
  writeEntry('v1');

  const bus = createHookBus({ log: { warn: () => {} } });
  const registry = createToolRegistry();
  const host = createExtensionHost({
    root, registry, bus,
    getCustom: () => ({ plugins: { enabled: ['demo'], settings: {} } }),
    log: { info: () => {}, warn: () => {} },
  });
  const snap = await host.load();
  assert.equal(snap.sum.loaded, 1);
  assert.ok(registry.names().some((n) => n.includes('v1_tool')));

  writeEntry('v2');
  const r = await host.reload('demo');
  assert.equal(r.ok, true, `reload 失败：${r.reason} ${r.detail}`);
  const names = registry.names();
  assert.ok(names.some((n) => n.includes('v2_tool')), '新工具应已注册');
  assert.ok(!names.some((n) => n.includes('v1_tool')), '旧工具应已收回');
});

await ok('新清单坏掉 → reload 失败但说清原因（不假装成功）', async () => {
  const root = path.join(tmpRoot, 'root2');
  const dir = path.join(root, 'plugins', 'bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id: 'bad', name: 'B', version: '1.0.0', apiVersion: 1 }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function setup(){}\n', 'utf8');
  const bus = createHookBus({ log: { warn: () => {} } });
  const registry = createToolRegistry();
  const host = createExtensionHost({
    root, registry, bus,
    getCustom: () => ({ plugins: { enabled: ['bad'], settings: {} } }),
    log: { info: () => {}, warn: () => {} },
  });
  await host.load();
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({ id: 'bad', apiVersion: 999 }), 'utf8');
  const r = await host.reload('bad');
  assert.equal(r.ok, false);
  assert.ok(String(r.reason || '').length > 0, '必须给出原因');
});

// ── 13. 控制台契约（前端读的字段不许悄悄改名）─────────────────────────────
//
// 上面 12 组保证"逻辑对"，这一组保证"控制台能读对"。
// TS 归一化函数（console/src/lib/api.ts）读的每一个 key 都在这里钉死 ——
// 后端改个字段名，前端只会静默显示「—」，看不出是坏了，所以必须静态拦住。
console.log('── 13. 控制台契约（2026-10-22 新增）──');

const keysOf = (obj) => Object.keys(obj).sort();
const mustHave = (actual, expected, label) => {
  const missing = expected.filter((k) => !actual.includes(k));
  assert.equal(missing.length, 0, `${label} 缺字段：${missing.join('、')}`);
};

await ok('/api/risk/audit 形状', () => {
  const audit = auditRisk({ send: { maxPerMinute: 3, maxPerHour: 60 } }, { todaySent: 5 });
  mustHave(keysOf(audit), ['checkedAt', 'items', 'level', 'summary'], 'audit');
  assert.ok(['ok', 'info', 'warn', 'critical'].includes(audit.level), `level 越界：${audit.level}`);
  for (const item of audit.items) {
    mustHave(keysOf(item), ['code', 'detail', 'hint', 'level', 'title'], `audit.item(${item.code})`);
  }
});

await ok('/api/send/pending 形状', () => {
  const dir = path.join(tmpRoot, 'ledger');
  const ledger = new SendLedger({ dir, now: () => Date.now() });
  ledger.recordUnknown({ chatKey: 'group:1', text: 'hi', error: 'timeout', kind: 'text' });
  mustHave(keysOf(ledger.stats()), ['expired', 'file', 'open', 'resolved', 'total'], 'ledger.stats');
  const [row] = ledger.pending();
  mustHave(keysOf(row), ['at', 'chatKey', 'error', 'fp', 'kind', 'resolvedAt', 'resolvedBy', 'text', 'tries'], 'ledger.item');
  assert.equal(row.resolvedAt, 0, '未结清时 resolvedAt 必须是 0（前端据此过滤）');
});

await ok('/api/expressions 形状', () => {
  const dir = path.join(tmpRoot, 'expr');
  const learner = new ExpressionLearner({ dir, now: () => Date.now() });
  learner.observe('group:1', [
    { text: '笑死我了', senderId: 'a' },
    { text: '笑死我了', senderId: 'b' },
  ]);
  learner.add('真的假的');
  mustHave(keysOf(learner.stats()), ['library', 'pending'], 'expressions.stats');
  for (const label of ['pending', 'library']) {
    const rows = label === 'pending' ? learner.pendingList() : learner.libraryList();
    assert.ok(rows.length > 0, `${label} 不该为空（否则这条断言是空跑）`);
    for (const row of rows) {
      // weight 是派生值，promote 后不落盘，但列表 API 一定会补上
      mustHave(keysOf(row), ['weight'], `expressions.${label}`);
      mustHave(keysOf(row), ['id', 'text', 'count', 'chatKeys', 'firstSeen', 'lastSeen'], `expressions.${label}(${row.id})`);
    }
  }
});

await ok('/api/mention-wait 形状', () => {
  const dir = path.join(tmpRoot, 'wait');
  const wait = new MentionWait({ dir, now: () => Date.now() });
  wait.set('group:9', { ttlMs: 10 * 60 * 1000, speakerId: 'u1', note: '先静静' });
  const rows = wait.list();
  assert.equal(rows.length, 1);
  mustHave(keysOf(rows[0]), ['at', 'chatKey', 'note', 'remainingMs', 'speakerId', 'until'], 'mention-wait.item');
  assert.ok(rows[0].remainingMs > 0, '剩余时间必须是正的');
});

await ok('/api/onebot/restart-state 形状', () => {
  let t = 0;
  const b = new RestartBudget({ max: 3, jitter: 0, windowMs: 60000, now: () => t, rand: () => 0.5 });
  t += 10;
  b.recordFailure();
  mustHave(
    keysOf(b.snapshot()),
    ['exhausted', 'exhaustedAt', 'failures', 'lastFailureAt', 'max', 'remaining', 'windowMs'],
    'restart.snapshot',
  );
  // 宿主还会额外补 nextRetryAt / connectedAt（前端「立即重连」按钮据此判断）
  assert.equal(typeof b.snapshot().exhausted, 'boolean', 'exhausted 必须是布尔，不能是时间戳');
});

await ok('闸门判定记录能被前端渲染（reason ∈ 已知表）', () => {
  // 前端 REASON_TEXT 的 key；后端新增 reason 时必须同步加中文，否则会显示英文
  const KNOWN = ['private', 'at', 'at-all', 'named', 'reply-self', 'keyword', 'poke',
    'continuation', 'probability', 'score', 'skipped', 'dry-run', 'waiting-mention',
    'poke-quiet', 'gate-off', 'to-others'];
  const nowVal = Date.now();
  const entries = (text, n = 3) => Array.from({ length: n }, (_, i) => ({ text: `${text}-${i}`, senderId: `u${i}` }));
  const gate = { enabled: true, dryRun: false, mode: 'score', scoreThreshold: 0.5, probability: 0.3 };
  const seen = new Set();
  for (const kind of ['private', 'group']) {
    for (const entries_ of [entries('在吗'), entries('@我 看看'), entries('@全体成员 集合'), entries('哈哈哈')]) {
      const d = decideWake({ kind, entries: entries_, cfg: { gate: { ...gate, mode: 'probability', probability: 1 } }, now: nowVal });
      seen.add(d.reason);
    }
  }
  const d = decideWake({ kind: 'group', entries: entries('哈哈哈'), cfg: { gate }, now: nowVal, wait: { until: nowVal + 60000, remainingMs: 60000 } });
  seen.add(d.reason);
  const unknown = [...seen].filter((r) => r && !KNOWN.includes(r));
  assert.equal(unknown.length, 0, `前端没有这些 reason 的中文：${unknown.join('、')}`);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
