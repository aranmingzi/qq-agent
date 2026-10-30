#!/usr/bin/env node
// 规则违规率看板（P4）：把 system 提示词里的每条行为规则，对上历史里真实的违规率。
//
// 用法：
//   node scripts/rule-audit.mjs                 # 最近 7 天
//   node scripts/rule-audit.mjs --days 3
//   node scripts/rule-audit.mjs --json          # 只出 JSON（给别的脚本吃）
//   node scripts/rule-audit.mjs --save          # 写快照到 data/rule-audit/<日>.json
//
// 为什么要有它：
//   提示词里的规则是"出了某个问题就加一条"堆出来的，只进不出。
//   没有指标时，谁也说不清哪条规则在起作用、哪条纯属心理安慰、哪两条在互相打架。
//   这个脚本给每条规则一个**可重放的检出器**，于是"删掉一条规则"第一次有了依据。
//
// 先跑检出器自检：0% 违规到底是"规则有效"还是"正则写错了"，只有样本能分辨。
// 自检不过的规则，它的 0% **不计入统计**（在表里标 ?），否则你会放心地删掉一条真在起作用的规则。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRuns, selfTest, dayKeyOf, locateRules, RULES, shapeRun, bucketRates } from '../src/rule-audit.js';
import { buildSystemBundle } from '../src/prompt.js';
import { getConfig } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_DIR = path.join(ROOT, 'data', 'sessions');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const DAYS = Math.max(1, Number(arg('days', '7')) || 7);
const since = Date.now() - DAYS * 86400000;

// ── 读历史 ────────────────────────────────────────────────────
let files = [];
try { files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json')); } catch { files = []; }
const sessions = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(j.sent) || !Number(j.startedAt)) continue;
  if (Number(j.startedAt) < since) continue;
  sessions.push(j);
}

const report = auditRuns(sessions);
const self = selfTest();
const failed = new Map(self.failures.map((x) => [x.id, x.detail]));

// ── 规则在哪一段（拿真实提示词搜，不手写断言）──────────────────
let locate = new Map();
let systemChars = 0;
try {
  const persona = getConfig().persona;
  const bundle = buildSystemBundle({ persona });
  const sections = (bundle.sections || []).map((s) => ({ name: s.name, text: String(s.text || ''), where: 'system' }));
  systemChars = String(bundle.text || '').length;
  // 人设段：不少"规则"其实是角色卡里的措辞（不写括号旁白、少用推销词…），
  // 换个人设就没了。不单独列出来，看板会谎报"这条规则在起作用"。
  if (String(persona?.roleText || '').trim()) {
    sections.push({ name: 'roleText', text: String(persona.roleText), where: 'persona' });
  }
  // user 侧：用最近一轮真实会话的 userPrompt 整体当一段（它没有名字可切，但"在不在 user 里"够用）
  const latest = sessions.slice().sort((a, b) => b.startedAt - a.startedAt)[0];
  if (latest?.userPrompt) {
    sections.push({ name: 'userPrompt', text: String(latest.userPrompt), where: 'user' });
  }
  for (const [id, v] of locateRules(RULES, sections)) locate.set(id, v);
} catch { /* 定位失败不影响统计，只是少一列 */ }

const sectionChars = {};
for (const v of locate.values()) if (v) sectionChars[v.where] = v.chars;

// ── 人类基线：同一条规则，真人自己是什么水平 ──────────────────
// 没有这一列的看板只能"跟自己比"：目标是自己拍的，方向靠感觉。
// 空格分句就是活例子 —— 目标拍的是 5%，而真人 27.7%（2,603 条）：
// 按 5% 要求她，等于要求她比真人规整 5 倍，那是另一种机器感。
// 口径：data/messages 里 self=false、排除 [拍一拍]/[卡片]/[图片] 这类系统占位（那不是人写的句子）。
const PH = /^\[(拍一拍|卡片|图片|表情|文件|语音|视频|合并转发|链接)/;
function humanTexts() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(ROOT, 'data', 'messages')).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'messages', f), 'utf8')); } catch { continue; }
    for (const m of (j.messages || [])) {
      if (!m || typeof m.text !== 'string' || m.self) continue;
      if (PH.test(m.text)) continue;
      out.push(m.text);
    }
  }
  return out;
}
const HUMS = humanTexts();
const humanSpaceRate = (() => {
  const detect = RULES.find((r) => r.id === 'space-split')?.detect;
  if (!HUMS.length || !detect) return null;
  return { n: HUMS.length, hits: HUMS.filter(detect).length, rate: Math.round((HUMS.filter(detect).length / HUMS.length) * 1000) / 10 };
})();

