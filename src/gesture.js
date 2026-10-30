// 「肢体动作」：拍一拍与 @ —— 判定、去重、频率、按心情的分寸。
//
// 为什么单独一层：这两件事都是"真人会做、但机器容易做过头"的动作。
// 散在工具里写，就会出现三种典型病：
//   ① 别人之间的拍一拍也把它叫醒（它开始对别人的互动插嘴）；
//   ② 模型一兴奋连拍五下、每条回复都 @ 人（群里立刻看出是机器人）；
//   ③ 私聊里也 @（QQ 私聊没有 @ 语义，协议端直接让整条消息失败）。
// 所以：判据全在这里（纯函数、零依赖、可断言），工具和入站事件只负责接线。

/** 入站拍一拍事件里我们认的标记。提示词/闸门都依赖它，别改。 */
export const POKE_MARK = '[拍一拍]';

/**
 * 解析一条 OneBot notice（拍一拍）。
 *
 * 三条 fail-closed 纪律（学自 Estrella 的 notice.js，也是踩过的坑）：
 *   · **拿不到 target_id 就当没发生**，不能拿 user_id 兜底 ——
 *     那会把"谁拍的"当成"拍的谁"，于是任何人拍别人都被当成拍在机器人身上；
 *   · **自己拍的**（send_poke 的事件回显）直接丢，否则一次主动拍会触发一轮自言自语；
 *   · 私聊里 NapCat 有时把 `sender_id` 也塞进来，判定"是不是自己"要把两者都比一遍。
 *
 * @param {object} event OneBot 原始事件
 * @param {string} selfId 机器人自己的 QQ
 * @returns {{ok:boolean, reason:string, kind:'group'|'private', chatKey:string,
 *            fromId:string, targetId:string, aboutSelf:boolean, dedupeKey:string, at:number}}
 */
export function parsePokeEvent(event, selfId) {
  const fail = (reason) => ({
    ok: false, reason, kind: '', chatKey: '', fromId: '', targetId: '',
    aboutSelf: false, dedupeKey: '', at: 0
  });
  if (!event || typeof event !== 'object') return fail('bad-event');
  if (event.post_type !== 'notice' || event.notice_type !== 'notify' || event.sub_type !== 'poke') {
    return fail('not-poke');
  }

  const self = String(selfId ?? event.self_id ?? '');
  const fromId = String(event.user_id ?? event.sender_id ?? '').trim();
  const targetRaw = event.target_id;
  if (!fromId) return fail('no-actor');
  if (self && (fromId === self || String(event.sender_id ?? '') === self)) return fail('self-echo');

  const targetId0 = targetRaw === null || targetRaw === undefined ? '' : String(targetRaw).trim();
  const groupId = event.group_id;
  const kind = groupId === null || groupId === undefined || String(groupId) === '' ? 'private' : 'group';

  // 私聊里 target_id 缺失是常态（NapCat 有时只给 user_id）：私聊只有两个人，
  // 戳一下**必然**是冲我来的，这时候按"拍我"处理不是猜，是场景本身决定的。
  // 群里不能这么做 —— 群里少一个 target_id 就等于不知道拍的是谁，宁可不触发。
  let targetId = targetId0;
  if (!targetId && kind === 'private' && self) targetId = self;
  if (!targetId || targetId === '0') return fail('no-target');

  const chatKey = kind === 'group' ? `group:${String(groupId)}` : `private:${fromId}`;
  const at = event.time ? Math.round(Number(event.time) * 1000) : Date.now();

  return {
    ok: true,
    reason: '',
    kind,
    chatKey,
    fromId,
    targetId,
    aboutSelf: !!self && targetId === self,
    // 同一个 poke 被协议端重复推送时用它去重；time 参与 → 真的又拍了一次不会被吞
    dedupeKey: `${chatKey}|${fromId}|${targetId}|${event.time ?? ''}`,
    at
  };
}

