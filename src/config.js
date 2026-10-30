// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { readJsonDetailed } from './json-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/**
 * config.json 的 schema 版本（2026-10-26）。
 *
 * 以前这个文件没有版本概念：字段改名/搬家只能靠"读的时候猜"（比如 `?? 默认值`），
 * 猜错了就是静默降级 —— 和密钥掩码被回写覆盖是同一类事故。
 * 现在：没有 `schema` 字段的旧文件视为 0，逐级跑到当前版本；
 * 读到**比自己新**的版本说明程序比配置旧，要喊出来（否则新字段会被老程序悄悄丢掉）。
 */
export const CONFIG_SCHEMA = 1;

export const DEFAULT_CONFIG = {
  schema: CONFIG_SCHEMA,
  // OpenAI 兼容 API（必填才能跑）
  api: {
    baseUrl: 'http://127.0.0.1:8787/v1',   // 例如本机 buddy2api 网关或任何 OpenAI 兼容端点
    apiKey: '',
    model: '',                              // UI 里选择/填写
    complexModel: '',                       // 复杂任务可选的更强模型
    routing: {
      enabled: true,
      auto: true,
      allowModelEscalation: true
    },
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 6,                           // 单次运行的最多工具轮数
    thinkingMode: 'auto',                    // auto=正常开思考，被截断时自动改走"不思考"兜底；off=从不发思考
    maxOutputTokens: 1200,                   // 普通聊天单次模型调用的输出上限（推理模型的思考也计入此额度）
    complexMaxOutputTokens: 4000,            // 复杂任务模型单次调用的输出上限（写代码/推理这类要留足思考）
    timeoutMs: 180000,
    // ── 上下文窗口感知（2026-10-31）────────────────────────────────
    // 在这之前全仓上限都是**字符数**，没人知道模型窗口多大。三个新字段：
    //   contextWindow: 模型窗口 token 数。0 = 不知道（会先问 /models，还拿不到就按
    //                  128K 估，且**只警告不压缩**）。手配优先于自动探测——
    //                  /models 返回的窗口字段各家五花八门，不一定可信。
    //   charsPerToken: 字符→token 的换算倍率。本仓中文为主，实测 1 字 ≈ 1 token
    //                  （data/sessions 里 calls===1 的 13 个样本校准，见 src/token-meter.js）。
    //   compactThreshold: 用量到窗口的这个比例才动手清理工具结果。0.82 借 AstrBot 实测值。
    contextWindow: 0,
    charsPerToken: 1.0,
    compactThreshold: 0.82,
    // 旁路整理用模型（往事摘要/事实抽取/记忆整理/反思）。留空 = 沿用 model，行为完全不变。
    // 对齐 Letta 的 sleep-time agent：整理活儿可以换更便宜或更强的模型，
    // 反正它不在用户等回复的链路上。
    utilityModel: '',
    // 展示用单价（元 / 百万 token），不参与任何请求
    priceInputPerM: 0,
    priceOutputPerM: 0
  },
  // 出站网络：海外域名走代理、国内直连（见 src/net-proxy.js）。
  // 留空 = 先读环境变量，再自动探测本机常见代理端口（7897/7890/10809/10808/2080）。
  // ⚠️ proxyHosts 留空表示用内置名单；写成数组就**整体替换**，不是追加。
  net: {
    enabled: true,
    proxyUrl: '',
    proxyHosts: []
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索
  //   provider: 'auto'      = 有 AnySearch key 就用它，失败自动回退 Bing（推荐）
  //             'anysearch' = 只用 AnySearch（需配置 key，结果更全）
  //             'bing'      = 只用 Bing 网页抓取（无需 key）
  webSearch: {
    enabled: true,
    provider: 'auto',
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // AnySearch 的 API key（可选；也可用环境变量 ANYSEARCH_API_KEY / _2 注入，env 优先）
    // 支持多个 key 轮换：某个 key 返回 429 时自动换下一个
    anysearchKeys: []
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // 识图模式：native=主模型原生多模态；qwen=独立 Qwen-VL 分析后把文字交给主模型
  vision: {
    mode: 'native',
    // GIF 动图拆成几张静帧再交给视觉模型（0 = 不拆，原样发 image/gif）。
    // 模型只吃 jpeg/png/webp，QQ 的动图表情/转发动图几乎全是 GIF，不拆就是「看不见」。
    // 3 帧够表现动作前/中/后；每多一帧就多一份视觉 token，且容易让模型当成张数更多的图。
    gifFrames: 3,
    // 通道选择（见 src/vision-client.js 顶部）：auto = 表情包走 deepseek、其余走千问。
    // 两家各有硬伤：deepseek 便宜快但小字 OCR 弱；千问小字准但跨帧比较会编。
    route: 'auto',
    qwen: {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: '',
      model: 'qwen3-vl-plus',
      timeoutMs: 60000,
      maxTokens: 1200,
      maxImages: 4
    },
    deepseek: {
      enabled: true,
      baseUrl: 'https://api.deepseek.com',
      // 留空 = 复用 providers 里 api.deepseek.com 那把 Key（不把密钥复制成两份）。
      apiKey: '',
      model: 'deepseek-flash',
      timeoutMs: 30000,
      // 识图输出本来就压到 120 字，400 够用。
      // ⚠️ 必须靠 thinking-dialect 关思考，否则这点预算会被思维链吃光、正文空。
      maxTokens: 400,
      // low = 缩到 512×512（更省更糊）；auto = 原图
      detail: 'auto'
    }
  },
  // 语音（文字转语音发 QQ 语音消息）。apiKey 留空 = 用 vision.qwen 那把 DashScope Key。
  audio: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'qwen-audio-3.0-tts-plus',
    voice: '',                 // 留空 = 用该模型的默认音色（plus → longanlingxin）
    instruction: '',          // 默认语气/情绪指令（qwen-audio-3.0-tts 用 instruction；留空不指定）
    format: 'wav',             // 无损 wav：避免 mp3→RVC→mp3 的多重有损，QQ 端再转 silk
    maxChars: 150,             // 单条语音最多合成多少字（超出截断）
    timeoutMs: 60000,
    sendAsBase64: false,       // true = 以 base64 内联发给协议端（NapCat 在另一台机器时用）
    transcodeFormat: 'mp3',    // 收语音时让协议端转成什么格式再送去识别（NapCat get_record out_format）
    // 角色本音：默认用谁的声音说话（GPT-SoVITS 本地微调模型）
    //   可选 hutao / nahida / sparkle / liuying / furina / ayaka，见 src/gpt-sovits.js 的 GSV_VOICES。
    //   ★ 这是「设置 → 语音音色 → 角色本音」选的那一个，是实际发声音色的唯一真相源。
    //     gsvAllowModelPick=false（默认）时模型传的 voice 会被忽略，避免音色自己乱跳。
    gsvVoice: 'hutao',
    // 允许模型在单次回复里临时换音色（传了 voice 就用它的）。
    //   false = 上面 gsvVoice 说了算 —— 设置里选了谁，就一直是谁；这是默认，符合直觉。
    //   true  = 模型可以按语境换人（比如"模仿胡桃说话"），但容易导致音色乱跳。
    gsvAllowModelPick: false,
    // 角色本音服务（api_v2.py，127.0.0.1:9880）没在跑时，发语音前自动拉起。
    //   ★ 关掉这项的后果：服务没开 → 所有音色都静默降级成千问 TTS →
    //     换哪个音色听起来都一样，看着像"切换不生效"。
    gsvAutoStart: true,
    // 随语气自动调速（src/prosody.js）：按标点/语气词给语速乘一个 0.88~1.26 的倍率。
    //   ★ 关掉它的后果：每个音色一个固定语速 —— 同一句话"好呀～"和"快点！！"念出来
    //     节奏完全一样，听久了像播报。这是声音层面的机器感，比措辞更难被发现。
    //   基准速度仍由音色决定（如神里绫华 1.15），这里只做乘法；工具里手动传 speed 时不介入。
    prosodyAuto: true,
    // 人声后处理链（src/voice-postchain.js）：合成出口统一过
    // highpass→降噪→去齿音→3kHz 提亮→loudnorm(-16 LUFS)，把不同来源的音色
    // 响度/频谱对齐。学自小鱼训练工程的合成出口链。false = 完全关掉（裸 16k 直发）。
    postChain: true,
    // ── 按语境换语气（src/voice-delivery.js）──────────────────────────────
    // 把「此刻情绪」翻译成一次合成的**表演参数**：参考音频 + 语速偏置 + 韵律参数
    //   + 给模型看的一句写法提示。以前发语音的语气完全靠模型自由发挥，结果是
    //   同一个音色在开心/难过/生气时听起来一模一样，流萤那 6 条情绪参考音频
    //   几乎没被真正切过（模型不知道参考音频标签长什么样）。
    //   ★ 关掉它的后果：回到"模型自己写一句 style"，音色不换、参数不动。
    toneAuto: true,
    // 情绪强度 0~1.5。0 = 完全按老样子（等于关），1 = 正常，1.5 = 演得夸张些。
    // 情绪底色低（mood.score ≤ 39）时会自动收敛 20%，免得"刚被怼完还笑得跟没事一样"。
    toneStrength: 1,
    // 是否把 temperature / top_k / top_p / fragment_interval / repetition_penalty
    // 一起下发给 api_v2。关掉 = 只用 speed_factor（老行为），出爆音时可以一键回退。
    toneParams: true,
    // ── 合成速度/可复现（api_v2 的 sample_steps 与 seed）────────────────────
    // CFM 扩散步数。32 = 官方默认；调低合成更快、单调音质下降，调高更慢更稳。
    //   ★ 只对 v4 音色生效（hutao / nahida / furina / ayaka）。
    //     流萤、花火是 v2ProPlus，走的是另一条解码路径，这个值对它们**完全没作用** ——
    //     切到那两个音色时觉得"调了没反应"就是这个原因，不是坏了。
    //   改之前先跑 node rvc/train/bench_gsv.mjs --voice=<音色> 量一下耗时/RTF/音质，别凭感觉定。
    gsvSampleSteps: 32,
    // 随机种子。-1 = 每次随机（当前行为，同一句话听感会略有不同）。
    //   固定成某个整数 = 同句同参数出同一条音频，方便 A/B 和复现"这条怎么念成这样"。
    gsvSeed: -1,
    // RVC 音色转换（本地 Python 服务）：把 TTS 的声音换成训练好的自定义音色
    //   服务端脚本 rvc\\rvc_service.py；改完设置需要重启 RVC 服务（或整机重启 QQ Agent）
    rvc: {
      enabled: false,            // 打开后 send_voice 会先过 RVC 再发
      autoStart: true,           // 没在跑就自动拉起 Python 服务
      url: 'http://127.0.0.1:3211',
      model: '',                  // rvc\\models 里的模型名（不带 .pth）；留空 = 自动检测（优先 hutao）
      device: 'auto',            // auto / cpu:0 / cuda:0
      f0upKey: 0,                // 升降调半音数（男声→女声常用 +12）
      method: 'rmvpe',           // rmvpe / harvest / pm / crepe
      timeoutMs: 180000,         // 单次转换超时
      startTimeoutMs: 150000,    // 启动并加载模型的等待上限
      fallbackToRaw: true,       // RVC 失败就用 TTS 原始音色发出去
      protect: 0.5,              // 0~0.5，越大越保留清辅音/呼吸声（活人感）
      enhance: 1.0,              // 人声后处理强度：压掉声码器编造的超高频，减金属感
      silk: true,                // true=对输出做 SILK 预适配（16kHz+预加重），缓解 QQ 语音模糊；听感不满意可关
      preferOverGsv: false       // true=说话不用 GPT-SoVITS 角色本音，统一走「TTS→RVC」（知更鸟没 GSV 模型时用）
    },
    // DDSP-SVC 歌声转换（知更鸟）：把唱歌干声换成角色音色，比 RVC 更像原唱
    //   服务端 ddsp-svc/ddsp_service.py；模型 ddsp-svc/models/<名字>/
    ddsp: {
      enabled: false,            // 打开后唱歌（歌词/翻唱）优先走 DDSP
      autoStart: true,           // 没在跑就自动拉起 Python 服务
      url: 'http://127.0.0.1:3213',
      model: 'zhigengniao',      // ddsp-svc/models 里的目录名
      device: 'auto',            // auto / cpu / cuda:0
      steps: 20,                 // RectifiedFlow 采样步数（越大越细，越慢）
      maxSeconds: 240,           // 单次转换最长音频
      timeoutMs: 600000,
      startTimeoutMs: 180000
    },
    // 唱歌（歌词真唱走 DiffSinger；原曲翻唱走 route_a + RVC/DDSP）
    svc: {
      singDry: true,             // 「唱：歌词」默认干声（只人声，不加自动伴奏）；false=带伴奏
      coverDry: true,            // 按原曲翻唱默认干声（只人声，不混原曲伴奏）；false=混音成品
      // 原曲翻唱的人声分离后端（route_a.py --separator）。四个值以外 route_a 会直接退出码 2，
      // 归一化在 svc-voice.js::svcConfig()，非法值回落 htdemucs。
      //   htdemucs    Meta Demucs v4 混合版，默认，速度正常（约 1× 实时）
      //   htdemucs_ft 微调版，人声更干净但慢约 4 倍
      //   mdx_kim     UVR MDX-Net「Kim Vocal 2」，密集编曲人声泄漏更少（audio-separator）
      //   mdx_vocft   UVR MDX-NET Voc_FT，同上，风格不同
      separator: 'htdemucs',
      // 没有旋律来源（曲库没原曲、旋律库没谱、群友也没发音频）时，还让不让唱。
      // false=不唱（如实说「没有调我不乱唱，发段音频或哼一句」）—— 现编的调听着就是乱唱；
      // true=用算法现编的旋律唱，并在回执里说明「调是我现编的」。
      allowImprovise: false,
      // 默认曲目：群友只说「唱首歌」「你来一首」但没点名唱哪首时，就唱这首。
      // 填的是歌名（不是文件路径），必须在曲库（songs/raw 或点歌台缓存）里能查到；
      // 留空 = 老行为（反问对方唱什么）。
      defaultSong: '我的悲伤是token做的',
      vcEngine: 'rvc',           // 唱歌换音色引擎：rvc / ddsp
      coverEngine: 'rvc',        // 原曲翻唱换音色引擎：rvc / ddsp
      voiceModel: 'hutao'        // 唱歌目标音色（RVC 模型名；ddsp 引擎时用 audio.ddsp.model）
    },
    autoAsr: 'direct',         // 'direct'=私聊/@我/叫名时自动把语音转成文字；'off'=不自动（模型自己调 voice_to_text）；'all'=所有语音都自动转
    autoAsrMaxPerMessage: 1,   // 一条消息最多自动转写几段语音
    // 语音识别（听懂群友的语音）：默认沿用同一把 DashScope Key
    asr: {
      enabled: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-omni-flash',
      prompt: '把这段语音逐字转成中文文字，只输出文字本身；听不清的地方用「？」代替，不要编造。',
      maxBytes: 8388608
    }
  },
  // 语音通话（在控制台里像打电话一样对话；QQ 客户端里的真实语音通话协议层不支持）
  voice: {
    enabled: true,
    // 通话总时长上限（毫秒）。默认 10 分钟 —— 再长多半是忘了挂断，
    // 而每一秒都可能在下一次说话时重新烧一遍提示词。
    maxCallMs: 600000,
    // 一次通话最多几轮。到了就发 closed 让前端收尾，避免无意识的长跑。
    maxTurns: 40,
    // 断句用的能量阈值（RMS）。安静房间 0.012 够用；吵的地方可以调高。
    vadThreshold: 0.012,
    // 连续有声多久才算「开始说话」——挡住键盘声、关门声。
    vadMinSpeechMs: 250,
    // 连续无声多久才算「说完了」——调小会更跟手，但容易把你换气的停顿当成说完了。
    vadSilenceMs: 700,
    // 它说话时你一开口就打断（停播放）。关掉的话就只能等它说完。
    bargeIn: true,
    // 一句话最多念多少字。电话里说太长没人听，也会让 TTS 等很久。
    replyMaxChars: 120,
    // 记住最近多少轮对话（一轮 = 一问一答）。
    historyTurns: 12,
    // 合成音频的格式，直接回传给浏览器解码。
    ttsFormat: 'mp3',
    // 多久没收到任何音频就自动挂断（毫秒）。
    idleTimeoutMs: 60000
  },
  // QQ 通话（真的 QQ 客户端里的语音通话，不是控制台里的那个 voice）
  // 三步：手（UIA 自动接听）→ 耳朵（Electron loopback 录 QQ 声音）→ 嘴（虚拟声卡）
  // ⚠️ 默认全关：替用户接电话是高风险动作，必须显式打开。
  call: {
    enabled: false,
    // 只探测和通知（emit qq-call 事件），不真的点「接听」。
    // 想让 agent 自己接，把 autoAnswer 也打开。
    autoAnswer: false,
    // 多久扫一次 UIA 窗口树。600ms 是 ohwhale 的值；再快没意义（QQ 元素树本身要几百毫秒）。
    scanIntervalMs: 600,
    // 同一通电话重复点击的冷却。600ms 一轮，30 秒的电话会被扫到 50 次。
    answerCooldownMs: 20000,
    // 只在标题含这个词的窗口里找按钮。ohwhale 的实测：全树扫一轮 >20 秒会错过来电。
    windowPattern: '通话',
    // 接听类按钮名（来自 ohwhale 的 ANSWER_PAT）。QQ 改版改了名字就在这里改。
    answerPattern: '接听|接受|接起',
    // 挂断类按钮名（来自 ohwhale 的 REJECT_PAT）。这些**永远不能**被当成接听。
    rejectPattern: '挂断|拒绝|关闭',
    // 是否接视频电话。默认 false：会开摄像头，且这条链路原作者自己都没验证通过。
    preferVideo: false,
    // 耳朵：用 Electron 的系统声音环回（Windows 专用）录 QQ 正在播放的声音。
    loopbackEnabled: true,
    // 断句参数照搬 ohwhale 的实测值（它是在 WASAPI+VB-Cable 链路上调的，本机可能要再调）：
    // 静音 900ms —— 注释原话「0.55 太急，一句话中间换气就被截断」，700 也偏急。
    vadSilenceMs: 900,
    // 预录 450ms —— 不留的话第一个字永远丢。
    vadPreRollMs: 450,
    // 尾部 300ms —— 静音判定到点后还要留一点尾音。
    vadKeepTailMs: 300,
    // 打断倍率：对方要有多响才算"抢话"。ohwhale：「2.0 时环境噪音就误触发」。
    bargeInRatio: 3.0,
    // 嘴：TTS 播到哪个设备。空 = 系统默认（对方听不到）。
    // 装了 VB-Cable / VoiceMeeter 之后在这里填 CABLE Input 的 deviceId。
    //
    // ⚠️ 这个 deviceId 是**浏览器**的（enumerateDevices 给的），不是系统的端点 id。
    // 而且它是按 origin 加盐哈希的 —— 换端口/换协议就变，所以它只适合当"上次用的那个"
    // 这种一次性记忆，真正的持久化用下面的 outputLabel（按名字重新认）。
    outputDeviceId: '',
    // 面板上显示的提示名，用于从设备列表里自动认出来（大小写不敏感）。
    outputHint: 'CABLE Input',
    // 上次在面板里手动选中的设备**标签**（如 "CABLE Input (VB-Audio Virtual Cable)"）。
    // 为什么存标签而不是 id：见上面那条 —— deviceId 换个端口就失效，存了等于没存；
    // 标签是驱动给的固定名字，重启、换端口都能重新认回来。
    outputLabel: ''
  },
  // 点歌台：把 B站缓存里的音乐整理成歌单，群友用 #点歌 直接点播原曲（不是翻唱）
  playlist: {
    enabled: true,
    roots: [],                 // B站缓存根目录；留空=自动探测 %USERPROFILE%\Videos\bilibili
    autoRebuildMinutes: 30,    // 歌单缓存有效期（分钟）；0=每次点歌都重扫
    pageSize: 10,              // #歌单 每页条数
    cooldownSec: 5,            // 同一人同一会话的点播冷却（秒）
    maxFileMb: 120,            // 单个音频文件上限（超过拒绝发送）
    transcodeBitrate: '192k',  // 转 mp3 的码率
    snippetSec: 45,            // 语音条试听时长（QQ 语音上限 60s）
    sendMode: 'file'           // file=整首发文件；auto=≤55s 发语音条；voice=总是语音条
  },
  // 看视频：群友甩视频链接 → 抓标题/简介/章节/字幕/弹幕/热评 → 让模型说清大概讲了什么
  // （详见 docs/视频理解-2026-10-22.md；判据与抓取都在 src/video-intel.js）
  video: {
    enabled: true,             // 总闸：关了就不再自动看链接（工具也不可用）
    autoReply: true,           // 解析完自动把总结发回群里；false=只记进上下文，让模型自己决定说不说
    keyframes: false,          // true=必要时下载视频抽几帧真看画面（要下整个视频，默认关）
    maxFrameDurationSec: 900,  // 超过这个时长就不抽帧（防一个链接拖进来几百 MB）
    frameCount: 4,             // 抽几帧（1~6）
    maxChars: 6000,            // 喂给模型的材料上限（长视频弹幕上万条，不裁会爆 token）
    cacheHours: 12,            // 同一个链接多久内直接复用上次的总结；0=不缓存
    danmakuTop: 12,            // 高频弹幕取几条
    commentTop: 8,             // 热评取几条
    summaryMaxChars: 400,      // 总结的目标长度（只是给模型的字数要求，不硬截）
    quietFromHour: 0,          // 这个时间段不自动开口（0-6 点）
    quietToHour: 6,
    perChatCooldownMs: 60000,  // 同一会话两次自动看视频的最小间隔
    maxPerHour: 4,             // 同一会话一小时内最多自动看几个
    timeoutMs: 30000           // 单次"看视频"的总超时（含抓材料 + 模型总结）
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: '',       // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
    accountQQ: ''              // 机器人小号 QQ 号：启动 NapCat 时用 -q 快速登录（免扫码）；留空=扫码登录
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    masterQQ: '10000001'                  // 主人 QQ
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 多身份：按会话绑定人设。key = chatKey（可含模式后缀，如 private:123456789:tutor），
  // value = 人设 id（'builtin:xxx' 内置 / 'persona:<name>' 自定义人设名，见 resolvePersona）
  personaBindings: {},
  // 身份模式（学习模式等）：按会话记录当前激活的身份
  // { "<chatKey>": { "mode": "tutor"|"assistant", "personaRef": "...", "switchedAt": 123 } }
  personaModes: {},
  // 身份模式定义：每个模式一套完整配置（人设 + 工具 + 提示注入）
  identityModes: {
    // 示例（默认留空，由实际项目配置填充）：
    // tutor: { label: '教师模式', personaRef: '', extraPrompt: '', masterOnly: true }
  },
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 群聊未提及机器人时的触发概率（0.05 = 5%；@/提及/图片/提问必触发）
  groupMentionProbability: 0.05,
  // 运行节奏
  wakeDelayMs: 1800,        // 普通群聊防抖窗口
  directWakeDelayMs: 500,   // 私聊/@/引用/点名时的快速响应窗口
  drainDelayMs: 800,        // 一次运行结束后发现还有未读，到下一次运行的间隔
  // 多人并发（判据在 src/crowd.js，窗口在 src/waiting.js）
  //   一批未读里有 ≥2 个人在等它时，别"一人回一条"，合并成一句/两条说完。
  //   wakeDelayMs  这时候的合并窗口 —— 必须够长，否则第二个人的话还落进下一轮；
  //   maxWaitMs    硬顶：一群人轮流 @ 它时，不能每句都把计时器重置到天荒地老；
  //   maxAskers    提示词里最多详列几个人（超出的只报"还有 N 个"）；
  //   enabled=false 退回旧行为（谁先触发谁跑，各回各的）。
  crowd: {
    enabled: true,
    wakeDelayMs: 2600,
    maxWaitMs: 6000,
    maxAskers: 4
  },
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 等待与垫话（判据在 src/waiting.js）
  // 合并窗口沿用上面两个 wakeDelayMs / directWakeDelayMs，**不在这里另立一套数字**。
  waiting: {
    holdText: '',           // 慢任务垫话文案；空 = 关闭（例："我想想…"）
    holdMs: 6000            // 超过这么久还没出结果才垫（要明显大于正常生成耗时）
  },
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔（也是节奏的下限）
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）——旧字段，保留兼容
    maxPerMinute: 0,   // 0 = 不限速（已取消频率限制）
    maxPerHour: 0,    // 0 = 不限速（已取消频率限制）
    // 私聊独立每分钟额度：一对一对话里用户连发、她分条回，和群里"别刷屏"不是一回事。
    // 不配 = 沿用 maxPerMinute（历史行为）；配 0 = 私聊完全不限速。
    // 起因见 sender.js #checkRate 的注释（整轮被限流吞掉 → 模型补一句"我走神了你说啥"）。
    maxPerMinutePrivate: undefined,
    // 发送额度的**前置**感知（2026-10-29 第 3 轮）：开跑前先问一句"这一分钟还发得出去吗"，
    // 已经满了就不花那一整轮模型调用。实测 78 个零发送轮次烧掉 7.77% 的 prompt tokens，
    // 且每个都在开跑前额度就已满 —— 详见 src/send-quota.js 顶部。
    // 设 false = 回到老行为（只在发送时才判限流）。
    preflightQuota: true,
    // 限流等待：`rateWaitFirstMs` 用于"这一轮真正的那句回应"（private 私聊常常只差几秒就滑出窗口，
    // 等一等远好过让她说'你说啥'）；`rateWaitMs` 用于分条的第 2 条起（等不到就安静省略）。
    rateWaitFirstMs: 12000,
    rateWaitMs: 2500,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    // 拟人节奏（rhythm.js）：首条走"总延迟预算"，条间走随机抖动。
    // enabled=false 时完全回落到 minGapMs~maxGapMs 的旧行为。
    pace: {
      enabled: true,
      minMs: 1000,          // 条间最小间隔
      maxMs: 3000,          // 条间最大间隔
      perCharMs: 20         // 每字附加（毫秒）
    },
    // 发送前复核：白名单/暂停/预算在"判定之后、发送之前"可能已经变了
    // （中间夹着一次完整的模型生成）。关掉它 = 回到"入站放行过就一直发"。
    recheckBeforeSend: true,
    // 出站空格分句纠正（src/space-split.js）：
    //   把「中文 + 空格 + 中文」里当逗号用的空格换成「，」，但只对 ≥despaceMinChars 字的整段生效。
    //   短气泡（<10 字）不动 —— 人类那个长度里几乎不用标点（逗号率 2.1%），
    //   「那行 给你配了」是真实写法，一律换逗号会让她比人还规整。
    //   关掉它 = 回到 65.6% 的空格分句（提示词里的【空格不是分句符号】实测拦不住）。
    despaceSplit: true,
    despaceMinChars: 10,    // 低于这个字数不动（人类短气泡几乎不用标点）
    despaceMaxChars: 30,    // 达到这个字数不动（人类 30+ 空格率 84.8%，她 9.1%，本来就比人干净）
  },
  // 连续对话（学自 Estrella「拟人对话逻辑」v1.4.2 的 talk-session）
  //   她刚回过谁，谁在这段时间内继续说 → 直接接住，不掷概率。
  //   windowMs=0 等于关掉这个机制（退回"每句都走概率"）。
  talk: {
    enabled: true,
    windowMs: 20000,          // 接话窗口（20 秒）
    stickerTolerant: true,    // 文字后 2.5 秒内补的表情不结束对话
    // 口头禅抑制（src/phrase-guard.js）：量出"她最近是不是在重复自己"。
    // 起因：群友玩"付钱"梗 → 她接梗 → 写进日记 → 日记每天注入 → 变成口头禅。
    // 提示词里一句"别复读梗"挡不住，因为模型看不见自己说过几次；必须外部量出频率再喂回去。
    // watch 里的 pattern 是正则字符串（写坏了只作废那一簇，不会崩）。
    phraseGuard: {
      enabled: true,
      windowMessages: 30,     // 只看最近多少条自己的发言
      windowHours: 12,        // 且只算这么久之内的（昨天的话不算口癖）
      minCount: 3,            // 语义簇命中 >= 几条不同消息才提醒
      minRepeat: 4,           // 通用复读：同一个 3-gram 出现在 >= 几条不同消息
      watch: [
        {
          id: 'money',
          label: '讨钱/开价那一套（钱、转账、红包）',
          pattern: '(给|打|付|收|转|掏|发|要|赚)钱|转账|红包|开价|收费|收钱|几个币|扫码|先付|五块|十块|一块钱|几毛'
        }
      ]
    }
  },
  // 拍一拍 / @（现实里的"肢体动作"，判据在 src/gesture.js）
  gesture: {
    enabled: true,
    othersWake: false,        // 别人之间的拍一拍要不要叫醒它（默认不要——那是群里的背景动静）
    maxPokePerRun: 1,         // 一轮最多拍几次
    pokeCooldownMs: 45000,    // 同一会话两次拍一拍的间隔
    pokeTargetCooldownMs: 1200000,  // 同一个人 20 分钟内不重复拍
    quietFromHour: 0,         // 这个时间段不主动拍人（0-6 点）
    quietToHour: 6,
    sadMoodBelow: 35,         // 心情低于这个分数就不主动招惹人
    maxAtPerRun: 1,           // 一轮最多 @ 几个人
    atTargetCooldownMs: 600000,
    // 别人拍我 → 自动回拍：同一个人多久内只回一次（挡"隔十来秒戳一下"的逗弄）。
    // 0 = 每次被拍都回（只受 8 秒手速限制）
    pokeBackSameTargetMs: 60000,
    // 连戳炸毛：同一个会话同一个人，间隔在这之内算"同一串"；数到第 N 下就不回拍了
    // （真人被连戳会烦，一直乖乖回拍像个弹簧）。炸毛后不自动发台词，交给模型自己哼。
    pokeStreakResetMs: 300000,
    pokeAngryAt: 4
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25,
    // ── 收敛（2026-10-29 第 2 轮，学自 MaiBot 的 idle_backoff 设计）──────
    // 问题：idleThresholdMs 是个"只会越来越真"的条件 —— 没人说话的时间只会变长。
    // 于是没人搭理的群会被反复投骰子，每次烧一整轮的钱，结果永远是 noreply。
    // 连败只对**连续**计数：群里一有人说话（正常对话跑完一轮）立刻清零，
    // 否则"越冷场越沉默"会滚成雪球，最后机器人对这个群永久闭嘴 —— 那是坏掉不是收敛。
    backoffEnabled: true,
    backoffBaseMs: 600000,      // 连败到起点后第一次等多久（10 分钟）
    backoffCapMs: 21600000,     // 退避上限（6 小时）—— 群三天后可能重新热起来，别睡死
    backoffStartCount: 2,       // 连败几次开始退避（前两次照常试）
    cooldownMs: 1800000         // 主动说完一句、还没人接时的冷却（30 分钟）
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    maxCollectPerHour: 10,
    maxPerRun: 1,            // 同一轮处理最多发几张表情（硬约束）
    // 表情自己的一分钟额度（**不占** send.maxPerMinute 的文本名额）。
    // 实测 14/62 次表情死在「这一分钟发得太多了」——额度被前几轮文字吃光。
    // 缺省 1；显式 0 = 不限。
    maxPerMinute: 1,
    // 同一会话两次表情的最小间隔。2026-10-28 从 3 分钟降到 2 分钟：她要"用表情回话"，
    // 3 分钟一张在活跃群里等于半小时才敢发两张。
    // ⚠️ 改这个数必须同步 stickers.js 策略段里那句"2 分钟内只能发一张"（提示词与实现脱钩过一次）。
    cooldownMs: 120000,
    // 同一张图多少天内不再自动选（0 = 只按 dailyPerIdCap 限制当天）。
    // 近 3 天 28 次发送里 7 张各发了 2 次、全是隔天复发 —— 用户要"不要同一张反复发"。
    reuseCooldownMs: 259200000,
    recentWindow: 40,        // 去重时回看多少条自己的发言
    // 同一张表情一天最多发几次。2 的结果是"招牌三张"轮着刷（36/21/11 次），降成 1 逼她换图。
    dailyPerIdCap: 1,
    // 这段时间内发过的图不进「本轮候选」（6 小时）。这是"用得更丰富"的唯一硬机制：
    // 提示词劝"别总用同一张"从来无效（模型只认摆在眼前的 id），把发过的藏起来才有效。
    // 候选窗口与 reuseCooldownMs 对齐（3 天，2026-10-28）：
    // 6 小时的时候，昨天发过的图还会出现在「本轮候选」里，模型点了才发现发不出 ——
    // 提示词写着"最近几天发过的不会再进候选"，实现却只挡 6 小时，又是一次文实脱钩。
    candidateCooldownMs: 259200000
  },
  // 唤醒闸门：宿主层先判断"这一批消息值不值得叫醒模型"（省调用、更像人）
  //   enabled=false → 完全按老行为（每条消息都跑模型）
  //   dryRun=true   → 只记日志"本来会跳过哪些"，不真跳（建议先挂一周看日志再关）
  gate: {
    enabled: true,
    dryRun: true,
    probability: 0.05,       // 非必回消息的唤醒概率（基线）
    keywords: [],            // 命中即必回的词
    activeWindowMs: 1200000, // 自己刚在这个会话说过话 → 提权（默认 20 分钟）
    activeBoost: 3,
    coldGapMs: 1800000,      // 群里冷了很久 → 降权（默认 30 分钟）
    coldFactor: 0.3,
    // 群里被拍一拍之后「顺手说句话」的概率。注意：**回拍是必然的**（app.js 入站直接拍，
    // 见 gesture.pokeBackSameTargetMs），这里只管要不要顺带开一次模型去接话。
    // 1 = 每次被拍都应一句；0 = 只回拍、从不为这个开模型。
    pokeReplyProb: 0.6,
    // 寻址（addressee.js）：群友之间说话时，她只是旁人。
    //   toOtherFactor  这条明着是对别人说的（@别人 / 引用别人的话）→ 概率乘这个。
    //   sideTalkFactor 最后两条来自两个不同的人（那两个人在对谈）→ 概率乘这个。
    // 都不是"禁止"，想彻底不接就写 0。enabled=false 则整套寻址判定停用（退回旧行为）。
    addressee: {
      enabled: true,
      toOtherFactor: 0.08,
      sideTalkFactor: 0.35
    }
  },
  // 存储
  store: {
    maxMessagesPerChat: 2000,   // 单群 JSON 最大保留条数（0 = 无限）
    // 裁内存前先归档（2026-10-26）：按天分片写 data/archive/<会话>/<日期>.jsonl，
    // 只追加、不自动删。关掉它就退回"超过 2000 条直接丢"的旧行为。
    archiveHistory: true,
    pastStateLimit: 24,         // 提示词里"过去状态"最多带多少条（私聊）
    pastStateMaxChars: 2400,    // "过去状态"文本预算（私聊）
    // 群聊单独一份：群里噪声占比高（多人交错、寒暄），同样字数换到的有用信息更少。
    // ⚠️ 这两项必须显式登记：没登记时 windowLimitsOf 会回落到私聊值（= 不缩小）。
    pastStateGroupLimit: 20,
    pastStateGroupMaxChars: 2000,
    // 保护项（P1）：@我 / @全体 / 提到我 的消息及其前后各 N 条，淘汰时**最后**才丢。
    // 0 = 关掉保护（退回纯时间窗口）。判据在 past-window.js。
    pastProtectRadius: 2,
    pastProtectMaxHits: 3,      // 只保最近的 3 处 @（全保会把最近的对话挤出去）
    pastProtectMax: 6,          // 保护项总条数上限（实测：不限的话活跃群 20 条里 12 条都是保护项）
    pastProtectScan: 60,        // 为找保护项额外回看多少条（只花 CPU，不花 token）
    // 刷屏折叠（P1，仅群聊）：同一人连续 ≥minRun 条、每条 ≤maxChars 字的消息合并成一条。
    // 关掉它的理由通常只有一个：想让提示词里保留原样的单条节奏。
    pastFloodFold: true,
    pastFloodMinRun: 4,
    pastFloodMaxChars: 10,
    // 自己的旧发言降采样（P2，仅群聊）：最近 keepRecent 条原样留，更早的并成**一行**片段。
    // 实测群窗口里她自己的消息占 40% 条数 / 42.6% 字数 —— 每轮有一半注意力在读自己说过的话，
    // 这是"复读自我强化"的物理来源。**私聊不受影响**（那里逐句原话就是语感）。
    // 只按"连续连发"折叠是无效的（她多为交替发言，实测只 -26%），必须按总量压。
    pastSelfFold: true,
    pastSelfKeepRecent: 3,      // 最近 3 句原样保留（语感/口癖的强化源）
    pastSelfFragChars: 10,      // 更早的每句只留 10 字片段（够看出"聊过什么"，拿不到可复读的整句）
    pastSelfLineMaxChars: 80,   // 合并行总长上限（防 10 句片段拼成一坨）
    // 低价值行截短（P3，仅群聊）：**只在窗口装不下时**把 low/mid 的行截成片段（不删除）。
    // 判据从"时间 + 保护"二值升级为"时间 + 保护 + 价值"三级（学 fast-jev 的 keep/截断/删除）。
    // 敢压的底气：search_messages 能按关键词捞回原文 —— Jev 那条"可重取吗"在这里恒为真。
    pastValueFold: true,
    pastValueFragChars: 14,     // 被截的行留多少个字（够看出"这句在说什么"）
    pastValueMinGainChars: 120, // 单次截短至少省这么多字才动手：省 50 字丢半句话不划算
    keepSessionFiles: 300       // 保留最近多少个会话记录文件
  },
  // 往事摘要（past-summary.js，P2）：热窗口之外的历史压成**条目**，增量更新。
  //   这是"中间那层对话流记忆"——memory 是条目、facts 是按人、diary 是按天，都不管这个。
  //   失败不阻塞聊天：连续 failThreshold 次就停用该会话，退回纯窗口。
  pastSummary: {
    enabled: true,
    maxLines: 8,        // 摘要最多几条（与 context-budget 的 pastSummary 配额 800 字对齐）
    maxChars: 800,
    // 槽位化（P4）：输出分成「谁在要什么 / 答应了什么 / 定了什么 / 发生了什么」四块，
    // 超预算时**按块丢**（先丢"发生了什么"），而不是从末尾整条丢。
    // 依据：anchored iterative 的量化 —— 多留 0.7% 的 token 换 0.35 质量分（3.35→3.70）。
    // 关掉就退回一坨无差别的条目（旧摘要照样读得回，只是没分类）。
    slotMode: true,
    // 每槽条数上限（P4.1，2026-10-26 真机修的）：0 = 不限。
    // ⚠️ 不设的话「谁在要什么」一个人一条就能把 maxLines 吃满 ——
    //   实测某个群的生产摘要只剩这一个槽，承诺/决定/事实一条不剩。
    perSlotMax: 3,
    minPending: 12,     // 窗口外攒够多少条才值得压一次
    maxBatch: 60,       // 单次最多压多少条
    minIntervalMs: 1800000,  // 同一会话最快 30 分钟压一次（别跟主流程抢钱）
    failThreshold: 3,
    // 增量编辑（2026-10-31，学自 ACE）：true = 只让模型对**已有条目 id** 做
    // ADD / EDIT / REMOVE，禁止把整份摘要重写一遍。
    // 为什么：整体重写有两个必然损伤 —— brevity bias（追简洁丢细节）与
    // context collapse（重写摧毁积累）。ACE 实测 1.8 万 token 的上下文被
    // "总结压缩"到 122 token 后，性能从正常水平跌到 57.1%。
    // 关掉就退回旧的"合并重写"路径（`buildSummaryMessages` 仍在，可随时回退）。
    editMode: true
  },
  // 时段摘要（time-digest.js，m00209）：把"刚才那半小时"按 15 分钟切片压成一行行大概。
  //   为什么要单独一层：past-window 是**按条数**的滑窗（群里热闹时 20 条只覆盖 40 秒），
  //   past-summary 是**跨时间的存量**（要攒 12 条 + 隔 30 分钟才动）。中间那段
  //   "刚刚聊完、已经滑出窗口"的历史以前直接消失 —— 于是"八点聊了十五分钟，八点十五
  //   才有人叫她"这种情况，她对前面那段一无所知。
  //   token 规矩：只在真有人叫她的那一轮现压、一片只压一次（片键永久有效）、只压
  //   滑出热窗口的片、本地先挑代表句再送模型。默认每片 160 字，一轮最多补 2 片。
  digest: {
    enabled: true,
    groupsOnly: true,        // 私聊本来就没有"滑出窗口"的问题（一轮一问一答）
    slotMs: 900000,          // 15 分钟一格
    slots: 4,                // 回看最近 4 格（= 1 小时）
    minMessages: 3,          // 一片少于 3 条不值得压（压出来也只有"说了两句话"）
    maxPerWake: 2,           // 一次唤醒最多新压几片（别为了一段背景连打 4 次小模型）
    maxChars: 700,           // 整段上限（与 context-budget 侧不登记配额配套，见该文件注释）
    perSlotChars: 160,       // 每片上限：大约 3~5 行
    maxLines: 5,
    pickLines: 12,           // 本地挑给模型的代表句条数
    keepSlots: 96,           // 磁盘上每个会话最多留多少片（96 × 15 分钟 = 24 小时）
    timeoutMs: 9000,         // 回复链路上的硬超时：超了本轮就不带，下次再压
    failThreshold: 3
  },
  // 工具结果预算（tool-result-budget.js）
  //   超上限时保留开头 + 结尾，中间换成省略标记。
  //   ⚠️ 以前这两个值只能手改 data/config.json 才生效（代码里 `|| 12000` 兜底），
  //   面板上看不到、也不知道有这回事 —— 属于"配置项存在但不可见"。
  tools: {
    toolResultMaxChars: 12000,  // 单条工具结果字符上限
    toolResultHeadRatio: 0.4,   // 头占多少（其余给尾巴；结论通常在末尾）
    // 按场景装载工具包（tool-scene.js，仅群聊）。46 个工具定义 18,072 字符，
    // 比整个人格提示词还大一倍，而实测只有 5 个工具做了 95% 的活。
    // false = 退回"每轮全挂"（改动前的行为），用于排查"她说自己不会唱歌"这类问题。
    sceneTrim: true
  },
  // 失败可见化（src/error-reply.js，2026-10-29 学自 AstrBot 的 persona_error_reply）
  //   以前模型彻底失败时只有一行 console.error：用户端看到的静默和"她决定不接话"
  //   一模一样，面板上也查不到任何记录。这里决定"要不要说、说给谁"。
  //   两类失败刻意分开：瞬时故障（超时/断网/限流/5xx）说一句人话圆过去；
  //   运营故障（欠费/密钥/参数）只给主人发技术诊断，绝不进群。
  errorReply: {
    enabled: true,
    // 同一会话的提示冷却。一个坏端点会在几秒内失败很多轮，
    // 没有冷却就是"卡了一下"刷屏 —— 那比沉默更像机器人。
    cooldownMs: 600000,        // 10 分钟
    // 群里被点名时要不要说人话。关掉 = 只在私聊里提示。
    inGroup: true,
    // 运营类失败（欠费/密钥）要不要给主人发诊断。只在私聊里发，且只发给 masterQQ。
    operatorNotice: true,
    // 覆盖某几类用户端文案（键 = error-reply.js 的 kind）。
    // 值留空数组 = 该类不说话（例如不想让她说"网抽风了"）。
    lines: {}
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000  // 默认 6 小时
  },
  // 长期事实记忆（memory-facts.js，学自《记忆模块参考包》的三层记忆）
  //   只记"一年后仍有用"的信息（称呼/生日/城市/职业/约定/偏好/雷点/重大事件），
  //   按 QQ 存 → 私聊和各个群共享，换个群也认识他。
  memoryFacts: {
    enabled: true,
    injectLimit: 8,               // 每轮最多注入几条
    minIntervalMs: 1800000,       // 同一会话两次提取的最小间隔（30 分钟）
    minNewMessages: 16,           // 攒够多少条新消息才提取
    // 遗忘衰减（2026-10-26 接线）：decayFacts/forgetWeakFacts 早就写好了，
    // 但从来没人调用 —— 一条三年前的旧事和昨天的事等权。
    // 0.02/天 ≈ 50 天掉 1.0；低于 0.3 的事实会被淡出（rule/negative 永久豁免）。
    decayEnabled: true,
    decayRatePerDay: 0.02,
    decayMinWeight: 0.3,
    decayIntervalMs: 72000000,     // 20 小时跑一次（挂半小时轮询上，等于每天一次）

    // ── 概率式召回 + 联想链（2026-10-27，学自 dsh-rofm 的召回那一半）──────
    // 原来的检索是**确定性** top-N：同一个说话者、同一批事实，每轮注入逐字相同。
    // 这跟表情包那次是同一个坑（按次数做全序 → 头几张自锁成招牌图）：高分项每轮出现 →
    // 更容易被再次提及从而 +0.3 → 下一轮分更高，低分项永远排不上。
    // 打开后会改成「必入的仍然必入（雷点/规矩）+ 其余按 α×score 加权无放回抽样 + 顺着
    // 共享关键词再想起一两条」。detail 见 src/fact-recall.js 文件头。
    recallSampling: true,
    recallTemperature: 1,          // >1 更随机（压平权重差异）/ <1 更偏向高分
    recallAssocMax: 1,             // 联想最多**额外**带几条（有独立额度，不挤占正常召回）
    recallMaxGeneration: 4,        // 最多联想几跳；p(5)≈0.55、p(8)≈0.18，再往后基本听不见
    recallMinShared: 1,            // 至少共享几个"有区分力的关键词"才算联想候选
    recallMaxDocRatio: 0.8,        // 出现在 80% 以上事实里的关键词判为无区分力
                                   // （事实一律以昵称开头，昵称的二元组必须在这里被筛掉，
                                   //   否则同一个人的事实两两相连，联想退化成完全图。
                                   //   ⚠️ 别调低：设过 0.5，结果把真正的联想之桥一起砍掉了）
    recallTopShare: 0.5            // 直接名额里"必须想起"的比例（一半确定性检索 + 一半随机）
  },
  // 群级记忆（group-facts.js，2026-10-26）：按会话存"这个群是什么地方 / 有什么规矩 / 他们的梗"。
  // 与 facts 的区别：facts 的主语是**某个人**（按 QQ 存、跨群可见），这里是**群本身**（按会话存）。
  // 关掉只是不再注入/不再新增，磁盘上已有内容不删。
  groupFacts: {
    enabled: true,
    injectLimit: 6,           // 每轮最多注入几条（再多就变成背群规）
    decayRatePerDay: 0.02,
    decayMinWeight: 0.3,
    // 与 memoryFacts 同一套概率召回（一个群开久了也有十几条印象，同样会自锁）
    recallSampling: true,
    recallAssocMax: 1,
    recallMaxGeneration: 4
  },
  // 反思层（reflection.js，2026-10-26）：不看"有没有人叫我"，定期把没处理过的消息
  // 按人分组各喂一次，提取长期事实。它补的是"只有被 @ 的人才会被记住"这个洞。
  // ⚠️ 这是唯一一个会「按人数 × 会话数」放大模型调用的模块，预算三闸都在这里。
  reflection: {
    enabled: true,
    minPending: 20,           // 攒够多少条未处理就立刻反思
    minLinesPerPerson: 3,     // 一个人至少说几句才值得单独喂一次
    maxPerRun: 60,            // 单次最多取多少条消息（从最旧的开始，防止饿死旧消息）
    // 冷启动优先（2026-10-26）：还没关系记忆的人排前面。原来固定取"发言最多的 4 人"，
    // 结果熟人反复被提取、新面孔永远轮不到 —— 真机 90 轮里关系段一次都没注入过。
    maxPeople: 6,             // 单次最多给几个人各调一次模型（成本闸）
    refreshPeoplePerRun: 2,   // 都覆盖过之后每轮只刷新几个熟人（关系是覆盖式，刷多了纯浪费）
    idleMs: 600000,           // 消息不多时，安静 10 分钟也反思一次
    // 每日额度（2026-10-26 改）：原来是死数 3。真机发现下午 19:51 就烧完了，
    // 之后一小时群里 20+ 条消息一条都没学到 —— 固定次数对"热闹的群"和"冷清的群"一视同仁。
    // 现在按当天实际消化的消息量给额度：
    //   allowed = clamp(1 + ⌊processed / runsPerMessages⌋, minRunsPerDay, maxRunsPerDay)
    maxRunsPerDay: 8,         // 硬上限（成本闸）
    minRunsPerDay: 3,         // 保底（等于旧的固定 3，冷清会话不多花钱）
    runsPerMessages: 40,      // 每消化 40 条消息 +1 次额度
    backlogSkip: 600,         // 积压超过这个数只处理最近一段（否则永远在补历史）
    maxChatsPerTick: 2,       // 每 5 分钟这一轮最多处理几个会话（成本闸）
    intervalMs: 300000,       // 反思轮询间隔
    // 群级提取（2026-10-26）：每轮反思**额外**调一次模型，只问"这个群有什么稳定特征"。
    // 它是成本闸里最贵的一项（每人一次 + 群一次），所以只在批次够大时才跑：
    // 3 条消息的批次去总结群画像，只会总结出噪声。
    groupPass: true,
    groupPassMinLines: 20,
    relationPass: true        // 按人提取时顺带更新"我和他之间"的关系（覆盖式，一次一条）
  },
  mood: {
    enabled: true
  },  // 人设回路（vibe.js）：此刻心情 / 关系账本 / 沉默档，只写进提示词，不参与任何闸门判定。
  // 和 mood 是两个时间尺度：mood.score 是底色（慢，拍一拍预算读它），这里是此刻情绪（快，指数半衰期）。
  // 设为 enabled:false 就整段不注入，退回原来的单行情绪提示。
  vibe: {
    enabled: true,
    halfLifeMin: 40
  },
  // 本地日记（学自实施包 08）：每天给每个聊得来的会话写一篇她自己的日记。
  //   只写"已经过完的那一天"（默认早上 6 点后补昨天），一天一篇、不覆盖。
  diary: {
    enabled: true,
    hour: 6,                // 过了这个点才写"昨天"（避免半夜写半截的一天）
    minMessages: 12,        // 昨天至少这么多条消息才写（太冷清的日子不硬编）
    maxMessages: 200,       // 最多喂给模型多少条消息
    maxChars: 8000,         // 喂给模型的总字数上限
    maxPerDay: 3,           // 一次检查最多补几篇（防开机补太多）
    injectEntries: 2,       // 提示词里带最近几天的日记
    injectChars: 220        // 每条在提示词里的截断字数
  },
  // QQ 空间说说（NapCat 扩展接口 /send_qzone_msg）：把日记发到她自己的空间。
  // ⚠️ 日记里装的是群友说过的话。默认 ugcRight=64（仅自己可见），改成 1（所有人可见）
  //    之前先想清楚：那等于把群里的对话片段公开出去。
  qzone: {
    enabled: true,             // 总开关：关掉 = 不发，日记也不再生成脱敏版
    autoPublishDiary: true,    // 日记写好后自动发一条
    ugcRight: 64,              // 1 所有人可见 / 4 好友可见 / 64 仅自己可见
    maxPerDay: 1,              // 每天最多自动发几条（0 = 不限）
    maxChars: 900,             // 说说正文上限（QQ 空间本身的上限约 1000 字）
    includeTitle: true,        // 正文前带【标题】
    publicSafe: true           // 用生成时产出的脱敏简版（关掉 = 发全文，只靠正则兜底）
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    // 监听地址：127.0.0.1 = 只有本机能开（默认，最安全）
    //           0.0.0.0   = 同一局域网的手机/平板能开（手机轻量版必需）
    // 非回环监听时 token 必填，否则启动会强制退回 127.0.0.1（见 app.js auditBindHost）
    bindHost: '127.0.0.1',
    token: '',                // 控制台访问令牌；留空 = 不校验（仅 bindHost 为回环时允许）
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  // 预算保险丝：今日估算成本达到上限（元）自动暂停；0 = 不限制
  budget: {
    dailyCostYuan: 0
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

/** 掩码形态：正常掩码（••/****），或被 ASCII 编码器"吃掉"后的残骸（连续问号）。 */
function looksMasked(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (text.includes('••') || text.includes('****')) return true;
  return /\?{4,}/.test(text);
}

/**
 * 掩码不该出现在配置里：它只是给界面看的占位符，一旦落盘就会被当成真密钥发出去。
 * 更隐蔽的是 `sk-••••••••107d` 这种掩码经过一次 ASCII 编码会变成 `sk-????????107d`，
 * 连 stripMaskedSecrets 都认不出来，于是模型请求拿一串问号当 key，
 * 表现就是「聊着聊着机器人突然不回话，而界面显示密钥已配置」。
 * 这里按 providers 目录把真密钥找回来；找不到就清空——宁可显示「未配置」。
 */
function healMaskedSecrets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const norm = (value) => String(value ?? '').trim().replace(/\/+$/, '');
  const real = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate && !looksMasked(candidate)) return String(candidate);
    }
    return '';
  };
  const keyByBaseUrl = (url) => {
    const target = norm(url);
    if (!target) return '';
    const hit = providers.find((p) => p && norm(p.baseURL) === target);
    return hit ? real(hit.apiKey) : '';
  };

  if (cfg.api && looksMasked(cfg.api.apiKey)) {
    const byId = providers.find((p) => p && p.id === cfg.api.provider);
    cfg.api.apiKey = real(byId?.apiKey, keyByBaseUrl(cfg.api.baseUrl));
  }
  if (cfg.vision?.qwen && looksMasked(cfg.vision.qwen.apiKey)) {
    cfg.vision.qwen.apiKey = real(keyByBaseUrl(cfg.vision.qwen.baseUrl), cfg.audio?.apiKey);
  }
  if (cfg.audio && looksMasked(cfg.audio.apiKey)) {
    cfg.audio.apiKey = real(cfg.vision?.qwen?.apiKey, keyByBaseUrl(cfg.audio.baseUrl));
  }
  // 协议端令牌没人能还原，坏的直接清掉，让用户重登一次
  for (const field of ['accessToken', 'httpAccessToken']) {
    if (cfg.snowluma && looksMasked(cfg.snowluma[field])) cfg.snowluma[field] = '';
  }
  if (Array.isArray(cfg.webSearch?.anysearchKeys)) {
    cfg.webSearch.anysearchKeys = cfg.webSearch.anysearchKeys.filter(
      (key) => key && !looksMasked(key)
    );
  }
  return cfg;
}

