// 真实起一次 app，验证 QQ 通话那几条接口和 /qq-call 页面真的能用。
// 为什么要起真的 app：语音通话那轮就是这么抓到「页面 404」的 ——
// 只跑单测和 tsc 都绿，但 ui-console 里没有那个路由。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-call-smoke-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// 端口必须写进临时 config 再导入 app：app.start() 读的是配置里的 server.port，
// 用默认的 3210 会跟真在跑的 QQ Agent 撞端口。
const port = await freePort();
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  server: { port, token: '', bindHost: '127.0.0.1' },
  snowluma: { autoLaunch: false, wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9', accessToken: '' },
  proactive: { enabled: false },
  api: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' }
}));

const { createApp } = await import('../src/app.js');

let pass = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const app = createApp({ log: () => {} });
await app.start();
const base = `http://127.0.0.1:${port}`;

try {
  await ok('/api/call/status 返回结构完整的报告', async () => {
    const res = await fetch(`${base}/api/call/status`);
    assert(res.status === 200, `状态码：${res.status}`);
    const data = await res.json();
    assert(typeof data.enabled === 'boolean', 'enabled 不是布尔');
    assert(typeof data.autoAnswer === 'boolean', 'autoAnswer 不是布尔');
    assert(Array.isArray(data.problems), 'problems 不是数组');
    assert(data.problems.length > 0, '默认全关却没有任何 problems —— 用户看不出为什么不能用');
    assert(data.watch && typeof data.watch.windowPattern === 'string', 'watch 缺失');
    assert(data.vad && typeof data.vad.silenceMs === 'number', 'vad 缺失');
    assert(data.mouth && data.mouth.cable, 'mouth.cable 缺失');
    assert(data.loopback && typeof data.loopback.available === 'boolean', 'loopback 缺失');
    // 纯 node 里没有 electron，环回必须是"不可用 + 有原因"，不能是假的可用。
    assert(data.loopback.available === false, '纯 node 下环回居然报告可用');
    assert(data.loopback.reason.length > 0, '环回不可用却没给原因');
  });

  await ok('/api/call/devices 能列出音频端点', async () => {
    const res = await fetch(`${base}/api/call/devices`);
    assert(res.status === 200, `状态码：${res.status}`);
    const data = await res.json();
    assert(Array.isArray(data.all), 'all 不是数组');
    assert(data.virtualCable && typeof data.virtualCable.state === 'string', 'virtualCable 缺失');
  });

  await ok('/api/call/probe 干跑能返回窗口和决策', async () => {
    const res = await fetch(`${base}/api/call/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeAll: false }),
    });
    assert(res.status === 200, `状态码：${res.status}`);
    const data = await res.json();
    assert(Array.isArray(data.windows), 'windows 不是数组');
    assert(data.decision && typeof data.decision.action === 'string', 'decision 缺失');
    // 没有来电时决策必须是 none —— 否则看门狗会去点不存在的按钮。
    assert(data.decision.action === 'none', `没来电却给出 ${data.decision.action}`);
  });

  await ok('/api/call/answer 缺参数时给 400 而不是 500', async () => {
    const res = await fetch(`${base}/api/call/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `状态码：${res.status}`);
    const data = await res.json();
    assert(data.ok === false, 'ok 不是 false');
  });

  await ok('/api/call/output 记住并清空设备标签', async () => {
    const save = await fetch(`${base}/api/call/output`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'CABLE Input (VB-Audio Virtual Cable)' }),
    });
    assert(save.status === 200, `保存状态码：${save.status}`);
    const saved = await save.json();
    assert(saved.outputLabel.includes('CABLE Input'), '保存后没读回标签');
    const status = await (await fetch(`${base}/api/call/status`)).json();
    assert(status.mouth.outputLabel.includes('CABLE Input'), '状态接口没反映标签');

    const clear = await fetch(`${base}/api/call/output`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    });
    const cleared = await clear.json();
    assert(cleared.outputLabel === '', '清空后还有残留');
  });

  await ok('控制台首页真的能打开，且打包里有 QQ 通话页', async () => {
    const res = await fetch(`${base}/console/`);
    assert(res.status === 200, `状态码：${res.status}`);
    const html = await res.text();
    assert(html.includes('<div id="root"'), '返回的不是控制台页面');
    const assets = fs.readdirSync(path.join(process.cwd(), 'ui-console', 'assets'));
    const js = assets.find((f) => f.startsWith('index-') && f.endsWith('.js'));
    assert(js, 'ui-console/assets 里没有 index-*.js —— 没跑 build:electron');
    const bundle = fs.readFileSync(path.join(process.cwd(), 'ui-console', 'assets', js), 'utf8');
    // 这一条查的是"页面本体在不在打包里"。组件被 tree-shake 掉（比如路由那行被删、
    // 只剩一个没人用的 import）时这句独有的文案就没了 —— 这正是语音通话那轮 404 的形态。
    // 路由注册本身由 tsc 的 noUnusedLocals 兜底：删了路由行，import 就变成未使用，构建直接失败。
    //
    // ⚠️ 别拿「某个按钮的文案」当锚点：这里原本断言的是「干跑一次扫描」，
    // 2026-10-29 重做这一页 UI 时那句文案被改掉了，测试立刻报"页面会 404"，
    // 而页面其实好好的 —— 一条只会在改文案时变红的断言，测的不是打包。
    // 换成结论横幅的主文案：两个分支（会/不会）都编译进 bundle，
    // 只有这一页会产出它，改布局改按钮都碰不到。
    assert(bundle.includes('会替你接电话'), '打包里没有 QQ 通话页的内容 —— 页面会 404');
    assert(bundle.includes('/qq-call'), '打包里没有 /qq-call 这个导航项');
  });

  console.log(`\n[call-smoke] ${pass} 项通过，全部通过`);
} catch (error) {
  // ⚠️ 这里必须显式 exit(1)。
  // 第一版把 process.exit(0) 写在 finally 里，结果断言抛了异常也被 finally 的
  // exit(0) 抹平 —— 脚本"通过"了，实际一条断言都没跑。
  // 凡是 finally 里有 process.exit 的测试，都要用这个形状。
  console.error(`\n✗ ${error?.message ?? error}`);
  await app.stop();
  fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true });
  process.exit(1);
}

await app.stop();
fs.rmSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true, force: true });
process.exit(0);
