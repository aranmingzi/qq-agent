// Qwen 语音合成（TTS）—— 和 qwen-vision.js 用同一套 DashScope 凭据，纯 Node HTTP，不需要 Python。
//
// 接口契约（来自 qianwen-audio-tts 技能）：
//   · qwen-audio-3.0-tts-*（NRT） → POST {base}/services/audio/tts/SpeechSynthesizer
//        body: { model, input: { text, voice, format, sample_rate } }
//   · qwen3-tts-*                 → POST {base}/services/aigc/multimodal-generation/generation
//        body: { model, input: { text, voice } }
//   两者都返回 output.audio.url（24 小时有效）→ 需要自己下载成音频文件。
//
// 凭据优先级：audio.apiKey > vision.qwen.apiKey > 环境变量（DASHSCOPE_API_KEY / QIANWEN_API_KEY）。
// 也就是说：只要"识图"那把 Qwen key 已经在配置里，语音开箱可用，不用再申请一把。
import { getConfig } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';

export const NATIVE_BASE = 'https://dashscope.aliyuncs.com/api/v1';
export const NRT_PATH = '/services/audio/tts/SpeechSynthesizer';
export const QWEN3_PATH = '/services/aigc/multimodal-generation/generation';
export const DEFAULT_MODEL = 'qwen-audio-3.0-tts-plus';
const NRT_DEFAULT_VOICES = {
  'qwen-audio-3.0-tts-plus': 'longanlingxin',
  'qwen-audio-3.0-tts-flash': 'longanhuan_v3.6'
};
const QWEN3_DEFAULT_VOICE = 'Cherry';
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

// ── CosyVoice（cosyvoice-v3-* / cosyvoice-v2）─────────────────────────
// 2026-10-20 故障：把 audio.model 换成 cosyvoice-v3-flash 后语音全哑，接口只回一句
// `[cosyvoice:]Engine return error code: 418`。两个坑叠在一起，都不是网络问题：
//
//  ① **音色不通用**。CosyVoice 只认自己那套（longanhuan / longanyang / longanhuan_v3…），
//     而 qwen-audio 系列的 longanlingxin 传过去 → 引擎报 418。
//     注意 `[cosyvoice:]` 冒号后面是空的，就是引擎没能解析出音色名的样子。
//  ② **instruction 是固定句式，不是自由描述**。实测（同一把 key，2026-10-20）：
//        ✓ 你说话的情感是neutral。        ← 无空格 + 中文句号
//        ✗ 你说话的情感是 neutral。        ← 多了个半角空格
//        ✗ 你说话的情感是neutral.          ← 英文句号
//        ✗ 你正在进行闲聊互动，你说话的情感是happy。   ← 官方文档里的组合句式，这条 HTTP 路径不认
//        ✓ 请用山东话表达。
//     qwen-audio 系列能吃自由描述（"像真人在QQ上发语音聊天…"），CosyVoice 吃不了，
//     而且**整个请求会失败** —— 语气微调不该换掉一次完整的语音。
//     所以下面把自由描述归一化成合法句式；认不出来的情绪落到 happy（欢脱），
//     与默认音色 longanhuan（欢脱元气女）一致。
const COSYVOICE_VOICES = {
  'cosyvoice-v3-flash': 'longanhuan',
  'cosyvoice-v3-plus': 'longanhuan_v3',
  'cosyvoice-v2': 'longxiaochun_v2'
};
/** 认不出的 cosyvoice-* 型号时的兜底音色（v3 系列通用）。 */
const COSYVOICE_FALLBACK_VOICE = 'longanhuan';
/** CosyVoice 支持的 7 个情感值（官方列表）。 */
export const COSYVOICE_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'];
/** 自由描述里出现这些词就映射到对应情感；都不命中则 happy。 */
const EMOTION_HINTS = [
  ['sad', /难过|失落|委屈|低落|伤心|哭|沮丧/],
  ['angry', /生气|恼|火大|愤怒|凶/],
  ['surprised', /惊讶|吃惊|震惊|意外/],
  ['fearful', /害怕|紧张|恐惧|慌/],
  ['disgusted', /嫌弃|厌恶|恶心|反感/],
  ['neutral', /平静|中性|正常|平淡|冷静/],
  ['happy', /开心|高兴|雀跃|俏皮|活泼|欢快|兴奋|笑|甜|撒娇/]
];

