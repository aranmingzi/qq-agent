// 重启按钮的自检：只验"接线"，不真的重启（真重启会掐掉 NapCat / RVC，不能在测试里干）。
//   · 后端：/api/restart 路由、status 里的进程身份、stop() 要断 SSE 并释放端口
//   · 桌面端：宿主注入 restartHook，并用 app.relaunch 换进程
//   · 面板：按钮存在、用 startedAt 判断"新进程起来了"、旧进程 404 时有明确提示
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const appSrc = read('src/app.js');
const uiHtml = read('ui/index.html');
const uiJs = read('ui/app.js');
const electronMain = read('electron/main.js');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

console.log('重启按钮');

ok('后端有 POST /api/restart 路由', () => {
  assert.match(appSrc, /pathname === '\/api\/restart' && method === 'POST'/);
});

ok('先回响应再停服（否则面板读到的是被掐断的连接）', () => {
  const i = appSrc.indexOf("pathname === '/api/restart'");
  const block = appSrc.slice(i, i + 700);
  assert.match(block, /json\(res, 200, \{ ok: true, restarting: true/);
  assert.match(block, /setTimeout\(/);
  assert.ok(block.indexOf('json(res') < block.indexOf('restart({'));
});

ok('/api/status 暴露本进程身份（startedAt / pid）', () => {
  const i = appSrc.indexOf("pathname === '/api/status'");
  const block = appSrc.slice(i, i + 400);
  assert.match(block, /startedAt/);
  assert.match(block, /pid: process\.pid/);
});

ok('stop() 会断开 SSE 并释放端口（否则新进程抢不到 3210）', () => {
  // 以前这里是 slice(i, i + 900) —— 在 stop() 里加两行注释就会把 closeAllConnections
  // 挤出窗口，测试变红而代码完全正确。按函数边界取，加多少行都不影响。
  const i = appSrc.indexOf('async function stop()');
  const end = appSrc.indexOf('\n  async function ', i + 10);
  const block = appSrc.slice(i, end > 0 ? end : i + 3000);
  assert.match(block, /sseClients/);
  assert.match(block, /closeAllConnections/);
  assert.match(block, /server\.close\(/);
});

ok('restart() 先关 NapCat 进程树（只 kill 子进程会留孤儿占 3001）', () => {
  const i = appSrc.indexOf('async function restart(');
  const block = appSrc.slice(i, i + 900);
  assert.ok(block.indexOf('stopSnowluma()') < block.indexOf('stop()'));
  assert.match(block, /restarting/);
});

ok('restart/setRestartHook 已导出', () => {
  assert.match(appSrc, /return \{[^}]*\brestart\b/);
  assert.match(appSrc, /setRestartHook/);
});

ok('桌面端注入了 restartHook，并用 app.relaunch 换进程', () => {
  assert.match(electronMain, /restartHook:/);
  assert.match(electronMain, /app\.relaunch\(/);
  assert.match(electronMain, /app\.exit\(0\)/);
});

ok('托盘也有重启入口', () => {
  assert.match(electronMain, /label: '重启 QQ Agent'/);
});

ok('面板顶栏有重启按钮', () => {
  assert.match(uiHtml, /id="restart-btn"/);
});

ok('面板用 startedAt 变化判断重启完成，而不是"能连上就算好了"', () => {
  assert.match(uiJs, /waitRestarted/);
  assert.match(uiJs, /s\.startedAt/);
  assert.match(uiJs, /!== Number\(prevStartedAt\)/);
});

ok('旧进程没有重启接口时给出明确提示，不干等超时', () => {
  assert.match(uiJs, /error\?\.status\) === 404/);
});

ok('重启前要用户确认（会打断正在处理的消息）', () => {
  assert.match(uiJs, /confirm\(/);
});

console.log(`\n通过 ${pass} 项`);
