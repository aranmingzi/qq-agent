// 出站媒体否决点 + 清单 prompt.sections。
// 跑：node test/test-plugin-media-prompt.mjs（秒级；会真的 sleep 几次，最长约 4 秒）
//
// 这两条一起测，因为它们共用一条链路：
//   插件 → hook-bus → sender（before-media）/ prompt.js（sections）
// 所以最后一个用例是**端到端**：把临时插件装进真宿主，让它的 before-media 钩子
// 真的拦住一次发图，并且它的 prompt.sections 真的出现在系统提示里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createHookBus, HOOK_POINTS } = await import('../src/hook-bus.js');
const { SendQueue } = await import('../src/sender.js');
const { getConfig } = await import('../src/config.js');
const {
  normalizePromptSections, sortPromptSections, normalizeManifest,
  PROMPT_SECTIONS_MAX, PROMPT_SECTION_BODY_MAX, PROMPT_SECTIONS_TOTAL_MAX,
} = await import('../src/plugin-manifest.js');
const { renderExtensionSections, buildSystemPrompt } = await import('../src/prompt.js');
const { createToolRegistry } = await import('../src/tool-registry.js');
const { createExtensionHost } = await import('../src/plugin-host.js');

// 关掉限频与节奏：这两个是生产行为，不该让断言变成"看运气"。
const cfg = getConfig();
cfg.send = { ...(cfg.send || {}), maxPerMinute: 0, maxPerHour: 0, hardSplitAt: 0, pace: { enabled: false } };

const noopLog = { warn: () => {}, info: () => {} };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-media-prompt-'));

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

function fakeOneBot() {
  let seq = 0;
  const calls = [];
  const done = (extra = {}) => ({ message_id: ++seq, ...extra });
  return {
    calls,
    async sendText(kind, id, text) { calls.push({ type: 'text', text }); return done(); },
    async sendImage(kind, id, url) { calls.push({ type: 'image', url }); return done(); },
    async sendFile(kind, id, filePath, fileName) { calls.push({ type: 'file', filePath, fileName }); return { file_id: 'f1' }; },
    async sendRecord(kind, id, file) { calls.push({ type: 'record', file }); return done(); },
    async sendSticker(kind, id, url) { calls.push({ type: 'sticker', url }); return done(); },
  };
}

function senderWith(guard) {
  const onebot = fakeOneBot();
  const store = { appendSelf() {} };
  const sender = new SendQueue({ onebot, store, beforeMedia: guard });
  return { sender, onebot };
}

console.log('\n钩子点');

await ok('before-media 是已登记的钩子点', () => {
  assert.ok(HOOK_POINTS.includes('before-media'), '不在 HOOK_POINTS 里就注册不上');
});

await ok('未知钩子点仍然被拒绝（新点没有把校验搞松）', () => {
  const bus = createHookBus({ log: noopLog });
  assert.equal(bus.on('before-everything', () => {}, { owner: 'x' }), false);
  assert.equal(bus.on('incoming-message', () => {}, { owner: 'x' }), false);
});

console.log('\nsender：所有出站媒体都过一个点');

await ok('没有钩子时四种媒体照发（不改变默认行为）', async () => {
  const { sender, onebot } = senderWith(null);
  await sender.sendImage('group:1', 'https://example.com/a.png');
  await sender.sendFile('group:1', '/tmp/a.txt', 'a.txt');
  await sender.sendVoice('group:1', { file: 'base64://AAAA', label: '短句' });
  await sender.sendSticker('group:1', { id: 's1', url: 'https://example.com/s.png', desc: '狗头' });
  assert.deepEqual(onebot.calls.map((c) => c.type), ['image', 'file', 'record', 'sticker']);
});

