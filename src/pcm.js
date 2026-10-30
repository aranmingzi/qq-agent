// 裸 PCM ↔ WAV ↔ Float32 的转换。
//
// ── 为什么要有这个文件 ─────────────────────────────────────────────────
// 语音通话的链路是：浏览器麦克风 → 裸 PCM（16kHz / 16bit / 单声道）
//                  → 包一层 WAV 头 → 现有 transcribeSpeech() 识别。
//
// 现成的 `transcribeSpeech`（src/qwen-audio.js:238）收的是「文件字节 + 格式」，
// 而 `FORMAT_MIME` 里已经有 `wav`（src/qwen-audio.js:71）。也就是说：
// **只要我们自己补上那 44 字节的 WAV 头，就不需要 ffmpeg、不需要新供应商、
// 不需要新的识别协议。** 这就是本文件存在的全部理由。
//
// 反面做法（考虑过、否掉了）：为了包个 WAV 头去调 ffmpeg。项目里虽然能翻到
// ffmpeg.exe（src/media-tools.js:27-45），但那是「碰运气能找到」的路径，
// 找不到就静默降级；而写一个 44 字节的头是纯算术，永远不会失败。
//
// ── 纪律 ──────────────────────────────────────────────────────────────
// 这个文件必须是**纯函数、零 IO、零依赖**。它跑在每一次通话的关键路径上，
// 出错的后果是「识别出乱码」或者「识别不出东西」，两种都很难从日志看出来。
// 所以：不读配置、不写日志、不 await、不碰网络。所有边界都在 test/test-pcm.mjs 里钉住。

/** WAV 头固定 44 字节：RIFF(12) + fmt (24) + data(8)。 */
export const WAV_HEADER_BYTES = 44;

/** 语音通话统一用这个采样率：DashScope 识别与浏览器采集都按它对齐。 */
export const DEFAULT_SAMPLE_RATE = 16000;

/** 16bit = 2 字节/样本。 */
export const BYTES_PER_SAMPLE = 2;

/**
 * Float32（-1..1）转 int16 小端 Buffer。
 *
 * 越界必须削顶而不是取模：浏览器给的 Float32 偶尔会因为增益处理略超 ±1，
 * 直接 `| 0` 或取模会把它翻成反相的大噪音（听起来像爆音）。
 * 这里 -1 → -32768、+1 → 32767，是音频领域的惯例映射。
 *
 * 缩放用 **32768** 而不是 32767：这样 0.5 → 16384、0.25 → 8192 都是精确值，
 * 和 int16ToFloat32 的 `/32768` 严格互逆（误差不超过半个 LSB）。
 * 用 32767 的话往返会系统性偏小一点点 —— 单个样本听不出来，但 VAD 的
 * 能量阈值是靠累积比较的，系统性偏差会让阈值在长通话里慢慢失准。
 */
export function float32ToInt16(input) {
  const samples = input ?? [];
  const n = samples.length ?? 0;
  const out = Buffer.alloc(n * BYTES_PER_SAMPLE);
  for (let i = 0; i < n; i += 1) {
    let v = Number(samples[i]);
    if (!Number.isFinite(v)) v = 0;            // NaN / ±Infinity / undefined 都当静音
    let s = Math.round(v * 32768);
    if (s > 32767) s = 32767;                  // +1 会算出 32768，必须削回来
    else if (s < -32768) s = -32768;
    out.writeInt16LE(s, i * BYTES_PER_SAMPLE);
  }
  return out;
}

/**
 * int16 小端 Buffer 转 Float32（-1..1）。
 * 除数是 32768 而不是 32767：与 float32ToInt16 的乘法不对称，
 * 但这样 `int16ToFloat32(float32ToInt16(x))` 对 |x| < 1 的结果严格相等。
 */
export function int16ToFloat32(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const n = Math.floor(buf.length / BYTES_PER_SAMPLE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = buf.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
  }
  return out;
}

