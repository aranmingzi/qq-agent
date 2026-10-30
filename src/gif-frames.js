// GIF 动图 → 若干张 JPEG 静帧。
//
// 为什么要这一层
// --------------
// 视觉模型只吃 jpeg / png / webp。QQ 里的动图表情、转发的搞笑动图几乎全是 GIF，
// 原样 `data:image/gif;base64,...` 塞过去，模型要么直接 400，要么「看到」一片空白
// 或只有第一帧 —— 而 GIF 的第一帧在动图里常常是最没信息的那一帧（纯色/过渡帧）。
// 所以这里做两件事：**挑帧**（不是取第一帧）和**转码**（rgba → 垫白底 → jpeg）。
//
// 为什么帧数要小
// --------------
// 每多一帧就是多一份视觉 token，且模型会把「同一张动图的三帧」误当成三张不同的图。
// 默认 3 帧：足够表现「动作前 / 中 / 后」，又不至于让识图变慢（识图慢的主因是输出
// 长度，但输入图数直接乘算 token）。帧数走 `vision.gifFrames`，设 0 = 关闭拆帧。
//
// 为什么用纯 JS 读结构、只用 ffmpeg 解码
// --------------------------------------
// 帧数和「有没有透明通道」这两件事，靠解析 GIF 的块结构就能拿到（几十行，无子进程）；
// 拿到它们才能：① 均匀挑帧而不是瞎猜；② 只在真的有透明时才多走一遍垫白滤镜
// （多一遍滤镜 = 多一次 rgba→yuv 转换，白底会更干净但没必要给不透明的图付这个钱）。
// 真正的 LZW 解码交给 ffmpeg —— 那是它擅长的事，我们只让它解出挑中的那几帧。
//
// 失败策略：**永不抛**。拿不到静帧就返回空数组，调用方退回原图（宁可给一张读不出来的
// 图，也不能因为拆帧失败把整条消息吞掉）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { resolveFfmpeg, runProc } from './media-tools.js';

/** 最长边上限：视觉模型会自己缩图，超过这个尺寸只是白烧上传体积。 */
const MAX_DIM = 1600;
/** mjpeg 的 qscale（2 最好 / 31 最差），4 约等于 JPEG q≈85。 */
const QSCALE = 4;
/** 单帧小于这个字节数就认为没解出来（1x1 的合法 jpeg 也才 300 字节左右，用 200 兜底）。 */
const MIN_FRAME_BYTES = 200;
/** 解析时的帧数上限：防止损坏文件把 0x2C 当成无限循环。 */
const PARSE_FRAME_CAP = 5000;

/** 是否 GIF（按 magic，不看扩展名/Content-Type —— QQ 的 CDN 经常给错）。 */
export function isGifBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) return false;
  const sig = buffer.toString('ascii', 0, 6);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

/**
 * 纯 JS 读 GIF 块结构：帧数 + 是否有透明通道 + 画布尺寸。
 * 不是 GIF 或结构损坏时返回 null（调用方按「不能拆」处理）。
 *
 * 块结构（GIF89a 规范）：
 *   头 6 字节 → 逻辑屏幕描述符 7 字节 → [全局调色板] →
 *   循环：0x21 扩展（含 0xF9 图形控制扩展，其 packed 字节 bit0 = 透明标记）
 *         0x2C 图像描述符（9 字节 → [局部调色板] → LZW 最小码长 1 字节 → 数据子块）
 *         0x3B 结束
 */
export function gifInfo(buffer) {
  if (!isGifBuffer(buffer)) return null;
  let p = 6;
  if (buffer.length < p + 7) return null;
  const width = buffer.readUInt16LE(p);
  const height = buffer.readUInt16LE(p + 2);
  const packed = buffer[p + 4];
  p += 7;
  // 全局调色板：bit7 为标志位，低 3 位给出 2^(n+1) 个表项，每项 3 字节
  if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));

  let frames = 0;
  let transparent = false;

  // 跳过一串数据子块（每块 1 字节长度 + 内容，遇到 0 结束）
  const skipSubBlocks = () => {
    while (p < buffer.length) {
      const size = buffer[p];
      p += 1 + size;
      if (size === 0) return true;
    }
    return false;
  };

  while (p < buffer.length) {
    const marker = buffer[p];
    if (marker === 0x3b) break;                       // 结束符
    if (marker === 0x21) {                            // 扩展块
      const label = buffer[p + 1];
      p += 2;
      if (label === 0xf9 && p + 1 < buffer.length) {
        // 图形控制扩展：块长(通常 4) + packed + 延迟(2) + 透明色索引 + 结束符
        const blockSize = buffer[p];
        const flags = buffer[p + 1];
        if (blockSize >= 4 && (flags & 0x01)) transparent = true;
      }
      if (!skipSubBlocks()) return null;
      continue;
    }
    if (marker === 0x2c) {                            // 图像描述符
      if (p + 10 > buffer.length) return null;
      const local = buffer[p + 9];
      p += 10;
      if (local & 0x80) p += 3 * (1 << ((local & 0x07) + 1));
      p += 1;                                         // LZW 最小码长
      if (!skipSubBlocks()) return null;
      frames += 1;
      if (frames > PARSE_FRAME_CAP) break;
      continue;
    }
    return null;                                      // 认不出来的块：当作损坏
  }
  if (!frames) return null;
  return { frames, width, height, transparent };
}

