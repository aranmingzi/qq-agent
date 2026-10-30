// 裸 PCM ↔ WAV 转换（src/pcm.js）。
//
// ── 这条为什么值得单独测 ───────────────────────────────────────────────
// 这 44 字节的 WAV 头是整条语音链路的第一个环节，而且**失败是静默的**：
// 头写错了，transcribeSpeech 那边只会拿到一个 400，或者更糟 ——
// 识别成功但结果是乱码。用户听到的是"它听不懂我说话"，
// 日志里看不出任何异常。所以这里逐字节钉住。
//
// 三件事：
//   ① 头的每个字段都要对（RIFF/WAVE/fmt /data、byteRate、blockAlign、长度）；
//   ② 奇数字节长度要补 pad，但 data 长度字段必须写真实长度；
//   ③ Float32 ↔ int16 往返不能有精度损失，越界必须削顶而不是溢出。
import assert from 'node:assert/strict';

const {
  wrapWav, parseWavHeader, wavToPcm, float32ToInt16, int16ToFloat32,
  pcmDurationMs, WAV_HEADER_BYTES, DEFAULT_SAMPLE_RATE
} = await import('../src/pcm.js');

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

console.log('[pcm]');

// ── WAV 头逐字段 ────────────────────────────────────────────────────
await ok('WAV 头：RIFF/WAVE 标识与 44 字节固定长度', () => {
  const wav = wrapWav(Buffer.alloc(320, 0));
  assert.equal(wav.length, WAV_HEADER_BYTES + 320);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
});

await ok('WAV 头：fmt 块长度 16、格式 PCM(1)、单声道、16bit', () => {
  const wav = wrapWav(Buffer.alloc(10, 0));
  assert.equal(wav.readUInt32LE(16), 16, 'fmt 块长度');
  assert.equal(wav.readUInt16LE(20), 1, 'audioFormat 必须是 1(PCM)');
  assert.equal(wav.readUInt16LE(22), 1, '声道数');
  assert.equal(wav.readUInt32LE(24), 16000, '采样率');
  assert.equal(wav.readUInt16LE(34), 16, 'bitsPerSample');
});

await ok('WAV 头：byteRate 与 blockAlign 按公式算，不是写死的', () => {
  const mono = wrapWav(Buffer.alloc(10), { sampleRate: 16000, channels: 1 });
  assert.equal(mono.readUInt32LE(28), 16000 * 1 * 2, 'byteRate');
  assert.equal(mono.readUInt16LE(32), 1 * 2, 'blockAlign');

  const stereo48 = wrapWav(Buffer.alloc(10), { sampleRate: 48000, channels: 2 });
  assert.equal(stereo48.readUInt32LE(24), 48000);
  assert.equal(stereo48.readUInt32LE(28), 48000 * 2 * 2);
  assert.equal(stereo48.readUInt16LE(32), 2 * 2);
  assert.equal(stereo48.readUInt16LE(22), 2);
});

await ok('WAV 头：RIFF chunkSize 与 data 长度字段正确（偶数长度）', () => {
  const wav = wrapWav(Buffer.alloc(320, 0));
  assert.equal(wav.readUInt32LE(40), 320, 'data 长度');
  assert.equal(wav.readUInt32LE(4), 36 + 320, 'RIFF chunkSize');
});

await ok('WAV 头：奇数长度要补 pad 字节，但 data 长度字段写真实长度', () => {
  const wav = wrapWav(Buffer.alloc(321, 0));
  assert.equal(wav.length, WAV_HEADER_BYTES + 321 + 1, '实际字节数含 pad');
  assert.equal(wav.readUInt32LE(40), 321, 'data 长度必须是真实长度 321，不含 pad');
  assert.equal(wav.readUInt32LE(4), 36 + 321 + 1, 'RIFF chunkSize 含 pad');
});

await ok('空 PCM 也能包（长度字段全 0，不能崩）', () => {
  const wav = wrapWav(Buffer.alloc(0));
  assert.equal(wav.length, WAV_HEADER_BYTES);
  assert.equal(wav.readUInt32LE(40), 0);
  assert.equal(wav.readUInt32LE(4), 36);
});

