// ══════════════════════════════════════════════════════════════════════════
// QQ Agent Console · 设置页骨架声明表（数据驱动）
// ══════════════════════════════════════════════════════════════════════════
// 这个文件只声明「设置页有哪些 section、叫什么、顺序、图标」，不含渲染代码。
// 加/删/排序一个 section，只改下面这份数组；app.js 的侧边栏与路由都读它。
//
// 设计哲学参考 Estrella Bot 的 schema.js：
//   骨架是数据，渲染器读数据画界面，改骨架不改渲染代码。
//
// 当前阶段：section 内部仍是手写渲染函数（renderXxxSection），
//   因为它们带复杂交互（模型目录弹窗/人设选择器/白名单选择器等），
//   强行 schema 化收益低、风险高。本文件先把「最外层」数据化，
//   后续可逐步把 section 内部字段也下沉成 ctrls 声明。
// ══════════════════════════════════════════════════════════════════════════

// 普通 script 加载（非 ES module），把骨架挂到全局，避免 app.js 无 import 机制时无法引用。
(function () {
  'use strict';

// 图标：用内联 SVG 的 path（简化单色图标，跟随当前主题的 text 色）
const ICONS = {
  overview: '<path d="M4 4h6v6H4zM10 4h6v6h-6zM4 10h6v6H4zM10 10h6v6h-6z"/>',
  api: '<path d="M12 2a10 10 0 0 0 0 20 10 10 0 0 0 0-20zm1 3.5a7.5 7.5 0 0 1 0 13zM11 5.5a7.5 7.5 0 0 1 0 13z"/>',
  persona: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>',
  allow: '<path d="M7 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm3 6h4M10 14h4"/>',
  chat: '<path d="M4 6h16v9H9l-4 3z"/>',
  voice: '<path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3z"/><path d="M6 12a6 6 0 0 0 12 0M12 18v3"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  onebot: '<path d="M12 3a9 9 0 0 0-6 15.5L5 21l2.5-1A9 9 0 1 0 12 3z"/>'
};

/**
 * 设置页 section 骨架。
 * 每个条目：{ id, label, icon, desc }，desc 是进入该 section 顶部的一句话说明（可空）。
 */
const SETTINGS_SECTIONS = [
  { id: 'capabilities', label: '能力总览', icon: ICONS.overview, desc: '机器人现在具备哪些能力、哪些开关没打开。' },
  { id: 'api', label: '模型 API', icon: ICONS.api, desc: '模型、密钥、视觉识别与联网搜索的配置。' },
  { id: 'persona', label: '人设', icon: ICONS.persona, desc: '机器人的性格与说话方式。' },
  { id: 'allow', label: '聊天白名单', icon: ICONS.allow, desc: '控制机器人在哪些群/对谁响应。' },
  { id: 'chat', label: '聊天设置', icon: ICONS.chat, desc: '回复节奏、上下文、插话等行为参数。' },
  { id: 'voice', label: '语音音色', icon: ICONS.voice, desc: '文字转语音与 RVC 音色转换。' },
  { id: 'desktop', label: '桌面端', icon: ICONS.desktop, desc: '桌面应用相关设置。' },
  { id: 'onebot', label: 'OneBot（SnowLuma）', icon: ICONS.onebot, desc: '协议端与登录管理。' }
];

/** 按 id 取一个 section（找不到返回 null）。 */
function getSection(id) {
  return SETTINGS_SECTIONS.find((s) => s.id === id) || null;
}

/** 图标 SVG 字符串（18×18，stroke 跟随当前主题）。 */
function sectionIcon(id, size = 18) {
  const s = getSection(id);
  if (!s) return '';
  return `<svg class="sec-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.icon}</svg>`;
}

// 挂到全局，app.js 通过 window.QQAGENT_SCHEMA 引用
window.QQAGENT_SCHEMA = { SETTINGS_SECTIONS, getSection, sectionIcon };

})();
