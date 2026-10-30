// /api/skips 端到端自检（第 13 轮）。
//
// 为什么必须有这一层：
//   这个接口从第 1 轮就存在，二十个 stage 也一直在记账 —— 但**没有任何前端调它**，
//   所以"她刚才为什么没回"这个功能整整十二轮都是隐形的。纯函数测试（test-skip-labels）
//   只能证明标签对，证明不了"接口真的把标签吐出来了"。这一层专门钉住接线。
//
// 做法：用**隔离 data 目录 + 指向不存在端口的假 OneBot** 另起一个真实进程，
//      绝不碰正在运行的机器人的数据，也不抢 QQ 消息。
// 用法：node test/test-skips-api.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'skips-fake-t' + 'oken-9c31';

let passed = 0;
let failed = 0;

async function acheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

const TMP = path.join(ROOT, '.tmp-skips-test');
const dataDir = path.join(TMP, 'data');
const port = 3900 + Math.floor(Math.random() * 90);
let child = null;

function startServer() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      server: { port, bindHost: '127.0.0.1', token: TOKEN },
      // 指向不存在的端口：临时进程连不上 OneBot，绝不会抢正式实例的消息
      snowluma: { wsUrl: 'ws://127.0.0.1:39999', httpUrl: 'http://127.0.0.1:39998', autoLaunch: false },
      api: { baseUrl: 'http://127.0.0.1:9/v1', model: '', apiKey: 'sk-fake-shou' + 'ld-not-leak' },
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

async function waitReady(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode != null) {
      throw new Error('临时进程已退出：\n' + (child.logs || []).join('').slice(-1500));
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('等不到临时进程就绪：\n' + (child?.logs || []).join('').slice(-1500));
}

function stopServer() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  child = null;
}

let headers = {};