await ok('入参给 Uint8Array / 数组也接受（浏览器侧传过来的类型不固定）', () => {
  const fromU8 = wrapWav(new Uint8Array([1, 2, 3, 4]));
  assert.equal(fromU8.readUInt32LE(40), 4);
  const fromArr = wrapWav([1, 2, 3, 4]);
  assert.equal(fromArr.readUInt32LE(40), 4);
  assert.deepEqual(wavToPcm(fromArr), Buffer.from([1, 2, 3, 4]));
});

await ok('入参非法采样率时退回默认 16000，不产生 NaN 头', () => {
  for (const bad of [0, -1, NaN, null, undefined, 'abc']) {
    const wav = wrapWav(Buffer.alloc(4), { sampleRate: bad });
    assert.equal(wav.readUInt32LE(24), DEFAULT_SAMPLE_RATE, `sampleRate=${String(bad)}`);
    assert.equal(wav.readUInt32LE(28), DEFAULT_SAMPLE_RATE * 2);
  }
});

// ── parseWavHeader 自洽 ─────────────────────────────────────────────
await ok('parseWavHeader 与 wrapWav 自洽（默认参数）', () => {
  const pcm = Buffer.alloc(640, 7);
  const info = parseWavHeader(wrapWav(pcm));
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.byteRate, 32000);
  assert.equal(info.blockAlign, 2);
  assert.equal(info.dataOffset, WAV_HEADER_BYTES);
  assert.equal(info.dataLength, 640);
});

await ok('parseWavHeader 与 wrapWav 自洽（立体声 48k）', () => {
  const info = parseWavHeader(wrapWav(Buffer.alloc(400), { sampleRate: 48000, channels: 2 }));
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
  assert.equal(info.byteRate, 192000);
  assert.equal(info.blockAlign, 4);
  assert.equal(info.dataLength, 400);
});

await ok('wavToPcm 取出的字节与原始 PCM 完全一致（含奇数长度）', () => {
  const pcm = Buffer.from([...Array(321).keys()].map((i) => i % 256));
  assert.deepEqual(wavToPcm(wrapWav(pcm)), pcm);
});

await ok('parseWavHeader：非 WAV 数据报出人话，而不是 NaN', () => {
  assert.throws(() => parseWavHeader(Buffer.alloc(0)), /字节数不足 12/);
  assert.throws(() => parseWavHeader(Buffer.from('MP3MP3MP3MP3')), /开头应为 RIFF/);
  const badWave = wrapWav(Buffer.alloc(8));
  badWave.write('AVI ', 8, 'ascii');
  assert.throws(() => parseWavHeader(badWave), /第 9-12 字节应为 WAVE/);
});

await ok('parseWavHeader：data 的 size 写成 0 时按剩余字节算（流式写入的常见写法）', () => {
  const wav = wrapWav(Buffer.alloc(100, 1));
  wav.writeUInt32LE(0, 40);
  const info = parseWavHeader(wav);
  assert.equal(info.dataLength, 100);
  assert.equal(wavToPcm(wav).length, 100);
});

// ── Float32 ↔ int16 ────────────────────────────────────────────────
await ok('float32 → int16：满幅映射到 +32767 / -32768', () => {
  const buf = float32ToInt16(new Float32Array([0, 1, -1, 0.5, -0.5]));
  assert.equal(buf.readInt16LE(0), 0);
  assert.equal(buf.readInt16LE(2), 32767, '+1 → 32767（削回，不溢出）');
  assert.equal(buf.readInt16LE(4), -32768, '-1 → -32768');
  assert.equal(buf.readInt16LE(6), 16384, '0.5 → 16384（精确）');
  assert.equal(buf.readInt16LE(8), -16384, '-0.5 → -16384（精确）');
});

await ok('float32 → int16：越界削顶，绝不溢出成反相噪音', () => {
  const buf = float32ToInt16(new Float32Array([2, -2, 1.5, -1.5]));
  assert.equal(buf.readInt16LE(0), 32767);
  assert.equal(buf.readInt16LE(2), -32768);
  assert.equal(buf.readInt16LE(4), 32767);
  assert.equal(buf.readInt16LE(6), -32768);
});

