import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.mkdirSync(OUT, { recursive: true });

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  else console.log(`✓ ${name}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crash-reporter',
    '--disable-dev-shm-usage',
    '--force-device-scale-factor=1',
  ],
});

await browser
  .defaultBrowserContext()
  .overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);

const page = await browser.newPage();
page.on('dialog', (dialog) => void dialog.accept());
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  // 无头 Chrome 的 OS 剪贴板权限不稳定；这里捕获浏览器 API 的写入内容，
  // 验证应用层复制逻辑与写入文本，真实剪贴板权限仍由浏览器决定。
  window.__copiedText = '';
  if (navigator.clipboard) {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text) => {
        window.__copiedText = String(text);
      },
    });
  }
});

async function goto(hash) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction(() => document.fonts.status === 'loaded', { timeout: 10000 }).catch(() => {});
}

async function hardGoto(hash) {
  await page.goto(`${BASE}/?r=${Date.now()}#${hash}`, {
    waitUntil: 'networkidle0',
    timeout: 30000,
  });
  await page.waitForFunction(() => document.fonts.status === 'loaded', { timeout: 10000 }).catch(() => {});
}

async function clickText(selector, text) {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const content = await handle.evaluate((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    if (content.includes(text)) {
      await handle.click();
      return true;
    }
  }
  return false;
}

async function setInput(selector, value) {
  await page.$eval(
    selector,
    (el, next) => {
      const input = el;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value,
  );
}

async function textOf(selector) {
  return page.$eval(selector, (el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '').catch(() => '');
}

async function cleanFocus() {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await new Promise((resolve) => setTimeout(resolve, 220));
}

async function setTheme(themeLabel) {
  await page.click('[aria-label^="切换主题"]');
  await page.waitForSelector('[role="menuitemradio"]', { timeout: 5000 });
  const ok = await clickText('[role="menuitemradio"]', themeLabel);
  if (!ok) throw new Error(`theme item not found: ${themeLabel}`);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

// ── 会话页 ────────────────────────────────────────────────────────────────
await goto('/sessions');
await page.waitForSelector('[data-testid="session-detail"]', { timeout: 15000 });
await new Promise((resolve) => setTimeout(resolve, 500));

const initialTitle = await textOf('[data-testid="session-title"]');
check('会话默认选中并展示详情', initialTitle.includes('20000001'), initialTitle);

const itemCount = await page.$$eval('[data-session-item]', (items) => items.length);
check('会话列表渲染 8 条演示数据', itemCount === 8, String(itemCount));

const statusLabel = await textOf('[data-testid="session-detail"]');
check('会话详情包含状态与情绪标签', statusLabel.includes('运行中') && statusLabel.includes('很兴奋'));

await page.screenshot({ path: path.join(OUT, 'final-sessions-light.png') });

// 切换会话
const secondItem = (await page.$$('[data-session-item]'))[1];
await secondItem.click();
await new Promise((resolve) => setTimeout(resolve, 400));
const secondTitle = await textOf('[data-testid="session-title"]');
check('点击列表项同步更新详情', secondTitle.includes('20000001') && (await textOf('[data-testid="session-detail"]')).includes('已发言'));

// 复制全部会话
const copyButtons = await page.$$('[data-testid="session-detail"] button');
for (const button of copyButtons) {
  const label = await button.evaluate((el) => el.getAttribute('aria-label') || el.textContent || '');
  if (label.includes('复制全部会话')) {
    await button.click();
    break;
  }
}
await new Promise((resolve) => setTimeout(resolve, 500));
const clipboard = await page.evaluate(() => window.__copiedText ?? '');
check('复制全部会话写入剪贴板 API', clipboard.includes('会话') && clipboard.includes('20000001'), `${String(clipboard).slice(0, 44)}…`);

// 重置情绪（从第二个会话切回第一个聊天的情绪）
const resetButtons = await page.$$('[data-testid="session-detail"] button');
for (const button of resetButtons) {
  const label = await button.evaluate((el) => el.getAttribute('aria-label') || el.textContent || '');
  if (label.includes('重置情绪')) {
    await button.click();
    break;
  }
}
await new Promise((resolve) => setTimeout(resolve, 350));
const dialogText = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '');
check('重置情绪先展示影响范围确认', dialogText.includes('只影响后续回复的语气') || dialogText.includes('不会删除会话'));
const confirmed = await clickText('[role="dialog"] button', '重置为平静');
check('确认重置按钮可点击', confirmed);
await new Promise((resolve) => setTimeout(resolve, 500));
const detailAfterReset = await textOf('[data-testid="session-detail"]');
check('重置后情绪显示为平静', detailAfterReset.includes('平静'));

// 深色主题
await setTheme('深色');
const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
check('主题切换为深色', isDark);
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('[data-testid="session-detail"]');
await new Promise((resolve) => setTimeout(resolve, 500));
await page.screenshot({ path: path.join(OUT, 'final-sessions-dark.png') });

// 浅色主题，进入模型 API
await setTheme('浅色');
await goto('/settings/model');
await page.waitForSelector('#provider-select', { timeout: 15000 });
await new Promise((resolve) => setTimeout(resolve, 500));
await cleanFocus();
await page.screenshot({ path: path.join(OUT, 'final-model-light.png') });

// 预设切换
await page.click('[data-testid="preset-complex"]');
await new Promise((resolve) => setTimeout(resolve, 350));
const temp = await page.$eval('#temperature', (el) => el.value);
const output = await page.$eval('#max-output', (el) => el.value);
const rounds = await page.$eval('#max-rounds', (el) => el.value);
check('选择「深度」同步温度', temp === '0.6', temp);
check('选择「深度」同步输出上限', output === '1600', output);
check('选择「深度」同步工具轮数', rounds === '8', rounds);
const presetText = await textOf('#model-parameters');
check('预设匹配状态更新', presetText.includes('当前参数与「深度」一致'));

// 手动修改后判定为自定义
await setInput('#temperature', '0.7');
await new Promise((resolve) => setTimeout(resolve, 300));
const customText = await textOf('#model-parameters');
check('手动修改后显示自定义参数', customText.includes('当前为自定义参数'));

// 空值校验
await setInput('#temperature', '');
await new Promise((resolve) => setTimeout(resolve, 200));
const saved = await clickText('button', '保存设置');
await new Promise((resolve) => setTimeout(resolve, 400));
const validationText = await textOf('body');
check('保存按钮触发校验', saved && validationText.includes('请输入温度'));
check('空值不会静默提交', !validationText.includes('已保存到本地演示状态'));

// 恢复有效值并保存
await setInput('#temperature', '0.7');
await new Promise((resolve) => setTimeout(resolve, 200));
await clickText('button', '保存设置');
await new Promise((resolve) => setTimeout(resolve, 700));
const savedToast = await textOf('body');
check('演示模式保存反馈明确标注本地状态', savedToast.includes('已保存到本地演示状态'));

// 密钥显隐：已保存密钥只显示掩码，替换后才可切换显隐
const storedMask = await page.$eval('#api-key', (el) => el.value).catch(() => '');
check('已保存密钥不以输入框明文展示', storedMask === '');
await clickText('button', '替换');
await new Promise((resolve) => setTimeout(resolve, 250));
const keyTypeBefore = await page.$eval('#api-key', (el) => el.type);
await page.click('[aria-label="显示 API Key"]');
await new Promise((resolve) => setTimeout(resolve, 150));
const keyTypeAfter = await page.$eval('#api-key', (el) => el.type);
check('新密钥默认隐藏且可切换显示', keyTypeBefore === 'password' && keyTypeAfter === 'text');
await setInput('#api-key', 'sk-demo-only-1234567890');
await new Promise((resolve) => setTimeout(resolve, 250));
const dirtyText = await textOf('body');
check('输入新密钥后标记未保存', dirtyText.includes('未保存更改'));

// 内部导航守卫
await page.click('a[href="#/sessions"]');
await new Promise((resolve) => setTimeout(resolve, 350));
const guardDialog = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '');
check('未保存时切换页面触发确认', guardDialog.includes('有未保存的更改'));
await clickText('[role="dialog"] button', '继续编辑');
await new Promise((resolve) => setTimeout(resolve, 250));
check('取消后停留在模型配置页', Boolean(await page.$('#provider-select')));

// 深色模型页（先隐藏新密钥并放弃修改，避免把测试输入带进截图）
const hideKey = await page.$('[aria-label="隐藏 API Key"]');
if (hideKey) await hideKey.click();
await clickText('button', '放弃更改');
await setTheme('深色');
await hardGoto('/settings/model');
await page.waitForSelector('#provider-select');
await new Promise((resolve) => setTimeout(resolve, 400));
await cleanFocus();
await page.screenshot({ path: path.join(OUT, 'final-model-dark.png') });

// 参数区块浅色
await setTheme('浅色');
await hardGoto('/settings/model');
await page.waitForSelector('#provider-select');
await page.click('[data-testid="preset-complex"]');
await page.evaluate(() => document.querySelector('#model-parameters')?.scrollIntoView({ block: 'start' }));
await page.mouse.move(0, 0);
await new Promise((resolve) => setTimeout(resolve, 500));
await cleanFocus();
await page.screenshot({ path: path.join(OUT, 'final-model-parameters.png') });
await clickText('button', '放弃更改');
await new Promise((resolve) => setTimeout(resolve, 250));

// ── SnowLuma ──────────────────────────────────────────────────────────────
await hardGoto('/snowluma');
await page.waitForSelector('[role="log"]', { timeout: 15000 });
await new Promise((resolve) => setTimeout(resolve, 600));
await page.screenshot({ path: path.join(OUT, 'final-snowluma-light.png') });
const hasJsonTokens = await page.$$eval('[role="log"] .token.property', (nodes) => nodes.length);
check('日志 JSON 使用语法高亮', hasJsonTokens > 0, String(hasJsonTokens));

// 日志向上滚动 → 暂停跟随
await page.$eval('[role="log"]', (el) => {
  el.scrollTop = 0;
  el.dispatchEvent(new Event('scroll', { bubbles: true }));
});
await new Promise((resolve) => setTimeout(resolve, 350));
const followText = await textOf('body');
check('向上查看历史时暂停跟随', followText.includes('返回最新日志'));

// 清空视图确认，不删除服务端
const clearClicked = await clickText('button', '清空视图');
await new Promise((resolve) => setTimeout(resolve, 300));
const clearDialog = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '');
check('清空日志说明只影响当前视图', clearDialog.includes('不会删除服务端') && clearDialog.includes('磁盘'));
await clickText('[role="dialog"] button', '清空视图');
await new Promise((resolve) => setTimeout(resolve, 300));
const emptyLog = await textOf('[role="log"]');
check('清空后当前视图为空且可重新读取', emptyLog.includes('当前视图没有日志'), emptyLog);

// ── 能力总览 ──────────────────────────────────────────────────────────────
await hardGoto('/settings/capabilities');
await page.waitForSelector('text/工具清单', { timeout: 15000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 600));
await page.screenshot({ path: path.join(OUT, 'final-capabilities-light.png') });
const capText = await textOf('body');
check('能力总览展示真实演示状态', capText.includes('41 个工具') && capText.includes('未安装'));
const toolTrigger = await page.$('button[data-state="closed"]');
if (toolTrigger) {
  await toolTrigger.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
}
const bodyAfterTool = await textOf('body');
check('工具参数展开显示类型和必填', bodyAfterTool.includes('必填') || bodyAfterTool.includes('可选'));

// ── 存档 ──────────────────────────────────────────────────────────────────
await hardGoto('/archive');
await page.waitForSelector('text/消息存档', { timeout: 15000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 600));
await page.screenshot({ path: path.join(OUT, 'final-archive-light.png') });
const archiveText = await textOf('body');
check('存档页展示只读边界', archiveText.includes('只读') && archiveText.includes('消息存档'));

// ── 移动端 ────────────────────────────────────────────────────────────────
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await hardGoto('/sessions');
await page.waitForSelector('[data-testid="session-detail"]', { timeout: 15000 }).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 500));
const hasList = await page.$$eval('[data-session-item]', (items) => items.length);
check('移动端默认展示会话列表', hasList === 8, String(hasList));
await page.screenshot({ path: path.join(OUT, 'final-sessions-mobile-list.png') });
await page.click('[data-session-item]');
await new Promise((resolve) => setTimeout(resolve, 500));
const mobileDetail = await page.$('[data-testid="session-detail"]');
check('移动端点击后展示详情', Boolean(mobileDetail));
await page.screenshot({ path: path.join(OUT, 'final-sessions-mobile-detail.png') });

