// 看图双通道的纯逻辑测试：不打网络，用 fetch 桩。
//
// 钉住的四个点，每一个都曾经或差点变成线上事故：
//   ① 表情包走 deepseek、其余走千问（分工反了 = 省下的钱全赔在 OCR 上）
//   ② deepseek 请求体必须带 thinking:disabled（不带 = HTTP 200 + 空正文）
//   ③ 一家挂了要能换另一家，且报出的 provider 是**实际**出结果那家
//   ④ Key 留空时复用 providers 里那把，不把密钥复制成两份
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离：配置模块在 import 时读 DATA_DIR，所以必须先建空目录再动态导入。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-visionroute-'));
process.env.QQ_AGENT_DATA_DIR = tmpRoot;

const { deepseekVisionConfig, visionRoute, analyzeWithDeepseekVision, analyzeWithVision } =
  await import('../src/vision-client.js');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

const QWEN_ONLY = { route: 'auto', qwen: { apiKey: 'q', baseUrl: 'http://127.0.0.1:9/v1' }, deepseek: { apiKey: '', enabled: true } };
const BOTH = { route: 'auto', qwen: { apiKey: 'q', baseUrl: 'http://127.0.0.1:9/v1' }, deepseek: { apiKey: 'd' } };

await ok('① 两家都没配 Key 时不崩，落到千问并说明原因', () => {
  const cfg = { route: 'auto', qwen: { apiKey: '' }, deepseek: { apiKey: '', enabled: true } };
  const r = visionRoute({ kind: 'sticker', rawConfig: cfg });
  assert.strictEqual(r.provider, 'qwen');
  assert.match(r.reason, /都没 Key/);
});

await ok('② 只有 deepseek 可用时，两种 kind 都走 deepseek', () => {
  const cfg = { route: 'auto', qwen: { apiKey: '' }, deepseek: { apiKey: 'd' } };
  assert.strictEqual(visionRoute({ kind: 'sticker', rawConfig: cfg }).provider, 'deepseek');
  assert.strictEqual(visionRoute({ kind: 'message', rawConfig: cfg }).provider, 'deepseek');
});

await ok('③ 两家都可用：表情包 → deepseek，图片/截图 → 千问', () => {
  assert.strictEqual(visionRoute({ kind: 'sticker', rawConfig: BOTH }).provider, 'deepseek');
  assert.strictEqual(visionRoute({ kind: 'message', rawConfig: BOTH }).provider, 'qwen');
});

await ok('④ route 强制能压过分档（qwen 强制 / deepseek 强制）', () => {
  assert.strictEqual(visionRoute({ kind: 'sticker', rawConfig: { ...BOTH, route: 'qwen' } }).provider, 'qwen');
  assert.strictEqual(visionRoute({ kind: 'message', rawConfig: { ...BOTH, route: 'deepseek' } }).provider, 'deepseek');
});

await ok('⑤ 强制某家但它没 Key / 被禁用 → 回退另一家，不报错', () => {
  const off = { route: 'deepseek', qwen: { apiKey: 'q' }, deepseek: { apiKey: 'd', enabled: false } };
  const r = visionRoute({ kind: 'message', rawConfig: off });
  assert.strictEqual(r.provider, 'qwen');
  assert.match(r.reason, /回退/);
});

await ok('⑥ deepseek 的 Key 留空时复用 providers 里 api.deepseek.com 那把', async () => {
  // 另起一个数据目录，写一份带 provider Key 的 config.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-visionroute-prov-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    providers: [
      { baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'fake-sf-key' },
      { baseURL: 'https://api.deepseek.com', apiKey: 'fake-provide' + 'rs-ds-key' }
    ]
  }), 'utf8');
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { deepseekVisionConfig } from ${JSON.stringify(new URL('../src/vision-client.js', import.meta.url).href)};
    const c = deepseekVisionConfig();
    console.log(JSON.stringify({ hasKey: !!c.apiKey, keySource: c.keySource, model: c.model }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir },
    encoding: 'utf8'
  });
  const info = JSON.parse(out.trim());
  assert.strictEqual(info.hasKey, true);
  assert.strictEqual(info.keySource, 'providers');
  assert.strictEqual(info.model, 'deepseek-flash');
});

