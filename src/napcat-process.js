import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfiguredPorts } from './napcat-onebot-config.js';

function psQuote(value) {
  return String(value || '').replace(/'/g, "''");
}

function parseUninstallExecutable(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const quoted = /^"([^"]+\.exe)(?:"|\s|$)/i.exec(value);
  const plain = /^([^\s]+\.exe)(?:\s|$)/i.exec(value);
  return quoted?.[1] || plain?.[1] || '';
}

/** 定位本机 QQ.exe。注册表优先，常见安装目录兜底；全过程不创建控制台窗口。 */
export function findQQExecutable() {
  if (process.platform !== 'win32') return '';
  const candidates = [];
  const addCandidate = (value) => {
    if (!value) return;
    const resolved = path.resolve(String(value));
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  const uninstallKeys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ'
  ];
  for (const key of uninstallKeys) {
    const result = spawnSync('reg.exe', ['query', key, '/v', 'UninstallString'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    if (result.status !== 0 || !result.stdout) continue;
    const match = /UninstallString\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/im.exec(String(result.stdout));
    const executable = parseUninstallExecutable(match?.[1]);
    if (executable) addCandidate(path.join(path.dirname(executable), 'QQ.exe'));
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  addCandidate(path.join(programFiles, 'Tencent', 'QQNT', 'QQ.exe'));
  addCandidate(path.join(programFilesX86, 'Tencent', 'QQNT', 'QQ.exe'));
  if (localAppData) {
    addCandidate(path.join(localAppData, 'Programs', 'Tencent', 'QQNT', 'QQ.exe'));
    addCandidate(path.join(localAppData, 'Tencent', 'QQNT', 'QQ.exe'));
  }

  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || '';
}

/**
 * 生成进程定位/结束脚本。
 *
 * 两条判据 **都无条件执行**（旧版是"前面没找到才扫端口"，一条空壳 PID 就能把扫描顶掉）：
 *   ① 进程名 + 路径：NapCatWinBootMain.exe（引导器，注入完通常就退了，不能只靠它）
 *   ② 监听端口 → owner：NapCat 是注入进 QQ.exe 的，真正承载网关的进程只能靠端口认
 * 端口从 NapCat 自己的配置读（见 readConfiguredPorts）——
 * 端口可配置、且 NapCat 冲突时会随机换，写死就等于让判据悄悄失效。
 */
export function buildNapcatProcessScript({ dir, embeddedPid = null, ports = [], kill = false, hookScan = true } = {}) {
  const target = psQuote(path.resolve(String(dir || '.'), 'NapCatWinBootMain.exe'));
  const pid = Number(embeddedPid) > 0 ? Math.floor(Number(embeddedPid)) : 0;
  const portList = (Array.isArray(ports) ? ports : [])
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  const portLiteral = portList.length ? portList.join(',') : '';
  return `
$ErrorActionPreference = 'SilentlyContinue'
$target = [System.IO.Path]::GetFullPath('${target}')
$candidates = New-Object System.Collections.Generic.List[int]
# $matched 用普通数组：PowerShell 5.1 解析不了"元素是 object 的泛型 List"，
# 一写就让整段脚本以 exit 1 结束、且没有任何 stderr —— 静默失败最坑
$matched = @()
if (${pid} -gt 0) { $candidates.Add(${pid}) }

# 一次查全 QQ 进程的父子关系与命令行：后面"上溯主进程""只查主进程的模块"都要用
$qqParent = @{}
$qqIsChild = @{}
Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | ForEach-Object {
  $id2 = [int]$_.ProcessId
  $qqParent[$id2] = [int]$_.ParentProcessId
  $qqIsChild[$id2] = ([string]$_.CommandLine -match '--type=')
}

Get-Process -Name 'NapCatWinBootMain' |
  Where-Object { $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq $target) } |
  ForEach-Object { $candidates.Add([int]$_.Id) }

${portLiteral ? `
$ports = @(${portLiteral})
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in $ports } |
  ForEach-Object {
    $proc = Get-Process -Id $_.OwningProcess
    if ($proc -and $proc.ProcessName -in @('QQ','QQNT','NapCatWinBootMain')) {
      $candidates.Add([int]$proc.Id)
      $matched += [pscustomobject]@{
        pid = [int]$proc.Id
        port = [int]$_.LocalPort
        name = [string]$proc.ProcessName
        via = 'port'
      }
    }
  }
` : ''}

# ── ③ 注入判据：QQ 主进程里加载了 NapCatWinBootHook.dll ───────────────
# 比端口更本质：端口要配置对、要真的起来了才认得出来，而"这个 QQ 被 NapCat 注入了"
# 跟端口无关。少了这条，没开 OneBot/WebUI 的那台会漏掉（它照样挂着 NapCat 的内部端口）。
# 只对主进程查模块（子进程几十个、枚举很慢，而且 Hook 只注入主进程）。
${hookScan ? `
foreach ($q in (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) {
  $qid = [int]$q.Id
  if ($qqIsChild[$qid]) { continue }
  $hooked = $false
  try {
    $hooked = (@($q.Modules | Where-Object { $_.ModuleName -match 'NapCat' }).Count -gt 0)
  } catch { $hooked = $false }
  if ($hooked) {
    $candidates.Add($qid)
    $matched += [pscustomobject]@{ pid = $qid; port = 0; name = [string]$q.ProcessName; via = 'hook' }
  }
}
` : ''}

$ids = @($candidates | Sort-Object -Unique)

# ── 上溯到 QQ 主进程 ──────────────────────────────────────────────────
# NapCat 实际跑在 QQ 的 node.mojom.NodeService **子进程**里。只杀它，
# QQ 主进程会在一秒内拉个新的出来、端口又被占上 —— 这就是"点了关闭、
# 面板也提示已关闭，但网关转眼又活了"的成因。要关就得关主进程。
# 判据：沿 ParentProcessId 往上走，直到某个 QQ 进程的命令行**不带 --type=**（即 browser 主进程）。
function Resolve-QQRoot {
  param([int]$StartId)
  $cur = $StartId
  for ($i = 0; $i -lt 12; $i++) {
    if (-not $qqParent.ContainsKey($cur)) { return $cur }
    if (-not $qqIsChild[$cur]) { return $cur }
    $next = [int]$qqParent[$cur]
    if ($next -le 0 -or -not $qqParent.ContainsKey($next)) { return $cur }
    $cur = $next
  }
  return $cur
}

$roots = @()
$resolved = @()
foreach ($m in @($matched)) {
  $r = Resolve-QQRoot -StartId ([int]$m.pid)
  $resolved += [pscustomobject]@{ pid = [int]$m.pid; port = [int]$m.port; name = [string]$m.name; root = [int]$r; via = [string]$m.via }
  $roots += [int]$r
}
foreach ($processId in $ids) {
  if (-not ($roots -contains $processId)) { $roots += Resolve-QQRoot -StartId ([int]$processId) }
}
$rootIds = @($roots | Sort-Object -Unique)

$killed = New-Object System.Collections.Generic.List[int]
$errors = New-Object System.Collections.Generic.List[string]
${kill ? `
# 杀主进程（/T 会带走它那整棵进程树）；没有匹配到端口时才退回杀 ids 本身
$targets = @($rootIds)
if ($targets.Count -eq 0) { $targets = @($ids) }
foreach ($processId in $targets) {
  $output = & taskkill.exe /F /T /PID $processId 2>&1
  if ($LASTEXITCODE -eq 0) { $killed.Add([int]$processId) }
  else {
    $detail = ($output | Out-String).Trim()
    $errors.Add("taskkill failed for pid " + $processId + " with exit code " + $LASTEXITCODE + ": " + $detail)
  }
}
` : ''}
@{ ids = $ids; roots = $rootIds; killed = @($killed); errors = @($errors); matched = @($resolved); ports = @(${portLiteral}) } |
  ConvertTo-Json -Compress -Depth 5
exit 0
`.trim();
}

/** PowerShell 的 ConvertTo-Json 会把单元素数组拍平成对象，这里统一还原成数组。 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

/**
 * 端口判据的默认来源：NapCat 自己配置里写的监听端口。
 * 调用方可以用 extraPorts 追加（例如设置里的 httpUrl/wsUrl），取并集、不互相覆盖。
 */
export function resolveNapcatPorts({ dir, extraPorts = [] } = {}) {
  const configured = readConfiguredPorts(dir);
  const merged = new Set(configured.ports);
  for (const p of asArray(extraPorts)) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n <= 65535) merged.add(n);
  }
  return { ports: [...merged].sort((a, b) => a - b), sources: configured.sources };
}

function runNapcatProcessCommand({ dir, embeddedPid = null, kill = false, ports = null } = {}) {
  if (process.platform !== 'win32') {
    return { ids: [], killed: [], errors: ['only supported on Windows'] };
  }
  const resolved = Array.isArray(ports) ? { ports, sources: [] } : resolveNapcatPorts({ dir });
  const script = buildNapcatProcessScript({ dir, embeddedPid, ports: resolved.ports, kill });
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  });
  const empty = (errors) => ({ ids: [], roots: [], killed: [], matched: [], ports: resolved.ports, sources: resolved.sources, errors });
  if (result.error) {
    return empty([String(result.error.message || result.error)]);
  }
  // 以 stdout 能不能解析出结果为准，不拿 exit code 当判据：
  // PowerShell 的 exit code 语义很松（非终止错误 / 中文输出的编码问题都会让它非 0），
  // 但只要拿到了合法 JSON，结果就是可信的。
  try {
    if (!String(result.stdout || '').trim()) {
      return empty([String(result.stderr || `PowerShell 没有返回结果（exit ${result.status}）`).trim()]);
    }
    const data = JSON.parse(String(result.stdout || '{}'));
    const killed = asArray(data.killed).map(Number).filter(Boolean);
    // port=0 也合法：那是"按 NapCat 注入"命中的，没有对上具体端口
    const matched = asArray(data.matched).map((m) => ({
      pid: Number(m?.pid) || 0,
      port: Number(m?.port) || 0,
      name: String(m?.name || ''),
      root: Number(m?.root) || 0,
      via: String(m?.via || '')
    })).filter((m) => m.pid > 0);
    return {
      ids: asArray(data.ids).map(Number).filter(Boolean),
      // 真正会被杀的是这些：命中的子进程沿父链上溯到的 QQ 主进程
      roots: asArray(data.roots).map(Number).filter(Boolean),
      killed,
      matched,
      ports: asArray(data.ports).map(Number).filter(Boolean),
      sources: resolved.sources,
      errors: asArray(data.errors).map(String).filter(Boolean)
    };
  } catch (error) {
    return empty([`无法解析进程查询结果：${error?.message ?? error}`]);
  }
}

export function findNapcatProcesses({ dir, embeddedPid = null, ports = null } = {}) {
  return runNapcatProcessCommand({ dir, embeddedPid, ports, kill: false });
}

export function stopNapcatProcesses({ dir, embeddedPid = null, ports = null } = {}) {
  const result = runNapcatProcessCommand({ dir, embeddedPid, ports, kill: true });
  return { ...result, stopped: result.killed.length > 0 };
}

/**
 * NapCat 启动参数：[QQ.exe, Hook.dll, ...可选 -q <QQ号>]。
 * 配了 accountQQ（且是纯数字）就带 `-q` 走快速登录，免去扫会过期的二维码。
 */
export function buildNapcatLaunchArgs({ qqExe = '', hookDll = '', accountQQ = '' } = {}) {
  const args = [String(qqExe || ''), String(hookDll || '')];
  const uin = String(accountQQ || '').trim();
  if (/^\d{5,12}$/.test(uin)) args.push('-q', uin);
  return args;
}
