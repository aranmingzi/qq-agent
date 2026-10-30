/**
 * 工具清单的**真实**成本。
 *
 * ⚠️ 为什么要这个工具：直接调 selectToolDefs(buildToolDefs(), {active:new Set()})
 *    量出来的"常驻工具"是**假的** —— 它绕过了 orchestrator 的两道前置筛选：
 *      · switchAllowed（KB 工具按身份模式、masterOnly 按主人、vision/search 按开关）
 *      · sceneTrim（私聊不裁工具）
 *    只看单个函数会得出"有 21 个工具常驻却从没用过"这种看着像金矿、实则不存在的结论。
 *    **测量必须复刻真实调用链。**
 *
 * 用法：node tools/tool-cost.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const { buildToolDefs, toOpenAiTools } = await import('../src/tools.js');
const { selectToolDefs, selectPacks, PACK_NAMES } = await import('../src/tool-scene.js');
const { qwenVisionInfo, modelVisionVerdict } = await import('../src/vision.js').catch(() => ({ qwenVisionInfo: () => ({ hasKey: false }), modelVisionVerdict: () => 'unknown' }));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

const visionMode = cfg.vision?.mode === 'qwen' ? 'qwen' : 'native';
const qv = qwenVisionInfo();
const visionEnabled = cfg.api?.vision !== false
  && (visionMode === 'qwen' || modelVisionVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision');
const searchEnabled = cfg.webSearch?.enabled !== false;

/** 复刻 orchestrator 的 switchAllowed + selectToolDefs 两步。 */
function realTools({ isMaster = false, mode = 'assistant', kind = 'group', packs = [] } = {}) {
  const ident = { mode };
  const sceneTrim = kind === 'group';
  const switchAllowed = (d) => {
    if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
    if ((cfg.audio?.enabled === false || cfg.audio?.asr?.enabled === false) && d.name === 'voice_to_text') return false;
    if (d.name === 'qwen_vision' && visionMode !== 'qwen' && !qv.hasKey) return false;
    if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
    if (d.name === 'watch_video' && cfg.video?.enabled === false) return false;
    if (d.masterOnly && !isMaster) return false;
    if (d.name === 'escalate_reasoning'
      && !(cfg.api?.routing?.enabled && cfg.api?.routing?.allowModelEscalation
        && String(cfg.api?.complexModel || '').trim())) return false;
    if (d.name === 'load_tools' && !sceneTrim) return false;
    return true;
  };
  const allAllowed = buildToolDefs().filter(switchAllowed);
  const pick = selectToolDefs(allAllowed, { active: new Set(packs), enabled: sceneTrim });
  return pick.defs;
}

const scenes = [
  { label: '群聊·群友说话·无包（最常见）', o: { kind: 'group', isMaster: false, mode: 'assistant' } },
  { label: '群聊·主人说话', o: { kind: 'group', isMaster: true, mode: 'assistant' } },
  { label: '私聊（主人）', o: { kind: 'private', isMaster: true, mode: 'assistant' } }
];

console.log('=== 真实工具清单（复刻 switchAllowed + sceneTrim）===\n');
for (const s of scenes) {
  const defs = realTools(s.o);
  const json = JSON.stringify(toOpenAiTools(defs));
  console.log(`  ${s.label.padEnd(24)} ${String(defs.length).padStart(3)} 个  ${String(json.length).padStart(6)} 字符 ≈ ${Math.round(json.length / 1.6)} token`);
}

// 最常见场景的工具逐个列出来
const common = realTools({ kind: 'group', isMaster: false, mode: 'assistant' });
console.log(`\n=== 最常见场景的 ${common.length} 个工具（按体积降序）===`);
const sizes = common
  .map((d) => ({ name: d.name, n: JSON.stringify(toOpenAiTools([d])).length, master: !!d.masterOnly }))
  .sort((a, b) => b.n - a.n);
for (const s of sizes) {
  console.log(`  ${s.name.padEnd(26)} ${String(s.n).padStart(5)} 字符${s.master ? '  [主人专属]' : ''}`);
}

// 对照：这些工具 1000 轮里被调用过几次
const sessDir = path.join(ROOT, 'data', 'sessions');
const files = fs.existsSync(sessDir) ? fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')) : [];
const calls = new Map();
for (const f of files) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    for (const m of (Array.isArray(s.messages) ? s.messages : [])) {
      for (const c of (m?.tool_calls || m?.toolCalls || [])) {
        const nm = (c?.function?.name) || c?.name || '';
        if (nm) calls.set(nm, (calls.get(nm) || 0) + 1);
      }
    }
  } catch { /* 坏存档跳过 */ }
}

console.log('\n=== 最常见场景里，1000 轮从未被调用的工具 ===');
const never = sizes.filter((s) => !calls.get(s.name));
let neverChars = 0;
for (const s of never) {
  neverChars += s.n;
  console.log(`  ${s.name.padEnd(26)} ${String(s.n).padStart(5)} 字符${s.master ? '  [主人专属]' : ''}`);
}
console.log(`  合计 ${never.length} 个 / ${neverChars} 字符 ≈ ${Math.round(neverChars / 1.6)} token`);
console.log(`  （占最常见场景的 ${(neverChars / JSON.stringify(toOpenAiTools(common)).length * 100).toFixed(1)}%）`);

console.log('\n=== 被调用过的（供对照）===');
for (const s of sizes) {
  const c = calls.get(s.name) || 0;
  if (c > 0) console.log(`  ${s.name.padEnd(26)} ${String(s.n).padStart(5)} 字符  ${String(c).padStart(4)} 次`);
}
