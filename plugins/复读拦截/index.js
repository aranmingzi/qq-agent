// 复读拦截 —— before-tool 钩子否决重复 send_message
// 移植自 Estrella-Bot，适配 QQ Agent 的 send_message 工具（args.messages 为字符串或数组）
//
// 2026-10-29 第 12 轮修正：记账时机从 before-tool 挪到 after-tool。
//
// 原来的写法在**发送之前**就把这句话记进 history，于是"这一次发送失败了"这句话
// 也被当成"已经说过"。模型的正常反应是换个说法重发 —— 但复读拦截拿它自己的
// 失败记录把它挡下，用户看到的就是"它没理我"。
//
// 实测（1000 个真实会话、15 次复读拦截）：5 次的上一句其实是失败的
// （4 次撞分钟额度、1 次白名单失效），另有 1 次是模型重发时把整轮
// messages 传成了 JSON 字符串、回显里带 `["` 前缀，把两种失败叠在了一起。
//
// 所以：只有**真的发出去了**（after-tool 且未报错）才记账。
// 代价是同一轮里并行调两次 send_message 时，第二次看不到第一次 —— 但
// orchestrator 是按 tool_calls 顺序逐个 before-tool → 执行 → after-tool 的，
// 所以先后顺序仍然保得住，这个代价实际上不存在。

let cfg = () => ({});
let log = () => {};

/** chatKey → { texts: string[], at: number[] } */
const history = new Map();

/** 待记账：chatKey → [{ texts }]，等 after-tool 确认成功再落账 */
const pending = new Map();

function pushPending(chatKey, texts) {
  const q = pending.get(chatKey) || [];
  q.push({ texts });
  // 兜底：after-tool 理论上总会来；万一没来（进程被杀、插件被禁用），别让它无限长
  if (q.length > 32) q.splice(0, q.length - 32);
  pending.set(chatKey, q);
}

function popPending(chatKey) {
  // 只认带 chatKey 的：after-tool 不带会话就没法判断这句属于哪个群，
  // 猜错会把 A 群的话记到 B 群头上（然后 B 群里一句全新的话被莫名拦下）。
  // 拿不到就**不记账** —— 记账失败只会让复读拦截少拦一次（放行，安全方向），
  // 而记错群会让用户莫名其妙说不出话。
  if (!chatKey) return null;
  const q = pending.get(chatKey);
  if (!q || !q.length) return null;
  const item = q.shift();
  if (!q.length) pending.delete(chatKey);
  return { chatKey, texts: item.texts };
}

function windowMs() {
  return Math.max(1, Number(cfg()?.windowMin) || 20) * 60 * 1000;
}

function minLen() {
  return Math.max(2, Number(cfg()?.minLen) || 6);
}

function maxPerRun() {
  return Math.max(1, Number(cfg()?.maxPerRun) || 6);
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[。．.!！?？~～…、,，;；:："'"'“”‘’()（）\[\]【】]/g, '');
}

function isNearDup(a, b) {
  if (a === b) return true;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  if (x.length >= minLen() && y.includes(x)) return true;
  if (y.length - x.length <= 2) {
    let diff = 0;
    for (let i = 0, j = 0; i < x.length && j < y.length; i++, j++) {
      if (x[i] !== y[j]) {
        diff++;
        if (diff > 2) return false;
        if (x[i] === y[j + 1]) j++;
        else if (x[i + 1] === y[j]) i++;
      }
    }
    return diff <= 2;
  }
  return false;
}

function prune(chatKey) {
  const h = history.get(chatKey);
  if (!h) return null;
  const cut = Date.now() - windowMs();
  const texts = [];
  const at = [];
  for (let i = 0; i < h.texts.length; i++) {
    if ((h.at[i] || 0) >= cut) {
      texts.push(h.texts[i]);
      at.push(h.at[i]);
    }
  }
  const next = { texts, at };
  history.set(chatKey, next);
  return next;
}

function remember(chatKey, text) {
  const h = history.get(chatKey) || { texts: [], at: [] };
  h.texts.push(text);
  h.at.push(Date.now());
  if (h.texts.length > 80) {
    h.texts = h.texts.slice(-80);
    h.at = h.at.slice(-80);
  }
  history.set(chatKey, h);
}

/** 把 args.messages 摊平成字符串数组（模型可能传数组、字符串、或数组的 JSON 字符串）。 */
function textsOf(argsRaw) {
  let args = argsRaw;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  let raw = args?.messages;
  // 模型偶尔把整个数组序列化成**字符串**再塞进 messages：
  //   messages: "[\"甲\", \"乙\"]"
  // 老代码把这一整串当成一句话，norm() 之后开头的 `["` 留在判重串里，
  // 于是回显给模型的否决原因也带着 `["` —— 实测见过一次。
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) raw = parsed;
      } catch { /* 保持原字符串 */ }
    } else if (t.startsWith('"')) {
      try {
        const parsed = JSON.parse(t);
        if (typeof parsed === 'string') raw = parsed;
      } catch { /* 保持原字符串 */ }
    }
  }
  if (Array.isArray(raw)) return raw.map((m) => String(m ?? '')).filter((s) => s.trim());
  if (raw == null) return [];
  return [String(raw)];
}

