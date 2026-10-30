// 「嘴」的纯逻辑测试：从浏览器设备列表里挑虚拟声卡。
//
// 为什么用 node 直接跑 TS 而不是起浏览器：
// Node 24 自带类型剥离（type stripping），`console/src/lib/call-output.ts` 里全是
// 纯函数、没有 import 任何浏览器 API，所以可以直接 import 来断言。
// 这条链路的坑（label 为空、'default' 别名、只装一半的虚拟声卡）全是**数据形状**问题，
// 用真浏览器测反而更慢更不稳。
//
// 跑法：node test/test-call-output.mjs

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(path.join(root, 'console/src/lib/call-output.ts')).href);
const { pickOutputDevice, describeMouth, isAudioOutput, toOutputDevices, matchByLabel } = mod;

let pass = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

// ── pickOutputDevice ────────────────────────────────────────────────

await ok('默认 hint 能认出 CABLE Input', () => {
  const r = pickOutputDevice([
    { deviceId: 'a', label: '扬声器 (Realtek(R) Audio)' },
    { deviceId: 'b', label: 'CABLE Input (VB-Audio Virtual Cable)' },
  ]);
  assert.equal(r.device?.deviceId, 'b');
  assert.equal(r.fellBackToDefault, false);
  assert.match(r.reason, /CABLE Input/);
});

await ok('hint 优先于内置猜测（用户可能装的是 VoiceMeeter 或改过名）', () => {
  const r = pickOutputDevice(
    [
      { deviceId: 'a', label: 'CABLE Input (VB-Audio Virtual Cable)' },
      { deviceId: 'b', label: 'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)' },
    ],
    'VoiceMeeter Input',
  );
  assert.equal(r.device?.deviceId, 'b');
});

await ok('hint 没命中时退到内置猜测，并说明原因', () => {
  const r = pickOutputDevice([{ deviceId: 'a', label: 'VoiceMeeter Aux Input (VB-Audio)' }], 'CABLE Input');
  assert.equal(r.device?.deviceId, 'a');
  // 这里**不能**再说"没找到名字含 X 的设备"：在真浏览器里 hint 命不中是常态
  // （Chromium 给的 label 是端点友好名「扬声器 (VB-Audio Virtual Cable)」，
  // 里面根本没有 "CABLE Input"），说成失败会让人以为哪儿坏了。
  assert.match(r.reason, /按内置规则认出来的/);
  assert.match(r.reason, /VoiceMeeter/);
  assert.equal(r.fellBackToDefault, false);
});

await ok('真浏览器里的端点友好名（没有 "CABLE Input" 字样）也能认出来', () => {
  // 实测这台机器上 Chromium 给的 label 就是这个 —— 不是 MME 名。
  const r = pickOutputDevice([
    { deviceId: 'a', label: '扬声器 (Realtek(R) Audio)' },
    { deviceId: 'b', label: '扬声器 (VB-Audio Virtual Cable)' },
  ]);
  assert.equal(r.device?.deviceId, 'b');
  assert.equal(r.fellBackToDefault, false);
});

await ok('16 通道变体排在普通端点后面（上混会让声音变形，且用户分不清）', () => {
  // 装了 VB-Cable 的机器上这两个端点同时存在，枚举顺序不保证。
  // ⚠️ 必须用 hint **命不中** 的名字来测：只要列表里有 "CABLE Input" 字样，
  // 前面那条 hint 分支就先命中了，根本走不到这里的排序逻辑。
  // Chromium 在 Windows 上给的正是端点友好名，两种都不含 "CABLE Input"。
  const r = pickOutputDevice([
    { deviceId: 'sixteen', label: 'CABLE In 16 Ch (VB-Audio Virtual Cable)' },
    { deviceId: 'normal', label: '扬声器 (VB-Audio Virtual Cable)' },
  ]);
  assert.equal(r.device?.deviceId, 'normal');
});

await ok('16 通道变体的负分真的生效（去掉它就会选错）', () => {
  // 这条是上一条的加固：枚举顺序反过来也一样，靠的是打分不是顺序。
  const r = pickOutputDevice([
    { deviceId: 'normal', label: '扬声器 (VB-Audio Virtual Cable)' },
    { deviceId: 'sixteen', label: 'CABLE In 16 Ch (VB-Audio Virtual Cable)' },
  ]);
  assert.equal(r.device?.deviceId, 'normal');
});

await ok('只有 16 通道变体时仍然用它，不回落默认设备', () => {
  const r = pickOutputDevice([{ deviceId: 'sixteen', label: 'CABLE In 16 Ch (VB-Audio Virtual Cable)' }]);
  assert.equal(r.device?.deviceId, 'sixteen');
  assert.equal(r.fellBackToDefault, false);
});

await ok('大小写不敏感（设备名常是 CABLE Input / cable input 混着）', () => {
  const r = pickOutputDevice([{ deviceId: 'a', label: 'cable input (vb-audio)' }]);
  assert.equal(r.device?.deviceId, 'a');
});

await ok("'default' 与 'communications' 两个别名不算候选", () => {
  const r = pickOutputDevice([
    { deviceId: 'default', label: 'CABLE Input' },
    { deviceId: 'communications', label: 'CABLE Input' },
  ]);
  assert.equal(r.device, null);
  assert.equal(r.fellBackToDefault, true);
});

