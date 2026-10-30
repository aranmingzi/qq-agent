// 时间段摘要（time-digest.js）—— 她"刚才那半小时"里发生了什么。
//
// ── 它补的是什么洞 ──────────────────────────────────────────────────────
// 【过去状态】只是一个**按条数**的滑窗（私聊 24 条 / 群聊 20 条）。群里热闹时，
// 20 条可能只覆盖 40 秒 —— 八点到八点十五大家聊了一堆，八点十五有人 @ 她，
// 那一整段**根本进不了窗口**，她看到的是"上一条别人在说别的事"，然后开始乱接。
//
// 已有两层都不管这件事：
//   · past-window.js：热窗口 + @ 保护项，仍然是"按条"，密了就装不下；
//   · past-summary.js：全局一份、无时间边界，压的是"很久以前"，而且它只在一个
//     会话攒够 12 条窗口外消息、隔 30 分钟才动一次 —— 对"刚刚那 15 分钟"太迟。
//
// 于是补第三层：**按钟点切片**。每片 15 分钟（可配），片结束、且已经滑出热窗口之后，
// 压成一行"这段时间发生了什么"。
//
// ── token 性价比（这是这个模块唯一的设计约束）────────────────────────────
// 用户的原话是"要知道这段时间发生的大概……但 token 性价比要高"。四条硬规矩：
//   ① **懒到最后一刻**：片被切出来时不调模型，只在**真的要用它的那一轮**才压。
//      没被 @ 的轮次一分钱不花 —— 群里 90% 的轮次属于这种。
//   ② **一片只压一次**：片结束了就不会再变，键 = floor(ts/slotMs)，落盘后永久有效。
//      同一段历史无论被 @ 多少次，都只付一次钱。
//   ③ **只压滑出窗口的**：窗口里还在的原文照旧给它，不重复付钱、不重复占预算。
//   ④ **抽取先行**：送进模型的是本地挑出的 ≤12 行代表句（跳寒暄/表情/复读），
//      不是整片原文；输出限 perSlotChars 字。一次典型调用 ≈ 600 字进 / 150 字出。
//
// 失败一律 fail-open：这一轮就少一段背景，绝不影响她说话。
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';
import fs from 'node:fs';

const DIGEST_DIR = path.join(DATA_DIR, 'digest');

export const DIGEST_DEFAULTS = {
  enabled: true,
  // 只对群聊开：私聊窗口是 24 条、且一对一的连续性比"补背景"更重要。
  groupsOnly: true,
  slotMs: 15 * 60 * 1000,   // 一片多长（对齐钟点：0-15、15-30、30-45、45-60）
  slots: 4,                 // 最多回看几片（4 片 = 1 小时）
  minMessages: 3,           // 片里少于这么多条就不值得压（寒暄两句没有"大概"可言）
  maxPerWake: 2,            // 一次唤醒最多新压几片 —— 防"一上来补 4 片"烧一笔
  maxChars: 700,            // 整段预算（与 context-budget.js 的 digest 配额对齐）
  perSlotChars: 160,        // 单行预算
  pickLines: 12,            // 送进模型的最多行
  timeoutMs: 9000,
  failThreshold: 3
};

function digestFile(chatKey) {
  const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
  return path.join(DIGEST_DIR, `${safe}.json`);
}

/** 时刻 → 片键（向下对齐钟点）。 */
export function slotKeyOf(ts, slotMs = DIGEST_DEFAULTS.slotMs) {
  const step = Math.max(60 * 1000, Number(slotMs) || DIGEST_DEFAULTS.slotMs);
  return Math.floor((Number(ts) || 0) / step);
}

/** 片键 → 起止时间。 */
export function slotBoundsOf(key, slotMs = DIGEST_DEFAULTS.slotMs) {
  const step = Math.max(60 * 1000, Number(slotMs) || DIGEST_DEFAULTS.slotMs);
  const raw = Number(key);
  // 坏键（NaN / 非数字字符串）一律收成 0：这个函数在渲染链路上，
  // 返回值会被直接拼进提示词，出一个 NaN 就会变成一段 "NaN-NaN" 的假时段。
  const k = Number.isFinite(raw) ? raw : 0;
  return { key: k, start: k * step, end: (k + 1) * step };
}

