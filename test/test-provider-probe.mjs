// 提供商探针的判定分支（testProvider）。
// 重点：Gemini 的 429 错误体是**数组包裹**的 [{error:{...}}]，且 Pro 档在免费层是 limit:0，
// 不单独识别就会被归成通用的 'error'，用户看到"HTTP 429"只会在网络和 key 上打转。
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-probe-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { testProvider, testModelChat } = await import('../src/providers.js');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n    ', e.message); }
};

// ── 一个假端点，按路径前缀返回不同状态 ──────────────────────────────────
const GEMINI_429 = JSON.stringify([{
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details.\n'
      + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro, description: Generate content input tokens per day limit exceeded on Free Tier.',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaMetric: '...free_tier_input_token_count', quotaId: 'GenerateContentInputTokensPerModelPerDay-FreeTier', quotaDimensions: { location: 'global', model: 'gemini-3.1-pro' } }]
    }]
  }
}]);

const BUSY_503 = JSON.stringify([{ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } }]);
const PONG_200 = JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 7, completion_tokens: 1 } });

const routes = {
  '/ok/models': [200, JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })],
  '/quota429/models': [429, GEMINI_429],
  '/busy503/models': [503, BUSY_503],
  '/badkey400/models': [400, JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }])],
  // 控制台「测这个模型」走的是 testModelChat，是另一条路径，必须单独覆盖
  '/okchat/chat/completions': [200, PONG_200],
  '/quota429/chat/completions': [429, GEMINI_429],
  '/busy503/chat/completions': [503, BUSY_503]
};

const server = http.createServer((req, res) => {
  const hit = Object.keys(routes).find((k) => req.url.startsWith(k));
  if (!hit) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no route"}'); return; }
  const [code, body] = routes[hit];
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const P = (p) => ({ id: 'x', baseURL: base + p, apiKey: 'k' });

console.log('提供商探针判定');

// ① 正常：2 个模型
{
  const r = await testProvider(P('/ok'));
  ok('① 200 → verdict ok 且数出模型数', () => {
    assert.equal(r.verdict, 'ok');
    assert.equal(r.modelCount, 2, `modelCount=${r.modelCount}`);
  });
}

// ② 429 + limit:0 → quota，且文案要点出"额度为 0"和"Cloud Billing"
{
  const r = await testProvider(P('/quota429'));
  ok('② 429(limit:0) → verdict quota（不是 error）', () => {
    assert.equal(r.verdict, 'quota', `verdict=${r.verdict} note=${r.note}`);
  });
  ok('②b 文案要说清"额度为 0"而不是"网络错误"', () => {
    assert.match(r.note, /额度为 0/, r.note);
    assert.match(r.note, /Cloud Billing/i, r.note);
  });
  ok('②c 文案要带上具体模型名（从错误体里抓）', () => {
    assert.match(r.note, /gemini-3\.1-pro/, r.note);
  });
  ok('②d 数组包裹也要能读出 message（不能显示空串）', () => {
    assert.ok(r.note.length > 20, `note 太短，说明没解析出 body: ${JSON.stringify(r.note)}`);
  });
}

// ③ 503 → model-busy，文案必须说"非配置问题"，否则用户会去翻 key
{
  const r = await testProvider(P('/busy503'));
  ok('③ 503 → verdict model-busy（不是 error）', () => {
    assert.equal(r.verdict, 'model-busy', `verdict=${r.verdict}`);
  });
  ok('③b 文案要说明"非配置问题"', () => {
    assert.match(r.note, /非配置问题/, r.note);
  });
}

// ④ 400 + "valid API key" → bad-key（Gemini 用 400 表达 key 错）
{
  const r = await testProvider(P('/badkey400'));
  ok('④ 400 含 api key 字样 → verdict bad-key', () => {
    assert.equal(r.verdict, 'bad-key', `verdict=${r.verdict}`);
  });
}

// ⑤ 404 无路由
{
  const r = await testProvider(P('/whatever'));
  ok('⑤ 404 → no-models-route', () => {
    assert.equal(r.verdict, 'no-models-route', `verdict=${r.verdict}`);
  });
}

// ⑥ testModelChat（控制台"测这个模型"的真实入口）也要认 429，不能只显示 "HTTP 429"
{
  const r = await testModelChat({ baseUrl: base + '/quota429', apiKey: 'k', model: 'gemini-3.1-pro-preview' });
  ok('⑥ testModelChat 429(limit:0) 要说清额度为 0', () => {
    assert.equal(r.ok, false);
    assert.match(r.note, /额度为 0/, `note=${r.note}`);
    assert.match(r.note, /Cloud Billing/i, r.note);
  });
}

// ⑦ testModelChat 503 → 过载，不是配置问题
{
  const r = await testModelChat({ baseUrl: base + '/busy503', apiKey: 'k', model: 'gemini-3.8-flash' });
  ok('⑦ testModelChat 503 → 文案说明非配置问题', () => {
    assert.equal(r.ok, false);
    assert.match(r.note, /非配置问题/, `note=${r.note}`);
  });
}

// ⑧ testModelChat 成功路径别被这次改动带坏
{
  const r = await testModelChat({ baseUrl: base + '/okchat', apiKey: 'k', model: 'm' });
  ok('⑧ testModelChat 200 → ok 且回显模型回复', () => {
    assert.equal(r.ok, true, `note=${r.note}`);
    assert.match(r.note, /pong/);
  });
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
