// 出站网络：按域名分流代理（海外域名走代理，国内端点直连）。
//
// ── 为什么必须有这一层 ───────────────────────────────────────────────────
// Node/undici 的 fetch **不读** HTTP_PROXY / HTTPS_PROXY 环境变量
// （Node 24 才有 `--use-env-proxy`，本项目跑 Node 22）。
// 所以命令行 `curl` 能翻出去，**不代表服务进程能**：curl 读环境变量，fetch 不读。
//
// 2026-10-27 真机事故：配好 Gemini key 后点"测试连通性"，报"连接超时"。
// 实测 generativelanguage.googleapis.com：DNS 解析 20ms 正常，TCP connect 0 秒不动，
// 12s 后 `UND_ERR_CONNECT_TIMEOUT` —— 典型链路被阻断，和 key 一点关系都没有。
// 同一个域名走本机 7897 代理，1.5 秒就回了。结论：缺的是"出站走代理"这件事本身。
//
// ── 为什么按域名分流，而不是全局走代理 ───────────────────────────────────
// 硅基流动 / 百炼 / DeepSeek 这些国内端点绕一圈代理只会更慢；更糟的是
// **代理一关，国内模型也全线瘫痪** —— 把本来能用的东西一起拖下水。
// 所以只让名单里的海外域名走代理，其余保持直连（连不上代理也不影响主力链路）。
import net from 'node:net';

/** 默认走代理的域名（后缀匹配，`a.b.com` 命中 `b.com`）。 */
export const DEFAULT_PROXY_HOSTS = [
  'googleapis.com',
  'google.com',
  'gstatic.com',
  'openai.com',
  'anthropic.com',
  'claude.ai',
  'openrouter.ai',
  'x.ai'
];

/** 常见本地代理端口（Clash 7897/7890、v2rayN 10809/10808、通用 2080）。 */
export const COMMON_PROXY_PORTS = [7897, 7890, 10809, 10808, 2080];

export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 这个域名要不要走代理。
 * ⚠️ 必须是**后缀边界**匹配：`notgoogleapis.com` 不能被 `googleapis.com` 命中，
 * 否则任何拿域名当后缀的野站点都会把请求塞进代理。
 */
export function shouldProxyHost(host, patterns = DEFAULT_PROXY_HOSTS) {
  const h = normalizeHost(host);
  if (!h) return false;
  const list = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_PROXY_HOSTS;
  for (const raw of list) {
    const pat = normalizeHost(raw).replace(/^\*?\./, '');
    if (!pat) continue;
    if (h === pat || h.endsWith(`.${pat}`)) return true;
  }
  return false;
}

/** 代理地址：配置 > 环境变量 > 空（直连）。 */
export function proxyUrlFrom({ cfg = {}, env = {} } = {}) {
  const fromCfg = String(cfg?.net?.proxyUrl || '').trim();
  if (fromCfg) return { url: fromCfg, from: '配置 net.proxyUrl' };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = String(env?.[key] || '').trim();
    if (value) return { url: value, from: `环境变量 ${key}` };
  }
  return { url: '', from: '' };
}