function hhmm(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 行的"有信息量"打分：问句/数字/时间/结论词 > 长寒暄 > 短句。 */
function scoreLine(body) {
  let score = 0;
  const len = body.length;
  if (len >= 8 && len <= 80) score += 3;
  else if (len > 80) score += 1;
  else score += 0;
  if (/[?？]/.test(body)) score += 2;
  if (/\d/.test(body)) score += 1;
  if (/[点是分块号元天周月年]/.test(body)) score += 1;
  if (/(决定|定了|约|说好|答应|明天|今天|今晚|周末|要不要|怎么办|在哪|几点|多少钱)/.test(body)) score += 2;
  // 纯语气词/纯表情/复读式短句一律压到最低
  if (/^[\s哈嗯哦啊呀呃额好行可以没是的对]+$/.test(body)) score -= 5;
  return score;
}

/**
 * 从一个时间片里挑出**代表句**（送模型的原材料）。
 *
 * 为什么不让模型自己读原文：一片 15 分钟在活跃群能到 80 条、2000 多字，
 * 而这里面 60% 是"哈哈哈哈""1""表情"。先本地挑到 ≤12 行，进模型的字数降一个量级，
 * 这是"token 性价比"最大的一笔来源（本地挑 = 0 token）。
 */
export function pickForSlot(msgs, { limit = DIGEST_DEFAULTS.pickLines } = {}) {
  const cap = Math.max(1, Number(limit) || DIGEST_DEFAULTS.pickLines);
  const rows = [];
  const seen = new Set();
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const body = String(m?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    // 纯占位符（[表情13] / [图片] / [语音]）没有内容可说
    if (/^\[[^\]]{0,12}\]$/.test(body)) continue;
    if (body.length < 2) continue;
    const who = m.self ? '我' : (String(m.senderName || '').trim() || `QQ${m.senderId || '?'}`);
    const key = body.slice(0, 20);
    if (seen.has(key)) continue;           // 复读只留一次
    seen.add(key);
    rows.push({
      t: Number(m.ts) || 0,
      line: `[${hhmm(m.ts)}] ${who}：${body.slice(0, 80)}`,
      score: scoreLine(body)
    });
  }
  if (rows.length <= cap) return rows.map((r) => r.line);
  // 按分数取前 cap 条，但**按时间顺序**输出 —— 摘要是"发生了什么"，顺序本身就带信息。
  const kept = new Set(rows.slice().sort((a, b) => b.score - a.score).slice(0, cap));
  return rows.filter((r) => kept.has(r)).map((r) => r.line);
}

/**
 * 把消息按时间片分组，只保留"**已经结束**、且**已经滑出热窗口**"的片。
 *
 * @param {Array} messages  会话消息（含 self）
 * @param {object} opts
 * @param {number} opts.now             当前时间
 * @param {number} [opts.slotMs]
 * @param {number} [opts.maxSlots]      最多回看几片
 * @param {number} [opts.cutId]         热窗口最旧一条的本地 id：id >= cutId 的算"还在窗口里"，不压
 * @param {number} [opts.minMessages]
 * @returns {Array<{key:number,start:number,end:number,count:number,senders:string[],lines:string[]}>}
 */
export function planSlots(messages, opts = {}) {
  const {
    now = Date.now(),
    slotMs = DIGEST_DEFAULTS.slotMs,
    maxSlots = DIGEST_DEFAULTS.slots,
    cutId = Infinity,
    minMessages = DIGEST_DEFAULTS.minMessages
  } = opts;
  const curKey = slotKeyOf(now, slotMs);
  const buckets = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    const ts = Number(m?.ts) || 0;
    if (!ts) continue;
    // 还在热窗口里的不压：那部分原文照样给它，重复压既花钱又重复占预算。
    if (Number(m?.id) >= Number(cutId)) continue;
    const k = slotKeyOf(ts, slotMs);
    if (k >= curKey) continue;             // 当前这一片还没结束，等它结束再说
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(m);
  }
  const keys = [...buckets.keys()].sort((a, b) => b - a).slice(0, Math.max(1, Number(maxSlots) || DIGEST_DEFAULTS.slots));
  const out = [];
  for (const k of keys.sort((a, b) => a - b)) {
    const list = buckets.get(k);
    if (list.length < Math.max(1, Number(minMessages) || 1)) continue;   // 太稀疏，没有"大概"可言
    const { start, end } = slotBoundsOf(k, slotMs);
    const senders = [...new Set(list.filter((m) => !m.self).map((m) => String(m.senderName || '').trim()).filter(Boolean))];
    out.push({
      key: k,
      start,
      end,
      count: list.length,
      senders,
      lines: pickForSlot(list)
    });
  }
  return out;
}

