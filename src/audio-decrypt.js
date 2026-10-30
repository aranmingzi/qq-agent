// 各平台加密音频的解密总入口（网易云 NCM、酷我 KWM；酷狗 KGM 在 kgm.js）。
//
// 为什么要收进来：QQagent 的唱歌链路只认「真音频」，而群友发过来的经常是
// 各平台的加密下载文件 —— 扩展名看着正常（.flac/.mp3），内容却是密文，
// ffmpeg 一读就报 "Output file #0 does not contain any stream"。
// 让群友自己去装工具转换一遍，比在服务端自动解密差得远。
//
// 算法出处：unlock-music（MIT），与其 src/decrypt/{ncm,kwm}.ts 一致。
// 各格式的魔数：
//   NCM  `CTENFDAM`                 （网易云，AES-128-ECB + 自建 RC4 keybox）
//   KWM  `yeelion-kuwo-tme` / `yeelion-kuwo\0\0\0\0`（酷我，32 字节循环异或）
//   KGM  0x7CD532EB…                （酷狗，见 kgm.js）
// QQ 音乐的 qmc 系列不在这里：qmcflac/mflac/mgg 需要加密表或客户端密钥，
// 官方工具也得靠内置 key 才能解，这里只做能确定性解开的。

import crypto from 'node:crypto';

const NCM_MAGIC = Buffer.from('CTENFDAM', 'ascii');            // 8 字节
const KWM_MAGIC1 = Buffer.from([
  0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d,
  0x6b, 0x75, 0x77, 0x6f, 0x2d, 0x74, 0x6d, 0x65,
]);
const KWM_MAGIC2 = Buffer.from([
  0x79, 0x65, 0x65, 0x6c, 0x69, 0x6f, 0x6e, 0x2d,
  0x6b, 0x75, 0x77, 0x6f, 0x00, 0x00, 0x00, 0x00,
]);

// 网易云写死的两把 key（不是用户密钥，全世界的 NCM 都用这两个）
const NCM_CORE_KEY = Buffer.from('687a4852416d736f356b496e62617857', 'hex');
const NCM_META_KEY = Buffer.from('2331346c6a6b5f215c5d2630553c2728', 'hex');
const KWM_PREDEFINED_KEY = 'MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk';

/** 是哪种加密格式？不是加密文件返回 ''。 */
export function sniffEncrypted(buf) {
  if (!buf || buf.length < 0x20) return '';
  if (buf.subarray(0, 8).equals(NCM_MAGIC)) return 'ncm';
  if (buf.subarray(0, 16).equals(KWM_MAGIC1) || buf.subarray(0, 16).equals(KWM_MAGIC2)) return 'kwm';
  return '';
}

function aesEcbDecrypt(cipher, key) {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(true);        // PKCS7，和 crypto-js 默认一致
  return Buffer.concat([d.update(cipher), d.final()]);
}

/** 标准 RC4 KSA + 一次变换，得到 256 字节密钥流。 */
function buildKeyBox(keyData) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (box[i] + j + keyData[i % keyData.length]) & 0xff;
    const t = box[i]; box[i] = box[j]; box[j] = t;
  }
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const k = (i + 1) & 0xff;
    const si = box[k];
    const sj = box[(k + si) & 0xff];
    out[i] = box[(si + sj) & 0xff];
  }
  return out;
}

/**
 * 解网易云 NCM。
 * 文件结构：[8 字节魔数][2 字节版本][keyLen][key 密文][metaLen][meta 密文][crc 4][gap 5][音频]
 * @returns {{buffer: Buffer, meta: object|null, format: string}}
 */
