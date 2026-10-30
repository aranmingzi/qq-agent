// NapCat OneBot 端口配置的自动补/修（单元测试；只用临时目录，不碰真实配置）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureOnebotConfigs, HTTP_SERVER_NAME, WS_SERVER_NAME } from '../src/napcat-onebot-config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-onebotcfg-'));
const configDir = path.join(root, 'config');
fs.mkdirSync(configDir, { recursive: true });
const logs = [];
const log = (t) => logs.push(t);
const read = (f) => JSON.parse(fs.readFileSync(path.join(configDir, f), 'utf8'));
const ports = (cfg) => ({
  http: ((cfg.network && cfg.network.httpServers) || []).filter((s) => s.enable !== false).map((s) => s.port),
  ws: ((cfg.network && cfg.network.websocketServers) || []).filter((s) => s.enable !== false).map((s) => s.port)
});

// ① 空目录 → 先补出"账号无关模板"
let r = ensureOnebotConfigs(root, { httpPort: 3000, wsPort: 3001, log, stamp: 'T1' });
assert.ok(r.ok, '应成功');
assert.deepStrictEqual(r.changes.map((c) => c.action), ['created'], '首次应创建模板');
const tpl = read('onebot11.json');
assert.deepStrictEqual(ports(tpl), { http: [3000], ws: [3001] }, '模板应带 HTTP 3000 / WS 3001');
assert.strictEqual(tpl.network.httpServers[0].name, HTTP_SERVER_NAME, 'HTTP 服务端名字应固定');
assert.strictEqual(tpl.network.websocketServers[0].name, WS_SERVER_NAME, 'WS 服务端名字应固定');
assert.ok(logs.some((l) => l.includes('以后换任何号登录都会自带端口')), '日志要说明模板的作用');

// ② 幂等：再跑一次不写盘
r = ensureOnebotConfigs(root, { httpPort: 3000, wsPort: 3001, log, stamp: 'T2' });
assert.deepStrictEqual(r.changes.map((c) => c.action), ['ok'], '第二次应是 ok（不写盘）');
assert.ok(!fs.existsSync(path.join(configDir, 'onebot11.json.bak-T1')), '没改动就不该有备份');

// ③ NapCat 自己生成的"空配置"（一个端口都没开）→ 补上 + 备份 + 提示需重新登录
fs.writeFileSync(path.join(configDir, 'onebot11_123456.json'), JSON.stringify({ network: { httpServers: [], websocketServers: [] }, timeout: { baseTimeout: 10000 } }, null, 2), 'utf8');
r = ensureOnebotConfigs(root, { httpPort: 3100, wsPort: 3101, log, stamp: 'T3' });
const filled = r.changes.find((c) => c.file === 'onebot11_123456.json');
assert.ok(filled && filled.action === 'filled', '空配置应被补上');
assert.ok(fs.existsSync(path.join(configDir, 'onebot11_123456.json.bak-T3')), '改动前应备份');
const acc = read('onebot11_123456.json');
assert.deepStrictEqual(ports(acc), { http: [3100], ws: [3101] }, '补的应是当前设置里的端口');
assert.ok(acc.timeout && acc.timeout.baseTimeout === 10000, '其它字段必须原样保留');
assert.ok(logs.some((l) => l.includes('需重新登录一次才生效')), '要提示需重新登录才生效');

// ④ 还是我们那份、但端口变了 → 对齐端口
r = ensureOnebotConfigs(root, { httpPort: 3200, wsPort: 3201, log, stamp: 'T4' });
assert.ok(r.changes.some((c) => c.file === 'onebot11_123456.json' && c.action === 'realigned'), '端口不一致应被对齐');
assert.deepStrictEqual(ports(read('onebot11_123456.json')), { http: [3200], ws: [3201] }, '应已对齐到新端口');

// ⑤ 用户自己改过的（服务端名字不是我们的）→ 一律不动
fs.writeFileSync(path.join(configDir, 'onebot11_999.json'), JSON.stringify({ network: { httpServers: [{ name: '我自己配的', enable: true, port: 8080 }], websocketServers: [] } }, null, 2), 'utf8');
r = ensureOnebotConfigs(root, { httpPort: 3200, wsPort: 3201, log, stamp: 'T5' });
const foreign = r.changes.find((c) => c.file === 'onebot11_999.json');
assert.ok(foreign && foreign.action === 'skip-foreign', '别人的配置不该动');
assert.deepStrictEqual(ports(read('onebot11_999.json')).http, [8080], '端口保持原样');

// ⑥ 解析失败的文件 → 不动
fs.writeFileSync(path.join(configDir, 'onebot11_888.json'), '{ 这不是合法 JSON', 'utf8');
r = ensureOnebotConfigs(root, { httpPort: 3200, wsPort: 3201, log, stamp: 'T6' });
assert.ok(r.changes.some((c) => c.file === 'onebot11_888.json' && c.action === 'skip-unparsable'), '坏文件应跳过');
assert.strictEqual(fs.readFileSync(path.join(configDir, 'onebot11_888.json'), 'utf8'), '{ 这不是合法 JSON', '坏文件内容不得被改');

fs.rmSync(root, { recursive: true, force: true });
console.log('✓ NapCat OneBot 配置自动补/修：全部断言通过');