for (const [kind, run] of [
  ['图片', (s) => s.sendImage('group:2', 'https://example.com/blocked.png')],
  ['文件', (s) => s.sendFile('group:2', '/tmp/blocked.txt', 'blocked.txt')],
  ['语音', (s) => s.sendVoice('group:2', { file: 'base64://AAAA', label: 'blocked' })],
  ['表情', (s) => s.sendSticker('group:2', { id: 's2', url: 'https://example.com/blocked.png', desc: '狗头' })],
]) {
  await ok(`${kind}被否决 → 真的没发出去，错误里带原因和插件名`, async () => {
    const seen = [];
    const { sender, onebot } = senderWith(async (p) => {
      seen.push(p);
      return { vetoed: { reason: '这张图不合适', owner: 'guard-plugin' } };
    });
    await assert.rejects(() => run(sender), /这张图不合适.*guard-plugin/);
    assert.equal(onebot.calls.length, 0, '被否决的绝不能落到 onebot');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].chatKey, 'group:2');
  });
}

await ok('钩子自己抛错 → 放行（拦截系统不能因为自身 bug 变成全静默）', async () => {
  const { sender, onebot } = senderWith(async () => { throw new Error('钩子写挂了'); });
  await sender.sendImage('group:3', 'https://example.com/ok.png');
  assert.equal(onebot.calls.length, 1);
});

await ok('被否决的那次不占限频额度', async () => {
  cfg.send = { ...cfg.send, maxPerMinute: 1, maxPerHour: 0 };
  const { sender } = senderWith(async () => ({ vetoed: { reason: '先拦一下' } }));
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => sender.sendImage('group:4', 'https://example.com/x.png'), /先拦一下/);
  }
  // 还留着额度：取消否决后发一条文本应当成功（若前三次计了数，这里会撞上限）
  sender.beforeMedia = null;
  await sender.sendTextBatch('group:4', ['还在吗']);
  cfg.send = { ...cfg.send, maxPerMinute: 0, maxPerHour: 0 };
});

await ok('base64 语音的 source 被裁剪（不把整段 base64 塞进钩子）', async () => {
  const seen = [];
  const { sender } = senderWith(async (p) => { seen.push(p); return null; });
  const big = `base64://${'A'.repeat(5000)}`;
  await sender.sendVoice('group:5', { file: big, label: '长语音' });
  assert.equal(seen.length, 1);
  assert.match(seen[0].source, /^base64:\/\/\(\d+ 字符\)$/);
  assert.ok(seen[0].source.length < 40, '裁剪后必须很短');
  assert.match(seen[0].label, /长语音/);
});

await ok('钩子载荷带 kind，能看到是图还是文件', async () => {
  const seen = [];
  const { sender } = senderWith(async (p) => { seen.push(p.kind); return null; });
  await sender.sendImage('group:6', 'https://example.com/a.png');
  await sender.sendFile('group:6', '/tmp/a.txt', 'a.txt');
  assert.deepEqual(seen, ['image', 'file']);
});

console.log('\nprompt.sections 归一化');

