// 禁言状态：被禁言的群不再白跑一轮（学自 TT 整合包 plugins/ban-state）。
//
// ── 为什么要单独记这件事 ──────────────────────────────────────────────────
// 被禁言的群里每来一条消息，机器人都会**完整跑一轮**：拼 17K 提示词、调模型、
// 拿到回复、发送失败（平台拒绝）。表现是"群里什么都没发生"，账上却实实在在
// 花掉了一整轮的钱 —— 这类漏在用量统计里看不出来，只能靠状态机避免。
//
// ── 两个来源，一个状态 ────────────────────────────────────────────────────
//   ① OneBot 的 `notice / group_ban`（最准，带 duration）
//   ② 发送失败的报错文案（兜底：NapCat 偶尔不推事件，但一定会报错）
// 两条都只认"被禁的是自己"（user_id === selfId），别人被禁言与我们无关。
//
// ⚠️ 只落盘"到什么时候解除"，不落盘"为什么被禁言"以外的推断 —— 误判会让它闭嘴，
//    所以宁可短（默认 10 分钟）也不要长，且发送成功时自动清掉。
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

const FILE = path.join(DATA_DIR, 'ban-state.json');
const DEFAULT_MS = 10 * 60 * 1000;

/** 读全表（顺手清掉已过期的）。 */
function readAll() {
  const raw = readJsonSafe(FILE, null);
  const map = raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object' ? raw.chats : {};
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!(Number(map[key]?.until) > now)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeAll(map);
  return map;
}

function writeAll(map) {
  try {
    writeJsonAtomic(FILE, { chats: map, updatedAt: Date.now() });
  } catch { /* 记账失败不影响主流程 */ }
}

/**
 * 记一次禁言。
 * @param {string} chatKey  'group:123456'
 * @param {object} opts
 * @param {number} [opts.durationSec] OneBot 给的剩余秒数；缺省/0 用默认 10 分钟
 * @param {string} [opts.reason]      人话原因（进日志）
 * @returns {{until:number, ms:number}}
 */
export function noteBan(chatKey, { durationSec = 0, reason = '' } = {}) {
  const key = String(chatKey || '').trim();
  if (!key) return { until: 0, ms: 0 };
  const sec = Number(durationSec) || 0;
  // duration 为 0 在 OneBot 里是"解除禁言"，不能当"无限期禁言"
  if (sec === 0 && String(reason).includes('lift')) return clearBan(key);
  const ms = sec > 0 ? Math.min(sec * 1000, 24 * 3600 * 1000) : DEFAULT_MS;
  const until = Date.now() + ms;
  const map = readAll();
  const prev = Number(map[key]?.until) || 0;
  map[key] = { until: Math.max(prev, until), reason: String(reason || '发送被拒绝').slice(0, 120), at: Date.now() };
  writeAll(map);
  return { until: map[key].until, ms };
}

/** 这个群现在是不是被禁言。 */
export function isBanned(chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return false;
  const entry = readAll()[key];
  return Number(entry?.until) > Date.now();
}

/** 解除（发送成功后调用：说明其实没被禁，之前的判断是误判）。 */
export function clearBan(chatKey) {
  const key = String(chatKey || '').trim();
  const map = readAll();
  if (!map[key]) return { until: 0, ms: 0 };
  delete map[key];
  writeAll(map);
  return { until: 0, ms: 0 };
}

/** 还剩多久（毫秒）；没被禁返回 0。 */
export function banRemainingMs(chatKey) {
  const entry = readAll()[String(chatKey || '').trim()];
  return Math.max(0, (Number(entry?.until) || 0) - Date.now());
}

/** 快照（控制台/排查用）。 */
export function banSnapshot() {
  const map = readAll();
  return Object.entries(map).map(([chatKey, v]) => ({
    chatKey,
    until: Number(v?.until) || 0,
    remainingSec: Math.max(0, Math.round(((Number(v?.until) || 0) - Date.now()) / 1000)),
    reason: v?.reason || ''
  }));
}

/**
 * 从发送失败的文案里认"被禁言"。
 * 只认明确措辞 —— 把网络超时误判成禁言会让它白白闭嘴十分钟。
 */
export function looksLikeMute(message) {
  const m = String(message || '');
  return /禁言|被禁|muted|mute[ds]?\b|shut[ _-]?up|not allowed to send|发言.{0,6}(限制|禁止)|禁发/i.test(m);
}
