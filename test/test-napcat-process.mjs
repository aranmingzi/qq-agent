// SnowLuma/NapCat 网关的进程定位判据（单元测试；不真杀任何进程）
//
// 钉的是"点了关闭却关不掉"这个 bug 的成因：
//   ① 端口判据写死 3000/3001/6099，而实际端口可配置、NapCat 冲突时还会随机换
//   ② 端口扫描被 `if ($candidates.Count -eq 0)` 包住，一条空壳 PID 就能把它顶掉
//   ③ 只收服务端端口（客户端端口是连别人的，反查 LISTEN 会杀错人）
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNapcatProcessScript, resolveNapcatPorts } from '../src/napcat-process.js';
import { readConfiguredPorts } from '../src/napcat-onebot-config.js';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-napcatproc-'));
const write = (dir, name, data) => {
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
};

// ── ① 端口从配置读，不写死 ──────────────────────────────────────────────
{
  const dir = mk();
  write(dir, 'onebot11.json', {
    network: {
      httpServers: [{ name: 'QQAgent HTTP', enable: true, port: 3002 }],
      websocketServers: [{ name: 'QQAgent WebSocket', enable: true, port: 3003 }],
      httpSseServers: [{ name: 'sse', enable: true, port: 3004 }],
      httpClients: [{ name: 'c', enable: true, port: 8080 }],      // 连别人的，不该收
      websocketClients: [{ name: 'wc', enable: true, port: 8081 }] // 同上
    }
  });
  write(dir, 'onebot11_123456.json', {
    network: { httpServers: [{ enable: false, port: 3999 }], websocketServers: [{ enable: true, port: 4001 }] }
  });
  write(dir, 'webui.json', { port: 6099, disableWebUI: false });

  const r = readConfiguredPorts(dir);
  assert.ok(r.ports.includes(3002) && r.ports.includes(3003) && r.ports.includes(3004), '服务端端口要收：' + r.ports);
  assert.ok(r.ports.includes(4001), '按账号配置的端口也要收');
  assert.ok(r.ports.includes(6099), 'WebUI 端口要收');
  assert.ok(!r.ports.includes(8080) && !r.ports.includes(8081), '客户端端口绝不能收（会杀到被连的程序）');
  assert.ok(!r.ports.includes(3999), 'enable:false 的服务端不算在监听');
  assert.ok(r.ports.includes(3000) && r.ports.includes(3001), '读不到配置时要有默认端口兜底');
}

// ── ② 只认配置正身，不认 .bak 备份 ──────────────────────────────────────
// 备份里存着历代随机端口（本机见过 50018/54563/58909/60223…），混进来等于拿过期判据去杀进程
{
  const dir = mk();
  write(dir, 'onebot11.json', { network: { httpServers: [{ enable: true, port: 3002 }], websocketServers: [] } });
  write(dir, 'onebot11_123456.json.bak-2026-10-22T11-06-40', {
    network: { httpServers: [{ enable: true, port: 54563 }], websocketServers: [{ enable: true, port: 54564 }] }
  });
  const r = readConfiguredPorts(dir, { fallback: [] });
  assert.deepStrictEqual(r.ports, [3002], '历史备份里的随机端口不能进判据：' + r.ports);
}

// ── ③ disableWebUI 时不拿 6099 当判据 ───────────────────────────────────
{
  const dir = mk();
  write(dir, 'webui.json', { port: 6099, disableWebUI: true });
  const r = readConfiguredPorts(dir, { fallback: [] });
  assert.ok(!r.ports.includes(6099), 'WebUI 关掉了就不该按它的端口找进程');
}

// ── ④ 端口扫描必须无条件执行（不能被 embeddedPid 顶掉）──────────────────
{
  const dir = mk();
  const withPid = buildNapcatProcessScript({ dir, embeddedPid: 12345, ports: [3002, 3003], kill: true });
  assert.ok(!withPid.includes('if ($candidates.Count -eq 0)'), '端口扫描不能被 Count==0 包着');
  assert.ok(withPid.includes('Get-NetTCPConnection'), '给了 embeddedPid 也要照样扫端口');
  assert.ok(withPid.includes('@(3002,3003)'), '端口要真的进脚本');
  assert.ok(withPid.includes('taskkill.exe /F /T /PID'), 'kill=true 才带 taskkill');

  const dry = buildNapcatProcessScript({ dir, ports: [3002], kill: false });
  assert.ok(!dry.includes('taskkill'), 'kill=false 绝不能带 taskkill');
  assert.ok(dry.includes('exit 0'), '正常路径要显式 exit 0（PowerShell 的 exit code 噪声很大）');
}

