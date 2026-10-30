// 寻址判定 —— 这条消息是「对我说的」还是「对别人说的」。
//
// ── 为什么要它 ────────────────────────────────────────────────────────
// 群聊里绝大多数话不是对它说的。以前没有这一层，只有三条零散的文本猜测：
//   · 闸门里 `text.includes('@我')` —— 只知道"有人 @ 我"，不知道"有人 @ 了别人"；
//   · 提示词里 `text.startsWith('@')` → 标成「@我」—— "@张三 吃了吗" 也以 @ 开头，
//     于是模型看到的标签是"这条在叫我"，理直气壮地接了过去；
//   · `entry.reply` 从来没被写入过（`appendIncoming` 的默认参数是 null，
//     入站侧根本没传）→ 「引用我的话」这条判据是死代码，引用信息只以
//     `[引用 张三：xxx]` 的形式混在文本里，没人去读。
// 三件事叠在一起的结果就是：**和群友说话时，它以为在跟它说话**。
//
// 这一层把"对谁说的"变成**一个明确结论**（target），让闸门和提示词都读同一个事实，
// 不再各自用 `includes` 猜。
//
// ── 优先级（刻意定死的顺序，改之前先想清楚）──────────────────────────
//   1. @我 / 引用我的话           → self   （明确叫它，最优先）
//   2. @全体成员                  → all    （在叫所有人，它也算一个）
//   3. @别人 / 引用别人的话        → other  （明确在跟别人说 —— 即使话里提到了它的名字）
//   4. 叫它的名字（呼格）          → self   （"小鱼，这个怎么弄" —— 真的在叫它）
//   5. 都没有                     → none   （公屏闲聊，谁都可以在）
//
// 第 3 条压过第 4 条是本模块存在的理由：「@张三 你看小鱼多能说」是在跟张三说话，
// 不是叫小鱼 —— 提到名字不等于叫名字。
//
// ⚠️ 2026-10-31 修「agent 幻觉严重，没跟她说话却以为在跟她说话」（m00001）：
//   以前第 4 条写的是「**提到**它的名字（没 @ 也没引用）→ self」，判据就是
//   `text.includes(昵称)` —— 裸子串。后果是"小鲸鱼今天怎么没来""我觉得小鲸鱼有点吵"
//   这类**聊到它**的话全被判成"在叫它"，闸门满血唤醒、模型也拿着"提到我"的标签
//   理直气壮地接话。实测 5267 条非己消息里 673 条被判 self，其中相当一部分是这种。
//   现在改成**呼格判据**（looksLikeCallingName）：名字必须出现在"句首/标点之后"，
//   且后面紧跟的是标点、结尾，或"在/呢/你/帮/来/看…"这类叫它做事的词。
//   "小鲸鱼" 单独一条是叫它；"我觉得小鲸鱼挺好的" 不是。
//   只是聊到它 → target 保持 none，但 mentionSelf 仍为真，供提示词标「聊到我，没叫我」。
//
// 纯函数：不 import config、不碰磁盘、不联网，每条判据都能直接断言。
export const TARGET = {
  SELF: 'self',
  OTHER: 'other',
  ALL: 'all',
  NONE: 'none'
};

// @全体成员 在文本里长这样（onebot.js::segmentsToText 对 at all 的输出）
const AT_ALL_TEXT = '@全体成员';
// @我 是 onebot.js 对 at self 的输出
const AT_SELF_TEXT = '@我';

