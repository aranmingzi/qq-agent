// 口头禅抑制 —— 「我最近是不是老说同一个东西」。
//
// ── 这个毛病是怎么长出来的（2026-10-24 实机复盘，别只看现象就改）────────────
// 用户反馈：她老把"给钱/不给钱"挂嘴上，越说越不像人。翻存档倒推出三条链子，
// 缺任何一条都不会长成这样：
//   ① 群友先玩梗：group_20000005 的「国见 玉喵」连着说"没码还想让我付钱"
//      "不付钱我继续戳"；group_20000001 的「我的拳头想喝血了」说"玩我也行你得付钱"。
//   ② 她接梗接得漂亮，于是这个梗被当成"人设的一部分"继续用
//      （"先转账五块 老规矩"、"想看先转账 十块一次"、"光笑不给钱啊"）。
//   ③ 最要命的一条：这些话被写进了**日记** ——
//      10-22《飞八分钱是爸坟前》"我开价三块，他报两块九毛九"、
//      10-23《饭盆阵型与一块钱门票》"一块钱一次，涨到两块还照拍"，
//      而日记**每天注入两篇**。于是她每天读到"我是个爱收钱的角色"，
//      越说越顺嘴 —— 这是个自增强闭环。
//
// 这也解释了一个反直觉的现象：提示词里早就写着"不连续堆砌梗、不每条复读同一个"，
// 却完全没用 —— **模型看不见自己说过几次**。软约束对"频率"这类信息天然失效，
// 必须由外部把频率量出来再喂回去。
//
// ── 判据为什么不是"关键词黑名单"──────────────────────────────────────
// 实测她的问题不是重复同一个词，而是**同一个梗换着说法反复用**：
//   "光笑不给钱啊" / "先打钱 一分都还没见着" / "红包呢" / "转账五块" / "十块一次"
// 词面全不同，语义全一样。所以按"语义簇"（可配正则）数**命中了多少条不同消息**，
// 而不是数关键词出现总次数 —— 一条消息里连说五遍和五条消息各说一遍，前者是情绪，
// 后者才是口癖。
//
// 另一路是通用复读检测（3-gram）：抓"哦豁""你们这"这类不管什么梗的机械重复。
// 阈值刻意比语义簇高，且排除语气词 —— "哈哈""？""草"是真人正常反应，不是口癖。
//
// ── 输出怎么用 ──────────────────────────────────────────────────────
// 渲染成一句"点名"，注入 user prompt（每轮变，不进 system，不破坏缓存）。
// 措辞刻意写成"别人早听腻了"而不是"禁止使用词汇"：前者是**像人**的理由，
// 后者是客服纪律 —— 而被客服纪律管住的角色，一眼就是 AI。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const PLACEHOLDER_RE = /\[[^\]]{1,40}\]/g;    // [图片] [表情:xx] [语音] [拍一拍] 这类占位符

// ── 屡犯记录（为什么需要持久化）──────────────────────────────────────────
// 光靠"最近 12 小时/30 条"的滑动窗口，有个致命缺口：她今天被提醒了就收敛，
// 窗口一滑过去，明天从零开始，于是隔三差五又能重新捡起同一个梗（"消停两天，第三天
// 又'先转账五块'"）。真人不会这样 —— 被朋友怼过一次"你怎么老说这个"，之后就永久
// 长记性了。所以这里把"被点名过的梗"存下来：
//   · 7 天内在册 → 阈值从 3 条降到 2 条（沾一下就被抓）
//   · 提示词措辞升级成"你已经因为这个被提醒过 N 次"
// 记录是**跨会话全局**的（按簇 id，不分群）：这正是她"这个人爱说钱"的属性，
// 跟长期事实按 QQ 存的道理一样 —— 换个群也一样爱说。
const MARK_TTL_MS = 7 * 24 * 3600 * 1000;
let marksCache = null;
let marksCacheAt = 0;

function marksFile() {
  return path.join(DATA_DIR, 'phrase-guard.json');
}

function readMarks(now) {
  if (marksCache && now - marksCacheAt < 60000) return marksCache;
  marksCacheAt = now;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(marksFile(), 'utf8')); } catch { parsed = null; }
  marksCache = (parsed && typeof parsed.marks === 'object' && parsed.marks) ? parsed.marks : {};
  return marksCache;
}

function writeMarks(marks) {
  marksCache = marks;
  marksCacheAt = Date.now();
  const file = marksFile();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, marks }, null, 1), 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      try { fs.rmSync(file, { force: true }); } catch { /* 再试一次 */ }
      fs.renameSync(tmp, file);
    }
  } catch { /* 记不下来不影响这一轮对话 */ }
}

