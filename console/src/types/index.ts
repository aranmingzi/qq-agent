export type SessionStatus = 'running' | 'done' | 'noreply' | 'error' | 'aborted';

export type SessionFilter = 'all' | SessionStatus;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface Mood {
  score: number;
  label: string;
  lastInteractionAt: number;
  lastUpdatedAt: number;
  decayStage: number;
}

export interface SessionSummary {
  id: string;
  chatKey: string;
  chatName: string;
  startedAt: number;
  endedAt?: number | null;
  status: SessionStatus;
  trigger: string;
  triggerSummary: string;
  model: string;
  rounds: number;
  usage: TokenUsage;
  mood?: Mood | null;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown> | string;
  result: string;
  isError?: boolean;
}

export type SessionMessage =
  | {
      kind: 'assistant';
      role: 'assistant';
      content: string;
      toolCalls?: unknown[];
    }
  | {
      kind: 'tool';
      toolCall: ToolCallRecord;
    }
  | {
      kind: 'tool-images';
      tool: string;
      count: number;
    };

export interface SentMessage {
  type?: string;
  text: string;
  at?: string;
}

export interface SessionDetail extends SessionSummary {
  triggerText?: string;
  systemPrompt?: string;
  userPrompt?: string;
  promptChars?: number;
  messages: SessionMessage[];
  sent: SentMessage[];
  error?: string | null;
  finishReason?: string | null;
  feedbacks?: unknown[];
  modelChain?: string[];
}

export interface ChatSummary {
  key: string;
  chatKey: string;
  total: number;
  unread: number;
  lastTs: number;
  lastText: string;
  mood?: Mood | null;
}

export interface ChatMessage {
  id: number | string;
  mid: number | string;
  ts: number;
  senderId: string;
  senderName: string;
  text: string;
  self: boolean;
  read: boolean;
  reply: string | null;
}

export interface Account {
  nickname: string;
  userId: string;
}

export interface AppStatus {
  onebot: {
    connected: boolean;
    healthy: boolean;
    self: Account | null;
    account: { online: boolean | null };
  };
  snowluma: {
    running: boolean;
    dir: string;
    webuiUrl?: string;
  };
  orchestrator: {
    model: string;
    complexModel?: string;
    paused: boolean;
    running?: string[];
  };
  usage: {
    runs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    dayKey?: string;
    cost?: number;
  };
  paused: boolean;
  pauseReason?: string | null;
}

export interface Provider {
  id: string;
  displayName: string;
  baseURL: string;
  models: string[];
  modelNames?: Record<string, string>;
  apiKey?: string;
  apiKeyFrom?: string;
  hasKey?: boolean;
  needsBaseUrl?: boolean;
}

/**
 * 控制台只保留「是否已配置」和掩码提示，绝不把后端明文密钥放进组件树。
 * 后端 /api/config 目前会回传明文，适配层会立即丢弃，仅生成 maskedHint。
 */
export interface ApiConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
  temperature: number;
  maxRounds: number;
  maxOutputTokens: number;
  complexMaxOutputTokens: number;
  complexModel: string;
  thinkingMode: 'off' | 'auto';
  vision: boolean;
  routing: {
    enabled: boolean;
    auto: boolean;
    allowModelEscalation: boolean;
  };
  preset: string | null;
}

export interface VisionConfig {
  mode: 'native' | 'qwen';
  qwen: {
    baseUrl: string;
    model: string;
    apiKeyConfigured: boolean;
    apiKeyHint: string;
  };
}

export interface WebSearchConfig {
  enabled: boolean;
  provider: 'auto' | 'bing' | 'anysearch';
  searchUrl: string;
  anysearchKeyConfigured: boolean;
  anysearchKeyCount: number;
}

export interface ModelConfigBundle {
  api: ApiConfig;
  providers: Provider[];
  vision: VisionConfig;
  webSearch: WebSearchConfig;
}

export type PresetId = 'fast' | 'balanced' | 'complex' | 'tutor';

export interface BrainPreset {
  id: PresetId;
  name: string;
  description: string;
  temperature: number;
  maxOutputTokens: number;
  complexMaxOutputTokens: number;
  thinkingMode: 'off' | 'auto';
  maxRounds: number;
}

