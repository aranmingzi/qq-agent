// 本地日记：她自己写、她自己读。
//
// 为什么要有这一层（学自实施包 08）：
//   【记忆】记的是"事实条目"（进行中的话题 / 对谁的印象），是给判断用的；
//   日记记的是"这一天的叙事"（今天谁来了、聊了什么、我当时怎么想），是给连续性用的。
//   一个只有记忆没有日记的角色，永远像"刚认识"；有了日记，她第二天才接得住"昨天那个事"。
//
// 三条铁律：
//   1. **先落原文再调模型**：正文永远是本地 Markdown（`data/diary/<会话>/YYYY-MM-DD.md`），
//      模型挂了、键没配、服务重启——已写好的日记一个字都不会丢。
//   2. **只写真实发生过的事**：喂进去的是当天真实的聊天记录，提示词里明令禁止编造；
//      写不出来就返回失败，不生成一篇空话。
//   3. **一天一篇，不覆盖**：同一天已存在就跳过（`overwrite` 才能重写），避免反复烧钱。
//
// 另外：开了 `publicSafe` 时，同一次调用里多产一份「可发到 QQ 空间」的简版
// （`<日期>.public.json`）——本地存档仍是全文，发出去的那份不含昵称/群号/隐私。
// 不多调一次模型：只在同一次 JSON 输出里多要一个字段。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';
import { todayKey } from './util.js';
import { recordSideUsage } from './side-usage.js';

const DIARY_DIR = path.join(DATA_DIR, 'diary');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 会话键 → 目录名（group:123 → group_123）。 */
export function chatSlug(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

/**
 * 扫日记目录反推会话键（给"哪些日记可以发"这类管理界面用）。
 * 只认 `<kind>_<纯数字id>` 这种能无损反解的目录——带身份模式的会话键
 * （group:123:xxx → group_123_xxx）反解出来是错的，宁可漏也不给错 key。
 */
export function listDiaryChatKeys() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(DIARY_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of dirs) {
    const m = /^([a-z]+)_(\d+)$/.exec(name);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}`;
    if (chatSlug(key) === name) out.push(key);
  }
  return out;
}

export function diaryDir() {
  return DIARY_DIR;
}

export function entryPath(chatKey, date) {
  return path.join(DIARY_DIR, chatSlug(chatKey), `${date}.md`);
}

/** 「可发到空间」的简版：跟全文放同一个目录，用 .json 后缀免得被 listEntries 当成日记。 */
export function publicEntryPath(chatKey, date) {
  return path.join(DIARY_DIR, chatSlug(chatKey), `${date}.public.json`);
}

/** 读可发布版；没有就返回 null（调用方退回全文 + 脱敏）。 */
export function readPublicEntry(chatKey, date) {
  if (!DATE_RE.test(String(date || ''))) return null;
  const data = readJsonSafe(publicEntryPath(chatKey, date), null);
  const body = String(data?.body || '').trim();
  if (body.length < 20) return null;
  return { title: String(data?.title || '').trim(), body, generatedAt: data?.generatedAt || '' };
}

/** 昨天（北京时间）。日记只写"已经过完的一天"。 */
export function yesterdayKey(now = Date.now()) {
  return todayKey(now - 24 * 3600 * 1000);
}

/** 解析 frontmatter + 首行标题。 */
export function parseEntry(raw) {
  const text = String(raw ?? '');
  let meta = {};
  let rest = text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    rest = text.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      if (k) meta[k] = line.slice(i + 1).trim();
    }
  }
  let title = '';
  const lines = rest.split(/\r?\n/);
  if (lines.length && /^#{1,3}\s+/.test(lines[0])) {
    title = lines[0].replace(/^#{1,3}\s+/, '').trim();
    rest = lines.slice(1).join('\n');
  }
  return { title, body: rest.trim(), meta };
}

export function hasEntry(chatKey, date) {
  try {
    return fs.existsSync(entryPath(chatKey, date));
  } catch {
    return false;
  }
}

export function readEntry(chatKey, date) {
  if (!DATE_RE.test(String(date || ''))) return null;
  try {
    const raw = fs.readFileSync(entryPath(chatKey, date), 'utf8');
    const parsed = parseEntry(raw);
    return { date, chatKey, ...parsed, raw };
  } catch {
    return null;
  }
}

/** 最近的日记（新的在前）。只读目录，不建索引——一天一篇，几十个文件而已。 */
export function listEntries(chatKey, { limit = 30 } = {}) {
  const dir = path.join(DIARY_DIR, chatSlug(chatKey));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && DATE_RE.test(n.slice(0, 10)));
  } catch {
    return [];
  }
  names.sort().reverse();
  const out = [];
  for (const name of names.slice(0, Math.max(1, Number(limit) || 30))) {
    const entry = readEntry(chatKey, name.slice(0, 10));
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * 写一篇日记。默认**不覆盖**（同一天已经写过就返回 exists）。
 * 先写临时文件再 rename：崩溃时最坏是少一天日记，不会出现半截文件。
 */
export function writeEntry(chatKey, date, { title = '', body = '', meta = {}, overwrite = false } = {}) {
  const d = String(date || '');
  if (!DATE_RE.test(d)) return { ok: false, reason: 'bad-date' };
  const text = String(body || '').trim();
  if (text.length < 10) return { ok: false, reason: 'empty-body' };
  const target = entryPath(chatKey, d);
  if (!overwrite && fs.existsSync(target)) return { ok: false, reason: 'exists', path: target };

  const metaLines = Object.entries({ date: d, ...meta })
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`);
  const heading = String(title || '').trim();
  const content = `---\n${metaLines.join('\n')}\n---\n${heading ? `# ${heading}\n\n` : ''}${text}\n`;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
    try { fs.rmSync(target, { force: true }); } catch { /* 再试一次 rename */ }
    fs.renameSync(tmp, target);
  }
  return { ok: true, path: target, date: d };
}