await ok('⑦ deepseek 请求体必须带 thinking:disabled，且模型名/图片顺序正确', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content: '一只鲸鱼' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    };
  };
  try {
    const r = await analyzeWithDeepseekVision({
      rawConfig: { apiKey: 'd' },
      dataUrls: ['data:image/jpeg;base64,AAAA'],
      prompt: '这是什么'
    });
    assert.strictEqual(captured.url, 'https://api.deepseek.com/chat/completions');
    assert.deepStrictEqual(captured.body.thinking, { type: 'disabled' }, '没关思考 = 空正文');
    assert.strictEqual(captured.body.model, 'deepseek-flash');
    const content = captured.body.messages[0].content;
    assert.strictEqual(content[0].type, 'image_url');
    assert.strictEqual(content.at(-1).type, 'text');
    assert.strictEqual(r.provider, 'deepseek');
    assert.strictEqual(r.label, 'DeepSeek');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('⑧ deepseek 返空正文时抛明确的错（而不是安静返回空串）', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) });
  try {
    await assert.rejects(
      () => analyzeWithDeepseekVision({ rawConfig: { apiKey: 'd' }, dataUrls: ['data:image/jpeg;base64,AAAA'], prompt: 'x' }),
      /没有返回文字结果/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('⑨ 一家失败自动换另一家，且标签是实际出结果那家', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('deepseek.com')) {
      return { ok: false, status: 402, json: async () => ({ error: { message: 'Insufficient Balance' } }) };
    }
    return { ok: true, json: async () => ({ model: 'qwen3-vl-plus', choices: [{ message: { content: '截图里写着 3210' } }], usage: {} }) };
  };
  try {
    const r = await analyzeWithVision({
      rawConfig: BOTH,
      kind: 'sticker',                       // 首选 deepseek，会 402
      dataUrls: ['data:image/jpeg;base64,AAAA'],
      prompt: '这是什么'
    });
    assert.strictEqual(r.provider, 'qwen');
    assert.strictEqual(r.label, 'Qwen-VL');
    assert.strictEqual(r.fallbackFrom, 'deepseek');
    assert.ok(r.failures[0].includes('deepseek'), '失败原因要留痕');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('⑩ 两家都挂时错误信息里要能看到各自的原因', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });
  try {
    await assert.rejects(
      () => analyzeWithVision({ rawConfig: BOTH, kind: 'message', dataUrls: ['data:image/jpeg;base64,AAAA'], prompt: 'x' }),
      (e) => /两家都试过/.test(e.message) && /qwen/.test(e.message) && /deepseek/.test(e.message)
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ⑪⑫ 钉住「本机 DSH 网关」这一档（2026-10-25 接入免费模型网关时新增）。
//   为什么必须单独钉：`thinking-dialect.js` 原本把所有 127.0.0.1 判成 'local'、
//   supports=[] ⇒ 一个字段都不发。而该网关实测**必须显式收到 reasoning_effort
//   才吐正文**：不发 → HTTP 200、finish_reason 正常、content = ""（2.98s）；
//   发 thinking:{type:'disabled'} → 同样 content = ""。两种都是"静默空手而归"。
await ok('⑪ 指向本机网关 8326 时必须发 reasoning_effort，且不发无效的 thinking', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ model: 'deepseek-account/deepseek-flash', choices: [{ message: { content: '一只鲸鱼' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    };
  };
  try {
    await analyzeWithDeepseekVision({
      rawConfig: { apiKey: 'gw', baseUrl: 'http://127.0.0.1:8326/v1', model: 'deepseek-account/deepseek-flash' },
      dataUrls: ['data:image/jpeg;base64,AAAA'],
      prompt: '这是什么'
    });
    assert.strictEqual(captured.url, 'http://127.0.0.1:8326/v1/chat/completions');
    assert.strictEqual(captured.body.reasoning_effort, 'none', '网关不收到 reasoning_effort = 正文空串');
    assert.strictEqual(captured.body.thinking, undefined, '网关不认 thinking，发了是噪音');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('⑫ 本机**其他**端口不能被当成网关（否则会误伤别的本地 LLM）', async () => {
  const { dialectFor } = await import('../src/thinking-dialect.js');
  const gw = dialectFor({ baseUrl: 'http://127.0.0.1:8326/v1', model: 'qoder/auto' });
  assert.strictEqual(gw.dialect, 'local-openai');
  assert.deepStrictEqual(gw.supports, ['off', 'effort']);

  const other = dialectFor({ baseUrl: 'http://127.0.0.1:9880/v1', model: 'x' });
  assert.strictEqual(other.dialect, 'local', '别的本地端口必须保持原样（什么都不发）');
  const body = {};
  other.apply(body, 'off');
  assert.deepStrictEqual(body, {}, 'local 方言不许发任何思考字段');
});

await ok('⑬ 超时**不换家**（客户端断了服务端还在跑，换家 = 一次识图付两次钱）', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const e = new Error('请求超时');
    e.name = 'TimeoutError';
    throw e;
  };
  try {
    await analyzeWithVision({
      dataUrls: ['data:image/jpeg;base64,AAAA'],
      prompt: '这是什么',
      kind: 'message',
      rawConfig: { qwen: { apiKey: 'q' }, deepseek: { enabled: true, apiKey: 'd' } }
    });
    assert.fail('两家都超时应该抛错');
  } catch (error) {
    assert.strictEqual(calls, 1, `超时后不该换家，实际打了 ${calls} 家`);
    assert.ok(String(error?.message ?? error).includes('未换家'), `错误信息要说明没换家：${error?.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('⑭ 报错（非超时）仍然换家 —— 别把"不换家"写成"永不兜底"', async () => {
  const realFetch = globalThis.fetch;
  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(String(url));
    if (tried.length === 1) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
    return { ok: true, json: async () => ({ model: 'deepseek-flash', choices: [{ message: { content: '兜底成功' } }] }) };
  };
  try {
    const r = await analyzeWithVision({
      dataUrls: ['data:image/jpeg;base64,AAAA'],
      prompt: '这是什么',
      kind: 'message',   // 首选千问，千问 500 → 应换 deepseek
      rawConfig: { qwen: { apiKey: 'q' }, deepseek: { enabled: true, apiKey: 'd' } }
    });
    assert.strictEqual(tried.length, 2, `应该试两家，实际 ${tried.length}`);
    assert.strictEqual(r.provider, 'deepseek');
    assert.strictEqual(r.label, 'DeepSeek', '标签必须是**实际**出结果那家');
    assert.strictEqual(r.fallbackFrom, 'qwen');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('⑮ 没有图片时直接报错，不白跑两家', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; };
  try {
    await analyzeWithVision({ dataUrls: [], prompt: 'x', kind: 'message' });
    assert.fail('空图片应该报错');
  } catch (error) {
    assert.strictEqual(calls, 0, '没有图还发出了请求');
    assert.ok(String(error?.message ?? error).includes('没有可识别的图片'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n[vision-route] ${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
