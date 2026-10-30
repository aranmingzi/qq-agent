// 过去状态窗口（P1）：从"取最近 N 条"改成"取最近 N 条，但**在叫它的**那些最后才丢"。
//
// ── 为什么改「丢谁」而不是「丢多少」──────────────────────────────────────
// 旧实现是 `store.recent(limit).slice(-limit)` + 从头部按字符丢 —— 判据只有**时间**。
// 于是真实故障长这样：群里有人 @ 它说了需求，中间隔了几十条寒暄，
// 等它被唤醒时那条需求已经被"取最近 24 条"整段冲掉了。表现不是报错，
// 是"答非所问"，而日志里什么都没有（这类故障最难查）。
//
// 所以判据改成两级：
//   ① **时间**仍是主要判据（近的优先），
//   ② 但「@我 / @全体 / 提到我」的消息及其**前后各 radius 条**是保护项，
//      淘汰时从最旧的**非保护项**开始丢；只有保护项自己超了预算，才丢保护项。
//
// 纪律：
//   · 纯函数、零 IO（只 import 纯文本解析的 addressee.js），谁都能单测；
//   · **没触发保护/折叠时，输出必须与旧实现逐字相同** —— 私聊 direct 档尤其如此
//     （本项目的铁律：私聊提示词一个字都不能变）。
//   · 保护不是"永不丢"：永不丢会让预算失控。它是"最后才丢"。
//
// 折叠（刷屏）是同一件事的另一半：同一人连发 N 条极短消息，本质是**一条**话，
// 每条都带时间和昵称前缀等于白烧预算。只在群聊开启，私聊保持原样。
import { addresseeOf, TARGET } from './addressee.js';

/** 会话类型（只认前缀，不依赖 config —— 这个模块要保持零依赖可测）。 */
export function chatKindOf(chatKey) {
  const s = String(chatKey || '');
  const m = /^(private|group)[:_]/.exec(s);
  return m ? m[1] : '';
}

export function isGroupChat(chatKey) {
  return chatKindOf(chatKey) === 'group';
}

/**
 * 是否私聊。**全项目只有这一处判私聊** —— 别再写 `startsWith('private:')`。
 *
 * ⚠️ 两种形状容易搞混，而且搞混过一次（差点按错误前提"修"掉一批活分支）：
 *   · 磁盘**文件名**是下划线：private_123456789.json（store.js / identity.js）
 *   · 代码里的 **chatKey** 是冒号：private:123456789（`store.listChats()` 会把前者还原成后者）
 * 所以判据必须两种分隔符都认（chatKindOf 的正则同时接受 `[:_]`）——
 * 唯一能塞进任意字符串的入口是 HTTP `POST /api/dsh/report` 的 body.chatKey，
 * 传错格式会让 DSH 汇报静默不发，日志里什么都不留。
 */
export function isPrivateChat(chatKey) {
  return chatKindOf(chatKey) === 'private';
}

/**
 * 这一档基础预算（不含 tier 收窄）：群聊与私聊分开。
 *
 * 为什么分开：群聊的窗口里噪声占比高得多（多人交错、寒暄），
 * 同样字数的预算，群聊能换到的"有用信息"更少。
 * ⚠️ 未知会话类型一律按**私聊**（= 旧值、不缩小）处理：宁可多带，也不许悄悄变少。
 */
export function windowLimitsOf(chatKey, storeCfg = {}) {
  const cfg = storeCfg || {};
  const privLimit = Math.max(10, Number(cfg.pastStateLimit) || 80);
  const privChars = Math.max(1000, Number(cfg.pastStateMaxChars) || 6000);
  if (!isGroupChat(chatKey)) return { limit: privLimit, maxChars: privChars };
  return {
    limit: Math.max(10, Number(cfg.pastStateGroupLimit) || privLimit),
    maxChars: Math.max(1000, Number(cfg.pastStateGroupMaxChars) || privChars)
  };
}

