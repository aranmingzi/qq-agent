// 工具结果预算：把"超长工具结果"从**只留开头**改成**留开头 + 留结尾**。
//
// 为什么改（原实现只有 slice(0, max)，见 orchestrator 里那段"省钱层移植"注释）：
//   只留开头会切掉**结论所在的位置**。本项目的工具结果有三类尾巴特别重要：
//     ① 列表类（get_recent_messages / get_group_list）：最新的是最后几条，
//        而"最新"往往正是模型要回答的东西；
//     ② JSON：截断后括号不闭合，尾部通常还带 total / has_more / error 字段；
//     ③ 检索类（web_search / 视频弹幕）：摘要行、统计行基本都压在末尾。
//   实测表现不是报错，而是"它看了工具结果却答了前面几句无关的"——最难查的那类故障。
//
// 纪律（与本项目其它预算模块一致）：
//   ① 纯函数，不读配置、不碰磁盘、不看时间；
//   ② 没超上限就返回**原引用**，`changed:false` —— 调用方靠这个判断有没有真的动过；
//   ③ 切在**行边界**上，不留半条消息/半个 JSON 字段；
//   ④ 丢了多少字要写在标记里，模型和日志都得知道"这里缺东西"，否则它会当成完整结果。
//
// 与 context-budget.js 的分工：那边管**提示词分段**（段配额、淘汰次序），
// 这边只管**单条工具结果**这一种瞬时大块。两者都是"裁剪"，但判据和调用点完全不同。
// （方案来源：上下文压缩设计 §四「工具结果专门压缩」的 L1 级 = 头尾截断。）

/** 默认上限（字符）：与 config.tools.toolResultMaxChars 的出厂值保持一致。 */
export const DEFAULT_MAX_CHARS = 12000;
/** 默认头尾配比：头 40% / 尾 60%。尾巴多留 —— 结论通常在后面（见文件头）。 */
const DEFAULT_HEAD_RATIO = 0.4;
/** 上下各至少要留这么多字符，否则"截断"等于只剩标记。 */
const MIN_SIDE = 120;

/**
 * 从 `idx` 往前找最近的行首；找不到就原样返回（宁可切半行，也不能切出空串）。
 * @param {string} s
 * @param {number} idx
 */
function snapHead(s, idx) {
  if (idx >= s.length) return s.length;
  const nl = s.lastIndexOf('\n', idx);
  return nl > 0 ? nl : idx;
}

/** 从 `idx` 往后找最近的行首，保证尾巴从整行开始。 */
function snapTail(s, idx) {
  if (idx <= 0) return 0;
  const nl = s.indexOf('\n', idx);
  return nl >= 0 ? nl + 1 : idx;
}

/**
 * 截断一条工具结果：保留开头 + 结尾，中间换成可见的省略标记。
 *
 * @param {string} text 原始工具结果
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  总预算（字符）
 * @param {number} [opts.headRatio] 头占多少（0.1~0.9）
 * @param {string} [opts.hint]      给模型的"怎么拿更多"提示（工具不同说法不同）
 * @returns {{text:string, changed:boolean, before:number, after:number, dropped:number}}
 */
export function clipToolResult(text, opts = {}) {
  const src = String(text ?? '');
  const before = src.length;
  const raw = Number(opts.maxChars);
  const maxChars = Number.isFinite(raw) && raw > 0 ? Math.max(200, Math.floor(raw)) : DEFAULT_MAX_CHARS;
  if (before <= maxChars) {
    return { text: src, changed: false, before, after: before, dropped: 0 };
  }

  const hr = Number(opts.headRatio);
  const headRatio = Math.min(0.9, Math.max(0.1, Number.isFinite(hr) ? hr : DEFAULT_HEAD_RATIO));

  // 标记本身要占字符：先估一个足够宽松的余量，再按剩下的分头尾。
  const markerFor = (n) => `\n\n[⚠️ 工具结果过长，中间已省略 ${n} 字（保留开头与结尾；这不是完整结果）。${String(opts.hint || '需要中间部分请缩小查询范围或分页重取。')}]\n\n`;
  // 用"最多丢掉多少"来估标记长度，避免反复重算：迭代两次就足够收敛。
  let headChars = Math.floor(maxChars * headRatio);
  let tailChars = maxChars - headChars;
  for (let i = 0; i < 3; i += 1) {
    const markerLen = markerFor(before).length;
    const room = Math.max(MIN_SIDE * 2, maxChars - markerLen);
    headChars = Math.max(MIN_SIDE, Math.floor(room * headRatio));
    tailChars = Math.max(MIN_SIDE, room - headChars);
    if (headChars + tailChars + markerLen <= maxChars) break;
  }

  const headEnd = snapHead(src, headChars);
  const tailStart = snapTail(src, Math.max(headEnd, before - tailChars));
  if (tailStart <= headEnd) {
    // 极端情况（一整行就有几万字）：退回硬切，但仍然是头尾各留一半。
    // ⚠️ 两个下限：① 每边至少 MIN_SIDE；② **头尾不许重叠** —— 原文本来就不长时
    //    "截断一半"会把同一段文字算两次，dropped 变成负数、结果反而更长。
    //    这种情况直接放弃截断（宁可超一点，也不产生一段重复内容）。
    const markerLen = markerFor(before).length;
    const room = Math.max(MIN_SIDE, maxChars - markerLen);
    const half = Math.min(Math.max(MIN_SIDE, Math.floor(room / 2)), Math.floor(before / 2));
    if (half * 2 >= before) {
      return { text: src, changed: false, before, after: before, dropped: 0 };
    }
    const head = src.slice(0, half);
    const tail = src.slice(-half);
    const droppedHard = before - head.length - tail.length;
    const outHard = `${head}${markerFor(droppedHard)}${tail}`;
    if (outHard.length >= before) {
      return { text: src, changed: false, before, after: before, dropped: 0 };
    }
    return { text: outHard, changed: true, before, after: outHard.length, dropped: droppedHard };
  }

  const head = src.slice(0, headEnd);
  const tail = src.slice(tailStart);
  const dropped = before - head.length - tail.length;
  const out = `${head}${markerFor(dropped)}${tail}`;
  // 兜底：标记膨胀导致"截断后反而更长"时不动原结果（宁可超一点，也不能越截越大）
  if (out.length >= before) {
    return { text: src, changed: false, before, after: before, dropped: 0 };
  }
  return { text: out, changed: true, before, after: out.length, dropped };
}

/** 给日志用的一句话；没截断返回空串（不要天天报"一切正常"）。 */
export function describeClip(r) {
  if (!r || !r.changed) return '';
  return `工具结果 ${r.before}→${r.after} 字（头尾保留，中间省略 ${r.dropped} 字）`;
}
