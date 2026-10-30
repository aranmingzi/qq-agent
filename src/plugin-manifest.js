/**
 * 扩展包清单（skill.json / plugin.json）的唯一判据
 * 移植自 Estrella-Bot（QQ-Agent 生态 · MIT），按 QQ Agent 现状裁剪。
 *
 * 职责只有一件：在把磁盘上的东西当成插件之前，先把它看清楚。
 * 本文件不执行任何扩展代码（不 import、不跑 hooks、不注册工具）。
 *
 * 关键约定（与 Estrella 一致，别改）：
 *  - 目录名与 id 解耦：目录名可以是中文，清单里的 id 必须是英文；
 *    加载器以 id 为准。
 *  - manifest 文件名按优先序：skill.json > plugin.json。
 *  - plugins/ = 确定性型（钩子/能力）；skills/ = LLM 型（注册工具）。
 *  - 白名单：扫描只发现候选，真正加载必须在 config 里显式列出 id。
 */

/** 宿主支持的扩展 API 版本。清单里 apiVersion 不等于它 → 拒绝加载。 */
export const PLUGIN_API_VERSION = 1;

/**
 * 宿主自身版本（用于清单 `engines.qqagent` 的兼容判断）。
 * ⚠️ 必须与 package.json 的 version 同步；改一处就改两处（有测试盯着）。
 */
export const HOST_VERSION = '1.0.0';

function parseVer(v) {
  const m = String(v ?? '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

/**
 * 极简 semver 区间判断（纯函数）。
 * 支持：`>=1.2.0` `<2` `=1.0.0` `1.0.0` `^1.2.0`（同 major）`~1.2.0`（同 minor）
 * 多个条件用空格或逗号分隔 = AND；不认识的写法一律视为"不满足"（宁可拒绝，不要装上一个说不清兼容性的插件）。
 */
export function satisfies(version, range) {
  const v = parseVer(version);
  if (!v) return false;
  const r = String(range ?? '').trim();
  if (!r || r === '*') return true;
  const parts = r.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return true;
  for (const raw of parts) {
    const m = raw.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/);
    if (!m) return false;
    const op = m[1] || '=';
    const target = parseVer(m[2]);
    if (!target) return false;
    const c = cmpVer(v, target);
    if (op === '>=' && c < 0) return false;
    if (op === '<=' && c > 0) return false;
    if (op === '>' && c <= 0) return false;
    if (op === '<' && c >= 0) return false;
    if (op === '=' && c !== 0) return false;
    if (op === '^') {
      if (c < 0) return false;
      if (v[0] !== target[0]) return false;      // 只允许同 major
    }
    if (op === '~') {
      if (c < 0) return false;
      if (v[0] !== target[0] || v[1] !== target[1]) return false;
    }
  }
  return true;
}

/** 清单文件名，按优先序。 */
export const MANIFEST_FILES = ['skill.json', 'plugin.json'];

/** 目录 → 语义类型。 */
export const DIR_KINDS = { plugins: 'plugin', skills: 'skill' };

/** 最多允许启用的扩展条目数（兜底，防配置写坏）。 */
export const PLUGIN_MAX = 20;

/** 入口文件默认名。 */
const DEFAULT_ENTRY = 'index.js';

/** 合法 id：英文（字母开头，后跟字母/数字/下划线/连字符，总长 ≤ 40）。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function isValidPluginId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}

/** 去掉 UTF-8 BOM（Windows 记事本 / PowerShell 会写，JSON.parse 遇 BOM 抛错且不提示）。 */
export function stripBom(text) {
  if (typeof text !== 'string') return '';
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 相对路径安全判定（纯字符串，不碰 fs/path）。
 * 拦：绝对路径、上跳段(..)、空段/尾斜杠、NUL 注入。
 */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.includes('\u0000')) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  const segs = p.split(/[\\/]/);
  return segs.every((s) => s !== '' && s !== '..');
}

