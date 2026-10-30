// 旧版设置页（/legacy/）的冒烟检查：模型 API 与人设两块必须能渲染、能切、无 JS 异常。
// 旧版是 Electron 的回退通道，新版控制台出问题时全靠它，别让它静默坏掉。
// 用法：node test/test-legacy-ui.mjs
import puppeteer from 'puppeteer-core';

const BASE = process.env.QQAGENT_BASE || 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

// 旧版页面用 SSE 长连接，networkidle0 永远不会触发，只能等 DOM
await page.goto(`${BASE}/legacy/?r=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#tabs .tab', { timeout: 20000 });
await sleep(1500);

for (const tab of await page.$$('#tabs .tab')) {
  const label = await tab.evaluate((el) => el.textContent || '');
  if (label.includes('设置')) {
    await tab.click();
    break;
  }
}
await page.waitForSelector('.settings-menu-item', { timeout: 15000 });
await sleep(600);

const menuLabels = await page.$$eval('.settings-menu-item', (els) =>
  els.map((el) => (el.textContent || '').trim()),
);
check(
  '旧版设置菜单包含模型 API 与人设',
  menuLabels.some((l) => l.includes('模型 API')) && menuLabels.some((l) => l.includes('人设')),
  menuLabels.join('/'),
);

// 模型 API：服务商/模型目录与密钥输入都在
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.settings-menu-item')].find((el) =>
    (el.textContent || '').includes('模型 API'),
  );
  item?.click();
});
await sleep(900);
const apiDom = await page.evaluate(() => ({
  pick: Boolean(document.querySelector('#cfg-model-pick')),
  key: Boolean(document.querySelector('#cfg-apikey')),
  presets: document.querySelectorAll('.preset-chip').length,
  keyValue: document.querySelector('#cfg-apikey')?.value ?? '',
}));
check('模型 API 区块渲染完整', apiDom.pick && apiDom.key && apiDom.presets > 0, JSON.stringify(apiDom));
check(
  '密钥输入框只显示掩码',
  !apiDom.keyValue || /[•*?]{2,}/.test(apiDom.keyValue),
  apiDom.keyValue.slice(0, 20),
);

// 人设：角色设定有内容，人设选择器存在
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.settings-menu-item')].find((el) =>
    (el.textContent || '').includes('人设'),
  );
  item?.click();
});
await sleep(900);
const personaDom = await page.evaluate(() => ({
  roleLen: (document.querySelector('#cfg-roletext')?.value ?? '').length,
  pick: document.querySelector('#cfg-persona-pick')?.value ?? '',
  save: Boolean(document.querySelector('#save-persona-btn')),
  backupBar: Boolean(document.querySelector('#persona-backup-bar')),
}));
check('人设区块渲染完整', personaDom.roleLen > 0 && personaDom.save && personaDom.backupBar, JSON.stringify(personaDom));

check('旧版页面无前端异常', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) process.exitCode = 1;
