// QQ 通话自动接听（"手"）
//
// 为什么必须走 UIA，而不是协议：
//   QQ 的通话走闭源 AVSDK→NTRTC，NapCat / Lagrange / 官方频道 API 全都没有接口
//   （NapCat 的完整 action 列表里 avsdk/voice_call/video_call 命中数为 0）。
//   ohwhale-deploy 的 scripts/call_agent.py 开头写得很直白：
//     「QQ 9.9.35 带了 --remote-debugging-port 参数，但进程里没有 DevToolsActivePort，
//       端口也不监听 —— 腾讯把这个口子关掉了。UIA 是系统级无障碍接口，绕不过去也封不掉」
//   UIA 是 Windows 无障碍接口，进程开着就能读它的元素树，不需要注入、不需要改 QQ。
//
// 为什么用 PowerShell 而不是 Python + pywinauto：
//   本机 python 里 pywinauto / soundcard / sounddevice / pycaw / dashscope 全都没装，
//   只有 numpy 和 httpx。而 UIAutomationClient 是 .NET 自带程序集，PowerShell 直接
//   Add-Type 就能用 —— 零新依赖。QQagent 里已有同款调用模式（src/napcat-process.js:215）。
//
// 本机实测（2026-10-29）：纯 PowerShell 扫到 QQ 窗口 pid 14616 的全部 175 个 UIA 元素，
//   按钮名可读（最小化/最大化/关闭/更多/我的手机/导入手机相册）。但**当时没有来电窗口**，
//   所以「接听」这个真实按钮名只有 ohwhale 的 regex 作为证据 —— 这正是
//   /api/call/probe 这个 dry-run 端点存在的原因：让用户在有来电时点一次，核对真名字。
//
// ★ 全程异步：所有 runner 都返回 Promise。原因见 src/powershell.js 顶部 ——
//   用 spawnSync 时每次扫描都会把事件循环占死 1.2 秒，看门狗 600ms 一轮，
//   于是整个进程**永远**在阻塞，控制台每个请求都要等好几秒（用户报的"卡顿、打不开"）。
import { runPowerShell } from './powershell.js';

/** 只在标题含这个词的窗口里找按钮。 */
export const DEFAULT_WINDOW_PATTERN = '通话';
/** 接听类按钮名。来自 ohwhale-deploy 的 ANSWER_PAT。 */
export const DEFAULT_ANSWER_PATTERN = '接听|接受|接起';
/** 挂断类按钮名。来自 ohwhale-deploy 的 REJECT_PAT。 */
export const DEFAULT_REJECT_PATTERN = '挂断|拒绝|关闭';

/** PowerShell 单引号字符串里只需要把 ' 变成 ''。 */
function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** 正则写错了不该让整条链路沉默，也不该退化成"全都算匹配"。 */
function compilePattern(source, label) {
  try {
    return { re: new RegExp(String(source ?? ''), 'i'), error: '' };
  } catch (error) {
    return { re: null, error: `${label} 不是合法正则：${error?.message ?? error}` };
  }
}

/**
 * 生成"扫描来电窗口"的 PowerShell 脚本。
 *
 * 三条纪律（前两条照抄 src/napcat-process.js:69 的血泪注释）：
 *   ① `$ErrorActionPreference = 'SilentlyContinue'` + 容器用**普通数组** `$out = @()`
 *      —— 「PowerShell 5.1 解析不了『元素是 object 的泛型 List』，一写就让整段脚本
 *      以 exit 1 结束、且没有任何 stderr —— 静默失败最坑」。
 *   ② 结果以 stdout 能不能解析成 JSON 为准，不拿 exit code 当判据。
 *   ③ 只钻标题匹配的窗口：ohwhale 实测「遍历所有窗口的整棵树会慢到错过来电：
 *      WorkBuddy 一个窗口就有几百个元素，一轮扫描超过 20 秒」。600ms 一轮更不可能全扫。
 *
 * `[Console]::OutputEncoding = UTF8` 是本模块**新增**的一条：napcat 那份 JSON 里只有
 * pid/端口/QQ 这类 ASCII，而这里的窗口标题和按钮名**全是中文**。PowerShell 5.1 重定向
 * stdout 时按控制台代码页（本机 GBK）编码，Node 按 utf8 解就是乱码，`JSON.parse` 直接抛。
 */
