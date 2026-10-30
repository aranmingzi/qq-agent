// 把 cnmeme.wiki 的词库（memes.db）导成 QQ Agent 能直接读的 JSON。
//
// 为什么要有这一步（而不是运行时直读 sqlite）：
//   1. 运行时依赖 node:sqlite 是**实验特性**，22.x 要 `--experimental-sqlite`，
//      20.x 干脆没有；而 package.json 的 engines 写着 >=20。一次导出，全程零依赖。
//   2. 词库是**只读快照**（上游也是这么设计的），没有写入、没有并发，用不上数据库。
//   3. 导出时顺手裁掉不看的部分：usage 存到 600 字、origin 到 450 字 —— 这两个数
//      和 meme-wiki.js 里给模型看的截断上限一致，等于把 12.8MB 压到 5MB 上下，
//      而模型能看到的**一个字都没少**。
//
// 用法：
//   node tools/build-meme-wiki.mjs                 # 用 _vendor 里的 memes.db 导出
//   node tools/build-meme-wiki.mjs --db D:\x\memes.db
//   node tools/build-meme-wiki.mjs --check         # 只看现有导出是否可用，不写盘
//
// ⚠️ 别在服务运行中直接覆盖 wiki.json：node 里读了一半被换掉会解析失败。
//    这里先写 .tmp 再 rename（和 json-store 的 writeJsonAtomic 同一套做法）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DB = path.join(ROOT, '_vendor', 'memewiki', 'data', 'memes.db');
const DEFAULT_OUT = path.join(ROOT, 'data', 'memewiki', 'wiki.json');

/** 和 meme-wiki.js 的展示上限对齐 —— 导出时裁到这里，运行时不用再裁。 */
export const USAGE_MAX = 600;
export const ORIGIN_MAX = 450;

function argOf(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n) : t;
}

/** memes.db → wiki 对象。字段与 meme-wiki.js 的 item 形状一一对应。 */
export function rowsToWiki(rows, { builtAt = '', source = 'memes.db' } = {}) {
  const items = [];
  const seen = new Set();
  for (const r of rows || []) {
    const title = String(r.title ?? '').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);

    let usage = clip(r.usage, USAGE_MAX);
    let origin = clip(r.origin, ORIGIN_MAX);
    // 上游约定：usage/origin 都空时才把 other/summary 当正文（否则会重复一遍来源）。
    if (!usage && !origin) usage = clip(r.other || r.summary, USAGE_MAX);
    if (!usage && !origin) continue;

    items.push({
      t: title,
      g: String(r.tags ?? '').split('、').map((x) => x.trim()).filter(Boolean),
      u: usage,
      o: origin
    });
  }
  return {
    schema: 1,
    built_at: builtAt,
    count: items.length,
    source,
    items
  };
}

async function readDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(
      '当前 node 没有 node:sqlite。22.x 请加 --experimental-sqlite，或换 node ≥ 23.4。\n'
      + '（运行时不需要它 —— 只有这个导出脚本需要）'
    );
  }
  if (!DatabaseSync) throw new Error('node:sqlite 里没有 DatabaseSync（版本太老）');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到词库文件：${dbPath}`);
  // 只读打开、用完即关：Windows 上常驻句柄会把 memes.db 锁住（上游 1.5.2 踩过）。
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT title, tags, usage, origin, other, summary FROM memes').all();
    let builtAt = '';
    try {
      const meta = db.prepare('SELECT key, value FROM meta').all();
      builtAt = String(meta.find((m) => m.key === 'built_at')?.value ?? '');
    } catch {
      // meta 表不存在不影响导出
    }
    return { rows, builtAt };
  } finally {
    db.close();
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function summarize(wiki) {
  const bytes = Buffer.byteLength(JSON.stringify(wiki));
  return `${wiki.count} 条 · ${(bytes / 1024 / 1024).toFixed(2)}MB · 生成于 ${wiki.built_at || '未知'}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const out = argOf(argv, '--out', DEFAULT_OUT);
  const dbPath = argOf(argv, '--db', DEFAULT_DB);

  if (argv.includes('--check')) {
    if (!fs.existsSync(out)) {
      console.error(`✗ 没有词库导出：${out}`);
      process.exitCode = 1;
      return;
    }
    const wiki = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log(`✓ ${out}`);
    console.log(`  ${summarize(wiki)}`);
    return;
  }

  const { rows, builtAt } = await readDb(dbPath);
  const wiki = rowsToWiki(rows, { builtAt, source: path.basename(dbPath) });
  if (!wiki.count) throw new Error('导出 0 条 —— 表结构变了？检查 memes 表的 title/usage 列');
  writeAtomic(out, JSON.stringify(wiki));
  console.log(`✓ 写入 ${out}`);
  console.log(`  ${summarize(wiki)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`✗ ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
