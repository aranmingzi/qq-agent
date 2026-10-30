// 一插件一工具 + action 枚举 —— 插件工具位的省法。
//
// ── 为什么要这条约定 ──────────────────────────────────────────────────────
// 我们的预算是硬的：内置工具 44 个，注册表上限 24 个（tool-registry.js::TOOL_MAX）。
// 一个插件想提供「列出 / 读一条 / 写一条 / 删一条 / 搜索」五件事，
// 按"一个功能一个工具"写就吃掉 5 个位；三个插件就把预算吃光。
//
// 模型那边其实也不需要 5 个名字：**一个名字 + 一个 action 参数**它照样会用，
// 而且这样工具描述能集中写清"这几个动作的区别"，比 5 段分散的描述更容易选对。
// 所以约定是：**一个插件一个工具，动作用 action 枚举分流。**
//
// 这条约定来自 QQ 机器人插件总合集（第五批）那套 `tool('safe_file_edit', desc, ['list','read',...])`
// 的包装手法。我们把它做成运行时能校验的形态，而不是只写在文档里：
//   · action 声明了就必须在 enum 里 —— 非法值**不会**落到插件代码里，而是在这里被拦下
//     并回一份"可选动作清单"（模型看到就能自己改，不用人介入）。
//   · parameters 只写各动作**共用**的键；每个动作专用的键写进 properties 即可，
//     用不到时模型不传，插件也不必校验"这个键在这个动作下必须为空"。
//   · 返回形状与内置工具一致（{content, isError}），插件不用记第二套协议。

/** 一个工具最多声明多少个动作（再多模型也记不住，描述会挤爆上下文）。 */
export const ACTION_MAX = 12;

/** 动作名：小写英文 + 下划线，和 tool name 同一套字符集。 */
const ACTION_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * 归一化 actions 声明。
 * 接受：`{ read: '读一条', write: '写一条' }` 或 `[{ name:'read', description:'读一条' }]`。
 * @returns {Array<{name:string, description:string}>} 顺序即 enum 顺序
 */
export function normalizeActions(actions, { problems = [] } = {}) {
  const out = [];
  const seen = new Set();
  const push = (name, description) => {
    const n = String(name ?? '').trim().toLowerCase();
    if (!ACTION_RE.test(n)) {
      problems.push(`action 名「${name}」不合法（小写英文开头，字母/数字/下划线，≤32 字），已丢弃`);
      return;
    }
    if (seen.has(n)) {
      problems.push(`action「${n}」重复声明，只留第一个`);
      return;
    }
    seen.add(n);
    out.push({ name: n, description: String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || n });
  };

  if (Array.isArray(actions)) {
    for (const item of actions) {
      if (typeof item === 'string') push(item, '');
      else if (item && typeof item === 'object') push(item.name ?? item.id, item.description ?? item.desc ?? item.title);
      else problems.push('actions 里有既不是字符串也不是对象的项，已丢弃');
    }
  } else if (actions && typeof actions === 'object') {
    for (const [k, v] of Object.entries(actions)) push(k, v);
  }
  return out.slice(0, ACTION_MAX);
}

/** 把动作清单压成一句给模型看的枚举说明。 */
export function describeActions(list) {
  return list.map((a) => `${a.name}=${a.description}`).join('；');
}

/**
 * 造一个 action 分发的工具定义。
 *
 * @param {object} spec
 * @param {string} spec.id 工具 id（会被 registry 收敛成合法 name）
 * @param {string} spec.description 工具描述（写清"这几件事归这一个工具管"）
 * @param {object|Array} spec.actions 动作声明
 * @param {object} [spec.properties] 各动作共用/全部的参数 schema
 * @param {string[]} [spec.required] 除 action 之外必填的键
 * @param {(ctx:object, args:object, action:string)=>any} spec.execute 真正的实现
 * @param {(problems:string[])=>void} [spec.onProblem] 声明有问题时的出口
 */
export function actionTool(spec = {}) {
  const { id, description = '', properties = {}, required = [], execute, onProblem } = spec;
  const problems = [];
  const list = normalizeActions(spec.actions, { problems });
  if (typeof onProblem === 'function' && problems.length) onProblem(problems);
  else if (problems.length) console.warn(`[plugin-toolkit] ${id || '(未命名工具)'}：${problems.join(' / ')}`);

  const names = list.map((a) => a.name);
  const schemaProps = {
    // action 放在第一个：模型的注意力顺序基本等于 properties 顺序
    action: {
      type: 'string',
      enum: names,
      description: names.length ? `要做什么：${describeActions(list)}` : '要做什么（本工具没有声明任何动作）',
    },
    ...(properties && typeof properties === 'object' ? properties : {}),
  };

  const def = {
    id,
    name: id,
    description: String(description || '').replace(/\s+/g, ' ').trim(),
    parameters: {
      type: 'object',
      properties: schemaProps,
      required: ['action', ...(Array.isArray(required) ? required.filter((r) => r && r !== 'action') : [])],
    },
    /** 这份工具声明了哪些动作（宿主/控制台可读，不用跑代码）。 */
    actions: names,
    async execute(ctx, args = {}) {
      const action = String(args?.action ?? '').trim().toLowerCase();
      if (!names.includes(action)) {
        // 不抛错，回一份"选择题" —— 模型看到枚举会自己重试，
        // 抛错反而容易让它放弃这个工具。这是和内置工具一致的形态。
        return {
          content: `错误：没有 action「${action || '(空)'}」。可选：${describeActions(list) || '（本工具没有动作）'}`,
          isError: true,
        };
      }
      try {
        const out = await execute(ctx, args, action);
        if (typeof out === 'string') return { content: out };
        if (out && typeof out === 'object') return out;
        return { content: '(无输出)' };
      } catch (error) {
        return { content: `错误：${error?.message ?? error}`, isError: true };
      }
    },
  };
  return def;
}