export interface ToolParam {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface ToolCapability {
  name: string;
  group: string;
  description: string;
  masterOnly: boolean;
  params: ToolParam[];
}

export interface Capabilities {
  total: number;
  tools: ToolCapability[];
  features: {
    identityModes: string[];
    kb: 'ready' | 'missing' | string;
    search: {
      enabled: boolean;
      provider: string;
      anysearchAvailable: boolean;
      effective: string;
    };
    scheduled: {
      count: number;
      items: unknown[];
    };
  };
}

export interface SnowLumaLogLine {
  id: string;
  at: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  text: string;
}

export type DataMode = 'demo' | 'live';

export interface PersonaConfig {
  botName: string;
  selfNickname: string;
  participation: 'low' | 'medium' | 'high';
  roleText: string;
  customRules: string;
}

export interface PersonaTemplate {
  id: string;
  name: string;
  text: string;
  customRules?: string;
  builtin: boolean;
}

export interface AllowConfig {
  groups: string[];
  private: string[];
}

export interface SendConfig {
  minGapMs: number;
  maxGapMs: number;
  maxPerMinute: number;
}

export interface ProactiveConfig {
  enabled: boolean;
  checkIntervalMinMs: number;
  checkIntervalMaxMs: number;
  probability: number;
}

/** QQ 通话（真 QQ 客户端里的通话，不是控制台内的语音通话）。见 src/config.js call 段。 */
export interface CallConfig {
  enabled: boolean;
  autoAnswer: boolean;
  scanIntervalMs: number;
  answerCooldownMs: number;
  windowPattern: string;
  answerPattern: string;
  rejectPattern: string;
  preferVideo: boolean;
  loopbackEnabled: boolean;
  vadSilenceMs: number;
  vadPreRollMs: number;
  vadKeepTailMs: number;
  bargeInRatio: number;
  outputDeviceId: string;
  outputHint: string;
  outputLabel: string;
}

export interface AudioConfig {
  enabled: boolean;
  model: string;
  voice: string;
  instruction: string;
  maxChars: number;
  /** 角色本音：实际发声音色的唯一真相源（hutao/nahida/sparkle/liuying/furina/ayaka/robin） */
  gsvVoice: string;
  /** 是否允许模型在单次回复里用 args.voice 临时换音色（默认 false） */
  gsvAllowModelPick: boolean;
  /** 角色本音服务没在跑时，发语音前自动拉起 */
  gsvAutoStart: boolean;
  /** 随语气自动调速（按标点/语气词给语速乘 0.88~1.26 的倍率） */
  prosodyAuto?: boolean;
  /** 按语境换语气：把此刻情绪翻译成参考音频 + 语速 + 韵律参数（默认 true） */
  toneAuto?: boolean;
  /** 情绪强度 0~1.5；0 = 完全按老样子 */
  toneStrength?: number;
  /** 是否下发 temperature/top_k/top_p/fragment_interval/repetition_penalty */
  toneParams?: boolean;
  /** CFM 扩散步数（默认 32）。只对 v4 音色生效，越低越快、音质越差 */
  gsvSampleSteps?: number;
  /** 随机种子。-1 = 每次随机；固定值 = 同句同结果（A/B 用） */
  gsvSeed?: number;
  rvc: {
    enabled: boolean;
    model: string;
    device: string;
    f0upKey: number;
    method: string;
    protect: number;
    indexRate: number;
    enhance: number;
    fallbackToRaw: boolean;
    /** true = 胡桃也走「TTS→RVC」快路径，不用本音模型 */
    preferOverGsv: boolean;
  };
  svc: {
    enabled: boolean;
    mixInstrumental: boolean;
    singDry: boolean;
    coverDry: boolean;
    /** 原曲翻唱的人声分离后端：htdemucs | htdemucs_ft | mdx_kim | mdx_vocft */
    separator: string;
    allowImprovise: boolean;
  };
}

export interface SnowlumaConfig {
  dir: string;
  autoLaunch: boolean;
  wsUrl: string;
  httpUrl: string;
  accessToken: string;
  httpAccessToken: string;
}

export interface AppConfig {
  api: {
    baseUrl: string;
    apiKey: string;
    model: string;
    provider: string;
    temperature: number;
    maxRounds: number;
    maxOutputTokens: number;
    complexMaxOutputTokens: number;
    complexModel: string;
    thinkingMode: 'off' | 'auto';
    vision: boolean;
    preset: string;
    routing?: {
      enabled: boolean;
      auto: boolean;
      allowModelEscalation: boolean;
    };
  };
  providers: Provider[];
  vision: VisionConfig & {
    qwen: VisionConfig['qwen'] & { apiKey: string };
  };
  webSearch: WebSearchConfig & { anysearchKeys?: string[] };
  persona: PersonaConfig;
  allow: AllowConfig;
  deny?: AllowConfig;
  allowAllWhenEmpty?: boolean;
  wakeDelayMs: number;
  directWakeDelayMs: number;
  drainDelayMs: number;
  maxConcurrentRuns: number;
  send: SendConfig;
  proactive: ProactiveConfig;
  sticker: { enabled: boolean };
  store: {
    pastStateLimit: number;
    pastStateMaxChars: number;
    maxMessagesPerChat?: number;
  };
  server: {
    port: number;
    autoStart: boolean;
    closeToTray: boolean;
  };
  snowluma: SnowlumaConfig;
  audio: AudioConfig;
  call?: CallConfig;
  customPersonas?: Array<{ name: string; text: string; customRules?: string }>;
  [key: string]: unknown;
}

export interface OneBotAccountItem {
  id: string;
  name: string;
}

export interface SnowLumaQrInfo {
  exists: boolean;
  qrAt: string;
  ageMs: number;
  loggedIn: boolean;
  self?: { userId: string; nickname: string } | null;
}

export interface SnowLumaLoginInfo {
  available: boolean;
  running: boolean;
  port?: number;
}

export interface SnowLumaLoginStatus {
  quickList: string[];
  status?: Record<string, unknown>;
}

export interface RvcStatus {
  ok: boolean;
  enabled: boolean;
  running: boolean;
  health?: {
    ok?: boolean;
    loaded?: boolean;
    model?: string;
    device?: string;
    gpu?: string;
    lastError?: string;
    uptimeSec?: number;
  } | null;
  models?: Array<{ name: string; file?: string; sizeMB?: number }>;
}

