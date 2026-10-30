// 失败可见化自测（src/error-reply.js，2026-10-29 学自 AstrBot 的 persona_error_reply）。
//
// 这个模块的全部价值在于**分类正确**和**别乱说话**：
//   · 分错类 → 欠费时她跟群里说"网抽风了"，主人永远收不到真正的原因；
//   · 乱说话 → 用户已经拿到回复了还补一句"刚才出错了"，前面那句就变可疑；
//   · 冷却失效 → 一个坏端点几秒内失败十轮，"卡了一下"刷满屏。
// 所以测试的重点不是文案好不好听，而是**决策边界**。
import assert from 'node:assert';

const { classifyLlmError, decideErrorReply, buildErrorReply, describeErrorReply, ERROR_KINDS, OWNER } =
  await import('../src/error-reply.js');

let pass = 0;
/**
 * 断言一个用例。
 *
 * **async 回调必须被 await**：同步版本 `fn()` 拿到 Promise 就丢掉，
 * 里面 assert 失败只会变成 unhandled rejection —— 用例显示 ✓，护栏其实没生效。
 * 所以这里统一 async，并且失败时立刻抛出（连同用例名），不留"看起来过了"的可能。
 */
async function ok(name, fn) {
  try {
    await fn();
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
  pass += 1;
  console.log('  ✓', name);
}

console.log('[error-reply]');

// ── 分类 ────────────────────────────────────────────────────────────────
// 用的是 llm.js 真实抛出的三种形态：`模型 API HTTP 4xx：正文` / `模型请求超时（Nms）` /
// `模型请求失败：<底层错误>`。测试里的样例必须贴着这三种写，否则测的是想象。
await ok('402 / 余额不足 → quota（运营的锅）', () => {
  const a = classifyLlmError('模型 API HTTP 402：{"error":{"message":"Insufficient Balance"}}');
  assert.strictEqual(a.kind, ERROR_KINDS.QUOTA);
  assert.strictEqual(a.owner, OWNER.OPERATOR);
  assert.strictEqual(a.httpCode, 402);
  assert.strictEqual(a.retryable, false, '欠费换模型也没用，不该让用户"过会儿再试"');
  assert.strictEqual(classifyLlmError('模型 API HTTP 400：余额不足，请充值').kind, ERROR_KINDS.QUOTA);
});

await ok('401/403 → auth；中文"密钥"也算', () => {
  assert.strictEqual(classifyLlmError('模型 API HTTP 401：Unauthorized').kind, ERROR_KINDS.AUTH);
  assert.strictEqual(classifyLlmError('模型 API HTTP 403：Forbidden').kind, ERROR_KINDS.AUTH);
  assert.strictEqual(classifyLlmError('模型 API HTTP 400：无效的密钥').kind, ERROR_KINDS.AUTH);
});

await ok('429 → rate-limit（瞬时的，可以说人话）', () => {
  const r = classifyLlmError('模型 API HTTP 429：rate limit exceeded');
  assert.strictEqual(r.kind, ERROR_KINDS.RATE_LIMIT);
  assert.strictEqual(r.owner, OWNER.TRANSIENT);
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(classifyLlmError('模型 API HTTP 400：请求过于频繁').kind, ERROR_KINDS.RATE_LIMIT);
});

await ok('超时 / 断网 → 瞬时', () => {
  assert.strictEqual(classifyLlmError('模型请求超时（180000ms）').kind, ERROR_KINDS.TIMEOUT);
  assert.strictEqual(classifyLlmError('模型请求失败：fetch failed').kind, ERROR_KINDS.NETWORK);
  assert.strictEqual(classifyLlmError('模型请求失败：connect ECONNREFUSED 127.0.0.1:8326').kind, ERROR_KINDS.NETWORK);
});

await ok('5xx 与"响应解析不了"→ server（还是瞬时的）', () => {
  assert.strictEqual(classifyLlmError('模型 API HTTP 502：bad gateway').kind, ERROR_KINDS.SERVER);
  assert.strictEqual(classifyLlmError('模型 API 返回了无法解析的 JSON').kind, ERROR_KINDS.SERVER);
  assert.strictEqual(classifyLlmError('模型 API 响应缺少 choices：{}').kind, ERROR_KINDS.SERVER);
});

await ok('上下文超长优先于 400 —— 与 orchestrator 的裁剪判据必须同序', () => {
  const c = classifyLlmError('模型 API HTTP 400：maximum context length is 65536 tokens');
  assert.strictEqual(c.kind, ERROR_KINDS.CONTEXT);
  assert.strictEqual(c.owner, OWNER.OPERATOR);
  assert.strictEqual(classifyLlmError('模型 API HTTP 400：Input length must be less than 8192').kind, ERROR_KINDS.CONTEXT);
});

// 这条是回归护栏：两个模块各写过一份判据，2026-10-29 漂过一次 ——
// 百炼的 `Input length must be less than 8192` 只在 error-reply 这边被认出来，
// 于是同一句报错"上面裁历史重试、下面当成参数错误去报"。现在正则只有一份（CONTEXT_RE）。
await ok('上下文判据与 orchestrator 共用同一份正则（不许再漂）', async () => {
  const orch = await import('../src/orchestrator.js');
  const cases = [
    '模型 API HTTP 400：maximum context length is 65536 tokens',
    '模型 API HTTP 400：Input length must be less than 8192',
    '模型 API HTTP 400：context_length_exceeded',
    '模型 API HTTP 400：too many tokens',
    '模型 API HTTP 400：上下文长度超出上限'
  ];
  for (const c of cases) {
    assert.strictEqual(classifyLlmError(c).kind, ERROR_KINDS.CONTEXT, `error-reply 认不出：${c}`);
    assert.strictEqual(orch.isContextOverflowError(c), true, `orchestrator 认不出：${c}`);
  }
  // 反向：参数错误不能被误判成上下文超长，否则会白砍一次历史
  for (const c of ['模型 API HTTP 400：tools[3].parameters is invalid', '模型 API HTTP 500：oops']) {
    assert.notStrictEqual(classifyLlmError(c).kind, ERROR_KINDS.CONTEXT);
    assert.strictEqual(orch.isContextOverflowError(c), false);
  }
});

await ok('普通 400/422/404 → bad-request（运营的锅，不可重试）', () => {
  assert.strictEqual(classifyLlmError('模型 API HTTP 400：tools[3].parameters is invalid').kind, ERROR_KINDS.BAD_REQUEST);
  assert.strictEqual(classifyLlmError('模型 API HTTP 404：model not found').kind, ERROR_KINDS.BAD_REQUEST);
  assert.strictEqual(classifyLlmError('模型 API HTTP 400：x').retryable, false);
});

await ok('空串 / 认不出来 → unknown（默认归运营，宁可少说不可乱说）', () => {
  assert.strictEqual(classifyLlmError('').kind, ERROR_KINDS.UNKNOWN);
  assert.strictEqual(classifyLlmError(undefined).kind, ERROR_KINDS.UNKNOWN);
  assert.strictEqual(classifyLlmError('模型莫名其妙炸了').kind, ERROR_KINDS.UNKNOWN);
  assert.strictEqual(classifyLlmError('模型莫名其妙炸了').owner, OWNER.OPERATOR);
});

// ── 决策：该闭嘴的场合 ──────────────────────────────────────────────────
const base = {
  kind: ERROR_KINDS.TIMEOUT, owner: OWNER.TRANSIENT,
  direct: true, proactive: false, sentAny: false, isMaster: false,
  chatKind: 'private', now: 1000000, lastAt: 0, cooldownMs: 600000
};

await ok('已经说过话 → 不补道歉', () => {
  const d = decideErrorReply({ ...base, sentAny: true });
  assert.strictEqual(d.send, false);
  assert.match(d.reason, /已经说过话/);
});

await ok('主动机会失败 → 不出声（没人问，不自曝）', () => {
  assert.strictEqual(decideErrorReply({ ...base, proactive: true }).send, false);
});

await ok('没在叫它 → 不出声', () => {
  const d = decideErrorReply({ ...base, direct: false, chatKind: 'group' });
  assert.strictEqual(d.send, false);
  assert.match(d.reason, /不是在叫它/);
});

await ok('enabled=false → 完全闭嘴（回到改动前的行为）', () => {
  assert.strictEqual(decideErrorReply({ ...base, enabled: false }).send, false);
});

await ok('冷却期内 → 不说话，且 reason 说明还剩多久', () => {
  const d = decideErrorReply({ ...base, now: 1000000 + 1000, lastAt: 1000000, cooldownMs: 600000 });
  assert.strictEqual(d.send, false);
  assert.match(d.reason, /冷却/);
  assert.match(d.reason, /599s|600s/, '剩余时间要写出来，否则调参时看不出冷却是几秒');
});

await ok('冷却已过 → 恢复说话', () => {
  const d = decideErrorReply({ ...base, now: 1000000 + 600001, lastAt: 1000000, cooldownMs: 600000 });
  assert.strictEqual(d.send, true);
  assert.strictEqual(d.scope, 'user');
});

// ── 决策：瞬时故障说人话 ────────────────────────────────────────────────
await ok('私聊里的超时 → 说人话', () => {
  const d = decideErrorReply(base);
  assert.strictEqual(d.send, true);
  assert.strictEqual(d.scope, 'user');
});

await ok('群里被点名 → 默认说人话；inGroup=false 时闭嘴', () => {
  assert.strictEqual(decideErrorReply({ ...base, chatKind: 'group' }).send, true);
  assert.strictEqual(decideErrorReply({ ...base, chatKind: 'group', inGroup: false }).send, false);
});

// ── 决策：运营故障只给主人 ──────────────────────────────────────────────
const quota = { ...base, kind: ERROR_KINDS.QUOTA, owner: OWNER.OPERATOR };

await ok('欠费 + 陌生人 → 什么都不说（不泄露部署信息）', () => {
  const d = decideErrorReply({ ...quota, isMaster: false, chatKind: 'private' });
  assert.strictEqual(d.send, false);
  assert.match(d.reason, /只告诉主人/);
});

await ok('欠费 + 主人在群里 → 也不说（群里会泄露部署信息）', () => {
  const d = decideErrorReply({ ...quota, isMaster: true, chatKind: 'group' });
  assert.strictEqual(d.send, false);
  assert.match(d.reason, /只在私聊/);
});

await ok('欠费 + 主人私聊 → 发技术诊断', () => {
  const d = decideErrorReply({ ...quota, isMaster: true, chatKind: 'private' });
  assert.strictEqual(d.send, true);
  assert.strictEqual(d.scope, 'operator');
});

await ok('operatorNotice=false → 运营类一律不说', () => {
  assert.strictEqual(decideErrorReply({ ...quota, isMaster: true, operatorNotice: false }).send, false);
});

// ── 文案 ────────────────────────────────────────────────────────────────
await ok('用户端文案短、无技术词、随机源可注入', () => {
  const a = buildErrorReply({ kind: ERROR_KINDS.TIMEOUT, scope: 'user', rng: () => 0 });
  const b = buildErrorReply({ kind: ERROR_KINDS.TIMEOUT, scope: 'user', rng: () => 0.999 });
  assert.ok(a.length > 0 && a.length <= 30, `文案要短（真实聊天没人发长句解释自己的网络）：${a}`);
  assert.notStrictEqual(a, b, '同一类故障要有不止一句，否则连着两次一模一样更像机器人');
  assert.doesNotMatch(a, /HTTP|token|API|超时/i, '用户端不解释内部细节');
});

await ok('运营端文案带【模型失败】前缀 + 原因 + 原始错误（截短）', () => {
  const t = buildErrorReply({
    kind: ERROR_KINDS.QUOTA, scope: 'operator', botName: '小鲸鱼',
    detail: `模型 API HTTP 402：${'x'.repeat(500)}`
  });
  assert.match(t, /^【模型失败】/);
  assert.match(t, /小鲸鱼/);
  assert.match(t, /欠费|余额不足/);
  assert.match(t, /402/);
  assert.ok(t.length < 320, `原始错误必须截短，否则一条提示就几百字：${t.length}`);
  assert.match(t, /…$/);
});

await ok('config.lines 可覆盖某类文案；覆盖成空数组 = 该类不说话', () => {
  const custom = buildErrorReply({
    kind: ERROR_KINDS.TIMEOUT, scope: 'user', lines: { [ERROR_KINDS.TIMEOUT]: ['我掉线了'] }, rng: () => 0
  });
  assert.strictEqual(custom, '我掉线了');
  const muted = buildErrorReply({
    kind: ERROR_KINDS.NETWORK, scope: 'user', lines: { [ERROR_KINDS.NETWORK]: [] }
  });
  assert.strictEqual(muted, '', '空数组要退回默认池，而不是发出空串——但绝不能抛');
});

await ok('未知类别也能说一句，不会发出 undefined', () => {
  const t = buildErrorReply({ kind: 'something-new', scope: 'user', rng: () => 0 });
  assert.ok(t && t !== 'undefined' && t.length > 0);
  const o = buildErrorReply({ kind: 'something-new', scope: 'operator' });
  assert.match(o, /【模型失败】/);
});

// ── 摘要行（写进 skip-log 的 reason，给人查的）──────────────────────────
await ok('describeErrorReply 区分"提示了"和"没提示以及为什么"', () => {
  const sent = describeErrorReply(ERROR_KINDS.TIMEOUT, { send: true, scope: 'user', reason: '' });
  assert.match(sent, /已提示用户/);
  const master = describeErrorReply(ERROR_KINDS.QUOTA, { send: true, scope: 'operator', reason: '' });
  assert.match(master, /主人/);
  const skipped = describeErrorReply(ERROR_KINDS.QUOTA, { send: false, reason: '只告诉主人' });
  assert.match(skipped, /未提示：只告诉主人/);
});

console.log(`\n[error-reply] ${pass} 项全部通过`);
