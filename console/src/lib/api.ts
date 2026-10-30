import type {
  AppConfig,
  AppStatus,
  BrainPreset,
  Capabilities,
  ChatMessage,
  ChatSummary,
  ModelConfigBundle,
  Mood,
  OneBotAccountItem,
  PersonaTemplate,
  Provider,
  RvcStatus,
  SessionDetail,
  SessionMessage,
  SessionStatus,
  SessionSummary,
  SnowLumaLoginInfo,
  SnowLumaLogLine,
  SnowLumaQrInfo,
  TokenUsage,
  ToolParam,
} from '@/types';
import { demoPresets } from '@/lib/demo-data';
import { chatLabel, maskSecret } from '@/lib/format';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof data.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asNumber = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const asString = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;

function normalizeUsage(raw: unknown): TokenUsage {
  const value = asRecord(raw);
  return {
    promptTokens: asNumber(value.promptTokens),
    completionTokens: asNumber(value.completionTokens),
    totalTokens: asNumber(value.totalTokens),
    calls: asNumber(value.calls),
  };
}

function normalizeMood(raw: unknown): Mood | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = asRecord(raw);
  if (!value.label) return null;
  return {
    score: asNumber(value.score, 50),
    label: asString(value.label, '平静'),
    lastInteractionAt: asNumber(value.lastInteractionAt),
    lastUpdatedAt: asNumber(value.lastUpdatedAt),
    decayStage: asNumber(value.decayStage),
  };
}

const sessionStatuses: SessionStatus[] = ['running', 'done', 'noreply', 'error', 'aborted'];

function normalizeStatus(value: unknown): SessionStatus {
  const status = asString(value) as SessionStatus;
  return sessionStatuses.includes(status) ? status : 'done';
}

export function normalizeSessionSummary(raw: unknown): SessionSummary {
  const value = asRecord(raw);
  const chatKey = asString(value.chatKey);
  return {
    id: asString(value.id),
    chatKey,
    chatName: chatLabel(chatKey, asString(value.chatName)),
    startedAt: asNumber(value.startedAt),
    endedAt: value.endedAt == null ? null : asNumber(value.endedAt),
    status: normalizeStatus(value.status),
    trigger: asString(value.triggerSummary, asString(value.trigger)),
    triggerSummary: asString(value.triggerSummary, asString(value.trigger)),
    model: asString(value.model, '—'),
    rounds: asNumber(value.rounds),
    usage: normalizeUsage(value.usage),
    mood: normalizeMood(value.mood),
  };
}

function normalizeSessionMessage(raw: unknown): SessionMessage | null {
  const item = asRecord(raw);
  const toolCall = asRecord(item.toolCall);
  if (item.toolCall) {
    return {
      kind: 'tool',
      toolCall: {
        name: asString(toolCall.name, 'tool'),
        args:
          typeof toolCall.args === 'string'
            ? toolCall.args
            : (asRecord(toolCall.args) as Record<string, unknown>),
        result: asString(toolCall.result, ''),
        isError: Boolean(toolCall.isError),
      },
    };
  }

  const toolImages = asRecord(item.toolImages);
  if (item.toolImages) {
    return {
      kind: 'tool-images',
      tool: asString(toolImages.tool, 'image_input'),
      count: asNumber(toolImages.count),
    };
  }

  if (item.role === 'assistant') {
    const content = asString(item.content);
    const hasToolCalls = Array.isArray(item.tool_calls) && item.tool_calls.length > 0;
    if (hasToolCalls && !content.trim()) return null;
    return {
      kind: 'assistant',
      role: 'assistant',
      content: content || '（无文本输出，仅调用工具）',
    };
  }

  return null;
}

export function normalizeSessionDetail(raw: unknown): SessionDetail {
  const value = asRecord(raw);
  const summary = normalizeSessionSummary(value);
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeSessionMessage).filter((item): item is SessionMessage => Boolean(item))
    : [];
  const sent = Array.isArray(value.sent)
    ? value.sent.map((item) => {
        const entry = asRecord(item);
        return {
          type: asString(entry.type, 'text'),
          text: asString(entry.text),
          at: asString(entry.at),
        };
      })
    : [];

  return {
    ...summary,
    triggerText: asString(value.triggerText, summary.triggerSummary),
    systemPrompt: asString(value.systemPrompt) || undefined,
    userPrompt: asString(value.userPrompt) || undefined,
    promptChars: value.promptChars == null ? undefined : asNumber(value.promptChars),
    messages,
    sent,
    error: value.error == null ? null : asString(value.error),
    finishReason: value.finishReason == null ? null : asString(value.finishReason),
    feedbacks: Array.isArray(value.feedbacks) ? value.feedbacks : [],
    modelChain: Array.isArray(value.modelChain) ? value.modelChain.map(String) : [],
  };
}

export function normalizeStatusPayload(raw: unknown): AppStatus {
  const value = asRecord(raw);
  const onebot = asRecord(value.onebot);
  const account = asRecord(onebot.account);
  const self = asRecord(onebot.self);
  const snowluma = asRecord(value.snowluma);
  const orchestrator = asRecord(value.orchestrator);
  const usage = asRecord(value.usage);

  return {
    onebot: {
      connected: Boolean(onebot.connected),
      healthy: Boolean(onebot.healthy),
      self: onebot.self
        ? {
            nickname: asString(self.nickname, 'QQ 账号'),
            userId: asString(self.userId),
          }
        : null,
      account: {
        online: account.online == null ? null : Boolean(account.online),
      },
    },
    snowluma: {
      running: Boolean(snowluma.running),
      dir: asString(snowluma.dir),
      webuiUrl: asString(snowluma.webuiUrl),
    },
    orchestrator: {
      model: asString(orchestrator.model, '—'),
      complexModel: asString(orchestrator.complexModel),
      paused: Boolean(orchestrator.paused),
      running: Array.isArray(orchestrator.running) ? orchestrator.running.map(String) : [],
    },
    usage: {
      runs: asNumber(usage.runs),
      promptTokens: asNumber(usage.promptTokens),
      completionTokens: asNumber(usage.completionTokens),
      totalTokens: asNumber(usage.totalTokens),
      dayKey: asString(usage.dayKey),
      cost: asNumber(usage.cost),
    },
    paused: Boolean(value.paused),
    pauseReason: value.pauseReason == null ? null : asString(value.pauseReason),
  };
}