export function buildCallScanScript({
  windowPattern = DEFAULT_WINDOW_PATTERN,
  includeAll = false
} = {}) {
  const matchExpr = includeAll
    ? '$true'
    : `([string]$w.Current.Name -match ${psQuote(windowPattern)})`;
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$out = @()
$errors = @()
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  foreach ($w in $wins) {
    $match = ${matchExpr}
    if (-not $match) { continue }
    $buttons = @()
    try {
      $bs = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
      foreach ($b in $bs) {
        $buttons += [pscustomobject]@{
          name = [string]$b.Current.Name
          enabled = [bool]$b.Current.IsEnabled
          automationId = [string]$b.Current.AutomationId
        }
      }
    } catch { $errors += ('buttons: ' + [string]$_.Exception.Message) }
    $out += [pscustomobject]@{
      pid = [int]$w.Current.ProcessId
      title = [string]$w.Current.Name
      cls = [string]$w.Current.ClassName
      buttons = $buttons
    }
  }
} catch { $errors += [string]$_.Exception.Message }
[pscustomobject]@{ windows = $out; errors = $errors } | ConvertTo-Json -Depth 8 -Compress
`.trim();
}

/**
 * 把扫描结果收拾成稳定结构。
 *
 * **单元素数组会被 PowerShell 拆开**：`ConvertTo-Json` 在 PS 5.1 里对只有一个元素的
 * 数组会输出成对象而不是数组（`{"windows":{...}}`）。用 `,@()` 之类的技巧在 5.1/7
 * 之间行为还不一致，所以这里统一在 Node 侧归一化 —— 两种形状都收。
 */
export function parseCallScan(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return { ok: false, windows: [], errors: ['PowerShell 没有返回结果（可能被安全软件拦了，或 UIAutomationClient 不可用）'] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, windows: [], errors: [`扫描结果不是合法 JSON：${error?.message ?? error}`] };
  }
  const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
  const windows = asArray(raw?.windows).map((w) => ({
    pid: Number(w?.pid) || 0,
    title: String(w?.title ?? ''),
    cls: String(w?.cls ?? ''),
    buttons: asArray(w?.buttons)
      .map((b) => ({
        name: String(b?.name ?? '').trim(),
        enabled: b?.enabled !== false,
        automationId: String(b?.automationId ?? '')
      }))
      .filter((b) => b.name)
  }));
  const errors = asArray(raw?.errors).map((e) => String(e)).filter(Boolean);
  return { ok: errors.length === 0, windows, errors };
}

/**
 * 接听按钮名的长度上限。
 *
 * 这个数字不是拍出来的 —— 是本机实测踩到的**真实误点**：
 * probe 用 windowPattern='QQ' 扫到了 DSH 窗口「QQagent — DeepSeek Harness」，
 * 里面有个按钮叫「打开计划：QQ 通话三步落地计划（自动接听 → 环回耳朵 → 虚拟声卡嘴）」。
 * 按钮名里含「接听」，旧逻辑就判成来电、准备去点它 —— 点下去会打开一个计划面板。
 *
 * 真正的接听按钮是**动作短语**：接听(2) / 接受(2) / 接起(2) / 视频接听(4)。
 * 超过这个长度的名字一定是"带说明的按钮"或正文文本，不是通话动作。
 */
export const CALL_BUTTON_MAX_CHARS = 16;

/**
 * 这个按钮名像不像"接听"这个动作。
 *
 * 三道闸，每一道都对应一种真实误判：
 *   ① 长度 —— 见 CALL_BUTTON_MAX_CHARS 上面的实测案例；
 *   ② 冒号 —— 「打开计划：…」「说明：…」这类是标题式按钮，动作在冒号后面，
 *      不在名字开头。真按钮不会带冒号；
 *   ③ 明确的动作词黑名单 —— 「设置接听」「自动接听」是开关项，点了会改配置。
 */
export function looksLikeCallButton(name) {
  const text = String(name ?? '').trim();
  if (!text) return false;
  if (text.length > CALL_BUTTON_MAX_CHARS) return false;
  if (/[：:]/.test(text)) return false;
  if (/设置|自动|开关|说明|计划|教程|帮助/.test(text)) return false;
  return true;
}

/** 按钮名打分：视频优先（3）> 精确接听（2）> 其他含接听字样（1）。来自 ohwhale 的 rank。 */
export function rankCallButton(name) {
  const text = String(name ?? '');
  if (text.includes('视频')) return 3;
  if (/^(接听|接受|接起)$/.test(text)) return 2;
  return 1;
}

/**
 * 决定这一轮要不要接、接哪个按钮。
 *
 * 刻意分成两个候选池，而不是只按 rank 排序取第一个：
 *   只有「视频接听」而没有语音接听、且 `preferVideo=false` 时，点下去等于替用户
 *   接了一通视频电话 —— 摄像头会被打开。这种时候必须返回 none 并说明原因，
 *   而不是"反正有个接听按钮就点"。
 */
export function decideAnswer({
  windows = [],
  answerPattern = DEFAULT_ANSWER_PATTERN,
  rejectPattern = DEFAULT_REJECT_PATTERN,
  preferVideo = false
} = {}) {
  const answer = compilePattern(answerPattern, 'answerPattern');
  if (answer.error) return { action: 'none', target: null, matchedName: '', reason: answer.error, candidates: 0, skipped: [] };
  const reject = compilePattern(rejectPattern, 'rejectPattern');
  if (reject.error) return { action: 'none', target: null, matchedName: '', reason: reject.error, candidates: 0, skipped: [] };

  const candidates = [];
  const skipped = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    const pid = Number(w?.pid) || 0;
    // pid 拿不到的窗口点了也不知道点到哪去，直接跳过
    if (pid <= 0) continue;
    const title = String(w?.title ?? '');
    for (const b of Array.isArray(w?.buttons) ? w.buttons : []) {
      const name = String(b?.name ?? '').trim();
      if (!name) continue;
      if (b?.enabled === false) continue;   // 灰掉的按钮 Invoke 会抛，别点
      if (reject.re.test(name)) continue;   // 「挂断」「关闭」绝不能被当成接听
      if (!answer.re.test(name)) continue;
      // 名字里有「接听」不代表它就是接听按钮（实测误判过计划面板的标题按钮）。
      // 这里不静默丢掉，而是记下来放进 skipped —— 用户查"为什么没接"时能看到
      // "我看到了这个按钮但没敢点"，比一句"没找到接听按钮"有用得多。
      if (!looksLikeCallButton(name)) {
        skipped.push({ pid, title, name });
        continue;
      }
      candidates.push({ pid, title, name, rank: rankCallButton(name) });
    }
  }

  const byRank = (a, b) => b.rank - a.rank || a.name.length - b.name.length;
  const video = candidates.filter((c) => c.rank === 3).sort(byRank);
  const plain = candidates.filter((c) => c.rank !== 3).sort(byRank);

  let best = null;
  let action = 'none';
  let reason = '';
  if (preferVideo && video.length) {
    best = video[0];
    action = 'video-answer';
    reason = `来电，按配置接视频：${best.name}`;
  } else if (plain.length) {
    best = plain[0];
    action = 'answer';
    reason = `来电，接语音：${best.name}`;
  } else if (video.length) {
    reason = '只找到「视频接听」，但 config.call.preferVideo=false —— 不替你接视频电话（会开摄像头）';
  } else if (skipped.length) {
    // 这条比"没找到"重要：确实看到了带「接听」字样的按钮，但每一个都长得不像
    // 通话动作（太长 / 带冒号 / 是设置项）。把名字报出来，用户一眼就知道
    // 是"扫错窗口了"还是"QQ 改版了"。
    reason = `看到 ${skipped.length} 个名字带「接听」的按钮，但都不像接听动作（太长或带冒号），没点：${skipped.map((s) => `「${s.name}」`).join('、')}`;
  } else {
    reason = '没有找到「接听」按钮（可能没有来电，或 QQ 改版改了按钮名；用 /api/call/probe 看一眼真实按钮名）';
  }

  return {
    action,
    target: best ? { pid: best.pid, title: best.title, name: best.name } : null,
    matchedName: best ? best.name : '',
    reason,
    candidates: candidates.length,
    // 名字含接听字样但不像动作按钮的，单独回报 —— 不点，也不假装没看见。
    skipped
  };
}

function defaultRunner(script) {
  return runPowerShell(script, { timeout: 15000 });
}

/** 真的扫一遍。非 Windows 直接给结论，不装样子。 */
export async function scanCallWindows({ windowPattern = DEFAULT_WINDOW_PATTERN, includeAll = false, runner = defaultRunner } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, windows: [], errors: ['自动接听只支持 Windows（UIA 是 Windows 无障碍接口）'] };
  }
  const script = buildCallScanScript({ windowPattern, includeAll });
  let result;
  try {
    result = await runner(script);
  } catch (error) {
    return { ok: false, windows: [], errors: [`调用 PowerShell 失败：${error?.message ?? error}`] };
  }
  if (result?.error) return { ok: false, windows: [], errors: [String(result.error.message || result.error)] };
  const stdout = String(result?.stdout ?? '');
  if (!stdout.trim()) {
    const stderr = String(result?.stderr ?? '').trim();
    return { ok: false, windows: [], errors: [stderr || `PowerShell 没有返回结果（exit ${result?.status}）`] };
  }
  return parseCallScan(stdout);
}

/**
 * 点按钮。
 *
 * 按 pid 找窗口再按名字找按钮，**不按标题找** —— 标题里带着对方昵称和会话数
 * （本机实测是「我的手机等2个会话」），来电时还会变，拿标题当定位键必然错。
 */
export function buildAnswerScript({ pid, buttonName }) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ok = $false
$errors = @()
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${Number(pid) || 0})
  $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
  $target = $null
  foreach ($w in $wins) {
    $bs = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    foreach ($b in $bs) {
      if ([string]$b.Current.Name -eq ${psQuote(buttonName)}) { $target = $b; break }
    }
    if ($target -ne $null) { break }
  }
  if ($target -ne $null) {
    $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    $ok = $true
  } else {
    $errors += ('没找到名为「' + ${psQuote(buttonName)} + '」的按钮（窗口可能已经关了）')
  }
} catch { $errors += [string]$_.Exception.Message }
[pscustomobject]@{ ok = $ok; errors = $errors } | ConvertTo-Json -Depth 4 -Compress
`.trim();
}

