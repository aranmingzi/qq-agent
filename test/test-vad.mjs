// 语音活动检测（src/vad.js）。
//
// ── 这条为什么值得单独测 ───────────────────────────────────────────────
// 打电话最难的不是识别，是「什么时候认为你说完了」。
// 判早了它抢话，判晚了每轮干等一秒多，判漏了它就一直不出声。
// 而这三种错都不会抛异常 —— 用户只会觉得"它不好用"，日志里干干净净。
//
// 所以这里钉的是：
//   ① 短促杂音（键盘、关门）不能触发「开始说话」；
//   ② 说完了只报一次 speech-end，不能重复报；
//   ③ pre-roll 要保住第一个字，尾音也不能被削掉；
//   ④ 时钟可注入，测试里不 sleep（否则机器一卡就偶发失败）。
import assert from 'node:assert/strict';

const { createVad, DEFAULT_THRESHOLD, DEFAULT_FRAME_MS } = await import('../src/vad.js');
const { pcmDurationMs } = await import('../src/pcm.js');

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

/** 造一段 16kHz 单声道 PCM：恒定振幅 amp（0..1），时长 ms。RMS 就等于 amp。 */
function frame(ms, amp = 0) {
  const samples = Math.round((16000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  const v = Math.max(-32768, Math.min(32767, Math.round(amp * 32768)));
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(v, i * 2);
  return buf;
}

/** 连续推 n 帧同样的音频，收集事件。 */
function feed(vad, n, ms, amp, t0 = 0) {
  const events = [];
  for (let i = 0; i < n; i += 1) {
    const r = vad.push(frame(ms, amp), t0 + i * ms);
    if (r.event) events.push({ ...r, at: t0 + i * ms });
  }
  return events;
}

const QUIET = 0.002;   // 远低于阈值，当静音
const LOUD = 0.5;      // 远高于阈值，当说话

console.log('[vad]');

// ── 基础：静音不触发 ────────────────────────────────────────────────
await ok('一直静音：永远不触发任何事件', () => {
  const vad = createVad();
  const events = feed(vad, 100, 20, QUIET);
  assert.equal(events.length, 0);
  assert.equal(vad.state, 'idle');
});

await ok('空帧 / 零字节帧被安全忽略（不会算出 NaN 时长）', () => {
  const vad = createVad();
  assert.deepEqual(vad.push(Buffer.alloc(0), 0), { event: null, segment: null, ms: 0 });
  assert.deepEqual(vad.push(null, 0), { event: null, segment: null, ms: 0 });
  assert.equal(vad.state, 'idle');
  assert.equal(vad.snapshot().segmentMs, 0);
});

// ── 短促杂音不能触发 ────────────────────────────────────────────────
await ok('短促杂音（100ms）不触发「开始说话」', () => {
  const vad = createVad({ minSpeechMs: 250 });
  const events = feed(vad, 5, 20, LOUD);   // 100ms
  assert.equal(events.length, 0, '键盘/关门声不该被当成一句话');
  assert.equal(vad.state, 'idle');
});

await ok('minSpeechMs 边界：240ms 不触发，260ms 触发', () => {
  const a = createVad({ minSpeechMs: 250 });
  assert.equal(feed(a, 12, 20, LOUD).length, 0, '240ms');

  const b = createVad({ minSpeechMs: 250 });
  const ev = feed(b, 13, 20, LOUD);        // 260ms
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, 'speech-start');
  assert.equal(b.state, 'speech');
});

await ok('间断的杂音（响一下停一下）不会累积成一句话', () => {
  const vad = createVad({ minSpeechMs: 250 });
  for (let i = 0; i < 10; i += 1) {
    feed(vad, 5, 20, LOUD);   // 100ms 有声
    feed(vad, 1, 20, QUIET);  // 20ms 静音，把连击打断
  }
  assert.equal(vad.state, 'idle');
});

// ── 说完了只报一次 ──────────────────────────────────────────────────
await ok('speech-end 在 silenceMs 处只报一次，之后不再重复', () => {
  const vad = createVad({ minSpeechMs: 100, silenceMs: 700, keepTailMs: 0 });
  const events = [];
  // 说 300ms
  for (let i = 0; i < 15; i += 1) {
    const r = vad.push(frame(20, LOUD), i * 20);
    if (r.event) events.push(r.event);
  }
  assert.deepEqual(events, ['speech-start']);
  // 静音 680ms：还不该结束
  let ended = 0;
  for (let i = 0; i < 34; i += 1) {
    const r = vad.push(frame(20, QUIET), 300 + i * 20);
    if (r.event === 'speech-end') ended += 1;
  }
  assert.equal(ended, 0, '680ms 静音还不该断句');
  // 再 20ms，凑够 700
  const r = vad.push(frame(20, QUIET), 1000);
  assert.equal(r.event, 'speech-end');
  // 继续静音不该再报
  const more = feed(vad, 50, 20, QUIET, 1020);
  assert.equal(more.length, 0, 'speech-end 只能报一次');
  assert.equal(vad.state, 'idle');
});

await ok('两段独立的话各自报 start/end，不串在一起', () => {
  const vad = createVad({ minSpeechMs: 100, silenceMs: 300, keepTailMs: 0 });
  const events = [];
  const run = (n, amp, t0) => {
    for (let i = 0; i < n; i += 1) {
      const r = vad.push(frame(20, amp), t0 + i * 20);
      if (r.event) events.push(r.event);
    }
  };
  run(15, LOUD, 0);        // 第一段 300ms
  run(20, QUIET, 300);     // 400ms 静音 → 结束
  run(15, LOUD, 700);      // 第二段 300ms
  run(20, QUIET, 1000);
  assert.deepEqual(events, ['speech-start', 'speech-end', 'speech-start', 'speech-end']);
});

// ── pre-roll / 尾音 ────────────────────────────────────────────────
await ok('pre-roll：第一个字不会被吃掉（段首带上了说话前的缓冲）', () => {
  const vad = createVad({ minSpeechMs: 250, silenceMs: 400, preRollMs: 200, keepTailMs: 200 });
  // 先 500ms 静音，让 pre-roll 攒满
  feed(vad, 25, 20, QUIET);
  // 再说 300ms
  feed(vad, 15, 20, LOUD, 500);
  // 再说 400ms 静音触发结束
  const events = feed(vad, 20, 20, QUIET, 800);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'speech-end');
  const segMs = pcmDurationMs(events[0].segment.length);
  // 200ms 前置缓冲 + 300ms 说话 + 200ms 尾音 ≈ 700ms
  assert.ok(segMs >= 640 && segMs <= 780, `段长 ${segMs}ms 应在 640~780 之间`);
});

