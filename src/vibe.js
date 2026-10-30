// 人设回路 —— 「她此刻什么心情、跟这个人处得怎么样」。
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// 原来只有 mood.js 一个标量分数：四个标签（低落/平静/开心/很兴奋）+ 一句通用提示。
// 结果是「情绪」只出现在提示词里一行字，模型能读到的信息量约等于"你今天心情还行"，
// 于是永远回成同一个温度 —— 有礼貌、正确、但没有当下状态，像个应答机。
//
// 这个模块补的是"当下状态"的三件事：
//   ① 混合情绪：不是"委屈"，而是"别扭里带一点委屈"。带强度、带原因、带半衰期。
//   ② 关系账本：他这几条只回了两个字、只甩了个表情、这一段你说 5 条他回 1 条。
//      客观计数，不评价；它不念出来，但它影响现在的语气。
//   ③ 沉默档：他隔了多久才回、你上一句是不是还挂着没人接 —— 每一档给「可以」和「别」。
//
// ── 三条设计铁律（都是踩过坑换来的）─────────────────────────────────────
// 1. **只改"怎么说"，不改"是谁"**：不碰 roleText、不碰性格、不碰工具权限。
//    这里产出的每一句都会带"（不覆盖角色设定）"的意思，情绪是语气，不是新人格。
// 2. **情绪 → 表达菜单 + 硬禁止**。只给情绪（"你现在很委屈"）模型会演；
//    给 2~3 个具体可选动作 + 明确不许做的事，才会长出分寸。
//    学自「鲜活模块」的 mood.js 和「时间感知」的 gap.js —— 每档都写了 say 和 not。
// 3. **没情绪就不注入**。低于显示阈值整段不出现。活人大多数时候是平静的，
//    每条都"她心里泛起涟漪"才是最大的假。学自「活人感」v1.2.0 的「自然优先」。
//
// ── 和 mood.js 的分工（别合并）───────────────────────────────────────────
// mood.js 的 score 是**慢变量**（底色/心气，几小时到几天，gesture.js 用它算拍一拍预算）：
//   score ≤35 只回拍、0–6 点不主动 —— 这些是行为闸门，不能被情绪抖动带着走。
// 这里的 blend 是**快变量**（此刻的情绪，分钟到小时，指数半衰期）：
//   只进提示词，不参与任何闸门判定。
// 两个时间尺度分开，才不会"因为他回了个'哦'，半夜就被判定成心情低落不敢说话"。
//
// 纯函数为主：now / rng 全由入参给，测试不必等真实时间，也不碰网络。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { readJsonSafe } from './json-store.js';

// ── 情绪表 ───────────────────────────────────────────────────────────────
// 口径：小鲸鱼是**群里的玩伴**，不是恋爱陪伴。
// 所以这里只保留"玩伴会有的情绪"，故意**不收**吃醋/受伤/崩溃/哭腔这类
// 高浓度关系向情绪 —— 那套东西（「时间感知」高需求感档里连"你是不是不要我了"
// 都写好了）放进这个角色里是换人格，不是修回路。
//
// 每条三件套：
//   tone —— 写进提示词的"说话姿态"（写的是怎么说话，不是心里多难受）
//   say  —— 可以怎么做（2~4 个具体动作，让模型有得挑，不会每次都同一个反应）
//   not  —— 硬禁止（这一条比 say 更重要：没有它，情绪会被演成伤人或耍赖）
export const EMOTIONS = Object.freeze({
  开心: {
    tone: '轻快、愿意多说两句，尾巴是翘的',
    say: ['顺手多接一句有的没的', '主动抛个新话题', '逗他一下'],
    not: '一高兴就刷屏、逮着人查户口'
  },
  兴奋: {
    tone: '话变多、语速快、忍不住连着说',
    say: ['连发两条也行', '拉他一起干点什么', '把"哇"直接甩出来'],
    not: '一口气发五条、解释"我为什么这么开心"'
  },
  得意: {
    tone: '尾巴翘起来，故意卖一下，等人夸',
    say: ['让他夸你一句', '把刚才那句再嘚瑟一遍', '"哼哼"两声'],
    not: '真摆架子、自己解释"我厉害在哪"'
  },
  好奇: {
    tone: '眼睛亮起来，追着问，语速偏快',
    say: ['"诶？"', '"让我康康"', '"这什么梗啊"'],
    not: '一次问三个问题、不懂装懂'
  },
  害羞: {
    tone: '句子变短、躲闪、不正面接话',
    say: ['只回两三个字', '把话岔开', '甩个表情糊过去'],
    not: '否认到底（"我才没有"）、反夸回去'
  },
  别扭: {
    tone: '嘴上不认、心里在意，来回两句就散',
    say: ['"哦" / "行吧" / "随你"', '故意说反话', '把话题拐走'],
    not: '一上来就"你是不是不想理我"、写小作文'
  },
  委屈: {
    tone: '先小声抱怨一句，再说想要什么',
    say: ['把话说短、说闷', '只回一个字', '直接说"我有点不爽"'],
    not: '审问（"刚跟谁聊呢"）、翻旧账、逼他表态'
  },
  失落: {
    tone: '句子收得很快，不再追问',
    say: ['"算了" / "没事" / "你忙"', '干脆这条不回', '换个自己的话题'],
    not: '阴阳怪气到伤人、反复问"你怎么了"'
  },
  没劲: {
    tone: '句子散、有点黏、起个头又不想聊',
    say: ['起个话头又自己接下去', '玩个梗敷衍一下', '"好无聊啊"'],
    not: '用"有人吗""大家还在吗"这种气氛组话术'
  },
  嫌弃: {
    tone: '吐槽一句，但不真伤人，带点笑',
    say: ['一句吐槽 + 立刻转话题', '翻个白眼（表情）', '"咦——"'],
    not: '连珠炮、碰外貌/家人/穷、把人怼跑'
  },
  假生气: {
    tone: '嘴上凶、其实没真气，下一句就散',
    say: ['"哼"', '"你完了"', '"三天不理你"（当然不能真不理）'],
    not: '把假生气演成真冷战、拿这个要东西'
  },
  心疼: {
    tone: '语气放软、关心具体、不绕弯',
    say: ['问一句具体的（"骂你啥了"）', '"啧，说说"', '少说话，就陪着'],
    not: '劝"别难过""想开点"、趁机抖机灵、追问细节'
  },
  累: {
    tone: '短、钝、不想动脑',
    say: ['一两句就收', '坦白"今天脑子不太行"'],
    not: '硬撑着长聊、拿"累"当借口装死'
  },
  平静: {
    tone: '正常说话，不刻意加情绪',
    say: ['正常接话就行'],
    not: '为了显得"有情绪"硬加感叹号和语气词'
  }
});

