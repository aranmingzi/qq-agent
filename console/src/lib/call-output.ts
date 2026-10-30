// 「嘴」：把 TTS 的声音送进虚拟声卡，对方才听得到。
//
// 为什么单独一个模块、而不是写在通话页里：
// 选设备这件事有一堆**纯逻辑**的坑（标签为空、deviceId 是 'default'、名字大小写、
// 只有一半装上的虚拟声卡），它们跟 React 无关，但每一个都会让人对着"没声音"发呆。
// 抽出来就能用 node 直接跑断言，不用起浏览器。
//
// ⚠️ 最重要的一条边界：**服务端枚举出来的设备 id 不能喂给 setSinkId。**
//   - `src/audio-devices.js` 用 PowerShell 拿的是系统端点 id（`{0.0.0.00000000}.{guid}`）；
//   - `setSinkId()` 只认浏览器自己 `enumerateDevices()` 给的 deviceId
//     （按 origin 加盐哈希过，跟系统 id 完全对不上）。
//   把系统 id 塞进去会得到一个 NotFoundError，而错误信息看不出是"id 类型搞错了"。
//   所以这里只吃 `enumerateDevices()` 的结果。

/** `enumerateDevices()` 里我们关心的那部分（只取 audiooutput）。 */
export type OutputDevice = {
  deviceId: string;
  label: string;
};

export type PickResult = {
  /** 选中的设备；null 表示没找到可用的虚拟声卡。 */
  device: OutputDevice | null;
  /** 所有 audiooutput，用于面板列出来让人手动选。 */
  candidates: OutputDevice[];
  /** 一句人话，直接显示在面板上。 */
  reason: string;
  /** 是否退到了"系统默认设备"（对方听不到，但至少自己听得见）。 */
  fellBackToDefault: boolean;
};

/** 虚拟声卡播放端的常见名字。VB-Cable 的命名反直觉：CABLE Input 才是播放端。 */
const VIRTUAL_HINTS = ['cable input', 'vb-audio', 'voicemeeter input', 'voicemeeter aux input', 'voicemeeter vaio'];

/**
 * 从一组虚拟声卡候选里挑最合适的那个。
 *
 * 为什么需要排序而不是直接取第一个：装了 VB-Cable 的机器上同时有
 * 「CABLE Input (VB-Audio Virtual Cable)」和「CABLE In 16 Ch (VB-Audio Virtual Cable)」
 * 两个播放端点。16 通道那个是给多轨用的，拿它播 TTS 会被上混，
 * 而且用户按名字根本分不清。**两个都是"虚拟声卡"，但只有前者是我们要的。**
 *
 * 而且 Chromium 在 Windows 上给的 label 是**端点友好名**：
 * 播放端叫「扬声器 (VB-Audio Virtual Cable)」，里面压根没有 "CABLE Input" 这几个字。
 * 所以"名字含 cable input"这条规则在真浏览器里经常命不中，必须有兜底排序，
 * 不能只靠配置里的 hint。
 */
function rankVirtual(devices: OutputDevice[]): OutputDevice[] {
  const score = (d: OutputDevice): number => {
    const label = String(d.label || '').toLowerCase();
    let s = 0;
    if (label.includes('cable input')) s += 100;      // 正是 VB-Cable 的播放端
    if (label.includes('vb-audio')) s += 10;
    if (label.includes('voicemeeter')) s += 10;
    // 16 通道变体是同一张卡的另一条端点，播语音会被上混，排到最后。
    if (/\b16\s*ch/.test(label)) s -= 50;
    return s;
  };
  return [...devices].sort((a, b) => score(b) - score(a));
}

/**
 * 从设备列表里挑出虚拟声卡。
 *
 * 优先级：配置里的 `hint` > 内置的常见名字（按 rankVirtual 排序）> 放弃（回落到系统默认）。
 * 之所以让 `hint` 优先：用户可能装的是 VoiceMeeter 或者改过名字，
 * 配置里能写死一个他实际看到的标签，比我们猜准。
 */
