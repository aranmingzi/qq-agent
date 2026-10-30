// QQ 通话状态接口的接线测试。
//
// 为什么这个测试存在：
// 这条链路有四个独立的失败点（功能没开 / 平台不对 / 只看不接 / 没有虚拟声卡），
// 任何一处没说出来，用户看到的就是"按钮按了没反应"。所以断言的不是"字段存在"，
// 而是**每一条阻塞原因都真的被拼进了 problems**。
//
// 上一轮踩过的坑：只断言源码里有 `pathname === '/api/call/status'` 是没用的，
// 那种测试在把整段路由删掉之后照样绿。这里真的起一个 app、真的发请求。

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import config/app 之前定好数据目录，否则会读写真实 data/
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-call-status-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

let pass = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}：期望 ${e}，实际 ${a}`);
}

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

function request(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = { ...headers };
    if (payload) {
      h['content-type'] = 'application/json';
      h['content-length'] = String(payload.length);
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const port = await freePort();
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  // 把 app 拉起来但别真去连协议端/真去跑主动消息
  server: { port, token: '', bindHost: '127.0.0.1' },
  snowluma: { autoLaunch: false, wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9', accessToken: '' },
  proactive: { enabled: false },
  api: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fake-k', model: 'm' },
  audio: { enabled: true, apiKey: 'fake-dashsco' + 'pe-key', gsvAutoStart: false, gsvUrl: 'http://127.0.0.1:9' }
}));

const { createApp } = await import('../src/app.js');
const { getConfig, updateConfig } = await import('../src/config.js');

const app = createApp({ log: () => {} });
await app.start();

try {
  await ok('默认全关：enabled=false，且原因点名了 config.call.enabled', async () => {
    const r = await request(port, '/api/call/status');
    assertEqual(r.status, 200, '状态码');
    const b = r.body;
    assertEqual(b.enabled, false, '默认必须关着 —— 替用户接电话是高风险动作');
    assertEqual(b.autoAnswer, false, '默认不自动接');
    assertEqual(b.ready, false, 'ready 应为 false');
    assert(
      b.problems.some((p) => p.includes('config.call.enabled=false')),
      `应指出是配置关的，实际：${JSON.stringify(b.problems)}`
    );
    // 关着的时候不该有看门狗实例（start() 里挂的那次会直接返回 null）。
    // 这条必须在任何 enabled=true 之前断言，否则实例一旦建出来就不会消失。
    assertEqual(b.watcher, null, '功能关着时 watcher 应是 null');
  });

  await ok('结构完整：watch / loopback / vad / mouth 四块都在', async () => {
    const r = await request(port, '/api/call/status');
    const b = r.body;
    assert(b.watch && typeof b.watch.intervalMs === 'number', 'watch.intervalMs 应是数字');
    assertEqual(b.watch.windowPattern, '通话', '只扫标题含「通话」的窗口');
    assert(b.watch.answerPattern.includes('接听'), '接听正则应含接听');
    assert(b.watch.rejectPattern.includes('挂断'), '挂断正则应含挂断');
    assertEqual(b.watch.preferVideo, false, '默认不接视频（会开摄像头）');
    assert(b.loopback && typeof b.loopback.enabled === 'boolean', 'loopback.enabled 应是布尔');
    assert(b.vad && typeof b.vad.silenceMs === 'number', 'vad.silenceMs 应是数字');
    // 断句参数是照搬 ohwhale 实测值的，写死在这里防止被误改回 700/200
    assertEqual(b.vad.silenceMs, 900, '静音 900ms（0.55 太急，换气就被截断）');
    assertEqual(b.vad.preRollMs, 450, '预录 450ms（不留的话第一个字永远丢）');
    assert(b.mouth && b.mouth.cable, 'mouth.cable 必须存在');
    assert(
      b.mouth.note.includes('enumerateDevices'),
      `必须提醒前端：系统端点 id 不能喂给 setSinkId，实际：${b.mouth.note}`
    );
  });

  await ok('loopback.available 跟着运行环境走（纯 node 跑 app.js 时是 false）', async () => {
    const r = await request(port, '/api/call/status');
    // 这个测试是 node 直接跑的，不在 Electron 里，所以拿不到 setDisplayMediaRequestHandler。
    assertEqual(r.body.loopback.available, !!process.versions.electron, 'available 应等于"在不在 Electron 里"');
    if (!process.versions.electron) {
      assert(r.body.loopback.reason.includes('Electron'), `不在 Electron 里要说明原因，实际：${r.body.loopback.reason}`);
    }
  });

  await ok('没装虚拟声卡时：problems 里有一句人话，且点名 VB-Cable', async () => {
    const r = await request(port, '/api/call/status');
    // 这台机器确实没装 VB-Cable（2026-10-29 实测），所以断言"必须说听不到"是对的。
    // 万一以后装了，这个断言会失败 —— 那时把它改成"有 cable 就不该有这条"，也是对的。
    if (r.body.mouth.cable.present) {
      assert(
        !r.body.problems.some((p) => p.includes('对方暂时听不到')),
        '既然装了虚拟声卡，就不该说听不到'
      );
      return;
    }
    assert(
      r.body.problems.some((p) => p.includes('对方暂时听不到它说话')),
      `应明说对方听不到，实际：${JSON.stringify(r.body.problems)}`
    );
    assert(
      r.body.problems.some((p) => p.includes('VB-Cable')),
      `应点名要装 VB-Cable，实际：${JSON.stringify(r.body.problems)}`
    );
  });

  await ok('打开 enabled 但 autoAnswer=false → 明确说"只看不接"', async () => {
    updateConfig({ call: { enabled: true, autoAnswer: false } });
    const r = await request(port, '/api/call/status');
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.enabled, true, 'enabled');
    assertEqual(r.body.autoAnswer, false, 'autoAnswer');
    assert(
      r.body.problems.some((p) => p.includes('只看不接')),
      `应说清只看不接，实际：${JSON.stringify(r.body.problems)}`
    );
    updateConfig({ call: { enabled: false, autoAnswer: false } });
  });

  await ok('关着的时候也照样能查设备（否则用户没法先看装没装）', async () => {
    const r = await request(port, '/api/call/devices');
    assertEqual(r.status, 200, '状态码');
    assert(Array.isArray(r.body.all), 'all 应是数组');
    assert(r.body.virtualCable && typeof r.body.virtualCable.state === 'string', 'virtualCable.state 应是字符串');
    assert(['present', 'partial', 'absent'].includes(r.body.virtualCable.state), 'state 只能是这三个值之一');
  });

  await ok('probe 干跑：返回窗口列表和决策，不点任何东西', async () => {
    const r = await request(port, '/api/call/probe', { method: 'POST', body: {} });
    assertEqual(r.status, 200, '状态码');
    assert(typeof r.body.ok === 'boolean', 'ok 应是布尔');
    assert(Array.isArray(r.body.windows), 'windows 应是数组');
    assert(Array.isArray(r.body.errors), 'errors 应是数组');
    assert(r.body.decision && typeof r.body.decision.action === 'string', 'decision.action 应是字符串');
    // 没有来电时必须是 none —— 绝不能因为"扫到别的窗口里有按钮"就去点
    assertEqual(r.body.decision.action, 'none', '没有来电时应是 none');
    assert(
      ['没有窗口', '没有可点的接听按钮', '没有匹配'].some((k) => r.body.decision.reason.includes(k))
        || r.body.decision.reason.length > 0,
      'none 必须带原因'
    );
  });

  await ok('probe 能指定 windowPattern（QQ 改版时不用改配置先试）', async () => {
    const r = await request(port, '/api/call/probe', {
      method: 'POST',
      body: { windowPattern: 'QQ', includeAll: false }
    });
    assertEqual(r.status, 200, '状态码');
    assert(Array.isArray(r.body.windows), 'windows 应是数组');
    // 本机 QQ 主窗口标题是「QQ」/「我的手机等2个会话」，不含「通话」，
    // 所以这个 probe 会扫到窗口但找不到接听按钮 —— 决策仍是 none。
    assertEqual(r.body.decision.action, 'none', 'QQ 主窗口里没有接听按钮');
  });

  await ok('probe 把坏正则的原因说出来，不静默全匹配', async () => {
    const r = await request(port, '/api/call/probe', {
      method: 'POST',
      body: { answerPattern: '接听(' }
    });
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.decision.action, 'none', '坏正则不能退化成"什么都能点"');
    assert(
      r.body.decision.reason.includes('answerPattern'),
      `应点名是哪个 pattern 坏了，实际：${r.body.decision.reason}`
    );
  });

  await ok('手动接听：pid / buttonName 不全时 400，且不会去点', async () => {
    const noPid = await request(port, '/api/call/answer', { method: 'POST', body: { buttonName: '接听' } });
    assertEqual(noPid.status, 400, '缺 pid 应 400');
    assert(noPid.body.error.includes('pid'), `实际：${noPid.body.error}`);

    const noName = await request(port, '/api/call/answer', { method: 'POST', body: { pid: 1234 } });
    assertEqual(noName.status, 400, '缺 buttonName 应 400');
    assert(noName.body.error.includes('buttonName'), `实际：${noName.body.error}`);

    const badPid = await request(port, '/api/call/answer', { method: 'POST', body: { pid: 0, buttonName: '接听' } });
    assertEqual(badPid.status, 400, 'pid=0 应 400');
  });

  await ok('记住声音输出设备：存的是标签，空标签等于忘掉', async () => {
    // 为什么不存 deviceId：浏览器的 deviceId 是按 origin 加盐哈希的，
    // 端口从 3210 换成 3211 就全变，存下来下次根本认不回来。
    // 标签是驱动给的固定名字，重启/换端口都还在 —— 所以接口只收标签。
    const saved = await request(port, '/api/call/output', {
      method: 'POST',
      body: { label: 'CABLE Input (VB-Audio Virtual Cable)' }
    });
    assertEqual(saved.status, 200, '状态码');
    assertEqual(saved.body.outputLabel, 'CABLE Input (VB-Audio Virtual Cable)', '应原样存回');

    const back = await request(port, '/api/call/status');
    assertEqual(back.body.mouth.outputLabel, 'CABLE Input (VB-Audio Virtual Cable)', 'status 里要能读到');

    const cleared = await request(port, '/api/call/output', { method: 'POST', body: { label: '' } });
    assertEqual(cleared.status, 200, '状态码');
    assertEqual(cleared.body.outputLabel, '', '空标签 = 忘掉这个选择');
    const after = await request(port, '/api/call/status');
    assertEqual(after.body.mouth.outputLabel, '', '清空后 status 也应为空');
  });

  await ok('输出设备标签会去掉首尾空白并截断，不会把超长字符串塞进配置', async () => {
    const r = await request(port, '/api/call/output', {
      method: 'POST',
      body: { label: `   ${'x'.repeat(300)}   ` }
    });
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.outputLabel.length, 200, '应截断到 200 字符');
    assert(!r.body.outputLabel.startsWith(' '), '首尾空白应去掉');
    await request(port, '/api/call/output', { method: 'POST', body: { label: '' } });
  });

  await ok('body 缺 label 时按"清空"处理，不是报错也不是保留旧值', async () => {
    // 前端清空下拉框时可能根本不带这个字段。此时若保留旧值，
    // 用户会看到"我明明清空了它还在"；若 500，面板会弹一条看不懂的错误。
    await request(port, '/api/call/output', { method: 'POST', body: { label: 'CABLE Input' } });
    const r = await request(port, '/api/call/output', { method: 'POST', body: {} });
    assertEqual(r.status, 200, '状态码');
    assertEqual(r.body.outputLabel, '', '缺字段应当作清空');
  });

  await ok('设了 server.token 后：未带 cookie 的请求 401（状态接口也不白送）', async () => {
    updateConfig({ server: { token: 'call-test-token' } });
    const r = await request(port, '/api/call/status');
    assertEqual(r.status, 401, '应拒绝');
    updateConfig({ server: { token: '' } });
  });

  await ok('watcher 只在 start 后才起（构造期起会拖住测试进程）', async () => {
    // 这一条的实质断言已经前移到第一条用例里（必须在任何 enabled=true 之前看）。
    // 这里只守住"关着时接口不会因为 watcher 为 null 而炸"。
    const r = await request(port, '/api/call/status');
    assertEqual(r.status, 200, '状态码');
    assert('watcher' in r.body, 'watcher 字段必须在（哪怕是 null）');
  });

  await ok('打开 enabled 后看门狗真的挂上，且 canClick 跟着 autoAnswer 走', async () => {
    // 这条是给「危险动作失控」兜底的：看门狗的 isEnabled 必须真的读 autoAnswer。
    // 如果接线写错成永远 true，面板会显示"会接"、而且真的会去点 —— 替用户接电话
    // 是这个功能里唯一不可回退的动作，所以必须由接口自证。
    // 扫描间隔调到很大，避免测试期间反复 spawn PowerShell。
    updateConfig({ call: { enabled: true, autoAnswer: false, scanIntervalMs: 600000 } });

    const off = await request(port, '/api/call/status');
    assertEqual(off.status, 200, '状态码');
    assert(off.body.watcher, 'enabled=true 后 watcher 不该还是 null（说明没挂上）');
    assertEqual(off.body.watcher.canClick, false, 'autoAnswer=false 时绝不能点');
    // 本机实测：windowPattern='QQ' 扫到过 DSH 窗口里一个叫
    // 「打开计划：QQ 通话三步落地计划（自动接听 → …）」的按钮，名字含「接听」。
    // 这类"看到了但判定不是通话动作"的按钮必须能带出来，
    // 否则面板只会说"没有来电"，用户会以为扫描坏了。
    assert(Array.isArray(off.body.watcher.lastSkipped), 'lastSkipped 必须是数组（哪怕是空数组）');

    updateConfig({ call: { autoAnswer: true } });
    const on = await request(port, '/api/call/status');
    assertEqual(on.body.watcher.canClick, true, 'autoAnswer=true 后才允许点');

    updateConfig({ call: { enabled: false, autoAnswer: false } });
  });

  await ok('关掉 enabled 之后 watcher 报告不再点击（不会留着旧状态骗人）', async () => {
    // 看门狗实例还在（已经 start 过），但 isEnabled 读的是实时配置，
    // 所以关掉开关后它必须立刻变成"不点"。这比"停掉实例"更重要 ——
    // 用户关开关的意图是"别再替我接了"，不是"下次重启才别接"。
    const r = await request(port, '/api/call/status');
    assertEqual(r.body.enabled, false, 'enabled');
    if (r.body.watcher) {
      assertEqual(r.body.watcher.canClick, false, '关掉后绝不能还在点');
    }
  });

  await ok('状态接口带出「看到但没敢点」的按钮（否则用户以为扫描坏了）', async () => {
    // 实质断言已并入上一条（那里 watcher 一定存在）。
    // 这里守住的是"关掉开关后形状也不能变"：watcher 为 null 时不炸，为对象时字段仍在。
    const r = await request(port, '/api/call/status');
    assertEqual(r.status, 200, '状态码');
    assert('watcher' in r.body, 'watcher 字段必须在（哪怕是 null）');
    if (r.body.watcher) {
      assert(Array.isArray(r.body.watcher.lastSkipped), 'lastSkipped 必须是数组');
    }
  });
} finally {
  try { await app.stop(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n[call-status] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