export function normalizeProviders(raw: unknown): Provider[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const value = asRecord(item);
    const modelNames = Object.entries(asRecord(value.modelNames)).reduce<Record<string, string>>(
      (acc, [key, label]) => {
        if (typeof label === 'string') acc[key] = label;
        return acc;
      },
      {},
    );
    return {
      id: asString(value.id),
      displayName: asString(value.displayName, asString(value.id, '未命名服务商')),
      baseURL: asString(value.baseURL, asString(value.baseUrl)),
      models: Array.isArray(value.models) ? value.models.map(String) : [],
      modelNames,
      apiKey: asString(value.apiKey),
      apiKeyFrom: asString(value.apiKeyFrom),
      hasKey: Boolean(value.hasKey ?? value.apiKey),
      needsBaseUrl: Boolean(value.needsBaseUrl),
    };
  });
}

/** 从 /api/config 中只提取安全字段，明文密钥在函数返回前即被丢弃。 */
export function normalizeConfig(raw: unknown): ModelConfigBundle {
  const value = asRecord(raw);
  const api = asRecord(value.api);
  const vision = asRecord(value.vision);
  const qwen = asRecord(vision.qwen);
  const webSearch = asRecord(value.webSearch);
  const keys = Array.isArray(webSearch.anysearchKeys) ? webSearch.anysearchKeys : [];
  const routing = asRecord(api.routing);
  const apiKey = asString(api.apiKey);
  const qwenKey = asString(qwen.apiKey);

  return {
    api: {
      provider: asString(api.provider),
      baseUrl: asString(api.baseUrl, asString(api.baseURL)),
      model: asString(api.model),
      apiKeyConfigured: Boolean(apiKey),
      apiKeyHint: apiKey ? maskSecret(apiKey) : '',
      temperature: asNumber(api.temperature, 0.8),
      maxRounds: asNumber(api.maxRounds, 6),
      maxOutputTokens: asNumber(api.maxOutputTokens, 800),
      complexMaxOutputTokens: asNumber(api.complexMaxOutputTokens, 2_000),
      complexModel: asString(api.complexModel),
      thinkingMode: api.thinkingMode === 'off' ? 'off' : 'auto',
      vision: api.vision !== false,
      routing: {
        enabled: routing.enabled !== false,
        auto: routing.auto !== false,
        allowModelEscalation: routing.allowModelEscalation !== false,
      },
      preset: asString(api.preset) || null,
    },
    providers: normalizeProviders(value.providers),
    vision: {
      mode: vision.mode === 'native' ? 'native' : 'qwen',
      qwen: {
        baseUrl: asString(qwen.baseUrl),
        model: asString(qwen.model, 'qwen3-vl-plus'),
        apiKeyConfigured: Boolean(qwenKey),
        apiKeyHint: qwenKey ? maskSecret(qwenKey) : '',
      },
    },
    webSearch: {
      enabled: webSearch.enabled !== false,
      provider:
        webSearch.provider === 'bing' || webSearch.provider === 'anysearch'
          ? webSearch.provider
          : 'auto',
      searchUrl: asString(webSearch.searchUrl, 'https://cn.bing.com/search'),
      anysearchKeyConfigured: keys.some((key) => String(key ?? '').trim()),
      anysearchKeyCount: keys.filter((key) => String(key ?? '').trim()).length,
    },
  };
}

/**
 * /api/presets 只返回展示字段，不返回数值。这里以项目 brain-presets.js 的当前值为准，
 * 后端新增/调整预设时应改为由接口返回这些字段（见 DESIGN.md 的假设）。
 */
export function normalizePresets(raw: unknown): BrainPreset[] {
  const value = asRecord(raw);
  const list = Array.isArray(value.presets) ? value.presets : [];
  if (!list.length) return demoPresets;
  return list
    .map((item) => {
      const entry = asRecord(item);
      const id = asString(entry.id);
      const base = demoPresets.find((preset) => preset.id === id);
      if (!base) return null;
      return {
        ...base,
        name: asString(entry.name, base.name),
        description: asString(entry.desc, base.description),
      };
    })
    .filter((preset): preset is BrainPreset => Boolean(preset));
}

export function normalizeChats(raw: unknown): ChatSummary[] {
  const value = asRecord(raw);
  const list = Array.isArray(value.chats) ? value.chats : [];
  return list.map((item) => {
    const entry = asRecord(item);
    const chatKey = asString(entry.chatKey, asString(entry.key));
    return {
      key: asString(entry.key, chatKey),
      chatKey,
      total: asNumber(entry.total),
      unread: asNumber(entry.unread),
      lastTs: asNumber(entry.lastTs),
      lastText: asString(entry.lastText),
      mood: normalizeMood(entry.mood),
    };
  });
}

