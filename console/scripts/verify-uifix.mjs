// 模型 API / 人设 两个页面的交互回归（只读为主，不改动运行配置）。
// 用法：node scripts/verify-uifix.mjs
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.QQAGENT_BASE || 'http://127.0.0.1:3210';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 开了访问令牌之后所有 /api/* 都要带令牌（含 node 侧与浏览器侧），
// 否则脚本只会拿到 {"error":"未授权"}，看起来像"页面坏了"。
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
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const apiGet = async (p) => (await fetch(`${BASE}${p}`, { headers: authHeaders })).json();

const cfg = await apiGet('/api/config');
const tplList = (await apiGet('/api/persona-templates')).templates || [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

async function open(hash) {
  await page.goto(`${BASE}/console/?r=${Date.now()}#${hash}`, {
    waitUntil: 'networkidle0',
    timeout: 30000,
  });
  await sleep(700);
}

// 浏览器侧登录：控制台的 HttpOnly cookie 只能由 /api/auth/login 下发。
async function login() {
  if (!TOKEN) return;
  await page.goto(`${BASE}/console/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(async (token) => {
    await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  }, TOKEN);
  await sleep(300);
}

await login();

// ── 人设页 ────────────────────────────────────────────────────────────────
await open('/settings/persona');
await page.waitForSelector('#persona-template', { timeout: 15000 });

const roleText = String(cfg.persona?.roleText ?? '').trim();
const expectTpl = tplList.find((t) => String(t.text ?? '').trim() && String(t.text).trim() === roleText);
const triggerText = await page.$eval('#persona-template', (el) => (el.textContent || '').trim());
check(
  '人设下拉回显当前人设',
  expectTpl ? triggerText.includes(expectTpl.name) : triggerText.includes('未应用模板'),
  `trigger="${triggerText}" expect=${expectTpl ? expectTpl.name : '未应用模板'}`,
);

const customCount = (cfg.customPersonas || []).length;
const bodyText = await page.evaluate(() => document.body.innerText);
if (customCount > 0) {
  check('自定义人设列表可见', bodyText.includes(`自定义人设（${customCount}）`), bodyText.slice(0, 100));
}

// 下拉面板：点一条即应用（不再弹「覆盖/追加」对话框），自定义行右侧带 × 删除
await page.click('#persona-template');
await sleep(400);
const optionCount = await page.$$eval('[role="listbox"] button', (els) => els.length).catch(() => 0);
check('人设下拉有可选项', optionCount > 0, String(optionCount));

const xCount = await page
  .$$eval('[role="listbox"] button[aria-label^="删除自定义人设"]', (els) => els.length)
  .catch(() => 0);
check('自定义人设行右侧有 × 删除', xCount === customCount, `×=${xCount} 自定义=${customCount}`);

const builtinHasX = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[role="listbox"] > div > div')].find((el) =>
    (el.textContent || '').includes('小鲸鱼（默认）'),
  );
  return Boolean(row?.querySelector('button[aria-label^="删除自定义人设"]'));
});
check('内置模板不带 ×（代码里的删不掉）', builtinHasX === false);

const roleBefore = await page.$eval('#persona-roletext', (el) => el.value);
// 挑一条「跟当前角色设定不一样」的模板，否则点了等于没点，后面的断言会假红
const pickTarget = tplList.find(
  (t) =>
    String(t.text ?? '').trim() &&
    String(t.text).trim() !== roleText &&
    !/空白|通用模板/.test(String(t.name ?? '')),
);
let pickedName = '';
for (const option of await page.$$('[role="listbox"] button')) {
  const label = await option.evaluate((el) => (el.textContent || '').trim());
  if (!pickTarget || !label.includes(pickTarget.name)) continue;
  if (label.includes('删除') || label.includes('取消')) continue;
  await option.click();
  pickedName = label;
  break;
}
await sleep(600);
const afterPick = await page.evaluate(() => ({
  role: document.querySelector('#persona-roletext')?.value ?? '',
  dialog: Boolean(document.querySelector('[role="dialog"]')),
  panel: Boolean(document.querySelector('[role="listbox"]')),
  text: document.body.innerText,
}));
check(
  '点一条模板就地应用（不弹确认框）',
  Boolean(pickedName) && afterPick.role !== roleBefore && !afterPick.dialog && !afterPick.panel,
  `${pickedName} | dialog=${afterPick.dialog} panel=${afterPick.panel}`,
);
check('应用后出现「已备份…可撤销」提示', afterPick.text.includes('已备份应用前的角色设定'));

for (const button of await page.$$('button')) {
  const label = await button.evaluate((el) => (el.textContent || '').trim());
  if (label.includes('撤销上次应用')) {
    await button.click();
    break;
  }
}
await sleep(500);
const afterUndo = await page.evaluate(() => ({
  role: document.querySelector('#persona-roletext')?.value ?? '',
  text: document.body.innerText,
}));
check('撤销上次应用把角色设定还原', afterUndo.role === roleBefore, `len ${afterUndo.role.length} vs ${roleBefore.length}`);
check('撤销后没有未保存改动', !afterUndo.text.includes('未保存更改'));

// ── 模型 API 页 ───────────────────────────────────────────────────────────
await open('/settings/model');
await page.waitForSelector('#provider-select', { timeout: 15000 });

const providerText = await page.$eval('#provider-select', (el) => (el.textContent || '').trim());
check(
  '服务商下拉显示当前服务商',
  providerText.length > 0 && !providerText.includes('选择服务商'),
  providerText,
);

const fetchUsable = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((el) =>
    (el.textContent || '').includes('获取列表'),
  );
  return button ? !button.disabled : false;
});
check('已保存密钥时「获取列表」可点（不必重贴 key）', fetchUsable);

const saveDisabled = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((el) =>
    (el.textContent || '').includes('保存设置'),
  );
  return button ? button.disabled : null;
});
check('未改动时「保存设置」禁用', saveDisabled === true, String(saveDisabled));

// 改一个参数 → 出现未保存提示 → 放弃更改 → 回到原值
await page.$eval('#temperature', (el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '1.1');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(450);
const dirtyShown = await page.evaluate(() => document.body.innerText.includes('未保存更改'));
check('改参数后出现未保存提示', dirtyShown);

for (const button of await page.$$('button')) {
  const label = await button.evaluate((el) => (el.textContent || '').trim());
  if (label.includes('放弃更改')) {
    await button.click();
    break;
  }
}
await sleep(450);
const tempValue = await page.$eval('#temperature', (el) => el.value);
const stillDirty = await page.evaluate(() => document.body.innerText.includes('未保存更改'));
check('放弃更改把参数恢复原值', !stillDirty && tempValue === String(cfg.api.temperature), `temperature=${tempValue}`);

// ── 保存接口契约 ──────────────────────────────────────────────────────────
// 这两条钉住的是根因本身（UI 断言会被兜底路径掩盖，见下方保存回环）：
// POST /api/config 返回 { ok, config }，顶层没有 api/vision/providers，
// 前端必须拆包后再归一化，否则 normalizeConfig 会静默产出一份全默认值的空壳。
const postRaw = await (
  await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({}),
  })
).json();
check('POST /api/config 返回 { ok, config } 包裹体', Boolean(postRaw?.config?.api), Object.keys(postRaw ?? {}).join(','));
check('包裹体顶层没有 api 字段（拆包不可省）', !postRaw?.api, Object.keys(postRaw ?? {}).join(','));

// ── 保存回环 ──────────────────────────────────────────────────────────────
// 回归：POST /api/config 返回的是 { ok, config }。前端忘了拆包时 normalizeConfig
// 拿不到 api 字段 → 整包退化成默认值 → 保存成功后 Base URL / 模型被清空、
// 密钥变「未配置」，用户只能全部重填一遍。
const origTemp = Number(cfg.api.temperature);
const probeTemp = origTemp >= 1.5 ? 0.7 : 1.2;

async function setTemperature(value) {
  await page.$eval(
    '#temperature',
    (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
  await sleep(400);
}

async function clickButton(text) {
  for (const button of await page.$$('button')) {
    const label = await button.evaluate((el) => (el.textContent || '').trim());
    if (label.includes(text)) {
      await button.click();
      return true;
    }
  }
  return false;
}

const savedClicked = await (async () => {
  await setTemperature(probeTemp);
  return clickButton('保存设置');
})();
await sleep(1400);

const afterSave = await page.evaluate(() => ({
  text: document.body.innerText,
  provider: document.querySelector('#provider-select')?.textContent?.trim() ?? '',
  baseUrl: document.querySelector('#base-url')?.value ?? '',
  temperature: document.querySelector('#temperature')?.value ?? '',
  // 密钥「已保存」时渲染的是不可回显的锁定行，#api-key 输入框**不存在**；
  // 一旦回包是空壳，configured 变 false，输入框会冒出来并带「尚未配置密钥」报错。
  keyInputShown: Boolean(document.querySelector('#api-key')),
}));

check('保存设置按钮可点', savedClicked);
check('保存后服务商没被清空', afterSave.provider.length > 0 && !afterSave.provider.includes('选择服务商'), afterSave.provider);
check('保存后 Base URL 保留', afterSave.baseUrl === String(cfg.api.baseUrl), `baseUrl="${afterSave.baseUrl}"`);
check('保存后温度保持改动值', afterSave.temperature === String(probeTemp), `temperature=${afterSave.temperature}`);
check('保存后不再提示「尚未配置密钥」', !afterSave.text.includes('该服务商尚未配置密钥'));
check('保存后密钥仍是已保存态（不要求重填）', afterSave.keyInputShown === false);
check('保存后回到未改动状态', !afterSave.text.includes('未保存更改'));

// 还原温度，别把验证脚本的副作用留在用户配置里
await setTemperature(origTemp);
await clickButton('保存设置');
await sleep(1400);
const restored = await apiGet('/api/config');
check('温度已还原', Number(restored.api.temperature) === origTemp, String(restored.api.temperature));

check('两个页面无前端异常', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
fs.mkdirSync(path.join(ROOT, 'screenshots'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'screenshots', 'verify-uifix-result.json'),
  JSON.stringify({ at: new Date().toISOString(), base: BASE, checks }, null, 2),
);
if (failed.length) process.exitCode = 1;
