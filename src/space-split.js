// 出站「空格分句」纠正：把中文之间**当逗号用的空格**换成真逗号。
//
// 为什么要在出站闸门做，而不是在 system 提示词里再写一遍（2026-10-25）：
//   提示词里早就有【空格不是分句符号】，实测 7 天 1,082 个气泡里 710 个仍然用空格分句（65.6%），
//   而规则表里给它定的目标是 5%。也就是说这条规则**只进不出**：写了、没人核、也没拦住。
//   模型看得见「要求」，但看不见「自己上一次怎么写的」，加字只会让 system 继续变长。
//
// 但**先说清一件事：空格分句本身不是原罪**。量了真人（data/messages 里 self=false 共 2,603 条，
// 已排除 [拍一拍]/[卡片]/[图片] 这类系统占位），按长度分桶并排，两者差别一目了然：
//
//        长度     她 n   她 逗号/空格     人类 n   人类 逗号/空格
//        <10      276    3.6% / 42.8%    1519     2.2% / 10.5%
//        10-19    713    5.9% / 72.1%     476    13.7% / 28.4%
//        20-29     87   11.5% / 79.3%     281    40.9% / 57.7%
//        30+       55   89.1% /  9.1%     327    32.1% / 81.0%
//
// 读法：**人类的逗号率随长度暴涨**（2.2% → 13.7% → 40.9%，10~29 字是逗号主导），
// 而她的逗号率几乎不随长度变（3.6% → 5.9% → 11.5%），一路拿空格顶着 —— 这才是机器感的物理来源。
// 所以真正要纠的不是「用了空格」，而是「该用逗号的地方用了空格」，也就是 **10~29 字**这一段。
//
// 两头都刻意不动：
//   · <10 字：人类同长度只有 2.2% 带逗号，「那行 给你配了」是真实写法，
//     硬换逗号会让她比人还规整 —— 那是另一种机器感。
//   · ≥30 字：她 89.1% 已经在用逗号（比人类 32.1% 还干净），这一段她本来就过线了；
//     而且 30 字以上多半是整段粘贴/引用/代码，动它风险远大于收益。
//
// 三条纪律：
//   ① 只换「汉字 + 空格 + 汉字」。夹着数字/英文的空格一律不动（"8.50 分""IG 打 GEN"）。
//   ② 不认识的东西一概不碰：代码块、URL、卡片/占位符（[表情包：…]、【正在播放…】）、多段落。
//   ③ 纯函数、无 IO、可单测；没改时返回原引用，调用方用 `changed` 判断。
//
// 副作用（有意为之）：改后的文本才进 ChatStore，所以**下一轮【过去状态】里她自己的历史发言
// 也是干净的**。她过去是照着"自己用空格分句"的样本继续用空格，这一层同时也切断了这个自循环。

/** 汉字（含扩展 A / 兼容区）。只认这些，不认标点、假名、谚文。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 空格串：半角空格与全角空格（U+3000 在群里很常见，只认半角会漏掉）。 */
const SPACE_RUN = /[ \u3000]+/g;

/** 默认区间：10~29 个非空白字符（依据见文件头那张表，两头都不该动）。 */
export const DEFAULT_MIN_CHARS = 10;
export const DEFAULT_MAX_CHARS = 30;

/**
 * 这些形状**整段跳过**：不是"她写给人看的一句话"，改标点只会破坏结构。
 * 宁可漏改，不可改坏 —— 改坏的代价是发出去就收不回。
 */
function shouldSkip(s) {
  if (!s) return true;
  if (s.length > 400) return true;                     // 长文（多半是引用/代码/整段粘贴）
  if (/\n/.test(s)) return true;                       // 多行 = 有意排版
  if (/^[[【]/.test(s)) return true;                    // [表情包：…] 【正在播放…】这类占位/卡片
  if (/```|https?:\/\/|base64:/i.test(s)) return true;  // 代码块 / 链接
  // 中文字符占比过低 → 是英文/代码/数据，不是闲聊句子
  const hanCount = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  if (hanCount / s.length < 0.4) return true;
  return false;
}

/**
 * 把"当逗号用的空格"换成「，」。
 *
 * @param {string} text
 * @param {{minChars?:number, maxChars?:number, mark?:string}} [opts]
 *   minChars: 整段（去空白）少于这么多字就不动，默认 10
 *   maxChars: 整段（去空白）达到这么多字就不动，默认 30（0/Infinity = 不设上限）
 *   mark:     替换成什么，默认全角逗号（测试与灰度时会用到别的）
 * @returns {{text:string, changed:boolean, fixed:number, skipped?:string}}
 *   changed=false 时 `text` 是**原引用**（调用方可以 `!==` 判断）
 */
export function despace(text, opts = {}) {
  const s = String(text ?? '');
  if (!s) return { text: s, changed: false, fixed: 0 };
  const reason = shouldSkip(s) ? 'shape' : '';
  if (reason) return { text: s, changed: false, fixed: 0, skipped: reason };

  const minChars = Number.isFinite(Number(opts.minChars)) ? Math.max(0, Number(opts.minChars)) : DEFAULT_MIN_CHARS;
  const maxChars = Number.isFinite(Number(opts.maxChars)) ? Number(opts.maxChars) : DEFAULT_MAX_CHARS;
  const solid = s.replace(/[ \u3000]/g, '').length;
  if (solid < minChars) return { text: s, changed: false, fixed: 0, skipped: 'short' };
  if (maxChars > 0 && solid >= maxChars) return { text: s, changed: false, fixed: 0, skipped: 'long' };

  const mark = typeof opts.mark === 'string' && opts.mark ? opts.mark : '，';

  let out = '';
  let last = 0;
  let fixed = 0;
  for (const m of s.matchAll(SPACE_RUN)) {
    const i = m.index;
    const left = s[i - 1];
    const right = s[i + m[0].length];
    // 行首/行尾、非汉字两侧：一律不动
    if (!left || !right) continue;
    if (!HAN.test(left) || !HAN.test(right)) continue;
    out += s.slice(last, i) + mark;
    last = i + m[0].length;
    fixed += 1;
  }
  if (!fixed) return { text: s, changed: false, fixed: 0 };
  out += s.slice(last);
  return { text: out, changed: true, fixed };
}

/**
 * 诊断用：列出这段文字里会被换掉的每一处（前 6 个字上下文）。
 * 只给日志/看板用，不参与发送。
 */
export function scanSplits(text, opts = {}) {
  const s = String(text ?? '');
  const hits = [];
  for (const m of s.matchAll(SPACE_RUN)) {
    const i = m.index;
    const left = s[i - 1];
    const right = s[i + m[0].length];
    if (!left || !right || !HAN.test(left) || !HAN.test(right)) continue;
    hits.push({
      at: i,
      before: s.slice(Math.max(0, i - 6), i),
      after: s.slice(i + m[0].length, i + m[0].length + 6)
    });
  }
  const r = despace(s, opts);
  return { hits, wouldFix: r.changed, fixed: r.fixed, skipped: r.skipped || '' };
}
