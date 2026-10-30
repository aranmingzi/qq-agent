// 表情库整备：给缺图的表情补本地副本、给没备注的生成备注、把彻底失效的标记停用。
//
// 用法（建议先退出 QQ Agent，再执行；否则运行中的应用可能用内存旧数据覆盖回写）：
//   node scripts/prepare-stickers.mjs --check              只体检不写盘（退出码非 0 表示库不健康）
//   node scripts/prepare-stickers.mjs                      补副本 + 生成备注 + 停用死链
//   node scripts/prepare-stickers.mjs --concurrency 4       并发度（默认 3）
//   node scripts/prepare-stickers.mjs --no-annotate         只补副本、不调模型生成备注
//   node scripts/prepare-stickers.mjs --force               应用在运行时也强制写盘
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../src/config.js';
import { loadStickerStore, saveStickerStore, stickerLocalCopy, STICKER_FILES_DIR } from '../src/stickers.js';
import { safeFetchBinary } from '../src/safe-fetch.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
const MAX_BYTES = 4 * 1024 * 1024;
const ANNOTATE_PROMPT = '这是一张 QQ 聊天里用的表情包。请只输出一行 JSON：{"note":"情绪=…；场景=…","tags":["…","…"]}。'
  + 'note 用中文写清它表达的情绪和适合用的场合，不超过 24 字；tags 给 3~6 个短词（主体/情绪/场景）。不要输出任何解释文字。';

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHECK = hasFlag('--check');
const FORCE = hasFlag('--force');
const ANNOTATE = !hasFlag('--no-annotate');
const CONCURRENCY = Math.max(1, Math.min(6, Number(flagValue('--concurrency', '3')) || 3));
const nowIso = () => new Date().toISOString();

function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.toString('ascii', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  return '';
}

const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

function extFor(contentType, fileName, buffer) {
  const sniffed = sniffMime(buffer);
  if (sniffed && EXT_BY_MIME[sniffed]) return EXT_BY_MIME[sniffed];
  const byName = String(fileName || '').match(/\.(png|jpe?g|gif|webp|bmp)$/i);
  if (byName) return '.' + byName[1].toLowerCase().replace(/^jpeg$/, 'jpg');
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('bmp')) return '.bmp';
  return '.jpg';
}

/** 本地副本是否可用（文件存在且是真图片）；返回绝对路径或空串。 */
function usableCopy(entry) {
  const file = stickerLocalCopy(entry);
  if (!file) return '';
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length || !sniffMime(buf)) return '';
    return file;
  } catch {
    return '';
  }
}

function dataUrlOf(file) {
  const buf = fs.readFileSync(file);
  return `data:${sniffMime(buf) || 'image/jpeg'};base64,${buf.toString('base64')}`;
}

async function downloadToLocal(url, fileName = '') {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('不是 http(s) 地址');
  const { buffer, contentType } = await safeFetchBinary(target, MAX_BYTES);
  if (!buffer || !buffer.length) throw new Error('下载内容为空');
  const mime = sniffMime(buffer);
  if (!mime) throw new Error('下载内容不是图片');
  fs.mkdirSync(STICKER_FILES_DIR, { recursive: true });
  const md5 = crypto.createHash('md5').update(buffer).digest('hex').toUpperCase();
  const file = path.join(STICKER_FILES_DIR, `${md5}${extFor(contentType, fileName, buffer)}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  return file;
}

/** 用配置里的主模型看图生成备注（native 多模态）。 */
async function annotateOne(file) {
  const cfg = getConfig();
  const baseUrl = String(cfg.api?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !cfg.api?.model) throw new Error('未配置主模型');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.api.apiKey ? { authorization: `Bearer ${cfg.api.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: cfg.api.model,
      temperature: 0.2,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: ANNOTATE_PROMPT },
          { type: 'image_url', image_url: { url: dataUrlOf(file) } }
        ]
      }]
    }),
    signal: AbortSignal.timeout(Math.max(20000, Number(cfg.api?.timeoutMs) || 120000))
  });
  if (!res.ok) throw new Error(`模型 HTTP ${res.status}`);
  const json = await res.json().catch(() => ({}));
  const text = String(json?.choices?.[0]?.message?.content ?? '');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('模型没有返回 JSON');
  const parsed = JSON.parse(m[0]);
  const note = String(parsed.note ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const tags = Array.isArray(parsed.tags)
    ? [...new Set(parsed.tags.map((t) => String(t ?? '').trim()).filter(Boolean))].slice(0, 6)
    : [];
  if (!note) throw new Error('模型返回的 note 为空');
  return { note, tags };
}

