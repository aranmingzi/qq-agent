// 识人 —— 这一轮到底是谁在跟你说话、谁算主人。**唯一实现**。
//
// ── 为什么要单独成模块（2026-10-25 修「QQ 群里不认识主人」）────────────
// 同一条判断以前被写了三遍，而且三遍的判法还不一样：
//   · prompt.js   buildIdentityLine（告诉模型"谁在说话/是不是主人"）
//                 → 取触发批里**最后一条**非自己消息；
//   · orchestrator speaker（拿他的 QQ 去查长期事实）
//                 → 也是"最后一条"；
//   · orchestrator isMaster（决定挂不挂【主人专属】工具）
//                 → 取的是触发批里**第一条**。
// 群里一次唤醒常常带 10~20 条未读：主人 @ 了它、后面又有人插了两句闲话，
// 于是提示词那边写「他**不是**你的主人」，工具那边却按主人挂载 —— 两边打架。
// 模型只能挑一边信，结果就是当着主人的面回一句「我哪来的主人」。
//
// 所以判断只留一份：**谁是主人**（masterQQOf）、**谁是这一轮的说话人**
// （primarySpeaker）、**主人这批在不在这**（masterPresence）。
//
// ── 两条铁律 ──────────────────────────────────────────────────────────
//   ① **绝不猜号码**。群里重名的人很多，拿昵称去猜 QQ 迟早认错人，
//      而"把陌生人当成主人"的代价不对称（学自「新小鱼识人插件」）。
//   ② **主人这批里说过话就必须单独点名**。只按"最后一条"认人，
//      主人说话之后又有人插一句，他就会被彻底抹掉。

import { getConfig } from './config.js';
import { addresseeOf, TARGET } from './addressee.js';

const QQ_RE = /^\d{5,15}$/;

export function isQq(v) {
  return QQ_RE.test(String(v ?? '').trim());
}

/**
 * 主人 QQ。人设上没写就用全局配置。
 * 没配置 = 空串，**绝不回退到任何写死的号码**
 * （以前这里有 `|| '123456789'`：没设主人时，一个恰好叫 123456789 的人就成了主人）。
 */
export function masterQQOf(persona) {
  const own = String(persona?.masterQQ ?? '').trim();
  if (isQq(own)) return own;
  const cfg = String(getConfig()?.persona?.masterQQ ?? '').trim();
  return isQq(cfg) ? cfg : '';
}

/** 条目自己的 QQ（拿不到就是空串 —— 不拿昵称凑）。 */
function senderIdOf(m) {
  const id = String(m?.senderId ?? '').trim();
  return QQ_RE.test(id) ? id : '';
}

/** 触发批里"别人说的话"（排除机器人自己的发言）。 */
function othersOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.filter((m) => m && !m.self);
}

/**
 * 这一轮的"说话人"。
 *
 * 优先级：
 *   1. 最后一条**在跟它说话**的消息（@我 / @全体 / 叫我的名字 / 引用我）——
 *      群里 12 条未读里，真正叫它的是哪一条，比"谁最后发的"有意义得多；
 *   2. 都只是在闲聊 → 最后一条别人说的话（插话场景，那就是"刚说话的人"）；
 *      但这时候 addressed=false —— 调用方必须能区分"有人叫我"和"我猜是这个人"。
 *      2026-10-31（m00001）：以前这条回退路径不带标记，提示词直接写成
 *      「正在跟你说话的是 QQ x」，于是"没人跟它说话"被写成"有人在跟我说话"。
 *   3. 私聊 → 会话号就是对方 QQ，不依赖任何宿主字段；
 *   4. 拿不到号码 → null（**绝不猜**）。
 *
 * @param entries 触发批（store 条目）
 * @param opts { kind, chatId, aliases, selfIds, selfNickname }
 * @returns {{id: string, name: string, addressed: boolean}|null}
 *          addressed=true 表示这条消息确实是在叫它；false 表示只是"最后说话的人"
 */
export function primarySpeaker(entries, opts = {}) {
  const { kind, chatId } = opts || {};
  const list = othersOf(entries);

  if (kind === 'private') {
    const id = isQq(chatId) ? String(chatId).trim() : '';
    if (!id) return null;
    const last = list[list.length - 1];
    return { id, name: String(last?.senderName || '').trim(), addressed: true };
  }

  const addrOpts = {
    aliases: Array.isArray(opts.aliases) ? opts.aliases : [],
    selfIds: (Array.isArray(opts.selfIds) ? opts.selfIds : [opts.selfIds])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
    selfNickname: opts.selfNickname || ''
  };

  let addressed = null;
  let last = null;
  for (const m of list) {
    const id = senderIdOf(m);
    if (!id) continue;               // 认不出人：跳过，但别因此中断（后面可能有带号码的）
    last = { id, name: String(m.senderName || '').trim() };
    let addr = null;
    try { addr = addresseeOf(m, addrOpts); } catch { addr = null; }
    if (addr && (addr.target === TARGET.SELF || addr.target === TARGET.ALL)) {
      addressed = last;
    }
  }
  if (addressed) return { ...addressed, addressed: true };
  if (last) return { ...last, addressed: false };
  return null;
}

/**
 * 主人这一批里说了哪些话（按 QQ 精确匹配，不看昵称）。
 *
 * @returns {{id: string, name: string, entries: Array, mids: string[]}}
 *          主人没在这批里 → 全空（id 为空串）
 */
export function masterPresence(entries, masterQQ) {
  const empty = { id: '', name: '', entries: [], mids: [] };
  const master = String(masterQQ ?? '').trim();
  if (!QQ_RE.test(master)) return empty;
  const hits = othersOf(entries).filter((m) => senderIdOf(m) === master);
  if (!hits.length) return empty;
  const mids = hits
    .map((m) => (m.mid === null || m.mid === undefined ? '' : String(m.mid)))
    .filter(Boolean);
  return {
    id: master,
    name: String(hits[hits.length - 1].senderName || '').trim(),
    entries: hits,
    mids
  };
}

/**
 * 这一批算不算"主人在场"（主人专属工具的挂载条件）。
 *
 * 群里判**批内出现过**，不判"第一条/最后一条是谁"：
 * 主人说了一句话之后又有人插嘴，不能因此把主人的能力收回去。
 * 真正拦住"群友索要主人操作"的是提示词里的拒绝规则，不是这个开关。
 */
export function batchHasMaster(entries, { kind, chatId, persona } = {}) {
  const master = masterQQOf(persona);
  if (!master) return false;
  if (kind === 'private') return String(chatId ?? '').trim() === master;
  return masterPresence(entries, master).entries.length > 0;
}
