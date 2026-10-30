import { addresseeOf, describeTarget, TARGET } from './addressee.js';

// 唤醒预判（省钱层移植）—— 弱触发先用一次极小请求判断「这句要不要接」，判不接就整轮不跑。
//
// ── 为什么需要它（省钱层实测数据）──────────────────────────────────────
// 概率/关键词这类「弱触发」把机器人叫起来后，它要跑一整轮（人设+记忆+存档+工具 ≈ 上万 prompt）
// 才决定"潜水观望"。实测 320 次运行里 71 次是这种空跑、约 100 万 token（全天 16.5%）。
// 这一层只带"最近几条消息"，不带人设/记忆/工具，关思考，输出一个词：
// 约 300~600 token，比整轮便宜 20 倍以上；判"不接"就整轮不跑。
//
// 设计约束（照抄省钱层，一条都不改）：
//  1) 只对群聊、只对弱触发（概率唤醒）生效 —— 被@/私聊/关键词必回，不预判。
//  2) 失败按「接」处理（fail-open）：宁可多花一轮，也不能把该回的消息吞了。
//  3) 拿不准时倾向「接」—— 这是省钱闸门，不是让机器人变哑巴。
//  4) 本模块不 import config（纯函数 + 注入 chat），方便直接单测。

/** 这一次唤醒需要预判吗（弱触发 + 群聊才预判）。 */
export function shouldGate({ decision = null, kind = 'group', cfg = {} } = {}) {
  const gate = cfg?.gate?.cheapWakeGate || {};
  if (gate.enabled !== true) return false;
  if (String(kind) !== 'group') return false;                    // 私聊必回，不预判
  if (!decision || decision.wake !== true) return false;
  // 只预判弱触发：概率唤醒（强触发 reason 是 at/named/keyword/reply-self/private 等）
  //
  // ⚠️ dryRun 下"本来会跳过"的那批也算弱触发（2026-10-27 修）。
  //   以前只认 reason==='probability'，而 dryRun 时 decideWake 返回的是
  //   `{ wake:true, reason:'dry-run', wouldSkip:true }` —— 于是演练模式一开，
  //   这一层**整层失效**：概率路径 100% 唤醒，又没人预判，闸门等于不存在。
  //   实测 data/usage/2026-10-25~27 的 side 账本里连 `wake-gate` 这个键都没有（零调用），
  //   而群里每批未读都会跑一轮主模型（344~481 轮/天）。
  if (decision.reason === 'probability') return true;
  return decision.reason === 'dry-run' && decision.wouldSkip === true;
}

/** 把最近几条消息渲染成极简清单（每条截断，省 token）。 */
export function formatGateLines(entries = [], {
  limit = 12, perLine = 80, selfName = '我', aliases = [], selfId = '', selfNickname = ''
} = {}) {
  const opts = { aliases, selfIds: [selfId], selfNickname };
  return (Array.isArray(entries) ? entries : []).slice(-limit).map((m) => {
    const who = m?.self ? selfName : String(m?.senderName || m?.senderId || '某人');
    let text = String(m?.text ?? '').replace(/\s+/g, ' ').trim();
    // 只在真的带图时补占位符；带视频的消息 already 有 [视频]，补成 [视频][图片] 会误导判活模型
    if (Array.isArray(m?.media) && m.media.some((x) => x?.kind === 'image') && !text.includes('[图片]')) {
      text = `${text}[图片]`.trim();
    }
    if (text.length > perLine) text = text.slice(0, perLine) + '…';
    // 寻址标注：让这个极简模型一眼看出"这条在跟谁说话"。
    // 少了它，"@张三 晚上吃啥" 在它眼里和公屏闲聊没区别，容易判成"接"。
    const info = addresseeOf(m, opts);
    const tag = describeTarget(info);
    // 「对某某说」= 在跟别人说；「聊到我」= 只是提了名字，同样不是在叫它（m00001）
    let suffix = '';
    if (info.target === TARGET.OTHER) suffix = `（${tag}说）`;
    else if (tag === '聊到我') suffix = '（聊到我，没叫我）';
    return `${who}：${text}${suffix}`;
  });
}

/** 组装预判请求（越小越好：不带人设、不带工具、不带思考）。 */
export function buildGateMessages({
  botName = '机器人', entries = [], limit = 12, aliases = [], selfId = '', selfNickname = ''
} = {}) {
  const lines = formatGateLines(entries, { limit, aliases, selfId, selfNickname });
  return [
    {
      role: 'user',
      content: [
        `你是 QQ 群里的群友「${botName}」。下面是你刚看到的最近几条消息：`,
        '',
        ...(lines.length ? lines : ['（没有消息）']),
        '',
        '这几条里有你想接一句的吗？只回答一个词：接 / 不接。',
        '接：跟你有关、有人点了你的名或在问你、你对这个话题有想说的、能自然插一句。',
        '不接：纯粹是别人之间的闲聊、跟你无关、接不上、你只是路过。',
        '★ 行末标了「（对某某说）」= 那是他在跟那个人说话，不是跟你 —— 直接判「不接」。',
        '★ 行末标了「（聊到我，没叫我）」= 只是提到了你的名字，没在叫你 —— 也判「不接」。',
        '拿不准时倾向于「接」。'
      ].join('\n')
    }
  ];
}

/** 解析回答：'reply' | 'skip' | null（看不懂）。先判「不接」再判「接」。 */
export function parseGateVerdict(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (/不接|不回|不用说|潜水|没必要|无关|不参与/.test(t)) return 'skip';
  if (/^接|接$|要接|回一句|^回/.test(t)) return 'reply';
  return null;
}

/**
 * 真正跑一次预判。
 * @param chat 注入的对话函数（生产用 llm.js 的 chatCompletion；测试传假的）
 * @returns {{engage:boolean, verdict:string|null, usage?:object, text?:string, ms:number}}
 */
export async function cheapWakeGate({
  entries = [], botName = '机器人', limit = 12, chat, log = () => {},
  aliases = [], selfId = '', selfNickname = ''
} = {}) {
  const t0 = Date.now();
  const messages = buildGateMessages({ botName, entries, limit, aliases, selfId, selfNickname });
  try {
    const r = await chat({ messages, temperature: 0, maxTokens: 16, thinking: 'off' });
    const text = String(r?.message?.content ?? '').trim();
    const verdict = parseGateVerdict(text);
    const ms = Date.now() - t0;
    if (verdict === 'skip') {
      log(`预判=不接（${text.slice(0, 20)}），跳过整轮；${ms}ms/${r?.usage?.total_tokens ?? '?'} token`);
      return { engage: false, verdict, usage: r?.usage, text, ms };
    }
    log(`预判=${verdict === 'reply' ? '接' : `看不懂(${text.slice(0, 12)})→按接处理`}；${ms}ms/${r?.usage?.total_tokens ?? '?'} token`);
    return { engage: true, verdict, usage: r?.usage, text, ms };
  } catch (error) {
    const ms = Date.now() - t0;
    log(`预判调用失败（${String(error?.message ?? error)}），按"接"处理`);   // fail-open
    return { engage: true, verdict: null, error: String(error?.message ?? error), ms };
  }
}
