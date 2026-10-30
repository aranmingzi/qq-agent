// 复读拦截的**端到端**验证：真的跑一轮 wake()，确认 orchestrator 把会话
// 传给了 after-tool 钩子。
//
// 为什么单开一个文件：插件测试（test-echo-guard.mjs）直接调钩子，测不到
// **orchestrator 到底有没有把 session 传给 after-tool**。实测把那行
// `session: { chatKey, ... }` 删掉，那个文件照样全绿 —— 因为钩子会退回"猜"。
// 线上没有猜的余地：拿不到 chatKey 就记不上账（或记错群），
// 用户看到的是"她明明说了，下一句却突然不吭声了"。
//
// 这里跑真实链路：wake() → 模型返回 tool_calls → executeTool → sender → after-tool → 插件记账。
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-eg-e2e-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 假模型：每次都调 send_message 发同一句。
// 群聊里纯文本 content 不算发言，必须走 tool_calls 才真的"说了话"。
const SAY = '这句话我到底说出去了没有';
const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `call_${Math.random()}`,
            type: 'function',
            function: { name: 'send_message', arguments: JSON.stringify({ messages: [SAY] }) }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8 }
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { getConfig, updateConfig } = await import('../src/config.js');
await getConfig();
updateConfig({
  api: {
    apiKey: 'sk-test',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    fallbacks: [],
    maxRetries: 0,
    routing: { enabled: false }
  },
  talk: { enabled: false },
  persona: { roleText: '你是一个用于测试的人设，说话简短。'.repeat(4), masterQQ: '10001' },
  send: { maxPerMinute: 100, maxPerHour: 0, preflightQuota: false },
  proactive: { enabled: false },
  maxConcurrentRuns: 4,
  tools: { enabled: false }
});

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { resetSkipMemory } = await import('../src/skip-log.js');
const guard = await import('../plugins/复读拦截/index.js');

resetSkipMemory();

let pass = 0;
async function ok(name, fn) {
  try {
    await fn();
  } catch (e) {
    e.message = `[${name}] ${e.message}`;
    throw e;
  }
  pass += 1;
  console.log('  ✓', name);
}

const GROUP = 'group:55555';
let sendCalls = 0;
let sendFails = false;
const platform = {
  selfId: '99999',
  async sendText() {
    if (sendFails) throw new Error('这一分钟发到上限（4 条）了');
    sendCalls += 1;
    return { message_id: `m${sendCalls}` };
  }
};

const store = new ChatStore();
const sender = new SendQueue({ platform, store });
const sessions = new SessionRegistry(5);
const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
const bus = createEventBus();
const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });

// 把真插件挂到真钩子总线上（不经过文件扫描，但用的就是它导出的 hooks）。
// 顺带记下 after-tool 收到的 session —— 这正是本文件要盯的东西。
guard.setup({ config: () => ({ enabled: true, windowMin: 20, minLen: 6, maxPerRun: 6 }), log: () => {} });
const afterSessions = [];
orch.hookBus.on('before-tool', guard.hooks['before-tool'], { owner: 'echo-guard' });
orch.hookBus.on('after-tool', (p) => {
  afterSessions.push(p.session);
  return guard.hooks['after-tool'](p);
}, { owner: 'echo-guard' });

function seedUnread(text) {
  store.appendIncoming(GROUP, { mid: `m${Math.random()}`, senderId: 'u1', senderName: '张三', text, ts: Date.now() });
}

console.log('[echo-guard-e2e]');

await ok('after-tool 拿到了 session（没有 session 就记不上账）', async () => {
  seedUnread('在吗');
  await orch.wake(GROUP);
  assert.ok(afterSessions.length > 0, 'after-tool 应该至少触发一次');
  assert.strictEqual(afterSessions[0]?.chatKey, GROUP, `after-tool 必须拿到 chatKey，实际 ${JSON.stringify(afterSessions[0])}`);
  assert.ok(Array.isArray(afterSessions[0]?.sent), 'after-tool 应拿到本轮已发列表');
});

await ok('真发出去之后，下一轮说同一句被拦下（端到端记账生效）', async () => {
  const before = sendCalls;
  assert.ok(before >= 1, '第一轮应该真的发出去过');
  seedUnread('再问一次');
  await orch.wake(GROUP);
  assert.strictEqual(sendCalls, before, '同一句不该再发一次（说明真的记进了 history）');
});

await ok('发送失败的那句不算说过 → 换会话重发不被拦', async () => {
  const CHAT2 = 'group:55556';
  const say = '这句第一次其实没发出去';
  const { executeTool, buildToolDefs } = await import('../src/tools.js');
  const defs = buildToolDefs();

  // ① 让发送失败，走真实钩子 → 真实工具层 → 真实 after-tool 回灌
  sendFails = true;
  const ctx = {
    chatKey: CHAT2,
    session: { id: 's-x', sent: [] },
    sender,
    store,
    emit: () => {},
    cfg: getConfig(),
    persona: {},
    atsThisRun: 0
  };
  const attempt = { toolName: 'send_message', argsRaw: JSON.stringify({ messages: [say] }), session: { chatKey: CHAT2, sent: [] } };
  const pre = await orch.hookBus.emit('before-tool', attempt);
  assert.strictEqual(pre.vetoed, null, '第一次尝试不该被拦（还没说过）');
  const r1 = await executeTool(defs, ctx, 'send_message', JSON.stringify({ messages: [say] }));
  assert.ok(r1?.isError, '第一次应失败');
  await orch.hookBus.emit('after-tool', { ...attempt, result: r1?.content, isError: true });

  // ② 恢复后重发同一句 → 不该被复读拦截
  sendFails = false;
  const veto = await orch.hookBus.emit('before-tool', {
    toolName: 'send_message',
    argsRaw: JSON.stringify({ messages: [say] }),
    session: { chatKey: CHAT2, sent: [] }
  });
  assert.strictEqual(veto.vetoed, null, `上次没发出去，这次必须放行；实际被拦：${veto.vetoed?.reason}`);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
console.log(`\n[echo-guard-e2e] ${pass} 项通过，全部通过`);
process.exit(0);
