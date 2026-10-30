// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, resolvePersona, resolveChatKey, parseChatKey, setIdentityMode, getIdentityMode, DEFAULT_MODE, ROOT, utilityModelOf, contextWindowOf } from './config.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemBundle, buildUserBundle } from './prompt.js';
import { trimPromptSection } from './context-budget.js';
import { describeBudget } from './context-budget.js';
import { clipToolResult, describeClip } from './tool-result-budget.js';
// 上下文窗口感知（2026-10-31）：这是本仓第一次"知道窗口有多大"。
// 之前所有上限都是字符数，谁也说不清离窗口还有多远。实测本仓中文提示词
// 1 字符 ≈ 1 token（data/sessions 里 calls===1 的 13 个样本校准，见 token-meter.js）。
import { windowUsageOf, shouldCompact, describeUsage, CHARS_PER_TOKEN, COMPACT_THRESHOLD } from './token-meter.js';
// 历史工具结果清理（Anthropic 的 tool result clearing）。tool-result-budget 只在
// "结果当轮进历史时"截一次，之后那份 12000 字的搜索结果会一直躺在 messages 里到第 6 轮。
// 这里只换 content 不动 role/tool_call_id/顺序 —— 动了就是 400（tool 消息必须配对）。
import { clearStaleToolResults, describeClearing, KEEP_RECENT_ROUNDS } from './tool-history.js';
import { windowLimitsOf, describePastWindow, isGroupChat, isPrivateChat, chatKindOf } from './past-window.js';
import { selectPacks, selectToolDefs, stampPacks, describeOmitted, packOfTool, PACK_NAMES, PACKS } from './tool-scene.js';
import { PastSummaryStore, pickPending, renderForSummary, buildSummaryMessages, buildEditMessages, parseEdits, normalizeSummary, normalizeSlots, SUMMARY_DEFAULTS } from './past-summary.js';
// 时间段摘要（time-digest.js, 2026-10-31, m00209）：把"刚才那半小时"按 15 分钟切片压成
// 一行行大概。past-window 是"按条数"的滑窗，群里热闹时 20 条只覆盖 40 秒；past-summary
// 是"跨时间的存量"且要攒 12 条 + 隔 30 分钟才动。中间那段"刚刚聊完、已经滑出窗口"
// 的历史，以前是直接消失的。
import { TimeDigestStore, planSlots, buildDigestMessages, normalizeDigest, digestLead, DIGEST_DEFAULTS } from './time-digest.js';
import { chatCompletion, addUsage, addUsageForModel, estimateCost, listModels } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { looksLikeMonologue, looksSpokenToUser } from './monologue-guard.js';
import { modelVisionVerdict } from './vision-scan.js';
import { qwenVisionInfo } from './qwen-vision.js';
import { MoodStore } from './mood.js';
import { chooseInitialModel, formatModelChain, isComplexRequest } from './model-routing.js';
import { buildFallbackChain, isRetryableError } from './model-fallback.js';
import { dialectFor } from './thinking-dialect.js';
import { decideWake, describeWake } from './reply-gate.js';
import { addresseeOf, TARGET } from './addressee.js';
import { primarySpeaker, batchHasMaster, masterQQOf } from './speaker.js';
import { recordSkip, describeSkip, newTraceId, SKIP_STAGES } from './skip-log.js';
import { classifyLlmError, decideErrorReply, buildErrorReply, describeErrorReply, CONTEXT_RE } from './error-reply.js';
import { mergeWindowMs, capWait, shouldHold, MERGE_DEFAULTS } from './waiting.js';
import { crowdOf, isMultiAsk, describeCrowd } from './crowd.js';
import { planActions, getMentionWait } from './action-planner.js';
import { getExpressions } from './expression-learner.js';
import { shouldGate, cheapWakeGate } from './wake-gate.js';
import { talkWindowOf, noteTalkReply, notePartnerText, stickerEndsTalk, TALK_MAX_TURNS } from './talk-session.js';
import { formatFactsForPrompt, formatRelationForPrompt, rememberFact, rememberRelation, listRelation, buildExtractionPrompt, parseExtraction, parseExtractionDetailed, parseReflectionOutput, factCount, decayFacts, forgetWeakFacts, loadAllFacts } from './memory-facts.js';
import { recordRecall, trimRecallLedger } from './recall-ledger.js';
import { DEFAULT_MAX_DOC_RATIO } from './fact-recall.js';
// 群级记忆（2026-10-26，P2-2）：按会话存"这个群是什么地方"，与按人存的 facts 分开。
import { formatGroupFactsForPrompt, listGroupFacts, rememberGroupFact, buildGroupPrompt, parseGroupExtraction, decayGroupFacts, forgetWeakGroupFacts, loadAllGroupFacts } from './group-facts.js';
import { isStickerOnlyText } from './qq-face.js';
import { formatForPrompt as formatDiaryForPrompt, writeDiaryFor, hasEntry, yesterdayKey } from './diary.js';
import { ReflectionCursor, planRun, shouldReflect, pickUnprocessed } from './reflection.js';
import { publishDiary as publishDiaryToQzone, remainingQuota, findPost as findQzonePost } from './qzone.js';
import { VibeStore, collectSignals, driftLayers, renderVibe, vibeKey, topEmotion } from './vibe.js';
import { resolveTone, formatToneHint } from './voice-delivery.js';
import { GSV_VOICES } from './gpt-sovits.js';
import { personaAliases } from './personas.js';
import { createHookBus } from './hook-bus.js';
import { createToolRegistry } from './tool-registry.js';
import { createExtensionHost } from './plugin-host.js';
import { sortPromptSections } from './plugin-manifest.js';
import { allowed, denyReason } from './whitelist.js';
import { recordSideUsage } from './side-usage.js';
import { getProactiveBackoff, saveProactiveBackoff, describeWait } from './proactive-backoff.js';
import { describeQuotaWait } from './send-quota.js';
import { assessSticker, scanOwnStickers, describeSticker } from './sticker-quota.js';
import { parseStickerLogId, isStickerSendable } from './stickers.js';

/**
 * 概率式召回的调参（facts 与群级记忆共用一份，2026-10-27 精简时合并）。
 *
 * 为什么抽出来：以前 facts 和 groupFacts 各写一遍，而且两遍**写法还不一样**
 * （一处用 `||`、一处用 `??`；`Number(x) ?? 1` 里的 `??` 永远不会生效，
 * 配置缺失时传下去的是 NaN）。同一套阈值两个入口 = 迟早只改一处。
 *
 * @param {object} cfg
 * @param {'group'|'private'} kind  群级记忆只在群里有自己的两个旋钮
 */
function recallOptsOf(cfg, kind = 'group') {
  const mf = cfg.memoryFacts || {};
  const gf = cfg.groupFacts || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    temperature: Number(mf.recallTemperature) || 1,
    topShare: num(mf.recallTopShare, 0.5),
    assocMax: kind === 'group'
      ? num(gf.recallAssocMax, num(mf.recallAssocMax, 1))
      : num(mf.recallAssocMax, 1),
    maxGeneration: kind === 'group'
      ? (Number(gf.recallMaxGeneration) || 4)
      : (Number(mf.recallMaxGeneration) || 4),
    minShared: Number(mf.recallMinShared) || 1,
    // ⚠️ 兜底必须是 fact-recall 的默认值（0.8），不能写 0.5：
    //    0.5 会把"出现在好几条事实里的词"判成无区分力，而那恰恰是联想要走的桥 ——
    //    实测那样联想一次都不发生，且不报任何错（见 fact-recall.js 文件头）。
    maxDocRatio: Number(mf.recallMaxDocRatio) || DEFAULT_MAX_DOC_RATIO
  };
}

/**
 * 去重护栏：判断这段文本是否已在本会话发出过（归一化后比较）。
 * 背景：私聊场景存在多个内容兜底路径（无 toolCalls / 工具前 / finish 后），
 * 同一段 content 可能被多条路径各发一次，造成"同样的消息发两遍"。
 * 独立成模块级函数便于单测。
 */
export function alreadySent(session, text) {
  const norm = String(text || '').replace(/\s+/g, '').trim();
  if (!norm) return true;
  const sent = session?.sent || [];
  for (const item of sent) {
    const prev = String(item?.text || '').replace(/\s+/g, '').trim();
    if (!prev) continue;
    // 完全相同，或一方包含另一方（兜底路径常对同一段文本做不同截断/清理）即视为重复
    if (prev === norm) return true;
    if (norm.length >= 20 && prev.includes(norm)) return true;
    if (prev.length >= 20 && norm.includes(prev)) return true;
  }
  return false;
}

/**
 * 这条消息是在叫它吗。
 *
 * 以前是两条 `includes`：文本里有它的名字就算（"@张三 你看小鱼多能说"也算），
 * 外加一条 `entry.reply.sender` —— 而 reply 字段从来没被写入过，等于永远 false。
 * 现在统一问 addressee.js：明确对别人说的就不算叫它。
 */
function isDirectMessage(entry, { kind, selfNickname, botName, selfId = '' }) {
  if (kind === 'private') return true;
  const aliases = [selfNickname, botName].map((x) => String(x || '').trim()).filter(Boolean);
  const info = addresseeOf(entry, { aliases, selfIds: [selfId], selfNickname });
  return info.target === TARGET.SELF;
}

