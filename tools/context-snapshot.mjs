// 上下文压缩管线的**逐字快照**基准。
//
// 用途：重构压缩相关模块时，改动前后各跑一次，比对 JSON 必须完全一致。
//   node tools/context-snapshot.mjs --save baseline   # 改动前
//   node tools/context-snapshot.mjs --diff baseline   # 改动后
//
// 为什么不用"跑一遍 npm test"就完事：单测断言的是**我事先想到的性质**；
// 而重构最容易坏的是我没想到的那一处（比如某段拼装顺序、某个兜底值）。
// 真机存档里那 1000 份会话的原文是现成的语料，逐字比对能覆盖到那些性质之外的地方。
//
// 只跑纯函数（不联网、不写盘）：buildPastState / formatForPrompt / clipToolResult /
// selectPacks / selectToolDefs / normalizeSlots|normalizeSummary。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const CORPUS = path.join(DATA, 'snapshot-corpus');

// ── ⓪ 冻结语料（必须在 import src 之前：DATA_DIR 是加载时常量）────────────
// ⚠️ 语料必须**冻结**：data/messages 是机器人正在写的活数据（群里有新消息就变，
//    且 store 封顶 2000 条会裁最老的）；data/summary 也会随轮末异步改写。
//    直接拿它们当基准，diff 会红在"输入变了"而不是"代码坏了" ——
//    这种假红比没有基准更糟（真红会被当噪音一起忽略，实测就吃过两次）。
//    冻结内容：每个会话的尾部 200 条消息 + 摘要全文 + 一份 config.json
//    （config 也要冻结，否则 past 组会在默认配置下跑，测的就不是生产行为了）。
const FREEZE_N = 200;
const msgDir = path.join(CORPUS, 'messages');
const sumDir = path.join(CORPUS, 'summary');
const liveMsg = path.join(DATA, 'messages');
const liveSum = path.join(DATA, 'summary');
for (const d of [msgDir, sumDir]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

const liveFiles = fs.existsSync(liveMsg) ? fs.readdirSync(liveMsg).filter((f) => f.endsWith('.json')) : [];
for (const f of liveFiles) {
  const dst = path.join(msgDir, f);
  if (fs.existsSync(dst)) continue;
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(liveMsg, f), 'utf8'));
    const list = Array.isArray(arr) ? arr : (arr.messages || []);
    if (!list.length) continue;
    fs.writeFileSync(dst, JSON.stringify(list.slice(-FREEZE_N)));
  } catch { /* 坏文件跳过 */ }
}
for (const f of (fs.existsSync(liveSum) ? fs.readdirSync(liveSum) : []).filter((x) => x.endsWith('.json'))) {
  const dst = path.join(sumDir, f);
  if (fs.existsSync(dst)) continue;
  try { fs.copyFileSync(path.join(liveSum, f), dst); } catch { /* 忽略 */ }
}
if (fs.existsSync(path.join(DATA, 'config.json')) && !fs.existsSync(path.join(CORPUS, 'config.json'))) {
  try { fs.copyFileSync(path.join(DATA, 'config.json'), path.join(CORPUS, 'config.json')); } catch { /* 忽略 */ }
}

// 之后所有模块都读冻结目录（DATA_DIR 在 config.js 加载时就固化，改晚了一步就无效）
process.env.QQ_AGENT_DATA_DIR = CORPUS;

const { buildPastState } = await import('../src/prompt.js');
const { PastSummaryStore, normalizeSummary, normalizeSlots } = await import('../src/past-summary.js');
const { clipToolResult } = await import('../src/tool-result-budget.js');
const { selectPacks, selectToolDefs } = await import('../src/tool-scene.js');

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 12);
const out = { at: new Date().toISOString(), groups: {}, corpus: '' };

// ── ① 过去状态窗口 ────────────────────────────────────────────────────────
const files = fs.readdirSync(msgDir).filter((f) => f.endsWith('.json')).sort();
const rows = [];
let t0 = Date.now();
for (const f of files) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(msgDir, f), 'utf8')); } catch { continue; }
  const list = Array.isArray(arr) ? arr : (arr.messages || []);
  if (!list.length) continue;
  const chatKey = f.replace(/\.json$/, '').replace(/_/g, ':');
  const store = { recent: (_k, o = {}) => list.slice(-(Number(o.limit) || 24)) };
  for (const tier of ['direct', 'keyword', 'interject']) {
    const r = buildPastState(store, chatKey, { tier, aliases: ['小助手'], selfIds: ['10000001'], selfNickname: '小助手' });
    rows.push({ chat: f, tier, md5: md5(r.text), chars: r.text.length, kept: r.count, dropped: r.dropped?.length || 0 });
  }
}
out.groups.past = rows;
out.corpus = `frozen(${files.length} 会话)`;
out.timing = { buildPastStateMs: Date.now() - t0, runs: rows.length };

