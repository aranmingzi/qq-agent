// 手动重建歌单：node tools/build-playlist.mjs [--root <缓存目录>] [--json]
//
// 平时不需要手动跑：机器人收到第一条 #点歌 时会自动扫，之后每 30 分钟（可配）失效重扫。
// 这个脚本的用处是：换机器/换缓存目录后先跑一次看结果，或排查「为什么某首歌没进歌单」。

import path from 'node:path';
import { buildLibrary, formatLibraryPage, resolveRoots, playlistConfig } from '../src/playlist.js';

const argv = process.argv.slice(2);
const roots = [];
let asJson = false;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--root' && argv[i + 1]) { roots.push(path.resolve(argv[i + 1])); i += 1; }
  else if (argv[i] === '--json') asJson = true;
}

const cfg = playlistConfig();
const useRoots = roots.length ? roots : resolveRoots();
console.log(`[build] 缓存目录：${useRoots.length ? useRoots.join(' | ') : '(未找到)'}`);
console.log(`[build] 码率 ${cfg.bitrate} · 每页 ${cfg.pageSize} 首 · 自动重扫 ${cfg.autoRebuildMinutes} 分钟`);

if (!useRoots.length) {
  console.error('[build] 没有可扫描的目录。用 --root 指定，或在 data/config.json 的 playlist.roots 里填写。');
  process.exit(2);
}

const lib = await buildLibrary({ roots: useRoots, log: (m) => console.log(m) });

if (asJson) {
  console.log(JSON.stringify({ stats: lib.stats, roots: lib.roots, tracks: lib.tracks }, null, 2));
} else {
  console.log('');
  console.log(formatLibraryPage(1, { lib }));
  console.log('');
  const problems = lib.tracks.filter((t) => t.status !== 'ok');
  if (problems.length) {
    console.log(`[build] 有 ${problems.length} 条不可播（缓存没下完/文件被移走）：`);
    for (const t of problems) console.log(`  - ${t.rawTitle} → ${t.status}`);
  }
  const collections = lib.tracks.filter((t) => t.kind === 'collection');
  if (collections.length) {
    console.log(`[build] 合集/语音包（不进默认点歌列表，可按序号点播）：`);
    for (const t of collections) console.log(`  - #${t.no} ${t.title}（${Math.round(t.duration / 60)} 分钟）`);
  }
}