// ── 语音识别（ASR）────────────────────────────────────────────────
// 实测可用：compatible-mode 的 /chat/completions + input_audio（data URI），模型 qwen3-omni-flash。
// wav / mp3 都认；返回的就是转写文字。
export const ASR_PATH = '/chat/completions';
export const DEFAULT_ASR_MODEL = 'qwen3-omni-flash';
export const DEFAULT_ASR_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_ASR_PROMPT = '把这段语音逐字转成中文文字，只输出文字本身；听不清的地方用「？」代替，不要编造。';

const FORMAT_MIME = { wav: 'wav', mp3: 'mpeg', m4a: 'mp4', mp4: 'mp4', ogg: 'ogg', flac: 'flac', amr: 'amr', aac: 'aac' };

export function isQwen3Tts(model) {
  return String(model || '').trim().startsWith('qwen3-tts-');
}

/** CosyVoice 系列（音色规则、instruction 语法都与 qwen-audio 系列不同）。 */
export function isCosyvoice(model) {
  return /^cosyvoice-/i.test(String(model || '').trim());
}

/** 音色：显式指定优先；否则按模型给默认（三个系列的默认音色互不通用）。 */
export function resolveVoice(model, voice = '') {
  const v = String(voice || '').trim();
  if (v) return v;
  const m = String(model || '').trim();
  if (NRT_DEFAULT_VOICES[m]) return NRT_DEFAULT_VOICES[m];
  if (isCosyvoice(m)) return COSYVOICE_VOICES[m] || COSYVOICE_FALLBACK_VOICE;
  return isQwen3Tts(m) ? QWEN3_DEFAULT_VOICE : 'longanlingxin';
}

/**
 * 这个音色像不像 CosyVoice 的？
 *
 * 只用来**提示**，不用来拦截 —— 用户可能有声音复刻/声音设计的自定义音色，
 * 那些不在系统音色表里但照样合法。判据是"带 _v2/_v3 后缀"或"在 v3 标杆名单里"。
 */
const COSYVOICE_KNOWN_VOICES = ['longanhuan', 'longanyang', 'longanhuan_v3', 'longhuhu_v3', 'longpaopao_v3', 'longxiaochun_v3'];
export function looksLikeCosyvoiceVoice(voice) {
  const v = String(voice || '').trim();
  if (!v) return false;
  return /_v\d(\.\d)?$/i.test(v) || COSYVOICE_KNOWN_VOICES.includes(v);
}

/**
 * 把一句自由描述归一化成 CosyVoice 认得的 instruction。
 *
 * 三条硬约束（都来自 2026-10-20 的实测，不是猜的）：中文句号结尾、句中不能有半角空格、
 * 只支持单一句式（"场景+情感"的组合句式在这条 HTTP 路径上会 428）。
 *
 * @returns {{instruction:string, changed:boolean, emotion:string}}
 */
export function normalizeCosyvoiceInstruction(instruction = '') {
  const raw = String(instruction ?? '').trim();
  const pickEmotion = () => {
    const hit = EMOTION_HINTS.find(([, re]) => re.test(raw));
    return hit ? hit[0] : 'happy';
  };
  if (!raw) return { instruction: '', changed: false, emotion: 'happy' };

  // ① 方言句式本身就是合法的，原样放行（"请用山东话表达。"）
  if (/^请用[^。]{1,10}表达。$/.test(raw)) {
    return { instruction: raw, changed: false, emotion: 'neutral' };
  }

  // ② 情感句式：抽出情感值，其余一律重建 —— 不试图"修"用户那句，因为
  //    空格/标点错一个字符就 428，重建比修补可靠。
  const m = raw.match(/你说话的情感是\s*([A-Za-z]+)\s*[。.]?/);
  const candidate = m ? String(m[1]).toLowerCase() : '';
  const emotion = COSYVOICE_EMOTIONS.includes(candidate) ? candidate : pickEmotion();
  const rebuilt = `你说话的情感是${emotion}。`;
  return { instruction: rebuilt, changed: rebuilt !== raw, emotion };
}

