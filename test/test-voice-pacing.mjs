// 语音通话「持续卡顿」的回归测试（console/src/lib/voice-client.ts）。
//
// ── 这条为什么值得单独测 ───────────────────────────────────────────────
// 卡顿的成因不是某一行写错了，而是**频率**：
// AudioWorklet 每 8ms 回调一次（16kHz / 128 样本），原实现回调一次就
//   · 转一次 Int16（新分配一块内存）
//   · ws.send 一个独立二进制帧（256 字节载荷 + 2~6 字节帧头）
//   · 调一次 onLevel → 页面 setState → 整个 492 行通话页重渲染
// 也就是每秒 125 次。用户看到的就是「一直卡」。
//
// 这种 bug 用「断言源码里有 CHUNK_MS 三个字」是测不出来的 ——
// 上一轮的教训（docs/能力前置可见化-2026-10-29.md）就是这么翻车的。
// 所以这里**真跑** PcmChunker：喂 1 秒的 128 样本帧，数输出块数。
//
// 跑法：node test/test-voice-pacing.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(path.join(root, 'console/src/lib/voice-client.ts')).href);
const { PcmChunker, shouldEmitLevel, CHUNK_MS, LEVEL_INTERVAL_MS } = mod;

let pass = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log(`  ✓ ${name}`);
}

/** 造一帧 128 样本的 16k 正弦波。 */
function frame128(index = 0) {
  const out = new Float32Array(128);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.sin(((index * 128 + i) / 16000) * 2 * Math.PI * 440) * 0.5;
  }
  return out;
}

const Q = 128;                 // AudioWorklet 渲染量子
const RATE = 16000;
const FRAMES_PER_SEC = RATE / Q;   // 125

console.log('\n语音发送节流\n');

// ── 1. PcmChunker：1 秒的帧只该出 10 块 ───────────────────────────────
await ok('1 秒 125 帧只发出 10 块（不是 125 块）', () => {
  const chunker = new PcmChunker(RATE, CHUNK_MS);
  let blocks = 0;
  for (let i = 0; i < FRAMES_PER_SEC; i += 1) {
    if (chunker.push(frame128(i), RATE)) blocks += 1;
  }
  assert.equal(blocks, 10, `期望 10 块，实际 ${blocks} 块（每块 ${CHUNK_MS}ms）`);
  // 顺手钉住压下去的量级：125 → 10 就是 12.5 倍
  assert.equal(Math.round(FRAMES_PER_SEC / blocks), 13, '125/10 应约等于 12');
});

// ── 2. 每块正好 100ms 的样本数 ────────────────────────────────────────
await ok('每块样本数 = 1600（100ms @ 16k）', () => {
  const chunker = new PcmChunker(RATE, CHUNK_MS);
  assert.equal(chunker.chunkSamples, (RATE * CHUNK_MS) / 1000);
  assert.equal(chunker.chunkSamples, 1600);
  let first = null;
  for (let i = 0; i < FRAMES_PER_SEC && !first; i += 1) first = chunker.push(frame128(i), RATE);
  assert.ok(first, '攒满一块后必须返回数据');
  assert.equal(first.length, 1600, `块长度应为 1600，实际 ${first?.length}`);
});

// ── 3. 尾巴不会丢：flush 必须吐出没攒满的那部分 ────────────────────────
await ok('flush 吐出尾巴（挂断时最后半句话还在）', () => {
  const chunker = new PcmChunker(RATE, CHUNK_MS);
  // 喂 6 帧 = 768 样本 = 48ms，不够一块
  for (let i = 0; i < 6; i += 1) {
    assert.equal(chunker.push(frame128(i), RATE), null, '没攒满不该发');
  }
  assert.equal(chunker.pending, 6 * Q);
  const tail = chunker.flush();
  assert.ok(tail, 'flush 必须有输出，否则最后半句丢失');
  assert.equal(tail.length, 6 * Q);
  assert.equal(chunker.pending, 0, 'flush 后应清空');
  assert.equal(chunker.flush(), null, '再 flush 一次应返回 null');
});

