// 主动消息退避：**冷场越久，越不该一直试**。
//
// ── 为什么需要它（2026-10-29 第 2 轮对标，学自 MaiBot 的 idle_backoff 设计）──
// 以前的主动开话题只有两道闸：群安静够久（idleThresholdMs）+ 掷骰子过了（probability）。
// 问题在于"安静够久"是个**只会越来越真**的条件：没人说话的时间只会变长。
// 于是一个没人搭理的群，每 30~90 分钟就被投一次骰子，每次都可能烧掉一整轮的钱，
// 而结果永远是 noreply —— 它自己判断"没必要说话"，然后这件事被彻底忘掉。
//
// 面板上看不出这件事：noreply 是正常状态，和"她看过但决定不接"长得一模一样。
// 现状：本机 `data/config.json` 里 `proactive.enabled` 一直是 false，
// `data/sessions/` 里也找不到带「（主动机会）」标记的会话 —— 也就是说这套逻辑**还没在生产跑过**，
// 上面的浪费是设计推演，不是实测数字。等真开起来以后，用
// `proactiveBackoffSnapshot()` / `proactive-backoff` 的 skip 记录去核对。
//
// ── 三条纪律 ──────────────────────────────────────────────────────────────
// ① **只对连续失败计数**：这个群一旦有人说话（正常对话跑过一轮），计数立刻清零。
//    否则"越冷场越沉默"会滚成雪球，最后机器人对这个群永久闭嘴 —— 那是坏掉，不是收敛。
// ② **指数退避有上限**：连败 n 次 → 等 base * 2^(n-start)，封顶 cap。
//    目的是"别一直试"，不是"永不试"。群可能三天后才重新热起来。
// ③ **说过话先冷却**：主动开完话题、还没人接，就先别接着说。
//    这不是"少说话"，是"别对着沉默自言自语" —— 真人抛完话没人接，也不会隔半小时再抛一句。
//
// 注意 ③ 和 ① 的配合：`recordSent` **也**给连败 +1。
// 「我说了、没人接」和「我判断了、没说」对群里来说都是没反应，都该让下一次更晚。
// 区别只在等多久：说了 → 走 cooldown（短）；没说 → 走指数退避（长）。
//
// 纯逻辑：now 可注入，不 import config，不碰文件 —— 落盘由本文件底部的 load/save 负责，
// 这样测试不用等真时间，也不用清 data/。
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

const FILE = path.join(DATA_DIR, 'proactive-backoff.json');

