// 图片尺寸解析（纯 JS，不依赖 sharp/ffmpeg）。
//
// 为什么需要它：识图质量的天花板不在提示词，而在**送进去之前图被缩了多少**。
// 实测（2026-10-26）：1094×2214 的长图整张喂 Qwen-VL，in=2503 token，
// 上半部分内容直接丢失（三段图只认出后两段）；纵向切三段分别识别，in=939×3，
// 三段全部读准 —— 成本几乎不变，耗时靠并行也不变（见 tools.js 的 describeImage）。
// 于是「要不要切」必须先知道宽高，而 DataURL 里没有宽高，只能解二进制头。
//
// 顺带记一条无效参数：`vl_high_resolution_images` / `max_pixels` 在 DashScope
// 兼容模式下对这版 qwen3-vl-plus **完全无效**（2188×1000 的图，四种传法 prompt_tokens
// 都是 2127，一模一样）。别再指望调参提分辨率，只能切图。

function pngSize(buf) {
  // 89 50 4E 47 0D 0A 1A 0A，紧跟 IHDR 长度+类型，宽高在 offset 16/20（大端）
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    // 填充字节
    if (marker === 0xff) { i += 1; continue; }
    // 无 length 字段的标记
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: 'jpeg' };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  if (kind === 'VP8L') {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      format: 'webp'
    };
  }
  if (kind === 'VP8X') {
    return {
      width: 1 + buf.readUIntLE(24, 3),
      height: 1 + buf.readUIntLE(27, 3),
      format: 'webp'
    };
  }
  return null;
}

/** @returns {{width:number,height:number,format:string}|null} */
export function imageSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return null;
  return pngSize(buf) || jpegSize(buf) || gifSize(buf) || webpSize(buf);
}

/** 从 dataURL 里取出 mime 与 base64。 */
export function parseDataUrl(url) {
  const m = String(url || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  return { mime: m[1] || 'image/jpeg', base64: m[3] || '', isBase64: !!m[2] };
}
