// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { getConfig } from './config.js';
import { decodeBody, htmlToText, normalizeUrl } from './html-text.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  // 先归一化：群友粘的链接常常没有协议头、被 Markdown 包着、句尾带中文标点。
  // 以前这里直接 new URL() → 这些输入一律"URL 无效"，看起来就是"网址解析不了"。
  const cleaned = normalizeUrl(raw);
  let url;
  try {
    url = new URL(cleaned || String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效（看起来不像网址，检查一下有没有漏 http:// 或多了标点）');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total >= maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - maxBytes))));
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, { buffer: Buffer.concat(chunks), truncated: true });
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => finish(resolve, { buffer: Buffer.concat(chunks), truncated: false }));
    res.on('error', (err) => finish(reject, err));
  });
}

/** 按 Content-Encoding 解压。解不开就原样返回（有些站点声明了却发明文）。 */
export function decompressBody(buffer, contentEncoding = '') {
  const enc = String(contentEncoding || '').toLowerCase().trim();
  if (!buffer.length || !enc || enc === 'identity') return buffer;
  // finishFlush=Z_SYNC_FLUSH：响应被我们按体积截断时，标准解压会抛错，
  // 这个标志能把"已经收到的那部分"解出来 —— 一大半正文总比一坨二进制强。
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    if (enc.includes('gzip') || enc.includes('x-gzip')) return zlib.gunzipSync(buffer, opts);
    if (enc.includes('deflate')) {
      try { return zlib.inflateSync(buffer, opts); } catch { return zlib.inflateRawSync(buffer, opts); }
    }
  } catch { /* 解压失败：当作明文 */ }
  return buffer;
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip, { asBinary = false, maxBytes = 50000, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        // 允许压缩：不声明它，很多站点会发 gzip 原文，读出来就是一坨二进制（"网址解析不了"的另一种形态）
        'accept-encoding': 'gzip, deflate, br'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      // 2026-10-26：调用方传的 timeoutMs 以前被丢掉（这里写死 20000），
      // `downloadImageBuffer(url, timeoutMs)` 的参数形同虚设。
      timeout: Math.max(1000, Number(timeoutMs) || 20000)
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBounded(res, maxBytes)
        .then(({ buffer, truncated }) => resolve({
          statusCode,
          body: buffer,
          truncated,
          contentType: String(res.headers['content-type'] || ''),
          contentEncoding: String(res.headers['content-encoding'] || '')
        }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

const MAX_REDIRECTS = 5;

// 压缩后的字节上限（解开后按字符数再截一次）。50KB 压缩包可能展开成 300KB 文本，
// 所以这里给足余量，真正对模型友好的截断在 maxChars 那一层做。
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

/**
 * 抓取网页正文，SSRF 全防护（不做内网例外）。
 *
 * 返回的 body 是**已经提纯过的正文**（去 script/style/导航，按真实字符集解码），
 * 不再是 HTML 原文 —— 调用方拿到就能直接读。要原文用 rawBody。
 *
 * @returns {{url:string, statusCode:number, truncated:boolean, body:string,
 *            title:string, text:string, rawBody:string, contentType:string}}
 */
export async function safeFetch(urlString, { maxChars = 20000 } = {}) {
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes: MAX_DOWNLOAD_BYTES });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }

    const rawBuffer = decompressBody(result.body, result.contentEncoding);
    const rawBody = decodeBody(rawBuffer, { contentType: result.contentType });
    const isHtml = /html|xml/i.test(result.contentType) || /^\s*<(!doctype|html|head|body)/i.test(rawBody.slice(0, 200));

    let body = rawBody;
    let title = '';
    if (isHtml) {
      const parsed = htmlToText(rawBody, { maxChars });
      body = parsed.text;
      title = parsed.title;
    } else {
      body = sliceByCodePoints(rawBody, maxChars);
    }

    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated || body.length >= maxChars,
      body,
      text: body,
      title,
      rawBody: sliceByCodePoints(rawBody, maxChars * 4),
      contentType: result.contentType
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。
 *
 * opts.allowPrivate = true 时放行内网/本机地址 —— 只用于「地址来自 NapCat 自己」的场景
 * （get_file / get_record 换回来的下载地址通常是 http://127.0.0.1:6099/...）。
 * 这条不是放宽安全策略：那个地址不是群友能控制的输入，而是本机协议端给的，
 * 拦掉它只会让「群友发的文件永远下不下来」。群友直接给的 url 仍然走严格校验。
 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, opts = {}) {
  const allowPrivate = opts.allowPrivate === true || getConfig().security?.allowPrivateImageHosts === true;
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes, timeoutMs: opts.timeoutMs });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}
