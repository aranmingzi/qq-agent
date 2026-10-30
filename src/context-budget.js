// 上下文预算：把提示词从"一堆 parts.push"变成**有名字、有上限、有顺序、有记录**的表。
//
// 为什么要有它（学自 Estrella-Bot `context-budget.js`，2026-10-22 架构调研的 P0-1）：
//   以前 system 提示词的每段都是匿名字符串，谁都能往中间插一段，谁也不知道它多长。
//   真实后果有三类，全都**不报错**：
//     ① 某段悄悄涨到几千字，把别段挤掉 —— 模型忽然"不记得要分条发"；
//     ② 新加一段忘了登记顺序 → 拼在错误的位置（或在裁剪时被整段丢掉）；
//     ③ 裁掉了什么没人记得 → 事后查到"它那天怎么不回话"只能靠猜。
//
// 四条纪律（前三条抄自它，第四条是这次补的）：
//   ① **段名是稳定枚举**，顺序由 `SECTION_ORDER` 唯一决定，不靠调用方 push 的先后；
//   ② 每段有配额，超了**从尾部截断**（保留段头 = 保留"这段是什么"）；
//   ③ 总量超了按 `EVICTION_ORDER` **整段**淘汰，`NEVER_DROP` 永不砍，砍了必须出现在 `dropped` 里；
//   ④ **未登记的段名要能被看见** —— 它那边就栽过：`brain.js` 建了 extensions 段却没登记，
//      每个扩展包的提示词指引被静默丢掉，表现是"模型有工具却没被告知何时用"。
//      这里把它做成返回值 `unregistered`，由调用方 warn，而不是让它悄悄排在末尾。
//
// 纯函数：不读配置、不碰磁盘、不看时间。所有上限都从入参来（默认值只是出厂建议）。

/**
 * 段名 → 拼装顺序。**唯一决定顺序的地方**。
 *
 * ⚠️ 加段必须在这里登记两处（system / user 各一张），否则 `unregistered` 会点名。
 * 分两张表而不是一张，是因为 system 与 user 的段本来就不同源，
 * 混在一张表里会让"某段为什么排在角色设定前面"变得无法解释。
 *
 * ── 三段式（决定"加在哪"的唯一依据）────────────────────────────────────
 *   ① **静态层**（base → reportBan）：跨轮次逐字节不变，能吃到前缀缓存。
 *      要加新规则、加新段，默认放这一层，越靠前越稳定。
 *   ② **半易变层**（adminRules / extensions）：配置或扩展包变了才变。
 *   ③ **必变层**（本项目暂无；user 侧的 time/past/trigger 承担这个角色）。
 * 纪律：**稳定段必须排在易变段前面**。一旦把每轮都变的内容插进静态层中间，
 * 它后面的所有段每轮都会作废一次缓存 —— 而 system 命中价是输入价的 1/50，
 * 这种"插一段"的代价远比它本身多出来的那几百字大。
 * （分三段的判断标准学自 QQ-BOT-CONTROL 的 SECTION_ORDER：静态 / ambient / volatile。）
 */
export const SYSTEM_ORDER = [
  // 底座（谁、规则、协议）—— 永远在最前，模型读完才知道自己是谁
  'base',
  // 角色设定：默认留在 user（人设是"给这次运行的情绪"，见 prompt.js roleInSystem 注释）；
  // 打开 persona.roleInSystem 后搬到这里，位置紧跟在"你是谁"后面。
  'role',
  'security',
  'tools',
  // 说话分寸（2026-10-24 剃刀：antiAi/contrast/subjectivity/notAQueue/humanRhythm/
  // notModerator/memes 七段并入 humanVoice 一段，system −29%）
  'humanVoice',
  'speakOrNot',
  'quoteAt',
  'identity',
  'quality',
  'memoryRules',
  'stickerRules',
  'voice',
  'scene',
  'reportBan',
  // 承诺落地：答应了"每天/到点提醒"就必须当场建任务（2026-10-25 加的，见 prompt.js）
  'commitment',
  // 外来内容永远压最后（管理员附加规则、扩展包声明）
  'adminRules',
  'extensions'
];

