// NapCat 的 OneBot 端口配置：自动补 / 修。
//
// 为什么需要它（同类实现踩过、我们也踩得到的坑）：
//   NapCat 只会读 \`config/onebot11_<实际登录的号>.json\`。
//   找不到带号的配置时，它会自己生成一份 **什么服务端都没开** 的配置 ——
//   于是 3001/3000 永远不开，而且 **一句报错都没有**，
//   表现就是"QQ 明明登录了，机器人却一直显示离线"。
//
// 本模块做两件事（都不动用户自己改过的配置）：
//   ① 始终存在一份**账号无关**的模板 \`config/onebot11.json\`：
//      NapCat 换任何号登录都会照它生成带端口的配置，一步到位；
//   ② 扫描已有的 \`onebot11_<号>.json\`：
//      · 一个端口都没开 → 补上（历史遗留的空配置）
//      · 端口是**我们写的那份**、但和你设置里的端口不一致 → 对齐（改了设置也能生效）
//      · 用户自己改过的（服务端名字不是我们的）→ 一律不动，只在日志里说明
//
// 纪律：覆盖前先备份 \`.bak-<时间戳>\`；写入用"临时文件 + rename"（防半截文件）；
//       解析失败的文件绝不动；已经对了就不写盘（幂等）。
import fs from 'node:fs';
import path from 'node:path';

export const HTTP_SERVER_NAME = 'QQAgent HTTP';
export const WS_SERVER_NAME = 'QQAgent WebSocket';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function backup(file, stamp) {
  try {
    const bak = file + '.bak-' + stamp;
    fs.copyFileSync(file, bak);
    return bak;
  } catch {
    return '';
  }
}

function httpEntry(port, token) {
  return {
    name: HTTP_SERVER_NAME, enable: true, host: '127.0.0.1', port,
    enableCors: true, enableWebsocket: false, messagePostFormat: 'array',
    token: token || '', debug: false, reportSelfMessage: false
  };
}

function wsEntry(port, token) {
  return {
    name: WS_SERVER_NAME, enable: true, host: '127.0.0.1', port,
    messagePostFormat: 'array', reportSelfMessage: false,
    enableForcePushEvent: true, token: token || '', debug: false, heartInterval: 30000
  };
}

function enabled(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && s.enable !== false && Number(s.port) > 0);
}

/** 配置里有没有"我们自己写的那两个服务端"（决定能不能安全地改端口）。 */
function isOurs(cfg) {
  const all = [...((cfg && cfg.network && cfg.network.httpServers) || []), ...((cfg && cfg.network && cfg.network.websocketServers) || [])];
  return all.some((s) => s && (s.name === HTTP_SERVER_NAME || s.name === WS_SERVER_NAME));
}

/** 把我们的两个服务端塞进配置（其余原样保留）；同名则就地更新。 */
function withServers(cfg, want) {
  const net = { ...((cfg && cfg.network) || {}) };
  const put = (key, entry) => {
    const list = Array.isArray(net[key]) ? [...net[key]] : [];
    const idx = list.findIndex((s) => s && s.name === entry.name);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    net[key] = list;
  };
  put('httpServers', httpEntry(want.httpPort, want.token));
  put('websocketServers', wsEntry(want.wsPort, want.token));
  return { ...cfg, network: net };
}

function freshConfig(want) {
  return {
    network: {
      httpServers: [httpEntry(want.httpPort, want.token)],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [wsEntry(want.wsPort, want.token)],
      websocketClients: [],
      plugins: []
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 }
  };
}

/**
 * 读出 NapCat **实际会监听** 的端口（给"定位进程"用）。
 *
 * 为什么不能硬编码 3000/3001/6099：
 *   端口是可配置的（设置里改 httpUrl/wsUrl 就变），NapCat 遇到端口冲突还会自己
 *   换成随机高位端口（本机就见过 50018/54563/58909/60223…）。判据一旦写死，
 *   "按端口找进程"这条路径就会悄悄失效 —— 表现出来就是 **点了关闭却关不掉**。
 *
 * 只收 "服务端" 端口，绝不收 httpClients/websocketClients：
 *   客户端端口是**连别人**的，拿它去反查 LISTEN 的 owner，杀到的是被连的那个程序。
 *
 * 只读 `onebot11*.json` 正身，不读 `.bak-*` 备份：
 *   备份里存着历代随机端口（几百份），混进来等于拿过期判据去杀进程。
 *
 * @returns {{ports:number[], sources:Array<{port:number,file:string}>, configDir:string}}
 */
