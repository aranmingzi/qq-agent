// 插件系统冒烟测试：验证 manifest 校验、白名单、加载执行、工具注册、钩子总线
// 独立运行，不依赖 electron / QQ 连接

import { loadExtensions, createExtensionHost } from '../src/plugin-host.js';
import { createHookBus } from '../src/hook-bus.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { normalizeManifest, planLoad, isValidPluginId } from '../src/plugin-manifest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log('── 1. 清单判据（纯函数）──');
assert('isValidPluginId 接受英文 id', isValidPluginId('echo-guard'));
assert('isValidPluginId 拒绝中文 id', !isValidPluginId('复读拦截'));
const nm = normalizeManifest({ id: 'x', apiVersion: 1 }, { fallbackId: '目录名', kind: 'plugin' });
assert('normalizeManifest 无致命错误', nm.fatal.length === 0);
assert('normalizeManifest 保留 settings', typeof nm.manifest.settings === 'object');
const nmBad = normalizeManifest({ id: 'x', apiVersion: 999 });
assert('apiVersion 不符 → 致命', nmBad.fatal.some((f) => f.code === 'api-version-mismatch'));

console.log('── 2. 扫描 + 白名单 ──');
const enabled = ['echo-guard', 'encyclo-lookup', 'fresh-news'];
const { plan, sum } = loadExtensions({ root: ROOT, enabled, log: { info: () => {}, warn: () => {} } });
console.log(`  扫描合计 ${sum.total} 个 → 可加载 ${sum.load} · 未启用 ${sum.skip} · 有问题 ${sum.reject}`);
assert('发现 3 个扩展（1 plugin + 2 skill）', sum.total === 3);
assert('3 个都可加载', sum.load === 3);
assert('无拒绝', sum.reject === 0);
assert('plan 中 echo-guard 是 load', plan.find((p) => p.id === 'echo-guard')?.action === 'load');
assert('plan 中 encyclo-lookup 是 load', plan.find((p) => p.id === 'encyclo-lookup')?.action === 'load');
assert('plan 中 fresh-news 是 load', plan.find((p) => p.id === 'fresh-news')?.action === 'load');

console.log('── 3. 宿主加载执行 ──');
const bus = createHookBus({ log: { warn: () => {} } });
const registry = createToolRegistry();
const host = createExtensionHost({
  root: ROOT,
  registry,
  bus,
  getCustom: () => ({ plugins: { enabled, settings: {} } }),
  log: { info: () => {}, warn: () => {} },
});
const snap = await host.load();
console.log(`  执行结果 → 已加载 ${snap.sum.loaded} · 未启用 ${snap.sum.pending} · 失败 ${snap.sum.failed}`);
assert('3 个扩展都 loaded', snap.sum.loaded === 3);
assert('无失败', snap.sum.failed === 0);

console.log('── 4. 工具注册（skill 注册了 encyclo_lookup）──');
const names = registry.names();
console.log('  已注册工具:', names.join(', '));
assert('encyclo-lookup 工具已注册（owner 前缀）', names.some((n) => n.includes('encyclo_lookup')));
const toolNames = registry.meta().map((t) => t.name);
const encycloTool = toolNames.find((n) => n.includes('encyclo_lookup'));
assert('工具 name 带 owner 前缀', encycloTool && encycloTool.startsWith('encyclo-lookup__'));

console.log('── 5. 钩子总线（echo-guard 挂了 before-tool）──');
assert('before-tool 有 1 个钩子', bus.size('before-tool') === 1);
assert('钩子 owner 是 echo-guard', bus.owners().includes('echo-guard'));
// 触发一次 send_message，验证不否决（首次发送，无历史）
const r1 = await bus.emit('before-tool', {
  toolName: 'send_message',
  argsRaw: JSON.stringify({ messages: '你好呀，第一次发这条' }),
  session: { chatKey: 'test:123', sent: [] },
});
assert('首次发送不被否决', r1.vetoed === null);
assert('before-tool 执行了 1 个钩子', r1.ran === 1);
// 2026-10-29 第 12 轮：记账从 before-tool 挪到了 after-tool ——
// 只有"真的发出去"才算说过，所以这里要先回灌一次成功的 after-tool。
// ⚠️ after-tool 必须带 session.chatKey：插件的 popPending 只认带会话的记账
//（防跨群记错），不带 = 不记账 = 下面的复读否决永远不触发。
await bus.emit('after-tool', { toolName: 'send_message', result: '{"sent":1}', isError: false, session: { chatKey: 'test:123' } });
// 再次发同样内容 → 应被否决
const r2 = await bus.emit('before-tool', {
  toolName: 'send_message',
  argsRaw: JSON.stringify({ messages: '你好呀，第一次发这条' }),
  session: { chatKey: 'test:123', sent: [{ type: 'text', text: '你好呀，第一次发这条' }] },
});
assert('复读同一条被否决', r2.vetoed !== null && r2.vetoed.owner === 'echo-guard');
if (r2.vetoed) console.log(`  否决原因: ${r2.vetoed.reason}`);

// 失败的那次不该被记成"说过"：这是本轮修的 bug
// （发送失败 → 换个说法重发 → 被自己上次的失败记录挡下 → 用户看到"它没理我"）
const bus2 = createHookBus({ log: { warn: () => {} } });
const host2 = createExtensionHost({
  root: ROOT,
  registry: createToolRegistry(),
  bus: bus2,
  getCustom: () => ({ plugins: { enabled, settings: {} } }),
  log: { info: () => {}, warn: () => {} },
});
await host2.load();
const failText = '这句其实没发出去呀';
const f1 = await bus2.emit('before-tool', {
  toolName: 'send_message',
  argsRaw: JSON.stringify({ messages: failText }),
  session: { chatKey: 'test:456', sent: [] },
});
assert('失败用例：首次不否决', f1.vetoed === null);
await bus2.emit('after-tool', { toolName: 'send_message', result: '错误：这一分钟发到上限（4 条）了', isError: true });
const f2 = await bus2.emit('before-tool', {
  toolName: 'send_message',
  argsRaw: JSON.stringify({ messages: failText }),
  session: { chatKey: 'test:456', sent: [] },
});
assert('发送失败的那句不算说过 → 重发不被否决', f2.vetoed === null);
await host2.disposeAll();

console.log('── 6. 工具执行（skill executor 可调用，需网络，此处只验证接线）──');
const exec = registry.executorOf(encycloTool);
assert('encyclo 工具 executor 存在', typeof exec === 'function');
// 不实际发网络请求，只验证 executor 是函数（网络测试可选）

console.log('── 7. dispose 清理 ──');
const dispose = await host.disposeAll();
assert('dispose 摘掉钩子', dispose.hooksRemoved >= 1);
assert('dispose 后 before-tool 无钩子', bus.size('before-tool') === 0);

console.log(`\n结果：${pass} 通过 · ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
