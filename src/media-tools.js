// 媒体工具层：定位 ffmpeg/ffprobe、跑子进程、修 B站缓存的私有头。
//
// 为什么单独一层
// --------------
// 点歌台（播放 B站缓存原曲）和唱歌链路都要用 ffmpeg，但两边对「输入文件」的假设不同：
// 唱歌链路的输入是我们自己生成的 wav，直接能读；B站缓存的 .m4s 却带着客户端私有头。
// 把「怎么把一个奇怪的文件变成 ffmpeg 能读的干净文件」放在这里，上层就不用各自踩坑。
//
// 私有头是什么
// ------------
// PC 客户端缓存的 .m4s 前 9 个字节是 ASCII "000000000"，之后才是标准的 ftyp box。
// 直接喂给 ffmpeg 会 `Invalid data found when processing input`；
// `-skip_initial_bytes 9` 也无效（那是探测阶段选项，mov 解复用器不认）。
// 唯一稳妥的办法是物理跳过这几个字节（复制一份，绝不改原缓存 —— 客户端还要用）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR } from './config.js';

const CLEAN_DIR = path.join(DATA_DIR, 'playlist', 'tmp');

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  path.join(ROOT, 'gpt-sovits-app', 'GPT-SoVITS-v2pro-20250604', 'runtime', 'ffmpeg.exe'),
  'C:\\Program Files (x86)\\ACLOS\\Cross\\recorder-release\\ffmpeg.exe',
  'ffmpeg',
];

function firstExisting(list) {
  for (const p of list) {
    if (!p) continue;
    if (p === 'ffmpeg' || p === 'ffprobe') return p;   // 交给 PATH
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return '';
}

let _ffmpeg = null;
let _ffprobe = null;

export function resolveFfmpeg() {
  if (_ffmpeg === null) _ffmpeg = firstExisting(FFMPEG_CANDIDATES);
  return _ffmpeg;
}

export function resolveFfprobe() {
  if (_ffprobe !== null) return _ffprobe;
  const ff = resolveFfmpeg();
  const cands = [process.env.FFPROBE_PATH];
  if (ff && ff !== 'ffmpeg') cands.push(path.join(path.dirname(ff), 'ffprobe.exe'), path.join(path.dirname(ff), 'ffprobe'));
  cands.push('ffprobe');
  _ffprobe = firstExisting(cands);
  return _ffprobe;
}

/** 跑一个子进程，收全 stdout/stderr。失败不抛，由调用方按 code 判断。 */
export function runProc(cmd, args, { timeoutMs = 180000, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    if (!cmd) return resolve({ code: -1, stdout: '', stderr: '找不到可执行文件' });
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd });
    } catch (error) {
      return resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      if (!settled) { settled = true; resolve({ code: -2, stdout, stderr: stderr + '\n[超时]' }); }
    }, Math.max(5000, Number(timeoutMs) || 180000));

    child.stdout?.on('data', (b) => { stdout += b.toString(); if (stdout.length > 200000) stdout = stdout.slice(-100000); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * 探测「ftyp」盒子的起始偏移。0 = 干净 MP4；>0 = 前面有多余字节；-1 = 认不出来。
 * 只读前 8KB，够覆盖各种客户端头（实测 9 字节）。
 */
export function detectMp4Offset(file, { scanBytes = 8192 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(scanBytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    if (len >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return 0;
    for (let i = 4; i < len - 8; i += 1) {
      if (buf.toString('ascii', i, i + 4) !== 'ftyp') continue;
      const boxSize = buf.readUInt32BE(i - 4);
      // 盒子长度必须合理（8~1MB），否则只是数据里偶然出现的 "ftyp"
      if (boxSize >= 8 && boxSize <= 1024 * 1024) return i - 4;
    }
    return -1;
  } catch {
    return -1;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

function cacheKey(file, stat, offset) {
  return crypto.createHash('sha1')
    .update(`${file}|${stat.size}|${stat.mtimeMs}|${offset}`)
    .digest('hex').slice(0, 20);
}

/**
 * 返回一个「ffmpeg 能直接读」的路径：
 *   - 干净文件 → 原路径（零拷贝）
 *   - 带私有头 → data/playlist/tmp 下的去头副本（按 路径+大小+mtime+偏移 做键，可复用）
 */
export async function cleanedSource(file, { log = null } = {}) {
  const offset = detectMp4Offset(file);
  if (offset <= 0) return file;             // 0=干净；-1=认不出，交给 ffmpeg 自己试（可能本来就是 mp3/flv）

  const stat = await fsp.stat(file);
  const out = path.join(CLEAN_DIR, cacheKey(file, stat, offset) + path.extname(file));
  try {
    const st = await fsp.stat(out);
    if (st.size === stat.size - offset) return out;   // 已有可用副本
  } catch { /* 不存在，继续生成 */ }

  await fsp.mkdir(CLEAN_DIR, { recursive: true });
  const tmp = `${out}.${process.pid}.part`;
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { start: offset });
    const ws = fs.createWriteStream(tmp);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  await fsp.rename(tmp, out);
  log?.(`[media] 去掉私有头 ${path.basename(file)}（跳过 ${offset} 字节）`);
  return out;
}

/** ffprobe 一份媒体文件（自动处理私有头）。失败返回 {ok:false, error}。 */
export async function probeMedia(file, { timeoutMs = 30000 } = {}) {
  const bin = resolveFfprobe();
  if (!bin) return { ok: false, error: '找不到 ffprobe' };
  let src;
  try { src = await cleanedSource(file); } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  const r = await runProc(bin, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate,bit_rate',
    '-show_entries', 'format=duration,format_name,bit_rate',
    '-of', 'json',
    src,
  ], { timeoutMs });
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || '').trim().slice(0, 300) || `ffprobe exit ${r.code}` };
  }
  try {
    const data = JSON.parse(r.stdout || '{}');
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio') || null;
    const video = streams.find((s) => s.codec_type === 'video') || null;
    return {
      ok: true,
      duration: Number(data.format?.duration) || 0,
      formatName: String(data.format?.format_name || ''),
      bitRate: Number(data.format?.bit_rate) || 0,
      audio,
      video,
      streams,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
