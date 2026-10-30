// 歌声转换（so-vits-svc 4.1）客户端：把一段人声/整首歌换成训练好的胡桃歌声音色。
//   服务端：svc\svc_service.py（svc\py310 → 复用 rvc\py310 的 Python，默认端口 3212）
//   接入点：tools.js 的 sing_convert 工具（可以从「群友发的语音/文件」或「URL」取音频）
//   模型：svc\models\hutao（主模型 G_32000）/ hutao-alt（备选 G_32800）
//
// 和 RVC 的分工：
//   RVC  = 说话音色（TTS 输出 → 胡桃说话声），每句话都用，要求快（毫秒级）
//   SVC  = 唱歌音色（整首歌 → 胡桃歌声），按需触发，允许慢（10~60 秒）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig, ROOT } from './config.js';

const DEFAULT_URL = 'http://127.0.0.1:3212';

/**
 * 原曲翻唱可用的人声分离后端（必须与 route_a.py --separator 的 choices 完全一致）。
 * 前两个是 Meta Demucs v4（separate.py），后两个是 UVR MDX-Net（separate_mdx.py）。
 */
export const SEPARATOR_MODELS = ['htdemucs', 'htdemucs_ft', 'mdx_kim', 'mdx_vocft'];
export const DEFAULT_SEPARATOR = 'htdemucs';

/** 把任意输入收敛成一个合法的分离后端名；不认识的一律回落默认值（绝不让它传到 Python）。 */
export function normalizeSeparator(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return SEPARATOR_MODELS.includes(v) ? v : DEFAULT_SEPARATOR;
}

/** 是否是 MDX 系后端（走 audio-separator，CPU 跑 ONNX，没有 --demucs-device 概念）。 */
export function isMdxSeparator(value) {
  return normalizeSeparator(value).startsWith('mdx');
}

function detectDefaultModel() {
  try {
    const dir = path.join(ROOT, 'svc', 'models');
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    return names.includes('hutao') ? 'hutao' : (names[0] || 'hutao');
  } catch {
    return 'hutao';
  }
}

export function svcConfig(raw = null) {
  const cfg = getConfig();
  const cur = raw || (cfg.audio && cfg.audio.svc) || {};
  const url = String(cur.url || DEFAULT_URL).replace(/\/+$/, '');
  let port = 3212;
  try { port = Number(new URL(url).port || 3212); } catch { /* 用默认端口 */ }
  return {
    enabled: cur.enabled !== false,
    autoStart: cur.autoStart !== false,
    url,
    port,
    pythonPath: String(cur.pythonPath || '').trim() || path.join(ROOT, 'rvc', 'py310', 'python.exe'),
    scriptPath: String(cur.scriptPath || '').trim() || path.join(ROOT, 'svc', 'svc_service.py'),
    model: String(cur.model || detectDefaultModel()).trim(),
    device: String(cur.device || 'auto').trim(),
    trans: Number.isFinite(Number(cur.trans)) ? Number(cur.trans) : 0,
    f0p: String(cur.f0p || 'crepe').trim(),
    mixInstrumental: cur.mixInstrumental !== false,
    vocalGain: Number.isFinite(Number(cur.vocalGain)) ? Number(cur.vocalGain) : 1.0,
    instGain: Number.isFinite(Number(cur.instGain)) ? Number(cur.instGain) : 1.0,
    // 真唱（DiffSinger）出来的干声要不要再过一遍 RVC 换真人音色。
    // 实测：RVC 走 GPU 约 0.17× 实时（7 秒干声 ~2 秒），平坦度砍半；
    // 效果和 Seed-VC 持平但快 160 倍。服务不可用时引擎侧会自动跳过，不影响唱歌。
    // 唱歌默认出干声（只人声、不混伴奏）。
    //   ①「唱：歌词」走 DiffSinger：干声 = 不加自动生成的和弦伴奏（--no-acc）
    //   ②「翻唱原曲」走 route A：干声 = 不混原曲伴奏、不做母带（--dry）
    // 想听「带伴奏的完整成品」就在 设置 → 语音 → 唱歌 里关掉。
    singDry: cur.singDry !== false,
    coverDry: cur.coverDry !== false,
    // 原曲翻唱的人声分离后端（route_a.py --separator）。
    // 唯一真相源之一：cover-song.js 拿它拼命令行，控制台 设置→语音→唱歌转换 写到 audio.svc.separator。
    // 必须白名单校验：route_a 的 argparse 只有一个 choices，写错一个字母就是退出码 2 + 整单失败，
    // 而报错文案是 python 的 usage 提示，群里看着像「引擎挂了」。
    separator: normalizeSeparator(cur.separator),
    // 没有旋律来源时还让不让唱（算法现编）。默认 false：没调就不唱，
    // 免得群里听到「跑调的原创」——那在听众耳朵里就是乱唱。
    allowImprovise: cur.allowImprovise === true,
    // 默认曲目（歌名）：没说唱什么时唱这首。留空=反问对方。
    defaultSong: String(cur.defaultSong || '').trim(),
    // 唱歌换音色引擎：rvc（常驻 RVC 服务）/ ddsp（知更鸟 DDSP-SVC）
    vcEngine: String(cur.vcEngine || 'rvc').trim(),
    vc: cur.vc !== false,
    vcIndexRate: Number.isFinite(Number(cur.vcIndexRate)) ? Number(cur.vcIndexRate) : 0.8,
    vcProtect: Number.isFinite(Number(cur.vcProtect)) ? Number(cur.vcProtect) : 0.4,
    vcEnhance: Number(cur.vcEnhance) === 1 ? 1 : 0,
    maxSeconds: Math.max(10, Number(cur.maxSeconds) || 240),
    timeoutMs: Math.max(60000, Number(cur.timeoutMs) || 900000),
    startTimeoutMs: Math.max(20000, Number(cur.startTimeoutMs) || 120000),
    logFile: path.join(ROOT, 'svc', 'svc-service.log')
  };
}