export const EMOTION_NAMES = Object.freeze(Object.keys(EMOTIONS));

export const DEFAULTS = Object.freeze({
  enabled: true,
  // 快变量半衰期：40 分钟掉一半。一小时后基本淡掉，符合"小事气一会儿就过去了"。
  halfLifeMin: 40,
  // 低于这个强度不显示（噪音线）。0.15 的口径：
  //   一条强信号（被夸 0.22 / 被怼 0.22 / 心疼 0.16）当场就看得见；
  //   一条弱信号（他连着回两三个字 0.14）单独不够，攒两轮才浮出来。
  displayThreshold: 0.15,
  // 同时最多显示几层（主情绪 + 2 层）。
  maxBlend: 3,
  // 低于这个强度就当成"没这回事"从记忆里丢掉。
  // ⚠️ 这个数**必须远小于**单次信号权重（最小 0.05），否则小信号永远攒不起来：
  //   曾经设成 0.08，结果 0.06 的"别扭"每次读盘就被筛掉，攒十轮也还是 0.06。
  dropBelow: 0.02,
  // 副层的显示门槛（"别扭里带一点委屈"里的"委屈"）。
  subLayerThreshold: 0.12,
  // 总强度封顶：叠太多会让每句话都在演，压回去。
  ceiling: 1.5,
  // 沉默档从多久开始有感觉。
  noticeFromMs: 10 * 60 * 1000,
  // 账本只看最近多少条对方消息。
  ledgerWindow: 8
});

export function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function settingsOf(raw) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (v !== undefined && v !== null && k in out) out[k] = v;
  }
  return out;
}

// ── 信号：他这条消息/这几条消息，说明了什么 ────────────────────────────────
// 情绪词表**分强弱两级**（照抄「活人感」v1.4.0 的修正，理由见下）。
//
// ⚠️ v1.2 时代这里是一张 64 词的大表，"离谱 / 好烦 / 睡不着 / 头大 / 麻了" 这种
// **日常轻吐槽**单词命中就判"对方低落"。两个后果都很难看：
//   ① 提示词里每轮都多一行「他状态不对，先接情绪」→ 她一动嘴就得收敛幽默；
//   ② 更糟的是 driftLayers 会因此 push('心疼', 0.20) —— 群里有人随口说句
//      "好烦啊"，她的【你此刻的心情】就变成"心疼"。这不是接情绪，是抢情绪。
// 「活人感」作者在真机上抽样 101 条群消息验证过：大表命中 1 条，且那 1 条是误判
// （「不然睡不着啊」= 闲聊）。所以口径改成两级。

/**
 * **强信号**：单个命中就算"他此刻状态不好"。
 * 收词口径：只收**明确在说此刻难受**的说法 —— 这些词日常几乎不会用来形容
 * "这事好笑/离谱"，所以单个就够，不必等第二个词来确认。
 */
export const LOW_MOOD_STRONG = Object.freeze([
  '难过', '好难受', '难受死', '哭了', '想哭', '委屈', '憋屈', '心塞', '堵得慌', '破防', '破大防',
  '崩溃', '绷不住', '绷不住了', '蚌埠住了', '撑不住', '顶不住', '熬不住', '干不动', '卷不动',
  '累死', '累死了', '好累', '累趴', '心累', '疲惫',
  '被骂', '骂我', '挨骂', '背锅', '考砸', '挂了科', '被裁', '被裁员', '失业', '压力好大',
  '丧', '自闭', '社死', '抑郁', '焦虑', '分手', '吵架', '失眠',
  '不想活', '活着没意思', '想死'
]);

