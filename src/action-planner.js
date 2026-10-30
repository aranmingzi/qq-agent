// 受限动作集：把"这轮能做什么"从模型自由发挥，改成**先划范围、再让它选**。
//
// 为什么要有它（2026-10-22 生态调研的 P1-2）：
//   现在模型能调 send_message / send_sticker / send_poke / send_voice 等一堆工具，
//   但"这一轮到底允不允许发表情/拍人/发语音"全靠工具内部各自判断，
//   于是会出现"深夜拍人""刚被拒还在追着发语音"这种不合时宜的动作。
//
// 做法（学 MaiBot 的 ActionSet，但保持我们的确定性）：
//   ① 每轮先算出**允许集合**（带原因），写进提示词 —— 模型看得见边界；
//   ② 预算按轮算（不是按天），越界由工具侧拒绝；
//   ③ `wait_for_mention` 是显式状态：说了"等被叫"就真的安静，被 @/点名时自动解除。
//
// 纯函数 + 一个小状态文件，不依赖运行时。

import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from './config.js';

/** 取时间戳：0 是合法值（测试常用），只有空值/NaN 才回退到当前时间。 */
function timeOf(v) {
  if (v === null || v === undefined) return Date.now();
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.now();
}


export const ACTIONS = Object.freeze({
  REPLY: 'reply',
  REPLY_MULTI: 'reply_multi',
  STICKER: 'sticker',
  POKE: 'poke',
  VOICE: 'voice',
  WAIT_FOR_MENTION: 'wait_for_mention',
  SILENT: 'silent',
});

/** 每个档位允许的最大气泡数（与 prompt 里的分条纪律一致，略放宽一点）。 */
export const BUBBLE_BUDGET = Object.freeze({
  direct: 4,
  continuation: 3,
  named: 3,
  keyword: 2,
  interject: 2,
});

/** 深夜/凌晨不主动招惹人（与手势那边的 0–6 点纪律同源，这里放宽到 7 点）。 */
export function isQuietHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  return h >= 23 || h < 7;
}

/**
 * 算这一轮的动作集。
 * @param {object} p
 * @param {'group'|'private'} [p.kind]
 * @param {string} [p.tier]       reply-gate 给的档位
 * @param {number} [p.hour]       本地小时（0–23）
 * @param {number} [p.moodScore]  心情底色 0–100
 * @param {boolean} [p.hasSticker]
 * @param {boolean} [p.canVoice]
 * @param {number} [p.sendQuota]  这一轮**真实**还能发几条（-1/缺省 = 不限或未知）
 * @param {object} [p.sticker]    `orchestrator.stickerState()` 的结果：
 *                                `{canSend, kind:'ok'|'run'|'cooldown'|'minute'|'empty'|'off', reason, waitMs}`。
 *                                缺省视为"能发"，保持既有调用方的行为不变。
 * @returns {{allowed:Array<{name:string,label:string,reason:string}>, budgets:object, quiet:boolean, note:string}}
 */
