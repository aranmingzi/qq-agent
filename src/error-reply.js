// 模型失败可见化 —— 「她不说话」和「她坏了」必须能区分开。
//
// ── 现状（2026-10-29 复盘）────────────────────────────────────────────
// 模型彻底失败时，wake() 的 catch 只做三件事：
//   session.error = …、sessions.finish('error')、console.error。
// 于是用户端看到的是**和"她决定不接话"一模一样**的静默；运营端在面板上连一条
// skip 记录都没有 —— 唯一线索是控制台里那行 stderr，而它会被下一次刷屏冲掉。
// 这就是"她刚才没理我"最难查的那一类：代码没崩，账本也没有，只剩一句口头描述。
//
// ── 三种失败必须分开，判据是「谁该负责」──────────────────────────────
//   ① 运营的锅（欠费 / 密钥失效 / 模型名不存在 / 参数不合法）：用户端说一句人话
//      没有任何用处，只有主人能修 → 只给主人看技术诊断，绝不发到群里；
//   ② 网络的锅（超时 / 断网 / 限流 / 5xx）：过一会儿自己就好，可以说句"卡了一下"
//      把这一轮圆过去（这是**拟人**，不是撒谎：真人也会说"刚走神了"）；
//   ③ 我们的锅（上下文超长 / 未知异常）：属于代码问题，拿去当人设说话只会污染人格。
//
// ── 四条纪律 ─────────────────────────────────────────────────────────
//   · 纯函数：不读配置、不碰磁盘、不看时钟（时间与冷却由调用方传进来），
//     这样测试能造确定的场景，也不会因为 import 就产生副作用；
//   · 已经说过话的一轮**绝不补道歉**：用户已经拿到回复，再来一句"刚才出错了"
//     只会让人怀疑前面那句也是假的；
//   · 主动机会（proactive）失败一律不出声 —— 没人问，别自曝；
//   · 文案不解释内部细节（"HTTP 402"），也不假装没事（"我在呢"）：
//     只说"卡了一下"，既不撒谎，也不掉人设。

/** 失败类别。刻意用**短横线**命名：它会落进 skip-log 的 detail，方便 grep。 */
export const ERROR_KINDS = {
  QUOTA: 'quota',             // 欠费 / 余额不足 / 402
  AUTH: 'auth',               // 密钥失效 / 401 / 403
  RATE_LIMIT: 'rate-limit',   // 429 / 请求过于频繁
  TIMEOUT: 'timeout',         // 本端超时（llm.js 自己抛的）
  NETWORK: 'network',         // 连不上 / DNS / 连接被重置
  SERVER: 'server',           // 5xx / 返回体解析不了 / 缺 choices
  CONTEXT: 'context',         // 上下文超长
  BAD_REQUEST: 'bad-request', // 400 / 422（参数或工具 schema 不合法）
  UNKNOWN: 'unknown'
};

/** 谁该为这次失败负责。决定"发给谁"：`operator` 只给主人，`transient` 可以说人话。 */
export const OWNER = { OPERATOR: 'operator', TRANSIENT: 'transient' };

const OWNER_OF = {
  [ERROR_KINDS.QUOTA]: OWNER.OPERATOR,
  [ERROR_KINDS.AUTH]: OWNER.OPERATOR,
  [ERROR_KINDS.BAD_REQUEST]: OWNER.OPERATOR,
  [ERROR_KINDS.CONTEXT]: OWNER.OPERATOR,
  [ERROR_KINDS.UNKNOWN]: OWNER.OPERATOR,
  [ERROR_KINDS.RATE_LIMIT]: OWNER.TRANSIENT,
  [ERROR_KINDS.TIMEOUT]: OWNER.TRANSIENT,
  [ERROR_KINDS.NETWORK]: OWNER.TRANSIENT,
  [ERROR_KINDS.SERVER]: OWNER.TRANSIENT
};

/** 中文标签（写进 skip-log 和诊断文案，给人看的）。 */
const LABEL_OF = {
  [ERROR_KINDS.QUOTA]: '账户欠费或余额不足',
  [ERROR_KINDS.AUTH]: '密钥无效或没有权限',
  [ERROR_KINDS.RATE_LIMIT]: '被限流（请求过于频繁）',
  [ERROR_KINDS.TIMEOUT]: '请求超时',
  [ERROR_KINDS.NETWORK]: '网络连不上',
  [ERROR_KINDS.SERVER]: '服务端出错',
  [ERROR_KINDS.CONTEXT]: '上下文超出模型上限',
  [ERROR_KINDS.BAD_REQUEST]: '请求参数不合法',
  [ERROR_KINDS.UNKNOWN]: '未知错误'
};

