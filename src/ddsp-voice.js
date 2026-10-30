// DDSP-SVC 歌声转换客户端（知更鸟音色）
//
//   服务端：ddsp-svc/ddsp_service.py（ddsp-svc/DDSP-SVC 的 RectifiedFlow cascade 模型）
//   用途：把「干声」换成知更鸟的音色，给两条唱歌链路用：
//     ① 歌词真唱（DiffSinger 渲染出来的干声）
//     ② 原曲翻唱（route_a 分离出来的人声）
//   说话不走这里：TTS → RVC（rvc-voice.js）更快，形态也更适合说话。
//
// 本机只有 4GB 显存，DDSP 服务和常驻 RVC 服务同时占卡会顶到 ~3.9/4.0GB，
// 所以唱歌前调用方要先停 RVC、唱完再拉起来（cover-song.js 已有这套逻辑）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig, ROOT } from './config.js';

const DEFAULT_URL = 'http://127.0.0.1:3213';

export function ddspConfig(raw = null) {
  const cfg = getConfig();
  const cur = raw || (cfg.audio && cfg.audio.ddsp) || {};
  const url = String(cur.url || DEFAULT_URL).replace(/\/+$/, '');
  let port = 3213;
  try { port = Number(new URL(url).port || 3213); } catch { /* 默认端口 */ }
  return {
    enabled: cur.enabled === true,
    autoStart: cur.autoStart !== false,
    url,
    port,
    pythonPath: String(cur.pythonPath || '').trim() || path.join(ROOT, 'rvc', 'py310', 'python.exe'),
    scriptPath: String(cur.scriptPath || '').trim() || path.join(ROOT, 'ddsp-svc', 'ddsp_service.py'),
    model: String(cur.model || 'zhigengniao').trim(),
    device: String(cur.device || 'auto').trim(),
    steps: Number.isFinite(Number(cur.steps)) ? Number(cur.steps) : 20,
    maxSeconds: Number.isFinite(Number(cur.maxSeconds)) ? Number(cur.maxSeconds) : 240,
    timeoutMs: Math.max(30000, Number(cur.timeoutMs) || 600000),
    startTimeoutMs: Math.max(30000, Number(cur.startTimeoutMs) || 180000),
    logFile: path.join(ROOT, 'ddsp-svc', 'ddsp-service.log')
  };
}

let child = null;
let starting = null;

/** 模型目录（ddsp-svc/models/*），设置界面下拉用。 */
export function listDdspModels() {
  const dir = path.join(ROOT, 'ddsp-svc', 'models');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'model.pt')))
      .map((d) => ({ name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function ddspHealth(timeoutMs = 2000) {
  const c = ddspConfig();
  try {
    const res = await fetch(c.url + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.loaded ? data : null;
  } catch {
    return null;
  }
}

function appendLog(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
  } catch { /* ignore */ }
}

async function startService(c, log) {
  if (!fs.existsSync(c.pythonPath)) return { ok: false, reason: '找不到 Python：' + c.pythonPath };
  if (!fs.existsSync(c.scriptPath)) return { ok: false, reason: '找不到 DDSP 服务脚本：' + c.scriptPath };
  const args = [
    c.scriptPath,
    '--model', c.model,
    '--device', c.device,
    '--steps', String(c.steps),
    '--port', String(c.port)
  ];
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1'
  };
  // numba/librosa 在受限环境里需要可写缓存目录（服务脚本自己也会设，这里双保险）
  if (!env.NUMBA_CACHE_DIR) env.NUMBA_CACHE_DIR = path.join(ROOT, 'ddsp-svc', 'tmp', 'numba');
  child = spawn(c.pythonPath, args, {
    cwd: path.dirname(c.scriptPath),
    windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const tag = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ';
  appendLog(c.logFile, tag + '启动 DDSP 服务 pid=' + child.pid + ' ' + args.join(' ') + '\n');
  child.stdout.on('data', (b) => appendLog(c.logFile, tag + String(b)));
  child.stderr.on('data', (b) => appendLog(c.logFile, tag + String(b)));
  child.on('exit', (code) => {
    appendLog(c.logFile, tag + 'DDSP 服务退出 code=' + code + '\n');
    child = null;
  });
  if (log) log('知更鸟歌声服务启动中…（加载模型约 10~30 秒）');
  const deadline = Date.now() + c.startTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await ddspHealth(1500);
    if (h) return { ok: true, started: true, health: h };
    if (!child) break;
  }
  return { ok: false, reason: 'DDSP 服务启动超时，详见 ' + c.logFile };
}

/** 确保 DDSP 服务在跑（没在跑且开了 autoStart 就拉起来）。 */
export async function ensureDdspService({ log = null, force = false } = {}) {
  const c = ddspConfig();
  if (!c.enabled) return { ok: false, reason: 'DDSP 歌声未启用（config.audio.ddsp.enabled=false）' };
  const h = await ddspHealth(1200);
  if (h) return { ok: true, started: false, health: h };
  if (!c.autoStart && !force) return { ok: false, reason: 'DDSP 服务没在运行，且没开自动启动' };
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

export function stopDdspService({ force = false } = {}) {
  const c = ddspConfig();
  let stopped = false;
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    child = null;
    stopped = true;
  }
  if (stopped && !force) return true;
  const pid = pidOnPort(c.port);
  if (!pid) return stopped;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000 });
    stopped = true;
  } catch { /* ignore */ }
  return stopped;
}

/**
 * 把一段干声换成知更鸟音色。
 * @returns {Promise<{buffer: Buffer, ext: string, seconds: number, costMs: number}>}
 */
export async function ddspConvert(buffer, { format = 'wav', steps = null, f0up = 0, maxSeconds = null } = {}) {
  const c = ddspConfig();
  const ready = await ensureDdspService({ log: null });
  if (!ready.ok) throw new Error(ready.reason || 'DDSP 服务不可用');
  const q = new URLSearchParams({ format });
  if (steps) q.set('steps', String(steps));
  if (Number.isFinite(Number(f0up))) q.set('f0up', String(Number(f0up)));
  if (maxSeconds) q.set('maxSeconds', String(maxSeconds));
  const t0 = Date.now();
  const res = await fetch(c.url + '/convert?' + q.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buffer,
    signal: AbortSignal.timeout(c.timeoutMs)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error('DDSP 转换失败 ' + res.status + ': ' + String(msg).slice(0, 200));
  }
  const out = Buffer.from(await res.arrayBuffer());
  if (!out.length) throw new Error('DDSP 返回空音频');
  return {
    buffer: out,
    ext: format,
    seconds: Math.round((Number(res.headers.get('x-ddsp-seconds')) || 0) * 10) / 10,
    costMs: Date.now() - t0
  };
}