/**
 * **弱信号**：日常轻吐槽。单个命中**不算**情绪低落 —— 至少 2 个才算。
 * 为什么单独一张表：这些词在群里天天出现，单词就触发"先接情绪、别开玩笑"，
 * 等于把话痨和幽默直接关掉。攒到两个才说明他今天确实有点丧，不是在接梗。
 */
export const LOW_MOOD_WEAK = Object.freeze([
  '没劲', '没意思', '不想动', '不想上班', '烦死', '好烦', '烦躁', '生气', '气死',
  '无语了', '头大', '头疼', '离谱', 'emo', '摆烂', '躺平了', '睡不着', '麻了'
]);

/** 兼容导出：两级合起来的全量（外部只读用；判定请走 `lowMoodDetail` / `lowMoodOf`）。 */
export const LOW_MOOD = Object.freeze([...LOW_MOOD_STRONG, ...LOW_MOOD_WEAK]);

/** 超过这个长度就当成"转发/粘贴进来的文本"而不是他此刻在说话。 */
const LONG_TEXT_CHARS = 120;

/**
 * 上下文否决 —— **分级之后还剩下的那类误判**，靠词表解决不了。
 *
 * ⚠️ 这一层不是原包带的，是拿本项目 2131 条真实群消息跑出来的（原包抽样 101 条、
 * 命中 1 条，样本太小看不出）。实测强信号单命中仍然会错在这两处：
 *
 *  ① **"哭"在中文群聊里是高频梗**：`我真他妈笑哭了`、`急哭了`、`我哭了做题蛆`。
 *     原包把「哭了」列强信号没问题，但它没处理"笑着说哭"——"笑哭了"判成
 *     心疼 +0.20 是**方向错**，不是力度错。凡是同一个句子里还带着"笑"的，
 *     那个"哭"是开心。
 *
 *  ② **长文本里的情绪词不是他此刻的状态**。实测命中的两条：
 *     一条是《LOL 主播梗来源》的百科粘贴（含"破防"），
 *     一条是"南京总统府 1937 年…蒋介石"的小说片段（含"崩溃"）。
 *     里面的"崩溃"描述的是**文本里的人**，跟她眼前的群友毫无关系。
 *     转发/粘贴超过 120 字就整体不判 —— 真有人在长文里倾诉，也还有
 *     后续几条短消息兜着，漏一轮不要紧，误判一轮她会心疼一整个上午。
 *
 * @returns {string} 否决理由（空串 = 不否决）
 */
export function moodVeto(text, hit = '') {
  const s = String(text ?? '');
  if (!s) return '';
  if (s.length > LONG_TEXT_CHARS) return '长文本（转发/粘贴）';
  // 只对带"哭"的命中做"在笑"否决：别的词（失业/被骂）跟"笑"可以并存
  // （"被骂了，笑死"是真被骂），不能一刀切。
  if (hit.includes('哭') && /笑/.test(s)) return '他在笑（笑哭了）';
  // ③ 说的是别人（"把人唱得绷不住了"）—— 他在评论第三方，不是他自己难受。
  // 只认"把人…"这种句式：范围小到不会误伤"我被人骂了"（那是真有情绪）。
  if (/把人.{0,8}([哭绷整笑气])/.test(s)) return '在说别人';
  return '';
}

/**
 * 分级判定 —— 给需要区分"真低落"和"顺口吐槽"的地方用（driftLayers 靠它分权重）。
 * @returns {{level: ''|'strong'|'weak', hit: string, vetoed: string}}
 *   level='strong' 单个强信号命中；level='weak' 两个以上弱信号（hit 形如 "好烦+头大"）。
 *   vetoed 非空 = 词命中了但被上下文否掉（level/hit 已清零，留理由只为可查）。
 */
export function lowMoodDetail(text) {
  const s = String(text ?? '');
  if (!s) return { level: '', hit: '', vetoed: '' };
  let level = '';
  let hit = '';
  const strong = LOW_MOOD_STRONG.find((k) => s.includes(k));
  if (strong) {
    level = 'strong';
    hit = strong;
  } else {
    const weak = LOW_MOOD_WEAK.filter((k) => s.includes(k));
    if (weak.length >= 2) { level = 'weak'; hit = weak.join('+'); }
  }
  if (!level) return { level: '', hit: '', vetoed: '' };
  const vetoed = moodVeto(s, hit);
  if (vetoed) return { level: '', hit: '', vetoed };
  return { level, hit, vetoed: '' };
}

/** 对方在明确的低落状态里吗？返回命中的词（弱信号形如 "好烦+头大"；没有就空串）。 */
export function lowMoodOf(text) {
  return lowMoodDetail(text).hit;
}

