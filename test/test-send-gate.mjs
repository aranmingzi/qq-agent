// 发送前许可复核 + OneBot 回包判据自测（P2-9 / P2-10）。
//
// 这两件是同一次调研里的一对：
//   P2-9 判"这次调用到底是什么结果"（传输 / 业务 / 读不出响应体）——决定能不能重发；
//   P2-10 判"现在还让不让发给这个会话"（白名单 / 暂停 / 预算）——决定要不要发。
// 两者都排在实际发出之前，且都**不许凭入站时的旧结论办事**。
import assert from 'node:assert';
import { judgeBusiness, judgeCall, looksUnsupported } from '../src/onebot-result.js';
import { classifySendFailure } from '../src/send-ledger.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }
async function okAsync(name, fn) { await fn(); pass += 1; console.log('  ✓', name); }

console.log('[onebot-result / send-gate]');

// ── 回包判据：传输 ≠ 业务 ──────────────────────────────────────────────
ok('retcode=0 但 status=failed → 判失败（以前这里会判成成功）', () => {
  const j = judgeBusiness({ retcode: 0, status: 'failed' });
  assert.strictEqual(j.businessOk, false, '这条路必须用 AND，写成 AND 连两个失败条件就漏了');
  assert.strictEqual(judgeCall({ transportOk: true, body: { retcode: 0, status: 'failed' } }).ok, false);
});

ok('status=ok 但没有 retcode → 判成功（不能要求两路都在）', () => {
  assert.strictEqual(judgeBusiness({ status: 'ok' }).businessOk, true);
  assert.strictEqual(judgeBusiness({ retcode: 0 }).businessOk, true);
});

ok('两个成功信号都在 → 成功；任一路说失败 → 失败', () => {
  assert.strictEqual(judgeBusiness({ status: 'ok', retcode: 0 }).businessOk, true);
  assert.strictEqual(judgeBusiness({ status: 'ok', retcode: 1200 }).businessOk, false);
  assert.strictEqual(judgeBusiness({ status: 'error', retcode: 0 }).businessOk, false);
});

ok('什么信号都没有 → 按成功（fail-safe：漏判失败只多一条，误判成功会少发）', () => {
  const j = judgeBusiness({});
  assert.strictEqual(j.businessOk, true);
  assert.strictEqual(j.sawAny, false);
});

ok('HTTP 不通 → kind=transport（确定没发出去，可以重试）', () => {
  const j = judgeCall({ transportOk: false, httpStatus: 500, action: 'send_msg' });
  assert.strictEqual(j.kind, 'transport');
  assert.strictEqual(j.transportOk, false);
  assert.strictEqual(j.businessOk, false, '传输没通就谈不上业务成功');
});

ok('传输通但响应体读不出 → 单列 no-body（不确定，不是确定失败）', () => {
  const j = judgeCall({ transportOk: true, httpStatus: 200, body: null });
  assert.strictEqual(j.transportOk, true, '传输是通的');
  assert.strictEqual(j.kind, 'no-body');
  assert.strictEqual(j.businessOk, false, '没有成功证据就不能算成功');
});

ok('业务失败 → kind=business，且 reason 里带得清是 retcode 还是 status', () => {
  const a = judgeCall({ transportOk: true, body: { retcode: 1200, wording: '频率超限' } });
  assert.strictEqual(a.kind, 'business');
  assert.ok(a.reason.includes('retcode=1200'));
  const b = judgeCall({ transportOk: true, body: { status: 'failed' } });
  assert.ok(b.reason.includes('status=failed'), `实际：${b.reason}`);
});

ok('looksUnsupported 认 retcode=1404 与中文文案', () => {
  assert.strictEqual(looksUnsupported(judgeCall({ transportOk: true, body: { retcode: 1404 } })), true);
  assert.strictEqual(looksUnsupported(judgeCall({ transportOk: true, body: { retcode: 1, wording: '不支持该接口' } })), true);
  assert.strictEqual(looksUnsupported(judgeCall({ transportOk: true, body: { retcode: 1200, wording: '频率超限' } })), false);
});

// ── 与台账的分工 ────────────────────────────────────────────────────────
ok('classifySendFailure 认三种 kind（能不能重发由它决定）', () => {
  assert.strictEqual(classifySendFailure({ result: { kind: 'transport' } }), 'failed');
  assert.strictEqual(classifySendFailure({ result: { kind: 'business' } }), 'failed');
  assert.strictEqual(classifySendFailure({ result: { kind: 'no-body' } }), 'unknown');
});

ok('no-body 优先级高于后续文案匹配（"HTTP 400: timeout" 不能反过来）', () => {
  // 这条既像确定失败（400）又像不确定（timeout），必须按判据给的 kind 定，不按文案猜
  const e = { result: { kind: 'no-body' }, message: 'OneBot send_msg 响应体读不出来（HTTP 200）' };
  assert.strictEqual(classifySendFailure(e), 'unknown');
});

// ── 发送前许可复核 ──────────────────────────────────────────────────────
const { SendQueue } = await import('../src/sender.js');

function fakeEnv() {
  const sent = [];
  return {
    sent,
    onebot: {
      sendText: async (kind, id, text) => { sent.push(text); return { message_id: sent.length }; },
      sendImage: async () => ({}), sendFile: async () => ({}),
      sendRecord: async () => ({}), sendSticker: async () => ({}), sendPoke: async () => ({})
    }
  };
}

function queueWith(env, gate) {
  return new SendQueue({
    onebot: env.onebot,
    store: { appendSelf() {} },
    beforeSend: gate,
  });
}

