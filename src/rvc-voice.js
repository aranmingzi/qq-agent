// RVC 音色转换：把 TTS 出来的声音换成训练好的目标音色（花火2.0-赵爽）
//   服务端：rvc\\rvc_service.py（rvc\\py310 里的 Python，默认端口 3211）
//   接入点：tools.js 的 send_voice —— 合成完先过一遍 RVC，再交给 NapCat 发送
//   配置：config.audio.rvc（enabled / url / model / device / f0upKey / method ...）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { getConfig, ROOT } from './config.js';

const DEFAULT_URL = 'http://127.0.0.1:3211';
// ⚠️ 不再写死 'huahuo'：曾三次因「model 字段读取不到就 fallback 到 huahuo」导致
//   音色被静默切回花火。改为从 models 目录动态探测默认模型。
function detectDefaultModel() {
  try {
    const dir = path.join(ROOT, 'rvc', 'models');
    const files = fs.readdirSync(dir).filter((f) => /\.pth$/i.test(f));
    // 优先 hutao（胡桃），其次任意非 huahuo 的模型，最后才 huahuo
    const names = files.map((f) => f.replace(/\.pth$/i, ''));
    return names.find((n) => n === 'hutao') || names.find((n) => n !== 'huahuo') || names[0] || '';
  } catch {
    return '';
  }
}
const DEFAULT_MODEL = detectDefaultModel();

export function rvcConfig(raw = null) {
  const cfg = getConfig();
  const current = raw || (cfg.audio && cfg.audio.rvc) || {};
  const url = String(current.url || DEFAULT_URL).replace(/\/+$/, '');
  let port = 3211;
  try {
    const parsed = new URL(url);
    port = Number(parsed.port || 3211);
  } catch {
    /* 用默认端口 */
  }
  return {
    enabled: current.enabled === true,
    autoStart: current.autoStart !== false,
    url,
    port,
    pythonPath: String(current.pythonPath || '').trim() || path.join(ROOT, 'rvc', 'py310', 'python.exe'),
    scriptPath: String(current.scriptPath || '').trim() || path.join(ROOT, 'rvc', 'rvc_service.py'),
    model: String(current.model || DEFAULT_MODEL).trim(),
    device: String(current.device || 'auto').trim(),
    f0upKey: Number.isFinite(Number(current.f0upKey)) ? Number(current.f0upKey) : 0,
    method: String(current.method || 'rmvpe').trim(),
    // 音质 / 自然度（config 里不写就用 RVC 官方默认值，行为与改动前完全一致）
    //   protect:     0~0.5，越大越保留原始清辅音和呼吸声（活人感的关键）
    //   rmsMixRate:  0~1，1=完全用模型音量包络；调小则保留输入本身的语调起伏
    //   indexRate:   0~1，检索索引的介入强度
    protect: Number.isFinite(Number(current.protect)) ? Number(current.protect) : 0.33,
    rmsMixRate: Number.isFinite(Number(current.rmsMixRate)) ? Number(current.rmsMixRate) : 1.0,
    indexRate: Number.isFinite(Number(current.indexRate)) ? Number(current.indexRate) : 0.5,
    // 人声后处理强度：0=关闭，1=默认。压掉声码器"编造"的超高频，减金属感
    enhance: Number.isFinite(Number(current.enhance)) ? Number(current.enhance) : 1.0,
    // SILK 预适配：1=开启。输出降到 16kHz 并预加重，缓解 QQ 语音 SILK 编码后的模糊
    silk: current.silk === true || Number(current.silk) === 1,
    // true=说话跳过 GPT-SoVITS 角色本音，统一走「TTS→RVC」（知更鸟没有 GSV 模型）
    preferOverGsv: current.preferOverGsv === true,
    timeoutMs: Math.max(5000, Number(current.timeoutMs) || 180000),
    startTimeoutMs: Math.max(10000, Number(current.startTimeoutMs) || 150000),
    logFile: String(current.logFile || '').trim() || path.join(ROOT, 'rvc', 'rvc-service.log'),
    fallbackToRaw: current.fallbackToRaw !== false
  };
}