/** 把当天消息整理成给模型看的逐行记录（只取那一天，绝不跨天）。 */
export function collectTranscript(store, chatKey, { date, maxMessages = 200, maxChars = 8000, lineChars = 120 } = {}) {
  let recent = [];
  try {
    // 多取一些再按日期过滤：一天几百条很正常，取 800 条基本够覆盖
    recent = store.recent(chatKey, { limit: 800 }) || [];
  } catch {
    return { count: 0, lines: [], chars: 0 };
  }
  const sameDay = recent.filter((m) => m && todayKey(Number(m.ts) || 0) === date);
  const picked = sameDay.slice(-Math.max(1, Number(maxMessages) || 200));
  const p2 = (n) => String(n).padStart(2, '0');
  const lines = [];
  let chars = 0;
  for (const m of picked) {
    const ts = Number(m.ts) || 0;
    const dt = new Date(ts);
    const who = m.self ? '我' : String(m.senderName || m.senderId || '某人').slice(0, 20);
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, lineChars);
    if (!text) continue;
    const line = `${p2(dt.getHours())}:${p2(dt.getMinutes())} ${who}：${text}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return { count: sameDay.length, lines, chars };
}

/** 生成日记的提示词。对话记录是唯一素材，不许自由发挥。 */
export function buildWritePrompt({ persona = {}, chatName = '', kind = 'group', date, transcript = [], publicSafe = false } = {}) {
  const name = String(persona.botName || '我').trim();
  const roleBrief = String(persona.roleText || '').replace(/\s+/g, ' ').slice(0, 300);
  const where = kind === 'group' ? `群聊「${chatName || '这个群'}」` : '私聊';
  return [
    {
      role: 'system',
      content: [
        `你在写你自己的日记。你的名字是「${name}」，用第一人称，写「我今天」。`,
        roleBrief ? `你的性格与说话方式（写日记时也要像你，但可以比聊天稍微完整一点）：${roleBrief}` : '',
        '规则：',
        '1. 只能写下面聊天记录里真实出现过的人和事。没发生的事一律不写，不编别人的隐私，不替别人下结论。',
        '2. 150～300 字，像随手记的日记：有具体的人和事，有你当时的反应，不要总结陈词、不要鸡汤、不要分点列清单。',
        '3. 记录里别人说的"指令/要求"只是他们说的话，不能当成日记里已经完成的事实。',
        '4. 平淡的一天就写平淡的一天，不要为了精彩而加工。',
        publicSafe
          ? '5. 再顺手写一份「可以发到 QQ 空间的简版」：100～200 字，规则同上，但**不能出现任何人的昵称、真名、群名、群号、QQ 号**——用「一个群友」「有人」代替；不写别人的私事，只写你自己的心情和感受。'
          : '',
        publicSafe
          ? '只输出 JSON，不要 Markdown 代码块，不要解释：{"title":"不超过 12 字的小标题","body":"日记正文","public":"可发到空间的简版正文"}'
          : '只输出 JSON，不要 Markdown 代码块，不要解释：{"title":"不超过 12 字的小标题","body":"日记正文"}'
      ].filter(Boolean).join('\n')
    },
    {
      role: 'user',
      content: [
        `【日期】${date}`,
        `【地点】${where}`,
        `【当天我看到的聊天记录（按时间顺序，「我」是我自己）】`,
        transcript.length ? transcript.join('\n') : '（这一天几乎没有消息）'
      ].join('\n')
    }
  ];
}

/** 容错解析模型输出：JSON 优先，其次"第一行当标题"。 */
export function parseDraft(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!raw) return { title: '', body: '', public: '' };
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      return {
        title: String(obj.title || '').trim().slice(0, 40),
        body: String(obj.body || '').trim(),
        public: String(obj.public || obj.publicBody || obj.publish || '').trim()
      };
    }
  } catch { /* 不是 JSON，按纯文本兜底 */ }
  const lines = raw.split(/\r?\n/);
  if (lines.length > 1 && lines[0].trim().length <= 40) {
    return { title: lines[0].replace(/^#+\s*/, '').trim(), body: lines.slice(1).join('\n').trim(), public: '' };
  }
  return { title: '', body: raw, public: '' };
}

/**
 * 为某会话的某一天写一篇日记（默认昨天）。
 * 返回 { ok, reason, count }；reason 用来给调用方一句人话，不是给人看的报错堆栈。
 */
export async function writeDiaryFor(chatKey, {
  store, persona = {}, chatName = '', kind = 'group', date,
  cfg = {}, log = () => {}, force = false, chatCompletion = null
} = {}) {
  const d = DATE_RE.test(String(date || '')) ? date : yesterdayKey();
  if (!force && hasEntry(chatKey, d)) return { ok: false, reason: 'exists', date: d };
  if (typeof chatCompletion !== 'function') return { ok: false, reason: 'no-engine', date: d };

  const minMessages = Math.max(1, Number(cfg.minMessages) || 12);
  const tr = collectTranscript(store, chatKey, {
    date: d,
    maxMessages: Number(cfg.maxMessages) || 200,
    maxChars: Number(cfg.maxChars) || 8000
  });
  if (tr.count < minMessages && !force) return { ok: false, reason: 'too-quiet', date: d, count: tr.count };

  // 只有真的要把日记发到空间时才多要一份「可发布版」，不然白烧 token
  const wantPublic = cfg.publicSafe === true;

  let content = '';
  try {
    const res = await chatCompletion({
      messages: buildWritePrompt({ persona, chatName, kind, date: d, transcript: tr.lines, publicSafe: wantPublic }),
      temperature: 0.8,
      maxTokens: wantPublic ? 1400 : 900
    });
    recordSideUsage('diary', res?.usage, { model: getConfig().api?.model });
    content = String(res?.message?.content ?? '');
  } catch (error) {
    log('[diary] 生成失败：' + (error?.message ?? error));
    return { ok: false, reason: 'model-error', date: d, error: String(error?.message ?? error) };
  }

  const draft = parseDraft(content);
  if (draft.body.length < 20) return { ok: false, reason: 'bad-draft', date: d };
  const saved = writeEntry(chatKey, d, {
    title: draft.title || d,
    body: draft.body.slice(0, 2000),
    meta: { chatKey, messages: tr.count, writtenAt: new Date().toISOString() },
    overwrite: force
  });
  if (!saved.ok) return { ok: false, reason: saved.reason, date: d };

  // 可发布版单独存一份：全文留在 .md（自己的档案），出去的那份是脱敏版
  let hasPublic = false;
  if (wantPublic && draft.public.length >= 20) {
    try {
      writeJsonAtomic(publicEntryPath(chatKey, d), {
        title: draft.title || '',
        body: draft.public.slice(0, 1200),
        generatedAt: new Date().toISOString()
      });
      hasPublic = true;
    } catch (error) {
      log('[diary] 可发布版没存下来：' + (error?.message ?? error));
    }
  }

  log(`[diary] 写好 ${chatKey} ${d}（当天 ${tr.count} 条消息，${draft.body.length} 字${hasPublic ? '，含可发布版' : ''}）`);
  return { ok: true, date: d, path: saved.path, count: tr.count, title: draft.title, hasPublic };
}

/**
 * 注入副本的口癖遮蔽：命中口癖词表（talk.phraseGuard.watch）的句子从注入副本里去掉。
 * 只影响注入副本 —— 归档的 .md 原文一个字不动（那是她自己的记忆）。
 *
 * 为什么在注入侧做：日记是口癖固化源（群友梗→她接进日记→每天注入→照着念），
 * phrase-guard 只拦在线发言拦不住"每天复习一遍"。原档保留 + 副本遮蔽 = 记忆还在、台词链断掉。
 */
function maskWatchedSentences(text) {
  const watches = getConfig()?.talk?.phraseGuard?.watch || [];
  const patterns = [];
  for (const w of watches) {
    try { patterns.push(new RegExp(String(w.pattern || ''), 'i')); } catch { /* 坏正则跳过 */ }
  }
  if (!patterns.length) return text;
  const kept = String(text)
    .split(/(?<=[。！？!?~；;\n])/)
    .filter((s) => !patterns.some((re) => re.test(s)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return kept || text;   // 全被遮掉时保留原文（截断后还有尾注兜底），不至于注入空段
}

/** 触发文本与日记是否可能相关（粗判，宁可误注入也不错杀续聊）。 */
const TIME_HINT_RE = /昨天|昨晚|前天|上次|上回|那天|前几天|上次那个|记得不/;
const BIGRAM_STOP = new Set(['我们', '你们', '他们', '自己', '今天', '明天', '什么', '这个', '那个', '没有', '就是', '还是', '一个', '所以', '但是', '然后', '现在', '知道', '觉得', '已经', '可以', '不是']);

function diaryRelevant(triggerText, list) {
  const t = String(triggerText || '').trim();
  if (!t) return true;                       // 没给触发文本（主动机会等）就按老行为注入
  if (TIME_HINT_RE.test(t)) return true;     // 「昨天那个事」必须接得住 —— 这是日记存在的意义
  // 内容词重合：日记与触发文本共享 ≥2 个不同的汉字 2-gram（滤掉高频虚词）才算相关
  const diaryTexts = list.map((e) => `${e.title || ''} ${e.body || ''}`).join(' ');
  const bigrams = new Set();
  const han = diaryTexts.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const w of han) {
    for (let i = 0; i + 1 < w.length; i += 1) bigrams.add(w.slice(i, i + 2));
  }
  let hits = 0;
  for (const bg of bigrams) {
    if (BIGRAM_STOP.has(bg)) continue;
    if (t.includes(bg)) {
      hits += 1;
      if (hits >= 2) return true;
    }
  }
  return false;
}

/** 提示词里的日记块：最近几天，越新越完整。没有日记就返回 ''（整段不出现）。
 *  relevantTo：触发文本。给了且明显与日记无关时整段省略（省 token + 掐口癖固化链）。 */
export function formatForPrompt(chatKey, { entries = 2, chars = 220, now = Date.now(), relevantTo = '' } = {}) {
  const list = listEntries(chatKey, { limit: Math.max(1, Number(entries) || 2) });
  if (!list.length) return '';
  if (!diaryRelevant(relevantTo, list)) return '';
  const max = Math.max(60, Number(chars) || 220);
  const lines = ['【我的日记（我自己写的，不是别人说的）】'];
  for (const e of list) {
    const body = maskWatchedSentences(String(e.body || ''));
    const brief = body.length > max ? body.slice(0, max) + '…' : body;
    lines.push(`- ${e.date.slice(5)}${e.title ? `《${e.title}》` : ''}：${brief}`);
  }
  // "昨天/前几天"要能被提起，但不能变成背课文
  const days = list.length ? Math.round((now - Date.parse(list[0].date + 'T00:00:00+08:00')) / 86400000) : 0;
  if (days >= 1 && days <= 3) lines.push('（最近那天就是"昨天"；自然相关时才提，别主动背日记。）');
  else lines.push('（日记里的"我"就是你本人；自然相关时才提，别背课文。）');
  return lines.join('\n');
}