/** 只有 QQ 表情/表情包、没有实际文字。 */
const FACE_ONLY_RE = /^(?:\[(?:表情|表情包)(?::[^\]]*)?\])+$/;

export function isFaceOnly(text) {
  const s = String(text ?? '').trim();
  return !!s && FACE_ONLY_RE.test(s);
}

// 他说了哪一类话 —— 一个词表，一个情绪倾向。
// 权重口径（配合 displayThreshold=0.15）：单条消息就能浮出水面的是"强信号"
// （被夸/被怼/被逗/被激/他说了甜的/他说自己难受）；"弱信号"（回得短、只发表情、
// 她说得多）单条不够，攒两轮才显形 —— 单条"嗯"就让她失落，那是一碰就碎，不是活人。
const SAY_RULES = Object.freeze([
  { id: 'praise', re: /厉害|好看|可爱|聪明|温柔|真棒|辛苦|牛|强|绝了|可以啊|有点东西/, layers: [['害羞', 0.16], ['得意', 0.10]], cause: '他在夸你' },
  { id: 'sweet', re: /想你|喜欢你|爱你|抱抱|乖|宝贝|等你/, layers: [['害羞', 0.18], ['开心', 0.10]], cause: '他说了句甜的' },
  { id: 'tease', re: /笨蛋|傻瓜|小胖|胖|傻鱼|笨鱼/, layers: [['假生气', 0.16], ['害羞', 0.06]], cause: '他逗你' },
  { id: 'provoke', re: /你敢|你能|试试|不行吧|就你|菜|比不过|输了吧/, layers: [['兴奋', 0.16], ['得意', 0.06]], cause: '他激你' },
  { id: 'harsh', re: /笨死|蠢|烦死|闭嘴|没用|就这|滚|有病|别烦我/, layers: [['委屈', 0.18], ['没劲', 0.08]], cause: '他说了难听的' },
  { id: 'whatever', re: /^随便|都行|你决定|无所谓|懒得/, layers: [['失落', 0.14], ['没劲', 0.06]], cause: '他说"随便"' },
  { id: 'busy', re: /在忙|没空|晚点说|等会儿|开会|加班/, layers: [['失落', 0.08]], cause: '他说在忙' },
  { id: 'apology', re: /对不起|抱歉|我错了|别生气|哄你|原谅/, layers: [['心疼', 0.12], ['别扭', 0.06]], cause: '他在跟你赔不是' },
  { id: 'curious', re: /[?？]\s*$|吗|呢|什么|为啥|怎么/, layers: [['开心', 0.06]], cause: '他在问你' }
]);

export function detectSay(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const hits = [];
  for (const r of SAY_RULES) {
    if (r.re.test(s)) hits.push({ id: r.id, cause: r.cause, layers: r.layers });
  }
  return hits;
}

/**
 * 从"最近一段消息 + 这批唤醒"里数出客观事实。
 *
 * @param {object} p
 * @param {Array} p.recent       最近的会话消息（store.recent 的形状）
 * @param {Array} p.triggerEntries 这一批还没看过的消息
 * @param {string} p.speakerId   当前说话的人（拿不到就空串 —— 绝不用昵称猜）
 * @param {number[]} p.selfTimes 自己发言的时间戳（用于算"他隔了多久才回"）
 * @param {number} p.now
 * @returns {object} 纯计数，不含任何评价
 */
export function collectSignals({ recent = [], triggerEntries = [], speakerId = '', selfTimes = [], kind = 'group', now = Date.now() } = {}) {
  const sid = String(speakerId || '');
  const his = sid
    ? recent.filter((m) => !m.self && String(m.senderId ?? '') === sid)
    : recent.filter((m) => !m.self);
  const mine = recent.filter((m) => m.self);
  const text = String((triggerEntries.filter((m) => m && !m.self).at(-1) || {}).text ?? '');
  const moodHit = lowMoodDetail(text);

  const hisTime = his.at(-1)?.ts ?? 0;
  // 这批唤醒最早那一条，减去我上一条 = 他隔了多久才回。
  const firstTriggerTs = triggerEntries.filter((m) => m && !m.self).map((m) => Number(m.ts) || 0).filter(Boolean).sort((a, b) => a - b)[0] || 0;
  const lastSelfTs = selfTimes.length ? Math.max(...selfTimes.map(Number).filter(Number.isFinite)) : 0;
  let replyGapMs = 0;
  if (firstTriggerTs && lastSelfTs && firstTriggerTs > lastSelfTs) replyGapMs = firstTriggerTs - lastSelfTs;

  // 我上一条还挂着没人接：最后一条是我发的，且现在离它已经很久。
  const lastAll = recent.at(-1);
  const pendingGapMs = lastAll?.self && lastSelfTs ? Math.max(0, now - lastSelfTs) : 0;

  return {
    speakerId: sid,
    kind: String(kind || 'group'),
    hisCount: his.length,
    myCount: mine.length,
    hisShort: his.filter((m) => String(m.text ?? '').trim().length > 0 && String(m.text ?? '').trim().length <= 3).length,
    hisFaceOnly: his.filter((m) => isFaceOnly(m.text)).length,
    hisBurst: triggerEntries.filter((m) => m && !m.self).length,
    repeated: his.length >= 2 && String(his.at(-1)?.text ?? '').trim() === String(his.at(-2)?.text ?? '').trim() && String(his.at(-1)?.text ?? '').trim() !== '',
    // 账本在群里天然不可靠，得拆成两条判据（真机上踩过）：
    //  · "他回得短"只说他自己 —— 他在这个窗口里说了 3 条以上才够采样（私聊 2 条就够）。
    //  · "你说得多他只回几条"在群里根本不成立 —— 那 12 条是跟 4 个人说的，
    //    拿一个人的条数去除，会得出"你在硬撑话题"这种完全错误的结论。所以只在私聊算。
    shortEligible: String(kind) === 'private' ? his.length >= 2 : his.length >= 3,
    ratioEligible: String(kind) === 'private',
    replyGapMs,
    pendingGapMs,
    // lowMood：命中的词（弱信号 "好烦+头大"）；lowMoodLevel：'' / 'strong' / 'weak'。
    // 两个都要，因为"要不要收敛"看 hit，"给多少心疼"看 level。
    lowMood: moodHit.hit,
    lowMoodLevel: moodHit.level,
    sayHits: detectSay(text),
    text
  };
}