// 1920 布局
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await hardGoto('/sessions');
await page.waitForSelector('[data-testid="session-detail"]');
await new Promise((resolve) => setTimeout(resolve, 500));
await page.screenshot({ path: path.join(OUT, 'final-sessions-1920.png') });

// 1280 布局
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await hardGoto('/settings/model');
await page.waitForSelector('#provider-select');
await new Promise((resolve) => setTimeout(resolve, 500));
await page.screenshot({ path: path.join(OUT, 'final-model-1280.png') });

// ── 实时模式只读校验（不保存、不测试、不登录） ───────────────────────────
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
await hardGoto('/settings/model');
await page.waitForSelector('#provider-select');
await page.click('[aria-label^="切换数据源"]');
await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
await clickText('[role="menuitem"]', '连接本地服务');
await new Promise((resolve) => setTimeout(resolve, 1500));
const liveDom = await page.content();
check(
  '连接本地服务后读取真实状态',
  liveDom.includes('本地服务') && liveDom.includes('platform.deepseek.com'),
);
check(
  '实时配置不把明文密钥渲染进 DOM',
  !/sk-[A-Za-z0-9_-]{20,}/.test(liveDom),
  (liveDom.match(/sk-[A-Za-z0-9_-]{20,}/) ?? [])[0] ?? '',
);
check('实时配置密钥以掩码呈现', liveDom.includes('••••'));
// 切回演示模式，避免后续观摩时误触真实后端
await page.click('[aria-label^="切换数据源"]');
await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
await clickText('[role="menuitem"]', '演示数据');
await new Promise((resolve) => setTimeout(resolve, 700));

await browser.close();

const failed = checks.filter((item) => !item.ok);
console.log('\n— 验证汇总 —');
console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) {
  console.error(failed.map((item) => `FAIL: ${item.name}${item.detail ? ` (${item.detail})` : ''}`).join('\n'));
  process.exitCode = 1;
}
fs.writeFileSync(
  path.join(OUT, 'verify-result.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, checks }, null, 2),
);
