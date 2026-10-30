// 用量归档回填：把 data/sessions/*.json 里现存的会话汇总成 data/usage/<day>.json。
// 用途：老版本没有按天归档（usage-today.json 跨天即重置），能救回多少算多少。
// 用法：node scripts/usage-backfill.mjs [--force]
//   --force  覆盖已存在的归档（默认跳过，避免把更完整的实时账盖掉）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../src/json-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS_DIR = path.join(ROOT, 'data', 'sessions');
const USAGE_DIR = path.join(ROOT, 'data', 'usage');
const force = process.argv.includes('--force');

const localDayKey = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const days = new Map();
let scanned = 0;
let bad = 0;

for (const file of fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
  } catch {
    bad += 1;
    continue;
  }
  if (!s?.startedAt || !s.usage) continue;
  scanned += 1;
  const dayKey = localDayKey(s.startedAt);
  const acc = days.get(dayKey) || {
    dayKey,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    runs: 0,
    calls: 0,
    models: {},
    firstAt: s.startedAt,
    lastAt: s.startedAt
  };
  acc.promptTokens += s.usage.promptTokens || 0;
  acc.completionTokens += s.usage.completionTokens || 0;
  acc.totalTokens += s.usage.totalTokens || 0;
  acc.runs += 1;
  acc.calls += Number(s.usage.calls) || 0;
  for (const [model, u] of Object.entries(s.usage.models || {})) {
    const cur = acc.models[model] || { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    cur.promptTokens += u.promptTokens || 0;
    cur.completionTokens += u.completionTokens || 0;
    cur.totalTokens += u.totalTokens || 0;
    cur.calls += u.calls || 0;
    acc.models[model] = cur;
  }
  acc.firstAt = Math.min(acc.firstAt, s.startedAt);
  acc.lastAt = Math.max(acc.lastAt, s.endedAt || s.startedAt);
  days.set(dayKey, acc);
}

fs.mkdirSync(USAGE_DIR, { recursive: true });
const report = [];
for (const [dayKey, acc] of [...days.entries()].sort()) {
  const target = path.join(USAGE_DIR, `${dayKey}.json`);
  if (fs.existsSync(target) && !force) {
    report.push(`${dayKey} 已存在，跳过（--force 覆盖）`);
    continue;
  }
  const dayStart = new Date(`${dayKey}T00:00:00`).getTime();
  // 现存最早的一条都不在当天开头 → 前面那段明细已经被会话文件清理滚掉了
  const partial = acc.firstAt - dayStart > 60 * 60 * 1000;
  const out = {
    ...acc,
    source: 'sessions-backfill',
    partial,
    note: partial ? `仅含 ${new Date(acc.firstAt).toLocaleString('zh-CN', { hour12: false })} 之后的部分` : '完整',
    updatedAt: Date.now()
  };
  writeJsonAtomic(target, out);
  report.push(`${dayKey} 写入 ${out.runs} 轮 / ${(out.totalTokens / 1e6).toFixed(2)}M tokens${partial ? '（部分）' : ''}`);
}

console.log(`扫描会话 ${scanned} 个${bad ? `，坏文件 ${bad} 个` : ''}`);
for (const line of report) console.log('  ' + line);