/**
 * CosyVoice 的引擎错误码翻译成人话。
 *
 * 原始提示只有 `[cosyvoice:]Engine return error code: 418`，既不说哪个参数错，
 * 也不说该改成什么 —— 换模型时撞上就只能靠猜。这里补上归因和建议。
 */
export function explainCosyvoiceError(message, { model = '', voice = '', instruction = '' } = {}) {
  const msg = String(message ?? '');
  if (!isCosyvoice(model)) return msg;
  if (/error code:\s*418/.test(msg)) {
    return `${msg}｜音色「${voice || '(空)'}」不属于模型 ${model}：CosyVoice 与 qwen-audio 的音色互不通用，`
      + `可用 longanhuan / longanyang 等（见 help.aliyun.com/model-studio/cosyvoice-voice-list）`;
  }
  if (/error code:\s*428/.test(msg)) {
    const tail = String(instruction || '').trim();
    return `${msg}｜instruction 句式不合法：只接受「你说话的情感是happy。」或「请用山东话表达。」这类单句，`
      + `要求中文句号且句中不能有半角空格${tail ? `；当前传的是 ${JSON.stringify(tail.slice(0, 60))}` : '（本次没传 instruction，请检查 voice/format）'}`;
  }
  return msg;
}

/** 语音配置：apiKey 缺省沿用识图那把 DashScope key。 */
export function qwenAudioConfig(raw = null) {
  const cfg = getConfig();
  const current = raw || cfg.audio || {};
  const qwen = cfg.vision?.qwen || {};
  const envKey = process.env.DASHSCOPE_API_KEY || process.env.QIANWEN_API_KEY || '';
  const apiKey = String(current.apiKey || '').trim() || String(qwen.apiKey || '').trim() || String(envKey).trim();
  return {
    enabled: current.enabled !== false,
    baseUrl: String(current.baseUrl || NATIVE_BASE).replace(/\/+$/, ''),
    apiKey,
    keySource: current.apiKey ? 'config.audio' : (qwen.apiKey ? 'config.vision.qwen' : (envKey ? 'env' : '')),
    model: String(current.model || DEFAULT_MODEL).trim(),
    voice: String(current.voice || '').trim(),
    format: String(current.format || 'mp3').trim(),
    instruction: String(current.instruction || '').trim(),
    maxChars: Math.max(10, Math.min(600, Number(current.maxChars) || 150)),
    // 角色本音：实际发声音色的唯一真相源（设置 → 语音音色 → 角色本音）
    voiceKey: String(current.gsvVoice || 'hutao').trim().toLowerCase(),
    // 是否允许模型在单次回复里用 args.voice 临时换音色；默认 false（设置说了算）
    allowModelPick: current.gsvAllowModelPick === true,
    timeoutMs: Math.max(5000, Number(current.timeoutMs) || 60000),
    sendAsBase64: current.sendAsBase64 === true
  };
}

export function qwenAudioInfo(raw = null) {
  const c = qwenAudioConfig(raw);
  return { enabled: c.enabled, model: c.model, voice: resolveVoice(c.model, c.voice), hasKey: !!c.apiKey, keySource: c.keySource };
}