/**
 * 拍一拍事件写进存档时的正文。
 *
 * 拍我：明确说"你被拍了"（模型要能一眼看出这是冲它来的）；
 * 拍别人：只陈述，不暗示"该你接话" —— 群里的互动它不一定非要插一脚。
 * @returns {string}
 */
export function pokeTextOf(p, { fromName = '', targetName = '', selfId = '' } = {}) {
  const who = String(fromName || p?.fromId || '有人').trim();
  const target = String(targetName || p?.targetId || '').trim();
  if (String(p?.targetId) === String(selfId) && selfId) return `${POKE_MARK} ${who} 拍了拍你`;
  if (p?.fromId && p?.targetId && String(p.fromId) === String(p.targetId)) return `${POKE_MARK} ${who} 拍了拍自己`;
  return `${POKE_MARK} ${who} 拍了拍 ${target || '对方'}`;
}

// ── 出站：该不该拍、该不该 @ ─────────────────────────────────────────────

/**
 * 拍一拍的"分寸"。
 *
 * 依据是现实里的三个约束（不是随机数）：
 *   · **手速**：刚拍过就别再拍（同一会话 45 秒内最多一次）；
 *   · **关系**：同一个人 20 分钟内只拍一次 —— 真人反复拍同一个人是"急事找上门"，不是撒娇；
 *   · **状态**：夜里（0~6 点）不主动拍；心情低落（≤35）不主动拍，但**可以回拍**。
 * 回拍（inbound=true，对方刚拍了我）不受"主动"那两条限制，只留 8 秒手速。
 *
 * @param {object} p
 * @param {number} [p.now]
 * @param {number} [p.moodScore] 0~100（mood.js 的 score）
 * @param {number} [p.lastPokeAt] 本会话上次拍人时间
 * @param {number} [p.lastPokeToTargetAt] 上次拍**这个目标**的时间
 * @param {number} [p.pokesThisRun] 本轮已经拍了几次
 * @param {boolean} [p.inbound] 是不是在回拍
 * @param {string} [p.targetId]
 * @param {object} [p.cfg] 设置里的 gesture 段
 * @returns {{allow:boolean, reason:string, delayMs:number}}
 */
export function pokeBudget({
  now = Date.now(), moodScore = 50, lastPokeAt = 0, lastPokeToTargetAt = 0,
  pokesThisRun = 0, inbound = false, targetId = '', cfg = {}
} = {}) {
  const c = cfg || {};
  const chatCooldown = Math.max(0, Number(c.pokeCooldownMs ?? 45000));
  const targetCooldown = Math.max(0, Number(c.pokeTargetCooldownMs ?? 20 * 60 * 1000));
  const maxPerRun = Math.max(1, Number(c.maxPokePerRun ?? (inbound ? 1 : 1)));
  const quietFrom = Number(c.quietFromHour ?? 0);
  const quietTo = Number(c.quietToHour ?? 6);
  const sadBelow = Number(c.sadMoodBelow ?? 35);

  if (pokesThisRun >= maxPerRun) return { allow: false, reason: '本轮已经拍过了', delayMs: 0 };

  const elapsedChat = lastPokeAt ? now - lastPokeAt : Infinity;
  const elapsedTarget = lastPokeToTargetAt ? now - lastPokeToTargetAt : Infinity;

  if (inbound) {
    // 回拍：手速还是要有的，但别拿"深夜/心情"卡它 —— 被拍了装死更假
    if (elapsedChat < 8000) return { allow: false, reason: '刚拍过，太快了', delayMs: 0 };
    return { allow: true, reason: '回拍', delayMs: randDelay(250, 900) };
  }

  if (elapsedChat < chatCooldown) {
    return { allow: false, reason: `刚拍过 ${Math.round(elapsedChat / 1000)} 秒，间隔太短`, delayMs: 0 };
  }
  if (targetId && elapsedTarget < targetCooldown) {
    return { allow: false, reason: '这个人刚被拍过，重复拍会显得像刷屏', delayMs: 0 };
  }

  const hour = new Date(now).getHours();
  const inQuiet = quietFrom <= quietTo
    ? (hour >= quietFrom && hour < quietTo)
    : (hour >= quietFrom || hour < quietTo);
  if (inQuiet) return { allow: false, reason: '这个点不主动戳人', delayMs: 0 };

  if (Number(moodScore) <= sadBelow) return { allow: false, reason: '心情低的时候不主动招惹人', delayMs: 0 };

  // 心情越好越想动手动脚：兴奋时快一点，平静时慢一点（差距不大，只是"手贱"的节奏感）
  const mood = Math.max(0, Math.min(100, Number(moodScore) || 50));
  const delay = mood >= 75 ? randDelay(300, 900) : randDelay(700, 1800);
  return { allow: true, reason: '可以', delayMs: delay };
}

