// 等待与合并：**"什么时候开始处理"和"什么时候先垫一句"是两件独立的事**。
//
// 为什么单独一层（学自 Estrella-Bot `waiting.js`，2026-10-22 调研 P1-6）：
//   我们原本只有 `rhythm.js`（发出去之间停多久）。缺的是另一半：
//     · 一群人在连发时，什么时候算"说完了"（连发合并）；
//     · 模型迟迟不出结果时，要不要先垫一句"我想想"（慢任务垫话）。
//   这两件事都在"发送之前"，却一直被塞在发送节奏里讨论，于是没人能单独调它。
//
// ⚠️ 与 `rhythm.js` 的分工（不要重造）：
//   · `rhythm.firstSendDelayMs` = **回之前等多久**（目标总延迟 − 模型已耗时）→ 唯一实现，不在这里重复；
//   · `rhythm.sendGapMs`        = **两条之间停多久**；
//   · 本文件只负责：**合并窗口** 与 **垫话时机**，外加"按字数附加"的那一小段。
//
// 纯函数：now / rng 全部入参，测试不必等真实时间。

/** 合并窗口默认值（毫秒）。与 config 里的 wakeDelayMs / directWakeDelayMs 同源，不另立一套数字。 */
export const MERGE_DEFAULTS = Object.freeze({
  normalMs: 1800,   // 普通群聊：等对方把话说完
  directMs: 500,    // 被 @/点名/私聊：别让人等
  crowdMs: 2600,    // 好几个人同时在等：等他们把话都说完，才不至于一人一条
  crowdMaxWaitMs: 6000, // 但再多人一直 @ 也不能无限等（否则一群人轮着刷就永远不醒）
  holdMs: 6000,     // 超过这么久还没出结果 → 垫一句
  perCharExtraMs: 15,  // 首条消息每多一个字，多等这么久
  maxCharExtraMs: 1200 // 但最多再多等这么多（长消息不该让人等更久）
});

