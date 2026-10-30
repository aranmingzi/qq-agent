// 音频设备枚举（"嘴"那一步的前置检查）
//
// 为什么需要它：TTS 要播进虚拟声卡，对方才听得到。而"虚拟声卡到底装没装"这件事
// 服务端必须能自己回答 —— 否则面板只能说"不知道"，用户就得靠猜。
//
// ⚠️ 关键边界：**这里拿到的设备 id 不能直接喂给浏览器的 setSinkId。**
//   - PowerShell / MMDevice 给的是 `{0.0.0.00000000}.{guid}` 这种系统端点 id；
//   - Chromium 的 `setSinkId()` 要的是它自己 `enumerateDevices()` 输出的 deviceId，
//     那是按 origin 加盐哈希过的，两者对不上。
//   所以分工是：
//     本模块 → 只回答"装没装、叫什么名字"（服务端状态、面板提示、/api/call/status）；
//     浏览器 → `enumerateDevices()` 找到 label 含 `CABLE Input` 的 audiooutput，
//              拿它的 deviceId 去 setSinkId（见 console/src/lib/voice-client.ts）。
//   如果把系统端点 id 硬塞给 setSinkId，会得到一个 `NotFoundError`，而且很难查。
//
// 为什么要查两端：虚拟声卡是"一对"设备 —— 播放端（CABLE Input，我们往里写）
// 和录音端（CABLE Output，QQ 当麦克风读）。只装了一半是最常见的翻车方式，
// 这时 QQ 里根本选不到麦克风，而面板若只查一端就会报"已安装"，纯属骗人。
//
// ★ 异步返回 Promise：本机实测这一个 PowerShell 枚举要 3.5~4.1 秒，
//   用 spawnSync 会把 Node 的事件循环整段冻住 —— 期间控制台所有请求全部卡死，
//   而 /api/call/status 每次都会调它。见 src/powershell.js 顶部。
import { runPowerShell } from './powershell.js';

/** 播放端（我们往这里写声音）的常见名字。 */
export const CABLE_RENDER_HINTS = ['cable input', 'vb-audio', 'voicemeeter input', 'voicemeeter aux input'];
/** 录音端（QQ 当麦克风读）的常见名字。 */
export const CABLE_CAPTURE_HINTS = ['cable output', 'vb-audio', 'voicemeeter output', 'voicemeeter aux output'];

/**
 * 生成枚举音频端点的 PowerShell 脚本。
 *
 * 用 `Get-PnpDevice -Class AudioEndpoint` 而不是 `Get-CimInstance Win32_SoundDevice`：
 * 后者只列声卡（驱动层），而我们要的是**端点**（CABLE Input / CABLE Output 是两个
 * 独立端点，属于同一块虚拟声卡）。本机实测 Get-PnpDevice 能列出
 * 「耳机 (Bluetooth)」「扬声器 (Realtek(R) Audio)」「麦克风阵列 (Realtek(R) Audio)」。
 *
 * 纪律与 qq-call-answer.js 一致：普通数组 + SilentlyContinue + UTF8 输出 + 只信 JSON。
 * 端点方向靠 FriendlyName 猜不准（Realtek 的「扬声器」是渲染，「麦克风阵列」是采集），
 * 所以脚本只负责**原样列出**，方向判定放在 Node 侧（parseAudioDevices），
 * 那里能写中文关键词、能被测试覆盖。
 */