if (has('json')) {
  const located = Object.fromEntries([...locate.entries()]);
  console.log(JSON.stringify({ days: DAYS, ...report, selfTest: self, located, systemChars, humanSpaceRate }, null, 2));
  process.exit(0);
}

// ── 输出 ─────────────────────────────────────────────────────
const L = console.log;
const pct = (n) => `${n.toFixed(1)}%`;
const unitLabel = { bubble: '条气泡', run: '轮', 'run-all': '轮', sticker: '次表情' };
const whereOf = (id) => locate.get(id);
const shortWhere = (w) => (w ? w.where.replace('system:', 's.').replace('persona:roleText', '人设').replace('user:userPrompt', 'user') : '—');

L(`规则违规率看板 · 最近 ${DAYS} 天`);
L(`轮次 ${report.runs} · 文本气泡 ${report.bubbles} · 表情 ${report.stickers} · system 提示 ${systemChars} 字`);
if (!report.runs) {
  L('\n没有可用的历史（data/sessions 里没有带 sent 的会话）。等跑几轮再看。');
  process.exit(0);
}

// 自检
L('');
if (self.ok) {
  L(`检出器自检：${RULES.length} 条全部通过（坏样本都能抓到、好样本都不误判）`);
} else {
  L(`⚠️ 检出器自检失败 ${self.failures.length} 条 —— 下面标 ? 的那几行，它们的数字**不算数**（可能是正则写错，不是规则有效）`);
  for (const f of self.failures) L(`   · ${f.id}：${f.detail}`);
}

// 主表
L('');
const head = ['规则', '段', '段字数', '违规', '目标', '状态', '分母'];
const widths = [22, 17, 9, 7, 6, 9, 12];
const pad = (s, w) => {
  const str = String(s);
  const len = [...str].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, w - len));
};
L(head.map((h, i) => pad(h, widths[i])).join(''));
L(widths.map((w) => '─'.repeat(w)).join(''));
for (const r of report.rules) {
  const bad = failed.has(r.id);
  const w = whereOf(r.id);
  const status = bad ? ' ? 自检失败' : r.gauge ? ' 水位' : r.ok ? ' 达标' : ' 超标';
  L(pad(r.name, widths[0])
    + pad(shortWhere(w), widths[1])
    + pad(w ? `${w.chars}字` : '—', widths[2])
    + pad(bad ? '—' : pct(r.rate), widths[3])
    + pad(r.gauge ? '—' : pct(r.target), widths[4])
    + pad(status, widths[5])
    + pad(`${bad ? '?' : r.hits}/${r.total} ${unitLabel[r.unit] || ''}`, widths[6]));
}

const spaceRule = report.rules.find((r) => r.id === 'space-split');
if (HUMS.length >= 50 && spaceRule) {
  const detect = RULES.find((r) => r.id === 'space-split').detect;
  L('');
  L(`人类基线（data/messages 里 ${humanSpaceRate.n} 条真人消息，self=false）：空格分句 ${pct(humanSpaceRate.rate)}`);
  // 分桶并排：她在 / 人类 / 她原稿
  const shaped = sessions.map(shapeRun);
  const mine = bucketRates(shaped.flatMap((r) => r.texts), detect);
  const rawS = bucketRates(shaped.flatMap((r) => r.rawTexts || r.texts), detect);
  const hums = bucketRates(HUMS, detect);
  L(pad('长度档', 8) + pad('她(收到)', 11) + pad('她(原稿)', 11) + pad('人类', 11) + '差');
  L('─'.repeat(8) + '─'.repeat(11) + '─'.repeat(11) + '─'.repeat(11) + '─'.repeat(12));
  for (let i = 0; i < mine.length; i += 1) {
    const d = mine[i].rate - hums[i].rate;
    const cell = (row) => (row.n ? `${pct(row.rate)}(${row.n})` : '—');
    L(pad(mine[i].label, 8)
      + pad(cell(mine[i]), 11)
      + pad(cell(rawS[i]), 11)
      + pad(cell(hums[i]), 11)
      + (hums[i].n && mine[i].n ? `${d > 0 ? '+' : ''}${d.toFixed(1)}pp` : '—'));
  }
  L('读法：人类 <10 字段几乎不分隔（逗号率 2.1%），10 字以上改逗号（13.9%/40.9%），');
  L('      而空格率随长度一路上升到 57%、85% —— 说明空格是长句里的"备选分隔符"，不是禁忌。');
  L('      该纠的是"10 字以上该用逗号却用空格"，不是"用了空格"。');
}

