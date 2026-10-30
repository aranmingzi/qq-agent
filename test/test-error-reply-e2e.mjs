// 端到端演练：本地起一个假模型端点，精确控制失败类型，验证 orchestrator 的两条分支：
//   ① 瞬时故障（500）→ 对用户说一句人话，落 run-error 账；
//   ② 运营故障（402 欠费）→ 只在主人私聊发技术诊断，且群里绝不出现；
//   ③ 冷却期内重复失败 → 只落账、不再发。
//
// 为什么不用"连不上"来造错：undici 对 1/7/9 等端口先抛 `bad port`，
// 对未监听端口抛 ECONNREFUSED —— 前者分类会落到 unknown，测的就不是目标路径。
// 起个真 HTTP server 才能钉死状态码。
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-er-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 假模型：由 mode 决定这一轮返回什么
let mode = 500;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (mode === 500) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal server error' } }));
      return;
    }
    if (mode === 402) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '在的' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 }
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
  errorReply: { cooldownMs: 600000 }
});

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { resetSkipMemory } = await import('../src/skip-log.js');
resetSkipMemory();

const sent = [];
const platform = {
  selfId: '99999',
  async sendText(kind, id, text) { sent.push({ kind, id, text }); return { message_id: 'm1' }; }
};

const store = new ChatStore();
const sender = new SendQueue({ platform, store });
const sessions = new SessionRegistry(5);
// 记忆在真实运行时是 MemoryStore；这里只需要"不崩、不注入"，让流程走到模型调用。
const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
const bus = createEventBus();
const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });

const skips = [];
bus.on('skip', (r) => skips.push(r));
const runErr = () => skips.filter((s) => s.stage === 'run-error');

// ── 场景 1：瞬时故障 → 用户端人话 ────────────────────────────────────────
const privKey = 'private:10001';
store.appendIncoming(privKey, { senderId: '10001', senderName: '主人', text: '在吗' });
await orch.wake(privKey);

assert.strictEqual(runErr().length, 1, `应记一条 run-error，实际 ${JSON.stringify(skips.map((s) => s.stage))}`);
assert.strictEqual(runErr()[0].detail.kind, 'server');
assert.strictEqual(runErr()[0].detail.notified, 'user');
assert.strictEqual(sent.length, 1, `应发出恰好一条提示，实际 ${JSON.stringify(sent)}`);
assert.doesNotMatch(sent[0].text, /HTTP|500|模型 API/, '用户端不许出现技术细节');
console.log('① 瞬时故障 →', sent[0].text);

// ── 场景 2：冷却期内再失败 → 只落账不发 ──────────────────────────────────
sent.length = 0;
store.appendIncoming(privKey, { senderId: '10001', senderName: '主人', text: '人呢' });
await orch.wake(privKey);
assert.strictEqual(runErr().length, 2, '冷却期内也要落账');
assert.strictEqual(sent.length, 0, `冷却期内不该再发，实际 ${JSON.stringify(sent)}`);
assert.match(runErr()[1].reason, /冷却/);
console.log('② 冷却期内 →', runErr()[1].reason);

// ── 场景 3：欠费 + 主人在**群**里 → 一个字都不说 ─────────────────────────
// 群里说"余额不足"等于把部署情况广播出去，而且群友也无从处理。
mode = 402;
sent.length = 0;
const groupKey = 'group:55555';
// 先冷却清零，否则测的是冷却而不是分类
orch.errorReplyAt.clear();
store.appendIncoming(groupKey, {
  senderId: '10001', senderName: '主人', text: '@小鲸鱼 在吗', atSelf: true
});
await orch.wake(groupKey);
assert.strictEqual(runErr().length, 3);
assert.strictEqual(runErr()[2].detail.kind, 'quota');
assert.strictEqual(runErr()[2].detail.notified, undefined, '群里不该有任何提示');
assert.strictEqual(sent.length, 0, `群里不该发消息，实际 ${JSON.stringify(sent)}`);
console.log('③ 欠费+群里 →', runErr()[2].reason);

// ── 场景 4：欠费 + 主人私聊 → 技术诊断 ───────────────────────────────────
sent.length = 0;
orch.errorReplyAt.clear();
store.appendIncoming(privKey, { senderId: '10001', senderName: '主人', text: '在吗' });
await orch.wake(privKey);
assert.strictEqual(runErr().length, 4);
assert.strictEqual(runErr()[3].detail.kind, 'quota');
assert.strictEqual(runErr()[3].detail.notified, 'operator');
assert.strictEqual(sent.length, 1, `应发一条诊断，实际 ${JSON.stringify(sent)}`);
assert.match(sent[0].text, /【模型失败】/);
assert.match(sent[0].text, /欠费|余额不足/);
assert.match(sent[0].text, /402/);
console.log('④ 欠费+主人私聊 →', sent[0].text);

// ── 断言：诊断那句必须进了历史（否则下一轮她不知道自己说过）────────────
const hist = JSON.stringify(store.recent?.(privKey, { limit: 50 }) ?? store.list?.(privKey, 50) ?? []);
assert.ok(hist.includes('【模型失败】'), '技术诊断必须落进历史，否则下一轮提示词里看不到它');

// ── 场景 5：恢复后正常说话 ───────────────────────────────────────────────
mode = 200;
sent.length = 0;
orch.errorReplyAt.clear();
store.appendIncoming(privKey, { senderId: '10001', senderName: '主人', text: '好了吗' });
await orch.wake(privKey);
assert.ok(sent.length >= 1, `恢复后应该正常回复，实际 ${JSON.stringify(sent)}`);
assert.doesNotMatch(sent.map((s) => s.text).join(''), /【模型失败】/);
console.log('⑤ 恢复后 →', sent.map((s) => s.text).join(' / '));

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n端到端演练通过（5 个场景）');
// 显式退出：Orchestrator 里有若干 setTimeout 定时器，不 exit 会让 node 一直挂着
// （表现是"测试跑完了但命令不返回"，CI 上会被当成超时）。
process.exit(0);
