// 配置自愈：掩码一旦落盘，必须按 providers 目录还原真密钥，
// 绝不能拿一串问号/圆点当 API Key 去请求模型。
// 用法：node test/test-config-heal.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-heal-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const cfgMod = await import('../src/config.js');
const { CONFIG_FILE } = cfgMod;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

// 假密钥：只用于验证掩码还原逻辑，任何情况下都不要在这里填真实 key
const REAL_KEY = 'sk-fake-00000000000000000000107d';
const RAW = {
  api: { provider: 'p1', baseUrl: 'https://api.deepseek.com', model: 'm', apiKey: 'sk-????????107d' },
  providers: [
    {
      id: 'p1',
      displayName: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: REAL_KEY,
      models: ['m'],
    },
  ],
  vision: {
    mode: 'native',
    qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '' },
  },
  audio: { apiKey: '' },
  snowluma: { accessToken: '????' },
  webSearch: { anysearchKeys: ['k-live', '????????'] },
};

fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(RAW, null, 2), 'utf8');

const loaded = cfgMod.loadConfig();
check('加载时把问号残骸还原成真密钥', loaded.api.apiKey === REAL_KEY, loaded.api.apiKey);
check('坏的协议端令牌被清空', loaded.snowluma.accessToken === '', loaded.snowluma.accessToken);
check(
  '坏掉的 AnySearch Key 被剔除',
  loaded.webSearch.anysearchKeys.length === 1 && loaded.webSearch.anysearchKeys[0] === 'k-live',
  JSON.stringify(loaded.webSearch.anysearchKeys),
);

// 写入路径同样拦住：模拟前端把 •• 掩码原样提交
const next = cfgMod.updateConfig({ api: { apiKey: 'sk-••••••••107d' } });
check('写入时也把掩码还原（不是存成掩码）', next.api.apiKey === REAL_KEY, next.api.apiKey);

const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
check('落盘的密钥是真值', disk.api.apiKey === REAL_KEY, disk.api.apiKey);

// 没有可还原来源时清空，而不是留一串问号
const orphanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-heal2-'));
process.env.QQ_AGENT_DATA_DIR = orphanDir;
fs.writeFileSync(
  path.join(orphanDir, 'config.json'),
  JSON.stringify({ api: { apiKey: 'sk-????????nope', provider: 'nope' }, providers: [] }),
  'utf8',
);
const fresh = await import('../src/config.js?orphan=1');
const orphan = fresh.loadConfig();
check('无从还原时清空密钥', orphan.api.apiKey === '', JSON.stringify(orphan.api.apiKey));

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(orphanDir, { recursive: true, force: true });

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
if (failed.length) process.exitCode = 1;
