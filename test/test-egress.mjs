// 出口凭据闸门 + 规则扫描引擎自测（P0-2 / P0-3）。
//
// 这里最该被钉住的是**失败方向**：
//   · 规则自己坏了 → 出口 fail-closed（宁可这条不发）
//   · 抛错的规则不能把后面的规则带哑（单一遍历的意义）
//   · 拦下时日志/异常里不许出现原文
import assert from 'node:assert';
import { scanRules, realHits, describeHits, GATE_ERROR, SEVERITY } from '../src/gate-scan.js';
import {
  scanEgress, maskSecrets, setRuntimeSecrets, clearRuntimeSecrets,
  collectSecretsFromConfig, runtimeSecretCount, EGRESS_RULES
} from '../src/egress.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }
async function okAsync(name, fn) { await fn(); pass += 1; console.log('  ✓', name); }

console.log('[gate-scan / egress]');

// ── 引擎 ────────────────────────────────────────────────────────────────
ok('一次遍历跑完全部规则（不 early return）', () => {
  const r = scanRules([
    { id: 'a', pattern: /x/g },
    { id: 'b', pattern: /x/g }
  ], 'x');
  assert.strictEqual(realHits(r).length, 2, '两条规则都该命中');
  assert.strictEqual(r.checked, 2);
});

ok('非全局正则被强制转成全局（否则漏掉第二条凭据）', () => {
  const r = scanRules([{ id: 'sk', pattern: /sk-\w+/ }], 'sk-aaa 与 sk-bbb');
  assert.strictEqual(realHits(r).length, 2);
});

ok('单条规则抛错折成哨兵，**后续规则照常执行**', () => {
  const r = scanRules([
    { id: 'broken', test: () => { throw new Error('规则写错了'); } },
    { id: 'after', pattern: /secret/g }
  ], 'secret');
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].id, 'broken');
  assert.ok(r.hits.some((h) => h.kind === GATE_ERROR), '哨兵必须出现在 hits 里');
  assert.strictEqual(realHits(r).length, 1, '抛错不能把后面的规则带哑');
  assert.strictEqual(realHits(r)[0].id, 'after');
});

ok('blockOnError 由调用方声明方向（同一份规则两种语义）', () => {
  const rules = [{ id: 'broken', test: () => { throw new Error('x'); } }];
  assert.strictEqual(scanRules(rules, 't', { blockOnError: true }).blocked, true, '出口：出错就拦');
  assert.strictEqual(scanRules(rules, 't', { blockOnError: false }).blocked, false, '观测：出错不拦');
});

ok('严重度由规则声明，warn 不算拦', () => {
  const r = scanRules([{ id: 'soft', pattern: /嗯/g, severity: SEVERITY.WARN }], '嗯');
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.blocked, false);
});

ok('describeHits 不含命中的原文', () => {
  const r = scanRules(EGRESS_RULES, 'sk-fakeabcde' + 'fghijklmnopq' + 'rstuvwxyz');
  const line = describeHits(r);
  assert.ok(line.includes('openai-sk'));
  assert.ok(!line.includes('abcdefghij'), '说明文字里不许出现原文');
});

// ── 形态 ────────────────────────────────────────────────────────────────
ok('已知形态：sk- / Bearer / AKIA / PEM / api_key=', () => {
  // 假的 PEM 头：拼接成字符串，避免源码里出现连续字面量被扫描器误判
  const fakePem = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const cases = [
    ['sk-fake12345' + '67890abcdef1' + '234', 'openai-sk'],
    ['Authorization: Bearer ' + 'fake-abcdefghijklmnop1234', 'bearer'],
    ['AKIA' + 'IOSFODNN7EXAMPLE', 'aws-key'],
    [fakePem, 'private-key'],
    ['api_key=abcdef1234567890', 'kv-secret'],
    ['ghp_' + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'github-token']
  ];
  for (const [text, rule] of cases) {
    const r = scanEgress(text);
    assert.strictEqual(r.blocked, true, `应拦下：${text}`);
    assert.ok(r.ruleIds.includes(rule), `${text} 应命中 ${rule}，实际 ${JSON.stringify(r.ruleIds)}`);
  }
});

ok('正常聊天不被误拦（这是能长期开着的唯一前提）', () => {
  const texts = [
    '哈哈哈哈哈这个绝了',
    'id: 1234567890',                 // 长数字不是密钥
    'https://example.com/a/b?x=1',
    '我用了 sk- 开头的模型',            // 只有前缀、没有密钥体
    '这个 base64 是 iVBORw0KGgo=',
    'Bearer 这个词本身不算凭据'
  ];
  for (const t of texts) {
    assert.strictEqual(scanEgress(t).blocked, false, `不该拦：${t}`);
  }
});

// ── 值匹配 ──────────────────────────────────────────────────────────────
ok('值匹配抓得住自定义格式的密钥（形态表做不到）', () => {
  clearRuntimeSecrets();
  const custom = 'qqagent-custom-key-9f3a2b7c';
  setRuntimeSecrets([custom]);
  const r = scanEgress(`我的配置是 ${custom} 你看`);
  assert.strictEqual(r.blocked, true);
  assert.ok(r.ruleIds.includes('runtime-secret'));
  clearRuntimeSecrets();
});

