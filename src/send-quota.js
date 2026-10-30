// 发送额度的**前置**感知：在花掉一整轮模型调用之前，先问一句"这一分钟还发得出去吗"。
//
// ── 为什么需要它（2026-10-29 第 3 轮对标，学自 AstrBot / LangBot 的限流阶段）──
// 我们的限流只在**发送时**判（sender.js 的 #checkRate）：模型已经想完、工具已经调了，
// 才被告知"这一分钟发到上限了"。那次模型调用照样全额计费，而且模型的反应往往是
// 再跑一轮换句话重试 —— 又是一整轮。
//
// 实测（`data/sessions/` 1000 份会话，2026-10-29）：
//   · `finishReason` 命中限流文案且 `sent.length === 0` 的会话 **78 个**；
//   · 它们合计烧掉 **2,550,975** prompt tokens，占全部 32,849,688 的 **7.77%**，
//     平均每个 **32,943 tokens**，而这一轮什么都没发出去；
//   · 这 78 个会话里，**每一个**在开始前 60 秒内都已经由同一个群发过 **4 条**
//     （分布恰好是 {4: 78}）—— 也就是说额度在模型开口之前就已经满了，它不可能成功。
//
// 竞品的做法是在**入站阶段**就把这种轮次挡掉（AstrBot 的 RateLimitStage、
// LangBot 的 ratelimit 阶段都排在 LLM 阶段之前），所以它们从不为此付费。
//
// ── 边界 ──────────────────────────────────────────────────────────────────
// 本模块**只回答"还剩几条"**，不做任何决定、不写文件、不看时间以外的状态：
// 判定与留痕在 orchestrator 的 wake() 里，落盘由 sender 的内存桶负责。
// 这样测试可以用假时钟，也不需要清 data/。
//
// ⚠️ 取额度上限的规则**只能有一份**：`resolveMinuteLimit`。
// sender 的 #minuteLimit 与 #checkRate 都走它 —— 两边各写一遍必然漂移
// （同类事故：降级链的 MAX_CHAIN 与 orchestrator 的 slice 上限没对齐，
// 第 8 条端点永不尝试且零报错）。

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/**
 * 这个会话每分钟允许发几条文字（0 = 不限）。
 *
 * 私聊可以用 `maxPerMinutePrivate` 单独放宽（一对一里用户连发、她分条回，
 * 和群里"别刷屏"不是一回事）；未配置 = 沿用 `maxPerMinute`，配 0 = 私聊不限速。
 *
 * @param {string} chatKey
 * @param {object} sendCfg `config.send`
 * @returns {number} 非负整数，0 表示不限
 */
export function resolveMinuteLimit(chatKey, sendCfg = {}) {
  const cfg = sendCfg || {};
  const kind = String(chatKey).split(':')[0];
  const privRaw = cfg.maxPerMinutePrivate;
  const raw = (kind === 'private' && privRaw !== undefined && privRaw !== null)
    ? privRaw
    : cfg.maxPerMinute;
  return Number(raw) || 0;
}

/**
 * 单窗口用量：给定时间戳列表与上限，算出还剩几条、满的话还要多久滑出窗口。
 *
 * 时间戳收垃圾（非数字、未来时间）一律丢掉：桶是内存里的，出过一次脏数据
 * 就会让某个会话永久"发满了"。
 *
 * @param {object} p
 * @param {number[]} [p.times]    该桶里的发送时间戳
 * @param {number}   [p.limit]    上限，0 = 不限
 * @param {number}   [p.windowMs] 窗口长度
 * @param {number}   [p.now]
 * @returns {{limit:number, used:number, remaining:number, resetInMs:number, unlimited:boolean}}
 */
export function quotaFrom({ times = [], limit = 0, windowMs = MINUTE_MS, now = Date.now() } = {}) {
  const cap = Number(limit) || 0;
  const t = Number(now);
  if (!(cap > 0)) {
    // 不限：remaining 用 Infinity 而不是 null —— 调用方统一写 `remaining <= 0`，
    // 而 `null <= 0` 在 JS 里是 true，会把"不限"误判成"发满了"。
    return { limit: 0, used: 0, remaining: Infinity, resetInMs: 0, unlimited: true };
  }
  const span = Number(windowMs) || MINUTE_MS;
  const ts = (Array.isArray(times) ? times : [])
    .map(Number)
    .filter((x) => Number.isFinite(x) && x <= t && t - x < span)
    .sort((a, b) => a - b);
  const used = ts.length;
  const remaining = Math.max(0, cap - used);
  // 还有余额就不用等；满了则等最早那条滑出窗口。
  const resetInMs = remaining > 0 ? 0 : Math.max(0, ts[0] + span - t);
  return { limit: cap, used, remaining, resetInMs, unlimited: false };
}

/**
 * 综合分钟与小时两个窗口，给出**更紧的那个**。
 *
 * 为什么要一起看：`maxPerHour` 同样会让发送抛错，只看分钟的话
 * "小时额度用完"这种轮次照样白烧一次模型调用。
 *
 * @param {object} p
 * @param {string}   p.chatKey
 * @param {object}   [p.sendCfg]   `config.send`
 * @param {number[]} [p.minuteTimes]
 * @param {number[]} [p.hourTimes]
 * @param {number}   [p.now]
 * @returns {{limit:number, used:number, remaining:number, resetInMs:number, unlimited:boolean, window:'minute'|'hour'|null}}
 */
export function assessQuota({ chatKey, sendCfg = {}, minuteTimes = [], hourTimes = [], now = Date.now() } = {}) {
  const cfg = sendCfg || {};
  const maxMin = resolveMinuteLimit(chatKey, cfg);
  const maxHour = Number(cfg.maxPerHour) || 0;
  if (maxMin <= 0 && maxHour <= 0) {
    return { limit: 0, used: 0, remaining: Infinity, resetInMs: 0, unlimited: true, window: null };
  }
  const m = quotaFrom({ times: minuteTimes, limit: maxMin, windowMs: MINUTE_MS, now });
  const h = quotaFrom({ times: hourTimes, limit: maxHour, windowMs: HOUR_MS, now });
  // 更紧的赢：剩余少的优先；剩余相同则等得久的优先（否则会立刻再撞一次）。
  const pickHour = h.remaining < m.remaining
    || (h.remaining === m.remaining && h.resetInMs > m.resetInMs && h.remaining !== Infinity);
  if (pickHour && !h.unlimited) return { ...h, window: 'hour' };
  if (!m.unlimited) return { ...m, window: 'minute' };
  return { ...h, window: 'hour' };
}

/** 还要等多久说成人话（进日志与提示词用）。 */
export function describeQuotaWait(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (s <= 0) return '马上';
  if (s < 60) return `${Math.ceil(s)} 秒`;
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

/** 一条人话摘要，给日志/面板看。不限时返回空串（别拿"还剩 ∞ 条"刷屏）。 */
export function describeQuota(q) {
  if (!q || q.unlimited) return '';
  const unit = q.window === 'hour' ? '小时' : '分钟';
  if (q.remaining <= 0) return `这一${unit}已发满（${q.limit} 条），${describeQuotaWait(q.resetInMs)}后滑出窗口`;
  return `这一${unit}还能发 ${q.remaining} 条（上限 ${q.limit}）`;
}
