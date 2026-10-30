// 给"没有场景标签"的旧表情补场景归因（纯文本判断，不用重新看图）。
//
// 背景：库里的表情来自三处 —— 早期手工整备的 dayu_*、QQ 收藏同步的 qq、以及
// 整包导入的 dfy_*。前两类的标签是早期自由词（"腹黑/傲娇/涨价"），不在场景词表里，
// 于是"按场景检索"永远搜不到它们。这个脚本只补场景词，原有标签保留（关键词搜索还要用）。
//
// 用法：node scripts/sticker-retag.mjs [--dry-run] [--force] [--batch 20]
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../src/config.js';
import { STICKER_SCENES, loadStickerStore, saveStickerStore } from '../src/stickers.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DRY = hasFlag('--dry-run');
const FORCE = hasFlag('--force');
const BATCH = Math.max(5, Math.min(40, Number(flagValue('--batch', '20')) || 20));
const nowIso = () => new Date().toISOString();

const items = loadStickerStore(STICKER_FILE).filter((e) => !e.disabled);
const need = items.filter((e) => canonicalScenes(e.tags).length === 0);
console.log(`库里启用 ${items.length} 条，待补场景标签 ${need.length} 条`);
if (!need.length) process.exit(0);
if (DRY) {
  for (const e of need.slice(0, 10)) console.log(`  ${e.id}｜${(e.desc || e.localNote || '').slice(0, 36)}`);
  console.log('--dry-run：不写盘');
  process.exit(0);
}

const cfg = getConfig().api || {};
if (!cfg.baseUrl || !cfg.model) {
  console.error('未配置主模型，无法做文本归类');
  process.exit(2);
}

async function classify(chunk) {
  const prompt = `下面是一批聊天表情包的备注（desc 是画面描述，note 是图上文字/用法）。请判断每张最适合在什么场景发给别人。

场景词表（只能从这里选，每张 1~3 个）：${STICKER_SCENES.join('、')}

只输出一个 JSON 对象，键是 id，值是场景词数组，不要任何解释：
{"id1":["场景","场景"],"id2":["场景"]}

表情列表：
${chunk.map((e) => `- id=${e.id}｜${(e.desc || '').slice(0, 40)}｜${(e.localNote || '').slice(0, 50)}`).join('\n')}`;
  const res = await fetch(`${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.1,
      max_tokens: 1500,
      stream: false,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(120000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
  const text = String(json?.choices?.[0]?.message?.content ?? '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没返回 JSON');
  return JSON.parse(text.slice(a, b + 1));
}

const store = loadStickerStore(STICKER_FILE);
const byId = new Map(store.map((e) => [e.id, e]));
// 先确认应用没在跑：运行时会在同步表情后用内存旧数据回写，白改一场
const port = Number(getConfig().server?.port) || 3210;
let running = false;
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
  running = r.status > 0;
} catch { running = false; }
if (running && !FORCE) {
  console.error('检测到 QQ Agent 正在运行：请先退出，或加 --force（结束后必须重启应用，否则会被内存旧数据覆盖）');
  process.exit(3);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.copyFileSync(STICKER_FILE, `${STICKER_FILE}.bak-retag-${stamp}`);

let updated = 0;
for (let i = 0; i < need.length; i += BATCH) {
  const chunk = need.slice(i, i + BATCH);
  let map = {};
  try {
    map = await classify(chunk);
  } catch (error) {
    console.warn(`  批次 ${i / BATCH + 1} 失败：${error.message}`);
    continue;
  }
  for (const e of chunk) {
    const picked = (Array.isArray(map[e.id]) ? map[e.id] : []).filter((s) => STICKER_SCENES.includes(s)).slice(0, 3);
    if (!picked.length) continue;
    const target = byId.get(e.id);
    if (!target) continue;
    target.tags = [...new Set([...(target.tags || []), ...picked])].slice(0, 10);
    target.updatedAt = nowIso();
    updated += 1;
  }
  console.log(`  批次 ${i / BATCH + 1}/${Math.ceil(need.length / BATCH)} 完成，累计补 ${updated} 条`);
}

saveStickerStore(store, STICKER_FILE);
const counts = new Map();
for (const e of store.filter((x) => !x.disabled)) {
  for (const t of e.tags || []) if (STICKER_SCENES.includes(t)) counts.set(t, (counts.get(t) || 0) + 1);
}
const left = store.filter((e) => !e.disabled && !(e.tags || []).some((t) => STICKER_SCENES.includes(t))).length;
console.log(`\n补标注 ${updated} 条，仍缺场景标签 ${left} 条`);
console.log(`场景分布：${STICKER_SCENES.filter((s) => counts.get(s)).map((s) => `${s}${counts.get(s)}`).join(' ')}`);
console.log('完成。重启 QQ Agent 生效。');
