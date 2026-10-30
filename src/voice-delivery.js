/**
 * 「按语境换语气」——把**情绪**翻译成一次语音合成的**表演参数**。
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 原来 `send_voice` 只有一个自由文本参数 `style`：模型爱写什么写什么，写到什么算什么。
 * 结果是三件事同时发生：
 *   ① 同一个音色在开心、难过、生气时听起来一模一样（"永远一个调"）；
 *   ② 流萤明明有 6 条情绪参考音频，却几乎从没被真正切过 —— 因为模型不知道
 *      "参考音频标签"长什么样，它只会写"温柔一点"；
 *   ③ 千问兜底（cosyvoice）只认固定句式 `你说话的情感是xxx。`，自由描述会被
 *      归一化成 happy —— 于是"语气指令"在兜底链上等于不存在。
 *
 * ── 为什么是"查表"而不是"再写一句提示词" ──────────────────────────────────
 * 看了几个开源 TTS 的做法后确认，业界通行的是**情绪标签 → 参考音频 / 韵律参数**
 * 的结构化映射，而不是把情绪塞进自由文本：
 *   · GPT-SoVITS 官方理念：由参考音频的"情感、音色、语速"控制合成的情感、音色、语速
 *     —— 情绪由"选哪条参考音频"承载（github.com/kekewolf/GPT-SoVITS）。
 *   · vits-simple-api 的参考音频 preset：按名字预配多组参考音频，调用时按 preset 切换
 *     —— 就是本文件这张表在服务端的样子（github.com/zwssunny/vits-simple-api）。
 *   · EmotiVoice：`<speaker_id>|<emotion_prompt>|<phoneme>|<text>`，情绪提示与文本**分离**。
 *   · ChatTTS：面向对话的细粒度韵律（笑声、停顿、插入语）。
 * 所以这里把"情绪"做成一等公民：一个情绪 = 一条参考音频标签 + 一组韵律参数 + 一句
 * 给模型看的写法提示。自由文本 `style` 仍然保留，但降级成"补充说明"。
 *
 * ── 三条设计铁律 ──────────────────────────────────────────────────────────
 * 1. **零 I/O、纯函数**：不读配置、不读文件、不 import 别的大模块。
 *    音色支持哪些参考音频由调用方传进来（`availableRefs`），这样单测不需要起服务。
 * 2. **可一键回到原样**：`enabled=false` 或 `strength=0` 时，产出的 plan 必须与
 *    "没有情绪"完全等价（bias=1、参数=api_v2 默认值、line 为空）。回滚不改代码。
 * 3. **脏输入不出 NaN**：情绪名、强度、基准分都可能是手改配置或老档里的怪值，
 *    一律兜底成安全值 —— 一条语音合成失败不该让整轮对话哑掉。
 */

/**
 * GPT-SoVITS 参考音频的 6 个情绪标签（= `GSV_VOICES[*].emotions` 的键）。
 * 顺序按"从热到冷"排，日志和控制台都按这个顺序展示。
 */
export const GSV_TAGS = Object.freeze(['开心', '生气', '难过', '吃惊', '恐惧', '中立']);

/**
 * 韵律参数的安全区间。取的是"能听出差别但不至于爆音/破音"的保守范围：
 *   temperature 太低（<0.85）会咬字发死，太高（>1.10）会飘、会跳字；
 *   top_k 太小（<10）念错字的概率明显上升，太大（>20）等于没设；
 *   fragment_interval 是"句间停顿"，0.20 已经偏赶、0.40 已经偏慢。
 */
export const PARAM_BOUNDS = Object.freeze({
  temperature: [0.85, 1.10],
  topK: [10, 20],
  topP: [0.9, 1.0],
  fragmentInterval: [0.2, 0.4],
  repetitionPenalty: [1.25, 1.45]
});

/** api_v2.py 的默认参数 —— "没有情绪"就等于这一组，保证可回滚。 */
export const NEUTRAL_PARAMS = Object.freeze({
  temperature: 1.0,
  topK: 15,
  topP: 1.0,
  fragmentInterval: 0.3,
  repetitionPenalty: 1.35
});

/**
 * 情绪 → 表演参数。14 种来自 vibe.js 的 EMOTIONS，外加 2 个 GSV 独有标签
 * （吃惊/恐惧：vibe 不用它们，但模型显式点名时要能落地）。
 *
 * 字段说明：
 *   gsv          → 落到 6 个参考音频标签之一（没有该标签的音色自动降级成参数模式）
 *   cosyvoice    → 落到 COSYVOICE_EMOTIONS 之一（避免被归一化成 happy 兜底）
 *   speedBias    → 相对音色基准的语速乘数（不是替换！见 prosody.js 的铁律）
 *   params       → 下发给 api_v2 的韵律参数
 *   line         → 给模型/兜底 TTS 看的一句"怎么念"
 *   textHint     → 写这段文本时该注意什么（进提示词的速查表）
 */
