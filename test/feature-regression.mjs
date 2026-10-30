import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { PERSONAS } from '../src/personas.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { buildToolDefs, executeTool } from '../src/tools.js';
import { MoodStore } from '../src/mood.js';
import { searchMemes } from '../src/memes.js';
import { chooseInitialModel, isComplexRequest, formatModelChain } from '../src/model-routing.js';
import { addUsageForModel } from '../src/llm.js';
import { buildNapcatProcessScript, buildNapcatLaunchArgs } from '../src/napcat-process.js';
import { buildTtsRequest, resolveVoice, isQwen3Tts, isCosyvoice, normalizeCosyvoiceInstruction, explainCosyvoiceError, buildAsrRequest, audioDataUri } from '../src/qwen-audio.js';
import { analyzeWithQwenVision, buildQwenVisionMessages, qwenVisionInfo } from '../src/qwen-vision.js';
import { containsInlineToolSyntax, parseInlineToolCalls } from '../src/orchestrator.js';
import { segmentsToText } from '../src/onebot.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-feature-'));

try {
  // 情绪：按会话隔离、直接互动升温、时间衰减和重置
  const moodFile = path.join(tempDir, 'moods.json');
  const moods = new MoodStore(moodFile);
  assert.strictEqual(moods.get('group:1').score, 50);
  const warm = moods.observe('group:1', { direct: true, freshReply: true });
  assert.strictEqual(warm.score, 54);
  assert.strictEqual(moods.get('group:2').score, 50);
  const later = moods.get('group:1', Date.now() + 7 * 60 * 60 * 1000);
  assert.strictEqual(later.score, 52);
  assert.strictEqual(moods.reset('group:1').score, 50);

  // 梗库：精确、别名、标签和无结果
  const memeFile = path.join(tempDir, 'memes.json');
  fs.writeFileSync(memeFile, JSON.stringify({
    memes: [{
      key: '典',
      aliases: ['典中典'],
      meaning: '典型套路',
      usage: '调侃',
      tone: '轻松',
      tags: ['群聊']
    }]
  }));
  assert.strictEqual(searchMemes('典中典', { file: memeFile }).results[0].key, '典');
  assert.strictEqual(searchMemes('群聊', { file: memeFile }).results[0].key, '典');
  assert.strictEqual(searchMemes('完全不存在', { file: memeFile }).found, false);

  // 路由：普通短句 Flash，代码/长文/文件走 Pro，定时任务保持 Flash
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.model = 'deepseek-flash';
  cfg.api.complexModel = 'deepseek-v4-pro';
  assert.strictEqual(chooseInitialModel({
    cfg,
    triggerEntries: [{ text: '在吗' }]
  }), 'deepseek-flash');
  assert.strictEqual(chooseInitialModel({
    cfg,
    triggerEntries: [{ text: '这段代码报错了，帮我分析堆栈' }]
  }), 'deepseek-v4-pro');
  assert.strictEqual(chooseInitialModel({
    cfg,
    triggerEntries: [{ text: '看下文件', media: [{ kind: 'file' }] }]
  }), 'deepseek-v4-pro');
  cfg.vision = { mode: 'qwen', qwen: { apiKey: 'test-key' } };
  assert.strictEqual(chooseInitialModel({
    cfg,
    triggerEntries: [{ text: '看看这张图', media: [{ kind: 'image' }] }]
  }), 'deepseek-flash');
  cfg.vision = { mode: 'native' };
  assert.strictEqual(chooseInitialModel({
    cfg,
    triggerEntries: [{ text: '提醒我明天考试' }],
    pushTask: { kind: 'reminder' }
  }), 'deepseek-flash');
  assert.strictEqual(isComplexRequest('x'.repeat(801)), true);
  assert.strictEqual(formatModelChain(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro']), 'deepseek-flash→deepseek-v4-pro');

  // 会话按模型累计 usage
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, models: {} };
  addUsageForModel(usage, 'deepseek-flash', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  addUsageForModel(usage, 'deepseek-v4-pro', { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 });
  assert.strictEqual(usage.models['deepseek-flash'].calls, 1);
  assert.strictEqual(usage.models['deepseek-v4-pro'].totalTokens, 24);

  // 新人格、正确性规则、梗规则和动态称呼已进入提示词
  const runtime = structuredClone(DEFAULT_CONFIG);
  runtime.api.model = 'deepseek-flash';
  runtime.persona = {
    botName: '测试鲸',
    selfNickname: '小测',
    roleText: PERSONAS.xiaojingyu_tsundere_v1.text,
    participation: 'medium',
    customRules: '',
    masterQQ: '10000001'
  };
  setRuntimeConfig(runtime);
  const system = buildSystemPrompt({ persona: runtime.persona });
  for (const marker of ['正确性优先', '像真人说话', '傲娇不等于装傻', '测试鲸', '小测', '内容已经展开']) {
    assert.ok(system.includes(marker), `系统提示缺少：${marker}`);
  }
  for (const banned of ['作为AI，我是一个助手', '客服很高兴为您服务']) {
    assert.ok(!system.includes(banned), `系统提示不应包含：${banned}`);
  }

  const toolDefs = buildToolDefs();
  const tools = toolDefs.map((tool) => tool.name);
  assert.ok(tools.includes('search_meme'), '缺少 search_meme');
  assert.ok(tools.includes('escalate_reasoning'), '缺少 escalate_reasoning');
  assert.ok(!tools.includes('schedule_query'), '已移除的课表工具不应重新注册');
  assert.ok(!system.includes('schedule_query'), '系统提示词不应再引用已移除的课表工具');

  const stopScript = buildNapcatProcessScript({ dir: 'C:\\qq agent\\snowluma', embeddedPid: 123, kill: true });
  assert.ok(stopScript.includes('NapCatWinBootMain.exe'), '快速关闭脚本能定位 NapCat 根进程');
  assert.ok(stopScript.includes('taskkill.exe /F /T /PID'), '快速关闭脚本会关闭整个进程树');
  assert.deepStrictEqual(
    buildNapcatLaunchArgs({ qqExe: 'C:\\QQ\\QQ.exe', hookDll: 'D:\\hook.dll', accountQQ: '10000002' }),
    ['C:\\QQ\\QQ.exe', 'D:\\hook.dll', '-q', '10000002'],
    '配了账号号时启动参数应带 -q 快速登录'
  );
  assert.deepStrictEqual(
    buildNapcatLaunchArgs({ qqExe: 'C:\\QQ\\QQ.exe', hookDll: 'D:\\hook.dll', accountQQ: '' }),
    ['C:\\QQ\\QQ.exe', 'D:\\hook.dll'],
    '未配账号号时启动参数不带 -q（回退扫码）'
  );

  // 语音（TTS）：请求体按模型系列分流 + 各系列默认音色不通用
  const nrt = buildTtsRequest({ text: '你好', model: 'qwen-audio-3.0-tts-plus' });
  assert.ok(nrt.path.includes('/services/audio/tts/SpeechSynthesizer'), 'Qwen-Audio-TTS 走 SpeechSynthesizer 端点');
  assert.strictEqual(nrt.payload.input.voice, 'longanlingxin', 'plus 默认音色 longanlingxin');
  assert.strictEqual(nrt.payload.input.format, 'mp3', 'NRT 默认输出 mp3');
  const q3 = buildTtsRequest({ text: 'hi', model: 'qwen3-tts-flash' });
  assert.ok(q3.path.includes('/services/aigc/multimodal-generation/generation'), 'qwen3-tts 走 multimodal-generation 端点');
  assert.strictEqual(q3.payload.input.voice, 'Cherry', 'qwen3-tts 默认音色 Cherry');
  assert.ok(isQwen3Tts('qwen3-tts-flash') && !isQwen3Tts('qwen-audio-3.0-tts-plus'), '模型系列判定正确');
  assert.strictEqual(resolveVoice('qwen-audio-3.0-tts-flash'), 'longanhuan_v3.6', 'flash 的默认音色与 plus 不同');
  assert.strictEqual(resolveVoice('qwen-audio-3.0-tts-plus', 'longanlufeng'), 'longanlufeng', '显式音色优先');
  const nrtInst = buildTtsRequest({ text: '你好', model: 'qwen-audio-3.0-tts-plus', instruction: '开心俏皮' });
  assert.strictEqual(nrtInst.payload.input.instruction, '开心俏皮', 'NRT 带 instruction 语气指令');
  const q3Inst = buildTtsRequest({ text: 'hi', model: 'qwen3-tts-instruct-flash', instruction: '开心俏皮' });
  assert.strictEqual(q3Inst.payload.input.instructions, '开心俏皮', 'qwen3-tts-instruct 用 instructions 字段');

  // ── CosyVoice（2026-10-20 语音全哑的两个根因，见 src/qwen-audio.js 文件头）──
  assert.ok(isCosyvoice('cosyvoice-v3-flash') && !isCosyvoice('qwen-audio-3.0-tts-plus'), 'CosyVoice 系列判定正确');
  assert.strictEqual(resolveVoice('cosyvoice-v3-flash', ''), 'longanhuan', 'v3-flash 默认音色必须是 CosyVoice 那套，不能落回 qwen 的 longanlingxin（引擎 418）');
  assert.strictEqual(resolveVoice('cosyvoice-v3-flash', 'longanyang'), 'longanyang', '显式音色仍然优先');
  // instruction：只接受固定句式（中文句号 + 不能有半角空格），自由描述会让整个请求 428
  assert.strictEqual(
    normalizeCosyvoiceInstruction('你说话的情感是 neutral.').instruction,
    '你说话的情感是neutral。',
    '带空格/英文句号的句式要被重建（这两处各错一次都会 428）'
  );
  assert.strictEqual(normalizeCosyvoiceInstruction('像真人在QQ上发语音，带一点傲娇俏皮').instruction, '你说话的情感是happy。', '自由描述按关键词落到 happy');
  assert.strictEqual(normalizeCosyvoiceInstruction('声音很低落').instruction, '你说话的情感是sad。', '自由描述能认出 sad');
  assert.strictEqual(normalizeCosyvoiceInstruction('请用山东话表达。').instruction, '请用山东话表达。', '方言句式本身合法，原样放行');
  const cosy = buildTtsRequest({ text: '你好', model: 'cosyvoice-v3-flash', instruction: '像真人在QQ上发语音聊天' });
  assert.ok(cosy.path.includes('/SpeechSynthesizer'), 'CosyVoice 走 SpeechSynthesizer 端点');
  assert.strictEqual(cosy.payload.input.voice, 'longanhuan', 'CosyVoice 请求体里不能出现 qwen 音色');
  assert.strictEqual(cosy.payload.input.instruction, '你说话的情感是happy。', 'CosyVoice 的 instruction 必须已归一化');
  assert.ok(cosy.notes.length > 0, '归一化过就必须留痕（别让用户以为自己的语气设置生效了）');
  assert.ok(/418/.test(explainCosyvoiceError('[cosyvoice:]Engine return error code: 418', { model: 'cosyvoice-v3-flash', voice: 'longanlingxin' })) &&
    /音色/.test(explainCosyvoiceError('[cosyvoice:]Engine return error code: 418', { model: 'cosyvoice-v3-flash', voice: 'longanlingxin' })),
    '418 要解释成"音色不属于该模型"');
  assert.ok(/instruction/.test(explainCosyvoiceError('[cosyvoice:]Engine return error code: 428', { model: 'cosyvoice-v3-flash' })),
    '428 要解释成"instruction 句式不合法"');

  // 语音识别（ASR）：compatible-mode 的 chat/completions + input_audio（data URI）
  const asrReq = buildAsrRequest({ dataUri: 'data:audio/mpeg;base64,AAA', format: 'mp3', model: 'qwen3-omni-flash' });
  assert.strictEqual(asrReq.path, '/chat/completions', 'ASR 走 compatible-mode 的 chat/completions');
  const asrParts = asrReq.payload.messages[0].content;
  assert.strictEqual(asrParts[0].type, 'input_audio', 'ASR 请求带 input_audio');
  assert.strictEqual(asrParts[0].input_audio.data, 'data:audio/mpeg;base64,AAA', 'ASR 用 data URI 内联音频');
  assert.ok(String(asrParts[1].text).includes('转成中文'), 'ASR 带转写指令');
  assert.ok(audioDataUri(Buffer.from([1, 2, 3]), 'wav').startsWith('data:audio/wav;base64,'), 'audioDataUri 生成合法 data URI');
  assert.ok(audioDataUri(Buffer.from([1]), 'mp3').startsWith('data:audio/mpeg;base64,'), 'mp3 → audio/mpeg');

  const qwenMessages = buildQwenVisionMessages({
    dataUrls: ['data:image/png;base64,AAAA'],
    prompt: '识别文字'
  });
  assert.strictEqual(qwenMessages[0].content[0].type, 'image_url');
  assert.strictEqual(qwenMessages[0].content[1].text, '识别文字');
  const qwenInfo = qwenVisionInfo({ baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'qwen3-vl-plus' });
  assert.strictEqual(qwenInfo.hasKey, true);
  assert.strictEqual(qwenInfo.model, 'qwen3-vl-plus');

  const dsmlCall = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>'
    + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="get_recent_messages">'
    + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="limit">10</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>'
    + '</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>'
    + '</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
  const parsedDsml = parseInlineToolCalls(dsmlCall);
  assert.strictEqual(parsedDsml[0].name, 'get_recent_messages');
  assert.strictEqual(parsedDsml[0].args.limit, 10);
  assert.strictEqual(containsInlineToolSyntax(dsmlCall), true);

  // 合并转发：NapCat get_forward_msg 的 node 列表应转成可读聊天记录
  const forwardedText = await segmentsToText(
    [{ type: 'forward', data: { id: 'forward-1' } }],
    {
      resolveForward: async (id) => ({
        messages: [
          {
            type: 'node',
            data: {
              user_id: 10001,
              nickname: '甲',
              message: [
                { type: 'text', data: { text: '第一句' } },
                { type: 'image', data: { file: 'a.png' } }
              ]
            }
          },
          {
            type: 'node',
            data: {
              sender: { user_id: 10002, nickname: '乙' },
              content: [{ type: 'text', data: { text: '第二句' } }]
            }
          }
        ]
      })
    }
  );
  assert.ok(forwardedText.includes('甲(QQ:10001)：第一句[图片]'), '转发内容应包含第一位发送者及文字');
  assert.ok(forwardedText.includes('乙(QQ:10002)：第二句'), '转发内容应兼容 sender/content 字段');
  assert.ok(forwardedText.includes('id=forward-1'), '转发原文应保留可追溯 id');

  const failedForward = await segmentsToText(
    [{ type: 'forward', data: { id: 'forward-2' } }],
    { resolveForward: async () => { throw new Error('expired'); } }
  );
  assert.ok(failedForward.includes('id=forward-2'), '转发读取失败时应保留 id');
  assert.ok(failedForward.includes('读取失败'), '转发读取失败时应明确降级');

  const visionServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const hasImage = parsed.messages?.[0]?.content?.some((part) => part.type === 'image_url');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: parsed.model,
        choices: [{ message: { content: hasImage ? '识别成功' : '缺少图片' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }));
    });
  });
  await new Promise((resolve) => visionServer.listen(0, '127.0.0.1', resolve));
  const visionPort = visionServer.address().port;
  try {
    const analyzed = await analyzeWithQwenVision({
      rawConfig: {
        baseUrl: `http://127.0.0.1:${visionPort}/v1`,
        apiKey: 'test-key',
        model: 'qwen3-vl-plus'
      },
      dataUrls: ['data:image/png;base64,AAAA'],
      prompt: '识别'
    });
    assert.strictEqual(analyzed.text, '识别成功');

    const localImage = path.join(tempDir, 'qq-image.jpg');
    // 2026-10-26：图片读取现在要验魔数（防止把 config.json 当图片发给供应商），
    // 而 detectMime 需要至少 12 字节才能判格式。原来这里只写了 4 字节 [ff d8 ff d9]，
    // 会被判"不是图片"。真实图片不可能小于 12 字节，所以改的是测试数据不是闸。
    fs.writeFileSync(localImage, Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9
    ]));
    runtime.vision = {
      mode: 'qwen',
      qwen: {
        baseUrl: `http://127.0.0.1:${visionPort}/v1`,
        apiKey: 'test-key',
        model: 'qwen-vl-ocr'
      }
    };
    setRuntimeConfig(runtime);
    const imageToolResult = await executeTool(
      toolDefs,
      {
        chatKey: 'private:1',
        store: {
          findByMid: () => ({ mid: 1, media: [{ kind: 'image', file: 'qq-image.jpg' }] })
        },
        onebot: {
          call: async () => ({ file: localImage })
        }
      },
      'qwen_vision',
      JSON.stringify({ messageId: 1, prompt: '识别' })
    );
    assert.ok(String(imageToolResult.content).includes('Qwen-VL 识图结果'), 'QQ 图片应能通过 NapCat 本地缓存交给千问识别');
  } finally {
    visionServer.close();
  }

  const memeResult = await executeTool(toolDefs, {}, 'search_meme', JSON.stringify({ keyword: '典' }));
  assert.ok(String(memeResult.content).includes('典型'), 'search_meme 可执行');

  let escalated = false;
  const routingCtx = {
    routingEnabled: true,
    allowModelEscalation: true,
    modelEscalated: false,
    escalateModel() {
      escalated = true;
      this.modelEscalated = true;
      return true;
    }
  };
  const escalateResult = await executeTool(
    toolDefs,
    routingCtx,
    'escalate_reasoning',
    JSON.stringify({ reason: '需要复杂推理' })
  );
  assert.strictEqual(escalated, true, 'escalate_reasoning 应触发模型升级');
  assert.ok(String(escalateResult.content).includes('true'), '升级结果返回成功');

  console.log('✓ 傲娇人格、情绪、梗库和模型路由回归测试通过');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