await ok('label 全为空时说"要先授权"，而不是让人去装驱动', () => {
  const r = pickOutputDevice([
    { deviceId: 'a', label: '' },
    { deviceId: 'b', label: '' },
  ]);
  assert.equal(r.device, null);
  assert.equal(r.fellBackToDefault, true);
  assert.match(r.reason, /拿到麦克风权限之前不给标签/);
});

await ok('一个设备都没有时说清楚', () => {
  const r = pickOutputDevice([]);
  assert.equal(r.device, null);
  assert.match(r.reason, /一个播放设备都没枚举到/);
});

await ok('没装虚拟声卡时明确说"对方听不见"', () => {
  const r = pickOutputDevice([{ deviceId: 'a', label: '扬声器 (Realtek(R) Audio)' }]);
  assert.equal(r.device, null);
  assert.equal(r.fellBackToDefault, true);
  assert.match(r.reason, /对方听不见/);
  // candidates 要完整保留，面板才能列出来手动选
  assert.equal(r.candidates.length, 1);
});

await ok('入参不是数组也不崩（防御）', () => {
  assert.equal(pickOutputDevice(null).device, null);
  assert.equal(pickOutputDevice(undefined).device, null);
  assert.equal(pickOutputDevice('x').device, null);
});

await ok('deviceId 为空的条目被丢掉', () => {
  const r = pickOutputDevice([{ deviceId: '', label: 'CABLE Input' }]);
  assert.equal(r.device, null);
});

// ── describeMouth ───────────────────────────────────────────────────

await ok('不支持 setSinkId 时说清是浏览器的问题', () => {
  const text = describeMouth({ supported: false, picked: null });
  assert.match(text, /不支持切换播放设备/);
  assert.match(text, /对方听不到/);
});

await ok('还没读设备列表时不假装有结论', () => {
  assert.match(describeMouth({ supported: true, picked: null }), /还没读设备列表/);
});

await ok('选中了就把设备名说出来', () => {
  const picked = pickOutputDevice([{ deviceId: 'a', label: 'CABLE Input (VB-Audio)' }]);
  assert.match(describeMouth({ supported: true, picked }), /CABLE Input/);
});

// ── isAudioOutput / toOutputDevices ─────────────────────────────────

await ok('kind 判定大小写不敏感', () => {
  assert.equal(isAudioOutput({ kind: 'audiooutput' }), true);
  assert.equal(isAudioOutput({ kind: 'AudioOutput' }), true);
  assert.equal(isAudioOutput({ kind: 'audioinput' }), false);
  assert.equal(isAudioOutput({}), false);
  assert.equal(isAudioOutput(null), false);
});

await ok('toOutputDevices 只留播放设备且丢掉空 id', () => {
  const list = toOutputDevices([
    { kind: 'audioinput', deviceId: 'm', label: '麦克风' },
    { kind: 'audiooutput', deviceId: 's', label: '扬声器' },
    { kind: 'audiooutput', deviceId: '', label: '空 id' },
    { kind: 'videoinput', deviceId: 'c', label: '摄像头' },
  ]);
  assert.deepEqual(list, [{ deviceId: 's', label: '扬声器' }]);
});

await ok('toOutputDevices 入参不是数组返回空数组', () => {
  assert.deepEqual(toOutputDevices(null), []);
  assert.deepEqual(toOutputDevices(undefined), []);
});

// ── matchByLabel ────────────────────────────────────────────────────

await ok('matchByLabel：标签精确命中', () => {
  const hit = matchByLabel(
    [
      { deviceId: 'a', label: '扬声器 (Realtek(R) Audio)' },
      { deviceId: 'b', label: 'CABLE Input (VB-Audio Virtual Cable)' },
    ],
    'CABLE Input (VB-Audio Virtual Cable)',
  );
  assert.equal(hit?.deviceId, 'b');
});

await ok('matchByLabel：驱动改版导致标签变了，靠包含也能认回来', () => {
  // 存的是 "CABLE Input (VB-Audio Virtual Cable)"，驱动升级后变成 "CABLE Input (VB-Audio Virtual Cable) (2)"
  const hit = matchByLabel([{ deviceId: 'b', label: 'CABLE Input (VB-Audio Virtual Cable) (2)' }], 'CABLE Input (VB-Audio Virtual Cable)');
  assert.equal(hit?.deviceId, 'b');
});

await ok('matchByLabel：认不回来就返回 null（不许悄悄回落默认设备）', () => {
  const hit = matchByLabel([{ deviceId: 'a', label: '扬声器 (Realtek(R) Audio)' }], 'CABLE Input (VB-Audio)');
  assert.equal(hit, null);
});

await ok('matchByLabel：空标签返回 null', () => {
  assert.equal(matchByLabel([{ deviceId: 'a', label: 'x' }], ''), null);
  assert.equal(matchByLabel([{ deviceId: 'a', label: 'x' }], '   '), null);
  assert.equal(matchByLabel(null, 'x'), null);
});

await ok('matchByLabel：deviceId 为空的条目不会被选中', () => {
  assert.equal(matchByLabel([{ deviceId: '', label: 'CABLE Input' }], 'CABLE Input'), null);
});

// ── 汇总 ────────────────────────────────────────────────────────────

if (failures.length) {
  console.log(`\n[call-output] ${pass} 项通过，${failures.length} 项失败`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error?.message ?? f.error}`);
  process.exit(1);
}
console.log(`\n[call-output] ${pass} 项通过，全部通过`);