export function rvcInfo() {
  const c = rvcConfig();
  return {
    enabled: c.enabled,
    url: c.url,
    model: c.model,
    device: c.device,
    f0upKey: c.f0upKey,
    method: c.method,
    protect: c.protect,
    rmsMixRate: c.rmsMixRate,
    indexRate: c.indexRate,
    enhance: c.enhance,
    silk: c.silk,
    pythonPath: c.pythonPath,
    pythonExists: fs.existsSync(c.pythonPath),
    scriptPath: c.scriptPath,
    scriptExists: fs.existsSync(c.scriptPath),
    logFile: c.logFile
  };
}

export async function rvcHealth(timeoutMs = 2500) {
  const c = rvcConfig();
  try {
    const res = await fetch(c.url + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

export async function rvcStatus() {
  const health = await rvcHealth(2000);
  return { ...rvcInfo(), running: !!health, health: health || null };
}

let child = null;
let starting = null;

function appendLog(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
  } catch {
    /* ignore */
  }
}

async function startService(c, log) {
  if (!fs.existsSync(c.pythonPath)) return { ok: false, reason: '找不到 Python：' + c.pythonPath };
  if (!fs.existsSync(c.scriptPath)) return { ok: false, reason: '找不到服务脚本：' + c.scriptPath };
  const args = [
    c.scriptPath,
    '--model', c.model,
    '--device', c.device,
    '--f0-method', c.method,
    '--f0up', String(c.f0upKey),
    '--protect', String(c.protect),
    '--rms-mix-rate', String(c.rmsMixRate),
    '--index-rate', String(c.indexRate),
    '--enhance', String(c.enhance),
    '--port', String(c.port)
  ];
  if (c.silk) args.splice(args.indexOf('--port'), 0, '--silk', '1');
  try {
    child = spawn(c.pythonPath, args, {
      cwd: path.dirname(c.scriptPath),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    return { ok: false, reason: '启动 RVC 失败：' + (error?.message ?? error) };
  }
  const tag = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ';
  appendLog(c.logFile, tag + '启动 RVC 服务 pid=' + child.pid + ' ' + args.join(' ') + '\n');
  child.stdout.on('data', (b) => appendLog(c.logFile, tag + String(b)));
  child.stderr.on('data', (b) => appendLog(c.logFile, tag + String(b)));
  child.on('exit', (code) => {
    appendLog(c.logFile, tag + 'RVC 服务退出 code=' + code + '\n');
    child = null;
  });
  if (log) log('RVC 音色服务启动中…（首次加载模型要几秒）');
  const deadline = Date.now() + c.startTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await rvcHealth(1500);
    if (h && h.loaded) return { ok: true, started: true, health: h };
  }
  return {
    ok: false,
    reason: 'RVC 服务启动超时（' + Math.round(c.startTimeoutMs / 1000) + 's），详见 ' + c.logFile
  };
}

/** 确保本地 RVC 服务在跑（没在跑且开了 autoStart 就拉起来）。 */
export async function ensureRvcService({ log = null, force = false } = {}) {
  const c = rvcConfig();
  if (!c.enabled) return { ok: false, reason: 'RVC 音色未启用（config.audio.rvc.enabled=false）' };
  const h = await rvcHealth(1200);
  if (h && h.loaded) return { ok: true, started: false, health: h };
  if (!c.autoStart && !force) return { ok: false, reason: 'RVC 服务没在运行，且没开自动启动', health: h };
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

/**
 * 停掉音色服务。
 *   force=false：只停本进程拉起来的那一个
 *   force=true ：不管谁拉起来的，按端口找到进程一起停（设置界面「停止服务」用）
 */
export function stopRvcService({ force = false } = {}) {
  const c = rvcConfig();
  let stopped = false;
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
    stopped = true;
  }
  if (stopped && !force) return true;
  const pid = pidOnPort(c.port);
  if (!pid) return stopped;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000 });
    stopped = true;
  } catch {
    /* ignore */
  }
  return stopped;
}

