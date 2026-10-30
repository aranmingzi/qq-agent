/**
 * 扩展包宿主 —— 目录扫描 / 清单读取 / 白名单接线 / 加载执行
 * 移植自 Estrella-Bot（QQ-Agent 生态 · MIT），适配 QQ Agent。
 *
 * 本文件是插件系统唯一碰磁盘的地方。判据全在 plugin-manifest.js（纯函数）。
 *
 * 两段职责：
 *  ① loadExtensions()：扫描 + 校验 + 白名单（不执行外来代码）
 *  ② createExtensionHost()：加载 + 执行 + 四态生命周期（真的 import）
 *
 * 关键约定：
 *  - 不支持热插拔（load 幂等，改配置要重启）。
 *  - 一个包失败只拒它自己，其余照常加载。
 *  - entry 的 realpath 必查（防符号链接越界）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from './config.js';
import {
  DIR_KINDS,
  MANIFEST_FILES,
  normalizeManifest,
  planLoad,
  stripBom,
  summarize,
} from './plugin-manifest.js';
import { buildApi, activateCtxOf, splitPermissions } from './plugin-api.js';
import { actionTool } from './plugin-toolkit.js';
import { scopedToolId } from './tool-registry.js';

/** 插件私有存储（storage 权限）的落盘目录：一个插件一个 <id>.json。 */
export const PLUGIN_STORAGE_DIR = path.join(DATA_DIR, 'plugin-storage');

/** 两个根目录（可用环境变量覆盖）。 */
export const EXTENSION_ENV = ['QQBOT_PLUGINS_DIR', 'QQBOT_SKILLS_DIR'];

export function extensionRoots(root) {
  const [envPlugins, envSkills] = EXTENSION_ENV.map((k) => process.env[k]);
  return [
    { dir: envPlugins ? path.resolve(envPlugins) : path.join(root, 'plugins'), kind: DIR_KINDS.plugins, name: 'plugins' },
    { dir: envSkills ? path.resolve(envSkills) : path.join(root, 'skills'), kind: DIR_KINDS.skills, name: 'skills' },
  ];
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listSubdirs(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return ents
    .filter((e) => !e.name.startsWith('.')
      && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))))
    .map((e) => e.name)
    .sort();
}

function readManifest(dir) {
  for (const file of MANIFEST_FILES) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const source = file.replace(/\.json$/, '');
    try {
      return { raw: JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))), source };
    } catch (e) {
      return { error: `清单解析失败（${file}）：${e.message}`, source };
    }
  }
  return { error: `缺少清单文件（${MANIFEST_FILES.join(' / ')}）`, source: null };
}

function entryEscapeReason(dir, entry) {
  const entryPath = path.resolve(dir, entry);
  const rel = path.relative(dir, entryPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return `entry 越出了包目录：${entry}`;
  try {
    const realDir = fs.realpathSync(dir);
    const realEntry = fs.realpathSync(entryPath);
    const relReal = path.relative(realDir, realEntry);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      return `entry 经符号链接指向包外：${entry}`;
    }
  } catch {
    // realpath 失败 = 文件不存在或链接断掉，交给调用方判入口缺失
  }
  return null;
}

function scanOne(dir, dirName, kind) {
  const base = { dir, dirName, kind, source: null, manifest: null, fatal: [], problems: [] };

  const found = readManifest(dir);
  base.source = found.source;
  if (found.error) {
    base.fatal.push({ code: 'no-manifest', text: found.error });
    return base;
  }

  const { manifest, fatal, problems } = normalizeManifest(found.raw, { fallbackId: dirName, kind });
  base.manifest = manifest;
  base.fatal = fatal;
  base.problems = problems;
  if (fatal.length) return base;

  const esc = entryEscapeReason(dir, manifest.entry);
  if (esc) {
    base.fatal = [{ code: 'entry-escapes', text: esc }];
    return base;
  }
  const entryPath = path.resolve(dir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    base.problems.push({ code: 'entry-missing', text: `入口文件不存在：${manifest.entry}` });
  } else if (!fs.statSync(entryPath).isFile()) {
    base.problems.push({ code: 'entry-not-file', text: `entry 指向的不是文件：${manifest.entry}` });
  }
  return base;
}

function scanRoot({ dir, kind, name }) {
  const names = listSubdirs(dir);
  if (names === null) return { dir, kind, name, missing: true, entries: [] };
  return { dir, kind, name, missing: false, entries: names.map((n) => scanOne(path.join(dir, n), n, kind)) };
}

