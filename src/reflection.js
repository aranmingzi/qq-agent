// 反思层（reflection）：把"没人 @ 我"的那些消息也消化成长期记忆。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
// 现有的 `#maybeExtractFacts`（memory-facts.js）只在**被唤醒时**跑，而且只提取
// `primarySpeaker` 一个人的发言。后果是：群里其他人聊一年，facts 里也不会多一条 ——
// 于是"她只记得被点名的人"，这跟"有长期记忆"是两回事。
//
// 反思层的分工：
//   · 触发：不看"有没有人叫我"，看"有没有没处理过的消息"（条数或空闲时长）
//   · 范围：整段对话里的**每个活跃发言者**，各自单独喂一次（防串人的铁律）
//   · 幂等：按 `uptoId` 游标走，处理过的不再处理
//   · 预算：每次最多几人、每天最多几轮、积压太多就只处理最近的
//
// ── 三条纪律（都是踩过的坑）─────────────────────────────────────────────
// ① **按人分组单独喂**，绝不把整群对话一次性丢给模型：一次把 A 说 B 的事记到 A 头上，
//    比"记不住"严重得多（memory-facts.js 文件头也写着这条）。
// ② **只喂原始消息**，不喂 facts / memory / summary：否则反思会读到自己的产出，
//    自我强化、越记越偏。
// ③ **只给"这个人说的话 + 紧接着我的回复"**：我的回复里带着上下文，但**别人的话不进** ——
//    这比"整批 self 消息全塞进去"更严，也顺带压掉了串人面。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

const DIR = path.join(DATA_DIR, 'reflection');

export const REFLECT_DEFAULTS = Object.freeze({
  minPending: 20,            // 攒够多少条未处理就立刻反思
  minLinesPerPerson: 3,      // 一个人至少说几句才值得单独喂一次
  maxPerRun: 60,             // 单次最多取多少条消息（从最旧的开始）
  maxPeople: 6,              // 单次最多给几个人各调一次模型（冷启动期宽一点，见 planRun）
  refreshPeoplePerRun: 2,    // 都有关系记忆之后，每轮只刷新几个熟人（覆盖式，刷多了纯浪费）
  idleMs: 10 * 60 * 1000,    // 未处理不多时，安静这么久也反思一次
  // 每日额度（2026-10-26 改）：原来是死数 3，真机发现下午 19:51 就烧完了，
  // 之后一小时群里 20+ 条消息**一条都没学到**。改成「按处理量给额度」：
  //   allowed = clamp(1 + ⌊processed / runsPerMessages⌋, minRunsPerDay, maxRunsPerDay)
  // processed 是当天累计喂进去的消息条数 —— 聊得多就多学几次，冷清就少花点钱。
  maxRunsPerDay: 8,          // 硬上限（成本闸）
  minRunsPerDay: 3,          // 保底（等于旧的固定 3，低活跃会话不多花钱）
  runsPerMessages: 40,       // 每处理 40 条消息 +1 次额度
  backlogSkip: 600           // 积压超过这个数就只处理最近的一段（否则永远在补历史）
});

