import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.env.QQAGENT_BASE || 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const consoleErrors = [];
const failedRequests = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
});

await page.goto(`${BASE}/console/`, { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForSelector('[data-session-item]', { timeout: 20000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 800));

const html = await page.content();
const bodyText = await page.evaluate(() => document.body.innerText);
const pathname = await page.evaluate(() => window.location.pathname);
const sessions = await page.$$eval('[data-session-item]', (items) => items.length);

check('Electron 控制台加载 /console/', pathname === '/console/');
check('默认进入实时模式', bodyText.includes('本地服务') && !bodyText.includes('演示数据'));
check('读取真实会话列表', sessions > 0, String(sessions));
check('控制台无未处理的前端异常', consoleErrors.length === 0, consoleErrors.join(' | '));
check('静态资源无 404', failedRequests.length === 0, failedRequests.join(' | '));
check(
  '实时配置不把明文密钥渲染进 DOM',
  !/sk-[A-Za-z0-9_-]{20,}/.test(html),
  (html.match(/sk-[A-Za-z0-9_-]{20,}/) ?? [])[0] ?? '',
);

await page.screenshot({ path: path.join(OUT, 'final-electron-live.png') });

await page.goto(`${BASE}/legacy/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#tabs', { timeout: 15000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 800));
const legacyText = await page.evaluate(() => document.body.innerText);
const legacyAssets = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('/legacy/')),
);
check('旧版兼容页可加载', legacyText.includes('会话') && legacyText.includes('新版控制台'));
check(
  '旧版 CSS/JS 走 /legacy/ 路由',
  legacyAssets.some((url) => url.includes('/legacy/style.css')) &&
    legacyAssets.some((url) => url.includes('/legacy/app.js')),
  legacyAssets.join(' | '),
);

await browser.close();
const failed = checks.filter((item) => !item.ok);
fs.writeFileSync(
  path.join(OUT, 'verify-electron-result.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, checks }, null, 2),
);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) process.exitCode = 1;