// "@我" 作为**独立标记**的样子：渲染器是 `out.push('@我')` 单独推一个 token，
// 所以它后面必然是分隔符或结尾。用来把"真的 @ 了它"和"文字里写着 @我"分开：
//   "@我 在吗" / "图里有几只奶龙@我"      → 命中（真 @）
//   "荷叶你@我干嘛" / "再@我就当你想我了"  → 不命中（在说别人 @ 它）
const AT_SELF_TOKEN_RE = /@我(?=$|[\s，。、；;：:！!？?~～"'“”‘’（）()【】\[\]])/;

/** 文本里有没有一个**独立的** "@我" 标记（不是"@我独自哈气"那种昵称前缀）。 */
export function hasAtSelfToken(text) {
  return AT_SELF_TOKEN_RE.test(String(text ?? ''));
}

// 抓 `@名字`：@ 后面到分隔符为止。分隔符里含 @ 是为了"@a@b"能拆开。
const AT_NAME_RE = /@([^\s@，。、；;：:！!？?~～"'“”‘’（）()【】\[\]]{1,24})/g;
// 抓 `[引用 张三：原文]`；没有冒号的不认（只有原文、不知道引用了谁 → 当不知道）
const REPLY_RE = /\[引用\s*([^：:\[\]]{1,24})[：:]/;

/** 归一化：去空白、转小写。中文没有大小写，但别名可能是英文。 */
const norm = (s) => String(s ?? '').trim().toLowerCase();

/** 正则转义（昵称里可能有 + . ( ) 之类）。 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 从文本里兜底抽寻址信号。
 * 结构化字段（atSelf / atOthers / reply）缺失时才靠它 —— 老存档、其它来源的消息
 * 没有结构化信息，但文本里的 "@张三" / "[引用 张三：…]" 一直都在。
 *
 * ⚠️ 昵称可能带空格（"AI 酱"）。AT_NAME_RE 按空格断词，会把 "@AI 酱" 切成 "AI"，
 * 于是它自己的名字被当成另一个人 —— 所以先把"@它的名字"整段匹配掉，剩下的 @ 才是别人。
 */
export function parseTextTargets(text, { aliases = [], selfNickname = '' } = {}) {
  const s = String(text ?? '');
  const pool = [...(Array.isArray(aliases) ? aliases : []), selfNickname]
    .map(norm)
    .filter((n) => n && n !== '我' && n !== AT_ALL_TEXT.slice(1));
  let atSelf = s.includes(AT_SELF_TEXT);
  let rest = s;
  if (pool.length) {
    const re = new RegExp('@(' + [...new Set(pool)].map(escapeRe).join('|') + ')', 'gi');
    if (re.test(s)) atSelf = true;
    rest = s.replace(re, ' ');
  }
  const names = [];
  for (const m of rest.matchAll(AT_NAME_RE)) {
    const n = String(m?.[1] ?? '').trim();
    // 「@我」「@全体成员」是保留字，不算具体某个人
    if (!n || n === '我' || n === AT_ALL_TEXT.slice(1)) continue;
    names.push(n);
  }
  const rm = REPLY_RE.exec(s);
  return {
    atSelf,
    atAll: s.includes(AT_ALL_TEXT),
    atNames: names,
    replySender: rm ? String(rm[1] || '').trim() : ''
  };
}

/** 这个名字是它的自称/昵称之一吗。 */
function isSelfName(name, aliases, selfNickname) {
  const n = norm(name);
  if (!n || n === '我' || n === 'all') return false;
  const pool = [...(Array.isArray(aliases) ? aliases : []), selfNickname]
    .map(norm)
    .filter(Boolean);
  return pool.includes(n);
}

/** 名字是不是出现在文本里（只是"聊到它"，不代表在叫它）。 */
function mentionsSelf(text, aliases, selfNickname) {
  const s = norm(text);
  if (!s) return false;
  const pool = [...(Array.isArray(aliases) ? aliases : []), selfNickname]
    .map(norm)
    .filter(Boolean);
  return pool.some((a) => s.includes(a));
}

// ── 呼格（vocative）判据 ─────────────────────────────────────────────
// 名字能"出现在句子里"和"被用来叫它"是两件事：
//   "小鲸鱼今天怎么没来"   ← 聊到它，不是在叫它
//   "我觉得小鲸鱼有点吵"   ← 同上
//   "小鲸鱼，这个怎么弄"   ← 叫它
//   "小鲸鱼"               ← 叫它
// 判据：名字必须落在一个"分句开头"（句首 / 标点空格之后 / 叫喊找问之类动词之后），
// 并且后面紧跟标点、结尾、或一个叫它做事的词。两个条件缺一不可，宁漏勿错。
const BOUNDARY_BEFORE = /[\s，。、；;：:！!？?~～…—"'“”‘’（）()【】\[\]《》<>/\\|+=*&^%$#@]/;
const CALL_VERB_BEFORE = /(叫|喊|找|问|呼叫|艾特|at)(一下|下)?\s*$/;
// 昵称自带的语气/小名后缀："小鲸鱼儿"、"小鱼啊"。只收"儿"——
// "啊/呀/哦"太泛（"小鲸鱼啊真好看"其实更像聊到），宁可漏判。
const NAME_SUFFIX = /^[儿]+/;
// 名字后面紧跟这些 = 在支使它/招呼它（"小鱼帮我看"、"小鲸鱼在吗"、"小鱼呢"）。
// ⚠️ 刻意**不**收「怎么/什么/干嘛/咋/能不能/有没有」这类词：
//    "小鲸鱼怎么没来""小鲸鱼什么都会""小鲸鱼干嘛去了" 全是**聊到它**，
//    收了它们等于把旧 bug 换个写法。宁可漏判（当旁听），不要错判（当场被叫）。
const CALL_FOLLOW_RE = /^\s*(在的|在吗|在不在|在呢|在么|在干嘛|在哪|你好|您好|嗨|哈喽|hello|hi|hey|早|午安|晚安|晚上好|早上好|中午好|下午好|生日快乐|帮我|帮忙|帮个|帮下|帮我看|来一下|来帮|来看|来整|来说|来个|给我|给个|讲个|讲讲|看看|说说|拜托|求你|麻烦|下次|回头|你在|你|您|别|快|呢|啊|呀|吧|嗯|，|,|、|！|!|？|\?|。|~|～|…|$)/;

/**
 * 名字是在**叫它**（呼格），还是只是把名字说出来了（提到）？
 * @returns {boolean}
 */
export function looksLikeCallingName(text, { aliases = [], selfNickname = '' } = {}) {
  const raw = String(text ?? '');
  if (!raw) return false;
  const s = norm(raw);
  if (!s) return false;
  const pool = [...new Set([...(Array.isArray(aliases) ? aliases : []), selfNickname]
    .map(norm)
    .filter((n) => n && n !== '我' && n !== 'all' && n !== AT_ALL_TEXT.slice(1)))];
  if (!pool.length) return false;
  for (const name of pool) {
    let from = 0;
    for (;;) {
      const i = s.indexOf(name, from);
      if (i < 0) break;
      from = i + name.length;
      const before = s.slice(0, i);
      const afterRaw = s.slice(i + name.length);
      const after = afterRaw.replace(NAME_SUFFIX, '');
      const atClauseStart = i === 0
        || BOUNDARY_BEFORE.test(before.slice(-1))
        || CALL_VERB_BEFORE.test(before);
      if (!atClauseStart) continue;
      if (CALL_FOLLOW_RE.test(after)) return true;
    }
  }
  return false;
}

/**
 * 判定一条消息对谁说的。
 *
 * @param entry  store 条目：{ text, atSelf, atOthers, reply:{senderId,sender,text,self} }
 * @param opts   { aliases: string[], selfIds: string[], selfNickname: string }
 * @returns {{target:string, atSelf:boolean, atAll:boolean, atOthers:string[],
 *            replySelf:boolean, replyToSelf:boolean, replyToOther:boolean,
 *            mentionSelf:boolean, callSelf:boolean, via:string}}
 *          mentionSelf = 名字出现在句子里（可能只是聊到）；callSelf = 名字是呼格（在叫它）
 *          via 只用于日志/排查：'structured'（读了结构化字段）/ 'text'（只能靠文本猜）
 */
export function addresseeOf(entry = {}, opts = {}) {
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
  const selfNickname = opts.selfNickname || '';
  const selfIds = (Array.isArray(opts.selfIds) ? opts.selfIds : [opts.selfIds])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);

  const raw = entry || {};
  const text = String(raw.text ?? '');
  const t = parseTextTargets(text, { aliases, selfNickname });

  const structReply = raw.reply && typeof raw.reply === 'object' ? raw.reply : null;
  const structAtSelf = raw.atSelf === true;
  const structAtOthers = Array.isArray(raw.atOthers) ? raw.atOthers.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  // ⚠️ 判据是「字段存在」，不是「值为真」（2026-10-27 修）。
  //   入站每条都会写 atSelf/atOthers（哪怕是 false/null，见 app.js::ingestMessage 的
  //   store.appendIncoming 调用）—— 存在 = 这三个信号已经按 QQ 号精确比过，文本里那个
  //   "@我" 只是 segmentsToText 渲染出来的字符，没有判别力。
  //   以前用「值为真」：一条既没 @ 它、也没 @ 别人的消息，两个字段都为假 →
  //   hasStructured=false → 退回 includes('@我')，于是下面这些全被判成"在叫我"：
  //     "@我要看看多少盘盘能挡子弹 盘盘急麻了"   ← 群友昵称以"我"开头
  //     "荷叶你@我干嘛" / "再@我就当你想我了"    ← 在转述别人 @ 它
  //   实测 3 个群 5774 条里有 19 条是这么来的，每条都会换来一次满血唤醒。
  const hasStructured = Object.prototype.hasOwnProperty.call(raw, 'atSelf')
    || Object.prototype.hasOwnProperty.call(raw, 'atOthers')
    || !!structReply;
  const via = hasStructured ? 'structured' : 'text';

  // ── 1. @我 ────────────────────────────────────────────────────────
  // 结构化：onebot 侧已经比过 QQ 号，最可靠。
  // 文本兜底分两种情况（见 hasStructured 的注释）：
  //   · 没有结构化字段（老存档/外部注入）：宽松 `includes('@我')` —— 那时它只可能是真的标记。
  //   · 有结构化字段：只认**独立的** "@我" 标记（hasAtSelfToken），并且一旦这条消息明确
  //     @ 了别人就不认 —— "@我要看看多少盘盘能挡子弹"是群友昵称，不是叫它。
  // 再兜一层：@ 的目标名字正好是它的昵称（QQ 号没比上，但名字对上了）。
  const atSelf = structAtSelf
    || (structAtOthers.length === 0 && (hasStructured ? hasAtSelfToken(text) : t.atSelf))
    || (structAtOthers.length === 0 && t.atNames.some((n) => isSelfName(n, aliases, selfNickname)));
  // 注：t.atSelf 已经包含了"@昵称/别名"（昵称带空格也认，见 parseTextTargets）

  // ── 2. 引用我的话 ─────────────────────────────────────────────────
  // 结构化 reply.self 由入站比对 senderId===selfId 写入，最可靠；
  // 否则比名字（入站拿不到 QQ 号时至少还有昵称）。
  const replySelf = structReply?.self === true
    || (!!structReply?.senderId && selfIds.includes(String(structReply.senderId)))
    || (!!structReply?.sender && isSelfName(structReply.sender, aliases, selfNickname))
    || (!structReply && !!t.replySender && isSelfName(t.replySender, aliases, selfNickname));

  // 引用了某个人（不是它）—— 结构化里有 sender 就行，文本兜底要有名字
  const replyOther = !replySelf
    && (!!structReply?.senderId || !!structReply?.sender || !!t.replySender);

  // ── 3. @别人 ──────────────────────────────────────────────────────
  // ⚠️ 结构化 atOthers 是权威（入站按 QQ 号逐个解析出来的）；有它的时候**不再**并进
  //   文本抓的名字。没有它的时候（老数据）也要把"@我X"整段丢掉：
  //   `@我` 是渲染标记，后面那句正文会被正则当成一个人名 ——
  //   "荷叶你@我干嘛" 会抓出个叫"我干嘛"的人，于是判成"对别人说"（碰巧不回复，
  //   但 otherName 会把"我干嘛"喂给模型）。真正的 @别人 一定带结构化名字，不靠猜。
  const namePool = structAtOthers.length
    ? structAtOthers
    : t.atNames.filter((n) => !String(n).startsWith('我'));
  const atOthers = namePool
    .map((n) => String(n ?? '').trim())
    .filter(Boolean)
    .filter((n) => n !== '我' && n !== 'all' && n !== AT_ALL_TEXT.slice(1))
    .filter((n) => !isSelfName(n, aliases, selfNickname));
  const atAll = t.atAll || structAtOthers.some((n) => n === 'all');

  const mentionSelf = mentionsSelf(text, aliases, selfNickname);
  // 只是"聊到它"（名字出现）≠ "在叫它"（呼格）。见文件头 2026-10-31 那段。
  const callSelf = mentionSelf && looksLikeCallingName(text, { aliases, selfNickname });

  // 对谁说的那个人（"对小明说"比"对别人说"好懂，模型要的就是这个名字）
  const otherName = atOthers[0]
    || structReply?.sender
    || t.replySender
    || '';

  const base = {
    atSelf,
    atAll,
    atOthers,
    replySelf,
    replyToSelf: replySelf,
    replyToOther: replyOther,
    otherName,
    mentionSelf,
    callSelf,
    via
  };

  if (atSelf || replySelf) return { ...base, target: TARGET.SELF };
  if (atAll) return { ...base, target: TARGET.ALL };
  // ★ 明确在跟别人说 —— 即便提到了它的名字，那也是"聊到它"，不是"叫它"
  if (atOthers.length || replyOther) return { ...base, target: TARGET.OTHER };
  // ★ 叫它的名字（呼格）才算叫它；裸提到名字不算（2026-10-31）
  if (callSelf) return { ...base, target: TARGET.SELF };
  return { ...base, target: TARGET.NONE };
}

/** 只取 target（批量判定时省一次解构）。 */
export function targetOf(entry, opts = {}) {
  return addresseeOf(entry, opts).target;
}

/** 一批消息各自的 target（顺序与入参一致）。 */
export function targetsOf(entries = [], opts = {}) {
  return (Array.isArray(entries) ? entries : []).map((e) => addresseeOf(e, opts).target);
}

/**
 * 这批消息里"最后一条"的寻址 —— 决定要不要接话时看的是最后一条，
 * 不是 anyone 说过什么：别人中间插一句不能替这条盖棺定论。
 */
export function lastTargetOf(entries = [], opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return TARGET.NONE;
  return addresseeOf(list[list.length - 1], opts).target;
}

/**
 * 群友之间在对谈吗（她在旁听）。
 *
 * 两种都算：
 *   · 最后一条明确是对别人说的（@张三 / 引用张三）；
 *   · 最后两条来自**两个不同的人**，且都不是对她说 —— A 问 B 答，她在旁边看着。
 *     （同一个人的连发不算：那是他在自己说，她插一句不算抢话。）
 *
 * @param targets 与 entries 等长的 target 数组（先算好传进来，避免重复解析）
 */
export function isSideTalk(entries = [], targets = []) {
  const list = Array.isArray(entries) ? entries : [];
  const tg = Array.isArray(targets) ? targets : [];
  if (!list.length) return false;
  const tailT = tg.slice(-2);
  if (tailT.includes(TARGET.OTHER)) return true;
  if (tailT.includes(TARGET.SELF)) return false;
  const ids = list.slice(-2)
    .map((e) => String(e?.senderId ?? '').trim())
    .filter(Boolean);
  return ids.length === 2 && ids[0] !== ids[1];
}

/** 一句话说清"这条是对谁说的"，给提示词/日志用。空字符串 = 没有明确寻址，不必标注。 */
export function describeTarget(info = {}) {
  if (info.target === TARGET.SELF) {
    if (info.atSelf) return '@我';
    if (info.replySelf) return '引用我';
    if (info.callSelf) return '叫我';
    if (info.mentionSelf) return '提到我';
    return '对我';
  }
  if (info.target === TARGET.ALL) return '对全体';
  if (info.target === TARGET.OTHER) {
    const who = (info.atOthers || [])[0] || info.otherName;
    if (who) return `对${who}`;
    return '对别人';
  }
  // 谁也没叫，但话里出现了它的名字 —— 给提示词/闸门一个"聊到我，没叫我"的标注，
  // 免得模型看到名字就往自己身上接（m00001）。
  if (info.mentionSelf) return '聊到我';
  return '';
}