/**
 * 标记保护项：命中「在叫它」的消息 + 前后各 radius 条。
 *
 * 为什么带邻居：只有那一句 @ 而没有上下文，模型看到的是"有人喊了你一声"，
 * 依然不知道怎么接。前后各两条刚好是"这句话是在什么对话里说的"。
 *
 * 三道刹车（都是实测出来的，不是洁癖）：
 *   · `maxHits`：只保最近的 N 处 @。一个刷屏的群里两小时能有十几条 @。
 *   · `maxProtected`：保护项**总条数**上限（默认 6）。这是最要紧的那道 ——
 *     真机实测：某活跃群 radius=2 + 3 处 @ 时，20 条的窗口里有 12 条都是保护项，
 *     等于把"当前正在聊的那 8 条"挤掉了一半。保护项一旦占多数，
 *     故障就从"答非所问"变成"接不上话"，而后者更难解释。
 *   · 扩展时按**距离由近及远**取，超上限就停 —— 保证被舍掉的是离 @ 最远的邻居。
 *
 * @param {Array} entries 消息（store 的原始形态）
 * @returns {Array} 浅拷贝后的新数组，带 protect / protectReason 字段
 */
export function markProtected(entries, {
  aliases = [], selfIds = [], selfNickname = '', radius = 2, maxHits = 3, maxProtected = 6
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const out = list.map((e) => ({ ...e, protect: false, protectReason: '' }));
  if (!out.length) return out;
  const r = Math.max(0, Math.min(6, Number(radius) || 0));
  const hitsCap = Math.max(1, Number(maxHits) || 1);
  const keepCap = Math.max(1, Number(maxProtected) || 1);

  // ① 从**最新**往回找 @，先到先得，过了 maxHits 就停（"最近的 @ 最要紧"）。
  const hits = [];
  for (let i = out.length - 1; i >= 0 && hits.length < hitsCap; i -= 1) {
    let info;
    try {
      info = addresseeOf(out[i], { aliases, selfIds, selfNickname });
    } catch { continue; }               // 解析失败 = 不算保护项，绝不因此丢消息
    if (!info) continue;
    if (info.target !== TARGET.SELF && info.target !== TARGET.ALL) continue;
    hits.push(i);
  }
  if (!hits.length) return out;

  // ② 算出候选（本身 + 邻居），按**距离**近远排序；同距离时新的优先。
  const cand = new Map();               // index -> {dist, addressed}
  for (const i of hits) {
    cand.set(i, { dist: 0, addressed: true });
    for (let d = 1; d <= r; d += 1) {
      for (const k of [i - d, i + d]) {
        if (k < 0 || k >= out.length) continue;
        const cur = cand.get(k);
        if (!cur || cur.dist > d) cand.set(k, { dist: d, addressed: cur?.addressed || false });
      }
    }
  }
  const ordered = [...cand.entries()].sort((a, b) => (a[1].dist - b[1].dist) || (b[0] - a[0]));

  // ③ 只取前 keepCap 条。注意"那句 @ 本身"必须优先于"离它远的邻居" —— 距离排序已保证。
  for (const [idx, meta] of ordered.slice(0, keepCap)) {
    out[idx].protect = true;
    out[idx].protectReason = meta.addressed ? 'addressed' : 'near';
  }
  return out;
}

/**
 * 刷屏折叠：同一人**连续** ≥minRun 条、每条 ≤maxTextChars、无图无引用的消息，
 * 合并成一条（`text` 用「 / 」连接，`count` 记条数）。
 *
 * 不折叠的对象（每一项都是踩过的理由）：
 *   · 带图消息 —— 提示词里要用 #消息id 去取图，合并后 id 就丢了；
 *   · 引用消息 —— 引用关系是"这句话在回谁"的唯一线索；
 *   · 自己的发言 —— 她自己的原话是语感/口癖的强化源，合并会改变注入形态；
 *   · 含换行的长段 —— 本来就不是"刷屏短句"。
 */
export function foldFlood(entries, { enabled = true, minRun = 4, maxTextChars = 10 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!enabled || list.length < minRun) return list.map((e) => ({ ...e }));
  const cap = Math.max(2, Number(maxTextChars) || 10);
  const runMin = Math.max(3, Number(minRun) || 4);
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= runMin) {
      const last = run[run.length - 1];
      const merged = {
        ...last,
        text: run.map((m) => String(m.text || '').trim()).filter(Boolean).join(' / '),
        count: run.length,
        protect: run.some((m) => m.protect),
        protectReason: run.find((m) => m.protectReason)?.protectReason || ''
      };
      out.push(merged);
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const e of list) {
    const eligible = e && !e.self && !(Array.isArray(e.media) && e.media.length)
      && !e.reply
      && String(e.text || '').trim().length > 0
      && String(e.text || '').trim().length <= cap
      && !String(e.text || '').includes('\n');
    if (!eligible) { flush(); out.push({ ...e }); continue; }
    if (run.length && run[0].senderId !== e.senderId) flush();
    run.push({ ...e });
  }
  flush();
  return out;
}

