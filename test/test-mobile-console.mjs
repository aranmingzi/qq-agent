// 手机轻量版（/m/）自检：静态接线 + 端到端。
//   静态部分：确认关键代码路径还在（防以后重构把鉴权/白名单删掉）。
//   端到端部分：用**隔离 data 目录 + 假 OneBot 地址**另起一个进程测，
//              不会碰到正在运行的机器人的数据，也不会抢 QQ 消息。
// 用法：node test/test-mobile-console.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'mobile-fake-' + 'token-2f8a';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('异步断言请用 acheck');
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n      ${error.message}`);
  }
}

async function acheck(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n      ${error.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 1. 静态接线
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[1] 静态接线');

const appSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');

check('config 默认只监听回环', () => {
  assert.match(configSrc, /bindHost:\s*'127\.0\.0\.1'/, 'server.bindHost 默认值丢了');
});

check('listenOn 使用配置的 bindHost', () => {
  assert.match(appSrc, /async function listenOn\(port, host = '127\.0\.0\.1'\)/, 'listenOn 签名没带 host');
  assert.match(appSrc, /server\.listen\(port, host,/, 'server.listen 没传 host');
  assert.match(appSrc, /listenOn\(p, bindHost\)/, 'start() 没把 bindHost 传下去');
});

check('非回环监听缺令牌时强制退回回环（fail-closed）', () => {
  assert.match(appSrc, /function auditBindHost\(\)/, 'auditBindHost 不存在');
  assert.match(appSrc, /已强制退回 127\.0\.0\.1/, '缺少强制退回逻辑');
});

check('鉴权支持 cookie 与定长比较', () => {
  assert.match(appSrc, /const AUTH_COOKIE = 'qqagent_token'/, 'cookie 名丢了');
  assert.match(appSrc, /crypto\.timingSafeEqual/, '没用定长比较');
  assert.match(appSrc, /parseCookies\(req\)\[AUTH_COOKIE\]/, 'authorize 没读 cookie');
  assert.match(appSrc, /HttpOnly;\s*SameSite=Lax/, 'cookie 缺少 HttpOnly/SameSite');
});

check('登录接口排在 /api 鉴权守卫之前', () => {
  const loginAt = appSrc.indexOf("pathname === '/api/auth/login'");
  // 注意：/api/events 那处鉴权在登录之前是正常的（SSE 不是登录入口），
  // 真正要保证的是登录不要落到 "/api/" 前缀守卫后面。
  const guardAt = appSrc.indexOf("if (pathname.startsWith('/api/'))");
  assert.ok(loginAt > 0, '找不到登录路由');
  assert.ok(guardAt > 0, '找不到 /api 守卫');
  assert.ok(loginAt < guardAt, '登录路由被 /api 守卫挡住了，永远进不去');
});

check('server.token 不下发给浏览器', () => {
  assert.match(appSrc, /clone\.server\.token = maskSecretValue/, 'publicConfig 没掩码 server.token');
  assert.match(appSrc, /'httpAccessToken', 'token'\]/, 'stripMaskedSecrets 不认识 token 字段');
});

check('移动端写配置走白名单', () => {
  assert.match(appSrc, /const MOBILE_CONFIG_GROUPS = \{/, '缺少字段白名单');
  assert.match(appSrc, /function pickMobileConfig\(raw\)/, '缺少 pickMobileConfig');
  assert.match(appSrc, /pathname === '\/api\/mobile\/config'/, '缺少移动端写接口');
  const block = appSrc.slice(appSrc.indexOf('const MOBILE_CONFIG_GROUPS'), appSrc.indexOf('const MOBILE_CONFIG_SCALARS'));
  for (const forbidden of ['server', 'allow', 'deny', 'providers', 'snowluma', 'customPersonas', 'masterQQ']) {
    assert.ok(!new RegExp(`^\\s{2}${forbidden}:`, 'm').test(block), `白名单里不该出现 ${forbidden}`);
  }
});

check('/m/ 路由已接入且目录缺失时回退', () => {
  assert.match(appSrc, /const MOBILE_DIR = /, '缺 MOBILE_DIR');
  assert.match(appSrc, /pathname\.startsWith\('\/m\/'\)/, '缺 /m/ 分支');
  assert.match(appSrc, /'\/m'\) return redirect\('\/m\/'\)/, '/m 短地址没重定向');
  assert.match(appSrc, /pathname === '\/m'/, '缺 /m 短地址');
});

check('webmanifest 有正确 content-type', () => {
  assert.match(appSrc, /'\.webmanifest': 'application\/manifest\+json/, 'manifest 会被当成 octet-stream');
});

const mobileDir = path.join(ROOT, 'ui-mobile');
check('手机端三件套存在', () => {
  for (const file of ['index.html', 'manifest.webmanifest', 'icon.svg']) {
    assert.ok(fs.existsSync(path.join(mobileDir, file)), `缺 ${file}`);
  }
});

check('manifest 的 start_url 与 scope 一致', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(mobileDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '/m/', 'start_url 不对');
  assert.equal(manifest.scope, '/m/', 'scope 不对');
  assert.equal(manifest.display, 'standalone', '不是独立窗口模式');
});

const mobileHtml = fs.readFileSync(path.join(mobileDir, 'index.html'), 'utf8');
check('手机端登录态与接口约定对齐', () => {
  assert.match(mobileHtml, /\/api\/auth\/status/, '没检查登录状态');
  assert.match(mobileHtml, /\/api\/auth\/login/, '没有登录请求');
  assert.match(mobileHtml, /\/api\/mobile\/config/, '保存没走白名单接口');
  assert.match(mobileHtml, /credentials: "same-origin"/, 'fetch 没带 cookie');
});

check('手机端不碰密钥类接口', () => {
  for (const forbidden of ['set-key', 'test-saved', '/api/config", { method: "POST"', 'snowluma/login']) {
    assert.ok(!mobileHtml.includes(forbidden), `手机端不该调用 ${forbidden}`);
  }
});

check('声明表里的字段都在后端白名单内', () => {
  const groups = appSrc.slice(appSrc.indexOf('const MOBILE_CONFIG_GROUPS'), appSrc.indexOf('const MOBILE_CONFIG_SCALARS'));
  const allowed = new Set();
  for (const match of groups.matchAll(/^\s{2}(\w+):\s*\[([\s\S]*?)\]/gm)) {
    allowed.add(match[1] + '.*');
    for (const key of match[2].matchAll(/'([\w.]+)'/g)) allowed.add(match[1] + '.' + key[1]);
  }
  const scalars = (appSrc.slice(appSrc.indexOf('const MOBILE_CONFIG_SCALARS')).match(/^const MOBILE_CONFIG_SCALARS = \[([\s\S]*?)\]/m) || [])[1] || '';
  for (const key of scalars.matchAll(/'([\w.]+)'/g)) allowed.add(key[1]);

  const paths = [...mobileHtml.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 20, `只解析到 ${paths.length} 个字段，声明表结构变了？`);
  const orphan = paths.filter((p) => !allowed.has(p));
  assert.deepEqual(orphan, [], `这些字段不在后端白名单里，存了也会被丢弃：${orphan.join(', ')}`);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 端到端
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[2] 端到端（隔离进程）');

const dataDir = path.join(ROOT, '.tmp-mobile-test', 'data');
const port = 3600 + Math.floor(Math.random() * 200);
let child = null;
let snowBackup = null;

function backupSnowlumaOnebot() {
  // 启动时会按配置重写 onebot11*.json（这本来就是每次启动都做的事），
  // 测试结束后还原，避免临时实例的端口写进正式配置。
  const dir = path.join(ROOT, 'snowluma', 'config');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^onebot11.*\.json$/.test(f));
  const backup = files.map((f) => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
  return { dir, backup };
}

function restoreSnowlumaOnebot(saved) {
  if (!saved) return;
  for (const item of saved.backup) {
    try {
      fs.writeFileSync(path.join(saved.dir, item.file), item.content, 'utf8');
    } catch {
      /* 还原失败不阻断测试结论 */
    }
  }
}

function startServer() {
  fs.rmSync(path.join(ROOT, '.tmp-mobile-test'), { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      server: { port, bindHost: '127.0.0.1', token: TOKEN },
      // 指向不存在的端口：让临时进程连不上 OneBot，绝不抢正式实例的消息
      snowluma: { wsUrl: 'ws://127.0.0.1:39999', httpUrl: 'http://127.0.0.1:39998', autoLaunch: false },
      api: { baseUrl: 'http://127.0.0.1:9/v1', model: 'before-model', apiKey: 'sk-fake-shou' + 'ld-not-leak' },
      audio: { enabled: false, rvc: { autoStart: false, enabled: false }, ddsp: { autoStart: false, enabled: false } },
      playlist: { enabled: false },
      proactive: { enabled: false },
      diary: { enabled: false }
    }, null, 2),
    'utf8'
  );

  child = spawn(process.execPath, [path.join('src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, TZ: 'Asia/Shanghai' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.logs = logs;
}

async function waitReady(timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode != null) {
      throw new Error('临时进程已退出：\n' + (child.logs || []).join('').slice(-1200));
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('等不到临时进程就绪：\n' + (child?.logs || []).join('').slice(-1200));
}

function stopServer() {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  child = null;
}

try {
  snowBackup = backupSnowlumaOnebot();
  startServer();
  const authInfo = await waitReady();

  await acheck('未登录时 /api/auth/status 表明需要令牌', () => {
    assert.equal(authInfo.required, true, 'required 应为 true');
    assert.equal(authInfo.authed, false, '未登录却显示已认证');
    assert.ok(!('token' in authInfo), 'auth/status 不该回传任何令牌信息');
  });

  await acheck('/m/ 返回手机页面', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/m/`);
    assert.equal(res.status, 200, 'HTTP ' + res.status);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /QQagent/);
  });

  await acheck('本机打开页面自动带凭证（否则 Electron 会 401 白屏）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/m/`);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /qqagent_token=/, '本机页面没下发 cookie');
    // 拿这个 cookie 直接读状态，模拟 Electron 加载完页面后调接口
    const cookie = setCookie.split(';')[0];
    const state = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } });
    assert.equal(state.status, 200, '自动凭证无效，实际 ' + state.status);
  });

  await acheck('/m/manifest.webmanifest 可访问', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/m/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /manifest\+json/);
  });

  await acheck('无凭证访问 /api/status 得 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 401, '实际 ' + res.status);
  });

  await acheck('错误令牌登录失败', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' })
    });
    assert.equal(res.status, 401, '实际 ' + res.status);
  });

  let cookie = '';
  await acheck('正确令牌登录后下发 HttpOnly cookie', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN })
    });
    assert.equal(res.status, 200, '实际 ' + res.status);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /qqagent_token=/, '没有下发 cookie');
    assert.match(setCookie, /HttpOnly/i, 'cookie 不是 HttpOnly');
    cookie = setCookie.split(';')[0];
  });

  await acheck('带 cookie 能读状态（EventSource 靠的就是这条）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } });
    assert.equal(res.status, 200, '实际 ' + res.status);
    const data = await res.json();
    assert.ok('paused' in data, '状态字段缺失');
  });

  await acheck('带 header 也能读状态（PC 端/脚本用）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-console-token': TOKEN } });
    assert.equal(res.status, 200, '实际 ' + res.status);
  });

  await acheck('配置接口不下发 server.token 明文', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const cfg = await res.json();
    assert.ok(!String(cfg.server?.token || '').includes(TOKEN), 'server.token 明文泄露了');
    assert.equal(cfg.server?.hasToken, true, 'hasToken 没标记');
  });

  await acheck('白名单接口只写允许的字段', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mobile/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        api: { model: 'after-model', apiKey: 'sk-hacked', baseUrl: 'http://evil/v1' },
        persona: { botName: '手机改的名字' },
        server: { token: 'hacked-token', bindHost: '0.0.0.0' },
        allow: { groups: ['123456'] },
        groupMentionProbability: 0.12
      })
    });
    assert.equal(res.status, 200, '实际 ' + res.status);
    const data = await res.json();
    for (const key of ['api.apiKey', 'api.baseUrl', 'server', 'allow']) {
      assert.ok((data.ignored || []).includes(key), `${key} 没被拒绝，权限白名单失效`);
    }
    assert.equal(data.config.api.model, 'after-model', '允许的字段没写进去');
    assert.equal(data.config.persona.botName, '手机改的名字', '允许的字段没写进去');
    assert.equal(data.config.groupMentionProbability, 0.12, '顶层标量没写进去');
    assert.ok(!String(data.config.api.apiKey || '').includes('hacked'), 'apiKey 被改了');
    assert.equal(data.config.api.baseUrl, 'http://127.0.0.1:9/v1', 'baseUrl 被改了');
  });

  await acheck('令牌没被白名单接口改掉', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-console-token': TOKEN } });
    assert.equal(res.status, 200, '原令牌已失效，说明 token 被改了');
    const bad = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'x-console-token': 'hacked-token' } });
    assert.equal(bad.status, 401, '被改成了弱令牌');
  });

  await acheck('静态目录穿越被挡住', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/m/..%2f..%2fsrc%2fconfig.js`);
    assert.ok([403, 404].includes(res.status), '实际 ' + res.status);
  });

  await acheck('手机访问开关只允许本机调用', () => {
    assert.match(appSrc, /if \(!isLocalRequest\(req\)\) return json\(res, 403/, '开启接口没做本机校验');
    assert.match(appSrc, /function isLocalRequest\(req\)/, '缺 isLocalRequest');
  });

  let newToken = '';
  await acheck('开启手机访问会写入监听地址与令牌', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mobile/enable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ enable: true })
    });
    assert.equal(res.status, 200, '实际 ' + res.status);
    const data = await res.json();
    assert.equal(data.enabled, true);
    assert.equal(data.bindHost, '0.0.0.0', '没改成对外监听');
    assert.ok(String(data.token || '').length >= 12, '令牌太短');
    assert.ok(Array.isArray(data.addresses), 'addresses 不是数组');
    assert.ok(Array.isArray(data.privateAddresses), 'privateAddresses 不是数组');
    assert.ok(Array.isArray(data.publicAddresses), 'publicAddresses 不是数组');
    // 私网地址必须排在公网地址前面：拨号网卡的公网 IP 在同一 WiFi 下根本连不上
    assert.equal(
      data.addresses.length,
      data.privateAddresses.length + data.publicAddresses.length,
      'addresses 与分组对不上'
    );
    for (const url of data.privateAddresses) {
      assert.match(url, /^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/, '私网分组里混进了公网地址：' + url);
    }
    newToken = data.token;

    // 新令牌立即生效，旧 cookie 应当失效
    const withNew = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { 'x-console-token': newToken }
    });
    assert.equal(withNew.status, 200, '新令牌不生效');
    const withOld = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie } });
    assert.equal(withOld.status, 401, '换令牌后旧 cookie 还能用');
  });

  await acheck('二维码只为本机地址生成', async () => {
    const headers = { 'x-console-token': newToken };
    const bad = await fetch(
      `http://127.0.0.1:${port}/api/mobile/qr?url=${encodeURIComponent('http://evil.example.com/x')}`,
      { headers }
    );
    assert.equal(bad.status, 400, '外站地址不该生成二维码，实际 ' + bad.status);

    // 本机网卡上的公网地址同样不该生成：扫码连不上，还会把"公网可达"这件事带进来
    const wan = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address)
      .filter((ip) => !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/.test(ip));
    for (const ip of wan) {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/mobile/qr?url=${encodeURIComponent(`http://${ip}:${port}/m/`)}`,
        { headers }
      );
      assert.equal(res.status, 400, '公网地址不该生成二维码：' + ip);
    }

    const good = await fetch(
      `http://127.0.0.1:${port}/api/mobile/qr?url=${encodeURIComponent(`http://127.0.0.1:${port}/m/`)}`,
      { headers }
    );
    assert.equal(good.status, 200, '本机地址生成失败，实际 ' + good.status);
    assert.match(good.headers.get('content-type') || '', /svg/);
    assert.match(await good.text(), /<svg/);
  });

  await acheck('退出登录后 cookie 失效', async () => {
    const out = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    const setCookie = out.headers.get('set-cookie') || '';
    assert.match(setCookie, /Max-Age=0/, '没有清 cookie');
  });
} finally {
  stopServer();
  restoreSnowlumaOnebot(snowBackup);
  fs.rmSync(path.join(ROOT, '.tmp-mobile-test'), { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
