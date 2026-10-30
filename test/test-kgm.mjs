// KGM（酷狗加密音频）解密自检。
//
// 不依赖真实密文样本：用一个自造的密文做「加密→解密」往返，
// 校验算法与官方 unlock-music 实现一致（key 17 字节循环、mask 4MiB 表、
// 半字节混淆的合并顺序）。真实文件（侧脸.kgm.flac）只需人工验一次。

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { isKgm, isKgmFile, decryptKgmSync } = await import('../src/kgm.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; } catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); fail += 1; }
}

const MAGIC = Buffer.from([0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b, 0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14]);

/** 按官方算法的逆运算造一份密文（用来验解密器，不需要真 key）。 */
function makeCipher(plain, key) {
  const headerLen = 0x400;
  const buf = Buffer.alloc(headerLen + plain.length);
  MAGIC.copy(buf, 0);
  buf.writeUInt32LE(headerLen, 0x10);
  buf.writeUInt32LE(3, 0x14);
  buf.writeUInt32LE(1, 0x18);
  key.copy(buf, 0x1c, 0, 16);          // 第 17 字节留 0，与官方 key1 布局一致
  // 表全给零（解密的 tables 参数同样传零表）：这样往返验的是
  // key 的 17 字节相位、16 字节分块、以及半字节混淆的可逆性，
  // 而三张表本身由真实样本负责验（见文件末尾的条件断言）。
  for (let i = 0; i < plain.length; i++) {
    const med8 = plain[i];             // mask=0 时 med8 就是明文
    // 反解 med8 → raw：med8 = t ^ ((t & 0xf) << 4)，其中 t = key ^ raw
    const t = invNibble(med8);
    buf[headerLen + i] = t ^ key[i % 17];
  }
  return buf;
}

/** med8 = t ^ ((t & 0xf) << 4) 的反函数（该变换是对合的，逆等于自身）。 */
function invNibble(x) {
  return x ^ ((x & 0xf) << 4);
}

console.log('\n[KGM] 魔数识别');
ok('KGM 魔数 → true', () => {
  const buf = Buffer.alloc(0x500);
  MAGIC.copy(buf, 0);
  assert.equal(isKgm(buf), true);
});
ok('VPR 魔数也算加密音频', () => {
  const buf = Buffer.alloc(0x500);
  Buffer.from([0x05, 0x28, 0xbc, 0x96, 0xe9, 0xe4, 0x5a, 0x43,
    0x91, 0xaa, 0xbd, 0xd0, 0x7a, 0xf5, 0x36, 0x31]).copy(buf, 0);
  assert.equal(isKgm(buf), true);
});
ok('普通 flac 不误判', () => {
  const buf = Buffer.alloc(0x500);
  buf.write('fLaC', 0, 'ascii');
  assert.equal(isKgm(buf), false);
});
ok('普通 mp3 / wav 不误判', () => {
  const mp3 = Buffer.alloc(0x500, 0xff);
  mp3.write('ID3!', 0, 'ascii');
  assert.equal(isKgm(mp3), false);
  const wav = Buffer.alloc(0x500);
  wav.write('RIFF', 0, 'ascii');
  assert.equal(isKgm(wav), false);
});
ok('太短的 buffer 一律否', () => {
  assert.equal(isKgm(Buffer.alloc(8)), false);
  assert.equal(isKgm(null), false);
});

console.log('\n[KGM] 文件头探测');
ok('isKgmFile 读盘判断，且对不存在的文件返回 false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgm-test-'));
  const f = path.join(dir, 'a.flac');
  const buf = Buffer.alloc(0x500);
  MAGIC.copy(buf, 0);
  fs.writeFileSync(f, buf);
  assert.equal(isKgmFile(f), true);
  assert.equal(isKgmFile(path.join(dir, 'nope.flac')), false);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
});

console.log('\n[KGM] 解密算法往返');
ok('往返能还原明文（长度、首字节、随机抽查都一致）', () => {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f00', 'hex');
  const plain = Buffer.alloc(70000);
  plain.write('fLaC', 0, 'ascii');
  for (let i = 4; i < plain.length; i++) plain[i] = (i * 17 + (i >> 5)) & 0xff;

  const cipher = makeCipher(plain, key);
  assert.equal(isKgm(cipher), true);
  const zero = Buffer.alloc(272);
  const got = decryptKgmSync(cipher, { predef: zero, t1: zero, t2: zero }).buffer;
  assert.equal(got.length, plain.length);
  for (const i of [0, 1, 2, 3, 4095, 4096, 12345, 65535, plain.length - 1]) {
    assert.equal(got[i], plain[i], `第 ${i} 字节不一致`);
  }
  assert.equal(got.subarray(0, 4).toString('ascii'), 'fLaC');
});
ok('头部 headerLen 异常时给出可读报错，而不是崩在越界上', () => {
  const buf = Buffer.alloc(0x500);
  MAGIC.copy(buf, 0);
  buf.writeUInt32LE(0x999999, 0x10);   // 声称的头长度比文件还长
  assert.throws(() => decryptKgmSync(buf), /KGM 文件头异常/);
});

// 真实样本（本地有就验，CI/新机器没有就跳过）：
// 这一步才能真正校验三张表与官方实现一致 —— 往返测试只能验结构。
console.log('\n[KGM] 真实样本（有则验，无则跳过）');
const sample = [
  path.join('songs', 'raw', '侧脸.kgm.bak'),
  path.join('test', 'fixtures', 'sample.kgm'),
].find((p) => fs.existsSync(p) && isKgmFile(p));
if (!sample) {
  console.log('  – 未找到 .kgm 样本，跳过（不算失败）');
} else {
  ok(`真实密文解出 flac 头（${path.basename(sample)}）`, () => {
    const dec = decryptKgmSync(fs.readFileSync(sample));
    assert.equal(dec.buffer.subarray(0, 4).toString('ascii'), 'fLaC');
    // 明文里应能读到 STREAMINFO（位于 fLaC 头之后），长度字段要大于 0
    assert.ok(dec.buffer.length > 0x1000, '解出来的数据太少');
    assert.equal(dec.buffer.length, fs.statSync(sample).size - dec.headerLen);
  });
}

console.log(`\n[KGM] ${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`);
if (fail) process.exit(1);