export function normalizeChatMessages(raw: unknown): ChatMessage[] {
  const value = asRecord(raw);
  const list = Array.isArray(value.messages) ? value.messages : [];
  return list.map((item) => {
    const entry = asRecord(item);
    return {
      id: (entry.id as string | number) ?? '',
      mid: (entry.mid as string | number) ?? '',
      ts: asNumber(entry.ts),
      senderId: asString(entry.senderId),
      senderName: asString(entry.senderName, '未知'),
      text: asString(entry.text),
      self: Boolean(entry.self),
      read: Boolean(entry.read),
      reply: entry.reply == null ? null : asString(entry.reply),
    };
  });
}

export function normalizeCapabilities(raw: unknown): Capabilities {
  const value = asRecord(raw);
  const features = asRecord(value.features);
  const search = asRecord(features.search);
  const scheduled = asRecord(features.scheduled);
  const tools = Array.isArray(value.tools)
    ? value.tools.map((item) => {
        const entry = asRecord(item);
        const params: ToolParam[] = Array.isArray(entry.params)
          ? entry.params.map((param) => {
              if (typeof param === 'string') {
                return { name: param, type: undefined, required: undefined, description: undefined };
              }
              const record = asRecord(param);
              return {
                name: asString(record.name),
                type: record.type == null ? undefined : String(record.type),
                required:
                  typeof record.required === 'boolean' ? record.required : undefined,
                description: asString(record.description) || undefined,
              };
            })
          : [];
        return {
          name: asString(entry.name),
          group: asString(entry.group, '其它'),
          description: asString(entry.description),
          masterOnly: Boolean(entry.masterOnly),
          params,
        };
      })
    : [];

  return {
    total: asNumber(value.total, tools.length),
    tools,
    features: {
      identityModes: Array.isArray(features.identityModes)
        ? features.identityModes.map(String)
        : [],
      kb: asString(features.kb, 'missing'),
      search: {
        enabled: Boolean(search.enabled),
        provider: asString(search.provider, 'auto'),
        anysearchAvailable: Boolean(search.anysearchAvailable),
        effective: asString(search.effective, '—'),
      },
      scheduled: {
        count: asNumber(scheduled.count),
        items: Array.isArray(scheduled.items) ? scheduled.items : [],
      },
    },
  };
}

export function normalizeLogs(raw: unknown): SnowLumaLogLine[] {
  const value = asRecord(raw);
  const list = Array.isArray(value.logs) ? value.logs : [];
  const now = Date.now();
  return list.map((line, index) => {
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    const level = /error|fail|timeout/i.test(text)
      ? 'error'
      : /warn|delay|retry/i.test(text)
        ? 'warn'
        : /debug|event/i.test(text)
          ? 'debug'
          : 'info';
    return {
      id: `live-log-${now}-${index}`,
      at: now,
      level,
      text,
    };
  });
}

// ── 运行体检 / 表达库（2026-10-22 生态借鉴落地）──────────────────────────────
//
// 这三块数据的共同点：**都是"她自己的运行状态"，不是配置**。
// 所以归一化的纪律是「缺字段就省略，不编默认值」—— 编了会让人以为系统真检测过。

export type RiskLevel = 'ok' | 'info' | 'warn' | 'critical';

export interface RiskItem {
  code: string;
  level: RiskLevel;
  title: string;
  detail: string;
  hint: string;
}

export interface RiskAudit {
  level: RiskLevel;
  summary: string;
  items: RiskItem[];
  checkedAt: number;
}

const RISK_LEVELS: RiskLevel[] = ['ok', 'info', 'warn', 'critical'];

function normalizeRiskLevel(value: unknown): RiskLevel {
  const level = String(value ?? '');
  return (RISK_LEVELS as string[]).includes(level) ? (level as RiskLevel) : 'ok';
}

export function normalizeRiskAudit(raw: unknown): RiskAudit {
  const value = asRecord(raw);
  const rows = Array.isArray(value.items) ? value.items : [];
  return {
    level: normalizeRiskLevel(value.level),
    summary: String(value.summary ?? ''),
    checkedAt: asNumber(value.checkedAt, 0),
    items: rows.map((row) => {
      const item = asRecord(row);
      return {
        code: String(item.code ?? ''),
        level: normalizeRiskLevel(item.level),
        title: String(item.title ?? ''),
        detail: String(item.detail ?? ''),
        hint: String(item.hint ?? ''),
      };
    }),
  };
}

/** 结果不确定的发送（`OUTCOME_UNKNOWN`）：没结清之前绝不原样重发。 */
export interface PendingSend {
  fp: string;
  chatKey: string;
  text: string;
  error: string;
  kind: string;
  at: number;
  tries: number;
}

export interface PendingSendBundle {
  open: number;
  resolved: number;
  expired: number;
  total: number;
  file: string;
  items: PendingSend[];
}

export function normalizePendingSends(raw: unknown): PendingSendBundle {
  const value = asRecord(raw);
  const rows = Array.isArray(value.items) ? value.items : [];
  return {
    open: asNumber(value.open, 0),
    resolved: asNumber(value.resolved, 0),
    expired: asNumber(value.expired, 0),
    total: asNumber(value.total, 0),
    file: String(value.file ?? ''),
    items: rows.map((row) => {
      const item = asRecord(row);
      return {
        fp: String(item.fp ?? ''),
        chatKey: String(item.chatKey ?? ''),
        text: String(item.text ?? ''),
        error: String(item.error ?? ''),
        kind: String(item.kind ?? 'text'),
        at: asNumber(item.at, 0),
        tries: asNumber(item.tries, 1),
      };
    }),
  };
}

