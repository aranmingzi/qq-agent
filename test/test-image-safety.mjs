// 图片读取安全（2026-10-26 修的真漏洞）
//
// 起因：`file` 字段来自**消息内容**，是外部可控的。旧的 `mediaImageDataUrls` 是
// 「只要是存在的绝对路径就读出来」，再被 `detectMime() || 'image/jpeg'` 兜底成图片
// 上传给视觉供应商 —— 也就是说，一条把 file 写成 `data/config.json` 的消息，
// 就能把本机所有 API Key 原样发给第三方。
//
// 两道闸：
//   ① 扩展名（NapCat 自己 get_image 返回的路径常无扩展名，可豁免）
//   ② 魔数必须真命中 png/jpeg/gif/webp，本地文件**不允许**兜底
//
// ⚠️ 为什么必须拦**出站请求**来验：
//    工具拿到字节后还要经过视觉 API 才发出去。不配 key 时压根发不出去，
//    于是"有没有闸"的返回结果一模一样 —— 只看返回值会得到假绿（实测过）。
//    所以这里起一个假视觉服务，把**发出去的每一个字节**都记下来。
//
// 用法：node test/test-image-safety.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-imgsafe-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 假视觉服务：记录所有出站请求体
const seen = [];
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    seen.push(b);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '（mock 识图结果）' } }] }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

const { updateConfig } = await import('../src/config.js');
updateConfig({
  vision: { mode: 'qwen', qwen: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-vl' } }
});

const { buildToolDefs } = await import('../src/tools.js');

const pass = [];
async function aok(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name} — ${error?.message ?? error}`); process.exitCode = 1; }
}

const SECRET_MARK = 'sk-TOP-SECRET-SHOULD-NEVER-BE-SENT-OUT';
const secretFile = path.join(tmp, 'config.json');
fs.writeFileSync(secretFile, JSON.stringify({ providers: [{ apiKey: SECRET_MARK }] }, null, 2), 'utf8');

const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/1QAAAABJRU5ErkJggg==';
const noExtImage = path.join(tmp, 'cachename-without-ext');
fs.writeFileSync(noExtImage, Buffer.from(pngB64, 'base64'));

const tool = buildToolDefs().find((t) => t.name === 'get_message_images');

// ⚠️ onebot 必须有：本地路径分支被包在 `if (fileRef && ctx?.onebot)` 里，
// 传 undefined 的话压根走不到读取逻辑 —— 测试会变成"因为没读所以没泄漏"的假绿。
const runTool = async (media, onebot = { call: async () => ({}) }) => {
  const ctx = { chatKey: 'group:1', onebot, store: { findByMid: () => ({ media }) } };
  try { return { ok: true, value: await tool.execute(ctx, { messageId: 1 }) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
};

console.log('\n[image-safety]');

// ⚠️ 判据用「有没有出站请求」，不是「出站内容里有没有密钥明文」：
// 图片是 **base64** 之后才发出去的，`includes('sk-...')` 永远查不到 ——
// 实测过：拆掉闸之后请求体里确实带着它，但明文匹配是绿的，于是测试假绿。
// 「有闸 = 0 个出站请求 / 无闸 = 1 个」这个判据既精确，又和 ④（正常图必须有出站）
// 正好互补：一边防闸太松，一边防闸太严。
await aok('① 指向密钥文件的路径：一个字节都不许发出去', async () => {
  seen.length = 0;
  const r = await runTool([{ kind: 'image', file: secretFile, url: '' }]);
  assert.strictEqual(seen.length, 0,
    `⚠️ 密钥文件被当成图片读出并发给了视觉服务（${seen.length} 个出站请求）。返回：${JSON.stringify(r).slice(0, 160)}`);
});

await aok('② 伪装成 .jpg 的非图片文件：魔数不认就拒绝', async () => {
  const fake = path.join(tmp, 'fake.jpg');
  fs.writeFileSync(fake, JSON.stringify({ apiKey: SECRET_MARK }), 'utf8');
  seen.length = 0;
  await runTool([{ kind: 'image', file: fake, url: '' }]);
  assert.strictEqual(seen.length, 0, '扩展名是 .jpg 就放行了（魔数没验）');
});

await aok('③ 真图片（NapCat 缓存，无扩展名）仍然读得出来 —— 别把闸修成误伤', async () => {
  seen.length = 0;
  const r = await runTool(
    [{ kind: 'image', file: 'whatever', url: '' }],
    { call: async () => ({ file: noExtImage }) }      // 走 get_image 分支：免检扩展名
  );
  assert.ok(!r.ok || r.value, '工具调用异常');
  const sent = seen.some((b) => b.includes('image/png') || b.includes(pngB64.slice(0, 24)));
  assert.ok(sent, `无扩展名的真图片被误拒了（出站 ${seen.length} 个请求里没有图片数据）`);
});

await aok('④ 反向验真：普通图片消息照样能走通（闸没把正常功能挡死）', async () => {
  seen.length = 0;
  const jpg = path.join(tmp, 'normal.jpg');
  fs.writeFileSync(jpg, Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA==', 'base64'));
  const r = await runTool([{ kind: 'image', file: jpg, url: '' }]);
  assert.ok(seen.length > 0, '正常图片也没发出去 —— 闸太严会误伤日常看图');
  void r;
});

mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (!process.exitCode) console.log(`\n[image-safety] ${pass.length} 项全过`);
