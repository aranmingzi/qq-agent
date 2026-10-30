// 触发档位 ↔ 上下文预算（学自 Estrella「拟人对话逻辑」的 tier.js）。
//
// ── 解决什么 ──────────────────────────────────────────────────────────────
// 现在「为什么回它」和「带多少历史」是两件互不相干的事：
//   · 要不要回 —— reply-gate.decideWake() 按私聊 → @/叫名 → 引用 → 关键词 → 概率判；
//   · 带多少   —— prompt.buildPastState() 用 store.pastStateLimit / pastStateMaxChars 两个**全局常量**。
// 于是"随机插话"这种最轻的接话，和"被 @"一样带着满额历史，单次成本白白高一截。
//
// 改造后：**档位由 decideWake() 自己产出**（decision.tier），上下文按档位收窄。
//
// ⚠️ 档位不由 reason 反推：reason 是给人看的文案（「命中关键词「早」」），
//    日志/面板都在读它。拿文案当判定键，改一个字就静默错档，且没有断言会响。
//    所以档位在产出它的那一行就给出来，映射表只有 TIER_OF_KIND 一份。
//
// ⚠️ 零依赖叶子：本文件不许 import 任何模块，谁都能读而不被拖进 IO。

/** kind → 档位（全项目唯一一份映射）。 */
export const TIER_OF_KIND = {
  private: 'direct',
  named: 'direct',
  // 同一人接着刚才的话说：属于"直接对话"，带满历史。
  continuation: 'direct',
  keyword: 'keyword',
  interject: 'interject'
};

/**
 * 每档的**收窄比例**（相对全局上限）。
 *
 * · direct 留空 = 完全继承全局配置，一个字都不改。
 *   理由：被 @ / 私聊是最高频也最要紧的一条路，它的提示词必须逐字不变 ——
 *   否则「它说话怎么变味了」没有任何断言能发现。
 * · keyword 只收背景（历史条数不动，字数收到 0.75）：命中关键词是"被叫到"，
 *   对话连续性该保；要省的是"没参与的群聊背景"那一大段。
 * · interject 收得最狠（条数 0.55、字数 0.55）：随机插话是唯一"没人叫它"的路径，
 *   代价与风险都最低，省在这里最划算。
 *
 * ⚠️ 这些是**收窄系数**，不是绝对值 —— 见 contextLimitsOf。
 */
const TIER_SHRINK = {
  direct: {},
  keyword: { maxCharsRatio: 0.75 },
  interject: { limitRatio: 0.55, maxCharsRatio: 0.55 }
};

/**
 * 算出这一档**实际**能用多少上下文。
 *
 * ⚠️ 只能压紧、不能放宽：用户把 pastStateLimit 从 24 调到 8（从简），
 *    插话档不能反过来"放宽"到 13 —— 那就成了"我调小了它却带得更多"。
 *    实现上就是 min()：比例收窄后与全局值取小。
 *
 * @param {string} tier 档位（未知档按 direct 处理 —— 宁可多带也不许丢防线）
 * @param {{limit:number, maxChars:number}} base 全局配置里的那两份数字
 */
export function contextLimitsOf(tier, base = {}) {
  const cap = TIER_SHRINK[tier] || TIER_SHRINK.direct;
  const limit = Math.max(1, Number(base.limit) || 0);
  const maxChars = Math.max(200, Number(base.maxChars) || 0);
  const byLimit = cap.limitRatio ? Math.max(1, Math.round(limit * cap.limitRatio)) : limit;
  const byChars = cap.maxCharsRatio ? Math.max(200, Math.round(maxChars * cap.maxCharsRatio)) : maxChars;
  return {
    limit: Math.min(limit, byLimit),
    maxChars: Math.min(maxChars, byChars)
  };
}

/** 判定结果的档位；拒绝回 null。未知 kind 回 undefined，好让契约测试当场暴露。 */
export function tierOfKind(kind) {
  return Object.prototype.hasOwnProperty.call(TIER_OF_KIND, kind) ? TIER_OF_KIND[kind] : undefined;
}