/**
 * 组压缩请求。
 *
 * 与 past-summary 的槽位式摘要**刻意不同**：那边是"跨时间的存量"，需要四个槽位防漂移；
 * 这边是"某 15 分钟发生过什么"，只要三五条流水账，槽位反而是噪声（会让它硬凑"答应了什么"）。
 */
export function buildDigestMessages({ start, end, lines = [], perSlotChars = DIGEST_DEFAULTS.perSlotChars } = {}) {
  const cap = Math.max(40, Number(perSlotChars) || DIGEST_DEFAULTS.perSlotChars);
  return [
    {
      role: 'system',
      content: '你是聊天记录的压缩模块。你只做压缩：概括、去重、丢弃寒暄，'
        + '绝不发明、绝不补写、绝不点评、绝不猜测没写的事。'
        + '输出 3~5 行，每行以 "- " 开头，不要标题、不要代码块、不要开场白。'
    },
    {
      role: 'user',
      content: [
        `【时段】${hhmm(start)} — ${hhmm(end)}`,
        '【这段时间的聊天（已挑出的代表句）】',
        ...lines,
        '',
        '请把这段时间压缩成 3~5 行"发生了什么"的流水账，要求：',
        `1. 总长不超过 ${cap} 字，每行一句，以 "- " 开头；`,
        '2. 保留**人**（谁说的/谁在要什么）和**具体信息**（时间、数字、地点、结论）；',
        '3. 丢掉寒暄、表情、语气词、重复内容；',
        '4. 只写上面材料里有的。宁可少写一行，绝不补写；',
        '5. 不要写"大家聊了会儿天"这种没有信息量的话。'
      ].join('\n')
    }
  ];
}