/**
 * 配置完整性 + 身份闸（2026-10-25）
 *
 * 起因：config.json 是全项目**唯一**承载"她是谁"的文件（人设 + 密钥 + 白名单），
 * 但它偏偏是唯一不走 `json-store` 的 JSON —— 旧写法是
 * `catch { return structuredClone(DEFAULT_CONFIG) }`：不告警、不隔离原文件，
 * 进程照常起来变成出厂的小鲸鱼，而那个坏文件**原地不动**，等下一次
 * `updateConfig()` 用默认值把它覆盖掉 = 永久丢失、不可恢复。
 * 实测过：坏配置 → 出厂人设 + providers 为空 + 白名单为空 + **零日志**。
 * 表现是"服务正常、她不对劲"，和"服务挂了"一样难查（10-25 白名单事故同一家族）。
 *
 * 按 `json-store.js:14-24` 我们自己定的原则「**隔离后继续**」补齐：
 *   坏文件 → 改名 `.corrupt-<时间戳>` 留档（手工能捞）→ console.error 一条 → 才回默认。
 *
 * 再加一道身份闸（对应认知连续性样例的"反例 2：规则丢了不许强行唤醒"）：
 * 规则层为空时也要喊出来。空规则不是"失忆"，是"变成了别的东西"。
 * 这里只告警不停摆 —— 我们是常驻后台，拒绝启动 = 用户只看到"机器人不说话了"。
 */