/** 把一个可能是垃圾的输入收成非负整数。 */
function intOf(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 等多久说成人话（进日志用）。 */
export function describeWait(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

export class ProactiveBackoff {
  /**
   * @param {object} opts
   * @param {number} [opts.baseMs]        退避基准（默认 10 分钟）
   * @param {number} [opts.capMs]         退避上限（默认 6 小时）
   * @param {number} [opts.startCount]    连败几次开始退避（默认 2）
   * @param {number} [opts.cooldownMs]    主动说过话后的冷却（默认 30 分钟）
   * @param {Function} [opts.now]         可注入时钟
   * @param {object} [opts.state]         从磁盘读回来的状态（toJSON 的形状）
   */
  constructor({
    baseMs = 10 * 60 * 1000,
    capMs = 6 * 3600 * 1000,
    startCount = 2,
    cooldownMs = 30 * 60 * 1000,
    now = () => Date.now(),
    state = null,
  } = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.chats = new Map();
    this.configure({ baseMs, capMs, startCount, cooldownMs });
    if (state && typeof state === 'object') this.#hydrate(state);
  }

  /** 配置可以在运行期改（面板改了参数不必重启）。 */
  configure({ baseMs, capMs, startCount, cooldownMs } = {}) {
    this.baseMs = Math.max(0, Number(baseMs) || 0);
    const cap = Math.max(0, Number(capMs) || 0);
    // cap=0 是"关掉退避"的开关，不能被 max(base, cap) 悄悄救回来 —— 那会让
    // "我不想收敛"配成"按 base 封顶"，效果和预期完全不同。
    this.capMs = cap === 0 ? 0 : Math.max(this.baseMs, cap);
    this.startCount = Math.max(1, intOf(startCount, 2));
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    return this;
  }

  #hydrate(state) {
    const chats = state.chats && typeof state.chats === 'object' ? state.chats : {};
    const now = this.now();
    for (const [key, v] of Object.entries(chats)) {
      const chatKey = String(key || '').trim();
      if (!chatKey) continue;
      const until = Number(v?.until) || 0;
      // 过期太久的等待直接丢掉：重启后不该接着等一个三天前的退避
      if (until > 0 && until < now - this.capMs) continue;
      this.chats.set(chatKey, {
        streak: Math.max(0, Math.floor(Number(v?.streak) || 0)),
        until: Math.max(0, until),
        lastSentAt: Math.max(0, Number(v?.lastSentAt) || 0),
      });
    }
  }

  #entry(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) return null;
    let e = this.chats.get(key);
    if (!e) {
      e = { streak: 0, until: 0, lastSentAt: 0 };
      this.chats.set(key, e);
    }
    return e;
  }

  /** 连败 n 次该等多久；n 小于起点时是 0（还没到该收敛的时候）。 */
  waitFor(streak) {
    const n = Math.max(0, Math.floor(Number(streak) || 0));
    if (this.baseMs <= 0 || this.capMs <= 0) return 0;
    if (n < this.startCount) return 0;
    // 2^30 早就超过任何 cap 了；不夹一下的话大数会算出 Infinity
    const exp = Math.min(30, n - this.startCount);
    return Math.min(this.capMs, this.baseMs * (2 ** exp));
  }

  /** 冷却截止时间（说过话才有）。 */
  #cooldownUntil(e) {
    if (!this.cooldownMs || !e.lastSentAt) return 0;
    return e.lastSentAt + this.cooldownMs;
  }

  /**
   * 现在能不能对这个会话主动开口。
   * @param {string} chatKey
   * @returns {{skip:boolean, reason:string, waitMs:number, streak:number, kind:string}}
   *          kind: 'none' | 'backoff' | 'cooldown'
   */
  check(chatKey) {
    const e = this.#entry(chatKey);
    if (!e) return { skip: true, reason: '会话键为空', waitMs: 0, streak: 0, kind: 'none' };
    const now = this.now();
    const streak = e.streak;
    const until = Math.max(e.until, this.#cooldownUntil(e));
    if (until > now) {
      const byCooldown = until === this.#cooldownUntil(e) && e.until <= now;
      return {
        skip: true,
        kind: byCooldown ? 'cooldown' : 'backoff',
        reason: byCooldown
          ? '上次主动开的话题还没人接，先别再抛'
          : `连续 ${streak} 次主动都没人接，退避中`,
        waitMs: until - now,
        streak,
      };
    }
    return { skip: false, reason: '', waitMs: 0, streak, kind: 'none' };
  }

  /** 记一次"主动了，但没人接"（模型自己决定不说）。 */
  recordDeclined(chatKey) {
    const e = this.#entry(chatKey);
    if (!e) return { streak: 0, waitMs: 0, until: 0 };
    e.streak += 1;
    const waitMs = this.waitFor(e.streak);
    e.until = waitMs > 0 ? this.now() + waitMs : 0;
    return { streak: e.streak, waitMs, until: e.until };
  }

  /**
   * 记一次"主动说了话"。
   * 连败照样 +1 —— 说了没人接，和没说一样是没反应；只是等得短（走 cooldown，不走指数）。
   */
  recordSent(chatKey) {
    const e = this.#entry(chatKey);
    if (!e) return { streak: 0, waitMs: 0 };
    e.streak += 1;
    e.until = 0;
    e.lastSentAt = this.now();
    return { streak: e.streak, waitMs: this.cooldownMs };
  }

  /**
   * 这个会话发生了**正常对话** → 连败清零（纪律①）。
   * @returns {boolean} 是否真的清掉了东西（调用方据此决定要不要落盘）
   */
  reset(chatKey) {
    const key = String(chatKey || '').trim();
    const e = this.chats.get(key);
    if (!e) return false;
    if (!e.streak && !e.until && !e.lastSentAt) return false;
    e.streak = 0;
    e.until = 0;
    e.lastSentAt = 0;
    return true;
  }

  /** 快照（控制台/排查用）。 */
  snapshot() {
    const now = this.now();
    return [...this.chats.entries()]
      .filter(([, e]) => e.streak > 0 || e.until > 0 || e.lastSentAt > 0)
      .map(([chatKey, e]) => ({
        chatKey,
        streak: e.streak,
        waitMs: Math.max(0, Math.max(e.until, this.#cooldownUntil(e)) - now),
        lastSentAt: e.lastSentAt,
      }));
  }

  /** 落盘形状。 */
  toJSON() {
    const chats = {};
    for (const [k, e] of this.chats) {
      if (!e.streak && !e.until && !e.lastSentAt) continue;
      chats[k] = { streak: e.streak, until: e.until, lastSentAt: e.lastSentAt };
    }
    return { chats, updatedAt: this.now() };
  }
}

// ── 落盘：和 ban-state.js 一样，失败绝不影响主流程 ────────────────────────

let singleton = null;

/**
 * 取全局实例（首次调用时从磁盘读）。
 * @param {object} [cfg] 面板里的 proactive 配置；每次调用都会应用，改参数不必重启
 */
export function getProactiveBackoff(cfg = {}) {
  if (!singleton) {
    singleton = new ProactiveBackoff({
      baseMs: cfg.backoffBaseMs,
      capMs: cfg.backoffCapMs,
      startCount: cfg.backoffStartCount,
      cooldownMs: cfg.cooldownMs,
      state: readJsonSafe(FILE, null),
    });
  } else {
    singleton.configure({
      baseMs: cfg.backoffBaseMs,
      capMs: cfg.backoffCapMs,
      startCount: cfg.backoffStartCount,
      cooldownMs: cfg.cooldownMs,
    });
  }
  return singleton;
}

/** 落盘（调用方在记录之后调；失败只警告，不抛）。 */
export function saveProactiveBackoff(inst = singleton) {
  if (!inst) return false;
  try {
    writeJsonAtomic(FILE, inst.toJSON());
    return true;
  } catch (error) {
    console.warn('[proactive-backoff] 落盘失败（不影响主流程）：', error?.message ?? error);
    return false;
  }
}

/** 测试用：丢掉全局实例。 */
export function resetProactiveBackoffForTest() {
  singleton = null;
}
