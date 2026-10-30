// 主动收敛的**结果记账**端到端验证：真的跑一轮 wake({proactive:true})，
// 看退避状态有没有被写对。
//
// 为什么单开一个文件：接线测试（test-proactive-backoff-wire.mjs）只直接调
// noteProactiveOutcome，测不到 wake() 的 finally 里到底有没有调它 ——
// 实测把那行删掉（`void finalStatus`）之后整套测试照样全绿，说明当时没有任何
// 用例覆盖这条路径。这个文件补的就是这个洞。
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-po-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 假模型：mode 决定这一轮是"说话"、"沉默"还是"报错"。
//
// 关键点：群聊里**纯文本 content 不算发言** —— 只有真的调 send_message 工具才算
// （orchestrator 对群聊不兜底）。所以"说话"这一档必须返回 tool_calls，
// 否则这一轮永远是 noreply，测到的就不是"开口后的冷却"而是"没开口的退避"。
let mode = 'speak';
const server = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    if (mode === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal server error' } }));
      return;
    }
    if (mode === 'silent') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1 }
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'send_message', arguments: JSON.stringify({ messages: ['大家都睡了吗'] }) }
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
  persona: {
    roleText: '你是一个用于测试的人设，说话简短，不要使用工具。'.repeat(4),
    masterQQ: '10001'
  },
  proactive: {
    enabled: true,
    backoffEnabled: true,
    backoffBaseMs: 60000,
    backoffCapMs: 600000,
    backoffStartCount: 1,
    cooldownMs: 120000
  },
  errorReply: { enabled: true, cooldownMs: 600000 }
});

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { resetSkipMemory } = await import('../src/skip-log.js');
const { resetProactiveBackoffForTest, getProactiveBackoff } = await import('../src/proactive-backoff.js');

resetSkipMemory();
resetProactiveBackoffForTest();

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

const sent = [];
const platform = {
  selfId: '99999',
  async sendText(kind, id, text) { sent.push({ kind, id, text }); return { message_id: 'm1' }; }
};

const store = new ChatStore();
const sender = new SendQueue({ platform, store });
const sessions = new SessionRegistry(5);
const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
const bus = createEventBus();
const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });

const logs = [];
bus.on('log', (r) => logs.push(r?.text || ''));
const cfg = () => getConfig();
const b = () => getProactiveBackoff(cfg().proactive);
const G = 'group:33333';

console.log('[proactive-outcome]');

// ── ① 主动开口了 → 记短冷却 ─────────────────────────────────────────────
await ok('主动这一轮真的说了话 → wake 的 finally 记成"已开口"（短冷却）', async () => {
  mode = 'speak';
  b().reset(G);
  await orch.wake(G, { proactive: true });
  const v = b().check(G);
  assert.strictEqual(v.skip, true, '开口之后应该进入冷却，否则会对着沉默连发');
  assert.strictEqual(v.kind, 'cooldown', `应是冷却，实际 ${v.kind}`);
  assert.ok(v.waitMs > 0 && v.waitMs <= 120000, `冷却应在 120 秒内，实际 ${v.waitMs}`);
  assert.ok(logs.some((t) => t.includes('[主动]') && t.includes('开了话题')));
});

// ── ② 主动没开口 → 记一次连败 ───────────────────────────────────────────
await ok('主动这一轮决定不说话 → 记成"没开口"（连败 +1）', async () => {
  mode = 'silent';
  b().reset(G);
  await orch.wake(G, { proactive: true });
  const v = b().check(G);
  assert.strictEqual(v.skip, true);
  assert.strictEqual(v.kind, 'backoff', `应是退避，实际 ${v.kind}`);
  assert.strictEqual(v.streak, 1);
  assert.ok(logs.some((t) => t.includes('[主动]') && t.includes('没有开口')));
});

// ── ③ 主动出错 → 也算没反应 ─────────────────────────────────────────────
await ok('主动这一轮报错 → 也算一次没反应（否则每次都超时的群会被无限重试）', async () => {
  mode = 'fail';
  b().reset(G);
  await orch.wake(G, { proactive: true });
  assert.strictEqual(b().check(G).streak, 1, '出错必须计入连败');
});

// ── ④ 正常对话 → 清零 ───────────────────────────────────────────────────
await ok('正常对话跑完一轮 → 连败清零（有人说话就说明这个群还活着）', async () => {
  mode = 'speak';
  b().reset(G);
  b().recordDeclined(G);
  b().recordDeclined(G);
  assert.strictEqual(b().check(G).skip, true);
  store.appendIncoming(G, { senderId: '20002', senderName: '群友', text: '@小鲸鱼 在吗', atSelf: true });
  await orch.wake(G);
  const v = b().check(G);
  assert.strictEqual(v.skip, false, '有人说话之后就该立刻放行');
  assert.strictEqual(v.streak, 0);
});

// ── ⑤ 开关可回退 ────────────────────────────────────────────────────────
await ok('backoffEnabled=false → 整轮跑完也不写任何状态', async () => {
  mode = 'speak';
  updateConfig({ proactive: { backoffEnabled: false } });
  b().reset(G);
  await orch.wake(G, { proactive: true });
  assert.strictEqual(b().check(G).skip, false, '关掉开关就不该有任何收敛');
  updateConfig({ proactive: { backoffEnabled: true } });
});

// ── ⑥ 落盘 ──────────────────────────────────────────────────────────────
await ok('状态真的落到了磁盘（重启后接着生效）', async () => {
  mode = 'silent';
  updateConfig({ proactive: { backoffEnabled: true } });
  b().reset(G);
  await orch.wake(G, { proactive: true });
  const file = path.join(tmp, 'proactive-backoff.json');
  assert.ok(fs.existsSync(file), '应写出 proactive-backoff.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(disk.chats[G], `磁盘上应有 ${G}，实际 ${JSON.stringify(disk.chats)}`);
  assert.ok(disk.chats[G].streak >= 1);
});

console.log(`\n[proactive-outcome] ${pass} 项全部通过`);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
// 显式退出：Orchestrator 里有若干 setTimeout，不 exit 会让 node 一直挂着
// （表现是"测试跑完了但命令不返回"，在 npm test 里表现为超时）。
process.exit(0);