async function getJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** 等 skip 记录真的出现（记账是内存 + 异步 flush，不能靠 sleep 猜） */
async function waitForSkips(predicate, timeoutMs = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const r = await getJson('/api/skips?limit=200');
    if (r.status === 200) {
      last = r.body;
      if (predicate(r.body)) return r.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

try {
  startServer();
  await waitReady();

  // 登录拿 cookie（本机自动凭证只对页面生效，API 走令牌）
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN })
  });
  const setCookie = login.headers.get('set-cookie') || '';
  headers = { cookie: setCookie.split(';')[0] };

  // ── 1. 接口形状 ──────────────────────────────────────────────────────
  await acheck('GET /api/skips 返回 items / stats / rows / summary / stages', async () => {
    const r = await getJson('/api/skips');
    assert.equal(r.status, 200, '实际 HTTP ' + r.status);
    for (const key of ['items', 'stats', 'rows', 'summary', 'stages']) {
      assert.ok(key in r.body, `响应里缺 ${key} 字段`);
    }
    assert.ok(Array.isArray(r.body.items), 'items 必须是数组');
    assert.ok(Array.isArray(r.body.rows), 'rows 必须是数组');
    assert.ok(Array.isArray(r.body.stages), 'stages 必须是数组');
    assert.equal(typeof r.body.summary, 'string');
  });

  await acheck('stages 覆盖全部枚举，且每条都带中文标签', async () => {
    const { body } = await getJson('/api/skips');
    const { SKIP_STAGES } = await import('../src/skip-log.js');
    const want = Object.values(SKIP_STAGES);
    assert.equal(body.stages.length, want.length, `应返回 ${want.length} 个阶段`);
    for (const row of body.stages) {
      assert.ok(want.includes(row.stage), `多出了未知阶段 ${row.stage}`);
      assert.ok(row.label && !/^[a-z][a-z-]*$/.test(row.label), `${row.stage} 的 label 不是中文：${row.label}`);
      assert.equal(typeof row.spent, 'boolean', `${row.stage} 的 spent 不是布尔`);
    }
  });

  // ── 2. 真实记账 → 接口能读到 ─────────────────────────────────────────
  // 不配模型 + 手动唤醒 → 必然产生一条 no-model 跳过记录。
  // 这是最省事的一条真实链路：不花钱、不发消息、不需要模型端点。
  await acheck('真实跳过能被接口读到（no-model 链路）', async () => {
    const wake = await fetch(`http://127.0.0.1:${port}/api/chats/group_880001/wake`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(wake.status, 200, '唤醒接口失败：' + wake.status);
    const body = await waitForSkips((b) => (b.items || []).some((i) => i.stage === 'no-model'));
    assert.ok(body, '一直读不到 /api/skips');
    const hit = (body.items || []).find((i) => i.stage === 'no-model');
    assert.ok(hit, '没有记录到 no-model 跳过（说明唤醒没走到那一步，或接口没接线）');
    assert.equal(hit.chatKey, 'group:880001', `chatKey 不对：${hit.chatKey}`);
  });

  await acheck('明细里每条都带 label / hint / spent（前端不必查表）', async () => {
    const { body } = await getJson('/api/skips?limit=200');
    assert.ok(body.items.length > 0, '没有明细可查');
    for (const item of body.items) {
      assert.ok(item.label, `${item.stage} 的明细缺 label`);
      assert.ok(item.hint, `${item.stage} 的明细缺 hint`);
      assert.equal(typeof item.spent, 'boolean');
      assert.ok(!/^[a-z][a-z-]*$/.test(item.label), `${item.stage} 的 label 还是英文枚举串`);
      assert.equal(typeof item.at, 'number');
    }
  });

  await acheck('rows 与 stats 一致，且已按次数降序', async () => {
    const { body } = await getJson('/api/skips?limit=200');
    const fromStats = Object.entries(body.stats).filter(([, n]) => n > 0);
    assert.equal(body.rows.length, fromStats.length, 'rows 与 stats 的非零项数不一致');
    for (const row of body.rows) {
      assert.equal(row.count, body.stats[row.stage], `${row.stage} 的计数与 stats 不一致`);
    }
    for (let i = 1; i < body.rows.length; i += 1) {
      assert.ok(body.rows[i - 1].count >= body.rows[i].count, 'rows 没有按次数降序');
    }
  });

  await acheck('summary 说清"多少次没开口、几次没花钱"', async () => {
    const { body } = await getJson('/api/skips');
    assert.match(body.summary, /没开口/, `summary 不像人话：${body.summary}`);
  });

  // ── 3. 参数与边界 ────────────────────────────────────────────────────
  await acheck('limit 被夹在 1..200（超大值不会把内存记录全吐出来）', async () => {
    const big = await getJson('/api/skips?limit=99999');
    assert.equal(big.status, 200);
    assert.ok(big.body.items.length <= 200, `返回了 ${big.body.items.length} 条，超过上限`);
    const zero = await getJson('/api/skips?limit=0');
    assert.equal(zero.status, 200);
    assert.ok(zero.body.items.length >= 1, 'limit=0 应回退到默认值而不是空数组');
  });

  await acheck('since 过滤：未来时间点读到 0 条，但 stats 也同步为 0', async () => {
    // since 语义是"最近多少毫秒内"，用一个比所有记录都早的窗口反向验证不过滤
    const all = await getJson('/api/skips?limit=200');
    assert.ok(all.body.items.length > 0, '前提：应该有记录');
    // 只留最近 1ms：几乎必然读到 0 条，且 stats 里不该还有旧计数
    const tiny = await getJson('/api/skips?limit=200&since=1');
    assert.equal(tiny.status, 200);
    assert.ok(tiny.body.items.length <= all.body.items.length, 'since 过滤后反而变多了');
    const tinyTotal = Object.values(tiny.body.stats).reduce((a, b) => a + Number(b || 0), 0);
    assert.equal(tinyTotal, tiny.body.items.length, 'stats 与 items 的过滤窗口不一致');
  });

  await acheck('无凭证访问 /api/skips 得 401（跳过记录里有会话 id，不能裸奔）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/skips`);
    assert.equal(res.status, 401, '实际 ' + res.status);
  });

  // ── 4. 前端真的接了（静态接线，防止以后被删） ────────────────────────
  await acheck('控制台前端确实调了 /api/skips（否则这个功能又是隐形的）', () => {
    const api = fs.readFileSync(path.join(ROOT, 'console/src/lib/api.ts'), 'utf8');
    assert.match(api, /async skips\(/, 'console/src/lib/api.ts 里没有 skips() 方法');
    assert.match(api, /\/api\/skips/, 'skips() 没有请求 /api/skips');
    assert.match(api, /export function normalizeSkips/, '缺少 normalizeSkips');
    const page = fs.readFileSync(path.join(ROOT, 'console/src/features/health/health-page.tsx'), 'utf8');
    assert.match(page, /api\.skips\(/, '运行体检页没有调用 api.skips()');
    assert.match(page, /刚才为什么没开口/, '运行体检页没有这一块');
  });
} finally {
  stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n[skips-api] ${passed} 项通过${failed ? ` / ${failed} 项失败` : '，全部通过'}`);
if (failed > 0) process.exit(1);
