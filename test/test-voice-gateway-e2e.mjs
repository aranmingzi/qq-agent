// 语音网关端到端（src/voice-gateway.js）。
//
// ── 这条为什么值得单独测 ───────────────────────────────────────────────
// 前几轮反复踩的同一个坑：**接线测试测不到接线**。
// 断言源码里出现了 `authorize` 三个字，和真的有一个未授权连接被拒，是两件事。
// 所以这里起一个真的 http server + 真的 ws 客户端，走真的 upgrade，
// 只把「识别/生成/合成」这三个花钱的外部依赖换成假的。
//
// 钉的是：
//   ① 未授权 / 错路径的 upgrade 必须被拒（默认拒绝，不是默认放行）；
//   ② 推 PCM → 收到 asr → 收到 reply → 收到音频二进制；
//   ③ interrupt 会发 stop-playback；
//   ④ maxTurns 到点发 closed；
//   ⑤ 任何一步失败都要发 error，绝不能沉默。
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

const { attachVoiceGateway } = await import('../src/voice-gateway.js');

let pass = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); } catch (e) {
    failures.push(`${name}: ${e?.message ?? e}`);
    console.error('  ✗', name, '\n     ', e?.message ?? e);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('  ✓', name);
}

/** 造一段 16kHz 单声道 PCM：振幅 amp，时长 ms。 */
function pcm(ms, amp = 0.5) {
  const samples = Math.round((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  const v = Math.max(-32768, Math.min(32767, Math.round(amp * 32768)));
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(v, i * 2);
  return buf;
}

/**
 * 起一个带语音网关的真 server。
 * transcribe / synthesize / turn 默认都是假的，返回固定内容。
 */
async function boot({ authorize = () => true, config = {}, transcribe, synthesize, turn } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const gateway = attachVoiceGateway({
    server,
    authorize,
    log: () => {},
    transcribe: transcribe ?? (async () => '你好呀'),
    synthesize: synthesize ?? (async () => Buffer.from('FAKE-MP3-BYTES')),
    turn: turn ?? (async () => ({ reply: '我在呢。', usedModel: true })),
    config: {
      vadMinSpeechMs: 100,
      vadSilenceMs: 200,
      idleTimeoutMs: 60000,
      ...config
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `ws://127.0.0.1:${port}/voice/ws`,
    async close() {
      await gateway.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    gateway
  };
}

/** 连上去并收集消息，返回一个可控的客户端。 */
function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const events = [];
    const waiters = [];
    let binary = [];

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binary.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return;
      }
      let msg = null;
      try { msg = JSON.parse(String(data)); } catch { return; }
      events.push(msg);
      for (const w of [...waiters]) {
        if (w.match(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });

    ws.on('open', () => resolve({
      ws,
      events,
      binary,
      /** 等一条满足条件的消息（已经收到过就直接返回）。 */
      waitFor(match, timeoutMs = 4000) {
        const found = events.find(match);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`等待超时，已有消息：${JSON.stringify(events.map((e) => e.type))}`)), timeoutMs);
          waiters.push({ match, resolve: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
      terminate() { try { ws.terminate(); } catch { /* ignore */ } }
    }));
    ws.on('error', reject);
  });
}

/** 推 ms 毫秒的音频（按 20ms 一帧推）。 */
function pushAudio(client, ms, amp = 0.5) {
  for (let sent = 0; sent < ms; sent += 20) {
    client.ws.send(pcm(20, amp), { binary: true });
  }
}

console.log('[voice-gateway]');

// ── 鉴权 ────────────────────────────────────────────────────────────
await ok('未授权的 upgrade 被拒（默认拒绝，不是默认放行）', async () => {
  const env = await boot({ authorize: () => false });
  try {
    await assert.rejects(
      () => connect(env.url),
      (e) => /401|Unexpected server response/.test(String(e?.message ?? e)),
      '未授权连接不该建立成功'
    );
    assert.equal(env.gateway.stats().rejected, 1, '应该记一次拒绝');
    assert.equal(env.gateway.stats().connections, 0, '不该有连接建立');
  } finally {
    await env.close();
  }
});

await ok('授权通过时能连上，并收到 ready', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    const ready = await c.waitFor((m) => m.type === 'ready');
    assert.equal(ready.vad, 'energy');
    assert.equal(ready.ttsFormat, 'mp3');
    assert.equal(ready.sampleRate, 16000);
  } finally {
    c.close();
    await env.close();
  }
});

