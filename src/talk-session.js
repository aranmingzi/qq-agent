// 连续对话状态机 —— 谁在跟我聊、聊到第几轮、什么时候算散场。
//
// ── 为什么需要它（学自 Estrella「拟人对话逻辑 v1.4.2」的 talk-session.js）──
// 现在每轮都是"无状态运行"：模型看到一批未读，回完就弃置会话。于是机器人
// 记不住"刚才那句话是接谁的话"，也分不清「同一个人接着说」和「第三个人插进来 @ 我」。
// 结果两种都错：
//   · 同一个人继续说 —— 又走一次概率闸门，五五开地装作没看见；
//   · 第三个人 @ 一句 —— 直接抢走整段对话的注意力，原先那个人被晾着。
//
// 这一层只做**记账**，不做判定（判定在 reply-gate.js）。这条边界是刻意的：
// Estrella 的注释里写过，旧实现把"判定"和"记账"揉成一份，`lastPartnerId` 一清空就全断。
//
// 字段：
//   partnerId    锚点用户 QQ（字符串）
//   partnerName  当时的显示名（只用于日志/排查，不参与判定）
//   turns        **已经发出的**回复轮数；第 MAX_TURNS 轮回完就软收尾
//   startedAt    这段对话第一次被回复的时间
//   lastBotAt    最后一次对锚点说话的发送完成时间（接话窗口的起点）
//   lastTextAt   锚点最后一次发**文字**的时间（表情宽限用）
//
// 落盘：data/talk-state.json（原子写）。重启后还能接着聊 —— 这是"像人"的一部分：
// 人不会因为重启就把刚才聊的人忘了。日志/测试可直接读文件核对。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'talk-state.json');

/** 一段连续对话最多几轮（第 12 轮回完就软收尾，防止无限黏着）。 */
export const TALK_MAX_TURNS = 12;

/** 文字后这么久内补的纯表情，视为"顺手补的"，不结束对话。 */
export const STICKER_GRACE_MS = 2500;

/** 默认接话窗口：她刚回过谁，谁在这段时间内继续说就直接接住。 */
export const DEFAULT_WINDOW_MS = 20 * 1000;

/** 超过这么久没动静的状态直接丢掉（重启后翻出来的陈年状态没有意义）。 */
const STALE_MS = 6 * 60 * 60 * 1000;

/** chatKey -> talk 对象。惰性加载，避免模块导入时碰磁盘（测试可注入）。 */
let state = null;
let lastWriteAt = 0;
let trailing = null;

function load() {
  if (state) return state;
  state = {};
  let raw = '';
  try {
    raw = fs.readFileSync(FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch {
    return state;   // 没有文件 = 干净启动
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return state; }   // 坏文件当没有，不因一次手滑全挂
  if (!parsed || typeof parsed !== 'object') return state;
  const now = Date.now();
  for (const [key, t] of Object.entries(parsed)) {
    if (!t || !t.partnerId) continue;
    const last = Number(t.lastBotAt) || 0;
    if (last && now - last > STALE_MS) continue;   // 陈年状态丢弃
    state[key] = {
      partnerId: String(t.partnerId),
      partnerName: String(t.partnerName || ''),
      turns: Math.max(0, Number(t.turns) || 0),
      startedAt: Number(t.startedAt) || last || now,
      lastBotAt: last || now,
      lastTextAt: Number(t.lastTextAt) || 0
    };
  }
  return state;
}

/** 原子落盘；300ms 内的连续写合并成一次（聊天高峰期不至于每条消息都碰磁盘）。 */
function persist() {
  if (!state) return;
  const now = Date.now();
  if (now - lastWriteAt < 300) {
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = null;
      writeNow();
    }, 320);
    if (typeof trailing.unref === 'function') trailing.unref();
    return;
  }
  writeNow();
}

function writeNow() {
  lastWriteAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state || {}, null, 1), 'utf8');
    try {
      fs.renameSync(tmp, FILE);
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      try { fs.rmSync(FILE, { force: true }); } catch { /* 再试一次 */ }
      fs.renameSync(tmp, FILE);
    }
  } catch { /* 状态落盘失败不影响聊天；内存里那份还在 */ }
}

/** 测试/退出前强制刷盘。 */
export function flushTalkState() {
  if (trailing) { clearTimeout(trailing); trailing = null; }
  writeNow();
}

/** 清空（仅测试用）。 */
export function resetTalkState() {
  state = {};
  flushTalkState();
}

/** 读当前连续对话；没有就返回 null。 */
export function talkOf(chatKey) {
  const all = load();
  const t = all[String(chatKey || '')];
  return t && t.partnerId ? t : null;
}

/**
 * 开始一段新对话。**在第一句回复真的发出去之后调用**，所以 turns 从 1 起算。
 */