export function buildAudioDeviceScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = @()
$errors = @()
try {
  $devices = Get-PnpDevice -Class AudioEndpoint
  foreach ($d in $devices) {
    $out += [pscustomobject]@{
      name = [string]$d.FriendlyName
      status = [string]$d.Status
      instanceId = [string]$d.InstanceId
    }
  }
} catch { $errors += [string]$_.Exception.Message }
[pscustomobject]@{ devices = $out; errors = $errors } | ConvertTo-Json -Depth 4 -Compress
`.trim();
}

/**
 * 把端点名字判成 render（播放）/ capture（录音）/ unknown。
 *
 * 顺序有讲究：先认「输入/输出」这种明确的方位词，再看设备类别词。
 * 反过来的话「CABLE Input」会被「CABLE」以外的关键词误判 —— 而且
 * VB-Cable 的命名天生反直觉：**CABLE Input 是播放端**（我们往里写），
 * **CABLE Output 是录音端**（QQ 从它读）。按字面"Input=输入设备"理解必错。
 */
export function classifyEndpoint(name) {
  const text = String(name ?? '').toLowerCase();
  if (!text) return 'unknown';
  // VB-Cable 的反直觉命名优先处理
  if (text.includes('cable input')) return 'render';
  if (text.includes('cable output')) return 'capture';
  // 明确的方位词
  if (/输出|output|speakers?|扬声器|耳机|headphone|hdmi/.test(text)) return 'render';
  if (/输入|input|麦克风|microphone|mic\b|array/.test(text)) return 'capture';
  return 'unknown';
}

/** 名字里是否带虚拟声卡特征（两端共用的宽判据）。 */
function looksVirtual(name) {
  const text = String(name ?? '').toLowerCase();
  return CABLE_RENDER_HINTS.some((h) => text.includes(h)) || CABLE_CAPTURE_HINTS.some((h) => text.includes(h));
}

/**
 * 解析 PowerShell 输出。
 *
 * 只保留状态正常的设备：`Status` 为 `OK` 才算真能用。本机实测未插入的蓝牙耳机
 * 也会出现在列表里（Status=Unknown/Error），把它算进"设备可用"会让面板显示
 * 「找到 3 个播放设备」而实际只有一个能出声。
 */
export function parseAudioDevices(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    return { ok: false, render: [], capture: [], all: [], errors: ['PowerShell 没有返回结果（可能被安全软件拦了）'] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, render: [], capture: [], all: [], errors: [`设备列表不是合法 JSON：${error?.message ?? error}`] };
  }
  const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
  const all = asArray(raw?.devices)
    .map((d) => ({
      name: String(d?.name ?? '').trim(),
      status: String(d?.status ?? '').trim(),
      instanceId: String(d?.instanceId ?? ''),
      kind: classifyEndpoint(d?.name),
      virtual: looksVirtual(d?.name)
    }))
    .filter((d) => d.name);
  const usable = all.filter((d) => /^ok$/i.test(d.status));
  const errors = asArray(raw?.errors).map((e) => String(e)).filter(Boolean);
  return {
    ok: errors.length === 0,
    render: usable.filter((d) => d.kind === 'render'),
    capture: usable.filter((d) => d.kind === 'capture'),
    all,
    errors
  };
}

/**
 * 判定虚拟声卡装没装。
 *
 * 四种结论都要说清楚，绝不能返回空对象让前端猜：
 *   present —— 两端都在，可以配
 *   partial —— 只有一端，说明装了一半（最常见的翻车）
 *   absent  —— 都没有，需要装驱动
 * 另外 `hint` 永远是一句人话，面板直接显示。
 */
export function detectVirtualCable({ render = [], capture = [] } = {}) {
  const renderHit = (Array.isArray(render) ? render : []).find((d) => looksVirtual(d?.name));
  const captureHit = (Array.isArray(capture) ? capture : []).find((d) => looksVirtual(d?.name));

  if (renderHit && captureHit) {
    return {
      state: 'present',
      present: true,
      renderName: renderHit.name,
      captureName: captureHit.name,
      hint: `已找到虚拟声卡：播放端「${renderHit.name}」，录音端「${captureHit.name}」。下一步在 QQ 设置里把麦克风选成「${captureHit.name}」。`
    };
  }
  if (renderHit) {
    return {
      state: 'partial',
      present: false,
      renderName: renderHit.name,
      captureName: '',
      hint: `只找到播放端「${renderHit.name}」，缺少录音端（CABLE Output）—— 虚拟声卡可能只装了一半，QQ 里会选不到麦克风。建议重装 VB-Cable。`
    };
  }
  if (captureHit) {
    return {
      state: 'partial',
      present: false,
      renderName: '',
      captureName: captureHit.name,
      hint: `只找到录音端「${captureHit.name}」，缺少播放端（CABLE Input）—— 声音没地方可写。建议重装 VB-Cable。`
    };
  }
  return {
    state: 'absent',
    present: false,
    renderName: '',
    captureName: '',
    hint: '没找到虚拟声卡。要让对方真的听到它说话，需要先装 VB-Cable（或 VoiceMeeter），装完重启一次，然后在 QQ 设置里把麦克风选成 CABLE Output。'
  };
}

function defaultRunner(script) {
  return runPowerShell(script, { timeout: 15000 });
}

/**
 * 真的枚举一次。
 *
 * 非 Windows / 非 win32 平台直接返回 absent + 原因，不装样子 —— 面板显示
 * 「这个平台不支持」比显示「未安装，请装 VB-Cable」诚实得多。
 */
export async function listAudioDevices({ runner = defaultRunner } = {}) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      render: [],
      capture: [],
      all: [],
      errors: ['音频设备枚举只支持 Windows'],
      virtualCable: { state: 'absent', present: false, renderName: '', captureName: '', hint: '这个平台没有 Windows 的音频端点枚举。' }
    };
  }
  let result;
  try {
    result = await runner(buildAudioDeviceScript());
  } catch (error) {
    const errors = [`调用 PowerShell 失败：${error?.message ?? error}`];
    return { ok: false, render: [], capture: [], all: [], errors, virtualCable: detectVirtualCable({}) };
  }
  if (result?.error) {
    const errors = [String(result.error.message || result.error)];
    return { ok: false, render: [], capture: [], all: [], errors, virtualCable: detectVirtualCable({}) };
  }
  const stdout = String(result?.stdout ?? '');
  if (!stdout.trim()) {
    const stderr = String(result?.stderr ?? '').trim();
    const errors = [stderr || `PowerShell 没有返回结果（exit ${result?.status}）`];
    return { ok: false, render: [], capture: [], all: [], errors, virtualCable: detectVirtualCable({}) };
  }
  const parsed = parseAudioDevices(stdout);
  return { ...parsed, virtualCable: detectVirtualCable({ render: parsed.render, capture: parsed.capture }) };
}