export async function invokeAnswer({ pid, buttonName, runner = defaultRunner } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, clicked: false, errors: ['自动接听只支持 Windows'] };
  }
  if (!(Number(pid) > 0)) return { ok: false, clicked: false, errors: ['没有有效的窗口 pid'] };
  if (!String(buttonName ?? '').trim()) return { ok: false, clicked: false, errors: ['没有指定要点的按钮名'] };

  let result;
  try {
    result = await runner(buildAnswerScript({ pid, buttonName }));
  } catch (error) {
    return { ok: false, clicked: false, errors: [`调用 PowerShell 失败：${error?.message ?? error}`] };
  }
  if (result?.error) return { ok: false, clicked: false, errors: [String(result.error.message || result.error)] };
  const stdout = String(result?.stdout ?? '').trim();
  if (!stdout) {
    const stderr = String(result?.stderr ?? '').trim();
    return { ok: false, clicked: false, errors: [stderr || `PowerShell 没有返回结果（exit ${result?.status}）`] };
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, clicked: false, errors: [`点击结果不是合法 JSON：${error?.message ?? error}`] };
  }
  const ok = data?.ok === true;
  const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return { ok, clicked: ok, errors: asArray(data?.errors).map((e) => String(e)).filter(Boolean) };
}

/**
 * 轮询守护：扫 → 判 → 点，同一通电话不重复点。
 *
 * 为什么必须有冷却：600ms 一轮，一通电话 30 秒内会被扫到 50 次。
 * 不去重就是连点 50 下「接听」。
 *
 * 为什么冷却只在**点成功**后才生效：点失败通常意味着窗口已经关了（对方挂断），
 * 这时候压 20 秒等于把下一通来电也一起压掉了。所以失败只压 3 秒。
 */
