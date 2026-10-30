// 点歌台：把 B站缓存扫成一份结构化歌单（library.json），并提供检索/排序/统计。
//
// 为什么不复用 song-router
// ------------------------
// song-router 面向的是「唱歌/翻唱」：曲库 = songs/raw 里少量素材，匹配靠名字，
// 目的是决定用哪种方式唱。点歌台面向的是「播放原曲」：几十上百首、需要序号、
// 别名、时长、歌手、点播热度、分页展示，还要能被群友用一句「#点歌 青花瓷」命中。
// 两者共用 nameScore 的匹配算法（同一个模块导出），但数据模型分开，互不污染。
//
// 数据放在 data/playlist/：
//   library.json    扫描生成的歌单（可随时重建，不要手改）
//   overrides.json  人工修正（别名/标题/隐藏），重建后依然生效
//   stats.json      点播次数/最近点播（跟 library 分开，重建不丢）
//   audio/          转码后的 mp3（交付用，按需生成）
//   tmp/            去头副本（见 media-tools）

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { nameScore } from './song-router.js';
import { scanCaches, defaultCacheRoots } from './bilibili-cache.js';
import { probeMedia } from './media-tools.js';

export const PLAYLIST_DIR = path.join(DATA_DIR, 'playlist');
const LIB_FILE = path.join(PLAYLIST_DIR, 'library.json');
const OVR_FILE = path.join(PLAYLIST_DIR, 'overrides.json');
const STATS_FILE = path.join(PLAYLIST_DIR, 'stats.json');

const LIB_VERSION = 1;

// ── 配置 ────────────────────────────────────────────────────────────────

export function playlistConfig() {
  const raw = getConfig()?.playlist || {};
  const roots = Array.isArray(raw.roots) ? raw.roots.map((s) => String(s || '').trim()).filter(Boolean) : [];
  return {
    enabled: raw.enabled !== false,
    roots,
    autoRebuildMinutes: Number.isFinite(Number(raw.autoRebuildMinutes)) ? Number(raw.autoRebuildMinutes) : 30,
    pageSize: Math.max(4, Math.min(20, Number(raw.pageSize) || 10)),
    cooldownSec: Math.max(0, Number(raw.cooldownSec) || 0),
    maxFileMb: Number(raw.maxFileMb) || 120,
    bitrate: String(raw.transcodeBitrate || '192k'),
    snippetSec: Math.max(10, Math.min(55, Number(raw.snippetSec) || 45)),
    sendMode: ['file', 'voice', 'auto'].includes(raw.sendMode) ? raw.sendMode : 'file',
  };
}

/** 实际要扫描的根目录：配置优先，否则自动探测。 */
export function resolveRoots() {
  const cfg = playlistConfig();
  if (cfg.roots.length) {
    return cfg.roots.map((r) => r.replace(/^~/, process.env.USERPROFILE || process.env.HOME || '')).map((r) => path.resolve(r));
  }
  return defaultCacheRoots();
}

// ── 标题/歌手解析 ────────────────────────────────────────────────────────

const NOISE_RE = [
  /[（(【\[]?(?:片段|完整版|高音质|无损|Hi-?Res|动态歌词|附歌词|歌词版|官方MV|4K|1080P|60帧|纯享|试听)[）)】\]]?/gi,
  /B站最强AI调音/g,
  /百万级录音棚试听/g,
  /来让胡桃陪陪你吧/g,
  /动态歌词/g,
];