/** 端口是否在监听（TCP 握手，300ms 内没回应就当没开）。 */
function portOpen(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 没配置任何代理时，探测本机常见端口。
 * 只做"提示 + 自动启用"，不写回配置 —— 端口是随客户端变的，
 * 落盘之后换台机器 / 换了端口就会变成一条永远连不上的死配置。
 */
export async function discoverProxy({ host = '127.0.0.1', ports = COMMON_PROXY_PORTS } = {}) {
  for (const port of ports) {
    if (await portOpen(host, port)) return `http://${host}:${port}`;
  }
  return '';
}

/** 最近一次安装结果（给 /api/status 看，避免"配了但不知道有没有生效"）。 */
let lastStatus = { mode: 'unknown', proxyUrl: '', proxyHosts: [], note: '' };
export function netProxyStatus() {
  return { ...lastStatus, proxyHosts: [...lastStatus.proxyHosts] };
}

/**
 * 安装全局 dispatcher（幂等：重复调用只是重新装一次）。
 * @param {{ connectTimeoutMs?: number, cfg?: object, env?: object, autoDiscover?: boolean }} options
 * @returns {Promise<{mode:'direct'|'proxy', proxyUrl:string, proxyHosts:string[], note:string}>}
 */
export async function installNetProxy({
  connectTimeoutMs = 30_000,
  cfg = null,
  env = process.env,
  autoDiscover = true
} = {}) {
  // 动态导入：undici 与 Electron 内置 Node 不兼容时只退回默认行为，绝不崩主进程。
  let undici;
  try {
    undici = await import('undici');
  } catch (error) {
    lastStatus = { mode: 'direct', proxyUrl: '', proxyHosts: [], note: `undici 不可用：${error?.message ?? error}` };
    console.warn('[net] undici 不可用，保持 Node 默认出站（无代理）:', error?.message ?? error);
    return lastStatus;
  }

  const { Agent, ProxyAgent, setGlobalDispatcher } = undici;
  const direct = new Agent({ connect: { timeout: connectTimeoutMs } });

  let cfgObj = cfg;
  if (!cfgObj) {
    try {
      const { getConfig } = await import('./config.js');
      cfgObj = getConfig();
    } catch {
      cfgObj = {};
    }
  }

  let { url: proxyUrl, from } = proxyUrlFrom({ cfg: cfgObj, env });
  if (!proxyUrl && autoDiscover) {
    proxyUrl = await discoverProxy();
    if (proxyUrl) from = '自动探测本机端口';
  }

  const hosts = Array.isArray(cfgObj?.net?.proxyHosts) && cfgObj.net.proxyHosts.length
    ? cfgObj.net.proxyHosts
    : DEFAULT_PROXY_HOSTS;

  if (cfgObj?.net?.enabled === false || !proxyUrl) {
    setGlobalDispatcher(direct);
    lastStatus = {
      mode: 'direct',
      proxyUrl: '',
      proxyHosts: hosts,
      note: cfgObj?.net?.enabled === false ? '配置里已关闭代理（net.enabled=false）' : '没有可用代理，全部直连'
    };
    console.log(`[net] 直连模式（${lastStatus.note}）`);
    return lastStatus;
  }

  if (!/^https?:\/\//i.test(proxyUrl)) {
    // undici 的 ProxyAgent 不支持 socks5://（要另装包）。与其静默直连，不如说清楚。
    setGlobalDispatcher(direct);
    lastStatus = {
      mode: 'direct',
      proxyUrl: '',
      proxyHosts: hosts,
      note: `不支持的代理协议：${proxyUrl}（只支持 http:// 或 https:// 代理）`
    };
    console.warn(`[net] ${lastStatus.note}，已退回直连`);
    return lastStatus;
  }

  let proxy;
  try {
    proxy = new ProxyAgent({ uri: proxyUrl, connect: { timeout: connectTimeoutMs } });
  } catch (error) {
    setGlobalDispatcher(direct);
    lastStatus = {
      mode: 'direct',
      proxyUrl: '',
      proxyHosts: hosts,
      note: `代理初始化失败：${error?.message ?? error}`
    };
    console.warn(`[net] ${lastStatus.note}，已退回直连`);
    return lastStatus;
  }

  // undici 只要求 dispatch 方法；close/destroy 给优雅退出用。
  const split = {
    dispatch(opts, handler) {
      let host = '';
      try {
        host = new URL(String(opts?.origin || '')).hostname;
      } catch { /* origin 异常按直连处理 */ }
      const target = shouldProxyHost(host, hosts) ? proxy : direct;
      return target.dispatch(opts, handler);
    },
    close() {
      return Promise.all([direct.close(), proxy.close()]);
    },
    destroy(error) {
      return Promise.all([direct.destroy(error), proxy.destroy(error)]);
    }
  };
  setGlobalDispatcher(split);

  lastStatus = {
    mode: 'proxy',
    proxyUrl,
    proxyHosts: [...hosts],
    note: `来源：${from}；仅名单内域名走代理，其余直连`
  };
  console.log(`[net] 代理 ${proxyUrl}（${from}），走代理的域名：${hosts.join(', ')}`);
  return lastStatus;
}