await ok('尾音保留：keepTailMs=0 时段长明显更短（说明尾音确实被留下来了）', () => {
  const make = (keepTailMs) => {
    const vad = createVad({ minSpeechMs: 100, silenceMs: 300, preRollMs: 0, keepTailMs });
    feed(vad, 10, 20, QUIET);
    feed(vad, 15, 20, LOUD, 200);
    const ev = feed(vad, 15, 20, QUIET, 500);
    return pcmDurationMs(ev[0].segment.length);
  };
  assert.ok(make(200) > make(0), 'keepTailMs=200 应该比 0 更长');
});

await ok('整段都没声时不会产出一个空段（trimTail 兜住）', () => {
  const vad = createVad({ minSpeechMs: 20, silenceMs: 100, keepTailMs: 0 });
  feed(vad, 5, 20, LOUD);          // 触发
  const ev = feed(vad, 10, 20, QUIET, 100);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].segment.length > 0);
});

// ── flush / reset ─────────────────────────────────────────────────
await ok('flush：说话中途强制收尾，返回这一段的字节', () => {
  const vad = createVad({ minSpeechMs: 100 });
  feed(vad, 20, 20, LOUD);         // 400ms，已触发
  assert.equal(vad.state, 'speech');
  const seg = vad.flush();
  assert.ok(Buffer.isBuffer(seg));
  assert.ok(seg.length > 0);
  assert.equal(vad.state, 'idle', 'flush 之后回到 idle');
  assert.equal(vad.flush(), null, '再 flush 一次没有东西可给');
});

await ok('flush：没在说话时返回 null（上层据此判断"这次没什么可识别"）', () => {
  const vad = createVad();
  feed(vad, 3, 20, QUIET);
  assert.equal(vad.flush(), null);
});