export function pickOutputDevice(
  devices: OutputDevice[],
  hint = 'CABLE Input',
): PickResult {
  const list = (Array.isArray(devices) ? devices : [])
    .filter((d) => d && typeof d.deviceId === 'string' && d.deviceId)
    // 'default' / 'communications' 是浏览器给的两个别名，不是真设备。
    // 把它们当候选会让"选了 CABLE Input 但其实还是系统默认"这种假成功混进来。
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');

  const named = list.filter((d) => String(d.label || '').trim());
  const lower = (d: OutputDevice) => String(d.label || '').toLowerCase();

  const wanted = String(hint || '').trim().toLowerCase();
  if (wanted) {
    const hit = named.find((d) => lower(d).includes(wanted));
    if (hit) {
      return {
        device: hit,
        candidates: list,
        reason: `已选中「${hit.label}」——它说话的声音会从这里进去，QQ 把它的录音端当麦克风。`,
        fellBackToDefault: false,
      };
    }
  }

  const virtuals = named.filter((d) => VIRTUAL_HINTS.some((h) => lower(d).includes(h)));
  const guess = rankVirtual(virtuals)[0];
  if (guess) {
    // 不再说"没找到名字含 X 的设备"——在真浏览器里 hint 命不中是常态
    // （label 是端点友好名「扬声器 (VB-Audio Virtual Cable)」），
    // 说成失败会让用户以为哪儿坏了。这里是成功，只是靠内置规则认出来的。
    return {
      device: guess,
      candidates: list,
      reason: `已选中「${guess.label}」（虚拟声卡，按内置规则认出来的）——它说话的声音会从这里进去，QQ 把它的录音端当麦克风。`,
      fellBackToDefault: false,
    };
  }

  // 标签全空 = 还没拿到麦克风权限。浏览器在授权前会把 label 抹成空字符串，
  // 这时候"没找到设备"是假象，必须说清楚，否则用户会去装驱动。
  if (!named.length) {
    return {
      device: null,
      candidates: list,
      reason:
        list.length > 0
          ? '设备列表里一个名字都没有 —— 浏览器在拿到麦克风权限之前不给标签。先开始一次通话（会申请权限），再回来选设备。'
          : '这台机器上一个播放设备都没枚举到。',
      fellBackToDefault: true,
    };
  }

  return {
    device: null,
    candidates: list,
    reason: `没找到虚拟声卡（找的是名字含「${hint}」的播放设备）。装了 VB-Cable 或 VoiceMeeter 之后重启一次浏览器再回来。现在只能用系统默认设备播放 —— 你自己听得见，对方听不见。`,
    fellBackToDefault: true,
  };
}

/**
 * 把「嘴」的当前状态说成一句话。
 *
 * 这个函数存在的理由：这条链路上有四种完全不同的"没声音"，
 * 用户从现象上分不出来，必须由我们直接说：
 *   1. 浏览器不支持切输出（旧浏览器 / 没给 speaker-selection 权限）
 *   2. 没装虚拟声卡
 *   3. 装了但没选中（还在系统默认）
 *   4. 选对了
 */
export function describeMouth({
  supported,
  picked,
}: {
  supported: boolean;
  picked: PickResult | null;
}): string {
  if (!supported) {
    return '这个浏览器不支持切换播放设备（setSinkId），声音只能进系统默认设备 —— 对方听不到。桌面版（Electron）里才行。';
  }
  if (!picked) return '还没读设备列表。';
  // pickOutputDevice 的 reason 本身就已经把"选中了/没选中/为什么"说完了，
  // 这里不要再包一层"成功/失败"的套话 —— 那样会把具体设备名盖掉。
  return picked.reason;
}

/**
 * 判断一个 `enumerateDevices()` 的条目是不是播放设备。
 *
 * 单独拿出来是因为 Safari/Firefox 在旧版本里 `kind` 缺失或写成 `'audio'`，
 * 只按 `kind === 'audiooutput'` 过滤会漏掉真设备，表现为"下拉框是空的"。
 */
export function isAudioOutput(entry: { kind?: string } | null | undefined): boolean {
  const kind = String(entry?.kind ?? '').toLowerCase();
  return kind === 'audiooutput';
}

/** 把 `enumerateDevices()` 的原始结果转成 `OutputDevice[]`。 */
export function toOutputDevices(entries: Array<{ kind?: string; deviceId?: string; label?: string }>): OutputDevice[] {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => isAudioOutput(e))
    .map((e) => ({ deviceId: String(e.deviceId ?? ''), label: String(e.label ?? '') }))
    .filter((e) => e.deviceId);
}

/**
 * 按保存下来的标签重新认设备。
 *
 * 为什么需要它：浏览器给的 deviceId 是按 origin 加盐哈希的，换端口/换协议就变，
 * 所以「上次选的是哪个」只能靠标签记。但标签也可能因为换驱动/改语言而变化，
 * 所以这里做**精确 → 包含**两级匹配，都失败就明确说"没认回来"，
 * 而不是悄悄回落到系统默认（那样对方听不见，用户还以为是通话功能坏了）。
 */
export function matchByLabel(devices: OutputDevice[], label: string): OutputDevice | null {
  const wanted = String(label || '').trim();
  if (!wanted) return null;
  const list = Array.isArray(devices) ? devices.filter((d) => d && d.deviceId) : [];
  const exact = list.find((d) => String(d.label || '').trim() === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  return list.find((d) => String(d.label || '').toLowerCase().includes(lower)) ?? null;
}
