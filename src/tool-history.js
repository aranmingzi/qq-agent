/**
 * 历史工具结果清理 —— Anthropic 说的"最轻的压缩"。
 *
 * ── 为什么需要这个文件 ──────────────────────────────────────────────
 * `src/tool-result-budget.js` 只在**工具结果当轮进历史时**截一次（头 40% +
 * 尾 60%，上限 12000 字符）。但工具轮会一直堆在 `messages` 里：
 * `src/orchestrator.js` 的 `messages.push(...toolResults...)` 之后**从不裁剪**，
 * 于是第 1 轮那份 12000 字符的搜索结果，会一直躺在第 6 轮的上下文里。
 *
 * 而模型的注意力根本用不上它 —— 那时它已经在第 4 轮基于那份结果做过判断了。
 * Anthropic 的上下文工程里把这件事叫 tool result clearing：
 * 「最轻的压缩是清掉那些深在历史里的工具原始结果」。
 *
 * ── 为什么不能直接删除那些消息 ──────────────────────────────────────
 * OpenAI 兼容接口对 tool 消息的配对是**硬校验**：
 * assistant 消息里的每个 `tool_calls[i].id` 都必须有一条 `role:'tool'` 且
 * `tool_call_id` 相同的消息跟上，否则直接 400（`must be followed by tool messages`）。
 * 所以这里只**替换 content**，绝不动 `role` / `tool_call_id` / `name` / 顺序 / 条数。
 * 这条不变量是本模块最重要的契约，`test/test-tool-history.mjs` 用深比较锁死它。
 *
 * ── 为什么按"轮"而不是按"条" ────────────────────────────────────────
 * AstrBot 的压缩逻辑里有一条经验：工具调用与其结果必须**成组**处理，
 * 否则会留下不完整的调用记录。这里的"轮"= 一条带 `tool_calls` 的 assistant
 * 消息 + 紧随其后的若干 tool 消息。
 *
 * ── 为什么保留最近 N 轮 ─────────────────────────────────────────────
 * 最近几轮是模型"正在想的事"，清掉会让它本轮答非所问。
 * 默认留 2 轮，紧急时（如 P0-1 的 token 超阈值）降到 1 轮。
 */

/** 默认保留最近几轮的工具结果原文。 */
export const KEEP_RECENT_ROUNDS = 2;

/** 低于这个长度的工具结果不值得清 —— 换成占位符反而更费 token。 */
export const MIN_CLEAR_CHARS = 400;

/**
 * 把 messages 切成"轮"。
 * 返回 [{ start, end, toolIndexes }]，index 是 messages 数组下标区间 [start, end)。
 * `toolIndexes` 是本轮里 tool 消息的下标。
 *
 * 非工具消息各自成"轮"（长度为 1、toolIndexes 为空），这样"最近 2 轮"的语义
 * 在纯对话历史里退化成"最近 2 条"，也说得通。
 */
export function splitRounds(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const rounds = [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    const hasCalls = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
    if (hasCalls) {
      const start = i;
      const toolIndexes = [];
      i += 1;
      while (i < list.length && list[i]?.role === 'tool') {
        toolIndexes.push(i);
        i += 1;
      }
      rounds.push({ start, end: i, toolIndexes });
      continue;
    }
    rounds.push({ start: i, end: i + 1, toolIndexes: [] });
    i += 1;
  }
  return rounds;
}

/** 占位符：明确告诉模型"这里原来有东西，要的话重新取"。 */
export function placeholderOf(chars, name = '') {
  const tool = name ? `「${name}」` : '';
  return `[已清理：${tool}原结果 ${chars} 字，为省上下文已移除。需要的话用工具重新取一次。]`;
}

/**
 * 清掉"深在历史里"的工具结果。
 *
 * @param {Array} messages OpenAI 格式消息数组（不改入参）
 * @param {{ keepRecentRounds?: number, minChars?: number, protectLast?: number }} [opts]
 * @returns {{ messages: Array, cleared: number, savedChars: number, rounds: number }}
 */
export function clearStaleToolResults(messages, {
  keepRecentRounds = KEEP_RECENT_ROUNDS,
  minChars = MIN_CLEAR_CHARS,
  protectLast = 0
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Math.max(0, Math.floor(Number(keepRecentRounds) || 0));
  const min = Math.max(0, Math.floor(Number(minChars) || 0));
  const tail = Math.max(0, Math.floor(Number(protectLast) || 0));

  // 先浅拷贝一层：消息对象本身不改，只换需要换的 content
  const out = list.slice();
  const rounds = splitRounds(list);
  // 从后往前数"最近 keep 轮"的起点：这些轮一律不动
  const keepFrom = keep > 0 ? Math.max(0, rounds.length - keep) : rounds.length;

  let cleared = 0;
  let savedChars = 0;

  for (let r = 0; r < keepFrom; r += 1) {
    const round = rounds[r];
    for (const idx of round.toolIndexes) {
      if (tail > 0 && idx >= list.length - tail) continue;
      const m = list[idx];
      const content = typeof m?.content === 'string' ? m.content : '';
      if (content.length < Math.max(1, min)) continue;
      // 已经是占位符了就别再套一层（重复清理会把占位符越滚越长）
      if (content.startsWith('[已清理：')) continue;
      const next = { ...m, content: placeholderOf(content.length, m?.name) };
      out[idx] = next;
      cleared += 1;
      savedChars += content.length - next.content.length;
    }
  }

  return { messages: out, cleared, savedChars: Math.max(0, savedChars), rounds: rounds.length };
}

/** 给日志用的一行；什么都没清返回空串（不刷屏）。 */
export function describeClearing(result, { keepRecentRounds = KEEP_RECENT_ROUNDS } = {}) {
  if (!result || !result.cleared) return '';
  const keep = Math.max(0, Math.floor(Number(keepRecentRounds) || 0));
  const tail = keep > 0 ? `，保留最近 ${keep} 轮原文` : '';
  return `[上下文] 清理旧工具结果 ${result.cleared} 条，省 ${result.savedChars} 字${tail}`;
}
