// 表情库索引画廊：把 stickers.json 里的条目做成一份可筛选的单页 HTML（缩略图内嵌 base64，
// 拷走也能看）。用途是人工核对"模型以为这张是什么意思"——表情发错，九成是备注错了。
//
// 用法：node scripts/sticker-gallery.mjs [--out <html 路径>] [--limit 0]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from '../src/config.js';
import { STICKER_SCENES, canonicalScenes, stickerLocalCopy, loadStickerStore } from '../src/stickers.js';
import { resolveFfmpeg } from '../src/media-tools.js';

const argv = process.argv.slice(2);
const flagValue = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OUT = flagValue('--out', path.join(process.cwd(), `表情包索引-${new Date().toISOString().slice(0, 10)}.html`));
const LIMIT = Number(flagValue('--limit', '0')) || 0;
const THUMB = 150;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-thumb-'));

function thumbOf(file) {
  const dst = path.join(tmp, `${path.basename(file)}.jpg`);
  const r = spawnSync(resolveFfmpeg(), ['-y', '-v', 'error', '-i', file,
    '-vf', `scale=${THUMB}:${THUMB}:force_original_aspect_ratio=decrease:flags=lanczos`,
    '-frames:v', '1', '-q:v', '6', dst], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(dst)) return '';
  return `data:image/jpeg;base64,${fs.readFileSync(dst).toString('base64')}`;
}

const store = loadStickerStore(path.join(DATA_DIR, 'stickers.json')).filter((e) => !e.disabled);
const items = [];
for (const e of store) {
  const file = stickerLocalCopy(e);
  if (!file && !/^https?:\/\//i.test(e.url || '')) continue; // 发不出去的条目不上画廊
  const img = file ? thumbOf(file) : '';
  items.push({
    id: e.id,
    desc: e.desc || '(无备注)',
    usage: e.usage || '',
    note: e.localNote || '',
    tags: [...new Set([...(e.tags || []), ...canonicalScenes(e.tags)])],
    useCount: e.useCount || 0,
    img,
    url: img ? '' : e.url
  });
  if (LIMIT && items.length >= LIMIT) break;
}

const counts = new Map();
for (const it of items) for (const t of canonicalScenes(it.tags)) if (STICKER_SCENES.includes(t)) counts.set(t, (counts.get(t) || 0) + 1);
const chips = STICKER_SCENES.filter((s) => counts.get(s))
  .map((s) => `<button class="chip" data-scene="${s}">${s}<b>${counts.get(s)}</b></button>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>表情包语义索引（${items.length} 张）</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--ink:#1b1f24;--dim:#6b7380;--accent:#1f6feb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:9;background:rgba(246,247,249,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px 10px}
h1{margin:0 0 4px;font-size:17px}
.meta{color:var(--dim);font-size:12.5px}
.bar{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
input{flex:1 1 240px;min-width:200px;padding:8px 11px;border:1px solid var(--line);border-radius:9px;background:#fff;font-size:13.5px;outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(31,111,235,.12)}
.chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:5px 11px;font-size:12.5px;color:var(--ink);cursor:pointer}
.chip b{color:var(--dim);font-weight:500;margin-left:5px;font-size:11.5px}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.chip.on b{color:#dbe7ff}
main{padding:16px 20px 60px;display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.pic{background:#fff;height:172px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--line)}
.pic img{max-width:100%;max-height:100%;object-fit:contain}
.body{padding:9px 10px 11px;display:flex;flex-direction:column;gap:5px}
.desc{font-weight:600;font-size:13px;line-height:1.35}
.usage{color:var(--dim);font-size:12px;line-height:1.4}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.t{font-size:11px;background:#eef2f8;color:#3c4a5d;border-radius:6px;padding:1px 6px}
.id{font:11px/1.4 ui-monospace,Consolas,monospace;color:#98a1ad;margin-top:2px;word-break:break-all}
footer{padding:0 20px 30px;color:var(--dim);font-size:12px}
.hidden{display:none}
</style></head><body>
<header>
  <h1>表情包语义索引 · 共 ${items.length} 张</h1>
  <div class="meta">按场景标注。点场景筛选，或搜图上文字/描述/用法。这张表就是模型选图的依据 —— 备注错，表情就会发错。</div>
  <div class="bar"><input id="q" placeholder="搜：嘲讽 / 杂鱼 / 涨价 / 躺平 …"/></div>
  <div class="bar" id="chips"><button class="chip on" data-scene="">全部<b>${items.length}</b></button>${chips}</div>
</header>
<main id="grid"></main>
<footer>由 scripts/sticker-gallery.mjs 生成。改备注用控制台或 sticker_note 工具，重新生成即可看到效果。</footer>
<script>
const DATA = ${JSON.stringify(items)};
const grid = document.getElementById('grid');
let scene = '', kw = '';
function render(){
  const q = kw.trim().toLowerCase();
  const rows = DATA.filter(d => (!scene || d.tags.includes(scene)) &&
    (!q || [d.desc,d.usage,d.note,d.id,...d.tags].join(' ').toLowerCase().includes(q)));
  grid.innerHTML = rows.map(d => \`<div class="card">
    <div class="pic">\${d.img ? \`<img loading="lazy" src="\${d.img}" alt="">\` : \`<span style="color:#98a1ad;font-size:12px">远程图</span>\`}</div>
    <div class="body">
      <div class="desc">\${esc(d.desc)}</div>
      \${d.usage ? \`<div class="usage">\${esc(d.usage)}</div>\` : ''}
      <div class="tags">\${d.tags.map(t => \`<span class="t">\${esc(t)}</span>\`).join('')}</div>
      <div class="id">\${esc(d.id)}</div>
    </div></div>\`).join('') || '<div style="grid-column:1/-1;color:#6b7380">没有匹配的表情</div>';
  document.querySelector('h1').textContent = \`表情包语义索引 · 显示 \${rows.length} / \${DATA.length} 张\`;
}
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
document.getElementById('q').addEventListener('input', e => { kw = e.target.value; render(); });
document.getElementById('chips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  scene = b.dataset.scene;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === b));
  render();
});
render();
</script></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`生成 ${OUT}（${items.length} 张，${(html.length / 1048576).toFixed(1)}MB）`);