/** 归一化字符串数组字段（非字符串项丢弃并记警告）。 */
function strList(v, max, problems, field) {
  const raw = Array.isArray(v) ? v : [];
  const out = [];
  for (const it of raw) {
    if (typeof it !== 'string') {
      problems.push({ code: 'bad-list-item', text: `${field} 里有非字符串项，已丢弃` });
      continue;
    }
    const s = it.trim();
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 归一化 configSchema：`{ 键: { type, label, default, options|min|max, help } }`。
 *
 * 为什么必须留本体，而不只是留键名（这是 Estrella 踩过的坑，写在他们的注释里）：
 *   只留 schemaKeys 等于留了一串"有这个设置"的空壳 —— 插件的 `api.config()`
 *   拿不到 default，永远是空对象。**测试之所以是绿的，是因为测试自己传了 settings**；
 *   生产里没人传，于是插件读到 undefined，静默走错分支。
 *
 * 这个函数只做归一化，不校验语义（那是插件自己的事）：
 *   unknown 的 type 一律按 'string' 处理（不拒绝整个清单 —— 一个坏字段不该让插件装不上）。
 *
 * @returns {object} 干净的 schema（键顺序保留清单里的顺序）
 */
export function normalizeConfigSchema(raw, problems = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const TYPES = ['string', 'number', 'boolean', 'select', 'multiselect', 'text', 'secret'];
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      problems.push({ code: 'bad-schema-field', text: `configSchema.${key} 不是对象，已忽略` });
      continue;
    }
    let type = String(v.type ?? '').trim().toLowerCase();
    if (!TYPES.includes(type)) {
      if (type) problems.push({ code: 'bad-schema-type', text: `configSchema.${key}.type「${type}」不认识，按 string 处理` });
      type = 'string';
    }
    const field = {
      type,
      label: typeof v.label === 'string' && v.label.trim() ? v.label.trim().slice(0, 60) : key,
      help: typeof v.help === 'string' ? v.help.trim().slice(0, 200) : '',
    };
    // default 只在真的写了的时候才带上：`default: undefined` 与 `没有 default` 必须能区分，
    // 否则"插件想让默认值是空"会被当成"没设默认值"，又被 settings 覆盖回去。
    if (Object.prototype.hasOwnProperty.call(v, 'default')) {
      field.default = v.default;
    }
    if (Array.isArray(v.options)) {
      field.options = v.options
        .map((o) => (o && typeof o === 'object'
          ? { value: o.value, label: String(o.label ?? o.value ?? '').slice(0, 40) }
          : { value: o, label: String(o ?? '').slice(0, 40) }))
        .slice(0, 50);
    }
    if (Number.isFinite(Number(v.min))) field.min = Number(v.min);
    if (Number.isFinite(Number(v.max))) field.max = Number(v.max);
    out[key] = field;
  }
  return out;
}

/** schema 里声明的默认值（顺序无所谓，只取 default 存在的键）。 */
export function schemaDefaults(configSchema) {
  const out = {};
  const src = configSchema && typeof configSchema === 'object' ? configSchema : {};
  for (const [k, f] of Object.entries(src)) {
    if (f && Object.prototype.hasOwnProperty.call(f, 'default')) out[k] = f.default;
  }
  return out;
}

/**
 * 归一化清单里的 `prompt.sections` —— 插件声明的"边界提醒"。
 *
 * 为什么插件要能带提示词：插件装了但模型不知道它存在，就会出现
 * 「复读拦截把消息否了，模型以为发送失败，换个说法再发一次，又被否」这种死循环。
 * 让插件自己写一句"我在这里，别做 X"，比逼着宿主改 prompt.js 干净得多 ——
 * 宿主只负责收集和拼接，不负责理解每个插件。
 *
 * 但这条口子必须窄，否则就是一个绕过所有约束往系统提示里写东西的后门：
 *   · 只允许**声明式文本**，不接受函数、不接受变量插值。
 *   · 条数/单段/总长都设硬上限（超了就截断并记 problem，不静默吞）。
 *   · 段落永远排在宿主自带规则**之后**，且标题写明是扩展包说的 ——
 *     它不能覆盖人格、安全规则、工具协议。
 */
export const PROMPT_SECTIONS_MAX = 5;
export const PROMPT_SECTION_TITLE_MAX = 40;
export const PROMPT_SECTION_BODY_MAX = 600;
export const PROMPT_SECTIONS_TOTAL_MAX = 2000;