await ok('float32 → int16：NaN / Infinity / undefined 全部当静音，不当半个满幅', () => {
  // Infinity 削顶到满幅会在听感上变成"啪"的一声爆音；而音频里出现 Infinity
  // 只可能是上游算坏了，当成静音比当成最大音量安全得多。
  const buf = float32ToInt16([NaN, undefined, Infinity, -Infinity]);
  assert.equal(buf.readInt16LE(0), 0, 'NaN → 0');
  assert.equal(buf.readInt16LE(2), 0, 'undefined → 0');
  assert.equal(buf.readInt16LE(4), 0, 'Infinity → 0（不是 32767）');
  assert.equal(buf.readInt16LE(6), 0, '-Infinity → 0（不是 -32768）');
});

await ok('float32 → int16：有限但越界的值仍然削顶（这条不能被上一条掩盖）', () => {
  const buf = float32ToInt16(new Float32Array([1e9, -1e9]));
  assert.equal(buf.readInt16LE(0), 32767);
  assert.equal(buf.readInt16LE(2), -32768);
});

await ok('float32 → int16：空输入返回空 Buffer，不崩', () => {
  assert.equal(float32ToInt16(new Float32Array(0)).length, 0);
  assert.equal(float32ToInt16(null).length, 0);
  assert.equal(float32ToInt16(undefined).length, 0);
});

await ok('int16 → float32：-32768 → -1，32767 → 0.99997', () => {
  const buf = Buffer.alloc(4);
  buf.writeInt16LE(-32768, 0);
  buf.writeInt16LE(32767, 2);
  const f = int16ToFloat32(buf);
  assert.equal(f[0], -1);
  assert.ok(Math.abs(f[1] - 32767 / 32768) < 1e-9);
});

await ok('往返：float32 → int16 → float32 误差不超过半个 LSB', () => {
  const src = new Float32Array([0, 0.25, -0.25, 0.75, -0.75, 0.999, -0.999]);
  const back = int16ToFloat32(float32ToInt16(src));
  for (let i = 0; i < src.length; i += 1) {
    // 半个 LSB = 1/65536。缩放用 32768 就是为了让这条成立；
    // 用 32767 会系统性偏小 1/32768 左右，累积到 VAD 能量上会失准。
    assert.ok(Math.abs(back[i] - src[i]) <= 1 / 65536, `样本 ${i}: ${back[i]} vs ${src[i]}`);
  }
});

await ok('往返：0.5 / 0.25 这类整齐值是精确的（不是"差不多"）', () => {
  const back = int16ToFloat32(float32ToInt16(new Float32Array([0.5, -0.5, 0.25, -0.25])));
  assert.equal(back[0], 0.5);
  assert.equal(back[1], -0.5);
  assert.equal(back[2], 0.25);
  assert.equal(back[3], -0.25);
});

await ok('int16 → float32：奇数长度（末尾半个样本）忽略残余字节', () => {
  const buf = Buffer.alloc(5);
  buf.writeInt16LE(1000, 0);
  buf.writeInt16LE(2000, 2);
  buf.writeUInt8(0xff, 4);
  const f = int16ToFloat32(buf);
  assert.equal(f.length, 2);
});

await ok('端到端：Float32 麦克风数据 → WAV，头里的长度与实际音频长度一致', () => {
  const samples = new Float32Array(1600); // 16000Hz 下 100ms
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 10) * 0.5;
  const wav = wrapWav(float32ToInt16(samples));
  const info = parseWavHeader(wav);
  assert.equal(info.dataLength, 3200);
  assert.equal(pcmDurationMs(info.dataLength, info.sampleRate), 100);
});

// ── 时长 ────────────────────────────────────────────────────────────
await ok('pcmDurationMs：16000Hz 单声道下 32000 字节 = 1000ms', () => {
  assert.equal(pcmDurationMs(32000), 1000);
  assert.equal(pcmDurationMs(1600), 50);
  assert.equal(pcmDurationMs(0), 0);
  assert.equal(pcmDurationMs(-5), 0);
  assert.equal(pcmDurationMs(NaN), 0);
});

await ok('pcmDurationMs：立体声/别的采样率按实际算', () => {
  assert.equal(pcmDurationMs(32000, 16000, 2), 500);
  assert.equal(pcmDurationMs(32000, 8000), 2000);
  // 采样率非法时退回默认 16000：1000 字节 / (16000*1*2) = 31.25ms → 四舍五入 31
  assert.equal(pcmDurationMs(1000, 0), 31);
  assert.equal(pcmDurationMs(1000, NaN), 31);
});

console.log(`\n[pcm] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