async function appRunning() {
  const port = Number(getConfig().server?.port) || 3210;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function report(store) {
  const enabled = store.filter((e) => !e.disabled);
  const broken = enabled.filter((e) => e.localPath && !usableCopy(e));
  const noCopy = enabled.filter((e) => !usableCopy(e));
  const noNote = enabled.filter((e) => !String(e.localNote || '').trim());
  console.log(`总条目 ${store.length}（启用 ${enabled.length}、已停用 ${store.length - enabled.length}）`);
  console.log(`  无可用本地副本：${noCopy.length}`);
  console.log(`  副本文件损坏：${broken.length}`);
  console.log(`  启用但没有备注：${noNote.length}`);
  const list = (arr) => arr.slice(0, 12).map((e) => `${e.id}(${String(e.desc || e.localNote || '').slice(0, 12)})`).join('、');
  if (noCopy.length) console.log(`    例：${list(noCopy)}${noCopy.length > 12 ? ' …' : ''}`);
  if (noNote.length) console.log(`    例：${list(noNote)}${noNote.length > 12 ? ' …' : ''}`);
  return { noCopy, broken, noNote };
}

async function main() {
  if (!fs.existsSync(STICKER_FILE)) {
    console.error(`找不到表情库：${STICKER_FILE}`);
    process.exit(2);
  }
  const store = loadStickerStore(STICKER_FILE);
  console.log(`表情库：${STICKER_FILE}\n`);

  if (CHECK) {
    const { noCopy, broken, noNote } = report(store);
    const unhealthy = noCopy.length + broken.length + noNote.length;
    console.log(unhealthy ? `\n体检结果：${unhealthy} 项待整备（跑不带 --check 的命令即可修复）` : '\n体检结果：表情库健康 ✅');
    process.exit(unhealthy ? 1 : 0);
  }

  if (await appRunning()) {
    if (!FORCE) {
      console.error('检测到 QQ Agent 正在运行：请先从托盘退出它，再执行本脚本（或用 --force 强制写盘）。');
      console.error('原因：运行中的应用会在同步表情时用内存里的旧数据覆盖回写 stickers.json。');
      process.exit(3);
    }
    console.warn('⚠️  QQ Agent 正在运行，--force 强制继续；脚本结束后请重启应用。\n');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${STICKER_FILE}.bak-${stamp}`;
  fs.copyFileSync(STICKER_FILE, backup);
  console.log(`已备份：${path.basename(backup)}\n`);

  const targets = store.filter((e) => !e.disabled);
  const summary = { total: targets.length, cached: 0, annotated: 0, disabled: 0, skipped: 0, failed: [] };
  let index = 0;

  const worker = async () => {
    while (index < targets.length) {
      const entry = targets[index++];
      const label = `${entry.id}${entry.desc ? `（${entry.desc.slice(0, 12)}）` : ''}`;
      try {
        let file = usableCopy(entry);
        if (!file) {
          file = await downloadToLocal(entry.url);
          entry.localPath = file;
          const md5 = path.basename(file).replace(/\.[^.]+$/, '');
          if (!entry.md5) entry.md5 = md5;
          entry.updatedAt = nowIso();
          summary.cached += 1;
          console.log(`[副本] ${label} -> ${path.basename(file)}`);
        }
        if (ANNOTATE && !String(entry.localNote || '').trim()) {
          const { note, tags } = await annotateOne(file);
          entry.localNote = note;
          if (tags.length) entry.tags = tags;
          entry.updatedAt = nowIso();
          summary.annotated += 1;
          console.log(`[备注] ${label} -> ${note}${tags.length ? ` [${tags.join('/')}]` : ''}`);
        } else if (usableCopy(entry) && String(entry.localNote || '').trim()) {
          summary.skipped += 1;
        }
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 160);
        if (usableCopy(entry) === '') {
          entry.disabled = true;
          entry.disabledReason = `整备失败：${reason}`;
          entry.updatedAt = nowIso();
          summary.disabled += 1;
          summary.failed.push(`${entry.id}：${reason}`);
          console.log(`[停用] ${label} -> ${reason}`);
        } else {
          summary.failed.push(`${entry.id} 备注失败：${reason}`);
          console.log(`[跳过] ${label} 备注失败 -> ${reason}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, targets.length)) }, worker));

  saveStickerStore(store, STICKER_FILE);
  fs.mkdirSync(STICKER_FILES_DIR, { recursive: true });

  console.log('\n──────── 汇总 ────────');
  console.log(`检查条目：${summary.total}`);
  console.log(`新增本地副本：${summary.cached}`);
  console.log(`新增备注：${summary.annotated}`);
  console.log(`标记停用：${summary.disabled}`);
  console.log(`已完备跳过：${summary.skipped}`);
  if (summary.failed.length) {
    console.log(`失败清单（${summary.failed.length}）：`);
    for (const line of summary.failed) console.log(`  - ${line}`);
  }
  console.log('\n完成。请重启 QQ Agent 让整备结果生效。');
}

main().catch((error) => {
  console.error('整备失败：', error);
  process.exit(1);
});