export function normalizePromptSections(raw, problems = []) {
  // 传错（比如传了个对象）不该让整个清单归一化崩掉 —— 丢弃 problem 记录总比拒绝加载好
  const notes = Array.isArray(problems) ? problems : [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    // `{ "标题": "正文" }` 的紧凑写法也认
    list = Object.entries(raw).map(([title, body]) => ({ title, body }));
  }
  const out = [];
  let total = 0;
  for (const item of list) {
    if (out.length >= PROMPT_SECTIONS_MAX) {
      notes.push({ code: 'too-many-prompt-sections', text: `prompt.sections 超过 ${PROMPT_SECTIONS_MAX} 段，多的已丢弃` });
      break;
    }
    let title = '';
    let body = '';
    let order = 100;
    let when = [];
    if (typeof item === 'string') {
      body = item;
    } else if (item && typeof item === 'object') {
      title = typeof item.title === 'string' ? item.title.trim().slice(0, PROMPT_SECTION_TITLE_MAX) : '';
      body = typeof item.body === 'string' ? item.body : (typeof item.text === 'string' ? item.text : '');
      if (Number.isFinite(Number(item.order))) order = Number(item.order);
      // when：只在消息命中这些关键词时才注入（条件段，见 prompt.renderConditionalSections）
      if (Array.isArray(item.when)) {
        when = item.when
          .filter((w) => typeof w === 'string' && w.trim())
          .map((w) => w.trim().slice(0, 40))
          .slice(0, 12);
      }
    }
    body = String(body || '').replace(/\r\n?/g, '\n').trim();
    if (!body) {
      notes.push({ code: 'empty-prompt-section', text: 'prompt.sections 有一段正文为空，已丢弃' });
      continue;
    }
    if (body.length > PROMPT_SECTION_BODY_MAX) {
      notes.push({ code: 'long-prompt-section', text: `prompt.sections 某段超过 ${PROMPT_SECTION_BODY_MAX} 字，已截断` });
      body = body.slice(0, PROMPT_SECTION_BODY_MAX);
    }
    if (total + body.length > PROMPT_SECTIONS_TOTAL_MAX) {
      notes.push({ code: 'prompt-sections-overflow', text: `prompt.sections 总长超过 ${PROMPT_SECTIONS_TOTAL_MAX} 字，后面的段落已丢弃` });
      break;
    }
    total += body.length;
    out.push({ title: title || '说明', body, order, when });
  }
  return out.sort((a, b) => a.order - b.order);
}

/**
 * 跨插件排序：先按各段 order，再按插件 id。
 *
 * 两个键都要：只按 order 排，同 order 的段落顺序会随 Map 迭代顺序变，
 * 提示词每轮都可能不一样（模型的 prompt 缓存全失效，且行为不可复现）。
 */
export function sortPromptSections(list = []) {
  return (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => (Number(a?.order) || 100) - (Number(b?.order) || 100)
      || String(a?.owner ?? '').localeCompare(String(b?.owner ?? '')));
}

/**
 * 归一化清单。fatal 非空 = 不可用；problems 非空但仍可用。
 */