// ── ⑤ 进程名白名单：只认 QQ / QQNT / NapCatWinBootMain ──────────────────
{
  const dir = mk();
  const s = buildNapcatProcessScript({ dir, ports: [3002], kill: true });
  assert.ok(s.includes("'QQ','QQNT','NapCatWinBootMain'"), '按端口找到的进程必须限定进程名，防止杀到无关程序');
  // PowerShell 5.1 解析不了"元素类型为 object 的泛型 List"，一写就整段 exit 1 且无 stderr
  assert.ok(!/\$matched\s*=\s*New-Object/.test(s), '$matched 不能用 New-Object 建泛型 List');
  assert.ok(/\$matched\s*\+=\s*\[pscustomobject\]/.test(s), '$matched 用数组 += 追加');
}

// ── ⑤b 必须上溯到 QQ 主进程（否则只是杀子进程，主进程一秒内又拉一个）─────
{
  const dir = mk();
  const s = buildNapcatProcessScript({ dir, ports: [3002], kill: true });
  assert.ok(s.includes('Resolve-QQRoot'), '要有上溯到主进程的函数');
  assert.ok(s.includes("Get-CimInstance Win32_Process"), '上溯要用进程父子关系');
  assert.ok(s.includes("'--type='"), '判据是"命令行不带 --type= 的那个 QQ 进程"才是主进程');
  assert.ok(s.includes('$targets = @($rootIds)'), '先杀主进程');
  assert.ok(s.includes('if ($targets.Count -eq 0) { $targets = @($ids) }'), '没解析出主进程才退回杀子进程');
}

// ── ⑥ 没端口时不生成端口扫描块（避免扫到一堆无关进程）────────────────────
{
  const dir = mk();
  const s = buildNapcatProcessScript({ dir, ports: [], kill: false });
  assert.ok(!s.includes('Get-NetTCPConnection'), '端口列表为空就别扫');
  const bad = buildNapcatProcessScript({ dir, ports: [0, -1, 99999, 'x', null], kill: false });
  assert.ok(!bad.includes('Get-NetTCPConnection'), '非法端口要被过滤掉');
}

// ── ⑦ extraPorts 与配置取并集 ───────────────────────────────────────────
{
  const dir = mk();
  write(dir, 'onebot11.json', { network: { httpServers: [{ enable: true, port: 3002 }], websocketServers: [] } });
  const r = resolveNapcatPorts({ dir, extraPorts: [3003, 3002, 'x', 0] });
  assert.ok(r.ports.includes(3002) && r.ports.includes(3003), 'extraPorts 要并进去：' + r.ports);
  assert.ok(!r.ports.some((p) => !Number.isInteger(p) || p <= 0), '非法端口要过滤');
  assert.strictEqual(r.ports.filter((p) => p === 3002).length, 1, '不能重复');
}

// ── ⑧ 真实环境冒烟（可选）：NAPCAT_PROC_LIVE=1 才跑，只看不杀 ────────────
if (process.env.NAPCAT_PROC_LIVE === '1') {
  const { findNapcatProcesses } = await import('../src/napcat-process.js');
  const dir = process.env.NAPCAT_PROC_LIVE_DIR || path.resolve(process.cwd(), 'snowluma');
  const r = findNapcatProcesses({ dir });
  assert.ok(Array.isArray(r.matched), 'matched 应是数组');
  assert.ok(r.ports.length > 0, '应解析出端口：' + r.ports);
  for (const m of r.matched) {
    assert.ok(m.root > 0, '每个命中的进程都要解析出主进程 root：' + JSON.stringify(m));
  }
  console.log('[live] ports=' + r.ports.join(',') + ' ids=' + r.ids.join(',') + ' roots=' + r.roots.join(',') +
    ' matched=' + JSON.stringify(r.matched));
}

console.log('test-napcat-process: OK');