let configIntegrity = { status: 'ok', quarantined: '', error: '', identityProblems: [], checkedAt: 0 };

/**
 * 人设正文的最短长度。短于它就是被清空/截断了，不是"写得简短"。
 * identity.js 的快照校验也用同一个值 —— 两处必须一致，否则"导出说合格、
 * 运行时说不合格"。
 */
export const MIN_ROLE_TEXT = 40;

/** 身份闸：纯函数，返回问题清单（不打印，便于测试直接断言）。 */
export function identityProblems(cfg) {
  const out = [];
  const p = cfg?.persona || {};
  if (!String(p.botName || '').trim()) out.push('persona.botName 为空');
  const role = String(p.roleText || '').trim();
  if (!role) out.push('persona.roleText 为空 —— 她会变成没有人格的通用助手');
  else if (role.length < MIN_ROLE_TEXT) out.push(`persona.roleText 只有 ${role.length} 字，疑似被清空或截断`);
  if (!String(p.masterQQ || '').trim()) out.push('persona.masterQQ 为空 —— 主人识别会失效');
  return out;
}

/** 供 /api/status 暴露，让控制台能显示"你现在跑在出厂配置上"。 */
export function getConfigIntegrity() {
  return { ...configIntegrity };
}

/**
 * schema 迁移。目前只有 0→1（= 打上版本标记），但**骨架必须先立起来**：
 * 等真的要改字段名时再补，就得面对"现场有多少份没有版本的旧文件"这个未知数。
 * 纯函数：不读盘、不写盘，便于测试。
 */
