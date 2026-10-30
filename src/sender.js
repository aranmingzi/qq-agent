// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import fs from 'node:fs';
import { getConfig } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { despace } from './space-split.js';
import { firstSendDelayMs, sendGapMs } from './rhythm.js';
import { scanEgress } from './egress.js';
import { recordSkip, SKIP_STAGES } from './skip-log.js';
import { asPlatform } from './platform.js';
import { classifySendFailure } from './send-ledger.js';
import { isBanned, noteBan, clearBan, looksLikeMute } from './ban-state.js';
import { resolveMinuteLimit, assessQuota, quotaFrom } from './send-quota.js';
import { STICKER_SCOPE_SUFFIX } from './sticker-quota.js';

export class SendQueue {
  /**
   * @param {object} opts
   * @param {object} [opts.platform] 平台薄接口（默认由 onebot 包一层，见 platform.js）
   * @param {object} [opts.ledger]   发送台账（结果不确定时落账，见 send-ledger.js）
   * @param {Function} [opts.beforeMedia] 出站媒体否决点：({chatKey,kind,source,label}) =>
   *   Promise<{vetoed?:{reason,owner}}|void>。由 orchestrator 接到 hook-bus 的 before-media。
   */
  constructor({ onebot, store, onSent = null, beforeMedia = null, platform = null, ledger = null, beforeSend = null }) {
    this.onebot = onebot;
    // 所有发送都走 platform：换协议端时只改这一层的实现，不用动每个调用点
    this.platform = platform || (onebot ? asPlatform(onebot) : null);
    this.store = store;
    this.ledger = ledger || null;
    this.onSent = onSent;
    this.beforeMedia = typeof beforeMedia === 'function' ? beforeMedia : null;
    /** 出站许可复核：({chatKey}) => {vetoed?:{reason}} | void。见 #gateBeforeSend。 */
    this.beforeSend = typeof beforeSend === 'function' ? beforeSend : null;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.paceRuns = new Map();    // chatKey -> { tier, startedAt, used, traceId }
  }