await ok('正常数组：保留顺序外的 order，title 缺省为「说明」', () => {
  const out = normalizePromptSections([
    { title: '复读拦截', body: '同一句话不要 20 分钟内发两遍', order: 20 },
    { body: '我还会贴表情' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '复读拦截');
  assert.equal(out[1].title, '说明');
  assert.equal(out[1].order, 100);
});

await ok('紧凑写法 { 标题: 正文 } 也认', () => {
  const out = normalizePromptSections({ 点歌台: '点歌用 #点歌 歌名' });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '点歌台');
  assert.equal(out[0].body, '点歌用 #点歌 歌名');
});

await ok('空正文丢弃并记 problem', () => {
  const problems = [];
  const out = normalizePromptSections([{ title: '空的', body: '   ' }, '有内容的'], problems);
  assert.equal(out.length, 1);
  assert.equal(problems[0].code, 'empty-prompt-section');
});

await ok(`单段超 ${PROMPT_SECTION_BODY_MAX} 字截断并记 problem`, () => {
  const problems = [];
  const out = normalizePromptSections([{ title: 'T', body: 'x'.repeat(PROMPT_SECTION_BODY_MAX + 50) }], problems);
  assert.equal(out[0].body.length, PROMPT_SECTION_BODY_MAX);
  assert.equal(problems[0].code, 'long-prompt-section');
});

await ok(`超过 ${PROMPT_SECTIONS_MAX} 段只留前几段`, () => {
  const problems = [];
  const many = Array.from({ length: PROMPT_SECTIONS_MAX + 3 }, (_, i) => ({ title: `t${i}`, body: 'b' }));
  const out = normalizePromptSections(many, problems);
  assert.equal(out.length, PROMPT_SECTIONS_MAX);
  assert.equal(problems[0].code, 'too-many-prompt-sections');
});

await ok(`总长超 ${PROMPT_SECTIONS_TOTAL_MAX} 字时后面的段落丢弃`, () => {
  const problems = [];
  const body = 'y'.repeat(PROMPT_SECTION_BODY_MAX);
  const list = Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, body }));
  const out = normalizePromptSections(list, problems);
  assert.ok(out.length < 5, '5×600 一定超总量');
  assert.ok(out.reduce((n, s) => n + s.body.length, 0) <= PROMPT_SECTIONS_TOTAL_MAX);
  assert.equal(problems.at(-1).code, 'prompt-sections-overflow');
});

console.log('\nprompt.sections 进清单 / 进提示词');

await ok('清单 prompt.sections → manifest.promptSections', () => {
  const { manifest, fatal } = normalizeManifest({
    id: 'demo', apiVersion: 1, name: '演示',
    prompt: { sections: [{ title: '边界', body: '别叫我播报天气' }] },
  });
  assert.deepEqual(fatal, []);
  assert.equal(manifest.promptSections.length, 1);
  assert.equal(manifest.promptSections[0].body, '别叫我播报天气');
});

await ok('没写 prompt 的清单拿到空数组（不是 undefined）', () => {
  const { manifest } = normalizeManifest({ id: 'demo2', apiVersion: 1, name: 'x' });
  assert.deepEqual(manifest.promptSections, []);
});

await ok('空段落 → 提示词里一个字都不多', () => {
  assert.equal(renderExtensionSections([]), '');
  assert.equal(renderExtensionSections([{ title: 'x', body: '  ' }]), '');
});

await ok('有段落 → 带统一标题，并写明优先级低于角色设定', () => {
  const text = renderExtensionSections([{ title: '复读拦截', body: '同一句话别连发' }]);
  assert.match(text, /【已启用的扩展包】/);
  assert.match(text, /· 复读拦截：同一句话别连发/);
  assert.match(text, /优先级低于角色设定与安全规则/);
});

await ok('段落排在系统提示最后（管理员规则之后）', () => {
  const p = buildSystemPrompt({
    persona: { botName: '小胡', masterQQ: '1', customRules: '管理员说：别用颜文字' },
    extraSections: [{ title: '扩展A', body: 'A 的边界' }],
  });
  const iAdmin = p.indexOf('【管理员附加规则】');
  const iExt = p.indexOf('【已启用的扩展包】');
  assert.ok(iAdmin > 0 && iExt > iAdmin, `管理员规则应在前（admin=${iAdmin}, ext=${iExt}）`);
  assert.equal(p.indexOf('扩展A'), p.lastIndexOf('扩展A'), '只出现一次');
});

await ok('buildSystemPrompt 不传 extraSections 时与原来一致（不出现空标题）', () => {
  const p = buildSystemPrompt({ persona: { botName: '小胡', masterQQ: '1' } });
  assert.equal(p.includes('【已启用的扩展包】'), false);
});

