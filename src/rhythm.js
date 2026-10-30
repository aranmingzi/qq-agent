// 发言节奏 —— 让"连着发几条"看起来像人在打字，而不是机器在批量推送。
//
// ── 学自 Estrella「拟人对话逻辑」的 talk-pace.js / pace.js，两条合并成一个纯函数模块 ──
// ① **首条回复用"总延迟预算"，不是固定等待**。
//    目标不是"固定延迟"，而是"收到消息 → 第一条真的发出去"落在目标区间里。
//    模型生成本身已经花掉的时间要扣掉，所以不会出现"模型慢 2 秒 + 再硬等 1.2 秒 = 3.2 秒"。
//    两个档位：首次触发 1.2–2.0 秒；接着刚才那个人的话 0.9–1.5 秒（略快，像在接话）。
// ② **条间间隔带随机抖动**，按字数附加。
//    固定 700ms 意味着"发三条"永远是 700 + 700 —— 人不会这么整齐，
//    这是最容易被一眼看出来的机器特征之一。
//
// ⚠️ 下面的数字是**经验值**，不是 QQ 官方风控阈值（QQ 从未公开过发送频率上限）。
//    它们只负责"别那么整齐"，允许在 config.json 的 send.pace 段里改。
//
// 纯函数：now / rng 全由入参给，测试不必等真实时间。
import { randInt } from './util.js';
import { typingExtraMs } from './waiting.js';

/** 首条消息的目标总延迟（毫秒）。 */
export const REPLY_TARGET_MS = Object.freeze({
  direct: Object.freeze({ min: 1200, max: 2000 }),
  continuation: Object.freeze({ min: 900, max: 1500 }),
  interject: Object.freeze({ min: 1800, max: 2800 })
});

/** 条间间隔默认值（以前散在 sender 里，现在只有这一份）。 */
export const GAP_DEFAULTS = Object.freeze({
  minMs: 1000,
  maxMs: 3000,
  perCharMs: 20
});

function num(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function r01(rng) {
  const v = Number(rng());
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

/**
 * 第一条消息还要等多久。
 *
 * @param {string} tier  档位：direct / continuation / interject（未知按 direct）
 * @param {number} elapsedMs 从收到消息到"准备发第一条"已经过去多久（模型生成耗时）
 * @param {() => number} [rng]
 * @param {object} [opts]
 * @param {string} [opts.text]  首条消息正文：**按字数**追加一点读的时间（有上限）
 * @returns {number} 毫秒；模型已经超过目标就返回 0（绝不倒扣成负数）
 */
export function firstSendDelayMs(tier, elapsedMs, rng = Math.random, opts = {}) {
  const band = REPLY_TARGET_MS[tier] || REPLY_TARGET_MS.direct;
  const target = band.min + Math.round(r01(rng) * (band.max - band.min));
  const spent = Math.max(0, Number(elapsedMs) || 0);
  // 按字数附加：长消息读完要多花点时间，但**有上限**（一千字也不该等十几秒）。
  // 判据在 waiting.js（唯一实现），这里只是把它加进"目标总延迟"。
  const extra = typingExtraMs(opts.text, { perCharMs: opts.perCharMs, maxExtraMs: opts.maxExtraMs });
  return Math.max(0, target + extra - spent);
}

/**
 * 两条消息之间停多久。
 *
 * 下限**不为 0**：0 延迟等于连着刷屏，那正是要避免的东西。
 * `send.minGapMs` 是**下限**而非被绕过的旧字段：用户在配置里写下的数字，
 * 不该被代码里的默认值悄悄压掉；反过来，节奏也不会比用户设的那条底线更快。
 *
 * @param {string} text 刚发出去那一条的正文（按字数附加延迟）
 * @param {object} [cfg] config.send 段
 * @param {() => number} [rng]
 */
export function sendGapMs(text, cfg = {}, rng = Math.random) {
  // 显式关掉节奏 → 回落旧行为：固定 minGapMs~maxGapMs 的整数随机。
  if (cfg?.pace && cfg.pace.enabled === false) {
    const min = Math.max(200, num(cfg.minGapMs, GAP_DEFAULTS.minMs, 0, 60000));
    const max = Math.max(min, num(cfg.maxGapMs, GAP_DEFAULTS.maxMs, min, 60000));
    return randInt(min, max);
  }
  const pace = cfg?.pace || {};
  const legacy = Math.max(0, num(cfg?.minGapMs, 0, 0, 60000));
  const minMs = Math.max(200, num(pace.minMs, GAP_DEFAULTS.minMs, 0, 60000));
  const maxMs = Math.max(minMs, num(pace.maxMs, GAP_DEFAULTS.maxMs, minMs, 60000));
  const perCharMs = num(pace.perCharMs, GAP_DEFAULTS.perCharMs, 0, 200);
  const jitter = minMs + Math.round(r01(rng) * (maxMs - minMs));
  return Math.min(15000, Math.max(legacy, jitter) + String(text ?? '').length * perCharMs);
}