export const TONE_TABLE = Object.freeze({
  开心: {
    gsv: '开心', cosyvoice: 'happy', speedBias: 1.06,
    params: { temperature: 1.02, topK: 16, topP: 0.98, fragmentInterval: 0.28, repetitionPenalty: 1.32 },
    line: '轻快一点，尾音往上翘，带点笑',
    textHint: '短句，可以有"呀/啦/嘿嘿"这种尾巴'
  },
  兴奋: {
    gsv: '开心', cosyvoice: 'happy', speedBias: 1.10,
    params: { temperature: 1.06, topK: 18, topP: 0.95, fragmentInterval: 0.22, repetitionPenalty: 1.30 },
    line: '语速快，气别憋着，连着说也不怕',
    textHint: '两三个短句连着，感叹号可以有'
  },
  得意: {
    gsv: '开心', cosyvoice: 'happy', speedBias: 1.04,
    params: { temperature: 1.05, topK: 17, topP: 0.97, fragmentInterval: 0.26, repetitionPenalty: 1.32 },
    line: '尾巴翘起来，故意拖一下再收',
    textHint: '可以先"哼哼"一声再说话'
  },
  好奇: {
    gsv: '开心', cosyvoice: 'happy', speedBias: 1.03,
    params: { temperature: 1.03, topK: 16, topP: 0.98, fragmentInterval: 0.27, repetitionPenalty: 1.33 },
    line: '句尾轻轻提起来，像在追问',
    textHint: '多问半句，别把话说满'
  },
  害羞: {
    gsv: '中立', cosyvoice: 'neutral', speedBias: 0.97,
    params: { temperature: 0.95, topK: 14, topP: 1.0, fragmentInterval: 0.34, repetitionPenalty: 1.36 },
    line: '声音收一点，说一半停一下',
    textHint: '句子短，可以用省略号收尾'
  },
  别扭: {
    gsv: '生气', cosyvoice: 'angry', speedBias: 0.99,
    params: { temperature: 0.96, topK: 13, topP: 1.0, fragmentInterval: 0.32, repetitionPenalty: 1.36 },
    line: '有点别扭，话里带刺但别真凶',
    textHint: '句子短，别解释太多'
  },
  委屈: {
    gsv: '难过', cosyvoice: 'sad', speedBias: 0.93,
    params: { temperature: 0.92, topK: 12, topP: 1.0, fragmentInterval: 0.36, repetitionPenalty: 1.38 },
    line: '声音往下掉一点，带点鼻音，别哭腔',
    textHint: '字少，允许停顿和省略号'
  },
  失落: {
    gsv: '难过', cosyvoice: 'sad', speedBias: 0.90,
    params: { temperature: 0.90, topK: 12, topP: 1.0, fragmentInterval: 0.38, repetitionPenalty: 1.38 },
    line: '慢一点、轻一点，句子别长',
    textHint: '一句就够，别硬撑着多说'
  },
  没劲: {
    gsv: '中立', cosyvoice: 'neutral', speedBias: 0.90,
    params: { temperature: 0.93, topK: 13, topP: 1.0, fragmentInterval: 0.38, repetitionPenalty: 1.37 },
    line: '懒懒的，字与字之间松一点',
    textHint: '短句，允许"嗯…""随便吧"'
  },
  嫌弃: {
    gsv: '生气', cosyvoice: 'angry', speedBias: 0.98,
    params: { temperature: 0.97, topK: 13, topP: 1.0, fragmentInterval: 0.30, repetitionPenalty: 1.35 },
    line: '撇一下嘴那种嫌弃，不是发火',
    textHint: '一个短句就够，尾音往下压'
  },
  假生气: {
    gsv: '生气', cosyvoice: 'angry', speedBias: 1.00,
    params: { temperature: 1.0, topK: 15, topP: 1.0, fragmentInterval: 0.29, repetitionPenalty: 1.33 },
    line: '装凶，气音多一点，别真的冷下来',
    textHint: '短促，可以叠感叹'
  },
  心疼: {
    gsv: '难过', cosyvoice: 'sad', speedBias: 0.92,
    params: { temperature: 0.92, topK: 12, topP: 1.0, fragmentInterval: 0.36, repetitionPenalty: 1.36 },
    line: '软下来，慢慢说，像在旁边',
    textHint: '句子短，别讲道理'
  },
  累: {
    gsv: '中立', cosyvoice: 'neutral', speedBias: 0.88,
    params: { temperature: 0.94, topK: 12, topP: 1.0, fragmentInterval: 0.40, repetitionPenalty: 1.38 },
    line: '气短一点，句尾别抬，慢',
    textHint: '一两句就收'
  },
  平静: {
    gsv: '中立', cosyvoice: 'neutral', speedBias: 0.95,
    params: { temperature: 1.0, topK: 15, topP: 1.0, fragmentInterval: 0.30, repetitionPenalty: 1.35 },
    line: '正常说话，不用刻意加情绪',
    textHint: '正常长度即可'
  },
  // ── 以下两个不在 vibe.EMOTIONS 里，但模型可以显式点名（"用惊讶的语气说"）──
  吃惊: {
    gsv: '吃惊', cosyvoice: 'surprised', speedBias: 1.05,
    params: { temperature: 1.04, topK: 17, topP: 0.97, fragmentInterval: 0.24, repetitionPenalty: 1.32 },
    line: '提气，前半句往上冲，尾音顿住',
    textHint: '一句就够，别解释'
  },
  恐惧: {
    gsv: '恐惧', cosyvoice: 'fearful', speedBias: 0.95,
    params: { temperature: 0.95, topK: 14, topP: 1.0, fragmentInterval: 0.34, repetitionPenalty: 1.36 },
    line: '气不稳，声音发紧，别喊',
    textHint: '短句，允许断'
  }
});

