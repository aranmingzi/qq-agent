// 事件日志：给 SSE 一个**游标**，断线重连不丢事件。
//
// 为什么要有它（2026-10-22 生态调研的 P0-2）：
//   以前 /api/events 是"连上之后才有事件"，前端一断（切后台、手机锁屏、控制台重载），
//   断线期间发生的事就永远看不到了；控制台显示的状态与实际不一致，且没有任何提示。
//
// 三条纪律：
//   ① 每条事件有单调递增 seq，SSE 的 `id:` 字段就是它；
//   ② 只保留最近 capacity 条（默认 500）——这是给人看的日志，不是消息存档；
//   ③ 重连时按 `?after=` 或 `Last-Event-ID` 补发；超出窗口时**明说丢了**，不假装连续。
//
// 纯内存，不落盘：进程重启后 seq 从 1 开始，前端靠 hello 事件里的 cursor 重新对齐。

export class EventLog {
  constructor({ capacity = 500 } = {}) {
    this.capacity = Math.max(1, Number(capacity) || 500);
    this.items = [];
    this.seq = 0;
  }

  /** 记一条事件，返回带 seq 的不可变副本。 */
  push(type, payload = {}, at = Date.now()) {
    this.seq += 1;
    const ev = { seq: this.seq, type: String(type || 'message'), payload, at };
    this.items.push(ev);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return ev;
  }

  /**
   * 取 seq 之后的事件。
   * @returns {{items:Array, cursor:number, gap:boolean, oldest:number}}
   *   gap=true 表示请求的位置比缓冲区还旧，中间那段已经丢了。
   */
  since(after = 0) {
    const cursor = this.seq;
    const oldest = this.items.length ? this.items[0].seq : cursor + 1;
    const n = Number(after);
    if (!Number.isFinite(n) || n < 0) return { items: [], cursor, gap: false, oldest };
    if (n >= cursor) return { items: [], cursor, gap: false, oldest };
    const gap = n + 1 < oldest;
    return { items: this.items.filter((e) => e.seq > n), cursor, gap, oldest };
  }

  cursor() { return this.seq; }
  size() { return this.items.length; }
}

/**
 * 一条 SSE 帧。
 * seq 为空时输出**不带 id** 的帧（hello / 提示），不占用游标。
 */
export function formatSse({ seq = null, type = 'message', payload = {}, at = null } = {}) {
  const idLine = Number.isFinite(Number(seq)) && Number(seq) > 0 ? `id: ${Number(seq)}\n` : '';
  const data = { ...(payload && typeof payload === 'object' ? payload : { value: payload }) };
  if (at) data._at = at;
  return `${idLine}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 从连接参数里取续传位置：查询串优先，其次 Last-Event-ID 头。 */
export function cursorFrom(req, url) {
  const q = url?.searchParams?.get('after');
  if (q !== null && q !== undefined && String(q).trim() !== '') {
    const n = Number(q);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const h = req?.headers?.['last-event-id'];
  if (h !== undefined && h !== null && String(h).trim() !== '') {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;   // null = 首次连接，不补发
}
