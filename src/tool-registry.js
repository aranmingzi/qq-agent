/**
 * 工具注册表 —— function calling 的唯一注册/列举/取名点
 * 移植自 Estrella-Bot（QQ-Agent 生态 · MIT），适配 QQ Agent。
 *
 * QQ Agent 现有的工具是 buildToolDefs() 返回的硬编码数组。
 * 本注册表用于让**扩展包**也能注册工具，与内置工具合并进同一份 function 列表。
 *
 * 约束（照抄参考实现）：
 *  - specs() 逐轮稳定（按 name 排序，缓存同一引用）。
 *  - 工具定义唯一约定 execute(ctx, args)（与 QQ Agent 现有工具一致）。
 *  - 撞名 → 拒绝后注册的那个，绝不静默合并。
 */

export const TOOL_NAME_MAX = 64;
export const TOOL_NAME_RE = new RegExp(`^[A-Za-z0-9_-]{1,${TOOL_NAME_MAX}}$`);
export const TOOL_MAX = 24;

const TOOL_DESC_MAX = 512;
const BAD_RUN_RE = /[^A-Za-z0-9_-]+/g;

/** 把任意来源 id 收敛成合法 function name。收敛不出 → 空串。 */
export function normalizeToolName(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(BAD_RUN_RE, '_');
  s = s.replace(/^_+/, '').replace(/_+$/, '');
  if (!s) return '';
  return s.slice(0, TOOL_NAME_MAX);
}

/** 描述压成单行。 */
function normalizeDescription(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.slice(0, TOOL_DESC_MAX);
}

/** 参数 schema 归一化（只接受 object 型 JSON Schema）。 */
export function normalizeParameters(raw) {
  if (raw === undefined || raw === null) return { type: 'object', properties: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = raw.type ?? 'object';
  if (type !== 'object') return null;
  const properties = raw.properties ?? {};
  if (typeof properties !== 'object' || Array.isArray(properties)) return null;
  const out = { ...raw, type: 'object', properties };
  if (out.required !== undefined && !Array.isArray(out.required)) return null;
  return out;
}

/** 一条工具定义归一化。 */
export function normalizeToolDef(def) {
  if (!def || typeof def !== 'object') return { ok: false, reason: '工具定义不是对象' };
  const origin = String(def.id ?? def.name ?? '').trim();
  const name = normalizeToolName(def.id ?? def.name);
  if (!name) return { ok: false, reason: `工具 id「${origin}」收敛不出合法的 function name` };
  if (typeof def.execute !== 'function') {
    return { ok: false, reason: `工具「${name}」没有 execute 函数` };
  }
  const parameters = normalizeParameters(def.parameters);
  if (!parameters) {
    return { ok: false, reason: `工具「${name}」的 parameters 不是 object 型 JSON Schema` };
  }
  const description = normalizeDescription(def.description ?? def.title);
  return {
    ok: true,
    name,
    spec: { type: 'function', function: { name, description, parameters } },
    execute: def.execute,
    owner: String(def.owner ?? '').trim(),
    origin,
  };
}

function deepFreeze(o) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const v of Object.values(o)) deepFreeze(v);
  return o;
}

/** 扩展包注册工具的取名：owner__toolId。 */
export function scopedToolId(owner, rawId) {
  const o = normalizeToolName(owner);
  const t = normalizeToolName(rawId);
  if (!o && !t) return '';
  if (!o) return t.slice(0, TOOL_NAME_MAX);
  if (!t) return o.slice(0, TOOL_NAME_MAX);
  const sep = '__';
  const ownerPart = o.slice(0, 24);
  const room = TOOL_NAME_MAX - ownerPart.length - sep.length;
  return `${ownerPart}${sep}${t.slice(0, Math.max(1, room))}`;
}

export function createToolRegistry() {
  const items = new Map();
  let cache = null;

  const registry = {
    register(def) {
      const n = normalizeToolDef(def);
      if (!n.ok) return { ok: false, reason: n.reason };
      const prev = items.get(n.name);
      if (prev) {
        return {
          ok: false,
          reason: prev.origin === n.origin
            ? `工具「${n.name}」已经注册过（同一来源 ${n.origin} 重复注册）`
            : `工具名撞车：「${n.origin}」与「${prev.origin}」都收敛成「${n.name}」`,
        };
      }
      if (items.size >= TOOL_MAX) {
        return { ok: false, reason: `工具数已达上限 ${TOOL_MAX}（不再注册「${n.name}」）` };
      }
      items.set(n.name, { spec: n.spec, execute: n.execute, owner: n.owner, origin: n.origin });
      cache = null;
      return { ok: true, name: n.name };
    },

    unregister(name) {
      const key = normalizeToolName(name);
      if (!key || !items.has(key)) return false;
      items.delete(key);
      cache = null;
      return true;
    },

    has(name) { return items.has(normalizeToolName(name)); },
    size() { return items.size; },
    names() { return [...items.keys()].sort(); },

    meta() {
      return [...items.values()]
        .map((v) => ({ name: v.spec.function.name, owner: v.owner, origin: v.origin, description: v.spec.function.description }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    /** 给 body.tools 用的数组（同一引用直到注册表变化，按 name 排序）。 */
    specs() {
      if (cache) return cache;
      cache = deepFreeze([...items.values()].map((v) => v.spec)
        .sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0)));
      return cache;
    },

    /** 取 execute。返回 null 表示没有。 */
    executorOf(name) {
      return items.get(normalizeToolName(name))?.execute ?? null;
    },
  };

  return registry;
}