function countHostileMessages(entries) {
  const hostile = /(傻逼|智障|弱智|废物|去死|草死你|你妈|妈的|滚出|有多远滚)/i;
  return (entries || []).filter((entry) => hostile.test(String(entry?.text || ''))).length;
}

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null }) {
    this.store = store;
    this.memory = memory;
    this.mood = new MoodStore();
    // 人设回路：快变量情绪（此刻心情 / 关系账本 / 沉默档）。只进提示词，不参与闸门判定。
    this.vibe = new VibeStore();
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();
    /** 上次跑"事实衰减"的时间（每天一次，内存态即可 —— 重启多跑一次无害）。 */
    this.lastFactsDecayAt = 0;
    /** 反思层（reflection.js）：游标 + 防重入 + 定时器。 */
    this.reflection = new ReflectionCursor();
    this.reflecting = false;
    this.reflectionTimer = null;
    // 未登记段只 warn 一次（键 = 段名，跨轮去重），避免每轮刷屏
    this.warnedUnregistered = new Set();
    /**
     * 失败提示的冷却时间戳（按 base 会话键）。
     *
     * 为什么按会话而不是全局：一个群挂在一个坏端点上，不该让另一个群也跟着闭嘴。
     * 为什么只在内存里：重启后多提示一次无害；落盘要多一个文件、多一种损坏可能。
     */
    this.errorReplyAt = new Map();

    // ── 插件系统：钩子总线 + 工具注册表 + 扩展宿主 ──────────────────────
    this.hookBus = createHookBus({
      log: { warn: (m) => console.warn(`[hook-bus] ${m}`) },
    });
    // 出站媒体否决点：sender 是所有出站媒体的唯一收口（图/文件/语音/表情），
    // 接在这里才能保证定时任务、唱歌交付、插件自己 api.sendImage 全都过同一个点。
    if (this.sender && typeof this.sender === 'object') {
      this.sender.beforeMedia = (payload) => this.hookBus.emit('before-media', payload);
    }
    this.registry = createToolRegistry();
    this.extHost = createExtensionHost({
      root: ROOT,
      registry: this.registry,
      bus: this.hookBus,
      getCustom: () => getConfig().custom,
      // 声明 send_image 的插件真的能发图 —— 并且走同一条 sender（限频、节奏、
      // before-media 否决点全部生效，插件没有绕过出站检查的后门）。
      sendImage: (chatKey, url, opts) => this.sender.sendImage(chatKey, url, opts),
      log: {
        info: (m) => this.emit('log', { text: m }),
        warn: (m) => console.warn(m),
      },
    });
    // 异步加载扩展（本地 import 极快，通常首个消息到达前已完成；不阻塞构造）
    this.extHost.load()
      .then(() => {
        // 插件目录热重载（默认开；custom.plugins.hotReload=false 可关）
        if (getConfig().custom?.plugins?.hotReload !== false && typeof this.extHost.watch === 'function') {
          this.extHost.watch({ debounceMs: 800 });
        }
      })
      .catch((e) => console.error('[plugins] 加载失败:', e?.message || e));

    this.identityPending = new Map();  // baseChatKey -> { to, label, at } 待确认的身份切换
    this.lastDecision = new Map();     // baseChatKey -> 本轮闸门判定（kind/tier，供组提示词用）
    this.factTick = new Map();         // baseChatKey -> { at, count } 事实提取节流
    this.exprTick = new Map();         // baseChatKey -> at 表达学习节流（10 分钟一次）
    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    // chatKey -> 本轮防抖**第一次**安排唤醒的时间戳。
    // 计时器每来一条消息就重置，人多时会被一直往后推（"它卡着一句话不说"），
    // 所以要有一个从第一次起算的硬顶 —— 见 waiting.capWait。
    this.pendingWakeSince = new Map();
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    // 工具按场景装载（tool-scene.js）：chatKey -> { song: 命中时刻, ... }。
    // 只记时间戳，包本身是常量 —— 这里存的东西丢了最多是"重装一次"，不会坏。
    this.packState = new Map();
    // 往事摘要（past-summary.js）：热窗口之外的历史压成条目。
    // 三类状态各管一件事 —— 正在压（防并发）、上次压的时间（限频）、
    // 以及每个会话的摘要本体与游标（在 PastSummaryStore 里，落 data/summary/）。
    this.pastSummary = new PastSummaryStore();
    this.summarizing = new Set();
    this.summaryTick = new Map();
    // 时间段摘要（time-digest.js）：按片键缓存，片结束就永不改变 → 天然幂等。
    // 没有"游标"这个概念，所以也不需要节流表：没压过的片才会被压。
    this.digest = new TimeDigestStore();
    this.digesting = new Set();        // chatKey -> 正在压（防同一会话并发多片）
    // 模型窗口大小：'<baseUrl>|<model>' -> token 数。
    // 从 /models 探测一次就缓存，别每轮都发一次 15 秒超时的请求。
    // 0 也是有效缓存值（= 探测过但没有这个信息），靠 has() 区分"没探测过"。
    this.windowCache = new Map();
    this.windowProbing = null;
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.diaryTimer = null;            // 日记定时器（半小时一次，只写"昨天"）
    this.diaryTicking = false;         // 正在批量补写日记
    this.qzoneCooldownUntil = 0;       // 空间发布失败后的冷却截止时间（别每半小时撞一次）
    this.aborted = false;
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) <= 0) continue;
      // 积压消息同样要先过身份口令检测，否则重启期间发的"开始学习"会被当成普通聊天
      try {
        const intent = this.#detectIdentityIntent(chatKey);
        if (intent) {
          this.#handleIdentityIntent(chatKey, intent).catch((e) =>
            console.error('[identity] 积压处理出错:', e?.message || e));
          continue;
        }
      } catch (e) {
        console.error('[identity] 积压检测出错:', e?.message || e);
      }
      if (!this.#gateAllowsWake(chatKey)) continue;   // 闸门：不值得跑的积压只标已读
      this.scheduleWake(chatKey, 0);
    }
  }

  /**
   * 记一次"没说话"。
   *
   * **所有不回复的分支都必须调它** —— 这是"静默失效"唯一的结构性解药：
   * 这个机器人绝大多数时间在做"决定不说话"，如果这些决定不落账，
   * 用户报障就永远只有一句"它刚才没理我"，而代码里查不到任何东西。
   *
   * 三条纪律：
   *   ① stage 用 SKIP_STAGES 里的枚举（不要现编字符串，否则统计会碎成几十类）；
   *   ② reason 写中文人话（这条记录是给人查的）；
   *   ③ traceId 能对上日志行与会话详情 —— 三处同一个把手，才叫可查。
   *
   * 记账自身出错绝不影响主流程（fail-open）：它是账本，不是闸门。
   */
  noteSkip(stage, chatKey, reason, detail = {}, traceId = '') {
    try {
      const rec = recordSkip({ stage, chatKey, reason, detail, traceId });
      this.emit('log', { text: describeSkip(rec) });
      this.emit('skip', rec);
      return rec;
    } catch (error) {
      console.warn('[skip-log] 记账失败（不影响主流程）：', error?.message ?? error);
      return null;
    }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  async onIncoming(chatKey) {
    if (this.aborted) {
      this.noteSkip(SKIP_STAGES.ABORTED, chatKey, '运行已被手动中止，这条消息不再处理');
      return;
    }
    if (this.paused) {
      this.noteSkip(SKIP_STAGES.PAUSED, chatKey, '已暂停（面板按钮或预算熔断），消息留在未读里，恢复后会自动补处理');
      return;
    }
    // 身份切换口令：在聚批前拦截（切换本身不消耗 LLM，但会主动回一句确认/结果）
    try {
      const intent = this.#detectIdentityIntent(chatKey);
      if (intent) {
        this.#handleIdentityIntent(chatKey, intent).catch((e) =>
          console.error('[identity] 处理出错:', e?.message || e));
        return;   // 已由切换流程接管，不再交给模型
      }
    } catch (e) {
      console.error('[identity] 切换检测出错:', e?.message || e);
    }
    if (this.runningChats.has(chatKey)) {
      // 不是"丢掉"：这条消息已写进 store，等当前这一轮结束后的 drain 会带着它再跑一次。
      this.noteSkip(SKIP_STAGES.RUNNING, chatKey, '这个会话正在跑，等本轮结束后由 drain 接着处理（消息没丢）');
      return;
    }
    if (!(await this.#gateAllowsWake(chatKey))) return;   // 唤醒闸门：不值得跑的批次只标已读，零模型调用
    this.scheduleWake(chatKey);
  }

  /**
   * 唤醒闸门（判据见 src/reply-gate.js）：
   *   值得跑 → true（照常唤醒）；不值得 → 消息标已读 + 记日志，返回 false（本轮不跑）。
   * gate.enabled=false 恒为 true（老行为）；dryRun=true 时只记"本来会跳过"，不真拦。
   * 闸门自己出错一律 fail-open（宁可多跑一次，也别把机器人憋成哑巴）。
   */
  async #gateAllowsWake(chatKey) {
    const gateCfg = getConfig().gate || {};
    if (gateCfg.enabled === false) return true;
    // traceId 生成在"未读写完、decide 之前"：因为**跳过的那一轮同样要能对账**，
    // 而跳过时后面不会再生成任何 id（学自 Estrella 的生成点选择）。
    const traceId = newTraceId();
    try {
      const { base: baseKey, kind } = parseChatKey(chatKey);
      const recent = this.store.recent(baseKey, { limit: 30 });
      const unread = recent.filter((m) => !m.self && !m.read);
      if (!unread.length) return true;                  // 没有未读 → 不是我们要判断的事
      const persona = resolvePersona(chatKey).persona;
      const aliases = personaAliases(persona, [this.onebot ? this.onebot.selfNickname : '']);
      const selfMsgs = recent.filter((m) => m.self);
      const others = recent.filter((m) => !m.self);
      const lastSelfAt = selfMsgs.length ? (Number(selfMsgs[selfMsgs.length - 1].ts) || 0) : 0;
      // 这批之前"群里最后一条别人的消息" = 倒数第二条来话（最后一条属于这批）
      const lastOtherAt = others.length > 1 ? (Number(others[others.length - 2].ts) || 0) : 0;
      // 连续对话：她刚回过的那个人，在接话窗口内继续说 → 直接接住（不掷概率）。
      const talkCfg = getConfig().talk || {};
      const talk = talkCfg.enabled === false ? null : talkWindowOf(baseKey, { windowMs: Number(talkCfg.windowMs) || 20000 });
      const mentionWait = getMentionWait();
      const decision = decideWake({
        kind, entries: unread, cfg: getConfig(), aliases, lastSelfAt, lastOtherAt, now: Date.now(), talk,
        // 寻址判定要知道它自己的 QQ 与昵称，才能认出"@ 的是不是它"
        selfId: this.onebot ? this.onebot.selfId : '',
        selfNickname: this.onebot ? this.onebot.selfNickname : '',
        // "等被叫"（action-planner.mentionWait）：弱触发一律不唤醒，被 @/点名立刻解除
        wait: mentionWait.get(baseKey)
      });
      // 明确触发 = 已经被叫到了：等待状态作废
      if (decision.wake && ['private', 'at', 'at-all', 'named', 'reply-self', 'keyword', 'poke', 'continuation'].includes(decision.reason)) {
        mentionWait.clear(baseKey);
      }
      this.lastDecision.set(baseKey, { ...decision, at: Date.now(), traceId });
      const line = describeWake(baseKey, decision);
      if (decision.wake) {
        if (decision.wouldSkip) this.emit('log', { text: line });
        // ── 唤醒预判（省钱层移植）：弱触发先花几百 token 判一下「要不要接」，
        //    判「不接」就整轮不跑（不组提示词、不调主模型）。失败一律按「接」处理（fail-open）。
        try {
          if (shouldGate({ decision, kind, cfg: getConfig() })) {
            const gateCfg = getConfig().gate?.cheapWakeGate || {};
            const recentFew = this.store.recent(baseKey, { limit: Math.max(4, Number(gateCfg.messages) || 12) });
            const r = await cheapWakeGate({
              entries: recentFew,
              botName: getConfig().persona?.botName || '机器人',
              limit: Math.max(4, Number(gateCfg.messages) || 12),
              aliases,
              selfId: this.onebot ? this.onebot.selfId : '',
              selfNickname: this.onebot ? this.onebot.selfNickname : '',
              chat: (opts) => chatCompletion(opts),
              log: (t) => this.emit('log', { text: '[预判] ' + baseKey + ' ' + t })
            });
            recordSideUsage('wake-gate', r?.usage, { model: getConfig().api?.model });
            if (r && r.engage === false) {
              const marked = this.store.drainUnread(baseKey);   // 标已读：正常终态，她看完了决定潜水
              this.noteSkip(SKIP_STAGES.CHEAP_GATE, baseKey, '唤醒预判判定「接不上」，整轮没跑（未调主模型）', {
                unread: marked.length, model: getConfig().api?.model || ''
              }, traceId);
              this.emit('chat-update', baseKey);
              return false;
            }
          }
        } catch (e) {
          this.emit('log', { text: '[预判] 出错按「接」处理：' + (e && e.message ? e.message : e) });
        }
        return true;
      }
      const marked = this.store.drainUnread(baseKey);     // 标已读：不再触发；消息仍留在存档里当上下文
      // 主闸门跳过：这是最高频的一类"不回"，必须带上判据来源（reason/p/档位）。
      // 注意 `decision.probability === undefined` 与 `p=0` 是两种不同的原因 ——
      // 前者是"结构上不许说"（没掷骰子），后者是"掷了但概率为 0"。
      this.noteSkip(SKIP_STAGES.GATE, baseKey, `唤醒闸门判定不值得跑：${decision.reason || '未知'}`, {
        unread: marked.length,
        decision: decision.reason,
        p: decision.probability,
        tier: decision.tier,
        boosted: decision.boosted || undefined,
        cooled: decision.cooled || undefined
      }, traceId);
      this.emit('chat-update', baseKey);
      return false;
    } catch (e) {
      // fail-open 也要留痕：放行了，但"为什么放行"必须能查（否则等于把闸门关了还看不出来）
      this.noteSkip(SKIP_STAGES.GATE_ERROR, chatKey, '闸门判定出错，按老行为唤醒（fail-open）', {
        error: String(e?.message ?? e)
      }, traceId);
      return true;
    }
  }

  /** 执行身份切换意图：发确认问句 / 完成切换 / 取消。 */
  async #handleIdentityIntent(chatKey, intent) {
    const { base: baseKey, kind, id } = parseChatKey(chatKey);
    this.emit('log', { text: '[identity] ' + baseKey + ' ' + intent.action + ' → ' + intent.mode });
    this.store.appendSelf(baseKey, { text: intent.reply, ts: Date.now() });
    this.emit('chat-update', baseKey);
    if (kind && id && this.sender) {
      try {
        await this.sender.sendTextBatch(baseKey, [intent.reply], {});
      } catch (e) {
        console.error('[identity] 发送确认语失败:', e?.message || e);
      }
    }
    // 把已读推进（这条消息由切换流程消化，不再留给模型）
    const marked = this.store.drainUnread(baseKey);
    // 留一条：这条消息**没有进模型**，是代码自己处理掉的。
    // 不记的话，面板上"它没回"和"它根本没看"是同一件事，查不出区别。
    this.noteSkip(SKIP_STAGES.IDENTITY, baseKey, `身份切换流程直接处理（${intent.action} → ${intent.mode}），未进模型`, {
      unread: marked.length,
      action: intent.action,
      mode: intent.mode
    });
  }

  /**
   * 身份切换口令检测（三段式）：
   *   ① 口令 → 需要确认：记下待确认请求，回复确认问句（由模型/兜底发出）
   *   ② 确认词（好/是/确认…）→ 真正切换
   *   ③ 否定词（不/算了/取消…）→ 放弃切换
   * 匹配用「包含」而非完全相等，并做归一化（去空格/标点），避免"开始学习吧"这类说话方式漏判。
   * 返回：{ action, mode, label, reply } 供调用方决定如何回应；未命中返回 null。
   */
  #detectIdentityIntent(chatKey) {
    const cfg = getConfig();
    const rules = cfg.identityModes || {};
    const { base: baseKey } = parseChatKey(chatKey);
    const pending = this.store.recent(baseKey, { limit: 8 }).filter((m) => !m.self && !m.read);
    if (!pending.length) return null;
    const last = pending[pending.length - 1];
    const raw = String(last.text || '').trim();
    // 归一化：去掉空白与常见标点，便于包含匹配
    const norm = raw.replace(/[\s，。！？、,.!?~～…]/g, '');
    if (!norm) return null;

    // 否定/取消优先判断（避免"我不想开始学习"被误判为进入）
    const NEG = ['不', '别', '算了', '取消', '先不', '暂时不'];
    const CANCEL = ['取消', '算了', '不用了', '先不', '不切换'];
    const CONFIRM = ['好', '好的', '是', '是的', '确认', '可以', '行', '嗯', '对', '开始吧', '进入吧', '来吧'];

    const curMode = getIdentityMode(baseKey);
    const pendingReq = this.identityPending.get(baseKey) || null;

    // ── 阶段②③：存在待确认请求时，先处理确认/取消 ──
    if (pendingReq) {
      // 取消
      if (CANCEL.some((w) => norm.includes(w))) {
        this.identityPending.delete(baseKey);
        return { action: 'cancelled', mode: curMode, label: pendingReq.label, reply: '好的，那就先不切换啦，本鲸继续当前的相处模式～' };
      }
      // 确认（词短且命中，避免长句误判）
      if (norm.length <= 8 && CONFIRM.some((w) => norm === w || norm.startsWith(w))) {
        this.identityPending.delete(baseKey);
        if (pendingReq.to === DEFAULT_MODE) {
          setIdentityMode(baseKey, DEFAULT_MODE);
          return { action: 'switched', mode: DEFAULT_MODE, label: pendingReq.label, reply: '好，那本鲸先下课啦，日常模式回来咯(๑•̀ㅂ•́)و✧' };
        }
        setIdentityMode(baseKey, pendingReq.to);
        return { action: 'switched', mode: pendingReq.to, label: pendingReq.label, reply: '好，本鲸这就上课！' };
      }
      // 待确认期间又说了别的 → 清掉待确认，按新消息继续走下面的检测
      this.identityPending.delete(baseKey);
    }

    // ── 阶段①：检测进入/退出口令 ──
    for (const [mode, def] of Object.entries(rules)) {
      const label = def.label || mode;
      const enterHit = (def.enter || []).map(String).filter(Boolean).find((t) => {
        const nt = t.replace(/[\s，。！？、,.!?~～…]/g, '');
        if (!nt || !norm.includes(nt)) return false;
        // 否定词保护：否定词出现在口令词之前 → 视为否定意图
        // 例："我不想开始学习"（不…在"开始学习"之前）→ 不触发
        //     "开始学习吧，别磨蹭"（别…在之后）→ 仍触发
        const at = norm.indexOf(nt);
        const before = norm.slice(0, at);
        if (NEG.some((n) => before.includes(n))) return false;
        return true;
      });
      if (enterHit && curMode !== mode) {
        this.identityPending.set(baseKey, { to: mode, label, at: Date.now() });
        return { action: 'ask-enter', mode, label, reply: '要进入【' + label + '】吗？回一句"好"本鲸就开始～' };
      }
      // 退出口令：仅当当前处于该模式时才问
      const exitHit = (def.exit || []).map(String).filter(Boolean).find((t) => {
        const nt = t.replace(/[\s，。！？、,.!?~～…]/g, '');
        return nt && norm.includes(nt);
      });
      if (exitHit && curMode === mode) {
        this.identityPending.set(baseKey, { to: DEFAULT_MODE, label, at: Date.now() });
        return { action: 'ask-exit', mode: DEFAULT_MODE, label, reply: '要结束【' + label + '】了吗？回一句"好"本鲸就下课～' };
      }
    }
    return null;
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时（但有硬顶，见 capWait）。 */
  scheduleWake(chatKey, delay = null) {
    const now = Date.now();
    // "第一次"从本轮真正空闲下来那一次算起；唤醒成功/进场时清掉。
    const since = this.pendingWakeSince.get(chatKey) || now;
    this.pendingWakeSince.set(chatKey, since);
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);
    let ms = delay ?? this.#wakeDelayFor(chatKey);
    // 硬顶只对"防抖算出来的"生效：显式 delay（forceWake 传 0）必须立刻跑，
    // 否则手动点一下面板还要等 6 秒，看起来像没反应。
    if (delay == null) {
      ms = capWait({
        since, now, windowMs: ms,
        maxWaitMs: Number(getConfig().crowd?.maxWaitMs) || MERGE_DEFAULTS.crowdMaxWaitMs
      });
    }
    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      this.pendingWakeSince.delete(chatKey);
      this.wake(chatKey).catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 合并窗口（判据在 `waiting.mergeWindowMs`，这里只负责"谁是 urgent / 是不是一群人"）。
   *
   * 拆开的意义：以前"等多久"和"怎么判断被叫到"写在同一段里，
   * 于是没人能单独回答"为什么这条消息等了 1.8 秒"——现在判据是纯函数，
   * 可以直接喂"被 @ 的私聊"这种反例。
   *
   * ★ crowd：**≥2 个人同时在等它时，窗口必须放宽**。
   *   否则被 @ 的 500ms 直通窗口会把同一件事切成两轮：第一个人先答，
   *   第二个人的 @ 落进 drain 再答一遍 —— 群里看到的就是"一人一条"。
   *   这一步是"一句话带过所有人"能不能发生的前提，不是调参。
   */
  #wakeDelayFor(chatKey) {
    const cfg = getConfig();
    const normalMs = Number(cfg.wakeDelayMs) || 0;
    const directMs = Number(cfg.directWakeDelayMs) || 0;
    try {
      const { base, kind } = parseChatKey(chatKey);
      if (kind === 'private') return mergeWindowMs({ urgent: true, normalMs, directMs });
      const persona = resolvePersona(chatKey).persona;
      const selfNickname = persona.selfNickname || this.onebot.selfNickname || persona.botName;
      const unread = this.store.recent(base, { limit: 12 }).filter((m) => !m.self && !m.read);
      const urgent = unread.some((entry) => isDirectMessage(entry, {
        kind,
        selfNickname,
        botName: persona.botName,
        selfId: this.onebot ? this.onebot.selfId : ''
      }));
      const crowdCfg = cfg.crowd || {};
      const crowd = crowdCfg.enabled === false || !unread.length
        ? null
        : crowdOf(unread, {
          kind,
          aliases: personaAliases(persona, [this.onebot ? this.onebot.selfNickname : '']),
          selfIds: [this.onebot ? this.onebot.selfId : ''],
          selfNickname,
          maxAskers: Number(crowdCfg.maxAskers) || 4,
          now: Date.now()
        });
      const many = isMultiAsk(crowd);
      const ms = mergeWindowMs({
        urgent, crowd: many, normalMs, directMs,
        crowdMs: Number(crowdCfg.wakeDelayMs) || MERGE_DEFAULTS.crowdMs
      });
      // 只在"因为人多而放宽"时说一句：平时每一次入站都打日志会把面板刷满。
      if (many && ms > (urgent ? Math.min(directMs, normalMs) : normalMs)) {
        this.emit('log', { text: `${describeCrowd(base, crowd)} → 合并窗口放宽到 ${Math.round(ms)}ms` });
      }
      return ms;
    } catch {
      return mergeWindowMs({ normalMs, directMs });
    }
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, taskContext = null, pushTask = null } = {}) {
    // traceId：优先用闸门那一轮生成的（同一条消息从头到尾同一个把手），
    // 主动/定时这类没有闸门前置的路径就当场生成。
    const traceKey = parseChatKey(chatKey).base;
    const traceId = this.lastDecision.get(traceKey)?.traceId || newTraceId();
    if (this.aborted) {
      this.noteSkip(SKIP_STAGES.ABORTED, chatKey, '已中止，不启动本轮', {}, traceId);
      return;
    }
    if (this.paused && !proactive) {
      this.noteSkip(SKIP_STAGES.PAUSED, chatKey, '已暂停，消息保留为未读（恢复后会补处理）', {}, traceId);
      return;
    }
    // 身份模式：物理键（消息来源）→ 有效键（含身份后缀），实现历史/记忆按身份隔离
    const physKey = String(chatKey);
    const runKey = resolveChatKey(physKey);
    if (this.runningChats.has(runKey)) {
      this.noteSkip(SKIP_STAGES.RUNNING, runKey, '同一会话已有一轮在跑，这次唤醒并入 drain', {}, traceId);
      return;
    }

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      this.noteSkip(SKIP_STAGES.NO_MODEL, runKey, '还没设置模型，消息保留为未读（设置好会自动补处理）', {}, traceId);
      return;
    }

    // 预算保险丝：今日成本达到上限 → 自动暂停，不再发起任何 LLM 调用
    if (this.overBudget()) {
      if (!this.paused) {
        this.setPaused(true, 'budget');
      }
      this.noteSkip(SKIP_STAGES.OVER_BUDGET, runKey, '今日花费已达上限，自动暂停（可在面板放宽预算或次日恢复）', {}, traceId);
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      const pending = this.runningChats.size;
      this.noteSkip(SKIP_STAGES.CONCURRENCY, runKey, '并发已满，3 秒后重试（消息没丢）', { running: pending }, traceId);
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // ── 发送额度的前置感知（2026-10-29 第 3 轮）────────────────────────────
    // 必须排在 drainUnread **之前**：drainUnread 会把未读标成已读（消费掉），
    // 在这里放弃的轮次必须让消息保持未读，等窗口滑过去再处理。
    // 实测依据见 src/send-quota.js 顶部：78 个零发送轮次烧掉 7.77% 的 prompt tokens，
    // 且每个都在开跑前额度就已满 —— 那一轮模型根本不可能成功。
    if (!this.checkSendQuota(physKey, { proactive, traceId })) return;

    // 触发批：当前所有未读（含之前积压的）
    // 触发批必须从「物理键」取——消息总是写入物理键（app.js 落库），
    // 有效键只用于历史/记忆隔离，不存放未读。
    let triggerEntries = proactive ? [] : this.store.drainUnread(physKey);
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(physKey); // 把可能的零星未读一并处理掉
    }
    if (!proactive && triggerEntries.length === 0) {
      this.noteSkip(SKIP_STAGES.NO_UNREAD, physKey, '没有未读，不空跑（空转一次也要花 token）', {}, traceId);
      return;
    }

    this.runningChats.add(runKey);
    const seq = (this.runSeq.get(runKey) || 0) + 1;
    this.runSeq.set(runKey, seq);
    const { kind, id: chatId } = parseChatKey(runKey);

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    const session = this.sessions.create({ chatKey: runKey, trigger: triggerEntries, triggerSummary });
    // traceId 落到会话上：面板点开会话就能拿到把手，再去 bridge.log / skip-log 里对同一条
    session.traceId = traceId;
    this.activeRuns.set(runKey, session.id);
    this.emit('session-start', { sessionId: session.id, chatKey: runKey, triggerSummary, traceId });
    this.emit('chat-update', runKey);

    try {
      await this.#runAgent(session, {
        kind, chatId, chatKey: runKey, triggerEntries, proactive, seq, taskContext, pushTask, traceId
      });
    } catch (error) {
      session.error = String(error?.message ?? error);
      this.sessions.finish(session.id, 'error');
      this.emit('session-end', { sessionId: session.id, chatKey: runKey, status: 'error', error: session.error });
      console.error(`[orchestrator] 运行 ${session.id} 出错:`, error);
      // ── 失败可见化（2026-10-29，学自 AstrBot 的 persona_error_reply）──────
      // 以前这里到此为止：用户端看到的是和"她决定不接话"一模一样的静默，
      // 面板上连一条 skip 记录都没有。现在两件事都要做：
      //   ① 落账（RUN_ERROR）—— 让"为什么没回"在面板上查得到；
      //   ② 视情况说一句 —— 瞬时故障说人话圆过去，运营故障只给主人发诊断。
      try {
        await this.#notifyRunError({ session, chatKey: runKey, physKey, triggerEntries, proactive, kind, chatId, traceId });
      } catch (e) {
        // 提示本身失败绝不能反过来影响主流程
        console.warn('[error-reply] 失败提示出错（忽略）：', e?.message ?? e);
      }
    } finally {
      this.activeRuns.delete(runKey);
      this.runningChats.delete(runKey);
      this.sender.endRun?.(runKey);   // 出错也不能把节奏上下文留在那
      // ── 主动收敛记账（2026-10-29 第 2 轮）──────────────────────────────
      // 放在 finally：出错也要记，否则一个每次超时的群会被无限重试 —— 那才是最贵的失败。
      // 用 physKey：主动候选来自 store.listChats()（物理键），键必须对得上。
      // status 兜底：sessions.finish() 会写 session.status，但中途早退的路径可能没写，
      // 那时按"发过话=done、否则=noreply"推断，绝不让它变成 undefined 而漏记。
      const finalStatus = session.status
        || (session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply'));
      this.noteProactiveOutcome(physKey, finalStatus, proactive);
      this.emit('chat-update', runKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      // 本次运行刚花了钱：结束后再查一次预算，超限就地熔断
      if (this.overBudget()) {
        this.setPaused(true, 'budget');
        return;
      }
      const unread = this.store.unreadCount(physKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 800);
        setTimeout(() => {
          if (!this.runningChats.has(runKey) && !this.paused && !this.aborted) {
            this.wake(runKey).catch((error) => console.error(`[orchestrator] drain ${runKey} 出错:`, error));
          }
        }, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
    // 往事摘要（P2）：把热窗口外、还没压过的消息压成条目。同样后台静默。
    this.#maybeSummarizePast(chatKey);
  }

  /**
   * 一轮跑崩之后：落账 + 视情况说一句话。
   *
   * 三件事分开做，因为它们失败的后果不一样：
   *   ① skip 记账必须成功（它是面板上唯一的线索）—— 但也绝不能因为记账出错而中断；
   *   ② 「要不要说」交给纯函数 error-reply.js 判（可测、无副作用）；
   *   ③ 真发出去必须落进历史，否则下一轮提示词里看不到自己说过这句，
   *      会出现"刚说完'我卡了一下'，紧接着又像什么都没发生一样接话"的割裂。
   *      落库交给 sender.sendTextBatch 内部做（src/sender.js:471），这里不重复写。
   *
   * 冷却按**会话**记（不是全局）：一个群里的坏端点不该让另一个群也闭嘴。
   * 内存态即可 —— 重启后多提示一次无害，而落盘要多一个文件、多一种损坏可能。
   */
  async #notifyRunError({ session, chatKey, physKey, triggerEntries, proactive, kind, chatId, traceId }) {
    const cfg = getConfig();
    const er = cfg.errorReply || {};
    const info = classifyLlmError(session.error);
    const { base: baseKey } = parseChatKey(chatKey);
    const persona = resolvePersona(chatKey).persona;
    const masterQQ = masterQQOf(persona);
    const last = Array.isArray(triggerEntries) && triggerEntries.length
      ? triggerEntries[triggerEntries.length - 1] : null;
    const selfId = this.onebot ? this.onebot.selfId : '';
    const direct = proactive ? false
      : (last ? isDirectMessage(last, {
        kind, selfNickname: persona.selfNickname || '', botName: persona.botName || '', selfId
      }) : false);
    const isMaster = !!masterQQ && !!last && String(last.senderId || '') === String(masterQQ);

    const now = Date.now();
    const decision = decideErrorReply({
      kind: info.kind,
      owner: info.owner,
      direct,
      proactive: !!proactive,
      // 已经发过话 = 用户已经得到回复，再补一句"出错了"只会让人怀疑前面那句
      sentAny: Array.isArray(session.sent) && session.sent.length > 0,
      isMaster,
      chatKind: kind === 'group' ? 'group' : 'private',
      now,
      lastAt: this.errorReplyAt.get(baseKey) || 0,
      cooldownMs: Number(er.cooldownMs) || 600000,
      enabled: er.enabled !== false,
      inGroup: er.inGroup !== false,
      operatorNotice: er.operatorNotice !== false
    });

    this.noteSkip(SKIP_STAGES.RUN_ERROR, chatKey, describeErrorReply(info.kind, decision), {
      kind: info.kind,
      owner: info.owner,
      httpCode: info.httpCode || undefined,
      retryable: info.retryable,
      notified: decision.send ? decision.scope : undefined,
      sent: (session.sent || []).length || undefined,
      proactive: proactive || undefined,
      error: String(session.error || '').slice(0, 300)
    }, traceId);

    if (!decision.send) return;
    const text = buildErrorReply({
      kind: info.kind,
      scope: decision.scope,
      botName: persona.botName,
      detail: session.error,
      lines: er.lines
    });
    if (!text) return;

    // 冷却戳在**发送前**打：发送本身要等节流/额度，慢的时候可能几秒，
    // 而这期间同一会话的另一轮失败正等着看这个戳。先打戳宁可多压一次提示。
    this.errorReplyAt.set(baseKey, now);
    // 历史由 sender.sendTextBatch 内部 appendSelf（src/sender.js:471）负责写，
    // 这里**不能**再写一遍 —— 否则同一句话在历史里出现两条，下一轮她看到自己重复说。
    try {
      await this.sender.sendTextBatch(physKey, [text], {});
      this.emit('log', { text: `[error-reply] 已提示（${info.kind} → ${decision.scope}）：${text.slice(0, 60)}` });
    } catch (e) {
      console.warn('[error-reply] 发送失败：', e?.message ?? e);
    }
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, taskContext = null, pushTask = null, traceId = '' }) {
    const cfg = getConfig();
    const baseKey = parseChatKey(chatKey).base;
    const talkCfg = cfg.talk || {};
    // 闸门判定只对"紧接着的那次唤醒"有效：超过 60 秒（或 forceWake 手动叫醒）
    // 就按 direct 走 —— 宁可按满档，也不拿一个过期的档位去压上下文。
    const cached = this.lastDecision.get(baseKey) || null;
    this.lastDecision.delete(baseKey);
    const decision = cached && Date.now() - (cached.at || 0) < 60000 ? cached : null;
    const tier = decision?.tier || 'direct';
    const decKind = decision?.kind || (kind === 'private' ? 'private' : 'interject');
    const talkBefore = talkCfg.enabled === false
      ? null
      : talkWindowOf(baseKey, { windowMs: Number(talkCfg.windowMs) || 20000 });
    // 首条消息的"总延迟预算"从这里起算（扣掉模型生成耗时）。
    this.sender.beginRun?.(chatKey, { tier, startedAt: Date.now(), traceId });
    // 日志行的 traceId 前缀：让"面板那一条"和"跳过记录/会话详情"能对上同一个把手。
    if (traceId) this.emit('log', { text: `[${traceId}] ${chatKey} 开始处理（档位 ${tier}，${triggerEntries.length} 条触发${proactive ? '，主动机会' : ''}）` });

    // 她自己的日记（diary.js）：记忆是条目，日记是"那一天"。没有日记就整段不出现。
    // 2026-10-24 相关性门控：日记曾是口癖固化源（群友梗→日记→每天注入→照着念），
    // 只有触发文本确实可能与日记相关（时间指代 / 内容词重合）才注入 ——
    // 大多数闲聊轮省掉 ~450 字，还掐断了"每天背自己的原话"的自增强链。
    const triggerTextForDiary = triggerEntries.map((m) => String(m.text || '')).join('\n');
    const diaryText = cfg.diary?.enabled === false
      ? ''
      : formatDiaryForPrompt(chatKey, {
        entries: Number(cfg.diary?.injectEntries) || 2,
        chars: Number(cfg.diary?.injectChars) || 220,
        relevantTo: triggerTextForDiary
      });
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const ident0 = resolvePersona(chatKey);
    const p0 = ident0.persona;
    const selfNickname = kind === 'group' ? (p0.selfNickname || this.onebot.selfNickname || p0.botName) : p0.botName;

    // 这一轮真正在说话的人（识人注入 + 长期事实都按他查）。拿不到号码就不猜。
    // 判定统一走 speaker.js：以前这里、提示词、isMaster 各写一份，判法还不一样
    // （提示词认"最后一条"、isMaster 认"第一条"）—— 群里就会自相矛盾。
    const speaker = primarySpeaker(triggerEntries, {
      kind,
      chatId,
      aliases: personaAliases(p0, [selfNickname]),
      selfIds: [this.onebot ? this.onebot.selfId : ''],
      selfNickname
    });
    // 本轮触发消息 = 相关性排序的 query（2026-10-26 P2-1）。
    // 不传的话，"聊到吃辣时把忌口那条顶上来"这件事根本不可能发生 ——
    // 事实只会按新旧排，"三个月没提的过敏"永远排在最后。
    // 概率式召回的调参（2026-10-27）：`stats` 是**就地填充**的观测对象 —— 召回台账靠它落盘。
    const recallOpts = recallOptsOf(cfg, kind);
    const factQuery = triggerEntries.map((m) => String(m?.text || '')).join(' ').slice(0, 400);
    const factStats = {};
    const factsText = speaker && cfg.memoryFacts?.enabled !== false
      ? formatFactsForPrompt(speaker.id, {
        limit: Number(cfg.memoryFacts?.injectLimit) || 8, chatKey, query: factQuery,
        sample: cfg.memoryFacts?.recallSampling !== false, recallOpts, stats: factStats
      })
      : '';
    if (factStats?.pool) {
      recordRecall('facts', factStats, { qq: speaker?.id || '', chatKey });
    }
    // 关系记忆（跨群、覆盖式）：和 facts 分两段，混在一起会被当成条目念
    const relationText = speaker && cfg.memoryFacts?.enabled !== false
      ? formatRelationForPrompt(speaker.id, { chatKey })
      : '';
    // 群级记忆只在群里有 —— 私聊没有"这个群"这回事
    const groupFactStats = {};
    const groupFactsText = kind === 'group' && cfg.groupFacts?.enabled !== false
      ? formatGroupFactsForPrompt(chatKey, {
        limit: Number(cfg.groupFacts?.injectLimit) || 6, query: factQuery,
        sample: cfg.groupFacts?.recallSampling !== false,
        recallOpts: recallOptsOf(cfg, 'group'),
        stats: groupFactStats
      })
      : '';
    if (groupFactStats?.pool) {
      recordRecall('group', groupFactStats, { chatKey });
    }

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    const selfLabel = p0.selfNickname || this.onebot.selfNickname || p0.botName;
    const direct = triggerEntries.some((entry) =>
      isDirectMessage(entry, {
        kind, selfNickname: selfLabel, botName: p0.botName,
        selfId: this.onebot ? this.onebot.selfId : ''
      }));
    const freshReply = !!selfLastMessageAt && triggerEntries.some((entry) =>
      !entry.self && entry.ts >= selfLastMessageAt && entry.ts - selfLastMessageAt <= 5000);
    const attackCount = countHostileMessages(triggerEntries);
    let moodText = '';
    if (cfg.mood?.enabled !== false) {
      if (!proactive && triggerEntries.length) {
        this.mood.observe(chatKey, { direct, freshReply, attackCount });
      }
      moodText = this.mood.formatForPrompt(chatKey);
    }

    // ── 人设回路（vibe.js）：此刻心情 / 关系账本 / 沉默档 ──────────────────
    // 和 mood.js 分开的两件事：mood.score 是**底色**（慢变量，gesture 的拍一拍预算读它），
    // 这里是**此刻情绪**（快变量，只写进提示词）。两个时间尺度合一，会出现
    // "他回了个'哦'，半夜就被判成心情低落不敢说话"这种事。
    // 拿不到 speaker.id 就不记账（宁可不记，也不要张冠李戴到别人头上）。
    let vibeText = '';
    // 此刻最强的那一层情绪（语音链路要用它决定语气/参考音频）。
    // 为空 = 没什么特别的情绪，语音走中性档，不硬演。
    let vibeEmotion = '';
    const vibeSettings = VibeStore.configSettings();
    if (vibeSettings.enabled !== false) {
      try {
        const recentForVibe = this.store.recent(chatKey, { limit: 20 });
        const selfTimes = myMessages.slice(-8).map((m) => m.ts);
        const signals = collectSignals({
          recent: recentForVibe,
          triggerEntries,
          speakerId: speaker?.id || '',
          selfTimes,
          kind,
          now: Date.now()
        });
        const key = vibeKey(chatKey, speaker?.id || '');
        if (!proactive && triggerEntries.length) {
          const layers = driftLayers(signals, vibeSettings);
          if (layers.length) this.vibe.observe(key, layers, VibeStore.causeOf(signals), { settings: vibeSettings });
        }
        const state = this.vibe.get(key, Date.now(), vibeSettings);
        vibeText = renderVibe({
          blend: state.blend,
          cause: state.cause,
          signals,
          baseline: this.mood.get(chatKey).score,
          settings: vibeSettings
        });
        // 语音链路要的是一个**标签**（能查表换参考音频），不是那句给人读的
        // "别扭里带一点委屈"。两者门槛一致（同一份 settings），否则会出现
        // 提示词说委屈、语音按平静念的分裂感。
        vibeEmotion = topEmotion(state.blend, vibeSettings)?.name || '';
      } catch (e) {
        // 人设回路出错绝不影响这一轮对话：降级回原来那行情绪提示。
        console.warn('[vibe] 组装失败（已降级）：', e?.message || e);
        vibeText = '';
      }
    }

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // ── 语音语气（voice-delivery.js）：此刻该用什么语气说话 ──────────────────
    // 原来"发语音用什么语气"完全靠模型在 send_voice 里自由发挥，结果是同一个
    // 音色在开心/难过/生气时听起来一模一样，流萤那 6 条情绪参考音频几乎没被切过。
    // 这里先把"情绪 → 表演参数"算出来，一半写进提示词（教它怎么写、怎么填 emotion），
    // 一半随 ctx 传给 send_voice（那边按**实际**音色再算一次，允许模型临时换音色）。
    const moodScoreNow = cfg.mood?.enabled === false ? 50 : (this.mood.get(chatKey)?.score ?? 50);
    const voiceKeyNow = String(cfg.audio?.gsvVoice || 'hutao');
    let toneText = '';
    try {
      const tonePlan = resolveTone({
        vibeEmotion,
        voice: voiceKeyNow,
        availableRefs: Object.keys(GSV_VOICES[voiceKeyNow]?.emotions || {}),
        moodScore: moodScoreNow,
        strength: cfg.audio?.toneStrength,
        enabled: cfg.audio?.toneAuto !== false
      });
      toneText = formatToneHint(tonePlan);
    } catch (e) {
      // 语气算不出来不该影响对话：空着就是"按老样子发"。
      console.warn('[voice] 语气计划失败（已降级）：', e?.message || e);
      toneText = '';
    }

    // 身份解析：按会话键决定人设（多身份核心接线）
    const ident = resolvePersona(chatKey);
    const persona = ident.persona;
    if (ident.modeDef && String(ident.modeDef.extraPrompt || '').trim()) {
      persona.customRules = [persona.customRules, ident.modeDef.extraPrompt].filter(Boolean).join('\n\n');
    }

    // ── 多人并发（crowd.js）：这批里到底有几个人在等它 ────────────────────
    // 这里只算事实，怎么说是 prompt.js 的事（措辞一旦写进判定层，就会变成模板）。
    // 没有这一层，模型看到的是一串平铺的消息，只有两条路：每人回一条，或只答最后一个。
    const crowdCfg = cfg.crowd || {};
    const crowd = crowdCfg.enabled === false
      ? null
      : crowdOf(triggerEntries, {
        kind,
        aliases: personaAliases(persona, [selfNickname]),
        selfIds: [this.onebot ? this.onebot.selfId : ''],
        selfNickname: persona.selfNickname || selfNickname,
        maxAskers: Number(crowdCfg.maxAskers) || 4,
        // 主人也在这几个"在等你"的人里时，点名标出来（提示词里写「（你的主人）」）
        masterId: masterQQOf(persona),
        now: Date.now()
      });
    // 只在"多人在等"时留一行：这是排查"这轮为什么回了两三条"的入口。
    if (isMultiAsk(crowd)) this.emit('log', { text: describeCrowd(chatKey, crowd) });

    // 组装提示词（无 LLM 历史）
    // 两段都带预算元信息：谁被截断、谁被淘汰、有没有未登记的段 —— 一律留痕。
    // 没留痕的裁剪是这套系统里最难查的一类故障：模型"忽然不听话"，日志里什么都没有。
    // ── 工具按场景装载（P1，tool-scene.js）──────────────────────────────
    // 46 个工具定义 18,072 字符，比整个人格提示词还大一倍，而 1000 轮里只有 5 个工具做了 95% 的活。
    // **只裁群聊**：私聊是主人一对一会话，唱歌/日记/文件都在那儿用，工具一个不动（同上一条取舍）。
    // 必须先算出来 —— 下面 buildUserBundle 要按"没装哪些包"写一句提示词，
    // 否则模型只知道"工具里没有唱歌"，不知道"可以去 load_tools 拿"（安全规则正好禁止它假装有）。
    const sceneTrim = cfg.tools?.sceneTrim !== false && isGroupChat(chatKey);
    const triggerText = triggerEntries.map((e) => String(e?.text ?? '')).join('\n');
    const packState = this.packState.get(chatKey) || {};
    // ⚠️ 包选择**不能被 sceneTrim 关掉**：sceneTrim 只在群聊为真（私聊不裁工具，
    //    工具全挂），但技能 SOP 的按需注入在私聊同样要生效 —— 否则主人私聊点歌时
    //    她手上有 sing_lyrics 却没有「没有调就不许唱」这条规矩。
    //    差别只在下游：工具裁剪与「缺什么工具」那句话仍只走群聊。
    const scenePacks = selectPacks({ text: triggerText, prev: packState });
    this.packState.set(chatKey, stampPacks(packState, scenePacks.matched));
    const toolPacksText = sceneTrim ? describeOmitted(scenePacks.active) : '';

    const sysBundle = buildSystemBundle({
      persona,
      extraSections: this.promptSections(),
      // 技能 SOP（唱歌/链接/视频 1293 字）只在对应包激活时才拼进 system，
      // 97.7% 的轮次整段不出现。放在最后是为了不破坏前缀缓存。
      packs: scenePacks.active
    });
    // 时间段摘要（time-digest.js）：只在"真有人叫它"时才现压缺的片。
    // ⚠️ 必须带超时：这是**回复链路上**唯一一次可能新起的模型调用，
    //    压缩慢不能拖成"她半天不说话"。超时就本轮不带，下次再压（片是幂等的）。
    // ⚠️ 定时器要 unref：否则每次唤醒都往事件循环里挂一个 9 秒的定时器，
    //    进程退出/测试收尾会被它白白拖住。
    const digestText = await Promise.race([
      this.#prepareDigest(chatKey, { kind, triggerEntries, talk: talkBefore }),
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve(''),
          Math.max(1500, Number(cfg.digest?.timeoutMs) || DIGEST_DEFAULTS.timeoutMs)
        );
        if (typeof timer.unref === 'function') timer.unref();
      })
    ]);
    const userBundle = buildUserBundle({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      // 这批里有几个人在等它（crowd.js）。solo/none 时 prompt 侧整段不出现。
      crowd,
      store: this.store,
      memory: this.memory,
      // 往事摘要（P2）：热窗口之外的历史已压成的条目。没压过 / 已熔断 = 空串 = 整段不出现。
      pastSummaryText: cfg.pastSummary?.enabled === false
        ? ''
        : this.pastSummary.formatForPrompt(chatKey, {
          maxChars: Number(cfg.pastSummary?.maxChars) || 800,
          perSlotMax: Number.isFinite(Number(cfg.pastSummary?.perSlotMax))
            ? Math.max(0, Number(cfg.pastSummary.perSlotMax))
            : SUMMARY_DEFAULTS.perSlotMax,
          slotMode: cfg.pastSummary?.slotMode !== false
        }),
      stickerEntries,
      // 时间段摘要（time-digest.js）：滑出热窗口的那半小时/一小时的大概。空串 = 整段不出现。
      digestText,
      // 按需工具（P1）：哪些包没挂出来。空串 = 整段不出现（私聊永远是空串）。
      toolPacksText,
      // 本轮激活的工具包：user 侧的表情包段要用它判断"能不能提 list_stickers"。
      packs: scenePacks.active,
      selfNickname: persona.selfNickname || selfNickname,
      // 寻址判定要知道它自己的 QQ（认出"@ 的是不是它"）
      selfId: this.onebot ? this.onebot.selfId : '',
      persona,
      mode: ident.mode,
      taskContext,
      pushTask,
      moodText,
      // 人设回路（此刻心情 / 关系账本 / 沉默档）。为空 = 没什么特别的情绪，不注入。
      vibeText,
      // 此刻最强情绪名（语音链路用；为空 = 中性档）
      vibeEmotion,
      // 【此刻的语气】那一段（voice-delivery 产出的写法提示），没有情绪时为空
      toneText,
      // 拍一拍/@ 的分寸要用到心情分数（gesture.pokeBudget）：
      // 心情低不主动招惹人，兴奋时才"手贱"。只给数字，不给文案。
      moodScore: moodScoreNow,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      tier,
      talk: talkBefore,
      // 受限动作集（每轮算一次）：只写在用户消息里，不污染系统提示
      actionPlan: planActions({
        kind,
        tier,
        hour: new Date().getHours(),
        moodScore: moodScoreNow,
        hasSticker: stickerEntries.length > 0,
        canVoice: cfg.audio?.enabled !== false,
        // 真实剩余额度（-1 表示不限/未知）：让"最多几条"和发送侧同一个数。
        // 不传这个的话，模型会照档位规划 3~4 条，撞墙后再花一整轮补救。
        sendQuota: this.sendQuotaRemaining(chatKey),
        // 表情这一轮到底能不能发（2026-10-29 第 4 轮）：
        // 以前 hasSticker 只表示"库里有图"，而真正拦她的是**会话冷却**和**表情的分钟桶**
        // （与文本桶分开，缺省 1 张/分钟）。实测 31 次表情失败里 30 次是这两条，
        // 全部可以在调用之前就知道 —— 提前说清楚，省下"调一次、撞墙、再改口"的一整轮。
        sticker: this.stickerState(chatKey, { cfg, stickerEntries }),
      }),
      // 学到的表达（只读正式库；候选库永远进不来）
      expressions: getExpressions().pick(parseChatKey(chatKey).base, { limit: 3 }),
      // 条件扩展段（manifest prompt.sections[].when）：由 prompt.js 按本批消息判断命中
      extensionSections: this.promptSections(),
      factsText,
      relationText,
      groupFactsText,
      diaryText
    });

    const systemPrompt = sysBundle.text;
    const userPrompt = userBundle.text;
    // 预算明细：进会话对象（面板/存档可查）+ 只在"真砍了什么"时打一行日志。
    // 刻意不每轮都打印 —— 天天输出"一切正常"的日志等于没有日志。
    session.promptBudget = {
      system: { chars: sysBundle.budget.chars, dropped: sysBundle.budget.dropped, clipped: sysBundle.budget.clipped, over: sysBundle.budget.over },
      user: { chars: userBundle.budget.chars, dropped: userBundle.budget.dropped, clipped: userBundle.budget.clipped, over: userBundle.budget.over },
      // 过去状态窗口（P1）：保住/折叠/丢了几条。这是"这轮为什么没看到那句 @"的唯一线索。
      past: userBundle.past
        ? { count: userBundle.past.count, protectKept: userBundle.past.protectKept, folded: userBundle.past.folded, dropped: userBundle.past.dropped?.length || 0 }
        : null
    };
    for (const [label, b] of [['系统提示', sysBundle.budget], ['用户消息', userBundle.budget]]) {
      const line = describeBudget(b, label);
      if (line) this.emit('log', { text: line });
      // 未登记段 = 顺序不可控（正是 Estrella 那次"扩展包提示词被静默丢掉"的成因）。
      // 每段只提醒一次，避免每轮刷屏。
      for (const name of b.unregistered || []) {
        const key = `${label}:${name}`;
        if (this.warnedUnregistered.has(key)) continue;
        this.warnedUnregistered.add(key);
        console.warn(`[prompt] ${label}里的段「${name}」没有在 context-budget.js 的 ORDER 里登记 —— 顺序不可控，请补上`);
      }
    }
    // 过去状态窗口：只在"真做了点什么"时打一行 ——
    // 保住了一条在叫它的消息、折叠了连发、或把她的旧发言并成了片段，都值得留痕；
    // 单纯按时间丢掉旧消息不值得刷屏。
    if (userBundle.past && (userBundle.past.protectKept > 0 || userBundle.past.folded > 0 || userBundle.past.selfFolded > 0)) {
      const pastLine = describePastWindow(userBundle.past);
      if (pastLine) this.emit('log', { text: pastLine });
    }

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    // 口头禅点名：必须留痕，否则"提醒过但还犯"这件事永远查不出来。
    // （只记簇 id 和条数，不记原话 —— 原话在 prompt 里已经有了，别重复存一遍。）
    if (userBundle.phraseGuard?.hits?.length) {
      const tags = userBundle.phraseGuard.hits
        .map((h) => `${h.id}×${h.count}${h.chronic ? '（屡犯' + h.times + '）' : ''}`)
        .join('、');
      this.emit('log', { text: `[口头禅] 这轮已点名：${tags}` });
      session.phraseGuard = userBundle.phraseGuard.hits.map((h) => ({
        id: h.id, count: h.count, chronic: !!h.chronic, times: h.times || 0
      }));
    }
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    session.chatName = chatName;
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    // ── before-context 钩子：组消息之后、建上下文之前（可读入站情绪等）──
    try {
      await this.hookBus.emit('before-context', {
        chatKey, kind, chatId,
        triggerEntries,
        persona,
        mode: ident.mode,
        moodText,
        vibeText,
      });
    } catch (e) {
      console.warn('[plugins] before-context 钩子出错:', e?.message || e);
    }

    // ── 慢任务垫话（默认关闭）──────────────────────────────────────────
    // 超过 holdMs 还一句都没发出去 → 先垫一句，别让人干等。
    // 为什么默认关：它改变的是"它一开口说什么"，属于风格决定，不该由代码替用户拍板。
    // 开启方式：config.waiting.holdText = "我想想…"（空 = 关）。
    let holdTimer = null;
    const holdText = String(cfg.waiting?.holdText || '').trim();
    if (holdText && !proactive) {
      const holdMs = Number(cfg.waiting?.holdMs) || MERGE_DEFAULTS.holdMs;
      const runStartedAt = Date.now();
      holdTimer = setTimeout(() => {
        if (session.sent.length > 0) return;   // 已经说过了，别再垫
        if (!shouldHold({ startedAt: runStartedAt, now: Date.now(), holdMs, sentCount: session.sent.length, text: holdText })) return;
        this.sender.sendTextBatch(chatKey, [holdText], {})
          .then((r) => {
            session.sent.push(...r.sent.map((x) => ({ type: 'text', text: x.text, raw: x.raw })));
            this.emit('log', { text: `[垫话] ${chatKey} 等了 ${holdMs}ms 还没出结果，先垫了一句` });
          })
          .catch(() => { /* 垫话失败不影响本轮 */ });
      }, holdMs);
      holdTimer.unref?.();
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPrompt}\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt }
    ];

    // ── before-llm-messages 钩子：消息已建好、发给模型之前 ──
    // 钩子拿到的 messages 是同一引用，可直接 push/splice 修改（如本体情绪注入额外 system 提示）
    try {
      await this.hookBus.emit('before-llm-messages', { messages, chatKey, kind, chatId, persona, mode: ident.mode });
    } catch (e) {
      console.warn('[plugins] before-llm-messages 钩子出错:', e?.message || e);
    }

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionMode = cfg.vision?.mode === 'qwen' ? 'qwen' : 'native';
    const qwenVision = qwenVisionInfo();
    const visionEnabled = cfg.api.vision !== false
      && (visionMode === 'qwen' || modelVisionVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision');
    // 主人判断：私聊对端是主人，或**这一批里主人说过话**（在工具过滤前计算）。
    // ⚠️ 别再退化成"第一条/最后一条是谁说的"：
    //   · 以前看 triggerEntries[0] —— 主人 @ 它之后有人先说话，主人的工具就没了；
    //   · 以前没配主人时会回退到写死的 '123456789' —— 谁恰好是这个号谁就是主人。
    // 现在统一走 speaker.js：主人只要在这一批里发过言就算在场；
    // "群友索要主人专属操作"由提示词里的拒绝规则拦（见 securityRules）。
    const isMaster = batchHasMaster(triggerEntries, { kind, chatId, persona });
    const searchEnabled = cfg.webSearch?.enabled !== false;
    // 开关类过滤单独抽出来：按需装载（load_tools）把包加回来时**必须再走一遍**，
    // 否则"关掉视频功能"的会话会被模型一句 load_tools 把 watch_video 装回来。
    const switchAllowed = (d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      // 语音识别：语音功能或识别关掉时，不把 voice_to_text 暴露给模型
      if ((cfg.audio?.enabled === false || cfg.audio?.asr?.enabled === false) && d.name === 'voice_to_text') return false;
      if (d.name === 'qwen_vision' && visionMode !== 'qwen' && !qwenVision.hasKey) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      // 看视频：关掉时不挂载（省一个工具位，也避免模型对着关掉的能力反复试）
      if (d.name === 'watch_video' && cfg.video?.enabled === false) return false;
      // 主人专属工具：仅主人触发时挂载（群友/他人触发时模型看不到这些工具）
      if (d.masterOnly && !isMaster) return false;
      if (d.name === 'escalate_reasoning'
          && !(cfg.api?.routing?.enabled
            && cfg.api?.routing?.allowModelEscalation
            && String(cfg.api?.complexModel || '').trim())) return false;
      // 不裁场景时（私聊/主人会话）load_tools 是纯噪声：那儿工具全挂着，它无事可做。
      if (d.name === 'load_tools' && !sceneTrim) return false;
      return true;
    };
    const allAllowed = this.toolDefs.filter(switchAllowed);
    const scenePick = selectToolDefs(allAllowed, { active: scenePacks.active, enabled: sceneTrim });
    const toolDefs = scenePick.defs;
    const openAiTools = toOpenAiTools(toolDefs);
    if (scenePick.removed.length) {
      session.toolScene = { removed: scenePick.removed, packs: [...scenePacks.active], matched: scenePacks.matched };
    }
    // 插件工具：从注册表取 specs，转换后追加（插件工具已是 OpenAI 形状，直接铺平 function）
    const pluginSpecs = this.registry.specs();
    for (const spec of pluginSpecs) openAiTools.push(spec);
    const chatModel = String(cfg.api?.model || '').trim();
    const complexModel = String(cfg.api?.complexModel || '').trim();
    let activeModel = chooseInitialModel({ cfg, triggerEntries, taskContext, pushTask }) || chatModel;
    let modelEscalated = false;
    let fallbackTried = false;   // 本次运行是否已做过一次降级（避免每轮都降级）
    // 降级成功之后必须"记住"备用端点。以前这里只改 modelChain 记录，下一轮仍拿
    // activeModel 去打 cfg.api.baseUrl —— 而主端点会走到降级，通常正是因为欠费/宕机，
    // 于是第 2 轮必然再挂一次；偏偏 fallbackTried 已经是 true 不会再降级，
    // 结果就是"一次带工具调用的会话必定失败"（DeepSeek 欠费时 402 刷屏的成因）。
    let fallbackEndpoint = null;
    const modelChain = [activeModel].filter(Boolean);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: persona.botName,
      persona,
      mode: ident.mode,
      // 当前触发人（memory_forget 等工具用它定位"谁的记忆"，拿不到时工具自己拒绝）。
      speakerId: speaker?.id || '',
      senderName: speaker?.name || '',
      pushTask,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      emit: (type, payload) => this.emit(type, payload),
      isMaster,
      routingEnabled: !!cfg.api?.routing?.enabled,
      allowModelEscalation: !!cfg.api?.routing?.allowModelEscalation,
      modelEscalated: false,
      // ── 语音语气（send_voice 读它）─────────────────────────────────────
      // 以前这里没有 moodScore，于是 tools.js 里 `Number(ctx.moodScore ?? 50)`
      // 永远等于 50 —— 拍一拍预算的"心情低就收敛"那一档实际上从没生效过。
      moodScore: moodScoreNow,
      // 此刻情绪名（空 = 没情绪）；send_voice 的 emotion 传 auto 时用它
      vibeEmotion,
      /**
       * 按需装载工具包（P1，供 load_tools 调用）。
       * **真的**把定义加回 toolDefs / openAiTools —— 下一轮 round 就能调，
       * 不是"告诉你有个工具但调不了"的假货。只加不删：唱到一半工具消失比一开始没有更糟。
       *
       * 2026-10-29 第 4 轮修复：这里原来是 `enablePack(packs) { … }` 方法简写，
       * `this` 指向 ctx 而不是 Orchestrator，于是 `this.toolDefs` 是 undefined、
       * `for (const d of this.toolDefs)` 直接抛 `this.toolDefs is not iterable`。
       * 实测 load_tools 被调 3 次、失败 3 次（100%），每次都在这一行炸掉。
       * 改成箭头函数让 `this` 回到 Orchestrator，工具定义改读闭包里的 `toolDefs`。
       */
      enablePack: (packs) => {
        if (!sceneTrim) return { added: [], packs: [], reason: '这个会话工具全挂着' };
        const want = new Set(
          (Array.isArray(packs) ? packs : [packs])
            .map((x) => String(x ?? '').trim())
            .flatMap((x) => (x === 'all' ? PACK_NAMES : [x]))
            .filter((x) => PACKS[x])
        );
        if (!want.size) return { added: [], packs: [], reason: '包名不认识' };
        const added = [];
        // 遍历**全部**可用定义（不是当前裁过的 toolDefs —— 那样 includes 恒为真，
        // 一个也加不进来，等于把 load_tools 换成另一种形式的坏掉）。
        // 用快照遍历，避免往 toolDefs 里 push 时边遍历边改。
        for (const d of [...allAllowed]) {
          if (toolDefs.includes(d)) continue;
          if (!want.has(packOfTool(d.name))) continue;
          toolDefs.push(d);
          added.push(d.name);
        }
        // 顺序回到 buildToolDefs 的原始顺序：工具数组越靠前越稳定，前缀缓存越好命中。
        //
        // ⚠️ 2026-10-29 第 6 轮修：排序基准必须和第一次 `selectToolDefs` 时用的一致，
        // 也就是 `allAllowed`（**开关过滤后的**全集）。以前这里用 `this.toolDefs`
        // （未经开关过滤的全集），两者的成员和次序都不完全相同 ——
        // 被功能开关关掉的工具（视频关了、搜索关了、非主人会话的 masterOnly）
        // 在 `allAllowed` 里根本没有，却仍占着 `this.toolDefs` 的位次，
        // 于是"装载回来的工具"会排到不可预期的位置。
        // 这不会报错，只会让**前缀缓存**的稳定前缀每次略微不同 —— 最难查的那一类。
        const order = new Map(allAllowed.map((d, i) => [d.name, i]));
        toolDefs.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
        openAiTools.length = 0;
        for (const t of toOpenAiTools(toolDefs)) openAiTools.push(t);
        for (const spec of pluginSpecs) openAiTools.push(spec);
        const names = [...want];
        this.packState.set(chatKey, stampPacks(this.packState.get(chatKey) || {}, names));
        for (const n of names) scenePacks.active.add(n);
        if (added.length) {
          this.emit('log', { text: `[工具] 按需装载 ${names.map((n) => PACKS[n].label).join('、')}：+${added.join(',')}` });
        }
        return { added, packs: names.map((n) => PACKS[n].label) };
      },
      /**
       * 升级到复杂模型（供 escalate_reasoning 调用）。
       * 与 enablePack 同样的坑：方法简写里 `this` 是 ctx，`this.emit` 不存在。
       * 实测 escalate_reasoning 没有被调用过（0 次），所以这个坏法一直没暴露出来 ——
       * 但只要主人一开路由、模型真去升级，就会在 `this.emit` 上抛 TypeError，
       * 而那时候已经切了模型、改了 maxRounds，属于"坏在半路"。
       */
      escalateModel: (reason = '') => {
        if (!complexModel || complexModel === activeModel || modelEscalated) return false;
        activeModel = complexModel;
        fallbackEndpoint = null;   // 升级用的是目录里的模型，要回到主端点，别沿用降级锁定的备份
        modelEscalated = true;
        ctx.modelEscalated = true;
        maxRounds = hardMaxRounds;
        if (modelChain[modelChain.length - 1] !== activeModel) modelChain.push(activeModel);
        session.modelChain = [...modelChain];
        session.model = formatModelChain(modelChain);
        this.emit('log', { text: `[model-routing] 升级到 ${complexModel}${reason ? `：${reason}` : ''}` });
        return true;
      }
    };

    const hardMaxRounds = Math.max(1, Number(cfg.api.maxRounds) || 6);
    let maxRounds = activeModel === complexModel ? hardMaxRounds : Math.min(4, hardMaxRounds);
    let finish = false;
    // 输出预算：推理模型的"思考 token"同样计入 max_tokens。额度太小会把答案整段截掉
    // （finish_reason=length + content 为空 = 静默不回复）。实测近 300 个会话里 198 个 noreply，
    // 其中 93 个正是"输出恰好顶满上限"这一特征——问专业问题不回答就是这么来的。
    const baseBudget = () => (activeModel === complexModel
      ? (Number(cfg.api.complexMaxOutputTokens) || 4000)
      : (Number(cfg.api.maxOutputTokens) || 1200));
    const budgetCeiling = Math.max(baseBudget(), 16000);
    let roundBudget = baseBudget();
    let truncRetries = 0;
    let sawTruncation = false;
    let thinkOff = String(cfg.api.thinkingMode || 'auto') === 'off';
    // 思考档位：auto=不发（由模型默认）、off/on/low/high=按方言表发对应参数。
    // 以前只有 off 一条硬编码路径，档位调高对不发思考的模型毫无作用。
    const thinkMode = String(cfg.api.thinkingMode || 'auto').toLowerCase();
    let thinkingUnsupported = false;
    // 上下文超长的收缩重试：只做一次（砍完还超就是真的太大，换模型也没用）
    let promptTrimmed = false;
    // 上下文窗口用量（2026-10-31）：本轮只检查/清理一次，之后不再扫全量 messages。
    // windowWarned 只为了"窗口未知"这条日志不刷屏（一个会话打一次就够）。
    let compactDone = false;
    let windowWarned = false;
    // 某个端点的思考参数：**由方言表决定，未识别的端点仍然一个字段都不发**。
    // 旧实现是"只要是备用端点就一律 `thinking: null`"，理由是"多数网关不认"——
    // 那个顾虑现在由方言表接管（generic 方言不发任何字段，与旧行为一致）。
    // 一律不发反而踩了新坑：本机网关（dsh-providers-hub，8326）必须显式收到
    // `reasoning_effort`，不发时个别通道会狂烧思维链（实测 codearts 25.8s /
    // 1758 思考 token，发了 3.5s / 0），既慢又按输出价白烧钱。
    const thinkingForEndpoint = (endpoint) => {
      const mode = thinkOff ? 'off' : (thinkMode === 'auto' ? null : thinkMode);
      if (!mode) return null;
      try {
        const d = dialectFor({ baseUrl: endpoint?.baseUrl || '', model: endpoint?.model || '' });
        return d.dialect === 'generic' ? null : mode;   // 未知方言＝沿用旧行为，不发
      } catch {
        return null;
      }
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      if (roundBudget < baseBudget()) roundBudget = baseBudget();   // 模型升级/配置变化后跟上预算
      // ── 上下文用量检查（2026-10-31）──────────────────────────────
      // 在这之前没有任何地方知道"离窗口还有多远"：所有上限都是字符数。
      // 现在是：估算 messages 的 token → 除以窗口 → 到 0.82 才动手。
      // 动手的动作只有一个 —— 清掉深在历史里的工具原文（最轻的压缩）。
      // 只做一次，做完记 locked，避免每轮都扫一遍全量 messages。
      if (!compactDone) {
        const w = await this.#windowLimit(activeModel, fallbackEndpoint?.baseUrl || cfg.api.baseUrl);
        const usage = windowUsageOf({
          messages,
          contextWindow: w,
          charsPerToken: Number(cfg.api.charsPerToken) || CHARS_PER_TOKEN,
          reserveTokens: roundBudget
        });
        // 窗口是猜的（/models 没给、也没手配）时只记一次日志，不压缩 ——
        // 拿一个猜出来的 128K 去砍用户真实历史，比不砍更糟。
        if (usage.assumed && !windowWarned) {
          windowWarned = true;
          this.emit('log', { text: `${describeUsage(usage)}（模型窗口未知，不会据此压缩；可在设置里填 contextWindow）` });
        }
        if (shouldCompact(usage, {
          threshold: Number(cfg.api.compactThreshold) || COMPACT_THRESHOLD,
          enabled: true
        })) {
          compactDone = true;
          // 先是常规清理（保留最近 2 轮），不够再降到 1 轮重来一次。
          for (const keepRounds of [KEEP_RECENT_ROUNDS, 1]) {
            const r = clearStaleToolResults(messages, { keepRecentRounds: keepRounds });
            if (r.cleared > 0) {
              messages.splice(0, messages.length, ...r.messages);
              const line = describeClearing(r, { keepRecentRounds: keepRounds });
              if (line) this.emit('log', { text: `${describeUsage(usage)} → ${line.replace('[上下文] ', '')}` });
              break;
            }
          }
        }
      }
      let response;
      try {
        response = await chatCompletion({
          messages,
          tools: openAiTools,
          model: activeModel,
          // 已降级过就固定用备用端点：模型名与 baseUrl 必须成对，混着发必然 4xx
          baseUrl: fallbackEndpoint?.baseUrl || null,
          // 备选端点可能本来就不需要密钥（本地网关），没有就传空串，
          // 绝不能回落成 cfg.apiKey —— 那等于把主服务商的密钥发给别人
          apiKey: fallbackEndpoint ? String(fallbackEndpoint.apiKey ?? '') : undefined,
          maxTokens: roundBudget,
          // 已锁定备用端点时也要按方言发：一律不发会让本机网关在**后续轮次**
          // （工具循环里最关键的几轮）狂烧思维链甚至丢正文
          thinking: fallbackEndpoint
            ? thinkingForEndpoint({ baseUrl: fallbackEndpoint.baseUrl, model: activeModel })
            : (thinkOff ? 'off' : (thinkMode === 'auto' ? null : thinkMode))
        });
      } catch (error) {
        // ① 上下文超长（400 且正文点名）：先把【过去状态】砍掉一部分再重发一次。
        //    换模型没用 —— 请求本身太大，换谁都一样大；而降级链还常常悄悄换成
        //    一个更小的模型，看起来"救回来了"，实际是答非所问。
        if (!promptTrimmed && isContextOverflowError(error?.message)) {
          // 必须定位最初那条 user（【过去状态】在里面）。tool loop 之后 messages 末尾
          // 是 tool 结果/图片 user 消息，盲取"最后一条"永远裁不动，只能白降级（2026-10-24 实锤）。
          const target = messages.find((m) => m && m.role === 'user') || messages[messages.length - 1];
          const trimmed = trimPromptSection(target?.content, '过去状态', 0.4);
          if (trimmed.changed && target) {
            promptTrimmed = true;
            target.content = trimmed.text;
            session.promptChars = systemPrompt.length + target.content.length;
            this.emit('log', { text: `[上下文] 超出模型上限，已裁掉较早的群聊记录（${trimmed.before}→${trimmed.after} 字）后重试` });
            round -= 1;
            continue;
          }
        }
        // ② 个别网关不认 thinking 参数（直接 4xx）：去掉它重试一次，之后本轮不再发
        // 只认 400/422（请求参数不合法）。402 欠费、401 密钥失效、429 限流都不是
        // "网关不认 thinking"，以前一律用 /HTTP 4\d\d/ 匹配，欠费时会先白跑一次
        // 去掉 thinking 的重试，白白多等一轮才进降级。
        if (thinkOff && !thinkingUnsupported && /HTTP (400|422)\b/.test(String(error?.message || ''))) {
          thinkingUnsupported = true;
          thinkOff = false;
          this.emit('log', { text: '[思考开关] 该端点不支持 thinking 参数，改用加大预算重试' });
          round -= 1;
          continue;
        }
        // 降级链：模型请求失败（网络/超时/5xx/密钥）时，换备选端点重试一次
        // 只在「本轮还没降级过」且「错误可重试」时触发，避免无限降级
        if (!fallbackTried && !this.aborted && isRetryableError(error?.message)) {
          const chain = buildFallbackChain({ currentModel: activeModel });
          // 去掉第一项（当前端点，已经失败过），只留备选
          const backups = chain.slice(1);
          if (backups.length) {
            fallbackTried = true;
            // 依次试完所有备选（同提供商其他模型 → 跨提供商），而不是只试第一个：
            // 典型场景——DeepSeek 欠费时 deepseek-v4-pro 同样 402，只有后面的
            // 跨提供商（如百炼 qwen-flash）才能救回这一轮。
            // ⚠️ 这里**不要再另设上限**：链长已由 buildFallbackChain 收敛到 MAX_CHAIN。
            // 以前写 slice(0, 6)，而链本身有 8 条（7 个备选）—— 排在最后的第 8 条
            // 永远不会被尝试，等于"加进目录了但永不生效"，且日志里一行痕迹都没有。
            // 2026-10-25 加第 5 家（本机免费网关）时正是踩在这个坑上。
            let lastRetryErr = null;
            for (const backup of backups) {
              this.emit('log', { text: `[模型降级] ${activeModel} 失败，切到 ${backup.displayName}/${backup.model} 重试` });
              try {
                response = await chatCompletion({
                  messages,
                  tools: openAiTools,
                  model: backup.model,
                  baseUrl: backup.baseUrl,
                  apiKey: backup.apiKey,
                  maxTokens: roundBudget,
                  // 交给方言表：未识别的端点不发（＝旧行为），本机网关则发 reasoning_effort
                  thinking: thinkingForEndpoint(backup)
                });
                // 锁定备用端点：后续轮次直接走它，不再回头撞那个已经失败的端点
                activeModel = backup.model;
                fallbackEndpoint = { baseUrl: backup.baseUrl, apiKey: backup.apiKey };
                if (modelChain[modelChain.length - 1] !== backup.model) modelChain.push(backup.model);
                lastRetryErr = null;
                break;
              } catch (retryErr) {
                lastRetryErr = retryErr;
                this.emit('log', { text: `[模型降级失败] ${backup.displayName}/${backup.model} 也失败：${retryErr?.message || retryErr}` });
              }
            }
            if (!response) throw lastRetryErr || error;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      const responseModel = String(response.model || activeModel || '').trim();
      if (responseModel && modelChain[modelChain.length - 1] !== responseModel) modelChain.push(responseModel);
      session.modelChain = [...modelChain];
      session.model = formatModelChain(modelChain);
      addUsage(session.usage, response.usage, { model: responseModel || activeModel });
      addUsageForModel(session.usage, responseModel || activeModel, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const assistantEntry = {
        role: 'assistant',
        content: typeof msg.content === 'string' ? msg.content : (msg.content ?? null),
        tool_calls: msg.tool_calls ?? undefined
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      this.sessions.update(session.id);
      this.emit('session-update', session.id);

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const uiLast = session.messages[session.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }

      if (!toolCalls.length) {
        // ① 输出被截断（思考吃满预算、答案为空）→ 原地加预算重试，不消耗轮次。
        //    不处理的话就是"问它专业问题它不回答"：content 空 + 无工具调用 → 直接 break 静默结束。
        const usedTokens = Number(response.usage?.completion_tokens) || 0;
        const truncated = response.finishReason === 'length' || (roundBudget > 0 && usedTokens >= roundBudget - 1);
        if (truncated && truncRetries < 3 && !String(rawContent || '').trim()) {
          truncRetries += 1;
          sawTruncation = true;
          const before = roundBudget;
          // 首选关思考（快且省），网关不支持时下一轮自动回退到"只加预算"
          if (!thinkingUnsupported) thinkOff = true;
          roundBudget = Math.min(budgetCeiling, Math.max(Math.round(roundBudget * 1.5), 2000));
          let escalated = false;
          if (activeModel !== complexModel && typeof ctx.escalateModel === 'function') {
            escalated = ctx.escalateModel('输出被截断，需要更长思考预算');
            if (escalated) roundBudget = Math.min(budgetCeiling, Math.max(roundBudget, baseBudget()));
          }
          messages.pop();              // 撤回这条空的 assistant 消息，别污染上下文
          session.messages.pop();
          this.emit('log', { text: '[预算重试] 输出被截断（' + usedTokens + '/' + before + ' tokens' + (escalated ? '，已升级模型' : '') + '，' + (thinkOff ? '改为不思考' : '加大预算') + '）→ 预算 ' + roundBudget });
          round -= 1;                  // 这次不计入轮次
          continue;
        }

        // 兜底（仅私聊）：模型把回复写在 content 里没调 send_message 时自动发出（清理 XML 残留）。
        // 群聊不兜底——模型看到消息后若决定回复会主动调 send_message；不调 = 自主选择不回复（正常），
        // 若把它的内心独白/决策文本兜底发出去，就会变成"每条都回/自言自语刷屏"。
        const privChat = isPrivateChat(ctx.chatKey);
        const directText = privChat ? (typeof msg?.content === 'string' ? msg.content : '').trim() : '';
        // 🔴 2026-10-24 实机事故：private:10000001 这一轮先用 send_message 发了
        //    「诶 出现了」「哪去了这两天」，随后又吐了一句收尾独白「（已经发完，结束。）」，
        //    走本兜底直接发给了主人。三个成因缺一不可：
        //      ① 这里判独白时 hasSendMessage 硬编码 false —— 明明本轮已经发过话；
        //      ② 那句是纯中文口语，不含任何加权特征，排除法得分 0；
        //      ③ 这是唯一一条只过"排除法"、不过"确认法"的兜底路径。
        //    修法比补特征更根本：**本轮已经发过话，后面的 content 必然是独白。**
        //    模型要说的已经在 send_message 里说完了，剩下的文字按定义不是给主人看的。
        const spokeThisRun = (ctx.session?.sent || []).length > 0;
        const monoA = directText ? looksLikeMonologue(directText, { hasSendMessage: spokeThisRun }) : { think: false };
        if (monoA.think) this.emit('log', { text: '[独白拦截/A] ' + directText.slice(0, 50) });
        // 兜底只放行"本轮还没说过话 + 不像独白"的文本；spokenOkA 再用确认法兜一层，
        // 防的是"不含已知特征、但其实是在自言自语"的那类（本事故正是这类）。
        const spokenOkA = directText ? looksSpokenToUser(directText) : false;
        if (!spokeThisRun && !monoA.think && directText && !spokenOkA) {
          this.emit('log', { text: '[独白拦截/A2] ' + directText.slice(0, 50) });
        }
        if (!spokeThisRun && !monoA.think && spokenOkA && directText && !containsInlineToolSyntax(directText)
            && directText.length <= 2000 && !/^[\[\]{}()<>\s]+$/.test(directText)) {
          const cleaned = directText
            .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
            .replace(/<\/?parameter>|<\/?invoke>|<\/?function_calls>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleaned && cleaned.length >= 1 && !/^<\/?/.test(cleaned)
              && !alreadySent(ctx.session, cleaned)) {
            try {
              const r = await ctx.sender.sendTextBatch(ctx.chatKey, cleaned, {});
              ctx.session.sent.push(...r.sent.map((x) => ({ type: 'text', text: x.text, raw: x.raw })));
              ctx.emit('session-update', ctx.session.id);
              this.emit('log', { text: '[兜底发送] 模型直接输出已发出: ' + cleaned.slice(0, 60) });
            } catch (e) {
              this.emit('log', { text: '[兜底发送失败] ' + (e?.message || e) });
            }
          }
        }
        // 没有工具调用 = 模型结束思考
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        break;
      }

      // ── 每轮工具调用前：content 兜底（2026-09-14 收紧）──
      // 🔴 事故复盘：用户反馈机器人"经常把思考内容发给我"（"已出题，等学生作答"、
      //    "让我查看复习队列的 key"、工具状态等）。
      //    统计 160 条真实记录 / 33 个"调了工具且带 content"的轮次后发现：
      //      · 其中含第二人称（你/同学）的只有 2 条，**且那 2 条也是思考**
      //      · 结论：**模型调工具时写的 content 几乎必然是思考，不是对主人说的话**
      //    旧逻辑把它当"边说边做"直接发出 → 大量独白泄漏到聊天。
      // 现在的规则：有工具调用时，**只发严格判定为"确实在对主人说话"的文本**；
      //    其余一律不发（模型要说话就该调 send_message）。
      {
        const privateChat = isPrivateChat(ctx.chatKey);
        const roundText = (typeof msg?.content === 'string' ? msg.content : '').trim();
        const roundHasSend = toolCalls.some((c) => (c?.function?.name ?? '') === 'send_message');
        const monoC = roundText ? looksLikeMonologue(roundText, { hasSendMessage: roundHasSend }) : { think: false };
        // 严格正向判定：必须"明确在对主人说话"才允许兜底发出。
        // 注意这里与 monoC.think 是两道独立闸门——只要任一认为可疑就不发。
        const spokenOk = roundText ? looksSpokenToUser(roundText) : false;
        if (monoC.think || (roundText && !spokenOk)) {
          this.emit('log', { text: '[独白拦截/C] ' + roundText.slice(0, 50) });
        }
        if (spokenOk && !monoC.think && privateChat && roundText
            && !containsInlineToolSyntax(roundText) && roundText.length <= 2000) {
          const cleanedRound = roundText
            .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
            .replace(/<\/?parameter>|<\/?invoke>|<\/?function_calls>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (cleanedRound && cleanedRound.length >= 1 && !/^<\/?/.test(cleanedRound)
              && !alreadySent(ctx.session, cleanedRound)) {
            try {
              const rRound = await ctx.sender.sendTextBatch(ctx.chatKey, cleanedRound, {});
              ctx.session.sent.push(...rRound.sent.map((x) => ({ type: 'text', text: x.text, raw: x.raw })));
              this.emit('log', { text: '[工具前兜底] content 已发出: ' + cleanedRound.slice(0, 50) });
            } catch (e) {
              this.emit('log', { text: '[工具前兜底失败] ' + (e?.message || e) });
            }
          }
        }
      }

      const toolResults = [];
      const imageUserMessages = [];
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        // ── before-tool 钩子：扩展包可否决这次工具调用（如复读拦截 send_message）──
        const beforeHook = await this.hookBus.emit('before-tool', {
          toolName: name,
          argsRaw,
          session: { chatKey, sent: ctx.session.sent },
        });
        let result;
        if (beforeHook.vetoed) {
          // 被否决：把否决原因作为工具结果回灌给模型，让它换个说法
          this.emit('log', { text: `[插件否决] ${name} 被 ${beforeHook.vetoed.owner} 否决：${beforeHook.vetoed.reason}` });
          result = { content: `错误：${beforeHook.vetoed.reason}`, isError: true };
        } else {
          // 插件工具优先走注册表 executor；内置工具走 executeTool
          const pluginExecutor = this.registry.executorOf(name);
          if (pluginExecutor) {
            let parsedArgs = {};
            try { parsedArgs = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw; } catch { parsedArgs = {}; }
            try {
              const r = await pluginExecutor(ctx, parsedArgs ?? {});
              result = { content: r?.content ?? JSON.stringify(r), isError: !!r?.isError };
            } catch (e) {
              result = { content: `错误：${e?.message ?? e}`, isError: true };
            }
          } else {
            result = await executeTool(toolDefs, ctx, name, argsRaw);
          }
        }
        // ── after-tool 钩子 ──
        // 带 session 是刻意的（2026-10-29 第 12 轮）：before-tool 早就有 session，
        // 而 after-tool 没有 —— 结果"这次到底有没有真的发出去"这件事，钩子侧看不见。
        // 复读拦截因此只能在 before-tool 记账（发送前），于是**发送失败的那句也被记成"说过"**，
        // 模型换个说法重发时被自己的历史挡下，用户看到的就是"它没理我"。
        // 实测 15 次拦截里 5 次是这个成因（上一句其实是 quota/白名单失败的）。
        await this.hookBus.emit('after-tool', {
          toolName: name,
          argsRaw,
          result: result?.content,
          isError: !!result?.isError,
          session: { chatKey, sent: ctx.session.sent },
        });
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        // ── 单条工具结果超长截断（省钱层移植：命中率修复的最后一道防线）──
        // 起因：模型可能并行调多个工具、每个返回上百条消息 ⇒ 上下文被顶爆，
        // 新内容第一次发送必然未命中缓存，越堆越贵越慢。宁可让它"看不全"。
        // 2026-10-25：从"只留开头"改成"头 + 尾"（tool-result-budget.js）。
        // 只留开头会切掉结论——列表类工具最新的消息在末尾，JSON 的 total/has_more 在末尾，
        // 表现是"它看了工具结果却答了前面几句无关的"。
        try {
          const tcfg = getConfig()?.tools || {};
          const r = clipToolResult(contentStr, {
            maxChars: Math.max(2000, Number(tcfg.toolResultMaxChars) || 12000),
            headRatio: Number(tcfg.toolResultHeadRatio) || undefined,
            hint: name === 'get_recent_messages' ? '需要更多请分页（get_recent_messages 带 offset）。' : ''
          });
          if (r.changed) {
            contentStr = r.text;
            this.emit('log', { text: `[工具截断] ${name}：${describeClip(r)}` });
          }
        } catch { /* 截断失败不影响原结果 */ }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') {
          finish = true;
          // 修复：模型调 finish 收尾时，若它把话写在 content 里没走 send_message → 私聊兜底发出
          const privateChat = isPrivateChat(ctx.chatKey);
          const finContent = (typeof msg?.content === 'string' ? msg.content : '').trim();
          // finish 轮若同时调了 send_message，content 同样是内心独白（该轮常伴随"总结收尾"式独白）
          const finHasSend = toolCalls.some((c) => (c?.function?.name ?? '') === 'send_message');
          const monoB = finContent ? looksLikeMonologue(finContent, { hasSendMessage: finHasSend }) : { think: false };
          // 同路径C：finish 轮的 content 也多为独白（"本轮结束"之类），需严格正向判定
          const spokenOkB = finContent ? looksSpokenToUser(finContent) : false;
          if (monoB.think || (finContent && !spokenOkB)) this.emit('log', { text: '[独白拦截/B] ' + finContent.slice(0, 50) });
          if (spokenOkB && !monoB.think && privateChat && finContent
              && !containsInlineToolSyntax(finContent) && finContent.length <= 2000) {
            const cleanedFin = finContent
              .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
              .replace(/<\/?parameter>|<\/?invoke>|<\/?function_calls>/gi, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (cleanedFin && cleanedFin.length >= 1 && !/^<\/?/.test(cleanedFin)
                && !alreadySent(ctx.session, cleanedFin)) {
              try {
                const rFin = await ctx.sender.sendTextBatch(ctx.chatKey, cleanedFin, {});
                ctx.session.sent.push(...rFin.sent.map((x) => ({ type: 'text', text: x.text, raw: x.raw })));
                this.emit('log', { text: '[finish兜底] content 已发出: ' + cleanedFin.slice(0, 60) });
              } catch (e) {
                this.emit('log', { text: '[finish兜底失败] ' + (e?.message || e) });
              }
            }
          }
        }
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    // 垫话计时器必须先停：否则它会在这一轮结束之后突然发一句，看起来像"幽灵消息"。
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    let status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    // 因输出预算被截断而什么都没发出：这不是"主动不接"，要让它看得见（不再是静默 noreply）
    if (!session.error && status === 'noreply' && sawTruncation) {
      session.error = '模型输出被截断：思考占满了输出上限（max_tokens），本轮没有产出可发送内容。可在设置里调高 maxOutputTokens / complexMaxOutputTokens。';
      status = 'error';
      this.emit('log', { text: '[预算不足] 本轮未回复：' + session.error });
      // 与 MODEL_SILENT 必须分开记：一个是"它决定不接"，一个是"它想说但被截断了"。
      // 混成一类的话，调大 maxOutputTokens 能修好的问题会被当成玄学。
      this.noteSkip(SKIP_STAGES.BUDGET_RETRY, chatKey, '输出被思考占满，本轮没有可发送内容', {
        truncated: true
      }, traceId);
    }
    // ── 私聊必回铁律（兜底重试）────────────────────────────
    // 私聊且模型本轮思考了却什么都没发（没调 send_message、content 也空）：
    // 再给一次机会强制让它回复，避免"私聊了却不回复"。最多重试 2 次。
    if (!session.error && status === 'noreply' && isPrivateChat(ctx.chatKey)) {
      // 未配置主人（masterQQ 为空）时这里必须什么都不做 —— 以前回退到写死的
      // '123456789'，等于把某个陌生人的私聊当成主人在催回复。
      const MASTER_QQ = masterQQOf(ctx.persona);
      if (MASTER_QQ && String(ctx.chatId || '') === MASTER_QQ) {
        let retried = 0;
        while (retried < 2 && session.sent.length === 0 && !this.aborted && !this.paused) {
          retried++;
          try {
            const retryMsg = [
              { role: 'system', content: buildSystemBundle({ persona: ctx.persona, extraSections: this.promptSections() }).text },
              { role: 'user', content: '【系统提醒】你刚才收到主人的私聊消息，但没有给出任何回复就结束了。私聊规则：主人私聊你时必须回复。请只用自然中文输出一条简短回复正文，不要调用工具，不要输出任何 XML、DSML、invoke、parameter 或函数调用标记。' }
            ];
            const { chatCompletion } = await import('./llm.js');
            const resp = await chatCompletion({ messages: retryMsg, temperature: 0.6 });
            recordSideUsage('master-retry', resp?.usage, { model: getConfig().api?.model });
            const retryText = String(resp?.message?.content || '').trim();
            if (retryText && !containsInlineToolSyntax(retryText)) {
              const cleaned = retryText.replace(/<\/?[a-zA-Z][^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
              if (cleaned && cleaned.length >= 1 && cleaned.length <= 2000) {
                const r2 = await ctx.sender.sendTextBatch(ctx.chatKey, cleaned, {});
                ctx.session.sent.push(...r2.sent.map((x) => ({ type: 'text', text: x.text, raw: x.raw })));
                status = 'done';
                this.emit('log', { text: '[必回重试] 已补发回复: ' + cleaned.slice(0, 60) });
              }
            } else if (retryText) {
              this.emit('log', { text: '[必回重试] 拦截工具标记文本' });
            }
          } catch (e) {
            console.error('[必回重试] 出错:', e?.message || e);
            break;
          }
        }
      }
    }

    // 模型自己选择不说话 = **正常终态**，但必须落账。
    // 这是"它为什么不回我"里最容易被错判成 bug 的一种：代码一切正常，只是它决定不接。
    // 带上档位与上下文长度，事后能判断"是不是上下文被压得太狠导致它不敢开口"。
    if (status === 'noreply') {
      this.noteSkip(SKIP_STAGES.MODEL_SILENT, chatKey, '模型看完之后决定不说话（正常终态，不是故障）', {
        tier,
        trigger: triggerEntries.length,
        promptChars: session.promptChars,
        proactive: proactive || undefined
      }, traceId);
    }

    // ── after-response 钩子：本轮回复结束之后（如本体情绪更新状态）──
    try {
      await this.hookBus.emit('after-response', {
        chatKey,
        status,
        sent: session.sent,
      });
    } catch (e) {
      console.warn('[plugins] after-response 钩子出错:', e?.message || e);
    }

    // ── 表达学习（零模型成本，节流 10 分钟一次）────────────────────
    // 只写候选库；候选永不进提示词，必须人工转正（红线，见 expression-learner.js）。
    try {
      const key = parseChatKey(chatKey).base;
      const tick = this.exprTick.get(key) || 0;
      if (Date.now() - tick >= 10 * 60 * 1000) {
        this.exprTick.set(key, Date.now());
        const recent = this.store.recent(key, { limit: 60 });
        const r = getExpressions().observe(key, recent);
        if (r.learned) this.emit('log', { text: `[表达] ${key} 新增候选 ${r.learned} 条（待确认，不会自动使用）` });
      }
    } catch (e) {
      console.warn('[expressions] 学习失败（不影响本轮）：', e?.message ?? e);
    }

    // ── 连续对话收口（唯一调用点）─────────────────────────────────────
    // 只记"已经发生过的事实"：发了没有、是不是锚点在说、这一轮是不是软收尾。
    // 判定归 reply-gate，这里只记账 —— 混在一起就是当初"lastPartnerId 一清空全断"的老毛病。
    if (talkCfg.enabled !== false && !proactive) {
      const last = triggerEntries.length ? triggerEntries[triggerEntries.length - 1] : null;
      const fromPartner = !!talkBefore?.partnerId && !!speaker && speaker.id === talkBefore.partnerId;
      const sentAny = session.sent.some((x) => x.type === 'text');
      const stickerOnly = isStickerOnlyText(last?.text);
      const ended = stickerOnly && fromPartner && !!talkBefore?.active
        && stickerEndsTalk(talkBefore, { tolerant: talkCfg.stickerTolerant !== false });
      if (fromPartner && !stickerOnly) notePartnerText(baseKey);   // 表情不刷新宽限，否则连发表情无限续命
      noteTalkReply(baseKey, {
        kind: decKind,
        userId: speaker?.id || '',
        name: speaker?.name || '',
        sent: sentAny,
        ended,
        closing: !!talkBefore?.active && (Number(talkBefore.turns) || 0) >= TALK_MAX_TURNS - 1,
        fromPartner,
        hadTalk: !!talkBefore?.active
      });
    }
    this.sender.endRun?.(chatKey);

    // 长期事实：后台静默提取（不阻塞收尾）。节流在 #maybeExtractFacts 里。
    if (speaker && triggerEntries.length && !proactive) {
      this.#maybeExtractFacts(baseKey, chatKey, speaker, triggerEntries)
        .catch((e) => console.warn('[memory-facts] 提取失败:', e?.message || e));
    }

    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage,
      cost: estimateCost(session.usage)
    });
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      const chatKey = this.pickProactiveTarget(cfg);
      if (!chatKey) return;
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  /**
   * 挑一个可以主动开口的群；没有就返回 null（调用方直接 return，不掷骰子也不花钱）。
   *
   * 抽成公开方法是为了**能被测到**：原来这段逻辑长在 tick 的闭包里，
   * 接线错了（比如漏掉退避过滤）任何测试都发现不了 —— 变异测试里把这一行改成
   * `candidates = candidates` 之后 12 项断言照样全绿，这就是没测到。
   */
  pickProactiveTarget(cfg = getConfig()) {
    const candidates = this.#proactiveCandidates(cfg);
    if (!candidates.length) return null;
    // 再收敛一层：这个群最近主动过、没人接 → 先别试（省下的是一整轮的钱）
    const allowed = this.filterByProactiveBackoff(cfg, candidates);
    if (!allowed.length) return null;
    return allowed[Math.floor(Math.random() * allowed.length)];
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  /**
   * 主动机会的收敛闸门（2026-10-29 第 2 轮）。
   *
   * 为什么不能只靠 idleThresholdMs：那是**只会越来越真**的条件 —— 没人说话的时间只会变长。
   * 所以一个没人搭理的群，每 30~90 分钟就被投一次骰子，每次烧一整轮的钱，
   * 结果永远是 noreply，而这件事在面板上和"她看过但决定不接"长得一模一样。
   *
   * 这里只做一件事：**让"上次试过了、没人接"这件事被记住**。
   * 判定与计数全在 proactive-backoff.js（纯逻辑、可注入时钟），这里只负责接线。
   *
   * @returns {string[]} 过滤后的候选（被挡下的会落一条 skip 记录，不花钱的跳过也要看得见）
   */
  filterByProactiveBackoff(cfg, candidates) {
    if (cfg.proactive?.backoffEnabled === false) return candidates;
    const backoff = getProactiveBackoff(cfg.proactive);
    const out = [];
    for (const chatKey of candidates) {
      const v = backoff.check(chatKey);
      if (!v.skip) {
        out.push(chatKey);
        continue;
      }
      // 落账：否则"为什么今天一次都没主动"在面板上无从排查
      this.noteSkip(SKIP_STAGES.PROACTIVE_BACKOFF, chatKey, v.reason, {
        kind: v.kind,
        streak: v.streak,
        waitMs: v.waitMs
      });
    }
    return out;
  }

  /**
   * 记账入口：主动这一轮的结果要回写到退避状态里。
   *
   * 三条规则的接线（规则本身在 proactive-backoff.js）：
   *   · 正常对话（非主动）跑完一轮 → reset：群里有人说话了，连败清零；
   *   · 主动且发出了话 → recordSent：短冷却，别对着沉默继续自言自语；
   *   · 主动但没发（noreply / 出错）→ recordDeclined：指数退避，下一次更晚。
   *
   * 出错也算一次"没反应"：否则一个每次都超时的群会被无限重试（那才是最贵的失败）。
   */
  noteProactiveOutcome(chatKey, status, proactive) {
    try {
      const cfg = getConfig();
      if (cfg.proactive?.backoffEnabled === false) return;
      const backoff = getProactiveBackoff(cfg.proactive);
      const key = String(chatKey || '');
      if (!proactive) {
        // 正常对话：有人说话就说明这个群活着，把连败清零（纪律①）
        if (backoff.reset(key)) saveProactiveBackoff(backoff);
        return;
      }
      if (status === 'done') {
        const r = backoff.recordSent(key);
        saveProactiveBackoff(backoff);
        this.emit('log', {
          text: `[主动] ${key} 开了话题，${describeWait(r.waitMs)}内不再主动开口（连败 ${r.streak}）`
        });
      } else {
        const r = backoff.recordDeclined(key);
        saveProactiveBackoff(backoff);
        this.emit('log', {
          text: `[主动] ${key} 这次没有开口（${status}），连败 ${r.streak}`
            + (r.waitMs > 0 ? `，${describeWait(r.waitMs)}后再试` : '，下次照常')
        });
      }
    } catch (e) {
      // 记账失败绝不能影响主流程
      console.warn('[proactive-backoff] 记账失败（忽略）：', e?.message ?? e);
    }
  }

  /** 面板/排查用：当前所有会话的退避快照。 */
  proactiveBackoffSnapshot() {
    try {
      return getProactiveBackoff(getConfig().proactive).snapshot();
    } catch {
      return [];
    }
  }

  // ── 发送额度的前置感知（2026-10-29 第 3 轮）────────────────────────────
  /**
   * 这一轮还能发几条（-1 = 不限或算不出来）。
   *
   * 与 `checkSendQuota` 的分工：那个是"整轮要不要放弃"（remaining <= 0 才放弃），
   * 这个是"既然要跑，就告诉模型真实上限"。两个数来自同一个 `sender.quotaFor()`。
   */
  sendQuotaRemaining(chatKey) {
    try {
      if (typeof this.sender?.quotaFor !== 'function') return -1;
      const q = this.sender.quotaFor(chatKey);
      if (!q || q.unlimited || !Number.isFinite(q.remaining)) return -1;
      return Math.max(0, Number(q.remaining) || 0);
    } catch {
      return -1;
    }
  }

  /**
   * 开跑前先问一句"这一分钟还发得出去吗"。
   *
   * 为什么值得单独一道闸（实测 `data/sessions/` 1000 份会话）：
   *   · `finishReason` 命中限流文案且 `sent.length === 0` 的轮次 **78 个**，
   *     合计 2,550,975 prompt tokens，占全部 32,849,688 的 **7.77%**（均 32,943/轮）；
   *   · 这 78 个轮次里，**每一个**在开始前 60 秒内同一个群都已经发过 **4 条**
   *     （分布恰好 {4: 78}）—— 额度在模型开口之前就满了，那一轮不可能成功。
   *
   * 竞品（AstrBot / LangBot）把限流放在**入站**阶段，所以从不为此付费；
   * 我们原来只在发送时判（sender.#checkRate），钱已经花了。
   *
   * 关键取舍：
   *   ① **只挡"已经满了"**（remaining <= 0），不挡"只剩 1 条" ——
   *      剩 1 条完全可能说完整，挡掉等于把正常对话也一起削了。
   *   ② 挡下时 `scheduleWake(resetInMs + 抖动)`：消息保持未读，等窗口滑过去再处理，
   *      不是丢掉。抖动是必要的 —— 同一个群的多个轮次会在同一秒一起醒来，
   *      错开 0~1.5 秒成本为零，却能避免它们又同时撞上新窗口。
   *   ③ 主动机会直接放弃（不重排）：主动开话题本来就是"可有可无"，
   *      额度满的时候还排队等，只会在窗口一开就立刻挤掉别人的正常对话。
   *   ④ 整段 try/catch：额度模块自己出错绝不能变成"不回复"。
   *
   * @param {string} physKey 物理键（消息实际落库的会话）
   * @param {object} [opts]
   * @param {boolean} [opts.proactive]
   * @param {string} [opts.traceId]
   * @returns {boolean} true = 放行，false = 这一轮不该开跑
   */
  checkSendQuota(physKey, { proactive = false, traceId = '' } = {}) {
    const cfg = getConfig();
    if (cfg.send?.preflightQuota === false) return true;   // 逃生阀：关掉即回到老行为
    if (!this.sender || typeof this.sender.quotaFor !== 'function') return true;
    let q;
    try {
      q = this.sender.quotaFor(physKey);
    } catch (e) {
      console.warn('[send-quota] 额度预判出错（按放行处理）：', e?.message ?? e);
      return true;
    }
    if (!q || q.unlimited || q.remaining > 0) return true;

    const waitMs = Math.max(0, Number(q.resetInMs) || 0);
    this.noteSkip(
      SKIP_STAGES.SEND_QUOTA,
      physKey,
      `这一${q.window === 'hour' ? '小时' : '分钟'}已经发满 ${q.limit} 条，${describeQuotaWait(waitMs)}后滑出窗口再处理（消息保持未读，没花模型钱）`,
      { window: q.window, limit: q.limit, used: q.used, resetInMs: waitMs, proactive },
      traceId
    );
    if (!proactive && !this.aborted && !this.paused) {
      // 错开一点点：同群的多个轮次会在同一毫秒醒来，再一起撞新窗口。
      const delay = waitMs + 100 + Math.floor(Math.random() * 1400);
      this.scheduleWake(physKey, delay);
    }
    return false;
  }

  // ── 表情能否发送的前置感知（2026-10-29 第 4 轮）────────────────────────
  /**
   * 这一轮到底能不能发表情（给 action-planner / 提示词用）。
   *
   * 与第 3 轮的文字额度是**两套桶**：表情有自己的分钟上限
   * （`sticker.maxPerMinute`，缺省 1 张）和自己的会话冷却（`sticker.cooldownMs`）。
   * 这两道闸门原来只在 send_sticker 的 execute 里判，模型得先调一次、撞墙、
   * 拿到错误再花一整轮改口。
   *
   * 实测（`data/sessions/` 1000 份会话）：send_sticker 被调 60 次、失败 31 次
   * （**51.7%**），失败原因全部可提前预判 —— 冷却中 16、分钟额度满 14、今天已发过 1。
   *
   * 关键取舍：
   *   ① 判定顺序与 send_sticker 的 execute **完全一致**（本轮张数 → 会话冷却 →
   *      分钟额度），否则会出现"提示词说冷却中、真发时却报额度满"的自相矛盾。
   *   ② 只回答"能不能发"和"为什么不能"，**不在这里拦调用** —— 工具侧照旧兜底。
   *      少一层拦截就少一处会跟配置漂移的规则副本。
   *   ③ 整段 try/catch：算不出来就当作"能发"（宁可让工具去判，也不能因为
   *      一个提示词字段算错就把正常表情削掉）。
   *
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {object} [opts.cfg]
   * @param {Array}  [opts.stickerEntries] 已经同步好的表情库快照（避免重复 sync）
   * @returns {{canSend:boolean, kind:string, reason:string, waitMs:number, remaining:number, available:number}}
   */
  stickerState(chatKey, { cfg = getConfig(), stickerEntries = null } = {}) {
    const fallback = { canSend: true, kind: 'ok', reason: '', waitMs: 0, remaining: Infinity, available: 0 };
    try {
      const sc = cfg.sticker || {};
      if (sc.enabled === false) {
        return { canSend: false, kind: 'off', reason: '表情功能关掉了', waitMs: 0, remaining: 0, available: 0 };
      }
      const entries = Array.isArray(stickerEntries) ? stickerEntries : [];
      const available = entries.filter((e) => isStickerSendable(e)).length;
      // 库里一张能发的都没有：这时候说"冷却中"是骗人的，说"没图"才有用。
      if (!available) {
        return { canSend: false, kind: 'empty', reason: '表情库里现在没有能发的图', waitMs: 0, remaining: 0, available: 0 };
      }
      const recentWindow = Math.max(10, Number(sc.recentWindow) || 40);
      const { lastStickerAt } = scanOwnStickers(
        this.store.recent(chatKey, { limit: recentWindow }),
        parseStickerLogId
      );
      const quota = typeof this.sender?.stickerQuotaFor === 'function'
        ? this.sender.stickerQuotaFor(chatKey)
        : { limit: 0, used: 0, remaining: Infinity, resetInMs: 0, unlimited: true };
      const state = assessSticker({
        sentThisRun: 0,
        maxPerRun: Math.max(1, Number(sc.maxPerRun) || 1),
        cooldownMs: Math.max(0, Number(sc.cooldownMs) || 0),
        lastStickerAt,
        // 分钟桶交给 sender 算（它持有那个 `|sticker` 桶），这里传 0 让 assessSticker
        // 只判前两道闸门。顺序仍然是「本轮张数 → 会话冷却 → 分钟额度」。
        minuteLimit: 0,
        stickerTimes: [],
        now: Date.now()
      });
      // 第三道闸门：分钟桶。额度已经由 stickerQuotaFor 算好，不必再传原始时间戳
      // （传空数组会让 used 恒为 0，看起来"永远还能发"，那是错的）。
      if (state.canSend && !quota.unlimited && Number(quota.remaining) <= 0) {
        return {
          canSend: false,
          kind: 'minute',
          reason: `这一分钟的表情额度已满（${quota.limit} 张）`,
          waitMs: Math.max(0, Number(quota.resetInMs) || 0),
          remaining: 0,
          available
        };
      }
      return { ...state, available };
    } catch (e) {
      console.warn('[sticker-quota] 表情状态预判出错（按能发处理）：', e?.message ?? e);
      return fallback;
    }
  }

  // ── 长期事实提取（memory-facts.js）──
  // 只喂「这个人说的话 + 我的回复」，别人说的不喂 —— 一次把 A 的事安到 B 头上，
  // 比记不住严重得多（记忆模块参考包的实测结论）。
  // 节流：同一会话攒够 minNewMessages 条、且距上次提取超过 minIntervalMs 才跑一次。
  async #maybeExtractFacts(baseKey, chatKey, speaker, triggerEntries) {
    const cfg = getConfig();
    if (cfg.memoryFacts?.enabled === false) return;
    if (!speaker?.id || !cfg.api?.model || !cfg.api?.baseUrl) return;
    const tick = this.factTick.get(baseKey) || { at: 0, count: 0 };
    tick.count += triggerEntries.length;
    this.factTick.set(baseKey, tick);
    const minMsgs = Number(cfg.memoryFacts?.minNewMessages) || 16;
    const minGap = Number(cfg.memoryFacts?.minIntervalMs) || 30 * 60 * 1000;
    const now = Date.now();
    if (tick.count < minMsgs || now - tick.at < minGap) return;
    tick.count = 0;
    tick.at = now;

    const recent = this.store.recent(chatKey, { limit: 30 });
    const lines = [];
    for (const m of recent) {
      const text = String(m.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (m.self) { lines.push(`我：${text.slice(0, 80)}`); continue; }
      if (String(m.senderId || '') !== speaker.id) continue;
      lines.push(`${speaker.name || '对方'}：${text.slice(0, 80)}`);
    }
    if (lines.filter((l) => l.startsWith(`${speaker.name || '对方'}：`)).length < 3) return;

    const prompt = buildExtractionPrompt({ name: speaker.name, who: speaker.id, lines });
    // 整理用模型（api.utilityModel）：留空就回落主模型，行为与从前完全一致。
    const r = await chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: utilityModelOf(cfg),
      temperature: 0,
      maxTokens: 300,
      thinking: 'off'
    });
    recordSideUsage('facts-extract', r?.usage, { model: utilityModelOf(cfg) });
    const facts = parseExtractionDetailed(r?.message?.content, { name: speaker.name });
    if (!facts.length) return;
    // scope：person 跨群可见，group 只留在本群（防把群里的私事端到别处）
    // kind：negative/rule 走核心保护（不衰减/优先占位）；占比已在解析层封顶
    for (const f of facts) rememberFact(speaker.id, f.text, { source: baseKey, scope: f.scope, kind: f.kind });
    this.emit('log', {
      text: `[长期记忆] ${baseKey} ${speaker.name || speaker.id} 记下 ${facts.length} 条（共 ${factCount(speaker.id)} 条）`
    });
  }

  // ── 记忆自动整理 ──
  // 触发条件（二者同时满足）：某类记忆超过阈值，且距上次整理超过冷却时间。
  // 频率与方法的权衡：整理本身是一次便宜的 LLM 调用，但没必要频繁跑——
  // 记忆只在 agent 使用 memory_append 时增长，阈值触发 + 6 小时冷却足够防止膨胀。
  static MEMORY_THRESHOLDS = { activeTopic: 8, pendingThought: 8, memberImpression: 18 };

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      const T = Orchestrator.MEMORY_THRESHOLDS;
      const over = st.counts.activeTopic > T.activeTopic
        || st.counts.pendingThought > T.pendingThought
        || st.counts.memberImpression > T.memberImpression;
      if (!over) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.#consolidateMemory(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  async #consolidateMemory(chatKey) {
    const st = this.memory.query(chatKey);
    const total = st.activeTopic.length + st.pendingThought.length + st.memberImpression.length;
    if (total === 0) return;
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = ['【进行中的话题】'];
    for (const e of st.activeTopic) lines.push(`- (${fmtTs(e.createdAt)}) ${e.content}`);
    lines.push('【想说但还没说的话】');
    for (const e of st.pendingThought) lines.push(`- (${fmtTs(e.createdAt)}) ${e.content}`);
    lines.push('【对群友的印象】');
    for (const e of st.memberImpression) lines.push(`- ${e.target || '某人'}：${e.content} (${fmtTs(e.createdAt)})`);

    const messages = [
      {
        role: 'system',
        content: '你是聊天机器人的记忆整理模块。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"activeTopic":["…"],"pendingThought":["…"],"memberImpression":[{"target":"群友QQ号或名字","content":"…"}]}'
      },
      {
        role: 'user',
        content: [
          '下面是机器人对某个聊天的长期记忆，请整理：',
          '1. 进行中的话题：同属一个话题的多条记录合并成一条最新的；明显已经聊完的、或超过 3 天且已过时的删除；最多保留 6 条，每条不超过 120 字。',
          '2. 想说但还没说的话：合并重复的；超过 1 天的旧念头删除；最多保留 6 条。',
          '3. 对群友的印象：同一个人有多条印象时合并成一条综合印象（target 保留原值），以最新观感为主；最多 15 条，每条不超过 120 字。',
          '原则：所有信息只能来自原文，语义不变，宁少勿错；空类别输出空数组。',
          '',
          ...lines
        ].join('\n')
      }
    ];
    const res = await chatCompletion({ messages, model: utilityModelOf(getConfig()), temperature: 0.2 });
    recordSideUsage('memory-consolidate', res?.usage, { model: utilityModelOf(getConfig()) });
    const text = String(res?.message?.content ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[memory] 整理结果不是合法 JSON，本轮放弃（原记忆未动）');
      return;
    }
    const afterCount = (Array.isArray(parsed.activeTopic) ? parsed.activeTopic.length : 0)
      + (Array.isArray(parsed.pendingThought) ? parsed.pendingThought.length : 0)
      + (Array.isArray(parsed.memberImpression) ? parsed.memberImpression.length : 0);
    if (afterCount > total) {
      console.warn(`[memory] 整理结果条数（${afterCount}）比原来（${total}）还多，疑似幻觉，本轮放弃`);
      return;
    }
    const norm = this.memory.replaceConsolidated(chatKey, parsed);
    const n = norm.activeTopic.length + norm.pendingThought.length + norm.memberImpression.length;
    console.log(`[memory] 记忆整理 ${chatKey}：${total} 条 → ${n} 条（原记忆已备份到 data/memory/backups/）`);
  }

  // ── 往事摘要（past-summary.js，P2）───────────────────────────────────────
  /**
   * 该不该压一次往事摘要。触发条件是**三件事同时满足**：
   *   ① 窗口外攒够了 minPending 条没压过的；
   *   ② 距上次压超过 minIntervalMs；
   *   ③ 这个会话没被熔断（连续失败过 failThreshold 次）。
   *
   * 为什么要有 ①：一条一条压，等于每条消息都付一次模型调用；攒一批压一次才划算。
   * 为什么要有 ②：会话很热的时候（每轮结束都会走到这里）不能让摘要抢主流程的钱。
   */
  #maybeSummarizePast(chatKey) {
    try {
      const cfg = getConfig();
      const sc = cfg.pastSummary || {};
      if (sc.enabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;      // 没选模型就不压
      if (this.summarizing.has(chatKey)) return;
      const st = this.pastSummary.get(chatKey);
      if (st.disabled) return;                                // 已熔断：安静退回纯窗口
      const win = windowLimitsOf(chatKey, cfg.store || {});
      // 只回看这么远：摘要不需要"全部历史"，游标会保证不重复压。
      const msgs = this.store.recent(chatKey, { limit: Math.min(400, win.limit + 120) });
      const pending = pickPending(msgs, {
        windowLimit: win.limit,
        uptoId: st.uptoId,
        maxBatch: Number(sc.maxBatch) || SUMMARY_DEFAULTS.maxBatch
      });
      if (pending.length < (Number(sc.minPending) || SUMMARY_DEFAULTS.minPending)) return;
      const last = this.summaryTick.get(chatKey) || 0;
      if (Date.now() - last < (Number(sc.minIntervalMs) || SUMMARY_DEFAULTS.minIntervalMs)) return;
      this.summaryTick.set(chatKey, Date.now());
      this.summarizing.add(chatKey);
      this.#summarizePast(chatKey, pending, st, sc)
        .catch((error) => console.warn(`[摘要] ${chatKey} 异常:`, error?.message ?? error))
        .finally(() => this.summarizing.delete(chatKey));
    } catch { /* 摘要是锦上添花，绝不影响聊天主流程 */ }
  }

  async #summarizePast(chatKey, pending, st, sc) {
    const maxLines = Number(sc.maxLines) || SUMMARY_DEFAULTS.maxLines;
    const maxChars = Number(sc.maxChars) || SUMMARY_DEFAULTS.maxChars;
    // 每槽限额（P4.1，2026-10-26）：不设的话第一个槽会把总配额吃光，
    // 真机实测「答应了什么/定了什么」曾经一条都不剩。
    const perSlotMax = Number.isFinite(Number(sc.perSlotMax))
      ? Math.max(0, Number(sc.perSlotMax))
      : SUMMARY_DEFAULTS.perSlotMax;
    // 增量编辑模式（2026-10-31，ACE）：只发条目 + id，模型只能 ADD/EDIT/REMOVE。
    // 关掉就回到"合并重写"老路径（配置里 editMode:false 可随时回退）。
    const editMode = sc.editMode !== false && sc.slotMode !== false;
    const messages = editMode
      ? buildEditMessages({
        items: this.pastSummary.items(chatKey),
        lines: pending.map(renderForSummary),
        maxLines,
        maxChars,
        perSlotMax
      })
      : buildSummaryMessages({
        oldSummary: st.summary,
        lines: pending.map(renderForSummary),
        maxLines,
        maxChars,
        perSlotMax
      });
    let res;
    try {
      res = await chatCompletion({
        messages,
        model: utilityModelOf(getConfig()),
        temperature: 0.2,
        // 纯机械压缩，不需要思考。**必须显式关掉**：默认不传时会走模型自己的思考模式，
        // 实测 1200 的输出预算被思维链吃干净 —— 只吐出 155 字就卡断在半个引号上，
        // 而 finish_reason 是 length 而不是报错，看起来像"模型写少了"。
        thinking: 'off',
        // 800 字中文 ≈ 900~1000 token；留一点余量，但别让一次摘要烧掉整轮预算。
        maxTokens: Math.min(1600, Math.max(400, Math.ceil(maxChars * 1.4) + 120))
      });
    } catch (error) {
      this.#summaryFailed(chatKey, sc, `调用失败 ${error?.message ?? error}`);
      return;
    }
    recordSideUsage('past-summary', res?.usage, { model: utilityModelOf(getConfig()) });
    const truncated = String(res?.finishReason || '') === 'length';
    const uptoId = Number(pending[pending.length - 1]?.id) || st.uptoId;

    if (editMode) {
      const edits = parseEdits(res?.message?.content);
      // 一条指令都没解析出来 = 这轮白跑。不当失败处理（模型可能只是认为"没什么要改的"），
      // 但**不推进游标** —— 否则这批消息既没进摘要又再也不会被压，等于永久丢失。
      if (!edits.length) {
        this.#summaryFailed(chatKey, sc, truncated ? '输出被截断，没解析出指令' : '模型没给出任何编辑指令');
        return;
      }
      const next = this.pastSummary.applyEdits(chatKey, {
        edits,
        uptoId,
        sources: pending.map((m) => Number(m.id)).filter(Boolean),
        maxLines,
        maxChars,
        perSlotMax
      });
      // 全部指令都无效（id 对不上 / 正文为空）说明模型在瞎编条目 —— 同样不推进游标。
      if (next.added + next.edited + next.removed === 0) {
        this.#summaryFailed(chatKey, sc, `指令全部无效（${next.ignored} 条被忽略）`);
        return;
      }
      this.emit('log', {
        text: `[摘要] ${chatKey}：压了 ${pending.length} 条（至消息 #${uptoId}）→ `
          + `+${next.added} ~${next.edited} -${next.removed}（忽略 ${next.ignored}），`
          + `共 ${next.items.length} 条要点/${next.summary.length} 字，累计 ${next.runs} 次`
      });
      return;
    }

    // 槽位化归一化（模型没按槽位输出时自动退化成平铺条目，见 normalizeSlots）
    const text = (sc.slotMode === false ? normalizeSummary : normalizeSlots)(res?.message?.content, {
      maxLines,
      maxChars,
      perSlotMax,
      truncated
    });
    // 空摘要当失败处理：它会白白推进游标，把这段历史永久丢掉却又什么都没留下。
    if (!text) { this.#summaryFailed(chatKey, sc, '模型没给出可用条目'); return; }
    const next = this.pastSummary.commit(chatKey, { summary: text, uptoId });
    this.emit('log', {
      text: `[摘要] ${chatKey}：压了 ${pending.length} 条（至消息 #${uptoId}）→ ${text.split('\n').length} 条要点/${text.length} 字，累计 ${next.runs} 次`
    });
  }

  #summaryFailed(chatKey, sc, why) {
    const r = this.pastSummary.bumpFail(chatKey, Number(sc.failThreshold) || SUMMARY_DEFAULTS.failThreshold);
    if (r.justDisabled) {
      this.emit('log', { text: `[摘要] ${chatKey} 连续失败 ${r.failCount} 次，已停用该会话的往事摘要（退回纯窗口，聊天不受影响）` });
    } else {
      console.warn(`[摘要] ${chatKey} 第 ${r.failCount} 次失败：${why}`);
    }
  }

  // ── 时间段摘要（time-digest.js，m00209）────────────────────────────────
  /**
   * 本轮要不要补"刚才那半小时"。
   *
   * 判据只有一条：**这一轮真的有人在叫它**（trigger 里有 @我 / @全体 / 叫名字，
   * 或者正在一段连续对话里）。没人叫它的轮次里，她要做的只是"随口接一句"，
   * 那段背景毫无用处 —— 而它每次要花一次小模型调用。群里 90% 的轮次属于这种，
   * 全部省掉，这是"token 性价比"最大的一笔。
   *
   * 另外两条护栏：
   *   · 只压**已经滑出热窗口**的片（窗口里的原文照样给它，重复压既费钱又重复占预算）；
   *   · 一次最多新压 maxPerWake 片，从最新的往前压 —— 越贴近"现在"的越有用。
   */
  /**
   * 模型窗口大小（token）。
   *
   * 优先级：手配 `api.contextWindow` > `/models` 探测值 > 0（未知）。
   * 手配永远赢：`/models` 的窗口字段各家五花八门（`context_length` /
   * `max_model_len` / `max_context` …），不一定可信，用户填的才作数。
   *
   * 探测结果按 `<baseUrl>|<model>` 缓存 —— `listModels()` 是一次 15 秒超时的
   * HTTP 请求，不能每轮都发。0 也会被缓存（= 探测过，但没有这个信息），
   * 用 `has()` 区分"没探测过"。
   *
   * 任何失败都返回 0（= 未知），绝不抛错 —— 这条链路上抛错会拖垮整轮回复。
   */
  async #windowLimit(model, baseUrl) {
    const cfg = getConfig();
    const configured = Number(cfg.api?.contextWindow);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
    const m = String(model || cfg.api?.model || '').trim();
    const b = String(baseUrl || cfg.api?.baseUrl || '').trim();
    if (!m) return 0;
    const key = `${b}|${m}`;
    if (this.windowCache.has(key)) return this.windowCache.get(key);
    // 并发去重：同一时刻多个会话都在跑，别各发一次 /models
    if (!this.windowProbing) {
      this.windowProbing = (async () => {
        try {
          const list = await listModels();
          for (const item of list) {
            const k = `${b}|${item.id}`;
            if (!this.windowCache.has(k)) this.windowCache.set(k, Number(item.contextWindow) || 0);
          }
          if (!this.windowCache.has(key)) this.windowCache.set(key, 0);
        } catch {
          this.windowCache.set(key, 0);
        } finally {
          this.windowProbing = null;
        }
      })();
    }
    try { await this.windowProbing; } catch { /* 已吞过，这里只是等它结束 */ }
    return this.windowCache.has(key) ? this.windowCache.get(key) : 0;
  }

  async #prepareDigest(chatKey, { kind, triggerEntries, talk } = {}) {
    try {
      const cfg = getConfig();
      const dc = cfg.digest || {};
      if (dc.enabled === false) return '';
      if (dc.groupsOnly !== false && kind !== 'group') return '';
      const st = this.digest.get(chatKey);
      if (st.disabled) return '';

      const slotMs = Number(dc.slotMs) || DIGEST_DEFAULTS.slotMs;
      const maxSlots = Math.max(1, Number(dc.slots) || DIGEST_DEFAULTS.slots);
      const win = windowLimitsOf(chatKey, cfg.store || {});
      // 回看范围要盖住 maxSlots 个片（默认 4 片 = 1 小时），再留一点余量。
      const scan = Math.min(800, win.limit + Math.ceil((slotMs * maxSlots) / 30000) * 6);
      const msgs = this.store.recent(chatKey, { limit: scan });
      // 热窗口最旧一条的 id：>= 它的都还在窗口里，不压。
      // 直接从上面那次 recent 里切尾，不重复读一遍（这条路径每次唤醒都会走，省一次全量切片）。
      const winMsgs = msgs.slice(-win.limit);
      const cutId = winMsgs.length ? Number(winMsgs[0].id) : Infinity;

      const planned = planSlots(msgs, {
        now: Date.now(),
        slotMs,
        maxSlots,
        cutId,
        minMessages: Number(dc.minMessages) || DIGEST_DEFAULTS.minMessages
      });
      if (!planned.length) return '';

      // 只在"被叫"时花钱。判据与闸门侧同源（addresseeOf），不另写一套。
      let called = !!(talk && talk.active);
      if (!called) {
        for (const e of Array.isArray(triggerEntries) ? triggerEntries : []) {
          const a = addresseeOf(e, {
            aliases: [this.selfNicknameOf(chatKey)],
            selfIds: [this.onebot ? this.onebot.selfId : ''],
            selfNickname: this.selfNicknameOf(chatKey)
          });
          if (a.target === TARGET.SELF || a.target === TARGET.ALL) { called = true; break; }
        }
      }

      let keys = planned.map((p) => p.key);
      let maxChars = Number(dc.maxChars) || DIGEST_DEFAULTS.maxChars;
      if (called) {
        const missing = planned.filter((p) => !this.digest.slot(chatKey, p.key));
        // 从最新的往前压：越新的片越贴近"现在在聊什么"。
        const todo = missing.slice(-Math.max(1, Number(dc.maxPerWake) || DIGEST_DEFAULTS.maxPerWake));
        for (const p of todo) await this.#digestSlot(chatKey, p, dc);
      } else {
        // 没人叫它、只是可能插一句：只要**最近已压好的一片**，预算也砍半。
        // 插话不需要一小时的历史（那是"回答"才需要的东西），这里省的是输入 token。
        keys = keys.slice(-1);
        maxChars = Math.min(maxChars, 300);
      }
      const text = this.digest.formatForPrompt(chatKey, keys, {
        maxChars,
        perSlotChars: Number(dc.perSlotChars) || DIGEST_DEFAULTS.perSlotChars
      });
      return text ? `${digestLead()}\n${text}` : '';
    } catch (error) {
      // 补背景失败 = 这一轮少一段背景，绝不影响她说话。
      console.warn(`[时段摘要] ${chatKey} 跳过:`, error?.message ?? error);
      return '';
    }
  }

  async #digestSlot(chatKey, slot, dc) {
    if (this.digesting.has(chatKey)) return;
    if (!getConfig().api?.model) return;      // 没选模型：不压，等下次
    this.digesting.add(chatKey);
    try {
      const perSlotChars = Number(dc.perSlotChars) || DIGEST_DEFAULTS.perSlotChars;
      const res = await chatCompletion({
        messages: buildDigestMessages({
          start: slot.start,
          end: slot.end,
          lines: slot.lines,
          perSlotChars
        }),
        model: utilityModelOf(getConfig()),
        temperature: 0.2,
        // 纯机械压缩，必须显式关思考：默认会走模型的思考模式，把输出预算吃干净后
        // 卡断在半句上（past-summary 侧踩过，finish_reason 是 length 不是报错）。
        thinking: 'off',
        maxTokens: Math.min(600, Math.max(200, Math.ceil(perSlotChars * 2.2) + 80))
      });
      recordSideUsage('time-digest', res?.usage, { model: utilityModelOf(getConfig()) });
      const text = normalizeDigest(res?.message?.content, {
        maxChars: perSlotChars,
        maxLines: Number(dc.maxLines) || 5
      });
      if (!text) { this.#digestFailed(chatKey, dc, '模型没给出可用条目'); return; }
      this.digest.commit(chatKey, {
        key: slot.key,
        start: slot.start,
        end: slot.end,
        count: slot.count,
        senders: slot.senders,
        summary: text
      });
      this.digest.prune(chatKey, Number(dc.keepSlots) || 96);
    } catch (error) {
      this.#digestFailed(chatKey, dc, `调用失败 ${error?.message ?? error}`);
    } finally {
      this.digesting.delete(chatKey);
    }
  }

  #digestFailed(chatKey, dc, why) {
    const r = this.digest.bumpFail(chatKey, Number(dc.failThreshold) || DIGEST_DEFAULTS.failThreshold);
    if (r.justDisabled) {
      this.emit('log', { text: `[时段摘要] ${chatKey} 连续失败 ${r.failCount} 次，已停用（聊天不受影响）` });
    } else {
      console.warn(`[时段摘要] ${chatKey} 第 ${r.failCount} 次失败：${why}`);
    }
  }

  /** 会话自己的昵称（判"有没有叫它"要用，且必须与闸门侧同源）。 */
  selfNicknameOf(chatKey) {
    try {
      const p = resolvePersona(chatKey).persona;
      const kind = chatKindOf(chatKey);
      if (kind === 'group') return p.selfNickname || this.onebot?.selfNickname || p.botName || '';
      return p.botName || '';
    } catch {
      return '';
    }
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;


}

  // ── 日记循环（diary.js）──────────────────────────────────────────────────
  /**
   * 每半小时看一眼：过了 diary.hour 之后，给"昨天有聊天"的会话补一篇日记。
   * 为什么用轮询而不是精确定时：机器人可能整晚没开，轮询天然能把落下的那天补上；
   * 一天一篇，靠 hasEntry 幂等，重复触发也不会多写。
   */
  startDiaryLoop() {
    this.stopDiaryLoop();
    const tick = () => {
      this.#factsDecayTick();   // 跟着同一个轮询走（内部按 20 小时节流 = 每天一次）
      this.#diaryTick().catch((error) => console.error('[diary] 检查失败:', error?.message ?? error));
    };
    this.diaryTimer = setInterval(tick, 30 * 60 * 1000);
    if (this.diaryTimer.unref) this.diaryTimer.unref();
    const first = setTimeout(tick, 60 * 1000);   // 启动 1 分钟后先补一次（跨夜没关机的场景）
    if (first.unref) first.unref();
  }

  stopDiaryLoop() {
    clearInterval(this.diaryTimer);
    this.diaryTimer = null;
  }

  /** 立刻补写一次（不等定时器；手工排查/测试用，不改动定时器）。 */
  async runDiaryNow() {
    await this.#diaryTick();
  }

  // ── 长期事实的遗忘（memory-facts.js 的 decayFacts / forgetWeakFacts）────────
  /**
   * 每天跑一次：按天数给事实扣权重，再把低于阈值的淡出。
   *
   * 为什么必须接上（2026-10-26）：这两个函数写在 memory-facts.js 里很久了，
   * 但全仓没有任何调用点 —— 结果是"事实永不衰减"，一条三年前的旧事和昨天的事等权，
   * 60 条上限只能靠"超了丢最弱"硬顶（而那其实是另一套判据）。
   *
   * 三条纪律：
   *   ① 只在配置开关打开时跑；扣多少天由 updatedAt 决定，**增量记账**，不会重复扣（decayFacts 内部保证）。
   *   ② `kind='rule'|'negative'` 永久豁免（群规和雷点不能因为"很久没提"就忘掉）。
   *   ③ 失败只记日志，绝不影响聊天 —— 记忆维护是锦上添花。
   */
  #factsDecayTick() {
    try {
      const cfg = getConfig();
      if (cfg.memoryFacts?.enabled === false || cfg.memoryFacts?.decayEnabled === false) return;
      const now = Date.now();
      const gap = Math.max(60 * 60 * 1000, Number(cfg.memoryFacts?.decayIntervalMs) || 20 * 60 * 60 * 1000);
      if (now - (this.lastFactsDecayAt || 0) < gap) return;
      this.lastFactsDecayAt = now;
      // 召回台账跟遗忘衰减同节奏清理 —— 它每天几百行，几个月就到上限了
      trimRecallLedger();
      const rate = Number(cfg.memoryFacts?.decayRatePerDay ?? 0.02);
      const minWeight = Number(cfg.memoryFacts?.decayMinWeight ?? 0.3);
      // 先把盘上所有人都装进缓存：不然"衰减"只覆盖今天被 @ 过的那几个人
      loadAllFacts();
      const { changed } = decayFacts({ ratePerDay: rate, now });
      // 2026-10-29 起 forgetWeakFacts 是**休眠**不是删除（淡化≠删除）：低于线的打 dormant 位，
      // 退出召回但记录保留；显式遗忘（用户明说）走 forgetFact 的墓碑，那是另一个入口。
      const { dormant } = forgetWeakFacts({ minWeight });
      // 群级记忆同一套节奏（rule 类豁免：群规不该过期）
      let gChanged = 0;
      let gDormant = 0;
      if (cfg.groupFacts?.enabled !== false) {
        loadAllGroupFacts();
        gChanged = decayGroupFacts({ ratePerDay: Number(cfg.groupFacts?.decayRatePerDay ?? rate), now }).changed;
        gDormant = forgetWeakGroupFacts({ minWeight: Number(cfg.groupFacts?.decayMinWeight ?? minWeight) }).dormant;
      }
      if (changed || dormant || gChanged || gDormant) {
        const days = rate > 0 ? Math.round(1 / rate) : 0;
        this.emit('log', {
          text: `[长期记忆] 衰减 ${changed} 条、淡出休眠 ${dormant} 条（每天 -${rate}，约 ${days} 天掉 1.0，低于 ${minWeight} 转休眠、记录保留）`
            + (gChanged || gDormant ? `；群记忆衰减 ${gChanged} 条、休眠 ${gDormant} 条` : '')
        });
      }
    } catch (error) {
      console.error('[memory] 事实衰减失败:', error?.message ?? error);
    }
  }

  // ── 反思层（reflection.js，2026-10-26）──────────────────────────────────
  /**
   * 每 5 分钟看一眼：哪个会话攒了没处理的消息、且今天还没超出预算，就消化一批。
   *
   * 它和 `#maybeExtractFacts` 的分工：
   *   · 那个是"被叫到时顺手记一下当前说话的人"（实时、单点、免费）
   *   · 这个是"没人叫我也定期把整段对话过一遍"（异步、按人、花小钱）
   * 两条并存不冲突：游标保证同一批消息不会重复处理，重复事实也只是加权（rememberFact 去重）。
   */
  startReflectionLoop() {
    this.stopReflectionLoop();
    const interval = Math.max(60000, Number(getConfig().reflection?.intervalMs) || 300000);
    const tick = () => {
      this.#reflectionTick().catch((error) => console.error('[reflection] 出错:', error?.message ?? error));
    };
    this.reflectionTimer = setInterval(tick, interval);
    if (this.reflectionTimer.unref) this.reflectionTimer.unref();
    const first = setTimeout(tick, 90 * 1000);   // 启动 1.5 分钟后先跑一次，把关机期间的积压补上
    if (first.unref) first.unref();
  }

  stopReflectionLoop() {
    clearInterval(this.reflectionTimer);
    this.reflectionTimer = null;
  }

  /** 立刻反思一轮（手工排查/测试用，不动定时器）。 */
  async runReflectionNow() {
    await this.#reflectionTick();
  }

  async #reflectionTick() {
    const cfg = getConfig();
    const rc = cfg.reflection || {};
    if (rc.enabled === false) return;
    if (this.paused || this.aborted || this.reflecting) return;
    if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不反思（也就不会白烧钱）
    const allowGroups = new Set((cfg.allow?.groups || []).map(String));
    const allowPrivate = new Set((cfg.allow?.private || []).map(String));
    const anyAllow = allowGroups.size > 0 || allowPrivate.size > 0;
    const perTick = Math.max(1, Number(rc.maxChatsPerTick) || 2);
    this.reflecting = true;
    try {
      let done = 0;
      for (const chatKey of this.store.listChats()) {
        if (done >= perTick || this.aborted) break;
        const { id, kind } = parseChatKey(chatKey);
        // 只反思白名单里的会话：被移出白名单的群不该继续长记忆
        if (anyAllow) {
          const allowed = kind === 'group' ? allowGroups.has(id) : allowPrivate.has(id);
          if (!allowed) continue;
        }
        const cursor = this.reflection.get(chatKey);
        const messages = this.store.recent(chatKey, { limit: 400 });
        const pending = pickUnprocessed(messages, cursor.uptoId).length;
        if (!pending) continue;
        const meta = this.store.getChatMeta(chatKey);
        const idleMs = Math.max(0, Date.now() - (Number(meta?.lastTs) || 0));
        const gate = shouldReflect({ pending, idleMs, state: cursor, cfg: rc, now: Date.now() });
        if (!gate.go) continue;
        await this.#reflectChat(chatKey, messages, { cfg: rc, reason: gate.reason });
        done += 1;
      }
    } finally {
      this.reflecting = false;
    }
  }

  /**
   * 消化一个会话的一批消息。**按人分组、各自单独调一次模型**（防串人）。
   * @param {string} chatKey
   * @param {Array} messages 该会话最近的消息（含 self）
   * @param {{cfg:object, reason:string}} opts
   */
  async #reflectChat(chatKey, messages, { cfg = {}, reason = '' } = {}) {
    const cursor = this.reflection.get(chatKey);
    // 冷启动优先：把"谁还没有关系记忆"告诉 planRun，新面孔优先占名额。
    // 这里读的是本群可见的那条 —— 和注入时的可见性判据保持一致，否则会出现
    // "系统以为他有、注入时却看不到"的假覆盖。
    const plan = planRun({
      messages,
      uptoId: cursor.uptoId,
      cfg,
      hasRelation: (id) => listRelation(id, { chatKey }).length > 0
    });
    if (!plan.batch.length) return;
    // 没有值得提取的人（全是自己说的 / 每人不足 3 句）→ 直接推进游标。
    // 不推进的话，每 5 分钟会重新看一眼同一批消息，日志和 CPU 都白花。
    if (!plan.people.length) {
      this.reflection.commit(chatKey, { uptoId: plan.nextUptoId, counted: false });
      return;
    }
    let saved = 0;
    const names = [];
    const withRelation = cfg.relationPass !== false;
    for (const p of plan.people) {
      if (this.aborted) break;
      const prompt = buildExtractionPrompt({ name: p.name, who: p.id, lines: p.lines, relation: withRelation });
      let r = null;
      try {
        r = await chatCompletion({
          messages: [{ role: 'user', content: prompt }],
          model: utilityModelOf(getConfig()),
          temperature: 0,
          maxTokens: 300,
          thinking: 'off'
        });
      } catch (error) {
        console.error(`[reflection] ${chatKey} ${p.name || p.id} 提取失败:`, error?.message ?? error);
        continue;   // 这个人失败不影响别人，也不阻塞游标推进
      }
      recordSideUsage('reflection', r?.usage, { model: utilityModelOf(getConfig()) });
      const out = parseReflectionOutput(r?.message?.content, { name: p.name });
      for (const f of out.facts) {
        const res = rememberFact(p.id, f.text, { source: chatKey, scope: f.scope, kind: f.kind });
        if (res.ok && !res.duplicate) saved += 1;
      }
      // 关系记忆：覆盖式（每条 scope 只留一条），所以不计入 saved —— 它没让库变大
      if (out.relation) {
        const rr = rememberRelation(p.id, out.relation, { source: chatKey, scope: 'person' });
        if (rr.ok && !rr.unchanged) names.push(`${p.name || p.id}·关系`);
      }
      if (out.facts.length) names.push(`${p.name || p.id}×${out.facts.length}`);
    }

    // ── 群级提取（一次，独立于"按人"）──────────────────────────────────
    // 只问"这个群有什么稳定特征"，绝不问"这些人是谁"：群记忆是整个群看得见的位置，
    // 把某个人的私事写进去比不记严重得多（提示词与解析层各挡一次）。
    if (plan.batch.length && cfg.groupPass !== false && parseChatKey(chatKey).kind === 'group') {
      const minLines = Math.max(1, Number(cfg.groupPassMinLines) || 20);
      if (plan.batch.length < minLines) {
        // 批次太小 → 不总结（3 条消息总结出来的"群画像"全是噪声）
      } else if (!this.aborted) {
        let chatName = '';
        try { chatName = await this.#chatName(parseChatKey(chatKey).id); } catch { /* 拿不到名字不影响 */ }
        const lines = plan.batch
          .filter((m) => String(m?.text || '').trim())
          .map((m) => `${m.self ? '我' : String(m.senderName || '群友')}：${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}`);
        if (lines.length) {
          try {
            // 已记的条目当"别重复写"清单喂进去（只抑制重复、不要求重写，防漂移）。
            // 不吃错键：listGroupFacts 内部已按物理键归一。
            const known = listGroupFacts(chatKey, { limit: 12 }).map((f) => f.text);
            const gr = await chatCompletion({
              messages: [{ role: 'user', content: buildGroupPrompt({ chatName, lines, known }) }],
              model: utilityModelOf(getConfig()),
              temperature: 0,
              maxTokens: 300,
              thinking: 'off'
            });
            recordSideUsage('reflection-group', gr?.usage, { model: utilityModelOf(getConfig()) });
            const gf = parseGroupExtraction(gr?.message?.content);
            let added = 0;
            for (const g of gf) {
              const res = rememberGroupFact(chatKey, g.text, { kind: g.kind });
              if (res.ok && !res.duplicate) added += 1;
            }
            if (added) names.push(`群画像×${added}`);
          } catch (error) {
            console.error(`[reflection] ${chatKey} 群级提取失败:`, error?.message ?? error);
          }
        }
      }
    }
    // 无论这轮有没有记到东西都推进游标：同一条消息反复过模型是最贵的浪费
    // processed = 本轮真正喂进去的条数，用来算"今天还能反思几次"（聊得多才多给额度）
    const st = this.reflection.commit(chatKey, { uptoId: plan.nextUptoId, processed: plan.batch.length });
    if (saved || plan.jumped) {
      this.emit('log', {
        text: `[反思] ${chatKey} 消化 ${plan.batch.length} 条（${reason || '触发'}）`
          + `，新记 ${saved} 条${names.length ? `（${names.join('、')}）` : ''}`
          + (plan.jumped ? `，积压 ${plan.pending} 条只取最近一段` : '')
          + `，今日第 ${st.runs} 轮（累计 ${st.processed} 条）`
      });
    }
  }

  async #diaryTick() {
    const cfg = getConfig();
    const dc = cfg.diary || {};
    const qc = cfg.qzone || {};
    if (dc.enabled === false) return;
    if (this.paused || this.aborted || this.diaryTicking) return;
    if (!cfg.api?.model || !cfg.api?.baseUrl) return;
    const hour = new Date().getHours();
    if (hour < (Number(dc.hour) || 6)) return;   // 没到早上不写，免得写半截的一天
    const date = yesterdayKey();
    const cap = Math.max(1, Number(dc.maxPerDay) || 3);
    // 只给"现在还在白名单里"的会话写：被移出白名单的群不该继续产生日记
    const allowGroups = new Set((cfg.allow?.groups || []).map(String));
    const allowPrivate = new Set((cfg.allow?.private || []).map(String));
    const anyAllow = allowGroups.size > 0 || allowPrivate.size > 0;
    const isAllowed = (chatKey) => {
      const { id, kind } = parseChatKey(chatKey);
      if (!anyAllow) return true;                       // 空名单 = 不限（沿用 allowAllWhenEmpty 的语义）
      return kind === 'group' ? allowGroups.has(id) : allowPrivate.has(id);
    };
    // 要发空间才让模型多写一份脱敏版；不发就一个字都不多烧
    const wantPublic = qc.enabled !== false && qc.autoPublishDiary !== false && qc.publicSafe !== false;
    const written = [];
    this.diaryTicking = true;
    try {
      let wrote = 0;
      for (const chatKey of this.store.listChats()) {
        if (wrote >= cap || this.aborted) break;
        if (hasEntry(chatKey, date)) continue;
        if (!isAllowed(chatKey)) continue;
        const { id, kind } = parseChatKey(chatKey);
        const persona = resolvePersona(chatKey).persona;
        const chatName = kind === 'group' ? await this.#chatName(id) : '';
        const r = await writeDiaryFor(chatKey, {
          store: this.store, persona, chatName, kind, date,
          cfg: { ...dc, publicSafe: wantPublic },
          log: (m) => console.log(m), chatCompletion
        });
        if (r.ok) {
          wrote += 1;
          written.push({ chatKey, date, count: r.count });
        } else if (r.reason !== 'too-quiet' && r.reason !== 'exists') {
          console.log(`[diary] ${chatKey} ${date} 没写成：${r.reason}`);
        }
        await sleep(1500);   // 每篇之间歇一下，别把模型端点打满
      }
      // 日记先落盘、再发空间：模型或协议端哪一个挂了，原文都还在
      if (wantPublic && !this.aborted) {
        // 除了本次新写的，也带上「写过但没发出去」的那些（早上协议端没连上就会这样），
        // 否则那一天的日记永远不会自动发出去，只能手动补。
        const pending = [...written];
        for (const chatKey of this.store.listChats()) {
          if (!isAllowed(chatKey) || !hasEntry(chatKey, date)) continue;
          if (findQzonePost(chatKey, date)) continue;
          if (pending.some((x) => x.chatKey === chatKey)) continue;
          pending.push({ chatKey, date, count: 0 });
        }
        if (pending.length) {
          await this.#publishDiaries(pending, qc)
            .catch((e) => console.error('[qzone] 自动发布失败:', e?.message ?? e));
        }
      }
    } finally {
      this.diaryTicking = false;
    }
  }

  /**
   * 把刚写好的日记发到 QQ 空间（自动，受 qzone.maxPerDay 配额约束）。
   * 好几个群都有日记的早上，先按当天消息量挑最热闹的那个 —— 默认一天一条，
   * 别一早起来把她空间刷满。
   */
  async #publishDiaries(items, qc = {}) {
    // 失败冷却：接口用不了（老 NapCat / 空间没开通）时，别每半小时撞一次
    if (Date.now() < this.qzoneCooldownUntil) return;
    const quota = remainingQuota(qc, todayKey());
    if (quota <= 0) {
      console.log('[qzone] 今天的额度已经用完，日记不发空间');
      return;
    }
    const queue = items
      .filter((x) => x?.chatKey && !findQzonePost(x.chatKey, x.date))
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, Number.isFinite(quota) ? quota : 1);
    for (const item of queue) {
      if (this.paused || this.aborted) break;
      const r = await publishDiaryToQzone({
        onebot: this.onebot, chatKey: item.chatKey, date: item.date, cfg: qc,
        log: (m) => console.log(m)
      });
      if (!r.ok) {
        console.log(`[qzone] ${item.chatKey} ${item.date} 没发成：${r.reason}${r.error ? ' — ' + r.error : ''}`);
        if (r.reason !== 'already') {
          this.qzoneCooldownUntil = Date.now() + 6 * 3600 * 1000;   // 6 小时内不再自动重试
          break;
        }
      }
      await sleep(1200);
    }
  }

  /** 手动发一篇到空间（控制台/手机端点按钮、或补发某天）。不受每日配额限制。 */
  async publishDiaryNow({ chatKey, date, force = false } = {}) {
    const cfg = getConfig();
    return publishDiaryToQzone({
      onebot: this.onebot, chatKey, date: date || yesterdayKey(),
      cfg: cfg.qzone || {}, force: force === true,
      log: (m) => console.log(m)
    });
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  /** 今日估算成本是否已达到预算上限（budget.dailyCostYuan=0 时不限制）。 */
  overBudget() {
    const cap = Number(getConfig().budget?.dailyCostYuan) || 0;
    if (cap <= 0) return false;
    const usage = this.sessions.todayUsage(todayKey());
    return estimateCost(usage) >= cap;
  }

  /**
   * 出站许可复核（供 sender 每次发送前调用）。
   *
   * 为什么必须有这一格（学自 Estrella 主链路的 `lateSendReason`，2026-10-22 调研 P2-10）：
   *   入站时判过"这条该回"，但**从判定到真正发出之间可能夹着一次完整的模型生成**
   *   （几秒到几十秒，主动发言更长）。这段时间里用户完全可能：
   *     · 在面板里把这个群移出白名单；
   *     · 按下暂停；
   *     · 当日花费刚好触顶。
   *   不重判的话，拿的还是"当初放行过"的结论 —— 表现就是"我都删了它还在说话"，
   *   这是最容易让用户不再信任这一类 bug：它违反了"我说了算"。
   *
   * 判据顺序按"最容易先变且最严重"排：暂停 → 预算 → 白名单。
   * 全部读**现值**（每次 `getConfig()`），不读入站时缓存的那份。
   *
   * @returns {{vetoed?: {reason: string, kind: string}} | void}
   */
  gateBeforeSend(chatKey) {
    if (getConfig().send?.recheckBeforeSend === false) return undefined;
    if (this.paused) {
      return { vetoed: { kind: 'paused', reason: `当前已暂停（${this.pauseReason || 'manual'}）` } };
    }
    if (this.overBudget()) {
      return { vetoed: { kind: 'budget', reason: '今日花费已达上限，这条没有发出去' } };
    }
    const cfg = getConfig();
    try {
      const { kind, id } = parseChatKey(String(chatKey));
      if (!allowed(kind, id, cfg)) {
        return { vetoed: { kind: 'whitelist', reason: `${denyReason(kind, id, cfg)}（发送前复核：白名单已经不含这个会话）` } };
      }
    } catch (error) {
      // 判据自己出错 → 放行。理由：这一格是兜底，它的 bug 不该让整台机器人变哑；
      // 而且白名单在入站时已经判过一次，这里出错并不引入新的放行面。
      console.warn(`[gate] 发送前复核出错（已放行）：${error?.message ?? error}`);
    }
    return undefined;
  }

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    this.stopProactiveLoop();
  }

  /** DSH 任务完成 watcher：轮询 pendingDshTasks，完成后主动向主人汇报。 */
  startDshWatcher() {
    if (this.dshWatcherTimer) return;
    const tick = async () => {
      try {
        const { pendingDshTasks, pollDshTask, markTaskCompleted, cleanupExpiredProducts, unregisterDshTask, markDshReported, savePendingTasks } = await import('./dsh-task.js');
        for (const [sessionId, entry] of [...pendingDshTasks]) {
          if (entry.reported) { pendingDshTasks.delete(sessionId); continue; }
          // 放宽单次窗口：避免 DSH 刚建目录、会话还没 running 起来就被判"完成"
          const res = await pollDshTask(sessionId, entry.workDir, { timeoutMs: 20000, intervalMs: 5000 });
          const chatKey = String(entry.chatKey || '');
          // 认不出形状的 chatKey 一律不汇报（保守）：宁可少报一条，也别发给错地方
          const canReport = chatKindOf(chatKey) !== '';

          // ── 未完成：只按 DSH 的**真实状态**处理，绝不靠"超时"猜失败 ──
          if (!res.done) {
            // res.state: running | idle | missing | unreachable | finished
            // 只要 DSH 说还在跑，就安静等待（这是正常状态，不累计失败）
            if (res.state === 'running') continue;

            // 查询失败（DSH 忙/超时）：同样不做失败推断，下轮再看
            if (res.state === 'unreachable') continue;

            // 只有「会话不存在」或「长期未开跑」才是真异常，且给出充分的等待时间
            const cur = pendingDshTasks.get(sessionId) || entry;
            if (cur.failedReported) continue;                  // 已报过就永不再报
            const ageMs = Date.now() - (cur.submittedAt || Date.now());
            const longEnough = ageMs > 5 * 60 * 1000;          // 给足 5 分钟
            if (!longEnough || !canReport) continue;

            cur.failedReported = true;
            cur.reported = true;
            pendingDshTasks.set(sessionId, cur);
            savePendingTasks();
            try {
              const why = res.state === 'missing'
                ? 'DSH 侧找不到这个任务会话'
                : '任务提交后一直没有开始执行';
              await this.sender.sendTextBatch(chatKey, [
                '⚠️ 刚才那个 DSH 任务好像没跑起来：' + why + '。',
                '要不要本鲸重新提交一次？'
              ], {});
              this.emit('log', { text: '[DSH任务] 已汇报异常(仅此一次): ' + cur.workDir });
            } catch (e) {
              this.emit('log', { text: '[DSH任务] 异常汇报失败: ' + (e?.message || e) });
            }
            continue;
          }

          // ── 判定完成：先落盘标记（幂等且重启不丢），再唤起白鲸本人汇报 ──
          markDshReported(sessionId);
          if (!canReport) { unregisterDshTask(sessionId); continue; }
          try {
            const files = res.files || [];
            const real = files.filter((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));
            const normFiles = real.map((f) => ({ name: f.name, size: f.size || 0, dir: !!f.dir }));
            // 找 DSH 写好的"回给主人"稿件（约定文件名含「回给主人」）
            let reportFile = '', reportText = '';
            try {
              const fsmod = await import('node:fs');
              const pathmod = await import('node:path');
              const cand = real.find((f) => !f.dir && /回给主人|汇报|report|summary/i.test(f.name) && /\.(txt|md)$/i.test(f.name));
              if (cand) {
                reportFile = cand.name;
                reportText = fsmod.readFileSync(pathmod.join(entry.workDir, cand.name), 'utf8').slice(0, 2500);
              }
            } catch { /* 读不到就算了 */ }

            // 唤起白鲸本人：把任务回执注入上下文，让它用自己的话精简汇报
            this.emit('log', { text: '[DSH任务] 完成，唤起白鲸汇报: ' + entry.workDir + ' 依据=' + (res.reason || '') });
            // 注意：这里 await——汇报成功后才把条目从待汇报表移除，
            // 若汇报失败则保留条目，下一轮 tick 会重试（避免"跑完了但没人说"）。
            await this.wake(chatKey, {
              proactive: true,
              taskContext: {
                kind: 'DSH 后台任务',
                name: entry.taskName || '',
                taskText: entry.taskText || '',
                workDir: entry.workDir,
                files: normFiles,
                empty: !real.length,
                reportFile,
                reportText
              }
            });
            unregisterDshTask(sessionId);
            if (real.length) markTaskCompleted(entry.workDir);
          } catch (e) {
            this.emit('log', { text: '[DSH任务] 汇报失败（下轮重试）: ' + (e?.message || e) });
          }
        }
      } catch (e) {
        this.emit('log', { text: '[DSH watcher] ' + (e?.message || e) });
      }
      // 产物时效：清理超过 1 小时的已完成任务目录
      try {
        // ★ 必须在这里重新 import：上面那次解构发生在 for 块的 try 里，
        //   出了那个块就出了作用域，直接调用会报 `cleanupExpiredProducts is not defined`
        //   （每 10 秒一条错误日志，功能等于没跑）。
        const { cleanupExpiredProducts } = await import('./dsh-task.js');
        const removed = cleanupExpiredProducts();
        if (removed.length) this.emit('log', { text: '[DSH产物清理] 已删除过期产物: ' + removed.join(', ') });
      } catch (e) {
        this.emit('log', { text: '[DSH产物清理] ' + (e?.message || e) });
      }
    };
    this.dshWatcherTimer = setInterval(tick, 10000);
    if (this.dshWatcherTimer.unref) this.dshWatcherTimer.unref();
  }

  stopDshWatcher() {
    if (this.dshWatcherTimer) { clearInterval(this.dshWatcherTimer); this.dshWatcherTimer = null; }
  }

  /**
   * 已加载扩展包声明的 prompt.sections（清单里写的"边界提醒"）。
   *
   * 排序：先按各段自己的 order，再按插件 id —— 两者都要，否则同一 order
   * 的段落顺序会随 Map 迭代顺序变，提示词每轮都可能不一样（缓存全失效）。
   * 未加载/加载失败的插件不参与：它连代码都没跑，说的话不该进提示词。
   */
  promptSections() {
    const items = this.extHost?.snapshot?.().items || [];
    const out = [];
    for (const it of items) {
      if (it.state !== 'loaded') continue;
      for (const s of it.promptSections || []) {
        if (s && String(s.body || '').trim()) out.push({ ...s, owner: it.id });
      }
    }
    return sortPromptSections(out);
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      overBudget: this.overBudget(),
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      complexModel: cfg.api.complexModel || '',
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const source = String(text || '');
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(source)) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }

  // DeepSeek 偶发把原生工具调用降级成 DSML 文本。兼容它的 calls / invoke / parameter 标签。
  const dsmlRe = /<[\uFF5C|]{2}\s*DSML\s*[\uFF5C|]{2}\s*calls\s*>([\s\S]*?)(?:<\/[\uFF5C|]{2}\s*DSML\s*[\uFF5C|]{2}\s*calls\s*>|$)/gi;
  while ((match = dsmlRe.exec(source)) !== null) {
    const invokeRe = /<[\uFF5C|]{2}\s*DSML\s*[\uFF5C|]{2}\s*invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/[\uFF5C|]{2}\s*DSML\s*[\uFF5C|]{2}\s*invoke\s*>|$)/gi;
    let invoke;
    while ((invoke = invokeRe.exec(match[1])) !== null) {
      const name = invoke[1].trim();
      if (!name) continue;
      const args = {};
      const paramRe = /<[\uFF5C|]{2}\s*DSML\s*[\uFF5C|]{2}\s*parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[\uFF5C|]{2}\s*DSML\s*[\uFF5C|]{2}\s*parameter\s*>/gi;
      let param;
      while ((param = paramRe.exec(invoke[2])) !== null) {
        let value = param[2].trim();
        try { value = JSON.parse(value); } catch { /* keep raw text */ }
        args[param[1].trim()] = value;
      }
      out.push({ name, args });
    }
  }
  return out;
}

export function containsInlineToolSyntax(text) {
  return /<tool_call\b|<\/?function_calls\b|<\/?invoke\b|<\/?parameter\b|<[\uFF5C|]{2}\s*DSML\b/i.test(String(text || ''));
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 这个错误是不是"上下文太长"。
 *
 * 判据必须用**正文关键词**，不能只看状态码：400 同样用于参数错误、工具 schema 不合法，
 * 对那类错误做"砍历史重试"只是白等一轮还多花一份钱。
 * 各家措辞不同（DeepSeek `maximum context length`、OpenAI `context_length_exceeded`、
 * 百炼 `Input length must be less than...`、硅基 `too many tokens`），所以是宽匹配。
 *
 * 正则**只定义在 `error-reply.js` 一处**，这里 import 复用 —— 两处各写一份就会漂，
 * 2026-10-29 实锤：百炼那句 `Input length must be less than 8192` 只在 error-reply
 * 那边被认出来，于是同一句报错"上面裁历史重试、下面当成参数错误去报"。
 */
export function isContextOverflowError(message) {
  const m = String(message ?? '');
  if (!/HTTP (400|413|422)\b/.test(m)) return false;
  return CONTEXT_RE.test(m);
}
