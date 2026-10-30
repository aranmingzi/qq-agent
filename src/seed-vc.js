// Seed-VC 零样本音色转换客户端
//
// 服务：seed-vc/seedvc_service.py（127.0.0.1:3213，CPU 推理较慢）
// 原理：source 提供发音内容+旋律，target（胡桃参考干声）提供音色，
//       f0_condition=true 保留 source 的旋律音高，用参考音色重合成。
//
// 与 SVC（so-vits-svc）的区别：Seed-VC 是零样本（不需要训练模型），
// 但 CPU 推理慢（约 5 分钟/段）；SVC 需要胡桃模型但 GPU 快（~30 秒/段）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const API = 'http://127.0.0.1:3213';

export async function seedVcHealth(timeoutMs = 5000) {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, ...(await res.json()) };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

/** 用 Seed-VC 把一段音频换成胡桃音色。
 *  @param {Buffer} audio  源音频（wav 字节）
 *  @returns {{buffer, ext, seconds, costMs}} 或抛错
 */
export async function seedVcConvert(audio, { diffusionSteps = 20, f0Condition = true, pitchShift = 0, timeoutMs = 600000 } = {}) {
  const q = new URLSearchParams({
    diffusion_steps: String(diffusionSteps),
    f0_condition: String(f0Condition),
    pitch_shift: String(pitchShift),
  });
  const t0 = Date.now();
  const res = await fetch(`${API}/convert?${q.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: audio,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Seed-VC 转换失败 ${res.status}: ${String(msg).slice(0, 150)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('Seed-VC 返回空音频');
  return {
    buffer,
    ext: 'wav',
    seconds: Math.round((buffer.length - 44) / 44100 / 2 * 10) / 10,
    costMs: Date.now() - t0,
  };
}

/** 便捷：把本地 wav 文件路径换成胡桃音色。 */
export async function seedVcConvertFile(filePath, opts = {}) {
  const audio = fs.readFileSync(filePath);
  return seedVcConvert(audio, opts);
}