export const USER_ORDER = [
  // 事实层（时间、会话、谁在说话）—— 必须最前，否则模型会把"过去状态"当成今天
  'time',
  'chatId',
  'identityLine',
  'role',
  'state',
  'vibe',
  // 此刻的语气（voice-delivery.js）：紧跟 vibe —— 它就是"心情怎么说出口"，
  // 也是 send_voice 的 emotion 参数依据。被砍掉时语音会退回中性档，不影响正确性。
  'tone',
  'talk',
  // 往事摘要（past-summary.js）：热窗口之外的历史压成的条目。必须紧跟【过去状态】之前 ——
  // 它是"更早的背景"，排在后面会被模型当成"刚刚发生的事"。不超 800 字，装不下时先于 past 被砍
  // （磁盘上有原文，下次还能取回来）。
  'pastSummary',
  // 时段摘要（time-digest.js，m00209）：滑出热窗口的那几段（默认按 15 分钟切片）的大概。
  // 必须排在 pastSummary 之后、past 之前 —— 三者是三个不同的时间深度：
  // 「更早的存量 → 刚才那一小时 → 眼下」。顺序错了模型就把"刚才"读成"很久以前"。
  // 与 pastSummary 同档：磁盘上有原文、能重算，装不下时先于 past 被砍。
  'digest',
  'past',
  'trigger',
  // 【这批没有叫你】—— 贴着触发批的判决（prompt.js::buildNoCallNote，m00001）。
  // 紧跟 trigger：它说的就是"上面那批消息是不是在叫你"，离开 trigger 就没指代对象了。
  'notAddressed',
  // 这批里有几个人在等它（crowd.js）—— 紧跟触发批，说的就是同一件事。
  // 放这里而不是放到"旁路参考"：它对"怎么回"的约束力和【本次唤醒】同级。
  'crowd',
  // 追加素材（异步任务回执、定时提醒）
  'taskContext',
  'pushTask',
  // 旁路参考
  'style',
  'participation',
  // 口头禅：紧跟 style/participation —— 三件事都是"她该怎么说"，量完语感量重复。
  'phraseGuard',
  'memory',
  // 群级记忆（group-facts.js）：这个群是什么地方、有什么规矩、他们的梗。
  // 紧跟【记忆】—— 两段都在说"这里是什么语境"，一个按会话、一个按群本身。
  'groupFacts',
  'facts',
  // 关系记忆（facts 里的 kind='relation'）：跨群、长期、覆盖式更新。
  // 排在 facts 之后：先"他是谁"，再"我们之间怎样"。
  'relation',
  'diary',
  'stickers',
  // 本轮边界与语感（2026-10-22 生态调研：动作集 / 表达 / 条件扩展段）
  'actionPlan',
  // 按需工具（tool-scene.js）：哪些工具包没挂出来、要用就 load_tools。
  // 紧跟 actionPlan —— 两者都是"这轮能做什么"，说到一起。
  // ⚠️ 不是 NEVER_DROP，但也不能进 SAVING_DROP：丢了它模型会以为自己不会唱歌/不能看链接。
  'toolPacks',
  'expressions',
  'conditionalSections',
  // 收尾指令
  'guide',
  'files'
];

/**
 * 每段的最大字符数。超了截断（不是丢弃）—— 一段被砍一半，比整段消失更容易发现。
 *
 * 数字来源：先按现有配置的实测长度留 1.5~2 倍余量，再按"这段能不能被砍"排。
 * 这些是**经验值**，不是官方阈值；改小之前先看 `dropped` 里有没有东西。
 */
export const SYSTEM_BUDGET = {
  base: 800,
  // 只在 persona.roleInSystem=true 时出现（角色设定从 user 搬过来）。
  // 必须显式登记：quotaOf 找不到时兜底 4000，人设稍长就会被**静默截断**。
  role: 6000,
  security: 2000,
  tools: 6000,
  humanVoice: 2000,
  speakOrNot: 1400,
  quoteAt: 700,
  identity: 1400,
  quality: 1100,
  memoryRules: 900,
  stickerRules: 2600,
  voice: 1500,
  scene: 4500,
  reportBan: 1300,
  commitment: 900,
  adminRules: 4000,
  extensions: 2000
};