/** 这批消息让情绪往哪边挪。返回 [{emotion, intensity}]。 */
export function driftLayers(sig, settings = DEFAULTS) {
  const out = [];
  const push = (emotion, w) => {
    if (EMOTIONS[emotion]) out.push({ emotion, intensity: clamp01(w) });
  };
  for (const hit of sig.sayHits || []) for (const [emotion, w] of hit.layers) push(emotion, w);

  // 他对你说"累死了/绷不住了"—— 心疼，而不是被他的情绪带跑。
  // ⚠️ 分级给权重（v1.4.0 口径）：强信号 0.20 一次就浮出水面；
  // 弱信号（两个日常吐槽凑一起）只给 0.13 —— 够让她语气软一点，
  // 但不足以让她下一轮还在"心疼"里出不来。老版本一律 0.20，
  // 结果群里连说两句"好烦+头大"，她后面几条都在心疼，非常假。
  if (sig.lowMood) push('心疼', sig.lowMoodLevel === 'weak' ? 0.13 : 0.20);

  // 他连着几条都只回两三个字 —— 单条不算，两条起才叫"敷衍感"。
  if (sig.shortEligible && sig.hisShort >= 2) { push('失落', 0.09); push('别扭', 0.06); }
  // 只甩表情、一个字不打。
  if (sig.shortEligible && sig.hisFaceOnly >= 1) { push('委屈', 0.08); }
  // 这一段明显是她在撑话题（只在私聊算：群里"我说 4 条"可能是对 4 个人说的）。
  if (sig.ratioEligible && sig.myCount >= 4 && sig.hisCount >= 1 && sig.myCount >= sig.hisCount * 2) { push('没劲', 0.09); }
  // 他连发好几条 —— 说明聊起来了。
  if (sig.hisBurst >= 3) { push('兴奋', 0.12); push('开心', 0.06); }
  // 同一句又说一遍。
  if (sig.repeated) { push('嫌弃', 0.10); }
  // 秒回 / 隔了很久才回。
  if (sig.replyGapMs > 0 && sig.replyGapMs <= 60 * 1000) { push('开心', 0.08); }
  if (sig.replyGapMs >= settings.noticeFromMs) {
    const gap = gapTier(sig.replyGapMs, settings);
    if (gap?.emotion) push(gap.emotion, gap.weight || 0.08);
  }
  return out;
}

// ── 衰减：指数半衰期 ─────────────────────────────────────────────────────
// 老 mood.js 是阶梯式（6 小时那一刻突然 -2，5 小时 59 分毫无变化）。
// 人会感到情绪连续地淡下去，不会整点跳变 —— 这里用 0.5^(Δt/半衰期)。
export function decayBlend(blend, updatedAt, now = Date.now(), settings = DEFAULTS) {
  const age = Math.max(0, now - (Number(updatedAt) || 0));
  const halfLifeMs = Math.max(60 * 1000, (Number(settings.halfLifeMin) || 40) * 60 * 1000);
  const factor = Math.pow(0.5, age / halfLifeMs);
  return (Array.isArray(blend) ? blend : [])
    .map((b) => ({ emotion: b.emotion, intensity: clamp01((Number(b.intensity) || 0) * factor) }))
    .filter((b) => EMOTIONS[b.emotion] && b.intensity >= settings.dropBelow)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, Math.max(1, Number(settings.maxBlend) || 3));
}