/** 语音识别配置（默认沿用同一把 DashScope Key）。 */
export function qwenAsrConfig(raw = null) {
  const cfg = getConfig();
  const current = raw || (cfg.audio && cfg.audio.asr) || {};
  const base = qwenAudioConfig();
  return {
    enabled: base.enabled && current.enabled !== false,
    baseUrl: String(current.baseUrl || DEFAULT_ASR_BASE).replace(/\/+$/, ''),
    apiKey: base.apiKey,
    model: String(current.model || DEFAULT_ASR_MODEL).trim(),
    prompt: String(current.prompt || DEFAULT_ASR_PROMPT),
    maxBytes: Math.max(64 * 1024, Number(current.maxBytes) || MAX_AUDIO_BYTES),
    timeoutMs: base.timeoutMs
  };
}

export function qwenAsrInfo(raw = null) {
  const c = qwenAsrConfig(raw);
  return { enabled: c.enabled, model: c.model, baseUrl: c.baseUrl, hasKey: !!c.apiKey };
}

/** 纯函数：ASR 请求体（便于断言）。 */
export function buildAsrRequest({ dataUri = '', format = 'mp3', model = DEFAULT_ASR_MODEL, prompt = DEFAULT_ASR_PROMPT } = {}) {
  return {
    path: ASR_PATH,
    payload: {
      model: String(model || DEFAULT_ASR_MODEL),
      messages: [{
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: String(dataUri), format: String(format) } },
          { type: 'text', text: String(prompt || DEFAULT_ASR_PROMPT) }
        ]
      }],
      max_tokens: 512
    }
  };
}

/** 把音频字节转成 ASR 用的 data URI。 */
export function audioDataUri(buffer, format = 'mp3') {
  const fmt = String(format || 'mp3').toLowerCase().replace(/^\./, '');
  const mime = FORMAT_MIME[fmt] || 'mpeg';
  return 'data:audio/' + mime + ';base64,' + Buffer.from(buffer || Buffer.alloc(0)).toString('base64');
}

/**
 * 语音转文字。
 * @param {{buffer:Buffer, format?:string, model?:string, prompt?:string}} opts
 * @returns {Promise<string>} 转写文本
 */
export async function transcribeSpeech({ buffer, format = 'mp3', model = null, prompt = null } = {}) {
  const cfg = qwenAsrConfig();
  if (!cfg.enabled) throw new Error('语音识别未开启（config.audio.asr.enabled=false）');
  if (!cfg.apiKey) throw new Error('没有可用的 DashScope Key：请先在 设置 → 模型 API → 识图 里填 Qwen Key');
  const buf = Buffer.from(buffer || Buffer.alloc(0));
  if (!buf.length) throw new Error('拿到的语音是空的');
  if (buf.length > cfg.maxBytes) throw new Error('语音文件过大（' + Math.round(buf.length / 1024) + 'KB），已拒绝识别');
  const dataUri = audioDataUri(buf, format);
  const { path: apiPath, payload } = buildAsrRequest({ dataUri, model: model || cfg.model, prompt: prompt || cfg.prompt });
  const res = await fetch(cfg.baseUrl + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || body?.code || ('HTTP ' + res.status);
    throw new Error('语音识别失败：' + String(msg).slice(0, 200));
  }
  const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('语音识别没有返回文字');
  return text;
}

/** 纯函数：按模型系列算出要请求的路径和 body（便于断言）。 */
export function buildTtsRequest({ text = '', model = DEFAULT_MODEL, voice = '', format = 'mp3', instruction = '' } = {}) {
  const m = String(model || '').trim() || DEFAULT_MODEL;
  const t = String(text ?? '');
  const v = resolveVoice(m, voice);
  const inst = String(instruction ?? '').trim();
  if (isQwen3Tts(m)) {
    const input = { text: t, voice: v };
    // qwen3-tts-instruct-*：用 instructions（复数）控制语气/情绪
    if (inst) {
      input.instructions = inst;
      input.optimize_instructions = true;
    }
    return { path: QWEN3_PATH, payload: { model: m, input } };
  }
  // CosyVoice：instruction 必须归一化成固定句式，否则整个请求 428（详见文件头注释）
  if (isCosyvoice(m)) {
    const input = { text: t, voice: v, format: String(format || 'mp3'), sample_rate: 24000 };
    const norm = normalizeCosyvoiceInstruction(inst);
    if (norm.instruction) input.instruction = norm.instruction;
    const notes = [];
    if (norm.changed) {
      notes.push(`CosyVoice 只接受固定句式，instruction 已从 ${JSON.stringify(inst.slice(0, 40))} 归一化为「${norm.instruction}」`);
    }
    return { path: NRT_PATH, payload: { model: m, input }, notes };
  }
  // qwen-audio-3.0-tts-*：用 instruction（单数）控制语气/语速/情绪
  const input = { text: t, voice: v, format: String(format || 'mp3'), sample_rate: 24000 };
  if (inst) input.instruction = inst;
  return { path: NRT_PATH, payload: { model: m, input } };
}