/** 重启音色服务：停掉旧的，再按当前配置（模型/设备）重新拉起。 */
export async function restartRvcService({ log = null } = {}) {
  stopRvcService({ force: true });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const h = await rvcHealth(700);
    if (!h) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return ensureRvcService({ log, force: true });
}

/** 列出 rvc\models 里可用的音色模型（设置界面下拉用）。 */
export function listRvcModels() {
  const dir = path.join(ROOT, 'rvc', 'models');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.pth$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f.replace(/\.pth$/i, ''), file: f, sizeMB: Math.round(st.size / 1048576), mtime: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** 角色 key → RVC 模型名。sparkle（花火）的 pth 文件叫 huahuo，其余同名。 */
const RVC_VOICE_ALIASES = { sparkle: 'huahuo', huahuo: 'huahuo' };

/**
 * 给定角色本音 key，返回 rvc\models 里**对得上**的那个模型名（没有则 null）。
 * ★ 为什么要这一步：以前 RVC 永远只换成 config.audio.rvc.model 那一个音色，
 *   请求纳西妲/流萤时也会被换成胡桃 —— 音色参数等于摆设。
 *   现在按角色找同名 pth，找不到就宁可不换（宁可没声音，也不要发错人的声音）。
 */
export function rvcModelForVoice(voiceKey) {
  const want = String(voiceKey || '').trim().toLowerCase();
  if (!want) return null;
  const available = listRvcModels().map((m) => m.name.toLowerCase());
  const alias = RVC_VOICE_ALIASES[want] || want;
  if (available.includes(alias)) return alias;
  if (available.includes(want)) return want;
  return null;
}

/**
 * 把一段音频（TTS 结果）转成目标音色。
 * @param {object} [opts]
 * @param {string} [opts.model]  本次要用的模型名；不传/与已加载相同则沿用当前模型。
 *                               RVC 服务支持 /reload 热切换，换模型不必重启进程。
 * @returns {{buffer:Buffer, ext:string, converted:boolean, reason?:string, costMs?:number, model?:string}}
 */
export async function convertVoice(buffer, { format = 'mp3', f0up = null, silk = null, model = null } = {}) {
  const c = rvcConfig();
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!c.enabled) return { buffer: raw, ext: format, converted: false, reason: 'RVC 音色未启用' };
  if (!raw.length) return { buffer: raw, ext: format, converted: false, reason: '音频为空' };
  const ready = await ensureRvcService({ log: null });
  if (!ready.ok) {
    if (c.fallbackToRaw) return { buffer: raw, ext: format, converted: false, reason: ready.reason };
    throw new Error(ready.reason || 'RVC 服务不可用');
  }
  // 换音色：请求的模型和当前加载的不一致才 reload（一次约 1~3 秒）
  let usedModel = c.model;
  const wantModel = String(model || '').trim();
  if (wantModel && wantModel.toLowerCase() !== String(c.model || '').trim().toLowerCase()) {
    const health = await rvcHealth(3000);
    const loadedModel = String(health?.model || '').trim().toLowerCase();
    if (loadedModel !== wantModel.toLowerCase()) {
      const reloadRes = await fetch(c.url + '/reload?model=' + encodeURIComponent(wantModel), {
        method: 'POST',
        signal: AbortSignal.timeout(Math.max(30000, c.startTimeoutMs))
      }).catch(() => null);
      if (!reloadRes || !reloadRes.ok) {
        const reason = 'RVC 切换模型失败：' + wantModel;
        if (c.fallbackToRaw) return { buffer: raw, ext: format, converted: false, reason };
        throw new Error(reason);
      }
    }
    usedModel = wantModel;
  }
  const q = new URLSearchParams({ format: String(format || 'mp3') });
  // 升降调和音高提取方法每次都按当前配置下发，所以改了设置不用重启服务
  const shift = f0up === null || f0up === undefined ? c.f0upKey : Number(f0up);
  if (Number.isFinite(shift)) q.set('f0up', String(shift));
  if (c.method) q.set('method', c.method);
  // 音质参数也按当前配置下发（改了 config 即时生效，不用重启 RVC 服务）：
  //   protect：保留清辅音/呼吸，越大越有活人感、越少金属感
  //   indexRate：检索索引介入强度，身份感强但杂音多就调低
  //   rmsMixRate：保留输入语调起伏
  //   enhance：压掉声码器编造的超高频，减金属感
  if (Number.isFinite(c.protect)) q.set('protect', String(c.protect));
  if (Number.isFinite(c.indexRate)) q.set('indexRate', String(c.indexRate));
  if (Number.isFinite(c.rmsMixRate)) q.set('rmsMix', String(c.rmsMixRate));
  if (Number.isFinite(c.enhance)) q.set('enhance', String(c.enhance));
  // silk 预适配：默认跟随配置，可单次覆盖
  const doSilk = silk === null || silk === undefined ? c.silk : !!silk;
  q.set('silk', doSilk ? '1' : '0');
  const started = Date.now();
  let res;
  try {
    res = await fetch(c.url + '/convert?' + q.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
      signal: AbortSignal.timeout(c.timeoutMs)
    });
  } catch (error) {
    const reason = '连不上 RVC 服务：' + (error?.message ?? error);
    if (c.fallbackToRaw) return { buffer: raw, ext: format, converted: false, reason };
    throw new Error(reason);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const reason = 'RVC 转换失败 HTTP ' + res.status + ' ' + String(detail).slice(0, 160);
    if (c.fallbackToRaw) return { buffer: raw, ext: format, converted: false, reason };
    throw new Error(reason);
  }
  const out = Buffer.from(await res.arrayBuffer());
  if (!out.length) {
    if (c.fallbackToRaw) return { buffer: raw, ext: format, converted: false, reason: 'RVC 返回空音频' };
    throw new Error('RVC 返回空音频');
  }

  // ── 校验"真的换了"，而不是"拿到了响应" ────────────────────────────────
  // ★ 2026-10-30 踩到的坑：服务进程在转换中途退出时，HTTP 仍返回 200、
  //   响应体是**原始音频**（服务端没换成就直接回原样），旧代码只要 out.length>0
  //   就报 converted:true —— 上层以为换声成功，实际发出去的是没换的音频，
  //   而且是静默的，排查时完全看不出。
  //
  // ★ 判据为什么不能只看采样率：furina 是 RVC v2 **40k** 模型，服务端 /health 报
  //   tgt_sr=40000，但实测吐出来的是 24000Hz（模型 sr 与输出 sr 不一定一致）。
  //   拿"输入输出采样率相同"当失败判据会误杀正常结果。
  //   改成逐字节比对：没换声时服务端是把原 buffer 原样回传，字节完全相同。
  //   这比采样率准，也比"听一下"可靠。
  if (raw.length === out.length && raw.equals(out)) {
    const reason = 'RVC 未换声（响应与原音频逐字节相同，服务未实际处理）';
    if (c.fallbackToRaw) return { buffer: raw, ext: format, converted: false, reason };
    throw new Error(reason);
  }

  return {
    buffer: out,
    ext: String(res.headers.get('x-rvc-format') || format || 'mp3'),
    converted: true,
    model: usedModel,
    inSampleRate: wavSampleRate(raw),
    outSampleRate: wavSampleRate(out),
    costMs: Number(res.headers.get('x-rvc-cost-ms')) || (Date.now() - started)
  };
}

/**
 * 从 WAV 头里读采样率。不是 WAV 就返回 0（调用方据此跳过校验，不误判）。
 * 只认 'RIFF'/'WAVE' + fmt 块，够用了 —— 这里只需要一个粗判据。
 */
function wavSampleRate(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return 0;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
    // 跳过 'WAVE' 后找 'fmt ' 块
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') return buf.readUInt32LE(off + 12);
      off += 8 + size + (size % 2);
    }
    return 0;
  } catch {
    return 0;
  }
}
