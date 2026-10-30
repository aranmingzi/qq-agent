// 概率式召回 + 联想链 —— 从「记得住」到「想得起」（2026-10-27，学自 dsh-rofm 的召回那一半）
//
// ── 原来的问题 ────────────────────────────────────────────────────────
// `memory-facts.js::rankFactRecords` 是**确定性** top-N：同一个说话者、同一批事实、
// 同一个 query，算出来的注入集合逐轮一字不差。这不是"记得牢"，这是**复读**。
//
// 而且它是一个会自我加强的坑 —— 与表情包那次完全同构：当时按使用次数做全序排序，
// 头几张自锁成"招牌图"，后来改成加权随机才解开。记忆一样：
//   高分项每轮都出现 → 更容易被再次提及 +0.3 → 下一轮分更高 → 低分项永远排不上。
// 真人不是这样想起一个人的 —— 你今天想起他养猫，明天想起他不吃香菜，跟聊什么有关，但也看运气。
//
// ── 借鉴了 dsh-rofm 的什么 ────────────────────────────────────────────
// 它的设计是：归档出来的记忆带 α（重要）与关键词，每轮用当前输入抽词 → 命中关键词的
// 记忆按 `α × p(n)` 掷骰决定是否真的想起，想起来一条还会顺着共享关键词**带出**第二条。
// 那条带 erf 的衰减曲线是本次唯一照搬的数学部分：
//     p(1) = 1，p(n) = (1 - erf((n-μ)/(σ√2))) / (1 - erf((1-μ)/(σ√2)))
//   实测（用本文件的 recallProbability 算）：1 / .926 / .823 / .694 / .550 / .407 / .278 / .175 / .100 / .053
//   —— **第 5 代减半、第 8 代基本听不见**。这正是"联想会散开但不会失控"的手感。
//
// ── 刻意没抄的三件事（都是它的宿主决定的，不是我们的）────────────────
// ① **它的 α 是新字段**。我们不新加。理由本项目刚吃过一次亏：`kind` 加好了元数据位，
//    但提示词没要求、 parse 层没给默认值 → 真机 102 条里 rule/negative 是 0，三条保护逻辑
//    一次都没触发过。`weight`（初次写入 + 重复提及 +0.3，上限 2.0）与 `kind=rule/negative`
//    本来就是模型写入记忆时表过的态，它们合起来就是 α。再加一个字段等于让模型就同一件事
//    第三次表态。
// ② **它把"想不起来"做成真的想不起来**（一次可能一条都不召回）。这对工具型 agent 成立
//    （忘掉一段旧代码无伤大雅），对社交场景不成立：忘了"他对花生过敏"是事故，不是拟人。
//    → 雷点/规矩（rule/negative）与被强化过的事实**必入，不掷骰**（沿用原有"核心项保 60% 名额"）。
// ③ **它的 p(n) 直接乘出来做 Bernoulli 掷骰**。我们把它留给**联想**那一路（那里本来就是
//    "可能想到也可能没想到"），而主名额用**加权无放回抽样**（Efraimidis–Spirakis）：
//    名额一定填满，高分项大概率入选但不是必然，冷门项永远有机会。
//    纯 Bernoulli 的问题是方差太大 —— 连续几轮一条都想不起来，看起来像坏了。
//
// ── 一个必须预先处理的坑：昵称前缀 ────────────────────────────────────
// 事实文本一律以昵称开头（防串人纪律："萌界一把刀是学生""萌界一把刀爱看B站"），
// 于是**同一个人的所有事实天然共享一大把二元组**。直接做联想的话，任意两条都相邻，
// 联想退化成一个完全图 —— 那不是联想，那是把剩下的全部塞进来。
// 所以 `buildTokenIndex` 会先算**文档频率**，把出现在 ≥ maxDocRatio 比例记录里的 token
// 全部判为"无区分力"剔除（昵称就在这里被筛掉），单字词也一律剔除（"的/了/是"会串起所有人）。
import { tokenize } from './recall.js';

/** α 的权重基准：与 `memory-facts.js` 的 MAX_WEIGHT 必须一致（有测试钉住两个常量）。 */
export const ALPHA_MAX_WEIGHT = 2;

/** p(n) 的形状参数（μ=5 σ=3 是 ROFM 的出厂值，实测手感：第 5 代减半、第 8 代基本停）。 */
/**
 * 文档频率阈值：一个关键词出现在**这么多比例**的记录以上就判为无区分力（默认 0.8）。
 * 见文件头"昵称陷阱"那节 —— 0.5 会把真正的联想之桥一起砍掉。
 */
