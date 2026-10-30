// 群级记忆 —— "这个地方是哪儿、怎么说话不冒犯人"那一层（2026-10-26，P2-2）。
//
// ── 为什么不能只靠 facts + past-summary ─────────────────────────────────
// 现有的两样东西都答不了"这个群的脾气"：
//   · `memory-facts.js` 按 **QQ** 存，主语是"某个人"；群本身没有 QQ，也就没有位置。
//   · `past-summary.js` 是**滚动摘要**：每次重写、会被新事实覆盖，只回答"最近聊了什么"。
// 于是"这个群不许发广告""他们管叫兽叫兽兽""周五固定开黑"这类**稳定属性**，
// 每轮都得从聊天记录里重新猜 —— 猜错就是社死（在正经群玩梗 / 在玩梗群装正经）。
//
// 群级记忆回答的是三个问题：
//   ① 这个群是什么地方（氛围：正经/玩梗/潜水/技术）  → kind=vibe
//   ② 有什么不能做的（群规、禁忌话题）                → kind=rule
//   ③ 他们自己的说法（梗、黑话、称呼）                → kind=meme
//   ④ 长期的固定安排（周常、固定活动）                → kind=plan
//
// ── 三条纪律 ────────────────────────────────────────────────────────────
// ① **只记群本身，不记某个人的事**。群记忆是整个群都看得见的位置，
//    把"某人离婚了"写进去比记不住严重得多 —— 提示词与写入闸各挡一次。
// ② **按会话存**（`data/memory/groups/<group_123>.json`），没有"跨群群记忆"这种东西。
// ③ **rule 类永不因为权重低被淘汰**（跟 facts 的 kind=rule 同一条纪律）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonDetailed } from './json-store.js';
import { rankFactRecords, recallFactRecords } from './memory-facts.js';

const DIR = path.join(DATA_DIR, 'memory', 'groups');

/** 每个群最多留多少条（超了丢最弱的，rule 豁免）。 */
export const MAX_GROUP_FACTS = 40;

export const GROUP_KINDS = Object.freeze({
  VIBE: 'vibe',
  RULE: 'rule',
  MEME: 'meme',
  PLAN: 'plan'
});

/** 提示词里给模型看的四类说明（也是渲染时的顺序依据）。 */
const GROUP_KIND_HINT = Object.freeze({
  vibe: '这个群的气氛（正经/玩梗/潜水/技术流/夜猫子）',
  rule: '这个群的规矩与禁忌（能做什么、绝不能做什么）',
  meme: '群里自己的说法（梗、黑话、外号、称呼）',
  plan: '群里长期的固定安排（周常活动、固定时间）'
});

const cache = new Map();

function slug(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

/**
 * 会话键归一：`group:123:tutor` → `group:123`。
 *
 * ⚠️ 分包必须归一，否则**写得进去、读不出来**：
 * 反思层从 `store.listChats()` 拿的是**物理键**（group:123），
 * 而每轮注入时 orchestrator 传的是**有效键**（带人设后缀，用于"历史/记忆隔离"）。
 * 不归一的话，群记忆会写在 `group_123.json` 里，却在 `group_123_tutor` 里找 —— 永远读不到，
 * 而且不报错（表现为"这个群她什么都不知道"）。
 * 群记忆讲的是**这个群**，不是"某个群里的某个人设"，所以统一按物理键存。
 */
function canon(chatKey) {
  const parts = String(chatKey || '').split(':');
  if (parts.length >= 3 && parts[0] && parts[1]) return `${parts[0]}:${parts[1]}`;
  return String(chatKey || '');
}

function fileOf(chatKey) {
  const s = slug(chatKey);
  return s ? path.join(DIR, `${s}.json`) : '';
}

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function clip(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 不写进群记忆的内容：
 *   · 凭据（同 facts：宁可少记一条，也不让 key 躺在能被翻出来的文件里）
 *   · 个人隐私 —— 群记忆是"公开位置"，写进去等于把一个群的事端到台面上
 */
const CRED_RE = /sk-[A-Za-z0-9]{16,}|accessToken|apiKey\s*[:=]|Bearer\s|BEGIN [A-Z ]*PRIVATE KEY/i;
const PRIVATE_RE = /(离婚|出轨|分手|抑郁症|自杀|怀孕|堕胎|工资|月薪|年薪|身份证|手机号|住院|癌症|欠债|借了.*万)/;

function load(chatKey) {
  const key = canon(chatKey);
  if (!key) return { chatKey: '', facts: [] };
  if (cache.has(key)) return cache.get(key);
  const file = fileOf(key);
  let facts = [];
  if (file) {
    const { data: parsed } = readJsonDetailed(file, null, { tag: 'group-facts' });
    const list = Array.isArray(parsed?.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
    facts = list
      .filter((f) => f && f.text)
      .map((f) => ({
        id: String(f.id || newId()),
        text: clip(f.text),
        kind: Object.values(GROUP_KINDS).includes(String(f.kind)) ? String(f.kind) : GROUP_KINDS.VIBE,
        weight: Math.max(0, Math.min(2, Number(f.weight) || 1)),
        createdAt: Number(f.createdAt) || Date.now(),
        updatedAt: Number(f.updatedAt) || Number(f.createdAt) || Date.now()
      }));
  }
  const st = { chatKey: key, facts };
  cache.set(key, st);
  return st;
}

function save(st) {
  const file = fileOf(st.chatKey);
  if (!file) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ chatKey: st.chatKey, facts: st.facts }, null, 1), 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      try { fs.rmSync(file, { force: true }); } catch { /* 再试一次 */ }
      fs.renameSync(tmp, file);
    }
  } catch { /* 落盘失败不影响本轮对话 */ }
}

