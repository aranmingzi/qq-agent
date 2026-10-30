# 打开就卡死：真正的原因（spawnSync 冻住事件循环）

日期：2026-10-29
触发：「打开QQagent还是存在卡顿，无法加载的情况」（上一轮改的是前端电平条和 PCM 分片，那个改动本身是对的，但**不是**这个用户能感知到的卡顿的原因）。

---

## 1. 现象与误判

上一轮把「持续卡顿」归给前端：AudioWorklet 每 8ms 一帧 → 每秒 125 次 `setState` → 整页重渲染。这个诊断是真的，也修了（`PcmChunker` 100ms 分片、电平条改走 `requestAnimationFrame`、服务端 `LEVEL_PUSH_MS=50` 节流）。

但用户说**还是卡，而且是页面加载不出来**。这两件事指向完全不同的地方：125 次 `setState` 只会让**语音通话页**在通话中掉帧，不会让**任何页面**加载不出来。所以重新量。

## 2. 测量（全部是实测，不是推测）

### 2.1 所有请求一起慢，跟请求内容无关

| 请求 | 字节 | 耗时 |
|---|---|---|
| `/console/`（静态 HTML） | 1,388 | **3,520 ms** |
| `/assets/index-*.css` | 54,838 | 3,734 ms |
| `/api/status` | 1,355 | 4,518 ms |
| `/api/chats` | — | 5,017 ms |

1.4KB 的静态文件要 3.5 秒。**首字节**就要 3.3 秒。更关键的一条：**TCP 连上到回调被调度用了 1,152 ms** —— 环回连接的连接建立是内核完成的，必然是亚毫秒级，能慢到 1.1 秒只有一个解释：**进程根本没在跑事件循环**。

### 2.2 并发不排队，一起等

5 个并发的 `/console/` 请求全部在 3,759 ms 完成，整批耗时 3,760 ms。如果是队列积压，它们会依次完成（3.7s / 7.4s / 11s…）。是"同时被放行"而不是"排队" —— 典型的**事件循环阻塞后集中恢复**。

### 2.3 事件循环采样

50ms 定时器量偏差：12 秒内 **8 次 1054~1241 ms 的停顿**；另一次采样 **21 次 >150ms**，每次 1086~1298 ms。

### 2.4 定位到具体回调

包装 `setInterval`/`setTimeout` 给每个回调计时，慢回调只有一类：

```
11× interval(600ms) @ at Object.start (file:///C:/QQagent/src/qq-call-answer.js:464:15)
   最慢 1314 ms
```

`src/qq-call-answer.js` 里 600ms 的 QQ 通话看门狗，每一轮都调 `spawnSync` 跑 PowerShell。

### 2.5 对照组

把 `QQ_AGENT_DATA_DIR` 指到一个临时目录（`call.enabled=false`，看门狗不起），**同一个探针**：

```
/console/         15 ms
慢回调             0 次
```

差异只有这一个变量。

### 2.6 PowerShell 到底多贵

| 命令 | 耗时 |
|---|---|
| `powershell.exe -NoProfile -Command "echo hi"` | **884~1222 ms** |
| `spawnSync` × 2 | 事件循环冻结 **1769 ms** |
| 同样两个子进程改用 `spawn` | **0 ms** |
| `cmd /c echo` | 125 ms |
| 真实 UIA 扫描脚本（`buildCallScanScript`） | 1366 / 1412 / 1584 ms |
| `Get-PnpDevice -Class AudioEndpoint`（`listAudioDevices`） | **3577~4137 ms** |

`src/napcat-process.js:215`、`src/ddsp-voice.js:140`、`src/rvc-voice.js:187`、`src/svc-voice.js:159` 都是同一个 `spawnSync` 模式 —— 但它们都是**一次性启动检查**，不是常驻轮询，所以只有 QQ 通话这条链路出问题。

### 2.7 三个成本叠加

1. 看门狗 600ms 一轮，每轮 `spawnSync` 一次 UIA 扫描 ≈ 1.4 秒 → **进程 100% 时间在阻塞**；
2. `/api/call/status` 里同步调 `listAudioDevices()`，**一次 3.5~4.1 秒**，而两个通话面板每次打开都会调它；
3. 面板保存配置后会立刻重读状态，把第 2 条再来一遍。

## 3. 改了什么

### 3.1 新增 `src/powershell.js`（异步底座）

`runPowerShell(script, {timeout, maxBytes})` → `Promise<{status, stdout, stderr, error, timedOut}>`，内部用 `spawn` + `-NoProfile -NonInteractive`，超时 `kill()`、`maxBytes` 截断但保留已到手的内容、`settled` 标志保证只 resolve 一次。

不直接复用 `src/sing-song.js:25` 的 `runProcess`：它把 stdout 截到末尾 **8000 字节**，而 UIA 全量扫描实测输出 **7108 字节**，贴着上限 —— 截断会得到半截 JSON，比报错更难查。

### 3.2 两个模块的 runner 改成异步

