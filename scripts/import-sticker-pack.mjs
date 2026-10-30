// 表情包整包导入：把一个文件夹的表情包图片（jpg/png/webp/gif）变成可发的表情条目。
//
// 为什么要有这个脚本（不是手工往 stickers.json 里加）：
//   表情要发得准，靠的不是图片本身，而是"这张图表达什么态度、什么时候该发"。
//   589 张图靠人写备注是写不完的，所以这里让视觉模型逐张读画面+图上文字，
//   归到固定场景词表（src/stickers.js 的 STICKER_SCENES），最终产出的不只是备注，
//   而是一份可以按场景检索的索引 —— 提示词里只放场景统计，真发时按场景查询取 id。
//
// 用法：
//   node scripts/import-sticker-pack.mjs --dir "D:/some/表情包"           全流程
//   node scripts/import-sticker-pack.mjs --dir ... --dry-run              只清点不写盘
//   node scripts/import-sticker-pack.mjs --dir ... --no-annotate          只入库不识别（备注留空）
//   node scripts/import-sticker-pack.mjs --dir ... --force                应用在跑也强制写盘
//   node scripts/import-sticker-pack.mjs --dir ... --prefix dfy_          条目 id 前缀（默认 dfy_）
//
// 断点续跑：识别结果逐行追加到 --cache（默认 work/sticker-pack-cache.jsonl），
// 重跑时已识别的 md5 直接复用，不会重复烧 token。
//
// 注意：写盘前请先退出 QQ Agent（或加 --force），否则运行中的进程会用内存旧数据回写覆盖。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, getConfig } from '../src/config.js';
import { STICKER_SCENES, STICKER_FILES_DIR, loadStickerStore, saveStickerStore, stickerLocalCopy } from '../src/stickers.js';
import { resolveFfmpeg } from '../src/media-tools.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
const MAX_SEND_BYTES = 4 * 1024 * 1024; // sender.js 只肯 base64 化 ≤4MB 的本地副本
const MAX_SIDE = 600;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
// 角色三视图/设定图这类不是"反应图"，当表情发出去只会让群友莫名其妙。
// 照样入库（数据留着），但直接停用，不进提示词也不进搜索结果。
const REFSHEET_RE = /三视图|设定图|角色卡|立绘|参考图|线稿/;

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DIR = flagValue('--dir', '');
const PREFIX = flagValue('--prefix', 'dfy_');
const CACHE = flagValue('--cache', path.join(DATA_DIR, '..', 'work', 'sticker-pack-cache.jsonl'));
const LIMIT = Number(flagValue('--limit', '0')) || 0;
const CONCURRENCY = Math.max(1, Math.min(10, Number(flagValue('--concurrency', '6')) || 6));
const DRY = hasFlag('--dry-run');
const FORCE = hasFlag('--force');
const ANNOTATE = !hasFlag('--no-annotate');
const nowIso = () => new Date().toISOString();

if (!DIR || !fs.existsSync(DIR)) {
  console.error('用法：node scripts/import-sticker-pack.mjs --dir "<表情包目录>"');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (IMAGE_EXT.test(ent.name)) out.push(p);
  }
  return out;
}