/**
 * 记一条群级事实。重复出现 = 强化（不是再存一条）。
 * @returns {{ok:boolean, record?:object, duplicate?:boolean, reason?:string, total?:number}}
 */
export function rememberGroupFact(chatKey, text, { kind = GROUP_KINDS.VIBE, weight = 1, now = Date.now() } = {}) {
  const key = canon(chatKey).trim();
  const body = clip(text);
  if (!key) return { ok: false, reason: '没有会话，记不了' };
  if (!body) return { ok: false, reason: '内容为空' };
  if (CRED_RE.test(body)) return { ok: false, reason: '像凭据，不记' };
  if (PRIVATE_RE.test(body)) return { ok: false, reason: '像某个人的私事，不写进群记忆' };

  const st = load(key);
  const nk = normalize(body);
  const dup = st.facts.find((f) => normalize(nk) === normalize(f.text) || normalize(f.text).includes(nk) || nk.includes(normalize(f.text)));
  if (dup) {
    dup.weight = Math.min(2, dup.weight + 0.3);
    dup.updatedAt = now;
    save(st);
    return { ok: true, record: dup, duplicate: true, total: st.facts.length };
  }
  const k = Object.values(GROUP_KINDS).includes(String(kind)) ? String(kind) : GROUP_KINDS.VIBE;
  const record = {
    id: newId(),
    text: body,
    kind: k,
    weight: Math.max(0.2, Math.min(2, Number(weight) || 1)),
    createdAt: now,
    updatedAt: now
  };
  st.facts.push(record);
  // 容量裁剪：休眠/墓碑条不占配额也不被裁（同 facts 的"淡化≠删除"）。
  if (st.facts.filter((f) => !f.dormant && !f.tombstone).length > MAX_GROUP_FACTS) {
    const spareable = st.facts.filter((f) => f.kind !== GROUP_KINDS.RULE && !f.dormant && !f.tombstone);
    const dropCount = Math.min(st.facts.length - MAX_GROUP_FACTS, spareable.length);
    const drop = new Set(
      spareable.slice()
        .sort((a, b) => (a.weight - b.weight) || (a.updatedAt - b.updatedAt))
        .slice(0, dropCount)
        .map((f) => f.id)
    );
    st.facts = st.facts.filter((f) => !drop.has(f.id));
  }
  save(st);
  return { ok: true, record, duplicate: false, total: st.facts.length };
}

/**
 * 排序取用（复用 facts 的"核心项保底 + 相关×新鲜竞争"）。
 * 群规永远优先 —— 少了它会在别人的地盘上说错话。
 *
 * `sample` 打开概率式召回 + 联想链（2026-10-27）：群这一层同样会自锁 ——
 * 一个开了很久的群有十几条群体印象，每轮按同一个顺序注入前 6 条，
 * 排在第七的那条永远没有机会被提起来，而它可能恰恰是这一轮该想起的。
 */