export function applySchema(cfg, raw) {
  const from = Number.isFinite(Number(raw?.schema)) ? Number(raw.schema) : 0;
  if (from > CONFIG_SCHEMA) {
    // 程序比配置旧：新字段会被老程序悄悄丢掉，必须喊
    console.warn(
      `[config] ⚠️ 配置文件 schema=${from} 高于本程序支持的 ${CONFIG_SCHEMA}，` +
      `多出来的字段会被忽略（甚至被下一次保存覆盖）。请升级程序。`
    );
    configIntegrity = { ...configIntegrity, schemaFrom: from, schemaTo: CONFIG_SCHEMA, schemaTooNew: true };
    return cfg;
  }
  let out = cfg;
  if (from < 1) {
    // 0→1：没有需要搬运的字段，只是把版本标记打上。
    // 将来真的改字段，就在这里写一节：读旧键 → 写新键 → 删旧键。
    out = { ...out, schema: 1 };
  }
  configIntegrity = { ...configIntegrity, schemaFrom: from, schemaTo: CONFIG_SCHEMA, schemaTooNew: false };
  return out;
}

export function loadConfig() {
  const { data, status, quarantined, error } = readJsonDetailed(CONFIG_FILE, null, { tag: 'config' });
  configIntegrity = {
    status,
    quarantined: String(quarantined || ''),
    error: String(error || ''),
    identityProblems: [],
    checkedAt: Date.now()
  };

  const usable = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  let cfg;
  if (status === 'ok' && usable) {
    cfg = healMaskedSecrets(deepMerge(DEFAULT_CONFIG, usable));
    cfg = applySchema(cfg, usable);
  } else {
    cfg = structuredClone(DEFAULT_CONFIG);
    // 'missing' 是首次启动，正常，不喊。只有真损坏/读不出来才喊。
    if (status === 'corrupt' || status === 'unreadable') {
      // 这一行最重要：把坏文件留下来。它可能只是结尾少个括号，手工就能救回来；
      // 一旦被默认值覆盖就永远没了。
      console.error(
        `[config] ⚠️ 配置文件${status === 'corrupt' ? '损坏' : '读不出来'}，已按出厂设置启动 —— ` +
        `人设/密钥/白名单全部为空。原文件已保留为：${quarantined || CONFIG_FILE}`
      );
    }
  }

  const problems = identityProblems(cfg);
  configIntegrity.identityProblems = problems;
  for (const p of problems) console.warn(`[config] 身份闸：${p}`);
  return cfg;
}

