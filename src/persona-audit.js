// 人设十维体检 —— "这张卡能不能撑住一个人"（学自《酒馆十维》）。
//
// ── 为什么不是"写得长就行" ────────────────────────────────────────────────
// QQagent 的人设是一段自由 Markdown。写得长不等于立得住：有的卡堆了一屏性格形容词，
// 却回答不了"他拿主意时先看什么"（逻辑）、"压力来了第一反应是什么"（本我）、
// "什么是他不懂的"（知识边界）。结果就是——**演什么都像同一个客服**。
//
// 十维不是评分比赛，是一张**缺口清单**：哪一维空着，就给出"该问他什么"的一句话。
// 所以每个分数都必须带**证据**（原文里命中了哪些词），没有证据的分数没人信。
//
// ⚠️ 纯函数、零 IO、零依赖：面板、命令行、测试三处共用这一份实现
//    （三处各写一份的话，"同一张卡分数不一样"是迟早的事）。
//
// ⚠️ 自定义维度（dimensions.json）**不在这里读**：本模块只管内置十维和打分，
//    要加维度由调用方把 dim 列表传进来（readCustomDims 在调用方）。
import { PERSONAS } from './personas.js';

/** 内置十维（岁小熙的提法：能不能演一个人，看这十样有没有）。 */
export const BUILTIN_DIMENSIONS = [
  {
    id: 'world', label: '世界观',
    cues: ['世界', '时代', '设定', '背景', '社会', '规则', '未来', '城市', '大陆'],
    fields: ['world', 'setting', 'background'],
    question: '这个世界的基本规则是什么？（时代/地点/有没有超自然，一句话）'
  },
  {
    id: 'values', label: '价值观',
    cues: ['重视', '看重', '认为', '应该', '不该', '公平', '自由', '原则', '底线', '在意'],
    fields: ['values', 'principle'],
    question: '他排在最前面的三样是什么？（例：自由 > 家人 > 正义）'
  },
  {
    id: 'life', label: '生命观',
    cues: ['生命', '死亡', '活着', '存在', '灵魂', '牺牲', '失去', '害怕'],
    fields: ['fear', 'life'],
    question: '他怎么看待生死和"活着"？（会为什么豁出去、什么情况绝不）'
  },
  {
    id: 'vocation', label: '职业理想',
    cues: ['职业', '工作', '身份', '想成为', '梦想', '事业', '职责', '使命', '目标'],
    fields: ['role', 'desire', 'job'],
    question: '他靠什么吃饭、想成为什么？（"还在混"也算答案）'
  },
  {
    id: 'attachment', label: '情感寄托',
    cues: ['喜欢', '在意', '牵挂', '依赖', '陪伴', '家人', '朋友', '群友', '心软', '惦记', '执念', '寄托', '主人'],
    fields: ['relation', 'attachment'],
    question: '他真正放不下的是谁/什么？'
  },
  {
    id: 'self', label: '自我',
    cues: ['我是', '自称', '名字', '我叫', '本鲸', '从不', '我认为'],
    fields: ['botName', 'selfNickname'],
    question: '他自己会怎么介绍自己？（只说他自己认的，不是设定集那种）'
  },
  {
    id: 'id', label: '本我',
    cues: ['本能', '冲动', '下意识', '忍不住', '脾气', '炸毛', '沉默', '身体', '饿', '困'],
    fields: ['stress', 'habits', 'temper'],
    question: '压力来时他第一反应是什么？（战斗/逃跑/僵住/讨好/讽刺/沉默）'
  },
  {
    id: 'logic', label: '思考逻辑',
    cues: ['所以', '因为', '判断', '先', '再', '根据', '考虑', '拿主意'],
    fields: ['logic', 'decide'],
    question: '他拿主意时先看什么、后看什么？'
  },
  {
    id: 'reasoning', label: '推理能力',
    cues: ['如果', '就会', '除非', '一旦', '举个例子', '例子', '反例'],
    fields: ['lines', 'examples'],
    question: '举一个"如果……他就会……"的具体条件，越具体越好。'
  },
  {
    id: 'knowledge', label: '知识储备边界',
    cues: ['不知道', '不懂', '只懂', '没学过', '听说', '据说', '专业', '不会'],
    fields: ['limits', 'secrets'],
    question: '他懂什么、不懂什么、又误以为什么呢？'
  }
];

/** 五色阈值（灰<0.30 / 绿<0.50 / 蓝<0.66 / 紫<0.90 / 金≥0.90）。 */
export const COLOR_STOPS = [
  { max: 0.30, name: 'gray', label: '几乎空的' },
  { max: 0.50, name: 'green', label: '有影子' },
  { max: 0.66, name: 'blue', label: '够用' },
  { max: 0.90, name: 'purple', label: '扎实' },
  { max: 2, name: 'gold', label: '能演' }
];

