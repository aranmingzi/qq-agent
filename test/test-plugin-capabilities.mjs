// 扩展包的能力契约：声明的权限必须真的接得出可调用的成员。
// 跑：node test/test-plugin-capabilities.mjs（秒级、不碰网络、只写系统临时目录）
//
// 背景（2026-10-21 自查出的第二例"声明≠接线"）：
//   PERMISSION_NAMES 里有 send_image / storage，`has()` 返回 true，
//   但 buildApi 从来没给过 api.sendImage / api.storage —— 插件先判真再调用就 TypeError。
//   这个测试锁死三件事：
//     ① 三项权限的 API 形状恒定（永远是函数/对象，绝不是 undefined）
//     ② 没接线时给的是"说得清原因"的错误，不是 TypeError
//     ③ 接上了就真的能用（存储隔离、容量上限、发图参数校验）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildApi, createPluginStorage, PERMISSION_NAMES, STORAGE_MAX_BYTES, STORAGE_KEYS_MAX } =
  await import('../src/plugin-api.js');
const { actionTool, normalizeActions, ACTION_MAX } = await import('../src/plugin-toolkit.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-extcap-'));
const noopLog = { warn: () => {}, info: () => {} };

let pass = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name + '\n       ' + (error?.message ?? error));
    process.exitCode = 1;
  }
}

function apiOf(permissions, extra = {}) {
  return buildApi({
    manifest: { id: 'demo', name: 'Demo', permissions },
    log: noopLog,
    ...extra,
  });
}

console.log('\n权限名与能力对齐');

await ok('PERMISSION_NAMES 里的每一项，api 上都有对应成员', () => {
  const api = apiOf([...PERMISSION_NAMES]);
  assert.equal(typeof api.fetch, 'function', 'web_fetch → api.fetch');
  assert.equal(typeof api.sendImage, 'function', 'send_image → api.sendImage');
  assert.equal(typeof api.storage, 'object', 'storage → api.storage');
  assert.equal(typeof api.storage.get, 'function');
  assert.equal(typeof api.storage.set, 'function');
});

await ok('没声明也拿得到成员（形状恒定，不是 undefined）', async () => {
  const api = apiOf([]);
  assert.equal(typeof api.sendImage, 'function');
  assert.equal(typeof api.storage.get, 'function');
  await assert.rejects(() => api.sendImage('group:1', 'https://example.com/a.png'), /send_image/);
  assert.throws(() => api.storage.get('k'), /storage/);
});

await ok('声明了但宿主没接 → unwired，报错说明是宿主侧问题', async () => {
  const api = apiOf(['send_image', 'storage']);
  const state = api.capabilityState();
  assert.equal(state.send_image, 'unwired');
  assert.equal(state.storage, 'unwired');
  assert.equal(state.web_fetch, 'undeclared', '没声明的也要报状态（否则看不全）');
  await assert.rejects(() => api.sendImage('group:1', 'https://example.com/a.png'), /宿主没有接出/);
  assert.throws(() => api.storage.set('k', 1), /宿主没有提供存储目录/);
});

console.log('\nsend_image：真的发得出去');

