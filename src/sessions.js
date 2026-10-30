// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';
import { emptyUsage, addUsage, addUsageForModel } from './llm.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 按天归档的用量：data/usage/<YYYY-MM-DD>.json
// 存在的理由：usage-today.json 在跨天时**直接重置**（dayKey 一变就不沿用旧值），
// 历史数字当天过后就没了；sessions/*.json 又只留 keepSessionFiles 个文件，
// 高并发几小时就能把当天白天的明细滚掉。所以这里单独留一份按天累加、不随会话文件清理的账。
const USAGE_DIR = path.join(DATA_DIR, 'usage');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionRegistry {
  constructor(keepFiles = 300) {
    this.keepFiles = Math.max(20, Number(keepFiles) || 300);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      for (const f of files.slice(0, this.keepFiles)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          if (data?.id) this.index.push(this.#summary(data));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // running | done | noreply | error | aborted
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      usageByModel: s.usageByModel ?? s.usage?.models ?? null,
      model: s.model ?? '',
      modelChain: Array.isArray(s.modelChain) ? s.modelChain : [],
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0
    };
  }

  create({ chatKey, trigger, triggerSummary }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      modelChain: [],
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0, models: {}, byRate: { peak: null, off: null } }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) this.#persist(s);
    return s ?? null;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
      if (files.length > this.keepFiles) {
        for (const f of files.slice(0, files.length - this.keepFiles)) {
          try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs };
  }

  /** 在会话结束时累加今日用量（并写入按天归档）。 */
  #bumpTodayUsage(s) {
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.cachedTokens = (Number(data.cachedTokens) || 0) + (Number(s.usage.cachedTokens) || 0);
    data.byRate = mergeByRate(data.byRate, s.usage.byRate);
    data.runs += 1;
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));
    this.#bumpUsageDay(s, dayKey);
  }

  /** 把一轮会话的用量并进 data/usage/<dayKey>.json（按天累加，永不跨天重置）。 */
  #bumpUsageDay(s, dayKey) {
    const file = path.join(USAGE_DIR, `${dayKey}.json`);
    const prev = readJsonSafe(file, null);
    const acc = prev?.dayKey === dayKey ? prev : {
      dayKey,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      runs: 0,
      calls: 0,
      models: {},
      firstAt: s.startedAt,
      lastAt: s.startedAt
    };
    acc.promptTokens += s.usage.promptTokens || 0;
    acc.completionTokens += s.usage.completionTokens || 0;
    acc.totalTokens += s.usage.totalTokens || 0;
    acc.cachedTokens = (Number(acc.cachedTokens) || 0) + (Number(s.usage.cachedTokens) || 0);
    acc.byRate = mergeByRate(acc.byRate, s.usage.byRate);
    acc.runs += 1;
    acc.calls = (Number(acc.calls) || 0) + (Number(s.usage.calls) || 0);
    acc.models = acc.models && typeof acc.models === 'object' ? acc.models : {};
    for (const [model, u] of Object.entries(s.usage.models || {})) {
      const cur = acc.models[model] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
      cur.promptTokens += u.promptTokens || 0;
      cur.completionTokens += u.completionTokens || 0;
      cur.totalTokens += u.totalTokens || 0;
      cur.cachedTokens = (Number(cur.cachedTokens) || 0) + (Number(u.cachedTokens) || 0);
      cur.byRate = mergeByRate(cur.byRate, u.byRate);
      cur.calls += u.calls || 0;
      acc.models[model] = cur;
    }
    const endedAt = s.endedAt || s.startedAt;
    acc.firstAt = Math.min(Number(acc.firstAt) || s.startedAt, s.startedAt);
    acc.lastAt = Math.max(Number(acc.lastAt) || s.startedAt, endedAt);
    acc.updatedAt = Date.now();
    writeJsonAtomic(file, acc);
  }

  /**
   * 旁路模型调用（唤醒预判 / 必回重试 / 日记生成 / 长期事实提取 / 记忆整理）入账。
   *
   * 这些调用没有会话文件，但花的钱是真的：不入账的话「今日成本」永远偏小，
   * 而且优化主流程后的 token 对比会失真 —— 主流程降了 30%，旁路涨了多少没人知道。
   * runs 不加（它们不是一轮会话）；calls 加 1；`side.<purpose>` 单独记一份明细，
   * 事后能回答「唤醒预判一天到底烧多少」。
   */
  recordSideUsage(purpose, usage, { model = null, at = Date.now() } = {}) {
    try {
      if (!usage || typeof usage !== 'object') return;
      const dayKey = localDayKey(at);
      const u = emptyUsage();
      addUsage(u, usage, { model, at: new Date(at) });
      u.calls = 1;
      if (model) addUsageForModel(u, model, usage);
      const when = Number(at) || Date.now();

      const bumpTotals = (data) => {
        data.promptTokens += u.promptTokens;
        data.completionTokens += u.completionTokens;
        data.totalTokens += u.totalTokens;
        data.cachedTokens = (Number(data.cachedTokens) || 0) + (Number(u.cachedTokens) || 0);
        data.byRate = mergeByRate(data.byRate, u.byRate);
        data.calls = (Number(data.calls) || 0) + 1;
        return data;
      };
      const bumpSide = (data) => {
        data.side = data.side && typeof data.side === 'object' ? data.side : {};
        const key = String(purpose || 'other').slice(0, 24);
        const cur = data.side[key] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
        cur.promptTokens += u.promptTokens;
        cur.completionTokens += u.completionTokens;
        cur.totalTokens += u.totalTokens;
        cur.calls += 1;
        data.side[key] = cur;
        return data;
      };

      // 今日汇总（todayUsage() 读的就是这个文件，旁路用量从此计入 UI 的「今日 token」）
      let today = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0 };
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
        if (parsed?.dayKey === dayKey) today = parsed;
      } catch { /* 新的一天 */ }
      bumpTotals(today);
      bumpSide(today);
      writeJsonAtomic(path.join(DATA_DIR, 'usage-today.json'), today);

      // 按天归档（含 models 明细，usageByModel() 才能把旁路也算进去）
      const file = path.join(USAGE_DIR, `${dayKey}.json`);
      const prev = readJsonSafe(file, null);
      const day = prev?.dayKey === dayKey ? prev : {
        dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0, calls: 0,
        models: {}, firstAt: when, lastAt: when
      };
      bumpTotals(day);
      bumpSide(day);
      day.models = day.models && typeof day.models === 'object' ? day.models : {};
      for (const [m, mu] of Object.entries(u.models || {})) {
        const cur = day.models[m] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
        cur.promptTokens += mu.promptTokens || 0;
        cur.completionTokens += mu.completionTokens || 0;
        cur.totalTokens += mu.totalTokens || 0;
        cur.cachedTokens = (Number(cur.cachedTokens) || 0) + (Number(mu.cachedTokens) || 0);
        cur.byRate = mergeByRate(cur.byRate, mu.byRate);
        cur.calls += mu.calls || 1;
        day.models[m] = cur;
      }
      day.firstAt = Math.min(Number(day.firstAt) || when, when);
      day.lastAt = Math.max(Number(day.lastAt) || when, when);
      day.updatedAt = Date.now();
      writeJsonAtomic(file, day);
    } catch { /* 记账绝不能炸主流程 */ }
  }

  /**
   * 最近 N 天按**模型**聚合的用量（跨日累加）。
   *
   * 为什么单独一个方法：`usageHistory` 是按天给你看趋势，但"这个月 DeepSeek 花了多少、
   * 百炼花了多少"需要跨日合并。TT 的 usage-ledger 就是干这个的（按通道日/月/累计三层），
   * 我们这边数据全在 data/usage/<day>.json 的 models 明细里，读一遍合并即可，
   * 不用再维护一份独立的账本文件（少一个会不一致的真源）。
   */
  usageByModel(days = 30) {
    const n = Math.min(365, Math.max(1, Number(days) || 30));
    const keys = [];
    try {
      for (const f of fs.readdirSync(USAGE_DIR)) {
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) keys.push(f.slice(0, 10));
      }
    } catch { /* 还没有归档 */ }
    keys.sort();
    const picked = keys.slice(-n);
    const acc = {};
    const add = (model, u) => {
      if (!model || !u) return;
      const cur = acc[model] || { model, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0, byRate: { peak: null, off: null } };
      cur.promptTokens += Number(u.promptTokens) || 0;
      cur.completionTokens += Number(u.completionTokens) || 0;
      cur.totalTokens += Number(u.totalTokens) || 0;
      cur.cachedTokens += Number(u.cachedTokens) || 0;
      cur.calls += Number(u.calls) || 0;
      cur.byRate = mergeByRate(cur.byRate, u.byRate);
      acc[model] = cur;
    };
    for (const dayKey of picked) {
      const day = this.usageDay(dayKey);
      for (const [model, u] of Object.entries(day?.models || {})) add(model, u);
    }
    // 今天还没结束的会话不在归档里，补上（否则当天数字总是偏小）
    for (const s of this.current.values()) {
      for (const [model, u] of Object.entries(s.usage?.models || {})) add(model, u);
    }
    return Object.values(acc).sort((a, b) => b.totalTokens - a.totalTokens);
  }

  /** 读某一天的归档用量（data/usage/<dayKey>.json），没有就返回 null。 */
  usageDay(dayKey) {
    const key = String(dayKey || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const data = readJsonSafe(path.join(USAGE_DIR, `${key}.json`), null);
    return data?.dayKey === key ? data : null;
  }

  /** 最近 N 天的用量（按日期升序），今天的实时数字以 todayUsage 为准。 */
  usageHistory(days = 7) {
    const n = Math.min(180, Math.max(1, Number(days) || 7));
    const keys = new Set();
    try {
      for (const f of fs.readdirSync(USAGE_DIR)) {
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) keys.add(f.slice(0, 10));
      }
    } catch { /* 还没有归档 */ }
    for (const s of this.current.values()) keys.add(localDayKey(s.startedAt));
    const today = localDayKey(Date.now());
    keys.add(today);
    const picked = [...keys].sort().slice(-n);
    return picked.map((dayKey) => {
      const archived = this.usageDay(dayKey) || {};
      const row = {
        dayKey,
        promptTokens: archived.promptTokens || 0,
        completionTokens: archived.completionTokens || 0,
        totalTokens: archived.totalTokens || 0,
        cachedTokens: archived.cachedTokens || 0,
        byRate: archived.byRate || null,
        runs: archived.runs || 0,
        calls: archived.calls || 0,
        models: archived.models || {},
        partial: !!archived.partial,
        source: archived.source || 'live'
      };
      if (dayKey === today) {
        // 今天可能有正在跑的会话还没归档（会话结束才累加），以 todayUsage 的合计数覆盖
        const live = this.todayUsage(dayKey);
        row.promptTokens = Math.max(row.promptTokens, live.promptTokens);
        row.completionTokens = Math.max(row.completionTokens, live.completionTokens);
        row.totalTokens = Math.max(row.totalTokens, live.totalTokens);
        row.cachedTokens = Math.max(row.cachedTokens, live.cachedTokens || 0);
        row.runs = Math.max(row.runs, live.runs);
        row.source = 'live';
        row.partial = false;
      }
      return row;
    });
  }

  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
      const target = sessionFile(s.id);
      try {
        fs.renameSync(tmp, target);
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        try { fs.rmSync(target, { force: true }); } catch { /* retry below */ }
        fs.renameSync(tmp, target);
      }
      if (s.status !== 'running') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把一份 usage 的「按档分桶」并进另一份。
 *
 * 为什么要有桶：同一个日账里既有凌晨 2–8 点的半价调用、又有白天的高峰调用，
 * 拿当日总量乘任何一个单价都是错的（差的是一倍）。桶只分 peak / off 两档，
 * 具体的价在计算时从 prices.json 取 —— 所以调价不用回改历史数据。
 */
function mergeByRate(target, src) {
  const from = src && typeof src === 'object' ? src : null;
  if (!from) return target;
  const out = target && typeof target === 'object' ? target : { peak: null, off: null };
  for (const key of ['peak', 'off']) {
    const part = from[key];
    if (!part) continue;
    const cur = out[key] || { prompt: 0, completion: 0, cached: 0 };
    cur.prompt += Number(part.prompt) || 0;
    cur.completion += Number(part.completion) || 0;
    cur.cached += Number(part.cached) || 0;
    out[key] = cur;
  }
  return out;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