// ── 4. 超长帧要能拆成多块（不能吞数据）────────────────────────────────
await ok('一帧超过一块时拆成多块，一个样本不丢', () => {
  const chunker = new PcmChunker(RATE, CHUNK_MS);
  // 一帧 4000 样本 = 250ms，应拆成 2 块 + 800 样本的尾巴
  const big = new Float32Array(4000).fill(0.25);
  const out = chunker.push(big, RATE);
  assert.ok(out, '应至少返回一块');
  assert.equal(out.length, 3200, `应拆出 2×1600 样本，实际 ${out?.length}`);
  assert.equal(chunker.pending, 4000 - 3200);
});

// ── 5. 采样率不是 16k 时先重采样再攒块 ────────────────────────────────
await ok('48k 采集：4800 样本帧重采样后按 16k 攒块', () => {
  const chunker = new PcmChunker(RATE, CHUNK_MS);
  // 48kHz 下 100ms = 4800 样本；一次给满应该正好出一块
  const big = new Float32Array(4800).fill(0.1);
  const out = chunker.push(big, 48000);
  assert.ok(out, '4800 个 48k 样本 = 100ms，应正好出一块');
  assert.equal(out.length, 1600);
  assert.equal(chunker.pending, 0);
});

// ── 6. 电平回调限流 ───────────────────────────────────────────────────
await ok('电平回调不超过 20 次/秒', () => {
  // 模拟 125 次回调，时间按 8ms 前进
  let lastAt = 0;
  let emitted = 0;
  for (let i = 0; i < FRAMES_PER_SEC; i += 1) {
    const now = i * 8;
    if (shouldEmitLevel(lastAt, now, LEVEL_INTERVAL_MS)) {
      lastAt = now;
      emitted += 1;
    }
  }
  // 1000ms / 50ms = 20 次，允许 ±1 的边界
  assert.ok(emitted >= 19 && emitted <= 21, `期望约 20 次/秒，实际 ${emitted} 次`);
  assert.ok(emitted < FRAMES_PER_SEC / 4, `必须远小于每帧回调数 ${FRAMES_PER_SEC}，实际 ${emitted}`);
});

await ok('第一次回调一定会发（lastAt=0 不能被当成"刚发过"）', () => {
  assert.equal(shouldEmitLevel(0, 1000, LEVEL_INTERVAL_MS), true);
  assert.equal(shouldEmitLevel(Number.NaN, 1000, LEVEL_INTERVAL_MS), true);
});

await ok('间隔没到就不发', () => {
  assert.equal(shouldEmitLevel(1000, 1020, LEVEL_INTERVAL_MS), false);
  assert.equal(shouldEmitLevel(1000, 1050, LEVEL_INTERVAL_MS), true);
});

// ── 7. 空输入不许崩 ───────────────────────────────────────────────────
await ok('空帧 / 空数组不崩也不产出', () => {
  const chunker = new PcmChunker(RATE, CHUNK_MS);
  assert.equal(chunker.push(new Float32Array(0), RATE), null);
  assert.equal(chunker.push(null, RATE), null);
  assert.equal(chunker.push(undefined, RATE), null);
  assert.equal(chunker.flush(), null);
});

await ok('构造函数对垃圾参数兜底成 16k/100ms', () => {
  const a = new PcmChunker(0, 0);
  assert.equal(a.chunkSamples, 1600, '采样率 0 应回落到 16000');
  const b = new PcmChunker(Number.NaN, Number.NaN);
  assert.equal(b.chunkSamples, 1600, 'NaN 应回落到默认值');
});

// ── 结果 ──────────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log(`✗ ${failures.length} 条失败，${pass} 条通过`);
  for (const item of failures) console.log(`   · ${item.name}: ${item.error?.message ?? item.error}`);
} else {
  console.log(`✓ 全部通过（${pass} 条）`);
}
