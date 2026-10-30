// 回归守卫：真的把看门狗跑起来，量事件循环有没有被冻住。
//
// 为什么这个测试存在（这是用户报的那个 bug 的正面复现）：
//   修复前的现场是 —— QQ 通话看门狗 600ms 一轮，每轮 spawnSync 调一次 PowerShell
//   （启动就要 884~1222ms），于是进程**永远**在阻塞：
//     /console/（1388 字节）  3520ms
//     TCP 连上到有回调       1152ms
//     /api/chats             5017ms
//     事件循环 8 次 1054~1241ms 的停顿
//   换成异步之后同样的请求是 2ms、停顿 0 次。
//
// 为什么不直接断言接口耗时：接口慢也可能是别的慢（磁盘、长查询），
// 而"事件循环被冻住"是这类卡顿的**唯一共性**，且不会被无关改动误伤。
//
// 依赖真实 QQ：不依赖。扫不到窗口时 scanCallWindows 返回 ok=true + 空 windows，
// 这正是我们要的日常状态 —— 空转的看门狗也必须不卡。
import { createCallWatcher } from '../src/qq-call-answer.js';
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

if (process.platform !== 'win32') {
  console.log('\n[call-watchdog] 非 Windows，跳过（UIA 只存在于 Windows）');
  process.exit(0);
}

// 20ms 采样事件循环
function sampler() {
  const state = { max: 0, count: 0 };
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const dev = now - last - 20;
    if (dev > 150) state.count += 1;
    state.max = Math.max(state.max, dev);
    last = now;
  }, 20);
  return { stop() { clearInterval(timer); return state; } };
}

// ── 1. 看门狗真的跑起来，事件循环不能长时间冻住 ─────────────────────
await ok('看门狗跑 4 秒（600ms 一轮真跑 PowerShell），事件循环不被冻住', async () => {
  const s = sampler();
  const watcher = createCallWatcher({ intervalMs: 600 });
  watcher.start();
  await new Promise((r) => setTimeout(r, 4000));
  watcher.stop();
  const { max, count } = s.stop();
  const snap = watcher.snapshot();
  assert(snap.scans >= 2, `4 秒至少该扫 2 次，实际 ${snap.scans}`);
  // 每次 PowerShell 启动会抢一下 CPU，200~400ms 的抖动是正常的；
  // 但 spawnSync 的病征是「一次 1200ms 以上、且反复出现」，所以两条都查。
  assert(count === 0, `出现 ${count} 次 >150ms 的停顿（最长 ${max}ms）—— 事件循环又被冻住了`);
  assert(max < 600, `最长停顿 ${max}ms，超过 600ms 说明有同步阻塞`);
});

// ── 2. 一次扫描比间隔长时不能并发（重入锁的集成验证）─────────────────
await ok('扫描比间隔慢时，同一时刻只有一轮在跑（重入锁真的生效）', async () => {
  let inFlight = 0;
  let peak = 0;
  const watcher = createCallWatcher({
    intervalMs: 200, // 比一次扫描短得多
    scan: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 500));
      inFlight -= 1;
      return { ok: true, windows: [], errors: [] };
    },
    answer: () => ({ ok: true })
  });
  watcher.start();
  await new Promise((r) => setTimeout(r, 1600));
  watcher.stop();
  assertEqual(peak, 1, `并发峰值必须为 1，实际 ${peak}`);
});

// ── 3. 事件循环空闲时的基线（对照组）──────────────────────────────────
await ok('对照组：完全不跑看门狗时事件循环本来就稳（证明上面量到的停顿确实来自看门狗）', async () => {
  const s = sampler();
  await new Promise((r) => setTimeout(r, 2000));
  const { max } = s.stop();
  assert(max < 150, `空闲时本该几乎无抖动，实际 ${max}ms`);
});

console.log(`\n[call-watchdog] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