let currentConfig = null;
let saveTimers = new Map();

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
/** 白名单类配置的快照（只取会用到的字段，顺序稳定，便于比对）。 */
function snapshotAllow(cfg) {
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    groups: list(cfg?.allow?.groups),
    private: list(cfg?.allow?.private),
    denyGroups: list(cfg?.deny?.groups),
    denyPrivate: list(cfg?.deny?.private),
    allowAllWhenEmpty: cfg?.allowAllWhenEmpty === true
  };
}

/**
 * 白名单变更审计：每次改动追加一行到 `data/config-changes.jsonl`。
 *
 * 为什么需要（2026-10-25 实机教训）：白名单是**静默生效**的硬边界 ——
 * 少一个群，那个群里她就完全不响应、连聊天记录都不留，看起来和"服务挂了"一模一样。
 * 而 config.json 没有历史，事后只能靠翻备份猜（这次备份还停留在 10-19，根本查不到）。
 * 所以改成"改一次记一笔"：谁改的查不到，但**改前改后和 diff 一定查得到**。
 */
function auditAllowChange(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const added = after.groups.filter((id) => !before.groups.includes(id));
  const removed = before.groups.filter((id) => !after.groups.includes(id));
  const line = JSON.stringify({ at: new Date().toISOString(), added, removed, before, after });
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'config-changes.jsonl'), line + '\n', 'utf8');
  } catch (error) {
    console.error('[config] 白名单审计写入失败:', error?.message ?? error);
  }
  // 移除最危险：它会让机器人"在一个群里彻底消失"，必须出现在运行日志里，
  // 而不是只躺在审计文件中等人去翻。
  if (removed.length) console.warn(`[config] 白名单移除了 ${removed.length} 个群：${removed.join(', ')}`);
  if (added.length) console.log(`[config] 白名单新增 ${added.length} 个群：${added.join(', ')}`);
}

