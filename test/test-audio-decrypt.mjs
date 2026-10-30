// 加密音频解密自检（网易云 NCM / 酷我 KWM）。
//
// 用「按官方格式加密一遍 → 解密 → 比对」的往返验证：
// 这样既不需要真实样本，也能把 key 派生、偏移计算、异或流三件事一起验住。
// 酷狗 KGM 的样本验证在 test-kgm.mjs（那边有真实文件）。

import assert from 'node:assert';
import crypto from 'node:crypto';

const {
  sniffEncrypted, decryptNcm, decryptKwm, decryptEncryptedAudio,
} = await import('../src/audio-decrypt.js');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; } catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); fail += 1; }
}

const CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex');
const META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex');
const KWM_PRE = 'MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk';
const NCM_PREFIX = Buffer.from("163 key(Don't modify):", 'utf8');

function aesEnc(buf, key) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(buf), c.final()]);
}

/** 造一个结构合法的 NCM（含 meta），用来验解密器。 */
function makeNcm(audio, metaObj) {
  const keySeed = Buffer.from('ABCDEFGH');                       // 8 字节 keybox 种子
  const keyPlain = Buffer.concat([Buffer.from('neteasecloudmusic', 'utf8'), keySeed]);
  const keyCipher = aesEnc(keyPlain, CORE_KEY);
  for (let i = 0; i < keyCipher.length; i++) keyCipher[i] ^= 0x64;

  const metaPlain = Buffer.concat([
    NCM_PREFIX,
    // 官方明文形如 `music:{json}`（电台是 `dj:{json}`），解密端按第一个冒号切
    Buffer.from(aesEnc(Buffer.from('music:' + JSON.stringify(metaObj), 'utf8'), META_KEY).toString('base64'), 'utf8'),
  ]);
  const metaCipher = Buffer.from(metaPlain);
  for (let i = 0; i < metaCipher.length; i++) metaCipher[i] ^= 0x63;

  // 音频密钥流（与解密端同一套 KSA）
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (box[i] + j + keySeed[i % keySeed.length]) & 0xff;
    const t = box[i]; box[i] = box[j]; box[j] = t;
  }
  const stream = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const k = (i + 1) & 0xff;
    const si = box[k];
    const sj = box[(k + si) & 0xff];
    stream[i] = box[(si + sj) & 0xff];
  }
  const encAudio = Buffer.alloc(audio.length);
  for (let i = 0; i < audio.length; i++) encAudio[i] = audio[i] ^ stream[i & 0xff];

  const gap = 7;
  const head = Buffer.alloc(10);
  Buffer.from('CTENFDAM', 'ascii').copy(head, 0);
  head.writeUInt16LE(0x0170, 8);
  const len1 = Buffer.alloc(4); len1.writeUInt32LE(keyCipher.length, 0);
  const len2 = Buffer.alloc(4); len2.writeUInt32LE(metaCipher.length, 0);
  const tail = Buffer.alloc(5 + 4 + gap + 4);                    // 5 字节头 + gapLen + gap + 4 字节尾
  tail.writeUInt32LE(gap, 5);
  return Buffer.concat([head, len1, keyCipher, len2, metaCipher, tail, encAudio]);
}

/** 造一个结构合法的 KWM。 */
function makeKwm(audio, keyNum) {
  const keyBuf = Buffer.alloc(8);
  keyBuf.writeBigUInt64LE(BigInt(keyNum), 0);
  let t = String(keyNum);
  if (t.length > 32) t = t.slice(0, 32);
  else while (t.length < 32) t += String(keyNum);
  const mask = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) mask[i] = KWM_PRE.charCodeAt(i) ^ t.charCodeAt(i);
  const enc = Buffer.alloc(audio.length);
  for (let i = 0; i < audio.length; i++) enc[i] = audio[i] ^ mask[i & 31];
  const head = Buffer.alloc(0x400);
  Buffer.from([0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d,
    0x6b, 0x75, 0x77, 0x6f, 0x2d, 0x74, 0x6d, 0x65]).copy(head, 0);
  keyBuf.copy(head, 0x18);
  return Buffer.concat([head, enc]);
}