/**
 * 把自己的旧发言降采样（P2）：最近 keepRecent 条原样保留，更早的压成**一行**。
 *
 * ── 为什么不是"折叠连发"而是"整段降采样"──────────────────────────────
 * 真机实测（5 个群 × 最近 20 条窗口）：她自己的消息占 **40% 条数 / 42.6% 字数**。
 * 但连续段平均只有 1.6 条（25 段里 13 段是单条）—— 她是**交替发言**，
 * 不是刷屏。所以按"连续 ≥N 条才折叠"去压，只能把 43 行压到 32 行（-26%），
 * 基本没用。真正的杠杆是**总量**：留最近几条，更早的一律并进一行。
 *
 * ── 为什么这值得改（不是为了省字）────────────────────────────────────
 * 每轮她有一半的注意力在读自己刚说过的话 —— 这是"复读自我强化"的物理来源，
 * 比在提示词里写"别复读"有效得多（模型看不见自己说过几次，只能从窗口里读）。
 * 顺带腾出的条数预算会被 selectPast 让给**更早的真实对话**（窗口按条数算）。
 *
 * ── 为什么"压成片段"而不是"删掉"或"全文合并"──────────────────────────
 *   · 全删 → 她不知道自己刚才回过什么，会重复回答同一个问题；
 *   · 全文合并 → 原话还在，复读源没断，只是少了几行前缀（实测只省 3%）；
 *   · 截成片段（默认 10 字）→ 记得"聊过什么"，但**拿不到可复读的完整句子**。
 *
 * 原样保留的对象：最近 keepRecent 条自己发言（语感/口癖的强化源）、
 * 保护项（那是对 @ 的回应，是当前对话的一部分）、带图消息（提示词要用 #id 取图）。
 *
 * @param {Array} entries markProtected + foldFlood 之后的列表
 * @returns {{list:Array, folded:number, kept:number, chars:number}}
 */
export function downsampleSelf(entries, {
  enabled = true, keepRecent = 3, fragChars = 10, lineMaxChars = 80
} = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const plain = () => ({ list: list.map((e) => ({ ...e })), folded: 0, kept: 0, chars: 0 });
  if (!enabled || list.length < 3) return plain();

  const keep = Math.max(0, Math.min(12, Number(keepRecent) || 0));
  const selfIdx = [];
  list.forEach((e, i) => { if (e && e.self) selfIdx.push(i); });
  if (selfIdx.length <= keep) return plain();

  const keepSet = new Set(selfIdx.slice(selfIdx.length - keep));
  const collapsible = selfIdx.filter((i) => {
    if (keepSet.has(i)) return false;
    if (list[i].protect) return false;                                  // 对 @ 的回应
    if (Array.isArray(list[i].media) && list[i].media.length) return false; // #id 要留给取图
    return true;
  });
  // 只压 1 条等于"删一条加一行"，纯亏（内容被截断却没省下行数）。
  if (collapsible.length < 2) return plain();

  const cap = Math.max(2, Number(fragChars) || 10);
  const lineCap = Math.max(20, Number(lineMaxChars) || 80);
  const frag = (t) => {
    const s = String(t || '').replace(/\s*\n\s*/g, ' ').trim();
    return s.length > cap ? `${s.slice(0, cap)}…` : s;
  };
  const before = collapsible.reduce((sum, i) => sum + String(list[i].text || '').length, 0);
  let body = collapsible.map((i) => frag(list[i].text)).filter(Boolean).join(' / ');
  if (body.length > lineCap) body = `${body.slice(0, lineCap - 1)}…`;
  if (!body) body = '（略）';

  const first = collapsible[0];
  const merged = {
    ...list[first],
    selfBatch: true,
    self: true,
    ts: list[first].ts,
    text: body,
    count: collapsible.length,
    protect: false,
    protectReason: '',
    media: []
  };
  const drop = new Set(collapsible);
  const out = [];
  list.forEach((e, i) => {
    if (i === first) { out.push(merged); return; }
    if (drop.has(i)) return;
    out.push({ ...e });
  });
  return { list: out, folded: collapsible.length, kept: selfIdx.length - collapsible.length, chars: before - body.length };
}