/** 一句「表达」（口头禅/语气词）。候选库永不生效，转正才进语感参考。 */
export interface ExpressionEntry {
  id: string;
  text: string;
  /** 派生值：count × 衰减因子²，15 天不出现趋近 0。 */
  weight: number;
  count: number;
  chatKeys: string[];
  firstSeen: number;
  lastSeen: number;
  source: string;
}

export interface ExpressionBundle {
  pending: ExpressionEntry[];
  library: ExpressionEntry[];
  stats: { pending: number; library: number };
}

export function normalizeExpressions(raw: unknown): ExpressionBundle {
  const value = asRecord(raw);
  const stats = asRecord(value.stats);
  const map = (rows: unknown): ExpressionEntry[] =>
    (Array.isArray(rows) ? rows : []).map((row) => {
      const item = asRecord(row);
      return {
        id: String(item.id ?? ''),
        text: String(item.text ?? ''),
        weight: asNumber(item.weight, 0),
        count: asNumber(item.count, 0),
        chatKeys: Array.isArray(item.chatKeys) ? item.chatKeys.map(String) : [],
        firstSeen: asNumber(item.firstSeen, 0),
        lastSeen: asNumber(item.lastSeen, 0),
        source: String(item.source ?? ''),
      };
    });
  return {
    pending: map(value.pending),
    library: map(value.library),
    stats: { pending: asNumber(stats.pending, 0), library: asNumber(stats.library, 0) },
  };
}

/**
 * 跳过记录：她**决定不说话**的那一笔账。
 *
 * 与闸门判定的区别：闸门判定说的是"这条消息要不要叫她"，跳过记录说的是
 * "叫了之后为什么这一轮什么都没发出去"（额度满、退避中、判据不接、出错…）。
 * 前者一条消息一条，后者一轮一条。
 */
export interface SkipRecord {
  stage: string;
  chatKey: string;
  reason: string;
  detail: Record<string, unknown>;
  traceId: string;
  at: number;
  /** 服务端翻译好的中文短标签（唯一实现在 src/skip-labels.js）。 */
  label: string;
  /** 一句话解释。 */
  hint: string;
  /** 该怎么办；空串表示正常现象不用管。 */
  action: string;
  /** 这一轮有没有花模型钱 —— 用户真正关心的是这个。 */
  spent: boolean;
}

/** 一条按次数聚合的跳过统计，服务端已翻译并排好序。 */
export interface SkipStatRow {
  stage: string;
  count: number;
  label: string;
  hint: string;
  action: string;
  spent: boolean;
}

export interface SkipBundle {
  items: SkipRecord[];
  rows: SkipStatRow[];
  summary: string;
  stages: SkipStatRow[];
}

export function normalizeSkips(raw: unknown): SkipBundle {
  const value = asRecord(raw);
  const rows = Array.isArray(value.items) ? value.items : [];
  const statRows = Array.isArray(value.rows) ? value.rows : [];
  const stages = Array.isArray(value.stages) ? value.stages : [];
  const mapRow = (row: unknown): SkipStatRow => {
    const item = asRecord(row);
    const stage = asString(item.stage);
    return {
      stage,
      count: asNumber(item.count, 0),
      // 服务端一定会给标签；万一拿到旧版本响应，退回 stage 原文而不是空白
      label: asString(item.label) || stage,
      hint: asString(item.hint),
      action: asString(item.action),
      spent: item.spent === true,
    };
  };
  return {
    items: rows.map((row) => {
      const item = asRecord(row);
      const stage = asString(item.stage);
      return {
        stage,
        chatKey: asString(item.chatKey),
        reason: asString(item.reason),
        detail: asRecord(item.detail),
        traceId: asString(item.traceId),
        at: asNumber(item.at, 0),
        label: asString(item.label) || stage,
        hint: asString(item.hint),
        action: asString(item.action),
        spent: item.spent === true,
      };
    }),
    rows: statRows.map(mapRow),
    summary: asString(value.summary),
    stages: stages.map(mapRow),
  };
}

/** 闸门最后判定：把"她刚才为什么回/不回"变成能读的一行。 */
export interface GateDecision {
  chatKey: string;
  at: number;
  wake: boolean;
  reason: string;
  tier: string;
  kind: string;
  wouldSkip: boolean;
  probability: number | null;
  score: number | null;
  continuation: boolean;
  signals: {
    question: boolean;
    multiParty: boolean;
    recentSelf: boolean;
    longSilence: boolean;
    lengthFit: number;
    count: number;
    senders: number;
  } | null;
  /** 说"等被叫"时剩下多久（毫秒）。 */
  waitRemainingMs: number;
  traceId: string;
  /** 寻址：这批里有人明着在跟别人说（@别人 / 引用别人的话）。 */
  toOther: boolean;
  /** 寻址：最后两条来自两个不同的人 —— 那两个人在对谈，她是旁人。 */
  sideTalk: boolean;
  /** 寻址降权倍率（1 = 没降）。 */
  addrMul: number;
}

