// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { normalizeFaceText } from './qq-face.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
// 归档目录（2026-10-26）：maxPerChat 裁剪前先落盘，否则"翻旧账"只能翻到最近 2000 条。
// 按天分片（<会话>/<YYYY-MM-DD>.jsonl），**只追加、不自动删** —— 一条聊天记录 200 字节，
// 10 个群一年约 200MB，用磁盘换"任何时候都能翻到去年那句原话"是划算的。
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

// 🔴 消息存档一律按「**基础会话键**」读写（2026-09-15 修）。
//
// 背景（用户报告"发图 agent 取不到"）：chatKey 有两种形态——
//   · 事件入库：'private:123456789'          （基础键，来自 OneBot 事件）
//   · 会话上下文：'private:123456789:tutor'   （带身份模式后缀）
// 旧实现把 chatKey 直接当文件名，于是**同一个人的消息被写进两个文件**：
//   private_123456789.json（有图）  vs  private_123456789_tutor.json（没图）
// 学习模式下 ctx.chatKey 带 ':tutor'，工具去查后者 → 报"当前会话找不到消息"，
// 图片/表情/历史一概取不到。
//
// 修法：抽一个 canonicalChatKey()，剥掉第三段身份模式后缀，保证读写同一个文件。
// 这样无论调用方传哪种形态，看到的都是同一份完整聊天记录。
export function canonicalChatKey(chatKey) {
  const s = String(chatKey || '');
  const parts = s.split(':');
  // group:123 / private:456            → 原样
  // group:123:tutor / private:456:tutor → 去掉第三段
  if (parts.length >= 3 && parts[0] && parts[1]) return `${parts[0]}:${parts[1]}`;
  return s;
}

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456（身份模式后缀已被剥掉）
  const safe = canonicalChatKey(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function archiveDirOf(chatKey) {
  const safe = canonicalChatKey(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(ARCHIVE_DIR, safe);
}

/** 本地日期键（归档按天分片用）。自己写这 4 行而不 import util，是为了不引入循环依赖。 */
function dateKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把调用方给的"边界"归一成数字，拿不到就用 fallback（= 该方向不设限）。
 *
 * ⚠️ 必须显式挡 `null` / `''` / `undefined`：`Number(null) === 0`、`Number('') === 0`，
 * 直接 `Number.isFinite(Number(x))` 会把"没传"当成"边界 = 0"，
 * 于是搜索永远返回空 —— 一个只在没传参数时才出现的空结果，最难查。
 */
function idBound(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function loadChat(chatKey) {
  try {
    let text = fs.readFileSync(chatFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) {
      // 老存档里 QQ 内置表情是「[表情182]」这种裸 id，人和模型都看不懂；
      // 读盘时统一规整成「[表情:笑哭]」（幂等）。这样控制台/存档、模型上下文一次全好，
      // 又不用去改写用户的历史文件。
      for (const m of parsed.messages) {
        if (typeof m?.text === 'string') m.text = normalizeFaceText(m.text);
      }
      return parsed;
    }
  } catch { /* 新会话 */ }
  return { chatKey, nextLocalId: 1, messages: [] };
}

function saveChat(state) {
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  const tmp = `${chatFile(state.chatKey)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  const target = chatFile(state.chatKey);
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
    // Windows 杀毒/索引器可能短暂占用目标文件；删除后重命名可避免偶发丢写。
    try { fs.rmSync(target, { force: true }); } catch { /* 下一行会给出真实错误 */ }
    fs.renameSync(tmp, target);
  }
}

export class ChatStore {
  /** 归档失败只喊一次（否则每条消息都刷一行日志）。 */
  #archiveWarned = false;

  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.archiveEnabled = true;
    this.chats = new Map(); // chatKey -> state
  }

  /** 关掉归档（极少用：只有"这块盘不能写"或测试里要验旧行为时才关）。 */
  setArchiveEnabled(on) {
    this.archiveEnabled = on !== false;
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    // 统一归一到基础键：这样 'private:x:tutor' 与 'private:x' 命中同一份内存态与磁盘文件，
    // 学习模式下也能看到完整聊天记录（含图片）。详见文件头 canonicalChatKey 的说明。
    const key = canonicalChatKey(chatKey);
    if (!this.chats.has(key)) this.chats.set(key, loadChat(key));
    return this.chats.get(key);
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /**
   * 追加一条收到的消息（未读）。返回写入的条目。
   *
   * atSelf / atOthers / reply 是**寻址三件套**（addressee.js 要读）：
   * 这条消息是 @ 谁、引用了谁的话。以前 reply 的默认值是 null 而入站从没传过，
   * 于是「引用我的话」这条唤醒判据一直是死代码，模型侧也永远看不到引用了谁。
   * 老条目没有这三个字段 = undefined，addressee.js 会退到文本兜底，不会误判。
   */
  appendIncoming(chatKey, {
    mid, ts, senderId, senderName, text,
    atSelf = false, atOthers = null, reply = null, media = []
  }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      atSelf: atSelf === true,
      atOthers: Array.isArray(atOthers) ? atOthers.map((x) => String(x ?? '').trim()).filter(Boolean) : [],
      reply: reply || null,
      media: Array.isArray(media) ? media : []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      atSelf: false,
      atOthers: [],
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /**
   * 只把某一条消息置为已读。
   * 用途：点歌指令（#点歌 …）由代码直接处理并回复，不该再让模型为它跑一轮；
   * 但同一会话里其它的未读消息必须保留，不能被 drainUnread 一起吞掉。
   */
  markRead(chatKey, mid) {
    if (mid === null || mid === undefined || String(mid).trim() === '') return false;
    const st = this.#state(chatKey);
    let changed = false;
    for (let i = st.messages.length - 1; i >= 0; i -= 1) {
      const m = st.messages[i];
      if (m.self) continue;
      if (String(m.mid) !== String(mid)) continue;
      if (!m.read) { m.read = true; changed = true; }
      break;
    }
    if (changed) saveChat(st);
    return changed;
  }

  /**
   * 未读快照：**只读，不消费**。
   *
   * 拆出这一步是为了让"看见"和"消费"变成两个动作（学自 Estrella-Bot `unread.js`）：
   *   · 判定要用快照（decideWake 看着某几条做决定）；
   *   · 消费只消费快照里那几条 —— 于是**快照之后新到的消息必然留下**。
   * 合成一个动作时，判定花掉的几百毫秒里到达的消息会被静默吞掉，
   * 表现是"它明明在线，却没回我那句" —— 这是最难复现的一类丢消息。
   */
  noteUnread(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self);
  }

  /** 当前未读的本地 id 列表（给日志/面板用，同样不消费）。 */
  unreadIds(chatKey) {
    return this.noteUnread(chatKey).map((m) => m.id);
  }

  /**
   * 单点消费：只把给定 id 标已读，返回**实际**消费的条数。
   *
   * 刻意只按本地 id 消费，不提供 `markAllRead` / `clearUnread` 这类入口 ——
   * 那种 API 一旦存在，早晚会有人在"顺手清理一下"的地方调它，
   * 而它的失败方式是静默的：消息没了，没人知道它们从没被看过。
   */
  consume(chatKey, ids) {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) return 0;
    const want = new Set(list.map((x) => Number(x)).filter((x) => Number.isFinite(x)));
    if (!want.size) return 0;
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (m.self || m.read) continue;
      if (!want.has(m.id)) continue;
      m.read = true;
      n += 1;
    }
    if (n) saveChat(st);
    return n;
  }

  /**
   * 快照并消费（运行开始时调用）。
   * 语义与老接口一致，但实现走"先取快照、再按 id 消费"——
   * 中间新到的消息不会被"全部置 true"顺手吃掉。
   */
  drainUnread(chatKey) {
    const snap = this.noteUnread(chatKey);
    if (snap.length) this.consume(chatKey, snap.map((m) => m.id));
    return snap;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 把"模型手里的那串 id"翻译成本地序号，**内存找不到就去归档找**。
   *
   * 为什么要跨到归档：翻页的锚点天然在边界上 —— 模型说"再往前，比 #xxx 更早"，
   * 那个 #xxx 往往正好是上一页最旧的一条，而它很可能已经被裁进归档了。
   * 只查内存的话，越翻越深就会在某一页突然"锚点不存在"，翻页直接断掉。
   *
   * ⚠️ **两套 id 会撞**：QQ 消息 id（`mid`，可以很小，也可以是负数）和本地序号（`id`，1 起递增）
   * 都是纯数字，同一串数字可能同时命中两条**不同的**消息。真机翻页实测过：
   * 第 2 页和第 1 页重复了 3 条，就是因为上一页回传的是本地序号 `4598`，
   * 而库里真有一条 mid=4598 的、更新的消息，被优先匹配上了。
   * 所以这里支持显式前缀 `mid:` / `id:`（`nextBefore` 一律带前缀回传），
   * 裸数字（老调用方 / 模型手抄的 `#123`）才走"先 mid 后 id"的猜测。
   *
   * @returns {{id:number, mid:any, ts:number, where:'memory'|'archive'}|null}
   */
  findAnywhere(chatKey, token) {
    let raw = String(token ?? '').trim();
    let mode = '';
    const prefixed = /^(mid|id)\s*[:：]\s*(.+)$/i.exec(raw);
    if (prefixed) {
      mode = prefixed[1].toLowerCase();
      raw = prefixed[2].trim();
    } else if (raw.startsWith('#')) {
      mode = 'mid';
      raw = raw.slice(1).trim();
    }
    if (!raw) return null;
    const st = this.#state(chatKey);
    const pick = (m) => ({ id: m.id, mid: m.mid, ts: m.ts });
    const byMid = st.messages.find((m) => m.mid !== null && m.mid !== undefined && String(m.mid) === raw);
    if (mode !== 'id' && byMid) return { ...pick(byMid), where: 'memory' };
    if (mode !== 'mid' && /^\d+$/.test(raw)) {
      const byId = st.messages.find((m) => Number(m.id) === Number(raw));
      if (byId) return { ...pick(byId), where: 'memory' };
    }
    return this.#findInArchive(chatKey, raw, mode);
  }

  /** 归档里从新到旧找一条（只读，命中即返回，不把整个文件读进内存表）。 */
  #findInArchive(chatKey, token, mode = '') {
    const dir = archiveDirOf(chatKey);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    } catch {
      return null;
    }
    const numeric = /^\d+$/.test(token);
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const rows = text.split('\n');
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const line = rows[i].trim();
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        const midHit = m?.mid !== null && m?.mid !== undefined && String(m.mid) === token;
        const idHit = numeric && Number(m?.id) === Number(token);
        const ok = mode === 'mid' ? midHit : (mode === 'id' ? idHit : (midHit || idHit));
        if (!ok) continue;
        return { id: Number(m.id), mid: m.mid, ts: m.ts, where: 'archive' };
      }
    }
    return null;
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  /**
   * 关键词搜索本会话存档（学自实施包 06：老资料按关键词回查，而不是整段塞回上下文）。
   * 多个关键词用空格分隔，**全部命中**才算（AND）；新的在前。
   * 只在当前会话里搜，绝不跨会话/跨人——"别人说过什么"和"这个群说过什么"是两件事。
   */
  /**
   * 关键词搜索。`beforeId` / `afterId` 是**本地序号**（`m.id`，同会话内递增）的**开区间**，
   * 用来"再往前翻一页"：模型手里只有 QQ 消息 id（`mid`），调用方先用 `findAnywhere()`
   * 把它翻译成 `id`，再从这里传进来 —— 不在这一层做字符串匹配，避免每轮扫全表。
   *
   * 为什么按 `id` 而不是按 `ts`：同一毫秒里可以有好几条（群友连发、机器人一次发多段），
   * 按时间戳做开区间会**同时**吞掉或漏掉同毫秒的那几条，翻页时表现为"少了一条"。
   */
  search(chatKey, { keyword = '', limit = 20, sender = '', maxScan = 0, beforeId = null, afterId = null } = {}) {
    const st = this.#state(chatKey);
    const words = String(keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const who = String(sender || '').trim().toLowerCase();
    const hi = idBound(beforeId, Infinity);
    const lo = idBound(afterId, -Infinity);
    const cap = Math.max(1, Number(maxScan) || st.messages.length);
    const start = Math.max(0, st.messages.length - cap);
    const max = Math.max(1, Math.min(50, Number(limit) || 20));
    const out = [];
    for (let i = st.messages.length - 1; i >= start; i -= 1) {
      const m = st.messages[i];
      if (hi !== Infinity || lo !== -Infinity) {
        const lid = Number(m.id);
        if (!Number.isFinite(lid) || lid >= hi || lid <= lo) continue;
      }
      const lower = String(m.text || '').toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;
      if (who) {
        const name = (m.self ? '我' : String(m.senderName || '')).toLowerCase();
        if (!name.includes(who) && String(m.senderId || '') !== who) continue;
      }
      out.push(m);
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 裁掉最旧的（maxPerChat）。**裁之前先归档**（2026-10-26 修）。
   *
   * 以前这里直接 `splice(0, n)`：2000 条以外的消息永久消失，于是
   * `search_messages` 号称"搜整份存档"，实际只搜得动一周 ——
   * 「上周说的那个链接」根本不在库里，模型只能说没印象（听起来像失忆，其实是没存）。
   */
  #trim(st) {
    if (!this.maxPerChat || st.messages.length <= this.maxPerChat) return;
    const overflow = st.messages.length - this.maxPerChat;
    const gone = st.messages.splice(0, overflow);
    this.#archive(st.chatKey, gone);
  }

  /**
   * 把被裁掉的消息追加到按天分片的 JSONL（`data/archive/<会话>/<YYYY-MM-DD>.jsonl`）。
   *
   * 为什么是 JSONL 而不是再一个 JSON：追加写不用重写整份文件，几十 MB 也不会卡；
   * 坏一行只坏一条，不像 JSON 数组那样整份报废。
   * 失败只算"这次没归档"，绝不阻塞聊天 —— 所以吞错误，且只喊一次（防刷日志）。
   */
  #archive(chatKey, items) {
    if (this.archiveEnabled === false) return 0;
    const list0 = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list0.length) return 0;
    const buckets = new Map();
    for (const m of list0) {
      const k = dateKeyOf(m?.ts);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(m);
    }
    let wrote = 0;
    try {
      const dir = archiveDirOf(chatKey);
      fs.mkdirSync(dir, { recursive: true });
      for (const [date, list] of buckets) {
        const file = path.join(dir, `${date}.jsonl`);
        fs.appendFileSync(file, `${list.map((m) => JSON.stringify(m)).join('\n')}\n`, 'utf8');
        wrote += list.length;
      }
    } catch (error) {
      if (!this.#archiveWarned) {
        this.#archiveWarned = true;
        console.warn('[store] 归档失败（消息仍会被裁，只是翻不回来了）:', error?.message ?? error);
      }
    }
    return wrote;
  }

  /**
   * 在归档里搜（内存里没有时回落用）。**只读，不载入内存** ——
   * 归档可能几十 MB，为了搜一句话把它全读进 Map 不值得。
   * @returns {Array} 命中的消息（新的在前），每条带 `archived: 'YYYY-MM-DD'`
   */
  searchArchive(chatKey, { keyword = '', sender = '', limit = 20, days = 0, beforeId = null, afterId = null } = {}) {
    const words = String(keyword || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hi = idBound(beforeId, Infinity);
    const lo = idBound(afterId, -Infinity);
    const dir = archiveDirOf(chatKey);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    } catch {
      return [];   // 还没归档过
    }
    const span = Number(days) || 0;
    if (span > 0) {
      const floor = dateKeyOf(Date.now() - span * 86400000);
      files = files.filter((f) => f.slice(0, 10) >= floor);
    }
    const who = String(sender || '').trim().toLowerCase();
    const max = Math.max(1, Math.min(50, Number(limit) || 20));
    const out = [];
    const seen = new Set();
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const rows = text.split('\n');
      // 同一个文件里新的在后 → 从尾部往前扫
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const line = rows[i].trim();
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (hi !== Infinity || lo !== -Infinity) {
          const lid = Number(m?.id);
          if (!Number.isFinite(lid) || lid >= hi || lid <= lo) continue;
        }
        const lower = String(m?.text || '').toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;
        if (who) {
          const name = (m.self ? '我' : String(m.senderName || '')).toLowerCase();
          if (!name.includes(who) && String(m.senderId || '') !== who) continue;
        }
        const dedup = `${m.mid ?? ''}|${m.ts}|${m.text}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        out.push({ ...m, archived: f.slice(0, 10) });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  /** 归档概览（控制台/排查用）：多少天、多少字节、最早到哪一天。 */
  archiveStats(chatKey) {
    const dir = archiveDirOf(chatKey);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { /* 无归档 */ }
    let bytes = 0;
    for (const f of files) {
      try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* 文件可能刚被删 */ }
    }
    return { days: files.length, bytes, oldest: files[0]?.slice(0, 10) || '', newest: files.at(-1)?.slice(0, 10) || '' };
  }
}
