// GPT-SoVITS 语音合成客户端（角色本音，替代千问 TTS）
//
// 服务：gpt-sovits-app/GPT-SoVITS-v2pro-20250604/api_v2.py（127.0.0.1:9880）
// 模型：原神/星铁官方角色微调模型 + 带情绪标注的参考音频
//   胡桃    v4          GPT_weights_v4 + SoVITS_weights_v4
//   纳西妲   v4         GPT_weights_v4 + SoVITS_weights_v4
//   芙宁娜   v4         GPT_weights_v4 + SoVITS_weights_v4
//   神里绫华 v4         GPT_weights_v4 + SoVITS_weights_v4
//   花火    v2ProPlus   GPT_weights_v2ProPlus + SoVITS_weights_v2ProPlus
//   流萤    v2ProPlus   GPT_weights_v2ProPlus + SoVITS_weights_v2ProPlus
//
// 注意：API 是「全局单模型」，切换角色要重载权重。实测在 RTX3050 4GB 上
//   v4←→v4 切换 3.5~5.3s、v2ProPlus 1.2s，都能切成功 —— 前提是 G2PW 那个
//   onnx 多音字模型别抢显存（见 GPT_SoVITS/text/g2pw/onnx_api.py 的 CPU 兜底）。
//   显存被 G2PW 吃掉时的症状是 set_sovits_weights 报
//   `CUDA out of memory`，且一挂就是全部音色都挂。
// 这里做当前角色缓存，只有角色变化时才切换。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, getConfig } from './config.js';
import { resolveSpeed, describeSpeed } from './prosody.js';
import { applyPostChain, postChainEnabled, DEFAULT_POST_CHAIN } from './voice-postchain.js';
import { writeSnapshot } from './gsv-state.js';

const APP_DIR = path.join(ROOT, 'gpt-sovits-app', 'GPT-SoVITS-v2pro-20250604');
const DEFAULT_API = 'http://127.0.0.1:9880';
// API 地址可配（audio.gsvUrl）：默认 9880；测试或换端口时可以指到别处。
// 用函数而不是常量 —— config 支持热更新，读常量会拿到启动时的旧值。
function gsvApi() {
  try {
    const u = String(getConfig()?.audio?.gsvUrl || '').trim();
    if (u) return u.replace(/\/+$/, '');
  } catch { /* 配置读不出就用默认 */ }
  return DEFAULT_API;
}
const PY = path.join(APP_DIR, 'runtime', 'python.exe');
const ENTRY = path.join(APP_DIR, 'api_v2.py');
const INFER_YAML = 'GPT_SoVITS/configs/tts_infer.yaml';
const LOG_FILE = path.join(ROOT, 'gpt-sovits-api.log');

