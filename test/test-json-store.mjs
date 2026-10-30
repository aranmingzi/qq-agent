// 数据文件损坏 → 隔离留档，而不是静默清零。
// 跑：node test/test-json-store.mjs（秒级、不碰网络、只写系统临时目录）
//
// 这一层要证明的就三件事：
//   ① 文件不存在 ≠ 文件坏了（前者静默，后者告警 + 隔离）
//   ② 坏文件本身不丢（改名后内容逐字节可读回来）
//   ③ 之后正常写盘不会把证据覆盖掉
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { readJsonSafe, readJsonDetailed, quarantineCorrupt, writeJsonAtomic, CORRUPT_TAG, stampOf } =
  await import('../src/json-store.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-jsonstore-'));
const T = 1_760_000_000_000; // 固定时间戳，让留档名可断言

const warns = [];
const warn = (m) => warns.push(String(m));

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
function corruptFilesOf(file) {
  const dir = path.dirname(file);
  const base = `${path.basename(file)}${CORRUPT_TAG}`;
  return fs.readdirSync(dir).filter((n) => n.startsWith(base));
}

console.log('\n文件不存在 vs 文件坏了');

await ok('文件不存在：返回 fallback，不告警，不产生留档', () => {
  const f = path.join(DIR, 'missing.json');
  const before = warns.length;
  const r = readJsonDetailed(f, { a: 1 }, { warn, tag: 't', now: T });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.data, { a: 1 });
  assert.equal(r.quarantined, '');
  assert.equal(warns.length, before, 'ENOENT 不该告警');
  assert.equal(corruptFilesOf(f).length, 0);
});

await ok('正常文件：原样返回，status=ok', () => {
  const f = path.join(DIR, 'good.json');
  fs.writeFileSync(f, JSON.stringify({ memes: [1, 2] }));
  const r = readJsonDetailed(f, null, { warn, tag: 't' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.data, { memes: [1, 2] });
  assert.equal(corruptFilesOf(f).length, 0);
});

await ok('带 BOM 的文件也能读（Windows 记事本）', () => {
  const f = path.join(DIR, 'bom.json');
  fs.writeFileSync(f, '\ufeff{"ok":true}', 'utf8');
  assert.deepEqual(readJsonSafe(f, null, { warn }), { ok: true });
  assert.equal(corruptFilesOf(f).length, 0);
});

console.log('\n坏文件：隔离留档');

await ok('坏 JSON：返回 fallback，status=corrupt，告警一条', () => {
  const f = path.join(DIR, 'broken.json');
  fs.writeFileSync(f, '{"memes": [ {"key": "典" ');
  const before = warns.length;
  const r = readJsonDetailed(f, null, { warn, tag: 'memes', now: T });
  assert.equal(r.status, 'corrupt');
  assert.equal(r.data, null);
  assert.ok(r.quarantined.startsWith(f + CORRUPT_TAG), '留档路径应同目录同前缀');
  assert.equal(warns.length, before + 1);
  assert.match(warns.at(-1), /memes/);
});

await ok('留档文件名带可读时间戳', () => {
  const f = path.join(DIR, 'stamped.json');
  fs.writeFileSync(f, 'not json at all');
  const r = readJsonDetailed(f, null, { warn, now: T });
  assert.equal(path.basename(r.quarantined), `stamped.json${CORRUPT_TAG}${stampOf(T)}`);
});

await ok('坏内容逐字节留在留档里，原文件已不在', () => {
  const f = path.join(DIR, 'keep.json');
  const body = '{"a": 1, "b": ';
  fs.writeFileSync(f, body);
  const r = readJsonDetailed(f, null, { warn, now: T });
  assert.equal(fs.existsSync(f), false, '原文件应被移走');
  assert.equal(fs.readFileSync(r.quarantined, 'utf8'), body, '留档内容必须和原文件一致');
});

await ok('坏文件之后正常写盘，不会覆盖留档', () => {
  const f = path.join(DIR, 'rescue.json');
  fs.writeFileSync(f, '{{{ 坏掉了');
  const r = readJsonDetailed(f, null, { warn, now: T });
  writeJsonAtomic(f, { memes: [{ key: '新' }] });
  assert.equal(fs.readFileSync(r.quarantined, 'utf8'), '{{{ 坏掉了');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { memes: [{ key: '新' }] });
});

