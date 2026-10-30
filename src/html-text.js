// 网页/链接的「能读懂」层：URL 归一化 → 解压 → 按真实字符集解码 → HTML 提纯成正文。
//
// 为什么单独一个文件：这三件事以前散在 safe-fetch（只会按 UTF-8 读字节）
// 和调用方（直接把 HTML 前 2 万字丢给模型）里，于是出现了两个真问题：
//   ① 中文站大量是 GBK/GB18030，按 UTF-8 解出来是乱码 → 模型说"网址读不了"；
//   ② 返回的原文里 <script>/<style> 占了大半，正文早被 2 万字截断 → 模型说"没内容"。
// 纯函数、零依赖、不碰网络 —— 全部可以被单测直接断言。

// ── 1. URL 归一化 ────────────────────────────────────────────────────────

// 群友粘链接时最常见的几种"脏输入"：
//   · 没有协议头：b23.tv/abc、www.bilibili.com/video/BV...
//   · 被 Markdown 包住：[标题](https://...)  /  <https://...>
//   · 句尾带中文标点：https://a.com/x。 / https://a.com/x，（中文输入法的锅）
//   · 全角冒号/斜杠：ｈｔｔｐｓ：／／
// 这些都还原成干净 URL；还原不了就返回 ''（调用方如实报错，不瞎猜主机）。
const FULLWIDTH_MAP = { '：': ':', '／': '/', '．': '.', '？': '?', '＝': '=', '＆': '&', '＃': '#', '％': '%' };

