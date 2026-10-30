// 发送额度前置感知的**端到端**验证：真的跑一轮 wake()，钉两件事——
//   ① 额度满时那一轮根本没发 HTTP 请求（模型没被调用，钱没花）；
//   ② 额度只剩 1 条时，**模型收到的提示词里**写的是 1 条，不是档位给的 3~4 条。
//
// 为什么单开一个文件：接线测试（test-send-quota-wire.mjs）直接调 checkSendQuota
// 和 sendQuotaRemaining，测不到"wake 里到底有没有调"以及"计划有没有真的进提示词"
// —— 第 2 轮踩过这个坑：把那行接线删掉，整套测试照样全绿。
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-quota-e2e-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 假模型：记下每次请求体，方便断言"提示词里写了什么"。
//
// 只返回纯文本、不返回 tool_calls：群聊里纯文本不算发言，这一轮会一次结束，
// 不会有第二、第三次请求。这里要验的是**第一轮提示词里写了什么**，
// 多跑几轮只会让断言里的"请求次数"变成工具轮询的噪声。
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { requests.push(null); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '在的' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
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
  send: { maxPerMinute: 4, maxPerHour: 0, preflightQuota: true },
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

const GROUP = 'group:77777';
const platform = {
  selfId: '99999',
  async sendText() { return { message_id: 'm1' }; }
};

const store = new ChatStore();
const sender = new SendQueue({ platform, store });
const sessions = new SessionRegistry(5);
const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
const bus = createEventBus();
const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });
const skips = [];
bus.on('skip', (r) => skips.push(r));

/** 造 n 条"刚刚发过"的记录，让文本桶显示已用 n 条。 */
function fillMinuteBucket(n) {
  sender.minuteTimes.set(GROUP, Array.from({ length: n }, (_, i) => Date.now() - i * 1000));
}

function seedUnread() {
  store.appendIncoming(GROUP, { mid: `m${Math.random()}`, senderId: 'u1', senderName: '张三', text: '在吗', ts: Date.now() });
}

console.log('[send-quota-e2e]');

// ── ① 额度满：一个 HTTP 请求都不该发出去 ─────────────────────────────────
await ok('额度满了 → 整轮不开跑，模型一次都没被调用', async () => {
  requests.length = 0;
  fillMinuteBucket(4);           // 上限 4，已经发满
  seedUnread();
  await orch.wake(GROUP);
  assert.strictEqual(requests.length, 0, `额度满时不该调用模型，实际发了 ${requests.length} 次请求`);
  assert.ok(store.unreadCount(GROUP) > 0, '未读必须留着');
  assert.ok(skips.some((s) => s.stage === 'send-quota'), '要留痕');
});

// ── ② 额度剩 1：真的跑，但提示词里只允许 1 条 ────────────────────────────
await ok('额度只剩 1 条 → 照跑，且提示词里的文字上限就是 1 条', async () => {
  requests.length = 0;
  fillMinuteBucket(3);           // 上限 4，已用 3 → 剩 1
  seedUnread();
  await orch.wake(GROUP);
  assert.strictEqual(requests.length, 1, `应该真的跑一轮，实际 ${requests.length} 次请求`);
  const body = requests[0];
  const text = JSON.stringify(body);
  assert.match(text, /文字最多 1 条/, `提示词里应写明"文字最多 1 条"，实际没找到：${text.slice(0, 400)}`);
  assert.match(text, /并成一条说完/, '应该明确要求并成一条，而不是先发引子');
  // 同时不能出现"最多 3 条/4 条"这种和真实额度打架的数字
  assert.ok(!/文字最多 [234] 条/.test(text), '不该再出现档位给的 3~4 条上限');
});

// ── ③ 额度充足：提示词按档位给，不被干扰 ─────────────────────────────────
await ok('额度充足 → 提示词不被额度影响（回到档位给的数）', async () => {
  requests.length = 0;
  fillMinuteBucket(0);
  seedUnread();
  await orch.wake(GROUP);
  assert.strictEqual(requests.length, 1);
  const text = JSON.stringify(requests[0]);
  assert.match(text, /文字最多 [234] 条/, '额度充足时应按档位给上限');
  assert.ok(!/并成一条说完/.test(text), '额度充足时不该出现"并成一条"的提醒');
});

// ── ④ 不限额度：同样不干扰 ───────────────────────────────────────────────
await ok('不限额度（maxPerMinute=0）→ 提示词不被额度影响', async () => {
  updateConfig({ send: { maxPerMinute: 0 } });
  requests.length = 0;
  fillMinuteBucket(0);
  seedUnread();
  await orch.wake(GROUP);
  assert.strictEqual(requests.length, 1);
  assert.ok(!/并成一条说完/.test(JSON.stringify(requests[0])), '不限额度时不该出现额度提醒');
  updateConfig({ send: { maxPerMinute: 4 } });
});

console.log(`\n[send-quota-e2e] ${pass} 项全部通过`);

try { server.close(); } catch { /* 无所谓 */ }
try { orch.aborted = true; } catch { /* 无所谓 */ }
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
process.exit(0);