/** 情绪名的合法集合（表里的键）。 */
export const TONE_NAMES = Object.freeze(Object.keys(TONE_TABLE));

/** 没有情绪时用的那一档（中性 = 平静）。 */
const NEUTRAL_TONE = '平静';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 情绪强度：把"偏一点"折算成 strength 的乘性修正。
 * 底色分（mood.score）低的时候，同样的"开心"要收敛一点 —— 否则会演出
 * "刚被人怼完还笑得跟没事一样"的分裂感；底色高的时候反过来。
 * @returns {-1|0|1} 负向 / 中性 / 正向
 */
function moodLean(moodScore) {
  const n = num(moodScore, 50);
  if (n <= 39) return -1;
  if (n >= 71) return 1;
  return 0;
}

/**
 * 把情绪解析成一次合成的表演参数。
 *
 * @param {object} p
 * @param {string} [p.emotion]        情绪名（TONE_NAMES 之一）；'auto'/空 = 用 vibe 的情绪
 * @param {string} [p.vibeEmotion]    vibe.js 给出的此刻情绪（emotion 为空时的来源）
 * @param {string} [p.voice]          音色 key（只用于回填 plan.voice）
 * @param {string[]} [p.availableRefs] 该音色实际拥有的参考音频标签（决定 ref/param 模式）
 * @param {number} [p.moodScore]      底色分 20~90（缺省 50）
 * @param {number} [p.strength]       0~1.5；0 = 完全按老样子
 * @param {boolean} [p.enabled]       false = 整条链路关闭
 * @returns {{emotion:string, gsv:string, cosyvoice:string, speedBias:number,
 *   strength:number, params:object, line:string, textHint:string,
 *   mode:'ref'|'param', enabled:boolean, voice:string, lean:number}}
 */
export function resolveTone({
  emotion = '',
  vibeEmotion = '',
  voice = '',
  availableRefs = [],
  moodScore = 50,
  strength = 1,
  enabled = true
} = {}) {
  const wantRaw = String(emotion ?? '').trim();
  const auto = !wantRaw || wantRaw === 'auto' || wantRaw === 'default';
  // 显式给了但不认识（"无语"/"emm"）→ 先试着从自由文本里猜一个；
  // 还是猜不出就落到中性档并且**不启用**（宁可维持原样，也不瞎演一个情绪）。
  const picked = auto
    ? String(vibeEmotion ?? '').trim()
    : (Object.prototype.hasOwnProperty.call(TONE_TABLE, wantRaw) ? wantRaw : guessTone(wantRaw));
  const known = Object.prototype.hasOwnProperty.call(TONE_TABLE, picked);
  const name = known ? picked : NEUTRAL_TONE;
  const entry = TONE_TABLE[name];

  const on = enabled !== false && known;
  // 强度：非法/负数 → 0（等于没开），超过 1.5 压回 1.5（再高就是夸张了）
  const s = on ? clamp(num(strength, 1), 0, 1.5) : 0;
  // 强度为 0 时连参考音频都不该换——"关掉就是原样"，不能只把参数调回默认。
  const active = on && s > 0;

  // 底色偏置：只动 20% 的力度，够听出来、不至于改掉情绪本身。
  const lean = on ? moodLean(moodScore) : 0;
  const leanScale = 1 + lean * 0.2;

  // 语速偏置：1 + (目标-1) × 强度，再夹进 prosody 的乘数区间
  const rawBias = 1 + (entry.speedBias - 1) * s * leanScale;
  const speedBias = Number(clamp(num(rawBias, 1), 0.8, 1.2).toFixed(3));

  // 韵律参数：从 api_v2 默认值往目标值插值，强度 0 时正好等于默认值
  const params = {};
  for (const [k, target] of Object.entries(entry.params)) {
    const base = NEUTRAL_PARAMS[k];
    const [lo, hi] = PARAM_BOUNDS[k] || [-Infinity, Infinity];
    const v = base + (num(target, base) - base) * s * leanScale;
    // temperature / topP / repetitionPenalty 保留 3 位，topK 取整
    params[k] = k === 'topK' ? Math.round(clamp(v, lo, hi)) : Number(clamp(v, lo, hi).toFixed(3));
  }

  const refs = Array.isArray(availableRefs) ? availableRefs.map((x) => String(x)) : [];
  const mode = active && refs.includes(entry.gsv) ? 'ref' : 'param';

  return {
    emotion: active ? name : '',
    gsv: entry.gsv,
    cosyvoice: entry.cosyvoice,
    speedBias,
    strength: s,
    params,
    line: active ? entry.line : '',
    textHint: active ? entry.textHint : '',
    mode,
    enabled: active,
    voice: String(voice ?? ''),
    lean
  };
}