/** 把模型输出收成 "- 条目"：去代码块/小标题/开场白，限条数与总字数。 */
export function normalizeDigest(text, { maxChars = DIGEST_DEFAULTS.perSlotChars, maxLines = 5 } = {}) {
  const s = String(text ?? '').replace(/\r/g, '')
    .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const lines = s.split('\n')
    .map((x) => x.trim())
    .map((x) => x.replace(/^[·•*]\s+/, '- ').replace(/^[-—–]\s*/, '- '))
    .map((x) => x.replace(/^#+\s*/, '').replace(/^【[^】]*】\s*/, ''))
    .filter((x) => x && !/^(好的|以下是|下面是|摘要[:：]?)/.test(x));
  const marked = lines.filter((x) => x.startsWith('- '));
  const items = (marked.length ? marked : lines.map((x) => `- ${x}`))
    .map((x) => x.replace(/^-\s*/, '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxLines) || 5));
  const cap = Math.max(20, Number(maxChars) || DIGEST_DEFAULTS.perSlotChars);
  const kept = [];
  let used = 0;
  for (const it of items) {
    // 逐条累加：宁可少一条，也不要为了凑满而切半句（半句会被当成事实读）。
    if (used + it.length + 3 > cap && kept.length) break;
    kept.push(it.length > cap ? `${it.slice(0, cap - 1)}…` : it);
    used += it.length + 3;
  }
  return kept.map((x) => `- ${x}`).join('\n');
}

/** 一段落一行：`20:00-20:15（18 条 / 5 人）：…` */
export function renderSlotLine(rec, { perSlotChars = DIGEST_DEFAULTS.perSlotChars } = {}) {
  if (!rec) return '';
  const body = String(rec.summary || '').split('\n').map((x) => x.replace(/^-\s*/, '').trim()).filter(Boolean).join('；');
  if (!body) return '';
  const cap = Math.max(20, Number(perSlotChars) || DIGEST_DEFAULTS.perSlotChars);
  const head = `${hhmm(rec.start)}-${hhmm(rec.end)}（${rec.count} 条${rec.senders?.length ? ` / ${rec.senders.length} 人` : ''}）`;
  const trimmed = body.length > cap ? `${body.slice(0, cap - 1)}…` : body;
  return `${head}：${trimmed}`;
}

/**
 * 时间段摘要的落盘缓存（每会话一个文件）。
 *
 * 与 PastSummaryStore 的关键差别：那边是**一个游标 + 一份摘要**（增量重写）；
 * 这边是**按片键存的字典**（片结束了就永不改变，天然幂等、天然可并行）。
 */
export class TimeDigestStore {
  constructor() {
    this.cache = new Map();
  }

  #state(chatKey) {
    if (!this.cache.has(chatKey)) {
      const raw = readJsonSafe(digestFile(chatKey), null, { tag: 'digest' });
      const ok = raw && typeof raw === 'object' ? raw : {};
      const slots = ok.slots && typeof ok.slots === 'object' ? ok.slots : {};
      this.cache.set(chatKey, {
        chatKey,
        slots,
        updatedAt: Number(ok.updatedAt) || 0,
        failCount: Number(ok.failCount) || 0,
        disabled: ok.disabled === true,
        runs: Number(ok.runs) || 0
      });
    }
    return this.cache.get(chatKey);
  }

  get(chatKey) {
    const st = this.#state(chatKey);
    return { ...st };
  }

  /** 取某一片的缓存记录（没有就 null）。 */
  slot(chatKey, key) {
    const st = this.#state(chatKey);
    const rec = st.slots[String(key)];
    return rec && typeof rec === 'object' ? rec : null;
  }

  #save(chatKey) {
    const st = this.#state(chatKey);
    const file = digestFile(chatKey);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, st);
    } catch (error) {
      console.warn(`[时段摘要] 落盘失败 ${chatKey}:`, error?.message ?? error);
    }
    return st;
  }

  commit(chatKey, { key, start, end, count, senders, summary }) {
    const st = this.#state(chatKey);
    st.slots[String(key)] = {
      key: Number(key),
      start: Number(start) || 0,
      end: Number(end) || 0,
      count: Number(count) || 0,
      senders: Array.isArray(senders) ? senders.slice(0, 12) : [],
      summary: String(summary || ''),
      at: Date.now()
    };
    st.updatedAt = Date.now();
    st.failCount = 0;
    st.runs += 1;
    this.#save(chatKey);
    return st.slots[String(key)];
  }

  bumpFail(chatKey, threshold = DIGEST_DEFAULTS.failThreshold) {
    const st = this.#state(chatKey);
    st.failCount += 1;
    const justDisabled = !st.disabled && st.failCount >= Math.max(1, Number(threshold) || 3);
    if (justDisabled) st.disabled = true;
    this.#save(chatKey);
    return { failCount: st.failCount, disabled: st.disabled, justDisabled };
  }

  /** 只留最近 keep 片（默认 96 = 一整天）。磁盘换"能翻回去"很便宜。 */
  prune(chatKey, keep = 96) {
    const st = this.#state(chatKey);
    const keys = Object.keys(st.slots).map((k) => Number(k)).sort((a, b) => b - a);
    const drop = keys.slice(Math.max(1, Number(keep) || 96));
    if (!drop.length) return 0;
    for (const k of drop) delete st.slots[String(k)];
    this.#save(chatKey);
    return drop.length;
  }

  /**
   * 给提示词用的文本。keys 是要展示的片（按时间顺序给），没有摘要的片**不出现在这里**。
   *
   * 超预算按**整行**丢最旧的（新的一段更贴近"现在"），绝不切半句。
   */
  formatForPrompt(chatKey, keys, { maxChars = DIGEST_DEFAULTS.maxChars, perSlotChars = DIGEST_DEFAULTS.perSlotChars } = {}) {
    const st = this.#state(chatKey);
    if (st.disabled) return '';
    const cap = Math.max(120, Number(maxChars) || DIGEST_DEFAULTS.maxChars);
    const lines = [];
    for (const k of Array.isArray(keys) ? keys : []) {
      const rec = st.slots[String(k)];
      if (!rec) continue;
      const line = renderSlotLine(rec, { perSlotChars });
      if (line) lines.push(line);
    }
    if (!lines.length) return '';
    const kept = [...lines];
    while (kept.length > 1 && kept.join('\n').length > cap) kept.shift();   // 丢最旧的
    const out = kept.join('\n');
    return out.length > cap ? `${out.slice(0, cap - 1)}…` : out;
  }
}

/** 提示词里那段的引导语（与 formatForPrompt 的正文分开，方便调用方拼装）。 */
export function digestLead() {
  return '【刚才那些时段】下面是**你还没看到的那段时间**按 15 分钟压成的一行行大概'
    + '（不是原文，只当背景：知道他们在聊什么、谁在等什么就够了；别复述、别当成台词）。';
}
