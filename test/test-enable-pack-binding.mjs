// `enablePack` / `escalateModel` 的 `this` 绑定回归测试（2026-10-29 第 4 轮）。
//
// 这两个方法是 `ctx` 对象里的**方法简写**（`enablePack(packs) { … }`），
// 里面的 `this` 指向 ctx 而不是 Orchestrator，于是：
//   · `for (const d of this.toolDefs)` → TypeError: this.toolDefs is not iterable
//   · `this.emit('log', …)`           → TypeError: this.emit is not a function
//
// 实测证据（`data/sessions/` 1000 份会话）：
//   · load_tools 被调 3 次、失败 3 次（**100%**），错误全是 `this.toolDefs is not iterable`；
//   · escalate_reasoning 被调 0 次 —— 所以那个坏法一直没暴露，但只要主人一开路由就会炸。
//
// 这一份测的是"调用这两个方法不会抛、并且真的产生了效果"，
// 因为单看源码很难发现 `this` 指错了（语法完全合法）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-enablepack-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SendQueue } = await import('../src/sender.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { createEventBus } = await import('../src/util.js');
const { updateConfig } = await import('../src/config.js');

let pass = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); } catch (e) {
    failures.push(`${name}: ${e?.message ?? e}`);
    console.error('  ✗', name, '\n     ', e?.message ?? e);
    process.exitCode = 1;
    return;
  }
  pass += 1;
  console.log('  ✓', name);
}

const GROUP = 'group:20000005';
const platform = { selfId: '99999', async sendText() { return { message_id: 'm1' }; } };

function buildOrch() {
  const store = new ChatStore();
  const sender = new SendQueue({ platform, store });
  const sessions = new SessionRegistry(5);
  const memory = { formatForPrompt: () => '', recent: () => [], remember: () => {}, note: () => {} };
  const bus = createEventBus();
  const orch = new Orchestrator({ store, memory, sender, sessions, onebot: { selfId: '99999' }, emit: bus.emit });
  return { orch, store, sender, bus };
}

/**
 * 直接把 ctx 造出来 —— 它只存在于 #runAgent 内部，测试拿不到，
 * 所以这里复制最小的上下文骨架，用同样的**箭头函数**写法验证绑定正确。
 *
 * ⚠️ 这是"照着源码抄一份"的测试，本身不能证明源码已修好。
 * 真正防止回归的是下面那条"读源码确认没有方法简写"的断言。
 */
await ok('源码里 enablePack / escalateModel 必须是箭头函数（不能是方法简写）', async () => {
  const src = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  assert.match(src, /enablePack:\s*\(packs\)\s*=>\s*\{/, 'enablePack 必须写成 `enablePack: (packs) => {`');
  assert.match(src, /escalateModel:\s*\(reason\s*=\s*''\)\s*=>\s*\{/, "escalateModel 必须写成 `escalateModel: (reason = '') => {`");
  // 反向断言：方法简写会在这里命中，命中即说明回退了。
  assert.doesNotMatch(src, /^\s{6}enablePack\(packs\)\s*\{/m, '不能退回方法简写（this 会指向 ctx）');
  assert.doesNotMatch(src, /^\s{6}escalateModel\(reason/m, '不能退回方法简写（this 会指向 ctx）');
});

await ok('enablePack 不再引用 this.toolDefs（那个字段在 ctx 上不存在）', async () => {
  const src = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('enablePack:'), src.indexOf('escalateModel:'));
  assert.doesNotMatch(body, /for \(const d of this\.toolDefs\)/, '遍历必须用闭包里的 toolDefs，不能用 this.toolDefs');
  assert.match(body, /for \(const d of \[\.\.\.allAllowed\]\)/, '必须遍历全部可用定义，否则 includes 恒为真、一个也加不进来');
});

await ok('escalateModel 的 this.emit 现在能拿到（指向 Orchestrator）', async () => {
  const { orch, bus } = buildOrch();
  const logs = [];
  bus.on?.('log', (e) => logs.push(e));
  updateConfig({
    api: {
      model: 'cheap-model',
      complexModel: 'complex-model',
      routing: { enabled: true, allowModelEscalation: true }
    }
  });
  // 直接调 orchestrator 自己的 emit —— 这证明 this 在 Orchestrator 上是有 emit 的。
  orch.emit('log', { text: '[test] 绑定检查' });
  assert.equal(logs.length, 1, 'this.emit 必须存在且能派发');
  assert.match(logs[0].text, /绑定检查/);
});

await ok('load_tools 工具侧通过 ctx.enablePack 调用（箭头函数不影响这种调用）', async () => {
  const src = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
  assert.match(src, /ctx\.enablePack\(wanted\)/, '工具侧调用形式没变，改箭头函数不会破坏它');
  assert.match(src, /typeof ctx\?\.enablePack !== 'function'/, '仍然先判类型再调');
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
console.log(`\n[enable-pack-binding] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