export function updateConfig(patch) {
  const before = snapshotAllow(getConfig());
  // 任何路径写进来的掩码都在落盘前还原成真密钥（见 healMaskedSecrets）
  currentConfig = healMaskedSecrets(deepMerge(getConfig(), patch));
  // 2026-10-26：身份闸以前只在 loadConfig 时算一次。改了人设之后
  // /api/status 显示的还是启动时的旧值 —— 面板会继续"一切正常"，
  // 而那正是这道闸存在的意义（让人看见"她现在跑在空人设上"）。
  configIntegrity = { ...configIntegrity, identityProblems: identityProblems(currentConfig), checkedAt: Date.now() };
  auditAllowChange(before, snapshotAllow(currentConfig));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}

// ── 多身份（身份模式 Identity Mode）──────────────────────────────────────
// 设计要点：
//   物理会话键 baseChatKey（如 private:123456789）= 消息"从哪来"；
//   有效会话键 = baseChatKey + ':' + mode（如 private:123456789:tutor）；
//   不同身份的历史/记忆/进度天然隔离（store/memory 都按 chatKey 分文件）。

export const DEFAULT_MODE = 'assistant';

/** 拆解 chatKey：kind / id / mode / base。 */
export function parseChatKey(chatKey) {
  const parts = String(chatKey || '').split(':');
  const kind = parts[0] || '';
  const id = parts[1] || '';
  const mode = parts[2] || '';
  return { kind, id, mode, base: `${kind}:${id}` };
}