export function decryptNcm(buf) {
  let off = 10;
  const guard = (n) => {
    if (!Number.isFinite(n) || n < 0 || off + n > buf.length) {
      throw new Error('NCM 文件结构异常（长度字段越界），文件可能没下完');
    }
  };

  guard(4);
  const keyLen = buf.readUInt32LE(off); off += 4;
  guard(keyLen);
  const keyCipher = Buffer.alloc(keyLen);
  for (let i = 0; i < keyLen; i++) keyCipher[i] = buf[off + i] ^ 0x64;
  off += keyLen;
  // 解密后的前 17 字节是 "neteasecloudmusic"，丢掉才是真正的 keybox 种子
  const keyPlain = aesEcbDecrypt(keyCipher, NCM_CORE_KEY).subarray(17);
  const keyBox = buildKeyBox(keyPlain);

  guard(4);
  const metaLen = buf.readUInt32LE(off); off += 4;
  let meta = null;
  if (metaLen > 0) {
    guard(metaLen);
    const metaCipher = Buffer.alloc(metaLen);
    for (let i = 0; i < metaLen; i++) metaCipher[i] = buf[off + i] ^ 0x63;
    off += metaLen;
    try {
      // 前 22 字节是 "163 key(Don't modify):" 这层壳，剩下的是 base64 的 AES 密文
      const b64 = metaCipher.subarray(22).toString('utf8');
      const raw = aesEcbDecrypt(Buffer.from(b64, 'base64'), NCM_META_KEY).toString('utf8');
      const idx = raw.indexOf(':');
      const obj = JSON.parse(raw.slice(idx + 1));
      meta = obj.mainMusic || obj;      // 电台节目会多包一层 mainMusic
    } catch {
      meta = null;                      // 元数据坏了不影响听歌，继续解音频
    }
  }

  // 音频起点：官方实现写的是 `offset += u32LE(offset+5) + 13`。
  // 这里照抄那个表达式而不是自己化简 —— meta 之后的结构（CRC / 间隔 / 长度字段）
  // 有 4 字节的语义一直没在文档里写清，化简容易差一位，直接对齐官方最稳。
  const audioGap = buf.readUInt32LE(off + 5);
  const audioStart = off + audioGap + 13;
  if (!Number.isFinite(audioStart) || audioStart >= buf.length) {
    throw new Error('NCM 里找不到音频数据（文件可能被截断）');
  }

  const out = Buffer.alloc(buf.length - audioStart);
  for (let i = 0; i < out.length; i++) out[i] = buf[audioStart + i] ^ keyBox[i & 0xff];
  return { buffer: out, meta, format: String(meta?.format || '').toLowerCase() };
}

/**
 * 解酷我 KWM：32 字节 mask（预置串 ^ 十进制密钥串），从 0x400 起循环异或。
 * @returns {{buffer: Buffer, format: string}}
 */
export function decryptKwm(buf) {
  if (buf.length <= 0x400) throw new Error('KWM 文件太短，文件可能没下完');
  const keyStr = buf.readBigUInt64LE(0x18).toString();
  let t = keyStr;
  if (t.length > 32) t = t.slice(0, 32);
  else while (t.length < 32) t += keyStr;   // 短了就用自身重复补齐，和官方实现一致
  const mask = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    mask[i] = KWM_PREDEFINED_KEY.charCodeAt(i) ^ t.charCodeAt(i);
  }
  const out = Buffer.alloc(buf.length - 0x400);
  for (let i = 0; i < out.length; i++) out[i] = buf[0x400 + i] ^ mask[i & 31];
  // 酷我音频本体一般是 mp3，个别是 flac；扩展名交给上层 sniff
  return { buffer: out, format: '' };
}

/**
 * 统一入口：是加密文件就解开，不是就返回 null（调用方按普通音频处理）。
 * @returns {{kind: string, buffer: Buffer, meta: object|null}|null}
 */
export function decryptEncryptedAudio(buf) {
  const kind = sniffEncrypted(buf);
  if (!kind) return null;
  if (kind === 'ncm') {
    const r = decryptNcm(buf);
    return { kind, buffer: r.buffer, meta: r.meta };
  }
  const r = decryptKwm(buf);
  return { kind, buffer: r.buffer, meta: null };
}
