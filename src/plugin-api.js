/**
 * 扩展包 ctx（api）—— 按声明裁剪的唯一构造点
 * 移植自 Estrella-Bot（QQ-Agent 生态 · MIT），适配 QQ Agent。
 *
 * setup(api) 拿到的就是这个对象。它上面有什么 = 外来代码能做什么。
 *
 * QQ Agent 适配差异：
 *  - 网络出口接 QQ Agent 已有的 safeFetch（私网/回环判据），不是 Estrella 的 ext-fetch。
 *  - 不提供 fs / path / process / dataDir（外来代码碰磁盘只有宿主主动给才可能）。
 */

import path from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { readJsonSafe, writeJsonAtomic } from './json-store.js';

/**
 * 认识的权限名。只有这里登记过的才可能发放。
 *
 * ⚠️ 铁律（2026-10-21 自查出来的第二例"声明≠接线"）：
 *    一个名字留在本数组里，`api.has(name)` 就会返回 true，
 *    插件就会写 `if (api.has('send_image')) api.sendImage(...)`。
 *    所以**登记在这里的每一项，buildApi 都必须真的接出一个可调用的成员**，
 *    而且这个成员在"没法提供"时要抛一条说得清原因的错误 ——
 *    绝不能是 undefined（那是 TypeError，且报错行在插件里，与真因无关）。
 */
export const PERMISSION_NAMES = Object.freeze(['web_fetch', 'send_image', 'storage']);

/** 插件私有存储的硬上限（单插件）。超了直接拒绝，不静默截断。 */
export const STORAGE_MAX_BYTES = 256 * 1024;
/** 插件私有存储的键数上限。 */
export const STORAGE_KEYS_MAX = 200;

/** chatKey 只允许两种形状：group:<数字> / private:<数字>。 */
const CHAT_KEY_RE = /^(group|private):\d{1,20}$/;

/** 统一的"这条能力没接上"错误：说清是没声明，还是宿主没给。 */
function denied(id, name, why) {
  return new Error(`扩展包「${id}」无法使用 ${name}：${why}`);
}

/**
 * 把 QQ Agent 的 safeFetch 结果还原成标准 Response 形状。
 * safeFetch 返回 { url, statusCode, truncated, body }（纯文本、GET-only、固定 headers），
 * 而插件生态（Estrella 风格）用的是标准 fetch 的 res.ok / res.status / res.json()。
 * 这里包一层，让插件代码不用改就能用标准 API，同时保留 SSRF 安全防护。
 * 注意：safeFetch 只支持 GET、忽略自定义 headers/body —— 对查榜单这类 JSON API 够用。
 */
function wrapSafeFetch() {
  return async (url, init = {}) => {
    // 只支持 GET（safeFetch 的实现约束）
    if (init?.method && String(init.method).toUpperCase() !== 'GET') {
      return new Response(JSON.stringify({ error: '插件 fetch 仅支持 GET（受安全出口约束）' }), {
        status: 405,
        headers: { 'content-type': 'application/json' }
      });
    }
    const r = await safeFetch(url);
    const status = Number(r.statusCode) || 200;
    const ok = status >= 200 && status < 300;
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    return new Response(r.body, { status, ok, headers });
  };
}

export function splitPermissions(declared) {
  const known = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of Array.isArray(declared) ? declared : []) {
    const s = String(raw ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (PERMISSION_NAMES.includes(s)) known.push(s);
    else unknown.push(s);
  }
  return { known, unknown };
}

/**
 * 按插件 id 隔离的 JSON 存储（声明 `storage` 权限才有）。
 *
 * 为什么给这个而不是给 fs：插件要的其实只是"记住一点自己的东西"
 * （上次推到哪、用户设过的偏好、计数器），不是"读你的硬盘"。
 * 给一个 key-value 抽屉就够了，既够用，也不用为它写一套路径围栏。
 *
 * 三条约束：
 *  - 一个插件一个文件（`<dir>/<id>.json`），看不到别人的。
 *  - 单文件 256KB / 200 个键，超了**抛错**（不静默截断 —— 静默截断最难查）。
 *  - 读盘走 readJsonSafe：坏文件隔离留档，不会把插件的状态静默清零。
 */