/**
 * 从 total 帧里均匀挑 count 帧。
 *
 * 为什么不取第 0 帧：动图的第一帧常常是「空白底/淡入起点」，第 0 帧和第 total-1 帧
 * 还经常是循环用的过渡帧。所以尽量在 [1, total-2] 这个开区间里均匀取；
 * 帧数不够时（total <= count）就全给，反正也没得挑。
 */
export function pickFrameIndexes(total, count) {
  const n = Math.max(1, Math.floor(Number(total) || 0));
  const want = Math.max(1, Math.floor(Number(count) || 1));
  if (n <= want) return Array.from({ length: n }, (_, i) => i);
  if (want === 1) return [Math.floor(n / 2)];        // 单帧就取正中，别取首帧
  // 帧够多（n >= want+2）才有余量避开首尾两帧，否则只能从 0 铺到 n-1
  const spare = n >= want + 2;
  const lo = spare ? 1 : 0;
  const hi = spare ? n - 2 : n - 1;
  const out = [];
  for (let i = 0; i < want; i += 1) {
    const idx = lo + Math.round((i * (hi - lo)) / (want - 1));
    if (!out.includes(idx)) out.push(idx);
  }
  return out;
}

function frameLimit() {
  try {
    const raw = Number(getConfig().vision?.gifFrames);
    if (!Number.isFinite(raw)) return 3;
    return Math.max(0, Math.min(8, Math.floor(raw)));
  } catch {
    return 3;
  }
}

/**
 * 把 GIF 拆成最多 N 张 JPEG 静帧。
 * @param {Buffer} buffer GIF 原始字节
 * @param {{ maxFrames?: number, maxDim?: number }} [opts]
 * @returns {Promise<{ frames: Buffer[], total: number, picked: number[] }>}
 *   失败时 `frames` 为空数组（调用方退回原图），永不抛。
 */
export async function splitGifFrames(buffer, opts = {}) {
  const empty = { frames: [], total: 0, picked: [] };
  const info = gifInfo(buffer);
  if (!info) return empty;
  const maxFrames = Math.max(0, Math.floor(Number(opts.maxFrames ?? frameLimit()) || 0));
  // 0 = 关闭拆帧。这个判断必须在"单帧也转"之前 ——
  // 否则关了开关，单帧 GIF 照样会起一次 ffmpeg（2026-10-26 修）。
  if (maxFrames <= 0) return empty;
  // 单帧 GIF（伪装成 .gif 的静图）也值得转一次：模型同样读不了 image/gif。
  const want = info.frames <= 1 ? 1 : maxFrames;
  if (want <= 0) return empty;

  const ff = resolveFfmpeg();
  if (!ff) return empty;

  const picked = pickFrameIndexes(info.frames, want);
  const dir = path.join(DATA_DIR, 'tmp', `gifframes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'in.gif');
    fs.writeFileSync(src, buffer);

    // select 里每个 eq(n\,i) 的逗号必须转义，否则会被当成滤镜分隔符
    const expr = picked.map((i) => `eq(n\\,${i})`).join('+');
    const scale = `scale=w='min(${MAX_DIM}\\,iw)':h=-2:flags=lanczos`;
    // 只有真的带透明通道时才垫白：GIF 透明度直接转 yuv 会变黑底
    const chain = info.transparent
      ? `${scale},format=rgba,split[f][b];[b]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill[bg];[bg][f]overlay=format=auto,format=yuv420p`
      : `${scale},format=yuv420p`;
    const vf = `select='${expr}',${chain}`;
    const outPattern = path.join(dir, 'f%1d.jpg');

    // -vsync 0 = 只要选中的帧，不补帧不重复。ffmpeg 5.1+ 已弃用它（改叫 -fps_mode），
    // 所以第一次失败时去掉该参数再试一次 —— 两个版本就都能跑。
    let r = await runProc(ff, ['-y', '-v', 'error', '-i', src, '-vf', vf, '-vsync', '0', '-q:v', String(QSCALE), outPattern], { timeoutMs: 60000 });
    if (r.code !== 0) {
      r = await runProc(ff, ['-y', '-v', 'error', '-i', src, '-vf', vf, '-q:v', String(QSCALE), outPattern], { timeoutMs: 60000 });
    }
    if (r.code !== 0) return empty;

    const frames = [];
    for (let i = 1; i <= picked.length; i += 1) {
      const file = path.join(dir, `f${i}.jpg`);
      let buf = null;
      try { buf = fs.readFileSync(file); } catch { continue; }
      if (buf.length > MIN_FRAME_BYTES && buf[0] === 0xff && buf[1] === 0xd8) frames.push(buf);
    }
    return { frames, total: info.frames, picked };
  } catch {
    return empty;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉无所谓 */ }
  }
}
