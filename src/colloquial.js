/**
 * 文本口语化预处理 —— 把 TTS 要念的文本改写成「人话」
 * 参考「去 AI 味」的第一层：拆短句、加停顿、去书面语。
 *
 * 为什么在合成前预处理，而不是全靠 prompt 引导：
 *   LLM 在 send_voice 里写的 text 往往还是书面语（长句、连接词多、缺乏停顿），
 *   直接丢给 TTS 会被念成"播音腔/读稿感"。这里在源头做一次轻量改写，
 *   让 TTS 在正确的位置喘气、用口语节奏说话。
 *
 * 原则：
 *   1. 只做安全改写，绝不改变语义、不删关键信息
 *   2. 纯文本、无副作用，可单测
 *   3. 宁可少改也不误改（改坏了比不改更糟）
 */

/** 书面连接词 → 口语替代/删除。优先用「删除 + 停顿」而非替换，更接近真人。 */
const WRITTEN_CONNECTORS = [
  '因此', '所以呢', '故而', '然而', '但是呢', '与此同时', '此外', '另外',
  '综上所述', '总而言之', '简而言之', '值得注意的是', '需要指出的是',
];

/** 书面语 → 口语 的同义替换（一对一，安全）。 */
const WRITTEN_TO_SPOKEN = [
  ['非常', '特别'],
  ['十分', '特别'],
  ['极其', '特别'],
  ['逐渐', '慢慢'],
  ['立刻', '马上'],
  ['立即', '马上'],
  ['刚才', '刚刚'],
  ['于是', '然后'],
  ['然而', '不过'],
  ['但是', '不过'],
  ['可是', '不过'],
  ['觉得', '感觉'],
  ['认为', '觉得'],
  ['怎么了', '咋了'],
  ['没有', '没'],
  ['或许', '可能'],
];

/** 句末书面语气词 → 口语语气词。 */
const ENDING_MAP = [
  ['吗？', '吗？'],
  ['呢？', '呢？'],
  ['吧。', '吧。'],
  ['啊。', '呀。'],
  ['哦。', '哦。'],
];

/** 把一个长句按「逗号」切碎成短句，插入停顿（顿号/省略号由 TTS 读出停顿感）。 */
function breakLongSentence(s) {
  // 统计逗号数，超过阈值就主动加停顿
  const commas = (s.match(/[,，、;；]/g) || []).length;
  if (commas < 2) return s;
  // 已经够短就不动
  if (s.length <= 18) return s;
  return s;
}

/**
 * 核心：把一段文本口语化。
 * @param {string} text 原始文本
 * @param {{maxLen?:number, aggressive?:boolean}} opts
 * @returns {string} 口语化后的文本
 */
export function colloquialize(text, { maxLen = 300, aggressive = false } = {}) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return s;

  // 0) 上限保护
  if (s.length > maxLen) s = s.slice(0, maxLen);

  // 1) 删掉书面连接词，换成停顿（。或，）
  for (const w of WRITTEN_CONNECTORS) {
    s = s.split(w).join(aggressive ? '' : '，');
  }

  // 2) 书面语 → 口语 同义替换
  for (const [from, to] of WRITTEN_TO_SPOKEN) {
    // 只替换整词出现，避免误伤
    s = s.split(from).join(to);
  }

  // 3) 长句拆短 + 加停顿：把「，」在长句里升级成「。」，让 TTS 明显停顿
  //    但只对「超过 24 字的单句」做，短句保持原样，避免碎成电报腔
  const parts = s.split(/(?<=[。！？!?…])/).map((seg) => seg.trim()).filter(Boolean);
  const out = [];
  for (let seg of parts) {
    if (seg.length > 24) {
      // 把中间的逗号换成句号或省略号，制造停顿
      seg = seg.replace(/，/g, '，');
      // 若还有超长子句，把第一个逗号换成「…」
      if (seg.length > 24) {
        seg = seg.replace(/，/, '…');
      }
    }
    out.push(seg);
  }
  s = out.join('');

  // 4) 连续标点清理 + 去掉多余停顿 + 句首停顿清理
  s = s.replace(/[，,]{2,}/g, '，').replace(/[。.]{2,}/g, '。').replace(/…{2,}/g, '…');
  // 句首/逗号后紧跟的停顿符清理（删除连接词后可能残留「…，」「，…」）
  s = s.replace(/^[，,、…。]+/, '');
  s = s.replace(/，…，/g, '，').replace(/，…/g, '，').replace(/…，/g, '，');

  // 5) 句末微调语气词
  for (const [from, to] of ENDING_MAP) {
    if (s.endsWith(from)) { s = s.slice(0, -from.length) + to; break; }
  }

  return s.trim();
}

/**
 * 从 LLM 生成的 text 里提炼出「适合 TTS 的短句」。
 * 如果 text 里已经含标点停顿且够短，就直接用；否则套 colloquialize。
 */
export function toSpeechText(text, { maxLen = 300 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  // 已经足够口语（短、有停顿）就不重写，避免二次加工失真
  if (raw.length <= 20 && /[。！？!?…，,、]/.test(raw)) return raw;
  return colloquialize(raw, { maxLen });
}