await ok('reset()：状态与统计全部归零', () => {
  const vad = createVad({ minSpeechMs: 100 });
  feed(vad, 20, 20, LOUD);
  assert.equal(vad.state, 'speech');
  vad.reset();
  const s = vad.snapshot();
  assert.equal(s.state, 'idle');
  assert.equal(s.level, 0);
  assert.equal(s.smoothLevel, 0);
  assert.equal(s.segmentMs, 0);
  assert.equal(s.voicedRunMs, 0);
  assert.equal(s.silenceRunMs, 0);
  assert.equal(s.segmentStartedAt, null);
});

// ── 时钟可注入 ────────────────────────────────────────────────────
await ok('时钟可注入：不传 at 时用注入的时钟，不碰真实 Date.now', () => {
  let clock = 1000;
  const vad = createVad({ minSpeechMs: 100, now: () => clock });
  // 关键：这里**不传** at，让 VAD 自己去问注入的时钟
  for (let i = 0; i < 20; i += 1) vad.push(frame(20, LOUD));
  const s = vad.snapshot();
  assert.equal(s.segmentStartedAt, 1000, '应该用注入的时钟 1000，而不是真实 Date.now');
  clock = 999999;
  assert.equal(vad.snapshot().segmentStartedAt, 1000, '时钟变化不该影响已记录的起点');
});

await ok('显式传 at 时以 at 为准（调用方可以给更准的时间戳）', () => {
  const vad = createVad({ minSpeechMs: 100, now: () => 777777 });
  for (let i = 0; i < 20; i += 1) vad.push(frame(20, LOUD), 5000 + i * 20);
  assert.equal(vad.snapshot().segmentStartedAt, 5000, '取第一帧自己的时间戳');
});

// ── 阈值 ──────────────────────────────────────────────────────────
await ok('阈值：恰好等于阈值算有声（>= 而不是 >）', () => {
  const vad = createVad({ threshold: 0.1, minSpeechMs: 20 });
  const events = feed(vad, 1, 20, 0.1);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'speech-start');
});

await ok('setThreshold：它说话时调高阈值，同一个音量就不再触发（防听见自己）', () => {
  const vad = createVad({ threshold: DEFAULT_THRESHOLD, minSpeechMs: 20 });
  assert.equal(vad.setThreshold(0.9), 0.9);
  assert.equal(vad.threshold, 0.9);
  const events = feed(vad, 20, 20, LOUD);   // 0.5 < 0.9
  assert.equal(events.length, 0, '阈值调高后 0.5 的音量不该再触发');
  vad.setThreshold(0.1);
  assert.equal(feed(vad, 20, 20, LOUD, 1000).length, 1, '调回来就能触发');
});

await ok('setThreshold：非法值被忽略，不会把阈值改成 0 或 NaN', () => {
  const vad = createVad({ threshold: 0.05 });
  for (const bad of [0, -1, NaN, 'abc', null, undefined]) vad.setThreshold(bad);
  assert.equal(vad.threshold, 0.05);
});

// ── 电平（给 UI 电平条） ──────────────────────────────────────────
await ok('level / smoothLevel：静音时接近 0，说话时接近实际振幅', () => {
  const vad = createVad();
  vad.push(frame(20, 0), 0);
  assert.ok(vad.level < 1e-6);
  vad.push(frame(20, 0.5), 20);
  assert.ok(Math.abs(vad.level - 0.5) < 1e-3, `level=${vad.level}`);
  // 快升慢降：紧接一个静音帧，smoothLevel 不该立刻掉到 0
  const before = vad.smoothLevel;
  vad.push(frame(20, 0), 40);
  assert.ok(vad.smoothLevel > 0, 'smoothLevel 应该慢慢降');
  assert.ok(vad.smoothLevel < before);
});

await ok('snapshot 是快照不是活引用（改它不影响内部状态）', () => {
  const vad = createVad({ minSpeechMs: 100 });
  feed(vad, 20, 20, LOUD);
  const s = vad.snapshot();
  s.state = 'tampered';
  s.segmentMs = -1;
  assert.equal(vad.state, 'speech');
  assert.ok(vad.snapshot().segmentMs > 0);
});

await ok('默认帧长常量与 16000Hz 对齐（640 字节 = 20ms）', () => {
  assert.equal(DEFAULT_FRAME_MS, 20);
  assert.equal(pcmDurationMs(640), 20);
});

console.log(`\n[vad] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
