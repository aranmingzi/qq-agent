// 端到端审计：mock OneBot（WS 收事件 + HTTP 发送）+ mock OpenAI 兼容 API，
// 完整跑一遍核心需求流程，逐项断言。不触碰真实 QQ / 真实模型。
//
// 运行：node test/selftest.mjs（DEBUG_TESTS=1 输出诊断）
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

// ── 基础设施 ──
async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch { resolve(text); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

// ── Mock OneBot（HTTP + WS） ──
function createMockOneBotHttp() {
  const state = { sends: [], pokes: [] };
  const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const action = req.url.replace(/^\//, '');
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_login_info') return reply({ user_id: 888, nickname: '审计Bot' });
    if (action === 'get_group_info') return reply({ group_id: body.group_id, group_name: `审计群${body.group_id}` });
    if (action === 'get_group_member_info') return reply({ card: `名片${body.user_id}`, nickname: `昵称${body.user_id}` });
    if (action === 'get_group_list') return reply([{ group_id: 456, group_name: '审计群456' }, { group_id: 789, group_name: '备用群789' }]);
    if (action === 'get_friend_list') return reply([{ user_id: 777, nickname: '好友777', remark: '老友' }]);
    if (action === 'get_msg') return reply({ sender: { card: '被引用者', nickname: '被引用者' }, message: [{ type: 'text', data: { text: '被引用的原话' } }] });
    if (action === 'fetch_custom_face_detail') return reply([{ emoji_id: 'st1', res_id: 'st1', md5: 'aaa', desc: '滑稽', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` }]);
    if (action.startsWith('search')) {
      // 模拟 Bing 结果页（b_algo 块结构）
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>
        <li class="b_algo"><h2><a href="https://example.com/a">审计梗的完整解释</a></h2><p>审计梗是指……的完整解释内容。</p></li>
        <li class="b_algo"><h2><a href="https://example.com/b">第二个结果</a></h2><p>摘要二。</p></li>
      </body></html>`);
      return;
    }
    if (action === 'group_poke' || action === 'send_poke') {
      state.pokes.push(body);
      return reply({});
    }
    if (action === 'get_record') {
      // 假装协议端把 SILK 转码成 mp3 后的本地路径
      return reply({ file: state.recordFile || '', url: '' });
    }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      state.sends.push({ action, body, at: Date.now() });
      return reply({ message_id: 5000 + state.sends.length });
    }
    if (action === 'img.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
  return { server, state };
}

function createMockOneBotWs() {
  const state = { client: null, events: [] };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const ready = new Promise((r) => wss.once('listening', r));
  wss.on('connection', (socket) => { state.client = socket; });
  return {
    server: wss,
    state,
    async ready() { await ready; return wss.address().port; },
    push(event) {
      state.events.push(event);
      if (state.client && state.client.readyState === WebSocket.OPEN) {
        state.client.send(JSON.stringify(event));
      } else {
        throw new Error('Mock OneBot WS 尚无客户端连接');
      }
    },
    close() { return new Promise((r) => wss.close(r)); }
  };
}

// ── Mock OpenAI 兼容 API：脚本化响应 + 全量请求记录 ──
function createMockLLM() {
  const state = { requests: [], script: [], sideScript: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }));
      return;
    }
    // 语音合成（TTS）最小 mock：返回一个可下载的音频 URL（供 send_voice 端到端测试）
    if (req.method === 'POST' && req.url === '/api/v1/services/audio/tts/SpeechSynthesizer') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: { audio: { url: `http://127.0.0.1:${PORTS.llm}/tts-sample.mp3`, format: 'mp3' } }, usage: { characters: 6 } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/tts-sample.mp3') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA', 'base64'));   // 以 "ID3" 开头的假 mp3
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readBody(req);
      // 图片输入探测请求（vision scan）：不进脚本队列，按模型名给固定答案。
      // 用探测专属提问文本识别，避免误伤真实运行里"模型看图"的请求（同样带 image_url）。
      const isProbe = (body.messages || []).some((m) => Array.isArray(m.content)
        && m.content.some((c) => c.type === 'text' && String(c.text || '').includes('这张图片里是什么')));
      if (isProbe) {
        state.probes = state.probes || [];
        state.probes.push(body.model);
        if (String(body.model).includes('vision-no')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'image input is not supported for this model' } }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一个红色像素点' } }] }));
        }
        return;
      }
      // 语音识别（ASR）请求：带 input_audio → 直接回固定转写，不消耗脚本队列
      const hasAudio = (body.messages || []).some((m) => Array.isArray(m.content)
        && m.content.some((c) => c.type === 'input_audio'));
      if (hasAudio) {
        state.asrCalls = (state.asrCalls || 0) + 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '（测试转写）群友说了一句你好呀' } }] }));
        return;
      }
      // 旁路调用（往事摘要 / 记忆整理 / 事实抽取 / 私聊兜底重试）：这些一律**不传 tools**，
      // 而主对话请求必带。让它们消耗脚本队列是错的 —— 它们是在场景之间异步插进来的，
      // 每插一次，后面所有场景整体错位一格。
      // ⚠️ 2026-10-26 修的真实故障：past-summary 在场景 13 之后插了一次，吃掉下标 47，
      // 于是场景 14（图片）push 的两条落到 47/48，而它第一次请求已是 step 48 →
      // 拿到的是第二条「（图看到了）」而不是 get_message_images 工具调用 →
      // 模型压根没调看图工具，「图片注入」断言红了好几轮，一直被误判成产品缺陷。
      //
      // 旁路走**自己的队列** `sideScript`（按提示词特征路由、先进先出），
      // 这样主队列的索引永远只被主对话请求消耗，旁路什么时候插进来都不影响。
      if (!body.tools || (Array.isArray(body.tools) && body.tools.length === 0)) {
        const flat = JSON.stringify(body.messages || []);
        const kind = flat.includes('记忆整理模块') ? 'memory'
          : (flat.includes('寒暄、表情、语气词') ? 'past-summary' : 'other');
        state.sideCalls = (state.sideCalls || 0) + 1;
        state.sideKinds = state.sideKinds || [];
        state.sideKinds.push(kind);
        const queued = kind === 'memory' ? (state.sideScript || []).shift() : null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: queued ?? '- 测试旁路：固定一条' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }));
        return;
      }
      const step = state.requests.length;
      body.__auth = req.headers.authorization || '';   // 供"改 key 是否生效"的断言使用
      state.requests.push(body);
      let scripted = state.script[step];
      if (!scripted) scripted = { content: '（默认：无动作）' };
      if (scripted.delayMs) await sleep(scripted.delayMs);
      const message = { role: 'assistant', content: scripted.content ?? null };
      if (scripted.toolCalls) {
        message.tool_calls = scripted.toolCalls.map((tc, i) => ({
          id: `call_${step}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl_${step}`,
        model: 'test-model-a',
        choices: [{ index: 0, message, finish_reason: scripted.finishReason || (message.tool_calls ? 'tool_calls' : 'stop') }],
        usage: scripted.usage || { prompt_tokens: 100 + step * 10, completion_tokens: 20, total_tokens: 120 + step * 10 }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── 主流程 ──
const PORTS = {};
const results = [];
function pass(name, extra = '') {
  results.push({ name, ok: true, extra });
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'));
  process.env.QQ_AGENT_DATA_DIR = dataDir;

  const onebotHttp = createMockOneBotHttp();
  PORTS.onebotHttp = await listen(onebotHttp.server);
  const onebotWs = createMockOneBotWs();
  PORTS.onebotWs = await onebotWs.ready();
  const llm = createMockLLM();
  PORTS.llm = await listen(llm.server);

  // fixture：模拟 DSH settings.yaml + .credentials.yaml（密钥优先级：凭据文件 > 环境变量）
  const fixtureYaml = path.join(dataDir, 'dsh-settings.yaml');
  fs.writeFileSync(fixtureYaml, `
agent-default-model:
  provider: openrouter
  model: z-ai/glm-5.3-flash
llm-pi-ai:
  providers:
    a6api:
      displayName: A6API中转站
      apiKeyEnv: A6API_API_KEY
      api: anthropic-messages
      baseURL: https://api.a6api.com/v1
      models:
        - glm-5.3-flash
        - DeepSeek-V4-Flash-0731
    a6apiforclaude:
      displayName: A6API-Claude
      apiKeyEnv: A6API_API_KEY
      api: anthropic-messages
      baseURL: https://api.a6api.com
      models:
        - claude-fable-5
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - z-ai/glm-5.3-flash
    local-8787:
      displayName: 本地中转8787
      apiKeyEnv: LOCAL_8787_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - hy4-preview
        - glm-5.3-flash
    visiontest:
      displayName: 视觉探测测试
      apiKeyEnv: VISIONTEST_API_KEY
      baseURL: http://127.0.0.1:${PORTS.llm}/v1
      models:
        - vision-ok-model
        - vision-no-model
`);
  process.env.A6API_APIKEY = 'test-a6api-key'; // 模拟环境变量别名解析（应被凭据文件覆盖）
  fs.writeFileSync(path.join(dataDir, '.credentials.yaml'), `version: 1
refs:
  A6API_API_KEY: cred-a6api-key
  LOCAL_8787_API_KEY: cred-local-key
  VISIONTEST_API_KEY: cred-visiont${'est-key'}
`);

  const cfg = {
    api: { baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'test-key', model: 'test-model-a', vision: true, temperature: 0.7, maxRounds: 6, priceInputPerM: 2, priceOutputPerM: 8 },
    providersSourceYaml: fixtureYaml,
    webSearch: { enabled: true, searchUrl: `http://127.0.0.1:${PORTS.onebotHttp}/search`, maxResults: 6 },
    security: { allowPrivateImageHosts: false },
    snowluma: { wsUrl: `ws://127.0.0.1:${PORTS.onebotWs}`, httpUrl: `http://127.0.0.1:${PORTS.onebotHttp}`, accessToken: '' },
    persona: { botName: '审计Bot', participation: 'medium', roleText: '你是审计群里的机器人。' },
    allow: { groups: ['456'], private: ['777'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    wakeDelayMs: 300,
    drainDelayMs: 200,
    maxConcurrentRuns: 2,
    send: { minGapMs: 10, maxGapMs: 20, byLengthMs: 0, maxPerMinute: 100, maxPerHour: 1000, hardSplitAt: 4000 },
    // gsvAutoStart=false + gsvUrl 指到必拒端口：本机 9880 可能正跑着生产 GSV（实测会真的合成，
    // 胡桃 v4 慢过测试超时）。指死端口让 gsvSpeak 秒失败 → 走设计好的"降级千问 TTS"路径。
    audio: { gsvAutoStart: false, gsvUrl: 'http://127.0.0.1:9' },
    proactive: { enabled: false },
    sticker: { enabled: true, collectEnabled: true },
    store: { maxMessagesPerChat: 0, pastStateLimit: 80, pastStateMaxChars: 6000, keepSessionFiles: 100 },
    server: { port: await freePort(), token: '' }
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));

  const { createApp } = await import('../src/app.js');
  const app = createApp({ log: () => {} });
  await app.start();

  // 同步原语
  const waitSessionDone = async (triggerSubstring, timeout = 9000) => {
    const s = await waitFor(() => {
      const found = app.sessions.listSummaries(10).find((e) => (e.trigger || '').includes(triggerSubstring));
      if (found && found.status !== 'running') return found;
      return null;
    }, timeout, `会话(${triggerSubstring})结束`);
    return app.sessions.get(s.id);
  };
  const pushGroupMsg = (userId, name, text, mid, extra = {}) => onebotWs.push({
    post_type: 'message',
    message_type: 'group',
    group_id: 456,
    user_id: userId,
    self_id: 888,
    message_id: mid,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, card: name, nickname: name },
    message: [{ type: 'text', data: { text } }],
    ...extra
  });

  // ── 场景 0：OneBot 已连接 ──
  await waitFor(() => app.onebot.connected, 5000, 'OneBot WS 连接');
  pass('OneBot WebSocket 已连接并取得登录信息', `self=${app.onebot.selfId}`);

  // ── 场景 1：消息触发运行，模型用工具发言 ──
  llm.state.script.push(
    { delayMs: 400, toolCalls: [{ name: 'send_message', args: { messages: ['在的', '咋了 [CQ:at,qq=1]'] } }] },
    { content: '（第一轮处理完毕）' }
  );
  pushGroupMsg(111, '张三', '在吗？', 9001);

  await waitFor(() => llm.state.requests.length >= 1, 5000, '第一次 LLM 调用');
  const req1 = llm.state.requests[0];
  assert.strictEqual(req1.messages.length, 2, '第一次运行只应有 system+user 两条消息（零 LLM 历史）');
  assert.strictEqual(req1.messages[0].role, 'system');
  assert.strictEqual(req1.messages[1].role, 'user');
  const user1 = req1.messages[1].content;
  assert.ok(user1.includes('【本次唤醒】') && user1.includes('在吗？'), '用户消息含本次唤醒与触发文本');
  assert.ok(user1.includes('【当前时间】') && user1.includes('【过去状态】'), '用户消息含时间与过去状态');
  assert.ok(req1.tools?.some((t) => t.function.name === 'send_message'), 'send_message 工具已暴露');
  const toolNames = req1.tools.map((t) => t.function.name);
  assert.ok(!toolNames.some((n) => n.includes('qq_')), '工具名不带 qq_ 前缀');
  assert.ok(!toolNames.includes('wait_for_messages') && !toolNames.includes('set_wake_config'), '无等待/唤醒类工具');
  pass('运行 1：零历史提示词 + 工具集正确', `${user1.length} 字符用户消息`);

  const session1 = await waitSessionDone('在吗？');
  await waitFor(() => onebotHttp.state.sends.length >= 2, 5000, '两条 QQ 消息已发出');
  const send1 = onebotHttp.state.sends[0];
  const send2 = onebotHttp.state.sends[1];
  assert.strictEqual(send1.body.message[0].data.text, '在的');
  assert.strictEqual(send2.body.message[0].data.text, '咋了 [CQ：at,qq=1]', 'CQ 码已转义');
  pass('发送：分条 + 顺序 + CQ 转义正确');

  assert.ok(session1.status === 'done', `运行 1 状态应为 done，实际 ${session1.status}`);
  assert.strictEqual(session1.usage.totalTokens, 250, 'usage 已累计两次调用（120+130）');
  assert.strictEqual(session1.sent.length, 2, '会话记录了 2 条已发送');
  assert.ok(session1.systemPrompt && session1.userPrompt, '会话记录含完整提示词');
  pass('会话记录：状态/用量/已发送/提示词留档完整', `totalTokens=${session1.usage.totalTokens}`);

  // ── 场景 2：处理期间插入新消息 → 结束后 drain 新开会话（需求 5 核心流程） ──
  llm.state.script.push(
    { delayMs: 600, content: '（看看再说）' },          // 运行 A：只有一轮，人为拖慢
    { content: '（看了下是闲聊，不用回）' }             // drain 运行
  );
  const reqsBeforeA = llm.state.requests.length;
  pushGroupMsg(113, '王五', '看看这个', 9010);
  await waitFor(() => llm.state.requests.length >= reqsBeforeA + 1, 5000, '运行 A 开始');
  await sleep(250);                                    // 处于 600ms 延迟中 = 运行 A 进行中
  pushGroupMsg(111, '张三', '处理期间插进来的新消息', 9011);  // ← 关键注入

  const sessionA = await waitSessionDone('看看这个');
  assert.strictEqual(sessionA.status, 'noreply', '运行 A 没有发言（正常选项）');
  assert.ok(onebotHttp.state.sends.every((s) => s.body.message.at(-1).data.text !== '（看看再说）'), '思考文本不会发到 QQ');

  // drain：运行 A 结束后自动开新会话处理 9011
  await waitFor(() => llm.state.requests.length >= reqsBeforeA + 2, 6000, 'drain 运行开始');
  const drainReq = llm.state.requests.at(-1);
  assert.strictEqual(drainReq.messages.length, 2, 'drain 运行同样是全新会话（零历史）');
  assert.ok(drainReq.messages[1].content.includes('处理期间插进来的新消息'), 'drain 运行的【本次唤醒】是处理期间插入的消息');
  assert.ok(!drainReq.messages[1].content.includes('在的"') || drainReq.messages[1].content.includes('我：在的'), '此前发言只以存档形式出现');
  await waitSessionDone('处理期间插进来的新消息');
  pass('drain 循环：运行中新消息 → 结束后自动新开会话处理，每次 messages.length=2');

  const meta = app.store.getChatMeta('group:456');
  assert.strictEqual(meta.unread, 0, '所有消息已标记已读');
  assert.strictEqual(meta.total, 5, '存档 = 3 条收到的 + 2 条自己发的');
  pass('已读/未读驱动：处理完全部标记已读，自己的发言入档', `total=${meta.total}`);

  // ── 场景 3：白名单外完全忽略 ──
  const llmCallsBefore = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111, self_id: 888,
    message_id: 9100, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 111, card: '外人', nickname: '外人' },
    message: [{ type: 'text', data: { text: '白名单外' } }]
  });
  await sleep(800);
  assert.strictEqual(llm.state.requests.length, llmCallsBefore, '白名单外不触发 LLM');
  assert.strictEqual(app.store.listChats().includes('group:999'), false, '白名单外不写入存档');
  pass('白名单：群 999 被完全忽略');

  // ── 场景 4：引用消息解析 + reply 段 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['收到'], replyToMessageId: 9001 } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 113, self_id: 888,
    message_id: 9003, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 113, card: '王五', nickname: '王五' },
    message: [
      { type: 'reply', data: { id: 9001 } },
      { type: 'text', data: { text: '张三说的对' } }
    ]
  });
  await waitSessionDone('张三说的对');
  await waitFor(() => onebotHttp.state.sends.length >= 3, 5000, '引用场景的发送');
  const send3 = onebotHttp.state.sends[2];
  assert.strictEqual(send3.body.message[0].type, 'reply', '第一条带 reply 段');
  assert.strictEqual(send3.body.message[0].data.id, '9001');
  assert.strictEqual(send3.body.message[1].data.text, '收到');
  const replyRunReq = llm.state.requests.at(-2);
  assert.ok(replyRunReq.messages[1].content.includes('[引用 被引用者：被引用的原话]'), '引用原文被解析进上下文');
  pass('引用解析与 reply 段发送正确');

  // ── 场景 5：记忆跨运行持久（无状态但记忆保留） ──
  llm.state.script.push(
    { toolCalls: [{ name: 'memory_append', args: { category: 'activeTopic', content: '今晚吃什么' } }, { name: 'send_message', args: { messages: ['记下了'] } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '帮我记一下今晚吃什么', 9004);
  const session5 = await waitSessionDone('帮我记一下');
  assert.strictEqual(session5.status, 'done');
  assert.ok(app.memory.query('group:456', 'activeTopic').activeTopic.some((e) => e.content === '今晚吃什么'), '记忆已写入存储');

  llm.state.script.push({ content: '（看过了）' });
  const reqs5b = llm.state.requests.length;
  pushGroupMsg(112, '李四', '随便说说', 9005);
  await waitFor(() => llm.state.requests.length >= reqs5b + 1, 5000, '带记忆的后续运行开始');
  const memPrompt = llm.state.requests.at(-1).messages[1].content;
  assert.ok(memPrompt.includes('今晚吃什么'), '【记忆】跨运行出现在新会话的提示词里');
  await waitSessionDone('随便说说');
  pass('轻量记忆跨运行持久化');

  // ── 场景 6：表情包同步 + SSRF 拦截 + 发表情机制 ──
  const stickers = await app.stickers.sync(true);
  assert.ok(stickers.entries.length >= 1, '从 mock OneBot 同步到收藏表情');
  // 6a. 本地/内网地址的图片必须被拒绝（防护生效即"不发送"）
  llm.state.script.push(
    { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'st1' } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '来个表情', 9006);
  const stickerSession = await waitSessionDone('来个表情');
  assert.ok(
    stickerSession.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('不合法')),
    '内网图片地址被 SSRF 防护拦截并回传模型'
  );
  pass('表情包安全：内网/本机图片地址被拒绝');
  // 6b. 发送机制本身：绕过工具直接走发送队列，验证 image 段
  const sendsBeforeSticker = onebotHttp.state.sends.length;
  await app.sender.sendSticker('group:456', { id: 'st1', desc: '直发测试', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` }, {});
  await waitFor(() => onebotHttp.state.sends.length >= sendsBeforeSticker + 1, 5000, '表情发送');
  const stickerSend = onebotHttp.state.sends.at(-1);
  assert.strictEqual(stickerSend.body.message.at(-1).type, 'image', '表情以 image 段发送');
  assert.ok(stickerSend.body.message.at(-1).data.file.includes('/img.png'), '表情 URL 正确');
  pass('表情包发送：image 段 + 存档记录');

  // ── 场景 7：限频保护 ──
  // ⚠️ 这里必须显式关掉 `preflightQuota`（2026-10-29 第 3 轮加的额度前置感知）。
  // 本场景验的是**发送时**撞上上限之后的行为：模型已经跑完、错误回传给模型、
  // 带反走神护栏。前置感知会在开跑前就把这种轮次挡掉，于是 waitSessionDone
  // 永远等不到会话 —— 那不是回归，是两道闸门里更早的那道先响了。
  // 前置感知本身另有 test/test-send-quota-e2e.mjs 覆盖。
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ send: { maxPerMinute: 1, minGapMs: 5, maxGapMs: 10, byLengthMs: 0, maxPerHour: 1000, hardSplitAt: 4000, preflightQuota: false } })
  });
  await sleep(80);
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['一条', '两条', '三条'] } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '刷屏测试', 9007);
  const limited = await waitSessionDone('刷屏测试');
  // ⚠️ 这里的断言必须**跟着 sender.js 的原文走**，不能凭印象写子串。
  // 2026-10-25 真实红灯：文案从「没发出去」改成「**这条没有发出去**」（多了一个"有"字），
  // 行为一点没变，断言 substring 差一个字就红了 —— 这种红灯最难查，因为看起来像
  // "限流逻辑被改坏了"，实际只是措辞。所以下面断言「上限/没发出/反走神护栏」三件事，
  // 并在失败时把真实返回打出来，下次文案再改能一眼看出改了哪。
  const sendCall = limited.messages.find((m) => m.toolCall?.name === 'send_message');
  assert.ok(sendCall?.toolCall?.isError, '超限的发送必须作为错误回给模型（不能让它以为发出去了）');
  const limitRes = String(sendCall?.toolCall?.result || '');
  assert.ok(limitRes.includes('发到上限') && limitRes.includes('没有发出去'),
    `超限文案变了？实际返回：${limitRes.slice(0, 300)}`);
  // 这道护栏是 2026-10-25 加的：模型拿到"没发出去"会以为话没送到，
  // 自己编「我走神了，你说啥？」补场，所以错误里必须显式禁止。
  assert.ok(limitRes.includes('走神'), '超限错误必须自带「别编走神」护栏');
  pass('发送限频：超额部分被拒绝，错误回传模型（含反走神护栏）');
  // 恢复限频配置（preflightQuota 也要恢复成 true，否则后面场景都少了这道闸门）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ send: { maxPerMinute: 100, preflightQuota: true } })
  });

  // ── 场景 8：暂停开关 + 手动唤醒 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: true }) });
  const callsBeforePause = llm.state.requests.length;
  pushGroupMsg(111, '张三', '暂停期间的消息', 9008);
  await sleep(900);
  assert.strictEqual(llm.state.requests.length, callsBeforePause, '暂停期间不触发运行');
  assert.ok(app.store.getChatMeta('group:456').unread >= 1, '暂停期间消息仍入档为未读');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: false }) });
  llm.state.script.push({ content: '（恢复后检查一遍，不用回）' }); // 显式脚本，保证后续索引不漂移
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/wake`, { method: 'POST', body: '{}' });
  await waitSessionDone('暂停期间的消息');
  pass('暂停/恢复 + 手动唤醒（暂停期间消息积压为未读）');

  // ── 场景 9：私聊 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: '私聊回复' } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 9200, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '好友' },
    message: [{ type: 'text', data: { text: '单独找你' } }]
  });
  try {
    await waitFor(() => onebotHttp.state.sends.some((s) => s.action === 'send_private_msg'), 6000, '私聊发送');
  } catch (error) {
    if (process.env.DEBUG_TESTS) {
      console.log('[debug] newest session:', JSON.stringify(app.sessions.listSummaries(3), null, 1));
      const latest = app.sessions.get(app.sessions.listSummaries()[0]?.id);
      console.log('[debug] latest detail error:', latest?.error, 'status:', latest?.status);
      console.log('[debug] store chats:', app.store.listChats());
    }
    throw error;
  }
  const privSend = onebotHttp.state.sends.find((s) => s.action === 'send_private_msg');
  assert.strictEqual(privSend.body.user_id, 777);
  assert.strictEqual(privSend.body.message.at(-1).data.text, '私聊回复');
  await waitSessionDone('单独找你');
  pass('私聊流程正常');

  // ── 场景 6c：停用过滤 + 自动换发 + 每轮限量 ──
  const stickerDir = path.join(dataDir, 'sticker-files');
  fs.mkdirSync(stickerDir, { recursive: true });
  const goodBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const goodFile = path.join(stickerDir, 'GOODTEST.png');
  fs.writeFileSync(goodFile, goodBytes);
  const stampIso = () => new Date().toISOString();
  const mkSticker = (id, extra = {}) => ({
    id, resId: id, url: '', localPath: '', md5: '', desc: '', localNote: '', tags: [], usage: '',
    disabled: false, disabledReason: '', source: 'ai', useCount: 0, lastUsedAt: 0, lastContext: '',
    createdAt: stampIso(), updatedAt: stampIso(), ...extra
  });
  app.stickers.entries.push(mkSticker('good1', { localPath: goodFile, md5: 'GOODTEST', localNote: '情绪=开心；场景=打招呼', tags: ['开心', '打招呼'] }));
  app.stickers.entries.push(mkSticker('good2', { localPath: goodFile, md5: 'GOODTEST2' }));
  app.stickers.entries.push(mkSticker('dead1', { url: `http://127.0.0.1:${PORTS.onebotHttp}/gone.png`, disabled: true, disabledReason: '链接失效' }));

  llm.state.script.push(
    { toolCalls: [{ name: 'list_stickers', args: {} }] },
    { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'dead1' } }] },
    { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'good2' } }] },
    { content: 'ok' }
  );
  const sendsBeforeFallback = onebotHttp.state.sends.length;
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 9300, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '好友' },
    message: [{ type: 'text', data: { text: '表情兜底测试' } }]
  });
  const fallbackSession = await waitSessionDone('表情兜底测试');
  const listCall = fallbackSession.messages.find((m) => m.toolCall?.name === 'list_stickers');
  assert.ok(listCall && !String(listCall.toolCall.result).includes('dead1'), '停用条目不出现在 list_stickers');
  assert.ok(listCall && String(listCall.toolCall.result).includes('good1'), '可用条目仍能列出');
  const swapCall = fallbackSession.messages.find((m) => m.toolCall?.name === 'send_sticker');
  assert.ok(swapCall && !swapCall.toolCall.isError, '选中停用条目时自动换发、不再报错');
  assert.ok(String(swapCall.toolCall.result).includes('good1'), '工具结果里告知实际发出的表情');
  const stickerSends = onebotHttp.state.sends.slice(sendsBeforeFallback)
    .filter((s) => (s.body.message || []).some((seg) => seg.type === 'image'));
  assert.strictEqual(stickerSends.length, 1, '一轮只发出 1 张表情（限量生效）');
  const stickerFile = String(stickerSends[0].body.message.at(-1).data.file);
  assert.ok(stickerFile.startsWith('base64://'), '本地副本以 base64 直传');
  assert.ok(Buffer.from(stickerFile.slice('base64://'.length), 'base64').equals(goodBytes), 'base64 解出的字节与副本一致');
  const secondSend = fallbackSession.messages.filter((m) => m.toolCall?.name === 'send_sticker')[1];
  assert.ok(secondSend && secondSend.toolCall.isError && /本轮/.test(String(secondSend.toolCall.result)), '同一轮第二张被限量拦截');
  pass('表情库兜底：停用过滤 + 自动换发 + 每轮限量');

  // ── 场景 6c-2：同一张今天发满了 → 自动换发，不是报错 ──
  // 2026-10-28 实测：62 次 send_sticker 里 2 次死在「今天已经发过」，而换发那条路本来就有。
  // 上面 6c 已经在存档里把 good1/good2 各发了一次（今天），这里再要 good2：
  // 换发候选里只剩 good3，结果必须**不是**报错。
  //
  // ⚠️ 必须先把会话冷却关掉：更早的场景已经在群里发过表情，冷却会先一步把它挡住 ——
  //    那样断言到的其实是"冷却拦截"，看着绿，测的却不是日上限这条路径（第一版就是这么错的）。
  app.stickers.entries.push(mkSticker('good3', { localPath: goodFile, md5: 'GOODTEST3', localNote: '情绪=无语' }));
  const setStickerCfg = (patch) => fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sticker: patch })
  });
  // 只测日上限这一条路：冷却和表情自己的分钟额度都要先关掉 —— 更早的场景刚在群里发过一张，
  // 任何一个不关，断言到的都是额度拦截（第一版就先后被这两个抢先挡了两次）。
  await setStickerCfg({ cooldownMs: 0, maxPerMinute: 0 });
  // good2 在上面 6c 其实**没发出去**（同轮第二张被 maxPerRun 拦下），存档里没有它的记录。
  // 这里直接补一条"今天发过 good2"，否则断言到的会是"正常发出一张"，又不是日上限换发。
  app.store.appendSelf('private:777', { text: '[表情包：旧记录（good2）]', ts: Date.now() });
  try {
    llm.state.script.push(
      { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'good2' } }] },
      { content: 'ok' }
    );
    pushGroupMsg(111, '张三', '再发一张好图', 9406);
    const dailySession = await waitSessionDone('再发一张好图');
    const dailyCall = dailySession.messages.find((m) => m.toolCall?.name === 'send_sticker');
    assert.ok(dailyCall && !dailyCall.toolCall.isError, '今天已发满的图不该直接报错');
    assert.ok(/今天已经发过/.test(String(dailyCall.toolCall.result)), '结果里说明是因为今天发满了才换的');
    assert.ok(String(dailyCall.toolCall.result).includes('good3'), '换发到另一张可用的图');
  } finally {
    await setStickerCfg({ cooldownMs: 120000, maxPerMinute: 1 });
  }
  pass('表情日上限：命中后自动换发（不报错）');

  // ── 场景 6c-3：前几天发过的同一张 → 也不再用（复用冷却，reuseCooldownMs）──
  // dailyPerIdCap 只管当天；跨天复发才是"老用同一张"的真来源（近 3 天 28 次里 7 张各 2 次）。
  // 这里 backdate 一条昨天的记录：good4 今天没发 → 只该被复用冷却挡住，note 也必须说"最近几天"。
  app.stickers.entries.push(mkSticker('good4', { localPath: goodFile, md5: 'GOODTEST4', localNote: '情绪=无语' }));
  app.stickers.entries.push(mkSticker('good5', { localPath: goodFile, md5: 'GOODTEST5', localNote: '情绪=开心' }));
  app.store.appendSelf('private:777', { text: '[表情包：昨天那张（good4）]', ts: Date.now() - 24 * 3600 * 1000 });
  await setStickerCfg({ cooldownMs: 0, maxPerMinute: 0 });
  try {
    llm.state.script.push(
      { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'good4' } }] },
      { content: 'ok' }
    );
    pushGroupMsg(111, '张三', '发张昨天那张', 9407);
    const reuseSession = await waitSessionDone('发张昨天那张');
    const reuseCall = reuseSession.messages.find((m) => m.toolCall?.name === 'send_sticker');
    assert.ok(reuseCall && !reuseCall.toolCall.isError, '复用冷却命中时不该报错');
    const reuseRes = String(reuseCall.toolCall.result);
    assert.ok(/最近几天刚发过/.test(reuseRes), 'note 要说"最近几天"，不能混成"今天"');
    assert.equal(JSON.parse(reuseRes).stickerId, 'good5', '应该换发到唯一没在窗口里发过的 good5');
  } finally {
    await setStickerCfg({ cooldownMs: 120000, maxPerMinute: 1 });
  }
  pass('表情复用冷却：几天内发过的自动换发');

  // ── 场景 6d：同会话冷却 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'good1' } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 9301, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '好友' },
    message: [{ type: 'text', data: { text: '再发一张表情' } }]
  });
  const cooldownSession = await waitSessionDone('再发一张表情');
  const cdCall = cooldownSession.messages.find((m) => m.toolCall?.name === 'send_sticker');
  assert.ok(cdCall && cdCall.toolCall.isError && /冷却/.test(String(cdCall.toolCall.result)), '冷却期内拒绝再发');
  pass('表情冷却：同会话短时间内不重复发');

  // ── 场景 9.5：输出预算被截断 → 自动加预算重试（专业问题不再静默不答）──
  const reqsBeforeTrunc = llm.state.requests.length;
  llm.state.script.push(
    { content: null, finishReason: 'length', usage: { prompt_tokens: 9000, completion_tokens: 320, total_tokens: 9320 } },
    { toolCalls: [{ name: 'send_message', args: { messages: '这题我给你写' } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '帮我写个快速排序', 9400);
  const truncSession = await waitSessionDone('帮我写个快速排序');
  assert.strictEqual(truncSession.sent.length, 1, '被截断后仍产出了回复');
  const truncRetryReq = llm.state.requests[reqsBeforeTrunc + 1];
  assert.ok(Number(truncRetryReq?.max_tokens) > 320, '重试时提高了输出预算（实际 ' + truncRetryReq?.max_tokens + '）');
  // thinking-dialect.js：mock 端点是 127.0.0.1 → 'local' 方言，按设计**不发** thinking 参数
  // （本地网关多发就 400）。所以这里断言"没有把思考打开/升档"，而不是强求 disabled 字段。
  const th = truncRetryReq?.thinking;
  assert.ok(!th || th?.type === 'disabled', `重试不能带开启思考的参数（实际 ${JSON.stringify(th)}）`);
  assert.notStrictEqual(truncRetryReq?.reasoning_effort, 'high', '重试不升思考档');
  assert.ok(!truncSession.error, '重试成功后不留错误');
  pass('输出预算截断：自动加预算重试并回复');

  // ── 场景 9.6：改 API Key 必须立刻生效（设置页曾漏提交该字段）──
  {
    // 运行时拼出来，避免被密钥扫描器当成真 key
    const NEW_KEY = 'sk-fake-' + 'changed-key-123';
    const uiSrc = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
    assert.ok(/apiKey: typedApiKey/.test(uiSrc), '设置页保存 payload 里包含 apiKey（防止再次漏字段）');
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api: { apiKey: NEW_KEY } })
    });
    await sleep(50);
    assert.strictEqual(app.getConfig().api.apiKey, NEW_KEY, '新密钥已写入配置');
    llm.state.script.push({ content: '（换 key 后的第一句）' });
    const before = llm.state.requests.length;
    pushGroupMsg(111, '张三', '密钥测试', 9450);
    await waitFor(() => llm.state.requests.length > before, 6000, '换 key 后的运行');
    assert.strictEqual(llm.state.requests.at(-1).__auth, 'Bearer ' + NEW_KEY, '实际请求用的是新密钥');
    await waitSessionDone('密钥测试');
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api: { apiKey: 'test-key' } })
    });
    pass('改 API Key：保存即生效（请求头已换新密钥）');
  }

  // ── 场景 9.7：唤醒闸门（宿主层先判断值不值得叫醒模型）──
  const setGate = (patch) => fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gate: patch })
  });
  // 关掉概率与权重 → 判定完全确定：只有"必回类"才会唤醒
  await setGate({ enabled: true, dryRun: false, probability: 0, keywords: ['必回词'], activeWindowMs: 0, coldGapMs: 0 });
  await sleep(60);
  // ① 无关群聊：不叫醒模型，消息标已读、但仍留在存档里
  // 注意：这条消息会被闸门跳过、不会产生请求 —— 所以这里**不要**压入脚本项，否则 mock 脚本索引会错位
  const callsBeforeGate = llm.state.requests.length;
  pushGroupMsg(111, '张三', '今天天气不错', 9500);
  await sleep(900);
  assert.strictEqual(llm.state.requests.length, callsBeforeGate, '无关群聊不应唤醒模型');
  assert.strictEqual(app.store.getChatMeta('group:456').unread, 0, '被跳过的消息应标为已读');
  assert.ok(app.store.recent('group:456', { limit: 5 }).some((m) => m.text === '今天天气不错'), '跳过的消息仍留在存档里（下次当上下文）');
  pass('唤醒闸门：无关群聊不叫醒模型（消息仍留档）');
  // ② 命中关键词 → 必回
  llm.state.script.push({ toolCalls: [{ name: 'finish', args: { reason: '命中必回词' } }] });
  const callsBeforeKeyword = llm.state.requests.length;
  pushGroupMsg(111, '张三', '必回词来了', 9501);
  await waitFor(() => llm.state.requests.length > callsBeforeKeyword, 6000, '关键词唤醒');
  await waitSessionDone('必回词来了');
  assert.ok(llm.state.requests.length > callsBeforeKeyword, '关键词命中时应唤醒模型');
  // ③ @ 我 → 必回（提示词里应标成 @我）
  llm.state.script.push({ toolCalls: [{ name: 'finish', args: { reason: '@我必回' } }] });
  const callsBeforeAt = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 111, self_id: 888,
    message_id: 9502, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 111, nickname: '张三' },
    message: [{ type: 'at', data: { qq: '888' } }, { type: 'text', data: { text: ' 在吗' } }]
  });
  await waitFor(() => llm.state.requests.length > callsBeforeAt, 6000, '@我唤醒');
  const atPrompt = String(llm.state.requests.at(-1).messages?.[1]?.content || '');
  assert.ok(atPrompt.includes('@我'), '@ 机器人自己时提示词里出现 @我');
  await waitSessionDone('在吗');
  pass('唤醒闸门：@我 必回（提示词标成 @我）');
  // ④ 私聊 → 闸门不拦
  llm.state.script.push({ toolCalls: [{ name: 'finish', args: { reason: '私聊' } }] });
  const callsBeforePriv = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 9503, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '好友' },
    message: [{ type: 'text', data: { text: '闸门私聊测试' } }]
  });
  await waitFor(() => llm.state.requests.length > callsBeforePriv, 6000, '私聊唤醒');
  await waitSessionDone('闸门私聊测试');
  pass('唤醒闸门：私聊不受闸门影响');
  // ⑤ 演练模式：dryRun 开着时，无关群聊照常唤醒（只记日志，不拦）
  await setGate({ enabled: true, dryRun: true, probability: 0, keywords: [], activeWindowMs: 0, coldGapMs: 0 });
  await sleep(60);
  llm.state.script.push({ toolCalls: [{ name: 'finish', args: { reason: 'dryRun 演练' } }] });
  const callsBeforeDry = llm.state.requests.length;
  pushGroupMsg(111, '张三', '演练模式消息', 9504);
  await waitFor(() => llm.state.requests.length > callsBeforeDry, 6000, 'dryRun 仍唤醒');
  await waitSessionDone('演练模式消息');
  pass('唤醒闸门：dryRun 只记日志、不真拦');
  // 恢复常规（dryRun 开着 + 默认概率），不影响后续场景
  await setGate({ enabled: true, dryRun: true, probability: 0.05, keywords: [], activeWindowMs: 1200000, coldGapMs: 1800000 });

  // ── 场景 9.8：语音（TTS → NapCat record 段）──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: { enabled: true, gsvAutoStart: false, gsvUrl: 'http://127.0.0.1:9', apiKey: 'test-tts-key', baseUrl: `http://127.0.0.1:${PORTS.llm}/api/v1`, model: 'qwen-audio-3.0-tts-plus', voice: '' }, security: { allowPrivateImageHosts: true } })
  });
  await sleep(60);
  llm.state.script.push(
    { toolCalls: [{ name: 'send_voice', args: { text: '哼，才不是特意帮你的呢' } }] },
    { content: 'ok' }
  );
  const sendsBeforeVoice = onebotHttp.state.sends.length;
  pushGroupMsg(111, '张三', '用语音说句话', 9600);
  let voiceSession = null;
  try {
    voiceSession = await waitSessionDone('用语音说句话');
  } catch (e) {
    console.error('DEBUG9.8 audio.cfg', JSON.stringify(app.getConfig().audio || {}));
    const stuck = app.sessions.listSummaries(2).map((s) => app.sessions.get(s.id));
    for (const s of stuck) {
      console.error('DEBUG9.8 session', s?.triggerSummary?.slice(0, 20), s?.status, s?.error || '');
      for (const m of (s?.messages || []).slice(-6)) {
        console.error('  msg', m.role, m.toolCall ? `${m.toolCall.name}${m.toolCall.isError ? ' ERR: ' + String(m.toolCall.result).slice(0, 300) : ''}` : String(m.content).slice(0, 120));
      }
    }
    throw e;
  }
  const voiceCall = voiceSession.messages.find((m) => m.toolCall?.name === 'send_voice');
  assert.ok(voiceCall && !voiceCall.toolCall.isError, 'send_voice 调用成功：' + String(voiceCall?.toolCall?.result).replace(/\s+/g, ' ').slice(0, 140));
  const voiceSend = onebotHttp.state.sends.slice(sendsBeforeVoice).map((s) => s.body.message.find((seg) => seg.type === 'record')).find(Boolean);
  assert.ok(voiceSend, 'OneBot 收到了 record 段');
  const voiceFile = String(voiceSend.data.file || '');
  assert.ok(/\.mp3$/.test(voiceFile), 'record 段指向本地 mp3：' + voiceFile);
  assert.ok(fs.existsSync(voiceFile) && fs.statSync(voiceFile).size > 0, '语音文件确实落盘且非空');
  assert.ok((voiceSession.sent || []).some((x) => String(x.text).startsWith('[语音：')), '会话留档里有语音记录');
  pass('语音：文字转语音 → NapCat record 段（文件落盘）');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: { apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' }, security: { allowPrivateImageHosts: false } })
  });

  // ── 场景 9.9：语音识别（voice_to_text）──
  {
    const voiceDir = path.join(dataDir, 'voice');
    fs.mkdirSync(voiceDir, { recursive: true });
    const fakeMp3 = path.join(voiceDir, 'incoming-test.mp3');
    fs.writeFileSync(fakeMp3, Buffer.from('SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA', 'base64'));
    onebotHttp.state.recordFile = fakeMp3;
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: { enabled: true, apiKey: 'test-tts-key', asr: { enabled: true, baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, model: 'qwen3-omni-flash' } } })
    });
    await sleep(60);
    llm.state.script.push(
      { toolCalls: [{ name: 'voice_to_text', args: { messageId: 9700 } }] },
      { content: 'ok' }
    );
    onebotWs.push({
      post_type: 'message', message_type: 'group', group_id: 456, user_id: 111, self_id: 888,
      message_id: 9700, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 111, nickname: '张三' },
      message: [{ type: 'record', data: { file: 'incoming-fake.amr' } }]
    });
    const asrSession = await waitSessionDone('[语音]');
    const asrCall = asrSession.messages.find((m) => m.toolCall?.name === 'voice_to_text');
    assert.ok(asrCall && !asrCall.toolCall.isError, 'voice_to_text 调用成功：' + String(asrCall?.toolCall?.result).replace(/\s+/g, ' ').slice(0, 140));
    assert.ok(String(asrCall.toolCall.result).includes('测试转写'), '工具返回了识别出来的文字');
    assert.ok((llm.state.asrCalls || 0) >= 1, '确实调用了语音识别接口');
    pass('语音识别：语音消息 → 转文字（协议端转码 + ASR）');
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: { asr: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } } })
    });
  }

  // ── 场景 9.95：定向语音自动转写（私聊/@我 要听到；无关群聊语音不自动转）──
  {
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: { enabled: true, apiKey: 'test-tts-key', autoAsr: 'direct', asr: { enabled: true, baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, model: 'qwen3-omni-flash' } } })
    });
    await sleep(60);
    // ① 私聊语音 → 自动转写（模型不必调工具，文本里直接带【语音内容：…】）
    const beforeAuto = llm.state.asrCalls || 0;
    llm.state.script.push({ content: '（听到了，先不回）' });
    onebotWs.push({
      post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
      message_id: 9800, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 777, nickname: '好友' },
      message: [{ type: 'record', data: { file: 'incoming-fake.amr' } }]
    });
    await waitFor(() => (llm.state.asrCalls || 0) > beforeAuto, 9000, '私聊语音自动转写');
    const privStored = app.store.recent('private:777', { limit: 5 }).map((m) => m.text).join(' | ');
    assert.ok(privStored.includes('测试转写'), '私聊语音已自动转文字并入库：' + privStored.slice(0, 90));
    await waitSessionDone('语音内容');
    // ② 无关群聊语音 → 不自动转（省成本），模型没调工具就完全不识别
    const beforeAuto2 = llm.state.asrCalls || 0;
    llm.state.script.push({ content: '（群里的语音，不管）' });
    onebotWs.push({
      post_type: 'message', message_type: 'group', group_id: 456, user_id: 222, self_id: 888,
      message_id: 9801, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 222, nickname: '路人' },
      message: [{ type: 'record', data: { file: 'incoming-fake2.amr' } }]
    });
    await sleep(1300);
    assert.strictEqual(llm.state.asrCalls || 0, beforeAuto2, '无关群聊的语音不该自动识别（省成本）');
    pass('语音：定向消息自动转写（私聊/@我），无关群聊不自动转');
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: { asr: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } } })
    });
  }

  // ── 场景 10：拍一拍触发 ──
  // 回拍本身是 100%（app.js 入站里的确定性动作），但「要不要顺带接一句话」是
  // 按 gate.pokeReplyProb（默认 0.6）掷骰子的。这里要断言的是「拍一拍能唤醒模型」，
  // 所以先把概率钉成 1 —— 否则这条测试有 40% 概率随机失败（poke-quiet 是设计行为）。
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gate: { pokeReplyProb: 1 } })
  });
  const pokesBeforeBack = onebotHttp.state.pokes.length;
  llm.state.script.push({ content: '（拍一下而已，不回）' });
  onebotWs.push({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 456, user_id: 114, target_id: 888, self_id: 888,
    time: Math.floor(Date.now() / 1000)
  });
  await waitFor(() => {
    const latest = llm.state.requests.at(-1);
    return latest?.messages?.[1]?.content?.includes('拍一拍');
  }, 8000, '拍一拍触发运行');
  await waitSessionDone('拍一拍');
  pass('拍一拍事件触发处理');

  // 回拍是入站就做完的确定性动作（不赌模型这一轮会不会想起 send_poke），
  // 所以"唤醒了模型"还不算数 —— 必须真的看到一次 poke 出网，且拍的是拍我的人。
  // 漏了这条断言，就会漏掉"它每次都说『已经拍回去了』、其实一条都没发出去"这种病。
  await waitFor(() => onebotHttp.state.pokes.length > pokesBeforeBack, 6000, '被拍后当场回拍');
  const backPoke = onebotHttp.state.pokes.find((p) => Number(p.user_id) === 114 && Number(p.group_id) === 456);
  assert.ok(backPoke, '回拍落在原群、拍的是拍我的那个人：' + JSON.stringify(onebotHttp.state.pokes));
  pass('被拍 → 当场回拍（群号与对象都对）', `group=${backPoke.group_id} user=${backPoke.user_id}`);

  // ── 场景 10b：自己拍一拍的 OneBot 回显不触发（自回环防护）──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gate: { pokeReplyProb: 0.6 } })
  });
  const pokesBefore = onebotHttp.state.pokes.length;
  // 注意目标别用 114：场景 10 的入站拍一拍已经触发过「确定性回拍」，
  // 存档里留下了一条 `[拍一拍] … 你拍了拍 …(QQ:114)`，pokeHistory 会据此判
  // 「同一人 20 分钟内已拍过」而拦下这次显式 send_poke（这是刻意的防刷屏分寸）。
  // 换一个没被拍过的群成员，测的才是 send_poke 本身。
  //
  // 另外：**会话级**的 pokeCooldownMs（默认 45 秒）同样会被上一幕的回拍点燃 ——
  // 它不看拍的是谁，只看"这个会话刚拍过"。所以不处理的话这一幕要睡 45 秒才过。
  // 测试不该靠睡，把冷却调短，让这一幕测的纯粹是 send_poke 本身。
  //
  // ⚠️ 静默时段也要关：pokeBudget 默认 0–6 点"不主动戳人"（quietFromHour/quietToHour），
  // 于是这个用例在深夜跑必挂、白天跑必过 —— 测试跟着钟点变绿变红是最难查的那种。
  // 把 from=to=0 让窗口为空，任何时刻都不算静默。
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gesture: { pokeCooldownMs: 500, quietFromHour: 0, quietToHour: 0 } })
  });
  llm.state.script.push(
    { toolCalls: [{ name: 'send_poke', args: { targetUserId: 222 } }] },
    { content: '（戳一下而已，不说话）' }
  );
  pushGroupMsg(115, '阿五', '戳我一下试试', 9025);
  await waitSessionDone('戳我一下试试');
  await waitFor(() => onebotHttp.state.pokes.length > pokesBefore, 6000, '拍一拍发送');
  const selfPoke = app.store.recent('group:456', { limit: 10 }).find((m) => m.self && String(m.text).includes('拍一拍'));
  assert.ok(selfPoke, '自己的拍一拍已留档为 self 记录');
  assert.strictEqual(selfPoke.read, true, '自己的拍一拍为已读');
  const callsBeforePokeEcho = llm.state.requests.length;
  onebotWs.push({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 456, user_id: 888, target_id: 114, self_id: 888,
    time: Math.floor(Date.now() / 1000)
  });
  await sleep(2500);
  assert.strictEqual(llm.state.requests.length, callsBeforePokeEcho, '自己拍的拍回显不触发新会话');
  assert.strictEqual(app.store.getChatMeta('group:456').unread, 0, '回显不产生未读');
  pass('拍一拍自回环防护：自拍回显不触发 + 自拍留档');

  // ── 场景 10c：消息 id 引导（报错带可用 id）+ send_poke 参数校验 + recent 带 messageId ──
  const pokesBeforeC = onebotHttp.state.pokes.length;
  llm.state.script.push(
    { toolCalls: [{ name: 'send_poke', args: { targetUserId: '张三' } }] },
    { toolCalls: [{ name: 'get_message_detail', args: { messageId: 999999 } }] },
    { toolCalls: [{ name: 'get_recent_messages', args: { limit: 10 } }] },
    { content: '（知道了）' }
  );
  pushGroupMsg(116, '阿六', '测试工具报错', 9026);
  const toolErrSession = await waitSessionDone('测试工具报错');
  const pokeErr = toolErrSession.messages.find((m) => m.toolCall?.name === 'send_poke');
  assert.ok(pokeErr?.toolCall?.isError && String(pokeErr.toolCall.result).includes('正整数'), 'send_poke 非法参数返回人话报错');
  assert.strictEqual(onebotHttp.state.pokes.length, pokesBeforeC, '非法 targetUserId 不透传 OneBot');
  const detailErr = toolErrSession.messages.find((m) => m.toolCall?.name === 'get_message_detail');
  assert.ok(detailErr?.toolCall?.isError && String(detailErr.toolCall.result).includes('不要自己编'), '找不到消息时报错带引导');
  assert.ok(/\d{4,}/.test(String(detailErr.toolCall.result)), '报错里列出真实可见的消息 id');
  const recentTool = toolErrSession.messages.find((m) => m.toolCall?.name === 'get_recent_messages');
  assert.ok(!recentTool?.toolCall?.isError && String(recentTool.toolCall.result).includes('messageId'), 'get_recent_messages 返回真实消息 id');
  pass('消息 id 引导：报错带可用 id + send_poke 校验 + recent 带 messageId');

  // ── 场景 12：联网搜索 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'web_search', args: { query: '审计梗 是什么' } }] },
    { content: '（搜到了，不用回）' }
  );
  pushGroupMsg(111, '张三', '审计梗是什么意思', 9020);
  const searchSession = await waitSessionDone('审计梗是什么意思');
  assert.ok(searchSession.messages.some((m) => m.toolCall?.name === 'web_search' && !m.toolCall.isError), 'web_search 调用成功');
  const searchReq = llm.state.requests.at(-1);
  const searchToolMsg = searchReq.messages.find((m) => m.role === 'tool' && m.name === 'web_search');
  assert.ok(searchToolMsg && String(searchToolMsg.content).includes('审计梗的完整解释'), '搜索结果以文本进入模型上下文');
  pass('联网搜索：web_search 结果回传模型');

  // ── 场景 13：web_fetch SSRF 防护 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'web_fetch', args: { url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` } }] },
    { content: '（知道了）' }
  );
  pushGroupMsg(112, '李四', '帮我抓内网页面', 9021);
  const fetchSession = await waitSessionDone('帮我抓内网页面');
  assert.ok(fetchSession.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('内网')), 'web_fetch 拒绝内网地址');
  pass('web_fetch SSRF 防护：内网地址被拒绝');

  // ── 场景 14：图片输入链路（vision） ──
  // 14a. 图片作为图像输入到达模型：tool 消息带文本，图片以 user 消息(image_url)补发
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ security: { allowPrivateImageHosts: true } }) // 测试例外：允许下载 mock 服务器上的本地图
  });
  llm.state.script.push(
    { toolCalls: [{ name: 'get_message_images', args: { messageId: 9022 } }] },
    { content: '（图看到了）' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 115, self_id: 888,
    message_id: 9022, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 115, card: '赵六', nickname: '赵六' },
    message: [
      { type: 'text', data: { text: '看这个图' } },
      { type: 'image', data: { file: 'a.png', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` } }
    ]
  });
  const visionSession = await waitSessionDone('看这个图');
  assert.ok(visionSession.messages.some((m) => m.toolImages?.count === 1), '会话记录了图片注入');
  const visReq = llm.state.requests.at(-1);
  const visToolMsg = visReq.messages.find((m) => m.role === 'tool' && m.name === 'get_message_images');
  assert.ok(visToolMsg && typeof visToolMsg.content === 'string' && !visToolMsg.content.includes('base64'), 'tool 消息只带文本，不塞 base64');
  const imgUserIdx = visReq.messages.findIndex((m) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(imgUserIdx > -1, '图片以 user 消息注入');
  const imgPart = visReq.messages[imgUserIdx].content.find((p) => p.type === 'image_url');
  assert.ok(imgPart && String(imgPart.image_url.url).startsWith('data:image/png;base64,'), '图片为 PNG data URL');
  const visToolIdx = visReq.messages.findIndex((m) => m.role === 'tool' && m.name === 'get_message_images');
  assert.ok(visToolIdx > -1 && visToolIdx < imgUserIdx, '消息顺序合法：tool 结果在前，图片 user 消息在后');
  pass('图片输入：tool 文本 + user 消息 image_url 补发，结构兼容 OpenAI 校验');

  // 不变量：脚本队列必须被消费干净。push 的条数 ≠ 请求数 = 后面所有场景整体错位，
  // 表现为某个场景"莫名其妙不调工具"，且越往后越难查。这里在第一个高风险场景后就钉住。
  assert.strictEqual(
    llm.state.script.length,
    llm.state.requests.length,
    `脚本队列与请求数不对齐（脚本 ${llm.state.script.length} / 请求 ${llm.state.requests.length}）：`
    + `说明有请求没走脚本或有脚本没被消费，后续场景会整体错位。旁路调用数=${llm.state.sideCalls || 0}`
  );
  assert.ok((llm.state.sideCalls || 0) > 0, '旁路调用（无 tools）必须被识别并排除在脚本队列外');

  // 14b. vision=false 时看图工具被移除、搜索工具保留
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { vision: false } })
  });
  llm.state.script.push({ content: '（看不了图，不回）' });
  pushGroupMsg(111, '张三', '再来一张图', 9023);
  await waitSessionDone('再来一张图');
  const visOffReq = llm.state.requests.at(-1);
  assert.ok(!visOffReq.tools.some((t) => t.function.name === 'get_message_images'), 'vision=false 时看图工具被移除');
  assert.ok(visOffReq.tools.some((t) => t.function.name === 'web_search'), '搜索工具不受影响');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { vision: true }, security: { allowPrivateImageHosts: false } })
  });
  pass('vision 开关：关闭后移除看图工具，提示词同步变化');

  // ── 场景 15：群/好友列表 + 手动测试消息 ──
  const groupsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/onebot/groups`)).json();
  assert.ok(groupsRes.groups.some((g) => g.id === '456' && g.name === '审计群456'), '群列表可供白名单勾选');
  const friendsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/onebot/friends`)).json();
  assert.ok(friendsRes.friends.some((f) => f.id === '777'), '好友列表可供白名单勾选');
  const testSendRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/test-send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '手动测试消息' })
  })).json();
  assert.ok(testSendRes.ok, '测试消息发送成功');
  assert.ok(onebotHttp.state.sends.some((s) => s.body.message.at(-1).data.text === '手动测试消息'), '测试消息到达 OneBot');
  assert.ok(app.store.recent('group:456', { limit: 5 }).some((m) => m.self && m.text === '手动测试消息'), '测试消息入档为自己的发言');
  const tplRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/persona-templates`)).json();
  assert.ok(tplRes.templates.some((t) => t.id === 'xiaojingyu' && t.text.includes('DeepSeek 小鲸鱼')), '原版小鲸鱼人设模板在内');
  assert.ok(tplRes.templates.some((t) => t.id === 'xiaojingyu_tsundere_v1' && t.text.includes('傲娇改版')), '小鲸鱼傲娇改版模板在内');
  pass('引导助手：群/好友列表 + 手动测试消息 + 人设模板');

  // ── 场景 16：预算保险丝 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ budget: { dailyCostYuan: 0.000001 } }) // 必然已超（前面已跑了十几次）
  });
  const reqsBeforeBudget = llm.state.requests.length;
  pushGroupMsg(111, '张三', '预算测试', 9030);
  await sleep(900);
  assert.strictEqual(llm.state.requests.length, reqsBeforeBudget, '预算超限后不再发起 LLM 调用');
  const budgetStatus = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/status`)).json();
  assert.ok(budgetStatus.paused && budgetStatus.pauseReason === 'budget', '自动暂停且原因标记为 budget');
  // 解除预算并恢复，确认还能继续处理
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ budget: { dailyCostYuan: 0 } })
  });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: false }) });
  llm.state.script.push({ content: '（预算恢复检查）' });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/wake`, { method: 'POST', body: '{}' });
  await waitSessionDone('预算测试');
  pass('预算保险丝：超限自动暂停 → 解除后恢复运行');

  // ── 场景 17：手动模型目录（添加提供商 + 模型管理 + 切换） ──
  // 通过新 API 手动添加两个提供商（等价于设置页“确认添加”），再验证模型追加/删除/切换。
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: 'https://api.a6api.com/v1',
      apiKey: 'cred-a6api-key',
      models: [
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
        { id: 'DeepSeek-V4-Flash-0731', name: 'DS Flash' }
      ]
    })
  });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: 'http://127.0.0.1:8787/v1',
      apiKey: 'local-key-1',
      models: [{ id: 'hy4-preview', name: '混元 Preview' }]
    })
  });
  const provRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  assert.strictEqual(provRes.providers.length, 2, `应存在 2 个手动添加的提供商（实际 ${provRes.providers.length}）`);
  const a6 = provRes.providers.find((p) => p.baseURL === 'https://api.a6api.com/v1');
  // 接口对密钥做脱敏（maskSecretValue），只能验"有没有存"和前缀，不能验原文
  assert.ok(a6 && a6.hasKey && a6.apiKey.startsWith('cre'), '手动添加的提供商保存了密钥');
  assert.ok(a6.models.includes('glm-5.3-flash'), '模型列表完整');
  const local = provRes.providers.find((p) => p.baseURL === 'http://127.0.0.1:8787/v1');
  assert.ok(local && local.models.includes('hy4-preview'), '本地网关模型已添加');
  // 追加模型
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: local.id, models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] })
  });
  const provRes2 = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  const local2 = provRes2.providers.find((p) => p.id === local.id);
  assert.ok(local2.models.includes('glm-5.3-flash'), '追加模型成功');
  // 切换到目录里的模型（等价于 UI 选中后的字段填充）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { provider: local.id, baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'local-key-1', model: 'hy4-preview' } })
  });
  const cfgAfter = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`)).json();
  assert.strictEqual(cfgAfter.api.provider, local.id);
  assert.strictEqual(cfgAfter.api.model, 'hy4-preview');
  // 删除模型
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers/models`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: local.id, modelId: 'glm-5.3-flash' })
  });
  const provRes3 = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  const local3 = provRes3.providers.find((p) => p.id === local.id);
  assert.ok(!local3.models.includes('glm-5.3-flash'), '删除模型成功');
  // 切回测试模型，保证后续场景正常
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { provider: '', baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'test-key', model: 'test-model-a' } })
  });
  pass('手动模型目录：添加提供商 + 追加/删除模型 + 切换');

  // ── 场景 11：HTTP API 完整性 ──
  const statusRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/status`)).json();
  assert.ok(statusRes.onebot.connected === true);
  assert.ok(statusRes.usage.totalTokens > 0, '今日 token 统计 > 0');
  assert.ok(statusRes.usage.cost > 0, '成本折算 > 0');
  const modelsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/models`)).json();
  assert.strictEqual(modelsRes.models.length, 2, '模型列表 API');
  const sessRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/sessions`)).json();
  assert.ok(sessRes.sessions.length >= 8, `会话列表有记录（${sessRes.sessions.length}）`);
  const oneSession = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/sessions/${sessRes.sessions[0].id}`)).json();
  assert.ok(oneSession.messages && oneSession.systemPrompt);
  const chatsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats`)).json();
  assert.ok(chatsRes.chats.some((c) => c.key === 'group:456'));
  const moodsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/moods`)).json();
  assert.ok(moodsRes.moods && typeof moodsRes.moods === 'object', '情绪列表 API');
  const moodReset = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/moods/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatKey: 'group:456' })
  })).json();
  assert.strictEqual(moodReset.mood.score, 50, '情绪重置 API');
  const uiRes = await fetch(`http://127.0.0.1:${cfg.server.port}/`);
  assert.ok((await uiRes.text()).includes('QQ Agent'), 'UI 首页可访问');
  pass('HTTP API：status/models/sessions/chats/moods/UI 全部可用', `今日 cost=¥${statusRes.usage.cost}`);

  // ── 场景 26：记忆自动整理（超阈值触发 + LLM 合并写回 + 备份 + 冷却）──
  let i = 0;
  while (app.memory.consolidationState('group:456').counts.activeTopic <= 8) {
    app.memory.append('group:456', 'activeTopic', `进行中话题${++i}——测试整理用的独特内容`);
  }
  assert.ok(app.memory.consolidationState('group:456').counts.activeTopic > 8, '记忆已灌到超阈值');
  llm.state.script.push({ content: '（继续聊天，不说话）' });   // 主对话（带 tools，走主队列）
  llm.state.sideScript.push(JSON.stringify({                   // 运行结束后的整理调用（无 tools，走旁路队列）
    activeTopic: ['合并后的唯一话题（来自整理测试）'],
    pendingThought: [],
    memberImpression: [{ target: '114', content: '合并后的综合印象' }]
  }));
  pushGroupMsg(117, '阿七', '触发记忆整理', 9027);
  await waitSessionDone('触发记忆整理');
  await waitFor(() => app.memory.consolidationState('group:456').lastConsolidatedAt > 0, 10000, '记忆整理完成');
  const memAfter = app.memory.query('group:456');
  assert.strictEqual(memAfter.activeTopic.length, 1, '整理后话题条数收敛');
  assert.ok(String(memAfter.activeTopic[0].content).includes('合并后的唯一话题'), '整理结果写回存储');
  const backupDir = path.join(dataDir, 'memory', 'backups');
  assert.ok(fs.existsSync(path.join(backupDir, 'group_456.json.1')), '整理前原记忆已备份');
  // 整理调用现在走旁路队列（不带 tools），不再进 requests —— 按旁路类型计数
  const consCount = () => (llm.state.sideKinds || []).filter((k) => k === 'memory').length;
  const consBefore = consCount();
  llm.state.script.push({ content: '（冷却期随便聊聊）' });
  pushGroupMsg(118, '阿八', '冷却验证', 9028);
  await waitSessionDone('冷却验证');
  await sleep(1500);
  assert.strictEqual(consCount(), consBefore, '冷却期内不重复整理');
  pass('记忆自动整理：超阈值触发 + LLM 合并写回 + 备份 + 冷却');

  // ── 场景 27：模型图片输入探测 + 按模型门控看图工具 ──
  // 先通过手动添加提供商 API 创建视觉探测专用提供商（baseUrl 指向 mock LLM）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`,
      apiKey: 'cred-visiont' + 'est-key',
      models: [
        { id: 'vision-ok-model', name: '视觉正常' },
        { id: 'vision-no-model', name: '视觉拒绝' }
      ]
    })
  });
  const visionProv = (await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json())
    .providers.find((p) => p.baseURL === `http://127.0.0.1:${PORTS.llm}/v1`);
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/vision/scan`, {
    method: 'POST', body: JSON.stringify({ providerIds: [visionProv.id] })
  });
  let visionRes = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    visionRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/vision/results`)).json();
    if (!visionRes.scanning
      && visionRes.results[`${visionProv.id}|||vision-ok-model`]
      && visionRes.results[`${visionProv.id}|||vision-no-model`]) break;
  }
  assert.strictEqual(visionRes.results[`${visionProv.id}|||vision-ok-model`].verdict, 'vision', '接受图片的模型判定为 vision');
  assert.strictEqual(visionRes.results[`${visionProv.id}|||vision-no-model`].verdict, 'no-vision', '拒绝图片的模型判定为 no-vision');
  assert.ok(visionRes.results[`${visionProv.id}|||vision-no-model`].note.includes('image'), 'no-vision 结论带原始报错说明');

  // 切到无视觉模型：请求里不应再有看图工具
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST',
    body: JSON.stringify({ api: { provider: visionProv.id, model: 'vision-no-model', baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'cred-visiont' + 'est-key' } })
  });
  llm.state.script.push({ content: '（安静）' });
  pushGroupMsg(119, '阿九', '看看无视觉模型', 9029);
  await waitSessionDone('看看无视觉模型');
  const noVisionReq = llm.state.requests.at(-1);
  assert.ok(!noVisionReq.tools?.some((t) => t.function?.name === 'get_message_images'), 'no-vision 模型不带看图工具');

  // 切到视觉模型：看图工具恢复
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST',
    body: JSON.stringify({ api: { provider: visionProv.id, model: 'vision-ok-model' } })
  });
  llm.state.script.push({ content: '（安静2）' });
  pushGroupMsg(120, '阿十', '看看有视觉模型', 9030);
  await waitSessionDone('看看有视觉模型');
  const visionReq = llm.state.requests.at(-1);
  assert.ok(visionReq.tools?.some((t) => t.function?.name === 'get_message_images'), 'vision 模型带看图工具');
  pass('模型图片输入探测 + 按模型门控看图工具');

  // ── 场景 28：语音音色（RVC）设置 —— 状态/模型列表/界面接线/保存/重启保护 ──
  // 注意：这里所有 rvc.url 都指向 127.0.0.1:1（死端口），
  //       免得测试跑起来把本机真正在跑的 3211 音色服务当自己的进程杀掉。
  const rvcApi = (p) => `http://127.0.0.1:${cfg.server.port}${p}`;
  const rvcStatusRes = await (await fetch(rvcApi('/api/rvc'))).json();
  assert.ok(Array.isArray(rvcStatusRes.models), '/api/rvc 返回音色模型列表');
  assert.ok(rvcStatusRes.models.some((m) => m.name === 'huahuo'), '模型列表包含花火音色');
  assert.strictEqual(rvcStatusRes.enabled, false, '测试配置默认不启用音色转换');
  assert.strictEqual(typeof rvcStatusRes.running, 'boolean', '状态接口返回运行标志');

  const uiAppJs = await (await fetch(rvcApi('/app.js'))).text();
  assert.ok(uiAppJs.includes('renderVoiceSection'), 'UI 已提供语音音色区块');
  assert.ok(uiAppJs.includes('cfg-rvc-model') && uiAppJs.includes('rvc-restart-btn'), 'UI 有音色下拉和服务按钮');
  assert.ok(uiAppJs.includes('语音音色'), 'UI 侧栏有「语音音色」入口');

  // 复刻设置界面点「保存设置」时提交的 payload
  await fetch(rvcApi('/api/config'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      audio: {
        enabled: true,
        model: 'qwen-audio-3.0-tts-plus',
        voice: 'longanlingxin',
        maxChars: 120,
        rvc: {
          enabled: false,
          autoStart: true,
          url: 'http://127.0.0.1:1',
          model: 'huahuo',
          device: 'cuda:0',
          f0upKey: 12,
          method: 'rmvpe',
          fallbackToRaw: true
        }
      }
    })
  });
  const rvcCfg = await (await fetch(rvcApi('/api/config'))).json();
  assert.strictEqual(rvcCfg.audio.rvc.f0upKey, 12, '升降调写入配置');
  assert.strictEqual(rvcCfg.audio.rvc.device, 'cuda:0', '运行设备写入配置');
  assert.strictEqual(rvcCfg.audio.rvc.model, 'huahuo', '音色模型写入配置');
  assert.strictEqual(rvcCfg.audio.maxChars, 120, '语音字数上限写入配置');
  assert.ok(rvcCfg.audio.asr, '保存语音区块不会把 asr 配置冲掉');

  // 未启用时重启只回原因，不应该真去拉 Python 进程
  const restartRes = await fetch(rvcApi('/api/rvc/restart'), { method: 'POST', body: '{}' });
  const restartBody = await restartRes.json();
  assert.strictEqual(restartRes.status, 500, '未启用时重启返回失败');
  assert.ok(String(restartBody.reason || '').includes('未启用'), '失败原因明确是「未启用」');

  const stopBody = await (await fetch(rvcApi('/api/rvc/stop'), { method: 'POST', body: '{}' })).json();
  assert.strictEqual(stopBody.ok, true, '停止接口幂等可用（没服务在跑也不报错）');
  pass('语音音色（RVC）：状态/模型列表/界面接线/保存/重启保护');

  // ── 收尾 ──
  await app.stop();
  onebotWs.close();
  onebotHttp.server.close();
  llm.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n全部 ${results.length} 项审计通过 ✅`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\n❌ 审计失败：', error);
  process.exit(1);
});