function extFromUrl(url, fallback = 'mp3') {
  const m = /\/download|[?&]file=/i.test(String(url)) ? null : String(url).match(/\.(wav|mp3|flac|ogg|pcm|aac)(?:$|[?#])/i);
  return m ? m[1].toLowerCase() : fallback;
}

/** 参数归一化的日志去重（同一句提示只打一次，避免每次发语音都刷屏）。 */
const warnedNotes = new Set();

/**
 * 合成一段语音，返回音频字节。
 * @returns {{buffer:Buffer, ext:string, audioUrl:string, model:string, voice:string, format:string, characters:number, truncated:boolean}}
 */
export async function synthesizeSpeech({ text, model = null, voice = null, format = null, instruction = null } = {}) {
  const cfg = qwenAudioConfig();
  if (!cfg.enabled) throw new Error('语音功能未开启（config.audio.enabled=false）');
  if (!cfg.apiKey) throw new Error('没有可用的 DashScope Key：请在 设置 → 模型 API → 识图 里填 Qwen Key，或配 audio.apiKey');
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('要说的内容是空的');
  const truncated = raw.length > cfg.maxChars;
  const finalText = truncated ? raw.slice(0, cfg.maxChars) : raw;
  const useModel = String(model || cfg.model);
  const useFormat = String(format || cfg.format || 'mp3');
  const useInstruction = String(instruction ?? cfg.instruction ?? '').trim();
  const { path: apiPath, payload, notes = [] } = buildTtsRequest({ text: finalText, model: useModel, voice: voice || cfg.voice, format: useFormat, instruction: useInstruction });
  // 归一化之类"改了用户给的参数"的事必须留痕：不然用户明明填了语气，听感却一成不变，
  // 会以为是自己没配对（本项目对"失败伪装成成功"的态度见 docs）。
  for (const note of notes) {
    if (warnedNotes.has(note)) continue;
    warnedNotes.add(note);
    try { console.warn('[voice] ' + note); } catch { /* 忽略 */ }
  }

  const res = await fetch(cfg.baseUrl + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.message || body?.error?.message || body?.code || ('HTTP ' + res.status);
    const pretty = explainCosyvoiceError(msg, {
      model: useModel,
      voice: payload?.input?.voice || '',
      instruction: payload?.input?.instruction || ''
    });
    throw new Error('语音合成失败：' + String(pretty).slice(0, 400));
  }
  const audio = body?.output?.audio || {};
  const audioUrl = String(audio.url || '').trim();
  if (!audioUrl) throw new Error('语音合成返回里没有 audio.url：' + JSON.stringify(body).slice(0, 200));
  const { buffer, contentType } = await safeFetchBinary(audioUrl, MAX_AUDIO_BYTES);
  if (!buffer || !buffer.length) throw new Error('语音文件下载为空');
  return {
    buffer,
    ext: extFromUrl(audioUrl, useFormat),
    audioUrl,
    model: useModel,
    voice: resolveVoice(useModel, voice || cfg.voice),
    format: String(audio.format || useFormat),
    characters: Number(body?.usage?.characters) || finalText.length,
    contentType: String(contentType || ''),
    truncated
  };
}