// 趋势（最近 4 个有数据的日子）
const days = Object.keys(report.byDay).sort().slice(-4);
if (days.length >= 2) {
  L('');
  L('按天趋势（违规率 %）');
  L(pad('规则', widths[0]) + days.map((d) => pad(d.slice(5), 8)).join('') + ' 走向');
  L(pad('', widths[0]) + days.map(() => '─'.repeat(8)).join('') + '────');
  for (const r of report.rules) {
    if (r.unit === 'bubble' && r.total === 0) continue;
    const vals = days.map((d) => report.byDay[d]?.[r.id]?.rate ?? 0);
    const first = vals[0];
    const last = vals[vals.length - 1];
    const arrow = Math.abs(last - first) < 0.05 ? '→' : (last > first ? '↑' : '↓');
    L(pad(r.name, widths[0]) + vals.map((v) => pad(v.toFixed(1), 8)).join('') + '  ' + arrow);
  }
}

// 结论
const over = report.rules.filter((r) => r.ok === false && !failed.has(r.id));
L('');
if (over.length) {
  L(`超标 ${over.length} 条：${over.map((r) => `${r.name} ${pct(r.rate)}（目标 ${pct(r.target)}）`).join('；')}`);
} else {
  L('所有可判定的规则都在目标内。');
}
const dead = report.rules.filter((r) => !r.gauge && !failed.has(r.id) && r.hits === 0 && r.total > 50);
if (dead.length) {
  L('');
  L(`零违规则（${dead.length} 条，样本 >50 才有资格进这张表）：`);
  for (const r of dead) {
    const w = whereOf(r.id);
    L(`   · ${r.name} —— 在「${shortWhere(w) || '找不到'}」${w ? `（该段 ${w.chars} 字）` : ''}，${r.total} 次机会里一次没犯`);
  }
  L('   零违规有两种解释：规则很有效，或者这条规则根本不需要写。');
  L('   判据不是字数，而是"删掉之后会不会立刻犯" —— 建议一次只删一条，看两周。');
}

// 定位异常：规则原文在提示词里找不到 = 规则被删了/搬走了，而看板还在报旧指标
const lost = report.rules.filter((r) => !whereOf(r.id));
if (lost.length) {
  L('');
  L(`⚠️ 有 ${lost.length} 条规则在当前提示词里**找不到原文**：${lost.map((r) => r.name).join('、')}`);
  L('   两种可能，都要人看一眼：① 它写在人设/附加规则里，换人设就没了（那它的 0% 不算"规则有效"）；');
  L('   ② 它已经不在提示词里了 —— 那看板这一行就该删掉，别留一个永远达标的假指标。');
}

// 存快照
if (has('save')) {
  const outDir = path.resolve(ROOT, arg('out', 'data/rule-audit'));
  fs.mkdirSync(outDir, { recursive: true });
  const key = dayKeyOf(Date.now());
  fs.writeFileSync(path.join(outDir, `${key}.json`), `${JSON.stringify({
    at: new Date().toISOString(),
    days: DAYS,
    runs: report.runs,
    bubbles: report.bubbles,
    rules: report.rules,
    selfTestOk: self.ok,
    located: Object.fromEntries([...locate.entries()]),
    systemChars,
    humanSpaceRate
  }, null, 2)}\n`, 'utf8');
  L(`\n快照已写入 ${path.relative(ROOT, path.join(outDir, `${key}.json`))}`);
}