export function listGroupFacts(chatKey, opts = {}) {
  const { limit = 6, query = '', now = Date.now(), sample = false, recallOpts = {}, stats = null } = opts;
  const st = load(chatKey);
  const n = Math.max(1, Number(limit) || 6);
  // 休眠（自然淡出）/墓碑（显式遗忘）不召回 —— 与 facts 同一条"淡化≠删除"纪律。
  const visible = st.facts.filter((f) => !f.dormant && !f.tombstone);
  const detailed = sample ? recallFactRecords(visible, { query, now, limit: n, ...recallOpts }) : null;
  const rows = detailed ? detailed.rows : rankFactRecords(visible, { query, now, limit: n });
  if (detailed?.stats && stats && typeof stats === 'object') Object.assign(stats, detailed.stats);
  return rows.map((f) => ({
    id: f.id,
    text: f.text,
    kind: f.kind,
    weight: Number(f.weight.toFixed(2))
  }));
}

/** 拼成提示词那一段。空的返回空串（新群、或不许记的群，一个字都不占）。 */
export function formatGroupFactsForPrompt(chatKey, opts = {}) {
  const { limit = 6, query = '', now = Date.now(), sample = false, recallOpts = {}, stats = null } = opts;
  const rows = listGroupFacts(chatKey, { limit, query, now, sample, recallOpts, stats });
  if (!rows.length) return '';
  return [
    '【这个群】（你自己在这儿待出来的印象。是分寸，不是台词：别把群规念出来，也别主动玩没人接的梗）',
    ...rows.map((f) => `- ${f.text}`)
  ].join('\n');
}

/** 遗忘衰减（与 facts 同一套节奏；rule 类不衰减，群规不该过期）。 */
export function decayGroupFacts({ ratePerDay = 0.02, now = Date.now() } = {}) {
  const rate = Math.max(0, Number(ratePerDay) || 0);
  if (!rate) return { changed: 0 };
  let changed = 0;
  for (const st of cache.values()) {
    let dirty = false;
    for (const f of st.facts) {
      if (f.kind === GROUP_KINDS.RULE) continue;
      const days = Math.max(0, (now - (Number(f.updatedAt) || now)) / 86400000);
      if (days <= 0) continue;
      const next = Math.max(0, f.weight - rate * days);
      if (next !== f.weight) {
        f.weight = next;
        f.updatedAt = now;
        dirty = true;
        changed += 1;
      }
    }
    if (dirty) save(st);
  }
  return { changed };
}

/** 丢掉权重过低的群事实（rule 豁免）。 */
/**
 * 低权重群记忆淡出 = **休眠**（2026-10-29，与 facts 同步改：淡化≠删除）。
 * 群规（rule）永不淡出；休眠条退出召回、不占容量配额、不衰减。
 * @returns {{removed:number, dormant:number}} removed 保留为 0 只为兼容旧日志
 */
export function forgetWeakGroupFacts({ minWeight = 0.3, chatKey = '', now = Date.now() } = {}) {
  const list = chatKey ? [load(chatKey)] : [...cache.values()];
  let dormantCount = 0;
  for (const st of list) {
    let dirty = false;
    for (const f of st.facts) {
      if (f.tombstone || f.dormant) continue;
      if (f.kind === GROUP_KINDS.RULE) continue;
      if (f.weight >= minWeight) continue;
      f.dormant = true;
      f.dormantAt = now;
      f.dormantReason = '低于注入线，自然淡出';
      dirty = true;
      dormantCount += 1;
    }
    if (dirty) save(st);
  }
  return { removed: 0, dormant: dormantCount };
}

/** 把磁盘上所有群的群记忆载入缓存（每日维护前必须调，理由同 loadAllFacts）。 */
export function loadAllGroupFacts() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let loaded = 0;
  for (const f of files) {
    const key = f.replace(/\.json$/, '');
    if (!key || cache.has(key)) continue;
    load(key);
    loaded += 1;
  }
  return loaded;
}

export function groupFactCount(chatKey) {
  return load(chatKey).facts.filter((f) => !f.dormant && !f.tombstone).length;
}

