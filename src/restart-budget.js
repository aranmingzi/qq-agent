
/** 取时间戳：0 是合法值（测试常用），只有空值/NaN 才回退到当前时间。 */
function timeOf(v) {
  if (v === null || v === undefined) return Date.now();
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.now();
}

// 重连预算：**不是"能重连就无限重连"**，而是给一段时间窗内的重启次数上限。
//
// 为什么要有它（2026-10-22 生态调研的 P0-3）：
//   以前 WS 断线就是固定 3s 重连，协议端反复崩时会无限重试并把日志刷满，
//   人看到的只有"一直在重连"，既不知道已经失败了多少次，也不知道该不该管。
//
// 三条纪律：
//   ① 退避带指数与抖动（1s → 2s → 4s … 封顶），避免同时重启的惊群；
//   ② 窗口内超过上限 → **停止自动重启**，进入"需要人工介入"，把原因说清楚；
//   ③ 稳定运行超过 stableMs 才清零预算 —— 否则"连上 2 秒又断"会被当成健康。
//
// 纯逻辑：now / rand 都可注入，测试不必等真时间。

export class RestartBudget {
  /**
   * @param {object} opts
   * @param {number} [opts.windowMs]    统计窗口（默认 10 分钟）
   * @param {number} [opts.max]         窗口内允许的最大失败次数（默认 10）
   * @param {number} [opts.baseDelayMs] 首次退避（默认 1s）
   * @param {number} [opts.maxDelayMs]  退避上限（默认 30s）
   * @param {number} [opts.stableMs]    连续多久算"稳定"（默认 60s）
   * @param {number} [opts.jitter]      抖动比例（默认 0.25，即 ±25%）
   * @param {Function} [opts.now]
   * @param {Function} [opts.rand]
   */
  constructor({
    windowMs = 10 * 60 * 1000,
    max = 10,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    stableMs = 60000,
    jitter = 0.25,
    now = () => Date.now(),
    rand = Math.random,
  } = {}) {
    this.windowMs = Math.max(1000, Number(windowMs) || 600000);
    this.max = Math.max(1, Number(max) || 10);
    this.baseDelayMs = Math.max(0, Number(baseDelayMs) || 1000);
    this.maxDelayMs = Math.max(this.baseDelayMs, Number(maxDelayMs) || 30000);
    this.stableMs = Math.max(0, Number(stableMs) || 60000);
    this.jitter = Math.min(1, Math.max(0, Number(jitter) || 0));
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.rand = typeof rand === 'function' ? rand : Math.random;
    this.failures = [];
    this.lastFailureAt = 0;
    this.exhausted = false;
    this.exhaustedAt = 0;
  }

  #prune(t) {
    this.failures = this.failures.filter((x) => t - x < this.windowMs);
  }

  /** 记一次失败，并给出"还让不让重试 / 等多久"。 */
  recordFailure() {
    const t = timeOf(this.now());
    // 窗口过期 = 上一轮故障已经过去很久，预算自然回满（不需要人工 reset）
    this.#prune(t);
    this.failures.push(t);
    this.lastFailureAt = t;
    const attempt = this.failures.length;
    if (attempt > this.max) {
      if (!this.exhausted) { this.exhausted = true; this.exhaustedAt = t; }
      return {
        allowed: false,
        exhausted: true,
        attempt,
        remaining: 0,
        delayMs: 0,
        reason: `${Math.round(this.windowMs / 60000)} 分钟内已失败 ${attempt - 1} 次（上限 ${this.max}），已停止自动重启`,
      };
    }
    const raw = this.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(this.maxDelayMs, raw);
    const factor = 1 + (this.rand() * 2 - 1) * this.jitter;
    const delayMs = Math.max(0, Math.round(capped * factor));
    return {
      allowed: true,
      exhausted: false,
      attempt,
      remaining: Math.max(0, this.max - attempt),
      delayMs,
      reason: '',
    };
  }

  /**
   * 报"稳定运行了多久"。只有真的稳了一段时间才清零。
   * @param {number} uptimeMs 本次连接持续时长
   */
  recordStable(uptimeMs = 0) {
    const up = Number(uptimeMs) || 0;
    if (up >= this.stableMs && this.failures.length) {
      const cleared = this.failures.length;
      this.failures = [];
      this.exhausted = false;
      this.exhaustedAt = 0;
      return { cleared, uptimeMs: up };
    }
    return { cleared: 0, uptimeMs: up };
  }

  /** 人工点"再试一次"：清空预算。 */
  reset() {
    this.failures = [];
    this.exhausted = false;
    this.exhaustedAt = 0;
    this.lastFailureAt = 0;
  }

  nextDelay() {
    const attempt = this.failures.length + 1;
    const capped = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const factor = 1 + (this.rand() * 2 - 1) * this.jitter;
    return Math.max(0, Math.round(capped * factor));
  }

  snapshot() {
    const t = timeOf(this.now());
    this.#prune(t);
    return {
      windowMs: this.windowMs,
      max: this.max,
      failures: this.failures.length,
      remaining: Math.max(0, this.max - this.failures.length),
      exhausted: this.exhausted,
      exhaustedAt: this.exhaustedAt || 0,
      lastFailureAt: this.lastFailureAt || 0,
    };
  }
}