export const USER_BUDGET = {
  time: 120,
  chatId: 200,
  identityLine: 400,
  role: 8000,
  state: 800,
  vibe: 900,
  talk: 600,
  // ⚠️ `past` / `pastSummary` / `digest` **刻意不在这里登记**：它们的上限在生产侧
  //    （store.pastState*MaxChars / pastSummary.maxChars / digest.maxChars），由 prompt.js 派生后覆盖进来。
  //    在这里再写一份 = 同一个字数两个真相源 —— 实测 1000 份会话里有 18 份的往事摘要
  //    因为"段配额 800 没算上引导语"被静默截掉尾巴（见 docs 2026-10-27 精简记录）。
  trigger: 6000,
  // 【这批没有叫你】（m00001）：几百字，砍了也不会回错话，但它是幻觉的直接解药 ——
  // 不进 NEVER_DROP（省 token 优先），但也不该排在最前面被砍。
  notAddressed: 700,
  crowd: 900,
  taskContext: 3000,
  pushTask: 1500,
  style: 800,
  participation: 400,
  phraseGuard: 500,
  memory: 3000,
  groupFacts: 700,
  facts: 2000,
  relation: 300,
  diary: 1200,
  stickers: 2000,
  actionPlan: 600,
  toolPacks: 400,
  expressions: 200,
  conditionalSections: 1200,
  guide: 1200,
  files: 1500
};

/**
 * 永不淘汰的段：人格、安全规则、工具协议、必回铁律、QQ 场景规则，
 * 以及 user 侧的"何时/在哪/谁在说/唤醒了什么/怎么收尾"。
 *
 * 判据不是"重要"，而是**缺了它回复就是错的**：
 *   · 缺安全规则 → 会越权；缺必回铁律 → 该回的不回；
 *   · 缺 time → 把旧消息当今天；缺 trigger → 不知道要回什么；
 *   · 缺 guide → 直接不调发送工具（实测过：整轮产出为空文本）。
 */
export const NEVER_DROP = new Set([
  'base', 'security', 'tools', 'speakOrNot', 'scene', 'role',
  'time', 'chatId', 'trigger', 'guide', 'state', 'identityLine'
]);

/**
 * 总量仍超时的淘汰顺序。**人格永远最后才被砍**（甚至不砍），
 * 因为"它忽然变了个人"比"它忘了昨天的梗"更难被用户解释。
 */
export const EVICTION_ORDER = [
  // 再砍旁路参考（都能重算，下次还在）
  'style', 'diary', 'stickers', 'participation',
  // 往事摘要先于 recent 丢：它已经压过一轮且磁盘有原文，近期原文才是"接话"的依据
  // 时段摘要同理，且更safe —— 它的片键永久有效、磁盘上有原文，下次一轮就能重算。
  'pastSummary', 'digest',
  // 再砍历史与记忆（本次少一点，下次还能取回来的）
  // groupFacts / relation 先于 facts：他本人的属性比"这个群的脾气"更不可替代
  'past', 'memory', 'groupFacts', 'relation', 'facts', 'talk', 'tone', 'vibe',
  // 再砍一次性回执
  'taskContext', 'pushTask',
  // 再砍协议细则（humanVoice 在此：砍了只是"话少一点味道"，不影响正确性）
  'humanVoice', 'quoteAt', 'quality', 'memoryRules', 'stickerRules', 'identity', 'voice',
  // 多人并发的做法提示：砍了它就退回"一人一条"，但比砍掉人格划算，所以排在协议细则之后
  // 【这批没有叫你】先于 crowd 砍：crowd 是"怎么同时应付几拨人"的做法，这条只是背景说明。
  'notAddressed',
  'crowd',
  // 外来内容（顺序明确写在标题里，砍掉时提示词本身已说明优先级）
  'extensions', 'adminRules'
];

/** 段名 → 是否允许被淘汰（`NEVER_DROP` 里的一律 false）。 */
export function isDroppable(name) {
  return !NEVER_DROP.has(String(name || ''));
}