/** 从工具结果里读"真正发出去几条"；读不出来返回 -1（按全成功处理）。 */
function sentCountOf(result) {
  if (typeof result !== 'string') return -1;
  try {
    const parsed = JSON.parse(result);
    const n = Number(parsed?.sent);
    return Number.isFinite(n) && n >= 0 ? n : -1;
  } catch {
    return -1;
  }
}

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
}

export const hooks = {
  'before-tool': ({ toolName, argsRaw, session } = {}) => {
    try {
      if (!/send_message/i.test(String(toolName || ''))) return;
      if (cfg()?.enabled === false) return;

      const msgs = textsOf(argsRaw);
      if (!msgs.length) return;

      const chatKey = String(session?.chatKey || '');
      const h = prune(chatKey);
      const blocked = [];
      const pass = [];
      for (const m of msgs) {
        const n = norm(m);
        if (n.length < minLen()) { pass.push(m); continue; }
        const dup = (h?.texts || []).some((prev) => isNearDup(n, prev));
        if (dup) blocked.push(m);
        else pass.push(m);
      }

      if (!pass.length && blocked.length) {
        return {
          block: true,
          reason: `复读拦截：「${String(blocked[0]).slice(0, 30)}」和刚发过的几乎一样。换个说法，或直接结束。`
        };
      }

      const sentCount = Array.isArray(session?.sent)
        ? session.sent.filter((s) => s?.type === 'text').length
        : 0;
      if (sentCount + pass.length > maxPerRun()) {
        return {
          block: true,
          reason: `这一轮已经发了 ${sentCount} 条（上限 ${maxPerRun()}），别再刷了。`
        };
      }

      // 不在这里记账 —— 等 after-tool 确认发出去了再记（见文件头）。
      pushPending(chatKey, pass.map(norm));
      if (blocked.length) log(`[echo-guard] 跳过 ${blocked.length} 条复读`);
      return undefined;
    } catch (e) {
      log('[echo-guard]', e?.message ?? e);
      return undefined;
    }
  },

  // 记账时机：只有**真的发出去**才算"说过"。
  'after-tool': ({ toolName, result, isError, session } = {}) => {
    try {
      if (!/send_message/i.test(String(toolName || ''))) return;
      if (!pending.size) return;
      const item = popPending(String(session?.chatKey || ''));
      if (!item) return;
      // 失败 = 没发出去 = 不该记成"说过"（正是本轮要修的 bug）
      if (isError) return;
      const sent = sentCountOf(result);
      const texts = sent >= 0 ? item.texts.slice(0, sent) : item.texts;
      for (const t of texts) if (t) remember(item.chatKey, t);
    } catch (e) {
      log('[echo-guard]', e?.message ?? e);
    }
  }
};
