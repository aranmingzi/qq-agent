// 进程内任务队列：单机单卡场景下的「互斥 + 优先级 + 持久化」。
//
// 设计取舍（对应 docs/ARCH-升级方案-2026-10-19.md §3）：
//   - 不引入 Redis/BullMQ。本项目只有一个 Node 进程、一张 4GB 显卡，
//     队列的刚需只有三条：GPU 互斥、点歌优先、重启不丢。进程内实现全覆盖。
//   - 将来要多机/多进程消费，只需替换 add()/claim()/finish() 三个方法，
//     其余（数据结构、事件、交付回调）不用动。
//
// 为什么不做「分布式」：异步系统的头号故障不是性能，是**任务永远卡在 running**。
// 本实现用「心跳 + 子任务超时 + 进程内 Promise 终态」三重兜底，保证每个 job 一定收敛。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

function shortId(prefix = 'job') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    + `_${randomUUID().slice(0, 6)}`;
}

export class JobQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.concurrency=1]   同时执行数（GPU 场景必须 1）
   * @param {string} [opts.journalPath]     JSONL 持久化路径；null=只在内存
   * @param {number} [opts.cacheTtlMs]      成功结果的可复用时长
   * @param {number} [opts.stallMs]         running 多久无心跳就判死
   * @param {function} [opts.log]
   * @param {function} [opts.onEvent]       (type, payload) 事件出口
   */
  constructor({
    concurrency = 1, journalPath = null, cacheTtlMs = 6 * 3600 * 1000,
    stallMs = 240 * 1000, log = () => {}, onEvent = null,
  } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) | 0);
    this.journalPath = journalPath;
    this.cacheTtlMs = cacheTtlMs;
    this.stallMs = stallMs;
    this.log = log;
    this.onEvent = onEvent;

    this.jobs = new Map();     // id -> job
    this.pending = [];         // 等待调度
    this.active = new Map();   // id -> job（正在跑）
    this.byKey = new Map();    // key -> id（在途去重）
    this.cache = new Map();    // key -> { result, at }
    this.rrCursor = 0;
    this.seq = 0;
    this.journalWrites = 0;

    this.sweeper = setInterval(() => this.#sweep(), Math.max(5000, Math.min(30000, stallMs / 2)));
    this.sweeper.unref?.();

    this.#loadJournal();
  }

  // ── 对外：入队 ─────────────────────────────────────────────────────────
  /**
   * @param {object} spec
   * @param {string} [spec.group]      公平调度单位（一般用 chatKey）
   * @param {string} [spec.key]        内容寻址键：相同 key 在途去重、成功后可复用
   * @param {number} [spec.priority]   越大越先跑
   * @param {number} [spec.etaMs]
   * @param {number} [spec.maxAttempts]
   * @param {object} [spec.meta]       透传给 run 的原始参数
   * @param {function} spec.run        async (ctl, meta) => result
   * @param {function} [spec.onDone]   async (result, meta) => void
   * @param {function} [spec.onFail]   async (error, meta) => void
   * @returns {{id, deduped, cached?, position, etaMs, status, result?}}
   */
  add(spec) {
    const {
      group = 'default', key = null, priority = 10, etaMs = 30000,
      maxAttempts = 2, meta = {}, run, onDone = null, onFail = null,
    } = spec;
    if (typeof run !== 'function') throw new Error('JobQueue.add 需要 run 函数');

    // ① 同 key 正在跑/排队 → 合并，不重复烧 GPU
    if (key && this.byKey.has(key)) {
      const j = this.jobs.get(this.byKey.get(key));
      if (j && !TERMINAL.has(j.status)) {
        j.waiters.push({ onDone, onFail });
        this.log(`[queue] 合并到在途任务 ${j.id}（当前 ${j.status} ${j.progress}%）`);
        return { id: j.id, deduped: true, position: this.positionOf(j), etaMs: j.etaMs, status: j.status };
      }
      this.byKey.delete(key);
    }

    // ② 已有成功成品 → 秒回
    const hit = key ? this.#cacheGet(key) : null;
    if (hit) {
      this.log(`[queue] 命中缓存 ${key}`);
      return { id: `cache_${key}`, deduped: true, cached: true, position: 0, etaMs: 800, status: 'succeeded', result: hit };
    }

    const job = {
      id: shortId(), group, key, priority, meta,
      status: 'queued', stage: null, progress: 0, etaMs,
      attempts: 0, maxAttempts: Math.max(1, maxAttempts),
      run, onDone, onFail, waiters: [],
      createdAt: Date.now(), startedAt: null, finishedAt: null,
      heartbeatAt: Date.now(), seq: ++this.seq, error: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    if (key) this.byKey.set(key, job.id);
    this.pending.push(job);
    this.#sortPending();
    this.#journal({ type: 'add', job });
    this.#emit('job.queued', job, { position: this.positionOf(job) });
    this.#pump();
    return { id: job.id, deduped: false, position: this.positionOf(job), etaMs: job.etaMs, status: job.status };
  }

  /** 取消：排队中直接移出，运行中发 abort 让子进程退出。 */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, reason: 'not_found' };
    if (TERMINAL.has(job.status)) return { ok: false, reason: `already_${job.status}` };
    if (job.status === 'queued') {
      this.pending = this.pending.filter((j) => j.id !== id);
      job.status = 'canceled';
      job.finishedAt = Date.now();
      if (job.key) this.byKey.delete(job.key);
      this.#journal({ type: 'cancel', job });
      this.#emit('job.canceled', job, {});
      this.#runFailHooks(job, Object.assign(new Error('已取消'), { code: 'CANCELED', retryable: false }));
      return { ok: true };
    }
    job.cancelRequested = true;
    try { job.controller.abort(); } catch { /* ignore */ }
    return { ok: true, aborting: true };
  }

  get(id) {
    const j = this.jobs.get(id);
    if (!j) return null;
    return {
      id: j.id, group: j.group, status: j.status, stage: j.stage,
      progress: j.progress, etaMs: j.etaMs, attempts: j.attempts,
      position: this.positionOf(j), createdAt: j.createdAt,
      // 给「查队列」用的人类可读标签（歌名/歌词开头），由提交方写进 meta
      label: j.meta?.label ?? null,
      startedAt: j.startedAt, finishedAt: j.finishedAt,
      error: j.error ? { code: j.error.code, message: j.error.message } : null,
    };
  }

  list({ group = null, limit = 50 } = {}) {
    const out = [];
    for (const j of this.jobs.values()) {
      if (group && j.group !== group) continue;
      out.push(this.get(j.id));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  stats() {
    let queued = 0; let running = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'queued') queued++;
      else if (j.status === 'running') running++;
    }
    return { queued, running, concurrency: this.concurrency, cacheKeys: this.cache.size };
  }

  positionOf(job) {
    if (job.status === 'running') return 0;
    if (job.status !== 'queued') return -1;
    const sorted = [...this.pending].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return sorted.findIndex((j) => j.id === job.id) + 1;
  }

  destroy() {
    clearInterval(this.sweeper);
    for (const j of this.active.values()) {
      try { j.controller.abort(); } catch { /* ignore */ }
    }
  }

  // ── 调度 ───────────────────────────────────────────────────────────────
  #sortPending() {
    this.pending.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }

  #pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      this.#start(this.#pickFair());
    }
  }

  /**
   * 按 group 轮转：一个群连点 5 首不会把其他群饿死。
   * 组内按 priority / 入队顺序。
   */
  #pickFair() {
    const groups = new Map();
    for (const j of this.pending) {
      if (!groups.has(j.group)) groups.set(j.group, []);
      groups.get(j.group).push(j);
    }
    const keys = [...groups.keys()].sort();
    if (!keys.length) return this.pending.shift();
    const k = keys[this.rrCursor % keys.length];
    this.rrCursor++;
    const bucket = groups.get(k).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    const job = bucket[0];
    this.pending = this.pending.filter((j) => j.id !== job.id);
    return job;
  }

  #start(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    job.heartbeatAt = Date.now();
    this.active.set(job.id, job);

    const ctl = {
      progress: (p = {}) => {
        if (job.status !== 'running') return;
        job.heartbeatAt = Date.now();
        if (p.stage) {
          if (job.stage !== p.stage) {
            job.stage = p.stage;
            this.#emit('job.stage', job, { stage: p.stage, msg: p.msg || '' });
          }
        }
        if (Number.isFinite(p.pct)) job.progress = Math.max(job.progress, Math.min(99, Math.round(p.pct)));
        if (Number.isFinite(p.etaMs)) job.etaMs = Math.max(500, Math.round(p.etaMs));
        this.#emit('job.progress', job, { stage: job.stage, progress: job.progress, etaMs: job.etaMs, msg: p.msg || '' });
      },
      log: (text) => {
        job.heartbeatAt = Date.now();
        this.#emit('job.log', job, { text: String(text) });
      },
      signal: job.controller.signal,
      isCanceled: () => job.status === 'canceled' || job.cancelRequested === true,
    };

    this.#emit('job.started', job, {});

    Promise.resolve()
      .then(() => job.run(ctl, job.meta))
      .then((result) => this.#finishOk(job, result))
      .catch((err) => this.#finishErr(job, err))
      .finally(() => {
        this.active.delete(job.id);
        this.#pump();
      });
  }

  // ── 终态 ───────────────────────────────────────────────────────────────
  async #finishOk(job, result) {
    if (job.cancelRequested) {
      job.status = 'canceled';
      job.finishedAt = Date.now();
      if (job.key) this.byKey.delete(job.key);
      this.#journal({ type: 'cancel', job });
      this.#emit('job.canceled', job, {});
      return;
    }
    job.status = 'succeeded';
    job.progress = 100;
    job.finishedAt = Date.now();
    if (job.key) {
      this.byKey.delete(job.key);
      this.cache.set(job.key, { result, at: Date.now() });
    }
    this.#journal({ type: 'done', job, result: this.#cacheableResult(result) });
    this.#emit('job.done', job, { result });

    const hooks = [job.onDone, ...job.waiters.map((w) => w.onDone)].filter(Boolean);
    for (const fn of hooks) {
      try { await fn(result, job.meta); } catch (e) { this.log(`[queue] onDone 回调出错：${e?.message ?? e}`); }
    }
  }

  async #finishErr(job, err) {
    const canceled = job.cancelRequested || err?.code === 'CANCELED';
    const code = err?.code || 'JOB_FAILED';
    const retryable = canceled ? false : (err?.retryable !== false);

    if (canceled) {
      job.status = 'canceled';
      job.finishedAt = Date.now();
      if (job.key) this.byKey.delete(job.key);
      this.#journal({ type: 'cancel', job });
      this.#emit('job.canceled', job, {});
      this.#runFailHooks(job, err);
      return;
    }

    // 重试：同一 job 复用，attempts+1，退避 1s 再排队
    if (retryable && job.attempts + 1 < job.maxAttempts) {
      job.attempts++;
      job.status = 'queued';
      job.stage = null;
      job.progress = 0;
      job.controller = new AbortController();
      job.error = { code, message: String(err?.message ?? err).slice(0, 500) };
      this.log(`[queue] ${job.id} 第 ${job.attempts} 次重试（${code}：${job.error.message.slice(0, 120)}）`);
      this.#journal({ type: 'retry', job });
      setTimeout(() => { this.pending.push(job); this.#sortPending(); this.#pump(); }, 1000);
      return;
    }

    job.status = 'failed';
    job.error = { code, message: String(err?.message ?? err).slice(0, 500) };
    job.finishedAt = Date.now();
    if (job.key) this.byKey.delete(job.key);
    this.#journal({ type: 'fail', job });
    this.#emit('job.failed', job, { code, message: job.error.message });
    this.#runFailHooks(job, err);
  }

  #runFailHooks(job, err) {
    const hooks = [job.onFail, ...job.waiters.map((w) => w.onFail)].filter(Boolean);
    for (const fn of hooks) {
      try { Promise.resolve(fn(err, job.meta)).catch(() => {}); } catch { /* ignore */ }
    }
  }

  /** 僵尸回收：running 但心跳停了（子进程被系统杀掉 / 死锁）→ 判死，别占着队列。 */
  #sweep() {
    const now = Date.now();
    for (const job of this.active.values()) {
      if (now - job.heartbeatAt <= this.stallMs) continue;
      this.log(`[queue] ${job.id} 心跳超时 ${Math.round((now - job.heartbeatAt) / 1000)}s，判死`);
      try { job.controller.abort(); } catch { /* ignore */ }
      job.heartbeatAt = now;
      this.#finishErr(job, Object.assign(new Error('任务超时（心跳停止）'), { code: 'STALLED', retryable: false }));
    }
  }

  // ── 缓存 / 持久化 ──────────────────────────────────────────────────────
  #cacheGet(key) {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.cacheTtlMs) { this.cache.delete(key); return null; }
    return e.result;
  }

  /** 只持久化可序列化的少量字段（绝不能塞 buffer，一首歌几十 MB）。 */
  #cacheableResult(result) {
    if (!result || typeof result !== 'object') return null;
    const { file, seconds, engine, melodyName, singer, name, qc } = result;
    return { file, seconds, engine, melodyName, singer, name, qc };
  }

  #journal(rec) {
    if (!this.journalPath) return;
    try {
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      const line = JSON.stringify({
        t: Date.now(), type: rec.type,
        id: rec.job.id, group: rec.job.group, key: rec.job.key,
        status: rec.job.status, progress: rec.job.progress,
        error: rec.job.error ? rec.job.error.message : null,
        result: rec.result || null,
      });
      fs.appendFileSync(this.journalPath, line + '\n');
      // 每 100 条检查一次体积，超过 2MB 只留最后 300 行（append-only 不能无限长）
      if (++this.journalWrites % 100 === 0) this.#rotateJournal();
    } catch { /* 持久化失败不影响主流程 */ }
  }

  #rotateJournal() {
    try {
      const st = fs.statSync(this.journalPath);
      if (st.size < 2 * 1024 * 1024) return;
      const keep = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean).slice(-300);
      fs.writeFileSync(this.journalPath, keep.join('\n') + '\n');
      this.log(`[queue] 任务日志已压缩到 ${keep.length} 条`);
    } catch { /* ignore */ }
  }

  #loadJournal() {
    if (!this.journalPath || !fs.existsSync(this.journalPath)) return;
    let lines = [];
    try { lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean); } catch { return; }
    let restored = 0;
    for (const line of lines.slice(-500)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.type === 'done' && r.key && r.result?.file) {
        try { if (!fs.existsSync(r.result.file)) continue; } catch { continue; }
        this.cache.set(r.key, { result: r.result, at: r.t });
        restored++;
      }
    }
    if (restored) this.log(`[queue] 从日志恢复 ${restored} 条可复用成品缓存`);
    const unfinished = lines.slice(-200).filter((l) => {
      try { const r = JSON.parse(l); return r.type === 'add'; } catch { return false; }
    }).length;
    if (unfinished) this.log(`[queue] 日志里有 ${unfinished} 条历史入队记录（已忽略，不自动重跑）`);
  }

  #emit(type, job, extra) {
    try {
      this.onEvent?.(type, {
        jobId: job.id, group: job.group, status: job.status,
        stage: job.stage, progress: job.progress, etaMs: job.etaMs,
        ...extra,
      });
    } catch { /* 事件出口不影响调度 */ }
  }
}