export function normalizeManifest(raw, { fallbackId = '', kind = null } = {}) {
  const fatal = [];
  const problems = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fatal.push({ code: 'not-an-object', text: '清单顶层不是一个对象' });
    return { manifest: null, fatal, problems };
  }

  const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
  let id = rawId;
  if (!id) {
    const fb = String(fallbackId || '').trim();
    if (fb) {
      id = fb;
      problems.push({ code: 'id-from-dirname', text: `清单没写 id，回退成目录名「${fb}」` });
    }
  }
  if (!id) fatal.push({ code: 'bad-id', text: '清单没有 id，目录名也取不到' });
  else if (!isValidPluginId(id)) {
    fatal.push({ code: 'bad-id', text: `id「${id}」不是合法英文 id（需字母/数字/下划线/连字符，≤40 字）` });
  }

  const apiVersion = Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion)) {
    fatal.push({ code: 'bad-api-version', text: `apiVersion 不是整数：${JSON.stringify(raw.apiVersion)}` });
  } else if (apiVersion !== PLUGIN_API_VERSION) {
    fatal.push({ code: 'api-version-mismatch', text: `apiVersion ${apiVersion} 与宿主 ${PLUGIN_API_VERSION} 不符` });
  }

  const entry = raw.entry == null || raw.entry === '' ? DEFAULT_ENTRY : String(raw.entry).trim();
  if (!isSafeRelPath(entry)) {
    fatal.push({ code: 'bad-entry', text: `entry 必须是包内的相对路径：${entry}` });
  }

  // engines：插件声明"我适配哪个宿主版本"。不满足就**拒绝加载**并说清版本，
  // 而不是装上去之后在某个 api 上抛 undefined（2026-10-22 AstrBot 的 astrbot_version 做法）。
  const engines = raw.engines && typeof raw.engines === 'object' && !Array.isArray(raw.engines)
    ? { ...raw.engines }
    : {};
  const wantHost = engines.qqagent === undefined ? '' : String(engines.qqagent).trim();
  if (wantHost && !satisfies(HOST_VERSION, wantHost)) {
    fatal.push({
      code: 'engine-mismatch',
      text: `清单要求宿主 qqagent「${wantHost}」，当前是 ${HOST_VERSION}；请换一个适配当前版本的插件`,
    });
  }

  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0.0.0';
  if (version === '0.0.0' && String(raw.version ?? '').trim() !== '0.0.0') {
    problems.push({ code: 'missing-version', text: '清单没写 version，按 0.0.0 记' });
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id || '(未命名)';
  if (!(typeof raw.name === 'string' && raw.name.trim())) {
    problems.push({ code: 'missing-name', text: '清单没写 name，用 id 代替' });
  }

  const configSchema = normalizeConfigSchema(raw.configSchema, problems);
  const schemaKeys = Object.keys(configSchema);

  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? { ...raw.settings }
    : {};
  if (!Object.keys(settings).length && raw.settings) {
    problems.push({ code: 'bad-settings', text: 'settings 不是对象，已忽略' });
  }
  const settingsKeys = [...new Set([...schemaKeys, ...Object.keys(settings)])];

  const promptSections = normalizePromptSections(
    raw.prompt && typeof raw.prompt === 'object' && !Array.isArray(raw.prompt)
      ? raw.prompt.sections
      : raw.prompt,
    problems
  );

  const manifest = {
    id,
    name,
    version,
    apiVersion: Number.isInteger(apiVersion) ? apiVersion : null,
    kind,
    category: typeof raw.category === 'string' ? raw.category.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    author: typeof raw.author === 'string' ? raw.author.trim() : '',
    enabledByDefault: raw.enabledByDefault === true,
    capabilities: strList(raw.capabilities, 20, problems, 'capabilities'),
    permissions: strList(raw.permissions, 20, problems, 'permissions'),
    requires: strList(raw.requires, 20, problems, 'requires'),
    engines,
    entry,
    configSchema,
    schemaKeys,
    settings,
    settingsKeys,
    promptSections,
  };

  return { manifest, fatal, problems };
}

/**
 * 白名单判定（纯函数）。action：load | skip | reject。
 */
export function planLoad(entries, enabledIds) {
  const want = new Set();
  for (const x of enabledIds || []) want.add(String(x));

  const out = [];
  for (const e of entries || []) {
    if (!e) continue;
    const dirName = String(e.dirName || '');
    const id = e.manifest?.id || dirName;
    const base = {
      id,
      dir: e.dir,
      dirName,
      kind: e.kind ?? null,
      manifest: e.manifest || null,
      problems: e.problems || [],
      detail: '',
    };

    if (!e.manifest) {
      const reason = e.fatal?.[0]?.code || 'no-manifest';
      const detail = e.fatal?.[0]?.text || '缺少 skill.json / plugin.json';
      out.push({ ...base, action: 'reject', reason, detail });
      continue;
    }

    if (e.fatal?.length) {
      out.push({ ...base, action: 'reject', reason: e.fatal[0].code, detail: e.fatal[0].text });
      continue;
    }

    if (!want.has(id)) {
      out.push({ ...base, action: 'skip', reason: 'not-enabled', detail: '未在 config 的白名单里启用' });
      continue;
    }

    // requires：声明的依赖必须也在启用列表里。否则加载顺序无法保证，
    // 插件会在 api.isActive() 恒为 false 的情况下静默降级（比直接拒绝更难查）。
    const requires = Array.isArray(e.manifest.requires) ? e.manifest.requires : [];
    const missing = requires.filter((r) => !want.has(String(r)));
    if (missing.length) {
      out.push({
        ...base,
        action: 'reject',
        reason: 'missing-requires',
        detail: `依赖的扩展没有启用：${missing.join('、')}`,
      });
      continue;
    }

    out.push({ ...base, action: 'load', reason: 'enabled', detail: '已启用' });
  }
  return out;
}

/** 汇总。必须把每个原因出现次数算出来（输入基数必须打印）。 */
export function summarize(plan) {
  const s = { total: 0, load: 0, skip: 0, reject: 0, byReason: {}, byKind: {} };
  for (const p of plan || []) {
    s.total += 1;
    s[p.action] = (s[p.action] || 0) + 1;
    s.byReason[p.reason] = (s.byReason[p.reason] || 0) + 1;
    const k = p.kind || 'unknown';
    s.byKind[k] = (s.byKind[k] || 0) + 1;
  }
  return s;
}
