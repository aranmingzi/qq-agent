// 语音通话里「说一句 → 想一句 → 回一句」的那一步。
//
// ── 为什么不用 #runAgent ───────────────────────────────────────────────
// `#runAgent`（src/orchestrator.js:825）是给 QQ 消息用的：它绑定 store、
// session、发送队列、工具循环、群聊上下文、主动消息、发送额度……
// 那套东西在打电话时全是负担：
//   · 提示词一万多字，模型要先读半天才轮到回答 → 延迟直接翻倍；
//   · 它会调工具（发表情、搜网页、点歌），电话里没人想等它搜网页；
//   · 它的输出是"发一条 QQ 消息"，而这里要的是"说一句话"。
// 所以通话走一条独立的、极窄的路径：一个精简提示词 + 一次模型调用。
// **这是本方案最重要的一条风险控制：不动 orchestrator。**
//
// ── 但要守住的东西 ────────────────────────────────────────────────────
// 1. 人设必须是同一个人。用 resolvePersona() 拿到的 roleText，
//    和 QQ 侧同源 —— 否则用户会觉得"打电话的是另一个人"。
// 2. **绝不静默**。前几轮反复修的都是同一类 bug：出错就不出声，
//    用户看到的是"它没理我"。这里任何异常都返回一句兜底的话。
// 3. 说出来的必须是"人话"：没有 Markdown、没有列表、没有括号里的动作描写。
//
// ── 纪律 ──────────────────────────────────────────────────────────────
// `chat` 可注入，所以测试里不需要网络、不需要 key、不会因为模型抽风而偶发失败。
import { mdToPlain } from './md-to-plain.js';

/** 模型彻底不可用时的兜底。宁可说一句"没听清"，也不能沉默。 */
export const FALLBACK_REPLY = '嗯…我这边刚走神了，你再说一遍？';

/** 空输入时的回应：用户可能只是咳嗽了一声。 */
export const EMPTY_INPUT_REPLY = '嗯？';

/** 打电话时固定追加在 system 里的说话规则。 */
export const VOICE_STYLE_RULES = [
  '你们正在打电话，不是在打字。',
  '说话要短：一次一到两句，能一句话说完就别说两句。',
  '用口语，不要书面语；不要分点、不要列表、不要标题、不要 Markdown。',
  '不要念自己的名字，不要说"作为AI"，不要播报"我收到你的消息了"这类客服话。',
  '不要描述动作或表情（不要写"（笑）""*点头*"这种），只说话。',
  '没听清就直说没听清，不要猜，也不要长篇解释。'
].join('\n');

/**
 * 组装通话用的 system 提示词。
 *
 * 刻意**不含** QQ 那一套：群成员名单、发送额度、表情包、工具清单、
 * 输出格式约定 —— 那些是"发消息"需要的，打电话时只会拖慢模型。
 */
export function buildVoiceSystemPrompt(persona = {}, options = {}) {
  const name = String(persona?.botName ?? '').trim();
  const role = String(persona?.roleText ?? '').trim();
  const extra = String(persona?.customRules ?? '').trim();

  const parts = [];
  if (name) parts.push(`你叫${name}。`);
  if (role) parts.push(role);
  if (extra) parts.push(extra);
  parts.push(VOICE_STYLE_RULES);

  // 用户可以在设置里再补一句（比如方言、语速习惯）。空的不占位。
  const userStyle = String(options.extraStyle ?? '').trim();
  if (userStyle) parts.push(userStyle);

  return parts.join('\n\n');
}

/**
 * 把模型输出收拾成"能念出来的一句话"。
 *
 * 顺序有讲究：
 *   ① 先去 Markdown（mdToPlain 会把 `**` 剥掉、把列表变成 •）；
 *   ② 再把换行折叠成空格 —— 念出来的文本里换行没有意义，
 *      但留着会让某些 TTS 在换行处停顿得很奇怪；
 *   ③ 去掉句首的「名字：」前缀（模型很爱写「小雅：你好呀」）；
 *   ④ 去掉成对的括号动作描写；
 *   ⑤ 最后才截断，这样不会把 Markdown 符号截一半留在里面。
 */
