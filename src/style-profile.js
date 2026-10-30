// 说话风格画像（ATI 风格的本地统计）—— 量出"对方怎么说话"，让机器人跟着对方的节奏。
//
// 为什么要它：现在只靠 `participation`（低/中/高）这类**固定档位**猜分量，
// 结果就是"对方三个字，它回一段"。这里改成**从真实消息里量**：
//   平均字数、短句占比、提问占比、2~4 字口癖 —— 全部本地算，**零模型调用**。
//
// 为什么是纯函数、且时间/随机都不进来：
//   数字是确定性的 → 每一条判据都能直接写进断言（这是它能进回归测试的前提）。
//   样本不足（< 8 条）时明确返回 enough=false，不硬给画像 —— 宁可不说，也别带偏。

const PLACEHOLDER_RE = /\[[^\]]{1,200}\]/g;     // [图片] [表情] [拍一拍] [引用 …] [转发消息 …] 这类占位符
const MENTION_RE = /@[^\s@]{1,24}/g;             // @某人 是称呼不是"说话"，统计口癖时必须去掉
const SPLIT_RE = /[\s\p{P}\p{S}]+/gu;             // 空白/标点/符号 → 分隔符
const PUNCT_CHAR_RE = /[\s\p{P}\p{S}]/u;

// 所有人都会说的词，不算"这个群的口癖"
const STOP = new Set([
  '什么', '怎么', '为什么', '这个', '那个', '我们', '你们', '他们', '真的', '可以', '不是', '但是',
  '所以', '然后', '现在', '已经', '一个', '一下', '知道', '觉得', '时候', '因为', '如果', '没有',
  '还是', '这么', '那么', '这样', '那样', '一样', '有点', '应该', '可能', '其实', '反正', '要不',
  '随便', '就是', '一定', '有点', '多少', '哈哈', '嘿嘿', '呵呵'
]);

function plainOf(text) {
  return String(text ?? '')
    .replace(PLACEHOLDER_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(SPLIT_RE, ' ')
    .trim();
}

/** 2~4 字口癖：必须出现在 ≥2 条消息里（同一句里重复不算口癖）。 */
function catchphrases(texts, { minMsgs = 2, limit = 3 } = {}) {
  const seen = new Map();       // 短语 -> Set(消息下标)
  const edgeHits = new Map();   // 短语 -> "整段/句首/句尾"出现次数
  texts.forEach((raw, idx) => {
    for (const block of plainOf(raw).split(' ').filter(Boolean)) {
      for (let n = 2; n <= 4; n++) {
        for (let k = 0; k + n <= block.length; k++) {
          const g = block.slice(k, k + n);
          if (PUNCT_CHAR_RE.test(g) || /^[0-9A-Za-z]+$/.test(g) || STOP.has(g)) continue;
          if (!seen.has(g)) seen.set(g, new Set());
          seen.get(g).add(idx);
          if (k === 0 || k + n === block.length) edgeHits.set(g, (edgeHits.get(g) || 0) + 1);
        }
      }
    }
  });
  const cands = [...seen.entries()]
    .map(([phrase, set]) => ({ phrase, msgs: set.size, edge: edgeHits.get(phrase) || 0 }))
    // ① 至少出现在 2 条消息里；② 一半以上的出现是"整段/句首/句尾" ——
    //    否则它多半只是某句长话里的一小截（实测真实群记录里"是一个""一点为了"就是这么冒出来的）
    .filter((c) => c.msgs >= minMsgs && c.edge >= Math.max(1, Math.ceil(c.msgs / 2)));
  // 更长的更具体 → 优先；同长度按命中消息数
  cands.sort((a, b) => b.phrase.length - a.phrase.length || b.msgs - a.msgs || (a.phrase < b.phrase ? -1 : 1));
  const out = [];
  for (const c of cands) {
    if (out.some((o) => o.includes(c.phrase) || c.phrase.includes(o))) continue;
    out.push(c.phrase);
    if (out.length >= limit) break;
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 从最近的聊天记录里量出"对方怎么说话"。
 * @param entries store 的消息条目（自己发的会被自动排除）
 * @param limit   只看最近多少条（默认 40）
 * @param minSamples 样本不足就不给画像（默认 8）
 */
export function buildStyleProfile(entries, { limit = 40, minSamples = 8 } = {}) {
  const texts = (Array.isArray(entries) ? entries : [])
    .filter((m) => m && !m.self)
    .map((m) => String(m.text || '').trim())
    .filter((t) => t && !/^\[[^\]]*\]$/.test(t))     // 只有 [图片] 这种不算一条"说话"样本
    .slice(-Math.max(1, limit));
  const samples = texts.length;
  if (samples < Math.max(1, minSamples)) return { samples, enough: false, medianChars: 0, shortRatio: 0, askRatio: 0, catchphrases: [] };
  const lens = texts.map((t) => plainOf(t).replace(/\s/g, '').length).filter((n) => n > 0);
  // 用中位数而不是平均数：群里偶发的长消息（合并转发展开之类）会把平均数拉飞，
  // 实测真实群记录里"平均 28.5 字"其实中位数只有 6 字 —— 平均值会带偏"跟着对方节奏"的判断。
  const sorted = [...lens].sort((a, b) => a - b);
  const medianChars = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : round2((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2))
    : 0;
  return {
    samples,
    enough: true,
    medianChars,
    shortRatio: lens.length ? round2(lens.filter((n) => n <= 6).length / lens.length) : 0,
    askRatio: round2(texts.filter((t) => /[?？]/.test(t)).length / samples),
    catchphrases: catchphrases(texts)
  };
}

/** 画像 → 提示词里的一行（样本不足返回空串，不占预算）。 */
export function formatStyleProfile(profile) {
  if (!profile || !profile.enough) return '';
  const bits = ['中位 ' + profile.medianChars + ' 字/条'];
  if (profile.shortRatio >= 0.4) bits.push('短句（≤6 字）占 ' + Math.round(profile.shortRatio * 100) + '%');
  if (profile.askRatio >= 0.25) bits.push('提问占 ' + Math.round(profile.askRatio * 100) + '%');
  if (profile.catchphrases && profile.catchphrases.length) bits.push('口癖「' + profile.catchphrases.join('」「') + '」');
  const short = profile.medianChars <= 8 || profile.shortRatio >= 0.5;
  const tail = short
    ? '→ 对方说话很短，你也别铺开：一句能说完就一句，想补再补第二条。'
    : '→ 跟着对方的量级走，别比他写得多。';
  return '【对方说话风格（本地统计，' + profile.samples + ' 条）】' + bits.join('；') + '。' + tail;
}