export function readConfiguredPorts(dir, { fallback = [3000, 3001, 6099] } = {}) {
  const configDir = path.join(String(dir || ''), 'config');
  const sources = [];
  const seen = new Set();
  const add = (port, file) => {
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return;
    if (!seen.has(n)) { seen.add(n); sources.push({ port: n, file }); }
  };

  const collectServers = (cfg, file) => {
    const net = (cfg && cfg.network) || {};
    // 服务端（本地监听）三类：HTTP / HTTP-SSE / WebSocket 服务端
    for (const key of ['httpServers', 'httpSseServers', 'websocketServers']) {
      for (const s of enabled(net[key])) add(s.port, file);
    }
  };

  try {
    for (const name of fs.readdirSync(configDir)) {
      if (!/^onebot11(_\d+)?\.json$/.test(name)) continue;   // 排除 .bak-* 与无关文件
      const cfg = readJson(path.join(configDir, name));
      if (cfg) collectServers(cfg, name);
    }
    const webui = readJson(path.join(configDir, 'webui.json'));
    if (webui && webui.disableWebUI !== true) add(webui.port, 'webui.json');
  } catch {
    /* 目录不存在 / 不可读：交给 fallback */
  }

  for (const p of fallback) add(p, 'fallback');
  return { ports: sources.map((s) => s.port).sort((a, b) => a - b), sources, configDir };
}

/**
 * 补 / 修 NapCat 的 OneBot 端口配置（幂等，只做必要写入，改前备份）。
 * @param dir     SnowLuma/NapCat 目录（其下应有 config/）
 * @param opts    { httpPort, wsPort, token, stamp, log }
 * @returns {{ok:boolean, configDir:string, changes:Array, error?:string}}
 */
export function ensureOnebotConfigs(dir, { httpPort = 3000, wsPort = 3001, token = '', stamp = null, log = () => {} } = {}) {
  const changes = [];
  const stampText = stamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const configDir = path.join(String(dir || ''), 'config');
  if (!dir || !fs.existsSync(configDir)) {
    return { ok: false, configDir, changes, error: '找不到 NapCat 配置目录：' + configDir };
  }
  const want = { httpPort: Number(httpPort) || 3000, wsPort: Number(wsPort) || 3001, token: String(token || '') };

  const handle = (file, kind) => {
    const name = path.basename(file);
    if (!fs.existsSync(file)) {
      writeJson(file, freshConfig(want));
      changes.push({ file: name, kind, action: 'created' });
      return;
    }
    const cfg = readJson(file);
    if (!cfg) { changes.push({ file: name, kind, action: 'skip-unparsable' }); return; }
    const http = enabled(cfg.network && cfg.network.httpServers);
    const ws = enabled(cfg.network && cfg.network.websocketServers);
    if (!http.length && !ws.length) {
      backup(file, stampText);
      writeJson(file, withServers(cfg, want));
      changes.push({ file: name, kind, action: 'filled' });
      return;
    }
    const gotHttp = Number((http[0] || {}).port) || 0;
    const gotWs = Number((ws[0] || {}).port) || 0;
    const portsOk = (!http.length || gotHttp === want.httpPort) && (!ws.length || gotWs === want.wsPort);
    if (portsOk) { changes.push({ file: name, kind, action: 'ok' }); return; }
    if (!isOurs(cfg)) {
      changes.push({ file: name, kind, action: 'skip-foreign', note: '端口是 ' + gotHttp + '/' + gotWs + '（不是我们写的），未改动' });
      return;
    }
    backup(file, stampText);
    writeJson(file, withServers(cfg, want));
    changes.push({ file: name, kind, action: 'realigned', note: gotHttp + '/' + gotWs + ' → ' + want.httpPort + '/' + want.wsPort });
  };

  handle(path.join(configDir, 'onebot11.json'), 'template');                       // ① 账号无关模板
  for (const f of fs.readdirSync(configDir).filter((n) => /^onebot11_\d+\.json$/.test(n))) {
    handle(path.join(configDir, f), 'account');                                    // ② 已有按账号配置
  }

  const needRelogin = '；协议端只在登录那一刻读这份配置，需重新登录一次才生效';
  for (const c of changes) {
    if (c.action === 'created') log('[OneBot 配置] 已创建 ' + c.file + '（HTTP ' + want.httpPort + ' / WS ' + want.wsPort + '）' + (c.kind === 'template' ? '—— 以后换任何号登录都会自带端口' : ''));
    else if (c.action === 'filled') log('[OneBot 配置] ' + c.file + ' 原先一个端口都没开，已补上（HTTP ' + want.httpPort + ' / WS ' + want.wsPort + '）' + (c.kind === 'account' ? needRelogin : ''));
    else if (c.action === 'realigned') log('[OneBot 配置] ' + c.file + ' 端口已对齐设置：' + c.note + (c.kind === 'account' ? needRelogin : ''));
    else if (c.action === 'skip-unparsable') log('[OneBot 配置] ' + c.file + ' 解析失败（可能正在编辑），未改动');
    else if (c.action === 'skip-foreign') log('[OneBot 配置] ' + c.file + ' 是你自己改过的（' + c.note + '），未改动');
  }
  return { ok: true, configDir, changes };
}
