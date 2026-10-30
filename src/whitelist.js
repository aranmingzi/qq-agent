// 会话白名单：**这是唯一实现**。
//
// 为什么抽出来（P2-10 的前置）：
//   原先它只是 `app.js` 里的一个函数，于是"发送前复核"这件事在别处根本做不到 ——
//   主动发言、定时任务、唱歌交付都在 orchestrator 里，它们只能"相信入站时放行过"。
//   而白名单是**会变的**：用户在面板里移掉一个群，正在进行的那一轮照样会发出去。
//   表现是"我已经把它删了，它还在那个群里说话" —— 这是最容易让人不信任的一类 bug。
//
// 判据本身很小，但方向要写清：
//   · 黑名单优先（显式拒绝永远赢）；
//   · 白名单非空即"白名单模式"；
//   · 白名单为空时由 `allowAllWhenEmpty` 决定（默认 false = 一个都不放）。

/**
 * @param {'group'|'private'|string} kind
 * @param {string|number} id
 * @param {object} cfg 完整配置（读 cfg.allow / cfg.deny / cfg.allowAllWhenEmpty）
 * @returns {boolean}
 */
export function allowed(kind, id, cfg = {}) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if ((Array.isArray(denyList) ? denyList : []).map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  const list = Array.isArray(allowList) ? allowList : [];
  if (list.length > 0) return list.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

/** 给拒绝文案用：说清是哪条规则拦的（不说原因等于没说）。 */
export function denyReason(kind, id, cfg = {}) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if ((Array.isArray(denyList) ? denyList : []).map(String).includes(s)) return '它在黑名单里';
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (Array.isArray(allowList) && allowList.length) return '它不在白名单里（可能刚被移除）';
  return '白名单为空且没有开启「允许全部」';
}
