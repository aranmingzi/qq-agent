// 跳过记录：**每一次"不回"都要留下可查的一条**。
//
// 为什么这是整套系统里最该先做的一件小事（学自 Estrella-Bot `writeSkip`，2026-10-22 调研 P1-5）：
//   我们这个机器人 90% 的时间在做一件事 —— **决定不说话**。
//   而"不说话"在日志里原本只有沉默：没有记录、没有原因、没有 traceId。
//   于是所有用户报障都长成同一句"它刚才没理我"，而代码里能查的东西是零。
//
// 三条纪律：
//   ① **stage 是稳定枚举**（见 SKIP_STAGES）：文案随便改，枚举不能改 ——
//      否则面板统计"哪一类跳过最多"会因为改了一句话而全部错位。
//   ② **reason 用中文写清人话**：这条记录是给人查的，不是给程序看的。
//   ③ **traceId 贯穿**：一条消息从入站到"决定不回"，用同一个 12 位把手；
//      日志行、跳过记录、会话详情里都是它 —— 三处能对上，才叫可查。
//
// 落盘：`data/skip-log.jsonl`，环形保留最近 240 条（超过就折半保留 120）。
// 为什么是 jsonl 而不是 JSON 数组：追加写不会因为进程被杀而丢掉整个文件。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/** 阶段枚举。**加一项要同时想清楚"面板上怎么显示"**，不要加同义项。 */
export const SKIP_STAGES = {
  PAUSED: 'paused',                 // 全局暂停
  ABORTED: 'aborted',               // 被手动中止
  NO_MODEL: 'no-model',             // 没配模型
  OVER_BUDGET: 'over-budget',       // 预算保险丝熔断
  NO_UNREAD: 'no-unread',           // 没有未读（空跑）
  RUNNING: 'running',               // 同会话已有运行，等 drain 接管
  CONCURRENCY: 'concurrency',       // 全局并发满
  GATE: 'gate',                     // 唤醒闸门判定不值得跑
  GATE_ERROR: 'gate-error',         // 闸门自身出错（fail-open 放行了，但要留痕）
  CHEAP_GATE: 'cheap-gate',         // 唤醒预判判定不接
  IDENTITY: 'identity',             // 被身份切换口令接管
  DIRECTIVE: 'directive',           // 被点歌等确定性指令接管
  EGRESS: 'egress',                 // 出口闸门拦下了要发的内容
  SEND_FAIL: 'send-fail',           // 发送失败
  MODEL_SILENT: 'model-silent',     // 模型自己选择不说话（noreply）
  BUDGET_RETRY: 'budget-retry',     // 输出被截断后放弃
  RUN_ERROR: 'run-error',           // 整轮抛异常（模型/网络/内部错误）
  SEND_GATE: 'send-gate',           // 发送前复核否决（白名单/暂停/预算在生成期间变了）
  PROACTIVE_BACKOFF: 'proactive-backoff', // 主动机会被退避挡下（连败/冷却中，没花钱）
  SEND_QUOTA: 'send-quota'          // 这一分钟/小时额度已满，开跑前就放弃（没花模型钱）
};

const MAX_LINES = 240;
const KEEP_LINES = 120;
const RING_MAX = 200;

/** 内存环形（给接口查最近几条，不必读盘）。 */
const ring = [];
let filePath = null;
let appended = 0;
let flushing = null;
let trimTimer = null;
/**
 * 待落盘缓冲。
 *
 * 为什么不用 `fs.appendFile`（异步）：Windows 上对**新建**文件走 'a' 时偶发 EPERM
 * （沙箱/杀软瞬时占用），而 skip 记录恰恰是每次都得写的新场景；
 * 改成"内存攒 1 秒、批量 appendFileSync"：一次系统调用写完一批，
 * 既不会因为高频跳过把磁盘刷满，也不依赖异步 open 的成功率。
 */
const pending = [];
let flushTimer = null;

function ensurePath() {
  if (filePath) return filePath;
  filePath = path.join(DATA_DIR, 'skip-log.jsonl');
  return filePath;
}

