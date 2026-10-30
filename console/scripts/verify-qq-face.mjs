/**
 * 校验：存档页把 QQ 内置表情渲染成真表情图（或名字标签），而不是「[表情182]」这种裸 id。
 *
 * 用法：先起后端（默认 http://127.0.0.1:3210），再
 *   node scripts/verify-qq-face.mjs
 * 需要 Chrome（CHROME_PATH 可覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`✓ ${name}`);
  else {
    failed += 1;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=2', '--lang=zh-CN'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
await page.goto(`${BASE}/console/#/archive`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForSelector('[aria-label="存档会话列表"] li button', { timeout: 30000 });

const items = await page.$$('[aria-label="存档会话列表"] li button');
check('存档会话列表已加载', items.length > 0, `共 ${items.length} 个会话`);

let hit = null;
for (const item of items) {
  await item.click();
  await new Promise((r) => setTimeout(r, 1000));
  const stat = await page.evaluate(() => {
    const scope = document.querySelector('[aria-label="存档详情"]');
    if (!scope) return { images: 0, raw: 0, names: 0 };
    const images = scope.querySelectorAll('img[src*="qzone/em/"]').length;
    const text = scope.innerText || '';
    return {
      images,
      // 裸 id 就是没修好的样子
      raw: (text.match(/\[表情\d+\]/g) || []).length,
      names: (text.match(/表情[:：][^\]]+/g) || []).length,
    };
  });
  if (stat.images > 0 || stat.names > 0) {
    hit = stat;
    break;
  }
}

check('有会话渲染出了 QQ 表情图', Boolean(hit && hit.images > 0), hit ? `图片 ${hit.images} 张` : '没找到');
check('正文里没有裸数字 id（[表情182]）', !hit || hit.raw === 0, hit ? `残留 ${hit.raw} 处` : '');

if (hit) {
  await page.evaluate(() => {
    document
      .querySelector('[aria-label="存档详情"] img[src*="qzone/em/"]')
      ?.scrollIntoView({ block: 'center' });
  });
  await new Promise((r) => setTimeout(r, 600));
  const clip = await page.evaluate(() => {
    const img = document.querySelector('[aria-label="存档详情"] img[src*="qzone/em/"]');
    if (!img) return null;
    const bubble = img.closest('div[class*="rounded-lg"]') || img.parentElement;
    const r = bubble.getBoundingClientRect();
    return {
      x: Math.max(0, r.x - 8),
      y: Math.max(0, r.y - 8),
      width: Math.min(1200, r.width + 16),
      height: Math.min(860, r.height + 16),
    };
  });
  if (clip) await page.screenshot({ path: path.join(OUT, 'qq-face-detail.png'), clip });
}

await page.screenshot({ path: path.join(OUT, 'qq-face-archive.png') });
console.log(`截图：${path.join(OUT, 'qq-face-archive.png')}`);
await browser.close();

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nQQ 表情渲染校验通过');