// ── 信息价值分（P3，2026-10-26）───────────────────────────────────────────
//
// 学自 `fast-jev-compaction`：它不给历史做总结，而是对每条问两个问题 ——
//   「知道它发生过还重要吗」「它的内容还需不需要逐字（重跑工具拿不拿得回来）」，
//   然后三态处理：整留 / 截断 / 删除。理由是总结是有损重写，会把路径、数字、承诺改没。
//
// 本项目原本只有**二值**：protect（@我 及其邻居）vs 其余 —— 非保护项从最旧的开始
// **整条丢**。中间没有"截短"这一档，唯一享受片段态的是她自己的旧话（downsampleSelf）。
// 而这里有个外部没有的优势：**我们有 `search_messages`（关键词 + 按人 + 全量存档）**，
// 压掉的内容模型随时能自己捞回来 —— 也就是 Jev 那条「可重取吗」在本项目基本恒为真，
// 我们本该比它更敢压，却还在用二值判据。
//
// 三条纪律（与 downsampleSelf 同源，别改掉）：
//   ① 保护项、带图（#id 要留给取图）、引用（"这句在回谁"）、自己的（已压过一轮）
//      —— 一律不动；
//   ② **装得下就一个字都不改**（`changed:false`）：窗口没触顶时压缩是纯损失；
//   ③ **单次收益低于 `minGainChars` 就不动手**：省 50 字却丢了半句话，不划算
//      （学 Jev 的 `reductionRatio < 0.25` 就不压）。

/** 承诺 / 约定 / 待办：丢了就是"它忘了人家在等""它忘了答应过什么"。 */
const RE_COMMIT = /(明天|后天|今晚|明晚|明早|下周|本周|周[一二三四五六日天末]|礼拜[一二三四五六日天]|下个?月|约好|说好|记得|别忘了|答应|等你|等我|回头|到时候|到时|几点|几号|\d{1,2}\s*点[半钟]?|改天|有空|一起|见[面个]|地址|哪儿见|哪里见|提醒我|帮我|等到)/;
/** 提问：要回答的东西，压没了它就不知道在问什么。 */
const RE_QUESTION = /[?？]/;
const RE_QUESTION_TAIL = /(吗|呢|嘛|么|谁|哪|什么|怎么|怎样|为啥|为什么|多少|几[个岁天条杯次只]|能不能|可不可以|要不要|是不是|有没有|行不行|好不好|对不对)$/;
/**
 * 时间/日期类事实（普通数字不算 —— "666" 不是事实）。
 *
 * ⚠️ 中文数字必须认：群里说"八点半叫我""三点集合"是常态，只认阿拉伯数字会把
 *    最典型的承诺判成 mid → 被截短。代价是"一点点""两点水"这类会被误判成 high，
 *    但那是**保守方向**（多带一点，不丢信息），比漏掉"八点半"划算得多。
 */