export function planActions({
  kind = 'group',
  tier = 'direct',
  hour = new Date().getHours(),
  moodScore = 50,
  hasSticker = false,
  canVoice = false,
  sendQuota = -1,
  sticker = null,
  rng = Math.random,
} = {}) {
  const quiet = isQuietHour(hour);
  const allowed = [];
  const add = (name, label, reason) => allowed.push({ name, label, reason });

  add(ACTIONS.REPLY, '发一条文字', '任何情况都可以');
  // 2026-10-24 剃刀：上限恒定会把每轮节奏定死成"答满 N 条"（实测一半会话恰好 2 条，
  // "回答+俏皮话"成了机械节奏）。35% 概率少给一条，让 1/2/3 条都自然出现；
  // 测试传固定 rng 保持确定性。
  const base = BUBBLE_BUDGET[tier] ?? 2;
  const planned = Math.max(1, base - (rng() < 0.35 ? 1 : 0));
  // ── 额度上限压到真实值（2026-10-29 第 3 轮）──────────────────────────────
  // 以前这里只按档位给数（2~4 条），而发送侧真正允许的可能是 1 条 ——
  // 模型照着 4 条规划，第一条之后全部撞墙，然后再花一整轮补救。
  // 现在把 sender.quotaFor() 的真实剩余量传进来，两边同一个数。
  // 下限仍然是 1：额度为 0 的轮次在 wake() 里就被挡下了，走不到这里；
  // 万一中途变了，也让模型把**最要紧的那一句**说完，而不是规划 0 条后哑火。
  const quotaCapped = Number.isFinite(Number(sendQuota)) && Number(sendQuota) >= 0
    ? Math.max(1, Math.min(planned, Number(sendQuota)))
    : planned;
  const bubbles = quotaCapped;
  if (base >= 3 && bubbles >= 2) add(ACTIONS.REPLY_MULTI, `分条发（最多 ${bubbles} 条）`, `档位 ${tier} 允许分条`);
  add(ACTIONS.SILENT, '不说话直接结束', '群聊里这是正常选择，不算失败');

  // ── 表情能不能发（2026-10-29 第 4 轮）──────────────────────────────────
  // 以前这里只问"库里有图吗"（hasSticker），而真正拦她的是**会话冷却**和
  // **表情的分钟桶**（与文本桶分开，缺省 1 张/分钟）。实测 60 次调用失败 31 次
  // （51.7%），其中 30 次属于这两条 —— 全部能在调用前就知道。
  // 判定顺序与 send_sticker 的 execute 一致，理由措辞直接复用，避免两套说法。
  const stickerState = sticker && typeof sticker === 'object' ? sticker : null;
  const stickerOk = hasSticker && (!stickerState || stickerState.canSend !== false);
  const stickerBlocked = hasSticker && stickerState?.canSend === false;

  if (stickerOk) add(ACTIONS.STICKER, '发表情包', '表情库可用');
  if (kind === 'group' && !quiet && Number(moodScore) > 35) {
    add(ACTIONS.POKE, '拍一拍', quiet ? '深夜不主动' : '心情与时段都允许');
  }
  if (canVoice && !quiet) add(ACTIONS.VOICE, '发语音', '语音引擎可用且不在深夜');
  if (kind === 'group' && tier !== 'direct' && tier !== 'continuation') {
    add(ACTIONS.WAIT_FOR_MENTION, '暂时安静，等被点名再开口', '这轮不是非回不可');
  }

  const budgets = {
    bubbles,
    sticker: stickerOk ? 1 : 0,
    poke: (kind === 'group' && !quiet && Number(moodScore) > 35) ? 1 : 0,
    voice: (canVoice && !quiet) ? 1 : 0,
  };

  let note = '';
  if (quiet) note = '现在是深夜，不主动拍人、不发语音；除非被点名，否则少开口。';
  else if (budgets.poke === 0 && kind === 'group' && Number(moodScore) <= 35) note = '心情偏低，这轮别主动招惹人。';
  // 额度比档位更紧时明说：让它把话合并成一条说完，而不是先发个引子再撞墙。
  if (bubbles < planned) {
    note = (note ? `${note} ` : '')
      + `这一分钟只剩 ${bubbles} 条额度了，把话并成一条说完，别先发引子再补。`;
  }
  // 表情被挡时明说理由（冷却/额度/没图），别让她调一次撞墙再改口。
  if (stickerBlocked) {
    const why = String(stickerState.reason || '').trim() || '这轮发不了表情';
    note = (note ? `${note} ` : '') + `${why}，这轮用文字，别试图发表情。`;
  }

  return { allowed, budgets, quiet, note, tier, kind };
}

/** 动作是否在允许集合里（工具侧可用来兜底）。 */
export function isAllowed(plan, name) {
  return !!plan?.allowed?.some((a) => a.name === name);
}

// ── "等被叫"状态 ─────────────────────────────────────────────────────────

export const WAIT_DEFAULT_MS = 20 * 60 * 1000;
export const WAIT_MAX_MS = 60 * 60 * 1000;

export class MentionWait {
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.dir = dir || DATA_DIR;
    this.file = path.join(this.dir, 'mention-wait.json');
    this.now = typeof now === 'function' ? now : () => Date.now();
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch { return {}; }
  }

  #write(map) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(map, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`[mention-wait] 写状态失败（已忽略）：${e?.message ?? e}`);
    }
  }

  /** 设"等被叫"。ttlMs 会被夹在 1 分钟 – 60 分钟之间。 */
  set(chatKey, { ttlMs = WAIT_DEFAULT_MS, speakerId = '', note = '' } = {}) {
    const key = String(chatKey || '');
    if (!key) return null;
    const t = timeOf(this.now());
    const ttl = Math.min(WAIT_MAX_MS, Math.max(60 * 1000, Number(ttlMs) || WAIT_DEFAULT_MS));
    const map = this.#read();
    map[key] = { until: t + ttl, at: t, speakerId: String(speakerId || ''), note: String(note || '').slice(0, 120) };
    this.#write(map);
    return map[key];
  }

  /** 取有效的等待状态（过期的顺手清掉）。 */
  get(chatKey, now = null) {
    const key = String(chatKey || '');
    const map = this.#read();
    const it = map[key];
    if (!it) return null;
    const t = timeOf(now ?? this.now());
    if (Number(it.until) <= t) {
      delete map[key];
      this.#write(map);
      return null;
    }
    return { ...it, remainingMs: Number(it.until) - t };
  }

  clear(chatKey) {
    const key = String(chatKey || '');
    const map = this.#read();
    if (!map[key]) return false;
    delete map[key];
    this.#write(map);
    return true;
  }

  list(now = null) {
    const map = this.#read();
    const t = timeOf(now ?? this.now());
    return Object.entries(map)
      .filter(([, v]) => Number(v?.until) > t)
      .map(([chatKey, v]) => ({ chatKey, ...v, remainingMs: Number(v.until) - t }));
  }
}

let waitSingleton = null;
export function getMentionWait() {
  if (!waitSingleton) waitSingleton = new MentionWait();
  return waitSingleton;
}