ok('太短的值不装（否则正常句子全被拦）', () => {
  clearRuntimeSecrets();
  const n = setRuntimeSecrets(['abc', 'test', '1234567', '12345678']);
  assert.strictEqual(n, 1, '只有 8 位以上才收');
  assert.strictEqual(scanEgress('这只是一个 test').blocked, false);
  clearRuntimeSecrets();
});

ok('纯掩码不进阻断集（掩码不是密钥）', () => {
  clearRuntimeSecrets();
  setRuntimeSecrets(['sk-****107d', '••••••••']);
  assert.strictEqual(runtimeSecretCount(), 0);
  clearRuntimeSecrets();
});

ok('密钥原文出现在文本中间也能命中（不靠词边界）', () => {
  clearRuntimeSecrets();
  setRuntimeSecrets(['zzz-CUSTOM-abcdef']);
  assert.strictEqual(scanEgress('前缀zzz-CUSTOM-abcdef后缀').blocked, true);
  clearRuntimeSecrets();
});

ok('collectSecretsFromConfig 覆盖所有会用到的位置', () => {
  const list = collectSecretsFromConfig({
    api: { apiKey: 'fake-k-api-1' + '234567' },
    providers: [{ apiKey: 'fake-k-provi' + 'der-1234567' }],
    vision: { qwen: { apiKey: 'fake-k-visio' + 'n-1234567' } },
    audio: { apiKey: 'fake-k-audio' + '-1234567' },
    webSearch: { anysearchKeys: ['fake-k-search-1234567'] },
    snowluma: { accessToken: 'k-napcat-1234567', httpAccessToken: 'k-http-1234567' },
    server: { token: 'k-panel-1234567' }
  });
  assert.strictEqual(list.length, 8, `应收到 8 把，实际 ${list.length}`);
});

// ── 脱敏 ────────────────────────────────────────────────────────────────
ok('maskSecrets 把形态命中的密钥换成掩码', () => {
  const out = maskSecrets('这里 sk-fakeabcde' + 'fghijklmnop1' + '234 和 ' + 'AKIA' + 'IOSFODNN7EXAMPLE');
  assert.ok(!out.includes('abcdefghijklmnop'), '原文必须消失');
  assert.ok(!out.includes('IOSFODNN7' + 'EXAMPLE'), '原文必须消失');
  assert.ok(out.includes('****'));
});

ok('maskSecrets 也处理运行时值（自定义格式）', () => {
  clearRuntimeSecrets();
  setRuntimeSecrets(['qqagent-custom-key-9f3a2b7c']);
  const out = maskSecrets('key=qqagent-custom-key-9f3a2b7c 完');
  assert.ok(!out.includes('9f3a2b7c'), `原文不该留下：${out}`);
  clearRuntimeSecrets();
});

ok('maskSecrets 对普通文本零改动（能安全挂在热路径上）', () => {
  const t = '[发送 -> group:123] 今天天气不错';
  assert.strictEqual(maskSecrets(t), t);
});

// ── 与发送队列的接线（端到端）─────────────────────────────────────────
// 这一节才验证"闸门真的拦在发出去之前"，前面的纯函数测试只管判据本身。
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

await okAsync('含密钥的消息**一条都不发**，且错误文案里没有原文', async () => {
  clearRuntimeSecrets();
  const secret = 'qqagent-fake' + '-secret-abcd' + 'ef123';
  setRuntimeSecrets([secret]);
  const env = fakeEnv();
  const q = new SendQueue({ onebot: env.onebot, store: { appendSelf() {} } });
  let msg = '';
  try {
    await q.sendTextBatch('group:123', [`给你看下配置：${secret}`]);
    assert.fail('应该抛错');
  } catch (e) { msg = String(e.message); }
  assert.strictEqual(env.sent.length, 0, '不能发出去任何一条');
  assert.ok(!msg.includes(secret), `错误文案不许带原文：${msg}`);
  assert.ok(msg.includes('密钥'), '要说明为什么没发');
  clearRuntimeSecrets();
});

await okAsync('一批里只拦含密钥的那一条，其余照发（不整批连坐）', async () => {
  clearRuntimeSecrets();
  setRuntimeSecrets(['qqagent-secret-abcdef123']);
  const env = fakeEnv();
  const q = new SendQueue({ onebot: env.onebot, store: { appendSelf() {} } });
  const r = await q.sendTextBatch('group:123', ['在的', 'key=qqagent-secret-abcdef123', '咋了']);
  assert.deepStrictEqual(env.sent, ['在的', '咋了']);
  assert.strictEqual(r.blocked.length, 1);
  clearRuntimeSecrets();
});

await okAsync('正常消息照原样发出（闸门不能变成哑巴）', async () => {
  const env = fakeEnv();
  const q = new SendQueue({ onebot: env.onebot, store: { appendSelf() {} } });
  const r = await q.sendTextBatch('group:123', ['今天天气不错']);
  assert.deepStrictEqual(env.sent, ['今天天气不错']);
  assert.strictEqual(r.blocked.length, 0);
});

console.log(`✓ gate-scan / egress 自测通过（${pass} 项）`);