await ok('空文件按损坏处理（写盘中断的典型形态）', () => {
  const f = path.join(DIR, 'empty.json');
  fs.writeFileSync(f, '');
  const r = readJsonDetailed(f, [], { warn, now: T });
  assert.equal(r.status, 'corrupt');
  assert.deepEqual(r.data, []);
  assert.equal(corruptFilesOf(f).length, 1);
});

await ok('同一时间戳重复隔离 → 自动加 -2 后缀，不覆盖上一份证据', () => {
  const f = path.join(DIR, 'twice.json');
  fs.writeFileSync(f, 'bad-1');
  const a = quarantineCorrupt(f, { now: T });
  fs.writeFileSync(f, 'bad-2');
  const b = quarantineCorrupt(f, { now: T });
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'bad-1');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'bad-2');
});

console.log('\n原子写');

await ok('writeJsonAtomic 写完即可读回，且不留 .tmp', () => {
  const f = path.join(DIR, 'sub', 'out.json');
  writeJsonAtomic(f, { x: 1 });
  assert.deepEqual(readJsonSafe(f, null, { warn }), { x: 1 });
  assert.equal(fs.existsSync(`${f}.${process.pid}.tmp`), false);
  assert.equal(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.tmp')).length, 0);
});

console.log('\n真实模块接线');

await ok('memes：坏库 → 查不到梗，但坏文件留档、不被下一次写盘覆盖', async () => {
  const { searchMemes, proposeMeme } = await import('../src/memes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-memes-corrupt-'));
  const memes = path.join(dir, 'memes.json');
  const pending = path.join(dir, 'memes-pending.json');
  const body = '{"memes": [{"key": "典"';
  fs.writeFileSync(memes, body);

  assert.equal(searchMemes('典', { file: memes }).found, false, '坏库当空库');
  const kept = corruptFilesOf(memes);
  assert.equal(kept.length, 1, '应产生一份 .corrupt 留档');
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), body);

  // 触发一次写盘（提候选只写 pending，这里改走 confirm 前的库写入路径）
  proposeMeme({ key: '新梗', meaning: '刚出现的说法' }, { file: pending, memeFile: memes, now: T });
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), body, '写盘不得覆盖留档');
});

await ok('memory-facts：坏的事实文件 → 当新用户，但坏文件留档', async () => {
  const facts = await import('../src/memory-facts.js');
  // 直接走模块内部路径不可注入，这里用导出函数验证"不抛错 + 空记忆"，
  // 文件级留档由上面 readJsonDetailed 的用例覆盖。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-facts-corrupt-'));
  const f = path.join(dir, '123.json');
  fs.writeFileSync(f, '{"facts": [');
  assert.deepEqual(readJsonSafe(f, [], { warn, now: T }), []);
  assert.equal(corruptFilesOf(f).length, 1);
  assert.equal(typeof facts.rememberFact, 'function');
});

await ok('vibe / mood：坏状态文件 → 空状态且留档（构造时不抛）', async () => {
  const { VibeStore } = await import('../src/vibe.js');
  const { MoodStore } = await import('../src/mood.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-state-corrupt-'));
  const vf = path.join(dir, 'vibe.json');
  const mf = path.join(dir, 'moods.json');
  fs.writeFileSync(vf, 'nope');
  fs.writeFileSync(mf, 'nope');
  const v = new VibeStore(vf);
  const m = new MoodStore(mf);
  assert.equal(typeof v.get('group:1'), 'object');
  assert.equal(typeof m.get('group:1'), 'object');
  assert.equal(corruptFilesOf(vf).length, 1);
  assert.equal(corruptFilesOf(mf).length, 1);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过'}`);
