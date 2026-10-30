// 复读拦截（echo-guard）插件的行为测试
//
// 2026-10-29 第 12 轮：这里盯的是一个**用户能直接看见**的缺陷 ——
// 她明明想说话，消息却没了。
//
// 数据依据（1000 个真实会话、15 次「复读拦截」）：
//   5 次被拦的那句，上一轮其实是**发送失败**的（4 次撞分钟额度、1 次白名单失效）。
//   模型换个说法重发，被自己上次的失败记录挡下 → 这一轮彻底沉默。
//   另有 1 次模型把整轮 messages 传成了 JSON 字符串，否决原因回显里带着 `["`。
//
// 所以测三件事：
//   1. 只有**真的发出去**的句子才进"说过"的历史；
//   2. 发送失败 → 重发不被拦；
//   3. 双重编码的 messages 能正确摊平（不会把整串当一句话，也不会回显 `["`）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHookBus } from '../src/hook-bus.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createExtensionHost } from '../src/plugin-host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (e) {
    failures.push({ name, message: String(e?.message ?? e) });
    console.error('  ✗', name, '\n      ', String(e?.message ?? e));
    process.exitCode = 1;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

/** 每个用例用独立的 host，避免 history 互相污染。 */
async function withGuard(fn) {
  const bus = createHookBus({ log: { warn: () => {} } });
  const host = createExtensionHost({
    root: ROOT,
    registry: createToolRegistry(),
    bus,
    getCustom: () => ({ plugins: { enabled: ['echo-guard'], settings: {} } }),
    log: { info: () => {}, warn: () => {} },
  });
  await host.load();
  try {
    await fn({ bus });
  } finally {
    await host.disposeAll();
  }
}

const before = (bus, chatKey, messages, sent = []) =>
  bus.emit('before-tool', {
    toolName: 'send_message',
    argsRaw: JSON.stringify({ messages }),
    session: { chatKey, sent },
  });
const after = (bus, chatKey, { result = '{"sent":1}', isError = false } = {}) =>
  bus.emit('after-tool', { toolName: 'send_message', result, isError, session: { chatKey } });

console.log('── 1. 成功的发送才记账 ──');
await ok('发出去之后，再说同一句会被拦', async () => {
  await withGuard(async ({ bus }) => {
    const a = await before(bus, 'g:1', '今天天气不错啊');
    assert(a.vetoed === null, '首次不该被拦');
    await after(bus, 'g:1');
    const b = await before(bus, 'g:1', '今天天气不错啊');
    assert(b.vetoed, '说过的话再说应被拦');
  });
});

await ok('发送失败的那句不算说过 → 重发不被拦（本轮主 bug）', async () => {
  await withGuard(async ({ bus }) => {
    const a = await before(bus, 'g:2', '这句其实没发出去呀');
    assert(a.vetoed === null, '首次不该被拦');
    await after(bus, 'g:2', { result: '错误：这一分钟发到上限（4 条）了', isError: true });
    const b = await before(bus, 'g:2', '这句其实没发出去呀');
    assert(b.vetoed === null, '上次没发出去，这次必须放行');
  });
});

await ok('失败后重发成功，再发同一句才被拦', async () => {
  await withGuard(async ({ bus }) => {
    const text = '再试一次这句话呀';
    await before(bus, 'g:3', text);
    await after(bus, 'g:3', { isError: true });
    const retry = await before(bus, 'g:3', text);
    assert(retry.vetoed === null, '重发应放行');
    await after(bus, 'g:3', { isError: false });
    const again = await before(bus, 'g:3', text);
    assert(again.vetoed, '这次真发出去了，再发应被拦');
  });
});

console.log('── 2. 部分发送成功：只记真的出去的那几条 ──');
await ok('sent=1 时只记第一条，第二条仍可发', async () => {
  await withGuard(async ({ bus }) => {
    const msgs = ['第一条真的发出去了', '第二条被省掉了呀'];
    const a = await before(bus, 'g:4', msgs);
    assert(a.vetoed === null, '首次不该被拦');
    await after(bus, 'g:4', { result: '{"sent":1}', isError: false });
    // 第一条已记 → 被拦
    const b = await before(bus, 'g:4', '第一条真的发出去了');
    assert(b.vetoed, '第一条应被拦');
    // 第二条没记 → 放行
    const c = await before(bus, 'g:4', '第二条被省掉了呀');
    assert(c.vetoed === null, '没发出去的第二条不该被记');
  });
});

console.log('── 3. 双重编码的 messages ──');
await ok('messages 是 JSON 字符串数组 → 按多条处理，否决原因不带 ["', async () => {
  await withGuard(async ({ bus }) => {
    const a = await before(bus, 'g:5', '["劝君更哈一口气，西出阳关无大狗", "下句就是莫愁前路"]');
    assert(a.vetoed === null, '首次不该被拦');
    await after(bus, 'g:5', { result: '{"sent":2}', isError: false });
    const b = await before(bus, 'g:5', '劝君更哈一口气，西出阳关无大狗');
    assert(b.vetoed, '拆开后的第一条应被拦');
    const reason = String(b.vetoed.reason || '');
    assert(!reason.includes('["'), `否决原因不该回显 ["：${reason}`);
    assert(reason.includes('劝君更哈一口气'), `否决原因应指出真正重复的那句：${reason}`);
  });
});

await ok('messages 是 JSON 字符串（单个） → 能正确解析', async () => {
  await withGuard(async ({ bus }) => {
    const a = await before(bus, 'g:6', '"这是被多包了一层的句子"');
    assert(a.vetoed === null, '首次不该被拦');
    await after(bus, 'g:6');
    const b = await before(bus, 'g:6', '这是被多包了一层的句子');
    assert(b.vetoed, '解析出真实内容后应被拦');
  });
});

console.log('── 4. 原有护栏不能退化 ──');
await ok('短句不判重（minLen 保护）', async () => {
  await withGuard(async ({ bus }) => {
    await before(bus, 'g:7', '嗯嗯');
    await after(bus, 'g:7');
    const b = await before(bus, 'g:7', '嗯嗯');
    assert(b.vetoed === null, '短句不该被拦');
  });
});

await ok('不同会话互不影响', async () => {
  await withGuard(async ({ bus }) => {
    await before(bus, 'g:8', '这个群里说过的话');
    await after(bus, 'g:8');
    const b = await before(bus, 'g:9', '这个群里说过的话');
    assert(b.vetoed === null, '别的群说过不该影响这个群');
  });
});

await ok('单轮条数上限仍然生效', async () => {
  await withGuard(async ({ bus }) => {
    const sent = Array.from({ length: 6 }, (_, i) => ({ type: 'text', text: `第${i}条` }));
    const r = await before(bus, 'g:10', '再来一条全新的内容', sent);
    assert(r.vetoed, '超过 maxPerRun 应被拦');
    assert(/别再刷了/.test(String(r.vetoed.reason)), `原因应提到刷屏：${r.vetoed.reason}`);
  });
});

await ok('非 send_message 工具完全不受影响', async () => {
  await withGuard(async ({ bus }) => {
    const r = await bus.emit('before-tool', {
      toolName: 'send_sticker',
      argsRaw: JSON.stringify({ stickerId: 'x' }),
      session: { chatKey: 'g:11', sent: [] },
    });
    assert(r.vetoed === null, '表情工具不该被复读拦截管');
  });
});

console.log(`\n[echo-guard] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
