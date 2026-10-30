// 唤醒闸门：**先判断这批消息值不值得叫醒模型**，再决定要不要真的跑一次。
//
// 为什么要有它：现在每条白名单消息都会完整跑一次模型（实测平均 9,647 入 token/次），
// 而其中相当一部分最后什么都没发（近 300 个会话里 39% 是 noreply）—— 那些调用纯属白花。
//
// 判据"从严到松"（对齐同类实现的做法）：
//   私聊 → 被@/被拍 → 叫我名字 → 引用我的话 → 命中关键词 → 连续对话 → 概率唤醒
//   概率上再叠两个权重：自己刚在这个会话说过话（活跃期）→ 提权；群里冷了很久（冷场）→ 降权。
//
// ── v2：连续对话（学自 Estrella「拟人对话逻辑」）──────────────────────────
// 以前"同一个人接着刚才的话说"和"陌生人随便说一句"走的是同一条概率路：五五开地
// 装作没看见。现在在概率之前插一条**确定性**判定：她刚回过的那个人，在接话窗口内
// 继续说 → 直接接住（reason='continuation'）。窗口与锚点状态在 talk-session.js，
// 这里只读它给的事实，不维护状态。
//
// ── v2：档位（tier.js）──────────────────────────────────────────────────
// 放行时同时给出 `kind`（稳定枚举）与 `tier`（上下文档位）。
// ⚠️ 档位**不**由 reason 反推：reason 是给人看的文案，改一个字就会静默错档。
//
// 不跑的时候：只把消息标已读（它们**仍留在存档里**，会成为下一轮的【过去状态】），零模型调用。
//
// ── v3：打分（学自 MaiBot 的"激活度"，2026-10-22 生态调研 P1-1）──────────
// 以前"没人 @ 也没人叫我"时只有一条概率路：p 是常数，聊什么都一样。
// 现在先把几条**可解释的信号**算成 0–1 的分，再让概率随分浮动：
//   问句（他在等一个回应）、多人在聊、长度像话、自己刚说过（活跃期）、群冷了（降权）。
// 两种用法：
//   mode='probability'（默认）→ p 被分调制（0.7 倍 ~ 1.3 倍），保持原有量级；
//   mode='score'            → 直接用 score 与 threshold 比，适合想精确控回复率时。
//
// ── v4：寻址（addressee.js）────────────────────────────────────────────
// 前面三版都只回答「有没有人叫它」，不回答「这句话是对谁说的」。于是群里
// A 对 B 说话时，它照样接过去 —— 就是「和群友说话，她以为在跟她说话」。
// 现在先把这批消息各自标上 target（self/other/all/none），再决定：
//   · 对别人说的条目**不能当"叫它"的证据**（哪怕话里提到了它的名字）；
//   · 最后一条是对别人说的 → 不接着刚才的话（continuation 失效）；
//   · 概率路径按 target 降权（对别人说几乎不接，群友对谈少接）。
// 判定本身在 addressee.js（纯函数），这里只消费结论。
//
// 纯函数：now / rng 都由入参给 → 每条判据都能直接断言，不必等真时间或碰运气。
import { tierOfKind } from './tier.js';
import { TARGET, addresseeOf, isSideTalk } from './addressee.js';

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

const hasAny = (text, list) => list.some((w) => w && String(text).includes(String(w)));

/** 问句/求助的语气：这类消息"值得接"的程度天然更高。 */
const ASK_RE = /[?？]|吗|呢|怎么|为什么|为啥|啥|多少|几点|哪里|哪个|谁|能不能|可不可以|有没有/;

/**
 * 把一批消息变成几个可解释的信号（0/1 或计数），不打分。
 * 单独导出是为了让测试能逐条断言，也方便以后加信号。
 */
