// B站缓存扫描：把客户端缓存目录解析成「一首歌 → 一份音频 + 干净元数据」。
//
// 支持的缓存形态（都是实际见过的）
// --------------------------------
//   1) PC 客户端：<root>/<id>/ 下有 .videoInfo(JSON) + <id>-<p>-<qn>.m4s
//      —— 元数据最全（标题/UP主/时长/BV号/封面路径），优先用它。
//   2) 安卓客户端：<root>/<aid>/<cid>/ 下有 entry.json + audio.m4s / video.m4s
//      —— 元数据在 entry.json 里，时长是毫秒。
//   3) 散装音频：目录里直接放 mp3/m4a/flac/wav/ogg，或单个 mp4/m4s（音视频合流）。
//      —— 没有元数据，文件名当标题，时长交给 ffprobe。
//
// 这里只读不写：缓存目录仍归客户端所有，随时可能被它清理/续传。
// 真正需要「改」的地方（去私有头）在 media-tools.cleanedSource 里，产物落在 data/playlist/tmp。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeMedia } from './media-tools.js';

/** 流清晰度码：这几个是「纯音频」轨（30280=192k / 30232=132k / 30216=64k ...）。 */
export const AUDIO_QN = new Set([30216, 30232, 30250, 30280, 30300, 30302, 30304]);

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma']);
const MEDIA_EXT = new Set(['.m4s', '.mp4', '.flv', '.blv', ...AUDIO_EXT]);
const COVER_NAMES = ['image.jpg', 'cover.jpg', 'cover.png', 'poster.jpg', 'group.jpg'];

/** 默认缓存根目录（配置里没写时自动探测）。 */
export function defaultCacheRoots() {
  const home = os.homedir();
  const cands = [
    process.env.BILIBILI_CACHE_DIR,
    path.join(home, 'Videos', 'bilibili'),
    path.join(home, 'Videos', 'bilibili_cache'),
    path.join(home, 'Videos', 'Bilibili'),
    path.join(home, 'Downloads', 'bilibili'),
  ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const dir of cands) {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try { if (fs.statSync(dir).isDirectory()) out.push(path.resolve(dir)); } catch { /* 不存在就跳过 */ }
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        let mtimeMs = 0;
        try { const st = fs.statSync(full); size = st.size; mtimeMs = st.mtimeMs; } catch { /* ignore */ }
        return { name: e.name, path: full, ext: path.extname(e.name).toLowerCase(), size, mtimeMs };
      });
  } catch {
    return [];
  }
}

/** 从 `<id>-<p>-<qn>.m4s` 里取最后一段数字当清晰度码。 */
function qualityOf(name) {
  const m = /-(\d+)\.[a-z0-9]+$/i.exec(name);
  return m ? Number(m[1]) : 0;
}

function pickCover(files, vi) {
  const fromMeta = String(vi?.coverPath || '').trim();
  if (fromMeta) {
    try { if (fs.existsSync(fromMeta)) return fromMeta; } catch { /* ignore */ }
  }
  for (const n of COVER_NAMES) {
    const hit = files.find((f) => f.name.toLowerCase() === n);
    // group.jpg 是合集封面，单集优先 image.jpg；这里按 COVER_NAMES 顺序已经处理
    if (hit && hit.size > 0) return hit.path;
  }
  return '';
}

function normalizeDuration(value) {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  // 安卓 entry.json 的 total_time_milli / page_data.duration 常是毫秒
  if (n > 10000) return Math.round(n / 1000);
  return Math.round(n);
}

function isComplete(vi, entry, files) {
  if (!files.length) return false;
  const total = Number(vi?.totalSize || entry?.total_bytes || 0);
  const loaded = Number(vi?.loadedSize || entry?.downloaded_bytes || 0);
  if (total > 0 && loaded > 0 && loaded < total * 0.98) return false;
  if (vi?.status && vi.status !== 'completed') return false;
  if (entry && entry.is_completed === false) return false;
  return true;
}

/**
 * 解析一个「含媒体文件」的目录（只看文件名/元数据，不开 ffprobe）。
 * @param {string} dir
 * @param {object} files  listFiles(dir) 的结果
 * @param {object} parent 父目录继承来的元数据（安卓多 P 的情况）
 */