/**
 * 回拍该不该拍（别人刚拍了我）。
 *
 * 为什么在 pokeBudget 之外再包一层：inbound 分支只做"手速"（8 秒），
 * 挡不住"隔十来秒戳我一次"——那是有人在反复逗它，每次都回拍就成刷屏了。
 * 所以这里多一条「同一个人 60 秒内只回一次」，其余分寸仍交给 pokeBudget。
 *
 * 注意 lastPokeAt 传的是**上次回拍**的时间：回拍和主动拍共用同一条手速线，
 * 不然刚主动拍完别人、转头被人拍，就会立刻再拍一下。
 *
 * @returns {{allow:boolean, reason:string, delayMs:number}}
 */
export function shouldPokeBack({
  now = Date.now(), fromId = '', lastBackAt = 0, lastBackTargetId = '', cfg = {}
} = {}) {
  const c = cfg || {};
  const same = Boolean(fromId) && String(fromId) === String(lastBackTargetId || '');
  const sameTargetMs = Math.max(0, Number(c.pokeBackSameTargetMs ?? 60000));
  if (same && lastBackAt && now - lastBackAt < sameTargetMs) {
    return { allow: false, reason: '同一个人刚回过，再拍就是刷屏', delayMs: 0 };
  }
  return pokeBudget({ now, inbound: true, lastPokeAt: lastBackAt, pokesThisRun: 0, targetId: fromId, cfg: c });
}

/**
 * 连着被戳：数一数，到点就炸毛。
 *
 * 为什么需要这一层（学自 Estrella 社区包 gm-poke-bomb）：
 *   shouldPokeBack 只保证"不刷屏"——同一个人 60 秒内只回一次。可如果对方
 *   隔一分钟戳一下、戳了五下，它每次都乖乖回拍，看起来就不是人，是个弹簧。
 *   真人被连戳到第四下会毛：可以不理、可以"你干嘛"、可以反手骂一句。
 *
 * 所以这里给的是**要不要继续陪玩**，不是"要不要发消息":
 *   · 没到阈值 → 照常回拍（angry=false）；
 *   · 到阈值 → **不再回拍**（angry=true），并把这句话交给模型自己决定怎么哼。
 *     故意不自动发固定台词：自动台词是死板的，连着三次一样就成了复读机。
 *
 * 计数规则：
 *   · 同一个会话、同一个人，两次戳间隔超过 resetMs（默认 5 分钟）就重新从 1 数；
 *   · 到阈值后不重置 —— 继续戳就一直算"还在毛着"，隔 5 分钟才自然消退。
 *
 * @returns {{count:number, angry:boolean, level:'calm'|'annoyed'|'angry', note:string, nextCount:number}}
 */
export function pokeStreak({
  count = 0, lastAt = 0, now = Date.now(), cfg = {}
} = {}) {
  const c = cfg || {};
  const resetMs = Math.max(1000, Number(c.pokeStreakResetMs ?? 5 * 60 * 1000));
  const angryAt = Math.max(2, Number(c.pokeAngryAt ?? 4));
  const gap = lastAt ? now - lastAt : Infinity;

  // 隔太久 = 之前那串已经结束了，这是新的一下
  const nextCount = gap > resetMs ? 1 : Math.max(0, Number(count) || 0) + 1;
  const angry = nextCount >= angryAt;
  const level = angry ? 'angry' : (nextCount >= angryAt - 1 ? 'annoyed' : 'calm');

  let note = '';
  if (angry) {
    note = `（他连着戳了你 ${nextCount} 下）`;
  } else if (level === 'annoyed') {
    note = `（他今天戳你有点勤，这是第 ${nextCount} 下）`;
  }

  return { count: nextCount, angry, level, note, nextCount };
}