/** 显式遗忘群记忆（同 memory-facts.forgetFact：墓碑、不看 kind、永不物理删除）。 */
export function forgetGroupFact(chatKey, match, { now = Date.now(), reason = '用户要求遗忘' } = {}) {
  const key = canon(chatKey);
  const needle = normalize(String(match ?? ''));
  if (!key || !needle) return { ok: false, count: 0, records: [], reason: '没说要忘哪条' };
  const st = load(key);
  const hit = st.facts.filter((f) => !f.tombstone && normalize(f.text).includes(needle));
  for (const f of hit) {
    f.tombstone = true;
    f.tombstoneAt = now;
    f.tombstoneReason = String(reason).slice(0, 80);
    delete f.dormant;
    delete f.dormantAt;
    delete f.dormantReason;
  }
  if (hit.length) save(st);
  return { ok: hit.length > 0, count: hit.length, records: hit.map((f) => ({ id: f.id, text: f.text })), reason: hit.length ? '' : '没有匹配的群记忆' };
}

/** 丢掉内存缓存（测试用）。 */
export function resetGroupCache() {
  cache.clear();
}

/**
 * 组装"提取群记忆"的提示词（**纯函数**）。
 *
 * ⚠️ 为什么给 `known` 但**不要求它重写**：
 * 真机跑出来同一件事会以不同措辞反复入库 ——
 * 「这个群爱用拍一拍互相点名互动」和「这个群爱用拍一拍互相逗，气氛偏玩梗」
 * 二元组 Jaccard 只有 0.47，词面去重抓不住；攒 40 条之后，注入的 6 条可能全是"爱玩梗"的四种说法。
 * 解法是让模型自己看着办，但**只做抑制、不做合并**：把已记的条目当"别重复"清单喂进去，
 * 输出仍然只来自这一批原始消息。
 * 不要求"顺手合并重写"是因为那会引入漂移：每批消息都重写一遍群画像，
 * 措辞一轮轮变、信息一层层丢，最后变成一句谁都能用的废话（facts 那边踩过同类的坑）。
 *
 * @param {{chatName?:string, lines:string[], known?:string[]}} p
 */
export function buildGroupPrompt({ chatName = '', lines = [], known = [] } = {}) {
  const label = String(chatName || '').trim() || '这个群';
  const hints = Object.entries(GROUP_KIND_HINT).map(([k, v]) => `· "${k}" —— ${v}`);
  const knownList = (Array.isArray(known) ? known : []).filter(Boolean);
  return [
    '请分析下面这段群聊，只输出一个 JSON 对象，不要输出任何别的文字：',
    '{"facts": [{"text": "这个群……", "kind": "vibe"}]}',
    '',
    `只提取关于「${label}」**这个群本身**的稳定特征，最多 2 条；没有值得记的就输出 {"facts": []}。`,
    'kind 只有四种取值：',
    ...hints,
    '',
    '**已经记过的（不要重复写，也不要换个说法再写一遍）：**',
    ...(knownList.length ? knownList.map((t) => `· ${t}`) : ['（无）']),
    '',
    '**绝对不要记**：',
    '· 任何关于某个人的事（谁生病了、谁分手了、谁说了什么私事）—— 这里放的是整个群都看得见的位置；',
    '· 一次性的聊天内容、当天的话题、谁发了个表情包；',
    '· 手机号、身份证、密码、token 之类的信息。',
    '',
    '判定标准：这条信息**三个月后再看还对**，才写。每条约 20 字，用"这个群……"或"群里……"开头。',
    '每条要具体（"这个群爱用猫图接话"比"这个群很活跃"有用）。',
    '',
    '群聊内容：',
    ...(Array.isArray(lines) && lines.length ? lines : ['（无）'])
  ].join('\n');
}

/**
 * 解析群记忆提取结果。容错同 facts（围栏/废话/字符串数组都认）。
 * @returns {Array<{text:string, kind:string}>}
 */
export function parseGroupExtraction(text, { max = 2 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  let body = raw;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) body = fence[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const list = Array.isArray(data?.facts) ? data.facts : [];
  const out = [];
  for (const item of list.slice(0, Math.max(1, Number(max) || 2))) {
    const rawText = typeof item === 'string' ? item : item?.text;
    const s = clip(rawText, 50);
    if (!s) continue;
    if (CRED_RE.test(s) || PRIVATE_RE.test(s)) continue;   // 解析层再挡一次（模型不一定听话）
    const hinted = String(typeof item === 'object' && item ? (item.kind || '') : '').trim().toLowerCase();
    const kind = Object.values(GROUP_KINDS).includes(hinted) ? hinted : GROUP_KINDS.VIBE;
    if (!out.some((x) => x.text === s)) out.push({ text: s, kind });
  }
  return out;
}
