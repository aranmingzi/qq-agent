// 降级链构建的纯逻辑测试（不打网络）。
//
// 钉住的是三类**静默失效**，它们的共同点都是"配置看着生效了、实际永远用不上"：
//   ① 加进 providers 的每一家，必须至少有一个模型真的出现在链里。
//      2026-10-25 实锤：链长 8 已满时，追加的第 5 家（本机免费网关）被
//      `slice(0, MAX_CHAIN)` 整个切光 —— 目录里有、日志里无、永远不被调用。
//   ② orchestrator 里另设的备选上限不许小于链长。
//      以前那边写 `backups.slice(0, 6)`，而链本身有 8 条（7 个备选）⇒ 第 8 条
//      永远不会被尝试，等于白配。这条测试用"链尾那家必须在窗口内"间接钉住。
//   ③ 非聊天模型（embedding/tts/ocr/…）不许进链；同 baseUrl+model 只留一份。
//
// 用法：node test/test-fallback-chain.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须重定向数据目录：否则会读到生产 config.json（也就测不出这几个坑）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-chain-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { updateConfig } = await import('../src/config.js');
const { buildFallbackChain, MAX_CHAIN, isRetryableError } = await import('../src/model-fallback.js');
const { dialectFor } = await import('../src/thinking-dialect.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail += 1;
    process.exitCode = 1;
    console.log(`✗ ${name}\n    ${error?.message ?? error}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

/** 造一家提供商（2 个聊天模型 + 若干非聊天模型，模拟真实目录）。 */
function provider(id, name, baseURL, models, apiKey = 'k') {
  return { id, displayName: name, api: 'openai', baseURL, apiKey, models };
}

// 5 家 × 2 个聊天模型 + 主端点 = 11，正好是 MAX_CHAIN 的容量
const FIVE = [
  provider('p1', '主用家', 'https://a.example.com/v1', ['m-a1', 'm-a2']),
  provider('p2', '第二家', 'https://b.example.com/v1', ['m-b1', 'm-b2']),
  provider('p3', '第三家', 'https://c.example.com/v1', ['m-c1', 'm-c2']),
  provider('p4', '第四家', 'https://d.example.com/v1', ['m-d1', 'm-d2']),
  provider('p5', '本机网关', 'http://127.0.0.1:8326/v1', ['gw/one', 'gw/two'])
];

updateConfig({
  api: { provider: 'p1', baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm-a1' },
  providers: FIVE
});

ok('① 链长不超过 MAX_CHAIN，且每条都是真候选', () => {
  const chain = buildFallbackChain({});
  assert(chain.length <= MAX_CHAIN, `链长 ${chain.length} 超过 MAX_CHAIN=${MAX_CHAIN}`);
  // 10 = 当前端点 1 + p1 的 1 个（p1 只有 2 个模型，主用占掉一个名额）+ 后四家各 2 个。
  // 这里刻意写成 10 而不是 11：当前端点会占用它自己那家本来就不多的候选名额，
  // 记成 11 会让人误以为"每家固定出 2 个"，算容量时就会多算一格。
  assert(chain.length === 10, `期望 10 条，实际 ${chain.length}`);
});

ok('② 加进目录的每一家都必须出现在链里（防静默截断）', () => {
  const chain = buildFallbackChain({});
  const ids = new Set(chain.map((c) => c.providerId));
  const missing = FIVE.map((p) => p.id).filter((id) => !ids.has(id));
  assert(!missing.length, `这些家被链切光了、永远不会被调用：${missing.join(', ')}`);
});

ok('③ 每家最多贡献 2 个候选', () => {
  const chain = buildFallbackChain({});
  const count = {};
  for (const c of chain) count[c.providerId] = (count[c.providerId] || 0) + 1;
  for (const [id, n] of Object.entries(count)) {
    assert(n <= 2 || id === '', `${id} 贡献了 ${n} 个候选（>2），会把别家挤出去`);
  }
});

ok('④ 兜底那家必须落在"会被尝试"的尾部窗口内', () => {
  const chain = buildFallbackChain({});
  const backups = chain.slice(1);                 // orchestrator 只跳过当前端点
  const idx = chain.findIndex((c) => c.providerId === 'p5');
  assert(idx > 0, '兜底家没进链');
  assert(idx >= chain.length - 2 && idx < backups.length + 1,
    `兜底家在第 ${idx + 1} 条，链长 ${chain.length} —— 位置异常`);
});

ok('⑤ 非聊天模型不进链（embedding/tts/ocr/图像）', () => {
  updateConfig({
    api: { provider: 'p1', baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm-a1' },
    providers: [
      provider('p1', '主用家', 'https://a.example.com/v1',
        ['m-a1', 'm-a2', 'bge-m3-embedding', 'cosyvoice-tts', 'paddle-ocr', 'image-gen']),
      provider('p2', '第二家', 'https://b.example.com/v1', ['m-b1'])
    ]
  });
  const chain = buildFallbackChain({});
  const bad = chain.filter((c) => /embedding|tts|ocr|image/i.test(c.model));
  assert(!bad.length, `链里混进了非聊天模型：${bad.map((b) => b.model).join(', ')}`);
});

ok('⑥ 同 baseUrl+model 只留一份（两家指向同一网关时不重复等待）', () => {
  updateConfig({
    api: { provider: 'p1', baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm-a1' },
    providers: [
      provider('p1', '主用家', 'https://a.example.com/v1', ['m-a1', 'shared-model']),
      provider('p2', '别名家', 'https://a.example.com/v1', ['shared-model', 'm-b1'])
    ]
  });
  const chain = buildFallbackChain({});
  const dup = chain.filter((c) => c.baseUrl === 'https://a.example.com/v1' && c.model === 'shared-model');
  assert(dup.length === 1, `shared-model 出现了 ${dup.length} 次，应去重为 1 次`);
});

ok('⑦ 链首永远是当前生效端点', () => {
  updateConfig({
    api: { provider: 'p1', baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm-a1' },
    providers: FIVE
  });
  const chain = buildFallbackChain({});
  assert(chain[0].baseUrl === 'https://a.example.com/v1' && chain[0].model === 'm-a1',
    `链首应是当前端点，实际 ${chain[0]?.baseUrl}/${chain[0]?.model}`);
});

ok('⑧ 400 不降级（请求本身有问题，换模型也白换）', () => {
  assert(isRetryableError('模型请求失败：HTTP 400 bad request') === false, '400 被判成可重试');
  assert(isRetryableError('fetch failed ECONNREFUSED') === true, '网络错误未判成可重试');
});

ok('⑨ 本机网关方言能发思考参数，未知端点仍一个字段都不发', () => {
  const gw = dialectFor({ baseUrl: 'http://127.0.0.1:8326/v1', model: 'gw/one' });
  assert(gw.dialect === 'local-openai', `网关方言识别成 ${gw.dialect}`);
  const body = {};
  gw.apply(body, 'off');
  assert(body.reasoning_effort === 'none', '网关未收到 reasoning_effort（会丢正文/狂烧思维链）');

  const unknown = dialectFor({ baseUrl: 'https://some-new-vendor.example/v1', model: 'x' });
  assert(unknown.dialect === 'generic', `未知厂商方言识别成 ${unknown.dialect}`);
});

ok('⑩ Gemini 走 OpenAI 兼容层：不发 thinking，只发 reasoning_effort', () => {
  const g = dialectFor({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' });
  assert(g.dialect === 'gemini', `Gemini 方言识别成 ${g.dialect}（会落到 generic 发 thinking:disabled）`);

  const offBody = {};
  g.apply(offBody, 'off');
  assert(!offBody.thinking, 'Gemini 收到了 thinking 字段：3/4 系列不认且无法关思考，会 400 → 静默降级');
  assert(offBody.reasoning_effort === undefined, 'off 档不该发 reasoning_effort（none 只有 2.5 接受）');

  const lowBody = {};
  g.apply(lowBody, 'low');
  assert(lowBody.reasoning_effort === 'low', 'Gemini 低档没映射到 reasoning_effort');
  const highBody = {};
  g.apply(highBody, 'on');
  assert(highBody.reasoning_effort === 'high', 'Gemini 高档没映射到 reasoning_effort');
});

ok('⑪ 第 6 家要拿到完整配额（MAX_CHAIN 必须跟着家数走）', () => {
  const SIX = [...FIVE, provider('p6', 'Gemini', 'https://gemini.example/v1', ['gemini-3.8-flash', 'gemini-3.5-flash-lite'])];
  updateConfig({
    api: { provider: 'p1', baseUrl: 'https://a.example.com/v1', apiKey: 'k', model: 'm-a1' },
    providers: SIX
  });
  const chain = buildFallbackChain({});
  const hit = chain.filter((c) => c.providerId === 'p6');
  // 为什么要求 2 而不是 >0：MAX_CHAIN 差一格时，最后一家只是"少一个候选"，
  // 看上去一切正常；再加一家就会整家消失 —— 那时才红就太晚了。
  assert(hit.length === 2,
    `第 6 家只进了 ${hit.length} 个候选（链长 ${chain.length} / MAX_CHAIN ${MAX_CHAIN}）——链尾配额被切，再加一家就会整家消失`);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${passedSafe(pass + fail)} 项：通过 ${pass}，失败 ${fail}`);
function passedSafe(n) { return `${pass}/${n}`; }
if (fail) process.exit(1);
