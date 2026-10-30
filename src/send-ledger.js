// 发送台账：解决"这条到底发出去没有"这个不可判定问题。
//
// 为什么需要它（2026-10-22 生态调研的 P0-1）：
//   发送失败时，错误的**性质**完全不同：
//     · 协议端明确回了错误（400 / 频率超限 / 内容为空）→ 确定没发出去，可以重试；
//     · 超时 / 连接被重置 / 写到一半断掉 → **可能已经发出去了**，重试就是重复投递。
//   以前两种情况都当成"失败"，模型看到失败就会换个说法再发一遍，群里于是出现两条。
//
// 三条纪律：
//   ① 只对"不确定"落账，确定失败不落（否则台账会被无意义的记录塞满）；
//   ② 同样的内容在台账里还没结清时，**拒绝原样重发**，并把原因说给模型听；
//   ③ 台账是给人看的：控制台能列出待确认项，人工确认后结清。
//
// 纯文件 + 追加写（JSONL），不引数据库：一天也就几十条。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

/** 取时间戳：0 是合法值（测试常用），只有空值/NaN 才回退到当前时间。 */
function timeOf(v) {
  if (v === null || v === undefined) return Date.now();
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.now();
}


/** 未结清记录保留多久（超过就不再拦重复发送，也不再出现在待确认列表）。 */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** 明确"没发出去"的错误码/文案：这些可以安全重试。 */
const DEFINITE_RE = /(频率超限|超限|没发出去|内容为空|消息列表为空|非法会话|无权限|权限不足|不支持|不存在|找不到|参数|格式|400|401|403|404|retcode)/i;
/** "不知道发没发出去"的错误码/文案。 */
const UNKNOWN_RE = /(timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ESOCKETTIMEDOUT|socket hang up|EPIPE|network|fetch failed|aborted|未响应|连接被重置|中断)/i;
/** 这些错误码一定没发出去（DNS 失败连不上）。 */
const DEFINITE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * 判定一次发送失败的性质。
 * @returns {'failed'|'unknown'} failed = 确定没发出去；unknown = 可能已经发出去
 */
export function classifySendFailure(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code && DEFINITE_CODES.has(code)) return 'failed';
  // 协议端明确回报的失败（transport / business）：确定没发出去，可以重试。
  // 这两个字段由 src/onebot-result.js 给出，比从文案里猜可靠。
  const kind = error?.result?.kind;
  if (kind === 'transport') return 'failed';
  if (kind === 'business') return 'failed';
  // 传输通了但响应体读不出来：请求可能已经被处理 → 不确定（宁可少发一条，不要多发一条）
  if (kind === 'no-body' || error?.uncertain === true) return 'unknown';
  const retcode = error?.retcode ?? error?.data?.retcode;
  if (retcode !== undefined && retcode !== null && retcode !== 0) return 'failed';
  const msg = String(error?.message ?? error ?? '');
  // 明确性优先：一句 "HTTP 400: timeout" 里两个词都有时，按"确定的失败"处理
  if (DEFINITE_RE.test(msg)) return 'failed';
  if (code && /^(ETIMEDOUT|ECONNRESET|EPIPE|ECONNABORTED|ESOCKETTIMEDOUT)$/.test(code)) return 'unknown';
  if (UNKNOWN_RE.test(msg)) return 'unknown';
  // 其余（未知异常）保守当"不确定"：宁可少发一条，不要多发一条
  return 'unknown';
}

export function fingerprint(chatKey, text) {
  return crypto.createHash('sha1')
    .update(`${String(chatKey)}\u0000${String(text ?? '')}`)
    .digest('hex')
    .slice(0, 16);
}