function upsertLayers(blend, layers, settings) {
  let next = [...blend];
  for (const layer of layers) {
    const w = clamp01(layer.intensity);
    if (!w) continue;
    const cur = next.find((b) => b.emotion === layer.emotion);
    const merged = cur ? Math.min(0.95, cur.intensity + w) : w;
    next = next.filter((b) => b.emotion !== layer.emotion);
    // 这里**不能**按 dropBelow 丢掉小信号：0.06 单看不显眼，但攒三次就是 0.18。
    // 显示门槛交给 decayBlend（读的时候筛），写的时候只挡 0。
    if (merged > 0) next.push({ emotion: layer.emotion, intensity: merged });
  }
  // 总强度封顶：叠太多会让每句话都在演，等比压回去。
  const sum = next.reduce((a, b) => a + b.intensity, 0);
  const ceil = Number(settings.ceiling) || 1.5;
  if (sum > ceil) next = next.map((b) => ({ ...b, intensity: b.intensity * (ceil / sum) }));
  return next.sort((a, b) => b.intensity - a.intensity).slice(0, Math.max(1, Number(settings.maxBlend) || 3));
}

// ── 沉默档 ───────────────────────────────────────────────────────────────
// 学自「时间感知」的 gap.js：每档写 head / feel / say / not / 条数上限。
// ⚠️ 但**故意砍掉了高需求感那套**（15 分钟闹、1 小时阴阳、一天崩溃、哭腔、
// "你是不是不要我了"）—— 那是恋爱陪伴向的阶梯。小鲸鱼是群里的玩伴，
// 隔久了最多是"有点闷、别扭两句"，不该升级成人格层面的崩塌。
const GAP_LADDER = Object.freeze([
  {
    name: 'steady', level: 0, fromMs: 0,
    head: ''
  },
  {
    name: 'waiting', level: 1, fromMs: 10 * 60 * 1000, maxMsgs: 1,
    emotion: '失落', weight: 0.06,
    head: '他隔了 {gap}才冒头。',
    feel: '也没多大事，就是被吊着等了一会儿，心里有点空。',
    say: '吐槽一句"哟，忙完了？"，或者当没这回事直接接话',
    not: '别一上来就兴师问罪，也别把等待时间报给他听。'
  },
  {
    name: 'miffed', level: 2, fromMs: 60 * 60 * 1000, maxMsgs: 1,
    emotion: '别扭', weight: 0.10,
    head: '{gap}没动静，现在才回来。',
    feel: '有点闷，也会想"他是不是不太想搭理我"。不用承认，但回话会短一点。',
    say: '回得短一点（"哦""行"），或者先晾半句再接',
    not: '别赌气不理人（那是冷暴力，不是别扭），别扭一两句就够。'
  },
  {
    name: 'moved-on', level: 3, fromMs: 6 * 60 * 60 * 1000, maxMsgs: 2,
    emotion: '平静', weight: 0,
    head: '{gap}了，人总算出现了。',
    feel: '早翻篇了，但会留意他回来第一句话说的是什么。',
    say: '正常接，随口带一句"你哪去了"',
    not: '别翻旧账、别算时间账、别演"我等了你一整晚"。'
  }
]);

/** 这段沉默属于第几档（level 0 表示还不用有反应）。 */
export function gapTier(gapMs, settings = DEFAULTS) {
  const from = Number(settings.noticeFromMs) || DEFAULTS.noticeFromMs;
  if (!(Number(gapMs) > from)) return null;
  let cur = null;
  for (const step of GAP_LADDER) if (Number(gapMs) >= step.fromMs && step.level > 0) cur = step;
  return cur;
}

export function humanGap(ms) {
  const n = Math.max(0, Number(ms) || 0);
  // 用 floor 不用 round：45 秒说成"1 分钟"会显得比实际久，人记时间只记整。
  const min = Math.floor(n / 60000);
  if (min < 1) return '不到一分钟';
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  const rest = min % 60;
  if (hour < 24) return rest ? `${hour} 小时 ${rest} 分钟` : `${hour} 小时`;
  const day = Math.floor(hour / 24);
  return `${day} 天`;
}

// ── 关系账本 ─────────────────────────────────────────────────────────────
// 只数事实，不下判断。这是「鲜活模块」sensitivity.js 里 ledgerFacts 的思路，
// 但重写了（原版开头那个 for 循环只有 continue，是死代码）。
export function ledgerFacts(sig) {
  const facts = [];
  if (sig.shortEligible && sig.hisShort >= 2) {
    // 全中时说"连着 N 条"更自然（"最近 3 条里有 3 条"是机翻腔）。
    facts.push(sig.hisShort >= sig.hisCount
      ? `他连着 ${sig.hisCount} 条都只回两三个字`
      : `他最近 ${sig.hisCount} 条里有 ${sig.hisShort} 条只回两三个字`);
  }
  if (sig.shortEligible && sig.hisFaceOnly >= 1) facts.push(`他甩了 ${sig.hisFaceOnly} 个表情，一个字都没打`);
  if (sig.ratioEligible && sig.myCount >= 4 && sig.hisCount >= 1 && sig.myCount >= sig.hisCount * 2) {
    facts.push(`这一段你说了 ${sig.myCount} 条，他只回了 ${sig.hisCount} 条`);
  }
  return facts.slice(0, 2);
}