export const DEFAULT_MAX_DOC_RATIO = 0.8;

export const DEFAULT_MU = 5;
export const DEFAULT_SIGMA = 3;

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * 误差函数。没有第三方依赖，也没有内置实现，所以自己算。
 * 用泰勒展开（Abramowitz & Stegun 7.1.26 的展开形式），|x|≥4 时直接饱和到 ±1
 * —— 那里 1-erf(4) ≈ 1.5e-8，继续算下去没有任何意义。
 */
export function erf(x) {
  const value = Number(x);
  // NaN 既不是 >0 也不是 <0。这里必须显式判掉 —— 否则 `value > 0 ? 1 : -1` 会把它送成 -1，
  // 然后整个 p(n) 变成负数，联想到那个方向也跟着静默坏掉。
  if (Number.isNaN(value)) return 0;
  if (!Number.isFinite(value)) return value > 0 ? 1 : -1;
  if (value === 0) return 0;
  const abs = Math.abs(value);
  if (abs >= 4) return value > 0 ? 1 : -1;
  const squared = abs * abs;
  let term = abs;
  let sum = abs;
  for (let n = 1; n < 200; n += 1) {
    term *= (-squared * (2 * n - 1)) / (n * (2 * n + 1));
    sum += term;
    if (Math.abs(term) < 1e-17) break;
  }
  return (value > 0 ? 1 : -1) * (2 / Math.sqrt(Math.PI)) * sum;
}

/**
 * 第 n 代联想还能想起来的概率（相对第 1 代归一化到 1）。
 * n ≤ 1 恒为 1 —— 种子本来就是想起来的，不需要再掷一次骰。
 */
export function recallProbability(n, mu = DEFAULT_MU, sigma = DEFAULT_SIGMA) {
  const generation = Number(n);
  if (!Number.isFinite(generation)) return 0;
  if (generation <= 1) return 1;
  const mean = Number(mu);
  const scale = Number(sigma);
  if (!Number.isFinite(mean) || !Number.isFinite(scale) || scale <= 0) return 0;
  const denominator = 1 - erf((1 - mean) / (scale * Math.SQRT2));
  if (!(denominator > 0) || !Number.isFinite(denominator)) return 0;
  const numerator = 1 - erf((generation - mean) / (scale * Math.SQRT2));
  return clamp01(numerator / denominator);
}

/**
 * α —— 想起这件事的倾向。**不新开字段**，从已有的 weight / kind 推。
 *
 *   rule / negative（雷点、规矩）→ 1.0：它们压根不该参与遗忘
 *   relation                      → 0.9
 *   普通 fact                     → 0.35 ~ 1.0，由 weight 线性映射
 *     weight 由 1.0 起步（新建），被提及一次 +0.3；衰减后会掉到 1.0 以下。
 *     给它 0.35 的下限而不是 0：一条没被强化的事实仍然应该偶尔浮上来一次，
 *     否则一条从没被强化过的事实连一次露脸的机会都没有 —— 它就再也不会被提到，
*     也就再也不会被强化，等于判了死刑。
 */
export function alphaOf(record, opts = {}) {
  const kind = String(record?.kind || 'fact');
  if (kind === 'rule' || kind === 'negative') return 1;
  if (kind === 'relation') return 0.9;
  const maxWeight = Number(opts?.maxWeight) || ALPHA_MAX_WEIGHT;
  // ⚠️ 不能写 `Number(f.weight) || 1` —— 0 是合法且**有含义**的值（已被衰减到底），
  //    falsy 会把它们一股脑抬回 1.0，于是"快忘了的"和"刚记住的"同权重。
  //    （这个 bug 是被测试④逼出来的：weight=0 期望 α=0.35，实际算出 0.675。）
  const raw = Number(record?.weight);
  const w = Number.isFinite(raw) ? Math.max(0, raw) : 1;
  return Math.max(0.35, Math.min(1, 0.35 + (Math.min(w, maxWeight) / maxWeight) * 0.65));
}

function idOf(record, i) {
  return String(record?.id ?? record?.text ?? `r${i}`);
}

