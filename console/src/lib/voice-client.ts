// 语音通话的浏览器端客户端。
//
// 为什么单独一个文件、而不是写在页面组件里：
// 采集、重采样、播放队列、断线重连这些东西跟 React 一点关系都没有，
// 塞进组件里既难测也难复用（以后手机轻量版 /m/ 想接同一个后端时，
// 只要这一个文件就能跑，不用把 JSX 也搬过去）。
//
// 传输约定（和 src/voice-gateway.js 一一对应）：
//   - 二进制帧 = 音频（两个方向都是）
//   - 文本帧   = JSON 控制消息
//
// 采样率：QQagent 后端只认 16kHz / 16bit / 单声道 PCM。
// 浏览器麦克风一般是 44.1k 或 48k，所以这里必须重采样 ——
// 直接把 48k 的样本当 16k 发过去，听上去就是快放三倍的尖嗓子。

export type VoiceStatus = {
  enabled: boolean;
  ready: boolean;
  problems: string[];
  micRequiresSecureContext: boolean;
  wsPath: string;
  vad: {
    threshold: number;
    minSpeechMs: number;
    silenceMs: number;
    preRollMs?: number;
    keepTailMs?: number;
  };
  asrModel: string;
  ttsFormat: string;
  limits: { maxCallMs: number; maxTurns: number; idleTimeoutMs: number };
  stats: { connections: number; rejected: number; turns: number; errors: number } | null;
};

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'closed';

/**
 * 耳朵从哪里来。
 * - `mic`：普通麦克风（对着电脑说话，控制台内的语音通话）。
 * - `loopback`：系统混音（把 QQ 正在放出来的对方声音抓过来）。
 *   打 QQ 电话时必须是这个 —— 对方的声在扬声器里，不在空气里等麦克风去捡。
 */
export type CaptureMode = 'mic' | 'loopback';

export type VoiceHandlers = {
  onState?: (state: VoiceState) => void;
  onReady?: (info: { asrModel: string; ttsFormat: string; vad: unknown; vadConfig?: unknown }) => void;
  onAsr?: (text: string) => void;
  onReply?: (text: string) => void;
  onError?: (message: string, code?: string) => void;
  onDropped?: (reason: string) => void;
  onClosed?: (reason: string) => void;
  onLevel?: (level: number) => void;
  onLog?: (line: string) => void;
};

const TARGET_RATE = 16000;

/** 把任意采样率的 Float32 线性重采样到 16k。 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input;
  if (!Number.isFinite(inputRate) || inputRate <= 0) return new Float32Array(0);
  const ratio = inputRate / TARGET_RATE;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

/** Float32 [-1,1] → Int16 PCM（小端）。超范围的直接夹紧，不要溢出成噪音。 */
export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 这一帧有多"响"（RMS）。页面上的音量条用它，顺便让人知道麦克风到底有没有开。 */
export function rms(input: Float32Array): number {
  if (!input.length) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
  return Math.sqrt(sum / input.length);
}

// ── 发送节流：为什么必须有这两块 ────────────────────────────────────
//
// 病根：AudioWorklet 的渲染量子是 **128 个样本**。16kHz 下就是每 8ms 回调一次
// → 每秒 125 次。原实现是「回调一次就转一次 Int16、就 ws.send 一次」：
//
//   每秒 125 个二进制帧 × 256 字节 = 32 KB/s，可每帧还要带 2~6 字节的 ws 帧头
//   —— 协议开销快赶上载荷本身了。
//
// 更要命的是电平条：每帧回调一次 onLevel → 页面里一次 setState → 492 行的
// 整个通话页每 8ms 重渲染一次。**这才是用户看到的「持续卡顿」。**
//
// 所以这里做两件事：
//   1. 攒成 100ms 一块再发（10 帧/秒，降 12.5 倍），顺便把重采样和
//      Float32→Int16 的转换也一起省到 1/12.5；
//   2. 电平回调限到 20 次/秒，再由页面用 requestAnimationFrame 自己画
//      （画面刷新率归画面管，跟采集频率解耦）。
//
// 两个数都是**纯逻辑**，下面配有 test/test-voice-pacing.mjs 真跑一遍，
// 不是靠读源码断言。

