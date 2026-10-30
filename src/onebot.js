// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';
import { faceText, marketFaceText, faceName } from './qq-face.js';
import { RestartBudget } from './restart-budget.js';
import { judgeCall, looksUnsupported, isPacketUnavailable } from './onebot-result.js';

const RECONNECT_MAX_MS = 30000;

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
    this.connectedAt = 0;
    this.nextRetryAt = 0;
    /** 撞到过"不支持"的动作（OneBot 实现差异；见 call()）。 */
    this.unsupported = new Set();
    /** 连续崩溃超预算时回调（由 app.js 接成"需要人工介入"告警）。 */
    this.onExhausted = null;
    // 10 分钟内最多重启 10 次；退避 1s→30s；稳定 60s 才清零预算（见 restart-budget.js）
    this.restartBudget = new RestartBudget({
      windowMs: 10 * 60 * 1000,
      max: 10,
      baseDelayMs: 1000,
      maxDelayMs: Math.max(RECONNECT_MAX_MS, 30000),
      stableMs: 60000,
      jitter: 0.25,
    });
  }

  #closedByUs;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  /**
   * 安排一次重连（唯一入口）。所有断线路径都必须走这里，
   * 否则会出现"有的地方按预算退避、有的地方 3 秒硬连"的两套策略。
   */
  #scheduleReconnect(uptimeMs = 0) {
    if (this.#closedByUs) return;
    if (uptimeMs > 0) {
      const stable = this.restartBudget.recordStable(uptimeMs);
      if (stable.cleared) console.log(`[onebot] 已稳定运行 ${Math.round(uptimeMs / 1000)}s，重连预算清零`);
    }
    const v = this.restartBudget.recordFailure();
    if (!v.allowed) {
      this.nextRetryAt = 0;
      this.#setStatus(false);
      const msg = `[onebot] ${v.reason}。已停止自动重连，请检查协议端（SnowLuma/NapCat）后手动重试。`;
      console.error(msg);
      try { this.onExhausted?.(v); } catch { /* 回调不该影响主流程 */ }
      return;
    }
    this.nextRetryAt = Date.now() + v.delayMs;
    setTimeout(() => this.#connectLoop(), v.delayMs);
  }

  /** 人工"再试一次"：清空预算并立刻重连（控制台/手机端用）。 */
  retryNow() {
    this.restartBudget.reset();
    this.nextRetryAt = 0;
    this.#closedByUs = false;
    this.#connectLoop();
  }

  restartState() {
    const s = this.restartBudget.snapshot();
    return { ...s, nextRetryAt: this.nextRetryAt, connectedAt: this.connectedAt };
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      this.#scheduleReconnect(0);
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.connectedAt = Date.now();
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      const uptime = this.connectedAt ? Date.now() - this.connectedAt : 0;
      this.connectedAt = 0;
      this.#setStatus(false);
      this.#scheduleReconnect(uptime);
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = 15000) {
    // 已知不支持的动作不要每次都去撞：首次撞到后记下来，上层能提前降级
    if (this.unsupported.has(action)) {
      const e = new Error(`当前协议端不支持「${action}」`);
      e.code = 'EPLATFORM_UNSUPPORTED';
      e.action = action;
      throw e;
    }
    let res;
    try {
      res = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // 网络层错误：保留原始 code（send-ledger 靠它判断"确定失败/结果不确定"）
      throw error;
    }
    // 回包判定走 src/onebot-result.js（纯函数叶子）：传输成功与业务成功是两个正交字段。
    // 别再写成 `status !== 'ok' && retcode !== 0` —— 那样 `retcode=0 + status=failed`
    // 会被判成成功，正是"以为发出去了其实没有"那类假象。
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const j = judgeCall({ transportOk: res.ok, httpStatus: res.status, body, action });
    if (j.kind === 'transport') {
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      const error = new Error(`OneBot ${action} HTTP ${res.status}${hint}`);
      error.status = res.status;
      error.result = j;
      if (res.status === 404 || res.status === 400) {
        // 404/400 在多数实现里就是"没这个接口"
        this.unsupported.add(action);
        error.code = 'EPLATFORM_UNSUPPORTED';
      }
      throw error;
    }
    if (j.kind === 'no-body') {
      // 传输通了但读不出响应体：请求可能已经被处理了 → 当"结果不确定"，
      // 让上层落台账、不重发，而不是当成确定失败再发一遍。
      const error = new Error(`OneBot ${action} 响应体读不出来（HTTP ${res.status}）`);
      error.status = res.status;
      error.result = j;
      error.uncertain = true;
      throw error;
    }
    if (!j.ok) {
      const error = new Error(`OneBot ${action} 失败: ${j.reason}`);
      error.retcode = j.retcode;
      error.result = j;
      // ⚠️ 必须排在 looksUnsupported 之前。
      // NapCat 发包能力不可用时的文案是「packetBackend发包能力不可用……PacketBackend
      // 不支持当前QQ版本架构」，里面带「不支持」三个字 → 会被 looksUnsupported 误判成
      // 「协议端没有这个接口」，于是 send_poke/group_poke 被永久拉黑，
      // 之后连"到底是接口没有、还是这台机器发包坏了"都分不清。
      // 这两种失败的处理完全不同：接口没有 → 换个动作名；发包坏了 → 换动作名也没用。
      if (isPacketUnavailable(j.wording)) {
        error.code = 'EPLATFORM_NO_PACKET';
        error.fatal = true;
        error.message = `协议端发包能力不可用（${action}）：${j.wording || `retcode=${j.retcode}`}`;
        throw error;
      }
      if (looksUnsupported(j)) {
        this.unsupported.add(action);
        error.code = 'EPLATFORM_UNSUPPORTED';
        error.message = `当前协议端不支持「${action}」（${j.wording || `retcode=${j.retcode}`}）`;
      }
      throw error;
    }
    return body.data;
  }

  /** 能力表：哪些动作已知不可用（被撞到过的）。 */
  capabilities() {
    return {
      connected: this.connected,
      unsupported: [...this.unsupported],
      supports: (action) => !this.unsupported.has(String(action)),
    };
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  /**
   * 拼「回复 + @ + 正文段」的公共前两段。
   *
   * 抽出来的原因：四个发送方法各抄一遍，其中一份还抄错了正则
   * （`[1-9]d*` 少了反斜杠 → 只要消息 id 超过一位就判"必须是整数"，
   *  表现为「回复某条消息时发图/发表情直接失败」）。
   *
   * ⚠️ 私聊不发 `at` 段：QQ 私聊没有 @ 语义，带上它 NapCat 会让整条消息失败。
   *    以前这里不区分场景，模型在私聊里传了 atUserId（很常见）就整条发不出去。
   */
  #prefixSegments(kind, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      if (kind === 'group') segments.push({ type: 'at', data: { qq: at } });
    }
    return segments;
  }

  async sendText(kind, id, text, options = {}) {
    const segments = this.#prefixSegments(kind, options);
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendSticker(kind, id, imageUrl, options = {}) {
    const segments = this.#prefixSegments(kind, options);
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发送一条语音（NapCat 的 record 段）。
   * file 支持：本地绝对路径 / http(s) URL / base64:// —— 与图片段同一套解析（NapCat 上传时会转成 SILK）。
   */
  async sendRecord(kind, id, file, options = {}) {
    const segments = this.#prefixSegments(kind, options);
    segments.push({ type: 'record', data: { file: String(file) } });
    return this.sendSegments(kind, id, segments);
  }

  /** 发送一张任意公网图片（URL 或本地路径），与表情同构。 */
  async sendImage(kind, id, imageUrl, options = {}) {
    const segments = this.#prefixSegments(kind, options);
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  /** 上传文件到群/私聊（NapCat upload_group_file / upload_private_file）。 */
  async sendFile(kind, id, filePath, fileName) {
    const action = kind === 'private' ? 'upload_private_file' : 'upload_group_file';
    const params = kind === 'private'
      ? { user_id: Number(id), file: String(filePath), name: String(fileName || String(filePath).split('/').pop()) }
      : { group_id: Number(id), file: String(filePath), name: String(fileName || String(filePath).split('/').pop()) };
    return this.call(action, params, 60000);
  }

  /**
   * 拍一拍。
   *
   * 为什么同一件事要准备四种写法（2026-10-22 修的正是这里）：
   *   · **ID 的类型**：NapCat 的 poke schema 把 user_id / group_id 定成**字符串**
   *     （见 snowluma/napcat.mjs 的 `Nwe`：p.String()），传数字会被 TypeBox 直接拒；
   *     而别的协议端按 OneBot v11 规范要 int64。两边要的不是同一种东西。
   *   · **动作名**：`group_poke`/`friend_poke` 是各家扩展名，`send_poke` 是标准名，
   *     不同实现支持的不一样。
   *
   * 之前只写了一种（数字 + 扩展名）：于是**每一次拍一拍都被参数校验挡回来**，
   * 而失败只进了 console.log —— 面板和存档里照样写着"已经拍回去了"。
   * 实测 94 次回拍、真发出去 0 次，就是这个原因。
   *
   * 顺序：先字符串（当前协议端要的），再数字（照顾别的协议端）；
   * 每种类型里先扩展名、后标准名。**只有确定失败才换下一种** ——
   * 结果不确定的（可能已经拍出去了）立刻停手：宁可拍不出去，也不能连拍两下。
   */
  async sendPoke(kind, id, targetUserId) {
    const gid = String(id);
    const uid = String(targetUserId || id);
    const forms = kind === 'private'
      ? [
        ['friend_poke', { user_id: uid }],
        ['send_poke', { user_id: uid }],
        ['friend_poke', { user_id: Number(uid) }],
        ['send_poke', { user_id: Number(uid) }],
      ]
      : [
        ['group_poke', { group_id: gid, user_id: uid }],
        ['send_poke', { group_id: gid, user_id: uid }],
        ['group_poke', { group_id: Number(gid), user_id: Number(uid) }],
        ['send_poke', { group_id: Number(gid), user_id: Number(uid) }],
      ];
    return this.#firstWorkingPoke(forms);
  }

  async #firstWorkingPoke(forms) {
    let last = null;
    for (const [action, params] of forms) {
      try {
        return await this.call(action, params);
      } catch (error) {
        // 结果不确定 = 这一下**可能已经拍出去了**：不再试下一种
        if (error?.uncertain) throw error;
        // 发包能力整台坏了：换动作名 / 换数字形态照样发不出去，白试还拖慢回包
        if (error?.code === 'EPLATFORM_NO_PACKET') throw error;
        last = error;
      }
    }
    throw last ?? new Error('拍一拍：所有写法都试过了，没有可用的');
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getForwardMsg(forwardId) {
    const id = String(forwardId ?? '').trim();
    if (!id) throw new Error('forwardId 不能为空');
    return this.call('get_forward_msg', { message_id: id });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

function forwardNodesFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['messages', 'content', 'nodes']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data !== payload) return forwardNodesFromPayload(payload.data);
  return [];
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function clipForwardText(text, limit) {
  const value = String(text ?? '').trim();
  if (!limit || value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)) + '…';
}

// 卡片里装跳转地址的字段名。不同 app 叫法不一样，按命中率排：
//   jumpUrl（structmsg 新闻卡）/ qqdocurl（公众号文章）/ url（通用）/ preview
const CARD_URL_KEYS = ['jumpUrl', 'qqdocurl', 'qqdocUrl', 'jump_url', 'url', 'preview', 'picUrl'];
const CARD_TITLE_KEYS = ['title', 'desc', 'nickname', 'name'];

/**
 * 从 QQ 分享卡片的 json 段里抠出真正的跳转链接。
 *
 * 为什么必须抠：群友发「公众号文章 / 网页 / 音乐」时，QQ 给的是 `type:'json'` 段，
 * 正文只是一个 `{app:'com.tencent.structmsg', meta:{news:{jumpUrl:'https://…'}}}` 的字符串。
 * 以前我们只输出 `[卡片消息]`，模型手里没有 URL，只能干瞪眼 —— 这就是
 * "有时候解析不了网址"里最典型的一种（而且**每次发卡片都复现**，不是偶尔）。
 *
 * 拿不到就返回 `{url:''}`，**不猜**（宁可让模型说"打不开"，也不要编一个地址去抓）。
 */
export function cardLinkFromJson(data) {
  const empty = { url: '', title: '', desc: '' };
  const raw = data?.data ?? data?.content ?? data?.json ?? '';
  let obj = null;
  if (raw && typeof raw === 'object') obj = raw;
  else if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch {
      // 有些协议端会把 json 转义两次
      try { obj = JSON.parse(JSON.parse('"' + raw.replace(/"/g, '\\"') + '"')); } catch { obj = null; }
      if (!obj) {
        const m = raw.match(/https?:\/\/[^\s"'\\]+/);
        return m ? { url: m[0].replace(/[，。、；：！？]+$/u, ''), title: '', desc: '' } : empty;
      }
    }
  }
  if (!obj || typeof obj !== 'object') return empty;

  // 深度有限遍历：卡片结构最多两层（obj.meta.news.xxx），不做无限递归
  const found = { url: '', title: '', desc: '' };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (!found.url && CARD_URL_KEYS.includes(key) && /^https?:\/\//i.test(value)) found.url = value;
        if (!found.title && CARD_TITLE_KEYS.includes(key) && value.trim() && value.length < 120) found.title = value.trim();
        else if (!found.desc && key === 'desc' && value.trim()) found.desc = value.trim().slice(0, 80);
      } else if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  };
  walk(obj, 0);
  if (!found.url) {
    // 最后兜底：整份 json 里第一个 http(s) 字符串（有些卡片把地址藏在 prompt 里）
    const m = JSON.stringify(obj).match(/https?:\\?\/\\?\/[^\s"',}]+/);
    if (m) found.url = m[0].replace(/\\\//g, '/');
  }
  return found;
}

/**
 * 把 get_forward_msg 返回的 node 列表压成一行可读文本。
 * NapCat 在不同版本里会把内容放在 message/content，发送者也可能是嵌套对象。
 */
export async function forwardPayloadToText(payload, {
  resolveReply = null,
  resolveAtName = null,
  maxNodes = 30,
  maxChars = 4000,
  forwardDepth = 0
} = {}) {
  const nodes = forwardNodesFromPayload(payload);
  if (!nodes.length) return '';

  const limit = Math.max(1, Number(maxNodes) || 30);
  const parts = [];
  const rows = [];   // 先按节点收成结构化的 {who, body}，折叠完再渲染成文本
  for (const node of nodes.slice(0, limit)) {
    const data = node?.data && typeof node.data === 'object' ? node.data : node;
    const sender = data?.sender ?? node?.sender ?? {};
    const senderId = firstText(
      data?.user_id,
      data?.userId,
      data?.senderId,
      sender?.user_id,
      sender?.userId,
      node?.user_id,
      node?.userId
    );
    const senderName = firstText(
      data?.nickname,
      data?.name,
      data?.senderName,
      sender?.card,
      sender?.nickname,
      node?.nickname,
      node?.name,
      senderId
    );
    const rawMessage = data?.message ?? data?.content ?? node?.message ?? node?.content ?? '';
    let body = '';
    if (typeof rawMessage === 'string') {
      body = rawMessage;
    } else if (Array.isArray(rawMessage)) {
      body = await segmentsToText(rawMessage, {
        resolveReply,
        resolveAtName,
        includeReply: true,
        forwardDepth: forwardDepth + 1
      });
    } else if (rawMessage && typeof rawMessage === 'object') {
      body = await segmentsToText([rawMessage], {
        resolveReply,
        resolveAtName,
        includeReply: true,
        forwardDepth: forwardDepth + 1
      });
    }
    const clipped = clipForwardText(body, Math.max(80, Math.floor(maxChars / Math.max(1, Math.min(limit, nodes.length)))));
    const who = senderName ? (senderId && senderId !== senderName ? `${senderName}(QQ:${senderId})` : senderName) : '';
    if (who || clipped) {
      // ⚠️ 2026-10-26 修：折叠必须拿**裁剪前**的原文比。
      // 30 个节点时每条被裁到 133 字，两条完全不同的长消息只要开头一样就会被判成
      // "连续 2 条" —— 后半段内容永久丢失，还向模型谎报"这两条一样"。
      rows.push({ who, body: clipped || '[空消息]', raw: body });
    }
  }
  // 连续重复折叠（2026-10-25 从 qq-bridge 媒体能力包的 formatForwardResponse 学的）。
  //
  // 为什么：群里刷屏/复读在合并转发里是几十条一模一样的行，原样铺开会把
  // maxChars 预算吃光，而且模型会跟着复述（"哈哈哈哈"×30 变成它的语感来源）。
  // 压成 `哈哈哈哈（连续 12 条）` 既保住了"刷屏"这个事实，又只占一行。
  //
  // 两处比原版更保守：
  //   · body 为空占位 `[空消息]` 不折叠（每条空消息都是独立节点，折了会丢条数）；
  //   · 发送者不同时标 `多人`，否则模型会以为是一个人连发了 12 条。
  const folded = [];
  for (const row of rows) {
    const prev = folded[folded.length - 1];
    if (prev && row.raw === prev.raw && row.body !== '[空消息]') {
      prev.count += 1;
      if (row.who !== prev.who) prev.mixed = true;
      continue;
    }
    folded.push({ who: row.who, body: row.body, raw: row.raw, count: 1, mixed: false });
  }
  for (const r of folded) {
    const times = r.count > 1 ? `（连续 ${r.count} 条${r.mixed ? '，多人' : ''}）` : '';
    // 多人连发时署名第一个人是失真的（"张三：哈哈（连续 12 条，多人）"）
    parts.push(`${r.who && !r.mixed ? `${r.who}：` : ''}${r.body}${times}`);
  }
  let out = parts.join(' | ');
  // 尾部提示要给足余量，否则会被下面的整体裁剪吃掉 ——
  // 模型就不知道列表被砍过，会把"就这些"当成完整转发。
  if (nodes.length > limit) {
    const tail = ` | ……还有 ${nodes.length - limit} 条未展开`;
    out = clipForwardText(out, Math.max(80, maxChars - tail.length)) + tail;
    return out;
  }
  return clipForwardText(out, maxChars);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 * resolveForward: async (id) => get_forward_msg 的 data —— 解析合并转发内容。
 */
export async function segmentsToText(segments, {
  resolveReply = null,
  resolveAtName = null,
  resolveForward = null,
  includeReply = true,
  forwardDepth = 0,
  selfId = ''
} = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else if (selfId && String(d.qq) === String(selfId)) {
          // 直接 @ 机器人自己：标成「@我」。既让模型一眼看出"这是叫我"，
          // 也让唤醒闸门不必去猜它的昵称（昵称可能被改、可能带群名片后缀）。
          out.push('@我');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(faceText(d.id)); break;
      // mface = 商城表情 / 大表情 / 表情包（QQ 自带表情里那些动图）
      case 'mface': out.push(marketFaceText(d)); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': {
        // 带上文件名和大小；file_id 通过 media 单独传给模型（见 mediaHint），避免刷屏
        const fname = String(d.name ?? d.file ?? '未命名');
        const fsize = Number(d.file_size ?? d.size ?? 0);
        const sizeText = fsize ? ` ${Math.max(1, Math.round(fsize / 1024))}KB` : '';
        out.push(`[文件：${fname}${sizeText}]`);
        break;
      }
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': {
        // QQ 的分享卡片（公众号文章/网页/小程序/音乐）。以前这里一律输出 [卡片消息]，
        // 结果群友甩来一张链接卡片，模型只知道"有张卡片"，没有网址可抓 ——
        // 这是"有时候解析不了网址"最常见的一种。卡片里的跳转地址其实就在 json 里。
        const card = cardLinkFromJson(d);
        if (card.url) {
          const bits = [card.title, card.desc].filter(Boolean).join(' — ');
          out.push(`[卡片消息${bits ? `：${bits}` : ''} 链接=${card.url}]`);
        } else {
          out.push('[卡片消息]');
        }
        break;
      }
      case 'forward': {
        const fid = forwardIdFromData(d);
        let inlineNodes = forwardNodesFromPayload(d.content);
        let detail = '';
        if (inlineNodes.length) {
          detail = await forwardPayloadToText(inlineNodes, {
            resolveReply,
            resolveAtName,
            forwardDepth
          });
        } else if (fid && resolveForward && forwardDepth < 2) {
          try {
            const payload = await resolveForward(fid);
            detail = await forwardPayloadToText(payload, {
              resolveReply,
              resolveAtName,
              forwardDepth: forwardDepth + 1
            });
          } catch { /* 解析失败时保留下面的占位符 */ }
        }
        if (detail) {
          out.push(`[转发消息${fid ? ` id=${fid}` : ''}：${detail}]`);
        } else {
          out.push(fid ? `[转发消息 id=${fid}（读取失败）]` : '[转发消息]');
        }
        break;
      }
      case 'node': {
        // 嵌套转发套娃没有天然上限（抓包里见过 node 里再套 node），不设闸门就是无界递归。
        // 与上面 `resolveForward && forwardDepth < 2` 同一口径：最多展开两层。
        if (forwardDepth >= 2) { out.push('[转发节点：嵌套过深，已省略]'); break; }
        const nodes = forwardNodesFromPayload(d.message ?? d.content ?? seg);
        const detail = await forwardPayloadToText(nodes, {
          resolveReply,
          resolveAtName,
          forwardDepth: forwardDepth + 1
        });
        out.push(detail ? `[转发节点：${detail}]` : '[转发节点]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      const faceId = String(d.id ?? '');
      media.push({ kind: 'face', faceId, name: faceName(faceId) || '' });
    } else if (seg.type === 'mface') {
      // 商城表情/大表情：没有稳定的 faceId，但有企鹅给的 summary（通常是表情本名）
      media.push({
        kind: 'face',
        faceId: String(d.emoji_id ?? d.emojiId ?? ''),
        name: String(d.summary ?? d.text ?? '').replace(/^[[【]|[\]】]$/g, '').trim(),
        url: String(d.url ?? '')
      });
    } else if (seg.type === 'file') {
      // 文件消息：file_id 是取回文件的唯一凭据（NapCat get_file 接口要用它）
      media.push({
        kind: 'file',
        fileId: String(d.file_id ?? d.id ?? ''),
        name: String(d.name ?? d.file ?? ''),
        size: Number(d.file_size ?? d.size ?? 0) || 0,
        url: String(d.url ?? '')
      });
    } else if (seg.type === 'video') {
      // path 是 NapCat 给的本地缓存路径；url 有时是 CDN 链接、有时就是那个本地路径。
      // 两者都留着 —— 取帧时先挑本地封面帧/本地原文件，再退到网络（见 tools.js）。
      media.push({
        kind: 'video',
        file: String(d.file ?? ''),
        fileId: String(d.file_id ?? ''),
        path: String(d.path ?? ''),
        url: String(d.url ?? ''),
        size: Number(d.file_size ?? d.size ?? 0) || 0
      });
    } else if (seg.type === 'record') {
      // 语音：file 通常是协议端缓存里的文件名（SILK），url 是可下载地址；
      // 真正取回内容时交给 NapCat 的 get_record 转码（见 tools.js 的 voice_to_text）
      media.push({
        kind: 'record',
        file: String(d.file ?? ''),
        fileId: String(d.file_id ?? d.fileId ?? ''),
        url: String(d.url ?? ''),
        seconds: Number(d.seconds ?? d.duration ?? 0) || 0
      });
    }
  }
  return media;
}

/**
 * 把合并转发里的图片/视频/语音也收集成 media。
 *
 * 为什么需要单独一个函数：extractMediaFromSegments 只看顶层消息段，
 * 而转发消息段里只有转发 id（内容要另外 get_forward_msg 才拿得到）。
 * 结果就是「转发里的图看不到」——模型只看到 [图片] 占位符，
 * 调 get_message_images 又被告知「这条消息没有可查看的图片」。
 *
 * @param {any} payload get_forward_msg 的返回，或内联的 nodes 数组
 * @returns {Array<{kind:string,file:string,url:string,fileId?:string,name?:string,summary?:string,fromForward?:boolean}>}
 */
export function collectForwardMedia(payload, { max = 6, depth = 0 } = {}) {
  const out = [];
  if (depth > 1) return out;                      // 转发套转发只挖一层，别把上下文撑爆
  const nodes = forwardNodesFromPayload(payload);
  for (const node of nodes) {
    if (out.length >= max) break;
    const data = node?.data && typeof node.data === 'object' ? node.data : node;
    const raw = data?.message ?? data?.content ?? node?.message ?? node?.content ?? '';
    const segs = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
    for (const seg of segs) {
      if (out.length >= max) break;
      const d = seg?.data ?? {};
      if (seg?.type === 'image') {
        out.push({
          kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''),
          summary: String(d.summary ?? ''), fromForward: true,
        });
      } else if (seg?.type === 'video') {
        out.push({
          kind: 'video', file: String(d.file ?? ''), url: String(d.url ?? ''),
          fileId: String(d.file_id ?? ''), path: String(d.path ?? ''),
          name: String(d.name ?? d.file_name ?? ''), fromForward: true,
        });
      } else if (seg?.type === 'record') {
        out.push({
          kind: 'record', file: String(d.file ?? ''), fileId: String(d.file_id ?? ''),
          url: String(d.url ?? ''), seconds: Number(d.seconds ?? 0) || 0, fromForward: true,
        });
      } else if (seg?.type === 'file') {
        out.push({
          kind: 'file', fileId: String(d.file_id ?? ''), name: String(d.name ?? d.file ?? ''),
          size: Number(d.file_size ?? 0) || 0, url: String(d.url ?? ''), fromForward: true,
        });
      } else if (seg?.type === 'forward') {
        // 转发里还套着转发：内容有时直接内联在 data.content 里
        for (const m of collectForwardMedia(d.content ?? d, { max: max - out.length, depth: depth + 1 })) out.push(m);
      }
    }
  }
  return out;
}
