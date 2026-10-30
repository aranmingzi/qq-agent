// 群聊「好几个人同时在跟你说话」的归拢层。
//
// ── 它回答的问题 ──────────────────────────────────────────────────────
// 一批未读里可能同时有三个人：一个 @ 它问几点开黑，一个问刚才那个梗是什么，
// 还有一个在跟第四个人聊别的。以前这一串原样丢给模型，附一句"挑你真正想接的几条"，
// 于是它只有两条路：
//   ① 给每人回一条 → 三条并列的答案，像客服工单（最像机器的地方）；
//   ② 只答最后一个 → 前面 @ 过它的人被当没看见（失礼）。
// 真人还有第三条路，也是这一层要撑起来的那条：
//   **一句话把几个人一起带上**，认真答最值得答的，其余半句带过。
//
// ── 为什么不在这里生成句式 ────────────────────────────────────────────
// 「@A 你说的是 X，@B 你说的是 Y」这种拼接一旦写进代码就等于给回复定了模板，
// 越用越像报表 —— 而"像报表"正是要解决的问题本身。所以这一层**只产事实**：
// 几个人在等、各自说了什么、等多久、谁在聊别的。措辞与策略归 prompt.js，语气归人设。
//
// ── 判据只有一个：**是不是在跟它说** ──────────────────────────────────
// "在等我"不等于"在说话"。@我 / 引用我 / 点我名 / @全体 → 在等它；
// @别人 / 引用别人的话 → 在跟别人说，只是背景（这条判据借 addressee.js，不另立一套）。
// 这也是「没必要所有人都回」的结构性依据：旁人的话不算待办，只算氛围。
//
// 纯函数：不读配置、不碰磁盘、不看时钟（now 由入参给），每条判据都能直接断言。
import { addresseeOf, TARGET } from './addressee.js';

/** 有几个人在等它 → 这一轮的表达规模。 */
export const CROWD_LEVEL = {
  NONE: 'none',   // 没人找它，这批只是群聊背景
  SOLO: 'solo',   // 一个人在跟它说（最常见；提示词不需要额外说什么）
  PAIR: 'pair',   // 两个人在等它 —— 已经会出现"分条回"的苗头
  CROWD: 'crowd'  // 三个及以上 —— 不合并就必然变成客服队列
};

/** 一个人的话压成一句话时的截断长度（每条）。 */
const ASK_MAX_CHARS = 40;
/** 敲门话：只有"在吗""喂""问你个事"这种，没有实质内容（不占位，但也别把它当成唯一诉求）。 */
const KNOCK_RE = /^(在吗|在不在|在么|在嘛|喂|hi|hello|有人吗|打扰了|问你个事|问个事|问一下|那个)[?？。！!~～…\s]*$/i;