/** 攒多久发一次。100ms 也是后端 VAD 粒度能接受的上限（再粗就会明显拖慢断句）。 */
export const CHUNK_MS = 100;

/** 电平回调最短间隔。50ms = 20 次/秒，肉眼已经连续，又不会把主线程喂满。 */
export const LEVEL_INTERVAL_MS = 50;

/** 把两段 Int16 拼起来（一次 push 攒出多块时才会用到，正常路径用不到）。 */
function concatInt16(left: Int16Array, right: Int16Array): Int16Array {
  const out = new Int16Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * 把 worklet 每 8ms 丢过来的 128 个样本，攒成 100ms 一块再发出去。
 *
 * 为什么不在 worklet 里攒：
 * worklet 是字符串源码、跑在 AudioWorkletGlobalScope 里，node 测不到它。
 * 攒在主线虽然多一次「拷 128 个 sample」的循环（每秒 16k 次乘法，可忽略），
 * 但换来了一个能被真跑一遍的纯类 —— 这一轮之前的教训就是
 * 「没被真跑过的逻辑，改坏了测试还是绿的」。
 */
export class PcmChunker {
  private readonly capacity: number;
  private buffer: Float32Array;
  private filled = 0;

  constructor(rate: number = TARGET_RATE, chunkMs: number = CHUNK_MS) {
    const safeRate = Number.isFinite(rate) && rate > 0 ? rate : TARGET_RATE;
    const safeMs = Number.isFinite(chunkMs) && chunkMs > 0 ? chunkMs : CHUNK_MS;
    this.capacity = Math.max(1, Math.round((safeRate * safeMs) / 1000));
    this.buffer = new Float32Array(this.capacity);
  }

  /** 这一块有多少样本（16kHz / 100ms 时是 1600）。 */
  get chunkSamples(): number {
    return this.capacity;
  }

  /** 已经攒了多少还没发出去的样本。 */
  get pending(): number {
    return this.filled;
  }

  /**
   * 塞一帧进去。攒满一块才返回 PCM，否则返回 null。
   *
   * @param samples   Float32 样本，范围 [-1,1]
   * @param inputRate 这一帧的真实采样率（采集上下文可能是 48k）
   */
  push(samples: Float32Array, inputRate: number = TARGET_RATE): Int16Array | null {
    if (!samples || samples.length === 0) return null;
    const resampled = resampleTo16k(samples, inputRate);
    if (resampled.length === 0) return null;

    let offset = 0;
    let out: Int16Array | null = null;
    while (offset < resampled.length) {
      const take = Math.min(this.capacity - this.filled, resampled.length - offset);
      this.buffer.set(resampled.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled >= this.capacity) {
        const block = float32ToInt16(this.buffer);
        this.filled = 0;
        out = out === null ? block : concatInt16(out, block);
      }
    }
    return out;
  }

  /**
   * 把没攒满的尾巴全吐出来。
   *
   * 挂断和「说完了」都必须先靠它收尾，否则最后不满 100ms 的那半句话
   * 会随着连接一起消失 —— 用户听到的就是「我最后一个字它没听见」。
   */
  flush(): Int16Array | null {
    if (this.filled === 0) return null;
    const block = float32ToInt16(this.buffer.subarray(0, this.filled));
    this.filled = 0;
    return block;
  }
}

/** 电平回调该不该发。抽成纯函数是为了能钉住「别每帧都回调」。 */
export function shouldEmitLevel(
  lastAt: number,
  now: number,
  intervalMs: number = LEVEL_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  return now - lastAt >= Math.max(0, intervalMs);
}

// ── QQ 通话（真的 QQ 客户端）的状态接口 ──────────────────────────────
//
// 为什么放在这个文件而不是 api.ts：
// 这几条接口只服务通话页，跟聊天/会话那套完全无关；放一起能一眼看全
// 「通话这条链路一共问后端几个问题」。

export type CallCable = {
  state: 'present' | 'partial' | 'absent';
  present: boolean;
  renderName: string;
  captureName: string;
  hint: string;
};

/** 看门狗的实时状态。`canClick` 是唯一不可回退动作的最后一道闸。 */
export type CallWatcher = {
  running?: boolean;
  scanning?: boolean;
  lastScanAt?: number | null;
  lastAction?: string;
  canClick?: boolean;
  answered?: number;
  errors?: number;
  lastReason?: string;
  /**
   * 名字带「接听」字样、但被判定成"不是通话动作"因而没点的按钮。
   *
   * 面板必须显示它：本机实测扫到过 DSH 窗口里一个叫
   * 「打开计划：QQ 通话三步落地计划（自动接听 → …）」的按钮。
   * 只报"没有来电"的话，用户会以为扫描坏了。
   */
  lastSkipped?: Array<{ pid?: number; title?: string; name?: string }>;
  [key: string]: unknown;
};

export type CallStatus = {
  enabled: boolean;
  autoAnswer: boolean;
  ready: boolean;
  problems: string[];
  platform: string;
  watch: {
    intervalMs: number;
    windowPattern: string;
    answerPattern: string;
    rejectPattern: string;
    preferVideo: boolean;
    cooldownMs: number;
  };
  loopback: { enabled: boolean; available: boolean; reason: string };
  vad: { silenceMs: number; preRollMs: number; keepTailMs: number; bargeInRatio: number };
  mouth: {
    outputDeviceId: string;
    outputHint: string;
    outputLabel: string;
    cable: CallCable | null;
    note: string;
  };
  watcher: CallWatcher | null;
};

/** 探测结果里的一扇窗口。 */
export type CallWindow = {
  pid: number;
  title: string;
  process?: string;
  buttons: Array<{ name: string; controlType?: string }>;
};

export type CallDecision = {
  action: 'answer' | 'none';
  reason: string;
  pid?: number;
  buttonName?: string;
  isVideo?: boolean;
  candidates?: string[];
};

export type CallProbeResult = {
  ok: boolean;
  errors: string[];
  windows: CallWindow[];
  decision: CallDecision;
};

export type CallDevices = {
  all: Array<{ name: string; kind: string; state?: string }>;
  virtualCable: CallCable;
};

/**
 * 读 QQ 通话状态。
 *
 * 注意 `mouth.cable` 是**系统端点**视角（装没装虚拟声卡），
 * 跟浏览器 `enumerateDevices()` 的 deviceId 是两回事，不能混用。
 */
export async function fetchCallStatus(): Promise<CallStatus> {
  const response = await fetch('/api/call/status', { cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as Partial<CallStatus> & { error?: string };
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  const mouth = (data.mouth ?? {}) as Partial<CallStatus['mouth']>;
  return {
    enabled: data.enabled === true,
    autoAnswer: data.autoAnswer === true,
    ready: data.ready === true,
    problems: Array.isArray(data.problems) ? data.problems : [],
    platform: data.platform || '',
    watch: data.watch ?? {
      intervalMs: 600,
      windowPattern: '通话',
      answerPattern: '接听|接受|接起',
      rejectPattern: '挂断|拒绝|关闭',
      preferVideo: false,
      cooldownMs: 20000,
    },
    loopback: data.loopback ?? { enabled: false, available: false, reason: '' },
    vad: data.vad ?? { silenceMs: 900, preRollMs: 450, keepTailMs: 300, bargeInRatio: 3 },
    mouth: {
      outputDeviceId: mouth.outputDeviceId || '',
      outputHint: mouth.outputHint || '',
      outputLabel: mouth.outputLabel || '',
      cable: mouth.cable ?? null,
      note: mouth.note || '',
    },
    watcher: data.watcher ?? null,
  };
}

/**
 * 干跑一次窗口扫描 —— 「接听按钮到底叫什么」的唯一可靠来源。
 *
 * 我们手上只有 ohwhale 在 9.9.35 上用的正则，没有本机 QQ 版本的真实按钮名。
 * QQ 一改版这个正则就可能失效，而失效的表现是「来电了它不接」——
 * 用户没法从现象反推原因。所以这个接口必须存在，让人能先看一眼。
 */
export async function probeCallWindows(options: {
  windowPattern?: string;
  answerPattern?: string;
  rejectPattern?: string;
  includeAll?: boolean;
} = {}): Promise<CallProbeResult> {
  const response = await fetch('/api/call/probe', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
  const data = (await response.json().catch(() => ({}))) as Partial<CallProbeResult> & { error?: string };
  if (!response.ok) throw new Error(data.error || `探测失败（HTTP ${response.status}）`);
  return {
    ok: data.ok === true,
    errors: Array.isArray(data.errors) ? data.errors : [],
    windows: Array.isArray(data.windows) ? data.windows : [],
    decision: data.decision ?? { action: 'none', reason: '' },
  };
}

/** 手动点一次「接听」。给「看门狗不敢用，先手动试一次」留条路。 */
export async function answerCall(pid: number, buttonName: string): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch('/api/call/answer', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid, buttonName }),
  });
  const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
  if (!response.ok) throw new Error(data.error || data.message || `接听失败（HTTP ${response.status}）`);
  return { ok: data.ok === true, message: data.message };
}