/**
 * 给裸 PCM 套上 WAV 头。
 *
 * @param {Buffer|Uint8Array} pcm   裸 PCM 字节（小端 16bit）
 * @param {{sampleRate?:number, channels?:number}} [options]
 * @returns {Buffer} 完整 WAV 文件字节
 *
 * 奇数长度：RIFF 规定每个 chunk 必须偶数字节对齐，所以要补一个 pad 字节，
 * 但 `data` 块的长度字段写**真实**长度（不含 pad）。长度字段写错的表现是
 * 播放器/识别接口截掉最后一个样本，或者直接拒收。
 */
export function wrapWav(pcm, options = {}) {
  const sampleRate = Number(options.sampleRate) > 0 ? Math.floor(Number(options.sampleRate)) : DEFAULT_SAMPLE_RATE;
  const channels = Number(options.channels) > 0 ? Math.floor(Number(options.channels)) : 1;
  const body = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);

  const dataLength = body.length;
  const pad = dataLength % 2;                 // 0 或 1
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  const blockAlign = channels * BYTES_PER_SAMPLE;

  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  // RIFF chunkSize = 4('WAVE') + (8+16)('fmt ') + (8 + dataLength + pad)
  header.writeUInt32LE(36 + dataLength + pad, 4);
  header.write('WAVE', 8, 'ascii');

  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);               // fmt 块长度，PCM 固定 16
  header.writeUInt16LE(1, 20);                // audioFormat = 1 (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34); // bitsPerSample = 16

  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);

  if (!pad) return Buffer.concat([header, body]);
  return Buffer.concat([header, body, Buffer.alloc(1)]);
}

/**
 * 读 WAV 头。
 *
 * 用来做两件事：① 自检（`parseWavHeader(wrapWav(x))` 必须和入参一致）；
 * ② 出错时给人话 —— 识别接口拒收时，能说出「这其实不是 WAV」比
 *    「语音识别失败：400」有用得多。
 *
 * 不认识的块会被跳过（WAV 允许 fmt 之前有 LIST/INFO 之类），
 * 遇到 `data` 就停。
 *
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, dataOffset:number, dataLength:number, byteRate:number, blockAlign:number}}
 */
export function parseWavHeader(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (buf.length < 12) throw new Error('不是 WAV：字节数不足 12，连 RIFF 头都不完整');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`不是 WAV：开头应为 RIFF，实际是「${buf.toString('ascii', 0, 4)}」`);
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`不是 WAV：第 9-12 字节应为 WAVE，实际是「${buf.toString('ascii', 8, 12)}」`);

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let blockAlign = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (body + 16 > buf.length) throw new Error('WAV 头损坏：fmt 块长度不够 16 字节');
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      blockAlign = buf.readUInt16LE(body + 12);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (!sampleRate) throw new Error('WAV 头损坏：data 块出现在 fmt 块之前');
      // data 的 size 字段可能是 0（流式写入的常见写法），那就按剩余字节算。
      const available = buf.length - body;
      const dataLength = size === 0 || size > available ? available : size;
      return { sampleRate, channels, bitsPerSample, dataOffset: body, dataLength, byteRate, blockAlign };
    }

    // 块长度按偶数字节对齐
    offset = body + size + (size % 2);
  }

  throw new Error('WAV 头里没有 data 块');
}

/**
 * 从 WAV 里取出裸 PCM（去掉头）。
 * 给自检和「客户端误传整段 WAV」这种容错场景用。
 */
export function wavToPcm(buffer) {
  const info = parseWavHeader(buffer);
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
}

/**
 * 这段 PCM 有多长（毫秒）。
 * 通话页要显示计时，服务端也要靠它判断「这段音频短得可疑，可能只是杂音」。
 */
export function pcmDurationMs(byteLength, sampleRate = DEFAULT_SAMPLE_RATE, channels = 1) {
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : DEFAULT_SAMPLE_RATE;
  const ch = Number(channels) > 0 ? Number(channels) : 1;
  const bytes = Number(byteLength);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / (rate * ch * BYTES_PER_SAMPLE)) * 1000);
}