export function createPluginStorage({ id, dir, log } = {}) {
  const pid = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const file = pid && dir ? path.join(dir, `${pid}.json`) : '';
  const warn = (m) => log?.warn?.(m);
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = {};
    if (!file) return cache;
    const raw = readJsonSafe(file, null, { tag: `storage:${pid}`, warn });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cache = raw;
    return cache;
  }

  function save(data) {
    if (!file) throw denied(pid, 'storage', '宿主没有提供存储目录');
    writeJsonAtomic(file, data);
  }

  function sizeOf(data) {
    try { return Buffer.byteLength(JSON.stringify(data), 'utf8'); } catch { return Infinity; }
  }

  const api = {
    /** 取一个键。不存在返回 fallback（默认 null）。 */
    get(key, fallback = null) {
      const k = String(key ?? '');
      const data = load();
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : fallback;
    },

    /** 写一个键。超容量/键数上限抛错并保持原样。 */
    set(key, value) {
      const k = String(key ?? '').trim();
      if (!k) throw new Error(`扩展包「${pid}」storage.set：键名不能为空`);
      const data = load();
      const isNew = !Object.prototype.hasOwnProperty.call(data, k);
      if (isNew && Object.keys(data).length >= STORAGE_KEYS_MAX) {
        throw new Error(`扩展包「${pid}」storage 已达键数上限 ${STORAGE_KEYS_MAX}，先删掉一些再写`);
      }
      let json;
      try { json = JSON.stringify(value); } catch (e) {
        throw new Error(`扩展包「${pid}」storage.set：值无法序列化成 JSON（${e?.message ?? e}）`);
      }
      if (json === undefined) throw new Error(`扩展包「${pid}」storage.set：值无法序列化成 JSON`);
      const next = { ...data, [k]: JSON.parse(json) };
      const bytes = sizeOf(next);
      if (bytes > STORAGE_MAX_BYTES) {
        throw new Error(
          `扩展包「${pid}」storage 容量超限（${bytes} > ${STORAGE_MAX_BYTES} 字节），` +
          '这条没有写入。插件自己的数据要精简，不要拿它当缓存盘'
        );
      }
      save(next);
      cache = next;
      return { ok: true, keys: Object.keys(next).length, bytes };
    },

    /** 删一个键。返回是否确实删掉了。 */
    remove(key) {
      const k = String(key ?? '');
      const data = load();
      if (!Object.prototype.hasOwnProperty.call(data, k)) return false;
      const next = { ...data };
      delete next[k];
      save(next);
      cache = next;
      return true;
    },

    /** 全部键值（副本，改它不会影响存储）。 */
    all() { return { ...load() }; },
    keys() { return Object.keys(load()); },
    has(key) { return Object.prototype.hasOwnProperty.call(load(), String(key ?? '')); },

    /** 清空（插件自己的东西，自己的责任）。 */
    clear() {
      save({});
      cache = {};
      return true;
    },

    /** 当前占用字节数（面板/自查用）。 */
    bytes() { return sizeOf(load()); },
  };
  return api;
}

/**
 * 设置：三层合并，越靠后越优先。
 *
 *   ① configSchema 里声明的 default  ← **这一层以前是缺的**
 *   ② 清单的 settings 静态值
 *   ③ 用户实际填的（over）
 *
 * 缺了 ① 的后果很隐蔽：插件写了 `config().volume` 期望有默认值，
 * 结果拿到 undefined，不报错、只是走了某个分支；测试因为自己传了 settings 全绿，
 * 生产上却静默错。所以这里必须补，而且要在读清单时就把 schema 本体留下来
 * （见 plugin-manifest.js 的 normalizeConfigSchema）。
 *
 * 返回取用函数（每次拿最新，插件可以改 user 之后重新取）。
 */
export function settingsOf(manifest, user) {
  const fromSchema = manifest?.configSchema && typeof manifest.configSchema === 'object'
    ? Object.fromEntries(
      Object.entries(manifest.configSchema)
        .filter(([, f]) => f && Object.prototype.hasOwnProperty.call(f, 'default'))
        .map(([k, f]) => [k, f.default])
    )
    : {};
  const base = manifest && typeof manifest.settings === 'object' && manifest.settings && !Array.isArray(manifest.settings)
    ? { ...manifest.settings }
    : {};
  const over = user && typeof user === 'object' && !Array.isArray(user) ? { ...user } : {};
  return () => ({ ...fromSchema, ...base, ...over });
}

/**
 * @param {object} opts
 * @param {Function} [opts.sendImage] 宿主的真实发图入口 (chatKey, url, opts) => Promise
 * @param {string}   [opts.storageDir] 插件私有存储目录（一个插件一个文件）
 * @param {Function} [opts.makeActionTool] plugin-toolkit.actionTool，用于 api.actionTool
 */
