import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.QQAGENT_BASE || 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
const errors = [];
const failed = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('response', (response) => {
  if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
});

async function open(hash) {
  await page.goto(`${BASE}/console/?r=${Date.now()}#${hash}`, {
    waitUntil: 'networkidle0',
    timeout: 30000,
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
}

const pages = [
  ['/settings/persona', '人设', '角色设定'],
  ['/settings/allowlist', '聊天白名单', '群聊白名单'],
  ['/settings/chat', '聊天设置', '运行节奏'],
  ['/settings/voice', '语音音色', 'RVC 音色转换'],
  ['/settings/desktop', '桌面端', '启动与关闭'],
  ['/settings/onebot', 'OneBot', '连接配置'],
];

for (const [route, title, marker] of pages) {
  await open(route);
  const text = await page.evaluate(() => document.body.innerText);
  check(
    `${title}页可打开`,
    text.includes(title) && text.includes(marker) && !text.includes('加载失败'),
    text.slice(0, 120),
  );
}

// 白名单隐私：默认 DOM 不渲染真实群名/群号，显式确认后才出现
// ⚠️ 开了访问令牌之后 /api/* 必须带 x-console-token，不然这里只会拿到「未授权」→
//    拿不到样本群 → 后面的断言直接 TypeError 崩掉（看起来像"白名单泄漏"）。
const TOKEN =
  process.env.QQAGENT_TOKEN ||
  (() => {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(ROOT, '..', 'data', 'config.json'), 'utf8'))
        ?.server?.token || '';
    } catch {
      return '';
    }
  })();
const realGroups = await fetch(`${BASE}/api/onebot/groups`, {
  headers: TOKEN ? { 'x-console-token': TOKEN } : {},
})
  .then((response) => response.json())
  .then((data) => data.groups || [])
  .catch(() => []);
const sampleGroup = realGroups[0];
await open('/settings/allowlist');
await new Promise((resolve) => setTimeout(resolve, 1200));
const hiddenText = await page.evaluate(() => document.body.innerText);
check(
  '白名单默认隐藏真实群名与群号',
  Boolean(sampleGroup) &&
    !hiddenText.includes(sampleGroup.name) &&
    !hiddenText.includes(String(sampleGroup.id)),
  sampleGroup ? `${sampleGroup.name}` : 'no sample group',
);
let revealClicked = false;
for (const button of await page.$$('button')) {
  const label = await button.evaluate((el) => el.textContent || '');
  if (label.includes('显示真实信息')) {
    await button.click();
    revealClicked = true;
    break;
  }
}
await new Promise((resolve) => setTimeout(resolve, 300));
const privacyDialog = await page.evaluate(
  () => document.querySelector('[role="dialog"]')?.textContent ?? '',
);
check('显示真实信息需要二次确认', revealClicked && privacyDialog.includes('屏幕共享'));
for (const button of await page.$$('[role="dialog"] button')) {
  const label = await button.evaluate((el) => el.textContent || '');
  if (label.includes('显示真实信息')) {
    await button.click();
    break;
  }
}
await new Promise((resolve) => setTimeout(resolve, 400));
const revealedText = await page.evaluate(() => document.body.innerText);
check(
  '确认后才渲染真实群名与群号',
  Boolean(sampleGroup) &&
    revealedText.includes(sampleGroup.name) &&
    revealedText.includes(String(sampleGroup.id)),
  sampleGroup ? '' : 'no sample group（接口没返回群，跳过判据）',
);
for (const button of await page.$$('button')) {
  const label = await button.evaluate((el) => el.textContent || '');
  if (label.includes('立即隐藏')) {
    await button.click();
    break;
  }
}
await new Promise((resolve) => setTimeout(resolve, 300));
const hiddenAgainText = await page.evaluate(() => document.body.innerText);
check(
  '立即隐藏后真实信息从 DOM 移除',
  !hiddenAgainText.includes(sampleGroup.name) &&
    !hiddenAgainText.includes(String(sampleGroup.id)),
);

// 安全测试：未输入新密钥时，用服务端已保存密钥测通
await open('/settings/model');
await page.waitForSelector('#provider-select', { timeout: 15000 });
let tested = false;
const buttons = await page.$$('button');
for (const button of buttons) {
  const label = await button.evaluate((el) => el.textContent || '');
  if (label.includes('测试连通性')) {
    await button.click();
    tested = true;
    break;
  }
}
check('模型页存在「测试连通性」按钮', tested);
await page
  .waitForFunction(
    () => document.body.innerText.includes('使用已保存密钥') || document.body.innerText.includes('连接成功'),
    { timeout: 20000 },
  )
  .catch(() => {});
const afterTest = await page.evaluate(() => document.body.innerText);
check('使用已保存密钥测试成功', afterTest.includes('使用已保存密钥') || afterTest.includes('连接成功'));
const html = await page.content();
check('密钥未进入 DOM', !/sk-[A-Za-z0-9_-]{20,}/.test(html));

// 存档写操作对话框：打开后取消，绝不真实发送
await open('/archive');
await page.waitForSelector('text/消息存档', { timeout: 15000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 800));
const archiveText = await page.evaluate(() => document.body.innerText);
check(
  '存档页提供写操作入口',
  archiveText.includes('唤醒一次') &&
    archiveText.includes('标记已读') &&
    archiveText.includes('测试发送'),
);
let dialogOpened = false;
for (const button of await page.$$('button')) {
  const label = await button.evaluate((el) => el.textContent || '');
  if (label.includes('测试发送')) {
    await button.click();
    dialogOpened = true;
    break;
  }
}
await new Promise((resolve) => setTimeout(resolve, 350));
const dialogText = await page.evaluate(
  () => document.querySelector('[role="dialog"]')?.textContent ?? '',
);
check('测试发送有确认对话框', dialogOpened && dialogText.includes('真实'));
const cancel = await page.$$('[role="dialog"] button');
for (const button of cancel) {
  const label = await button.evaluate((el) => el.textContent || '');
  if (label.includes('取消')) {
    await button.click();
    break;
  }
}

await open('/snowluma');
await page.waitForSelector('[role="log"]', { timeout: 15000 });
await new Promise((resolve) => setTimeout(resolve, 700));
const snowText = await page.evaluate(() => document.body.innerText);
check(
  'SnowLuma 登录面板可用',
  snowText.includes('账号密码登录') && (snowText.includes('扫码登录') || snowText.includes('已登录')),
);

check('新页面无前端异常', errors.length === 0, errors.join(' | '));
check('新页面无 404', failed.length === 0, failed.join(' | '));

await browser.close();
const failedChecks = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failedChecks.length}/${checks.length} 项通过`);
fs.writeFileSync(
  path.join(ROOT, 'screenshots', 'verify-settings-result.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, checks }, null, 2),
);
if (failedChecks.length) process.exitCode = 1;