export function startTalk(chatKey, { userId, name = '', now = Date.now() } = {}) {
  const key = String(chatKey || '');
  const id = String(userId ?? '').trim();
  if (!key || !id) return null;
  const t = {
    partnerId: id,
    partnerName: String(name || ''),
    turns: 1,
    startedAt: now,
    lastBotAt: now,
    // 触发那句本身就是文字：从它起算「文字后 2.5 秒」的宽限，
    // 这样"触发 → 她回 → 对方顺手补个表情"不会被当成收尾。
    lastTextAt: now
  };
  load()[key] = t;
  persist();
  return t;
}

/** 又回了锚点一条：轮数 +1，窗口从这一条重新计时。 */
export function extendTalk(chatKey, { now = Date.now() } = {}) {
  const t = talkOf(chatKey);
  if (!t) return null;
  t.turns = Math.max(0, Number(t.turns) || 0) + 1;
  t.lastBotAt = now;
  persist();
  return t;
}

/**
 * 只刷新窗口，不加轮数。
 * 用在「第三个人插话」之后：回了 C 一句，B 的 12 轮计数不变，但 B 重新获得完整窗口。
 */
export function refreshTalkWindow(chatKey, { now = Date.now() } = {}) {
  const t = talkOf(chatKey);
  if (!t) return null;
  t.lastBotAt = now;
  persist();
  return t;
}

/**
 * 记一笔"锚点刚发了文字"。只给表情宽限用：纯表情不刷新它，
 * 否则连发表情会无限续命。
 */
export function notePartnerText(chatKey, now = Date.now()) {
  const t = talkOf(chatKey);
  if (!t) return null;
  t.lastTextAt = now;
  persist();
  return t;
}

/**
 * 纯表情包要不要结束这段对话？
 * 开容忍：文字后 2.5 秒内补的表情 = 顺手发的，不结束；超过才算收尾。
 */
export function stickerEndsTalk(talk, { now = Date.now(), tolerant = true, graceMs = STICKER_GRACE_MS } = {}) {
  if (!tolerant) return true;
  if (!talk) return true;
  const lastTextAt = Number(talk.lastTextAt) || 0;
  if (!lastTextAt) return true;
  return now - lastTextAt > graceMs;
}

/** 结束当前对话（幂等）。 */
export function endTalk(chatKey) {
  const key = String(chatKey || '');
  const all = load();
  if (!all[key]) return;
  delete all[key];
  persist();
}

/**
 * 这一轮还接得上吗（纯计算，不写状态）。判定用，不是记账。
 * @returns {{active:boolean, partnerId:string, turns:number, leftMs:number, closing:boolean}}
 */
export function talkWindowOf(chatKey, { now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  const t = talkOf(chatKey);
  if (!t) return { active: false, partnerId: '', turns: 0, leftMs: 0, closing: false };
  const leftMs = Math.max(0, Number(windowMs) - (now - (Number(t.lastBotAt) || 0)));
  return {
    active: leftMs > 0,
    partnerId: t.partnerId,
    turns: Number(t.turns) || 0,
    leftMs,
    // 「下一条就是第 12 轮」= 这一轮该软收尾（不是已经收完）。
    closing: (Number(t.turns) || 0) >= TALK_MAX_TURNS - 1
  };
}

/**
 * 一轮回复发完之后的状态收口。**唯一调用点**是编排器。
 *
 * 入参刻意都是"已经发生过的事实"：
 *   sent        这一轮真的发出文字了吗（被出口闸门拦下 / 模型选择潜水 = false）
 *   ended       这一轮因为对方的图片/表情已经提前结束了吗
 *   closing     这是第 12 轮软收尾吗
 *   fromPartner 发言者是不是当前锚点
 *   hadTalk     这一轮开始时有没有连续对话（第三人插话时状态仍是 B 的）
 *
 * 规则四条：
 *   1. ended / closing → 结束；
 *   2. continuation → 锚点续一轮；
 *   3. named/keyword：
 *        - 有锚点且发言者是第三人 → 只刷新窗口，不换锚点、不加轮数；
 *        - 有锚点且就是锚点 → 续一轮；
 *        - 没锚点 → 当前发言者成为新锚点；
 *   4. 对锚点一个字都没发出去 → 结束。
 */
export function noteTalkReply(chatKey, {
  kind = '',
  userId = '',
  name = '',
  sent = false,
  ended = false,
  closing = false,
  fromPartner = false,
  hadTalk = false,
  now = Date.now()
} = {}) {
  if (ended || closing) {
    endTalk(chatKey);
    return null;
  }
  if (sent) {
    if (kind === 'continuation') return extendTalk(chatKey, { now });
    if (kind === 'named' || kind === 'keyword' || kind === 'private') {
      if (hadTalk && !fromPartner) return refreshTalkWindow(chatKey, { now });
      if (hadTalk) return extendTalk(chatKey, { now });
      return startTalk(chatKey, { userId, name, now });
    }
    return null;
  }
  if (fromPartner && (kind === 'continuation' || kind === 'named' || kind === 'keyword' || kind === 'private')) {
    endTalk(chatKey);
  }
  return null;
}