export function normalizeGateDecisions(raw: unknown): GateDecision[] {
  const value = asRecord(raw);
  const rows = Array.isArray(value.items) ? value.items : [];
  return rows.map((row) => {
    const item = asRecord(row);
    const sig = asRecord(item.signals);
    const hasSignals = Object.keys(sig).length > 0;
    return {
      chatKey: String(item.chatKey ?? ''),
      at: asNumber(item.at, 0),
      wake: item.wake === true,
      reason: String(item.reason ?? ''),
      tier: String(item.tier ?? ''),
      kind: String(item.kind ?? ''),
      wouldSkip: item.wouldSkip === true,
      probability: typeof item.probability === 'number' ? item.probability : null,
      score: typeof item.score === 'number' ? item.score : null,
      continuation: item.continuation === true,
      waitRemainingMs: asNumber(item.waitRemainingMs, 0),
      traceId: String(item.traceId ?? ''),
      toOther: item.toOther === true,
      sideTalk: item.sideTalk === true,
      addrMul: asNumber(item.addrMul, 1),
      signals: hasSignals
        ? {
            question: sig.question === 1 || sig.question === true,
            multiParty: sig.multiParty === 1 || sig.multiParty === true,
            recentSelf: sig.recentSelf === 1 || sig.recentSelf === true,
            longSilence: sig.longSilence === 1 || sig.longSilence === true,
            lengthFit: asNumber(sig.lengthFit, 0),
            count: asNumber(sig.count, 0),
            senders: asNumber(sig.senders, 0),
          }
        : null,
    };
  });
}

/** 协议端重连预算：耗尽后不会自己再连，只能人工点重试。 */
export interface RestartState {
  windowMs: number;
  max: number;
  failures: number;
  remaining: number;
  exhausted: boolean;
  exhaustedAt: number;
  lastFailureAt: number;
  nextRetryAt: number;
  connectedAt: number;
}

export function normalizeRestartState(raw: unknown): RestartState {
  const value = asRecord(raw);
  return {
    windowMs: asNumber(value.windowMs, 0),
    max: asNumber(value.max, 0),
    failures: asNumber(value.failures, 0),
    remaining: asNumber(value.remaining, 0),
    exhausted: value.exhausted === true,
    exhaustedAt: asNumber(value.exhaustedAt, 0),
    lastFailureAt: asNumber(value.lastFailureAt, 0),
    nextRetryAt: asNumber(value.nextRetryAt, 0),
    connectedAt: asNumber(value.connectedAt, 0),
  };
}

/** "说了等被叫"的会话：在这之前不主动说话，被 @/点名立刻解除。 */
export interface MentionWaitItem {
  chatKey: string;
  until: number;
  at: number;
  speakerId: string;
  note: string;
  remainingMs: number;
}

export function normalizeMentionWait(raw: unknown): MentionWaitItem[] {
  const value = asRecord(raw);
  const rows = Array.isArray(value.items) ? value.items : [];
  return rows.map((row) => {
    const item = asRecord(row);
    return {
      chatKey: String(item.chatKey ?? ''),
      until: asNumber(item.until, 0),
      at: asNumber(item.at, 0),
      speakerId: String(item.speakerId ?? ''),
      note: String(item.note ?? ''),
      remainingMs: asNumber(item.remainingMs, 0),
    };
  });
}

// ── API 调用 ────────────────────────────────────────────────────────────────