function clampMs(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 合并窗口：**这批消息"说完了"要等多久**。
 *
 * 判据是"有没有人在叫我"，不是"群还是私聊"：
 *   · 被 @ / 点名 / 引用我的话 / 私聊 → 立即（direct），因为对方在等回应；
 *   · 其它 → 等一个句子说完的时间（normal），期间新消息会重置窗口。
 *
 * ── crowd：好几个人同时在等 ────────────────────────────────────────────
 * 这条判据解决的是一个**结构性**问题，不是调参问题：
 * 被 @ 时窗口只有 500ms，第二个人一秒后才 @ 它 → 他必然落进 drain，
 * 于是同一件事被拆成"一人回一条"。窗口短是"回得快"，拆开之后就成了"逐条回"。
 * 所以 → 一旦这批里已经有 ≥2 个人在等它，窗口放宽到 crowdMs（且不短于原本该等的），
 * 让他们一起进来 —— 这样才有机会"一句话带过所有人"。
 *
 * ⚠️ 放长窗口的代价是"第一个 @ 它的人要多等两秒"。这是刻意接受的：
 *    真人被两个人同时叫住时，也会先听完"叫我干嘛"再答。
 *
 * @param {object} opts
 * @param {boolean} opts.urgent  是否有人在直接叫我
 * @param {boolean} [opts.crowd] 是否 ≥2 个人在等我（crowd.js::isMultiAsk）
 * @param {number} [opts.normalMs]
 * @param {number} [opts.directMs]
 * @param {number} [opts.crowdMs]
 * @returns {number}
 */
export function mergeWindowMs({
  urgent = false, crowd = false,
  normalMs = MERGE_DEFAULTS.normalMs, directMs = MERGE_DEFAULTS.directMs,
  crowdMs = MERGE_DEFAULTS.crowdMs
} = {}) {
  const normal = clampMs(normalMs, 0, 60000);
  const direct = clampMs(directMs, 0, 60000);
  const base = urgent ? Math.min(direct, normal) : normal;
  if (!crowd) return base;
  const wide = clampMs(crowdMs, 0, 60000);
  // max 而不是直接返回 wide：用户可能把 crowdMs 配得比普通窗口还短，
  // 那就不该"因为人多反而等得更短" —— 只会放宽，不会收紧。
  return Math.max(base, wide);
}

/**
 * 最长等待兜底：**一堆人轮流 @ 它时，不能每一句都把计时器重置**。
 *
 * 现有防抖是"每来一条消息重置计时"，人多的时候这个性质会反过来咬人：
 * 只要群里每两秒有人 @ 它一次，窗口就永远重置 —— 表现为"它卡在那儿一句话不说"。
 * 所以从**第一次**安排唤醒起算一个硬顶，到点就进场。
 *
 * @param {object} opts
 * @param {number} opts.since     第一次安排唤醒的时间戳
 * @param {number} opts.now
 * @param {number} opts.windowMs  本次算出来的窗口
 * @param {number} [opts.maxWaitMs] 硬顶（0/负数 = 不设上限）
 * @returns {number} 实际该用的毫秒数（0 <= 结果 <= maxWaitMs - 已经等过的）
 */
export function capWait({ since = 0, now = Date.now(), windowMs = 0, maxWaitMs = MERGE_DEFAULTS.crowdMaxWaitMs } = {}) {
  const win = clampMs(windowMs, 0, 60000);
  const cap = Number(maxWaitMs);
  if (!Number.isFinite(cap) || cap <= 0) return win;
  const started = Number(since) || Number(now) || 0;
  const left = Math.max(0, cap - Math.max(0, Number(now) - started));
  return Math.min(win, left);
}

/**
 * 首条消息的"按字数附加"停顿。
 *
 * 为什么不是"越长等越久"：真人看到一句长话，读完确实要多花一点时间，
 * 但**不是线性**的 —— 一千字的消息也不会让人等十五秒。所以有 `maxCharExtraMs` 硬顶。
 * 这一条与 `rhythm.firstSendDelayMs` 的"目标总延迟"叠加使用，不替代它。
 *
 * @param {string} text
 * @param {object} [opts]
 * @returns {number} 毫秒（0..maxCharExtraMs）
 */
export function typingExtraMs(text, opts = {}) {
  const len = String(text ?? '').length;
  if (!len) return 0;
  const per = clampMs(opts.perCharMs ?? MERGE_DEFAULTS.perCharExtraMs, 0, 200);
  const cap = clampMs(opts.maxExtraMs ?? MERGE_DEFAULTS.maxCharExtraMs, 0, 10000);
  return Math.min(cap, Math.round(len * per));
}

/**
 * 慢任务垫话：**该不该先垫一句**。
 *
 * 三条判据（缺一条都不垫）：
 *   ① 已经超过 holdMs；
 *   ② 这一轮还一句都没发出去（发过了就别再垫，否则变成刷屏）；
 *   ③ 垫话文案非空（默认关闭 —— 想开的人自己配一句）。
 *
 * 刻意**不看模型进度**：这里拿不到"模型跑到哪了"，只能按时间判。
 * 所以 holdMs 必须明显大于正常生成耗时（默认 6 秒），否则每轮都会垫一句。
 *
 * @param {object} opts
 * @param {number} opts.startedAt
 * @param {number} opts.now
 * @param {number} [opts.holdMs]
 * @param {number} [opts.sentCount] 本轮已发条数
 * @param {string} [opts.text]      垫话文案（空 = 关闭）
 * @returns {boolean}
 */
export function shouldHold({ startedAt = 0, now = Date.now(), holdMs = MERGE_DEFAULTS.holdMs, sentCount = 0, text = '' } = {}) {
  if (!String(text ?? '').trim()) return false;
  if (Number(sentCount) > 0) return false;
  const start = Number(startedAt) || 0;
  if (!start) return false;
  const waited = Number(now) - start;
  return waited >= clampMs(holdMs, 1000, 120000);
}

/** 给日志用：本次等待的构成（排查"为什么它 3 秒才开口"时看这一行）。 */
export function describeWait({ windowMs = 0, urgent = false, crowd = false, charExtraMs = 0 } = {}) {
  const bits = [`合并窗口 ${Math.round(windowMs)}ms`];
  if (crowd) bits.push('（好几个人同时在等，等他们说完）');
  else if (urgent) bits.push('（被叫到了，走直通）');
  if (charExtraMs > 0) bits.push(`按字数附加 ${Math.round(charExtraMs)}ms`);
  return `[等待] ${bits.join(' ')}`;
}