// 角色配置
export const GSV_VOICES = {
  hutao: {
    name: '胡桃',
    gpt: 'GPT_weights_v4/胡桃_ZH-e10.ckpt',
    sovits: 'SoVITS_weights_v4/胡桃_ZH_e10_s860_l32.pth',
    ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【默认】嘿嘿，毕竟找活人不是我擅长的事嘛，如果让我找的是「边界」另一边的人….wav',
    prompt: '嘿嘿，毕竟找活人不是我擅长的事嘛，如果让我找的是「边界」另一边的人…',
    // 官方只给了 1 条【默认】参考音频，六种情绪是本机自己造的：
    // 千问 TTS 按情绪句式合成 → RVC(hutao) 换成胡桃音色 → rvc/train/enhance.py 压掉
    // 声码器编造的高频（≥10kHz 衰减，减金属感）。成品在 rvc/train/emo/*_final.wav，
    // 与【默认】那条真人的 MFCC 余弦相似度 0.993~0.998，音色是连续的。
    // 时长 3.1~4.4s、48kHz、已归一化到峰值 0.91 以下 —— 都在 GPT-SoVITS 推荐区间内。
    // 重新生成：node gen_emotions.mjs --install=hutao（缺哪条补哪条，已存在的跳过），
    // 再造完跑 node rvc/train/check_emotions.mjs 做质量核验（ASR 回读 / F0 极差 / 音色余弦）。
    emotions: {
      '中立': { ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【中立】今天天气还不错，要不要一起出去走走？.wav', prompt: '今天天气还不错，要不要一起出去走走？' },
      '开心': { ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【开心】哇——你终于来啦！我等你好久好久了哦！.wav', prompt: '哇——你终于来啦！我等你好久好久了哦！' },
      '生气': { ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【生气】哼！你这个人怎么这么过分啊，我真的生气了！.wav', prompt: '哼！你这个人怎么这么过分啊，我真的生气了！' },
      '难过': { ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【难过】……算了，反正你也不会明白的。.wav', prompt: '……算了，反正你也不会明白的。' },
      '吃惊': { ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【吃惊】诶——？你说什么？怎么会突然变成这样！.wav', prompt: '诶——？你说什么？怎么会突然变成这样！' },
      '恐惧': { ref: 'gpt-sovits-models/hutao/v4/胡桃_ZH/reference_audios/中文/emotions/【恐惧】别过来……这里不对劲，我们快走。.wav', prompt: '别过来……这里不对劲，我们快走。' },
    },
  },
  nahida: {
    name: '纳西妲',
    gpt: 'GPT_weights_v4/纳西妲_ZH-e10.ckpt',
    sovits: 'SoVITS_weights_v4/纳西妲_ZH_e10_s1400_l32.pth',
    ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【默认】很抱歉地告诉大家，根据我们的调查，在梦境的背后隐藏着某种阴谋。.wav',
    prompt: '很抱歉地告诉大家，根据我们的调查，在梦境的背后隐藏着某种阴谋。',
    // 和胡桃一样，六种情绪也是本机自己造的（官方只给 1 条【默认】）：
    // 千问 TTS 按情绪句式合成 → RVC(nahida.pth) 换成纳西妲音色 → enhance.py 压高频。
    // 质量核验（check_emotions.mjs --dir=nahida）：
    //   音色余弦 0.985~0.996、F0 极差 140Hz、ASR 回读全部认对。
    // 注意纳西妲的发声习惯和胡桃不同：她的「生气」不是拔高，而是压低再发力
    //   （实测 angry 的 F0 中位 248Hz，是这批里最低的；p10 只有 104Hz）——
    //   这是角色特征，不是录坏了，别拿"生气应该更高"去套。
    // 采样率统一从 RVC 的 40kHz 重采样到 48kHz，与官方【默认】那条一致
    //   （GPT-SoVITS 内部会重采样，但同目录内保持统一更省心）。
    // 重新生成：node gen_emotions.mjs --only=nahida --install=nahida
    emotions: {
      '中立': { ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【中立】今天天气还不错，要不要一起出去走走？.wav', prompt: '今天天气还不错，要不要一起出去走走？' },
      '开心': { ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【开心】哇——你终于来啦！我等你好久好久了哦！.wav', prompt: '哇——你终于来啦！我等你好久好久了哦！' },
      '生气': { ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【生气】哼！你这个人怎么这么过分啊，我真的生气了！.wav', prompt: '哼！你这个人怎么这么过分啊，我真的生气了！' },
      '难过': { ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【难过】……算了，反正你也不会明白的。.wav', prompt: '……算了，反正你也不会明白的。' },
      '吃惊': { ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【吃惊】诶——？你说什么？怎么会突然变成这样！.wav', prompt: '诶——？你说什么？怎么会突然变成这样！' },
      '恐惧': { ref: 'gpt-sovits-models/nahida/v4/纳西妲_ZH/reference_audios/中文/emotions/【恐惧】别过来……这里不对劲，我们快走。.wav', prompt: '别过来……这里不对劲，我们快走。' },
    },
  },
  sparkle: {
    name: '花火',
    gpt: 'GPT_weights_v2ProPlus/花火-e10.ckpt',
    sovits: 'SoVITS_weights_v2ProPlus/花火_e10_s80.pth',
    ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【开心】最近想根据性格给自己打造一个全新面具，换一副样子玩玩。有没有什么推荐？.wav',
    prompt: '最近想根据性格给自己打造一个全新面具，换一副样子玩玩。有没有什么推荐？',
    // ★ 2026-10-30：官方只给了 4 条（开心/难过/吃惊/恐惧），它们在 emotions/ 里
    //   躺了很久却从没被登记进这张表 —— 等于白存（语气系统看不到，永远走参数模式）。
    //   这次一并处理：
    //     · 补登记那 4 条官方音频（原声比合成自然，不覆盖，gen_emotions.mjs
    //       --install 现在遇到同名标签已有文件会 [keep] 跳过）；
    //     · 新造「生气」「中立」两条（RVC 模型 huahuo.pth），补齐 6 档。
    //   核验：音色余弦 0.990~0.998、F0 极差 175Hz。
    //   注：花火的 angry/calm 两条 F0 中位几乎一样（276.7 vs 277.2），但动态范围差很多
    //       （angry p10~p90 = 100~547Hz，calm 75~392Hz）—— 生气是"起伏大"，不是"音更高"。
    //       别只看中位数就以为两条录重了。
    //   采样率统一成 48kHz（官方那 4 条原本是 44.1kHz）。
    emotions: {
      '中立': { ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【中立】今天天气还不错，要不要一起出去走走？.wav', prompt: '今天天气还不错，要不要一起出去走走？' },
      '开心': { ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【开心】最近想根据性格给自己打造一个全新面具，换一副样子玩玩。有没有什么推荐？.wav', prompt: '最近想根据性格给自己打造一个全新面具，换一副样子玩玩。有没有什么推荐？' },
      '生气': { ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【生气】哼！你这个人怎么这么过分啊，我真的生气了！.wav', prompt: '哼！你这个人怎么这么过分啊，我真的生气了！' },
      '难过': { ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【难过】——活在梦里的人们，真的能够远离痛苦，收获真正的幸福吗？.wav', prompt: '——活在梦里的人们，真的能够远离痛苦，收获真正的幸福吗？' },
      '吃惊': { ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【吃惊】…好吧，看你这个表情是不会相信我的…没事，我可以明天再来问你一遍！.wav', prompt: '…好吧，看你这个表情是不会相信我的…没事，我可以明天再来问你一遍！' },
      '恐惧': { ref: 'gpt-sovits-models/sparkle/v2ProPlus/花火/reference_audios/中文/emotions/【恐惧】合作对象储备库….wav', prompt: '合作对象储备库…' },
    },
  },
  liuying: {
    name: '流萤',
    gpt: 'GPT_weights_v2ProPlus/流萤-e10.ckpt',
    sovits: 'SoVITS_weights_v2ProPlus/流萤_e10_s250.pth',
    // 默认用「开心」那条：完整句子、起音干净；「中立」那条以省略号开头，容易被模仿成拖音
    ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【开心】我最喜欢这家店的橡木蛋糕卷，每天都要吃一个。.wav',
    prompt: '我最喜欢这家店的橡木蛋糕卷，每天都要吃一个。',
    // 流萤是唯一带 6 种情绪参考的音色，可按语气换参考音频（其余型号只有 1 条）
    emotions: {
      '中立': { ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【中立】…我应该会选择请求猎犬家系停止追捕。.wav', prompt: '…我应该会选择请求猎犬家系停止追捕。' },
      '开心': { ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【开心】我最喜欢这家店的橡木蛋糕卷，每天都要吃一个。.wav', prompt: '我最喜欢这家店的橡木蛋糕卷，每天都要吃一个。' },
      '生气': { ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【生气】小心，更多怪物进来了！准备开火！.wav', prompt: '小心，更多怪物进来了！准备开火！' },
      '难过': { ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【难过】抱歉，我不得不这么做…….wav', prompt: '抱歉，我不得不这么做……' },
      '吃惊': { ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【吃惊】快起来啦…没有人靠磕头打商战的吧…….wav', prompt: '快起来啦…没有人靠磕头打商战的吧……' },
      '恐惧': { ref: 'gpt-sovits-models/liuying/v2ProPlus/流萤/reference_audios/中文/emotions/【恐惧】…但感谢你出手相助，是真的。.wav', prompt: '…但感谢你出手相助，是真的。' },
    },
  },
  // 小鱼（昔涟）：本机自训音色 —— 2026-10-29 从「小鱼语音包-最终版.zip」接入。
  // 训练方式/踩坑记录见 docs/小鱼语音训练方式.md；参考音频清单见
  // gpt-sovits-models/xiaoyu/v2/reference_audios/refs.json（音频↔文本↔备注三元组，
  // 格式学自训练工程的 prompts.json）。
  // ★ 参数是这套权重自己实测调过的（temperature 0.6 / top_k 12 / top_p 0.85 / speed 0.95），
  //   和其它音色的 NEUTRAL_PARAMS 不同 —— 最优参数跟着训练数据走，不套通用表。
  //   version 是 v2：sample_steps 对它无效，buildTtsQuery 不会下发（设计如此）。
  xiaoyu: {
    name: '小鱼',
    gpt: 'GPT_weights_v2/小鱼_s1_e7.ckpt',
    sovits: 'SoVITS_weights_v2/小鱼_clean.pth',
    ref: 'gpt-sovits-models/xiaoyu/v2/reference_audios/ref_1.wav',
    prompt: '就像初遇时那样，再一次呼唤我昔涟，好吗？嗨，好久不见，接下来想如何度过美妙的双人时间呢？',
    speed: 0.95,
    toneParams: { temperature: 0.6, topK: 12, topP: 0.85 },
    emotions: {
      '中立': { ref: 'gpt-sovits-models/xiaoyu/v2/reference_audios/ref_1.wav', prompt: '就像初遇时那样，再一次呼唤我昔涟，好吗？嗨，好久不见，接下来想如何度过美妙的双人时间呢？' },
      '开心': { ref: 'gpt-sovits-models/xiaoyu/v2/reference_audios/ref_2.wav', prompt: '那好啦，不许忘记哦。从天真无邪的迷迷，到青春活泼的昔涟，再到美丽优雅又幸福的德谬歌。' },
      '难过': { ref: 'gpt-sovits-models/xiaoyu/v2/reference_audios/ref_3.wav', prompt: '因为有你，人家的故事终于圆满了呢。无论涟漪如何荡漾，都是我们亲手写的。' },
      '恐惧': { ref: 'gpt-sovits-models/xiaoyu/v2/reference_audios/ref_4.wav', prompt: '能在梦里听见朦胧的神域，还在他的指引下潜行，人家也觉得很神奇呢。' },
    },
  },
  furina: {
    name: '芙宁娜',
    gpt: 'GPT_weights_v4/芙宁娜_ZH-e10.ckpt',
    sovits: 'SoVITS_weights_v4/芙宁娜_ZH_e10_s950_l32.pth',
    ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【默认】根据故事走向，前往特定情景吗？听起来挺新颖。所以信封里写了什么？.wav',
    prompt: '根据故事走向，前往特定情景吗？听起来挺新颖。所以信封里写了什么？',
    // 六种情绪是本机造的（官方只给 1 条【默认】）。RVC 权重来自 HF
    // mrmocciai/genshin-impact 的 furina_rmvpe.pth（RVC v2 40k），
    // 链路：TTS → RVC(furina.pth) → enhance.py → 重采样 48kHz。
    // 核验：音色余弦 0.983~0.994、F0 极差 133Hz、ASR 全部认对。
    // ⚠️ 芙宁娜这个模型对**含省略号的短促句**特别不稳（实测「别过来……这里不对劲」
    //    会被念成「别动，你别动…」甚至「妈妈在呢」，且每次重跑结果都不同）。
    //    恐惧那条已改成无省略号的连贯句式。以后重做时别把省略号加回去。
    emotions: {
      '中立': { ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【中立】今天天气还不错，要不要一起出去走走？.wav', prompt: '今天天气还不错，要不要一起出去走走？' },
      '开心': { ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【开心】哇——你终于来啦！我等你好久好久了哦！.wav', prompt: '哇——你终于来啦！我等你好久好久了哦！' },
      '生气': { ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【生气】哼！你这个人怎么这么过分啊，我真的生气了！.wav', prompt: '哼！你这个人怎么这么过分啊，我真的生气了！' },
      '难过': { ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【难过】……算了，反正你也不会明白的。.wav', prompt: '……算了，反正你也不会明白的。' },
      '吃惊': { ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【吃惊】诶——？你说什么？怎么会突然变成这样！.wav', prompt: '诶——？你说什么？怎么会突然变成这样！' },
      '恐惧': { ref: 'gpt-sovits-models/furina/v4/芙宁娜_ZH/reference_audios/中文/emotions/【恐惧】别过来，这里不对劲，我们快点走，别回头。.wav', prompt: '别过来，这里不对劲，我们快点走，别回头。' },
    },
  },
  ayaka: {
    name: '神里绫华',
    gpt: 'GPT_weights_v4/神里绫华_ZH-e10.ckpt',
    sovits: 'SoVITS_weights_v4/神里绫华_ZH_e10_s670_l32.pth',
    ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【默认】看来，你们能理解我的心情了，既然这样，不知能否再考虑一下….wav',
    prompt: '看来，你们能理解我的心情了，既然这样，不知能否再考虑一下…',
    // 她的参考音频本身偏「端庄慢速」（实测 3.5 字/秒，胡桃 3.9、纳西妲 4.8），
    // 不补偿的话语言条会显得拖；1.15 能提到约 4.0 字/秒且不影响咬字。
    speed: 1.15,
    // 六种情绪本机自造。RVC 权重来自 HF mrmocciai/genshin-impact 的
    // ayaka-rmvpe.pth（RVC v2 40k）—— 同一仓库里还有 ayaka-v2 / ayaka_400 两个版本，
    // 选了 rmvpe 是因为和 furina 那套同系列，f0 提取方法一致。
    // 核验：音色余弦 0.987~0.995、F0 极差 184Hz（六个角色里最大）。
    // 注：她的「恐惧」F0 到 434Hz，是这批最高的 —— 绫华平时声线端庄，
    //     惊恐时反差会比别人更明显，听起来不违和，属于角色特性。
    emotions: {
      '中立': { ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【中立】今天天气还不错，要不要一起出去走走？.wav', prompt: '今天天气还不错，要不要一起出去走走？' },
      '开心': { ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【开心】哇——你终于来啦！我等你好久好久了哦！.wav', prompt: '哇——你终于来啦！我等你好久好久了哦！' },
      '生气': { ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【生气】哼！你这个人怎么这么过分啊，我真的生气了！.wav', prompt: '哼！你这个人怎么这么过分啊，我真的生气了！' },
      '难过': { ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【难过】……算了，反正你也不会明白的。.wav', prompt: '……算了，反正你也不会明白的。' },
      '吃惊': { ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【吃惊】诶——？你说什么？怎么会突然变成这样！.wav', prompt: '诶——？你说什么？怎么会突然变成这样！' },
      '恐惧': { ref: 'gpt-sovits-models/ayaka/v4/神里绫华_ZH/reference_audios/中文/emotions/【恐惧】别过来，这里不对劲，我们快点走，别回头。.wav', prompt: '别过来，这里不对劲，我们快点走，别回头。' },
    },
  },
};

/** 把自由文本的语气词映射到音色自带的情绪参考音频（只对配了 emotions 的音色有效）。 */
export function pickEmotion(voiceKey, style) {
  const v = GSV_VOICES[voiceKey];
  if (!v?.emotions || !style) return null;
  const s = String(style);
  // 顺序要紧：先说「不生气」再匹配「生气」会误判，所以先判否定词
  const table = [
    ['难过', /难过|伤心|委屈|遗憾|低落|沮丧|悲伤/],
    ['生气', /生气|愤怒|恼火|火大|凶|警告/],
    ['吃惊', /吃惊|惊讶|震惊|意外|吓一跳/],
    ['恐惧', /恐惧|害怕|怕|紧张|不安/],
    ['开心', /开心|高兴|愉快|轻快|俏皮|欢快|笑/],
    ['中立', /平静|中立|普通|平淡|认真|严肃/],
  ];
  for (const [tag, re] of table) {
    if (re.test(s) && v.emotions[tag]) return tag;
  }
  return null;
}

// ★ 不能默认成某个角色：API 的默认权重在 GPT_SoVITS/configs/tts_infer.yaml 里（当前是花火），
//   这里若硬写 'hutao'，第一次请求胡桃会被缓存判成"已加载"而跳过切换，
//   结果是拿花火的权重配胡桃的参考音频 —— 音色全错，还查不出来。
//   置空后首次请求一定会真正切一次（实测 1~5 秒）。
let loadedVoice = null;

/** 当前（最近一次成功切换）已加载的角色 key；null = 未知/未加载。 */
export function loadedVoiceKey() {
  return loadedVoice;
}

/**
 * 音色用的模型版本。决定哪些合成参数真的有效：
 *   - v4 / v3 走 vocoder 分支（TTS.py 的 use_vocoder=True），sample_steps 才有意义，
 *     且 aux_ref_audio_paths / streaming_mode 在它们身上是**无效或直接报错**的。
 *   - v2ProPlus 走另一条解码路径，能吃多参考音频融合，但 sample_steps 对它没作用。
 */
export function voiceVersion(v) {
  if (v?.sovits?.includes('v2ProPlus')) return 'v2ProPlus';
  // v2 自训权重（小鱼）：v4 专属的 sample_steps 对它无效，别按 v4 下发。
  if (v?.sovits?.includes('weights_v2/')) return 'v2';
  return 'v4';
}

/**
 * 读一个"可选的数字配置"。没配就返回 undefined。
 *
 * ★ 不能用裸 Number()：`Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`。
 *   直接转会把"没配"读成"配了 0"，然后 0 被夹成下限 —— 用户什么都没改，
 *   参数却悄悄变成了 8 步，音质莫名变差还查不出原因。这里只认数字和非空数字字符串。
 */
function readNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 拼 `/tts?` 的 query。
 *
 * ★ 为什么单独抽成纯函数：这是"参数到底发了什么"的唯一真相源。
 *   以前它和网络请求、文件系统检查、降级链全糊在 gsvSpeak 里，
 *   结果就是改一个参数没法单独测，只能真起一个 GSV 服务听一遍 —— 慢且不可回归。
 *   现在不读盘、不发请求、不写日志，`test/test-gsv-query.mjs` 能直接断言。
 *
 * @param {object} o
 * @param {string} o.text          要合成的文本
 * @param {string} o.refPath       参考音频绝对路径
 * @param {string} o.promptText    参考音频对应的文本
 * @param {number} o.speedFactor   最终语速倍数（调用方已算好基准×情绪×标点）
 * @param {object} [o.plan]        voice-delivery.resolveTone() 的产物
 * @param {string} [o.version]     音色版本（voiceVersion 的结果）
 * @param {object} [o.audio]       config.audio（不给就当作"全默认"）
 * @returns {{query: URLSearchParams, params: object, sampleSteps?: number, seed?: number}}
 */
export function buildTtsQuery({ text, refPath, promptText, speedFactor, plan = null, version = 'v4', audio = null, voiceTone = null } = {}) {
  const q = new URLSearchParams();
  const a = audio && typeof audio === 'object' ? audio : {};

  q.set('text', String(text || '').trim());
  q.set('text_lang', 'zh');
  q.set('ref_audio_path', String(refPath || ''));
  q.set('prompt_lang', 'zh');
  q.set('prompt_text', String(promptText || ''));
  q.set('text_split_method', 'cut5');
  q.set('media_type', 'wav');
  const sp = Number(speedFactor);
  q.set('speed_factor', String(Number.isFinite(sp) && sp > 0 ? sp : 1.0));

  // ── 韵律参数（api_v2 的 TTS_Request 全都支持，此前一个都没用）──────────────
  // 只下发"和默认值不同"的项：默认值由服务端自己带，多发等于多一层维护面。
  // 关掉：audio.toneParams = false（回到只用 speed_factor 的老样子）。
  const paramsOut = {};
  // ★ 音色自带参数（xiaoyu.toneParams）：这套权重自己实测出的最优组合，优先于情绪表。
  //   理由：最优参数跟着训练数据走 —— 通用表（NEUTRAL_PARAMS 基准）对自训 v2 权重不成立
  //   （temperature 0.85 下限对它是错的，它实测 0.6 最稳）。关掉：audio.toneParams = false。
  let tone = plan?.params || null;
  if (voiceTone && a.toneParams !== false) {
    tone = { ...(tone || {}), ...voiceTone };
  }
  if (tone && a.toneParams !== false && (plan?.enabled || voiceTone)) {
    const p = tone;
    const put = (key, val, dflt) => {
      const n = Number(val);
      if (!Number.isFinite(n) || n === dflt) return;
      q.set(key, String(n));
      paramsOut[key] = n;
    };
    put('temperature', p.temperature, 1);
    put('top_k', p.topK, 15);
    put('top_p', p.topP, 1);
    put('fragment_interval', p.fragmentInterval, 0.3);
    put('repetition_penalty', p.repetitionPenalty, 1.35);
  }

  // ── 扩散步数（只对 v4/v3 生效）───────────────────────────────────────────
  // 32 是服务端默认值，等于默认值时不下发。越界夹到 [8, 64]：
  // 低于 8 音质塌得厉害，高于 64 只是白等 —— 都不值得让它"成功但难听"。
  let sampleSteps;
  if (version === 'v4') {
    const raw = readNum(a.gsvSampleSteps);
    if (raw !== undefined && raw !== 32) {
      const clamped = Math.min(64, Math.max(8, Math.round(raw)));
      if (clamped !== 32) {
        q.set('sample_steps', String(clamped));
        sampleSteps = clamped;
      }
    }
  }

  // ── 随机种子 ────────────────────────────────────────────────────────────
  // -1（或没配）= 不下发 = 保持服务端每次随机（今天的行为）。
  // 固定值 = 同句同参数出同一条音频，用来 A/B 和复现"这句怎么念成这样"。
  let seed;
  const rawSeed = readNum(a.gsvSeed);
  if (rawSeed !== undefined && rawSeed !== -1) {
    const s = Math.trunc(rawSeed);
    q.set('seed', String(s));
    seed = s;
  }

  // ★ 明确不下发的四个，附理由，免得下一轮又有人"顺手加上"：
  //   aux_ref_audio_paths —— v4 走 vocoder 分支，只用 refer_spec[0] 单条参考
  //     （TTS.py 的 using_vocoder_synthesis / ..._batched_infer 都取 [0]），
  //     融合逻辑在 module/models.py 的 decode() 里，那条路 v4 根本不走。传了是白传。
  //   streaming_mode —— v4 传 2/3 会在 TTS.py 里 raise RuntimeError("SoVits V3/4 不支持流式")；
  //     传 1 等于"整段合成完再分块返回"，而我们要拿完整 buffer 交给 ffmpeg 转 16k 语音条，
  //     首字延迟对语音条没有意义。
  //   parallel_infer / batch_size —— 服务端默认值已是最优，且与上面的分支互相牵制。

  return { query: q, params: paramsOut, sampleSteps, seed };
}

/**
 * 列出全部角色本音 + 本机是否真的能用。
 * 设置页的下拉就靠这个：权重或参考音频缺任何一个都标成不可用，
 * 免得选了之后每句话都静默降级成千问 TTS（听感完全是另一个人）。
 */
export function listGsvVoices() {
  return Object.entries(GSV_VOICES).map(([key, v]) => {
    const missing = [];
    if (!fs.existsSync(path.join(APP_DIR, v.gpt))) missing.push('GPT 权重');
    if (!fs.existsSync(path.join(APP_DIR, v.sovits))) missing.push('SoVITS 权重');
    if (!fs.existsSync(path.join(ROOT, v.ref))) missing.push('参考音频');
    return {
      key,
      name: v.name,
      version: voiceVersion(v),
      emotions: v.emotions ? Object.keys(v.emotions) : [],
      speed: v.speed || 1.0,
      available: missing.length === 0,
      missing,
      loaded: loadedVoice === key,
    };
  });
}

/** 检查 API 是否在线 */
export async function gsvHealth(timeoutMs = 3000) {
  try {
    const res = await fetch(`${gsvApi()}/docs`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

let gsvChild = null;
let gsvStarting = null;

function appendLog(text) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + text);
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

/**
 * 确保角色本音推理服务在跑。
 * ★ 之前这个服务只能手动启：忘了启 → 每句话都静默降级成千问 TTS，
 *   用户看到的现象就是「换哪个音色都一样」。所以这里做成按需拉起。
 *   首次冷启动要加载 BERT/hubert/权重，约 30~90 秒，比 RVC 慢得多。
 */
export async function ensureGsvService({ log = null, force = false } = {}) {
  const alive = await gsvHealth(1200);
  if (alive.ok) return { ok: true, started: false };
  const cfg = getConfig();
  const autoStart = cfg.audio?.gsvAutoStart !== false;
  if (!autoStart && !force) {
    return { ok: false, reason: '角色本音服务没在跑，且没开自动启动（audio.gsvAutoStart）' };
  }
  if (gsvStarting) return gsvStarting;
  if (!fs.existsSync(PY)) return { ok: false, reason: '找不到 runtime/python.exe：' + PY };
  if (!fs.existsSync(ENTRY)) return { ok: false, reason: '找不到 api_v2.py：' + ENTRY };

  gsvStarting = (async () => {
    try {
      // 不加 detached（Windows 上 detached 会开新控制台）；windowsHide 静默启动
      const apiBase = gsvApi();
      const apiPort = (() => { try { return new URL(apiBase).port || '9880'; } catch { return '9880'; } })();
      gsvChild = spawn(PY, [ENTRY, '-a', '127.0.0.1', '-p', apiPort, '-c', INFER_YAML], {
        cwd: APP_DIR,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      appendLog('启动角色本音服务 pid=' + gsvChild.pid + '\n');
      gsvChild.stdout.on('data', (b) => appendLog(String(b)));
      gsvChild.stderr.on('data', (b) => appendLog(String(b)));
      gsvChild.on('exit', (code) => {
        appendLog('角色本音服务退出 code=' + code + '\n');
        gsvChild = null;
        // 服务一挂，进程内「已加载角色」缓存立刻作废 —— 不清掉的话服务重启后
        // 第一次合成会拿旧缓存跳过 set_*_weights，音色错位（active.json 模式要防的事故）。
        loadedVoice = null;
      });
      if (log) log('角色本音服务启动中…（首次加载模型约 30~90 秒）');

      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const h = await gsvHealth(2000);
        if (h.ok) return { ok: true, started: true };
      }
      return { ok: false, reason: '角色本音服务启动超时（180s），详见 ' + LOG_FILE };
    } finally {
      gsvStarting = null;
    }
  })();
  return gsvStarting;
}

/** 切换角色权重（只在角色变化时执行） */
async function ensureVoice(key) {
  const v = GSV_VOICES[key];
  if (!v) throw new Error(`未知角色: ${key}`);
  if (loadedVoice === key) return v;

  const setW = async (endpoint, p) => {
    const u = `${gsvApi()}/${endpoint}?weights_path=${encodeURIComponent(p)}`;
    const res = await fetch(u, { signal: AbortSignal.timeout(180000) });
    const txt = await res.text();
    if (!res.ok || /failed/i.test(txt)) throw new Error(`${endpoint} 失败: ${txt.slice(0, 160)}`);
    return txt;
  };

  await setW('set_gpt_weights', v.gpt);
  await setW('set_sovits_weights', v.sovits);
  loadedVoice = key;
  // 落状态快照（学自小鱼语音包的 active.json）：排查「当前到底加载的谁」时
  // 有据可查，不必翻 api 日志。
  writeSnapshot({ voice: key, s1: v.gpt, s2: v.sovits });
  return v;
}

/** 用角色本音合成一句话。
 * @param {object} [opts]
 * @param {string} [opts.voice]    角色 key（GSV_VOICES 的键）
 * @param {string} [opts.style]    语气描述（自由文本）。配了 emotions 的音色会据此换参考音频
 * @param {number} [opts.speed]    显式语速（给了就完全不自动算）
 * @param {object} [opts.plan]     voice-delivery.resolveTone() 的产物：情绪标签 + 韵律参数。
 *   给了 plan 之后，参考音频按 plan.gsv 精确选（而不是正则猜 style），
 *   并把 temperature/top_k/top_p/fragment_interval/repetition_penalty 一起下发。
 * @param {number} [opts.sampleSteps] 临时覆盖 audio.gsvSampleSteps（基准脚本用；不写配置）。
 * @returns {{buffer, ext, seconds, costMs, voice, emotion, speed, mode, params, sampleSteps, seed}}
 */
export async function gsvSpeak(text, { voice = 'hutao', style = '', speed = null, plan = null, sampleSteps = null, timeoutMs = 180000 } = {}) {
  // 先确保推理服务在跑：没启就按需拉起（否则每句话都会静默降级成千问 TTS，
  // 表现就是"换了音色听感没变化"）。
  const up = await ensureGsvService();
  if (!up.ok) throw new Error(up.reason || '角色本音服务不可用');

  const v = await ensureVoice(voice);

  // 情绪来源优先级：
  //   ① plan.gsv —— 结构化标签，能精确命中就命中（"别扭"→生气那条参考音频）
  //   ② pickEmotion(style) —— 模型直接写了 style 的自由文本（老路径，保留）
  //   ③ 默认那条参考音频
  // ★ 为什么不能让正则当主路径：模型写"温柔安慰"这种词，正则只能命中有限的几个字，
  //   永远切不到流萤那 6 条参考音频 —— 等于白存。
  const planTag = plan?.enabled && plan?.gsv && v.emotions?.[plan.gsv] ? plan.gsv : '';
  const emo = planTag || pickEmotion(voice, style);
  const refRel = emo ? v.emotions[emo].ref : v.ref;
  const promptText = emo ? v.emotions[emo].prompt : v.prompt;

  const refPath = path.join(ROOT, refRel);
  if (!fs.existsSync(refPath)) throw new Error('参考音频缺失: ' + refRel);

  // 语速：调用方显式给了就用它（工具里允许手动指定），否则 = 该音色的基准 × 语气倍数。
  //
  // ★ 2026-10-25 之前这里是 `speed ?? v.speed ?? 1.0`，也就是**每个音色一个固定速度**：
  //   同一句话"好呀～"和"快点！！"念出来节奏完全一样，听感像播报。
  //   现在用 prosody.js 按标点/语气词算一个 0.88~1.26 的乘数（零模型调用、零延迟），
  //   基准仍由音色决定，这里只做乘法。关掉：audio.prosodyAuto = false。
  const baseSpeed = Number(speed ?? v.speed ?? 1.0);
  let speedFactor = baseSpeed;
  const audioCfg = (() => {
    try { return getConfig()?.audio || {}; } catch { return {}; }
  })();
  const prosodyOn = audioCfg.prosodyAuto !== false;
  // ★ 2026-10-29：再乘一层"情绪偏置"（plan.speedBias）。情绪说"累"就再慢一档，
  //   和文本标点算出来的语速叠在一起 —— 两条线互补，谁也不会覆盖谁。
  const emotionBias = Number(plan?.enabled ? plan.speedBias : 1) || 1;
  if (speed === null || speed === undefined) {
    if (prosodyOn) {
      const r = resolveSpeed(String(text || ''), baseSpeed, { emotionBias });
      speedFactor = r.speed;
      if (r.tags.length || r.bias !== 1) {
        console.log(`[voice] ${describeSpeed(String(text || ''), baseSpeed, { emotionBias })}`);
      }
    }
  }

  // 参数拼装全在 buildTtsQuery 里（纯函数，test/test-gsv-query.mjs 直接断言）。
  // sampleSteps 参数只给基准脚本临时覆盖用 —— 走的是同一条拼装路径，不是另开一条。
  const effectiveAudio =
    sampleSteps === null || sampleSteps === undefined
      ? audioCfg
      : { ...audioCfg, gsvSampleSteps: sampleSteps };
  const { query: q, params: paramsOut, sampleSteps: stepsOut, seed } = buildTtsQuery({
    text,
    refPath,
    promptText,
    speedFactor,
    plan,
    version: voiceVersion(v),
    audio: effectiveAudio,
    voiceTone: v.toneParams || null,
  });

  const t0 = Date.now();
  const res = await fetch(`${gsvApi()}/tts?${q.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`GPT-SoVITS 合成失败 ${res.status}: ${String(msg).slice(0, 150)}`);
  }
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (!buffer.length) throw new Error('合成返回空音频');

  // 转 16kHz 单声道 + 人声后处理链（响度对齐/降噪/去齿音，学自小鱼训练工程）。
  // 后处理失败或 audio.postChain=false 时退回老的裸 16k 转换，行为与接入前一致。
  const postOn = postChainEnabled(audioCfg.postChain);
  let wav16 = null;
  if (postOn) {
    const post = await applyPostChain(buffer, { enabled: true, chain: DEFAULT_POST_CHAIN });
    if (post.processed) {
      wav16 = { buffer: post.buffer, seconds: post.seconds };
    } else {
      console.warn('[voice] 后处理链未生效（' + (post.reason || '') + '），退回裸转 16k');
    }
  }
  if (!wav16) wav16 = await toQqVoice(buffer);

  return {
    buffer: wav16.buffer,
    ext: 'wav',
    seconds: wav16.seconds,
    costMs: Date.now() - t0,
    voice: v.name,
    emotion: emo || '',
    // 实际用的语速倍数（便于排查"改了语气听感没变"：日志里能对上这一条）
    speed: Number(q.get('speed_factor')) || 1,
    // 'ref' = 真的换了情绪参考音频；'param' = 只靠参数微调（该音色没有这条情绪参考）
    mode: planTag ? 'ref' : 'param',
    // 实际下发的韵律参数（空对象 = 没下发，等于老行为）
    params: paramsOut,
    // 实际下发的扩散步数 / 种子（undefined = 没下发）。排查"调了听不出区别"先看这两个：
    // 音色是 v2ProPlus 时 sampleSteps 一定是 undefined，那是设计如此，不是配置没生效。
    sampleSteps: stepsOut,
    seed,
  };
}

/** wav → 16kHz 单声道（用 ffmpeg 转，失败则原样返回） */
async function toQqVoice(buffer) {
  const { spawnSync } = await import('node:child_process');
  const { resolveFfmpeg } = await import('./media-tools.js');
  const tmpIn = path.join(ROOT, 'data', 'voice', '_gsv_in_' + Date.now() + '.wav');
  const tmpOut = path.join(ROOT, 'data', 'voice', '_gsv_out_' + Date.now() + '.wav');
  try {
    fs.mkdirSync(path.dirname(tmpIn), { recursive: true });
    fs.writeFileSync(tmpIn, buffer);
    // 不再写死某台机器上的第三方 ffmpeg 路径（换机必挂，而且挂了以后是静默降级 ——
    // 44.1kHz 立体声被当语音条发出去，QQ 端转码失败，表现就是"语音发不出去"）。
    const ff = resolveFfmpeg();
    const r = spawnSync(ff, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', tmpOut], { encoding: 'utf8', timeout: 30000 });
    if (r.status === 0 && fs.existsSync(tmpOut)) {
      const buf = fs.readFileSync(tmpOut);
      return { buffer: buf, seconds: Math.round((buf.length - 44) / 32000 * 10) / 10 };
    }
    console.warn('[voice] ffmpeg 转 16k 失败，原样发送:', String(r.stderr || r.error?.message || '').slice(0, 200));
  } catch (error) {
    console.warn('[voice] ffmpeg 不可用，原样发送:', error?.message ?? error);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
  return { buffer, seconds: 0 };
}