await ok('声明 + 接线 → 透传 chatKey / url / 选项', async () => {
  const calls = [];
  const api = apiOf(['send_image'], {
    sendImage: async (chatKey, url, opts) => { calls.push({ chatKey, url, opts }); return { message_id: 42 }; },
  });
  assert.equal(api.capabilityState().send_image, 'wired');
  const r = await api.sendImage('group:123456', 'https://example.com/cat.png', { replyToMessageId: 7 });
  assert.deepEqual(r, { messageId: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatKey, 'group:123456');
  assert.equal(calls[0].opts.replyToMessageId, 7);
});

await ok('chatKey 形状不对 → 拒绝（不许发到任意 ID）', async () => {
  let called = 0;
  const api = apiOf(['send_image'], { sendImage: async () => { called += 1; return {}; } });
  for (const bad of ['', 'group:', 'other:1', 'group:abc', 'private:12 34']) {
    await assert.rejects(() => api.sendImage(bad, 'https://example.com/a.png'), /chatKey/, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.equal(called, 0, '校验没过就不能走到真发送');
});

await ok('非 http(s) 地址 / 超长地址 → 拒绝', async () => {
  const api = apiOf(['send_image'], { sendImage: async () => ({}) });
  for (const bad of ['', 'file:///etc/passwd', 'base64://AAAA', 'C:\\a.png', 'data:image/png;base64,xx']) {
    await assert.rejects(() => api.sendImage('group:1', bad), /公网 http\(s\)/);
  }
  await assert.rejects(() => api.sendImage('group:1', `https://a.com/${'x'.repeat(3000)}`), /过长/);
});

console.log('\nstorage：按插件隔离的抽屉');

await ok('基本读写：set / get / has / keys / all / remove / clear', () => {
  const dir = path.join(DIR, 'store-basic');
  const s = createPluginStorage({ id: 'alpha', dir, log: noopLog });
  assert.equal(s.get('nope'), null);
  assert.equal(s.get('nope', 'dflt'), 'dflt');
  assert.deepEqual(s.set('count', 3), { ok: true, keys: 1, bytes: s.bytes() });
  assert.equal(s.get('count'), 3);
  assert.equal(s.has('count'), true);
  assert.deepEqual(s.keys(), ['count']);
  assert.deepEqual(s.all(), { count: 3 });
  s.set('name', '阿尔法');
  assert.equal(s.remove('name'), true);
  assert.equal(s.remove('name'), false);
  assert.deepEqual(s.all(), { count: 3 });
  s.clear();
  assert.deepEqual(s.all(), {});
});

await ok('落盘是一个插件一个文件，别的插件看不到', () => {
  const dir = path.join(DIR, 'store-iso');
  const a = createPluginStorage({ id: 'alpha', dir, log: noopLog });
  const b = createPluginStorage({ id: 'beta', dir, log: noopLog });
  a.set('secret', 'only-alpha');
  assert.equal(b.get('secret'), null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['alpha.json'], '只写过 alpha，就只该有 alpha 的文件');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'alpha.json'), 'utf8')), { secret: 'only-alpha' });
});

await ok('另外实例读得到（不是内存缓存假象）', () => {
  const dir = path.join(DIR, 'store-persist');
  createPluginStorage({ id: 'gamma', dir, log: noopLog }).set('k', { nested: [1, 2] });
  const again = createPluginStorage({ id: 'gamma', dir, log: noopLog });
  assert.deepEqual(again.get('k'), { nested: [1, 2] });
});

await ok('容量超限 → 抛错，且不写坏已有数据', () => {
  const dir = path.join(DIR, 'store-cap');
  const s = createPluginStorage({ id: 'big', dir, log: noopLog });
  s.set('keep', 'ok');
  assert.throws(() => s.set('huge', 'x'.repeat(STORAGE_MAX_BYTES + 10)), /容量超限/);
  assert.equal(s.get('keep'), 'ok', '超限那次不该写盘');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'big.json'), 'utf8')), { keep: 'ok' });
});

await ok(`键数上限 ${STORAGE_KEYS_MAX} → 新增被拒，覆盖已有键仍可`, () => {
  const dir = path.join(DIR, 'store-keys');
  const s = createPluginStorage({ id: 'many', dir, log: noopLog });
  for (let i = 0; i < STORAGE_KEYS_MAX; i += 1) s.set(`k${i}`, i);
  assert.throws(() => s.set('one-more', 1), /键数上限/);
  s.set('k0', 999);
  assert.equal(s.get('k0'), 999);
});

await ok('不可序列化的值 → 抛错（不静默写 null）', () => {
  const s = createPluginStorage({ id: 'circular', dir: path.join(DIR, 'store-circ'), log: noopLog });
  const a = {};
  a.self = a;
  assert.throws(() => s.set('bad', a), /无法序列化/);
  assert.equal(s.has('bad'), false);
  assert.throws(() => s.set('undefined', undefined), /无法序列化/);
});

