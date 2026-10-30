// 工具名的**拼错复原**：模型把 `get_message_images` 写成 `get_ message_images`（多一个空格）、
// 或少一个下划线时，回调不该只回一句"未知工具"就完 —— 它得知道"你是想调这个吧"。
//
// ── 为什么需要它（2026-10-29 实测）──
// 1000 份真实会话里出现过一次 `未知工具 get_ message_images`：
// 模型**意图完全正确**（它要看图、参数也对），只是名字里插了一个空格。
// 它拿到"未知工具"之后没有重试，那一轮直接放弃了 —— 用户看到的是"它没理我"。
//
// 同类失败在真实数据里的共同特征：**名字是对的、拼写差一点点**，
// 而报错只说"未知"，不给候选，模型就无从修正。
//
// ── 纪律 ────────────────────────────────────────────────────────────
//   ① 只在**确实存在**候选时提示；猜不出就照旧说"未知工具"，绝不编一个不存在的名字；
//   ② 相似度门槛偏高，宁可漏提示也不要误导模型去调一个不相干的工具；
//   ③ 纯函数：不读配置、不看时间、不碰磁盘 —— 工具名表由调用方传入。
//
// ── 为什么不复用 song-router 的 nameScore（2026-10-29 踩过）──────────────
// 第一版图省事用了 `nameScore`（中文歌名的 CJK 二元组 + Dice），结果：
// `nameScore('send_stickr','send_sticker') = 0.674` —— 因为它对非精确匹配
// **乘了 0.8 的折扣**（`dice >= 0.45 ? dice * 0.8 : 0`），上限就是 0.8。
// 而我把门槛设在 0.82，于是模糊路径**永远不可能命中**，整条通道是死的。
// 工具名是纯 ASCII 的 snake_case，字符级编辑距离比 CJK 二元组可靠得多 ——
// 这里自己实现一份，不为复用而复用。

/**
 * 把工具名归一成"可比较"的形态。
 *
 * 去空白、转小写、把各种分隔符统一成 `_` 再删掉 ——
 * 于是 `get_message_images` / `get_message_images` / `getMessageImages` 会落到同一个键。
 * @param {string} name
 */
export function normalizeToolName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    // 各种分隔符先统一：空格、连字符、点、全角下划线都当成 `_`
    .replace(/[\s\-.\uFF3F]+/g, '_')
    // 再全部删掉：`get_message_images` 与 `getmessageimages` 从此等价
    .replace(/_/g, '');
}

/**
 * 字符级相似度：`1 - 编辑距离 / 较长者长度`。
 *
 * 只用于 ASCII 标识符，所以按码元逐字比较就是对的（不需要字形归一）。
 * 空串互相比较返回 0（不是 1）—— "两个都没有"不算相似。
 * @param {string} a
 * @param {string} b
 */
export function editSimilarity(a, b) {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const n = x.length;
  const m = y.length;
  // 滚动数组算 Levenshtein：工具名都很短，这里不必担心内存。
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const dist = prev[m];
  return 1 - dist / Math.max(n, m);
}

/** 首个 token（`send_message` → `send`）。用于排除"动作完全不同"的候选。 */
function headToken(name) {
  return String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || '';
}

/**
 * 从候选里找出"模型真正想调的那个"。
 *
 * @param {string} name            模型给的名字（可能是拼错的）
 * @param {string[]} available     当前会话**实际挂着**的工具名
 * @param {object} [opts]
 * @param {(a:string,b:string)=>number} [opts.score] 相似度函数，缺省 `editSimilarity`
 * @param {number} [opts.minScore] 相似度门槛（默认 0.82）
 * @returns {{name:string, score:number, via:'normalized'|'similar'} | null}
 */
export function suggestToolName(name, available = [], { score = null, minScore = 0.82 } = {}) {
  const raw = String(name ?? '').trim();
  const pool = (Array.isArray(available) ? available : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  if (!raw || !pool.length) return null;
  // 已经精确命中就不该走到这里（调用方先查表）；但保险起见直接返回 null，
  // 免得把"完全正确的名字"当成拼错。
  if (pool.includes(raw)) return null;

  // ── 第一优先：归一化后完全相等 ──────────────────────────────────────
  // 这是最常见也最该抓住的一类：多一个空格、少一个下划线、大小写不同。
  // 它比任何模糊相似度都可靠，所以排在前面且不受 minScore 约束。
  const nk = normalizeToolName(raw);
  for (const candidate of pool) {
    if (normalizeToolName(candidate) === nk) {
      return { name: candidate, score: 1, via: 'normalized' };
    }
  }

  // ── 第二优先：模糊相似度 ──────────────────────────────────────────
  // 门槛偏高是刻意的：工具名之间的编辑距离天然很近
  // （`send_message` / `send_sticker` / `send_image` 共享前缀），
  // 门槛一松就会把"想发表情"猜成"想发消息"—— 那比不猜更糟。
  //
  // ★ 额外的硬闸：**首 token 必须一致**。`get_message_images` 拼错成
  //   `get_mesage_images` 该猜中；但 `web_search` 拼错成 `web_serch` 时，
  //   绝不能被猜成 `get_recent_messages`（首 token 不同 = 动作族不同）。
  const fn = typeof score === 'function' ? score : editSimilarity;
  const rawHead = headToken(raw);
  let best = null;
  for (const candidate of pool) {
    if (rawHead && headToken(candidate) !== rawHead) continue;
    let s = 0;
    try { s = Number(fn(raw, candidate)) || 0; } catch { s = 0; }
    if (!(s >= minScore)) continue;
    if (!best || s > best.score) best = { name: candidate, score: s, via: 'similar' };
  }
  return best;
}

/**
 * 拼一句给人话的提示。没有候选时返回空串（调用方照旧说"未知工具"）。
 *
 * 措辞刻意点明"你是想调这个吧"：模型看到候选才会去改，光说"未知"它只会放弃。
 * @param {string} name
 * @param {object|null} suggestion  suggestToolName 的返回值
 */
export function describeToolSuggestion(name, suggestion) {
  if (!suggestion) return '';
  const why = suggestion.via === 'normalized' ? '名字里多了/少了点东西' : '和某个工具很像';
  return `没有叫「${String(name ?? '').trim()}」的工具。你是想调 \`${suggestion.name}\` 吧（${why}）？改用它重试。`;
}