/** 系统音频端点列表（判断装没装虚拟声卡）。跟浏览器的 enumerateDevices 是两回事。 */
export async function fetchCallDevices(): Promise<CallDevices> {
  const response = await fetch('/api/call/devices', { cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as Partial<CallDevices> & { error?: string };
  if (!response.ok) throw new Error(data.error || `读设备失败（HTTP ${response.status}）`);
  return {
    all: Array.isArray(data.all) ? data.all : [],
    virtualCable: data.virtualCable ?? { state: 'absent', present: false, renderName: '', captureName: '', hint: '' },
  };
}

/**
 * 记住这次把声音送进哪个设备。
 *
 * 传的是**标签**不是 deviceId —— 浏览器 deviceId 按 origin 加盐哈希，
 * 换端口就失效，存了下次也认不回来。传空字符串 = 忘掉这个选择。
 */
export async function saveOutputLabel(label: string): Promise<string> {
  const response = await fetch('/api/call/output', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  const data = (await response.json().catch(() => ({}))) as { outputLabel?: string; error?: string };
  if (!response.ok) throw new Error(data.error || `保存失败（HTTP ${response.status}）`);
  return data.outputLabel || '';
}

export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const response = await fetch('/api/voice/status', { cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as Partial<VoiceStatus> & { error?: string };
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return {
    enabled: data.enabled !== false,
    ready: data.ready === true,
    problems: Array.isArray(data.problems) ? data.problems : [],
    micRequiresSecureContext: data.micRequiresSecureContext !== false,
    wsPath: data.wsPath || '/voice/ws',
    vad: data.vad || { threshold: 0.012, minSpeechMs: 250, silenceMs: 700 },
    asrModel: data.asrModel || '',
    ttsFormat: data.ttsFormat || 'mp3',
    limits: data.limits || { maxCallMs: 600000, maxTurns: 40, idleTimeoutMs: 60000 },
    stats: data.stats ?? null,
  };
}

// 采集用的 worklet。写成字符串而不是独立文件：
// Vite 会把独立 .js 当模块处理，还得配 worker 的打包方式；
// 这里只有十几行，用 Blob URL 注册反而最省事、也不会漏进产物目录。
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // 拷一份再发：这块 buffer 下一帧会被复用，直接发引用会读到已经被覆盖的数据
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('qqagent-capture', CaptureProcessor);
`;

export class VoiceCall {
  private ws: WebSocket | null = null;
  private handlers: VoiceHandlers;
  private stream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private playCtx: AudioContext | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunker: PcmChunker | null = null;
  private mute: GainNode | null = null;
  private playing: AudioBufferSourceNode | null = null;
  private queue: AudioBuffer[] = [];
  private closing = false;
  private state: VoiceState = 'idle';
  private startedAt = 0;

  constructor(handlers: VoiceHandlers = {}) {
    this.handlers = handlers;
  }

  get currentState(): VoiceState {
    return this.state;
  }

  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  private setState(state: VoiceState) {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState?.(state);
  }

  private log(line: string) {
    this.handlers.onLog?.(line);
  }

  /** 连上通话网关，等到后端说 ready 才算打通。 */
  async connect(): Promise<void> {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/voice/ws`;
    this.log(`连接 ${url}`);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('连不上通话网关（超时 8 秒）')), 8000);
      ws.onopen = () => {
        this.log('已连接，等后端就绪…');
      };
      ws.onmessage = (event) => {
        // 二进制 = 合成好的语音，直接进播放队列；文本 = 控制消息
        if (typeof event.data !== 'string') {
          if (event.data instanceof ArrayBuffer) void this.playChunk(event.data);
          return;
        }
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(event.data); } catch { return; }
        this.dispatch(msg);
        if (msg.type === 'ready') {
          window.clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('通话网关连不上（握手失败或没有权限）'));
      };
      ws.onclose = (event) => {
        window.clearTimeout(timer);
        if (!this.closing) {
          this.handlers.onClosed?.(event.reason || '连接已断开');
          this.setState('closed');
        }
        reject(new Error(event.reason || '连接已断开'));
      };
    });

    this.startedAt = Date.now();
    this.setState('listening');
  }

  private dispatch(msg: Record<string, unknown>) {
    const type = String(msg.type || '');
    if (type === 'ready') {
      this.handlers.onReady?.({
        asrModel: String(msg.asrModel || ''),
        ttsFormat: String(msg.ttsFormat || ''),
        vad: msg.vad,
      });
    } else if (type === 'state') {
      this.setState(String(msg.state || 'listening') as VoiceState);
    } else if (type === 'asr') {
      this.handlers.onAsr?.(String(msg.text || ''));
    } else if (type === 'reply') {
      this.handlers.onReply?.(String(msg.text || ''));
    } else if (type === 'error') {
      this.handlers.onError?.(String(msg.message || '出错了'), String(msg.code || ''));
    } else if (type === 'dropped') {
      this.handlers.onDropped?.(String(msg.reason || ''));
    } else if (type === 'stop-playback') {
      // 「抢话」就是这里：立刻停，并把还没播的排队全扔掉
      this.stopPlayback();
    } else if (type === 'closed') {
      this.closing = true;
      this.handlers.onClosed?.(String(msg.reason || '通话结束'));
      this.setState('closed');
    }
  }

  private send(obj: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  /** 打开麦克风并开始推流。 */
  async startCapture(mode: CaptureMode = 'mic'): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('这个浏览器不支持麦克风采集（需要 Chrome / Edge / Firefox）');
    }
    const stream = mode === 'loopback' ? await this.openLoopback() : await this.openMic();
    this.stream = stream;

    // 尽量让浏览器直接给 16k（省一次重采样）；给不了也没关系，下面按实际采样率重采样
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx({ sampleRate: TARGET_RATE });
    this.captureCtx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    this.source = source;

    // 采集到 100ms 一块才发一次，电平回调限到 20 次/秒。
    // 这里刻意**不**每次回调都 setState：真正的渲染节流在页面里（requestAnimationFrame），
    // 客户端只负责把「回调次数」压到人眼分辨率以内。
    const chunker = new PcmChunker(TARGET_RATE, CHUNK_MS);
    this.chunker = chunker;
    let lastLevelAt = 0;

    const emit = (samples: Float32Array) => {
      if (this.closing) return;
      const now = performance.now();
      if (shouldEmitLevel(lastLevelAt, now, LEVEL_INTERVAL_MS)) {
        lastLevelAt = now;
        this.handlers.onLevel?.(rms(samples));
      }
      const pcm = chunker.push(samples, ctx.sampleRate);
      if (!pcm) return;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm.buffer);
    };

    if (ctx.audioWorklet) {
      const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
        const node = new AudioWorkletNode(ctx, 'qqagent-capture');
        node.port.onmessage = (event) => emit(event.data as Float32Array);
        source.connect(node);
        this.node = node;
      } finally {
        URL.revokeObjectURL(url);
      }
    } else {
      // 老浏览器兜底：ScriptProcessorNode 已废弃但仍能用，好过完全没有声音。
      //
      // ⚠️ 绝对不要 node.connect(ctx.destination)。
      // 上一版这么写了 —— 那等于把麦克风原样播回扬声器：用户会听到自己的回声，
      // 而且「它说话时你开口就打断」这条（抢话）会因为输出里永远有自己的声音而永远触发。
      // ScriptProcessor 只要挂在 source 上、不接 destination，大部分浏览器在某些版本里
      // 会因为它"没有被消费"而不触发 onaudioprocess；保险做法是接一个 GainNode
      // 并把它设成 0 —— 图还连着（所以照样出数据），但没有一个采样会出声。
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => emit(new Float32Array(event.inputBuffer.getChannelData(0)));
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      this.node = node;
      this.mute = mute;
      this.log('这台浏览器不支持 AudioWorklet，已退回 ScriptProcessor（能用，但更吃 CPU）');
    }
    this.log(`${mode === 'loopback' ? '系统混音' : '麦克风'}已打开：${ctx.sampleRate}Hz → 重采样到 ${TARGET_RATE}Hz`);
  }

  /** 普通麦克风。回声消除/降噪在"对着电脑说话"时是有益的。 */
  private async openMic(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  /**
   * 系统混音（QQ 正在放出来的对方声音）。
   *
   * 关键点：这条路**必须**关掉回声消除和自动增益。
   * 抓的是已经混好的系统输出，回声消除会把它当成"自己刚放的声音"而削掉，
   * 自动增益会把对方的呼吸声放大成噪音 —— ohwhale 那边踩过，
   * 环回音量被系统调小时靠增益硬拉反而把 ASR 喂成一堆噪声。
   *
   * 只有 Electron 能走这条路（Chromium 的 getDisplayMedia 只给视频，
   * 音频那一路靠 Electron 的 setDisplayMediaRequestHandler 显式授权 loopback）。
   * 普通浏览器里 getDisplayMedia({audio:true}) 会直接抛，这里翻译成人话。
   */
  private async openLoopback(): Promise<MediaStream> {
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (constraints?: MediaStreamConstraints) => Promise<MediaStream>;
    };
    if (typeof md.getDisplayMedia !== 'function') {
      throw new Error('这个环境拿不到系统声音（需要在 QQ Agent 桌面版里打开，普通浏览器不行）');
    }
    let stream: MediaStream;
    try {
      stream = await md.getDisplayMedia({ audio: true, video: false });
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (/Permission|denied|NotAllowed/i.test(message)) {
        throw new Error(
          '系统声音采集被拒绝。请确认是在 QQ Agent 桌面版里打开控制台；' +
            '如果刚更新过版本，重启一次桌面端让权限处理器生效。'
        );
      }
      throw new Error(`拿不到系统声音：${message}`);
    }
    if (!stream.getAudioTracks().length) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('拿到的是画面不是声音（这个环境不支持系统混音采集）');
    }
    return stream;
  }

  /**
   * 主动结束这一句（把没断完的那段强制送去识别）。
   *
   * 顺序很重要：**先冲尾巴、再发 stop**。
   * 攒块之后最后可能有不满 100ms 的半句话还压在本机，直接发 stop 的话
   * 后端收到的是一个少了结尾的音频 —— 用户的感觉是「我最后一个字它没听见」。
   */
  commit() {
    this.flushPending();
    this.send({ type: 'stop' });
  }

  /** 把 chunker 里没攒满的那一块立刻发出去（没有就什么都不做）。 */
  private flushPending() {
    const pcm = this.chunker?.flush();
    if (!pcm || !pcm.length) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm.buffer);
  }

  /** 抢话：让后端停播，同时本地也停。 */
  interrupt() {
    this.send({ type: 'interrupt' });
    this.stopPlayback();
  }

  /** 懒建播放上下文。所有要发声/要切输出设备的地方都走它，别各建各的。 */
  private ensurePlayCtx(): AudioContext | null {
    if (this.playCtx) return this.playCtx;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    this.playCtx = new Ctx();
    return this.playCtx;
  }

  /** 播放一段合成音频（二进制帧）。 */
  async playChunk(data: ArrayBuffer) {
    if (!data.byteLength) return;
    try {
      const ctx = this.ensurePlayCtx();
      if (!ctx) throw new Error('这个环境没有 AudioContext');
      if (ctx.state === 'suspended') await ctx.resume();
      const buffer = await ctx.decodeAudioData(data.slice(0));
      this.queue.push(buffer);
      this.drainQueue();
    } catch (error) {
      this.handlers.onError?.(`音频解码失败：${(error as Error)?.message ?? error}`, 'decode-failed');
    }
  }

  private drainQueue() {
    if (this.playing || !this.queue.length || !this.playCtx) return;
    const buffer = this.queue.shift()!;
    const src = this.playCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.playCtx.destination);
    src.onended = () => {
      if (this.playing === src) this.playing = null;
      this.drainQueue();
    };
    this.playing = src;
    src.start();
  }

  stopPlayback() {
    this.queue = [];
    if (this.playing) {
      try { this.playing.onended = null; this.playing.stop(); } catch { /* 已经停了 */ }
      this.playing = null;
    }
  }

  /**
   * 把播放输出切到指定设备（「嘴」：TTS 的声音要进虚拟声卡，QQ 才会当成麦克风输入）。
   *
   * 两个坑：
   * 1. `AudioContext.setSinkId()` 在 Chromium 110+ 才有，而且 TypeScript 的
   *    lib.dom 只给 HTMLMediaElement 声明了它，AudioContext 上没声明 —— 所以要断言。
   * 2. 传进来的必须是**浏览器自己的** deviceId（`enumerateDevices()` 里那个），
   *    不是 Windows 的 `{0.0.0.00000000}.{guid}`。后者塞进来会抛 NotFoundError，
   *    而且报错信息完全看不出是"id 类型搞错了"。
   *
   * 返回 false 表示这台浏览器/这个上下文不支持，调用方要给出人话提示，
   * 不能假装成功 —— 否则用户以为声音进了声卡，对方其实什么都没听到。
   */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    const wanted = String(deviceId || '').trim();
    // 播放上下文是懒建的：通话刚开始还没播过任何东西时它是 null。
    // 这里必须主动建一个 —— 否则"接通时就把出口摆好"这一步会永远返回 false，
    // 面板就会报"不支持切换输出设备"，而实际上只是还没建上下文。
    // 调用点在按钮的点击处理里，属于用户手势，建 AudioContext 不会被浏览器拦。
    const ctx = this.ensurePlayCtx() as
      | (AudioContext & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (!ctx || typeof ctx.setSinkId !== 'function') return false;
    try {
      // 空字符串 = 系统默认设备，是合法值
      await ctx.setSinkId(wanted);
      this.log(wanted ? `播放输出已切到设备 ${wanted}` : '播放输出已切回系统默认设备');
      return true;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      if (/NotFound/i.test(message)) {
        throw new Error(
          '这个输出设备浏览器不认。要选浏览器枚举出来的设备（面板里那个下拉框），' +
            '不能填 Windows 的设备 id。'
        );
      }
      if (/NotAllowed|Permission/i.test(message)) {
        throw new Error('切换输出设备被拒绝：需要「扬声器选择」权限（桌面版里已放行，浏览器里不行）。');
      }
      throw new Error(`切换输出设备失败：${message}`);
    }
  }

  /** 当前播放输出是否可切换（前端据此决定要不要显示下拉框）。 */
  canSelectOutput(): boolean {
    const ctx = this.ensurePlayCtx();
    if (!ctx) return false;
    return typeof (ctx as AudioContext & { setSinkId?: unknown }).setSinkId === 'function';
  }

  /** 挂断：停采集、停播放、关连接。 */
  async close() {
    // 先冲掉尾巴，再标记 closing —— 顺序反了 flushPending 里的 send 会被拦。
    this.flushPending();
    this.closing = true;
    this.stopPlayback();
    try { this.send({ type: 'stop' }); } catch { /* ignore */ }
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.mute?.disconnect(); } catch { /* ignore */ }
    this.node = null;
    this.source = null;
    this.mute = null;
    this.chunker = null;
    for (const track of this.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* ignore */ }
    }
    this.stream = null;
    try { await this.captureCtx?.close(); } catch { /* ignore */ }
    try { await this.playCtx?.close(); } catch { /* ignore */ }
    this.captureCtx = null;
    this.playCtx = null;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.setState('closed');
  }
}