function md5Of(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

/** 已有的本地副本（任意扩展名）。 */
function existingCopy(md5) {
  for (const ext of ['.jpg', '.png', '.gif', '.webp']) {
    const p = path.join(STICKER_FILES_DIR, md5 + ext);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
  }
  return '';
}

function ffmpeg(args) {
  const bin = resolveFfmpeg();
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${String(r.stderr || '').slice(-200)}`);
}

/** 探源图尺寸/是否带透明通道。不探的话只能写死 600x600，小图会被放大（体积反而翻倍）。 */
function probe(file) {
  const bin = resolveFfmpeg().replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/^ffmpeg/i, 'ffprobe'));
  const r = spawnSync(bin, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const line = String(r.stdout || '').trim().split('\n')[0] || '';
  const [w, h, pixFmt] = line.split(',');
  return {
    w: Number(w) || 0,
    h: Number(h) || 0,
    alpha: /a/i.test(String(pixFmt || '')) || /\.(png|webp)$/i.test(file)
  };
}

/** 等比缩到 MAX_SIDE 内，且绝不放大。 */
function fitBox(w, h) {
  if (!w || !h) return { w: MAX_SIDE, h: MAX_SIDE };
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  return { w: Math.max(2, Math.round(w * scale)), h: Math.max(2, Math.round(h * scale)) };
}

/**
 * 感知哈希（16x16 dhash，256 位）：解决"同一张图不同编码/不同体积"的重复。
 * 实测同一张图重压缩后距离 ~17，不同图 ≥110，所以 40 的阈值既抓得住重复又不会误并。
 * 没有它，旧库里 364.webp 和新包里同一张 jpg 会各存一份，发出来一模一样。
 */
function dhash(file) {
  try {
    const r = spawnSync(resolveFfmpeg(), ['-v', 'error', '-i', file,
      '-vf', 'scale=17:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
    const buf = r.stdout;
    if (!buf || buf.length < 272) return '';
    let bits = '';
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) bits += buf[y * 17 + x] < buf[y * 17 + x + 1] ? '1' : '0';
    }
    return bits;
  } catch {
    return '';
  }
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

const DUP_DISTANCE = 40;

/**
 * 规范化成可发的本地副本：静态图缩到 600px 内压成 JPEG（透明底铺白），动图压成 GIF
 * （压到 4MB 以内仍不行就退化成静帧）。输出文件名 = 内容 md5，天然去重、可被 stickers.json 引用。
 * 硬约束：结果必须 ≤4MB —— sender.js 只肯 base64 化这个大小以内的本地副本。
 */
function normalize(src, md5) {
  const hit = existingCopy(md5);
  if (hit && fs.statSync(hit).size <= MAX_SEND_BYTES) return hit;
  fs.mkdirSync(STICKER_FILES_DIR, { recursive: true });
  const { w, h, alpha } = probe(src);
  const box = fitBox(w, h);
  const isGif = /\.gif$/i.test(src);

  const toStaticJpg = () => {
    const dst = path.join(STICKER_FILES_DIR, md5 + '.jpg');
    const scale = `scale=${box.w}:${box.h}:flags=lanczos`;
    // 透明底必须铺白：直接 format=rgb24 会把透明区变成黑边
    const vf = alpha
      ? `${scale},format=rgba[fg];color=white:s=${box.w}x${box.h}[bg];[bg][fg]overlay=0:0:format=auto,format=rgb24`
      : `${scale},format=rgb24`;
    ffmpeg(['-y', '-v', 'error', '-i', src, alpha ? '-filter_complex' : '-vf', vf,
      '-frames:v', '1', '-q:v', '3', dst]);
    return dst;
  };

  if (isGif) {
    const dst = path.join(STICKER_FILES_DIR, md5 + '.gif');
    if (fs.statSync(src).size <= MAX_SEND_BYTES && !hit) {
      fs.copyFileSync(src, dst);
      return dst;
    }
    try {
      // 调色板量化 + 限帧。split 有两个输出，必须 -filter_complex，写成 -vf 会直接失败。
      ffmpeg(['-y', '-v', 'error', '-i', src,
        '-filter_complex',
        `[0:v]fps=12,scale=${box.w}:${box.h}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5`,
        '-loop', '0', dst]);
    } catch { /* 失败就走静帧 */ }
    if (fs.existsSync(dst) && fs.statSync(dst).size <= MAX_SEND_BYTES) return dst;
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    return toStaticJpg();
  }
  return toStaticJpg();
}

function loadCache() {
  const map = new Map();
  if (!fs.existsSync(CACHE)) return map;
  for (const line of fs.readFileSync(CACHE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.md5) map.set(row.md5, row);
    } catch { /* 半行（进程被杀）直接忽略 */ }
  }
  return map;
}

function captionPrompt() {
  return `这是一张中文网络聊天表情包。请仔细看画面和上面的所有文字（包括小字、对话框），输出严格 JSON（不要 markdown 代码块，不要多余解释）：

{"text":"图上文字，照抄最关键的主句；多段用｜分隔；没有文字填空串","desc":"画面一句话描述，说清是谁在做什么表情/动作，不超过28字","emotion":"主要情绪，从[开心,难过,生气,无语,惊讶,害羞,得意,害怕,嫌弃,调皮,平静]里选1个","scene":["发送场景"],"usage":"什么情况下发这张最合适，不超过22字"}

scene 从下面固定词表里选 1~3 个最贴切的（只能选这些词，不要自创）：
${STICKER_SCENES.join('、')}

判断要点：
- 这是聊天里用来"替自己说话"的表情，重点是它传达的态度，不是单纯描写画面。
- 有文字的，文字意思优先于画面。反讽/阴阳怪气的按真实语气归类。
- 区分几个容易混的：
  · 嘲讽＝调戏、贬损、阴阳（"杂鱼♡""就这""急了"）。
  · 怼人＝直接凶、骂、赶人走。
  · 无语＝翻白眼、沉默、看傻子、不想说话。
  · 摆烂＝累、躺平、放弃、不想努力。
- 多格漫画/长图就概括整张在讲什么梗，别只描述第一格。
- 认不出角色就写"二次元女孩/猫/熊猫"等，不要编造名字。
- 如果图里明显是某家 AI 模型（DeepSeek/GPT/Gemini/Claude/Qwen 等）或程序员梗，scene 里加"AI话题"。`;
}

function pickJson(text) {
  const s = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没返回 JSON');
  return JSON.parse(s.slice(a, b + 1));
}

async function annotate(file, attempt = 1) {
  const cfg = getConfig().vision?.qwen || {};
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) throw new Error('未配置识图模型（设置 → 模型 API → 识图）');
  const buf = fs.readFileSync(file);
  const body = {
    model: String(cfg.model).trim(),
    temperature: 0.2,
    max_tokens: 500,
    stream: false,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
      { type: 'text', text: captionPrompt() }
    ] }]
  };
  // 硅基流动/部分厂商吃这个开关，能把推理 token 压到 0（识别任务不需要思考）
  body.thinking = { type: 'disabled' };
  const res = await fetch(`${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(20000, Number(cfg.timeoutMs) || 90000))
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`识图 HTTP ${res.status}：${JSON.stringify(json).slice(0, 160)}`);
  const raw = json?.choices?.[0]?.message?.content ?? '';
  try {
    const parsed = pickJson(raw);
    return {
      text: String(parsed.text ?? '').slice(0, 200),
      desc: String(parsed.desc ?? '').slice(0, 60),
      emotion: String(parsed.emotion ?? '').slice(0, 10),
      scene: (Array.isArray(parsed.scene) ? parsed.scene : []).map(String).filter((s) => STICKER_SCENES.includes(s)).slice(0, 3),
      usage: String(parsed.usage ?? '').slice(0, 60)
    };
  } catch (error) {
    if (attempt >= 3) throw new Error(`识别结果无法解析：${String(raw).slice(0, 120)}`);
    return annotate(file, attempt + 1);
  }
}