/** 纯语气/口头反应：这些高频是真人，不是口癖。 */
const REACTION_WORDS = new Set([
  '哈哈哈', '哈哈哈哈', '嘿嘿嘿', '嘻嘻嘻', '呜呜呜', '啊啊啊',
  '不知道', '我觉得', '就是说', '这个嘛', '那个嘛', '是不是', '有没有',
  '怎么样', '什么都', '然后就', '真的啊', '不是吧', '我知道', '你们这'
]);

/** 正则编译带缓存：配置里 pattern 是字符串，每轮都 new RegExp 太浪费，写坏了也不能崩。 */
const reCache = new Map();
function compile(pattern) {
  const key = String(pattern || '');
  if (!key) return null;
  if (reCache.has(key)) return reCache.get(key);
  let re = null;
  try { re = new RegExp(key, 'u'); } catch { re = null; }   // 用户写坏正则 → 这一簇作废，不影响别的
  reCache.set(key, re);
  return re;
}

function plainOf(text) {
  return String(text ?? '')
    .replace(PLACEHOLDER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 一条消息里的中文 3-gram 集合（跨标点断开，避免把标点两侧的字拼成假词）。 */
function gramsOf(text, n = 3) {
  const out = new Set();
  const cleaned = plainOf(text).replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const seg of cleaned.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i + n <= seg.length; i += 1) out.add(seg.slice(i, i + n));
  }
  return out;
}

export const DEFAULT_WATCH = [
  {
    id: 'money',
    label: '讨钱/开价那一套（钱、转账、红包）',
    // 换皮的说法也要算："扫码""先付""给点""几个币" 都是同一个梗
    pattern: '(给|打|付|收|转|掏|发|要|掏|赚)钱|转账|红包|开价|收费|收钱|几个币|扫码|先付|五块|十块|一块钱|几毛'
  }
];

const DEFAULTS = {
  enabled: true,
  windowMessages: 30,     // 只看最近多少条自己的发言
  windowHours: 12,        // 且只算这么久之内的（昨天的话不算口癖）
  minCount: 3,            // 语义簇命中 >= 几条不同消息才提醒
  minRepeat: 4,           // 通用复读：同一个 3-gram 出现在 >= 几条不同消息
  watch: DEFAULT_WATCH
};

/**
 * 量出"她最近是不是在重复自己"。
 *
 * @param {Array<{text:string,self:boolean,ts:number}>} entries  本会话最近消息（store.recent 的形状）
 * @param {{config?:object, now?:number, chatKey?:string, persist?:boolean}} [opts]
 *   persist=false 时不读也不写屡犯记录（测试用，保证纯函数）。
 * @returns {{enabled:boolean, hits:Array, repeats:Array, text:string, checked:number}}
 */
