// 语音通话的 WebSocket 服务端。
//
// ── 为什么挂在现有的 http server 上，而不是另开一个端口 ──────────────────
// 项目里已经有一个 `http.createServer`（src/app.js:1417）和一个已经装好的
// `ws ^8.18.0`（src/onebot.js:3 就在用）。用 `noServer: true` + `upgrade` 事件，
// 可以做到**不加依赖、不新开端口、不改现有路由**。
// 另开端口的坏处很具体：Electron 壳、防火墙、局域网访问、端口占用排查，
// 每一项都是用户要额外面对的东西；而且新端口还得再做一次鉴权。
//
// ── 鉴权 ──────────────────────────────────────────────────────────────
// upgrade 请求本身就是 `http.IncomingMessage`，cookie / header 都在，
// 所以直接复用 app.js 的 `authorize(req)`。**默认拒绝**：
// 没通过鉴权就 401 + destroy，绝不让一个没认证的 socket 挂在那里。
//
// ── 帧约定 ────────────────────────────────────────────────────────────
// **二进制帧 = 音频，文本帧 = JSON 控制**。两个方向都一样。
// 这样做的理由：音频是高频大块数据，塞进 JSON 再 base64 会胖 33% 且要两头解析；
// 而控制消息很少，用 JSON 最方便调试。
//
// ── 纪律 ──────────────────────────────────────────────────────────────
// 1. **绝不静默**。任何失败都要发一条 `{type:'error'}` 并回到 listening ——
//    前几轮反复修的都是"出错就不出声"这一类 bug。
// 2. 所有重活（识别/生成/合成）都可注入，测试里不联网。
// 3. 一个连接一次通话；同一时刻只处理一段语音（新的来了就打断旧的）。
import { WebSocketServer } from 'ws';
import { createVad, DEFAULT_THRESHOLD } from './vad.js';
import { wrapWav, pcmDurationMs } from './pcm.js';
import { runVoiceTurn } from './voice-turn.js';

/** 通话状态机的状态。前端拿它显示「听/想/说」。 */
export const VOICE_STATES = Object.freeze(['idle', 'listening', 'transcribing', 'thinking', 'speaking']);

/** 太短的音频不值得识别（多半是咳嗽、碰麦、关门）。 */
export const MIN_SEGMENT_MS = 300;

/**
 * 往前端推电平的最小间隔。
 *
 * 50ms = 20 次/秒。人眼分辨不出更快的变化，而这个数字直接决定了
 * 「每帧回一条 JSON」是不是在烧带宽：客户端如果按 8ms 一帧推，
 * 不加这个限流就是 125 条/秒 —— 和前端每帧 setState 是同一个 bug 的两半。
 */
export const LEVEL_PUSH_MS = 50;

/**
 * 挂载语音网关。
 *
 * @param {object} args
 * @param {import('http').Server} args.server   现有的 http server
 * @param {(req: import('http').IncomingMessage) => boolean} args.authorize  复用 app.js 的鉴权
 * @param {(msg: string) => void} [args.log]
 * @param {string} [args.path='/voice/ws']
 * @param {(args:{buffer:Buffer,format:string}) => Promise<string>} [args.transcribe]  ASR 注入点
 * @param {(args:{text:string}) => Promise<Buffer>} [args.synthesize]                 TTS 注入点
 * @param {(args:object) => Promise<object>} [args.turn]                              一轮对话注入点
 * @param {object} [args.config]  覆盖默认配置（测试用）
 * @returns {{close: () => Promise<void>, stats: () => object, wss: WebSocketServer}}
 */