export function buildApi({
  manifest, log, now, registerTool, isActive, settings,
  sendImage, storageDir, makeActionTool,
} = {}) {
  const m = manifest || {};
  const id = String(m.id ?? '');
  const kind = m.kind ?? null;
  const { known, unknown } = splitPermissions(m.permissions);
  const has = (name) => known.includes(String(name ?? ''));

  const tag = `[ext:${id}]`;
  const mk = (level) => (...args) => {
    const fn = log?.[level] || log?.info;
    if (typeof fn === 'function') fn(`${tag}`, ...args);
  };
  const warnTo = (msg) => { const fn = log?.warn; if (typeof fn === 'function') fn(`${tag} ${msg}`); };
  const config = settingsOf(m, settings);

  if (unknown.length) {
    warnTo(`声明了不认识的权限：${unknown.join(' / ')}（支持的：${PERMISSION_NAMES.join(' / ')}）`);
  }

  /**
   * 每项声明权限的**实际接线状态**。这个对象会回传给宿主写进插件记录，
   * 目的只有一个：以后"声明了但没接"能一眼看出来，而不是等插件作者踩 TypeError。
   * 取值：'wired' 真接上了 · 'undeclared' 没声明 · 'unwired' 声明了但宿主没提供。
   */
  const wiring = {};

  const api = {
    id,
    name: String(m.name ?? id),
    version: String(m.version ?? ''),
    kind,
    config,
    log: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    has,
    /** 能力接线状态（只读快照）。 */
    capabilityState: () => ({ ...wiring }),
    isActive: (other) => (typeof isActive === 'function' ? isActive(String(other ?? '')) === true : false),
  };

  // fetch：只有声明 web_fetch 才给，且接 QQ Agent 的 safeFetch（私网/回环判据），
  // 再还原成标准 Response 形状，让插件代码用 res.ok / res.json() 即可。
  if (has('web_fetch')) {
    api.fetch = wrapSafeFetch();
    wiring.web_fetch = 'wired';
  } else {
    api.fetch = () => Promise.reject(denied(id, 'web_fetch', '清单 permissions 里没有 "web_fetch"'));
    wiring.web_fetch = 'undeclared';
  }

  // send_image：真的接到宿主的 sender（也就是会走限频、节奏、before-media 否决点）。
  // 只收公网 http(s) 链接：插件拿不到可靠的本地绝对路径，给了也只能靠猜。
  if (has('send_image')) {
    if (typeof sendImage === 'function') {
      wiring.send_image = 'wired';
      api.sendImage = async (chatKey, imageUrl, options = {}) => {
        const ck = String(chatKey ?? '').trim();
        if (!CHAT_KEY_RE.test(ck)) {
          throw new Error(
            `扩展包「${id}」sendImage：chatKey 必须是 "group:<群号>" 或 "private:<QQ号>"` +
            `（实际：${ck.slice(0, 40) || '(空)'}）`
          );
        }
        const url = String(imageUrl ?? '').trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new Error(`扩展包「${id}」sendImage：只接受公网 http(s) 图片地址（实际：${url.slice(0, 60) || '(空)'}）`);
        }
        if (url.length > 2048) throw new Error(`扩展包「${id}」sendImage：地址过长（${url.length} 字符）`);
        const r = await sendImage(ck, url, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null,
        });
        return { messageId: r?.message_id ?? null };
      };
    } else {
      wiring.send_image = 'unwired';
      warnTo('声明了 send_image，但宿主没有接出发图能力 —— 调用 api.sendImage 会报错（这是宿主侧的问题）');
      api.sendImage = () => Promise.reject(denied(id, 'send_image', '宿主没有接出发送能力（不是你的清单问题）'));
    }
  } else {
    wiring.send_image = 'undeclared';
    api.sendImage = () => Promise.reject(denied(id, 'send_image', '清单 permissions 里加上 "send_image" 即可'));
  }

  // storage：按 id 隔离的 key-value 抽屉。
  if (has('storage')) {
    if (storageDir) {
      api.storage = createPluginStorage({ id, dir: storageDir, log });
      wiring.storage = 'wired';
    } else {
      wiring.storage = 'unwired';
      warnTo('声明了 storage，但宿主没有提供存储目录 —— 读写会报错（这是宿主侧的问题）');
      const no = () => { throw denied(id, 'storage', '宿主没有提供存储目录（不是你的清单问题）'); };
      api.storage = { get: no, set: no, remove: no, all: no, keys: no, has: no, clear: no, bytes: no };
    }
  } else {
    wiring.storage = 'undeclared';
    const no = () => { throw denied(id, 'storage', '清单 permissions 里加上 "storage" 即可'); };
    api.storage = { get: no, set: no, remove: no, all: no, keys: no, has: no, clear: no, bytes: no };
  }

  api.registerTool = (def) => {
    if (typeof registerTool !== 'function') throw new Error('宿主未提供 registerTool');
    return registerTool(def, { owner: id });
  };

  // 一插件一工具 + action 枚举：见 plugin-toolkit.js 顶部的说明。
  if (typeof makeActionTool === 'function') {
    api.actionTool = (spec) => makeActionTool(spec);
  }

  if (typeof now === 'function') api.now = now;

  return api;
}

/** activate(ctx) 的 ctx：从 setup 的 api 投影出的只读子集（能力全摘）。 */
export function activateCtxOf(api) {
  if (!api || typeof api !== 'object') return {};
  const { id, name, version, kind, config, log, warn, error, has, now, capabilityState } = api;
  const ctx = { id, name, version, kind, config, log, warn, error, has };
  if (typeof now === 'function') ctx.now = now;
  // 接线状态不是能力，是信息 —— activate 阶段拿得到才有意义（不然只能读日志）。
  if (typeof capabilityState === 'function') ctx.capabilityState = capabilityState;
  return ctx;
}