let child = null;
let starting = null;

export async function svcHealth(timeoutMs = 2000) {
  const c = svcConfig();
  try {
    const res = await fetch(c.url + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function startService(c, log) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(c.logFile), { recursive: true });
      const out = fs.openSync(c.logFile, 'a');
      child = spawn(c.pythonPath, [c.scriptPath, '--model', c.model, '--device', c.device, '--port', String(c.port)], {
        cwd: path.join(ROOT, 'svc'),
        stdio: ['ignore', out, out],
        windowsHide: true
      });
      child.on('exit', () => { child = null; });
    } catch (error) {
      return resolve({ ok: false, reason: '唱歌服务启动失败：' + (error?.message ?? error) });
    }
    const deadline = Date.now() + c.startTimeoutMs;
    const tick = async () => {
      const h = await svcHealth(1200);
      if (h && h.loaded) return resolve({ ok: true, started: true, health: h });
      if (Date.now() > deadline) {
        return resolve({ ok: false, reason: '唱歌服务启动超时（' + Math.round(c.startTimeoutMs / 1000) + 's），详见 ' + c.logFile });
      }
      setTimeout(tick, 1200);
    };
    if (typeof log === 'function') log('[svc] 正在启动唱歌服务（首次加载模型约 10~20 秒）…');
    setTimeout(tick, 1500);
  });
}

/** 确保唱歌服务在跑（没在跑就拉起来）。 */
export async function ensureSvcService({ log = null, force = false } = {}) {
  const c = svcConfig();
  if (!c.enabled) return { ok: false, reason: '唱歌功能未启用（config.audio.svc.enabled=false）' };
  const h = await svcHealth(1500);
  if (h && h.loaded) return { ok: true, started: false, health: h };
  if (!c.autoStart && !force) return { ok: false, reason: '唱歌服务没在运行，且没开自动启动', health: h };
  if (starting) return starting;
  starting = startService(c, log);
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

function pidOnPort(port) {
  const script =
    '$c=Get-NetTCPConnection -LocalPort ' + port +
    ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}';
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000 });
    const pid = parseInt(String(r.stdout || '').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** 停掉唱歌服务（force=true 时按端口杀，不管谁拉起来的）。 */
export function stopSvcService({ force = false } = {}) {
  let stopped = false;
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    child = null;
    stopped = true;
  }
  if (stopped && !force) return true;
  const pid = pidOnPort(svcConfig().port);
  if (!pid) return stopped;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000 });
    stopped = true;
  } catch { /* ignore */ }
  return stopped;
}

/** 列出 svc\models 里可用的歌声模型。 */
export function listSvcModels() {
  const dir = path.join(ROOT, 'svc', 'models');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const p = path.join(dir, d.name);
        const g = fs.readdirSync(p).find((f) => f.startsWith('G_') && f.endsWith('.pth'));
        const st = g ? fs.statSync(path.join(p, g)) : null;
        return { name: d.name, file: g || '', sizeMB: st ? Math.round(st.size / 1048576) : 0, mtime: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function postAudio(endpoint, buffer, query, timeoutMs) {
  const res = await fetch(svcConfig().url + endpoint + '?' + query.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buffer,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('唱歌服务返回 HTTP ' + res.status + '：' + String(detail).slice(0, 200));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

/**
 * 整首歌 → 胡桃歌声（自动分离人声、转换、再与伴奏混音）。
 * @returns {{buffer:Buffer, ext:'wav', costMs:number, model:string}}
 */
export async function singSong(buffer, { trans = null, mix = null, log = null } = {}) {
  const c = svcConfig();
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!raw.length) throw new Error('音频为空');
  const ready = await ensureSvcService({ log });
  if (!ready.ok) throw new Error(ready.reason || '唱歌服务不可用');
  const q = new URLSearchParams();
  q.set('trans', String(trans === null || trans === undefined ? c.trans : Number(trans)));
  q.set('spk', c.model === 'hutao-alt' ? 'hutao' : c.model);
  q.set('f0p', c.f0p);
  q.set('mix', (mix === null || mix === undefined ? c.mixInstrumental : !!mix) ? '1' : '0');
  q.set('vocalGain', String(c.vocalGain));
  q.set('instGain', String(c.instGain));
  q.set('fmt', 'wav');
  const t0 = Date.now();
  const buf = await postAudio('/sing', raw, q, c.timeoutMs);
  return { buffer: buf, ext: 'wav', costMs: Date.now() - t0, model: c.model };
}

/** 纯干声 → 胡桃歌声（不分离、不混音，快一些）。 */
export async function convertSinging(buffer, { trans = null, log = null } = {}) {
  const c = svcConfig();
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!raw.length) throw new Error('音频为空');
  const ready = await ensureSvcService({ log });
  if (!ready.ok) throw new Error(ready.reason || '唱歌服务不可用');
  const q = new URLSearchParams();
  q.set('trans', String(trans === null || trans === undefined ? c.trans : Number(trans)));
  q.set('spk', c.model === 'hutao-alt' ? 'hutao' : c.model);
  q.set('f0p', c.f0p);
  q.set('fmt', 'wav');
  const t0 = Date.now();
  const buf = await postAudio('/convert', raw, q, c.timeoutMs);
  return { buffer: buf, ext: 'wav', costMs: Date.now() - t0, model: c.model };
}