const RE_WHEN = /(\d{1,2}[:：]\d{2}|\d{1,2}月\d{1,2}[日号]|\d{4}年|(\d{1,2}|[一二三四五六七八九十两])[点時时])/;
/** 纯噪声：语气词、表情、复读式应答。它们占条数不占信息。 */
const RE_NOISE = /^[\s]*(?:哦+|嗯+|啊+|哈+|嘿+|嗨+|嘻+|呵+|额+|诶+|哎+|啧+|em+m+|h+h+|6+|好[的嘞哒吧了]|行[吧了]?|是[的啊]|对[的对啊]*|真[的吗]|哇+|靠|艹|yyds|awsl|nb|牛[逼哇]?|绝了|厉害|哈哈哈|嘿嘿|嘻嘻|呜呜|嘤嘤|[。！!~～，,、\s]*)$/i;

/**
 * 单条消息的信息价值：`high` 整条留 / `mid` 可截短 / `low` 优先截、优先丢。
 *
 * ⚠️ 只做**文本**判据：protect 是 markProtected 的职责，这里不重复判（也判不了，
 *    需要 aliases/selfIds）。所以 `protect` 的优先级永远高于这里的 high。
 *
 * @param {object} m 消息（store 的原始形态）
 * @returns {'high'|'mid'|'low'}
 */