/**
 * 关键词索引 —— 联想靠它找到"和这条有共同点"的其它记录。
 *
 * 两道过滤网（少了任何一道联想都是坏的）：
 *   ① **单字剔除**：中文事实里"的/了/是/我"这类单字会把几乎所有记录串在一起。
 *   ② **高频 token 剔除**：出现在 ≥ maxDocRatio（默认 **0.8**）比例的记录里的 token
 *      没有区分力 —— 事实一律以昵称开头（"萌界一把刀…" × 33 条），
 *      昵称的二元组会出现在 100% 的记录里，不剔除的话联想图是一个完全图。
 *
 * ⚠️ 这个阈值**不能低**。一开始设 0.5，结果把真正的桥也砍了：同一个模块下的四条事实
 *    （"用 qoder 编程""等 qoder 不忙再问"…）里 qoder 占 3/4，判成"无区分力"直接剔除，
 *    联想一次都没发生过。语义上反而是：**出现在好几条里的词就是联想最该走的桥**，
 *    只有"几乎每条都有"的（昵称、人称代词）才是噪声。所以定在 0.8。
 *
 * @returns {{tokens: Map<string, Set<string>>, dropped: Set<string>}}
 *   tokens: 记录 id → 可用于联想的 token 集合；dropped: 被判为无区分力而丢弃的 token
 */
export function buildTokenIndex(records, { maxDocRatio = DEFAULT_MAX_DOC_RATIO } = {}) {
  const list = Array.isArray(records) ? records : [];
  const per = new Map();
  const docFreq = new Map();
  list.forEach((r, i) => {
    const id = idOf(r, i);
    const toks = new Set();
    for (const t of tokenize(r?.text || '')) {
      if (String(t).length < 2) continue;   // ①
      toks.add(t);
    }
    per.set(id, toks);
    for (const t of toks) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  });
  const n = Math.max(1, list.length);
  const cutoff = Math.max(2, Math.ceil(n * Math.max(0, Math.min(1, Number(maxDocRatio) || 0.5))));
  const dropped = new Set();
  for (const [t, c] of docFreq) if (c >= cutoff) dropped.add(t);   // ②
  const tokens = new Map();
  for (const [id, toks] of per) tokens.set(id, new Set([...toks].filter((t) => !dropped.has(t))));
  return { tokens, dropped };
}

/**
 * 由当前已想起的记录往外联想一层：**共享了至少一个有区分力的关键词**的记录。
 * 按共享数降序（共同点越多越可能是真的被带出来的），排除已在手里的。
 */
export function neighborsOf(seedIds, candidateIds, index, { minShared = 1 } = {}) {
  const tokens = index?.tokens instanceof Map ? index.tokens : new Map();
  const owned = new Set(seedIds);
  const scored = [];
  for (const id of candidateIds) {
    if (owned.has(id)) continue;
    const mine = tokens.get(id);
    if (!mine || !mine.size) continue;
    let shared = 0;
    for (const sid of seedIds) {
      const other = tokens.get(sid);
      if (!other) continue;
      for (const t of mine) if (other.has(t)) shared += 1;
    }
    if (shared >= Math.max(1, Number(minShared) || 1)) scored.push({ id, shared });
  }
  scored.sort((a, b) => b.shared - a.shared);
  return scored;
}

/**
 * 加权**无放回**抽样（Efraimidis–Spirakis 1972）：key = u^(1/w)，取 key 最大的 k 个。
 *
 * 为什么不用"每条独立掷骰"（Bernoulli）：那样名额可能空着，也可能爆掉，
 * 连续几轮想起 0~1 条的时候，日志看着跟模块坏了没区别。
 * E-S 的三个好处正好是我们要的：名额**恰好**填满、选中概率**严格正比于**权重、
 * 权重接近时结果就是随机的（这才是"今天想起这件、明天想起那件"）。
 *
 * @param {Array} items
 * @param {number[]} weights 与 items 等长；<=0 视为极小值（几乎不会选中）
 * @param {number} limit
 * @param {() => number} rng **必须可注入** —— 测试要能复现，否则这类代码永远假绿
 * @param {number} temperature >1 更随机（压缩权重差异），<1 更偏向高分
 */
export function weightedSample(items, { weights, limit, rng = Math.random, temperature = 1 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(0, Number(limit) || 0);
  if (n <= 0 || !list.length) return [];
  const T = Math.max(0.05, Number(temperature) || 1);
  const keyed = list.map((item, i) => {
    const raw = Math.max(0, Number(weights?.[i]) || 0);
    const w = Math.max(1e-6, Math.pow(raw, 1 / T));
    const u = clamp01(Number(rng()) || 0);
    return { item, key: Math.pow(Math.max(1e-12, u), 1 / w) };
  });
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, n).map((x) => x.item);
}