export function createCallWatcher({
  scan = scanCallWindows,
  answer = invokeAnswer,
  intervalMs = 600,
  cooldownMs = 20000,
  retryMs = 3000,
  isEnabled = () => true,
  options = () => ({}),
  log = () => {}
} = {}) {
  /** key = `pid::title::按钮名` → { at, ok } */
  const seen = new Map();
  const state = {
    running: false,
    scans: 0,
    answered: 0,
    lastScanAt: 0,
    lastAction: null,
    lastReason: '',
    lastSkipped: [],
    lastError: ''
  };
  let timer = null;
  // 重入锁。以前 runner 是 spawnSync，一次扫描期间事件循环是**死**的，
  // 600ms 的定时器根本不可能在上一次扫完前进第二轮 —— 重入天然不存在。
  // 改成异步之后这个假设没了：一次 UIA 扫描实测 1.4 秒，比间隔还长，
  // 不锁的话会并发起一堆 PowerShell 进程，每个都在抢 UIA 的 COM 单线程。
  let inFlight = null;

  const safeCall = (fn, fallback) => {
    try { return fn(); } catch (error) { state.lastError = String(error?.message ?? error); return fallback; }
  };

  async function check() {
    // 上一轮还没完：直接跳过，不排队。排队的话来电被接听时可能积压几十轮。
    if (inFlight) return { action: 'busy', reason: '上一轮扫描还没结束' };
    inFlight = doCheck();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function doCheck() {
    if (!safeCall(isEnabled, false)) return { action: 'disabled', reason: '自动接听没打开' };
    const opts = safeCall(options, {}) || {};
    state.scans += 1;
    state.lastScanAt = Date.now();

    let scanned;
    try {
      scanned = await scan({ windowPattern: opts.windowPattern ?? DEFAULT_WINDOW_PATTERN });
    } catch (error) {
      state.lastError = String(error?.message ?? error);
      return { action: 'error', reason: state.lastError };
    }
    if (!scanned?.ok) {
      state.lastError = (scanned?.errors ?? []).join('；') || '扫描失败';
      return { action: 'error', reason: state.lastError };
    }
    state.lastError = '';

    // 窗口没了就把它的冷却一起清掉 —— 否则下一通电话（pid 常复用）会被上一通的记录压住
    const livePids = new Set(scanned.windows.map((w) => Number(w?.pid) || 0));
    for (const key of [...seen.keys()]) {
      const pid = Number(key.split('::')[0]);
      if (!livePids.has(pid)) seen.delete(key);
    }

    const decision = decideAnswer({
      windows: scanned.windows,
      answerPattern: opts.answerPattern ?? DEFAULT_ANSWER_PATTERN,
      rejectPattern: opts.rejectPattern ?? DEFAULT_REJECT_PATTERN,
      preferVideo: opts.preferVideo === true
    });
    state.lastReason = decision.reason;
    // 名字带「接听」但没敢点的按钮也要能查到 —— 否则用户只看到"没有来电"，
    // 永远不知道其实扫到了东西（本机实测踩过一次：扫到计划面板的标题按钮）。
    state.lastSkipped = decision.skipped ?? [];
    if (decision.action !== 'answer' && decision.action !== 'video-answer') return decision;

    const key = `${decision.target.pid}::${decision.target.title}::${decision.target.name}`;
    const prev = seen.get(key);
    const now = Date.now();
    if (prev) {
      const wait = prev.ok ? cooldownMs : retryMs;
      if (now - prev.at < wait) {
        return { ...decision, action: 'cooldown', reason: '刚刚已经点过这个按钮，等一会儿再试' };
      }
    }

    let clicked;
    try {
      clicked = await answer({ pid: decision.target.pid, buttonName: decision.target.name });
    } catch (error) {
      clicked = { ok: false, clicked: false, errors: [String(error?.message ?? error)] };
    }
    const ok = clicked?.ok === true;
    seen.set(key, { at: now, ok });
    if (ok) state.answered += 1;
    else state.lastError = (clicked?.errors ?? []).join('；') || '点击失败';
    state.lastAction = {
      action: decision.action,
      pid: decision.target.pid,
      title: decision.target.title,
      name: decision.target.name,
      ok,
      at: now
    };
    log(ok ? `[通话] 已${decision.action === 'video-answer' ? '接视频' : '接听'}：${decision.target.title}（pid ${decision.target.pid}）` : `[通话] 点「${decision.target.name}」失败：${state.lastError}`);
    return { ...decision, action: ok ? decision.action : 'failed', clicked: ok, errors: clicked?.errors ?? [] };
  }

  return {
    start() {
      if (timer) return;
      state.running = true;
      timer = setInterval(() => { check().catch(() => {}); }, Math.max(200, Number(intervalMs) || 600));
      // 立刻扫一次：不要等第一个 interval，来电是突发的
      check().catch(() => {});
    },
    stop() {
      state.running = false;
      if (timer) { clearInterval(timer); timer = null; }
    },
    check,
    snapshot() {
      return {
        running: state.running,
        scans: state.scans,
        answered: state.answered,
        lastScanAt: state.lastScanAt,
        lastAction: state.lastAction,
        lastReason: state.lastReason,
        lastSkipped: state.lastSkipped,
        lastError: state.lastError,
        watching: seen.size,
        // 能不能真的点：面板必须区分「扫到了来电」和「会去接」。
        // 只看 scans/answered 的话，autoAnswer 关着时面板会显示得像在工作。
        canClick: safeCall(isEnabled, false) === true
      };
    }
  };
}