// ── ② 往事摘要（真机磁盘上的摘要）─────────────────────────────────────────
const sum = new PastSummaryStore();
const sumRows = [];
for (const f of (fs.existsSync(sumDir) ? fs.readdirSync(sumDir) : []).filter((x) => x.endsWith('.json'))) {
  const chatKey = f.replace(/\.json$/, '');
  for (const maxChars of [800, 400, 120]) {
    for (const slotMode of [true, false]) {
      const text = sum.formatForPrompt(chatKey, { maxChars, slotMode, perSlotMax: 3 });
      sumRows.push({ chat: chatKey, maxChars, slotMode, md5: md5(text), chars: text.length });
    }
  }
}
out.groups.summary = sumRows;

// ── ③ 归一化（真实摘要文本 + 固定坏样本）──────────────────────────────────
const samples = [];
for (const f of (fs.existsSync(sumDir) ? fs.readdirSync(sumDir) : []).filter((x) => x.endsWith('.json'))) {
  try { samples.push(String(JSON.parse(fs.readFileSync(path.join(sumDir, f), 'utf8')).summary || '')); } catch { /* ignore */ }
}
samples.push('- 张三问周末还聚不聚\n- 李四答应八点半叫我', '【谁在要什么】\n- a\n【发生了什么】\n- b', '', '好的，以下是摘要：\n- x');
const normRows = [];
for (const s of samples) {
  for (const [fn, label] of [[normalizeSummary, 'flat'], [normalizeSlots, 'slots']]) {
    for (const maxChars of [800, 200]) {
      for (const truncated of [false, true]) {
        const t = fn(s, { maxChars, maxLines: 8, perSlotMax: 3, truncated });
        normRows.push({ label, maxChars, truncated, md5: md5(t), chars: t.length });
      }
    }
  }
}
out.groups.normalize = normRows;

// ── ④ 工具结果截断 ────────────────────────────────────────────────────────
const mk = (n) => Array.from({ length: n }, (_, i) => `第${i}行内容abcdefghij`).join('\n');
const clipRows = [];
for (const body of [mk(5), mk(900), mk(5000), mk(200), 'x'.repeat(50000)]) {
  for (const maxChars of [12000, 4000, 2000]) {
    for (const headRatio of [undefined, 0.4, 0.7]) {
      const r = clipToolResult(body, { maxChars, headRatio });
      clipRows.push({ len: body.length, maxChars, headRatio: headRatio ?? 'default', md5: md5(r.text), changed: r.changed, dropped: r.dropped });
    }
  }
}
out.groups.toolClip = clipRows;

// ── ⑤ 工具场景装载 ────────────────────────────────────────────────────────
const texts = ['唱首歌', 'https://a.com/b 这个讲了啥', '什么梗啊这词', '表情包斗图', '你好', '来一首歌然后看 https://x.com'];
const defs = [{ name: 'send_message' }, { name: 'sing_lyrics' }, { name: 'web_fetch' }, { name: 'search_meme' }, { name: 'list_stickers' }];
const sceneRows = [];
for (const t of texts) {
  const s = selectPacks({ text: t, prev: { song: Date.now() - 60000 }, now: Date.parse('2026-10-27T12:00:00Z') });
  const d = selectToolDefs(defs, { active: s.active, enabled: true });
  sceneRows.push({ text: t, matched: s.matched.join(','), kept: s.kept.join(','), defs: d.defs.map((x) => x.name).join(','), removed: d.removed.join(',') });
}
out.groups.scene = sceneRows;

// ── 输出 / 比对 ───────────────────────────────────────────────────────────
const arg = process.argv[2];
const name = process.argv[3] || 'baseline';
const file = path.join(ROOT, 'data', `snapshot-${name}.json`);
if (arg === '--save') {
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`已保存快照 ${file}`);
  for (const [k, v] of Object.entries(out.groups)) console.log(`  ${k}: ${v.length} 行`);
  console.log(`  buildPastState ${out.timing.runs} 次耗时 ${out.timing.buildPastStateMs}ms`);
} else {
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  let diff = 0;
  for (const k of Object.keys(out.groups)) {
    const a = JSON.stringify(old.groups[k]);
    const b = JSON.stringify(out.groups[k]);
    if (a === b) { console.log(`  ✓ ${k} 逐字一致（${out.groups[k].length} 行）`); continue; }
    diff += 1;
    console.log(`  ✗ ${k} 不一致`);
    const oa = old.groups[k]; const ob = out.groups[k];
    for (let i = 0; i < Math.max(oa.length, ob.length); i += 1) {
      if (JSON.stringify(oa[i]) !== JSON.stringify(ob[i])) {
        console.log(`      [${i}] 旧 ${JSON.stringify(oa[i])}`);
        console.log(`      [${i}] 新 ${JSON.stringify(ob[i])}`);
        if (diff > 3) break;
      }
    }
  }
  console.log(diff ? `\n✗ 有 ${diff} 组不一致` : '\n✓ 与基线逐字一致');
  process.exit(diff ? 1 : 0);
}
