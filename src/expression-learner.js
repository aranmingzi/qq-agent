// 表达学习：从群里学"怎么说"，但**永远不直接改变行为**。
//
// 为什么要有它（2026-10-22 生态调研的 P1-3）：
//   拟人感最便宜的一块不是人格设定，是语感 —— 群里反复出现的口头禅、缩写、梗。
//   以前完全没学（README 里"黑话学习：暂未移植"）。
//
// 红线（沿用群梗那套已经验证过的两级库）：
//   ① 学到的只能进 **候选库**（data/expressions-pending.json），候选**永不进提示词**；
//   ② 人确认后才进正式库（data/expressions.json），正式库只作为"语感参考"注入，
//      不是指令、不是必须使用；
//   ③ 会**衰减**：15 天不出现权重趋近 0，≤0.01 直接淘汰 —— 不然库里会堆满过气梗。
//
// 不调模型：靠"重复出现"这个信号就够，零 token 成本。

import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

/** 取时间戳：0 是合法值（测试常用），只有空值/NaN 才回退到当前时间。 */
function timeOf(v) {
  if (v === null || v === undefined) return Date.now();
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.now();
}


export const EXPRESSION_MIN_LEN = 2;
export const EXPRESSION_MAX_LEN = 14;
/** 二次衰减窗口（天）。 */
export const DECAY_DAYS = 15;
/** 低于这个权重直接淘汰。 */
export const DECAY_FLOOR = 0.01;
export const PENDING_MAX = 200;
export const LIBRARY_MAX = 200;

/** 纯语气词 / 数字 / 标点：学了也没用。 */
const NOISE_RE = /^(哈+|呵+|嘿+|嘻+|嗯+|哦+|噢+|喔+|啊+|诶+|唉+|哎+|草+|靠+|乐|6+|牛+|强|1+|233+|awsl|\d+|[?？!！。.,，、~～…]+)$/i;

function clean(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[[^\]]{1,14}\]/g, ' ')     // [图片] [表情:笑哭] [语音]
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

/** 值得学的一句话（纯函数，测试直接断言）。 */
export function isLearnable(text) {
  const t = clean(text);
  if (t.length < EXPRESSION_MIN_LEN || t.length > EXPRESSION_MAX_LEN) return false;
  if (NOISE_RE.test(t)) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;   // 只学中文表达，英文缩写风险太大
  if (/[?？]$/.test(t)) return false;             // 问句是内容，不是语感
  return true;
}

export function expressionId(text) {
  return crypto.createHash('sha1').update(clean(text)).digest('hex').slice(0, 12);
}

/**
 * 从一批消息里找候选：同一个表达出现 ≥2 次才算。
 * @param {Array} entries store 条目（{text, self, senderId, ts}）
 * @returns {Array<{text,count,senders:string[],firstSeen,lastSeen}>}
 */
export function extractCandidates(entries, { minCount = 2 } = {}) {
  const map = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const text = clean(e.text);
    if (!isLearnable(text)) continue;
    const key = text;
    const cur = map.get(key) || { text, count: 0, senders: new Set(), firstSeen: 0, lastSeen: 0 };
    cur.count += 1;
    if (e.senderId) cur.senders.add(String(e.senderId));
    const ts = Number(e.ts) || 0;
    if (ts) {
      if (!cur.firstSeen || ts < cur.firstSeen) cur.firstSeen = ts;
      if (ts > cur.lastSeen) cur.lastSeen = ts;
    }
    map.set(key, cur);
  }
  return [...map.values()]
    .filter((c) => c.count >= Math.max(2, Number(minCount) || 2))
    .map((c) => ({ ...c, senders: [...c.senders] }))
    .sort((a, b) => b.count - a.count);
}

/** 二次衰减权重：15 天线性归零，得到的值再与 count 相乘。 */
export function decayWeight(item, now = Date.now()) {
  const count = Number(item?.count) || 0;
  const last = Number(item?.lastSeen) || Number(item?.promotedAt) || 0;
  if (!count) return 0;
  if (!last) return count;
  const days = Math.max(0, (now - last) / (24 * 60 * 60 * 1000));
  const factor = Math.max(0, 1 - days / DECAY_DAYS);
  return count * factor * factor;
}