export function normalizeUrl(raw) {
  let s = String(raw ?? '');
  // 全角 ASCII 区（！ 到 ～）统一半角化 —— 只对 URL 本身做，标题里不动
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => FULLWIDTH_MAP[ch] || String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.trim();

  // Markdown 链接 [文字](url) → 取括号里的
  const md = s.match(/\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/);
  if (md) s = md[1];
  // 尖括号包裹 <url>
  s = s.replace(/^<(.*)>$/, '$1').trim();

  // 去掉首尾的引号/括号/空白
  s = s.replace(/^["'“”‘’「」『』【】()（）]+/, '');
  // 去掉句尾的标点（中文输入法的句号/逗号/引号最常见；但保留 URL 合法的 & = ? # /）
  s = s.replace(/[，。、；：！？,;:!?"'“”‘’》」』】）)\]]+$/u, '');

  if (!s) return '';

  // 没有协议头：按 http(s) 处理（https 优先，绝大多数站点都吃）
  if (/^\/\//.test(s)) s = 'https:' + s;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // 只在"看起来像域名"时补协议，避免把 "唱首歌" 变成 URL
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$|\?)/i.test(s) && !/^localhost(:\d+)?(\/|$)/i.test(s)) return '';
    s = 'https://' + s;
  }

  try {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    if (!u.hostname || !u.hostname.includes('.') && u.hostname !== 'localhost') return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** 从一段文本里抠出第一个像 URL 的东西（给"他发的这句里有个链接"用）。 */
export function firstUrlIn(text) {
  const s = String(text ?? '');
  const m = s.match(/(?:https?:\/\/|www\.)[^\s<>"'，。、；：！？【】（）]+/i)
    || s.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s<>"'，。、；：！？【】（）]*/i);
  return m ? normalizeUrl(m[0]) : '';
}

// ── 2. 编码 ──────────────────────────────────────────────────────────────

/** 从 Content-Type 头里取 charset（没有就 ''）。 */
export function charsetFromContentType(contentType) {
  const m = String(contentType || '').match(/charset\s*=\s*["']?([\w-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/** 从 HTML 前几 KB 里嗅 <meta charset>。中文站这一步是救命的。 */
export function sniffCharset(buffer, { scanBytes = 4096 } = {}) {
  const head = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, scanBytes).toString('latin1')
    : String(buffer ?? '').slice(0, scanBytes);
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// GBK 家族：Node 的 TextDecoder 认 'gbk'/'gb18030'，但 'gb2312'/'gbk' 统一按 gb18030 解更稳
const CHARSET_ALIAS = {
  gb2312: 'gb18030', gbk: 'gb18030', 'x-gbk': 'gb18030',
  utf8: 'utf-8', 'utf-8': 'utf-8',
  big5: 'big5', 'iso-8859-1': 'windows-1252', latin1: 'windows-1252'
};

export function normalizeCharset(name) {
  const key = String(name || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  return CHARSET_ALIAS[key] || key;
}

/**
 * 把字节按"声明的/嗅到的/猜的"字符集解成文本。
 * 顺序：响应头 > HTML meta > UTF-8 严格试一遍 > gb18030 兜底 > UTF-8 容错。
 * 猜错的代价不对称：乱码等于没读到，所以宁可用 gb18030 再试一次。
 */
export function decodeBody(buffer, { contentType = '', fallback = 'utf-8' } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (!buf.length) return '';

  const candidates = [];
  const push = (name) => {
    const n = normalizeCharset(name);
    if (n && !candidates.includes(n)) candidates.push(n);
  };
  push(charsetFromContentType(contentType));
  push(sniffCharset(buf));
  push(fallback);

  for (const enc of candidates) {
    try {
      const text = new TextDecoder(enc, { fatal: false }).decode(buf);
      // 有替换字符说明解坏了：优先试下一个（但 UTF-8 容错是最后兜底，不再跳）
      if (!text.includes('\uFFFD')) return text;
    } catch { /* 不支持的字符集名，跳过 */ }
  }

  // 全部出现替换字符：再用 gb18030 硬解一次（中文网页最常见）
  for (const enc of ['gb18030', 'utf-8']) {
    try {
      return new TextDecoder(enc, { fatal: false }).decode(buf);
    } catch { /* ignore */ }
  }
  return buf.toString('utf8');
}

// ── 3. HTML → 正文 ───────────────────────────────────────────────────────

// 整块丢掉：脚本/样式/导航/页脚/表单/内联框架。这些是"正文读不出来"的主因。
const DROP_BLOCK = /<(script|style|noscript|svg|canvas|iframe|template|nav|footer|aside|form|select|button)\b[\s\S]*?<\/\1>/gi;
const BLOCK_TAG = /<\/?(p|div|section|article|main|header|li|ul|ol|dl|dt|dd|h[1-6]|tr|table|tbody|thead|pre|blockquote|figure|figcaption|hr|br)\b[^>]*>/gi;

/** 解 HTML 实体（数字实体 + 常见命名实体）。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&(nbsp|ensp|emsp|thinsp);/gi, ' ')
    .replace(/&(amp|lt|gt|quot|apos|#39);/gi, (m, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'"
    }[name.toLowerCase()] ?? m))
    .replace(/&(hellip|mdash|ndash|middot|ldquo|rdquo|lsquo|rsquo|copy|times);/gi, (m, name) => ({
      hellip: '…', mdash: '—', ndash: '–', middot: '·', ldquo: '“', rdquo: '”',
      lsquo: '‘', rsquo: '’', copy: '©', times: '×'
    }[name.toLowerCase()] ?? m));
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

export function extractTitle(html) {
  const m = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * HTML → 可读正文。
 * 保留段落换行（比一整行更好读，也更省 token），丢掉 script/style/导航/页脚。
 * @returns {{title:string, text:string}}
 */
export function htmlToText(html, { maxChars = 20000 } = {}) {
  let s = String(html ?? '');
  if (!s) return { title: '', text: '' };

  const title = extractTitle(s);

  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 隐藏元素（display:none / visibility:hidden / aria-hidden）里常藏着模板文本
  s = s.replace(/<(\w+)[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(DROP_BLOCK, ' ');
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, ' ');
  // 块级标签 → 换行；行内标签直接剥掉（不要给 <span> 加空格，会把词切断）
  s = s.replace(BLOCK_TAG, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // 全角空格/不换行空格统一成普通空格
  s = s.replace(/[\u00a0\u3000]/g, ' ');

  const lines = s.split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean);

  // 连续重复行（版权声明/菜单）只留一份，最多连续 2 次
  const out = [];
  for (const line of lines) {
    if (out.length >= 2 && out[out.length - 1] === line && out[out.length - 2] === line) continue;
    out.push(line);
  }
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
  return { title, text };
}

/** 正文是不是"基本没内容"（JS 渲染站/需要登录的常见表现），供调用方给出人话提示。 */
export function looksEmptyBody(text) {
  const t = String(text ?? '').replace(/\s+/g, '');
  return t.length < 120;
}
