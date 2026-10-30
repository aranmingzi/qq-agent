/**
 * 「随语气自动调速」——把一句话的**情绪形状**翻译成一个语速倍数。
 *
 * 为什么需要它：固定语速听久了像播报。真人说话时情绪会改速度——
 * 着急/惊讶时快，撒娇/低落时慢，长句会不自觉加速否则拖沓。
 * 这里只用标点和字符做判断（不调用模型，零延迟），规则都写在注释里。
 *
 * 注意：这不是"情感分析"，是**启发式**。宁可保守（倍数只在小范围浮动），
 * 也不要把「我很生气！」念成倒放。基准速度由音色决定，这里只做乘数。
 *
 * 来源：qq-bridge 媒体能力包 `src/prosody.js`（2026-10-25 学习移植）。
 * 移植时的两处加固：
 *   1. `mult` 每次都 clamp —— 原版只在返回时 clamp，中途叠出 NaN 会一路传下去；
 *   2. `resolveSpeed` 对 base 做 `Number.isFinite`——配置里填了字符串不会变成 NaN。
 */

/** 最终语速的上下限，防止某条规则叠出离谱的值。 */
/** 语气乘数的上下限（相对音色基准）。 */
export const SPEED_MIN = 0.88;
export const SPEED_MAX = 1.26;
/**
 * 最终 speed_factor 的绝对上下限。
 * 注意别拿 SPEED_MIN/MAX 去夹乘积 —— 那是**乘数**的范围，
 * 用它夹会让基准 1.15 的音色永远到不了 1.26 以上，等于把语气调节砍掉一截。
 */
export const SPEED_ABS_MIN = 0.5;
export const SPEED_ABS_MAX = 2.0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * @param {string} text 要念出来的纯文本（已洗过）
 * @returns {{mult:number, tags:string[]}} mult 为相对倍数，tags 说明为什么
 */
export function autoSpeedMultiplier(text) {
  const s = String(text ?? '');
  const tags = [];
  let mult = 1;

  const len = s.length;
  const bang = (s.match(/[！!]/g) ?? []).length;
  const ques = (s.match(/[？?]/g) ?? []).length;
  const softTail = (s.match(/[呀嘛啦呢哦唔欸诶嘞哈]|～|~/g) ?? []).length;
  const ellipsis = /…|\.\.\.|——/.test(s);
  const repeated = /(.)\1/.test(s);

  // 1) 感叹 / 催促 → 快。连两个感叹号多半是在嚷，再多给一点。
  if (bang >= 2) { mult += 0.08; tags.push('连感叹'); }
  else if (bang === 1) { mult += 0.05; tags.push('感叹'); }

  // 2) 疑问 → 略快。真人问句末尾往往提气带过，不是慢慢念。
  if (ques > 0) { mult += 0.02; tags.push('疑问'); }

  // 3) 软语气词成堆 / 省略号 / 拖长音 → 慢。撒娇、犹豫、贴耳说话都在这一档。
  if (softTail >= 3) { mult -= 0.06; tags.push('语气词多'); }
  else if (softTail >= 1) { mult -= 0.02; tags.push('软尾巴'); }
  if (ellipsis) { mult -= 0.04; tags.push('省略号'); }

  // 4) 叠字（"慢慢""好好""悄悄"）→ 略微放慢，念快了会像口吃。
  if (repeated && softTail > 0) { mult -= 0.02; tags.push('叠字'); }

  // 5) 长句 → 加快，否则一口气念 40 字会显得拖。
  if (len >= 40) { mult += 0.04; tags.push('长句'); }
  else if (len <= 8 && bang > 0) { mult += 0.02; tags.push('短促'); }

  // 6) 极长且没有标点（模型偶尔吐出来的一长串）→ 明显加快，救可听性。
  if (len >= 70 && !/[。！？，；]/.test(s)) { mult += 0.06; tags.push('无标点长串'); }

  if (!Number.isFinite(mult)) return { mult: 1, tags: [] };
  return { mult: Number(clamp(mult, SPEED_MIN, SPEED_MAX).toFixed(3)), tags };
}

/**
 * 合成时真正用的 speed_factor：音色基准 × 语气倍数 × 情绪偏置。
 *
 * @param {string} text
 * @param {number} baseSpeed 音色给的基准（1 = 原速）
 * @param {object} [opts]
 * @param {number} [opts.emotionBias] 情绪给的语速偏置（voice-delivery.js 的 speedBias）。
 *   默认 1 = 不参与，行为与旧版逐位一致 —— 这样没开情绪链路时不可能出现回归。
 * @param {string} [opts.emotion] 情绪名，只用于日志可读性
 */
export function resolveSpeed(text, baseSpeed = 1, opts = {}) {
  const n = Number(baseSpeed);
  const base = Number.isFinite(n) && n > 0 ? n : 1;
  const auto = autoSpeedMultiplier(text);
  // 情绪偏置本身也要夹：它是从查表来的，但表可能被人改、配置可能填字符串。
  const biasRaw = Number(opts?.emotionBias);
  const bias = Number.isFinite(biasRaw) && biasRaw > 0
    ? Number(clamp(biasRaw, SPEED_MIN, SPEED_MAX).toFixed(3))
    : 1;
  // 两步分开夹：先把"文本语气 × 情绪"夹回乘数区间，再乘基准。
  // 直接连乘会让"连感叹 + 兴奋"叠到 1.34，超出 SPEED_MAX 的口径。
  const mult = Number(clamp(auto.mult * bias, SPEED_MIN, SPEED_MAX).toFixed(3));
  // 乘积也要夹一次：mult 本身夹住了，但基准是音色自己配的，
  // 有人填 2.0 就会算出 2.5 —— 超出 SoVITS 合理区间，念出来是快进的怪声。
  const speed = Number(clamp(base * mult, SPEED_ABS_MIN, SPEED_ABS_MAX).toFixed(3));
  return { speed, mult, tags: auto.tags, base, bias };
}

/** 给日志用的一行说明。 */
export function describeSpeed(text, baseSpeed = 1, opts = {}) {
  const r = resolveSpeed(text, baseSpeed, opts);
  const why = r.tags.length ? r.tags.join('/') : '平';
  const emo = r.bias !== 1 ? ` × 情绪 ${r.bias}` : '';
  return `语速 ${r.speed}×（基准 ${r.base} × 语气 ${r.mult}${emo}，${why}）`;
}