function cleanText(s) {
  let out = String(s || '');
  for (const re of NOISE_RE) out = out.replace(re, '');
  return out
    .replace(/^[\s\-—–~·、,，。.!！?？:：|｜]+/, '')
    .replace(/[\s\-—–~·、,，。.!！?？:：|｜]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function hasCjk(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

/**
 * 【】/groupTitle 里的内容不一定是歌手：
 * 「Hi-Res无损」「⭐轮播合集」「《崩坏：星穹铁道》音乐」都是栏目/企划名。
 * 判断成歌手会让「#点歌 纳西妲」这种查询变得很奇怪，所以这里统一过滤。
 */
function normalizeSeries(s) {
  let x = String(s || '').replace(/[《》「」【】]/g, '').trim();
  if (!x) return '';
  if (/^(hi-?res|无损|高清|4k|1080p|mv|官方|音乐|现场|纯享|合集|动态歌词|翻唱|片段|完整版|轮播|歌单|收藏|默认)/i.test(x)) return '';
  if (/(轮播|合集|歌单|收藏)/.test(x) && x.length <= 8) return '';
  // 游戏/企划名不是歌手
  if (/星穹铁道|原神|崩坏|明日方舟|英雄联盟|王者荣耀|鸣潮/.test(x)) return '';
  if (x.length > 14) return '';
  return x;
}

/**
 * 从 B站标题里拆出「歌名 / 歌手 / 系列」。
 * 现实里的标题形态非常多，这里按「信息量」优先级取：
 *   ① 「」里的中文（通常是真正的歌名，如 《崩坏》EP：「使一颗心免于哀伤」）
 *   ② 《》里的内容（常见形态：【AI纳西妲】《青花瓷》…）
 *   ③ 去掉【】后按 | ｜ 切；再按 " - " 拆歌手
 */
export function parseTitle(rawTitle, { uploader = '', groupTitle = '', duration = 0 } = {}) {
  const raw = String(rawTitle || '').trim();
  let series = '';
  const brackets = [...raw.matchAll(/【([^】]+)】/g)].map((m) => m[1].trim()).filter(Boolean);
  if (brackets.length) series = brackets[0];
  if (!series && groupTitle) series = String(groupTitle).replace(/^【|】$/g, '').trim();

  const books = [...raw.matchAll(/《([^》]+)》/g)].map((m) => m[1].trim()).filter(Boolean);
  const corners = [...raw.matchAll(/「([^」]+)」/g)].map((m) => m[1].trim()).filter(Boolean);

  let title = '';
  let artist = '';

  const cornerSong = corners.find((c) => hasCjk(c) && c.length >= 2 && c.length <= 24);
  if (cornerSong) {
    title = cornerSong;
    // 《崩坏：星穹铁道》这类是作品/企划名，不是歌名
    if (books.length) series = series || books[0];
  } else if (books.length) {
    title = books[0];
    const before = cleanText(raw.slice(0, raw.indexOf('《')).replace(/【[^】]*】/g, ''));
    const after = cleanText(raw.slice(raw.lastIndexOf('》') + 1).split(/[|｜]/)[0]);
    // 书名号前面通常是歌手（胡桃《…》）；后面偶尔是（《妈妈的话》纳西妲），
    // 但「纳西妲一直在等你」这种宣传语要排除 —— 所以后面只接受极短的名字。
    artist = (before && before.length <= 8 ? before : '')
      || (after && after.length <= 4 ? after : '');
  } else {
    let body = raw.replace(/【[^】]*】/g, ' ').trim();
    // 歌名已经在「」里取过时就不会走到这；这里把残留的引用块/书名号清掉
    body = body.replace(/「[^」]*」/g, ' ').replace(/《[^》]*》/g, ' ').trim();
    body = body.split(/[|｜]/)[0].trim();
    const spaced = body.split(/\s+-\s+/);
    if (spaced.length >= 2 && cleanText(spaced[1]).length <= 12) {
      title = cleanText(spaced[0]);
      artist = cleanText(spaced[1]);
    } else {
      // 知更鸟-在银河中孤独摇摆：没有空格的连字符，前半段短就当前面的歌手
      const tight = body.split('-');
      if (tight.length === 2 && tight[0].trim().length <= 6 && tight[1].trim().length >= 2) {
        artist = cleanText(tight[0]);
        title = cleanText(tight[1]);
      } else {
        title = cleanText(body);
      }
    }
  }

  title = cleanText(title) || cleanText(raw) || '未命名';
  const artistSeries = normalizeSeries(series);
  const cleanSeries = artistSeries || (cornerSong && books.length ? books[0] : '');
  if (!artist && artistSeries) {
    artist = artistSeries.replace(/^AI(?=[\u4e00-\u9fa5A-Za-z])/i, '').trim();
  }
  if (!artist) artist = String(uploader || '').trim();

  // 分类：合集/语音包不进默认点歌列表；短片段单独标记
  const dur = Number(duration) || 0;
  let kind = 'song';
  if (/合集|大全|串烧|语音包|干声|纯人声|教程|合集/i.test(raw) || dur >= 900) kind = 'collection';
  else if (/片段/.test(raw) || (dur > 0 && dur < 70)) kind = 'clip';

  const tags = [];
  if (/AI/i.test(raw) || /^AI/i.test(series)) tags.push('AI翻唱');
  if (/片段/.test(raw)) tags.push('片段');
  if (/合集|大全|串烧/.test(raw)) tags.push('合集');
  if (cleanSeries) tags.push(cleanSeries);
  if (kind === 'clip') tags.push('短片段');

  // 别名只存「群友真可能打出来的写法」：裸标题、歌手+标题、去掉 AI 前缀的写法。
  // 原始标题太长且带宣传语，交给 scoreTrack 的 rawTitle 字段单独算分。
  const aliases = new Set([title]);
  aliases.add(title.replace(/[（(][^）)]*[）)]/g, '').trim());
  if (cleanSeries) {
    aliases.add(`${cleanSeries}${title}`);
    aliases.add(`${cleanSeries.replace(/^AI(?=[\u4e00-\u9fa5A-Za-z])/i, '')}${title}`);
  }

  return {
    title,
    artist: artist || '未知',
    series: cleanSeries,
    kind,
    tags: [...new Set(tags.filter(Boolean))],
    aliases: [...aliases].map((s) => String(s).trim()).filter((s) => s && s !== title),
  };
}

// ── 读写 ────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadOverrides() {
  const raw = readJson(OVR_FILE);
  return raw && typeof raw === 'object' ? raw : {};
}

function loadStats() {
  const raw = readJson(STATS_FILE);
  return raw && typeof raw === 'object' ? raw : {};
}

let _stats = null;
let _statsTimer = null;

function statsMap() {
  if (!_stats) _stats = loadStats();
  return _stats;
}

// ── 构建 ────────────────────────────────────────────────────────────────

const ARTIFACT_RE = /(-vocal\d*|-vocals?\b|-seg\d*|-hp\b|-chorus|-rvc\b|-f0\b|\binst\b|^test-|\.norm\b|instrumental|accompani|_fixed)/i;

function trackIdOf(entry) {
  const base = path.basename(entry.dir).replace(/[^0-9A-Za-z_-]+/g, '-');
  return `bili-${base || 'x'}`;
}

function toTrack(entry, overrides, { index = 0 } = {}) {
  const parsed = parseTitle(entry.meta.title, {
    uploader: entry.meta.uploader,
    groupTitle: entry.meta.groupTitle,
    duration: entry.meta.duration,
  });
  const id = trackIdOf(entry);
  const ovr = overrides[id] || {};
  const src = entry.audio || entry.muxed;
  const stats = statsMap()[id] || {};

  const tags = [...new Set([...(parsed.tags || []), ...(Array.isArray(ovr.tags) ? ovr.tags : [])])];
  const aliases = [...new Set([...(parsed.aliases || []), ...(Array.isArray(ovr.aliases) ? ovr.aliases : [])])]
    .filter((a) => a && a !== (ovr.title || parsed.title));

  const duration = Math.round(Number(entry.meta.duration) || 0);
  const track = {
    id,
    no: index + 1,
    title: String(ovr.title || parsed.title),
    artist: String(ovr.artist || parsed.artist || '未知'),
    album: parsed.series || '',
    rawTitle: entry.meta.title,
    aliases,
    tags,
    kind: ovr.kind || parsed.kind,
    duration,
    source: {
      platform: 'bilibili',
      bvid: entry.meta.bvid || '',
      cid: entry.meta.cid || '',
      aid: entry.meta.aid || 0,
      page: entry.meta.page || 0,
      url: entry.meta.bvid ? `https://www.bilibili.com/video/${entry.meta.bvid}` : '',
    },
    audio: src ? {
      path: src.path,
      name: src.name,
      size: src.size,
      ext: path.extname(src.name).toLowerCase(),
      qn: src.qn || 0,
      muxed: !entry.audio,
    } : null,
    cover: entry.cover || '',
    cacheDir: entry.dir,
    format: entry.format,
    status: entry.audio || entry.muxed ? (entry.meta.complete === false ? 'incomplete' : 'ok') : 'no-audio',
    addedAt: entry.meta.createdAtMs ? new Date(entry.meta.createdAtMs).toISOString() : '',
    updatedAt: new Date().toISOString(),
    plays: Number(stats.plays) || 0,
    lastPlayedAt: stats.lastAt || '',
  };
  if (ovr.hidden) track.hidden = true;
  return track;
}

function isPlayable(t) {
  return !!t && !t.hidden && t.status === 'ok' && t.audio && t.kind !== 'collection';
}

function durationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatDuration(sec) {
  return durationText(sec);
}

function artistKey(t) {
  return t.artist || '未知';
}

/**
 * 重建歌单。
 * @returns {Promise<object>} library
 */
export async function buildLibrary({ roots = null, log = () => {} } = {}) {
  const useRoots = roots && roots.length ? roots : resolveRoots();
  if (!useRoots.length) {
    throw new Error('没有找到 B站缓存目录：请在 设置 → 点歌台 里填缓存路径（或用环境变量 BILIBILI_CACHE_DIR）');
  }
  const t0 = Date.now();
  const { entries, errors } = await scanCaches(useRoots, { log });

  // 散装音频没有时长，补一次 ffprobe（最多 20 个，避免重建变慢）
  let probed = 0;
  for (const e of entries) {
    if (e.meta.duration > 0 || probed >= 20) continue;
    const f = e.audio || e.muxed;
    if (!f) continue;
    const p = await probeMedia(f.path).catch(() => null);
    if (p?.ok) e.meta.duration = Math.round(p.duration || 0);
    probed += 1;
  }

  const overrides = loadOverrides();
  let list = entries
    .filter((e) => !ARTIFACT_RE.test(e.meta.title))
    .map((e) => toTrack(e, overrides));

  // 去重：同一个 id（目录名相同）只留第一个
  const seen = new Set();
  list = list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));

  list.sort((a, b) => {
    const ka = a.kind === 'collection' ? 1 : 0;
    const kb = b.kind === 'collection' ? 1 : 0;
    if (ka !== kb) return ka - kb;                                  // 合集排最后
    const aa = artistKey(a).localeCompare(artistKey(b), 'zh-Hans-CN');
    if (aa !== 0) return aa;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
  list.forEach((t, i) => { t.no = i + 1; });

  const playable = list.filter(isPlayable);
  const collections = list.filter((t) => t.kind === 'collection' && t.status === 'ok');
  const artists = new Map();
  for (const t of playable) {
    const k = artistKey(t);
    if (!artists.has(k)) artists.set(k, []);
    artists.get(k).push(t.id);
  }

  const lib = {
    version: LIB_VERSION,
    name: '点歌台',
    generatedAt: new Date().toISOString(),
    buildMs: Date.now() - t0,
    roots: useRoots,
    errors,
    stats: {
      total: list.length,
      playable: playable.length,
      collections: collections.length,
      artists: artists.size,
      durationSec: playable.reduce((n, t) => n + (t.duration || 0), 0),
    },
    playlists: [
      { id: 'all', name: '全部歌曲', trackIds: playable.map((t) => t.id) },
      ...[...artists.entries()]
        .filter(([, ids]) => ids.length >= 2)
        .map(([name, ids]) => ({ id: `artist:${name}`, name, trackIds: ids })),
    ],
    tracks: list,
  };

  writeJsonAtomic(LIB_FILE, lib);
  log(`[playlist] 已生成 ${playable.length} 首可点播（另有 ${collections.length} 个合集），耗时 ${lib.buildMs}ms`);
  return lib;
}

// ── 读取 ────────────────────────────────────────────────────────────────

let _lib = null;
let _libAt = 0;
let _building = null;

/** 读歌单（带 mtime 失效）。没有就返回 null（不自动扫，避免指令路径阻塞）。 */
export function loadLibrary({ reload = false } = {}) {
  try {
    const st = fs.statSync(LIB_FILE);
    if (!reload && _lib && _libAt === st.mtimeMs) return _lib;
    const data = readJson(LIB_FILE);
    if (!data || !Array.isArray(data.tracks)) return null;
    _lib = data;
    _libAt = st.mtimeMs;
    return data;
  } catch {
    return null;
  }
}

/** 需要时重建（供指令/工具入口调用）。并发调用共享同一次构建。 */
export async function ensureLibrary({ maxAgeMs = null, log = () => {} } = {}) {
  const lib = loadLibrary();
  const cfg = playlistConfig();
  const ttlMs = maxAgeMs != null ? maxAgeMs : Math.max(0, cfg.autoRebuildMinutes) * 60 * 1000;
  const age = lib ? Date.now() - new Date(lib.generatedAt).getTime() : Infinity;
  if (lib && age < ttlMs) return lib;
  if (_building) return _building;
  _building = (async () => {
    try {
      return await buildLibrary({ log });
    } catch (error) {
      if (lib) {
        log(`[playlist] 重建失败，继续用旧歌单：${error?.message ?? error}`);
        return lib;
      }
      throw error;
    } finally {
      _building = null;
    }
  })();
  return _building;
}

export function getPlaylistMeta() {
  const lib = loadLibrary();
  if (!lib) return null;
  return {
    name: lib.name,
    generatedAt: lib.generatedAt,
    stats: lib.stats,
    roots: lib.roots,
    playlists: (lib.playlists || []).map((p) => ({ id: p.id, name: p.name, count: p.trackIds.length })),
  };
}

// ── 检索 ────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s || '')
    .replace(/[《》「」【】"'“”‘’]/g, '')
    .replace(/\.(wav|mp3|flac|m4a|ogg|aac|m4s)$/i, '')
    .replace(/[\s，。！？、；：,.!?;:~·…_\-—]/g, '')
    .toLowerCase();
}

/**
 * 从一段话里抠出 BV 号（支持整条 B 站链接 / 带 p 参数的链接 / 只给裸号）。
 * 群友常见做法是直接把链接粘过来，这里统一认。
 */
export function extractBvid(s) {
  const m = String(s || '').match(/BV[0-9A-Za-z]{10}/i);
  return m ? 'BV' + m[0].slice(2) : null;
}

/** 按 BV 号在歌单里精确找一首（不参与模糊打分）。 */
function findByBvid(data, bvid) {
  const key = String(bvid || '').toUpperCase();
  if (!key) return null;
  return data.tracks.find((t) => String(t.source?.bvid || '').toUpperCase() === key) || null;
}

function scoreTrack(t, kw, { penalizeCollections = true } = {}) {
  const q = normalize(kw);
  if (!q) return 0;
  let best = 0;
  const fields = [
    { text: t.title, weight: 1 },
    { text: t.artist, weight: 0.86 },
    { text: t.album, weight: 0.72 },
    { text: t.rawTitle, weight: 0.9 },
    ...(t.aliases || []).map((a) => ({ text: a, weight: 0.95 })),
    ...(t.tags || []).map((x) => ({ text: x, weight: 0.66 })),
  ];
  for (const f of fields) {
    if (!f.text) continue;
    const s = nameScore(q, f.text) * f.weight;
    if (s > best) best = s;
  }
  // 归一化后直接包含：中文短查询（如「青花瓷」）走 bigram 有时会被别的歌压过
  if (normalize(t.title).includes(q) || q.includes(normalize(t.title))) {
    best = Math.max(best, 0.93);
  }
  // 合集整体降权，避免「点歌 胡桃」把半小时语音包排到歌前面；
  // 但判断「用户是不是在点名某个合集」时要关掉这个降权，否则永远判不出来。
  if (penalizeCollections && t.kind === 'collection') best *= 0.7;
  if (t.kind === 'clip') best *= 0.98;
  // 点播热度只做微弱加权，不能压过名字匹配
  if (t.plays > 0) best += Math.min(0.04, Math.log10(t.plays + 1) * 0.03);
  return Math.min(1.2, best);
}

/**
 * 检索候选。
 * @returns {Array<{track, score}>} 按分数降序
 */
export function searchTracks(kw, {
  lib = null, limit = 8, includeCollections = false, penalizeCollections = true,
} = {}) {
  const data = lib || loadLibrary();
  if (!data) return [];
  const q = String(kw || '').trim();
  if (!q) return [];

  if (/^\d{1,3}$/.test(q)) {
    const n = Number(q);
    const t = data.tracks.find((x) => x.no === n);
    return t ? [{ track: t, score: 1.2 }] : [];
  }

  // 粘 B 站链接 = 指名道姓要这一首，别再去跟歌名比相似度
  const bvid = extractBvid(q);
  if (bvid) {
    const t = findByBvid(data, bvid);
    return t ? [{ track: t, score: 1.2 }] : [];
  }

  const out = [];
  for (const t of data.tracks) {
    if (t.hidden) continue;
    if (t.status !== 'ok') continue;
    if (!includeCollections && t.kind === 'collection') continue;
    const s = scoreTrack(t, q, { penalizeCollections });
    if (s >= 0.5) out.push({ track: t, score: Math.round(s * 100) / 100 });
  }
  out.sort((a, b) => b.score - a.score || (b.track.plays - a.track.plays));
  return out.slice(0, limit);
}

/**
 * 把「群友的一句话」变成一个明确的点播决定。
 * @returns {{track:object|null, candidates:Array, reason:string}}
 *   reason: index | random | bvid | exact | ambiguous | none | collection | notCached
 */
export function resolvePlayQuery(kw, { lib = null, includeCollections = false } = {}) {
  const data = lib || loadLibrary();
  if (!data) return { track: null, candidates: [], reason: 'none' };
  const q = String(kw || '').trim();

  if (!q) return { track: null, candidates: [], reason: 'none' };
  if (/^(随机|随便|random)$/i.test(q)) {
    const pool = data.tracks.filter(isPlayable);
    if (!pool.length) return { track: null, candidates: [], reason: 'none' };
    return { track: pool[Math.floor(Math.random() * pool.length)], candidates: [], reason: 'random' };
  }
  if (/^\d{1,3}$/.test(q)) {
    const t = data.tracks.find((x) => x.no === Number(q));
    if (t && t.status === 'ok') return { track: t, candidates: [], reason: 'index' };
    return { track: null, candidates: [], reason: 'none' };
  }

  // BV 号 / B站链接：命中就播，没缓存就如实说没有（别让模型瞎答应）
  const bvid = extractBvid(q);
  if (bvid) {
    const t = findByBvid(data, bvid);
    if (t && t.status === 'ok') return { track: t, candidates: [], reason: 'bvid' };
    return { track: null, candidates: [], reason: 'notCached', bvid };
  }

  const cands = searchTracks(q, { lib: data, includeCollections, limit: 8 });

  // 歌名本身就是某个合集/语音包（如「胡桃翻唱大合集」）时，不要因为有首歌的歌手也叫「胡桃」
  // 就把半小时的合集当成一首歌直接发出去 —— 提示用序号确认。
  // 但只认「用户确实在说这个合集」：短查询（「胡桃」「干声」）不算，
  // 否则「#点歌 胡桃」会变成点播 30 分钟语音包。
  const collections = searchTracks(q, {
    lib: data, includeCollections: true, limit: 3, penalizeCollections: false,
  }).filter((x) => x.track.kind === 'collection');
  const nq = normalize(q);
  const namedCollection = collections.find(({ track }) => {
    const nt = normalize(track.title);
    if (!nq || !nt) return false;
    if (nt === nq) return true;
    return nq.length >= 4 && nt.includes(nq) && nq.length / nt.length >= 0.4;
  });
  if (namedCollection && (!cands.length || namedCollection.score > cands[0].score)) {
    return { track: null, candidates: [namedCollection], reason: 'collection' };
  }

  if (!cands.length) return { track: null, candidates: [], reason: 'none' };
  const [top, second] = cands;
  const gap = top.score - (second?.score || 0);
  if (top.score >= 0.97 || (top.score >= 0.88 && gap >= 0.07)) {
    return { track: top.track, candidates: cands.slice(0, 5), reason: 'exact' };
  }
  return { track: null, candidates: cands.slice(0, 5), reason: 'ambiguous' };
}

// ── 展示 ────────────────────────────────────────────────────────────────

export function trackLine(t) {
  const dur = t.duration ? ` ${durationText(t.duration)}` : '';
  const mark = t.kind === 'clip' ? '（片段）' : '';
  return `${String(t.no).padStart(2, ' ')}. ${t.title}${mark} — ${t.artist}${dur}`;
}

export function formatLibraryPage(page = 1, { lib = null, filter = '' } = {}) {
  const data = lib || loadLibrary();
  if (!data) return '点歌台还没建好：先让主人在控制台点「重建歌单」。';
  const cfg = playlistConfig();

  let pool = data.tracks.filter(isPlayable);
  if (filter) {
    const hit = searchTracks(filter, { lib: data, limit: 999 });
    pool = hit.map((x) => x.track);
  }
  if (!pool.length) return filter ? `歌单里没有和「${filter}」相关的歌。` : '歌单里还没有可点播的歌。';

  const size = cfg.pageSize;
  const pages = Math.max(1, Math.ceil(pool.length / size));
  const p = Math.max(1, Math.min(pages, Number(page) || 1));
  const rows = pool.slice((p - 1) * size, p * size);

  const head = filter
    ? `🔎 点歌台 · 「${filter}」共 ${pool.length} 首`
    : `🎵 点歌台 · 共 ${pool.length} 首`;
  const body = rows.map(trackLine).join('\n');
  const foot = `—— 第 ${p}/${pages} 页 · #点歌 序号/歌名 · #随机 · #搜歌 关键词`;
  const extra = !filter && data.stats?.collections
    ? `\n（另有 ${data.stats.collections} 个合集/语音包未列出）`
    : '';
  return `${head}\n${body}\n${foot}${extra}`;
}

export function formatCandidates(cands, { keyword = '' } = {}) {
  if (!cands?.length) return `歌单里没找到「${keyword}」。试试 #搜歌 关键词，或 #歌单 看看都有什么。`;
  const lines = cands.map(({ track }) => trackLine(track));
  return `🔎 「${keyword}」匹配到 ${cands.length} 首：\n${lines.join('\n')}\n直接回 #点歌 序号 就能播。`;
}

// ── 统计 ────────────────────────────────────────────────────────────────

/** 记一次点播（延迟合并写盘，避免每次点歌都同步 IO）。 */
export function recordPlay(trackId, { by = '', chatKey = '' } = {}) {
  const stats = statsMap();
  const cur = stats[trackId] || { plays: 0 };
  cur.plays = (Number(cur.plays) || 0) + 1;
  cur.lastAt = new Date().toISOString();
  if (by) cur.lastBy = String(by);
  if (chatKey) cur.lastChat = String(chatKey);
  stats[trackId] = cur;

  if (_lib) {
    const t = _lib.tracks.find((x) => x.id === trackId);
    if (t) { t.plays = cur.plays; t.lastPlayedAt = cur.lastAt; }
  }
  if (_statsTimer) return;
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    try { writeJsonAtomic(STATS_FILE, stats); } catch { /* 统计失败不影响点播 */ }
  }, 1500);
  if (typeof _statsTimer.unref === 'function') _statsTimer.unref();
}

/** 把内存里的统计立刻落盘（进程退出前调用）。 */
export function flushStats() {
  if (!_stats) return;
  try { writeJsonAtomic(STATS_FILE, _stats); } catch { /* ignore */ }
}

/** 直接按 id 找一首（工具/API 用）。 */
export function getTrackById(id) {
  const lib = loadLibrary();
  return lib ? lib.tracks.find((t) => t.id === id) || null : null;
}

export const LIBRARY_FILE = LIB_FILE;
export const OVERRIDES_FILE = OVR_FILE;