export class ExpressionLearner {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] 数据目录（默认 <DATA_DIR>）
   * @param {Function} [opts.now]
   */
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.dir = dir || DATA_DIR;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.pendingFile = path.join(this.dir, 'expressions-pending.json');
    this.libraryFile = path.join(this.dir, 'expressions.json');
  }

  #read(file) {
    const raw = readJsonSafe(file, null, { tag: 'expressions' });
    const items = Array.isArray(raw?.items) ? raw.items.filter((x) => x && x.text) : [];
    return { version: 1, items };
  }

  #write(file, data) {
    writeJsonAtomic(file, { version: 1, items: data.items.slice(0, LIBRARY_MAX) });
  }

  pendingList() {
    return this.#read(this.pendingFile).items
      .map((x) => ({ ...x, weight: decayWeight(x, this.now()) }))
      .sort((a, b) => b.weight - a.weight);
  }

  libraryList() {
    return this.#read(this.libraryFile).items
      .map((x) => ({ ...x, weight: decayWeight(x, this.now()) }))
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * 观察一批消息。只写候选库；已在正式库里的表达只累加计数（不再进候选）。
   */
  observe(chatKey, entries, { minCount = 2 } = {}) {
    const now = timeOf(this.now());
    const found = extractCandidates(entries, { minCount });
    if (!found.length) return { learned: 0, updated: 0 };

    const lib = this.#read(this.libraryFile);
    const libById = new Map(lib.items.map((x) => [x.id, x]));
    const pending = this.#read(this.pendingFile);
    const pendById = new Map(pending.items.map((x) => [x.id, x]));

    let learned = 0;
    let updated = 0;
    for (const c of found) {
      const id = expressionId(c.text);
      const promoted = libById.get(id);
      if (promoted) {
        promoted.count = (Number(promoted.count) || 0) + 1;
        promoted.lastSeen = now;
        updated += 1;
        continue;
      }
      const cur = pendById.get(id);
      if (cur) {
        cur.count = (Number(cur.count) || 0) + 1;
        cur.lastSeen = now;
        cur.chatKeys = [...new Set([...(cur.chatKeys || []), String(chatKey)])].slice(0, 20);
        updated += 1;
      } else {
        pendById.set(id, {
          id,
          text: c.text,
          count: c.count,
          firstSeen: c.firstSeen || now,
          lastSeen: c.lastSeen || now,
          chatKeys: [String(chatKey)],
          senders: c.senders.slice(0, 8),
        });
        learned += 1;
      }
    }

    // 候选库按权重截断（不会无限涨）
    const pendItems = [...pendById.values()]
      .sort((a, b) => decayWeight(b, now) - decayWeight(a, now))
      .slice(0, PENDING_MAX);
    this.#write(this.pendingFile, { items: pendItems });
    this.#write(this.libraryFile, lib);
    return { learned, updated, candidates: found.length };
  }

  promote(id, { by = 'manual' } = {}) {
    const target = String(id || '');
    const pending = this.#read(this.pendingFile);
    const idx = pending.items.findIndex((x) => x.id === target);
    if (idx < 0) return { ok: false, reason: '候选库里没有这一条' };
    const [item] = pending.items.splice(idx, 1);
    const lib = this.#read(this.libraryFile);
    if (!lib.items.some((x) => x.id === item.id)) {
      lib.items.push({
        ...item,
        promotedAt: timeOf(this.now()),
        source: 'learned',
        promotedBy: String(by || 'manual'),
      });
    }
    // 正式库也做衰减淘汰，避免越攒越多
    lib.items = lib.items
      .map((x) => ({ ...x, weight: decayWeight(x, this.now()) }))
      .filter((x) => x.weight > DECAY_FLOOR)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, LIBRARY_MAX)
      .map(({ weight, ...rest }) => rest);   // weight 是派生值，不落盘
    this.#write(this.pendingFile, pending);
    this.#write(this.libraryFile, lib);
    return { ok: true, item };
  }

  reject(id) {
    const target = String(id || '');
    const pending = this.#read(this.pendingFile);
    const before = pending.items.length;
    pending.items = pending.items.filter((x) => x.id !== target);
    if (pending.items.length === before) return { ok: false, reason: '候选库里没有这一条' };
    this.#write(this.pendingFile, pending);
    return { ok: true };
  }

  /** 手动加一条（主人自己在控制台写）。 */
  add(text, { by = 'manual' } = {}) {
    const t = clean(text);
    if (!isLearnable(t)) return { ok: false, reason: `「${t}」不像一句可学的表达（2–14 字、中文、非问句）` };
    const id = expressionId(t);
    const lib = this.#read(this.libraryFile);
    if (lib.items.some((x) => x.id === id)) return { ok: false, reason: '已经有了' };
    const now = timeOf(this.now());
    lib.items.push({ id, text: t, count: 2, firstSeen: now, lastSeen: now, chatKeys: [], promotedAt: now, source: 'manual', promotedBy: String(by || 'manual') });
    this.#write(this.libraryFile, lib);
    return { ok: true, id, text: t };
  }

  /**
   * 给提示词挑几条（**只读正式库**）。
   * @param {string} chatKey
   * @param {object} opts { limit, exclude:Set<string> }
   */
  pick(chatKey, { limit = 3, exclude = null, now = null } = {}) {
    const t = timeOf(now ?? this.now());
    const ex = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);
    return this.libraryList()
      .filter((x) => !ex.has(x.text))
      .filter((x) => !x.chatKeys?.length || x.chatKeys.includes(String(chatKey)))
      .filter((x) => decayWeight(x, t) > DECAY_FLOOR)
      .slice(0, Math.max(1, Number(limit) || 3))
      .map((x) => ({ id: x.id, text: x.text, weight: Number(decayWeight(x, t).toFixed(2)) }));
  }

  /** 淘汰过气项（定时调用即可）。 */
  prune() {
    const now = timeOf(this.now());
    const lib = this.#read(this.libraryFile);
    const before = lib.items.length;
    lib.items = lib.items.filter((x) => decayWeight(x, now) > DECAY_FLOOR);
    const pending = this.#read(this.pendingFile);
    const beforeP = pending.items.length;
    pending.items = pending.items.filter((x) => decayWeight(x, now) > DECAY_FLOOR);
    if (lib.items.length !== before) this.#write(this.libraryFile, lib);
    if (pending.items.length !== beforeP) this.#write(this.pendingFile, pending);
    return { removed: (before - lib.items.length) + (beforeP - pending.items.length) };
  }

  stats() {
    return {
      pending: this.#read(this.pendingFile).items.length,
      library: this.#read(this.libraryFile).items.length,
    };
  }
}

/** 进程内单例（宿主各处共用一个，避免各读各的）。 */
let singleton = null;
export function getExpressions() {
  if (!singleton) singleton = new ExpressionLearner();
  return singleton;
}