/** 截断到 n 字，超出加省略号（保留前半段，人话都在前半段）。 */
function clip(text, n = ASK_MAX_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

/**
 * 同一个人连发好几条时，**他到底在问什么**。
 *
 * ⚠️ 不能只取一条：一个人十分钟前问"配置发我一下"、刚刚又问"今晚几点开黑"，
 *    这**是两件事**。只留最后那条，前一件事在提示词里就消失了 ——
 *    而它正是"漏掉某人"最难查的成因（不是没看到人，是没看到那件事）。
 *
 * 所以取最后两条**有实质内容**的（跳过"在吗""喂"这类敲门话），按时间正序返回：
 * 敲门的价值在于提示"他等了一会儿"，不在于它本身是个诉求。
 */
function pickAsks(texts = []) {
  const list = (Array.isArray(texts) ? texts : [])
    .map((t) => String(t ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!list.length) return [];
  const solid = list.filter((t) => !KNOCK_RE.test(t));
  // 全是敲门话时退回原文：总比"没说什么"强（"在吗"本身也是要回的那种）
  const pool = solid.length ? solid : list;
  const uniq = [...new Set(pool)];
  return uniq.slice(-2).map((t) => clip(t));
}

/** 消息时间戳（store 条目用 ts，兜底 0）。 */
const tsOf = (e) => Number(e?.ts) || 0;

/**
 * 把一批未读归拢成「谁在等我」。
 *
 * @param entries  store 条目数组（只传**未读**的那批；已读过的不算待办）
 * @param opts
 *   · kind          'group' | 'private'（私聊不存在"多人"，直接 solo）
 *   · aliases       它的自称/昵称（认"叫的是不是我"）
 *   · selfIds       它的 QQ（认"@ 的是不是我"）
 *   · selfNickname  群里显示名
 *   · maxAskers     最多详细列几个人（超出的只报数量，避免提示词被撑爆）
 *   · now           当前时间（算"等多久"用，测试可注入）
 * @returns {{
 *   level: string, askers: Array, more: number, totalAskers: number,
 *   backdrop: string[], backdropCount: number, broadcast: boolean,
 *   msgCount: number, senderCount: number, spanMs: number, firstAt: number, lastAt: number
 * }}
 */
export function crowdOf(entries = [], opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && !e.self);
  const kind = opts.kind === 'private' ? 'private' : 'group';
  const now = Number(opts.now) || Date.now();
  const maxAskers = Math.max(1, Math.min(12, Number(opts.maxAskers) || 4));

  const empty = {
    level: CROWD_LEVEL.NONE,
    askers: [],
    more: 0,
    totalAskers: 0,
    backdrop: [],
    backdropCount: 0,
    broadcast: false,
    msgCount: list.length,
    senderCount: 0,
    spanMs: 0,
    firstAt: 0,
    lastAt: 0
  };
  if (!list.length) return empty;

  // 私聊：对面只有一个人，"多人并发"这件事不存在。
  // 仍然返回结构（不返回 null），调用方不用到处判空 —— 只是 level 恒为 solo。
  if (kind === 'private') {
    const first = list[0];
    const last = list[list.length - 1];
    return {
      ...empty,
      level: CROWD_LEVEL.SOLO,
      totalAskers: 1,
      senderCount: 1,
      spanMs: Math.max(0, tsOf(last) - tsOf(first)),
      firstAt: tsOf(first),
      lastAt: tsOf(last)
    };
  }

  const addrOpts = {
    aliases: Array.isArray(opts.aliases) ? opts.aliases : [],
    selfIds: (Array.isArray(opts.selfIds) ? opts.selfIds : [opts.selfIds])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
    selfNickname: opts.selfNickname || ''
  };

  // senderId → 这个人的全部"在等我"的话
  const waiting = new Map();
  // 不是等它的人（在跟别人说 / 纯闲聊）——只要名字，用于"另外 N 个人在聊别的"
  const backdrop = new Map();
  let broadcast = false;
  const senders = new Set();

  for (const e of list) {
    const id = String(e.senderId ?? '').trim();
    const name = String(e.senderName || id || '').trim();
    const key = id || name;
    if (key) senders.add(key);

    const addr = addresseeOf(e, addrOpts);
    const toSelf = addr.target === TARGET.SELF || addr.target === TARGET.ALL;

    if (toSelf) {
      if (addr.target === TARGET.ALL) broadcast = true;
      if (!key) continue;   // 连 QQ 和昵称都没有的条目，认不出人，不硬凑
      const rec = waiting.get(key) || { id, name, texts: [], at: [], all: false };
      rec.texts.push(String(e.text ?? ''));
      rec.at.push(tsOf(e));
      if (addr.target === TARGET.ALL) rec.all = true;
      waiting.set(key, rec);
    } else if (key && !waiting.has(key)) {
      // 同一个人可能前一句在等我、后一句在聊别的 —— 只要有过"在等我"，他就不是背景。
      // 这里先记，最后再滤掉同时出现在 waiting 里的人。
      if (!backdrop.has(key)) backdrop.set(key, name);
    }
  }

  for (const key of waiting.keys()) backdrop.delete(key);

  const askers = [...waiting.values()]
    .map((rec) => {
      const at = rec.at.filter((x) => x > 0);
      const firstAt = at.length ? Math.min(...at) : 0;
      const lastAt = at.length ? Math.max(...at) : 0;
      const asks = pickAsks(rec.texts);
      return {
        id: rec.id,
        name: rec.name || rec.id,
        // 主人也在等你的时候要标出来：不然模型看到的是"两个人都在找我"，
        // 只把其中一个当普通群友，只能靠昵称猜哪个是主人（猜不到就都当群友）。
        master: Boolean(opts.masterId) && String(rec.id || '') === String(opts.masterId),
        // asks 是他这几条里"有实质内容的最后两件"（一件事就是一条）；
        // ask 保留成最后那一件 —— 兼容"只要一个代表句"的渲染/日志。
        asks,
        ask: asks.length ? asks[asks.length - 1] : '',
        // 一个人连发三条只算**一个**在等你 —— 这是"人数"不是"条数"
        msgs: rec.texts.length,
        all: rec.all,
        firstAt,
        lastAt,
        // 等了多久：先问的人先照顾（真人会说"哦刚看到你那条"）
        waitedMs: firstAt > 0 ? Math.max(0, now - firstAt) : 0
      };
    })
    // 先问的排前面，不是最后说话的排前面：后者会让"最安静的那个人"永远轮不到。
    .sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));

  const totalAskers = askers.length;
  const level = totalAskers === 0
    ? CROWD_LEVEL.NONE
    : (totalAskers === 1
      ? CROWD_LEVEL.SOLO
      : (totalAskers === 2 ? CROWD_LEVEL.PAIR : CROWD_LEVEL.CROWD));

  const times = list.map(tsOf).filter((x) => x > 0);
  return {
    level,
    askers: askers.slice(0, maxAskers),
    // 超出上限的人只报数量：宁可少说一个名字，也别把提示词撑成花名册
    more: Math.max(0, totalAskers - maxAskers),
    totalAskers,
    backdrop: [...backdrop.values()].filter(Boolean),
    backdropCount: backdrop.size,
    broadcast,
    msgCount: list.length,
    senderCount: senders.size,
    spanMs: times.length ? Math.max(...times) - Math.min(...times) : 0,
    firstAt: times.length ? Math.min(...times) : 0,
    lastAt: times.length ? Math.max(...times) : 0
  };
}