export function attachVoiceGateway({
  server,
  authorize,
  log = () => {},
  path = '/voice/ws',
  transcribe = null,
  synthesize = null,
  turn = null,
  config = {}
} = {}) {
  if (!server) throw new Error('attachVoiceGateway 需要一个 http server');
  if (typeof authorize !== 'function') {
    // 默认拒绝：宁可全部打不开，也不能默认放行。
    authorize = () => false;
  }

  const cfg = {
    enabled: true,
    maxCallMs: 600000,
    maxTurns: 40,
    vadThreshold: DEFAULT_THRESHOLD,
    vadMinSpeechMs: 250,
    vadSilenceMs: 700,
    // 预录与尾巴：不留预录，第一个字永远丢（VAD 判定"开始说话"时那几帧已经在过去）。
    // 打 QQ 电话时这两项由 config.call 传进来（450/300），比默认 200/200 宽松。
    vadPreRollMs: 200,
    vadKeepTailMs: 200,
    bargeIn: true,
    replyMaxChars: 120,
    historyTurns: 12,
    ttsFormat: 'mp3',
    idleTimeoutMs: 60000,
    sampleRate: 16000,
    // 给前端显示的识别模型名。这里只用于展示与排障，
    // 真正用哪个模型由 src/qwen-audio.js 的 audio.asr.model 决定。
    asrModel: 'wav/http',
    ...config
  };

  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set();
  let closed = false;

  const stats = {
    connections: 0,
    rejected: 0,
    turns: 0,
    errors: 0,
    segments: 0,
    dropped: 0
  };

  function onUpgrade(req, socket, head) {
    if (closed) { try { socket.destroy(); } catch { /* ignore */ } return; }
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== path) {
      // 不是我们的路径：直接掐掉。不写 404 —— upgrade 阶段写 HTTP 响应很别扭，
      // 而且这个 server 本来就没有别的 upgrade 消费者。
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    let allowed = false;
    try {
      allowed = authorize(req) === true;
    } catch (error) {
      log(`[语音] 鉴权时出错，按拒绝处理：${error?.message ?? error}`);
      allowed = false;
    }
    if (!allowed) {
      stats.rejected += 1;
      log('[语音] 拒绝了未通过鉴权的通话连接');
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws, req) => {
    stats.connections += 1;
    const session = createSession(ws, req);
    sessions.add(session);
    ws.on('close', () => {
      session.dispose();
      sessions.delete(session);
    });
    ws.on('error', (error) => {
      log(`[语音] 连接出错：${error?.message ?? error}`);
      session.dispose();
    });
    // 第一条消息应该是 {type:'start'}；在那之前也可以直接推音频（宽容一点，
    // 前端偶尔会先发一帧再发 start）。
    send(ws, {
      type: 'ready',
      vad: 'energy',
      asrModel: cfg.asrModel,
      ttsFormat: cfg.ttsFormat,
      sampleRate: cfg.sampleRate,
      // 前端要把这几个数显示出来：参数不对时（静音阈值太急/预录太短），
      // 用户听到的现象是"它老打断我""第一个字总丢"，从面板上一眼能对到配置。
      vadConfig: {
        threshold: cfg.vadThreshold,
        minSpeechMs: cfg.vadMinSpeechMs,
        silenceMs: cfg.vadSilenceMs,
        preRollMs: cfg.vadPreRollMs,
        keepTailMs: cfg.vadKeepTailMs
      }
    });
  });

  function send(ws, payload) {
    if (ws.readyState !== 1) return false;   // 1 === OPEN
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      log(`[语音] 发送控制消息失败：${error?.message ?? error}`);
      return false;
    }
  }

  function sendBinary(ws, buffer) {
    if (ws.readyState !== 1) return false;
    try {
      ws.send(buffer, { binary: true });
      return true;
    } catch (error) {
      log(`[语音] 发送音频失败：${error?.message ?? error}`);
      return false;
    }
  }

  function createSession(ws, req) {
    const vad = createVad({
      threshold: cfg.vadThreshold,
      minSpeechMs: cfg.vadMinSpeechMs,
      silenceMs: cfg.vadSilenceMs,
      preRollMs: cfg.vadPreRollMs,
      keepTailMs: cfg.vadKeepTailMs,
      sampleRate: cfg.sampleRate
    });

    let state = 'idle';
    let startedAt = Date.now();
    let turns = 0;
    let disposed = false;
    let busy = false;            // 正在处理上一段语音
    let currentAbort = null;     // 用来打断上一段
    let idleTimer = null;
    let callTimer = null;
    /**
     * 上一次往前端推电平的时刻。
     *
     * 为什么要有这个：前端现在 100ms 才发一块 PCM，但客户端如果退回老浏览器、
     * 或者别的调用方一帧一帧推，这里还是会一帧回一条 level JSON。
     * 电平条是给人看的，人眼分辨不出 20Hz 以上的变化 —— 每帧都发纯属白烧带宽，
     * 而且和「前端每帧 setState」是一对孪生 bug，两边都得堵。
     */
    let lastLevelAt = 0;
    /** @type {Array<{role:string,content:string}>} */
    const history = [];

    function setState(next, extra = null) {
      state = next;
      send(ws, { type: 'state', state: next, ...(extra ?? {}) });
    }

    function armIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        send(ws, { type: 'closed', reason: 'idle' });
        try { ws.close(1000, 'idle'); } catch { /* ignore */ }
      }, Math.max(1000, cfg.idleTimeoutMs));
      if (idleTimer.unref) idleTimer.unref();
    }

    function fail(message, code = 'error') {
      stats.errors += 1;
      send(ws, { type: 'error', message: String(message), code });
      // 出错之后一定要回到能继续听的状态，否则用户以为通话断了。
      if (!disposed) setState('listening');
    }

    /** 打断正在进行的这一轮（用户抢话，或者自己点了打断）。 */
    function interrupt(reason = 'user') {
      if (currentAbort) {
        try { currentAbort.abort(); } catch { /* ignore */ }
        currentAbort = null;
      }
      busy = false;
      vad.reset();
      send(ws, { type: 'stop-playback', reason });
      if (!disposed) setState('listening');
    }

    async function handleSegment(pcm) {
      if (busy) {
        // 上一段还没处理完：新的一段直接丢掉并告知，避免两段回复交错。
        stats.dropped += 1;
        send(ws, { type: 'dropped', reason: 'busy' });
        return;
      }
      const ms = pcmDurationMs(pcm.length, cfg.sampleRate, 1);
      if (ms < MIN_SEGMENT_MS) {
        stats.dropped += 1;
        send(ws, { type: 'dropped', reason: 'too-short', ms });
        return;
      }

      busy = true;
      stats.segments += 1;
      const abort = new AbortController();
      currentAbort = abort;
      if (callTimer) clearTimeout(callTimer);
      callTimer = setTimeout(() => {
        send(ws, { type: 'closed', reason: 'max-call-duration' });
        try { ws.close(1000, 'timeout'); } catch { /* ignore */ }
      }, Math.max(1000, cfg.maxCallMs));
      if (callTimer.unref) callTimer.unref();

      try {
        // ── 1. 识别 ──
        setState('transcribing');
        const wav = wrapWav(pcm, { sampleRate: cfg.sampleRate, channels: 1 });
        let text = '';
        try {
          text = String(await (transcribe
            ? transcribe({ buffer: wav, format: 'wav' })
            : defaultTranscribe({ buffer: wav, format: 'wav' })) ?? '').trim();
        } catch (error) {
          fail(`没听清（识别失败）：${error?.message ?? error}`, 'asr-failed');
          return;
        }
        if (!text) {
          // 识别成功但没内容 —— 多半是噪音。不要当成故障弹错误，也不要沉默，
          // 只提示一句"这段没听出内容"，然后继续听。
          send(ws, { type: 'dropped', reason: 'no-speech' });
          return;
        }
        send(ws, { type: 'asr', text });
        if (abort.signal.aborted) return;

        // ── 2. 想 ──
        setState('thinking');
        let reply = '';
        try {
          const result = await (turn
            ? turn({ text, history, persona: null, maxChars: cfg.replyMaxChars, historyTurns: cfg.historyTurns, signal: abort.signal })
            : runVoiceTurn({ text, history, maxChars: cfg.replyMaxChars, historyTurns: cfg.historyTurns, signal: abort.signal }));
          reply = String(result?.reply ?? '');
          if (result?.failed) {
            stats.errors += 1;
            send(ws, { type: 'error', message: `回答时出了点问题（${result.error ?? '未知'}）`, code: 'turn-failed' });
          }
        } catch (error) {
          fail(`想不出怎么回：${error?.message ?? error}`, 'turn-failed');
          return;
        }
        if (abort.signal.aborted) return;
        if (!reply.trim()) {
          send(ws, { type: 'dropped', reason: 'empty-reply' });
          return;
        }
        send(ws, { type: 'reply', text: reply });

        // ── 3. 说 ──
        setState('speaking');
        let audio = null;
        try {
          audio = await (synthesize
            ? synthesize({ text: reply })
            : defaultSynthesize({ text: reply }));
        } catch (error) {
          // 合成失败：话已经生成出来了，至少把文本给前端显示，别让这一轮白费。
          stats.errors += 1;
          send(ws, { type: 'error', message: `朗读失败：${error?.message ?? error}`, code: 'tts-failed' });
          return;
        }
        if (abort.signal.aborted) return;
        if (!audio || audio.length === 0) {
          send(ws, { type: 'error', message: '朗读失败：合成结果是空的', code: 'tts-empty' });
          return;
        }
        sendBinary(ws, audio);

        // ── 4. 记账 ──
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: reply });
        const keep = Math.max(2, cfg.historyTurns * 2);
        while (history.length > keep) history.shift();
        turns += 1;
        stats.turns += 1;
        if (turns >= cfg.maxTurns) {
          send(ws, { type: 'closed', reason: 'max-turns' });
          try { ws.close(1000, 'done'); } catch { /* ignore */ }
        }
      } finally {
        busy = false;
        if (currentAbort === abort) currentAbort = null;
        if (!disposed && state !== 'speaking') {
          // 正常收尾后回到 listening；speaking 交给前端播完再回。
          setState('listening');
        }
        armIdleTimer();
      }
    }

    function dispose() {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (callTimer) clearTimeout(callTimer);
      if (currentAbort) {
        try { currentAbort.abort(); } catch { /* ignore */ }
        currentAbort = null;
      }
    }

    ws.on('message', (data, isBinary) => {
      if (disposed) return;
      armIdleTimer();

      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const r = vad.push(frame);
        if (r.event === 'speech-start') {
          setState('listening');
          send(ws, { type: 'speech-start', level: vad.level });
        } else if (r.event === 'speech-end' && r.segment) {
          send(ws, { type: 'speech-end', ms: pcmDurationMs(r.segment.length, cfg.sampleRate, 1) });
          handleSegment(r.segment).catch((error) => {
            log(`[语音] 处理语音段时出错：${error?.message ?? error}`);
            fail(`处理语音时出错：${error?.message ?? error}`);
          });
        } else {
          // 让前端能画电平条。按 LEVEL_PUSH_MS 限流，不是每帧都发 ——
          // 且只在 idle/listening（也就是前端确实在等电平的时候）发。
          if ((state === 'idle' || state === 'listening') && Date.now() - lastLevelAt >= LEVEL_PUSH_MS) {
            lastLevelAt = Date.now();
            send(ws, { type: 'level', level: Number(vad.smoothLevel.toFixed(4)) });
          }
        }
        return;
      }

      let msg = null;
      try {
        msg = JSON.parse(String(data));
      } catch {
        fail('控制消息不是合法 JSON', 'bad-json');
        return;
      }
      if (!msg || typeof msg !== 'object') {
        fail('控制消息不是对象', 'bad-json');
        return;
      }

      switch (msg.type) {
        case 'start': {
          startedAt = Date.now();
          setState('listening');
          armIdleTimer();
          break;
        }
        case 'ping': {
          send(ws, { type: 'pong', at: Date.now() });
          break;
        }
        case 'interrupt': {
          interrupt('user');
          break;
        }
        case 'stop': {
          // 用户说完点了"发送"：把 VAD 里没断完的那一段强制拿出来。
          const seg = vad.flush();
          if (seg) {
            handleSegment(seg).catch((error) => {
              log(`[语音] 处理语音段时出错：${error?.message ?? error}`);
              fail(`处理语音时出错：${error?.message ?? error}`);
            });
          } else {
            send(ws, { type: 'dropped', reason: 'nothing-to-send' });
          }
          break;
        }
        case 'barge-in': {
          // 它正在说话时用户开口了：停播放，但不打断已经开始的模型调用。
          if (cfg.bargeIn) send(ws, { type: 'stop-playback', reason: 'barge-in' });
          break;
        }
        default:
          fail(`不认识的控制消息：${String(msg.type)}`, 'unknown-type');
      }
    });

    armIdleTimer();

    return {
      dispose,
      get state() { return state; },
      get startedAt() { return startedAt; },
      get turns() { return turns; }
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    try { server.off('upgrade', onUpgrade); } catch { /* ignore */ }
    for (const s of sessions) {
      try { s.dispose(); } catch { /* ignore */ }
    }
    sessions.clear();
    await new Promise((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
      // 已建立的 ws 连接不会因为 wss.close() 自己断开，必须显式关，
      // 否则 server.close() 会一直等它们（端口释放不掉）。
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* ignore */ }
      }
      const timer = setTimeout(resolve, 1000);
      if (timer.unref) timer.unref();
    });
  }

  return { close, stats: () => ({ ...stats, sessions: sessions.size }), wss };
}

/** 默认识别：走现有的 transcribeSpeech（WAV 已经在 FORMAT_MIME 里）。 */
async function defaultTranscribe({ buffer, format }) {
  const { transcribeSpeech } = await import('./qwen-audio.js');
  return transcribeSpeech({ buffer, format });
}

/** 默认合成：走现有的 synthesizeSpeech。 */
async function defaultSynthesize({ text }) {
  const { synthesizeSpeech } = await import('./qwen-audio.js');
  const result = await synthesizeSpeech({ text });
  return result?.buffer ?? Buffer.alloc(0);
}