/** 取某物理会话当前激活的身份模式（未配置或已删除的模式回退默认）。 */
export function getIdentityMode(baseChatKey) {
  const cfg = getConfig();
  const rec = cfg.personaModes?.[baseChatKey];
  const mode = rec?.mode || DEFAULT_MODE;
  if (mode !== DEFAULT_MODE && !cfg.identityModes?.[mode]) return DEFAULT_MODE;
  return mode;
}

/** 设置某物理会话的身份模式并持久化。
 *  注意：deepMerge 对同名字段做"深层合并"，删除 key 会失效，因此显式重建整个对象后整体覆盖。 */
export function setIdentityMode(baseChatKey, mode) {
  const cfg = getConfig();
  const m = String(mode || DEFAULT_MODE);
  const next = { ...(cfg.personaModes || {}) };
  if (m === DEFAULT_MODE) delete next[baseChatKey];
  else next[baseChatKey] = { mode: m, switchedAt: Date.now() };
  // 先清空再写入，绕开 deepMerge 的"保留旧键"行为
  getConfig().personaModes = {};
  updateConfig({ personaModes: next });
  return m;
}

/**
 * 旁路整理模型：摘要/事实抽取/记忆整理/反思用它。
 * 留空 → 回落主模型（行为与从前完全一致，零风险）。
 * 对齐 Letta 的 sleep-time agent：整理不在等回复的链路上，可以换更便宜或更强的模型。
 */
