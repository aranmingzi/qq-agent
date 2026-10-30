// GIF 拆帧自测。
//
// 重点不是「能不能拆」，而是四条纪律：
//   ① 结构解析必须自己算准帧数/透明 —— 帧数错了就会挑到不存在的帧，结果模型只收到 1 张；
//   ② 挑帧要**避开首尾**（动图首帧常是空白底、尾帧常是循环过渡帧）；
//   ③ 拆不出来必须返回空数组（调用方退回原图），**绝不许抛** —— 否则一条动图能把整条消息搞挂；
//   ④ 拆帧关闭（maxFrames=0）要真的不干活，别偷偷起 ffmpeg。
//
// 这里全部用**现场拼出来的 GIF 字节**，不依赖 data/sticker-files 里的生产素材
//（测试跑在生产目录上时不许读写真实表情包）。
import assert from 'node:assert';
import { isGifBuffer, gifInfo, pickFrameIndexes, splitGifFrames } from '../src/gif-frames.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }
async function okAsync(name, fn) { await fn(); pass += 1; console.log('  ✓', name); }

/**
 * 拼一个合法的 GIF89a：N 帧、1x1、可选透明标记。
 * 每帧 = 图形控制扩展(GCE) + 图像描述符 + LZW 数据子块，直接照着规范手写。
 */
function buildGif({ frames = 1, transparent = false } = {}) {
  const header = Buffer.from('GIF89a', 'ascii');
  // 逻辑屏幕描述符：宽高各 1（小端），packed=0x80 表示有全局调色板（2 项），背景色 0，像素比 0
  const lsd = Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
  const gct = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
  // 图形控制扩展：0x21 0xF9 块长(4) packed 延迟(2) 透明色索引 结束符
  const gce = Buffer.from([0x21, 0xf9, 0x04, transparent ? 0x01 : 0x00, 0x00, 0x00, 0x00, 0x00]);
  // 图像描述符：0x2C + left/top/w/h 各 2 字节 + packed(无局部调色板)
  // 之后是 LZW 最小码长 0x02，数据子块 [长度 0x02, 0x44 0x01]，结束符 0x00
  const image = Buffer.from([
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
  ]);
  const body = [];
  for (let i = 0; i < frames; i += 1) body.push(gce, image);
  return Buffer.concat([header, lsd, gct, ...body, Buffer.from([0x3b])]);
}

console.log('[gif-frames]');

ok('① 认 GIF 只看 magic（扩展名/Content-Type 都不可信）', () => {
  assert.strictEqual(isGifBuffer(buildGif()), true);
  assert.strictEqual(isGifBuffer(Buffer.from('GIF87a' + 'x'.repeat(20), 'ascii')), true);
  assert.strictEqual(isGifBuffer(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), false);
  assert.strictEqual(isGifBuffer(Buffer.from('这不是图片，只是一段中文')), false);
  assert.strictEqual(isGifBuffer(null), false);
});

ok('① 帧数 / 透明 / 尺寸都从块结构里读出来', () => {
  const one = gifInfo(buildGif({ frames: 1, transparent: true }));
  assert.deepStrictEqual(one, { frames: 1, width: 1, height: 1, transparent: true });
  const seven = gifInfo(buildGif({ frames: 7, transparent: false }));
  assert.strictEqual(seven.frames, 7);
  assert.strictEqual(seven.transparent, false);
});

ok('① 结构损坏返回 null（不是抛，也不是硬编成 1 帧）', () => {
  const full = buildGif({ frames: 3 });
  assert.strictEqual(gifInfo(full.slice(0, 12)), null);      // 截断在描述符中间
  assert.strictEqual(gifInfo(Buffer.concat([full.slice(0, 13), Buffer.from([0x99, 0x99])])), null);
  assert.strictEqual(gifInfo(Buffer.from('not a gif at all')), null);
});