export function sanitizeSpoken(text, maxChars = 120) {
  let s = String(text ?? '');
  if (!s.trim()) return '';

  s = mdToPlain(s);
  s = s.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // 「小雅：」「我：」这类前缀
  s = s.replace(/^[^\s：:]{1,12}[：:]\s*/, '').trim();
  // 括号里的动作/表情描写：（笑）（小声）[叹气]【停顿】*点头*
  // 方括号和圆括号都要管 —— 只处理圆括号的话，模型写「[叹气] 好吧」
  // 就会被 TTS 念成"叹气 好吧"。
  s = s.replace(/[（(][^（()）]{1,20}[)）]/g, '');
  s = s.replace(/[\[［【][^\[\]［］【】]{1,20}[\]］】]/g, '');
  s = s.replace(/[*＊][^*＊]{1,20}[*＊]/g, '');
  // 残留的成对 Markdown 记号（mdToPlain 只处理成对的，落单的会留下）
  s = s.replace(/\*{2,}|~{2,}|_{2,}/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  // 只有符号、没有任何可念的字 → 当作空。否则 TTS 会念出"星号星号"或者干脆静音。
  if (!/[\p{L}\p{N}]/u.test(s)) return '';

  const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 120;
  if (s.length > limit) {
    // 尽量在标点处断，别把一句话切成半个词。
    const head = s.slice(0, limit);
    const cut = Math.max(
      head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf('；'),
      head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf(',')
    );
    // 断点太靠前（剩下不到一半）就别硬断，直接截。
    s = cut >= Math.floor(limit / 2) ? head.slice(0, cut + 1) : `${head.replace(/[，、；,;\s]+$/, '')}…`;
  }
  return s.trim();
}

/** 默认的模型调用：走降级链，返回纯文本。 */
async function defaultChat({ messages, maxTokens, temperature, signal }) {
  const { buildFallbackChain, chatCompletionWithFallback } = await import('./model-fallback.js');
  const chain = buildFallbackChain({});
  const result = await chatCompletionWithFallback({
    chain,
    messages,
    maxTokens,
    temperature,
    thinking: 'off',   // 打电话等不起思考过程
    signal
  });
  return String(result?.message?.content ?? '');
}

/** 把对话历史裁到最近 N 轮，并且只保留 user/assistant 两种角色。 */
function trimHistory(history, historyTurns) {
  const list = Array.isArray(history) ? history : [];
  const clean = list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content ?? '') }))
    .filter((m) => m.content.trim() !== '');
  const turns = Number(historyTurns) > 0 ? Math.floor(Number(historyTurns)) : 12;
  const keep = turns * 2;             // 一轮 = 一问一答
  return clean.length > keep ? clean.slice(clean.length - keep) : clean;
}

/**
 * 跑一轮语音对话。
 *
 * @param {object} args
 * @param {string} args.text            识别出来用户说的话
 * @param {Array<{role:string,content:string}>} [args.history]  之前的对话（不含本轮）
 * @param {object} [args.persona]       resolvePersona() 给的 persona
 * @param {(args:object)=>Promise<string>} [args.chat]  注入点，测试用
 * @param {number} [args.maxChars=120]
 * @param {number} [args.historyTurns=12]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{reply:string, usedModel:boolean, empty?:boolean, failed?:boolean, truncated?:boolean, error?:string}>}
 *
 * 契约：**永不抛异常**。任何失败都变成一句能念出来的兜底话。
 */
export async function runVoiceTurn({
  text = '',
  history = [],
  persona = {},
  chat = defaultChat,
  maxChars = 120,
  historyTurns = 12,
  signal = null
} = {}) {
  const said = String(text ?? '').trim();
  if (!said) {
    // 用户没说出内容（可能只是咳了一声）。回一句轻轻的确认，不要沉默也不要长篇。
    return { reply: EMPTY_INPUT_REPLY, usedModel: false, empty: true };
  }

  const messages = [
    { role: 'system', content: buildVoiceSystemPrompt(persona) },
    ...trimHistory(history, historyTurns),
    { role: 'user', content: said }
  ];

  let raw = '';
  try {
    raw = await chat({ messages, maxTokens: 320, temperature: 0.7, signal });
  } catch (error) {
    const message = String(error?.message ?? error ?? '');
    // 用户主动挂断：这不是"故障"，安静地结束。
    if (error?.name === 'AbortError') {
      return { reply: '', usedModel: false, failed: true, error: 'aborted' };
    }
    return { reply: FALLBACK_REPLY, usedModel: false, failed: true, error: message };
  }

  const reply = sanitizeSpoken(raw, maxChars);
  if (!reply) {
    // 模型返回空字符串（真实发生过：被安全策略拦掉、或者只回了空白）。
    // 这时沉默是最差的选择 —— 用户会以为断线了。
    return { reply: FALLBACK_REPLY, usedModel: true, failed: true, error: 'empty-reply' };
  }

  const limit = Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : 120;
  const cleanedRaw = sanitizeSpoken(raw, Number.MAX_SAFE_INTEGER);
  return { reply, usedModel: true, truncated: cleanedRaw.length > limit };
}
