/**
 * 四套大脑预设 —— 一键切换「模型 + 参数」组合
 * 参考 Estrella Bot 的「多套大脑预设」思路，适配 QQ Agent。
 *
 * 每套预设绑定一组 api 配置片段，切换即更新 config.api 对应字段。
 * 预设不写死模型 id（用户模型目录可能不同），而是给「角色」+「可覆盖的模型名」：
 *   - model：普通聊天模型（快/省）
 *   - complexModel：复杂任务模型（深推理）
 * 若用户目录里没有预设指定的模型名，应用时保留现有 model，只改其它参数。
 *
 * 四套（与 Estrella 的「快速 / 均衡 / 复杂 / 教学」对齐）：
 *   fast      快速       快而省，日常闲聊
 *   balanced  均衡       默认，速度与质量折中
 *   complex   深度       复杂任务优先，深推理
 *   tutor     教学       教学身份，知识库 + 长输出
 */

export const BRAIN_PRESETS = Object.freeze([
  {
    id: 'fast',
    name: '快速',
    icon: '⚡',
    desc: '快而省，日常闲聊',
    temperature: 0.9,
    maxOutputTokens: 800,
    complexMaxOutputTokens: 2000,
    thinkingMode: 'off',
    maxRounds: 4,
    modelHint: null,      // 不强制换模型，用当前普通模型
    complexModelHint: null,
  },
  {
    id: 'balanced',
    name: '均衡',
    icon: '⚖️',
    desc: '速度与质量折中（默认）',
    temperature: 0.8,
    maxOutputTokens: 1200,
    complexMaxOutputTokens: 4000,
    thinkingMode: 'auto',
    maxRounds: 6,
    modelHint: null,
    complexModelHint: null,
  },
  {
    id: 'complex',
    name: '深度',
    icon: '🧠',
    desc: '复杂任务优先，深推理',
    temperature: 0.6,
    maxOutputTokens: 1600,
    complexMaxOutputTokens: 8000,
    thinkingMode: 'auto',
    maxRounds: 8,
    modelHint: null,
    complexModelHint: null,
  },
  {
    id: 'tutor',
    name: '教学',
    icon: '📚',
    desc: '教学身份，长输出 + 知识库',
    temperature: 0.5,
    maxOutputTokens: 2000,
    complexMaxOutputTokens: 8000,
    thinkingMode: 'auto',
    maxRounds: 8,
    modelHint: null,
    complexModelHint: null,
  },
]);

/** 按 id 取预设。 */
export function getPreset(id) {
  return BRAIN_PRESETS.find((p) => p.id === id) || null;
}

/**
 * 把预设应用到当前 config，返回一份 patch（供 updateConfig）。
 * 只改预设里声明的字段；model / complexModel 仅在预设显式指定且当前未设置时才写。
 */
export function presetPatch(preset, currentApi = {}) {
  if (!preset) return {};
  const patch = {
    temperature: preset.temperature,
    maxOutputTokens: preset.maxOutputTokens,
    complexMaxOutputTokens: preset.complexMaxOutputTokens,
    thinkingMode: preset.thinkingMode,
    maxRounds: preset.maxRounds,
    preset: preset.id,
  };
  // 预设未硬编码模型名 → 不覆盖用户已选的模型
  return patch;
}

/** 供 UI 展示的预设列表（不含内部字段）。 */
export function presetList() {
  return BRAIN_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    desc: p.desc,
  }));
}
