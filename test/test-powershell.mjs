// PowerShell 调用必须异步。
//
// 为什么这个测试存在：
//   「打开控制台卡顿、页面加载不出来」的根因就是 spawnSync —— 本机实测
//   powershell.exe 单是启动就要 884~1222ms，spawnSync 会把 Node 的事件循环
//   整段冻住。QQ 通话看门狗 600ms 一轮、每轮一次扫描，于是进程**永远**在阻塞：
//   /console/（1388 字节）要等 3520ms，TCP 连上 1152ms 才有反应。
//   换成 async spawn 之后同样的请求是 2ms。
//
// 这个测试不测源码文本（那种断言改个变量名就假绿），而是**真的跑起来量**：
//   - 三条并发 PowerShell 的总耗时要明显短于串行和；
//   - 并发期间事件循环不能出现长停顿；
//   - 超时、非零退出码、stderr 都要能正常返回，不能把调用方挂在 Promise 上。
//
// 环境说明：非 Windows 直接跳过 —— 这个模块本来就是给 Windows 用的。
// 跳过也要打印一行，免得在 Linux CI 上看起来像"测试没了"。
import { runPowerShell } from '../src/powershell.js';

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

const isWindows = process.platform === 'win32';

if (!isWindows) {
  console.log(`\n[powershell] 非 Windows，跳过 ${3} 项（这个模块只在 win32 上有意义）`);
  process.exit(0);
}

// 事件循环采样：20ms 一次，记最大偏差。
function startSampler() {
  const state = { max: 0, samples: 0 };
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    state.max = Math.max(state.max, now - last - 20);
    state.samples += 1;
    last = now;
  }, 20);
  return {
    stop() { clearInterval(timer); return state; }
  };
}

await ok('runPowerShell 正常返回 stdout 和 status=0', async () => {
  const r = await runPowerShell('Write-Output hello');
  assertEqual(r.status, 0, '退出码');
  assert(r.stdout.includes('hello'), `stdout=${r.stdout}`);
  assertEqual(r.timedOut, false, '不该判定超时');
});

// 核心用例：这是整个修复的理由。改成 spawnSync 这一条必然红。
await ok('三条 PowerShell 能并发跑，且不冻住事件循环', async () => {
  const sampler = startSampler();
  const t0 = Date.now();
  const results = await Promise.all([
    runPowerShell('Start-Sleep -Milliseconds 300; Write-Output one'),
    runPowerShell('Start-Sleep -Milliseconds 300; Write-Output two'),
    runPowerShell('Start-Sleep -Milliseconds 300; Write-Output three')
  ]);
  const elapsed = Date.now() - t0;
  const { max } = sampler.stop();

  assertEqual(results.map((r) => r.stdout.trim()), ['one', 'two', 'three'], '三条都要拿到输出');
  // 串行的话：3 × (启动 ~900ms + 睡 300ms) ≈ 3600ms。并发只付一次启动 + 一次睡眠。
  assert(elapsed < 2200, `三条并发应明显快于串行，实际 ${elapsed}ms`);
  // 真正的判据。spawnSync 会留下一个约 1200~3600ms 的坑。
  // 200ms 以上的停顿在这台机器上只来自进程启动抢 CPU，不是阻塞。
  assert(max < 600, `事件循环被冻住 ${max}ms —— 很可能又退回 spawnSync 了`);
});

await ok('超时会杀掉子进程并标记 timedOut，不会永远挂着', async () => {
  const t0 = Date.now();
  const r = await runPowerShell('Start-Sleep -Seconds 30', { timeout: 500 });
  const elapsed = Date.now() - t0;
  assertEqual(r.timedOut, true, '应标记超时');
  assert(elapsed < 8000, `超时设置没生效，等了 ${elapsed}ms`);
});

await ok('非零退出码把 stderr 原样带回来（调用方要靠它给出可读原因）', async () => {
  const r = await runPowerShell('throw "boom-detail"');
  assertEqual(r.status, 1, '退出码应为 1');
  assert(/boom-detail/.test(r.stderr), `stderr 里应有原因：${r.stderr}`);
  assertEqual(r.timedOut, false, '这不是超时');
});

await ok('输出超过 maxBytes 时截断而不是让内存炸掉', async () => {
  // 1KB 上限，输出 200 行 ~ 20KB
  const r = await runPowerShell('1..200 | ForEach-Object { "line-$_-padding-padding" }', { maxBytes: 1024 });
  assertEqual(r.status, 0, '退出码');
  assert(r.stdout.length <= 1024 + 4096, `截断没生效，拿到 ${r.stdout.length} 字节`);
  assert(r.stdout.length > 0, '不该因为截断就完全没输出');
});

console.log(`\n[powershell] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