export function utilityModelOf(cfg = getConfig()) {
  const api = cfg?.api || {};
  const own = String(api.utilityModel || '').trim();
  return own || String(api.model || '').trim();
}

/** 模型窗口大小：手配优先，其次 /models 探测值（由调用方缓存后在轮内传入）。 */
export function contextWindowOf(cfg = getConfig(), discovered = 0) {
  const want = Number(cfg?.api?.contextWindow);
  if (Number.isFinite(want) && want > 0) return Math.floor(want);
  const got = Number(discovered);
  return Number.isFinite(got) && got > 0 ? Math.floor(got) : 0;
}

/** 物理会话键 → 有效会话键（按当前身份模式追加后缀）。 */
export function resolveChatKey(baseChatKey) {
  const { mode } = parseChatKey(baseChatKey);
  if (mode) return String(baseChatKey);
  const m = getIdentityMode(baseChatKey);
  return m === DEFAULT_MODE ? String(baseChatKey) : `${baseChatKey}:${m}`;
}

/** personaRef → 完整 persona 对象。支持 builtin:<id> / custom:<名或custom_N>。 */
export function resolvePersonaRef(ref) {
  if (!ref) return null;
  const cfg = getConfig();
  const s = String(ref).trim();
  if (s.startsWith('builtin:')) {
    const p = PERSONAS[s.slice(8)];
    if (!p) return null;
    return { botName: p.name, selfNickname: '', roleText: p.text, participation: 'medium', customRules: '' };
  }
  const key = s.startsWith('custom:') ? s.slice(7) : (s.startsWith('persona:') ? s.slice(8) : s);
  const list = cfg.customPersonas || [];
  let found = list.find((p) => p && p.name === key);
  // 用稳定 id 绑定（custom_<hash>）也要认 —— 只认 name 的话，改了名字的绑定会静默失效
  if (!found) found = list.find((p) => p && String(p.id || '') === key);
  // 老的下标写法（custom_0）继续兼容
  if (!found && /^custom_\d+$/.test(key)) found = list[Number(key.slice(7))];
  if (!found) return null;
  return {
    botName: found.botName || found.name || cfg.persona.botName,
    selfNickname: found.selfNickname ?? '',
    roleText: found.text || '',
    participation: found.participation || cfg.persona.participation,
    customRules: found.customRules || ''
  };
}

/**
 * 解析某会话键应使用的人设与模式信息。
 * 优先级：personaBindings[有效键] > personaBindings[物理键] > 模式映射表 > 模式人设 > 全局默认。
 */
export function resolvePersona(chatKey) {
  const cfg = getConfig();
  const { base, mode } = parseChatKey(chatKey);
  const activeMode = mode || getIdentityMode(base);
  const modeDef = activeMode === DEFAULT_MODE ? null : (cfg.identityModes?.[activeMode] || null);

  const bindings = cfg.personaBindings || {};
  const ref = bindings[String(chatKey)] || bindings[base] || modeDef?.personaRef || '';
  const fromRef = resolvePersonaRef(ref);

  const persona = fromRef || {
    botName: cfg.persona.botName,
    selfNickname: cfg.persona.selfNickname,
    roleText: cfg.persona.roleText,
    participation: cfg.persona.participation,
    customRules: cfg.persona.customRules
  };
  return { persona, mode: activeMode, modeDef, baseChatKey: base };
}
