/**
 * 人声后处理链 —— 学自「小鱼语音训练方式.zip」的合成出口（voice.mjs）。
 *
 * 它解决什么：不同音色的参考音频来自不同来源（官方视频抓轨 / 自造 / 下载），
 * 响度和频谱不齐 —— 有的发闷、有的齿音刺、有的比别的音色响一截。
 * 发送端统一过一遍这条链，全音色听感对齐，且不依赖训练侧是否做过 loudnorm。
 *
 * 链路逐段说明（2026-10-28 训练工程实测调过的组合，原样移植）：
 *   highpass=f=80        切掉低频隆隆声（呼吸/桌震/QQ 语音用不到的频段）
 *   afftdn=nr=8:nf=-40   FFT 降噪，nr=8 保守档，减掉合成底噪不伤齿音
 *   deesser=i=0.3        轻度去齿音（S/M 音刺耳时明显）
 *   equalizer=f=3000:... 提 3kHz +2dB 左右的临场感（t=q:w=1.2:g=2）
 *   loudnorm=I=-16:TP=-1.5:LRA=11  EBU R128 归一到 -16 LUFS（语音条标准响度）
 *
 * 纪律（和本项目其它模块一致）：
 *   ① 可一键关闭：config.audio.postChain = false 或 'off' 时直通返回原 buffer；
 *   ② ffmpeg 缺失/失败绝不炸主流程 —— 降级成原样返回，行为与接入前逐位一致；
 *   ③ 纯函数式封装，test/test-postchain.mjs 直接断言参数拼装。
 */

/** 默认后处理链（学自训练工程，全部音色统一）。 */
export const DEFAULT_POST_CHAIN =
  'highpass=f=80,afftdn=nr=8:nf=-40,deesser=i=0.3,equalizer=f=3000:t=q:w=1.2:g=2,loudnorm=I=-16:TP=-1.5:LRA=11';

/** 后处理开关读法：false / 'off' / '0' 都算关，其余（含没配）算开。 */
export function postChainEnabled(raw) {
  if (raw === false) return false;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'off' || s === 'false' || s === '0') return false;
  }
  return true;
}

/**
 * 拼后处理 ffmpeg 参数。纯函数 —— 参数是唯一真相源，测试直接断言。
 * @param {object} [opts]
 * @param {string} [opts.chain]   覆盖默认链（想试验自己的组合时用）
 * @returns {{args: string[], chain: string} | null}  null = 没有可用后处理
 */
export function buildPostChainArgs({ chain = DEFAULT_POST_CHAIN } = {}) {
  const c = String(chain || '').trim();
  if (!c) return null;
  return {
    chain: c,
    args: ['-y', '-i', '{IN}', '-af', c, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', '{OUT}'],
  };
}

/**
 * 对一段合成好的音频跑后处理链 + 转 QQ 语音条标准（16kHz 单声道 s16）。
 * 失败时原样返回输入 buffer —— 后处理是增益项，不是必要项。
 *
 * @param {Buffer} buffer  合成输出的 wav
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]  总开关（读 config.audio.postChain 的调用方自己传）
 * @param {string}  [opts.chain]    覆盖默认链
 * @returns {Promise<{buffer: Buffer, seconds: number, processed: boolean, reason?: string}>}
 */
export async function applyPostChain(buffer, { enabled = true, chain = DEFAULT_POST_CHAIN } = {}) {
  if (!enabled || !buffer?.length) {
    return { buffer, seconds: 0, processed: false, reason: enabled ? 'empty' : 'disabled' };
  }
  const spec = buildPostChainArgs({ chain });
  if (!spec) return { buffer, seconds: 0, processed: false, reason: 'no-chain' };

  const path = await import('node:path');
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { ROOT } = await import('./config.js');
  const { resolveFfmpeg } = await import('./media-tools.js');

  const ff = resolveFfmpeg();
  if (!ff) return { buffer, seconds: 0, processed: false, reason: 'no-ffmpeg' };

  const tmpIn = path.join(ROOT, 'data', 'voice', '_post_in_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.wav');
  const tmpOut = path.join(ROOT, 'data', 'voice', '_post_out_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.wav');
  try {
    fs.mkdirSync(path.dirname(tmpIn), { recursive: true });
    fs.writeFileSync(tmpIn, buffer);
    const args = spec.args.map((a) => (a === '{IN}' ? tmpIn : a === '{OUT}' ? tmpOut : a));
    const r = spawnSync(ff, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (r.status === 0 && fs.existsSync(tmpOut)) {
      const out = fs.readFileSync(tmpOut);
      if (out.length > 44) {
        return { buffer: out, seconds: Math.round((out.length - 44) / 32000 * 10) / 10, processed: true };
      }
      return { buffer, seconds: 0, processed: false, reason: 'empty-output' };
    }
    return { buffer, seconds: 0, processed: false, reason: 'ffmpeg-exit-' + r.status + ': ' + String(r.stderr || '').slice(-120) };
  } catch (e) {
    return { buffer, seconds: 0, processed: false, reason: String(e?.message ?? e).slice(0, 120) };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}