const pad2 = (n) => String(n).padStart(2, '0');
export function dayKeyOf(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function slug(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

/** 取未处理的消息（游标之后），按 id 升序（旧 → 新）。 */
export function pickUnprocessed(messages, uptoId = 0) {
  const floor = Number(uptoId) || 0;
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && Number.isFinite(Number(m.id)) && Number(m.id) > floor)
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * 今天允许跑几轮（纯函数，测试直接断言）。
 *
 * 为什么不是死数：固定 3 次对"一天说 500 句的群"和"一天说 20 句的群"一视同仁，
 * 前者下午就把额度烧完、晚上的对话一条都学不到；后者根本用不完。
 * 按 processed（当天累计喂进去的消息条数）给额度，才是"聊得多才值得多花"。
 */
export function allowedRunsToday({ runs = 0, processed = 0, cfg = {} } = {}) {
  const c = { ...REFLECT_DEFAULTS, ...(cfg || {}) };
  const hard = Math.max(1, Number(c.maxRunsPerDay) || 8);
  const floorRuns = Math.max(1, Math.min(hard, Number(c.minRunsPerDay) || 3));
  const per = Math.max(1, Number(c.runsPerMessages) || 40);
  const earned = 1 + Math.floor(Math.max(0, Number(processed) || 0) / per);
  return Math.max(floorRuns, Math.min(hard, earned));
}

/**
 * 该不该反思（纯函数，测试直接断言）。
 * @param {{pending:number, idleMs:number, state:object, cfg:object, now:number}} p
 * @returns {{go:boolean, reason:string, runs:number, allowed:number}}
 */
export function shouldReflect({ pending = 0, idleMs = 0, state = {}, cfg = {}, now = Date.now() } = {}) {
  const c = { ...REFLECT_DEFAULTS, ...(cfg || {}) };
  const today = dayKeyOf(now);
  const sameDay = state?.dayKey === today;
  const runs = sameDay ? Number(state?.runs) || 0 : 0;
  const processed = sameDay ? Number(state?.processed) || 0 : 0;
  const allowed = allowedRunsToday({ runs, processed, cfg: c });
  if (pending < c.minLinesPerPerson) return { go: false, reason: 'empty', runs, allowed };
  if (runs >= allowed) return { go: false, reason: 'budget', runs, allowed };
  if (pending >= c.minPending) return { go: true, reason: 'count', runs, allowed };
  if (idleMs >= c.idleMs) return { go: true, reason: 'idle', runs, allowed };
  return { go: false, reason: 'wait', runs, allowed };
}

/**
 * 这条消息的发送者是不是"真人"。
 *
 * 真机推演暴露的问题：群里有很多**系统事件**也带 senderName ——
 * 「（拍一拍事件）」「」这种。它们混进人名单会白白多调一次模型，
 * 更糟的是模型会一本正经地从里面提取"事实"。
 */
const SYSTEM_NAME_RE = /(拍一拍|事件|系统消息|撤回了一条|加入了?群|退出了?群|开启了好友|以上是打招呼)/;

export function isHumanSender(m) {
  if (!m || m.self) return false;
  const id = String(m.senderId ?? '').trim();
  if (!id || id === 'self' || id === '0') return false;
  const name = String(m.senderName ?? '').trim();
  if (!name) return false;                      // 没名字的基本都是系统事件
  if (SYSTEM_NAME_RE.test(name)) return false;
  return true;
}

/**
 * 只取"这个人说的话 + **紧跟着**我的回复"。
 * 别人的话一律不进 —— 这是防串人的第一道闸。
 */
export function buildPersonLines(batch, personId, { selfLabel = '我', maxChars = 80 } = {}) {
  const who = String(personId || '').trim();
  if (!who) return [];
  const out = [];
  let lastSpeaker = '';
  for (const m of Array.isArray(batch) ? batch : []) {
    const text = String(m?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (m.self) {
      // 只收"紧跟在他说完之后"的回复；连续两条 self 仍算同一个人的后续
      if (lastSpeaker === who) out.push(`${selfLabel}：${text.slice(0, maxChars)}`);
      continue;
    }
    lastSpeaker = String(m.senderId || '').trim();
    if (lastSpeaker === who) out.push(`${String(m.senderName || '对方')}：${text.slice(0, maxChars)}`);
  }
  return out;
}

/**
 * 规划一轮反思（纯函数）。
 *
 * 返回里同时给出"这次要处理到哪个 id"（nextUptoId）和"被跳过的人"（skipped/dropped），
 * 方便日志里看出"为什么这轮没提某人"，而不是静默什么都不做。
 *
 * @param {{messages:Array, uptoId:number, cfg:object, hasRelation?:Function}} p
 *   hasRelation(id) → 这个人是否已有关系记忆。传了就会**优先给还没有的人**（冷启动优先），
 *   否则永远是最活跃的那 4 个人被反复提取，其余人一辈子拿不到关系判断。
 */
export function planRun({ messages = [], uptoId = 0, cfg = {}, hasRelation = null } = {}) {
  const c = { ...REFLECT_DEFAULTS, ...(cfg || {}) };
  const pending = pickUnprocessed(messages, uptoId);
  if (!pending.length) return { batch: [], people: [], nextUptoId: Number(uptoId) || 0, pending: 0, skipped: [], dropped: [], jumped: false };

  // 积压太多：只处理最近一段（否则每轮 60 条，永远追不上历史）
  const backlogLimit = Math.max(0, Number(c.backlogSkip) || 0);
  const jumped = backlogLimit > 0 && pending.length > backlogLimit;
  const batch = jumped ? pending.slice(-Number(c.maxPerRun)) : pending.slice(0, Number(c.maxPerRun));
  const nextUptoId = Number(batch[batch.length - 1].id);

  const groups = new Map();
  for (const m of batch) {
    if (!isHumanSender(m)) continue;
    const id = String(m.senderId || '').trim();
    if (!groups.has(id)) groups.set(id, { id, name: String(m.senderName || '').trim(), count: 0 });
    groups.get(id).count += 1;
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const worthy = ranked.filter((g) => g.count >= Number(c.minLinesPerPerson));
  // 冷启动优先（P4.4，2026-10-26）：还没关系记忆的人排前面，已有的人排后面兜底。
  // 起因：真机存量 5 条关系记忆，但最近 90 轮提示词里**一次都没注入** ——
  //   每轮都取"发言最多的 4 个人"，就是那几个熟人反复被提取，新面孔永远轮不到。
  // 组内仍按发言量排序（说得多的人更值得看清楚）。
  const known = typeof hasRelation === 'function' ? hasRelation : () => false;
  const fresh = [];
  const seen = [];
  for (const g of worthy) (known(g.id) ? seen : fresh).push(g);
  // 冷启动期：名额全给新面孔；都覆盖过了：每轮只刷新少数几个熟人。
  // 为什么不全给熟人：关系记忆是**覆盖式**的（每 scope 一条），刷新 6 个熟人 = 白烧 6 次调用，
  // 而新面孔一次都拿不到。冷启动优先 + 之后低频刷新，总调用数反而比原来（固定 4 人）更省。
  const cap = Math.max(1, Number(c.maxPeople) || 6);
  const refreshCap = Math.max(1, Number(c.refreshPeoplePerRun) || 2);
  const chosen = fresh.length ? fresh.slice(0, cap) : seen.slice(0, Math.min(cap, refreshCap));
  const people = chosen
    .map((g) => ({ id: g.id, name: g.name, lines: buildPersonLines(batch, g.id) }))
    .filter((p) => p.lines.length > 0);

  return {
    batch,
    people,
    nextUptoId,
    pending: pending.length,
    jumped,
    skipped: worthy.slice(Number(c.maxPeople)).map((g) => `${g.name || g.id}(${g.count})`),
    dropped: ranked.filter((g) => g.count < Number(c.minLinesPerPerson)).map((g) => `${g.name || g.id}(${g.count})`)
  };
}

/**
 * 反思游标：`data/reflection/<会话>.json`。
 * 坏文件由 readJsonSafe 兜底（当成"从没反思过"），这里不再自己写 try/catch 层。
 */
export class ReflectionCursor {
  #cache = new Map();

  fileOf(chatKey) {
    return path.join(DIR, `${slug(chatKey)}.json`);
  }

  get(chatKey) {
    const key = String(chatKey || '');
    if (this.#cache.has(key)) return this.#cache.get(key);
    const raw = readJsonSafe(this.fileOf(key), null);
    const runs = Number(raw?.runs) || 0;
    // processed 是 2026-10-26 新加的字段，老游标文件里没有。
    // 不给迁移默认值的话，新额度机制对"今天已经跑过几次"的会话完全无效
    // （processed=0 → allowed 恒等于保底 3 → 照样撞 budget）。
    // 按每轮约 40 条保守估（maxPerRun 是 60），只影响当天，跨天自然归零。
    const processed = raw?.processed === undefined && runs > 0
      ? runs * (Number(REFLECT_DEFAULTS.runsPerMessages) || 40)
      : Number(raw?.processed) || 0;
    const st = {
      uptoId: Number(raw?.uptoId) || 0,
      dayKey: String(raw?.dayKey || ''),
      runs,
      processed,                                // 当天累计喂进去的消息条数（额度按它算）
      lastRunAt: Number(raw?.lastRunAt) || 0
    };
    this.#cache.set(key, st);
    return st;
  }

  /**
   * 推进游标并记一次运行。
   * ⚠️ 跨天自动把 runs / processed 归零（否则昨天跑满，今天一整天都不反思了）。
   * @param {{uptoId?:number, now?:number, counted?:boolean, processed?:number}} p
   *   processed 是本次**实际喂给模型**的消息条数，累加到当天总额度里。
   */
  commit(chatKey, { uptoId, now = Date.now(), counted = true, processed = 0 } = {}) {
    const st = this.get(chatKey);
    const today = dayKeyOf(now);
    if (st.dayKey !== today) { st.dayKey = today; st.runs = 0; st.processed = 0; }
    st.uptoId = Math.max(Number(st.uptoId) || 0, Number(uptoId) || 0);
    st.lastRunAt = now;
    if (counted) st.runs += 1;
    st.processed = Math.max(0, Number(st.processed) || 0) + Math.max(0, Number(processed) || 0);
    writeJsonAtomic(this.fileOf(chatKey), st);
    return st;
  }

  reset() { this.#cache.clear(); }
}

/** 目录是否存在（控制台/排查用）。 */
export function reflectionDirExists() {
  try { return fs.existsSync(DIR); } catch { return false; }
}
