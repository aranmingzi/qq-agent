// 语音通话状态接口的接线测试。
//
// 为什么这个测试存在：
// 「语音通话」页在打开前会先问 /api/voice/status。如果这个接口没接上，
// 前端只会看到一个按了没反应的按钮 —— 用户分不清「没配 Key」和「功能没做」。
// 所以这里断言的不是"字段存在"，而是**每条不能打的原因都真的被说出来**。
//
// 这一轮踩过的坑：只断言源码里有 `pathname === '/api/voice/status'` 是没用的，
// 那种测试在把整段路由删掉之后照样绿。必须真的起一个 app、真的发一次请求。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import config/app 之前定好数据目录，否则会读写真实 data/
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-voice-status-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

let pass = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}：期望 ${e}，实际 ${a}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const port = await freePort();
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  // 尽量把 app 拉起来但别真去连协议端/真去跑主动消息
  server: { port, token: '', bindHost: '127.0.0.1' },
  snowluma: { autoLaunch: false, wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9', accessToken: '' },
  proactive: { enabled: false },
  api: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fake-k', model: 'm' },
  audio: { enabled: true, apiKey: 'fake-dashsco' + 'pe-key', gsvAutoStart: false, gsvUrl: 'http://127.0.0.1:9' }
}));

const { createApp } = await import('../src/app.js');
const { getConfig, updateConfig } = await import('../src/config.js');
const original = JSON.parse(JSON.stringify(getConfig()));

const app = createApp({ log: () => {} });
await app.start();

try {
  await ok('授权后返回结构完整的可用性报告', async () => {
    const r = await get(port, '/api/voice/status');
    assertEqual(r.status, 200, '状态码');
    const b = r.body;
    assert(typeof b.enabled === 'boolean', 'enabled 应是布尔');
    assert(typeof b.ready === 'boolean', 'ready 应是布尔');
    assert(Array.isArray(b.problems), 'problems 应是数组');
    assertEqual(b.wsPath, '/voice/ws', 'ws 路径');
    assert(b.vad && typeof b.vad.threshold === 'number', 'vad.threshold 应是数字');
    assert(b.vad.minSpeechMs > 0 && b.vad.silenceMs > 0, 'vad 断句参数应为正数');
    assert(b.limits && b.limits.maxTurns > 0, 'limits.maxTurns 应为正数');
    assertEqual(b.micRequiresSecureContext, true, '麦克风需要安全上下文');
  });

  await ok('网关真的挂上了：stats 有结构（不是 null）', async () => {
    const r = await get(port, '/api/voice/status');
    assertEqual(r.status, 200, '状态码');
    assert(r.body.stats, 'stats 不该是 null —— 说明网关没挂上');
    assert(typeof r.body.stats.connections === 'number', 'stats.connections 应是数字');
  });

  await ok('有 Key 时 ready=true（否则前端会一直说"打不了"）', async () => {
    const r = await get(port, '/api/voice/status');
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.problems, [], '不该有阻塞原因');
    assertEqual(r.body.ready, true, 'ready 应为 true');
  });

  await ok('关掉 voice.enabled 后：enabled=false 且原因说得出来', async () => {
    updateConfig({ voice: { enabled: false } });
    const r = await get(port, '/api/voice/status');
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.enabled, false, 'enabled');
    assertEqual(r.body.ready, false, 'ready');
    assert(
      r.body.problems.some((p) => p.includes('config.voice.enabled=false')),
      `应指出是配置关的，实际：${JSON.stringify(r.body.problems)}`
    );
    updateConfig({ voice: { enabled: true } });
  });

  await ok('没有 DashScope Key 时：ready=false 且点名缺 Key', async () => {
    updateConfig({ audio: { apiKey: '', asr: { apiKey: '' } } });
    const r = await get(port, '/api/voice/status');
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.ready, false, 'ready 应为 false');
    assert(
      r.body.problems.some((p) => p.includes('DashScope Key')),
      `应点名缺 Key，实际：${JSON.stringify(r.body.problems)}`
    );
    updateConfig({ audio: { apiKey: original.audio.apiKey } });
  });

  await ok('设了 server.token 后：未带 cookie 的请求 401（状态接口也不白送）', async () => {
    updateConfig({ server: { token: 'voice-fake-t' + 'oken' } });
    const r = await get(port, '/api/voice/status');
    assertEqual(r.status, 401, '应拒绝');
    updateConfig({ server: { token: '' } });
  });

  // 上面那些只证明「状态接口存在」，证明不了 upgrade 钩子真的挂上了。
  // 这一条用真正的 ws 客户端连真正的 app —— 只有它能证明接线是对的。
  await ok('真实 app 上 /voice/ws 能握手并收到 ready（接线真的通了）', async () => {
    const { default: WebSocket } = await import('ws');
    const msg = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/ws`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('10 秒没收到 ready'));
      }, 10000);
      ws.on('message', (raw) => {
        let parsed = null;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        if (parsed?.type === 'ready') {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          resolve(parsed);
        }
      });
      ws.on('error', (error) => { clearTimeout(timer); reject(new Error(`ws error: ${error.message}`)); });
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`握手被拒：HTTP ${res.statusCode}`));
      });
    });
    assertEqual(msg.sampleRate, 16000, '采样率');
    assertEqual(msg.vad, 'energy', '断句方式');
    assert(msg.asrModel, 'asrModel 不该是空的');
  });

  await ok('别的路径不会被误挂到通话网关（不会抢别人的 ws）', async () => {
    const { default: WebSocket } = await import('ws');
    const outcome = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/not-voice`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        resolve('timeout');
      }, 5000);
      ws.on('open', () => { clearTimeout(timer); resolve('open'); });
      ws.on('error', (e) => { clearTimeout(timer); resolve(`rejected:${e.message}`); });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve(`rejected:HTTP ${res.statusCode}`); });
    });
    assert(outcome.startsWith('rejected'), `错路径应被拒，实际：${outcome}`);
  });
} finally {
  try { await app.stop(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n[voice-status] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