export const api = {
  async status() {
    return normalizeStatusPayload(await request('/api/status'));
  },

  async sessions(limit = 80) {
    const data = await request(`/api/sessions?limit=${limit}`);
    const value = asRecord(data);
    return Array.isArray(value.sessions)
      ? value.sessions.map(normalizeSessionSummary)
      : [];
  },

  async sessionDetail(id: string) {
    return normalizeSessionDetail(await request(`/api/sessions/${encodeURIComponent(id)}`));
  },

  async moods() {
    const data = await request('/api/moods');
    const value = asRecord(data);
    const moods = asRecord(value.moods);
    return Object.entries(moods).reduce<Record<string, Mood>>((acc, [key, mood]) => {
      const normalized = normalizeMood(mood);
      if (normalized) acc[key] = normalized;
      return acc;
    }, {});
  },

  async mood(chatKey: string) {
    const data = await request(`/api/moods?chatKey=${encodeURIComponent(chatKey)}`);
    return normalizeMood(asRecord(data).mood);
  },

  /** QQ 内置表情映射：id → { n: 名字, e: 表情图号 } */
  async qqFaces() {
    const data = await request('/api/qq-faces');
    const faces = asRecord(asRecord(data).faces);
    return Object.entries(faces).reduce<Record<string, { name: string; em: string }>>(
      (acc, [id, row]) => {
        const item = asRecord(row);
        const name = typeof item.n === 'string' ? item.n.trim() : '';
        if (!name) return acc;
        acc[id] = { name, em: typeof item.e === 'string' ? item.e : '' };
        return acc;
      },
      {},
    );
  },

  async resetMood(chatKey: string) {
    const data = await request('/api/moods/reset', {
      method: 'POST',
      body: JSON.stringify({ chatKey }),
    });
    return normalizeMood(asRecord(data).mood);
  },

  /**
   * 群梗候选池。这些是模型"提了个候选"、等人确认的条目 ——
   * **确认之前它不算 AI 已知的梗**（search_meme 查不到）。确认 = 转正进梗库。
   */
  async memesPending() {
    const data = await request<{ pending?: unknown[]; rejectedCount?: number }>('/api/memes/pending');
    const rows = Array.isArray(data.pending) ? data.pending : [];
    return {
      rejectedCount: asNumber(data.rejectedCount, 0),
      pending: rows.map((row) => {
        const item = asRecord(row);
        return {
          key: String(item.key ?? ''),
          meaning: String(item.meaning ?? ''),
          usage: String(item.usage ?? ''),
          tone: String(item.tone ?? ''),
          aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
          hits: asNumber(item.hits, 1),
          lastSeenAt: asNumber(item.lastSeenAt, 0),
          source: String(item.source ?? ''),
          chatKey: String(item.chatKey ?? ''),
        };
      }),
    };
  },

  async confirmMeme(key: string) {
    const data = await request<{ ok?: boolean; reason?: string }>('/api/memes/confirm', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    return { ok: data.ok !== false, reason: String(data.reason ?? '') };
  },

  async rejectMeme(key: string) {
    const data = await request<{ ok?: boolean; reason?: string }>('/api/memes/reject', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    return { ok: data.ok !== false, reason: String(data.reason ?? '') };
  },

  async config() {
    return normalizeConfig(await request('/api/config'));
  },

  async presets() {
    return normalizePresets(await request('/api/presets'));
  },

  /**
   * POST /api/config 返回的是 `{ ok, config }`，**不是**配置本体。
   * 早期这里把整个响应丢给 normalizeConfig，它读不到 api/vision 字段就整包退化成默认值：
   * 保存成功后表单被清空（Base URL / 模型变空、密钥显示"未配置"），用户只能重填一遍。
   * 取 `config` 后再归一化；万一后端哪天改成直接返回配置，也还能兜住。
   */
  async saveConfig(patch: Record<string, unknown>) {
    const data = await request<{ config?: unknown }>('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    const payload = asRecord(data).config ?? data;
    return normalizeConfig(payload);
  },

  async rawConfig() {
    return (await request('/api/config')) as AppConfig;
  },

  async saveRawConfig(patch: Record<string, unknown>) {
    const data = await request<{ config?: AppConfig }>('/api/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    return data.config;
  },

  async personaTemplates() {
    const data = await request<{ templates?: PersonaTemplate[] }>('/api/persona-templates');
    return Array.isArray(data.templates) ? data.templates : [];
  },

  async createPersona(payload: { name: string; text: string; customRules?: string }) {
    const data = await request<{ ok?: boolean; id?: string; updated?: boolean }>('/api/persona-templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data ?? {};
  },

  /**
   * 就地修改一条自定义人设。
   * 以前没有这个接口，控制台只能「添加人设」，于是"改模板"实际是又存了一条副本。
   * 内置模板（写在 personas.js 里）会返回 409，调用方据此引导"另存"。
   */
  async updatePersona(id: string, payload: { name?: string; text: string; customRules?: string }) {
    const data = await request<{ ok?: boolean; id?: string; updated?: boolean; error?: string }>(
      `/api/persona-templates/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(payload) },
    );
    return data ?? {};
  },

  async deletePersona(id: string) {
    await request(`/api/persona-templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: '{}',
    });
  },

  async onebotGroups() {
    const data = await request<{ groups?: OneBotAccountItem[] }>('/api/onebot/groups');
    return Array.isArray(data.groups) ? data.groups : [];
  },

  async onebotFriends() {
    const data = await request<{ friends?: OneBotAccountItem[] }>('/api/onebot/friends');
    return Array.isArray(data.friends) ? data.friends : [];
  },

  async wakeChat(chatKey: string) {
    const [kind, id] = chatKey.split(':');
    return request<{ ok: boolean }>(`/api/chats/${kind}_${id}/wake`, {
      method: 'POST',
      body: '{}',
    });
  },

  async markChatRead(chatKey: string) {
    const [kind, id] = chatKey.split(':');
    return request<{ ok: boolean; marked: number }>(`/api/chats/${kind}_${id}/mark-read`, {
      method: 'POST',
      body: '{}',
    });
  },

  async testSend(chatKey: string, text: string) {
    const [kind, id] = chatKey.split(':');
    return request<{ ok: boolean; messageId?: string }>(`/api/chats/${kind}_${id}/test-send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },

  async rvcStatus() {
    return request<RvcStatus>('/api/rvc');
  },

  /** 角色本音列表（GPT-SoVITS 本地微调模型）+ 服务是否在线。 */
  async gsvVoices() {
    return request<{
      ok: boolean;
      service: { ok: boolean; reason?: string };
      current: string;
      allowModelPick: boolean;
      autoStart: boolean;
      preferOverGsv: boolean;
      /** 按语境换语气是否开启 */
      toneAuto?: boolean;
      /** 情绪强度 0–1.5 */
      toneStrength?: number;
      /** 是否下发韵律参数（关掉 = 只用语速） */
      toneParams?: boolean;
      voices: Array<{
        key: string;
        name: string;
        version: string;
        emotions: string[];
        speed: number;
        available: boolean;
        missing: string[];
        loaded: boolean;
      }>;
      /** 每个音色的情绪覆盖：refEmotions = 真能换参考音频的情绪，paramOnly = 只能调参数 */
      coverage?: Array<{ voice: string; refEmotions: string[]; paramOnly: string[]; tags: string[] }>;
    }>('/api/gsv/voices');
  },

  /** 语气预览：纯计算（不合成音频），返回该音色下某个情绪会用什么参数。 */
  async gsvTonePlan(params: { voice: string; emotion?: string; moodScore?: number }) {
    const query = new URLSearchParams({ voice: params.voice });
    if (params.emotion) query.set('emotion', params.emotion);
    if (typeof params.moodScore === 'number') query.set('moodScore', String(params.moodScore));
    return request<{
      ok: boolean;
      voice: string;
      plan: {
        emotion: string;
        gsv: string;
        cosyvoice: string;
        speedBias: number;
        strength: number;
        params: Record<string, number>;
        line: string;
        textHint: string;
        mode: 'ref' | 'param';
        enabled: boolean;
      };
      hint: string;
      describe: string;
      coverage: { voice: string; refEmotions: string[]; paramOnly: string[]; tags: string[] };
    }>(`/api/gsv/tone-plan?${query.toString()}`);
  },

  /** 启动角色本音推理服务（冷启动约 30–90 秒）。 */
  async gsvStart() {
    return request<{ ok: boolean; started?: boolean; reason?: string }>('/api/gsv/start', {
      method: 'POST',
      body: '{}',
    });
  },

  /** 用某个角色本音念一句话，返回音频 blob（试听用）。 */
  async gsvPreview(voice: string, text?: string, options?: { emotion?: string; style?: string }) {
    const response = await fetch('/api/gsv/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice, text, emotion: options?.emotion, style: options?.style }),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message =
        typeof data.error === 'string' ? data.error : `试听失败（HTTP ${response.status}）`;
      throw new ApiError(message, response.status);
    }
    return response.blob();
  },

  async rvcStart() {
    return request('/api/rvc/start', { method: 'POST', body: '{}' });
  },

  async rvcRestart() {
    return request('/api/rvc/restart', { method: 'POST', body: '{}' });
  },

  async rvcStop() {
    return request('/api/rvc/stop', { method: 'POST', body: '{}' });
  },

  async snowlumaLoginInfo() {
    return request<SnowLumaLoginInfo>('/api/snowluma/login/info');
  },

  async snowlumaLoginStatus() {
    return request<{ ok?: boolean; status?: Record<string, unknown>; quickList?: string[] }>(
      '/api/snowluma/login/status',
    );
  },

  async snowlumaQr() {
    return request<SnowLumaQrInfo>('/api/snowluma/qr');
  },

  async snowlumaRefreshQr() {
    return request<{ ok: boolean; error?: string }>('/api/snowluma/login/refresh-qr', {
      method: 'POST',
      body: '{}',
    });
  },

  async snowlumaPasswordLogin(uin: string, passwordMd5: string) {
    return request<{
      ok: boolean;
      error?: string;
      needCaptcha?: boolean;
      proofWaterUrl?: string;
      needNewDevice?: boolean;
      jumpUrl?: string;
      newDevicePullQrCodeSig?: string;
    }>('/api/snowluma/login/password', {
      method: 'POST',
      body: JSON.stringify({ uin, passwordMd5 }),
    });
  },

  async snowlumaQuickLogin(uin: string) {
    return request<{ ok: boolean; error?: string }>('/api/snowluma/login/quick', {
      method: 'POST',
      body: JSON.stringify({ uin }),
    });
  },

  async snowlumaCaptchaLogin(payload: {
    uin: string;
    passwordMd5: string;
    ticket: string;
    randstr: string;
    sid?: string;
  }) {
    return request<{
      ok: boolean;
      error?: string;
      needNewDevice?: boolean;
      jumpUrl?: string;
      newDevicePullQrCodeSig?: string;
    }>('/api/snowluma/login/captcha', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async snowlumaNewDeviceQr(uin: string, jumpUrl: string) {
    return request<{
      ok: boolean;
      error?: string;
      qr?: Record<string, unknown>;
      qrImage?: string;
    }>('/api/snowluma/login/new-device-qr', {
      method: 'POST',
      body: JSON.stringify({ uin, jumpUrl }),
    });
  },

  async snowlumaNewDevicePoll(uin: string, bytesToken: string) {
    return request<{ ok: boolean; poll?: Record<string, unknown> }>(
      '/api/snowluma/login/new-device-poll',
      {
        method: 'POST',
        body: JSON.stringify({ uin, bytesToken }),
      },
    );
  },

  async snowlumaNewDeviceLogin(payload: {
    uin: string;
    passwordMd5: string;
    newDevicePullQrCodeSig: string;
  }) {
    return request<{ ok: boolean; error?: string }>('/api/snowluma/login/new-device', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async testChat(payload: { baseUrl: string; apiKey: string; model: string }) {
    const data = await request<{ result?: Record<string, unknown> }>('/api/providers/test-chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return asRecord(data.result);
  },

  async testSavedKey(payload: {
    providerId?: string;
    model?: string;
  }): Promise<Record<string, unknown>> {
    const data = await request<{
      result?: Record<string, unknown>;
      providerId?: string;
      model?: string;
      baseUrl?: string;
    }>('/api/providers/test-saved', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return {
      ...asRecord(data.result),
      providerId: data.providerId,
      model: data.model,
      baseUrl: data.baseUrl,
    } as Record<string, unknown>;
  },

  async fetchModels(payload: { baseUrl: string; apiKey: string }) {
    const data = await request<{ models?: unknown[] }>('/api/providers/fetch-models', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return Array.isArray(data.models) ? data.models.map(String) : [];
  },

  /**
   * 把拉到的模型写进模型目录。这是模型列表唯一的存储位置：
   * 只改前端 state 的话，点「保存设置」不会带上它，刷新就没了。
   */
  async addProviderModels(providerId: string, models: string[]) {
    const data = await request<{ provider?: Provider }>('/api/providers/models', {
      method: 'POST',
      body: JSON.stringify({ providerId, models: models.map((id) => ({ id, name: id })) }),
    });
    return data.provider;
  },

  /**
   * 新建服务商。
   *
   * `created=false` 表示这个 Base URL 目录里已经有了，后端按「合并模型」处理——
   * 必须把这件事回传给界面，否则用户以为新建了一家、其实改动进了别人家。
   * 返回的 provider 用于就地更新界面（不必整页重载，见 use-model-config 注释）。
   */
  async createProvider(payload: {
    baseUrl: string;
    apiKey: string;
    displayName?: string;
    models: string[];
  }) {
    const data = await request<{ provider?: Provider; created?: boolean }>('/api/providers', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        displayName: payload.displayName ?? '',
        models: payload.models.map((id) => ({ id, name: id })),
      }),
    });
    return { provider: data.provider, created: data.created !== false };
  },

  /**
   * 批量删除模型。批量是刻意的：「清空这家重来」逐个删会落盘 N 次，
   * 中途失败就留下删了一半的状态，而且 modelNames 会残留。
   */
  async removeProviderModels(providerId: string, modelIds: string[]) {
    const data = await request<{ provider?: Provider }>('/api/providers/models', {
      method: 'DELETE',
      body: JSON.stringify({ providerId, modelIds }),
    });
    return data.provider;
  },

  /**
   * 重排模型。**这个顺序就是降级链的链位**：后端按数组取前 2 个去尝试。
   * 只传变动的片段也可以，后端会把没传到的接回末尾（不会丢模型）。
   */
  async reorderProviderModels(providerId: string, modelIds: string[]) {
    const data = await request<{ provider?: Provider }>('/api/providers/models/reorder', {
      method: 'POST',
      body: JSON.stringify({ providerId, modelIds }),
    });
    return data.provider;
  },

  /** 改名称 / Base URL / 密钥。空字段表示不改，掩码也不会被当成新密钥。 */
  async updateProviderMeta(payload: {
    providerId: string;
    displayName?: string;
    baseUrl?: string;
    apiKey?: string;
  }) {
    const data = await request<{ provider?: unknown }>('/api/providers/update', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data.provider;
  },

  /** 删除整个服务商条目。apiProviderCleared 表示后端顺带清空了悬空的 api.provider。 */
  async deleteProvider(providerId: string) {
    return request<{
      ok: boolean;
      removed: string;
      removedModels: number;
      apiProviderCleared: boolean;
    }>('/api/providers', {
      method: 'DELETE',
      body: JSON.stringify({ providerId }),
    });
  },

  async chats() {
    return normalizeChats(await request('/api/chats'));
  },

  async chatMessages(chatKey: string, limit = 200) {
    const pathKey = chatKey.replace(':', '_');
    return normalizeChatMessages(
      await request(`/api/chats/${pathKey}/messages?limit=${limit}`),
    );
  },

  async capabilities() {
    return normalizeCapabilities(await request('/api/capabilities'));
  },

  async snowlumaLogs() {
    return normalizeLogs(await request('/api/snowluma/logs'));
  },

  async launchSnowluma() {
    await request('/api/snowluma/launch', { method: 'POST', body: '{}' });
  },

  async stopSnowluma() {
    await request('/api/snowluma/stop', { method: 'POST', body: '{}' });
  },

  async openSnowlumaFolder() {
    await request('/api/snowluma/open-folder', { method: 'POST', body: '{}' });
  },

  async pause(paused: boolean) {
    await request('/api/pause', {
      method: 'POST',
      body: JSON.stringify({ paused, reason: paused ? '控制台手动暂停' : undefined }),
    });
  },

  async restart() {
    await request('/api/restart', {
      method: 'POST',
      body: JSON.stringify({ reason: '控制台按钮' }),
    });
  },

  // ── 运行体检 ───────────────────────────────────────────────────────────
  async riskAudit() {
    return normalizeRiskAudit(await request('/api/risk/audit'));
  },

  async pendingSends(chatKey?: string) {
    const query = chatKey ? `?chatKey=${encodeURIComponent(chatKey)}` : '';
    return normalizePendingSends(await request(`/api/send/pending${query}`));
  },

  /**
   * 人工结清一条"结果不确定"的发送。
   * 语义是「我确认过群里到底收到没」—— 结清只解除"不许重发"的锁，不会补发。
   */
  async resolveSend(fp: string, by = 'console') {
    const data = await request<{ ok?: boolean }>('/api/send/resolve', {
      method: 'POST',
      body: JSON.stringify({ fp, by }),
    });
    return data.ok !== false;
  },

  async gateDecisions() {
    return normalizeGateDecisions(await request('/api/gate/last'));
  },

  /**
   * 她"没开口"的完整账。
   * @param limit 最多几条明细（服务端上限 200）
   * @param sinceMs 只看最近这么多毫秒内的
   */
  async skips(limit = 50, sinceMs = 0) {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (sinceMs) query.set('since', String(sinceMs));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return normalizeSkips(await request(`/api/skips${suffix}`));
  },

  async mentionWait() {
    return normalizeMentionWait(await request('/api/mention-wait'));
  },

  async restartState() {
    return normalizeRestartState(await request('/api/onebot/restart-state'));
  },

  /** 重连预算耗尽后的唯一出路：人工放行一次。 */
  async retryOneBot() {
    const data = await request<{ state?: unknown }>('/api/onebot/retry', {
      method: 'POST',
      body: '{}',
    });
    return normalizeRestartState(data.state);
  },

  // ── 表达库 ─────────────────────────────────────────────────────────────
  async expressions() {
    return normalizeExpressions(await request('/api/expressions'));
  },

  async promoteExpression(id: string) {
    const data = await request<{ ok?: boolean; reason?: string }>('/api/expressions/promote', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    return { ok: data.ok !== false, reason: String(data.reason ?? '') };
  },

  async rejectExpression(id: string) {
    const data = await request<{ ok?: boolean; reason?: string }>('/api/expressions/reject', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    return { ok: data.ok !== false, reason: String(data.reason ?? '') };
  },

  async addExpression(text: string) {
    const data = await request<{ ok?: boolean; reason?: string }>('/api/expressions/add', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    return { ok: data.ok !== false, reason: String(data.reason ?? '') };
  },
};

export function applyMoodToSessions(
  sessions: SessionSummary[],
  moods: Record<string, Mood>,
): SessionSummary[] {
  return sessions.map((session) => ({
    ...session,
    mood: moods[session.chatKey] ?? session.mood ?? null,
  }));
}
