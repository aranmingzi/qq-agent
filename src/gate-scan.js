// 规则扫描引擎：**一次遍历跑完所有规则**，单条规则出错折成哨兵、不中断整轮。
//
// 为什么要单独一层（学自 Estrella-Bot `gate-scan.js`，2026-10-22 调研的 P0-2）：
//   我们原先有三处"规则表 + for 遍历"（出口凭据、语言卫生、画像统计），
//   每处各自写 try/catch，于是同一个坑反复踩：
//     · 某条规则抛错 → 整个 for 中断 → **后面的规则全部没执行**，而且日志里只有一条 stack；
//     · 想把"规则坏了"当成"命中了"还是"没命中"，只能改那一处的 if，改一处不影响别处；
//     · 加一条规则要动三个文件。
//
// 三条纪律：
//   ① **单一遍历**：所有规则一次跑完，不 early return（要跑完才知道总共命中几条）；
//   ② **哨兵**：单条规则抛错产出 `{kind: GATE_ERROR}` 而不是抛出 —— 于是"没命中"与"闸门坏了"
//      在返回值里是两种东西，能被分别统计、分别处置（这正是它那边 `GATE_ERROR_KIND` 的用处）；
//   ③ **失败方向由调用方声明**：引擎只回答 `{blocked}`，`blockOnError` 是入参。
//      出口闸门（发出去就收不回）用 true；只观测的规则（注入痕迹）用 false。
//      两种方向都对，混用才是错的。
//
// 纯函数：规则是数据，文本是入参，不读配置、不碰磁盘。

/** 哨兵：规则自身出错的标记。**不要**把它当成一种"命中内容"。 */
export const GATE_ERROR = 'gate-error';

/** 命中的严重度，由规则自己声明；引擎不解释语义。 */
export const SEVERITY = { BLOCK: 'block', WARN: 'warn' };

/**
 * 把一条规则跑成 0..n 个命中。
 * 规则形状：
 *   { id, kind, severity, pattern: RegExp | string, flags?, note? }
 *   { id, kind, severity, test: (text) => null | {match, index} }   // 复杂规则用 test
 *
 * 用 `matchAll` 而不是 `replace`：我们要**位置**（好给日志指到哪一段），不要改写原文。
 */
function runRule(rule, text) {
  const out = [];
  const id = String(rule?.id || '(未命名规则)');
  const kind = String(rule?.kind || id);
  const severity = rule?.severity === SEVERITY.WARN ? SEVERITY.WARN : SEVERITY.BLOCK;

  if (typeof rule?.test === 'function') {
    const hit = rule.test(text);
    if (hit) {
      out.push({ id, kind, severity, index: Number(hit.index) || 0, length: Number(hit.length) || 0, note: rule.note || '' });
    }
    return out;
  }

  let re = rule?.pattern;
  if (typeof re === 'string') re = new RegExp(re, String(rule?.flags || 'g'));
  if (!(re instanceof RegExp)) {
    throw new Error(`规则 ${id} 既没有 pattern 也没有 test`);
  }
  // 强制全局：非 g 的正则只能用一次，会漏掉第二条凭据（真实踩过）。
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const scan = new RegExp(re.source, flags);
  let m;
  let guard = 0;
  while ((m = scan.exec(text)) !== null && guard < 50) {
    guard += 1;
    out.push({ id, kind, severity, index: m.index, length: m[0].length, note: rule.note || '' });
    if (m[0].length === 0) scan.lastIndex += 1;   // 零宽匹配防死循环
  }
  return out;
}

/**
 * 单一遍历。
 *
 * @param {Array} rules
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxHits=20]   命中条数上限（防一条长文本炸出几万条日志）
 * @param {number} [opts.maxChars=200000] 超长文本只扫前 N 字符，并在返回里标 truncated
 * @param {boolean} [opts.blockOnError] 规则自身出错时算不算"拦下"
 * @returns {{hits:Array, errors:Array, blocked:boolean, truncated:boolean, checked:number}}
 */
export function scanRules(rules, text, opts = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const maxHits = Math.max(1, Number(opts.maxHits) || 20);
  const maxChars = Math.max(1000, Number(opts.maxChars) || 200000);
  const blockOnError = opts.blockOnError === true;

  const raw = String(text ?? '');
  const truncated = raw.length > maxChars;
  const subject = truncated ? raw.slice(0, maxChars) : raw;

  const hits = [];
  const errors = [];

  // ⚠️ 这里是"单一遍历"本身：一个 for，不嵌套、不早退。
  //    任何规则抛错都被收成哨兵，循环继续 —— 少了这一步，第 3 条规则报错
  //    会让第 4..N 条集体失声，而日志只会说"某处出错"。
  for (const rule of list) {
    try {
      for (const hit of runRule(rule, subject)) {
        if (hits.length < maxHits) hits.push(hit);
      }
    } catch (error) {
      const entry = {
        id: String(rule?.id || '(未命名规则)'),
        kind: GATE_ERROR,
        message: String(error?.message ?? error)
      };
      errors.push(entry);
      if (hits.length < maxHits) {
        hits.push({ ...entry, severity: blockOnError ? SEVERITY.BLOCK : SEVERITY.WARN, index: 0, length: 0 });
      }
    }
  }

  const blocked = hits.some((h) => h.severity === SEVERITY.BLOCK)
    || (blockOnError && errors.length > 0);

  return { hits, errors, blocked, truncated, checked: list.length };
}

/** 只取"真命中"（排除哨兵）—— 统计与展示用，绝不用于拦截判定。 */
export function realHits(result) {
  return (result?.hits || []).filter((h) => h.kind !== GATE_ERROR);
}

/** 命中 → 一行中文说明（给日志；**不含**命中的原文，避免二次泄露）。 */
export function describeHits(result, { includeNote = true } = {}) {
  if (!result) return '';
  const bits = [];
  for (const h of realHits(result)) {
    bits.push(includeNote && h.note ? `${h.id}（${h.note}）` : h.id);
  }
  if (result.errors?.length) bits.push(`规则自身出错 ${result.errors.map((e) => e.id).join('/')}`);
  if (result.truncated) bits.push('文本过长，只扫了前段');
  return bits.join('、');
}
