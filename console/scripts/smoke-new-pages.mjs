// 冒烟：新增两个页面能否加载、有没有运行时异常。
// 只做「能不能打开 + 有没有报错」，不做视觉校验。
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

const results = [];
let failed = 0;

for (const [hash, expectText] of [
  ['/health', '运行体检'],
  ['/settings/expressions', '表达库'],
]) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // 401 是本机旧进程没鉴权导致的，与页面本身无关
      if (!/401|Failed to load resource|Unauthorized/i.test(text)) errors.push(text);
    }
  });

  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  const title = await page.$eval('h1', (el) => el.textContent?.trim() ?? '').catch(() => '');
  const h2s = await page.$$eval('h2', (els) => els.map((e) => e.textContent?.trim() ?? ''));

  const ok = title === expectText && h2s.length > 0 && errors.length === 0;
  if (!ok) failed += 1;
  results.push(
    `${ok ? '✓' : '✗'} ${hash} 标题="${title}" 卡片=[${h2s.join(' | ')}]` +
      (errors.length ? `\n    错误: ${errors.slice(0, 3).join(' / ')}` : ''),
  );
  await page.close();
}

// 侧边栏：新入口有没有出现在导航里
{
  const page = await browser.newPage();
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  const nav = await page.$$eval('nav a', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  const hasHealth = nav.some((t) => t === '运行体检');
  const hasExpr = nav.some((t) => t === '表达库');
  const ok = hasHealth && hasExpr;
  if (!ok) failed += 1;
  results.push(`${ok ? '✓' : '✗'} 导航含新入口：运行体检=${hasHealth} 表达库=${hasExpr}`);
  await page.close();
}

await browser.close();
console.log(results.join('\n'));
console.log(`\n— 冒烟汇总：${results.length - failed}/${results.length} 通过 —`);
process.exit(failed ? 1 : 0);
