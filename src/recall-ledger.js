// 召回台账（2026-10-27）—— 回答"概率式召回到底跑起来没有"。
//
// ── 为什么必须有它 ───────────────────────────────────────────────────
// 概率化之后最大的风险不是"随机过头"，而是**看起来在做、其实一直在空转**：
//   · 某个人的事实只有 2 条、名额有 8 个 → 抽样压根不触发（`full=true`）；
//   · 提示词 / 结构受到反复调整，注入条数悄悄变了，但没人注意到；
//   · 两个月后看到"她好像什么都不记得了"，分不清是模型退步、检索坏了、还是今天运气不好。
// 这三种都不报错，只能靠**计数**发现。这是从 `space-split-raw` 那次学来的做法：
// 改了行为就必须 simultaneously 加一个能把"改之前/改之后"分开的量，否则两周后无法归因。
//
// ── 三条纪律 ──────────────────────────────────────────────────────────
// ① append-only JSONL，**只追加不改**（这台账是用来事后归因的，不是状态）；
// ② **写失败绝不影响主流程**（它挂了只是看不见了，不该让机器人不回话）；
// ③ 一天几百行的量级，靠文件大小自限 —— 超过上限就从头砍掉一部分。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'metrics', 'fact-recall.jsonl');
/** 超过这么多字节就从头砍到一半（保留最近的）。5MB ≈ 两三个月的量。 */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 记一条召回观测。
 *
 * @param {string} layer 'facts' | 'group'
 * @param {object} stats recallFactRecords 返回的 stats
 * @param {{qq?:string, chatKey?:string, at?:number}} [meta]
 */
export function recordRecall(layer, stats, meta = {}) {
  try {
    const row = {
      at: Number(meta?.at) || Date.now(),
      layer: String(layer || 'facts'),
      qq: String(meta?.qq || ''),
      chatKey: String(meta?.chatKey || ''),
      ...stats
    };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* 台账写不动不影响这一轮对话 */ }
}

/**
// 读台账（看板用）。坏行跳过而不是整文件报废 —— 追加写写到一半进程被杀，
 * 最后一行会是残缺的 JSON，跳过它即可，前面的记录都是好的。
 * @returns {object[]}
 */
export function readRecallLedger({ sinceMs = 0, layer = '' } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (sinceMs && Number(row?.at) < sinceMs) continue;
    if (layer && String(row?.layer) !== layer) continue;
    out.push(row);
  }
  return out;
}

/**
 * 体积自限。挑读/写都不忙的时候调（每日维护），**写失败不抛**。
 * @returns {{trimmed:boolean, bytes:number}}
 */
export function trimRecallLedger() {
  try {
    const st = fs.statSync(FILE);
    if (st.size <= MAX_BYTES) return { trimmed: false, bytes: st.size };
    const raw = fs.readFileSync(FILE, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const keep = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(FILE, `${keep.join('\n')}\n`, 'utf8');
    return { trimmed: true, bytes: Buffer.byteLength(keep.join('\n')) };
  } catch { return { trimmed: false, bytes: 0 }; }
}

/** 台账文件路径（看板脚本要显示它）。 */
export const RECALL_LEDGER_FILE = FILE;
