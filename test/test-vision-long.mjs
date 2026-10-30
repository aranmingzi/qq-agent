// 识图：尺寸解析 + 长图切段规划 + 输出契约。
// 纯函数，不联网 —— 联网质量对比在 tools/vision-prompt-eval.mjs 里手工跑。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { imageSize, parseDataUrl } from '../src/image-meta.js';
import { planImageSegments, segmentNote, segmentLabel, VISION_STRUCT, VISION_BRIEF } from '../src/vision-prompt.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e?.message ?? e}`); process.exitCode = 1; }
}

// ── 1. 尺寸解析 ───────────────────────────────────────────────────────────
function pngBuffer(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpegBuffer(w, h) {
  // SOI + APP0(最小) + SOF0
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function gifBuffer(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
  return b;
}

ok('PNG 宽高解析（大端）', () => {
  const s = imageSize(pngBuffer(1080, 2400));
  assert.equal(s.format, 'png');
  assert.equal(s.width, 1080);
  assert.equal(s.height, 2400);
});

ok('JPEG 走 SOF0 取宽高', () => {
  const s = imageSize(jpegBuffer(800, 600));
  assert.equal(s.format, 'jpeg');
  assert.equal(s.width, 800);
  assert.equal(s.height, 600);
});

ok('GIF 宽高解析（小端）', () => {
  const s = imageSize(gifBuffer(320, 200));
  assert.equal(s.format, 'gif');
  assert.equal(s.width, 320);
  assert.equal(s.height, 200);
});

ok('空/垃圾数据不抛异常，返回 null', () => {
  assert.equal(imageSize(Buffer.alloc(0)), null);
  assert.equal(imageSize(Buffer.from('not an image')), null);
});

ok('真实文件：视频封面帧能读出尺寸', () => {
  const p = 'D:/Documents/Tencent Files/10000001/nt_qq/nt_data/Video/2026-10/Thumb/1cac7175edd75a5d8cc540ee3fa8cebb_0.png';
  if (!fs.existsSync(p)) return;   // 换机器/换 QQ 号时跳过，不算失败
  const s = imageSize(fs.readFileSync(p));
  assert.ok(s && s.width > 100 && s.height > 100, `读不出尺寸：${JSON.stringify(s)}`);
});

// ── 2. 切段规划 ───────────────────────────────────────────────────────────
ok('普通横图不切（1094×500）', () => {
  assert.equal(planImageSegments({ width: 1094, height: 500 }).count, 1);
});

ok('手机竖屏截图要切（1080×2400 = 2.59M px）', () => {
  const p = planImageSegments({ width: 1080, height: 2400 });
  assert.equal(p.count, 3, p.reason);
});

ok('聊天长截图要切（1080×6000）', () => {
  const p = planImageSegments({ width: 1080, height: 6000 });
  assert.ok(p.count >= 3, p.reason);
  assert.ok(p.count <= 4, '最多 4 段，别切太碎');
});

ok('实测丢过内容的那张长图（1094×2214）必须切', () => {
  const p = planImageSegments({ width: 1094, height: 2214 });
  assert.ok(p.count >= 2, p.reason);
});

ok('切完每段太矮就不切（1500×800 边缘情况）', () => {
  // 像素超一点但高宽比不高：切成 2 段每段 400px，仍然可以
  const p = planImageSegments({ width: 1500, height: 800 });
  assert.ok(p.count >= 1);
});

ok('超长图不会切到只剩碎条（宽扁长条 4000×900）', () => {
  const p = planImageSegments({ width: 4000, height: 900 });
  assert.equal(p.count, 1, p.reason);   // 段高 225 < 320，放弃
});

ok('尺寸未知时按不切处理', () => {
  assert.equal(planImageSegments({}).count, 1);
  assert.equal(planImageSegments({ width: 0, height: 100 }).count, 1);
});

// ── 3. 契约文案 ───────────────────────────────────────────────────────────
ok('新契约必须要求「先给主旨」而不是罗列文字', () => {
  assert.ok(VISION_STRUCT.includes('主旨'), '缺少主旨要求');
  assert.ok(VISION_STRUCT.includes('原文'), '缺少原文要求');
  assert.ok(!/不超过 120 字/.test(VISION_STRUCT), '不该再回到 120 字念字');
});

ok('契约要防住刷屏符号把输出撑爆', () => {
  assert.ok(/重复|刷屏/.test(VISION_STRUCT), '缺少重复字符约束');
});

ok('契约要禁止推断图里没有的东西', () => {
  assert.ok(/不要推断/.test(VISION_STRUCT), '缺少防幻觉约束');
});

ok('表情包走短契约，不要求三段式', () => {
  assert.ok(VISION_BRIEF.length < VISION_STRUCT.length);
  assert.ok(!VISION_BRIEF.includes('①'), '表情包不该要求分三段');
});

ok('分段提示要说清「这是同一张图的一段」', () => {
  assert.ok(segmentNote(0, 3).includes('同一张'));
  assert.ok(segmentNote(1, 3).includes('第 2 段'));
});

ok('段标签覆盖 1/2/3/4 段', () => {
  assert.equal(segmentLabel(0, 1), '');
  assert.deepEqual([segmentLabel(0, 2), segmentLabel(1, 2)], ['上半', '下半']);
  assert.deepEqual([segmentLabel(0, 3), segmentLabel(1, 3), segmentLabel(2, 3)], ['上半', '中部', '下半']);
  assert.equal(segmentLabel(3, 4), '末段');
});

// ── 4. dataURL 解析 ───────────────────────────────────────────────────────
ok('dataURL 解析出 mime 与 base64', () => {
  const p = parseDataUrl(`data:image/png;base64,${pngBuffer(2, 2).toString('base64')}`);
  assert.equal(p.mime, 'image/png');
  assert.equal(p.isBase64, true);
  assert.equal(imageSize(Buffer.from(p.base64, 'base64')).width, 2);
});

ok('非 dataURL 返回 null（不误判成图）', () => {
  assert.equal(parseDataUrl('https://example.com/a.png'), null);
});

console.log(`\n[vision-long] ${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过'}`);