  /**
   * 出站许可复核：**每一次发送前重判一次现值**，不依赖入站时的判断。
   *
   * 为什么必须有（学自 Estrella 主链路的 `lateSendReason`，2026-10-22 调研 P2-10）：
   *   "要不要说话"是入站时判的，而"能不能发到这个会话"是**会变的** ——
   *   用户把群移出白名单、按了暂停、当日花费熔断，而正在进行的那一轮
   *   （尤其主动发言，中间夹着一次完整的模型生成，几秒到几十秒）
   *   会拿着"当初放行过"的结论照样发出去。表现就是"我都删了它还在说话"。
   *
   * 与 `beforeMedia` 的区别（不要合并）：
   *   · `beforeMedia` 是**别人**（扩展包）对内容的否决，走钩子总线；
   *   · 本方法是**宿主**对许可的自检，属于安全兜底，所以不走钩子、不能被插件覆盖。
   * 两者都排在 `#checkRate` 之前 —— 被拦下的消息不该占限额（否则被拦几次就哑了）。
   */
  #gateBeforeSend(chatKey) {
    const fn = this.beforeSend;
    if (typeof fn !== 'function') return;
    let r;
    try {
      r = fn({ chatKey: String(chatKey) });
    } catch (error) {
      // 复核本身出错 → 放行（fail-open）。理由与 before-media 一致：
      // 兜底机制自身的 bug 不该把整台机器人变成哑巴；出问题的是复核代码，不是这次发送。
      console.warn(`[sender] 发送前复核出错（已放行）：${error?.message ?? error}`);
      return;
    }
    if (r?.vetoed) {
      // 拦截必留痕：只抛错的话，控制台里看到的会是"它没说话"，
      // 而不是"我把它删了之后它还想说，被拦住了"——后者才是真相。
      try {
        recordSkip({
          stage: SKIP_STAGES.SEND_GATE,
          chatKey: String(chatKey),
          reason: r.vetoed.reason || '当前不允许向这个会话发送',
          detail: { kind: String(r.vetoed.kind || 'vetoed') }
        });
      } catch { /* 记账失败不能反过来阻止这次拦截 */ }
      throw new Error(`这条没有发出去：${r.vetoed.reason || '当前不允许向这个会话发送'}`);
    }
  }

  /**
   * 发送失败时区分"确定失败"与"结果不确定"（2026-10-22 生态调研 P0-1）。
   * 不确定 = 可能已经发出去了：**不重试**，落账，并把话说清楚让模型别再原样发。
   */
  async #attempt(chatKey, text, kind, fn) {
    try {
      const data = await fn();
      if (kind === 'text' && this.ledger) this.ledger.resolveByFingerprint(chatKey, text, 'sent');
      // 发成功了 → 之前的禁言判断是误判，撤掉（否则它会白闭嘴十分钟）。
      // 只有真的记过才动盘，正常发送不产生任何 IO。
      try {
        if (isBanned(chatKey)) clearBan(chatKey);
      } catch { /* 状态清理失败不影响发送 */ }
      return data;
    } catch (error) {
      // 被禁言：记下来，让这个群在一段时间内直接跳过（不再拼提示词、不再调模型）。
      // 不记的话表现是"群里什么都没发生"，但每来一条消息都白跑一整轮。
      try {
        if (looksLikeMute(error?.message)) {
          noteBan(chatKey, { reason: `发送被拒绝：${String(error?.message ?? error).slice(0, 80)}` });
        }
      } catch { /* 记账失败不影响报错 */ }
      if (classifySendFailure(error) !== 'unknown') {
        // 确定失败也要留痕：只靠调用方 emit('log') 的话，
        // 面板统计里"它说了没"和"它想说但没发出去"是同一格，查不出协议端在退化。
        // 刻意**不记原文**（很长、且可能含凭据），只记性质与长度。
        try {
          recordSkip({
            stage: SKIP_STAGES.SEND_FAIL,
            chatKey: String(chatKey),
            reason: `发送失败（${kind}）：${String(error?.message ?? error).slice(0, 200)}`,
            detail: { kind, chars: String(text || '').length, code: String(error?.code || '') || undefined }
          });
        } catch { /* 记账失败不能影响这次报错 */ }
        throw error;
      }
      const item = this.ledger?.recordUnknown({
        chatKey, text, kind,
        error: String(error?.message ?? error),
      });
      const e = new Error(
        `发送结果不确定（${String(error?.message ?? error)}）：这条**可能已经发出去了**，不要原样重发。`
        + (item ? '已经记进待确认列表。' : '')
      );
      e.code = 'ESEND_UNKNOWN';
      e.unknown = true;
      throw e;
    }
  }

  /**
   * 出站媒体统一过否决点（图 / 文件 / 语音 / 表情）。
   *
   * 三点纪律：
   *  ① **在真发之前调**，不是发完记录。发出去就是发出去了。
   *  ② 钩子自己出错 → 放行（fail-open）。拦截系统不能因为自身 bug 变成"什么都不发"。
   *  ③ 传给钩子的 source 必须裁剪：base64 语音动辄几百 KB，
   *     整段塞进钩子载荷会拖慢每一条发送，也没人需要读它。
   */
  async #checkMedia(chatKey, kind, source, label) {
    const fn = this.beforeMedia;
    if (typeof fn !== 'function') return;
    const s = String(source ?? '');
    const shortSource = /^base64:\/\//i.test(s)
      ? `base64://(${s.length} 字符)`
      : (s.length > 300 ? `${s.slice(0, 300)}…` : s);
    let r;
    try {
      r = await fn({ chatKey, kind, source: shortSource, label: String(label || '') });
    } catch (error) {
      console.warn(`[sender] before-media 钩子出错（已放行）：${error?.message ?? error}`);
      return;
    }
    if (r?.vetoed) {
      const who = r.vetoed.owner ? `（扩展包「${r.vetoed.owner}」）` : '';
      throw new Error(`这次的${label || '媒体'}没有发出去：${r.vetoed.reason}${who}`);
    }
  }

  /**
   * 开始一轮运行：记下"这一轮从什么时候开始、是什么档位"。
   * 首条消息的延迟 = 目标总时长 − 已经花掉的时间（模型生成耗时），
   * 所以不会出现"模型慢 2 秒 + 再硬等 1.2 秒"。
   */
  beginRun(chatKey, { tier = 'direct', startedAt = Date.now(), traceId = '' } = {}) {
    // traceId 一并存下来：出站被拦时要用**这一轮的**把手记账，
    // 否则"面板上那条被拦的消息"和跳过记录对不上。
    this.paceRuns.set(String(chatKey), { tier, startedAt, used: false, traceId });
  }

  endRun(chatKey) {
    this.paceRuns.delete(String(chatKey));
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  /**
   * 频率闸门。
   *
   * ⚠️ 这里以前是「超限就 throw」，实测代价非常大：模型拿到"请等一会再发"以后
   * 会**再调一次 send_message**，而每多一次工具往返就是把整份 system+user
   * （约 17K tokens）重发一遍。历史数据里 550 次 send_message 有 140 次是
   * 限流失败，其中 36 次是连续两次都超限 —— 光这一项就吃了当天约 7% 的 token。
   *
   * 2026-10-25 第二次踩（私聊「走神」）：maxPerMinute=4，上一轮刚发 3 条，
   * 主人接着说「明天开始哦」，这一轮要发的 2 条**整批被拒**。模型第二轮拿到
   * 「不要再重试」的错误，它并不知道"其实一条都没送到"，于是自己编了句
   * 「在的在的，刚刚走神了，主人你说啥？」发给主人 —— 用户看到的就是"走神"。
   * 复盘：被拒的时间点离额度滑出只差 7 秒。
   *
   * 所以现在分三档（`final` = 这条发不出去就等于"这一轮没回话"）：
   *   ① final 且差一点到的 → **等**（最多 send.rateWaitFirstMs，默认 12s）。
   *      用户多等几秒远好过收一句"我走神了你说啥"；
   *   ② 非 final（分条的第 2、3 条 / 图片 / 表情）超限 → 返回 {skipped}，
   *      **安静省略**：这一轮已经说过话了，不该为"少说一条"再跑一轮模型；
   *   ③ final 也等不到额度的，才 throw —— 文案里直接点名禁止"走神了/你说啥"
   *      这种补救话术，因为那正是上一次事故的产物。
   *
   * ⚠️ 2026-10-25 第三次踩 —— **谁算 final 判错了**（比限流本身更隐蔽）：
   *    群聊里"答应却不做"的根因就在这。群友说「帮我写篇 800 字作文」，她一次
   *    send_message 传 `[「行，那我真写了啊」, <800 字正文>]`。以前只有 i=0 走 final：
   *    引子正常发出，**正文 0.1 秒后被 ② 静默省掉**，工具返回还告诉她"不用补说"。
   *    于是她既答应了、也确实发了消息，正文却一个字都没出现 —— 而且她以为已经发过了，
   *    下一条有人聊别的她就跟着走了。用户看到的就是"莫名答应，结果不做"。
   *    所以 final 的判定在调用侧改成「这一批里最长的那条 + 所有 ≥60 字的文本」，
   *    见 `sendTextBatch` 的 `isCritical`。纯闲聊的补充句仍走 ②，别把它改回去。
   *
   * 注意：被拦下的不计额度（push 在检查之后），否则拦几次就真哑了。
   * 私聊有独立额度 `send.maxPerMinutePrivate`：一对一对话里用户连发、她分条回，
   * 和群里"别刷屏"不是一回事。未配置 = 沿用 maxPerMinute；配 0 = 私聊不限速。
   */
  /**
   * 这个会话每分钟允许发几条（0 = 不限）。
   *
   * ⚠️ 取值规则现在**只剩一份**：`src/send-quota.js` 的 `resolveMinuteLimit`。
   * 这里、`#checkRate`、`sendTextBatch` 的额度预检、以及 orchestrator 的前置判定
   * 全都走它 —— 以前这四处各写一遍，改配置时必有一边不同步（同类事故：降级链的
   * MAX_CHAIN 与 orchestrator 的 slice 上限没对齐，第 8 条端点永不尝试且零报错）。
   */
  #minuteLimit(chatKey) {
    return resolveMinuteLimit(chatKey, getConfig().send || {});
  }

  /**
   * 当前还剩几条额度（只读，不占名额）。给 orchestrator 的**前置**判定用：
   * 额度已经满了就别去花一整轮模型调用（见 src/send-quota.js 顶部的实测数字）。
   *
   * 走的就是 `#checkRate` 那两个桶（文本桶），所以"预判"和"真发"永远同一个数。
   *
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @returns {{limit:number, used:number, remaining:number, resetInMs:number, unlimited:boolean, window:'minute'|'hour'|null}}
   */
  quotaFor(chatKey, { now = Date.now() } = {}) {
    const key = String(chatKey);
    return assessQuota({
      chatKey: key,
      sendCfg: getConfig().send || {},
      minuteTimes: this.minuteTimes.get(key) || [],
      hourTimes: this.hourTimes.get(key) || [],
      now
    });
  }

  /**
   * 表情桶的剩余额度（只读，不占名额）。与 `quotaFor` 并列，走的是
   * `#checkRate` 里那个 `|sticker` 后缀的**独立桶**（表情不占文本名额）。
   *
   * 为什么需要：表情的分钟上限缺省只有 1，比文本紧得多。实测 31 次表情失败里
   * 14 次是"这一分钟发得太多了" —— 模型在调用前完全不知道这个桶已经满了。
   *
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @returns {{limit:number, used:number, remaining:number, resetInMs:number, unlimited:boolean}}
   */
  stickerQuotaFor(chatKey, { now = Date.now() } = {}) {
    const key = String(chatKey) + STICKER_SCOPE_SUFFIX;
    return quotaFrom({
      times: this.minuteTimes.get(key) || [],
      limit: this.#stickerMinuteLimit(),
      windowMs: 60 * 1000,
      now
    });
  }

  /**
   * 撞上限的报错文案（final 那条才用得到）。
   *
   * ⚠️ 结尾**必须留一个出口**：2026-10-25 群聊实录里，她写完 800 字作文的第二段
   * 撞上限，拿到"本轮到此为止"就彻底闭嘴了 —— 对方等的是作文，只等到一句
   * 「这题我知道」，然后她再没提过。所以这里允许她**发一句收尾告知**
   * （"剩下的等会儿补给你"），但明确禁止马上重发正文（那会再撞一次上限，
   * 还会多烧一整轮 17K tokens）。
   */
  #rateBlockedMessage(limit, unit) {
    const label = unit === '小时' ? '小时' : '分钟';
    return `这一${label}发到上限（${limit} 条）了，**这条没有发出去**，别当成已经发过了。`
      + `不要用"我走神了/你说啥/没听清"糊过去，也别马上换个说法重发。`
      + `如果有没说完的实质内容（写到一半的长文、没给完的证明），`
      + `可以发一句短的告知对方"剩下的等会儿补给你"，但本轮不要再发正文了。`;
  }

  /**
   * 表情的每分钟额度：**独立**于文本，缺省 1 张/分钟。
   *
   * 为什么必须分开：send.maxPerMinute（群聊 4）是"别刷屏"的纪律，而表情常常是她
   * 这一轮唯一的表达。实测 1000 份会话里 14 次表情死在「这一分钟发得太多了」——
   * 额度全被**前几轮**的文字吃光（同轮 send_message 成功只有 0~1 条）。
   * 文字既然已经说过话，多出来的第 5 个气泡是一张表情，不算刷屏。
   * 缺省 1；显式 0 = 不限（与本文件其余 0 的语义一致）。
   */
  #stickerMinuteLimit() {
    const raw = (getConfig().sticker || {}).maxPerMinute;
    if (raw === undefined || raw === null) return 1;
    return Number(raw) || 0;
  }

  async #checkRate(chatKey, { final = false, scope = 'text' } = {}) {
    const cfg = getConfig().send || {};
    const isSticker = String(scope) === 'sticker';
    // 两套桶（key 加后缀）：表情不消耗文本名额，文本也不会把表情的额度提前用掉。
    const key = isSticker ? `${chatKey}|sticker` : String(chatKey);
    const maxMin = isSticker ? this.#stickerMinuteLimit() : this.#minuteLimit(chatKey);
    // 表情的小时上限沿用 send.maxPerHour，但记在**自己的桶**里：
    // 总小时条数因此最多"文本上限 + 表情上限"，而 maxPerHour 缺省是 0（不限）。
    const maxHour = Number(cfg.maxPerHour) || 0;
    if (maxMin <= 0 && maxHour <= 0) return null;   // 0/缺省 = 不限速
    const maxWait = Math.max(0, Number(final ? (cfg.rateWaitFirstMs ?? 12000) : (cfg.rateWaitMs ?? 2500)));
    const deadline = Date.now() + maxWait;
    for (;;) {
      const now = Date.now();
      const minute = (this.minuteTimes.get(key) || []).filter((t) => now - t < 60000);
      const hour = (this.hourTimes.get(key) || []).filter((t) => now - t < 3600000);
      this.minuteTimes.set(key, minute);
      this.hourTimes.set(key, hour);
      if (maxHour > 0 && hour.length >= maxHour) {
        if (!final) return { skipped: 'hour' };
        throw new Error(this.#rateBlockedMessage(maxHour, '小时'));
      }
      if (maxMin > 0 && minute.length >= maxMin) {
        // 最早那条还要多久才滑出 60s 窗口
        const waitMs = minute[0] + 60000 - now + 80;
        if (now + waitMs > deadline) {
          if (!final) return { skipped: 'minute' };
          throw new Error(this.#rateBlockedMessage(maxMin, '分钟'));
        }
        await sleep(waitMs);
        continue;
      }
      minute.push(now);
      hour.push(now);
      this.minuteTimes.set(key, minute);
      this.hourTimes.set(key, hour);
      return null;
    }
  }

  /**
   * 条间间隔（rhythm.js 是唯一实现；以前这里的公式只在本文件里一份）。
   * 首条不走这里 —— 它走 beginRun 记下的"总延迟预算"，见 #firstDelay。
   */
  #gap(text, isLast) {
    if (isLast) return 0;
    return sendGapMs(text, getConfig().send);
  }

  /** 首条消息还要等多久（每轮只算一次；算完就作废）。 */
  #firstDelay(chatKey, text = '') {
    const ctx = this.paceRuns.get(String(chatKey));
    if (!ctx || ctx.used) return 0;
    ctx.used = true;
    if (getConfig().send?.pace?.enabled === false) return 0;
    // text 传进去是为了"按字数附加一点读的时间"（有硬上限，见 waiting.typingExtraMs）
    return firstSendDelayMs(ctx.tier, Date.now() - ctx.startedAt, undefined, { text });
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const cfgSend = getConfig().send || {};
    const parts = [];
    // 每个 part 对应的"她原本写的"文本（只在被空格分句纠正过时才有值）。
    // 为什么要留着：看板要能分清「她原本写的」和「用户实际看到的」——
    // 闸门兜底以后，`space-split` 一定降到很低，但那不代表提示词那条规则有用。
    const rawOf = [];
    // 出口凭据闸门（egress.js）：**发出去就收不回**，所以放在清洗之后、进队列之前。
    // 刻意放在 #checkRate 之前 —— 被拦下的消息不该占限额（否则模型被拦几次就哑了）。
    const blocked = [];
    const runTrace = this.paceRuns.get(String(chatKey))?.traceId || '';
    for (const m of list) {
      let plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 统一清洗模型偶尔夹带的 XML 工具调用残留（</parameter></invoke></tool_calls> 等）
      plain = plain
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/<\/?parameter>|<\/?invoke>|<\/?tool_calls>|<\/?function_calls>|<\/?search_attempts>/gi, '')
        .replace(/^\s*<\/?[a-zA-Z]+/gm, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!plain) continue;
      // 出口闸门：命中凭据（形态或本次生效的密钥原值）→ 这一条整条不发。
      // 不"清洗后照发"：掩码会把一句话变成乱码，而模型会以为发成功了。
      const scan = scanEgress(plain);
      if (scan.blocked) {
        blocked.push({ rules: scan.ruleIds, chars: plain.length });
        console.warn(`[egress] 拦下一条出站消息（${scan.ruleIds.join('/') || '规则出错'}，${plain.length} 字符），原文不落日志`);
        // 记账（不带原文）：被拦 = "这一轮它其实想说话，但内容不能出门"，
        // 与"它决定不说"是两种完全不同的原因，必须在跳过记录里分开。
        recordSkip({
          stage: SKIP_STAGES.EGRESS,
          chatKey,
          traceId: runTrace,
          reason: '要发的内容里有密钥/登录态，整条拦下没发',
          detail: { rules: scan.ruleIds, chars: plain.length }
        });
        continue;
      }
      // 空格分句纠正（space-split.js）：放在凭据闸门**之后** ——
      // 被拦下的那条不加工（没有意义，也不该在日志里留下加工痕迹）。
      // 放在硬切分**之前**：先定标点再切，切出来的两半各自都是完整短句。
      const trimmed = plain;
      if (cfgSend.despaceSplit !== false) {
        const fixed = despace(trimmed, { minChars: cfgSend.despaceMinChars, maxChars: cfgSend.despaceMaxChars });
        if (fixed.changed) {
          plain = fixed.text;
          console.info(`[despace] 纠正 ${fixed.fixed} 处空格分句（${trimmed.length}→${plain.length} 字，原文不落日志）`);
        }
      }
      const rawText = plain === trimmed ? null : trimmed;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) {
        const chunks = splitForQQ(plain, hardSplitAt);
        for (const c of chunks) { parts.push(c); rawOf.push(chunks.length === 1 ? rawText : null); }
      } else {
        parts.push(plain);
        rawOf.push(rawText);
      }
    }
    if (!parts.length && blocked.length) {
      // 说清"为什么没发"，但**不带原文**（带了等于换个渠道泄露一次）
      throw new Error(`这条消息没有发出去：里面含有不该发出去的密钥/登录态（${blocked[0].rules.join('、') || '出口规则异常'}）。换个说法重说，不要复述密钥。`);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    // 这一批里"必须送到"的那条：**正文通常是最长的，不是第一条**。
    //
    // ⚠️ 2026-10-25 第三次踩（群聊"答应了却不做"的正身）：
    //    群友说「帮我写篇 800 字作文」，她一次 send_message 传了两条 ——
    //    「行，那我真写了啊」+ 800 字正文。只有 i=0 走 final，引子正常发出；
    //    正文 0.1 秒后被限流**静默丢弃**，而工具返回还对她说"另一条按节奏省了，不用补说"。
    //    于是她既"答应了"又"确实发了消息"，作文却一个字都没出现，
    //    下一轮有人聊别的，她还以为作文早就发出去了 —— 用户看到的就是"答应完不做"。
    //    判据改成"这一批里最重的一条"；同时长文本永远不许静默丢（见 isCritical）。
    const LONG_TEXT_ALWAYS_SEND = 60;
    let criticalIdx = 0;
    for (let i = 1; i < parts.length; i++) {
      // 严格大于：长度相同时保留靠前的那条。
      // 用 >= 会让「一/二/三」这种等长批次把 critical 判到最后一条，
      // 于是第一条反而成了可省略的 —— 等于把 2026-10-25 之前的
      // "首条必须送达"语义整个掀翻，分条场景会开始丢开头那句。
      if (parts[i].length > parts[criticalIdx].length) criticalIdx = i;
    }
    // 额度预检：**正文优先占名额**。
    //
    // 光把长文划成 critical 还不够：额度只剩 1 条、批次是 [「行，那我真写了啊」, 正文] 时，
    // 引子会先按顺序吃掉那唯一的名额，正文照样只能报错 —— 用户看到的还是"答应了不做"。
    // 所以额度确实不够时，按长度从长到短保前 quota 条，剩下的短句直接让位。
    // 只在批里有实质内容（≥60 字）时才干预；全是闲聊就保持原顺序，别打乱正常对话的语义。
    const forcedDrop = new Set();
    const maxMin = this.#minuteLimit(chatKey);
    if (maxMin > 0 && parts.length > 1) {
      const now = Date.now();
      const used = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000).length;
      const quota = maxMin - used;
      const hasLong = parts.some((t) => t.length >= LONG_TEXT_ALWAYS_SEND);
      if (hasLong && quota > 0 && quota < parts.length) {
        const keep = new Set(
          parts.map((_, i) => i)
            .sort((a, b) => parts[b].length - parts[a].length || a - b)
            .slice(0, quota)
        );
        for (let i = 0; i < parts.length; i++) if (!keep.has(i)) forcedDrop.add(i);
      }
    }
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      // 实质内容（正文/长文）必须送到：它可以等，也可以明确报错，
      // 但**绝不能**被当成"多余的一条闲聊"安静省掉。
      const isCritical = i === criticalIdx || text.length >= LONG_TEXT_ALWAYS_SEND;
      // i=0 走"总延迟预算"（模型生成耗时已扣掉）；其余走条间抖动。
      const gap = i === 0 ? 0 : this.#gap(text, isLast);
      // 额度预检已经判定这条要让位 → 直接算省略，不进队列（否则它会占掉正文的名额）
      if (forcedDrop.has(i)) continue;
      promises.push(chain(async () => {
        // 每次发送前重判一次现值（白名单/暂停/预算可能已经变了，见 #gateBeforeSend）
        this.#gateBeforeSend(chatKey);
        // 上一次同样的内容结果不确定 → 不原样重发（重复投递比少发一条更伤）
        if (this.ledger?.isPending(chatKey, text)) {
          throw new Error('这条内容上一次发送结果不确定（可能已经发出去了），为避免重复，这次没有再发；请先确认，或换一句话。');
        }
        // critical（正文/长文）额度差一点就等；纯闲聊的补充句超限则安静省略 ——
        // 报错会让模型再跑一整轮 17K tokens 去说一句废话。
        const rate = await this.#checkRate(chatKey, { final: isCritical });
        if (rate?.skipped) return { skipped: rate.skipped, text };
        const wait = i === 0 ? this.#firstDelay(chatKey, text) : gap;
        if (wait > 0) await sleep(wait);
        const data = await this.#attempt(chatKey, text, 'text', () => this.platform.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        }));
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        // raw 只在出站前被改过时才带：session.sent 里留着它，看板才能把
        // 「她原本写的」和「用户实际看到的」分成两个数（见 rule-audit 的 space-split-raw）。
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts), raw: rawOf[i] || undefined };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    const dropped = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (r.value?.skipped) dropped.push({ reason: r.value.skipped, text: r.value.text });
        else sent.push(r.value);
        continue;
      }
      failed.push({ error: String(r.reason?.message ?? r.reason) });
    }
    // 额度预检判定让位的短句也要报上去：调用方要能告诉模型"少说了这几句"，
    // 否则它会以为全发了，下一轮又莫名其妙重复一遍。
    for (const i of forcedDrop) dropped.push({ reason: 'quota-short', text: parts[i] });
    if (sent.length === 0 && failed.length > 0) {
      throw new Error(failed.map((f) => f.error).join('；'));
    }
    // blocked 单独回报：调用方要能区分"发失败"（网络）与"被拦下"（内容）——
    // 这两种在日志、重试策略、给模型的提示上都不一样。
    // dropped 是"按节奏省略"：这一轮已经说过话，少一条不算失败，也不该让模型再补一句。
    return { sent, failed, blocked, dropped };
  }

  /** 上传文件到当前会话（产物交付用）。 */
  sendFile(chatKey, filePath, fileName) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 每次发送前重判一次现值（白名单/暂停/预算可能已经变了，见 #gateBeforeSend）
      this.#gateBeforeSend(chatKey);
      const shown = fileName || String(filePath).split(/[\\/]/).pop();
      await this.#checkMedia(chatKey, 'file', filePath, `文件（${shown}）`);
      const data = await this.#attempt(chatKey, `[文件]${shown}`, 'file', () => this.platform.sendFile(kind, id, filePath, fileName));
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[文件:${fileName || String(filePath).split('/').pop()}]`, ts });
      this.onSent?.({ chatKey, text: '[文件]', messageId: data?.file_id ?? null });
      return data;
    });
  }

  /** 发送一张任意图片（独立气泡，URL 或本地路径）。 */
  sendImage(chatKey, imageUrl, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 每次发送前重判一次现值（白名单/暂停/预算可能已经变了，见 #gateBeforeSend）
      this.#gateBeforeSend(chatKey);
      await this.#checkMedia(chatKey, 'image', imageUrl, '图片');
      // 图片不是"这一轮的回应"：额度不够就安静跳过，别为一张图让模型再跑一整轮
      if ((await this.#checkRate(chatKey))?.skipped) return { skipped: true, message_id: null };
      await sleep(randInt(500, 1200));
      const data = await this.#attempt(chatKey, `[图片]${imageUrl}`, 'image', () => this.platform.sendImage(kind, id, imageUrl, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      }));
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[图片:${String(imageUrl).split('/').pop().slice(0, 60)}]`, ts });
      this.onSent?.({ chatKey, text: '[图片]', messageId: data?.message_id ?? null });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 表情的实际图片来源：本地副本优先，转成 base64 直传。
   * 原因：QQ 消息图片是带 rkey 的临时链接（过期即 404）；而云端/隧道部署时
   * NapCat 也读不到本机绝对路径。base64 与文件位置无关（NapCat 支持 base64://）。
   */
  #stickerSource(sticker) {
    const localPath = String(sticker?.localPath || '').trim();
    if (localPath) {
      try {
        const stat = fs.statSync(localPath);
        if (stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 * 1024) {
          return `base64://${fs.readFileSync(localPath).toString('base64')}`;
        }
      } catch { /* 本地副本不可用则退回 URL */ }
    }
    return String(sticker?.url || '');
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 每次发送前重判一次现值（白名单/暂停/预算可能已经变了，见 #gateBeforeSend）
      this.#gateBeforeSend(chatKey);
      await this.#checkMedia(chatKey, 'sticker', sticker?.url || sticker?.localPath || '', `表情包（${sticker.desc || sticker.localNote || sticker.id}）`);
      // 表情的额度是独立的（见 #stickerMinuteLimit）：文字把那 4 条用光，也不该连累一张表情
      if ((await this.#checkRate(chatKey, { scope: 'sticker' }))?.skipped) return { skipped: true, message_id: null };
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.#attempt(chatKey, `[表情]${sticker?.id || ''}`, 'sticker', () => this.platform.sendSticker(kind, id, this.#stickerSource(sticker), {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      }));
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[表情包：${sticker.desc || sticker.localNote || sticker.id}（${sticker.id}）]`, ts });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发送一条语音（独立气泡）。
   * voice = { file, label }：file 是本地绝对路径或 base64:// 字符串（NapCat 会转 SILK）。
   *
   * 失败自动换一种投递方式再试一次：路径 → base64。
   * 这条重试是拿真实故障换来的：协议端不在同一台机器、路径里有中文/空格、
   * QQ 进程读不到用户目录时，"路径"这一种投递会失败，而同样的字节内联进去就能发。
   */
  async sendVoice(chatKey, voice = {}, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 每次发送前重判一次现值（白名单/暂停/预算可能已经变了，见 #gateBeforeSend）
      this.#gateBeforeSend(chatKey);
      const file = String(voice.file || '').trim();
      if (!file) throw new Error('语音文件为空');
      await this.#checkMedia(chatKey, 'voice', file, `语音（${String(voice.label || '').slice(0, 40) || '未命名'}）`);
      // 语音是实体交付（翻唱/长回复），不能静默丢：额度不够就等或明确报错
      await this.#checkRate(chatKey, { final: true });
      await sleep(randInt(400, 1100));   // 开口前真人式的短暂停顿
      const opts = {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      };
      let data;
      try {
        data = await this.#attempt(chatKey, `[语音]${voice.label || file}`, 'voice', () => this.platform.sendRecord(kind, id, file, opts));
      } catch (first) {
        const local = file.replace(/^file:\/\//i, '');
        if (/^base64:\/\//i.test(file) || !fs.existsSync(local)) throw first;
        try {
          data = await this.#attempt(chatKey, `[语音]${voice.label || local}`, 'voice', () => this.platform.sendRecord(kind, id, 'base64://' + fs.readFileSync(local).toString('base64'), opts));
        } catch {
          throw first;   // 两种都失败：报第一次的原因（更像人话，通常是"文件不存在/格式不支持"）
        }
      }
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[语音：${String(voice.label || '').slice(0, 40) || '（语音）'}]`, ts });
      this.onSent?.({ chatKey, text: '[语音]', messageId: data?.message_id ?? null, voice: voice.label || '' });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId, { targetName = '' } = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 每次发送前重判一次现值（白名单/暂停/预算可能已经变了，见 #gateBeforeSend）
      this.#gateBeforeSend(chatKey);
      await sleep(randInt(300, 900));
      let data;
      try {
        data = await this.platform.sendPoke(kind, id, targetUserId);
      } catch (error) {
        // 拍一拍没有"原文"可记，所以不走 #attempt —— 但失败必须留痕：
        // 之前这里只往上抛，控制台的 skip 列表里什么都没有，
        // 于是"它到底拍没拍"只能去翻 stdout 猜（94 次回拍全失败就是这么藏住的）。
        try {
          recordSkip({
            stage: SKIP_STAGES.SEND_FAIL,
            chatKey: String(chatKey),
            reason: `拍一拍发送失败：${String(error?.message ?? error).slice(0, 200)}`,
            detail: { kind: 'poke', target: String(targetUserId ?? ''), code: String(error?.code || '') || undefined }
          });
        } catch { /* 记账失败不能反过来改变这次失败的结果 */ }
        throw error;
      }
      const ts = Date.now();
      // 留档要带上**号码**：下一轮的拍一拍预算靠这条记录判断"刚拍过谁"，
      // 只写"对方"的话私聊里就永远算不出重复。
      const who = targetUserId != null
        ? (targetName ? `${targetName}(QQ:${targetUserId})` : String(targetUserId))
        : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍 ${who}`, ts });
      this.onSent?.({ chatKey, text: `[拍一拍]${who}`, messageId: null });
      return data;
    });
  }
}