const SAMPLE = Buffer.alloc(4096);
SAMPLE.write('fLaC', 0, 'ascii');
for (let i = 4; i < SAMPLE.length; i++) SAMPLE[i] = (i * 37 + 11) & 0xff;

console.log('\n[解密] 格式识别');
ok('NCM 魔数 → ncm', () => {
  const b = Buffer.alloc(0x20); Buffer.from('CTENFDAM', 'ascii').copy(b, 0);
  assert.equal(sniffEncrypted(b), 'ncm');
});
ok('KWM 两种魔数都认', () => {
  const a = Buffer.alloc(0x20);
  Buffer.from([0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d, 0x6b, 0x75, 0x77, 0x6f, 0x2d, 0x74, 0x6d, 0x65]).copy(a, 0);
  assert.equal(sniffEncrypted(a), 'kwm');
  const b = Buffer.alloc(0x20);
  Buffer.from([0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d, 0x6b, 0x75, 0x77, 0x6f, 0, 0, 0, 0]).copy(b, 0);
  assert.equal(sniffEncrypted(b), 'kwm');
});
ok('普通音频不误判', () => {
  const flac = Buffer.alloc(0x400); flac.write('fLaC', 0, 'ascii');
  assert.equal(sniffEncrypted(flac), '');
  const mp3 = Buffer.alloc(0x400); mp3.write('ID3!', 0, 'ascii');
  assert.equal(sniffEncrypted(mp3), '');
  assert.equal(sniffEncrypted(null), '');
});

console.log('\n[解密] 网易云 NCM');
ok('往返：解出的音频与原文逐字节一致', () => {
  const enc = makeNcm(SAMPLE, { musicName: '测试曲', format: 'flac' });
  const r = decryptNcm(enc);
  assert.equal(r.buffer.length, SAMPLE.length);
  assert.ok(r.buffer.equals(SAMPLE), '音频内容不一致');
  assert.equal(r.buffer.subarray(0, 4).toString('ascii'), 'fLaC');
});
ok('元数据能读出来（歌名/格式）', () => {
  const enc = makeNcm(SAMPLE, { musicName: '测试曲', format: 'flac', artist: [['某人', 1]] });
  const r = decryptNcm(enc);
  assert.equal(r.meta?.musicName, '测试曲');
  assert.equal(r.format, 'flac');
});
ok('长度字段越界时报可读错误，不崩在 readUInt32LE 上', () => {
  const enc = makeNcm(SAMPLE, { musicName: 'x' });
  const broken = enc.subarray(0, 24);       // 截断在 key 段中间
  assert.throws(() => decryptNcm(broken), /NCM 文件结构异常|找不到音频/);
});
ok('decryptEncryptedAudio 统一入口返回 kind=ncm', () => {
  const enc = makeNcm(SAMPLE, { musicName: 'y' });
  const r = decryptEncryptedAudio(enc);
  assert.equal(r?.kind, 'ncm');
  assert.ok(r.buffer.equals(SAMPLE));
});

console.log('\n[解密] 酷我 KWM');
ok('往返：解出的音频与原文逐字节一致', () => {
  const enc = makeKwm(SAMPLE, 1844674407370955161n);
  const r = decryptKwm(enc);
  assert.ok(r.buffer.equals(SAMPLE), '音频内容不一致');
});
ok('另一种魔数也能解', () => {
  const enc = makeKwm(SAMPLE, 123456789);
  const r = decryptKwm(enc);
  assert.ok(r.buffer.equals(SAMPLE));
});
ok('decryptEncryptedAudio 统一入口返回 kind=kwm', () => {
  const r = decryptEncryptedAudio(makeKwm(SAMPLE, 777));
  assert.equal(r?.kind, 'kwm');
});
ok('普通音频走统一入口返回 null（不误伤）', () => {
  assert.equal(decryptEncryptedAudio(SAMPLE), null);
});

console.log(`\n[解密] ${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`);
if (fail) process.exit(1);
