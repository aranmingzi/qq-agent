// 语音网关的电平推送限流（src/voice-gateway.js LEVEL_PUSH_MS）。
//
// ── 这条为什么值得单独测 ──────────────────────────────────────────────
// 「每帧回一条 level JSON」是这轮卡顿的另一半：前端按 8ms 一帧推 PCM，
// 服务端就 8ms 回一条 JSON。光改前端（攒成 100ms 一块）只能把新客户端的
// 流量压下来 —— 老客户端、或者别的调用方一帧一帧推，服务端还是会狂发。
//
// 所以这里起真 server、真 ws 客户端，**故意按 20ms 一帧推**（比前端的
// 100ms 更碎），数服务端回了多少条 level。如果限流被删掉，会回到 25 条；
// 有限流则只有少数几条。
//
// 跑法：node test/test-voice-level-throttle.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

const { attachVoiceGateway, LEVEL_PUSH_MS } = await import('../src/voice-gateway.js');

let pass = 0;
const failures = [];
async function ok(name, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push(`${name}: ${e?.message ?? e}`);
    console.error('  ✗', name, '\n     ', e?.message ?? e);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('  ✓', name);
}

/** 造一段 16kHz 单声道 PCM（低振幅 = 不触发 VAD 的语音段）。 */
function pcm(ms, amp = 0.004) {
  const samples = Math.round((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  const v = Math.max(-32768, Math.min(32767, Math.round(amp * 32768)));
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(v, i * 2);
  return buf;
}

async function boot() {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const gateway = attachVoiceGateway({
    server,
    authorize: () => true,
    log: () => {},
    transcribe: async () => 'x',
    synthesize: async () => Buffer.from('M'),
    turn: async () => ({ reply: 'y', usedModel: true }),
    // 阈值调高，保证这份低振幅音频永远不触发 speech-start/end，
    // 那样「除了 level 之外没有任何消息」，计数才是干净的。
    config: { vadThreshold: 0.05, vadMinSpeechMs: 100, vadSilenceMs: 200, idleTimeoutMs: 60000 },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, gateway, server };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        events.push(JSON.parse(String(data)));
      } catch {
        /* ignore */
      }
    });
    ws.on('open', () =>
      resolve({
        ws,
        events,
        waitFor(match, timeoutMs = 4000) {
          const found = events.find(match);
          if (found) return Promise.resolve(found);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('等待超时')), timeoutMs);
            const tick = setInterval(() => {
              const hit = events.find(match);
              if (hit) {
                clearInterval(tick);
                clearTimeout(timer);
                res(hit);
              }
            }, 10);
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      }),
    );
    ws.on('error', reject);
  });
}

console.log('[voice-level-throttle]');

// ── 1. 20ms 一帧推 1 秒，level 条数应远少于帧数 ─────────────────────────
await ok('20ms 一帧推 1 秒：level 条数受 LEVEL_PUSH_MS 限制，远少于帧数', async () => {
  const env = await boot();
  const client = await connect(`ws://127.0.0.1:${env.port}/voice/ws`);
  try {
    client.ws.send(JSON.stringify({ type: 'start' }));
    await client.waitFor((m) => m.type === 'state' && m.state === 'listening');

    // 1 秒 / 20ms = 50 帧
    const t0 = Date.now();
    for (let i = 0; i < 50; i += 1) {
      client.ws.send(pcm(20), { binary: true });
      await new Promise((r) => setTimeout(r, 20));
    }
    const elapsedMs = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 300));

    // 上限必须按**实测**耗时算：循环里每次 setTimeout(20) 都带调度开销，
    // 真实耗时通常 1.1~1.3 秒。按假定的 1000ms 算会把正常结果判成失败
    // —— 第一次写这条测试就踩了（25 条 > 22 条的上限）。
    const cap = Math.ceil(elapsedMs / LEVEL_PUSH_MS) + 2;
    const levels = client.events.filter((m) => m.type === 'level');
    assert.ok(levels.length > 0, '至少应该推过一条 level（否则前端画不出电平）');
    assert.ok(
      levels.length <= cap,
      `${elapsedMs}ms 内 level 应为 ≤ ${cap} 条，实际 ${levels.length} 条 —— 限流没生效`,
    );
    // 真正的护栏：未限流时帧数 50 → 消息数也是 50
    assert.ok(levels.length < 50, `level 条数 ${levels.length} 说明回到了每帧一条`);
    console.log(`      实测 ${levels.length} 条 / 50 帧 / ${elapsedMs}ms（上限 ${cap}）`);
  } finally {
    client.close();
    await env.gateway.close();
    await new Promise((r) => env.server.close(r));
  }
});

// ── 2. 常量本身要被导出且合理 ─────────────────────────────────────────
await ok('LEVEL_PUSH_MS 已导出且落在 30–200ms 之间', () => {
  assert.equal(typeof LEVEL_PUSH_MS, 'number');
  assert.ok(LEVEL_PUSH_MS >= 30 && LEVEL_PUSH_MS <= 200, `实际 ${LEVEL_PUSH_MS}`);
});

// ── 3. 一次都不推 PCM 时，不该冒出 level ───────────────────────────────
await ok('没推音频就不该有 level 消息', async () => {
  const env = await boot();
  const client = await connect(`ws://127.0.0.1:${env.port}/voice/ws`);
  try {
    client.ws.send(JSON.stringify({ type: 'start' }));
    await client.waitFor((m) => m.type === 'state' && m.state === 'listening');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(client.events.filter((m) => m.type === 'level').length, 0, '没有音频不该推电平');
  } finally {
    client.close();
    await env.gateway.close();
    await new Promise((r) => env.server.close(r));
  }
});

// ── 结果 ──────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败，${pass} 条通过`);
  for (const item of failures) console.log(`   · ${item}`);
} else {
  console.log(`✓ 全部通过（${pass} 条）`);
}