await ok('错路径的 upgrade 被掐掉（不会误挂到别的 ws 消费者上）', async () => {
  const env = await boot();
  try {
    const wrong = env.url.replace('/voice/ws', '/other/ws');
    await assert.rejects(() => connect(wrong), (e) => /socket hang up|ECONNRESET|Unexpected/.test(String(e?.message ?? e)));
  } finally {
    await env.close();
  }
});

await ok('authorize 抛异常时按拒绝处理（不能因为鉴权代码 bug 就放行）', async () => {
  const env = await boot({ authorize: () => { throw new Error('boom'); } });
  try {
    await assert.rejects(() => connect(env.url), (e) => /401|Unexpected/.test(String(e?.message ?? e)));
  } finally {
    await env.close();
  }
});

// ── 主链路：音频 → asr → reply → 音频 ──────────────────────────────
await ok('推一段 PCM：依次收到 speech-start / speech-end / asr / reply / 音频二进制', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    await c.waitFor((m) => m.type === 'state' && m.state === 'listening');

    pushAudio(c, 300, 0.5);          // 说话
    pushAudio(c, 300, 0.001);        // 静音 → 触发断句

    await c.waitFor((m) => m.type === 'speech-start');
    await c.waitFor((m) => m.type === 'speech-end');
    const asr = await c.waitFor((m) => m.type === 'asr');
    assert.equal(asr.text, '你好呀');

    const reply = await c.waitFor((m) => m.type === 'reply');
    assert.equal(reply.text, '我在呢。');

    // 音频二进制帧
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('没收到音频二进制帧')), 4000);
      const tick = setInterval(() => {
        if (c.binary.length > 0) { clearTimeout(t); clearInterval(tick); res(); }
      }, 20);
    });
    assert.equal(c.binary[0].toString(), 'FAKE-MP3-BYTES');
    assert.equal(env.gateway.stats().turns, 1);
  } finally {
    c.close();
    await env.close();
  }
});

await ok('状态机走过 listening → transcribing → thinking → speaking', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5);
    pushAudio(c, 300, 0.001);
    await c.waitFor((m) => m.type === 'reply');
    const states = c.events.filter((m) => m.type === 'state').map((m) => m.state);
    for (const s of ['listening', 'transcribing', 'thinking', 'speaking']) {
      assert.ok(states.includes(s), `状态序列里应该有 ${s}，实际：${states.join(',')}`);
    }
  } finally {
    c.close();
    await env.close();
  }
});

await ok('第二轮会带上上一轮的历史（多轮通话记得住上下文）', async () => {
  const seen = [];
  const env = await boot({
    turn: async ({ text, history }) => { seen.push({ text, history: history.slice() }); return { reply: `回:${text}` }; }
  });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    await c.waitFor((m) => m.type === 'reply');
    await new Promise((r) => setTimeout(r, 100));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(seen.length, 2, `应该跑了两轮，实际 ${seen.length}`);
    assert.equal(seen[0].history.length, 0, '第一轮没有历史');
    assert.equal(seen[1].history.length, 2, '第二轮应该带上上一轮的一问一答');
    assert.equal(seen[1].history[0].content, '你好呀');
    assert.equal(seen[1].history[1].content, '回:你好呀');
  } finally {
    c.close();
    await env.close();
  }
});

// ── 打断 ────────────────────────────────────────────────────────────
await ok('interrupt 发 stop-playback（这就是"抢话"的落地）', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    await c.waitFor((m) => m.type === 'state' && m.state === 'listening');
    c.ws.send(JSON.stringify({ type: 'interrupt' }));
    const stop = await c.waitFor((m) => m.type === 'stop-playback');
    assert.equal(stop.reason, 'user');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('barge-in 也发 stop-playback，但不会把连接搞坏', async () => {
  const env = await boot({ config: { bargeIn: true } });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    c.ws.send(JSON.stringify({ type: 'barge-in' }));
    const stop = await c.waitFor((m) => m.type === 'stop-playback');
    assert.equal(stop.reason, 'barge-in');
    // 之后还能正常通话
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    await c.waitFor((m) => m.type === 'reply');
  } finally {
    c.close();
    await env.close();
  }
});