export function valueOf(m) {
  if (!m) return 'low';
  // 带图：提示词要用 #消息id 去取图；引用：唯一的"这句在回谁"线索。两者不参与压缩。
  if (Array.isArray(m.media) && m.media.length) return 'high';
  if (m.reply) return 'high';
  const t = String(m.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return 'low';
  if (RE_COMMIT.test(t)) return 'high';
  if (RE_QUESTION.test(t) || RE_QUESTION_TAIL.test(t)) return 'high';
  if (RE_WHEN.test(t)) return 'high';
  // 极短且没信息：这类最多，也正是"每条都带时间和昵称前缀白烧预算"的来源
  if (t.length <= 4) return 'low';
  if (RE_NOISE.test(t)) return 'low';
  return 'mid';
}

/**
 * 只在**装不下**时把低价值行截短（不是删除）。删除仍归 selectPast。
 *
 * ── 为什么不在这里删 ────────────────────────────────────────────────────
 * 删一条 = 上下文断一格。实测过：保护项占多数时故障会从"答非所问"退化成
 * "接不上话"，后者更难解释。截短只丢字数不丢"这句话存在过"，
 * 且真需要时模型能 `search_messages` 捞回原文。
 *
 * @param {Array<{line:string, shortLine?:string, protect?:boolean, value?:string}>} items
 * @param {{limit:number, maxChars:number, minGainChars:number, enabled:boolean}} opts
 * @returns {{list:Array, degraded:number, chars:number, changed:boolean}}
 */
export function degradeByValue(items, { limit = 24, maxChars = 2400, minGainChars = 120, enabled = true } = {}) {
  const live = (Array.isArray(items) ? items : []).filter((x) => x && x.line);
  const out = live.map((x) => ({ ...x }));
  const idle = { list: out, degraded: 0, chars: 0, changed: false };
  if (!enabled) return idle;

  const capCount = Math.max(1, Number(limit) || 24);
  const capChars = Math.max(200, Number(maxChars) || 2400);
  const cost = () => out.reduce((sum, x) => sum + x.line.length + 1, 0);
  // 装得下就一个字都别动：窗口没触顶时"压缩"是纯损失（纪律②）
  if (out.length <= capCount && cost() <= capChars) return idle;

  const minGain = Math.max(20, Number(minGainChars) || 120);
  let degraded = 0;
  let saved = 0;
  let guard = out.length + 2;
  while ((out.length > capCount || cost() > capChars) && guard > 0) {
    guard -= 1;
    // 先挑 low 再挑 mid；同价值挑**最旧**的（近的更可能是"正在聊的那句"）。
    let victim = -1;
    for (const v of ['low', 'mid']) {
      for (let i = 0; i < out.length; i += 1) {
        const x = out[i];
        if (x.degraded || x.protect) continue;
        if ((x.value || 'mid') !== v) continue;
        const short = String(x.shortLine || '');
        if (!short || short.length >= x.line.length) continue;
        if (x.line.length - short.length < minGain) continue;   // 纪律③：省太少不动
        victim = i;
        break;
      }
      if (victim >= 0) break;
    }
    if (victim < 0) break;
    saved += out[victim].line.length - out[victim].shortLine.length;
    out[victim].line = out[victim].shortLine;
    out[victim].degraded = true;
    degraded += 1;
  }
  return { list: out, degraded, chars: saved, changed: degraded > 0 };
}

/**
 * 按"时间 + 保护 + 价值"三级判据选出真正进入提示词的那几行。
 *
 * 淘汰顺序（2026-10-26 加第三级）：
 *   ① 最旧的、非保护的**低价值**行 → ② 最旧的非保护行 → ③ 只剩保护项时最旧的那条。
 * 旧行为是 ②→③，所以**所有没带 `value` 的调用方行为逐字不变**（value 缺省视为 mid，
 * 落在第 ② 档）—— 私聊与既有测试都靠这条保住。
 *
 * @param {Array<{line:string, protect:boolean, value?:string}>} items 已格式化的行
 * @param {{limit:number, maxChars:number}} opts
 * @returns {{text:string, kept:number, dropped:Array, protectKept:number}}
 */
export function selectPast(items, { limit = 24, maxChars = 2400 } = {}) {
  const live = (Array.isArray(items) ? items : []).filter((x) => x && x.line);
  const capCount = Math.max(1, Number(limit) || 24);
  const capChars = Math.max(200, Number(maxChars) || 2400);
  const cost = () => live.reduce((sum, x) => sum + x.line.length + 1, 0);
  const dropped = [];

  let guard = live.length + 2;
  while ((live.length > capCount || cost() > capChars) && live.length > 1 && guard > 0) {
    guard -= 1;
    let victim = -1;
    // ① 低价值的、最旧的非保护项
    for (let i = 0; i < live.length; i += 1) {
      if (!live[i].protect && live[i].value === 'low') { victim = i; break; }
    }
    // ② 最旧的非保护项（旧行为）
    if (victim < 0) victim = live.findIndex((x) => !x.protect);
    // ③ 只剩保护项：才丢最旧的那一条
    if (victim < 0) victim = 0;
    const [gone] = live.splice(victim, 1);
    dropped.push({
      reason: live.length >= capCount ? 'limit' : 'budget',
      protect: !!gone?.protect,
      value: gone?.value || undefined,
      chars: (gone?.line || '').length
    });
  }

  const text = live.map((x) => x.line).join('\n');
  return {
    text,
    kept: live.length,
    protectKept: live.filter((x) => x.protect).length,
    dropped
  };
}

/**
 * 给日志/面板用的一句话；什么都没发生时返回空串。
 *
 * ⚠️ `buildPastState()` 返回的字段是 `count`，这里原来只认 `kept`，
 * 于是日志里**一直**打印「[过去状态] 0 条：…」（实测 2026-10-25 才发现）。
 * 两个名字都认：这个函数被测试和编排器两处以不同形状调用，改名会牵一片。
 */
export function describePastWindow({ kept, count, protectKept = 0, folded = 0, selfFolded = 0, selfBatchKept = false, degraded = 0, degradedChars = 0, dropped = [] } = {}) {
  const n = Number(kept ?? count) || 0;
  const bits = [];
  if (protectKept) bits.push(`保住 ${protectKept} 条在叫它的`);
  if (folded > 0) bits.push(`折叠 ${folded} 条连发`);
  if (degraded > 0) bits.push(`截短 ${degraded} 条低信息量的（省 ${degradedChars} 字）`);
  // 说真话：合并行被挤掉时不能还报"并成 1 行"（面板上会找不到那一行）。
  if (selfFolded > 0) {
    bits.push(selfBatchKept
      ? `自己更早的 ${selfFolded} 句并成 1 行`
      : `自己更早的 ${selfFolded} 句已省略（窗口装不下，位置让给真实对话）`);
  }
  if (dropped?.length) {
    const protectedDropped = dropped.filter((d) => d.protect).length;
    bits.push(`丢 ${dropped.length} 条${protectedDropped ? `（含 ${protectedDropped} 条保护项）` : ''}`);
  }
  return bits.length ? `[过去状态] ${n} 条：${bits.join('，')}` : '';
}