await ok('跨插件排序：order 优先，同 order 按插件 id（顺序稳定）', () => {
  const list = [
    { owner: 'zeta', order: 100, body: 'z' },
    { owner: 'beta', order: 10, body: 'b' },
    { owner: 'alpha', order: 100, body: 'a' },
  ];
  assert.deepEqual(sortPromptSections(list).map((s) => s.owner), ['beta', 'alpha', 'zeta']);
  // 输入顺序打乱，输出不变
  const shuffled = [list[2], list[0], list[1]];
  assert.deepEqual(sortPromptSections(shuffled).map((s) => s.owner), ['beta', 'alpha', 'zeta']);
});

console.log('\n端到端：临时插件装进真宿主');

function writePlugin(root, id, files) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
  return dir;
}

await ok('装一个真插件：权限接线状态 / prompt 段 / action 工具 / before-media 全通', async () => {
  const root = path.join(DIR, 'ext-root');
  const pluginDir = path.join(root, 'plugins', 'demo');
  writePlugin(path.join(root, 'plugins'), 'demo', {
    'plugin.json': JSON.stringify({
      id: 'demo',
      name: '演示插件',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.mjs',
      permissions: ['storage', 'send_image'],
      prompt: { sections: [{ title: '演示边界', body: '这是插件声明的边界' }] },
    }, null, 2),
    'index.mjs': `
export function setup(api) {
  api.storage.set('booted', true);
  api.registerTool(api.actionTool({
    id: 'demo_admin',
    description: '演示：一个工具管两件事',
    actions: { status: '看状态', reset: '重置' },
    execute: async (ctx, args, action) => 'action=' + action,
  }));
}
export const hooks = {
  'before-media': async (p) => (String(p.source).includes('blocked') ? { block: true, reason: '演示插件拦了这张图' } : null),
};
`,
  });

  const prev = process.env.QQBOT_PLUGINS_DIR;
  process.env.QQBOT_PLUGINS_DIR = path.join(root, 'plugins');
  try {
    const registry = createToolRegistry();
    const bus = createHookBus({ log: noopLog });
    const host = createExtensionHost({
      root,
      registry,
      bus,
      storageDir: path.join(root, 'storage'),
      sendImage: async () => ({ message_id: 'm1' }),
      getCustom: () => ({ plugins: { enabled: ['demo'], settings: {} } }),
      log: noopLog,
    });
    await host.load();

    const snap = host.snapshot();
    const item = snap.items.find((i) => i.id === 'demo');
    assert.ok(item, '插件应被记录');
    assert.equal(item.state, 'loaded', `状态：${item.state} / ${item.detail}`);

    // ① 声明的两项权限都真的接上了
    assert.equal(item.capability.storage, 'wired');
    assert.equal(item.capability.send_image, 'wired');
    assert.equal(item.capability.web_fetch, 'undeclared');

    // ② prompt.sections 进了记录
    assert.deepEqual(item.promptSections.map((s) => s.title), ['演示边界']);

    // ③ action 工具被识别
    assert.deepEqual(item.actionTools, [{ tool: 'demo__demo_admin', actions: ['status', 'reset'] }]);
    assert.equal(registry.has('demo__demo_admin'), true);

    // ④ 存储真的落盘了（插件 setup 里写的）
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'storage', 'demo.json'), 'utf8'));
    assert.deepEqual(stored, { booted: true });

    // ⑤ 它的 before-media 钩子真的能拦住一次出站图片
    const { sender, onebot } = senderWith((payload) => bus.emit('before-media', payload));
    await assert.rejects(() => sender.sendImage('group:9', 'https://example.com/blocked.png'), /演示插件拦了这张图/);
    assert.equal(onebot.calls.length, 0);
    await sender.sendImage('group:9', 'https://example.com/fine.png');
    assert.equal(onebot.calls.length, 1, '不含 blocked 的照发');
  } finally {
    if (prev === undefined) delete process.env.QQBOT_PLUGINS_DIR;
    else process.env.QQBOT_PLUGINS_DIR = prev;
  }
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过'}`);
