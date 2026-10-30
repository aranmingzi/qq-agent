import { api } from '@/lib/api';

/**
 * QQ 内置表情的解析与展示。
 *
 * 后端把 face 段写成「[表情:笑哭]」「[表情包:狗头]」，认不出来的写「[表情]」。
 * 这里负责把这种标记切成 token，控制台据此显示真的 QQ 表情图（拿不到就退回名字）。
 * 映射表来自 GET /api/qq-faces（NapCat 的 qface 表，见 tools/gen-qq-face.mjs）。
 */

export interface QqFace {
  name: string;
  em: string;
}

export type FaceToken =
  | { kind: 'text'; text: string }
  | { kind: 'face'; name: string; em: string }
  | { kind: 'pack'; name: string };

const FACE_IMG_BASE = 'https://qzonestyle.gtimg.cn/qzone/em/';

/** 表情图地址（腾讯 QQ 自带表情图）。没有图号就返回空串。 */
export function faceImageUrl(em: string) {
  const code = String(em ?? '').trim();
  return /^\d+$/.test(code) ? `${FACE_IMG_BASE}e${code}.gif` : '';
}

// 一整张表只拉一次：存档页 + 会话详情页共用同一份
let cache: Record<string, QqFace> | null = null;
let pending: Promise<Record<string, QqFace>> | null = null;

export function cachedQqFaces() {
  return cache;
}

export function loadQqFaces() {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = api
      .qqFaces()
      .then((faces) => {
        cache = faces;
        return faces;
      })
      .catch(() => {
        // 拉不到就当作没有图号：一律显示名字，不影响阅读
        cache = {};
        return cache as Record<string, QqFace>;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

// 名字 → 表情（后端写进来的新数据只有名字，要反查图号才能出图）
let byNameCache: Record<string, QqFace> | null = null;
let byNameSource: Record<string, QqFace> | null = null;

function faceByName(faces: Record<string, QqFace>, name: string): QqFace | null {
  if (!byNameCache || byNameSource !== faces) {
    const index: Record<string, QqFace> = {};
    for (const face of Object.values(faces)) {
      if (face.name && !index[face.name]) index[face.name] = face;
    }
    byNameCache = index;
    byNameSource = faces;
  }
  return byNameCache[name] ?? null;
}

// [表情] / [表情:笑哭] / [表情182] / [表情包:狗头]
const FACE_TAG = /\[(表情包?)\s*(?:[:：]\s*)?([^[\]]*)\]/g;

/** 把消息正文切成「普通文本 + 表情」token */
export function parseFaceTokens(text: string, faces: Record<string, QqFace> = {}): FaceToken[] {
  const source = String(text ?? '');
  if (!source.includes('[表情')) return source ? [{ kind: 'text', text: source }] : [];

  const tokens: FaceToken[] = [];
  let cursor = 0;
  FACE_TAG.lastIndex = 0;
  for (let match = FACE_TAG.exec(source); match; match = FACE_TAG.exec(source)) {
    const [whole, kind, payload] = match;
    const index = match.index;
    if (index > cursor) tokens.push({ kind: 'text', text: source.slice(cursor, index) });
    cursor = index + whole.length;

    const body = String(payload ?? '').trim().replace(/^[:：]\s*/, '');
    // 长的「[表情包：xx 场景=xx]」是机器人发表情时记下的描述，当正文读更合适，别做成大标签
    if (body.length > 12) {
      tokens.push({ kind: 'text', text: whole });
      continue;
    }
    if (kind === '表情包') {
      tokens.push({ kind: 'pack', name: body || '表情包' });
      continue;
    }
    // 老数据是裸 id（[表情182]），新数据是名字（[表情:笑哭]）
    const byId = /^\d+$/.test(body) ? (faces[body] ?? null) : null;
    const face = byId ?? faceByName(faces, body);
    if (face) tokens.push({ kind: 'face', name: face.name, em: face.em });
    else if (body && !/^\d+$/.test(body)) tokens.push({ kind: 'face', name: body, em: '' });
    else tokens.push({ kind: 'face', name: '表情', em: '' });
  }
  if (cursor < source.length) tokens.push({ kind: 'text', text: source.slice(cursor) });
  return tokens;
}
