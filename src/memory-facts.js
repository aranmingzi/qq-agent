// 长期事实记忆 —— "一年后还用得上"的那一层（学自《记忆模块参考包》的三层记忆）。
//
// ── 为什么要独立于 memory.js ──────────────────────────────────────────────
// memory.js 记的是**会话级**的三类东西（进行中的话题 / 想说没说的话 / 对群友的印象），
// 主语是"这个群现在聊到哪了"。它天然回答不了另一个问题：
//   「**这个人**叫什么、在哪、忌口什么、答应过我什么」 —— 换一个群就该认识他。
// 参考包把这类信息单独放一层（facts 表），带权重、会强化、会遗忘。这里照做：
//
//   第 1 层 原始消息      → store.js（已有，按会话）
//   第 2 层 会话记忆      → memory.js（已有，按会话）
//   第 3 层 长期事实      → 本文件（**按 QQ**，所以私聊/群聊天然共享 → 不会"换个群就生分"）
//
// ── 三条设计纪律（都是踩过的坑，别改成"更聪明"的版本）──────────────────
// ① **宁缺毋滥**：只记"称呼/生日/城市/职业/重要约定/持久偏好/雷点/重大事件"。
//    每次最多 3 条，闲聊/心情/临时话题一律不记 —— 否则事实库很快被垃圾淹没。
// ② **防串人**：事实文本必须以昵称或 QQ 开头（"小明对花生过敏"），
//    提取时只喂"当前这个人说的话 + 我的回复"，别人说的不喂。
//    一次把 A 的事安到 B 头上，比记不住严重得多。
// ③ **权重会衰减**：长期不提到的事实慢慢淡出（半衰期思路，不是线性掉到 0）。
//    重要事实初始权重高、重复提及会强化（+0.3，上限 2.0），闲聊类给低权重。
//
// 存储：data/memory/facts/<qq>.json。纯文本、可手改、可删；一个 QQ 一份。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonDetailed } from './json-store.js';
// 相关性打分复用 recall.js 的 tokenize（中文二元组 + 英文/数字按词）。
// 不引 embedding、不加依赖 —— 先把"排序对不对"做对，再谈向量。
// ⚠️ 分数**没有**直接用 recall.js 的 scoreEntry，原因见 scoreFactRecords 的注释。
import { tokenize } from './recall.js';
// 概率式召回 / 联想链的原语（2026-10-27）。这里只负责组装，算法本体在那边。
import {
  alphaOf, recallProbability, buildTokenIndex, neighborsOf, weightedSample,
  DEFAULT_MU, DEFAULT_SIGMA, DEFAULT_MAX_DOC_RATIO
} from './fact-recall.js';

const DIR = path.join(DATA_DIR, 'memory', 'facts');

/** 每人最多留多少条（超了从最弱的丢）。 */
export const MAX_FACTS_PER_USER = 60;
/** 权重上限（重复提及可以一路强化到这里）。 */
export const MAX_WEIGHT = 2;
/** 一次提取最多几条（参考包的实测值：再多就变成垃圾场）。 */
export const MAX_FACTS_PER_EXTRACT = 3;

/**
 * 事实的可见范围（2026-10-26 加）。
 *
 * 为什么需要它：事实是**按 QQ** 存的（换个群还认识他，这是对的），
 * 但"他在 A 群说过什么"属于 A 群的语境。不区分的话，A 在群里吐的槽、
 * 开的黄腔、说的家里事，会在他私聊我时被原样端出来 —— 那不是记性好，那是没分寸。
 *
 *   · person —— 这个人的属性（名字、生日、城市、职业、忌口、稳定偏好）。**跨群可见**
 *   · group  —— 只属于某个群的事（群规、群里的梗、群内约定）。**只在该群可见**
 *
 * ⚠️ 默认 person，且**不传 chatKey 时 group 一律不可见**：
 *    保守方向的错误只是"少提一句"，激进方向的错误是"把别人的私事说给另一个人"。
 */
export const SCOPES = Object.freeze({ PERSON: 'person', GROUP: 'group' });

/** 会话键归一（group:123:tutor → group:123）。不 import store，避免循环依赖。 */
function normalizeChat(key) {
  const parts = String(key || '').split(':');
  if (parts.length >= 3 && parts[0] && parts[1]) return `${parts[0]}:${parts[1]}`;
  return String(key || '');
}

/**
 * 这条事实在当前会话里能不能说。
 * @param {{scope?:string, source?:string}} fact
 * @param {string} chatKey 当前会话（不传 = 只允许 person）
 */
export function factVisibleIn(fact, chatKey) {
  const scope = String(fact?.scope || SCOPES.PERSON);
  if (scope !== SCOPES.GROUP) return true;
  const home = String(fact?.source || '').trim();
  if (!home || !chatKey) return false;
  return normalizeChat(home) === normalizeChat(chatKey);
}

/** 凭据一律不落盘：宁可这次记不上，也不让 key 写进能被翻出来的文件。 */
const CRED_RE = /sk-[A-Za-z0-9]{16,}|accessToken|apiKey\s*[:=]|Bearer\s|BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_|AKIA[0-9A-Z]{16}/i;

/**
 * 隐私护栏（2026-10-30，学自 dsh-beme read.js 的 PRIV_ASK × PRIV_HIT 交叉判断）。
 *
 * 为什么需要：scope 只管"存储范围"（群内的事不跨群），管不住另一种泄露——
 * **召回正常命中后，注入原文，模型在群里被人问"他家住哪"时靠自觉忍住**。
 * 护栏做成"命中即换文案"：不让原文进上下文，比指望模型看到后自己不说可靠。
 *
 *   PRIV_ASK —— 查询侧：这轮的问题像在问"能不能说出去"；
 *   PRIV_HIT —— 内容侧：召回的事实里有住址/电话一类。
 * 两者同时命中 → 不注原文，注入规矩句。方向刻意保守：误伤的代价只是少提一句，
 * 漏掉的代价是私事上桌（与 factVisibleIn 的保守方向同一条纪律）。
 */
export const PRIV_ASK_RE = /能不能(说|讲|告诉|发)|可不可以(说|讲|告诉)|说给别人|告诉(他们|大家|别人|他|她|群里)|发到群里|群里?(问|有人问)|外人|公开|透(露|个底)/;
export const PRIV_HIT_RE = /(住|家庭)?地址|电话|手机号|身份证|家门|小区|楼栋|单元|银行卡|卡号|密码|支付(密码|方式)|课表|上班(时间|地点)|工资/;

export function privacyGuardHit(query, factTexts) {
  return PRIV_ASK_RE.test(String(query || ''))
    && (Array.isArray(factTexts) ? factTexts : []).some((t) => PRIV_HIT_RE.test(String(t || '')));
}

/** 关系记忆的占位词（模型"没什么可写"时的常见输出）。 */
const RELATION_PLACEHOLDER_RE = /^(无|没有|暂无|不确定|未知|none|null|n\/a|na|-|—|\.{1,3})$/i;

const cache = new Map();

function fileOf(qq) {
  const safe = String(qq || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32);
  return safe ? path.join(DIR, `${safe}.json`) : '';
}

