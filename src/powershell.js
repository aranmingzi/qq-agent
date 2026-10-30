// 异步跑 PowerShell，返回 { status, stdout, stderr, error, timedOut }。
//
// ★ 为什么必须异步：Windows 上 `powershell.exe` 光启动就要 ~1 秒（本机实测
//   884~1222ms，命令还只是 `echo hi`）。`spawnSync` 会把这 1 秒整个算在事件循环上 ——
//   期间这个进程收不到任何 HTTP 请求、发不出任何 ws 消息、心跳也可能超时。
//
//   实测（同一台机器，QQ 通话看门狗 autoAnswer 打开时）：
//     - 每个 HTTP 请求，连 1.4KB 的静态 HTML，都固定等 2.3~5.0 秒
//     - 事件循环每 1.2 秒被占住 1.1~1.3 秒，几乎没空档
//     - 同样两个子进程改用 spawn 之后，事件循环最大阻塞 0ms
//
// 和 src/sing-song.js 的 runProcess 是同一个教训（那边是渲染冻住事件循环），
// 但这里不能直接复用：它把 stdout 截到末尾 8000 字节，而 UIA 全量扫描的输出
// 实测 7108 字节，贴着上限 —— 截断会得到半截 JSON，比报错更难查。
//
// 编码：显式按 UTF-8 解。中文 Windows 的默认代码页是 GBK，脚本里必须自带
// [Console]::OutputEncoding = UTF8（各 buildXxxScript 都已经有这一行）。
import { spawn } from 'node:child_process';

export function runPowerShell(script, { timeout = 15000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ status: -1, stdout: '', stderr: '', error, timedOut: false });
      return;
    }

    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        ...result
      });
    };

    // 超上限就停止累积，但已经到手的不丢 —— 半截输出配一句说明比空字符串好查。
    child.stdout?.on('data', (chunk) => {
      if (outBytes >= maxBytes) return;
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk) => {
      if (errBytes >= maxBytes) return;
      err.push(chunk);
      errBytes += chunk.length;
    });

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* 可能已经退出 */ }
      }, timeout);
      timer.unref?.();
    }

    child.on('error', (error) => finish({ status: -1, error }));
    child.on('close', (status) => finish({ status, error: null }));
  });
}