function safeText(s, max = 300) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export class SendLedger {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]   台账目录（默认 <DATA_DIR>）
   * @param {number} [opts.ttlMs] 未结清保留时长
   * @param {Function} [opts.now]
   */
  constructor({ dir = null, ttlMs = PENDING_TTL_MS, now = () => Date.now() } = {}) {
    this.dir = dir || DATA_DIR;
    this.file = path.join(this.dir, 'send-pending.jsonl');
    this.ttlMs = Math.max(60000, Number(ttlMs) || PENDING_TTL_MS);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.items = new Map();   // fp -> { fp, chatKey, text, error, at, resolvedAt, resolvedBy, tries }
    this.#load();
  }

  #load() {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-2000);
    for (const line of lines) {
      let ev = null;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.t === 'pending' && ev.fp) {
        this.items.set(String(ev.fp), {
          fp: String(ev.fp),
          chatKey: String(ev.chatKey || ''),
          text: String(ev.text || ''),
          error: String(ev.error || ''),
          at: Number(ev.at) || 0,
          resolvedAt: 0,
          resolvedBy: '',
          tries: Number(ev.tries) || 1,
        });
      } else if (ev.t === 'resolved' && ev.fp && this.items.has(String(ev.fp))) {
        const it = this.items.get(String(ev.fp));
        it.resolvedAt = Number(ev.at) || this.now();
        it.resolvedBy = String(ev.by || '');
      }
    }
  }

  #append(ev) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(ev)}\n`, 'utf8');
    } catch (e) {
      // 台账写不进去不能拖垮发送本身：只在控制台打一行
      console.warn(`[send-ledger] 写台账失败（已忽略）：${e?.message ?? e}`);
    }
  }

  /** 记一条"结果不确定"的发送。 */
  recordUnknown({ chatKey, text, error = '', kind = 'text' }) {
    const fp = fingerprint(chatKey, text);
    const prev = this.items.get(fp);
    const at = timeOf(this.now());
    const item = {
      fp,
      chatKey: String(chatKey || ''),
      text: safeText(text),
      error: safeText(error, 200),
      kind: String(kind || 'text'),
      at,
      resolvedAt: 0,
      resolvedBy: '',
      tries: (prev?.tries || 0) + 1,
    };
    this.items.set(fp, item);
    this.#append({ t: 'pending', fp, chatKey: item.chatKey, text: item.text, error: item.error, kind: item.kind, at, tries: item.tries });
    return item;
  }

  /** 结清（人工确认 / 后续成功发送）。 */
  resolve(fp, by = 'manual') {
    const it = this.items.get(String(fp));
    if (!it || it.resolvedAt) return false;
    it.resolvedAt = timeOf(this.now());
    it.resolvedBy = String(by || 'manual');
    this.#append({ t: 'resolved', fp: it.fp, at: it.resolvedAt, by: it.resolvedBy });
    return true;
  }

  resolveByFingerprint(chatKey, text, by = 'sent') {
    return this.resolve(fingerprint(chatKey, text), by);
  }

  /** 同样的内容还没结清 → 不要原样再发。 */
  isPending(chatKey, text) {
    const it = this.items.get(fingerprint(chatKey, text));
    if (!it || it.resolvedAt) return null;
    if (timeOf(this.now()) - it.at > this.ttlMs) return null;
    return it;
  }

  pending({ chatKey = null, limit = 50 } = {}) {
    const t = timeOf(this.now());
    const out = [];
    for (const it of this.items.values()) {
      if (it.resolvedAt) continue;
      if (t - it.at > this.ttlMs) continue;
      if (chatKey && it.chatKey !== chatKey) continue;
      out.push({ ...it });
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, Math.max(1, Number(limit) || 50));
  }

  stats() {
    const t = timeOf(this.now());
    let open = 0;
    let resolved = 0;
    let expired = 0;
    for (const it of this.items.values()) {
      if (it.resolvedAt) { resolved += 1; continue; }
      if (t - it.at > this.ttlMs) { expired += 1; continue; }
      open += 1;
    }
    return { open, resolved, expired, total: this.items.size, file: this.file };
  }
}