// ── 判据（正则顺序即优先级）──────────────────────────────────────────────
// 上下文超长必须**排在 400 前面**：它通常就是 400，只是正文里点了名。
// 这条与 orchestrator.js::isContextOverflowError 的判据保持一致 —— 两处判法不同
// 就会出现"上面裁了历史重试，下面还当成参数错误去报"的自相矛盾。
// （2026-10-29 实测踩到：那边能认出 `Input length must be less than 8192`，
//   这边只写了 `input is too long`，于是同一句话一边算可裁剪、一边算参数错误。）
export const CONTEXT_RE = /context[ _-]?length|maximum context|too many tokens|prompt is too long|input is too long|input.{0,12}length.{0,24}(less|exceed|max|limit)|exceed[a-z_ ]{0,12}(context|token)|上下文.{0,10}(过长|超)|(tokens|长度).{0,20}(超出|超过|limit)/i;
const QUOTA_RE = /余额不足|欠费|余额|insufficient|quota|billing|arrears|recharge|payment required|not enough credit/i;
const AUTH_RE = /invalid.{0,16}(api.?key|token|key)|unauthorized|forbidden|incorrect api key|authentication|鉴权|密钥|令牌|无权限/i;
const RATE_RE = /rate.?limit|too many requests|请求过于频繁|限流|TPM|RPM/i;
const TIMEOUT_RE = /超时|timeout|timed out|ETIMEDOUT/i;
const NETWORK_RE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|fetch failed|socket hang up|network error|网络|连不上|DNS/i;
const SERVER_RE = /无法解析的 JSON|缺少 choices|HTTP 5\d\d|internal server error|bad gateway|service unavailable|gateway timeout|upstream/i;

/**
 * 判断一次失败属于哪一类。
 *
 * @param {string} message 原始错误文案（本项目 llm.js 抛出的形态：
 *   `模型 API HTTP 402：…` / `模型请求超时（180000ms）` / `模型请求失败：fetch failed`）
 * @returns {{kind:string, owner:string, label:string, httpCode:number, retryable:boolean}}
 */
export function classifyLlmError(message) {
  const m = String(message ?? '');
  const httpMatch = /HTTP\s+(\d{3})\b/.exec(m);
  const httpCode = httpMatch ? Number(httpMatch[1]) : 0;
  const make = (kind) => ({
    kind,
    owner: OWNER_OF[kind] || OWNER.OPERATOR,
    label: LABEL_OF[kind] || LABEL_OF[ERROR_KINDS.UNKNOWN],
    httpCode,
    // 「值得再试一次」与 model-fallback 的判据独立：那边决定"要不要换模型"，
    // 这边只决定"要不要告诉用户'过会儿再试'"。400 换模型没用，但也不算可重试。
    retryable: kind !== ERROR_KINDS.BAD_REQUEST
      && kind !== ERROR_KINDS.CONTEXT
      && kind !== ERROR_KINDS.QUOTA
      && kind !== ERROR_KINDS.AUTH
  });

  if (!m) return make(ERROR_KINDS.UNKNOWN);
  if (CONTEXT_RE.test(m)) return make(ERROR_KINDS.CONTEXT);
  if (httpCode === 402 || QUOTA_RE.test(m)) return make(ERROR_KINDS.QUOTA);
  if (httpCode === 401 || httpCode === 403 || AUTH_RE.test(m)) return make(ERROR_KINDS.AUTH);
  if (httpCode === 429 || RATE_RE.test(m)) return make(ERROR_KINDS.RATE_LIMIT);
  if (TIMEOUT_RE.test(m)) return make(ERROR_KINDS.TIMEOUT);
  if (NETWORK_RE.test(m)) return make(ERROR_KINDS.NETWORK);
  if (SERVER_RE.test(m) || httpCode >= 500) return make(ERROR_KINDS.SERVER);
  if (httpCode === 400 || httpCode === 422 || httpCode === 404) return make(ERROR_KINDS.BAD_REQUEST);
  return make(ERROR_KINDS.UNKNOWN);
}

// ── 文案 ────────────────────────────────────────────────────────────────
// 「用户端」的句子：只说卡了一下，不解释原因、不承诺补偿。
// 每条都短（真实聊天里没人发长句解释自己的网络），且不带任何技术词。
export const DEFAULT_USER_LINES = {
  [ERROR_KINDS.TIMEOUT]: ['刚卡了一下，你再说一遍？', '等我一下，刚才慢了半拍'],
  [ERROR_KINDS.NETWORK]: ['刚断了一下，我回来了', '网抽风了，你说到哪儿了'],
  [ERROR_KINDS.RATE_LIMIT]: ['我这边被限速了，缓一下', '消息太密，我慢半拍'],
  [ERROR_KINDS.SERVER]: ['刚才那边抖了一下，再试一次？', '我这边出了点岔子，你刚说什么'],
  [ERROR_KINDS.UNKNOWN]: ['刚才没接住，你再说一遍？']
};

/**
 * 生成要发出去的那句话。
 *
 * @param {object} opts
 * @param {string} opts.kind      classifyLlmError 的 kind
 * @param {'user'|'operator'} opts.scope
 * @param {string} [opts.botName] 人设名（诊断文案里用"她"指代，避免主人误认成用户消息）
 * @param {string} [opts.detail]  原始错误（只进 operator 文案，且会被截短）
 * @param {object} [opts.lines]   覆盖某几类用户端文案（config.errorReply.lines）
 * @param {() => number} [opts.rng] 随机源，测试可注入 `() => 0`
 * @returns {string} 空串 = 不该发（调用方据此决定不发送）
 */