- `src/qq-call-answer.js`：`defaultRunner` → `runPowerShell`；`scanCallWindows` / `invokeAnswer` 变 `async`。
- `src/audio-devices.js`：同上，`listAudioDevices` 变 `async`。

`createCallWatcher` 的 `check()` 本来就是 `await scan(...)`，不用改。

### 3.3 重入锁（异步化带来的新风险）

以前 `spawnSync` 期间事件循环是**死**的，600ms 的定时器不可能在上一次扫完前进第二轮 —— 重入天然不存在。改成异步后这个前提没了：一次扫描 1.4 秒 > 600ms 间隔，**不锁就会并发起一堆 PowerShell**，每个都在抢 UIA 的 COM 单线程，反而更慢，还会让「已点过」的冷却判断错乱。

```js
let inFlight = null;
async function check() {
  if (inFlight) return { action: 'busy', reason: '上一轮扫描还没结束' };
  inFlight = doCheck();
  try { return await inFlight; } finally { inFlight = null; }
}
```

不排队，直接跳过 —— 排队的话来电高峰期会积压几十轮。

### 3.4 `/api/call/status` 的设备枚举加缓存 + 启动预热

`audioDevicesCached()`：30 秒软过期，**过期也给旧值**同时在后台重查。理由是硬过期等于把 4 秒的等待随机分配给某次打开面板；设备插拔本来也不是打开面板那一刻发生的事。

`start()` 里在端口刚起来时就 `void audioDevicesCached()` 预热（不 await），用户打开面板时缓存已经填好。

`/api/call/devices?fresh=1` 强制重查（刚插声卡 / 刚装完 VB-Cable 时用）。

五处接口加了 `await`：`/api/call/{status,probe,answer,devices}`。

## 4. 验证

### 4.1 同一台机器，同一个探针

| 请求 | 改前 | 改后 |
|---|---|---|
| `/console/`（1,388 B） | 3,520 ms | **2 ms** |
| `/api/status` | 4,518 ms | **2 ms** |
| `/api/call/status`（缓存命中） | — | **1 ms** |
| `/api/chats` | 5,017 ms | **2 ms** |
| TCP 连上到首字节 | 1,152 ms | — |

事件循环：**>150ms 的停顿 0 次，最长 0ms**（改前 8~21 次，每次 1.0~1.3 秒）。

### 4.2 runPowerShell 单独证明

三条并发 PowerShell（各睡 300ms）：

```
总耗时 1,844 ms   （串行应 >2,400 ms）
事件循环最长停顿 216 ms   （同步版是 1,769 ms）
超时用例：timedOut=true
抛错用例：status=1, stderr 含 boom
```

216ms 是 Windows 进程启动抢 CPU 的抖动，不是阻塞 —— 同步版会留下一个连续的 1.7 秒大坑。

### 4.3 新测试

- `test/test-powershell.mjs`（5 项）：正常返回、**三条并发且不冻事件循环**、超时杀进程、非零退出码带 stderr、`maxBytes` 截断。
- `test/test-call-watchdog-nonblocking.mjs`（3 项）：看门狗**真跑 4 秒**（真调 PowerShell）期间事件循环零停顿、扫描比间隔慢时并发峰值为 1、空闲对照组。
- `test/test-qq-call-answer.mjs` +1 项（共 48）：重入锁 —— 上一轮没结束时第二轮返回 `busy`、`scan` 并发峰值为 1、锁能释放。
- `test/test-qq-call-answer.mjs` / `test/test-call-devices.mjs` 加了 `await`（7 + 5 处）。

### 4.4 变异（3 个全被抓到）

| 变异 | 结果 |
|---|---|
| 删掉重入锁的 `if (inFlight)` | ✅ 3 项红 |
| 锁永不释放（`finally` 里不清空） | ✅ 3 项红 |
| `runPowerShell` 改回 `spawnSync` | ✅ powershell 1 项红 + watchdog 1 项红 |

### 4.5 全套

`npm test` → **EXIT=0，1438 ✓，99 条命令**。

## 5. 残留

- **`src/napcat-process.js:215` 等 4 处仍是 `spawnSync`**。它们不在热路径上，但如果将来有谁把它们改成轮询，同样的卡顿会回来。已在 `src/powershell.js` 头部注释里写清这个教训。
- **UIA 扫描一轮 1.4 秒**。异步化之后它不再阻塞进程，但来电检测的固有延迟仍有 1.4 秒 —— 想更快只能换成「事件钩子 + 只在有窗口变化时扫」，代价是复杂度和稳定性，这一轮不做。
- **音频设备枚举一次 3.5~4.1 秒**，靠缓存遮住。真正的解法是换成 `MMDeviceEnumerator` 的 COM 调用或开机时枚举一次存盘，不在这一轮范围。
- 只在**本机**验证过。其它机器上 PowerShell 的启动开销可能不同（尤其是装了杀毒软件实时扫描 `powershell.exe` 的），但「异步 vs 同步」的结论与机器无关。