/**
 * @ 人的分寸。@ 在群里等于"点名"，比拍一拍重，所以更严：
 *   · 私聊不能 @（协议端会让整条消息失败）；
 *   · 一轮最多 @ 一个；
 *   · 同一个人 10 分钟内不重复 @。
 * @returns {{allow:boolean, reason:string}}
 */export function atBudget({ kind = 'group', targetId = '', now = Date.now(), lastAtAt = 0, lastAtToTargetAt = 0, atsThisRun = 0, cfg = {} } = {}) {
  const c = cfg || {};
  if (kind !== 'group') return { allow: false, reason: '私聊没有 @ 这回事，直接说话就行' };
  if (!targetId) return { allow: false, reason: '不知道 @ 谁' };
  if (atsThisRun >= Math.max(1, Number(c.maxAtPerRun ?? 1))) return { allow: false, reason: '这一轮已经 @ 过人了' };
  const targetCooldown = Math.max(0, Number(c.atTargetCooldownMs ?? 10 * 60 * 1000));
  if (lastAtToTargetAt && now - lastAtToTargetAt < targetCooldown) {
    return { allow: false, reason: '刚 @ 过这个人，别连着点名' };
  }
  if (lastAtAt && now - lastAtAt < 5000) return { allow: false, reason: '同一轮里连着 @ 会刷屏' };
  return { allow: true, reason: '可以' };
}

function randDelay(min, max) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

/**
 * 把"名字"解析成 QQ 号。
 *
 * 模型经常只有昵称（聊天记录里看到的是「小明(QQ:123)」，它未必照抄）。
 * 匹配顺序：精确 QQ > 精确昵称/群名片 > 昵称包含 > 唯一的前缀匹配。
 * **重名一律不猜**（返回空）—— 认错人比不 @ 更糟。
 *
 * @param {string} query 名字或 QQ 号
 * @param {Array<{id:string|number, name?:string}>} members 候选成员
 * @returns {{id:string, name:string}|null}
 */
export function matchMember(query, members = []) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const list = (Array.isArray(members) ? members : [])
    .map((m) => ({ id: String(m?.id ?? m?.userId ?? '').trim(), name: String(m?.name ?? m?.card ?? m?.nickname ?? '').trim() }))
    .filter((m) => m.id);
  if (!list.length) return null;

  // 纯数字：先当 QQ 号精确匹配（真实号码 5~11 位，但这里不设长度门槛 ——
  // 只要是成员表里存在的号就算命中；不存在的号后面也不会被名字误伤）
  if (/^\d+$/.test(q)) {
    const byId = list.find((m) => m.id === q);
    if (byId) return byId;
  }
  const exact = list.filter((m) => m.name && m.name === q);
  if (exact.length === 1) return exact[0];

  const lower = q.toLowerCase();
  const ci = list.filter((m) => m.name && m.name.toLowerCase() === lower);
  if (ci.length === 1) return ci[0];

  const partial = list.filter((m) => m.name && (m.name.includes(q) || q.includes(m.name)));
  if (partial.length === 1) return partial[0];
  return null;   // 0 个或多个：都不猜
}

/** 给模型看的一行"这些人是谁"，用于在拿不到号码时提示它。 */
export function describeMembers(members = [], { limit = 8 } = {}) {
  return (Array.isArray(members) ? members : [])
    .slice(0, limit)
    .map((m) => `${String(m?.name ?? m?.card ?? m?.nickname ?? '')}(${String(m?.id ?? m?.userId ?? '')})`)
    .filter((s) => !s.startsWith('('))
    .join('、');
}