ok('② 挑帧避开首尾两帧（动图首帧常是空白、尾帧常是循环过渡）', () => {
  assert.deepStrictEqual(pickFrameIndexes(7, 3), [1, 3, 5]);
  assert.deepStrictEqual(pickFrameIndexes(60, 3), [1, 30, 58]);
  assert.deepStrictEqual(pickFrameIndexes(33, 3), [1, 16, 31]);
  for (const idx of pickFrameIndexes(60, 3)) {
    assert.ok(idx > 0 && idx < 59, `第 ${idx} 帧落在首尾，应避开`);
  }
});

ok('② 帧不够时退化：全给 / 取正中 / 允许带首帧，且不许重复', () => {
  assert.deepStrictEqual(pickFrameIndexes(3, 3), [0, 1, 2]);   // 帧数刚好 → 全给
  assert.deepStrictEqual(pickFrameIndexes(2, 3), [0, 1]);      // 帧数不足 → 全给
  assert.deepStrictEqual(pickFrameIndexes(1, 3), [0]);
  assert.deepStrictEqual(pickFrameIndexes(9, 1), [4]);         // 只要 1 帧 → 取正中
  assert.deepStrictEqual(pickFrameIndexes(4, 3), [0, 2, 3]);   // 帧太少铺不开，允许带首帧
  const picks = pickFrameIndexes(5, 4);
  assert.strictEqual(new Set(picks).size, picks.length, `picks 有重复：${picks}`);
});

ok('② 脏输入不许产出 NaN / 负数索引', () => {
  for (const [t, c] of [[0, 3], [-5, 3], [NaN, 3], [7, 0], [7, -1], [undefined, undefined]]) {
    const picks = pickFrameIndexes(t, c);
    assert.ok(picks.length >= 1, `total=${t} count=${c} 返回空`);
    assert.ok(picks.every((i) => Number.isInteger(i) && i >= 0), `total=${t} count=${c} → ${picks}`);
  }
});

await okAsync('③ 非 GIF / 关闭拆帧 → 返回空数组且不报错', async () => {
  const notGif = await splitGifFrames(Buffer.from('hello world, definitely not a gif'));
  assert.deepStrictEqual(notGif.frames, []);
  const off = await splitGifFrames(buildGif({ frames: 7 }), { maxFrames: 0 });
  assert.deepStrictEqual(off.frames, [], 'maxFrames=0 时不该拆');
  const empty = await splitGifFrames(Buffer.alloc(0));
  assert.deepStrictEqual(empty.frames, []);
});

const { resolveFfmpeg } = await import('../src/media-tools.js');
if (!resolveFfmpeg()) {
  console.log('  … 本机没有 ffmpeg，跳过真解码用例（解析与挑帧已覆盖）');
} else {
  await okAsync('③ 7 帧动图 → 3 张真 jpeg（不是原样透传 gif）', async () => {
    const { frames, total, picked } = await splitGifFrames(buildGif({ frames: 7 }));
    assert.strictEqual(total, 7);
    assert.strictEqual(frames.length, 3, `应拆出 3 帧，实得 ${frames.length}`);
    assert.deepStrictEqual(picked, [1, 3, 5]);
    for (const f of frames) {
      assert.strictEqual(f[0], 0xff, 'jpeg SOI 首字节');
      assert.strictEqual(f[1], 0xd8, 'jpeg SOI 次字节');
      assert.ok(f.length > 200, `帧太小（${f.length} 字节），可能是空图`);
    }
  });

  await okAsync('③ 单帧 GIF 也要转（模型同样读不了 image/gif）', async () => {
    const { frames, total } = await splitGifFrames(buildGif({ frames: 1 }));
    assert.strictEqual(total, 1);
    assert.strictEqual(frames.length, 1);
  });

  await okAsync('③ 带透明的动图能过（垫白底那条滤镜链不炸）', async () => {
    const { frames } = await splitGifFrames(buildGif({ frames: 5, transparent: true }));
    assert.strictEqual(frames.length, 3);
  });
}

console.log(`\n[gif-frames] ${pass} 项全过`);