await ok('空键名 → 拒绝', () => {
  const s = createPluginStorage({ id: 'blank', dir: path.join(DIR, 'store-blank'), log: noopLog });
  assert.throws(() => s.set('   ', 1), /键名不能为空/);
});

await ok('存储文件坏了 → 隔离留档 + 当空（不静默清零）', () => {
  const dir = path.join(DIR, 'store-corrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'delta.json'), '{"a":');
  const s = createPluginStorage({ id: 'delta', dir, log: noopLog });
  assert.deepEqual(s.all(), {});
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith('delta.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"a":');
});

console.log('\naction 枚举工具');

const echo = (spec) => actionTool({
  id: 'demo_tool',
  description: '演示：一个工具管多件事',
  actions: { list: '列出全部', read: '读一条', write: '写一条' },
  properties: { key: { type: 'string', description: '目标键' } },
  execute: async (ctx, args, action) => `action=${action} key=${args.key ?? ''}`,
  ...spec,
});

await ok('action 是 enum，排在第一，说明带全部动作', () => {
  const def = echo();
  const p = def.parameters.properties;
  assert.deepEqual(Object.keys(p), ['action', 'key'], 'action 必须排第一');
  assert.deepEqual(p.action.enum, ['list', 'read', 'write']);
  assert.match(p.action.description, /list=列出全部/);
  assert.deepEqual(def.parameters.required, ['action']);
  assert.deepEqual(def.actions, ['list', 'read', 'write']);
});

await ok('正常分发：execute 收到 (ctx, args, action)', async () => {
  const def = echo();
  assert.deepEqual(await def.execute({}, { action: 'read', key: 'x' }), { content: 'action=read key=x' });
});

await ok('非法 action → isError 且列出可选项（让模型自己改，不放弃工具）', async () => {
  const def = echo();
  const r = await def.execute({}, { action: 'delete' });
  assert.equal(r.isError, true);
  assert.match(r.content, /没有 action「delete」/);
  assert.match(r.content, /read=读一条/);
});

await ok('空 action 也被拦（不是落到插件代码里）', async () => {
  const def = echo();
  const r = await def.execute({}, {});
  assert.equal(r.isError, true);
  assert.match(r.content, /\(空\)/);
});

await ok('execute 抛错 → 转成 isError，不让异常穿透工具循环', async () => {
  const def = echo({ execute: async () => { throw new Error('插件内部炸了'); } });
  const r = await def.execute({}, { action: 'list' });
  assert.equal(r.isError, true);
  assert.match(r.content, /插件内部炸了/);
});

await ok('execute 返回字符串 → 包成 content', async () => {
  const def = echo({ execute: () => 'plain' });
  assert.deepEqual(await def.execute({}, { action: 'list' }), { content: 'plain' });
});

await ok('required 里除 action 外的键会保留', () => {
  const def = echo({ required: ['key'] });
  assert.deepEqual(def.parameters.required, ['action', 'key']);
});

await ok('非法动作名被丢弃并记 problem，最多 ACTION_MAX 个', () => {
  const problems = [];
  const list = normalizeActions({ ok1: '好的', 'BAD NAME': '带空格', ok2: '也好' }, { problems });
  assert.deepEqual(list.map((a) => a.name), ['ok1', 'ok2']);
  assert.equal(problems.length, 1);

  const many = {};
  for (let i = 0; i < ACTION_MAX + 5; i += 1) many[`a${i}`] = `动作${i}`;
  assert.equal(normalizeActions(many).length, ACTION_MAX);
});

await ok('api.actionTool 通过宿主暴露（插件不用 import 宿主文件）', () => {
  const api = apiOf([]);
  // 没传 makeActionTool 时不该声称有这个能力
  assert.equal(api.actionTool, undefined);
  const withToolkit = apiOf([], { makeActionTool: actionTool });
  assert.equal(typeof withToolkit.actionTool, 'function');
  const def = withToolkit.actionTool({ id: 't', description: 'd', actions: { go: '走' }, execute: () => 'ok' });
  assert.deepEqual(def.parameters.properties.action.enum, ['go']);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过'}`);