function parseEntryDir(dir, files, parent = null) {
  const vi = readJson(path.join(dir, '.videoInfo'))
    || readJson(path.join(dir, 'videoInfo.json'))
    || null;
  const entry = readJson(path.join(dir, 'entry.json')) || null;

  const media = files.filter((f) => MEDIA_EXT.has(f.ext) && f.size > 0);
  if (!media.length) return null;

  let audio = null;
  let video = null;
  let muxed = null;

  for (const f of media) {
    const qn = qualityOf(f.name);
    const lower = f.name.toLowerCase();
    if (lower === 'audio.m4s' || lower === 'audio.mp4') { audio = { ...f, qn }; continue; }
    if (lower === 'video.m4s' || lower === 'video.mp4') { video = { ...f, qn }; continue; }
    if (AUDIO_EXT.has(f.ext)) { if (!audio || f.size > audio.size) audio = { ...f, qn }; continue; }
    if (AUDIO_QN.has(qn)) { if (!audio || f.size > audio.size) audio = { ...f, qn }; continue; }
    if (!video || f.size > video.size) video = { ...f, qn };
  }

  // 只有一个「非纯音频」文件时，它可能是音视频合流 —— 用它当音源，转码时只取音轨
  if (!audio && video) muxed = video;

  const srcFile = audio || muxed || null;
  const title = String(vi?.title || entry?.title || parent?.title || path.basename(dir)).trim();
  const uploader = String(vi?.uname || entry?.user_info?.uname || parent?.uploader || '').trim();
  const groupTitle = String(vi?.groupTitle || parent?.groupTitle || '').trim();
  const rawDuration = vi?.duration
    || entry?.total_time_milli
    || entry?.page_data?.duration
    || parent?.duration
    || 0;
  const duration = normalizeDuration(rawDuration);

  return {
    format: vi ? 'pc' : (entry ? 'android' : 'plain'),
    dir,
    meta: {
      title,
      uploader,
      groupTitle,
      duration,
      bvid: String(vi?.bvid || entry?.bvid || ''),
      cid: String(vi?.cid || entry?.page_data?.cid || ''),
      aid: Number(vi?.aid || entry?.page_data?.aid || 0) || 0,
      page: Number(vi?.p || entry?.page_data?.page || 0) || 0,
      pubdate: Number(vi?.pubdate || 0) || 0,
      qn: Number(vi?.qn || entry?.prefered_video_quality || 0) || 0,
      status: String(vi?.status || ''),
      complete: isComplete(vi, entry, media) && Boolean(srcFile),
      createdAtMs: Number(vi?.createTime || 0) || 0,
    },
    audio: audio ? { path: audio.path, name: audio.name, size: audio.size, qn: audio.qn, mtimeMs: audio.mtimeMs } : null,
    video: video ? { path: video.path, name: video.name, size: video.size, qn: video.qn } : null,
    muxed: muxed ? { path: muxed.path, name: muxed.name, size: muxed.size, qn: muxed.qn } : null,
    cover: pickCover(files, vi),
    totalSize: media.reduce((n, f) => n + f.size, 0),
  };
}

/**
 * 递归扫描一个缓存根目录。
 * 判定规则：
 *   - 有 .videoInfo / entry.json / audio.m4s / video.m4s → 结构化条目，不再下钻
 *   - 只有散装媒体文件 → 整个目录算「一曲」（散装音频/合流 mp4）
 *   - 没有媒体 → 继续下钻（安卓多 P 的父目录就属于这种）
 *
 * 注意 root 本身也可能有散文件（历史实验产物），所以「散装」不能直接 return，
 * 否则会把整个缓存根当成一首歌、把下面的 20 多个目录全吞掉。
 */