export function detectPhraseAddiction(entries, { config = {}, now = Date.now(), chatKey = '', persist = true } = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const empty = { enabled: false, hits: [], repeats: [], text: '', checked: 0 };
  if (cfg.enabled === false) return empty;

  const windowMs = Math.max(1, Number(cfg.windowHours) || DEFAULTS.windowHours) * 3600000;
  const selfEntries = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.self && String(e.text || '').trim())
    .filter((e) => (Number(e.ts) || 0) >= Number(now) - windowMs)
    .slice(-Math.max(4, Number(cfg.windowMessages) || DEFAULTS.windowMessages));

  if (selfEntries.length < 4) return { ...empty, enabled: true, checked: selfEntries.length };

  const texts = selfEntries.map((e) => plainOf(e.text));
  const marks = persist ? readMarks(Number(now) || Date.now()) : {};

  // ── ① 语义簇：同一件事换着说法说 ──
  const watch = Array.isArray(cfg.watch) ? cfg.watch : DEFAULTS.watch;
  const baseMin = Math.max(2, Number(cfg.minCount) || DEFAULTS.minCount);
  const hits = [];
  for (const w of watch) {
    const re = compile(w?.pattern);
    if (!re) continue;
    const id = String(w.id || 'watch');
    const matchedEntries = selfEntries.filter((e) => re.test(plainOf(e.text)));
    const matched = matchedEntries.map((e) => plainOf(e.text));
    // 屡犯降阈：7 天内被点名过的梗，2 条就抓（而不是 3 条）。
    const mark = marks[id];
    const chronic = !!(mark && (Number(now) - (Number(mark.lastAt) || 0)) < MARK_TTL_MS);
    const need = chronic ? 2 : baseMin;
    if (matched.length >= need) {
      hits.push({
        id,
        label: String(w.label || id || '这个词'),
        count: matched.length,
        chronic,
        times: chronic ? Math.max(1, Number(mark.hits) || 1) : 0,
        samples: matched.slice(-3),
        // 同一批消息的签名（分钟桶）：连续多轮看到同一批历史时不重复记账，见下方记账块
        sig: `${matchedEntries.length}|${matchedEntries.map((e) => Math.floor((Number(e.ts) || 0) / 60000)).join(',')}`
      });
    }
  }

  // ── ② 通用复读：同一个 3-gram 出现在多条消息里 ──
  // 只统计**短消息**里的复读：长句里出现同一个三字组合多半是正常语言，
  // 而"哦豁""绝了""你们这"这种短句复读才是口癖。
  const minRepeat = Math.max(3, Number(cfg.minRepeat) || DEFAULTS.minRepeat);
  const owner = new Map();   // gram → Set(消息下标)
  texts.forEach((t, i) => {
    if (t.length > 14) return;
    for (const g of gramsOf(t)) {
      if (REACTION_WORDS.has(g)) continue;
      if (!owner.has(g)) owner.set(g, new Set());
      owner.get(g).add(i);
    }
  });
  const repeats = [...owner.entries()]
    .filter(([, set]) => set.size >= minRepeat)
    .map(([phrase, set]) => ({ phrase, count: set.size }))
    // 同样条数时，取更长（更具体）的那个，避免只报"你们这"这种半截词
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length)
    .slice(0, 2);

  // 记账：被点名的簇累加"屡犯次数"，供下次降阈和措辞升级用。
  // 2026-10-24 修复：以前每次检测命中都 +1 —— 12 小时窗口里同一批历史消息会被
  // 连续多轮重复记账，"屡犯 21 次"里绝大多数是同一批消息被数了 21 遍。
  // 现在按"命中的那批消息"的签名（条数+分钟桶时间戳）去重：同一批不涨，出现新消息才涨。
  if (persist && hits.length) {
    const next = { ...marks };
    let changed = false;
    for (const h of hits) {
      const prev = next[h.id] && typeof next[h.id] === 'object' ? next[h.id] : {};
      if (prev.sig === h.sig) continue;   // 同一批消息重复检测：不重复记账，也不续期 TTL
      next[h.id] = {
        hits: (Number(prev.hits) || 0) + 1,
        firstAt: Number(prev.firstAt) || Number(now),
        lastAt: Number(now),
        sig: h.sig,
        chatKeys: [...new Set([...(Array.isArray(prev.chatKeys) ? prev.chatKeys : []), chatKey].filter(Boolean))].slice(-5)
      };
      changed = true;
    }
    if (changed) writeMarks(next);
  }

  return {
    enabled: true,
    hits,
    repeats,
    text: renderPhraseGuard({ hits, repeats }, { checked: selfEntries.length }),
    checked: selfEntries.length
  };
}

/**
 * 渲染成提示词里的一句"点名"。
 * 空手（没毛病）时返回空串 —— 正常状态下这段不出现，不占预算也不污染语气。
 */
export function renderPhraseGuard({ hits = [], repeats = [] } = {}, { checked = 0 } = {}) {
  const lines = [];
  if (hits.length) {
    lines.push('【你最近的毛病 · 这轮别犯】');
    for (const h of hits) {
      lines.push(`- 最近 ${checked} 条发言里，你有 ${h.count} 条在说「${h.label}」。你自己都说顺嘴了，别人早听腻。`);
      if (h.chronic) {
        lines.push(`  这条你已经犯过 ${h.times} 次了（我提醒过你）。这次不是"换个说法"的问题 —— 是别再提。`);
      }
      lines.push('  这轮一个字都别再提这个；换个说法也不行（"扫码""先付""给点"这种换皮一样算）。要接话就接对方话里最具体的那一点。');
    }
  }
  if (repeats.length) {
    if (!lines.length) lines.push('【你最近的毛病 · 这轮别犯】');
    for (const r of repeats) {
      lines.push(`- 「${r.phrase}」这个说法你最近说了 ${r.count} 次了 —— 换个词，或者干脆把这句话省掉。`);
    }
  }
  if (!lines.length) return '';
  lines.push('真人不会每次开口都绕回同一个东西。这条比任何"要像人"的技巧都重要。');
  return lines.join('\n');
}