/**
 * 这一批是否"多人在等"（提示词要不要专门说一句 / 合并窗口要不要放宽）。
 *
 * 单独一个函数而不是到处写 `level === 'pair' || level === 'crowd'`：
 * 判据将来若改（比如三个以上才算），只需要改这一处。
 */
export function isMultiAsk(crowd) {
  const lv = crowd?.level;
  return lv === CROWD_LEVEL.PAIR || lv === CROWD_LEVEL.CROWD;
}

/** 给日志用的一行（排查"这轮为什么回了三句"时先看它）。 */
export function describeCrowd(chatKey = '', crowd = {}) {
  const n = Number(crowd?.totalAskers) || 0;
  const names = (crowd?.askers || []).map((a) => a.name).filter(Boolean).join('/');
  const bits = [`${n} 人在等你`];
  if (names) bits.push(names);
  if (Number(crowd?.backdropCount) > 0) bits.push(`另有 ${crowd.backdropCount} 人在聊别的`);
  if (crowd?.broadcast) bits.push('含@全体');
  if (Number(crowd?.msgCount) > 0) bits.push(`${crowd.msgCount} 条消息 / ${Math.round((Number(crowd.spanMs) || 0) / 1000)} 秒内`);
  return `[多人] ${chatKey} ${bits.join('，')}`;
}