export function wakeSignals({ entries = [], lastSelfAt = 0, lastOtherAt = 0, now = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const texts = list.map((e) => String(e?.text ?? ''));
  const last = texts.length ? texts[texts.length - 1] : '';
  const bare = last.replace(/\s+/g, '');
  const senders = new Set(list.map((e) => String(e?.senderId ?? '').trim()).filter(Boolean));
  const nowMs = Number(now) || Date.now();
  const lastSelf = Number(lastSelfAt) || 0;
  const lastOther = Number(lastOtherAt) || 0;
  const selfAgoMin = lastSelf > 0 ? (nowMs - lastSelf) / 60000 : Infinity;
  const otherAgoMin = lastOther > 0 ? (nowMs - lastOther) / 60000 : Infinity;
  // 问句看**最近三条**：一个"问"跟一个"答"打包进来时，最后一条是答案，
  // 只看最后一条会把"有人在等回应"这件事漏掉。
  const tail = texts.slice(-3);
  return {
    question: tail.some((t) => ASK_RE.test(t)) ? 1 : 0,
    multiParty: senders.size >= 2 ? 1 : 0,
    lengthFit: bare.length >= 4 && bare.length <= 60 ? 1 : (bare.length > 0 ? 0.4 : 0),
    recentSelf: selfAgoMin <= 20 ? 1 : 0,
    // 未知不等于冷场：lastOtherAt=0 表示"没有这个数据"，不该当惩罚
    longSilence: lastOther > 0 && otherAgoMin >= 30 ? 1 : 0,
    count: list.length,
    senders: senders.size,
  };
}

/** 信号 → 0..1 的分（权重写死、可解释，不训练）。 */
export function wakeScore(signals = {}) {
  const s = signals || {};
  const score = 0.42 * clamp01(s.question)
    + 0.24 * clamp01(s.multiParty)
    + 0.18 * clamp01(s.lengthFit)
    + 0.16 * clamp01(s.recentSelf)
    - 0.12 * clamp01(s.longSilence);
  return Math.round(clamp01(score) * 1000) / 1000;
}

/**
 * @param kind        'group' | 'private'
 * @param entries     这一批待处理的未读消息（store 条目：{ text, reply, ... }）
 * @param cfg         完整配置（读 cfg.gate）或直接传 gate 段
 * @param aliases     机器人的自称/昵称（"叫名字"判定用）
 * @param lastSelfAt  自己在这个会话最后一次说话的时间戳（0=没说过）
 * @param lastOtherAt 这批消息**之前**群里最后一条别人消息的时间戳（0=未知）
 * @param talk        连续对话状态（talk-window 的返回值；没有就传 null）
 * @param selfId      机器人自己的 QQ（判定"@ 的是不是它"）
 * @param selfNickname 机器人的昵称
 * @returns {{wake:boolean, reason:string, kind?:string, tier?:string, wouldSkip:boolean,
 *            probability?:number, boosted?:boolean, cooled?:boolean, continuation?:boolean,
 *            toOther?:boolean, sideTalk?:boolean, targets?:string[]}}
 */
export function decideWake({
  kind = 'group', entries = [], cfg = {}, aliases = [], lastSelfAt = 0, lastOtherAt = 0,
  now = Date.now(), rng = Math.random, talk = null, wait = null,
  selfId = '', selfNickname = ''
} = {}) {
  const gate = cfg && cfg.gate ? cfg.gate : (cfg || {});
  if (gate.enabled === false) return { wake: true, reason: 'gate-off', wouldSkip: false, kind: kind === 'private' ? 'private' : 'interject' };

  const list = Array.isArray(entries) ? entries : [];
  const texts = list.map((e) => String(e && e.text ? e.text : ''));
  const names = (Array.isArray(aliases) ? aliases : []).map((a) => String(a || '').trim()).filter(Boolean);
  const keywords = Array.isArray(gate.keywords) ? gate.keywords.map((k) => String(k || '').trim()).filter(Boolean) : [];

  // ── 寻址：这批消息各自是"对谁说的" ────────────────────────────────
  const addrCfg = (gate.addressee && typeof gate.addressee === 'object') ? gate.addressee : {};
  const addrOn = addrCfg.enabled !== false;
  const addrOpts = {
    aliases: names,
    selfIds: [selfId, cfg.selfId].filter(Boolean).map((x) => String(x)),
    selfNickname: selfNickname || cfg.selfNickname || ''
  };
  const addrs = addrOn ? list.map((e) => addresseeOf(e, addrOpts)) : list.map(() => ({ target: TARGET.NONE, atOthers: [], atSelf: false, atAll: false, replySelf: false, mentionSelf: false }));
  const targets = addrs.map((a) => a.target);
  // 候选 = 不是"对别人说的"那些条目。对别人说的消息，无论内容多像在叫它，都不作数。
  const cands = [];
  for (let i = 0; i < list.length; i++) {
    if (addrOn && targets[i] === TARGET.OTHER) continue;
    cands.push({ e: list[i] || {}, a: addrs[i] || {}, t: texts[i] || '' });
  }
  const cTexts = cands.map((c) => c.t);

  let reason = '';
  if (kind === 'private') reason = 'private';
  // "@我" 只认 addressee 的结论：它已经按结构化字段比过 QQ 号，也自带老数据的文本兜底。
  // ⚠️ 这里**不要**再自己 `includes('@我')` —— 那会绕过结构化，把
  //    "@我要看看多少盘盘能挡子弹"（昵称以"我"开头）、"荷叶你@我干嘛"（转述）
  //    判成"在叫我"，而这一条是明确触发，后面的寻址降权全被跳过（实测 19 条）。
  else if (cands.some((c) => c.a.atSelf === true) || cTexts.some((t) => t.includes('你拍了拍'))) reason = 'at';
  else if (cands.some((c) => c.a.atAll === true) || cTexts.some((t) => t.includes('@全体成员'))) reason = 'at-all';
  // ★ 2026-10-31（m00001）：以前是 `names.length && cTexts.some(t => hasAny(t, names))` ——
  //   名字**裸子串**出现就算"在叫它"，而且是确定性命中、直接 return，绕过后面所有概率与
  //   寻址降权。于是"小鲸鱼今天怎么没来""我觉得小鲸鱼有点吵"这种**聊到它**的话，每次都能
  //   满血唤醒它去接话 —— 这就是"明明没跟她说话，却以为在跟她说话"。
  //   现在只认呼格（addresseeOf 的 callSelf：名字在分句开头 + 后面跟着叫它做事的词）。
  else if (cands.some((c) => c.a.callSelf === true)) reason = 'named';
  else if (cands.some((c) => c.a.replySelf === true)
    || (!addrOn && list.some((e) => e && e.reply && (e.reply.self === true || (names.length && hasAny(String(e.reply.sender || ''), names)))))) reason = 'reply-self';
  // 被拍 = 被召唤（群里的「拍一拍」和私聊戳一下是同一个意思）。只认"拍了拍你"，
  // 别人之间的拍一拍不叫醒它 —— 那只是群里的背景动静。
  //
  // ★ 但"被拍"只保证**回拍**，不保证**说话**：回拍是 app.js 入站里的确定性动作，
  //   这里决定的是要不要顺带开一次模型去接一句。每次都接会显得有求必应、像个应答机，
  //   所以按 gate.pokeReplyProb 掷骰子（默认 0.6）。掷不中时消息照样标已读、留在存档里。
  //
  // ⚠️ 这条**故意不看 gate.dryRun**：dryRun 的用途是"先观察新判据会不会误杀该回的话"，
  //   而"被拍之后说不说"不影响"该不该回"（回拍已经应过了，不说话不会漏事）。
  //   跟着 dryRun 一起演练的话，开着演练就变成每次必接 —— 那这个概率等于没写。
  else if (cTexts.some((t) => t.includes('拍了拍你'))) {
    const pPoke = gate.pokeReplyProb === undefined ? 0.6 : clamp01(gate.pokeReplyProb);
    if (Number(rng()) < pPoke) reason = 'poke';
    else {
      return {
        wake: false, reason: 'poke-quiet', wouldSkip: true, probability: pPoke,
        kind: 'interject', tier: tierOfKind('interject')
      };
    }
  }
  else if (keywords.length && cTexts.some((t) => hasAny(t, keywords))) reason = 'keyword';

  // 明确触发 → 同时给出 kind/tier（档位由产出判定这一行给出，不从 reason 反推）
  if (reason) {
    const dkind = (reason === 'private' || reason === 'gate-off') ? 'private' : 'named';
    // 关键词是独立档位：命中关键词带满对话、只收背景（见 tier.js）
    const outKind = reason === 'keyword' ? 'keyword' : dkind;
    return { wake: true, reason, wouldSkip: false, kind: outKind, tier: tierOfKind(outKind) };
  }

  const nowMs = Number(now) || Date.now();
  const signals = wakeSignals({ entries, lastSelfAt, lastOtherAt, now: nowMs });
  const score = wakeScore(signals);

  // ── "等被叫"（action-planner.mentionWait）─────────────────────────────
  // 模型自己说了"先安静，等你叫我"，就真的别再被弱触发叫起来。
  // ⚠️ 只在**没有**明确触发时生效：@、点名、引用、私聊在上面已经 return 了。
  const waitUntil = Number(wait?.until) || 0;
  if (waitUntil > nowMs) {
    return {
      wake: false, reason: 'waiting-mention', wouldSkip: true,
      kind: 'interject', tier: tierOfKind('interject'),
      score, signals, waitRemainingMs: waitUntil - nowMs
    };
  }

  // ── 连续对话（确定性，不掷骰子）──────────────────────────────────────
  // 条件：有锚点、窗口还没过、还没到 12 轮软收尾、这条确实是锚点说的。
  // ⚠️ 只认"这批的最后一条" —— 一个陌生人夹在中间说话不能替锚点续命。
  //
  // ★ v4：锚点这句是在**跟别人说**的话，不算接话。
  //   这就是"我转头和群友说话，她还一句句接下去"的那条路径：她是锚点没错，
  //   但我这句 @的是别人、引用的是别人的话 —— 我已经换人聊了。
  if (talk && talk.active === true && talk.closing !== true && talk.partnerId) {
    const last = entries.length ? entries[entries.length - 1] : null;
    const speaker = String(last?.senderId ?? '').trim();
    const lastTarget = targets.length ? targets[targets.length - 1] : TARGET.NONE;
    if (speaker && speaker === String(talk.partnerId) && !(addrOn && lastTarget === TARGET.OTHER)) {
      return {
        wake: true, reason: 'continuation', kind: 'continuation', tier: tierOfKind('continuation'),
        wouldSkip: false, continuation: true, probability: 1, score, signals,
        targets, toOther: false, sideTalk: false
      };
    }
  }

  // ── 寻址降权 ─────────────────────────────────────────────────────────
  // toOther   ：这批里有人在明着跟别人说（@别人 / 引用别人的话）→ 她只是旁人
  // sideTalk  ：最后两条来自两个不同的人 → 那两个人在对谈，她也是旁人
  // 两者都只是"降低概率"，不是禁止：极偶尔顺嘴接一句是真人会做的事。
  // 想彻底不接就把对应倍率写成 0。
  const toOther = addrOn && targets.includes(TARGET.OTHER);
  const sideTalk = addrOn && !toOther && isSideTalk(entries, targets);
  const addrFactor = clamp01(addrCfg.toOtherFactor === undefined ? 0.08 : Number(addrCfg.toOtherFactor));
  const sideFactor = clamp01(addrCfg.sideTalkFactor === undefined ? 0.35 : Number(addrCfg.sideTalkFactor));
  const addrMul = toOther ? addrFactor : (sideTalk ? sideFactor : 1);

  let p = clamp01(Number(gate.probability) || 0);
  const activeWindowMs = Number(gate.activeWindowMs) || 0;
  const lastSelf = Number(lastSelfAt) || 0;
  const boosted = activeWindowMs > 0 && lastSelf > 0 && (nowMs - lastSelf) <= activeWindowMs;
  if (boosted) p = clamp01(p * (Number(gate.activeBoost) || 1));
  const coldGapMs = Number(gate.coldGapMs) || 0;
  const lastOther = Number(lastOtherAt) || 0;
  const cooled = coldGapMs > 0 && lastOther > 0 && (nowMs - lastOther) >= coldGapMs;
  if (cooled) p = clamp01(p * (Number(gate.coldFactor) || 1));

  // 内容分：只用"这条消息本身值不值得接"的信号（问句/多人/长度），
  // 不含活跃期与冷场 —— 那两个已经通过 boost/cold 作用在 p 上了，避免重复计权。
  const contentScore = clamp01((0.42 * signals.question + 0.24 * signals.multiParty + 0.18 * signals.lengthFit) / 0.84);

  const mode = gate.mode === 'score' ? 'score' : 'probability';
  const prob = {
    probability: p, boosted, cooled, kind: 'interject', tier: tierOfKind('interject'),
    score, signals, mode, targets, toOther, sideTalk
  };

  if (mode === 'score') {
    const threshold = gate.threshold === undefined ? 0.5 : clamp01(gate.threshold);
    const adjScore = Math.round(clamp01(score * addrMul) * 1000) / 1000;
    const wouldWake = adjScore >= threshold;
    const scored = { ...prob, probability: adjScore, threshold, rawScore: score };
    if (gate.dryRun) return { wake: true, reason: 'dry-run', wouldSkip: !wouldWake, ...scored };
    if (wouldWake) return { wake: true, reason: 'score', ...scored };
    return {
      wake: false,
      // 被寻址压下去的和"分本来就不够"分开：前者是"她在旁听"，后者是"这话没意思"
      reason: addrMul < 1 ? 'to-others' : 'skipped',
      wouldSkip: true, ...scored
    };
  }

  // probability 模式：分只做小幅调制（0.75~1.25 倍），不改变配置写下时的量级。
  p = clamp01(p * (0.75 + 0.5 * contentScore));
  // 寻址降权放在最后：它在内容分之后，这样"问句+对别人说"也不会翻身。
  const beforeAddr = p;
  p = clamp01(p * addrMul);
  prob.probability = p;
  prob.contentScore = contentScore;
  prob.addrMul = addrMul;

  const wouldWake = Number(rng()) < p;
  if (gate.dryRun) return { wake: true, reason: 'dry-run', wouldSkip: !wouldWake, ...prob };
  if (!wouldWake && addrMul < 1) {
    // 被寻址拦下的，单独一个 reason：和"掷骰子没中"分开，方便事后看是降权生效还是运气。
    // probability 一律是**真正掷骰子用的那个数**（降权后的），降权前那个另存 rawProbability。
    return {
      wake: false, reason: 'to-others', wouldSkip: true, ...prob,
      rawProbability: beforeAddr
    };
  }
  return wouldWake
    ? { wake: true, reason: 'probability', ...prob }
    : { wake: false, reason: 'skipped', wouldSkip: true, ...prob };
}

/** 决策 → 一行日志文案。 */
export function describeWake(chatKey, d = {}) {
  const pct = typeof d.probability === 'number' ? d.probability.toFixed(3) : '-';
  const sc = typeof d.score === 'number' ? `，分=${d.score.toFixed(2)}` : '';
  const why = d.signals
    ? `（${[
      d.signals.question ? '问句' : '',
      d.signals.multiParty ? '多人在聊' : '',
      d.signals.recentSelf ? '活跃期' : '',
      d.signals.longSilence ? '冷场' : '',
    ].filter(Boolean).join('·') || '普通闲聊'}）`
    : '';
  // 寻址那半句：她是在旁听，还是确实被叫到了
  const addr = d.toOther ? '，群友之间在说话（×' + (d.addrMul ?? '') + '）'
    : (d.sideTalk ? '，两个群友在对谈（×' + (d.addrMul ?? '') + '）' : '');
  if (d.reason === 'dry-run') {
    // 两种演练要分开说：本来是"该跳过"的，和本来是"会唤醒"的。
    // 以前一律写"本来会跳过"，而真实唤醒的也这么说，日志对不上账。
    const tail = d.wouldSkip
      ? '——dryRun 开着，不在这里真跳；这批交给唤醒预判再看一眼'
      : '——dryRun 开着，本来也会唤醒';
    return '[闸门·演练] ' + chatKey + ' 这批消息' + (d.wouldSkip ? '"本来会跳过"' : '"本来就会唤醒"')
      + '（p=' + pct + sc + (d.boosted ? '，活跃期提权' : '') + (d.cooled ? '，冷场降权' : '') + why + '）' + tail;
  }
  if (d.wake) {
    const tier = d.tier ? '，档位 ' + d.tier : '';
    const cont = d.continuation ? '，接着刚才那个人的话' : '';
    return '[闸门] ' + chatKey + ' 唤醒（' + d.reason + (d.probability !== undefined ? '，p=' + pct : '') + sc + (d.boosted ? '，活跃期提权' : '') + (d.cooled ? '，冷场降权' : '') + tier + cont + addr + '）';
  }
  if (d.reason === 'waiting-mention') {
    const min = Math.max(1, Math.round((Number(d.waitRemainingMs) || 0) / 60000));
    return '[闸门] ' + chatKey + ' 跳过唤醒（说了等被叫，还剩 ' + min + ' 分钟；被 @/点名会立刻解除）：消息已标已读';
  }
  if (d.reason === 'poke-quiet') {
    return '[闸门] ' + chatKey + ' 被拍了一下，已经拍回去，这次不接话（p=' + pct + '）';
  }
  if (d.reason === 'to-others') {
    const raw = typeof d.rawProbability === 'number' ? d.rawProbability.toFixed(3) : '?';
    return '[闸门] ' + chatKey + ' 跳过唤醒（这条是对别人说的，p 从 ' + raw + ' 降到 ' + pct + '（×' + (d.addrMul ?? 0) + '）没中' + sc + why + '）：消息已标已读，仍保留在存档里当上下文';
  }
  return '[闸门] ' + chatKey + ' 跳过唤醒（' + d.reason + '，p=' + pct + sc + why + addr + '）：消息已标已读，仍保留在存档里当上下文';
}