/** 宿主唯一接线点：扫描 + 校验 + 白名单（不执行外来代码）。 */
export function loadExtensions({ root, enabled = [], log = {} } = {}) {
  const info = typeof log.info === 'function' ? log.info.bind(log) : () => {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};

  const roots = extensionRoots(root);
  const scans = [];
  const entries = [];
  for (const r of roots) {
    const sc = scanRoot(r);
    scans.push(sc);
    entries.push(...sc.entries);
  }

  const plan = planLoad(entries, enabled);
  const sum = summarize(plan);

  for (const p of plan) {
    if (p.action === 'reject') warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${p.detail}`);
  }
  for (const p of plan) {
    if (p.action === 'load') info(`扩展包 ✓ ${p.dirName}（id ${p.id} v${p.manifest?.version || '?'}）：已启用`);
    for (const w of p.problems || []) {
      if (p.action !== 'reject') warn(`扩展包 ⚠ ${p.dirName}：${w.text}`);
    }
  }

  const scanned = scans
    .map((s) => `${s.name} ${s.missing ? '（目录不存在）' : `${s.entries.length} 个`}`)
    .join(' · ');
  info(
    `扩展包 | 扫描：${scanned} | 合计 ${sum.total} 个 → ` +
      `可加载 ${sum.load} · 未启用 ${sum.skip} · 有问题 ${sum.reject}`
  );

  return { plan, sum, scans, roots };
}

// ── ② 加载 / 执行 / 四态生命周期 ──────────────────────────────────────────

export const LIFECYCLE = Object.freeze(['setup', 'activate', 'deactivate', 'dispose']);

export const HOST_STATE = Object.freeze({
  PENDING: 'pending',
  LOADED: 'loaded',
  SKIPPED: 'skipped',
  FAILED: 'failed',
});

function entryProblem(dir, entry) {
  const esc = entryEscapeReason(dir, entry);
  if (esc) return esc;
  const p = path.resolve(dir, entry);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return `入口文件不存在：${entry}`;
  }
  if (!st.isFile()) return `entry 指向的不是文件：${entry}`;
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return `入口文件不可读（权限位）：${entry}`;
  }
  return null;
}

function attachHooks(mod, id, bus, warn) {
  const out = [];
  const hooks = mod?.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [point, fn] of Object.entries(hooks)) {
    const fns = Array.isArray(fn) ? fn : [fn];
    let n = 0;
    for (const f of fns) if (bus.on(point, f, { owner: id })) n += 1;
    if (n) out.push([point, n]);
    else warn(`扩展包「${id}」的钩子「${point}」没挂上（未知钩子点或不是函数）`);
  }
  return out;
}

/**
 * 建宿主。只由机器人进程调用（真的执行磁盘上的外来代码）。
 */
export function createExtensionHost({ root, registry, bus, getCustom, log = {}, now, sendImage, storageDir } = {}) {
  const info = typeof log.info === 'function' ? log.info.bind(log) : () => {};
  const warn = typeof log.warn === 'function' ? log.warn.bind(log) : () => {};
  const storeDir = storageDir || PLUGIN_STORAGE_DIR;

  const records = new Map();
  const modules = new Map();
  /** id -> 本次扫描出的加载计划（reload 时要用它的 dir/dirName/kind 重新扫） */
  const plans = new Map();
  let loaded = false;
  let reloadSeq = 0;
  let watchHandle = null;

  function record(id, fields) {
    records.set(id, {
      id,
      dirName: fields.dirName ?? '',
      kind: fields.kind ?? null,
      name: fields.name ?? id,
      version: fields.version ?? '',
      state: fields.state,
      reason: fields.reason ?? '',
      detail: fields.detail ?? '',
      tools: [],
      hooks: [],
      life: { setup: 'none', activate: 'none', deactivate: 'none', dispose: 'none' },
      permissions: fields.permissions ?? { known: [], unknown: [] },
      // 声明权限的**实际接线状态**（wired / undeclared / unwired）。见 plugin-api.js。
      capability: fields.capability ?? {},
      // 声明了 prompt.sections 的段落（进系统提示的原文，见 plugin-manifest.js）
      promptSections: fields.promptSections ?? [],
      /** 用 action 枚举分发的工具（一插件一工具的约定，见 plugin-toolkit.js）。 */
      actionTools: fields.actionTools ?? [],
      settingsKeys: fields.settingsKeys ?? [],
      configSchema: fields.configSchema ?? {},
      toolErrors: [],
      ...(fields.patch || {}),
    });
  }

  async function activateOne(p, { cacheBust = false } = {}) {
    const m = p.manifest || {};
    plans.set(p.id, p);
    const perms = splitPermissions(m.permissions);
    const base = {
      dirName: p.dirName,
      kind: p.kind,
      name: m.name || p.id,
      version: m.version || '',
      permissions: perms,
      settingsKeys: Array.isArray(m.settingsKeys) ? m.settingsKeys : [],
      configSchema: m.configSchema && typeof m.configSchema === 'object' ? m.configSchema : {},
    };

    const problem = entryProblem(p.dir, m.entry);
    if (problem) {
      record(p.id, { ...base, state: HOST_STATE.FAILED, reason: 'entry-unusable', detail: problem });
      warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${problem}`);
      return;
    }

    const entryPath = path.resolve(p.dir, m.entry);
    let mod;
    try {
      // 热重载时加一个 query 破 ESM 缓存：同一个 URL 的模块会被 Node 缓存住，
      // 不加的话"改了文件、重启了插件、行为没变"——比不重载更让人困惑。
      const href = pathToFileURL(entryPath).href + (cacheBust ? `?v=${++reloadSeq}` : '');
      mod = await import(href);
    } catch (e) {
      const detail = `import 失败：${e?.message ?? e}`;
      record(p.id, { ...base, state: HOST_STATE.FAILED, reason: 'import-failed', detail });
      warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${detail}`);
      return;
    }
    modules.set(p.id, mod);

    const hasSetup = typeof mod?.setup === 'function';
    const hasActivate = typeof mod?.activate === 'function';
    const hookCount = mod?.hooks && typeof mod.hooks === 'object' ? Object.keys(mod.hooks).length : 0;
    if (!hasSetup && !hasActivate && !hookCount) {
      record(p.id, { ...base, state: HOST_STATE.SKIPPED, reason: 'no-entry-contract', detail: '入口没有导出 setup / activate / hooks' });
      warn(`扩展包 ⚠ ${p.dirName}（id ${p.id}）：入口没有 setup / activate / hooks，跳过`);
      return;
    }

    const life = { setup: 'none', activate: 'none', deactivate: 'none', dispose: 'none' };
    const toolErrors = [];
    const actionTools = [];
    let setupFailed = null;
    let api = null;
    if (hasSetup) {
      api = buildApi({
        manifest: m,
        log,
        now,
        settings: (getCustom?.()?.plugins?.settings || {})[p.id],
        isActive: (other) => records.get(String(other))?.state === HOST_STATE.LOADED,
        // 声明的权限必须真的接出能力（见 plugin-api.js 的 PERMISSION_NAMES 注释）
        sendImage,
        storageDir: storeDir,
        makeActionTool: actionTool,
        registerTool: (def, { owner }) => {
          const name = scopedToolId(owner, def?.id ?? def?.name);
          const r = registry.register({ ...def, id: name, owner });
          if (!r.ok) {
            toolErrors.push({ id: String(def?.id ?? ''), reason: r.reason });
            warn(`扩展包「${owner}」注册工具失败：${r.reason}`);
            return '';
          }
          // 按"一插件一工具 + action 枚举"写的工具：把动作清单记下来，面板可读
          if (Array.isArray(def?.actions) && def.actions.length) {
            actionTools.push({ tool: r.name, actions: [...def.actions] });
          }
          return r.name;
        },
      });
      try {
        await mod.setup(api);
        life.setup = 'ok';
      } catch (e) {
        life.setup = 'failed';
        setupFailed = `setup 抛错：${e?.message ?? e}`;
      }
    }
    const capability = api && typeof api.capabilityState === 'function' ? api.capabilityState() : {};
    const promptSections = Array.isArray(m.promptSections) ? m.promptSections : [];

    if (setupFailed) {
      let removed = 0;
      for (const t of registry.meta()) if (t.owner === p.id && registry.unregister(t.name)) removed += 1;
      record(p.id, {
        ...base, state: HOST_STATE.FAILED, reason: 'setup-failed', detail: setupFailed,
        patch: { life, toolErrors, capability, promptSections, actionTools },
      });
      warn(`扩展包 ✗ ${p.dirName}（id ${p.id}）：${setupFailed}${removed ? `（已收回 ${removed} 个工具）` : ''}`);
      return;
    }

    const hooks = attachHooks(mod, p.id, bus, warn);

    if (hasActivate) {
      try {
        await mod.activate(activateCtxOf(api));
        life.activate = 'ok';
      } catch (e) {
        life.activate = 'failed';
        warn(`扩展包 ⚠ ${p.dirName}（id ${p.id}）：activate 抛错（钩子仍生效）：${e?.message ?? e}`);
      }
    }

    const tools = registry.meta().filter((t) => t.owner === p.id).map((t) => t.name);
    record(p.id, {
      ...base, state: HOST_STATE.LOADED, reason: 'ok', detail: '',
      patch: { life, tools, hooks, toolErrors, capability, promptSections, actionTools },
    });
    info(
      `扩展包 ✓ ${p.dirName}（id ${p.id} v${base.version || '?'}）：已加载` +
        ` · 工具 ${tools.length} · 钩子 ${hooks.map(([k, n]) => `${k}×${n}`).join('/') || '无'}` +
        ` · 权限 ${perms.known.join('/') || '无'}`
    );
    // 声明了权限却没接上，是宿主 bug，必须在日志里显形（而不是等插件作者踩 TypeError）
    const unwired = Object.entries(capability).filter(([, v]) => v === 'unwired').map(([k]) => k);
    if (unwired.length) warn(`扩展包 ⚠ ${p.dirName}（id ${p.id}）：权限 ${unwired.join('/')} 已声明但宿主未接线`);
  }

  return {
    async load() {
      if (loaded) return this.snapshot();
      loaded = true;

      const enabled = getCustom?.()?.plugins?.enabled || [];
      const { plan } = loadExtensions({ root, enabled, log });
      for (const p of plan) {
        if (p.action === 'load') continue;
        record(p.id, {
          dirName: p.dirName,
          kind: p.kind,
          name: p.manifest?.name || p.id,
          version: p.manifest?.version || '',
          state: p.action === 'skip' ? HOST_STATE.PENDING : HOST_STATE.FAILED,
          reason: p.reason,
          detail: p.detail,
          settingsKeys: Array.isArray(p.manifest?.settingsKeys) ? p.manifest.settingsKeys : [],
          configSchema: p.manifest?.configSchema && typeof p.manifest.configSchema === 'object' ? p.manifest.configSchema : {},
        });
      }
      for (const p of plan) {
        if (p.action !== 'load') continue;
        await activateOne(p);
      }

      const snap = this.snapshot();
      const s = snap.sum;
      info(
        `扩展包 | 执行：扫描 ${plan.length} 个 → 已加载 ${s.loaded} · 未启用 ${s.pending}` +
          ` · 无入口契约 ${s.skipped} · 失败 ${s.failed}` +
          ` | 工具 ${typeof registry.size === 'function' ? registry.size() : '?'}` +
          ` · 钩子 ${typeof bus.total === 'function' ? bus.total() : '?'}`
      );
      return snap;
    },

    has(id) { return records.get(String(id ?? ''))?.state === HOST_STATE.LOADED; },
    get(id) { return records.get(String(id ?? '')) || null; },

    snapshot() {
      const items = [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const sum = { total: items.length, loaded: 0, pending: 0, skipped: 0, failed: 0 };
      for (const it of items) sum[it.state] = (sum[it.state] || 0) + 1;
      return { items, sum };
    },

    async deactivateAll() {
      let ran = 0;
      const errors = [];
      for (const [id, r] of records) {
        if (r.state !== HOST_STATE.LOADED) continue;
        const fn = modules.get(id)?.deactivate;
        if (typeof fn !== 'function') { r.life.deactivate = 'absent'; continue; }
        try { await fn(); r.life.deactivate = 'ok'; ran += 1; }
        catch (e) { r.life.deactivate = 'failed'; errors.push({ id, message: String(e?.message ?? e) }); warn(`扩展包「${id}」deactivate 抛错：${e?.message ?? e}`); }
      }
      return { ran, errors };
    },

    /**
     * 卸载一个扩展：dispose → 摘钩子 → 收工具 → 清记录。
     * 单独抽出来是因为 reload 与"禁用某个插件"都要用，且顺序不能反
     * （先摘钩子再 dispose，dispose 里可能还想读自己的状态）。
     */
    async unload(id) {
      const key = String(id ?? '');
      const r = records.get(key);
      if (!r) return { ok: false, reason: '没有这个扩展' };
      const mod = modules.get(key);
      const fn = mod?.dispose;
      if (typeof fn === 'function') {
        try { await fn(); } catch (e) { warn(`扩展包「${key}」dispose 抛错：${e?.message ?? e}`); }
      }
      const hooksRemoved = bus.offOwner(key);
      let removed = 0;
      for (const t of registry.meta()) {
        if (t.owner === key && registry.unregister(t.name)) removed += 1;
      }
      modules.delete(key);
      records.delete(key);
      return { ok: true, hooksRemoved, toolsRemoved: removed };
    },

    /**
     * 热重载单个扩展（2026-10-22 生态调研 P2-1）。
     * 重新扫清单（可能改过 manifest）→ 卸载旧实例 → 用破缓存的方式重新 import。
     * 新版本坏掉时**不会**自动回滚旧版本：半新半旧的钩子比"没加载"更难查，
     * 这里选择把失败原因留在记录里，由控制台显示（失败就失败，说得清）。
     */
    async reload(id) {
      const key = String(id ?? '');
      const prev = plans.get(key) || (records.get(key) ? { dir: records.get(key).dir, dirName: records.get(key).dirName, kind: records.get(key).kind } : null);
      if (!prev?.dir) return { ok: false, reason: '没有这个扩展的加载计划（可能未启用或从未加载成功）' };
      const fresh = scanOne(prev.dir, prev.dirName, prev.kind);
      const enabled = getCustom?.()?.plugins?.enabled || [];
      const plan = planLoad([fresh], enabled)[0];
      if (!plan || plan.action !== 'load') {
        await this.unload(key);
        const why = plan?.detail || '新清单不可用';
        warn(`扩展包「${key}」重载中止：${why}`);
        return { ok: false, reason: why };
      }
      await this.unload(key);
      await activateOne(plan, { cacheBust: true });
      const r = records.get(key);
      const ok = r?.state === HOST_STATE.LOADED;
      info(`扩展包「${key}」${ok ? '已热重载' : '热重载失败'}${ok ? '' : `：${r?.detail || r?.reason || ''}`}`);
      return { ok, state: r?.state || '', reason: r?.reason || '', detail: r?.detail || '' };
    },

    /**
     * 监听插件目录，改了就重载那一个。
     * 只对"清单 / 入口文件"的变动作反应 —— 插件往自己目录里写数据不该触发重载。
     */
    watch({ debounceMs = 800 } = {}) {
      if (watchHandle) return watchHandle;
      const roots = extensionRoots(root);
      const timers = new Map();
      const watchers = [];
      const entryNames = new Set([...MANIFEST_FILES, 'index.js']);
      const onChange = (rootDir, filename) => {
        const rel = String(filename || '').replace(/\\/g, '/');
        if (!rel) return;
        const segs = rel.split('/').filter(Boolean);
        const dirName = segs[0];
        const base = segs[segs.length - 1];
        if (!dirName || !entryNames.has(base)) return;
        let id = '';
        for (const [pid, p] of plans) if (p.dirName === dirName) { id = pid; break; }
        if (!id) return;
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => {
          timers.delete(id);
          this.reload(id).catch((e) => warn(`扩展包「${id}」热重载出错：${e?.message ?? e}`));
        }, Math.max(100, Number(debounceMs) || 800)));
      };
      for (const r of roots) {
        try {
          const w = fs.watch(r.dir, { recursive: true }, (_evt, filename) => onChange(r.dir, filename));
          watchers.push(w);
        } catch { /* 目录不存在 / 平台不支持递归监听：静默跳过，不影响主流程 */ }
      }
      watchHandle = {
        stop() {
          for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
          for (const t of timers.values()) clearTimeout(t);
          timers.clear();
          watchHandle = null;
        },
        watched: watchers.length,
      };
      if (watchers.length) info(`扩展包 | 已开启热重载监听（${watchers.length} 个目录）`);
      return watchHandle;
    },

    async disposeAll() {
      let ran = 0;
      let hooksRemoved = 0;
      const errors = [];
      for (const [id, r] of records) {
        if (r.state !== HOST_STATE.LOADED) continue;
        const fn = modules.get(id)?.dispose;
        if (typeof fn === 'function') {
          try { await fn(); r.life.dispose = 'ok'; ran += 1; }
          catch (e) { r.life.dispose = 'failed'; errors.push({ id, message: String(e?.message ?? e) }); warn(`扩展包「${id}」dispose 抛错：${e?.message ?? e}`); }
        } else {
          r.life.dispose = 'absent';
        }
        hooksRemoved += bus.offOwner(id);
      }
      return { ran, hooksRemoved, errors };
    },
  };
}