/** 按段名取配额（未登记的给一个保守默认值，不当作无限）。 */
function quotaOf(name, budget, fallback) {
  const v = budget && Object.prototype.hasOwnProperty.call(budget, name) ? Number(budget[name]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 截断：保留段头（"这段是什么"比"这段后面几行"更重要）。
 * 明确加省略标记，免得模型以为那句话本来就是断的。
 */
export function clipSection(text, max) {
  const s = String(text ?? '');
  const cap = Math.max(0, Number(max) || 0);
  if (!cap || s.length <= cap) return { text: s, clipped: 0 };
  const keep = Math.max(0, cap - 1);
  return { text: `${s.slice(0, keep)}…`, clipped: s.length - keep };
}

/**
 * 主入口：把命名分段装配成最终文本。
 *
 * @param {Array<{name:string, text:string}>} sections  分段（顺序无所谓，由 ORDER 决定）
 * @param {object} [opts]
 * @param {string[]} [opts.order]        段顺序表（SYSTEM_ORDER / USER_ORDER）
 * @param {object}  [opts.budget]        段配额
 * @param {number}  [opts.totalMax]      总量上限（字符）
 * @param {string[]} [opts.eviction]     淘汰顺序
 * @returns {{text:string, chars:number, over:boolean, sections:Array, dropped:Array, clipped:Array, unregistered:string[]}}
 */
export function applyBudget(sections, opts = {}) {
  // ⚠️ `order` / `budget` **必须由调用方显式给**：这里是 system 与 user 两张不同的表，
  //    给默认值意味着 user 侧忘传时会静默套用 system 的（顺序错、配额错，且不报错）。
  //    不传就当空表：段会被 `unregistered` 点名、配额走 4000 兜底 —— 宁可吵，不可静默。
  const {
    order = [],
    budget = {},
    totalMax = 24000,
    eviction = EVICTION_ORDER
  } = opts;

  const rank = new Map((Array.isArray(order) ? order : []).map((n, i) => [n, i]));
  const unregistered = [];
  const live = [];

  for (const raw of Array.isArray(sections) ? sections : []) {
    const name = String(raw?.name || '').trim();
    const text = String(raw?.text ?? '').trim();
    if (!text) continue;                       // 空段不占位、不参与任何比例
    if (!name) { unregistered.push('(无名段)'); continue; }
    if (!rank.has(name)) unregistered.push(name);
    live.push({ name, text });
  }

  // ① 顺序：登记过的按 ORDER，未登记的稳定排在最后（可见，但不冒充正规段）
  const inf = Number.MAX_SAFE_INTEGER;
  live.sort((a, b) => (rank.has(a.name) ? rank.get(a.name) : inf) - (rank.has(b.name) ? rank.get(b.name) : inf));

  // ② 段内配额
  const clipped = [];
  for (const seg of live) {
    const cap = quotaOf(seg.name, budget, 4000);
    const r = clipSection(seg.text, cap);
    if (r.clipped > 0) clipped.push({ name: seg.name, clipped: r.clipped, kept: r.text.length });
    seg.text = r.text;
  }

  // ③ 总量：按 EVICTION_ORDER 整段淘汰（同序多段时从后往前砍，保住靠前的那份上下文）
  const dropped = [];
  const total = () => live.reduce((sum, s) => sum + s.text.length + 2, 0);
  // 不夹下限：配了 300 就是 300。夹一个"最小值"会让"我明明调小了"变成静默失效 ——
  // 正是这个文件要防的那类故障（判据被兜底改掉，且查不到）。
  const n = Number(totalMax);
  const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 24000;
  let guard = 0;
  while (total() > cap && guard < 200) {
    guard += 1;
    let victim = -1;
    for (const name of eviction) {
      if (!isDroppable(name)) continue;
      for (let i = live.length - 1; i >= 0; i -= 1) {
        if (live[i].name !== name) continue;
        victim = i;
        break;
      }
      if (victim >= 0) break;
    }
    if (victim < 0) break;                     // 只剩 NEVER_DROP，砍不动了
    dropped.push({ name: live[victim].name, chars: live[victim].text.length, reason: 'overflow' });
    live.splice(victim, 1);
  }

  const text = live.map((s) => s.text).join('\n\n');
  return {
    text,
    chars: text.length,
    over: targetOver(text.length, cap, live),
    sections: live.map((s) => ({ name: s.name, chars: s.text.length })),
    dropped,
    clipped,
    unregistered
  };
}

/**
 * `over` 只表示"砍到只剩不可砍的段还超"——这才是需要人介入的状态。
 * 别把它写成 `chars > totalMax`：那不区分"砍得动但没砍"和"真的砍不动"。
 */
function targetOver(chars, cap, live) {
  if (chars <= cap) return false;
  return live.every((s) => !isDroppable(s.name));
}

/**
 * 按段裁剪一段已经拼好的提示词（用于"上下文超长"的收缩重试）。
 *
 * ── 为什么不是砍消息数组 ────────────────────────────────────────────────
 * 本项目每轮是**新开会话**：messages 只有 [system, user] 两条，历史全在 user 的
 * 【过去状态】文本里。所以上游那种 `shrinkHistory(messages)` 在这里无事可做 ——
 * 能砍的只有 userPrompt 里的某一个段。
 *
 * ── 两条纪律（抄自上游的 shrinkHistory）─────────────────────────────────
 *  ① **只砍指定段，别的段一个字不动**：时间/本次唤醒/角色设定砍了等于答非所问，
 *     比"上下文超长"更糟（表面上还成功了，而模型根本没看到它要说的话）。
 *  ② **没砍动就返回原引用/`changed:false`**：调用方靠这个判断"这次降级有没有真的
 *     改变请求"。返回内容相同的新字符串会让判据失效 → 白打一枪，日志里还写着"已收缩"。
 *
 * @param {string} text       完整提示词
 * @param {string} sectionName 段名（不含【】，如 '过去状态'）
 * @param {number} keepRatio  保留比例（对段内正文，从**最新**那头留）
 * @returns {{ text:string, changed:boolean, before:number, after:number }}
 */
export function trimPromptSection(text, sectionName, keepRatio = 0.4) {
  const src = String(text ?? '');
  const marker = `【${sectionName}】`;
  const start = src.indexOf(marker);
  if (start < 0) return { text: src, changed: false, before: src.length, after: src.length };
  const bodyStart = start + marker.length;
  const nextHead = src.indexOf('\n【', bodyStart);
  const bodyEnd = nextHead < 0 ? src.length : nextHead;
  const body = src.slice(bodyStart, bodyEnd);
  if (body.length < 200) return { text: src, changed: false, before: src.length, after: src.length };

  const ratio = Math.min(0.9, Math.max(0.1, Number(keepRatio) || 0.4));
  const keep = Math.max(200, Math.floor(body.length * ratio));
  if (keep >= body.length - 80) return { text: src, changed: false, before: src.length, after: src.length };

  const tail = body.slice(-keep);
  const nl = tail.indexOf('\n');
  const clean = nl >= 0 ? tail.slice(nl + 1) : tail;   // 从整行开始，别切半条消息
  const out = `${src.slice(0, bodyStart)}\n（更早的群聊记录已省略）\n${clean}${src.slice(bodyEnd)}`;
  return { text: out, changed: true, before: src.length, after: out.length };
}

/** 给日志/面板用的一句话；没有异常时返回空串（不要天天报"一切正常"）。 */
export function describeBudget(result, label = '') {
  if (!result) return '';
  const bits = [];
  if (result.dropped?.length) {
    bits.push(`淘汰 ${result.dropped.map((d) => `${d.name}(${d.chars}字,${d.reason})`).join('、')}`);
  }
  if (result.clipped?.length) {
    bits.push(`截断 ${result.clipped.map((c) => `${c.name}(-${c.clipped}字)`).join('、')}`);
  }
  if (result.unregistered?.length) {
    bits.push(`未登记段 ${result.unregistered.join('、')}（请补进 ORDER，否则顺序不可控）`);
  }
  if (result.over) bits.push('超预算且无可淘汰段（需人工调小某段或提高 totalMax）');
  if (!bits.length) return '';
  return `[预算${label ? '·' + label : ''}] ${result.chars} 字：${bits.join('；')}`;
}
