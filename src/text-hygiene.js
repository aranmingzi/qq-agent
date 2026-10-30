// 请求体文本卫生：把**孤立代理项**（lone surrogate）摘掉再发给模型。
//
// 为什么需要它（2026-10-25 从 qq-bridge 媒体能力包的 text-hygiene.js 学到）：
//   JS 字符串是 UTF-16。一个 emoji（比如 😂 = "\uD83D\uDE02"）由两个码元组成。
//   只要有人用 `str.slice(0, n)` 按码元截断、或逐码元拼串，就可能把一对代理项
//   切成两半，留下孤立的 "\uD83D"。
//
//   孤立代理项**不是合法 Unicode**，`JSON.stringify()` 不报错，而是照样输出
//   转义序列 `"\ud83d"`。服务端 json 解析可能直接 400，也可能解析后整条被拒 ——
//   表现是"这一轮莫名失败"，日志里只有一个 400，完全看不出是哪个字的问题。
//
//   我们自己在哪儿会切出半个 emoji：
//     · tool-result-budget.js 按字符截工具结果（头 40% + 尾 60%）；
//     · 各处 `String(x).slice(0, N)` 的摘要/印象/笔记；
//     · 群名片、引用原文这类外部字符串本身就可能被上游切坏。
//   与其在十几处分别防，不如**在出站前统一收口**（和 gateBeforeSend 同一个思路）。
//
// 纪律：只删孤立的，不动成对的。emoji 必须原样活下来 —— 删多了等于把人家的表情
// 吃掉，比 400 更难发现。

/** 高代理项 U+D800–U+DBFF */
function isHigh(code) { return code >= 0xd800 && code <= 0xdbff; }
/** 低代理项 U+DC00–U+DFFF */
function isLow(code) { return code >= 0xdc00 && code <= 0xdfff; }

/**
 * 清洗单个字符串。**没变化时返回原引用**，调用方可用 `!==` 判断是否真的改了。
 * @param {string} input
 * @param {{removed:number}} [stats] 累计删掉的码元数
 * @returns {string}
 */
export function sanitizeString(input, stats = null) {
  const s = String(input ?? '');
  if (!s) return s;
  // data URI（内联图片的 base64）按定义是 ASCII，不可能含代理项；
  // 而且动辄几 MB，没必要每个字符扫一遍。
  if (s.startsWith('data:') && s.length > 512) return s;
  // 2026-10-26：原先 >2MB 直接返回原串，等于静默放弃清洗 —— 而"整条请求 400"
  // 恰恰最容易发生在大请求上（长对话塞了很多图）。扫描是 O(n)，2MB 也就几毫秒，
  // 不该为了省这点时间留一个静默漏洞。

  // 快路径：绝大多数字符串里没有代理项（中文/英文/常见符号都不在 D800–DFFF）
  let hasAny = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (isHigh(c) || isLow(c)) { hasAny = true; break; }
  }
  if (!hasAny) return s;

  let out = '';
  let dirty = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (isHigh(c)) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (isLow(next)) {
        out += s[i] + s[i + 1];   // 成对：整对保留
        i += 1;
      } else {
        dirty = true;             // 孤立高代理项：删
        if (stats) stats.removed += 1;
      }
      continue;
    }
    if (isLow(c)) {               // 走到这里说明前面不是高代理项 → 孤立低代理项
      dirty = true;
      if (stats) stats.removed += 1;
      continue;
    }
    out += s[i];
  }
  return dirty ? out : s;
}

const MAX_DEPTH = 12;

function walk(value, depth, stats) {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return sanitizeString(value, stats);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const r = walk(v, depth + 1, stats);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    // 只处理 plain object；Buffer / TypedArray / Date 等原样放过
    if (value.constructor && value.constructor !== Object) return value;
    let changed = false;
    const next = {};
    for (const [k, v] of Object.entries(value)) {
      const key = sanitizeString(k);
      if (key !== k) changed = true;
      const r = walk(v, depth + 1, stats);
      if (r !== v) changed = true;
      next[key] = r;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * 深遍历对象/数组，清洗其中所有字符串。**没变化时返回原引用**。
 * @param {any} value
 * @param {{removed:number}} [stats] 传入一个 `{removed:0}` 就能拿到删了多少
 */
export function sanitizeDeep(value, stats = null) {
  const s = stats && typeof stats === 'object' ? stats : { removed: 0 };
  if (!Number.isFinite(s.removed)) s.removed = 0;
  return walk(value, 0, s);
}

/** 给日志/诊断用：数一下有多少个孤立代理项（不修改原串）。 */
export function countLoneSurrogates(input) {
  const stats = { removed: 0 };
  sanitizeString(String(input ?? ''), stats);
  return stats.removed;
}

// ⚠️ 一个容易走错的方向（记下来免得后人再试一遍）：
//   对**已经 stringify 完的 JSON 文本**做同样的清洗是没有用的。ES2019 起
//   `JSON.stringify` 是 well-formed 的，孤立代理项会被转义成 6 个 ASCII 字符
//   `\ud83d`，那个字符串本身就是合法 UTF-16 —— 扫不出任何"孤立代理项"，
//   而服务端解析完仍然得到非法字符串。所以**必须在 stringify 之前**清对象。
