// OneBot 回包判据：**传输成功**与**业务成功**是两个正交字段。
//
// 为什么必须拆开（学自 Estrella 的 `backend/normalize.js`，2026-10-22 生态调研 P2-9）：
//   "HTTP 200 + 业务失败"和"HTTP 200 + 业务成功"在传输层上**长得一模一样**，
//   而"HTTP 200 + retcode=0 + status=failed"是真实存在的（NapCat 在某些接口上这么回）。
//   用一个布尔量表示，就只能二选一：要么把失败的当成成功（消息根本没发出去，
//   上层却以为发到了，台账也跟着结清），要么把成功的当成失败（模型会换个说法重发一遍）。
//
// 分开之后，失败还能再分一层：
//   · `transportOk=false` → 连都没连上 / 接口不存在，**重试是安全的**；
//   · `transportOk=true, businessOk=false` → 请求被处理了但没做成，重试前要看 retcode。
//   这个区分直接决定"能不能重发"，所以它必须是判据层的产物，不能靠调用方看文案猜。
//
// 这是一份**零依赖叶子**：不 import 任何东西（连 node: 都不），
// 于是它可以直接被喂反例单测，也能被别的协议端（Satori / Milky）的适配层原样复用。

/**
 * 这条响应体算不算"业务成功"。
 *
 * 三个口子都要看，缺一个都会漏：
 *   · `status` —— OneBot v11 规定 "ok" 为成功，有的实现只回它；
 *   · `retcode` —— 有的实现只回它（0 为成功）；
 *   · 两个都不给 —— 没有"失败证据"时按成功处理（fail-safe：漏判失败只会导致上层
 *     以为发到了，但**这条实际已经发出去了**，比反过来把成功判成失败造成重复发送好）。
 *
 * 判定是 **AND 不是 OR**：只要有一路明确说失败，就是失败。
 * 早先这里写成 `status !== 'ok' && retcode !== 0`（AND 连的是两个"失败"条件），
 * 于是 `retcode=0 + status='failed'` 会被整体判成成功 —— 正是它要防的那种假象。
 *
 * @param {object} body
 * @returns {{businessOk: boolean, retcode: number|null, status: string, wording: string, sawAny: boolean}}
 */
export function judgeBusiness(body) {
  const b = body && typeof body === 'object' ? body : {};
  const status = typeof b.status === 'string' ? b.status.trim().toLowerCase() : '';
  const raw = b.retcode;
  const retcode = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  // 注意用 `||` 而不是 `??`：有的实现会回 `wording: ""`（字段在、值是空串），
  // 用 `??` 会把这个空串当成"有值"，于是真正有信息的 `message` 被吞掉，
  // 上层判据（不支持 / 发包不可用）就全部失明。
  const wording = String(b.wording || b.message || '').trim();
  const sawStatus = status !== '';
  const sawRetcode = retcode !== null && Number.isFinite(retcode);
  const sawAny = sawStatus || sawRetcode;
  let businessOk = true;
  if (sawStatus && status !== 'ok' && status !== 'success') businessOk = false;
  if (sawRetcode && retcode !== 0) businessOk = false;
  return { businessOk, retcode, status, wording, sawAny };
}

/**
 * 一次 HTTP 调用的完整判定。
 *
 * @param {object} input
 * @param {boolean} input.transportOk HTTP 层通了没有（2xx）
 * @param {number} [input.httpStatus]
 * @param {object} [input.body] 解析后的响应体；解析失败传 null（此时 sawBody=false）
 * @param {string} [input.action] 动作名，只用于文案
 * @returns {{
 *   transportOk: boolean, businessOk: boolean, ok: boolean,
 *   retcode: number|null, status: string, wording: string,
 *   sawBody: boolean, kind: 'ok'|'transport'|'business'|'no-body',
 *   reason: string
 * }}
 */
export function judgeCall({ transportOk = false, httpStatus = 0, body = null, action = '' } = {}) {
  const tag = action ? `「${action}」` : '';
  if (!transportOk) {
    return {
      transportOk: false, businessOk: false, ok: false,
      retcode: null, status: '', wording: '',
      sawBody: false, kind: 'transport',
      reason: `HTTP ${httpStatus || '错误'}${tag}`,
    };
  }
  const sawBody = Boolean(body) && typeof body === 'object';
  if (!sawBody) {
    // 传输通了但读不出响应体：既不能算成功（没证据），也不能算业务失败（没处理过）。
    // 单列一类，是为了让上层把它当"结果不确定"落台账，而不是当成确定失败去重发。
    return {
      transportOk: true, businessOk: false, ok: false,
      retcode: null, status: '', wording: '',
      sawBody: false, kind: 'no-body',
      reason: `响应体解析失败${tag}`,
    };
  }
  const j = judgeBusiness(body);
  const ok = j.businessOk;
  return {
    transportOk: true,
    businessOk: j.businessOk,
    ok,
    retcode: j.retcode,
    status: j.status,
    wording: j.wording,
    sawBody: true,
    kind: ok ? 'ok' : 'business',
    reason: ok ? '' : `业务失败：${j.retcode !== null ? `retcode=${j.retcode}` : `status=${j.status || '未知'}`}${j.wording ? ` ${j.wording}` : ''}${tag}`,
  };
}

/** 文案里出现这些，说明协议端根本没有这个动作（而不是这次调用失败）。 */
const UNSUPPORTED_RE = /不支持|not\s*support|unknown\s*action|未实现|no\s*such\s*action/i;

/** 1404 = OneBot v11 里"不支持的 API"的常见实现。 */
export function looksUnsupported(j) {
  if (!j) return false;
  if (Number(j.retcode) === 1404) return true;
  return UNSUPPORTED_RE.test(String(j.wording || ''));
}

/**
 * 文案里出现这些，说明**协议端这台机器发包彻底坏了**，而不是"没有这个接口"。
 *
 * 典型来源：NapCat 的 PacketBackend 找不到当前 QQ 版本的偏移数据
 * （`PacketBackend 不支持当前QQ版本架构：9.9.36-53644-x64`）。
 * 它同时包含"不支持"三字，所以判据必须先于 looksUnsupported，
 * 否则 `send_poke` 会被当成"接口不存在"拉黑，掩盖真实病因。
 *
 * 处理上的区别：
 *   · 接口不存在 → 换个动作名（group_poke ↔ send_poke）有意义，重试也有意义；
 *   · 发包坏了   → 换名字、重试都白费，只能换协议端版本或降 QQ 版本。
 */
const NO_PACKET_RE = /packetBackend|PacketBackend|发包能力不可用/i;

export function isPacketUnavailable(wording) {
  return NO_PACKET_RE.test(String(wording || ''));
}