function flushPending() {
  flushTimer = null;
  if (!pending.length) return 0;
  const batch = pending.splice(0, pending.length);
  try {
    ensurePath();
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* 已存在 */ }
    fs.appendFileSync(filePath, batch.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    appended += batch.length;
    if (appended >= 50) {
      appended = 0;
      scheduleTrim();
    }
    return batch.length;
  } catch (error) {
    console.warn('[skip-log] 写入失败（记账不影响主流程）：', error?.message ?? error);
    return 0;
  }
}

/** 立刻把缓冲写盘（测试、退出前、面板"刷新"用）。 */
export function flushSkips() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  return flushPending();
}

/** 测试用：改落盘位置（传 null 恢复默认）。 */
export function setSkipLogFile(p) {
  filePath = p ? String(p) : null;
}

/**
 * 生成 traceId：12 位十六进制。
 * 入参 `rng` 可注入 —— 测试里要能造出确定的把手。
 */
export function newTraceId(rng = Math.random) {
  let s = '';
  for (let i = 0; i < 12; i += 1) {
    s += Math.floor(Number(rng()) * 16).toString(16);
  }
  return s;
}

/**
 * 记一条"没说话"。
 *
 * @param {object} entry
 * @param {string} entry.stage   SKIP_STAGES 里的值
 * @param {string} entry.reason  中文原因（给人看）
 * @param {string} [entry.chatKey]
 * @param {string} [entry.traceId] 不给就当场生成
 * @param {object} [entry.detail]  结构化补充（条数、概率、档位…）
 * @returns {object} 落库的那条（含 traceId/at）
 */
export function recordSkip(entry = {}) {
  const at = Date.now();
  const rec = {
    at,
    traceId: String(entry.traceId || newTraceId()),
    stage: String(entry.stage || 'unknown'),
    chatKey: String(entry.chatKey || ''),
    reason: String(entry.reason || '').slice(0, 300),
    detail: entry.detail && typeof entry.detail === 'object' ? entry.detail : undefined
  };
  ring.push(rec);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  append(rec);
  return rec;
}

function append(rec) {
  pending.push(rec);
  if (pending.length >= 50) { flushSkips(); return; }   // 积压太多立刻写，不等定时器
  if (flushTimer) return;
  flushTimer = setTimeout(flushPending, 1000);
  flushTimer.unref?.();
}

/** 环形裁剪：超过 MAX_LINES 保留最后 KEEP_LINES。失败不影响主流程。 */
function scheduleTrim() {
  if (flushing) return;
  flushing = true;
  setTimeout(() => {
    try {
      const text = fs.readFileSync(ensurePath(), 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length <= MAX_LINES) return;
      const kept = lines.slice(-KEEP_LINES);
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[skip-log] 裁剪失败：', error?.message ?? error);
    } finally {
      flushing = false;
    }
  }, 0).unref?.();
}

/** 最近若干条（内存视图，按时间正序）。 */
export function recentSkips(limit = 50) {
  const n = Math.max(1, Number(limit) || 50);
  return ring.slice(-n);
}

/**
 * 按阶段统计（面板"为什么没回"那一栏的数据源）。
 * `since` 可以只统计最近一段时间。
 */
export function skipStats({ since = 0 } = {}) {
  const out = {};
  for (const r of ring) {
    if (since && r.at < since) continue;
    out[r.stage] = (out[r.stage] || 0) + 1;
  }
  return out;
}

/** 一行日志文案：`[跳过·gate] 群:123 无关群聊（p=0.150） #a1b2c3d4e5f6` */
export function describeSkip(rec) {
  if (!rec) return '';
  const bits = [`[跳过·${rec.stage}]`, rec.chatKey || '-', rec.reason || ''];
  if (rec.detail && Object.keys(rec.detail).length) {
    const d = Object.entries(rec.detail)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (d.length) bits.push(`(${d.join(' ')})`);
  }
  bits.push(`#${rec.traceId}`);
  return bits.filter(Boolean).join(' ');
}

/** 清空内存环形与待写缓冲（**不删磁盘**）—— 进程重启或测试用。 */
export function resetSkipMemory() {
  ring.length = 0;
  pending.length = 0;
  appended = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (trimTimer) { clearTimeout(trimTimer); trimTimer = null; }
}