await okAsync('复核否决 → 一条都发不出去，且报错文案说得清原因', async () => {
  const env = fakeEnv();
  const q = queueWith(env, () => ({ vetoed: { kind: 'whitelist', reason: '白名单已经不含这个群' } }));
  let msg = '';
  try {
    await q.sendTextBatch('group:123', ['这句话不该出现']);
    assert.fail('应该被拦下');
  } catch (e) { msg = String(e.message); }
  assert.strictEqual(env.sent.length, 0);
  assert.ok(msg.includes('白名单'), `要说清为什么：${msg}`);
});

await okAsync('复核通过 → 照发（闸门不能变成哑巴）', async () => {
  const env = fakeEnv();
  const q = queueWith(env, () => undefined);
  await q.sendTextBatch('group:123', ['在的']);
  assert.deepStrictEqual(env.sent, ['在的']);
});

await okAsync('没接复核 → 照发（不强制接线，未接就是不管）', async () => {
  const env = fakeEnv();
  const q = new SendQueue({ onebot: env.onebot, store: { appendSelf() {} } });
  await q.sendTextBatch('group:123', ['在的']);
  assert.deepStrictEqual(env.sent, ['在的']);
});

await okAsync('复核自己抛错 → 放行（兜底的 bug 不该让机器人变哑）', async () => {
  const env = fakeEnv();
  const q = queueWith(env, () => { throw new Error('复核代码写错了'); });
  await q.sendTextBatch('group:123', ['在的']);
  assert.deepStrictEqual(env.sent, ['在的'], '该发的还是发得出去');
});

await okAsync('每一条都单独复核：中途被否决时前面几条已经发出', async () => {
  const env = fakeEnv();
  let n = 0;
  const q = queueWith(env, () => {
    n += 1;
    if (n >= 2) return { vetoed: { kind: 'paused', reason: '刚刚按了暂停' } };
    return undefined;
  });
  const r = await q.sendTextBatch('group:123', ['第一句', '第二句', '第三句']);
  assert.deepStrictEqual(env.sent, ['第一句'], '第二句开始被拦');
  assert.strictEqual(r.failed.length, 2, '被拦的两条要出现在 failed 里（不是静默消失）');
});

await okAsync('语音/图片/戳一戳也走同一道复核（不是只管文字）', async () => {
  const env = fakeEnv();
  const q = queueWith(env, () => ({ vetoed: { kind: 'budget', reason: '今日花费已达上限' } }));
  for (const [name, call] of [
    ['语音', () => q.sendVoice('group:123', { file: 'a.amr' })],
    ['图片', () => q.sendImage('group:123', 'https://example.com/a.png')],
    ['拍一拍', () => q.poke('group:123', '10001')],
    ['文件', () => q.sendFile('group:123', 'a.txt', 'a.txt')],
  ]) {
    let msg = '';
    try { await call(); assert.fail(`${name} 应该被拦下`); } catch (e) { msg = String(e.message); }
    assert.ok(msg.includes('花费'), `${name} 要说清为什么：${msg}`);
  }
  assert.strictEqual(env.sent.length, 0);
});

// ── 拦截必留痕 ──────────────────────────────────────────────────────────
// 只抛错的话，面板上看到的是"它没说话"；留痕之后看到的才是
// "我把它删了之后它还想说，被拦住了"——后者才是真相。
const { recentSkips, resetSkipMemory, SKIP_STAGES } = await import('../src/skip-log.js');

await okAsync('被复核拦下会记一条 send-gate 跳过（不是静默消失）', async () => {
  resetSkipMemory();
  const env = fakeEnv();
  const q = queueWith(env, () => ({ vetoed: { kind: 'whitelist', reason: '白名单已经不含这个群' } }));
  try { await q.sendTextBatch('group:123', ['这句话不该出现']); } catch { /* 预期 */ }
  const skips = recentSkips(20).filter((s) => s.stage === SKIP_STAGES.SEND_GATE);
  assert.strictEqual(skips.length, 1, '三条被拦 = 三条记录，一条都不能少');
  assert.strictEqual(skips[0].chatKey, 'group:123');
  assert.strictEqual(skips[0].detail.kind, 'whitelist');
  resetSkipMemory();
});

await okAsync('确定失败会记一条 send-fail（协议端退化能查出来）', async () => {
  resetSkipMemory();
  const onebot = { sendText: async () => { throw Object.assign(new Error('频率超限'), { code: 'ERATE' }); } };
  const q = new SendQueue({ onebot, store: { appendSelf() {} } });
  try { await q.sendTextBatch('group:123', ['这条发不出去']); } catch { /* 预期 */ }
  const skips = recentSkips(20).filter((s) => s.stage === SKIP_STAGES.SEND_FAIL);
  assert.strictEqual(skips.length, 1);
  assert.strictEqual(skips[0].detail.kind, 'text');
  assert.strictEqual(skips[0].detail.chars, 6, '只记长度，不记原文');
  resetSkipMemory();
});

await okAsync('结果不确定**不**记 send-fail（那种由台账单独管）', async () => {
  resetSkipMemory();
  const onebot = { sendText: async () => { throw Object.assign(new Error('ECONNRESET 连接被重置'), { code: 'ECONNRESET' }); } };
  const q = new SendQueue({ onebot, store: { appendSelf() {} }, ledger: { recordUnknown: () => null, isPending: () => null, resolveByFingerprint() {} } });
  try { await q.sendTextBatch('group:123', ['这条不知道发没发']); } catch { /* 预期 */ }
  const skips = recentSkips(20).filter((s) => s.stage === SKIP_STAGES.SEND_FAIL);
  assert.strictEqual(skips.length, 0, '不确定走台账，不该再混进跳过记录');
  resetSkipMemory();
});

console.log(`✓ onebot-result / send-gate 自测通过（${pass} 项）`);