/**
 * 给提示词用的一句话（没有情绪就返回空串 —— 空着比说"你现在没情绪"更像人）。
 * @param {object} plan resolveTone 的返回值
 */
export function formatToneHint(plan) {
  if (!plan?.enabled || !plan.emotion) return '';
  const bits = [`【此刻的语气】${plan.emotion}——${plan.line}。`];
  bits.push(`发语音时把 emotion 填成「${plan.emotion}」`);
  if (plan.textHint) bits.push(`，文本${plan.textHint}`);
  return `${bits.join('')}。`;
}

/** 给日志用的一行（排查"改了语气听感没变"时能一眼对上用了什么）。 */
export function describeTone(plan) {
  if (!plan) return '语气=（无）';
  if (!plan.enabled) return '语气=关（按老样子）';
  const p = plan.params || {};
  const params = `temp=${p.temperature} topK=${p.topK} topP=${p.topP} frag=${p.fragmentInterval} rep=${p.repetitionPenalty}`;
  return `语气=${plan.emotion}/gsv=${plan.gsv}/cosy=${plan.cosyvoice} 语速偏置×${plan.speedBias} 强度=${plan.strength} 模式=${plan.mode} ${params}`;
}

/**
 * 某个音色的情绪覆盖情况：哪些情绪能真正换参考音频、哪些只能靠参数。
 * 控制台用它画 chips，避免"选了流萤却以为胡桃也有 6 档"。
 * @param {string} voiceKey
 * @param {string[]} availableRefs
 */
export function toneCoverage(voiceKey, availableRefs = []) {
  const refs = new Set(Array.isArray(availableRefs) ? availableRefs.map((x) => String(x)) : []);
  const refEmotions = [];
  const paramOnly = [];
  for (const name of TONE_NAMES) {
    if (refs.has(TONE_TABLE[name].gsv)) refEmotions.push(name);
    else paramOnly.push(name);
  }
  return { voice: String(voiceKey ?? ''), refEmotions, paramOnly, tags: [...refs] };
}

/**
 * 反向查：某个参考音频标签对应哪些情绪（日志/控制台展示用）。
 * @param {string} tag
 */
export function emotionsOfTag(tag) {
  const t = String(tag ?? '');
  return TONE_NAMES.filter((n) => TONE_TABLE[n].gsv === t);
}

/**
 * 从一段自由文本里猜情绪（`style` 参数仍被模型大量使用时的兜底）。
 * 只做"能不能对上表里的键"这一件事；对不上就返回空串，交给中性档。
 * @param {string} text
 */
export function guessTone(text) {
  const s = String(text ?? '');
  if (!s) return '';
  // 直接命中情绪名优先（"有点失落" 里含"失落"）
  for (const name of TONE_NAMES) {
    if (s.includes(name)) return name;
  }
  // 别名必须映射到 TONE_NAMES 里的**真实键**，否则 resolveTone 会判定"不认识"
  // 而退化成中性 —— 模型写「有点伤心」时不该什么反应都没有。
  // 注意「生气」不是表里的键（表里是更细的「假生气」），这里显式折过去。
  const alias = [
    ['开心', /开心|高兴|愉快|欢快|笑|甜|撒娇|俏皮|活泼/],
    ['失落', /难过|伤心|悲伤|沮丧|低落|遗憾/],
    ['假生气', /生气|愤怒|恼火|火大|凶|警告/],
    ['吃惊', /吃惊|惊讶|震惊|意外|吓一跳/],
    ['恐惧', /恐惧|害怕|紧张|不安|慌/],
    ['平静', /平静|中立|普通|平淡|认真|严肃|正常/]
  ];
  for (const [name, re] of alias) {
    if (re.test(s)) return name;
  }
  return '';
}
