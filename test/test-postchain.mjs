// voice-postchain 自测：参数拼装（纯函数部分）+ 真实 ffmpeg 端到端。
//
// 学自 test-gsv-query.mjs 的写法：参数拼装是唯一真相源，先断言纯函数；
// 端到端那条需要 ffmpeg，机器上有就走一遍，没有就跳过（后处理是增益项，不是必要项）。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { buildPostChainArgs, postChainEnabled, DEFAULT_POST_CHAIN, applyPostChain } from '../src/voice-postchain.js';

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name);
    throw e;
  }
}

console.log('[postchain]');

ok('① 默认链拼装：5 段滤镜 + 16k/单声道/s16 输出', () => {
  const r = buildPostChainArgs({});
  assert.strictEqual(r.chain, DEFAULT_POST_CHAIN);
  assert.ok(r.args.includes(DEFAULT_POST_CHAIN));
  assert.strictEqual(r.args[r.args.length - 6], '16000');
  assert.strictEqual(r.args[r.args.length - 4], '1');
  assert.strictEqual(r.args[r.args.length - 2], 's16');
  assert.strictEqual(r.args[r.args.length - 1], '{OUT}');
});

ok('② 空链 = null（调用方按"没有后处理"处理）', () => {
  assert.strictEqual(buildPostChainArgs({ chain: '' }), null);
  assert.strictEqual(buildPostChainArgs({ chain: '   ' }), null);
});

ok('③ postChainEnabled：false/off/0 关，其余（含没配）开', () => {
  for (const v of [false, 'off', 'OFF', 'false', '0', ' 0 ']) assert.strictEqual(postChainEnabled(v), false, String(v));
  for (const v of [true, undefined, null, '', 'on', 1]) assert.strictEqual(postChainEnabled(v), true, String(v));
});

// ── 端到端（要 ffmpeg；生成一段 440Hz 正弦波再过链）──
const spec = buildPostChainArgs({});
const { execSync } = await import('node:child_process');
let ffmpeg = '';
for (const c of [
  path.join(process.cwd(), 'gpt-sovits-app', 'GPT-SoVITS-v2pro-20250604', 'runtime', 'ffmpeg.exe'),
  'ffmpeg',
]) {
  try { execSync(`"${c}" -version`, { stdio: 'ignore' }); ffmpeg = c; break; } catch { /* 下一个 */ }
}

if (ffmpeg) {
  const tmp = path.join(process.cwd(), 'data', 'voice');
  fs.mkdirSync(tmp, { recursive: true });
  const wav = path.join(tmp, '_postchain_test_in.wav');
  execSync(`"${ffmpeg}" -y -v error -f lavfi -i "sine=frequency=440:duration=1" -ar 32000 -ac 1 "${wav}"`, { stdio: 'ignore' });

  ok('④ 端到端：正弦波过链后仍是有效 wav（16k 单声道）', async () => {
    const buf = fs.readFileSync(wav);
    const r = await applyPostChain(buf, { enabled: true });
    assert.strictEqual(r.processed, true, 'reason=' + r.reason);
    assert.ok(r.buffer.length > 44);
    assert.ok(r.seconds > 0.5 && r.seconds < 2, 'seconds=' + r.seconds);
  });

  ok('⑤ enabled=false 直通返回原 buffer', async () => {
    const buf = fs.readFileSync(wav);
    const r = await applyPostChain(buf, { enabled: false });
    assert.strictEqual(r.processed, false);
    assert.strictEqual(r.buffer, buf);
  });

  try { fs.unlinkSync(wav); } catch {}
} else {
  console.log('  - 跳过端到端（机器上没找到 ffmpeg）');
}

console.log(`\n[postchain] ${pass} passed`);