async function appRunning() {
  const port = Number(getConfig().server?.port) || 3210;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function main() {
  const files = walk(DIR);
  console.log(`扫描到 ${files.length} 个图片文件：${DIR}`);

  // 去重：同内容只留一份（文件名不同、压缩包内重复很常见）
  const byMd5 = new Map();
  for (const f of files) {
    try {
      const md5 = md5Of(f);
      const size = fs.statSync(f).size;
      const cur = byMd5.get(md5);
      if (!cur || size > cur.size) byMd5.set(md5, { file: f, size, md5 });
    } catch (error) {
      console.warn(`  跳过（读不了）：${path.basename(f)} ${error.message}`);
    }
  }
  let uniq = [...byMd5.values()];
  console.log(`去重后 ${uniq.length} 张`);

  const store = loadStickerStore(STICKER_FILE);
  const kept = store.filter((e) => !String(e.id || '').startsWith(PREFIX));
  const keptMd5 = new Set(store.filter((e) => !String(e.id || '').startsWith(PREFIX)).map((e) => String(e.md5 || '').toUpperCase()).filter(Boolean));
  const fresh = uniq.filter((u) => !keptMd5.has(u.md5));
  console.log(`库里已有同图跳过 ${uniq.length - fresh.length} 张，待入库 ${fresh.length} 张`);
  if (LIMIT) {
    fresh.length = Math.min(fresh.length, LIMIT);
    console.log(`--limit 生效，本次只处理 ${fresh.length} 张`);
  }
  if (DRY) {
    for (const u of fresh.slice(0, 10)) console.log(`  ${u.md5}  ${path.basename(u.file)}`);
    console.log('--dry-run：不写盘');
    return;
  }
  if (!fresh.length) {
    console.log('没有新图需要入库。');
    return;
  }
  if (await appRunning()) {
    if (!FORCE) {
      console.error('\n检测到 QQ Agent 正在运行：请先退出，再加 --force 强制写盘。');
      console.error('原因：运行中的进程会在同步表情时用内存旧数据回写 stickers.json。');
      process.exit(3);
    }
    console.warn('⚠️  QQ Agent 正在运行，--force 继续；结束后请重启应用。\n');
  }

  const cache = loadCache();
  console.log(`识别缓存命中 ${cache.size} 条（${CACHE}）`);

  // 感知去重：先给库里现有条目建哈希表（同图不同编码靠 md5 是抓不到的）
  const knownHashes = [];
  for (const e of kept) {
    const f = stickerLocalCopy(e);
    if (!f) continue;
    const h = dhash(f);
    if (h) knownHashes.push({ h, id: e.id });
  }
  console.log(`已有条目去重指纹 ${knownHashes.length} 个`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${STICKER_FILE}.bak-${stamp}`;
  if (fs.existsSync(STICKER_FILE)) fs.copyFileSync(STICKER_FILE, backup);
  console.log(`已备份表情库：${path.basename(backup)}`);

  const added = [];
  const failed = [];
  const dupes = [];
  let idx = 0;
  const worker = async () => {
    while (idx < fresh.length) {
      const item = fresh[idx++];
      const label = path.basename(item.file);
      try {
        const localPath = normalize(item.file, item.md5);
        // 同图不同编码：归一化后再比一次指纹，命中就跳过（保留库里原有那条）
        const hash = dhash(localPath);
        const dup = hash ? knownHashes.find((k) => hamming(k.h, hash) <= DUP_DISTANCE) : null;
        if (dup) {
          dupes.push(`${label} ≈ ${dup.id}`);
          continue;
        }
        let cap = cache.get(item.md5);
        if (!cap && ANNOTATE) {
          cap = await annotate(localPath);
          fs.mkdirSync(path.dirname(CACHE), { recursive: true });
          fs.appendFileSync(CACHE, JSON.stringify({ md5: item.md5, file: label, ...cap }) + '\n', 'utf8');
          cache.set(item.md5, cap);
        }
        const scene = cap?.scene || [];
        const emotion = cap?.emotion || '';
        const tags = [...scene];
        if (emotion && !tags.includes(emotion)) tags.push(emotion);
        const noteParts = [];
        if (cap?.text) noteParts.push(`图上字：${cap.text}`);
        if (cap?.usage) noteParts.push(`用法：${cap.usage}`);
        const isRefsheet = REFSHEET_RE.test(String(cap?.desc || ''));
        added.push({
          id: PREFIX + item.md5.slice(0, 10).toLowerCase(),
          resId: PREFIX + item.md5.slice(0, 10).toLowerCase(),
          url: '',
          localPath,
          md5: item.md5,
          desc: (cap?.desc || '未识别表情').slice(0, 30),
          localNote: noteParts.join('｜').slice(0, 160),
          tags: tags.slice(0, 6),
          usage: (cap?.usage || '').slice(0, 60),
          disabled: isRefsheet,
          disabledReason: isRefsheet ? '设定图/三视图，不是聊天气氛表情' : '',
          source: 'ai',
          useCount: 0,
          lastUsedAt: 0,
          lastContext: '',
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
        const done = added.length + failed.length + dupes.length;
        if (done % 20 === 0) console.log(`  进度 ${done}/${fresh.length}`);
        if (hash) knownHashes.push({ h: hash, id: item.md5 });
      } catch (error) {
        failed.push(`${label}：${String(error?.message ?? error).slice(0, 120)}`);
        console.warn(`  [失败] ${label} -> ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fresh.length) }, worker));

  const merged = [...kept, ...added];
  saveStickerStore(merged, STICKER_FILE);
  const counts = new Map();
  for (const e of added) for (const t of e.tags) if (STICKER_SCENES.includes(t)) counts.set(t, (counts.get(t) || 0) + 1);
  const sceneLine = STICKER_SCENES.filter((s) => counts.get(s)).map((s) => `${s}${counts.get(s)}`).join(' ');

  console.log('\n──────── 汇总 ────────');
  console.log(`入库：${added.length} 张　重复跳过：${dupes.length} 张　失败：${failed.length} 张　表情库总计：${merged.length} 条`);
  console.log(`场景分布：${sceneLine || '（无）'}`);
  if (dupes.length) console.log(`重复样例：${dupes.slice(0, 5).join('；')}`);
  if (failed.length) {
    console.log('失败清单：');
    for (const line of failed.slice(0, 20)) console.log(`  - ${line}`);
  }
  console.log('\n完成。重启 QQ Agent 生效（提示词里的场景索引会按新库重新统计）。');
}

main().catch((error) => {
  console.error('导入失败：', error);
  process.exit(1);
});
