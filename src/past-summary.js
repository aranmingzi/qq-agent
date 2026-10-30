// 往事摘要（P2）：热窗口之外的历史，压成一份**增量更新**的条目式摘要。
//
// ── 它补的是什么洞 ──────────────────────────────────────────────────────
// 本项目每轮新开会话，历史只有【过去状态】那 20~24 条。超出的部分**直接消失**，
// 不会沉淀成任何东西。长期记忆有三层（memory 条目 / facts 按 QQ / diary 按天），
// 但它们分别是"条目""事实""那一天"的粒度 —— **中间那层"对话流"是空的**。
// 于是她记得住"群友的生日"，却记不住"两天前这半个钟头里大家在商量什么"。
//
// ── 三条硬约束（都是踩过的坑，不是洁癖）────────────────────────────────
//   ① **增量**：新摘要 = f(旧摘要, 本次被挤出的消息)。绝不每次从头总结全部历史 ——
//      否则长会话后期每轮都要重算，延迟与成本指数上升。
//   ② **游标**：按消息本地自增 id 记 `uptoId`，只压"没压过的"。id 是同群唯一且递增的。
//   ③ **熔断**：连续失败 failThreshold 次就**停用这个会话**的摘要，退回纯窗口。
//      绝不因为一行摘要把聊天卡住 —— 摘要失败必须是"少一点背景"，不是"她不说话"。
//
// ── 可寻址条目（2026-10-31，学自 ACE 的 "不要重写知识，要管理知识"）──────────────
// 以前每压一次都是「把旧摘要和新增记录合并重写成**一版新的**」。ACE 论文实测这条路
// 有两个必然损伤：brevity bias（追简洁丢细节）和 context collapse（重写摧毁积累）——
// 1.8 万 token 的上下文被"总结压缩"到 122 token 后，性能跌到 57.1%。
// 现在的做法：摘要存为**有序、带稳定 id 的条目列表**，模型只被允许做
// ADD / EDIT / REMOVE 三种针对 id 的编辑，禁止整体重写；每个条目带 `src`
// （哪几条消息压出来的），对应 Zep 的 provenance —— 一条 episode 被删时，
// 只有**没有其他来源支撑**的条目才消失。
//
// 触发时机在编排器侧：运行结束后（与记忆整理同一时机），**不阻塞回复链路**。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

const SUMMARY_DIR = path.join(DATA_DIR, 'summary');

function summaryFile(chatKey) {
  const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
  return path.join(SUMMARY_DIR, `${safe}.json`);
}

export const SUMMARY_DEFAULTS = {
  maxLines: 8,        // 摘要最多几条
  maxChars: 800,      // 摘要总字数（与 context-budget.js 的 pastSummary 配额对齐）
  perSlotMax: 3,      // 单个槽位最多几条（0 = 不限，旧行为）。见 normalizeSlots 的说明
  minPending: 12,     // 攒够多少条"没压过的"才值得压一次
  maxBatch: 60,       // 单次最多压多少条（防止一次塞爆）
  failThreshold: 3,   // 连续失败几次就停用这个会话
  minIntervalMs: 30 * 60 * 1000
};

/**
 * 判断一条要点是不是"话没说完"。
 *
 * 为什么需要：输出被 max_tokens 掐断时，最后一条必然是半句（实测截在
 * `萌界一把刀说“` 这种地方）。半句进提示词比少一条更糟 —— 它看起来像事实，
 * 但没有结论，模型会顺着这半个引号去猜。
 *
 * 两道判据：引号/括号不成对；结尾停在逗号冒号这类"后面还有"的标点上。
 */
