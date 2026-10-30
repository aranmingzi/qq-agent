// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
// 收藏表情的本地副本目录：QQ 消息里的图片是带 rkey 的临时链接，过期就 404，
// 所以收藏时立刻把图落到这里，发送时优先用本地副本（见 sticker-manager.js / sender.js）。
export const STICKER_FILES_DIR = path.join(DATA_DIR, 'sticker-files');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    localPath: String(entry.localPath ?? '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    disabled: entry.disabled === true,
    disabledReason: String(entry.disabledReason ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      localPath: String(old?.localPath || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      disabled: old?.disabled === true,
      disabledReason: String(old?.disabledReason || '').trim(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

/** 表情本地副本的可用绝对路径（必须是 STICKER_FILES_DIR 内的真实文件，否则返回空串）。 */
export function stickerLocalCopy(entry) {
  const raw = String(entry?.localPath || '').trim();
  if (!raw) return '';
  try {
    const resolved = path.resolve(raw);
    const base = path.resolve(STICKER_FILES_DIR) + path.sep;
    if (!resolved.startsWith(base)) return '';
    if (!fs.statSync(resolved).isFile()) return '';
    return resolved;
  } catch {
    return '';
  }
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

/** 表情场景词表（与 data/stickers.json 里的 tags 同源；改这里要同步重跑表情包索引脚本）。 */
export const STICKER_SCENES = [
  '夸赞', '自夸', '嘲讽', '怼人', '无语', '大笑', '开心', '害羞', '撒娇', '委屈',
  '哭', '震惊', '疑惑', '拒绝', '同意', '鼓励', '摆烂', '困', '吃瓜', '害怕',
  '打招呼', '道别', '道谢', '道歉', '吐槽', 'AI话题', '穷', '催促', '装傻', '嫌弃'
];

/**
 * 自由标签 → 场景词的归一表。
 * 识图模型给的是"得意/自信/笑死"这类自然词，和 30 个场景词表对不上，
 * 于是这些图在「按场景检索」里等于不存在（曾漏掉 7 张，且每批新包都会重犯）。
 * 在读取侧归一，写库不用动，老数据和新包一并生效。
 */
export const SCENE_ALIASES = {
  得意: '自夸', 自信: '自夸', 骄傲: '自夸', 炫耀: '自夸', 最强: '自夸', 厉害: '自夸',
  高兴: '开心', 快乐: '开心', 兴奋: '开心', 愉快: '开心', 治愈: '开心',
  笑死: '大笑', 笑: '大笑', 狂笑: '大笑', 绷不住: '大笑',
  讽刺: '嘲讽', 阴阳怪气: '嘲讽', 嘲笑: '嘲讽', 轻蔑: '嘲讽',
  生气: '怼人', 愤怒: '怼人', 凶: '怼人', 挑衅: '怼人',
  困惑: '疑惑', 懵逼: '疑惑', 问号: '疑惑', 不解: '疑惑',
  难过: '委屈', 伤心: '委屈', 沮丧: '委屈', 委屈巴巴: '委屈',
  流泪: '哭', 大哭: '哭', 泪目: '哭', 崩溃: '哭',
  恐惧: '害怕', 惊吓: '震惊', 惊讶: '震惊', 吃惊: '震惊',
  感谢: '道谢', 谢谢: '道谢', 抱歉: '道歉', 对不起: '道歉',
  再见: '道别', 拜拜: '道别', 晚安: '道别', 早上好: '打招呼', 你好: '打招呼',
  拒绝: '拒绝', 不行: '拒绝', 同意: '同意', 赞成: '同意', 好的: '同意',
  加油: '鼓励', 安慰: '鼓励', 摸头: '鼓励',
  躺平: '摆烂', 放弃: '摆烂', 累: '困', 睡觉: '困', 困倦: '困',
  八卦: '吃瓜', 看戏: '吃瓜', 围观: '吃瓜',
  嫌弃: '嫌弃', 鄙视: '嫌弃', 白眼: '无语', 沉默: '无语',
  可怜: '穷', 吃土: '穷', 没钱: '穷',
  催: '催促', 急: '催促', 装傻: '装傻', 卖萌: '撒娇', 求: '撒娇',
  吐槽: '吐槽', 抱怨: '吐槽', 拆台: '吐槽'
};

/** 把一条表情的自由标签收敛成场景词（保留原标签，只是补充规范词）。 */
export function canonicalScenes(tags) {
  const out = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (STICKER_SCENES.includes(t)) out.add(t);
    const alias = SCENE_ALIASES[t];
    if (alias) out.add(alias);
  }
  return [...out];
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(normalizeStickerEntry)
    .filter(Boolean)
    .filter((e) => !e.disabled); // 停用条目（失效死链）不再暴露给模型
  // 同分数内**不许**按"用得多的排前面"：那是正反馈自锁 —— 模型看到次数高的就当成默认选项，
  // 于是越常用的越常用（实测 3 张吃了 68/90 次）。改成"有用法说明 → 用得少 → 最久没发"，
  // 同一场景反复查，头几条会慢慢换人，这才是"用得更丰富"的来源。
  const q = String(query ?? '').trim().toLowerCase();
  const hasUsage = (e) => (String(e.usage || '').trim() ? 1 : 0);
  const useTier = (e) => {
    const n = Number(e.useCount) || 0;
    if (n >= 10) return 2;
    return n > 0 ? 1 : 0;
  };
  const filtered = q
    ? list
        .map((e) => {
          const scenes = canonicalScenes(e.tags);
          const tags = [...(e.tags || []), ...scenes].map((t) => String(t).toLowerCase());
          const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...tags].join(' ').toLowerCase();
          if (!haystack.includes(q)) return null;
          // 场景标签命中优先：精确等于 > 标签包含 > 仅正文命中
          const score = tags.includes(q) ? 3 : (tags.some((t) => t.includes(q)) ? 2 : 1);
          return { e, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score
          || hasUsage(b.e) - hasUsage(a.e)
          || useTier(a.e) - useTier(b.e)
          || (Number(a.e.lastUsedAt) || 0) - (Number(b.e.lastUsedAt) || 0)
          || (Number(a.e.useCount) || 0) - (Number(b.e.useCount) || 0))
        .map((x) => x.e)
    : [...list].sort((a, b) => hasUsage(b) - hasUsage(a)
      || useTier(a) - useTier(b)
      || (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0)
      || (Number(a.useCount) || 0) - (Number(b.useCount) || 0));
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  // 返回给模型的字段要瘦：localNote 里已经含「用法」，这里截断避免 24 条把上下文撑爆。
  // ⚠️ 不再回 useCount：次数一露出来，模型就把它当"推荐指数"，专挑数字大的 —— 自锁又回来了。
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    usage: e.usage || '',
    localNote: String(e.localNote || '').slice(0, 80),
    tags: e.tags || [],
    fresh: !(Number(e.useCount) > 0)
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 提示词里的【表情包】段：库小就列清单，库大就换成场景索引（否则 500 张清单会灌爆上下文）。
 *
 * @param {boolean} [opts.canQuery=true]  list_stickers 现在真的挂着吗。
 *   ⚠️ 场景索引和"换个池子挑"那句都指向 list_stickers，而它在 stickerBox 包里
 *   —— 那个包只在 2% 的轮次激活。98% 的轮次里这两句是**指向一个她手上没有的工具**：
 *   与技能 SOP 常驻同构的毛病（工具与说明脱钩），只是发生在 user 侧（全价区）。
 *   不传默认 true：离线工具与老调用方行为不变。
 */
export function buildStickerContext(entries, max = 10, opts = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .map(normalizeStickerEntry)
    .filter(Boolean)
    .filter((e) => !e.disabled); // 停用条目不进提示词
  if (!list.length) return '';
  const limit = Math.max(1, Math.min(30, Number(max) || 10));

  const counts = new Map();
  for (const e of list) {
    for (const t of canonicalScenes(e.tags)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const scenes = STICKER_SCENES.filter((s) => (counts.get(s) || 0) >= 2);
  // 注意：不能把各场景张数相加当"已标注数"——一张图有 2~3 个标签，相加会得出比总数还大的数
  const tagged = list.filter((e) => canonicalScenes(e.tags).length > 0).length;

  // ⚠️ 正反馈自锁踩过两次，别再回到"按次数排前面"：
  //   ① 最早摆 useCount 前 6 → 用过的永远占位，新图 useCount=0 永远进不来；
  //   ② 改成"常用 3 + 新面孔 5"之后，那 3 张仍每轮固定在第一屏 —— 实测 610 张库里
  //      前 3 张吃了 68/90 次发送（36/21/11 次），等于招牌口癖。
  // 真因不是"模型偏爱旧图"，而是**没有冷却**：一张图只要随时可用，它就会被反复选。
  // 现在交给 pickStickerCandidates 统一挑（冷却 + 三档配额 + 场景分散），这里只管排版。
  // 另外，凡是摆出来的 id，模型就能**一步直接 send_sticker**，不用先 list_stickers ——
  // 少一次工具往返，是提高使用率的关键（两步流程下模型倾向直接打字）。
  // 12 张是成本与"总能挑到一张"的折中：每行约 45 字，段长 ~900 字；
  // 8 张时有效新图只有 5 张（3 个位置被招牌占着），12 张能把场景铺开。
  const candidates = pickStickerCandidates(list, {
    limit: Math.min(14, limit),
    cooldownMs: opts.cooldownMs,
    dailyCap: opts.dailyCap
  });

  const cut = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const describe = (e) => {
    const name = cut(e.desc || e.localNote || '无备注', 18);
    const hint = cut(String(e.usage || '').replace(/^用法[:：]/, ''), 14);
    const text = /图上字[:：]/.test(String(e.localNote || '')) ? String(e.localNote).match(/图上字[:：]([^｜|]{1,12})/)?.[1] : '';
    const tail = hint || (text ? `图上字「${text}」` : '');
    // 「没发过」是给模型的定心丸：不标出来，它对陌生图会犹豫，宁可退回熟悉的那几张。
    const mark = (e.useCount || 0) > 0 ? '' : '｜没发过';
    return `- ${e.id}｜${name}${tail ? `｜${tail}` : ''}${mark}`;
  };

  const canQuery = opts.canQuery !== false;
  const lines = [];
  const scopeText = tagged >= list.length ? `${list.length} 张` : `${list.length} 张（其中 ${tagged} 张已按场景标注）`;
  lines.push(`【表情包】你能发的表情共 ${scopeText}。`);
  // 场景索引是 list_stickers({query:"场景词"}) 的目录 —— 没有那把钥匙就别摆目录。
  if (scenes.length && canQuery) {
    lines.push(`场景索引（场景=可发张数）：${scenes.map((s) => `${s}${counts.get(s)}`).join(' ')}`);
  }
  if (candidates.length) {
    lines.push('本轮候选（按"发过就别再发"轮换出来的，包括很久没用过的；id 可直接 send_sticker，不用先查）：');
    for (const e of candidates) lines.push(describe(e));
  }
  lines.push(canQuery
    ? '候选里没有对得上当下语气的，就 list_stickers({query:"场景词"}) 换个池子挑；都不合适就别硬发，纯文字也正常。'
    : '候选里没有对得上当下语气的，就别硬发，纯文字也正常。');
  lines.push('候选是轮换的：熟不熟和合不合适无关，desc 对得上就发 —— 别因为没见过就绕回那几张老图。');
  return lines.join('\n');
}

/**
 * 本轮候选表情：冷却 → 三档配额 → 场景分散。
 *
 * 为什么必须有冷却：模型不是"偏爱"旧图，它是**只认识**摆在眼前的 id。
 * 一张图只要随时可用，就会被反复选（实测 610 张库里前 3 张吃了 68/90 次）。
 * 所以"用得更丰富"劝不出来，只能把发过的图先藏起来：默认 6 小时内发过的不进候选，
 * 一天发 10 次表情就自然是 10 张不同的图。
 *
 * 三档配额（老手 1 / 半熟 3 / 全新 4，按 limit 比例）是为了别矫枉过正：
 * 候选里全变成陌生人，模型反而不敢发。永远留一张"保险牌"。
 */
export const PICK_COOLDOWN_MS = 6 * 3600 * 1000;

export function pickStickerCandidates(entries, opts = {}) {
  const limit = Math.max(1, Math.min(30, Number(opts.limit) || 8));
  const now = Number(opts.now) || Date.now();
  const asked = Number(opts.cooldownMs);
  const cooldownMs = Number.isFinite(asked) && asked >= 0 ? asked : PICK_COOLDOWN_MS;
  const rand = typeof opts.random === 'function' ? opts.random : Math.random;

  // 候选必须"有备注 + 真能发"：没备注的发了也不知道是什么，
  // 发不出去的会让模型白挨一次失败（下轮它就更倾向退回老图）。
  const pool = (Array.isArray(entries) ? entries : [])
    .map(normalizeStickerEntry)
    .filter(Boolean)
    .filter((e) => !e.disabled)
    .filter((e) => String(e.desc || e.localNote || '').trim() !== '')
    .filter((e) => String(e.localPath || '').trim() !== '' || /^https?:\/\//i.test(String(e.url || '')));
  if (!pool.length) return [];

  // 冷却分三级放宽：库小或都在冷却期时宁可复用，也不能让候选空着（空着模型就只能打字）
  const idle = (e, ms) => !(Number(e.lastUsedAt) > 0) || now - Number(e.lastUsedAt) >= ms;
  // 今天已经成功发过的图，直接不进候选 —— 和 send_sticker 的 dailyPerIdCap 对齐。
  // 不对齐的话会出现"候选里明明有它、真发却被拦"，模型白挨一次拒绝，下轮更不敢碰新图。
  const dailyCap = Math.max(1, Number(opts.dailyCap) || 1);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const usedToday = (e) => dailyCap <= 1 && Number(e.lastUsedAt) >= dayStart;
  let usable = pool.filter((e) => !usedToday(e) && idle(e, cooldownMs));
  if (usable.length < limit) usable = pool.filter((e) => !usedToday(e) && idle(e, Math.min(cooldownMs, 3600000)));
  if (usable.length < limit) usable = pool.filter((e) => !usedToday(e));
  if (usable.length < limit) usable = pool;

  const shuffled = shuffle(usable, rand);
  /** 标注越全越容易被抽到（有 usage > 多标签），但**不是排固定队** —— 这是加权随机，
   *  同一个"标注很好"的池子每轮抽出来的人不一样。之前用 annot 做全序，
   *  结果 22 张半熟图里标注最全的 5 张永远排前面，等于换一批熟客继续自锁。 */
  const annot = (e) => (String(e.usage || '').trim() ? 2 : 0) + (canonicalScenes(e.tags).length >= 2 ? 1 : 0);
  const weightedOrder = (list, weight = annot) => list
    .map((e) => ({ e, k: Math.pow(Math.max(1e-9, rand()), 1 / (1 + weight(e))) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.e);
  // 招牌之间也要轮：6 小时的抖动让"最近发过"往后靠，同一天里的顺序随机。
  // 不加抖动的话，最久没发的那张会永远占住 veteran 位 —— 换汤不换药的第二块招牌。
  const staleKey = new Map(shuffled.map((e) => [e.id, (Number(e.lastUsedAt) || 0) - rand() * 6 * 3600 * 1000]));
  const byStale = (a, b) => staleKey.get(a.id) - staleKey.get(b.id);
  const tierOf = (e) => {
    const n = Number(e.useCount) || 0;
    if (n >= 10) return 'veteran';
    return n > 0 ? 'known' : 'fresh';
  };
  const buckets = {
    veteran: shuffled.filter((e) => tierOf(e) === 'veteran').sort(byStale),
    known: weightedOrder(shuffled.filter((e) => tierOf(e) === 'known')),
    fresh: weightedOrder(shuffled.filter((e) => tierOf(e) === 'fresh'))
  };
  // 老手位只有三五张图，占满了就又变成招牌：一半的轮次干脆不给老手位，
  // 名额让给新图（她一天能发的表情本来就少，全花在那几张脸上最亏）。
  const quota = {
    veteran: rand() < 0.5 ? 1 : 0,
    known: Math.max(1, Math.round(limit * 0.35))
  };
  quota.fresh = Math.max(0, limit - quota.veteran - quota.known);

  // 场景分散：同一场景最多 ⌈limit/3⌉ 张（12 张候选 → 4 张）。
  // 否则 10 个候选全落在"无语"里，模型还是找不到贴题的那张。
  const cap = Math.max(1, Math.round(limit / 3));
  const sceneUsed = new Map();
  const sceneKeys = (e) => {
    const keys = canonicalScenes(e.tags);
    return keys.length ? keys : ['未标注'];
  };
  const out = [];
  const take = (e, relaxScene = false) => {
    if (out.length >= limit) return false;
    if (out.some((x) => x.id === e.id)) return false;
    if (!relaxScene && sceneKeys(e).some((k) => (sceneUsed.get(k) || 0) >= cap)) return false;
    for (const k of sceneKeys(e)) sceneUsed.set(k, (sceneUsed.get(k) || 0) + 1);
    out.push(e);
    return true;
  };
  const fill = (list, n) => {
    let added = 0;
    for (const e of list) {
      if (added >= n || out.length >= limit) break;
      if (take(e)) added += 1;
    }
    return added;
  };

  fill(buckets.veteran, quota.veteran);
  fill(buckets.known, quota.known);
  fill(buckets.fresh, quota.fresh);
  // 某档为空、或被场景上限挤掉时补齐；顺序上先补新图，老图垫底
  fill(buckets.fresh, limit);
  fill(buckets.known, limit);
  fill(buckets.veteran, limit);
  // 还差就放开场景上限，候选宁可有几张同场景，也不能空着
  if (out.length < limit) {
    for (const e of shuffled) {
      if (out.length >= limit) break;
      take(e, true);
    }
  }
  return out;
}

/** Fisher-Yates；只用于"新面孔"随机轮换，不追求可复现。 */
function shuffle(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：表情是你的另一种回话方式】',
    '- 什么时候发：对方发了表情、你被逗笑/被呛到、想怼人、想自夸、想撒娇、赞同、自嘲、安慰、无语、装傻、告别/晚安——只要有一张能准确替你说出那份情绪，就发它，不用先找话。',
    '- **只发表情也是完整回话**：上面这些场合，一张图比一段字更像真人，这时候不必再补文字。需要说清事实、答疑、解释原因时，才以文字为主（表情可以当尾巴，也可以不配）。',
    '- 频率：想发就发，别攒着；一轮最多 1 张，**同一会话 2 分钟内只能发一张**（换别的图也算超，工具会拦，被拦了这轮就用文字）。别连着两轮都发。',
    '- 一张图一天只发得出去一次，最近几天发过的也不会再进候选（工具硬拦）—— 所以别惦记"我那张顺手的"，直接从本轮候选里挑。',
    '- 怎么发最省事：【表情包】段里的「本轮候选」已经给了 id，凭 desc 对上语气就直接 send_sticker，**不用先 list_stickers**。',
    '- 候选都不合适才去查：list_stickers({query:"场景词"})（场景词见场景索引），从返回里挑 desc/usage 最贴的，再 send_sticker。',
    '- 带字的表情：图上文字的意思优先于画面（localNote 的「图上字：」就是原文），别把反讽当夸奖用；真拿不准那张长什么样，先 get_sticker_image 看一眼，不要瞎发。',
    '- 发送方式：只想用表情回，就只调 send_sticker 不写字；想在群里让人看明白你在回谁，就传 replyToMessageId（聊天记录里那条的 #数字）。想"说一句 + 配一张"，就 send_message 一个气泡、send_sticker 另一个气泡（一条消息只能一张表情，不能同气泡带文字）。',
    '- 不要：在严肃/正式/敏感话题硬塞；反复发同一张；一条消息塞多个表情；把文字和表情混在同一气泡。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

/** 从自己的发言留档里解析表情 id（格式 [表情包：<label>（<id>）]；旧格式没有 id 时返回空串）。 */
export function parseStickerLogId(text) {
  const m = /\[表情包[：:][\s\S]*?（([^（）]{1,120})）\]\s*$/.exec(String(text ?? ''));
  return m ? m[1].trim() : '';
}

/** 表情是否具备发送条件：未停用，且有本地副本或 http(s) 地址。 */
export function isStickerSendable(entry) {
  if (!entry || entry.disabled) return false;
  if (stickerLocalCopy(entry)) return true;
  return /^https?:\/\//i.test(String(entry.url || ''));
}

/** 换发候选排序：本地副本优先 → 标签重合多 → 最近没用过 → 用过最少的。
 *  ⚠️ 这里原本把 useCount 当正向权重，结果"换发"永远换成同一张常用图 ——
 *  换发的意义就是别再糊那张脸，所以次数只做反向着色。 */
export function rankStickerAlternatives(entries, { excludeIds = [], wantTags = [], limit = 2 } = {}) {
  const exclude = new Set((Array.isArray(excludeIds) ? excludeIds : []).map(String));
  const want = new Set((Array.isArray(wantTags) ? wantTags : []).map((t) => String(t).trim()).filter(Boolean));
  const pool = (Array.isArray(entries) ? entries : [])
    .map(normalizeStickerEntry)
    .filter(Boolean)
    .filter((e) => !exclude.has(e.id) && isStickerSendable(e));
  const score = (e) => [stickerLocalCopy(e) ? 1 : 0, want.size ? (e.tags || []).filter((t) => want.has(t)).length : 0];
  pool.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i];
    return (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0)
      || (Number(a.useCount) || 0) - (Number(b.useCount) || 0);
  });
  return pool.slice(0, Math.max(0, Number(limit) || 0));
}