export function colorOf(score) {
  const s = Number(score) || 0;
  return COLOR_STOPS.find((c) => s < c.max) || COLOR_STOPS[COLOR_STOPS.length - 1];
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 把 persona / 自定义人设 / 纯文本统一成一段可比对的正文。 */
export function textOf(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  const parts = [input.roleText, input.text];
  for (const key of ['botName', 'selfNickname', 'customRules', 'participation']) {
    if (input[key]) parts.push(String(input[key]));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * 给一张人设打十维分。
 *
 * 打分口径（刻意简单、可解释）：
 *   · cue 命中数 / 2 → cueScore（**两个证据词就算这一维立住了**：只命中一个
 *     往往是顺带提了一句，不算真的交代过）
 *   · persona 上存在同名结构化字段且 ≥20 字 → fieldScore = 1
 *   · 两者加权：0.8 * cueScore + 0.2 * fieldScore（文本是主要证据；结构化字段只加分）
 *
 * @param {object|string} persona 人设对象或纯文本
 * @param {Array} [dims] 维度列表（默认内置十维；调用方可传内置+自定义）
 * @returns {{scores:object, dims:Array, coverage:number, balance:number, boundary:number,
 *            reasonability:number, cell:number, gaps:Array, chars:number}}
 */
export function auditPersona(persona, dims = BUILTIN_DIMENSIONS) {
  const corpus = textOf(persona);
  const scores = {};
  const evidence = {};
  const rows = [];

  for (const dim of dims) {
    const cueHits = (dim.cues || []).filter((cue) => corpus.includes(String(cue)));
    const cueScore = Math.min(1, cueHits.length / 2);
    let fieldScore = 0;
    if (persona && typeof persona === 'object') {
      for (const key of dim.fields || []) {
        const v = persona[key];
        if (typeof v === 'string' && v.trim().length >= 20) { fieldScore = 1; break; }
      }
    }
    const score = clamp01(0.8 * cueScore + 0.2 * fieldScore);
    scores[dim.id] = Number(score.toFixed(3));
    evidence[dim.id] = cueHits.slice(0, 6);
    rows.push({
      id: dim.id,
      label: dim.label,
      score: scores[dim.id],
      color: colorOf(score).name,
      colorLabel: colorOf(score).label,
      evidence: evidence[dim.id],
      question: dim.question || ''
    });
  }

  const vals = Object.values(scores);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const coverage = clamp01(vals.filter((v) => v >= 0.66).length / Math.max(1, vals.length));
  // 平衡度：最弱那维 / 平均。留 0.3 的地板 —— 少一维（群里聊天不需要世界观）
  // 不该把整张卡判死；真正要看的是 gaps 那张清单。
  const min = vals.length ? Math.min(...vals) : 0;
  const balance = clamp01(0.3 + 0.7 * (avg > 0 ? min / avg : 0));
  // 边界：有没有明确"不聊/不做/不会"的表述 + 知识边界维
  const boundary = clamp01(
    (/(不聊|不谈|不做|禁止|底线|拒绝|不涉及|不提供)/.test(corpus) ? 0.5 : 0)
    + 0.5 * (scores.knowledge ?? 0)
  );
  const hasExamples = /(示例|例子|你可以|你不要|✓|✗)/.test(corpus) || String(persona?.examples || '').length > 40;
  const reasonability = clamp01(
    0.5 * (hasExamples ? 1 : 0) + 0.3 * (scores.reasoning ?? 0) + 0.2 * boundary
  );

  // 总评：四项加权（不是几何平均 —— 一维为空就把总分拉成 0，那只会让人不想看）。
  const cell = clamp01(
    0.40 * coverage + 0.30 * balance + 0.15 * boundary + 0.15 * reasonability
  );

  const gaps = rows
    .filter((r) => r.score < 0.66)
    .sort((a, b) => a.score - b.score)
    .map((r) => ({ id: r.id, label: r.label, score: r.score, question: r.question }));

  return {
    scores,
    evidence,
    dims: rows,
    coverage: Number(coverage.toFixed(3)),
    balance: Number(balance.toFixed(3)),
    boundary: Number(boundary.toFixed(3)),
    reasonability: Number(reasonability.toFixed(3)),
    cell: Number(cell.toFixed(3)),
    cellColor: colorOf(cell).name,
    gaps,
    chars: [...corpus].length
  };
}

/** 给人看的一段体检报告（命令行/面板直接显示）。 */
export function formatAuditReport(audit, { name = '当前人设' } = {}) {
  if (!audit) return '';
  const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
  const lines = [
    `【十维体检】${name}`,
    `总评 ${pct(audit.cell)}（${colorOf(audit.cell).label}）· 覆盖 ${pct(audit.coverage)} · 平衡 ${pct(audit.balance)} · 边界 ${pct(audit.boundary)} · 可信 ${pct(audit.reasonability)} · 全文 ${audit.chars} 字`,
    '',
    ...audit.dims.map((d) => {
      const ev = d.evidence.length ? `　证据：${d.evidence.join('、')}` : '';
      return `${d.label.padEnd(8, '　')} ${pct(d.score)}  ${colorOf(d.score).label}${ev}`;
    })
  ];
  if (audit.gaps.length) {
    lines.push('', '【缺哪维 · 该问什么】');
    for (const g of audit.gaps) lines.push(`- ${g.label}（${pct(g.score)}）：${g.question}`);
  } else {
    lines.push('', '十维都够用，不用补。');
  }
  return lines.join('\n');
}

/** 按 id / 名字取一个内置人设（命令行用）。 */
export function personaByKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  if (PERSONAS[k]) return { key: k, name: PERSONAS[k].name, persona: { roleText: PERSONAS[k].text, botName: PERSONAS[k].name } };
  const hit = Object.entries(PERSONAS).find(([, v]) => v.name === k || v.text.includes(k));
  if (!hit) return null;
  return { key: hit[0], name: hit[1].name, persona: { roleText: hit[1].text, botName: hit[1].name } };
}
