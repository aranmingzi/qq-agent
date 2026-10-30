/**
 * QQ 内置表情（face 段）识别。
 *
 * 背景：OneBot 的 face 段只给一个数字 id（{ type:'face', data:{ id:'182' } }），
 * 以前 segmentsToText 直接拼成「[表情182]」—— 模型和人（控制台/存档）都认不出这是哪个表情，
 * 而且 orchestrator 里判断"只发了个表情"的正则只认「[表情]」，带 id 的永远匹配不上。
 *
 * 现在统一成三种写法：
 *   [表情]            —— 认不出来的 id（不再带裸数字）
 *   [表情:笑哭]        —— 认识的表情，带名字
 *   [表情包:狗头]      —— mface（商城表情/大表情/表情包）
 *
 * 映射表来自 NapCat 自带的 qface 表，由 tools/gen-qq-face.mjs 生成到 src/data/qq-face.json。
 * 表结构：{ "182": { "n": "笑哭", "e": "252" } }，n=名字，e=QQ 表情图号（e{e}.gif）。
 */
import fs from 'node:fs';

const FACE_FILE = new URL('./data/qq-face.json', import.meta.url);

let FACE_TABLE = {};
try {
  FACE_TABLE = JSON.parse(fs.readFileSync(FACE_FILE, 'utf8')) || {};
} catch {
  // 表丢了也不能让消息解析挂掉：全部退化成 [表情]
  FACE_TABLE = {};
}

/** 表情图 CDN（腾讯 QQ 自带表情图，e100.gif = 微笑）。离线时前端自己回退成名字。 */
const FACE_IMG_BASE = 'https://qzonestyle.gtimg.cn/qzone/em/';

/** id → { id, name, em } | null */
export function faceInfo(id) {
  const key = String(id ?? '').trim();
  if (!/^\d+$/.test(key)) return null;
  const row = FACE_TABLE[key];
  if (!row || !row.n) return null;
  return { id: key, name: row.n, em: row.e ? String(row.e) : '' };
}

export function faceName(id) {
  return faceInfo(id)?.name || '';
}

export function faceImageUrl(em) {
  const code = String(em ?? '').trim();
  return /^\d+$/.test(code) ? `${FACE_IMG_BASE}e${code}.gif` : '';
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** OneBot face 段 → 可读文本 */
export function faceText(id) {
  const name = faceName(id);
  return name ? `[表情:${name}]` : '[表情]';
}

/** OneBot mface 段（商城表情/大表情/表情包）→ 可读文本 */
export function marketFaceText(data) {
  const raw = String(data?.summary ?? data?.text ?? data?.name ?? '').trim();
  const name = clip(raw.replace(/^[[【]|[\]】]$/g, '').trim(), 12);
  return name ? `[表情包:${name}]` : '[表情包]';
}

/**
 * 把历史存档里的旧写法（[表情182] / [表情:笑哭] / [表情 ： 笑哭]）统一成标准写法。
 * 读盘时过一道，老数据不用改文件就能变可读；对新数据是幂等的。
 */
export function normalizeFaceText(input) {
  const s = String(input ?? '');
  if (!s.includes('[表情')) return s;
  return s.replace(/\[表情(?!包)\s*(?:[:：]\s*)?([^[\]]*)\]/g, (_whole, payload) => {
    const body = String(payload ?? '').trim();
    if (!body) return '[表情]';
    if (/^\d+$/.test(body)) return faceText(body);
    return `[表情:${body.replace(/^[:：]\s*/, '')}]`;
  });
}

/** 给前端用的完整映射（控制台据此显示表情图 + 名字） */
export function qqFaceTable() {
  return FACE_TABLE;
}

// 「这条消息只有一个表情」——连续对话收口用（只发表情不等于在打字）。
// 注意：老写法的 [表情182] 会先被 normalizeFaceText 规整成 [表情:笑哭]，所以这里只认新写法 + 裸 [表情]。
const STICKER_ONLY_RE = /^(?:\[(?:表情|表情包)(?::[^[\]]*)?\]\s*)+$/;

export function isStickerOnlyText(text) {
  return STICKER_ONLY_RE.test(String(text ?? '').trim());
}