// ── 各种失败都要说出来 ─────────────────────────────────────────────
await ok('识别失败 → 发 error(asr-failed)，并回到 listening（不静默、不崩）', async () => {
  const env = await boot({ transcribe: async () => { throw new Error('ASR 挂了'); } });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    const err = await c.waitFor((m) => m.type === 'error');
    assert.equal(err.code, 'asr-failed');
    assert.match(err.message, /ASR 挂了/);
    const back = await c.waitFor((m) => m.type === 'state' && m.state === 'listening');
    assert.ok(back, '出错后必须回到能继续听的状态');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('识别结果为空（只是噪音）→ dropped(no-speech)，不当成故障弹错误', async () => {
  const env = await boot({ transcribe: async () => '   ' });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    const d = await c.waitFor((m) => m.type === 'dropped');
    assert.equal(d.reason, 'no-speech');
    assert.equal(c.events.filter((m) => m.type === 'error').length, 0, '噪音不该报 error');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('合成失败 → 仍然把回复文本给前端，并报 error(tts-failed)', async () => {
  const env = await boot({ synthesize: async () => { throw new Error('TTS 挂了'); } });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    await c.waitFor((m) => m.type === 'reply');
    const err = await c.waitFor((m) => m.type === 'error');
    assert.equal(err.code, 'tts-failed');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('合成结果为空 → error(tts-empty)，不推空音频帧', async () => {
  const env = await boot({ synthesize: async () => Buffer.alloc(0) });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    const err = await c.waitFor((m) => m.type === 'error');
    assert.equal(err.code, 'tts-empty');
    assert.equal(c.binary.length, 0, '不该推空音频');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('太短的音频（100ms）不送去识别，直接 dropped(too-short)', async () => {
  let called = 0;
  const env = await boot({
    transcribe: async () => { called += 1; return '不该到这'; },
    config: { vadMinSpeechMs: 20, vadSilenceMs: 60 }
  });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 60, 0.5);   // 只有 60ms 有声
    pushAudio(c, 100, 0.001);
    const d = await c.waitFor((m) => m.type === 'dropped');
    assert.ok(['too-short', 'no-speech'].includes(d.reason), `实际 reason=${d.reason}`);
    assert.equal(called, 0, '太短的段不该花钱调识别');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('非法 JSON 控制消息 → error(bad-json)，连接不断', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send('这不是 JSON');
    const err = await c.waitFor((m) => m.type === 'error');
    assert.equal(err.code, 'bad-json');
    // 连接还活着
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.waitFor((m) => m.type === 'pong');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('不认识的控制消息 → error(unknown-type)，说清楚是哪个', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'nonsense' }));
    const err = await c.waitFor((m) => m.type === 'error');
    assert.equal(err.code, 'unknown-type');
    assert.match(err.message, /nonsense/);
  } finally {
    c.close();
    await env.close();
  }
});

// ── 上限 ────────────────────────────────────────────────────────────
await ok('maxTurns 到点发 closed(max-turns)', async () => {
  const env = await boot({ config: { maxTurns: 1 } });
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    await c.waitFor((m) => m.type === 'reply');
    const closed = await c.waitFor((m) => m.type === 'closed');
    assert.equal(closed.reason, 'max-turns');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('stop 控制消息：把没断完的那段强制送去识别', async () => {
  const env = await boot({ config: { vadSilenceMs: 5000 } });   // 永远等不到自动断句
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 400, 0.5);        // 说 400ms，然后不发静音
    c.ws.send(JSON.stringify({ type: 'stop' }));
    const asr = await c.waitFor((m) => m.type === 'asr');
    assert.equal(asr.text, '你好呀');
  } finally {
    c.close();
    await env.close();
  }
});

await ok('stop 时什么都没说 → dropped(nothing-to-send)', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    c.ws.send(JSON.stringify({ type: 'stop' }));
    const d = await c.waitFor((m) => m.type === 'dropped');
    assert.equal(d.reason, 'nothing-to-send');
  } finally {
    c.close();
    await env.close();
  }
});

// ── 生命周期 ────────────────────────────────────────────────────────
await ok('close() 之后不再接受新连接，已有连接被断开', async () => {
  const env = await boot();
  const c = await connect(env.url);
  await c.waitFor((m) => m.type === 'ready');
  await env.close();
  await assert.rejects(() => connect(env.url), (e) => /ECONNREFUSED|Unexpected|hang up/.test(String(e?.message ?? e)));
  c.terminate();
});

await ok('stats() 记到连接数 / 轮数', async () => {
  const env = await boot();
  const c = await connect(env.url);
  try {
    c.ws.send(JSON.stringify({ type: 'start' }));
    pushAudio(c, 300, 0.5); pushAudio(c, 300, 0.001);
    await c.waitFor((m) => m.type === 'reply');
    const s = env.gateway.stats();
    assert.equal(s.connections, 1);
    assert.ok(s.turns >= 1);
    assert.ok(s.segments >= 1);
  } finally {
    c.close();
    await env.close();
  }
});

console.log(`\n[voice-gateway] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