/** "别扭里带一点委屈" —— 主情绪 + 最多两层副情绪。 */
export function describeBlend(blend, settings = DEFAULTS) {
  const shown = (blend || []).filter((b) => b.intensity >= settings.subLayerThreshold);
  if (!shown.length) return '';
  const [main, ...rest] = shown;
  const tail = rest.slice(0, 2).map((b) => b.emotion).join('、');
  return tail ? `${main.emotion}里带一点${tail}` : main.emotion;
}

/**
 * 此刻**最强的那一层情绪**（给"发语音时该用什么语气"用）。
 *
 * 为什么不复用 describeBlend：那段是给人读的（"别扭里带一点委屈"），
 * 而语音链路要的是一个能查表的**标签**。两者取层的门槛必须一致
 * （同样按 subLayerThreshold 过滤），否则提示词说"你有点委屈"、
 * 语音却按"平静"念，听起来像两个人。
 *
 * 低于显示阈值（displayThreshold）时返回 null —— 大多数时候人是平静的，
 * 没有情绪就别硬编一个。
 *
 * @param {Array<{emotion:string,intensity:number}>} blend
 * @param {object} settings
 * @returns {{name:string, intensity:number}|null}
 */
export function topEmotion(blend, settings = DEFAULTS) {
  const list = (Array.isArray(blend) ? blend : [])
    .filter((b) => b && EMOTIONS[b.emotion] && Number.isFinite(Number(b.intensity)));
  if (!list.length) return null;
  const main = list.reduce((a, b) => (Number(b.intensity) > Number(a.intensity) ? b : a));
  if (Number(main.intensity) < settings.displayThreshold) return null;
  return { name: main.emotion, intensity: Number(main.intensity) };
}

function levelText(intensity) {
  if (intensity >= 0.6) return '挺明显';
  if (intensity >= 0.4) return '有点上来了';
  return '只冒了一点点';
}

function baselineText(score) {
  const n = Math.max(20, Math.min(90, Number(score) || 50));
  if (n <= 39) return '这两天心气不高，别硬撑着演热闹';
  if (n <= 59) return '心气一般，正常状态';
  if (n <= 79) return '这两天心气挺好';
  return '这两天状态很好，容易上头';
}

/**
 * 渲染成提示词里的一段。**没有可说的就返回空串**（自然优先）。
 *
 * @param {object} p
 * @param {object} p.blend      decayBlend 的结果
 * @param {string} p.cause      这批情绪的由头（一句短语）
 * @param {object} p.signals    collectSignals 的结果
 * @param {number} p.baseline   底色分数（mood.score）
 * @param {object} p.settings
 * @returns {string}
 */
export function renderVibe({ blend = [], cause = '', signals = null, baseline = 50, settings = DEFAULTS } = {}) {
  if (settings.enabled === false) return '';
  const lines = [];
  // 脏数据防线：老档或手改的 vibe.json 里可能有已经不存在的情绪名。
  const safeBlend = (Array.isArray(blend) ? blend : []).filter((b) => b && EMOTIONS[b.emotion]);
  const main = safeBlend[0] || null;

  if (main && main.intensity >= settings.displayThreshold) {
    const preset = EMOTIONS[main.emotion];
    const name = describeBlend(safeBlend, settings) || main.emotion;
    // 副层只说"怎么表现"，不再重复报一遍名字（"失落里带一点别扭"已经说过了）。
    const subs = safeBlend
      .slice(1)
      .filter((b) => b.intensity >= settings.subLayerThreshold)
      .map((b) => `${b.emotion}＝${EMOTIONS[b.emotion].tone}`)
      .join('；');
    let head = `【你此刻的心情】${name}（${levelText(main.intensity)}${cause ? `，因为${cause}` : ''}）——${preset.tone}。`;
    lines.push(head);
    if (subs) lines.push(`副层：${subs}。`);
    lines.push(`可以：${preset.say.join(' / ')}`);
    lines.push(`别：${String(preset.not).replace(/^别[:：]?/, '')}`);
  }

  // 他明确在低落里 —— 这条**独立于情绪强度**，因为它是"情商"不是"心情"。
  // 学自「活人感」的 moodAware：命中就优先接情绪，别抖机灵、别讲道理。
  // 主情绪已经是心疼时不重复说（心疼的菜单里本来就写着"别劝别难过"）。
  if (signals?.lowMood && main?.emotion !== '心疼') {
    const hit = String(signals.lowMood).replace(/\+/g, '、');
    // 弱信号（两个日常吐槽凑一起）措辞要留余地：他可能只是随口说说，
    // 用"状态不对/先接情绪"那种重话会把她推进过度哄人的表演。
    if (signals.lowMoodLevel === 'weak') {
      lines.push(`【他这几句有点丧】他刚说了「${hit}」——这一轮别急着抖机灵，先把话接住；他要是接着往下倒，再收。`);
    } else {
      lines.push(`【他这句状态不对】他刚说了「${hit}」——这一轮先接情绪：别开玩笑、别讲道理、别劝"别难过""想开点"，一句就够。`);
    }
  }

  // 关系账本
  if (signals) {
    const facts = ledgerFacts(signals);
    if (facts.length) lines.push(`【你心里那本账】${facts.join('；')}。（不用念出来，但它会影响你现在的语气）`);
  }

  // 沉默档（他隔了多久才回来 / 你上一句还挂着）
  if (signals) {
    const gap = gapTier(signals.replyGapMs, settings);
    if (gap?.head) {
      lines.push(`【时间上的那点感觉】${gap.head.replace('{gap}', humanGap(signals.replyGapMs))}你心里：${gap.feel}`);
      lines.push(`可以：${gap.say}别：${String(gap.not).replace(/^别[:：]?/, '')}这一档最多主动补 ${gap.maxMsgs} 条，别追。`);
    } else if (signals.pendingGapMs >= 30 * 60 * 1000) {
      lines.push(`【还挂着的那句】你上一条消息 ${humanGap(signals.pendingGapMs)}前发的，到现在没人接。不用追问、不用自嘲，想再说一句就换个话头，不想说就算了。`);
    }
  }

  // 底色：只在明显偏离中间值时提一句（否则纯噪音）。
  const score = Number(baseline);
  if (Number.isFinite(score) && (score <= 42 || score >= 68)) {
    lines.push(`【底色】${baselineText(score)}。`);
  }

  if (!lines.length) return '';
  return lines.join('\n');
}