export function buildErrorReply({ kind, scope, botName = '', detail = '', lines = null, rng = Math.random } = {}) {
  if (scope === 'operator') {
    const label = LABEL_OF[kind] || LABEL_OF[ERROR_KINDS.UNKNOWN];
    const who = String(botName || '').trim() || '她';
    const raw = String(detail || '').replace(/\s+/g, ' ').trim();
    const cut = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
    // 刻意加【】前缀：主人一眼能认出"这不是她说的"，而是系统提示。
    // 不加前缀的话，这句会混进聊天流里被当成她真的回了话。
    return `【模型失败】${who}这一轮没有回复：${label}。${cut ? `原始错误：${cut}` : ''}`.trim();
  }
  // 覆盖语义要区分「没配」和「配成空」：
  //   没配 → 用默认池；配成 [] → **这一类闭嘴**（config.js 的注释承诺了这一点）。
  // 两者混为一谈的话，用户想关掉"网抽风了"就只能改代码。
  const override = lines && typeof lines === 'object' && Array.isArray(lines[kind]) ? lines[kind] : null;
  const pool = override
    ? override.map((x) => String(x ?? '').trim()).filter(Boolean)
    : (DEFAULT_USER_LINES[kind] || DEFAULT_USER_LINES[ERROR_KINDS.UNKNOWN]);
  if (!pool.length) return '';
  const r = Number(rng());
  const idx = Number.isFinite(r) ? Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length))) : 0;
  return pool[idx];
}

/**
 * 要不要说、说给谁。
 *
 * 决策顺序是刻意的：**越早否掉越省事**，而且每一条否掉的理由都要能解释给用户听
 * （skip-log 里那句 reason 就是给人查的）。
 *
 * @param {object} o
 * @param {string} o.kind
 * @param {string} o.owner
 * @param {boolean} o.direct      这一轮是不是在叫它（私聊恒 true）
 * @param {boolean} o.proactive   是不是主动机会
 * @param {boolean} o.sentAny     这一轮有没有已经发出去的话
 * @param {boolean} o.isMaster    触发者是不是主人
 * @param {'group'|'private'} o.chatKind
 * @param {number} o.now
 * @param {number} [o.lastAt]     上次提示的时间（0 = 没提示过）
 * @param {number} [o.cooldownMs]
 * @param {boolean} [o.enabled]
 * @param {boolean} [o.inGroup]   群里被点名时要不要说人话
 * @param {boolean} [o.operatorNotice] 运营类失败要不要给主人发诊断
 * @returns {{send:boolean, scope:'user'|'operator'|'', reason:string}}
 */
export function decideErrorReply({
  kind,
  owner,
  direct = false,
  proactive = false,
  sentAny = false,
  isMaster = false,
  chatKind = 'private',
  now = 0,
  lastAt = 0,
  cooldownMs = 600000,
  enabled = true,
  inGroup = true,
  operatorNotice = true
} = {}) {
  const no = (reason) => ({ send: false, scope: '', reason });
  if (!enabled) return no('errorReply 已关闭（config.errorReply.enabled=false）');
  if (sentAny) return no('这一轮已经说过话，不补道歉（否则用户会怀疑前面那句也是假的）');
  if (proactive) return no('主动机会失败不出声（没人问，不自曝）');
  if (!direct) return no('这条消息不是在叫它，失败也不必解释');

  const wait = Math.max(0, Number(cooldownMs) || 0);
  const since = Number(now) - Number(lastAt || 0);
  if (lastAt && wait && since >= 0 && since < wait) {
    return no(`提示冷却中（还剩 ${Math.ceil((wait - since) / 1000)}s，避免一个坏端点刷屏）`);
  }

  if (owner === OWNER.TRANSIENT) {
    if (chatKind === 'group' && !inGroup) return no('群里不提示（config.errorReply.inGroup=false）');
    return { send: true, scope: 'user', reason: `瞬时故障（${kind}），说一句人话圆过去` };
  }

  // 运营类：**只在私聊里发给主人**。群里说"我的 API 欠费了"等于把部署细节
  // 广播给所有人，而且解决不了任何事 —— 看见的人越多越尴尬。
  if (!operatorNotice) return no('运营类失败不提示（config.errorReply.operatorNotice=false）');
  if (!isMaster) return no('运营类失败只告诉主人（不向陌生人泄露部署信息）');
  if (chatKind !== 'private') return no('运营诊断只在私聊里发（群里会泄露部署信息）');
  return { send: true, scope: 'operator', reason: `运营类故障（${kind}），给主人技术诊断` };
}

/** 一行摘要，写进 skip-log 的 detail 与面板日志。 */
export function describeErrorReply(kind, decision) {
  const label = LABEL_OF[kind] || LABEL_OF[ERROR_KINDS.UNKNOWN];
  if (!decision?.send) return `${label}；未提示：${decision?.reason || '未知原因'}`;
  return `${label}；已提示${decision.scope === 'operator' ? '主人（技术诊断）' : '用户（人设短句）'}`;
}