export async function scanCacheRoot(root, { maxDepth = 4, probe = true, log = null } = {}) {
  const out = [];

  const walk = async (dir, depth, parent) => {
    const files = listFiles(dir);
    const media = files.filter((f) => MEDIA_EXT.has(f.ext) && f.size > 0);
    const structured = files.some((f) => /^(\.videoInfo|videoInfo\.json|entry\.json|audio\.m4s|video\.m4s)$/i.test(f.name));

    if (structured) {
      const parsed = await parseEntryDirAsync(dir, files, parent, { probe, log });
      if (parsed) out.push(parsed);
      return;
    }
    if (media.length) {
      const loose = parseLooseDir(dir, media);
      if (loose) out.push(loose);
    }
    if (depth >= maxDepth) return;
    let subs = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch { return; }

    // 父目录可能带一份 entry.json（安卓多 P 的合集信息），传给子目录当兜底
    let inherited = parent;
    const entry = readJson(path.join(dir, 'entry.json'));
    if (entry) {
      inherited = {
        title: String(entry.title || parent?.title || ''),
        uploader: String(entry.user_info?.uname || parent?.uploader || ''),
        groupTitle: parent?.groupTitle || '',
        duration: 0,
      };
    }
    for (const sub of subs) await walk(path.join(dir, sub.name), depth + 1, inherited);
  };

  await walk(root, 0, null);
  return out;
}

// 链路中间产物：即使混在缓存目录里也不该被当成「一首歌」点播。
const ARTIFACT_RE = /(instrumental|accompani|vocal[-_]?ref|\binst\b|伴奏|干声|分离|_fixed|\.norm\b|^_)/i;

/** 散装目录：把目录里的媒体文件汇总成一个条目，标题取最大那个文件的名字。 */
function parseLooseDir(dir, media) {
  const usable = media.filter((f) => !ARTIFACT_RE.test(f.name));
  if (!usable.length) return null;
  const main = usable.slice().sort((a, b) => b.size - a.size)[0];
  const isAudio = AUDIO_EXT.has(main.ext);
  const base = main.name.replace(/\.[^.]+$/, '').replace(/[_\-]+$/g, '');
  const files = listFiles(dir);
  return {
    format: 'plain',
    dir,
    meta: {
      title: base,
      uploader: '',
      groupTitle: '',
      duration: 0,
      bvid: '',
      cid: '',
      aid: 0,
      page: 0,
      pubdate: 0,
      qn: 0,
      status: '',
      complete: true,
      createdAtMs: 0,
    },
    // 合流 mp4/flv 也先记在 muxed 里：转码时只取音轨，不需要用户自己拆
    audio: isAudio ? { path: main.path, name: main.name, size: main.size, qn: 0, mtimeMs: main.mtimeMs } : null,
    video: null,
    muxed: isAudio ? null : { path: main.path, name: main.name, size: main.size, qn: 0 },
    cover: pickCover(files, null),
    totalSize: media.reduce((n, f) => n + f.size, 0),
  };
}

/** parseEntryDir 的异步版：同名同步函数里那段 probe 现在要 await。 */
async function parseEntryDirAsync(dir, files, parent, { probe, log }) {
  // 先把「名字能认出来」的常规情况走完，避免为每个条目都开 ffprobe
  const entry = parseEntryDir(dir, files, parent);
  if (!entry) return null;
  if (entry.audio || entry.muxed) return entry;
  if (!probe) return entry;

  // 名字认不出音频轨：逐个探测（最多 4 个，失败就放弃这个条目）
  for (const f of files.filter((x) => MEDIA_EXT.has(x.ext) && x.size > 0).slice(0, 4)) {
    const p = await probeMedia(f.path).catch(() => null);
    if (!p?.ok) continue;
    const qn = qualityOf(f.name);
    if (p.audio && !p.video) {
      entry.audio = { path: f.path, name: f.name, size: f.size, qn, mtimeMs: f.mtimeMs };
      entry.meta.complete = isComplete(readJson(path.join(dir, '.videoInfo')), readJson(path.join(dir, 'entry.json')), [f]);
      break;
    }
    if (p.audio && !entry.muxed) {
      entry.muxed = { path: f.path, name: f.name, size: f.size, qn };
    }
  }
  return entry;
}

/** 扫描多个根目录并去重（同一份音频可能被多个根覆盖）。 */
export async function scanCaches(roots, opts = {}) {
  const all = [];
  const seen = new Set();
  const errors = [];
  for (const root of roots) {
    try {
      const list = await scanCacheRoot(root, opts);
      for (const e of list) {
        const key = path.resolve(e.audio?.path || e.muxed?.path || e.dir).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(e);
      }
    } catch (error) {
      errors.push({ root, error: String(error?.message ?? error) });
    }
  }
  return { entries: all, errors };
}