// ── 存储 ─────────────────────────────────────────────────────────────────
// 按 `${chatKey}|${speakerId}` 存：同一个群里，跟 A 别扭不影响跟 B 说话。
// 拿不到 speakerId 时退回 chatKey（宁可粗一点，也不要张冠李戴）。
export function vibeKey(chatKey, speakerId = '') {
  const ck = String(chatKey || '');
  const sid = String(speakerId || '').trim();
  return sid ? `${ck}|${sid}` : ck;
}

export class VibeStore {
  constructor(file = path.join(DATA_DIR, 'vibe.json')) {
    this.file = file;
    this.cache = null;
  }

  #load() {
    if (this.cache) return this.cache;
    // 情绪状态本来就是短时量，坏了影响不大 —— 但仍然隔离留档而不是静默清零：
    // 同一个 readJsonSafe 让"到底是被重置了还是本来就空"能在日志和文件名上查到。
    const raw = readJsonSafe(this.file, null, { tag: 'vibe' });
    this.cache = raw && typeof raw === 'object' ? raw : {};
    return this.cache;
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache || {}, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, this.file);
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        try { fs.rmSync(this.file, { force: true }); } catch { /* 再试一次 */ }
        fs.renameSync(tmp, this.file);
      }
    } catch (e) {
      console.warn('[vibe] 写盘失败（忽略，不影响本轮）：', e?.message || e);
    }
  }

  /** 读当前有效情绪（会就地衰减，但不写盘）。 */
  get(key, now = Date.now(), settings = DEFAULTS) {
    const raw = this.#load()[key] || {};
    return {
      blend: decayBlend(raw.blend, raw.updatedAt, now, settings),
      cause: String(raw.cause || ''),
      updatedAt: Number(raw.updatedAt) || 0
    };
  }

  /** 把这一批信号叠进去，返回叠加后的状态。 */
  observe(key, layers, cause = '', { now = Date.now(), settings = DEFAULTS } = {}) {
    const all = this.#load();
    const cur = this.get(key, now, settings);
    if (!Array.isArray(layers) || !layers.length) return cur;
    const blend = upsertLayers(cur.blend, layers, settings);
    all[key] = { blend, cause: String(cause || '').slice(0, 60), updatedAt: now };
    this.#save();
    return { blend, cause: all[key].cause, updatedAt: now };
  }

  /** 一批情绪信号里最显眼的那个由头（写进提示词"因为…"）。 */
  static causeOf(signals) {
    if (!signals) return '';
    for (const hit of signals.sayHits || []) {
      if (hit.id === 'praise' || hit.id === 'tease' || hit.id === 'provoke' || hit.id === 'harsh' || hit.id === 'apology') return hit.cause;
    }
    // 他这句本身在难受 —— 比"回得短"更能解释"为什么你心里有点软"，优先。
    if (signals.lowMood) return '他这句听着不对';
    if (signals.hisShort >= 2 && signals.shortEligible) return '他这几条都只回了几个字';
    if (signals.hisFaceOnly >= 1 && signals.shortEligible) return '他只甩了个表情';
    if (signals.myCount >= 4 && signals.hisCount >= 1 && signals.myCount >= signals.hisCount * 2 && signals.ratioEligible) return '这段基本是你一个人在说';
    if (signals.replyGapMs >= 60 * 60 * 1000) return '他隔了很久才回来';
    return '';
  }

  /** 是否被配置关掉（读 config.vibe）。 */
  static configSettings() {
    let raw = null;
    try { raw = getConfig()?.vibe ?? null; } catch { raw = null; }
    return settingsOf(raw);
  }
}
