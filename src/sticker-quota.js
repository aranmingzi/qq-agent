// 表情发送的**前置**判定：这一轮到底能不能发表情，提前告诉模型。
//
// ── 为什么需要它（2026-10-29 第 4 轮对标，接着第 3 轮的文字额度做）──
// 第 3 轮把「文字还剩几条」提前告诉了模型（src/send-quota.js），但表情是**另一套桶**：
// 它有自己的分钟上限（sticker.maxPerMinute，缺省 1）和自己的会话冷却（sticker.cooldownMs）。
// 这两道闸门都只在 send_sticker 的 execute 里判 —— 模型得先调一次、撞墙、拿到错误，
// 再花一整轮改口。
//
// 实测（`data/sessions/` 1000 份会话，2026-10-29）：
//   · send_sticker 被调用 **60** 次，失败 **31** 次 = **51.7%**；
//   · 失败原因全部可提前预判：冷却中 **16**、这一分钟发满了 **14**、今天已发过 **1**；
//   · 「这一轮只调了 send_sticker 而且失败」的轮次共 **28** 个，合计约 **412,806**
//     prompt tokens —— 这些轮次什么都没发出去，还得再补一轮。
//
// 竞品的做法是把"能不能做"写进动作集（MaiBot 的 ActionSet 会在提示词里给出
// 本轮可用动作），而不是让模型去试错。我们已经有 action-planner 的动作集，
// 只是表情那一格一直只填 `hasSticker`（库里有没有图），没填"现在能不能发"。
//
// ── 边界 ──────────────────────────────────────────────────────────────────
// 纯函数：不读配置、不碰磁盘、不看时间以外的状态。判定所需的原始数据
// （自己最近的发言、表情桶时间戳、上限、冷却）全部由调用方传入。
// 这样测试可以用假时钟，也不会因为读 data/ 而互相污染。
//
// ⚠️ 与 send_sticker 的 execute 保持**同一套规则**，但**故意不管**「同一张图
// 今天/最近几天发过」这两条：那两条要扫全部会话的消息存档（listChats × 1000 条），
// 每轮都扫一遍不值当，而且只占 1/31 的失败。工具侧仍然照旧兜底。

export const STICKER_SCOPE_SUFFIX = '|sticker';

/**
 * 从自己最近的发言里找上一次发表情的时刻。
 *
 * 表情的发送记录就在消息存档里（self + `[表情包：…（id）]`），不需要额外状态文件。
 * 解析函数由调用方传入，避免本模块依赖 stickers.js（那边会拉 fs）。
 *
 * @param {Array<{self?:boolean, text?:string, ts?:number}>} ownRecent 自己最近的发言
 * @param {(text:string)=>string} parseId 从文本里解析表情 id（拿不到就返回空串）
 * @returns {{lastStickerAt:number, recentStickerIds:Set<string>}}
 */
export function scanOwnStickers(ownRecent = [], parseId = () => '') {
  const recentStickerIds = new Set();
  let lastStickerAt = 0;
  for (const m of Array.isArray(ownRecent) ? ownRecent : []) {
    if (!m || !m.self) continue;
    const id = parseId(m.text);
    if (!id) continue;
    recentStickerIds.add(id);
    lastStickerAt = Math.max(lastStickerAt, Number(m.ts) || 0);
  }
  return { lastStickerAt, recentStickerIds };
}

/**
 * 这一轮能不能发表情。
 *
 * 判定的顺序与 send_sticker 的 execute 完全一致（先本轮张数，再会话冷却，再分钟额度），
 * 因为**先撞哪道闸门决定了模型看到哪句理由** —— 顺序不一致就会出现
 * "提示词说冷却中、真发的时候报的是额度满"这种自相矛盾。
 *
 * @param {object} p
 * @param {number} [p.sentThisRun]   本轮已经发过几张表情
 * @param {number} [p.maxPerRun]     同一轮最多几张（缺省 1）
 * @param {number} [p.cooldownMs]    同一会话两次表情的最小间隔（0 = 不冷却）
 * @param {number} [p.lastStickerAt] 上一次发表情的时刻（0 = 没发过）
 * @param {number} [p.minuteLimit]   表情的每分钟上限（0 = 不限）
 * @param {number[]} [p.stickerTimes] 表情桶里的发送时间戳
 * @param {number} [p.now]
 * @returns {{canSend:boolean, kind:'ok'|'run'|'cooldown'|'minute', reason:string, waitMs:number, remaining:number}}
 */
export function assessSticker({
  sentThisRun = 0,
  maxPerRun = 1,
  cooldownMs = 0,
  lastStickerAt = 0,
  minuteLimit = 0,
  stickerTimes = [],
  now = Date.now()
} = {}) {
  const t = Number(now);
  const capRun = Math.max(1, Number(maxPerRun) || 1);
  const sent = Math.max(0, Number(sentThisRun) || 0);

  // 硬约束 1：同一轮最多几张。
  if (sent >= capRun) {
    return {
      canSend: false,
      kind: 'run',
      reason: `本轮已经发过 ${sent} 张表情了（一轮最多 ${capRun} 张）`,
      waitMs: 0,
      remaining: 0
    };
  }

  // 硬约束 2：同一会话的冷却。
  const cd = Math.max(0, Number(cooldownMs) || 0);
  const last = Number(lastStickerAt) || 0;
  if (cd > 0 && last > 0 && t - last < cd) {
    const waitMs = Math.max(0, cd - (t - last));
    return {
      canSend: false,
      kind: 'cooldown',
      reason: `刚发过表情，还要等 ${Math.max(1, Math.ceil(waitMs / 60000))} 分钟`,
      waitMs,
      remaining: 0
    };
  }

  // 硬约束 3：表情自己的分钟桶（与文本桶分开，见 sender 的 `|sticker` 后缀）。
  const limit = Number(minuteLimit) || 0;
  if (limit <= 0) {
    return { canSend: true, kind: 'ok', reason: '', waitMs: 0, remaining: Infinity };
  }
  const span = 60 * 1000;
  const ts = (Array.isArray(stickerTimes) ? stickerTimes : [])
    .map(Number)
    // 收垃圾：桶在内存里，出过一次脏数据就会让某个会话永久"发满了"。
    .filter((x) => Number.isFinite(x) && x <= t && t - x < span)
    .sort((a, b) => a - b);
  const used = ts.length;
  const remaining = Math.max(0, limit - used);
  if (remaining <= 0) {
    return {
      canSend: false,
      kind: 'minute',
      reason: `这一分钟的表情额度已满（${limit} 张）`,
      waitMs: Math.max(0, ts[0] + span - t),
      remaining: 0
    };
  }
  return { canSend: true, kind: 'ok', reason: '', waitMs: 0, remaining };
}

/** 一句话摘要，给日志/面板看。能发就返回空串（别拿"能发表情"刷屏）。 */
export function describeSticker(state) {
  if (!state || state.canSend) return '';
  if (state.kind === 'run') return state.reason;
  if (state.kind === 'cooldown') {
    return `${state.reason}（约 ${Math.max(1, Math.ceil((Number(state.waitMs) || 0) / 60000))} 分钟）`;
  }
  if (state.kind === 'minute') {
    const s = Math.max(0, Math.round((Number(state.waitMs) || 0) / 1000));
    return `${state.reason}，${s <= 0 ? '马上' : `${Math.ceil(s)} 秒`}后滑出窗口`;
  }
  return state.reason || '';
}