function normalizeKey(text) {
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

/** FNV-1a 内容哈希（2026-10-30，学自 dsh-beme 的 content_hash）：
 *  归一化去重的补充层 —— normalizeKey 抓"字面相同"，hash 抓"幂等写入"（同文本跳过、
 *  内容变了放行）。beme 实测教训：只看来源 id 有没有同步过就跳过，条目被整理后
 *  （id 不变、内容变了）永远进不了库，22 小时零新增。 */
function contentHash(text) {
  const s = String(text ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/**
 * 同主体冲突检测（REBUILD 分流的触发器，学自 beme 的 OVERWRITE/REBUILD 分流思想）。
 *
 * 为什么不能照抄它的特征 Jaccard：facts 是一句话（4~8 个二元组）且全部以昵称开头，
 * 同主语事实天然共享昵称二元组；而"杭州→上海"这类宾语替换**没有任何共同实义词**。
 * 所以用双通道：
 *   通道一（复述）  —— 与某条事实 2-gram Jaccard ≥ 0.62：**去掉主语后仍高度重合**，
 *                      同一件事换个措辞再说一遍。0.5 会误伤"同主语同构句"
 *                      （"小明第0件事/第1件事/…"在批量写入时连环替代，实测回归抓出）。
 *   通道二（更正）  —— 新说法带**迁移/更正信号词**（搬到/改成/不再/其实/后来…），
 *                      且存在同主语（≥2 字共同前缀）的活跃事实 → 替代其中最相似的一条。
 *   "宾语不同但都像属性"（对花生过敏 vs 对芒果过敏）判不出 → 并存（保守方向，宁可少分流）。
 * 误分流的代价是旧说法退出一个注入位，漏分流的代价是两条矛盾事实并注入、模型挑顺口的信。
 */
const CORRECTION_CUE_RE = /搬到|搬去|换成|改成|改到|改叫|换了|不再|其实|后来|现在(住|在|叫|用|是)/;
const RESTATE_JAC = 0.62;

function commonPrefixLen(a, b) {
  const x = String(a || ''), y = String(b || '');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  return i;
}

function cjkGrams(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function ngramJac(a, b) {
  const A = cjkGrams(a), B = cjkGrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 数字独立成段比对：'第1件事' vs '第11件事' 的二元组几乎全同（"第1"⊂"第11"），
 *  但语义上是两件事。数字差异是判然信号 —— 数字段不同 → 不算复述。 */
function digitsOf(text) {
  return String(text || '').replace(/\D+/g, ' ').trim();
}

export function findConflict(facts, text) {
  const target = String(text || '');
  if (target.length < 6) return null;   // 太短没有"说法"可言
  const targetDigits = digitsOf(target);
  const cands = [];
  for (const f of facts) {
    if (!f || f.tombstone || f.dormant || f.supersededAt || f.status === 'candidate') continue;
    if (commonPrefixLen(target, f.text) < 2) continue;   // 不同主语，谈不上冲突
    // 数字不同（第1件事 vs 第11件事、3月7日 vs 3月8日）→ 不同的事，绝不判复述
    if (digitsOf(f.text) !== targetDigits) continue;
    cands.push({ f, jac: ngramJac(target, f.text) });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.jac - a.jac);
  if (cands[0].jac >= RESTATE_JAC) return cands[0].f;    // 同一件事的复述 → 新说法替代
  if (CORRECTION_CUE_RE.test(target)) return cands[0].f; // 更正信号 → 替代同主语最相似条
  return null;
}

/** 把一条事实标记为被替代（不删：它当年真过）。 */
function supersede(oldFact, { byId, now }) {
  oldFact.supersededBy = String(byId || '');
  oldFact.supersededAt = now;
}

function load(qq) {
  const key = String(qq || '');
  if (cache.has(key)) return cache.get(key);
  const file = fileOf(key);
  let facts = [];
  if (file) {
    // "文件不存在"（新用户）与"文件坏了"必须分开：
    // 前者当新用户是对的，后者当新用户就会把这个人记了一年的东西清零，
    // 然后下一次 rememberFact 直接覆盖掉唯一还能人工抢救的坏文件。
    // 坏文件由 readJsonDetailed 改名留档（<qq>.json.corrupt-<时间戳>）后再当空。
    const { data: parsed } = readJsonDetailed(file, null, { tag: 'facts' });
    if (parsed && typeof parsed === 'object') {
      const list = Array.isArray(parsed?.facts) ? parsed.facts : (Array.isArray(parsed) ? parsed : []);
      facts = list
        .filter((f) => f && f.text)
        .map((f) => ({
          id: String(f.id || newId()),
          text: clip(f.text),
          kind: String(f.kind || 'fact'),
          weight: Math.min(MAX_WEIGHT, Math.max(0, Number(f.weight) || 1)),
          createdAt: Number(f.createdAt) || Date.now(),
          updatedAt: Number(f.updatedAt) || Number(f.createdAt) || Date.now(),
          // ⚠️ `source` 必须读回来（2026-10-26 修）：以前 map 里没有它，进程重启后
          // 内存里就丢了来源，下一次 save 会把磁盘上的 source 一起写没。
          // 加了 scope 之后这不只是信息丢失 —— group 事实会因为"没有来源"变成永远不可见。
          ...(f.source ? { source: String(f.source).slice(0, 24) } : {}),
          ...(String(f.scope || '') === SCOPES.GROUP ? { scope: SCOPES.GROUP } : {}),
          // 版本链（2026-10-30）：血统起点 + 被替代标记。读不回来 = 重启后冲突条重新并出。
          ...(f.hash ? { hash: String(f.hash) } : {}),
          ...(f.origin ? { origin: String(f.origin) } : {}),
          ...(f.originAt ? { originAt: Number(f.originAt) } : {}),
          ...(f.supersedes ? { supersedes: String(f.supersedes) } : {}),
          ...(f.supersededAt ? { supersededAt: Number(f.supersededAt), ...(f.supersededBy ? { supersededBy: String(f.supersededBy) } : {}) } : {}),
          // 休眠/墓碑（2026-10-29）："淡化≠删除"的两态。读不回来 = 重启后全部复活，
          // 墓碑一旦复活就会在下一轮反思链里被重新学到 —— 那正是墓碑要防的事。
          ...(f.tombstone
            ? {
              tombstone: true,
              tombstoneAt: Number(f.tombstoneAt) || 0,
              ...(f.tombstoneReason ? { tombstoneReason: String(f.tombstoneReason).slice(0, 80) } : {})
            }
            : {}),
          ...(f.dormant || Number(f.dormantAt)
            ? {
              dormant: true,
              dormantAt: Number(f.dormantAt) || 0,
              ...(f.dormantReason ? { dormantReason: String(f.dormantReason).slice(0, 80) } : {})
            }
            : {}),
          // 复活次数（2026-10-31）：跟 source 同一个坑 —— 读不回来就等于每次重启清零，
          // "忘了又想起" 的加权会周期性地凭空消失，而我们只会看到"加权好像没生效"。
          ...(Number(f.reviveCount) > 0 ? { reviveCount: Number(f.reviveCount) } : {}),
          ...(Number(f.reviveAt) > 0 ? { reviveAt: Number(f.reviveAt) } : {})
        }));
    }
  }
  const st = { qq: key, facts };
  cache.set(key, st);
  return st;
}

function save(st) {
  const file = fileOf(st.qq);
  if (!file) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ qq: st.qq, facts: st.facts }, null, 1), 'utf8');
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
 * 记一条长期事实。重复出现 = 强化（不是再存一条）。
 * @returns {{ok:boolean, record?:object, duplicate?:boolean, reason?:string, total?:number}}
 */
export function rememberFact(qq, text, { kind = 'fact', weight = 1, now = Date.now(), source = '', scope = '' } = {}) {
  const key = String(qq || '').trim();
  const body = clip(text);
  if (!key) return { ok: false, reason: '没有 QQ，记不了' };
  if (!body) return { ok: false, reason: '内容为空' };
  if (CRED_RE.test(body)) return { ok: false, reason: '这条看着像凭据（token / key / 私钥），不记' };

  const st = load(key);
  const nk = normalizeKey(body);
  // ⚠️ 休眠/墓碑/被替代的记录**不参与"重复提及=强化"**：
  // 它们淡出/被忘掉/被新说法取代后，同一句话再次被提取（反思链会重读归档）不应把它们原地唤醒 ——
  // 那等于"显式遗忘"只管一轮。正确路径：candidate 转正或新增 candidate（一次观察不算数）。
  // 被替代条（supersededAt）被重提时，强化目标**转投替代它的新条**（血统在 origin 链上）——
  // "住在杭州"被再次提起，该变强的是"搬到上海住了"这个新说法对应的活跃条。
  const dupRaw = st.facts.find((f) => normalizeKey(f.text) === nk);
  const dup = dupRaw
    ? (dupRaw.supersededBy
        ? st.facts.find((f) => f.id === dupRaw.supersededBy && !f.dormant && !f.tombstone && !f.supersededAt) || null
        : dupRaw)
    : null;
  // candidate 的二次独立出现 = 转正（对外版纪律 1"一次观察不算数"的正向出口）。
  // 判据用"不同时间批次的提取"：candidateSince 早于本次 now 即算独立确认；
  // 同一批内反复出现不会连续转正（rememberFact 每次调用本来就是独立批次）。
  if (dup && dup.status === 'candidate') {
    dup.status = 'active';
    delete dup.candidateSince;
    dup.weight = Math.min(MAX_WEIGHT, Math.max(Number(dup.weight) || 0.5, Math.min(Number(weight) || 1, 1)));
    dup.updatedAt = now;
    if (source && !dup.source) dup.source = clip(source, 24);
    if (String(scope) === SCOPES.GROUP) dup.scope = SCOPES.GROUP;
    if ((kind === 'negative' || kind === 'rule') && dup.kind !== kind) dup.kind = String(kind);
    save(st);
    return { ok: true, record: dup, duplicate: true, promoted: true, total: st.facts.length };
  }
  if (dup && !dup.dormant && !dup.tombstone) {
    dup.weight = Math.min(MAX_WEIGHT, dup.weight + 0.3);
    dup.updatedAt = now;
    // 重复提及可以补上来源/范围（以前只有新建时写，重复提及反而不补）
    if (source && !dup.source) dup.source = clip(source, 24);
    if (String(scope) === SCOPES.GROUP) dup.scope = SCOPES.GROUP;
    // kind **只升级不降级**：一条事实后来才被认成雷点，得能补上
    //（否则先记成 fact 的那条永远享受不到"不衰减 / 优先占位"）。
    // 反过来不行：这次模型没标 negative 不代表它不是雷点。
    if ((kind === 'negative' || kind === 'rule') && dup.kind !== kind) dup.kind = String(kind);
    save(st);
    return { ok: true, record: dup, duplicate: true, total: st.facts.length };
  }
  // 走到这里要么没有重复、要么重复条是休眠/墓碑态。
  // 淡化≠删除的另一面：**不复活旧条，新增一条 candidate**。
  // 好处：旧条的休眠史不丢（"这条曾经淡出过"本身是信息）；新条转正要过二次确认，
  // 不会因为归档里恰好又出现同一句话就把刚忘掉的内容送回提示词。
  if (dup) {
    const inherited = Number(dup.reviveCount) || 0;
    const revived = {
      id: newId(),
      text: body,
      kind: String(kind || 'fact'),
      weight: Math.max(0.1, Math.min(MAX_WEIGHT, Number(weight) || 0.5)),
      status: 'candidate',
      candidateSince: now,
      createdAt: now,
      updatedAt: now,
      // 复活史要跟着概念走（2026-10-31）：这条 candidate 就是"那句被忘掉的话又出现了"，
      // 继承旧条的次数，否则新条一转正就把"忘过又想起"的记忆洗成"第一次听说"。
      ...(inherited > 0 ? { reviveCount: inherited + 1, reviveAt: now } : {}),
      ...(source ? { source: clip(source, 24) } : {}),
      ...(String(scope) === SCOPES.GROUP ? { scope: SCOPES.GROUP } : {})
    };
    st.facts.push(revived);
    save(st);
    return { ok: true, record: revived, duplicate: false, reawakened: true, total: st.facts.length };
  }
  // ── 版本链分流（2026-10-30，学自 dsh-beme 的 OVERWRITE/REBUILD，但只取 REBUILD 那条腿）──
  // 与"旧记录不改写"纪律（对外版纪律 4）的取舍：不做 beme 的原地 ver+1（那是改写），
  // 冲突一律走"新条替代旧条"：新条带 supersedes，旧条打 supersededAt 不删。
  // 判不出冲突就并存（保守方向）——误分流的代价小，漏分流的代价是两条矛盾事实并注入。
  const conflicted = dup ? null : findConflict(st.facts, body);
  const record = {
    id: newId(),
    text: body,
    kind: String(kind || 'fact'),
    weight: Math.min(MAX_WEIGHT, Math.max(0.1, Number(weight) || 1)),
    hash: contentHash(body),
    createdAt: now,
    updatedAt: now,
    // origin = 这件事的血统起点：新事实从自己开始；替代旧条时继承它的 origin/originAt，
    // 于是"这事最早什么时候出现的"有据可说（问答里"X 天前的事"不用翻档）。
    origin: conflicted ? (conflicted.origin || conflicted.id) : '',
    originAt: conflicted ? (Number(conflicted.originAt) || Number(conflicted.createdAt) || now) : now,
    ...(conflicted ? { supersedes: conflicted.id } : {}),
    ...(source ? { source: clip(source, 24) } : {}),
    ...(String(scope) === SCOPES.GROUP ? { scope: SCOPES.GROUP } : {})
  };
  if (conflicted) supersede(conflicted, { byId: record.id, now });
  st.facts.push(record);
  // 超上限：先丢权重最低的（同权重丢最旧的）。规则/雷点类（rule/negative）不参与丢弃；
  // 休眠/墓碑/candidate/被替代条不占配额也不被裁（candidate 转正后才进入配额竞争）。
  const isActive = (f) => !f.dormant && !f.tombstone && f.status !== 'candidate' && !f.supersededAt;
  if (st.facts.filter(isActive).length > MAX_FACTS_PER_USER) {
    const spareable = st.facts.filter((f) => f.kind !== 'rule' && f.kind !== 'negative' && isActive(f));
    const dropCount = Math.min(st.facts.length - MAX_FACTS_PER_USER, spareable.length);
    const drop = new Set(
      spareable
        .slice()
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
 * 取这个人最重要的事实。
 *
 * ── 为什么现在要带 query（2026-10-26，P2-1）──────────────────────────────
 * 以前只按 `weight desc, updatedAt desc` 排。这个顺序在两个方向上都会错：
 *   ① 全都 weight=1.0 时它退化成"纯按时间"，**旧而重要**的事实被挤出去
 *      （"对花生过敏"躺在第 30 条，只因为三个月没提）；
 *   ② 本轮明明在聊"吃辣"，跟"忌口"高度相关的那条并不会因此上浮。
 * 现在改成**核心项保底 + 其余按相关×新鲜竞争**（见 rankFactRecords）。
 *
 * @param {string} qq
 * @param {{limit?:number, chatKey?:string, query?:string, now?:number}} [opts]
 *   chatKey 用来过滤 `scope='group'` 的事实 —— 只在该群可见。
 *   不传 chatKey 时 group 事实一律不出现（保守方向）。
 *   query 传当前这轮触发消息；**不传 = 完全保持旧顺序**（测试与老调用方逐字不变）。
 *   sample 打开概率式召回 + 联想链（默认关 = 走原来的确定性 top-N，见 recallFactRecords）。
 *   recallOpts / stats：概率召回的调参与**观测回流**（stats 是被就地填充的普通对象）。
 * @returns {Array<{id:string,text:string,kind:string,weight:number,scope:string}>}
 */
export function listFacts(qq, opts = {}) {
  const {
    limit = 8, chatKey = '', query = '', now = Date.now(),
    sample = false, recallOpts = {}, stats = null
  } = opts;
  const st = load(qq);
  const n = Math.max(1, Math.min(MAX_FACTS_PER_USER, Number(limit) || 8));
  // 四态过滤（2026-10-29/30）：休眠（自然淡出）、墓碑（显式遗忘）、candidate（一次观察未转正）、
  // 已被替代（有 supersededAt：新说法已在库里，旧说法继续注入 = 两条矛盾并出，模型挑顺口的信）
  // **都不召回**。墓碑防"重新学到"；candidate 落实"一次观察不算数"——二次独立确认才转正。
  const visible = st.facts.filter((f) => factVisibleIn(f, chatKey) && !f.dormant && !f.tombstone
    && f.status !== 'candidate' && !f.supersededAt);
  const detailed = sample ? recallFactRecords(visible, { query, now, limit: n, ...recallOpts }) : null;
  const rows = detailed ? detailed.rows : rankFactRecords(visible, { query, now, limit: n });
  if (detailed?.stats && stats && typeof stats === 'object') Object.assign(stats, detailed.stats);
  return rows.map((f) => ({
    id: f.id,
    text: f.text,
    kind: f.kind,
    weight: Number(f.weight.toFixed(2)),
    scope: String(f.scope || SCOPES.PERSON)
  }));
}

/** 某人的全部事实（含休眠/墓碑），控制台"记忆管理"与测试用。 */
export function listAllFactsRaw(qq) {
  return load(qq).facts.map((f) => ({
    id: f.id,
    text: f.text,
    kind: f.kind,
    weight: Number((Number(f.weight) || 0).toFixed(2)),
    scope: String(f.scope || SCOPES.PERSON),
    dormant: !!f.dormant,
    dormantAt: Number(f.dormantAt) || 0,
    dormantReason: String(f.dormantReason || ''),
    tombstone: !!f.tombstone,
    tombstoneAt: Number(f.tombstoneAt) || 0,
    tombstoneReason: String(f.tombstoneReason || ''),
    ...(f.supersedes ? { supersedes: String(f.supersedes) } : {}),
    ...(f.supersededAt ? { supersededAt: Number(f.supersededAt), supersededBy: String(f.supersededBy || '') } : {}),
    ...(f.origin ? { origin: String(f.origin), originAt: Number(f.originAt) || 0 } : {}),
    ...(Number(f.reviveCount) > 0 ? { reviveCount: Number(f.reviveCount), reviveAt: Number(f.reviveAt) || 0 } : {})
  }));
}

/**
 * 事实的新鲜度半衰期：30 天。
 * 刻意比【记忆】的 7 天长 —— facts 是"一年后还用得上"的那一层，
 * 用 7 天会让"上周没提过"就掉出候选，等于把长期记忆做成短期记忆。
 */
const FACT_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** 权重到"重要度"的换算：weight 1.0 算中等，1.5 以上算满。 */
function importanceOfFact(f) {
  const kind = String(f?.kind || 'fact');
  if (kind === 'rule' || kind === 'negative') return 1;
  if (kind === 'relation') return 0.9;
  return Math.max(0.2, Math.min(1, (Number(f?.weight) || 1) / 1.5));
}

/**
 * 核心项：**无论相关性如何都必须留着**。
 *
 * 判据只有两条，都是"错了代价最大"的：
 *   · kind=rule / negative —— 群规与雷点，丢了会直接冒犯人；
 *   · weight ≥ 1.2 —— 被重复提及过的（每提一次 +0.3），说明这个人自己在意。
 * 注意：**这不是"重要的"，是"不能丢的"**。别把 kind='fact' 的高权重当荣誉榜，
 * 1.2 这个门槛正好卡在"提过两次"（1.0+0.3=1.3）之上。
 */
export const CORE_WEIGHT = 1.2;

export function isCoreFact(f) {
  const kind = String(f?.kind || 'fact');
  if (kind === 'rule' || kind === 'negative') return true;
  return (Number(f?.weight) || 0) >= CORE_WEIGHT;
}

/**
 * 复活加权（2026-10-31，P2-2）：被淡出过、又被真实重提过的事实，值 0..1。
 *
 * 学自 MaiMBot-LPMM 的拟人脑遗忘设计 —— "忘掉的东西再想起来会记得更牢"。
 * 我们此前只做到"能复活"（dormantRevive），复活完跟新事实一模一样，等于没学到这条。
 *
 * 次数的映射（1 次 → 0.4，2 次 → 0.7，3 次以上 → 1.0）：
 *   · 1 次只给 0.4：一次淡出可能只是"那阵子没聊"，不该立刻抬成最要紧的记忆；
 *   · 3 次封顶：反复淡入淡出本身是信号，但不该让它在打分上压过 rule/negative ——
 *     那两类是必入项（isCoreFact），不靠分数竞争，这里只影响**普通事实之间**的排序。
 */
export function reviveBoostOf(f) {
  const times = Number(f?.reviveCount) || 0;
  if (times <= 0) return 0;
  return Math.min(1, 0.4 + (times - 1) * 0.3);
}

/**
 * 排序 + 截断（纯函数，测试直接断言）。
 *
 * 无 query → **旧顺序**（weight desc, updatedAt desc），一个字节都不改。
 * 有 query → 核心项先占 60% 名额（按权重），剩下的按打分竞争：
 *   score = 0.50×相关 + 0.28×新鲜 + 0.14×重要 + 0.08×复活加权（见 reviveBoostOf）
 *
 * ⚠️ 为什么核心项要**先占名额**而不是"参与打分"：相关分是 0.55 权重的大头，
 *    一条刚被提到的闲聊（相关 1.0）能轻松压过一条 90 天前的"对花生过敏"（相关 0）。
 *    那不是"检索做得好"，那是把长期记忆换成了短期记忆。
 *    保底 60% 而不是 100%：留 40% 给"这轮确实相关"的旧事上浮，否则相关性白算。
 *
 * ⚠️ 为什么不直接用 `recall.js` 的 `scoreEntry`：它的相关性是
 *    `命中数 / min(query 词数, 8)`，那是给**几百字的长条目**标定的。
 *    facts 是**一句话**（"对花生过敏"只有 4 个二元组），用户随口一句 6 个词的
 *    "这个花生能不能吃"只命中 1 个 → 相关 0.17 → 0.55×0.17 = 0.09，
 *    而"刚刚写进去的闲聊"仅凭新鲜就拿 0.30 —— 相关永远打不过新鲜，等于白算。
 *    所以这里把相关**在候选池内归一化**（跟这轮最贴的那条算满分），
 *    新鲜/重要沿用同一套权重与半衰期，口径一致。实测：过敏那条从 0.19 → 0.65。
 */
/**
 * 打分（**排序/召回两条路径的唯一真相源**）。
 *
 * 为什么抽出来：`rankFactRecords`（确定性 top-N）与 `recallFactRecords`（概率式）
 * 必须用同一把尺子打分，否则"什么叫相关"就变成两套判据 ——
 * 本项目踩过这个（判据写两遍 → 拆一处另一处兜住 → 测试假绿）。
 *
 * ⚠️ 相关性的归一化基准只取**非核心项**（`rest`）：跟原实现保持一致，
 *    核心项本来就走"必入"，让它们参与 maxHits 只会稀释池内差异。
 * @returns {Array<{record:object, core:boolean, hits:number, freshness:number, score:number}>}
 */
function scoreFactRecords(records, { query = '', now = Date.now(), halfLifeMs = FACT_HALF_LIFE_MS } = {}) {
  // 兜底：调用方忘了过滤休眠/墓碑/candidate/被替代（未来新增列表函数）也不至于把"忘掉的内容"注回提示词。
  const list = (Array.isArray(records) ? records : []).filter((f) => f && f.text
    && !f.dormant && !f.tombstone && f.status !== 'candidate' && !f.supersededAt);
  const q = String(query || '').trim();
  const queryTokens = q ? tokenize(q) : null;
  const raw = list.map((f) => {
    let hits = 0;
    if (queryTokens) {
      const own = tokenize(f.text);
      for (const t of queryTokens) if (own.has(t)) hits += 1;
    }
    const age = Math.max(0, now - (Number(f.updatedAt) || now));
    const freshness = halfLifeMs > 0 ? Math.max(0, Math.min(1, 1 - age / (halfLifeMs * 2))) : 1;
    return { record: f, core: isCoreFact(f), hits, freshness };
  });
  const restHits = raw.filter((x) => !x.core).reduce((m, x) => Math.max(m, x.hits), 0);
  return raw.map((x, idx) => ({
    ...x,
    // idx 是**入参数组里的下标**：联想要用它做稳定 id（record.id 可能缺失）。
    idx,
    revive: reviveBoostOf(x.record),
    // 四项权重（2026-10-31，P2-2）：前三项按 0.55/0.30/0.15 等比缩到 0.50/0.28/0.14，
    // 让出 0.08 给"复活过几次"。等比缩而不是重新分配，是为了让**相对排序**基本不变 ——
    // 这次改动的目的只是让"忘过又想起"这条信号有一票，不是重排整套判据。
    score: 0.50 * (restHits > 0 ? x.hits / restHits : 0)
      + 0.28 * x.freshness
      + 0.14 * importanceOfFact(x.record)
      + 0.08 * reviveBoostOf(x.record)
  }));
}

export function rankFactRecords(records, { query = '', now = Date.now(), limit = 8, halfLifeMs = FACT_HALF_LIFE_MS } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((f) => f && f.text);
  const n = Math.max(1, Number(limit) || 8);
  const byWeight = (a, b) => (b.weight - a.weight) || (b.updatedAt - a.updatedAt);
  const q = String(query || '').trim();
  if (!q) return list.slice().sort(byWeight).slice(0, n);

  const scored = scoreFactRecords(list, { query, now, halfLifeMs });
  const core = scored.filter((x) => x.core).map((x) => x.record).sort(byWeight);
  const rest = scored.filter((x) => !x.core).sort((a, b) => b.score - a.score).map((x) => x.record);
  const coreSlots = Math.min(core.length, Math.max(1, Math.ceil(n * 0.6)));

  const out = core.slice(0, coreSlots);
  for (const f of rest) {
    if (out.length >= n) break;
    out.push(f);
  }
  // 名额还没满（核心项比 60% 少、其余也不够）→ 用剩下的核心项补齐
  for (const f of core.slice(coreSlots)) {
    if (out.length >= n) break;
    out.push(f);
  }
  return out.slice(0, n);
}

/**
 * 【2026-10-27】概率式召回 + 联想链 —— 让"想起哪几条"这件事**不再是确定的**。
 *
 * 算法（细节与取舍见 `fact-recall.js` 的文件头，这里只讲这条流水线）：
 *
 *   ① **核心项必入，不掷骰**（rule / negative / weight ≥ CORE_WEIGHT）
 *      —— 沿用原有"核心项先占 60% 名额"。社交场景里忘掉一条雷点是事故，不是拟人。
 *   ② **直接名额一分为二**：一半（`topShare` 默认 0.5）按分数**确定性地**给本轮最贴题的几条
 *      —— 这是"条件反射"，不该掷骰；另一半**加权无放回抽样**（Efraimidis–Spirakis），
 *      权重 = α × score，池比名额还小时全进（**此时抽样不生效**，`stats.full = true`）。
 *   ③ **联想**：从 ① ②想起来的记录出发，顺着共享关键词往外走，
 *      第 n 代要通过 `α × p(n)` 的骰子。联想有**独立名额**（最多 n/2），不挤占 ②；
 *      它没用掉的额度在 ④ 会还给 ②，不让名额空着。
 *
 * ⚠️ **名额一定填满**（只要池够）：刻意不用 Bernoulli 逐条掷骰 —— 那会让某些轮
 *    想起 0 条，日志看着跟模块坏了没区别，而且"一条都想不起"对熟人来说非常假。
 *
 * @param {object[]} records 已经是**可见性过滤过**的记录（scope 逻辑在调用方）
 * @param {object} opts
 *   limit / query / now / halfLifeMs    —— 与 rankFactRecords 同义
 *   assocMax        联想最多带几条（默认 1，且不超过 limit 的一半）
 *   topShare        直接名额里"必须想起"的比例（默认 0.5；1 = 完全确定，0 = 完全随机）
 *   maxGeneration   最多联想几跳（默认 4；0 = 不限）
 *   temperature     >1 更随机 / <1 更偏向高分（默认 1）
 *   maxDocRatio     联想用的关键词过滤阈值（默认 0.8，见 fact-recall.js 的昵称陷阱）
 *   mu / sigma      p(n) 形状参数（默认 5 / 3）
 *   rng             **必须可注入**：不注入就永远测不了这类代码
 * @returns {{rows:object[], stats:object}} rows 形状与 rankFactRecords 完全一致
 */
export function recallFactRecords(records, opts = {}) {
  const {
    query = '',
    now = Date.now(),
    limit = 8,
    halfLifeMs = FACT_HALF_LIFE_MS,
    temperature = 1,
    assocMax = 1,
    topShare = 0.5,
    maxGeneration = 4,
    assocCandidateMax = 3,
    mu = DEFAULT_MU,
    sigma = DEFAULT_SIGMA,
    minShared = 1,
    maxDocRatio = DEFAULT_MAX_DOC_RATIO,
    rng = Math.random
  } = opts;

  const list = (Array.isArray(records) ? records : []).filter((f) => f && f.text);
  const n = Math.max(1, Number(limit) || 8);
  const idAt = (idx) => String(list[idx]?.id ?? list[idx]?.text ?? `r${idx}`);
  const byWeight = (a, b) => (b.record.weight - a.record.weight) || (b.record.updatedAt - a.record.updatedAt);

  // 联想是**额外**的名额：想起 A 顺带想起 B 不等于"检索命中了 B"。
  // 不给它独立名额的话，"联想越多、正常召回越少"会变成一桩赔本买卖。
  const assocBudget = Math.max(0, Math.min(Math.floor(Number(assocMax)) || 0, Math.floor(n / 2)));
  const directLimit = Math.max(1, n - assocBudget);

  const scored = scoreFactRecords(list, { query, now, halfLifeMs });
  const core = scored.filter((x) => x.core).sort(byWeight);
  const rest = scored.filter((x) => !x.core);
  const alphaOfRecord = (x) => alphaOf(x.record, { maxWeight: MAX_WEIGHT });

  // ① 核心项
  const coreSlots = Math.min(core.length, Math.max(1, Math.ceil(directLimit * 0.6)));
  const picked = core.slice(0, coreSlots);
  const seen = new Set(picked.map((x) => idAt(x.idx)));

  // ② 抽样池：核心项没占满名额时，剩下的核心回到池里竞争（α 天然更高）。
  //    统一按 score 降序 —— "条件反射"那一半名额直接从这里按序取。
  const pool = core.slice(coreSlots).concat(rest).slice().sort((a, b) => b.score - a.score);
  let available = pool.slice();
  const room = Math.max(0, directLimit - picked.length);
  const full = available.length <= room;

  /** 从池里加权抽 k 条，并**从池里移除**（后面补位不会重复）。池不够就全给。 */
  const draw = (k) => {
    if (k <= 0 || !available.length) return [];
    if (available.length <= k) {
      const all = available.slice();
      available = [];
      return all;
    }
    const weights = available.map((x) => alphaOfRecord(x) * Math.max(0.05, x.score));
    const chosen = weightedSample(available, { weights, limit: k, rng, temperature });
    const taken = new Set(chosen);
    available = available.filter((x) => !taken.has(x));
    return chosen;
  };

  let sampled = 0;
  let guaranteed = 0;
  if (room > 0 && available.length) {
    // ②a **条件反射**（topShare）：本轮最贴题的那几条**必须**想起，不掷骰。
    //    纯加权抽样做不到这件事 —— E-S 的选中率虽然正比于权重，但在"25 条里取 8 条"
    //    这个规模上，2.4 倍的权重差只换来约 45% 的命中率（实测），等于把检索降级成抽奖。
    //    拟人体现在**剩下的那一半**，不该体现在"聊到忌口却偏偏想不起过敏"。
    // ②b **自由联想**（其余名额）：加权抽样，冷门项永远有机会。
    const share = full ? 1 : Math.max(0, Math.min(1, Number(topShare)));
    const flat = full ? room : Math.min(room, Math.ceil(room * share));
    const top = available.slice(0, flat);
    available = available.slice(flat);
    for (const x of top) {
      picked.push(x);
      seen.add(idAt(x.idx));
      guaranteed += 1;
    }
    for (const x of draw(Math.max(0, room - flat))) {
      picked.push(x);
      seen.add(idAt(x.idx));
      sampled += 1;
    }
  }

  // ③ 联想
  const associated = [];
  let assocCandidates = 0;
  let droppedTokens = 0;
  if (assocBudget > 0 && picked.length) {
    const index = buildTokenIndex(list, { maxDocRatio });
    droppedTokens = index.dropped.size;
    const genCap = Number(maxGeneration) > 0 ? Number(maxGeneration) : Infinity;
    let frontier = [...seen];
    for (let gen = 2; gen <= genCap + 1 && frontier.length && associated.length < assocBudget; gen += 1) {
      const others = list.map((_, i) => idAt(i)).filter((id) => !seen.has(id));
      // 只从**最贴近的**几条里往外走（默认前 3）："想起 A 顺带想起 B"里的 B 应该是
      // 共同点最多的那一个，而不是池子里随便谁。不看这条的话，同一个人的事实高度同质，
      // 共享关键词的邻居动辄七八条，联想变成"几乎必然发生"—— 那又是一次确定性。
      const allNeigh = neighborsOf(frontier, others, index, { minShared });
      assocCandidates += allNeigh.length;   // 观测位记**原始**邻居数（截断前）
      const neigh = allNeigh.slice(0, Math.max(1, Number(assocCandidateMax) || 1));
      const next = [];
      for (const hit of neigh) {
        if (associated.length >= assocBudget) break;
        const x = scored.find((s) => idAt(s.idx) === hit.id);
        if (!x) continue;
        const p = alphaOfRecord(x) * recallProbability(gen, mu, sigma);
        if (Number(rng()) < p) {
          associated.push(x.record);
          seen.add(hit.id);
          next.push(hit.id);
        }
      }
      frontier = next;
    }
  }

  // ④ **联想没用掉的额度还给直接召回**。
  //    这一步是必须的：联想额度是预留的，它不成功就留空 —— 表现为"某些轮只想起 6 条"，
  //    日志看着跟模块坏了没区别（这个 bug 是被测试⑫抓出来的，肉眼看不出来）。
  const shortage = Math.max(0, n - (picked.length + associated.length));
  if (shortage > 0) {
    for (const x of draw(shortage)) {
      picked.push(x);
      seen.add(idAt(x.idx));
      sampled += 1;
    }
  }

  const rows = picked.map((x) => x.record).concat(associated);
  const stats = {
    pool: list.length,
    limit: n,
    directLimit,
    assocBudget,
    coreKept: core.slice(0, coreSlots).length,
    candidates: pool.length,
    room,
    guaranteed,
    sampled,
    full,
    assocCandidates,
    associated: associated.length,
    droppedTokens,
    total: rows.length
  };
  return { rows, stats };
}

/**
 * 拼成提示词里的那一段。空的返回空串（一个字都不多占）。
 * ⚠️ 标题必须写清"是当前说话者本人的记忆，不是别人的" ——
 *    否则模型会把 A 的生日说成 B 的（参考包里这条是实测踩出来的）。
 * ⚠️ 必须传 chatKey：不传就只能看到 person 级事实，群内的事一句都不提。
 */
export function formatFactsForPrompt(qq, opts = {}) {
  const {
    limit = 8, chatKey = '', query = '', now = Date.now(),
    sample = false, recallOpts = {}, stats = null
  } = opts;
  // relation 单独成段（见 formatRelationForPrompt）：混在"档案"里会被当成条目念出来
  const rows = listFacts(qq, { limit, chatKey, query, now, sample, recallOpts, stats })
    .filter((f) => f.kind !== 'relation');
  if (!rows.length) {
    // "没记到就说没记到"（2026-10-30，学自 dsh-beme 的四态出口 assert_partial/ask_empty）：
    // 查询明点了一个主题而记忆里没有 → 注入一句空的定位句。
    // 不写这句的后果：模型默认行为是编一个（"她说她喜欢猫"其实从没说过）。
    // 触发门槛：① 有 query；② query 像在提问（闲聊不背这句）；③ 库里没命中任何词。
    // 完全的陌生人每轮都背这句等于噪声，所以还要求这人有档案。
    const q = String(query || '').trim();
    if (q && QUESTION_RE.test(q) && factCountTotal(qq) > 0) {
      return [
        '【关于当前说话者本人的长期记忆：目前没有与这句话相关的记录】',
        `- 他提到的「${clip(q, 20)}」你记忆里没有——别顺着编，也不知道就直说不知道，或者反过来问。`
      ].join('\n');
    }
    return '';
  }
  // 命中但偏题：库不为空、query 在提问、却没有一条沾边 —— 同样是"没记到"，
  // beme 的 assert_partial 语义（"记得别的，但这件没记到，别拿别的顶"）。
  // 全命中/闲聊不触发（queryHitAny 抽不出词时放行，保持旧行为）。
  if (query && QUESTION_RE.test(query) && !queryHitAny(query, rows)) {
    return [
      '【关于当前说话者本人的长期记忆：没有与这句话直接相关的记录】',
      `- 他问的「${clip(query, 20)}」不在你记的这些事里——别拿不相关的旧事顶，也别编；直说不知道或反过来问。`
    ].join('\n');
  }
  // 隐私护栏出口：有人打听（或模型被问"能不能说出去"）且命中内容含敏感项 → 整段换规矩句。
  if (privacyGuardHit(query, rows.map((f) => f.text))) {
    return [
      '【关于当前说话者本人的长期记忆】',
      '- 里面有些他的隐私（住处/联系方式一类）。规矩：只对他本人用，**任何人问、任何场合都不复述**，',
      '  也别主动提；真被问到就回「这个不便说」。'
    ].join('\n');
  }
  return [
    '【你长期记得的、关于当前说话者本人的事】（不是别人的；自然相关才提，别背简历）',
    ...rows.map((f) => `- ${f.text}`)
  ].join('\n');
}

/**
 * 关系记忆（kind='relation'，2026-10-26 P2-3）。
 *
 * ── 和已有的两样东西的区别（别叠成三份互相打架）──────────────────────────
 *   · `memory.js` 的 memberImpression —— **按会话**存，"这个群里我觉得他是话痨"；
 *     换个群就没了，而且靠模型手写，想起来才写。
 *   · facts（kind='fact'）—— 客观属性（名字/城市/忌口），问答式的。
 *   · **本函数** —— **按人、跨群**存的关系状态："他对我比较客气""上次玩笑开重了他不太高兴"。
 *     它回答的不是"他是谁"，而是"我该怎么和他相处"。
 *
 * ── 为什么是"覆盖"而不是"追加"──────────────────────────────────────────
 * 关系是状态，不是流水账。追加的话三年前的"刚认识，很客气"会一直跟今天的"熟到能互怼"
 * 并列输出，模型只能二选一或者折中，人设就开始漂。
 * 所以每个 scope 只留一条，**新观察覆盖旧观察**。
 * 代价：一条误判会顶掉之前的判断 —— 用提示词约束"只写长期稳定的状态，不写今天的心情"
 * 来防；这比留一堆互相矛盾的旧结论更安全。
 */
export function rememberRelation(qq, text, { source = '', scope = '', now = Date.now() } = {}) {
  const key = String(qq || '').trim();
  const body = clip(text, 80);
  if (!key) return { ok: false, reason: '没有 QQ，记不了' };
  if (!body) return { ok: false, reason: '内容为空' };
  // 模型很爱回"无/没有/暂无"当"没什么可写" —— 写进去就成了一条叫"无"的关系
  if (RELATION_PLACEHOLDER_RE.test(body)) return { ok: false, reason: '看着像占位词，不记' };
  if (CRED_RE.test(body)) return { ok: false, reason: '这条看着像凭据，不记' };
  const sc = String(scope) === SCOPES.GROUP ? SCOPES.GROUP : SCOPES.PERSON;

  const st = load(key);
  const prev = st.facts.find((f) => f.kind === 'relation' && String(f.scope || SCOPES.PERSON) === sc);
  if (prev && normalizeKey(prev.text) === normalizeKey(body)) {
    prev.updatedAt = now;
    prev.weight = Math.min(MAX_WEIGHT, prev.weight + 0.1);
    save(st);
    return { ok: true, record: prev, unchanged: true };
  }
  // 先摘掉旧的同 scope 关系，再插新的（不留第二条）
  st.facts = st.facts.filter((f) => !(f.kind === 'relation' && String(f.scope || SCOPES.PERSON) === sc));
  const record = {
    id: newId(),
    text: body,
    kind: 'relation',
    weight: 1,
    createdAt: now,
    updatedAt: now,
    ...(source ? { source: clip(source, 24) } : {}),
    ...(sc === SCOPES.GROUP ? { scope: SCOPES.GROUP } : {})
  };
  st.facts.push(record);
  save(st);
  return { ok: true, record, replaced: prev ? prev.text : '' };
}

/** 取关系记忆（每个 scope 至多一条；按可见性过滤）。 */
export function listRelation(qq, { chatKey = '' } = {}) {
  return load(qq).facts
    .filter((f) => f.kind === 'relation' && factVisibleIn(f, chatKey))
    .map((f) => ({ id: f.id, text: f.text, scope: String(f.scope || SCOPES.PERSON) }));
}

/**
 * 关系段。**空的时候一个字都不占**（大多数新朋友没有关系记忆）。
 * 标题写死"不是今天的心情" —— 不写的话模型会把这条当情绪播报。
 */
export function formatRelationForPrompt(qq, { chatKey = '' } = {}) {
  const rows = listRelation(qq, { chatKey });
  if (!rows.length) return '';
  return [
    '【你和他之间的】（长期关系，不是今天的情绪；说话时自然带着就行，别念出来，也别演）',
    ...rows.map((f) => `- ${f.text}`)
  ].join('\n');
}

/**
 * 遗忘衰减（日常维护，按天增量扣）。
 * 半衰期思路：权重不会线性掉到 0，重要事实因为初始权重高、被提及会强化，
 * 自然分层；闲聊类掉得最快。
 *
 * @param {number} ratePerDay 每天衰减多少权重（默认 0.02 ≈ 50 天掉 1.0）
 */
export function decayFacts({ ratePerDay = 0.02, now = Date.now() } = {}) {
  const rate = Math.max(0, Number(ratePerDay) || 0);
  if (!rate) return { changed: 0 };
  let changed = 0;
  for (const st of cache.values()) {
    let dirty = false;
    for (const f of st.facts) {
      // 休眠/墓碑/candidate/被替代是终态或待定态：衰减不再扣分
      //（candidate 本来就不参与注入，等它转正后从满权重起算，不该被待业期偷偷扣光）。
      if (f.tombstone || f.dormant || f.status === 'candidate' || f.supersededAt) continue;
      // 雷点 / 规矩**不衰减**（2026-10-26 修：这条以前只写在注释里，代码无差别衰减）。
      // 语义上它们不是"记不记得住"的问题 —— 过敏和"别叫我某某"不该因为三个月没提就淡出。
      // ⚠️ 只豁免 kind，不豁免高权重：weight≥1.2 的普通事实照样衰减（那是"提过两次"，不是"不能丢"）。
      if (f.kind === 'rule' || f.kind === 'negative') continue;
      const days = Math.max(0, (now - (Number(f.updatedAt) || now)) / 86400000);
      if (days <= 0) continue;
      const next = Math.max(0, f.weight - rate * days);
      if (next !== f.weight) {
        f.weight = next;
        f.updatedAt = now;   // 增量记账：下次只算"这一次之后"的天数，不会重复扣
        dirty = true;
        changed += 1;
      }
    }
    if (dirty) save(st);
  }
  return { changed };
}

/**
 * 低权重事实淡出（2026-10-29 起 = **休眠**，不再物理删除）。
 *
 * 语义修正（对照《记忆模型-对外版》判据 3 /《蒸馏版》陷阱二）：
 *   日常所谓"淡忘" → 召回权重降到注入线以下，退出默认上下文；
 *   原文/记录      → 永久保留，问到还能翻到；
 *   物理删除       → 只有用户明确说"忘掉/删掉/别记着"（forgetFact，且带墓碑）。
 * 以前这里直接把记录从数组里滤掉 —— "想不起来"被实现成了"没了"，
 * 而且反思链会重读归档，删掉的过几天又被提取回来（删了也白删，还丢了"淡出过"的信息）。
 *
 * 现在打 `dormant: true`：召回端跳过（listFacts / scoreFactRecords 双重过滤），
 * 上限裁剪与衰减不再碰它（相当于冻结），真实重提可经 dormantRevive() 唤醒。
 * 唯一保留物理删除语义的地方：`trimToFacts` 类的容量裁剪 —— 那是配额，不是遗忘。
 *
 * @returns {{removed:number, dormant:number, revived:number}} removed 保留为 0 只为兼容旧日志格式
 */
export function forgetWeakFacts({ minWeight = 0.3, qq = '', now = Date.now(), reason = '低于注入线，自然淡出' } = {}) {
  const list = qq ? [load(qq)] : [...cache.values()];
  let dormantCount = 0;
  let revived = 0;
  for (const st of list) {
    let dirty = false;
    for (const f of st.facts) {
      if (f.tombstone || f.dormant) continue;                     // 已有终态的不动
      if (f.kind === 'negative' || f.kind === 'rule') continue;   // 雷点与规矩永不淡出
      if (f.weight >= minWeight) continue;
      f.dormant = true;
      f.dormantAt = now;
      f.dormantReason = String(reason).slice(0, 80);
      dirty = true;
      dormantCount += 1;
    }
    if (dirty) save(st);
  }
  return { removed: 0, dormant: dormantCount, revived };
}

/**
 * 显式遗忘：用户明确说"忘掉/删掉/别记着"时才走这里。
 *
 * 与自然淡出的三点区别（判据 3 的后半句）：
 *   ① 墓碑：留在原位（不删记录、不删数组槽位），带时间与原因；检索端永远排除，
 *      防止反思链从归档里把它"重新学到"；重复提及也不强化（rememberFact 已挡）。
 *   ② 不看 kind：雷点/规矩只要是用户本人要求忘的，也照忘（主人意志 > 默认保护）。
 *   ③ 物理删除不属于本功能：记录本体仍在 JSON 里，数据治理另行处理。
 *
 * @param {string} qq
 * @param {string} match  事实文本（支持包含匹配，归一化后比对）
 * @returns {{ok:boolean, count:number, records:Array, reason?:string}}
 */
export function forgetFact(qq, match, { now = Date.now(), reason = '用户要求遗忘' } = {}) {
  const key = String(qq || '').trim();
  const needle = normalizeKey(match);
  if (!key) return { ok: false, count: 0, records: [], reason: '没有 QQ' };
  if (!needle) return { ok: false, count: 0, records: [], reason: '没说要忘哪条' };
  const st = load(key);
  const hit = st.facts.filter((f) => !f.tombstone && normalizeKey(f.text).includes(needle));
  for (const f of hit) {
    f.tombstone = true;
    f.tombstoneAt = now;
    f.tombstoneReason = String(reason).slice(0, 80);
    delete f.dormant;          // 墓碑是更强的终态，休眠位让位
    delete f.dormantAt;
    delete f.dormantReason;
  }
  if (hit.length) save(st);
  return { ok: hit.length > 0, count: hit.length, records: hit.map((f) => ({ id: f.id, text: f.text })), reason: hit.length ? '' : '没有匹配的事实' };
}

/**
 * 唤醒休眠事实：只有**真实重提**才允许走这里（对应方案 R3"被真实用户再次提及可提高保留优先级"）。
 * 机器人自己的总结、后台重读、检索命中**不算** —— 防错误自我强化，所以不提供批量接口。
 *
 * 【2026-10-31，P2-2：忘了又想起，要记得更牢】
 * 学自 MaiMBot-LPMM 的拟人脑遗忘设计："再次检索到已遗忘的节点 → 重新激活并给更高权重"，
 * 与我们的休眠位本来就同构，只是我们以前**只复活、不加权**：weight 回 0.6 就跟一条新事实一样，
 * 于是"以前被淡出过、但这个人又提起过三次"和"第一次听说"在召回里毫无区别。
 *
 * 做法：复活时按次数递增 —— 第 1 次回 0.6，之后每复活一次 +0.25（封顶 MAX_WEIGHT）。
 * 上限只到 1.1 附近就不再涨（MAX_WEIGHT=2 但这里给个软顶）：反复淡入淡出本身是信号，
 * 不该让它涨成"核心项"去挤占 rule/negative 的名额 —— 那是社交事故级的误判。
 */
export function dormantRevive(qq, factId, { now = Date.now() } = {}) {
  const st = load(qq);
  const f = st.facts.find((x) => x.id === String(factId || ''));
  if (!f || !f.dormant || f.tombstone) return null;
  delete f.dormant;
  delete f.dormantAt;
  delete f.dormantReason;
  const times = (Number(f.reviveCount) || 0) + 1;
  f.reviveCount = times;
  f.reviveAt = now;
  // 唤醒即回到"值得竞争注入"的区间；复活史越长越牢（软顶 1.1，见上）。
  const base = 0.6 + Math.max(0, times - 1) * 0.25;
  f.weight = Math.min(MAX_WEIGHT, Math.max(Number(f.weight) || 0.1, Math.min(1.1, base)));
  f.updatedAt = now;
  save(st);
  return { id: f.id, text: f.text, weight: f.weight, reviveCount: times };
}

/** 某个 QQ 的事实条数（面板/排查用）。
 *  2026-10-29 起休眠/墓碑不物理删除，`factCount` 改报**活跃**数（进得来召回的），
 *  总量看 factCountTotal —— 否则"忘掉的"还在数字里，面板会说谎。 */
export function factCount(qq) {
  return load(qq).facts.filter((f) => !f.dormant && !f.tombstone && f.status !== 'candidate').length;
}

/** 含休眠与墓碑的总条数（数据治理/备份核对用）。 */
export function factCountTotal(qq) {
  return load(qq).facts.length;
}

/** 丢掉内存缓存（测试用）。 */
export function resetFactsCache() {
  cache.clear();
}

/**
 * 把磁盘上**所有人**的事实载入缓存，返回新载入的人数。
 *
 * 为什么每日维护前必须调它：`decayFacts` / `forgetWeakFacts` 只遍历 `cache.values()`，
 * 而缓存是"谁被 @ 过就载入谁"。不预热的话，重启之后那一整天只有零星几个人会被衰减，
 * 其他人的事实永远不动 —— 表现为"衰减看着在跑，其实只管了个零头"。
 */
export function loadAllFacts() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let loaded = 0;
  for (const f of files) {
    const qq = f.replace(/\.json$/, '');
    if (!qq || cache.has(qq)) continue;
    load(qq);
    loaded += 1;
  }
  return loaded;
}

/**
 * 组装"提取事实"的提示词（**纯函数**，测试可直接断言内容）。
 *
 * @param {{name:string, who:string, lines:string[], relation?:boolean}} p
 *   name 当前说话者的昵称；who 他的 QQ（用来要求事实带上主语）
 *   relation=true 时额外要一条"关系状态"（只有反思层用；实时提取不写关系，见 rememberRelation）
 */
export function buildExtractionPrompt({ name = '', who = '', lines = [], relation = false } = {}) {
  const label = String(name || '').trim() || '这个人';
  const head = relation
    ? [`{"facts": [{"text": "${label}...", "scope": "person", "kind": "fact"}], "relation": "${label}..."}`]
    : [`{"facts": [{"text": "${label}...", "scope": "person", "kind": "fact"}]}`];
  // kind 的说明（P4.2，2026-10-26）：不加这段，三条保护逻辑永远没对象。
  const kindRules = [
    'kind 三种取值（不写就按 "fact"）：',
    '· "fact"     —— 普通属性：称呼、生日、城市、职业、稳定偏好。**绝大多数都是这个**',
    '· "negative" —— 他的雷点/忌讳：过敏、明确讨厌的事、绝对别提起的话题',
    '· "rule"     —— 他给你立的规矩：别怎么称呼他、什么情况别打扰他',
    '⚠️ 只有**真会冒犯到人**的才标 negative/rule。一批里标太多系统会按比例降级回 fact；',
    '拿不准一律 "fact"。'
  ];
  const relationRules = relation
    ? [
      '',
      '`relation` 只写一条：**只对这个人成立**的相处分寸（你该怎么和他说话）。',
      '· 25 字以内。**不要写性格标签，要写具体做法**；',
      '· **禁止泛泛而谈**：「说话随意」「爱开玩笑」「很友好」「聊得来」这类放到谁身上都成立的话，一律不许写；',
      '· 好例子：「他爱拿你的音色开玩笑，可以顺着自嘲」／「他要歌时总说只唱一句，其实要整首」／',
      '　「他正经问技术时别玩梗」／「他不太喜欢被追问私事，问一句就停」；',
      '· 看不出具体的东西就写空字符串 ""。**宁可没有，也不要写一句对谁都成立的废话** ——',
      '　这条会每轮出现在提示词里，写空话等于给自己装一句口头禅；',
      '· 这条会**覆盖**上一次的关系判断，所以只在真看清了才写。'
    ]
    : [];
  return [
    '请分析下面这段对话，只输出一个 JSON 对象，不要输出任何别的文字：',
    ...head,
    '',
    `只提取关于「${label}」（QQ ${who || '未知'}）**本人**的事实，最多 ${MAX_FACTS_PER_EXTRACT} 条；没有值得记的就输出 {"facts": []}。`,
    '记这些（一年后仍然有用）：',
    '1. 称呼/名字（他让你怎么叫他）  2. 生日、年龄  3. 城市/学校/职业/身份',
    '4. 重要约定（约好一起做什么、答应过什么）  5. 重大事件（生病、升学、搬家、失去亲人）',
    '6. 持久偏好与兴趣（爱吃什么、常玩什么）  7. 雷点/忌讳（过敏、明确讨厌的事）',
    '8. 稳定的说话习惯（口头禅、爱开玩笑还是正经）',
    '不要记：一次性的闲聊、临时话题、当下的心情、随口一提没发生的事、**别人说的事**。',
    // 四条提取禁令（2026-10-30，学自 dsh-beme 的 segmentPrompt，逐条带它的实测理由）：
    //   ① 一条只写一件事 —— 防串人的提取侧版本（多人刷屏按"谁说了什么"拆，不整段塞成一条）；
    //   ② 玩笑/反讽不提取 —— 对外版判据 1：模型判"是不是玩笑"经常错，宁可不进，不可误当事实
    //      （「我明天就把你卖了」进承诺、「嗯嗯」变「她说好」就是这种）；
    //   ③ 保留原话口气 —— 提取时美化是"摘要走形"的第一成因（顺比错难查）；
    //   ④ 同一人不同叫法不当两个人 —— 召回侧 matchMember 已挡重名，提取侧补一句。
    '一条事实只写一件事；对话里几个人插话时，只看「' + label + '」说了什么，别把别人的话并成一条。',
    '玩笑、反讽、气话**一律不提取**——宁可少记一条，不可把闹着玩的话记成他真实的想法或承诺；',
    '纯表情、单字应答（嗯/哦/行）、复读也不算语料。',
    '用他自己的措辞记，不改写成书面语，不替他美化或补全原因；他没说原因就不知道原因。',
    '同一个人的不同叫法（本名/群名片/外号）指的是同一个人，不要当成两个人的事。',
    `每条不超过 30 字，**必须以「${label}」开头**（例：${label}对花生过敏）。`,
    'scope 只有两种取值：',
    '· "person" —— 这个人的属性，换个群也成立（名字、生日、城市、职业、忌口、稳定偏好）',
    '· "group"  —— 只属于当前这个群的事（群规、群里的梗、只在群里成立的约定）',
    '拿不准就写 "person"。',
    ...kindRules,
    ...relationRules,
    '对话里"我"是机器人自己，"对方"是这个人；不要把机器人自己的信息记到他头上。',
    '',
    '对话内容：',
    ...(Array.isArray(lines) && lines.length ? lines : ['（无）'])
  ].join('\n');
}

/** 群内语境的兜底关键词：模型没给 scope 时用它猜（宁可选 person，这条只是补漏）。 */
const RE_GROUP = /(群规|群里|群内|本群|这个群|大家|咱们群|以后都)/;

/** 从模型输出里抠出那个 JSON 对象（带 ```json 围栏/前后废话一律容错）。 */
function parseJsonBody(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let body = raw;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) body = fence[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) body = body.slice(start, end + 1);
  try { return JSON.parse(body); } catch { return null; }
}

/**
 * 解析提取结果（带 scope 与 kind）。模型经常带 ```json 围栏或前后废话，这里一律容错；
 * 解析失败返回空数组（**绝不让一次格式错误变成一条编造的记忆**）。
 * 兼容三种写法：`["..."]`（最老）、`[{"text","scope"}]`、`[{"text","scope","kind"}]`。
 *
 * ── kind 是 2026-10-26 补的（原来是空转的通道）────────────────────────────
 * `rankFactRecords` 的"核心项先占 60%"、`decayFacts` 的"rule/negative 豁免衰减"、
 * `forgetWeakFacts` 的"negative 不删"—— 三条保护全依赖 kind，但提示词只让模型输出
 * `{text, scope}`，于是**落库的全是 kind='fact'**：真机 102 条里 rule/negative 是 0，
 * 保护逻辑一次都没触发过。现在让模型标两类：
 *   · negative —— 他的雷点/忌讳（过敏、明确讨厌的事、别提的话题）
 *   · rule     —— 他给你立的规矩（"别叫我某某""别在他在时发语音"）
 * 两者都是"丢了会直接冒犯人"，所以走核心保护。
 *
 * ⚠️ **必须防滥标**：模型很容易把所有事实都标成 negative 来"求别丢"，那样等于没有保护
 * （全都豁免衰减 = 全都不衰减）。所以一批里核心项最多占一半，超出的降级为 fact。
 * @returns {Array<{text:string, scope:'person'|'group', kind:'fact'|'negative'|'rule'}>}
 */
export function parseExtractionDetailed(text, { name = '' } = {}) {
  const data = parseJsonBody(text);
  if (!data) return [];
  const list = Array.isArray(data?.facts) ? data.facts : [];
  const label = String(name || '').trim();
  const out = [];
  for (const item of list.slice(0, MAX_FACTS_PER_EXTRACT)) {
    const rawText = typeof item === 'string' ? item : item?.text;
    const hinted = typeof item === 'object' && item ? String(item.scope || '').trim().toLowerCase() : '';
    const s = clip(rawText, 60);
    if (!s) continue;
    // 弱句闸门（2026-10-30，对照对外版判据 1"弱"档）：提示词是引导，这里是闸门 ——
    // 模型不一定听话，"测试一嗯嗯"这种条目一旦落库就是永久注入的假事实。
    // 判据：去掉主语和标点后只剩应答词/单字/语气复读 → 丢弃。
    if (isWeakUtterance(s, label)) continue;
    // 防串人：模型漏写主语时补上，而不是丢掉（丢掉会让"记不住"变成常态）
    const withSubject = label && !s.startsWith(label) && !/^\d{5,12}/.test(s) ? `${label}${s}` : s;
    const scope = hinted === SCOPES.GROUP || (!hinted && RE_GROUP.test(withSubject)) ? SCOPES.GROUP : SCOPES.PERSON;
    const hintedKind = typeof item === 'object' && item ? String(item.kind || '').trim().toLowerCase() : '';
    const kind = hintedKind === 'negative' || hintedKind === 'rule' ? hintedKind : 'fact';
    if (!out.some((x) => x.text === withSubject)) out.push({ text: withSubject, scope, kind });
  }
  return limitCoreFacts(out);
}

/** 查询像在"问一个问题"（四态出口的触发门槛之一：闲聊不该背"没记到"提示）。 */
const QUESTION_RE = /[?？]|吗[。？?！!]?$|^(什么|怎么|为什么|哪|哪里|哪个|谁|几|多少|多久|什么时候|是不是|有没有|记不记得|还记不记得)|记不记得|什么|哪[个里天家儿]|几[点个号月岁]|多(少|久)|怎么样|如何/;

function queryHitAny(query, rows) {
  // 粒度刻意放宽到**单字**：偏题判断的漏放代价只是少一句提示（安全），
  // 误判的代价是真记得却被说成"没记到"（伤人）。"他住哪个区" vs "家住幸福小区"
  // 二元组无交集但共享"住/区"，单字层就该算沾边。
  const chars = new Set(String(query || '').match(/[\u4e00-\u9fa5]/g) || []);
  if (!chars.size) return true;   // 抽不出中文字就不谈"命中"
  for (const f of rows) {
    const hay = new Set(String(`${f.text} ${f.target ?? ''}`).match(/[\u4e00-\u9fa5]/g) || []);
    for (const c of chars) if (hay.has(c)) return true;
  }
  return false;
}

/**
 * 弱句判据（纯函数，测试可直接断言）。
 * 「弱」= 去掉主语、标点、语气词后没有实际内容。例（label=小明）：
 *   「小明嗯嗯」「小明说好」「小明哈哈」「小明？？」→ 弱
 *   「小明对花生过敏」「小明说周四交报告」→ 非弱
 * 注意"说好/说行"这种是复读语气，不算承诺——真正的承诺会写成"小明答应周四交"。
 */
const WEAK_FILLERS = /^(嗯+|哦+|噢+|啊+|哈+|嘿+|哼+|呃|诶|欸|行+|好+|中|要得|ok|okay|嗯呢|好滴|好嘞|是的|对对+|是吧|哦哦+)+$/i;

export function isWeakUtterance(text, label = '') {
  let s = String(text ?? '').trim();
  if (!s) return true;
  if (label) {
    // 主语通常无分隔地贴在开头（"小明嗯嗯"），也可能带引导（"小明说：嗯嗯"）。
    // 先剥"昵称+引导词"前缀，再把剩余部分按标点切开逐段判 —— 任何一段是弱内容即整条弱。
    let rest = s;
    if (rest.startsWith(label)) rest = rest.slice(label.length).replace(/^(说|表示|回答|回|道)[：:，,\s]*/, '');
    const parts = rest.split(/[，,。；;！!？?\s]+/).map((x) => x.trim()).filter(Boolean);
    const bareAll = parts.map((p) => p.replace(/[\s\p{P}\p{S}]/gu, ''));
    if (!bareAll.length || bareAll.every((b) => !b)) return true;      // 纯标点
    if (bareAll.every((b) => [...b].length <= 1)) return true;         // 单字（判据 1"弱"档）
    if (bareAll.every((b) => WEAK_FILLERS.test(b))) return true;       // 纯应答/语气复读
    return false;
  }
  const bare = s.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!bare) return true;
  if ([...bare].length <= 1) return true;
  if (WEAK_FILLERS.test(bare)) return true;
  return false;
}

/**
 * 核心项占比封顶：一批里 rule/negative 最多占一半（至少 1 条）。
 * 超出的**降级成 fact**，不丢内容 —— 只是不再享受"不衰减/优先占位"。
 * 理由见 parseExtractionDetailed 的注释：滥标等于取消保护。
 */
function limitCoreFacts(list) {
  const arr = Array.isArray(list) ? list : [];
  // ceil 而不是 floor：一批只有 3 条时 floor 只给 1 个名额，而"两条真雷点"很常见。
  const cap = Math.max(1, Math.ceil(arr.length / 2));
  let used = 0;
  return arr.map((f) => {
    if (f?.kind !== 'negative' && f?.kind !== 'rule') return f;
    used += 1;
    return used <= cap ? f : { ...f, kind: 'fact' };
  });
}

/**
 * 反思层用：一次解析出 `{facts, relation}`。
 * 与 `parseExtractionDetailed` 的区别只是多拿 `relation` 那一条 —— facts 的解析规则完全共用，
 * 免得两份实现慢慢分叉（本项目踩过：判据写两遍，拆一处另一处兜住）。
 */
export function parseReflectionOutput(text, { name = '' } = {}) {
  const data = parseJsonBody(text);
  const relation = clip(data?.relation, 80);
  // relation 里混进了"无/没有/暂无"这类占位 → 当没写
  const clean = relation && !/^(无|没有|暂无|none|null|n\/a|不确定)$/i.test(relation) ? relation : '';
  return { facts: parseExtractionDetailed(text, { name }), relation: clean };
}

/** 只要文本的简版（老调用方/测试用）。 */
export function parseExtraction(text, { name = '' } = {}) {
  return parseExtractionDetailed(text, { name }).map((x) => x.text);
}