export function looksIncomplete(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  const open = (s.match(/[“「（(]/g) || []).length;
  const close = (s.match(/[”」）)]/g) || []).length;
  if (open !== close) return true;
  return /[，,、：:；;（(「“"']$/.test(s);
}

/**
 * 把模型输出收成"条目式纯文本"。
 *
 * 为什么必须归一：模型时不时会包 ``` 代码块、加小标题、或者一句"好的，以下是摘要"。
 * 这些一旦进提示词就是噪声，而且会随缓存前缀变化放大成本。
 */
/**
 * 平铺形态的解析（`slots:false` 与旧格式共用）。
 *
 * ⚠️ 与 `parseSlots` 不能互相替代，关键差别就一条：**存在以 "- " 开头的行时只认这些行**。
 *    降级模型偶尔会输出 `# 往事` 这种小标题，若按 parseSlots"没前缀也当条目"处理，
 *    它就会变成一条 `- 往事` 混进提示词。
 *
 * @returns {string[]} 条目正文（不含 "- " 前缀）
 */
function collectFlat(text) {
  const s = String(text ?? '').replace(/\r/g, '')
    .replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const lines = s.split('\n')
    .map((x) => x.trim())
    .map((x) => x.replace(/^[·•*]\s+/, '- ').replace(/^[-—–]\s*/, '- '))
    .map((x) => x.replace(/^#+\s*/, ''))
    .filter((x) => x && !/^(好的|以下是|下面是|摘要[:：]?)/.test(x));
  const marked = lines.filter((x) => x.startsWith('- '));
  const items = marked.length ? marked : lines;
  return items.map((x) => (x.startsWith('- ') ? x.slice(2) : x).trim()).filter(Boolean);
}

/**
 * 把模型输出收成**平铺条目**的纯文本（`slotMode:false` 的形态）。
 *
 * ⚠️ 2026-10-27 精简：它曾经是**一整套独立的裁剪实现**（解析 → 截断保护 → 条数 → 字数），
 *    与 `normalizeSlots` 并列 —— 两套逻辑一旦只改一处，摘要就会在其中一个开关下悄悄变形。
 *    现在它是 `normalizeSlots(..., { slots:false })` 的薄封装：**裁剪只在那边做一次**。
 */
export function normalizeSummary(text, opts = {}) {
  return normalizeSlots(text, { ...opts, slots: false, perSlotMax: 0 });
}

// ── 槽位化摘要（P4，2026-10-26）───────────────────────────────────────────
//
// 学自 anchored iterative summarization：**结构逼着保留**。
// 槽位是清单，摘要器必须逐项填，于是不会静默漂移。外部量化（Factory Research）：
//   槽位+增量合并 压缩率 98.6% / 质量 3.70；opaque 极限压缩 99.3% / 3.35。
//   多留 0.7% 的 token 换 0.35 质量分 —— 凡"取回来要花成本"的场景都划算。
//
// 原来这里是**一坨无差别的 `- ` 条目**，两个后果：
//   ① 超字数只能从末尾整条 pop —— 最新的和最重要的被一起丢掉；
//   ② 无法按类型分配预算（"答应了什么"该留 3 条，"寒暄背景"该留 1 条，只能混着抢 800 字）。
//
// 四个槽位按"丢了会怎样"排序（不是照抄 coding agent 的 Files Modified，那套对群聊没意义）：
//   谁在要什么（未兑现的请求）→ 答应了什么（承诺）→ 定了什么（结论）→ 发生了什么（事实）。
// 越靠前越不能丢：忘了"谁在等我"是不可挽回的，忘了"聊过什么"有 search_messages 兜底。
//
// ⚠️ **必须能读回旧摘要**：磁盘上存着的还是平铺条目（没有槽位标题）。
//    解析时它们进 `legacy`，渲染时原样排在最前 —— 下一轮增量合并时模型会重新归类。

export const SUMMARY_SLOTS = [
  { key: 'asking', title: '谁在要什么' },
  { key: 'promised', title: '答应了什么' },
  { key: 'decided', title: '定了什么' },
  { key: 'happened', title: '发生了什么' }
];

/** 超预算时的丢弃顺序（从先丢到后丢）。legacy 是旧格式里没归类的条目，最老，先丢。 */
const SLOT_DROP_ORDER = ['legacy', 'happened', 'decided', 'promised', 'asking'];
/** 保留顺序（条数上限时谁优先）—— 与丢弃顺序相反，legacy 排最后。 */
const SLOT_KEEP_ORDER = ['asking', 'promised', 'decided', 'happened', 'legacy'];

/**
 * 判断一行是不是槽位标题。模型可能写成 `【谁在要什么】`、`## 谁在要什么` 或 `谁在要什么：`。
 * @returns {string} 槽位 key；不是标题返回 ''
 */
export function slotKeyOf(line) {
  const s = String(line ?? '').trim()
    .replace(/^#+\s*/, '')
    .replace(/^【/, '').replace(/】\s*$/, '')
    .replace(/[:：]\s*$/, '')
    .trim();
  const hit = SUMMARY_SLOTS.find((x) => x.title === s);
  return hit ? hit.key : '';
}

/**
 * 把摘要文本拆成槽位。解析不出槽位（旧格式 / 降级模型）时全部进 `legacy` ——
 * 不会丢内容，只是没分类。
 */
export function parseSlots(text) {
  const out = { asking: [], promised: [], decided: [], happened: [], legacy: [] };
  const raw = String(text ?? '').replace(/\r/g, '');
  let cur = '';
  for (const rawLine of raw.split('\n')) {
    let line = String(rawLine ?? '').trim();
    if (!line || /^```/.test(line)) continue;
    const key = slotKeyOf(line);
    if (key) { cur = key; continue; }              // 标题行本身不进内容
    line = line.replace(/^[·•*]\s+/, '- ').replace(/^[-—–]\s*/, '- ');
    if (!line.startsWith('- ')) line = `- ${line}`;
    const body = line.slice(2).trim();
    if (!body) continue;
    if (/^(好的|以下是|下面是|摘要[:：]?)$/.test(body)) continue;
    (out[cur] || out.legacy).push(body);
  }
  return out;
}

/**
 * 槽位 → 文本。空槽位整块不写；legacy 原样排在最前（保持旧摘要的形态）。
 *
 * `slots:false` = 平铺：不写槽位标题，按保留顺序（asking→…→legacy）拼成条目。
 */
export function renderSlots(parsed, opts = {}) {
  const p = parsed || {};
  const flat = (arr) => (Array.isArray(arr) ? arr : []).filter(Boolean).map((x) => `- ${x}`);
  if (opts.slots === false) {
    return [...flat(p.legacy), ...SUMMARY_SLOTS.flatMap((s) => flat(p[s.key]))].join('\n');
  }
  const blocks = [];
  const legacy = Array.isArray(p.legacy) ? p.legacy.filter(Boolean) : [];
  if (legacy.length) blocks.push(legacy.map((x) => `- ${x}`).join('\n'));
  for (const s of SUMMARY_SLOTS) {
    const items = (Array.isArray(p[s.key]) ? p[s.key] : []).filter(Boolean);
    if (!items.length) continue;
    blocks.push(`【${s.title}】\n${items.map((x) => `- ${x}`).join('\n')}`);
  }
  return blocks.join('\n');
}

function slotCount(parsed) {
  return Object.keys(parsed || {}).reduce((n, k) => n + (Array.isArray(parsed[k]) ? parsed[k].length : 0), 0);
}

/** 渲染顺序上的最后一条（输出被 max_tokens 掐断时，半句就在这里）。 */
function lastSlotItem(parsed) {
  for (const k of [...SLOT_KEEP_ORDER].reverse()) {
    const arr = parsed?.[k];
    if (Array.isArray(arr) && arr.length) return { key: k, idx: arr.length - 1 };
  }
  return null;
}

/**
 * 把模型输出收成**槽位化**的纯文本。
 *
 * 与 `normalizeSummary` 的关系：那边是平铺条目（旧格式），这边是槽位。
 * 模型没按槽位输出时自动退化成平铺（全部进 legacy），所以**旧模型/降级模型也安全**。
 *
 * @param {string} text
 * @param {{maxLines?:number, maxChars?:number, truncated?:boolean}} opts
 * @returns {string}
 */
export function normalizeSlots(text, opts = {}) {
  const slots = opts.slots !== false;
  const parsed = slots
    ? parseSlots(text)
    : { asking: [], promised: [], decided: [], happened: [], legacy: collectFlat(text) };
  if (!slotCount(parsed)) return '';
  const maxLines = Math.max(1, Number(opts.maxLines) || 8);
  const maxChars = Math.max(120, Number(opts.maxChars) || 800);
  // 每槽限额（默认 3，0 = 不限 = 旧行为）。
  // ⚠️ **这是必须的**：2026-10-26 真机发现 `group_20000001` 的摘要只剩一个槽 ——
  //    「谁在要什么」一个人一条写了 8 条，直接把 maxLines=8 的总配额吃满，
  //    【答应了什么】【定了什么】【发生了什么】一条都不剩。
  //    设计意图是"发生了什么最先丢"，实际变成"第一个槽把别人全挤死"。
  //    而现实中"答应了什么/定了什么"才是跨轮接着干活最需要的。
  const perSlotMax = Math.max(0, Number(opts.perSlotMax) || 0);

  // ① 截断保护（与平铺版同一套双判据）：输出被掐断时最后一条必然是半句
  const last = lastSlotItem(parsed);
  if (last) {
    const body = parsed[last.key][last.idx];
    if (opts.truncated || looksIncomplete(`- ${body}`)) {
      if (slotCount(parsed) > 1) parsed[last.key].pop();
      else parsed[last.key][0] = `${body}…`;        // 只剩一条就留着，但标明没说完
    }
  }

  // ② 每槽限额：先把单个槽裁到 perSlotMax，再做总闸。
  //    顺序不能反 —— 先总闸的话第一个槽已经把名额占完了，再按槽裁只会让总量变得更小。
  if (perSlotMax > 0) {
    for (const k of Object.keys(parsed)) {
      if (Array.isArray(parsed[k]) && parsed[k].length > perSlotMax) {
        parsed[k] = parsed[k].slice(0, perSlotMax);
      }
    }
  }

  // ③ 条数上限：**轮转分配**，不是一个槽从头吃到尾。
  //    每轮每个槽各拿 1 条，取满 maxLines 为止 —— 这样 4 个槽都有机会，
  //    而不是"谁排在前面的标题谁通吃"。
  const flat = [];
  for (const k of SLOT_KEEP_ORDER) {
    (Array.isArray(parsed[k]) ? parsed[k] : []).forEach((item, i) => flat.push({ k, i }));
  }
  if (flat.length > maxLines) {
    const keep = new Set();
    for (let round = 0; keep.size < maxLines; round += 1) {
      let added = false;
      for (const k of SLOT_KEEP_ORDER) {
        if (keep.size >= maxLines) break;
        const arr = Array.isArray(parsed[k]) ? parsed[k] : [];
        if (round < arr.length) { keep.add(`${k}#${round}`); added = true; }
      }
      if (!added) break;
    }
    for (const k of Object.keys(parsed)) {
      if (!Array.isArray(parsed[k])) continue;
      parsed[k] = parsed[k].filter((_, i) => keep.has(`${k}#${i}`));
    }
  }

  // ③ 字数上限：按 **槽位** 丢（先丢"发生了什么"），不是从末尾整条丢。
  //    这是槽位化唯一但最要紧的收益：800 字不够时，留下来的是承诺而不是寒暄。
  let guard = 80;
  while (renderSlots(parsed, { slots }).length > maxChars && guard > 0) {
    guard -= 1;
    let victim = '';
    for (const k of SLOT_DROP_ORDER) {
      if (Array.isArray(parsed[k]) && parsed[k].length) { victim = k; break; }
    }
    if (!victim) break;
    // 只剩最后一条还超：切半句（与平铺版一致）。到这步已无槽位可丢。
    // ⚠️ 渲染时每条前面有 "- " 两个字符、末尾还有 "…"，所以正文只能留 maxChars-3
    //    （实测：留 maxChars-1 会变成长 202 > 200，formatForPrompt 的老断言立刻红）。
    if (slotCount(parsed) <= 1) {
      const k = Object.keys(parsed).find((x) => Array.isArray(parsed[x]) && parsed[x].length);
      const cap = Math.max(1, maxChars - 3);
      const body = String(parsed[k][0] || '');
      parsed[k][0] = `${body.slice(0, cap)}…`;
      break;
    }
    parsed[victim].pop();
  }
  return renderSlots(parsed, { slots });
}

/** 摘要输入里的一行消息。刻意比 prompt.formatEntry 简单：这里不需要 #消息id。 */
export function renderForSummary(m) {
  const hhmm = new Date(Number(m.ts) || Date.now());
  const t = `${String(hhmm.getHours()).padStart(2, '0')}:${String(hhmm.getMinutes()).padStart(2, '0')}`;
  const who = m.self ? '我' : (m.senderName || `QQ${m.senderId || '?'}`);
  const body = String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `[${t}] ${who}：${body || '（非文字消息）'}`;
}

/**
 * 组压缩请求。**结构化要求写死在提示词里** —— 自由文本摘要会写成一段散文，
 * 那段散文进提示词之后既占预算又没法被"按条丢弃"。
 */
export function buildSummaryMessages({ oldSummary = '', lines = [], maxLines = 8, maxChars = 800, perSlotMax = 3 } = {}) {
  const per = Math.max(0, Number(perSlotMax) || 0);
  return [
    {
      role: 'system',
      content: '你是聊天记录的压缩模块。你只做压缩：合并、去重、丢弃过时内容，'
        + '绝不发明、绝不扩写、绝不猜测、绝不点评。'
        + '输出**必须**按【谁在要什么】【答应了什么】【定了什么】【发生了什么】分块，'
        + '块标题原样照抄、不加 Markdown 的 #；每块下面每行一条、以 "- " 开头。'
        + '不要代码块、不要任何解释或开场白。'
    },
    {
      role: 'user',
      content: [
        // ⚠️ 格式要求必须放在**材料之前**：60 行聊天记录之后再讲格式，
        //    模型读到时注意力已经在材料上了 —— 真机实测第一版 7 条全不分块。
        //    另外别写"该块没内容就整块不写"当唯一说明：有些会话本来就没有承诺/决定，
        //    模型会顺势连标题都不写。这里明说"只有一块有内容也要保留那一块的标题"。
        '【输出格式（必须遵守）】',
        '按下面四个小标题分块；块标题原样照抄；每块下面每行一条、以 "- " 开头。',
        '没内容的块整块不写，但**只有某一块有内容时，那一块的标题也要保留**。',
        '　【谁在要什么】还没兑现的请求、没回答的问题（谁在等、在等什么）',
        '　【答应了什么】承诺与约定（谁答应了谁、几点、在哪、要做什么）',
        '　【定了什么】已经得出的结论、共识、决定',
        '　【发生了什么】已经过去的事实（时间、地点、人名、数字）；这块最不重要',
        '例如：',
        '【谁在要什么】',
        '- 张三问周末还聚不聚',
        '【发生了什么】',
        '- 大家聊了会儿天气',
        '',
        '【已有的往事摘要】',
        String(oldSummary || '').trim() || '（无）',
        '',
        '【本次新增的聊天记录】',
        ...lines,
        '',
        '请把上面两部分合并重写成**一版新的往事摘要**，照上面的格式输出。另外：',
        `1. 总共最多 ${maxLines} 条${per > 0 ? `，**每块最多 ${per} 条**` : ''}，总长不超过 ${maxChars} 字；`,
        ...(per > 0 ? [
          `2. 某一块超过 ${per} 条，就把同类的**合并成一条**（例：A、B、C 都在问同一个功能 → 写成一行「A、B、C 都在问 X」），`
          + '不要为了塞满而拆开写；',
        ] : []),
        [`${per > 0 ? '3' : '2'}. 每条尽量写明**是谁**说的（昵称或 QQ 号）。丢了人，这份摘要就会张冠李戴；`,
          `${per > 0 ? '4' : '3'}. 丢弃：寒暄、表情、语气词、重复内容、已经聊完且没有后续的小事；`,
          `${per > 0 ? '5' : '4'}. 越近的越重要；旧条目可以被合并、被新事实覆盖，或直接删掉；`,
          `${per > 0 ? '6' : '5'}. 所有内容只能来自上面的原文。宁可少写，绝不补写。`].join('\n')
      ].join('\n')
    }
  ];
}

/**
 * FNV-1a 内容哈希。与 memory-facts.js 里那份同一算法（那边没导出，
 * 这里复制一份 —— 它只有 6 行，比造一个公共模块更划算）。
 */
function hashOf(text) {
  const s = String(text ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/**
 * 条目 id = 槽位 + 内容哈希。
 *
 * 为什么用**内容寻址**而不是自增号：自增号需要在磁盘上维护计数器，读坏一次
 * 计数器就乱了，而且旧摘要（只有一段文本、没有 id）迁移时无从分配。
 * 内容哈希的好处是 —— 同一句话无论渲染多少次、从哪条路径解析出来，
 * id 都一样；编辑改变了正文，id 自然跟着变，模型拿着旧 id 来改就是无效操作（安全失败）。
 */
export function itemIdOf(slot, text) {
  return `${slot || 'legacy'}:${hashOf(`${slot}|${String(text ?? '').trim()}`)}`;
}

/**
 * 摘要文本 → 有序条目列表 `[{id, slot, text}]`。
 * 旧格式（平铺、无槽位标题）全部落进 `legacy`，与 parseSlots 一致。
 */
export function itemsFromSummary(summary) {
  const parsed = parseSlots(summary);
  const out = [];
  for (const s of SUMMARY_SLOTS) {
    for (const text of (parsed[s.key] || [])) {
      const t = String(text || '').trim();
      if (t) out.push({ id: itemIdOf(s.key, t), slot: s.key, text: t });
    }
  }
  for (const text of (parsed.legacy || [])) {
    const t = String(text || '').trim();
    if (t) out.push({ id: itemIdOf('legacy', t), slot: 'legacy', text: t });
  }
  return out;
}

/**
 * 条目列表 → 摘要文本。渲染顺序与 renderSlots 一致（legacy 最前，然后四槽）。
 * 这是"磁盘上那份 summary 字符串"的唯一真源 —— 它由 items 渲染而来，
 * 所以 formatForPrompt / 预算裁剪那条老路径完全不用改。
 */
export function renderItems(items, { slots = true } = {}) {
  const list = Array.isArray(items) ? items : [];
  const bySlot = { asking: [], promised: [], decided: [], happened: [], legacy: [] };
  for (const it of list) {
    const k = bySlot[it?.slot] ? it.slot : 'legacy';
    const t = String(it?.text || '').trim();
    if (t) bySlot[k].push(t);
  }
  return renderSlots(bySlot, { slots });
}

/**
 * 解析模型的"编辑指令"。
 *
 * 格式刻意做成**一行一条、行首是动词**，而不是 JSON：
 * - 小模型写 JSON 经常缺括号、引号里带换行，解析失败就等于这一轮白烧；
 * - 一行一条错了只丢这一条，不会整批丢。
 *
 * 认这三种（大小写不敏感，中英文动词都认）：
 *   ADD 【谁在要什么】 | 张三在等回复
 *   EDIT  asking:1a2b3c | 张三在等回复（改过措辞）
 *   REMOVE asking:1a2b3c
 */
export function parseEdits(text) {
  const out = [];
  const raw = String(text ?? '').replace(/\r/g, '');
  for (const rawLine of raw.split('\n')) {
    let line = String(rawLine || '').trim();
    if (!line || /^```/.test(line)) continue;
    line = line.replace(/^[-*·•]\s+/, '');
    // 动词后面必须跟空白/冒号/竖线或直接结束 —— 否则 "ADDITION" 会被当成 ADD。
    const m = /^(ADD|EDIT|REMOVE|新增|改|删)(?=[\s:：|]|$)\s*[:：]?\s*(.*)$/i.exec(line);
    if (!m) continue;
    const verbRaw = m[1].toUpperCase();
    const verb = (verbRaw === 'ADD' || verbRaw === '新增') ? 'add'
      : (verbRaw === 'EDIT' || verbRaw === '改') ? 'edit' : 'remove';
    const rest = String(m[2] || '').trim();
    if (!rest) continue;
    const bar = rest.indexOf('|');
    if (verb === 'add') {
      const head = bar >= 0 ? rest.slice(0, bar) : '';
      const body = (bar >= 0 ? rest.slice(bar + 1) : rest).trim();
      if (!body) continue;
      const slot = slotKeyOf(head.replace(/[【】\[\]]/g, '')) || slotKeyOf(head) || 'legacy';
      out.push({ op: 'add', slot, text: body });
      continue;
    }
    const id = (bar >= 0 ? rest.slice(0, bar) : rest).trim().replace(/[【】\[\]`]/g, '');
    if (!id) continue;
    if (verb === 'remove') { out.push({ op: 'remove', id }); continue; }
    const body = (bar >= 0 ? rest.slice(bar + 1) : '').trim();
    if (!body) continue;
    out.push({ op: 'edit', id, text: body });
  }
  return out;
}

/**
 * 把编辑指令应用到条目上。**只做增删改，绝不整体重写** —— 没被点名的条目
 * 一个字都不会动，这是 ACE 那条结论（"一次错误的重写就可能摧毁全部积累"）的直接落实。
 *
 * @returns {{items: Array, added: number, edited: number, removed: number, ignored: number}}
 */
export function applyEdits(items, edits) {
  // 直接维护"活着的条目数组"，不用墓碑集合 ——
  // 曾经的墓碑版本在"先 REMOVE 再 ADD 回同一句"时会留下两份（同一 id 两条），
  // 模型做合并（删几条→补一条汇总）时就会踩到。
  const list = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id && String(it.text || '').trim())
    .map((it) => ({ ...it }));
  const findIdx = (id) => list.findIndex((it) => it.id === id);
  let added = 0;
  let edited = 0;
  let removed = 0;
  let ignored = 0;

  for (const e of (Array.isArray(edits) ? edits : [])) {
    if (!e) continue;
    if (e.op === 'add') {
      const text = String(e.text || '').trim();
      if (!text) { ignored += 1; continue; }
      const slot = SUMMARY_SLOTS.some((s) => s.key === e.slot) ? e.slot : 'legacy';
      const id = itemIdOf(slot, text);
      if (findIdx(id) >= 0) { ignored += 1; continue; }   // 一模一样的不重复加（幂等）
      list.push({ id, slot, text });
      added += 1;
      continue;
    }
    if (!e.id) { ignored += 1; continue; }
    const at = findIdx(String(e.id).trim());
    if (at < 0) { ignored += 1; continue; }               // 旧 id / 已删 → 静默跳过（安全失败）
    if (e.op === 'remove') {
      list.splice(at, 1);
      removed += 1;
      continue;
    }
    const text = String(e.text || '').trim();
    if (!text) { ignored += 1; continue; }
    // 改正文 = 换 id（内容寻址的必然结果）。撞了已存在的条目就当重复，直接丢掉改动的这条。
    const nextId = itemIdOf(list[at].slot, text);
    if (findIdx(nextId) >= 0) { list.splice(at, 1); ignored += 1; continue; }
    list[at] = { ...list[at], id: nextId, text };
    edited += 1;
  }
  return { items: list, added, edited, removed, ignored };
}

/**
 * 条目版的预算裁剪 —— 与 normalizeSlots 的三道闸同策略（每槽限额 → 轮转分名额 →
 * 按槽丢弃），但作用在**条目**上，所以 `src`（来源）不会像重新解析文本那样丢掉。
 *
 * 注意：这里只做"丢"，不合并、不改写 —— 改写是模型的事，代码只在超预算时兜底。
 */
export function pruneItems(items, { maxLines = 8, maxChars = 800, perSlotMax = 3 } = {}) {
  const per = Math.max(0, Number(perSlotMax) || 0);
  const capLines = Math.max(1, Number(maxLines) || 8);
  const capChars = Math.max(120, Number(maxChars) || 800);
  const bySlot = { asking: [], promised: [], decided: [], happened: [], legacy: [] };
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || !it.id || !String(it.text || '').trim()) continue;
    const k = bySlot[it.slot] ? it.slot : 'legacy';
    bySlot[k].push({ ...it, slot: k });
  }
  // ① 每槽限额
  if (per > 0) for (const k of Object.keys(bySlot)) bySlot[k] = bySlot[k].slice(0, per);
  // ② 轮转分名额（与 normalizeSlots 完全一致，避免"第一个槽通吃"）
  const total = Object.values(bySlot).reduce((n, a) => n + a.length, 0);
  if (total > capLines) {
    const keep = new Map();
    let got = 0;
    for (let round = 0; got < capLines; round += 1) {
      let added = false;
      for (const k of SLOT_KEEP_ORDER) {
        if (got >= capLines) break;
        if (round < bySlot[k].length) { keep.set(`${k}#${round}`, true); got += 1; added = true; }
      }
      if (!added) break;
    }
    for (const k of Object.keys(bySlot)) {
      bySlot[k] = bySlot[k].filter((_, i) => keep.has(`${k}#${i}`));
    }
  }
  // ③ 字数上限：先丢"发生了什么"，承诺最后丢
  // ⚠️ 长度必须按**真实渲染结果**算。bySlot 里放的是 `{id,slot,text}` 对象，
  //    直接对它们调 renderSlots 会拼成 "[object Object]"，算出来的长度跟正文毫无关系
  //    （踩过：正文 200 字时它算成 16 字，一次都没裁）。
  const renderedText = () => renderSlots(
    Object.fromEntries(Object.entries(bySlot).map(([k, arr]) => [k, arr.map((it) => it.text)]))
  );
  let guard = 200;
  while (renderedText().length > capChars && guard > 0) {
    guard -= 1;
    const victim = SLOT_DROP_ORDER.find((k) => bySlot[k] && bySlot[k].length);
    if (!victim) break;
    const alive = Object.values(bySlot).reduce((n, a) => n + a.length, 0);
    if (alive <= 1) {
      // 只剩一条还超：切正文（渲染时还有 "- " 与 "…"，所以留 capChars-3）
      const k = Object.keys(bySlot).find((x) => bySlot[x].length);
      const body = String(bySlot[k][0].text || '');
      bySlot[k][0] = { ...bySlot[k][0], text: `${body.slice(0, Math.max(1, capChars - 3))}…` };
      break;
    }
    bySlot[victim].pop();
  }
  return [...bySlot.legacy, ...SUMMARY_SLOTS.flatMap((s) => bySlot[s.key])];
}

/**
 * 组"增量编辑"请求 —— 与 buildSummaryMessages 的区别是**不许重写整份摘要**。
 * 材料里每条摘要带 id，模型只能拿这些 id 做 ADD/EDIT/REMOVE。
 */
export function buildEditMessages({ items = [], lines = [], maxLines = 8, maxChars = 800, perSlotMax = 3 } = {}) {
  const per = Math.max(0, Number(perSlotMax) || 0);
  const list = Array.isArray(items) ? items : [];
  const rendered = list.length
    ? list.map((it) => `[${it.id}](${it.slot}) ${it.text}`).join('\n')
    : '（无）';
  return [
    {
      role: 'system',
      content: '你是聊天记录的压缩模块。你只做压缩：合并、去重、丢弃过时内容，'
        + '绝不发明、绝不扩写、绝不猜测、绝不点评。'
        + '你**不能重写整份摘要**，只能对已有的条目做增删改（ADD / EDIT / REMOVE）。'
        + '没被你点名的条目会原样保留 —— 所以拿不准的就别动它。'
        + '一行一条指令，不要代码块、不要任何解释或开场白。'
    },
    {
      role: 'user',
      content: [
        // 格式要求同样放材料之前（踩过的坑：材料之后再讲格式，模型全不照做）
        '【输出格式（必须遵守）】一行一条指令，只允许这三种：',
        '　ADD 【槽位标题】 | 一句话',
        '　EDIT 条目id | 改后的一句话',
        '　REMOVE 条目id',
        '槽位标题只能是这四个之一：【谁在要什么】【答应了什么】【定了什么】【发生了什么】',
        '　【谁在要什么】还没兑现的请求、没回答的问题（谁在等、在等什么）',
        '　【答应了什么】承诺与约定（谁答应了谁、几点、在哪、要做什么）',
        '　【定了什么】已经得出的结论、共识、决定',
        '　【发生了什么】已经过去的事实（时间、地点、人名、数字）；这块最不重要',
        '现有条目里已经说清楚的事，不要重复 ADD；措辞没实质变化就不要 EDIT。',
        '',
        '【现有摘要条目】',
        rendered,
        '',
        '【本次新增的聊天记录】',
        ...lines,
        '',
        '看完聊天记录，输出你要做的改动。另外：',
        `1. 改完之后总共最多 ${maxLines} 条${per > 0 ? `，**每块最多 ${per} 条**` : ''}，总长不超过 ${maxChars} 字；`,
        ...(per > 0 ? [
          `2. 某一块超过 ${per} 条，就把同类的**合并成一条**（例：A、B、C 都在问同一个功能 → 把这几条删掉，ADD 一行「A、B、C 都在问 X」），`
          + '不要为了塞满而拆开写；',
        ] : []),
        [`${per > 0 ? '3' : '2'}. 每条尽量写明**是谁**说的（昵称或 QQ 号）。丢了人，这份摘要就会张冠李戴；`,
          `${per > 0 ? '4' : '3'}. 丢弃：寒暄、表情、语气词、重复内容、已经聊完且没有后续的小事；`,
          `${per > 0 ? '5' : '4'}. 越近的越重要；过时的条目用 REMOVE 删掉，别留着占名额；`,
          `${per > 0 ? '6' : '5'}. 所有内容只能来自上面的原文。宁可少写，绝不补写。`].join('\n')
      ].join('\n')
    }
  ];
}

/** 摘要文件（每会话一个）。读坏文件不报错、不覆盖写作 —— 直接当没有。 */
export class PastSummaryStore {
  constructor() {
    this.cache = new Map();
  }
  #state(chatKey) {
    if (!this.cache.has(chatKey)) {
      const raw = readJsonSafe(summaryFile(chatKey), null, { tag: 'summary' });
      const ok = raw && typeof raw === 'object' ? raw : {};
      const summary = String(ok.summary || '');
      // 迁移：磁盘上可能有老版本（只有一段 summary 文本、没有 items）。
      // 解析成条目即可，**内容一个字不改** —— 下次增量编辑时它就有 id 了。
      const items = Array.isArray(ok.items) && ok.items.length
        ? ok.items.filter((it) => it && it.id && it.text).map((it) => ({
          id: String(it.id),
          slot: String(it.slot || 'legacy'),
          text: String(it.text),
          ...(Array.isArray(it.src) && it.src.length ? { src: it.src.map(Number).filter(Boolean) } : {})
        }))
        : itemsFromSummary(summary);
      this.cache.set(chatKey, {
        chatKey,
        summary,
        items,
        uptoId: Number(ok.uptoId) || 0,
        updatedAt: Number(ok.updatedAt) || 0,
        failCount: Number(ok.failCount) || 0,
        disabled: ok.disabled === true,
        runs: Number(ok.runs) || 0
      });
    }
    return this.cache.get(chatKey);
  }

  get(chatKey) {
    const st = this.#state(chatKey);
    return { ...st, items: st.items.map((it) => ({ ...it })) };
  }

  /** 只读条目列表（给增量编辑用）。 */
  items(chatKey) {
    return this.#state(chatKey).items.map((it) => ({ ...it }));
  }

  #save(chatKey) {
    const st = this.#state(chatKey);
    const file = summaryFile(chatKey);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, st);
    } catch (error) {
      console.warn(`[摘要] 落盘失败 ${chatKey}:`, error?.message ?? error);
    }
    return st;
  }

  /**
   * 写一版新摘要（老路径：整份文本直接落盘）。
   *
   * 仍然保留 —— `slotMode:false`、外部调用、老测试都走这里。
   * 它会顺手把 items 从文本重新解析出来，所以两条路径共享同一份真源：
   * **items 是结构，summary 是渲染结果**，谁写都会同步另一方。
   */
  commit(chatKey, { summary, uptoId }) {
    const st = this.#state(chatKey);
    st.summary = String(summary || '');
    st.items = itemsFromSummary(st.summary);
    st.uptoId = Number(uptoId) || st.uptoId;
    st.updatedAt = Date.now();
    st.failCount = 0;
    st.runs += 1;
    this.#save(chatKey);
    return { ...st };
  }

  /**
   * 增量提交：只应用编辑指令，**不重写**。
   * items 变了 → 重新渲染 summary → 落盘。没被点名的条目原样保留。
   *
   * @param {string} chatKey
   * @param {{ edits?: Array, uptoId?: number, sources?: number[] }} payload
   *   sources = 本批消息的本地 id，会记到新增条目上（provenance，对应 Zep 的 episode 关联）
   */
  applyEdits(chatKey, { edits = [], uptoId = 0, sources = null, maxLines = SUMMARY_DEFAULTS.maxLines, maxChars = SUMMARY_DEFAULTS.maxChars, perSlotMax = SUMMARY_DEFAULTS.perSlotMax } = {}) {
    const st = this.#state(chatKey);
    const before = st.items.length;
    const r = applyEdits(st.items, edits);
    // provenance：本批压出来的条目标上来源 id
    if (Array.isArray(sources) && sources.length) {
      const srcs = sources.map(Number).filter(Boolean);
      if (srcs.length) {
        const known = new Set(st.items.map((it) => it.id));
        for (const it of r.items) {
          if (known.has(it.id)) continue;                  // 老条目不动来源
          it.src = [...new Set([...(it.src || []), ...srcs])];
        }
      }
    }
    // 超预算兜底：只在**条目**上丢，不改写。放这里而不是提示词里，
    // 是因为模型不一定遵守"每块最多 N 条"，而预算必须硬。
    st.items = pruneItems(r.items, { maxLines, maxChars, perSlotMax });
    st.summary = renderItems(st.items);
    st.uptoId = Number(uptoId) || st.uptoId;
    st.updatedAt = Date.now();
    st.failCount = 0;
    st.runs += 1;
    this.#save(chatKey);
    return { ...st, added: r.added, edited: r.edited, removed: r.removed, ignored: r.ignored, before, after: st.items.length };
  }

  /**
   * 删掉"只来自这几条消息"的条目 —— Zep 的 remove_episode 传播规则的简化版：
   * 一条来源被撤掉时，只有**没有其他来源支撑**的条目才消失。
   *
   * 用途：一批消息被判为"不该进摘要"（比如模型抽错了、或用户要求抹掉某段）。
   * 没有任何来源信息的老条目（src 为空）一律不动 —— 不知道来源就别猜着删。
   */
  dropEpisodes(chatKey, ids = []) {
    const st = this.#state(chatKey);
    const kill = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean));
    if (!kill.size) return { ...st, removed: 0 };
    const kept = [];
    let removed = 0;
    for (const it of st.items) {
      const srcs = Array.isArray(it.src) ? it.src.map(Number).filter(Boolean) : [];
      if (!srcs.length) { kept.push(it); continue; }            // 来源未知 → 保守保留
      const rest = srcs.filter((id) => !kill.has(id));
      if (!rest.length) { removed += 1; continue; }              // 唯一的支撑被撤 → 删
      kept.push({ ...it, src: rest });                           // 还有别的支撑 → 只摘掉这一条
    }
    st.items = kept;
    st.summary = renderItems(st.items);
    st.updatedAt = Date.now();
    this.#save(chatKey);
    return { ...st, removed };
  }

  /** 失败一次；到阈值就停用（返回 {disabled:true} 让调用方只打一次日志）。 */
  bumpFail(chatKey, threshold = SUMMARY_DEFAULTS.failThreshold) {
    const st = this.#state(chatKey);
    st.failCount += 1;
    const justDisabled = !st.disabled && st.failCount >= Math.max(1, Number(threshold) || 3);
    if (justDisabled) st.disabled = true;
    this.#save(chatKey);
    return { failCount: st.failCount, disabled: st.disabled, justDisabled };
  }

  /** 手动重置（控制台/排查用）：清掉停用标记与摘要。 */
  reset(chatKey) {
    const st = this.#state(chatKey);
    st.summary = '';
    st.items = [];
    st.uptoId = 0;
    st.failCount = 0;
    st.disabled = false;
    st.updatedAt = Date.now();
    this.#save(chatKey);
    return { ...st };
  }

  /**
   * 给提示词用的文本（没摘要、或已停用都返回空串 —— 空串 = 整段不出现）。
   *
   * 超预算时**按槽位丢**（先丢"发生了什么"，承诺最后才丢），而不是从末尾整条丢。
   * 旧摘要（磁盘上的平铺条目）解析不出槽位 → 全部进 legacy → 仍是按整条丢，与旧行为一致。
   */
  formatForPrompt(chatKey, { maxChars = SUMMARY_DEFAULTS.maxChars, slotMode = true, perSlotMax = SUMMARY_DEFAULTS.perSlotMax } = {}) {
    const st = this.#state(chatKey);
    if (st.disabled) return '';
    const s = String(st.summary || '').trim();
    if (!s) return '';
    const cap = Math.max(120, Number(maxChars) || 800);
    // 关掉槽位 = 退回**平铺条目**，且是**无条件**的：开关管的是输出形态，
    // 不只是"超预算时怎么丢"。⚠️ 不能只放在下面的 length<=cap 分支里 ——
    // 装得下时直接返回原文，磁盘上的槽位标题就原样进了提示词（实测踩到）。
    if (slotMode === false) return normalizeSummary(s, { maxChars: cap, maxLines: 99 }) || s;
    if (s.length <= cap) return s;
    // maxLines 给足：条数在写入时已经控过，这里只做字数淘汰。
    // perSlotMax 仍然传 —— 磁盘上的摘要是旧版写的（每槽不限），这里兜一道按槽裁。
    const slotted = normalizeSlots(s, { maxChars: cap, maxLines: 99, perSlotMax });
    if (slotted) return slotted;
    // 超预算按**整条**丢，绝不切半句（半句会被当成事实读）。
    // 配置改过 maxChars 时才会走到这里：摘要本身在写入时已经控过长度。
    const lines = s.split('\n').filter(Boolean);
    const kept = [...lines];
    while (kept.length > 1 && kept.join('\n').length > cap) kept.pop();
    const out = kept.join('\n');
    return out.length > cap ? `${out.slice(0, cap - 1)}…` : out;
  }
}

/** 纯函数：从会话消息里挑出"窗口外、还没压过"的那一批（最旧的先）。 */
export function pickPending(messages, { windowLimit = 24, uptoId = 0, maxBatch = 60 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const window = Math.max(1, Number(windowLimit) || 24);
  const cut = Math.max(0, list.length - window);
  const out = [];
  for (let i = 0; i < cut; i += 1) {
    const m = list[i];
    if (!m) continue;
    if (Number(m.id) <= Number(uptoId || 0)) continue;
    out.push(m);
    if (out.length >= Math.max(1, Number(maxBatch) || 60)) break;
  }
  return out;
}
