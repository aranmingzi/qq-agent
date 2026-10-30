// 音频设备枚举 / 虚拟声卡判定的单元测试。
//
// 为什么这个测试存在：
// 「对方听不到它说话」是这条链路里最难自查的故障 —— 声音确实合成了、也确实播了，
// 只是播进了扬声器。所以服务端必须能自己回答"虚拟声卡装没装"，而且**只装了一半**
// 这种最常见的翻车要单独判出来（只装播放端 → QQ 里选不到麦克风）。
//
// 这些用例全部注入假 runner，不真的调 PowerShell：真机扫描留给 /api/call/devices，
// 单元测试要的是能在任何机器（含 CI、Linux）上稳定复现判定逻辑。

import {
  buildAudioDeviceScript,
  classifyEndpoint,
  parseAudioDevices,
  detectVirtualCable,
  listAudioDevices
} from '../src/audio-devices.js';

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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}：期望 ${e}，实际 ${a}`);
}

// 本机真实输出（2026-10-29 实测 Get-PnpDevice -Class AudioEndpoint 的结果，去掉无关字段）
const REAL_MACHINE = JSON.stringify({
  devices: [
    { name: '耳机 (BT Hands-Free)', status: 'OK', instanceId: 'BTHENUM\\{0.0.0.00000000}.{a}' },
    { name: '耳机 (BT)', status: 'OK', instanceId: 'BTHENUM\\{0.0.0.00000000}.{b}' },
    { name: '扬声器 (Realtek(R) Audio)', status: 'OK', instanceId: 'HDAUDIO\\{0.0.0.00000000}.{c}' },
    { name: '数字音频(HDMI) (HD Audio Driver for Display Audio)', status: 'Unknown', instanceId: 'HDAUDIO\\{0.0.0.00000000}.{d}' },
    { name: '麦克风阵列 (Realtek(R) Audio)', status: 'OK', instanceId: 'HDAUDIO\\{0.0.0.00000000}.{e}' }
  ],
  errors: []
});

const WITH_CABLE = JSON.stringify({
  devices: [
    { name: '扬声器 (Realtek(R) Audio)', status: 'OK', instanceId: 'x' },
    { name: 'CABLE Input (VB-Audio Virtual Cable)', status: 'OK', instanceId: 'y' },
    { name: 'CABLE Output (VB-Audio Virtual Cable)', status: 'OK', instanceId: 'z' },
    { name: '麦克风阵列 (Realtek(R) Audio)', status: 'OK', instanceId: 'w' }
  ],
  errors: []
});

console.log('[call-devices] 音频设备枚举');

await ok('脚本带上了 AudioEndpoint 类、UTF8 输出、普通数组容器', () => {
  const script = buildAudioDeviceScript();
  assert(script.includes('Get-PnpDevice'), '应查 PnP 设备');
  assert(script.includes('-Class AudioEndpoint'), '应只查音频端点（不是整块声卡）');
  assert(script.includes('[Console]::OutputEncoding'), '中文设备名必须靠 UTF8 才不变乱码');
  assert(script.includes("$out = @()"), '必须用普通数组：PS 5.1 解析不了元素是 object 的泛型 List');
  assert(script.includes('SilentlyContinue'), '非终止错误不能中断整段脚本');
  assert(script.includes('ConvertTo-Json'), '结果必须以 JSON 交回来');
});

await ok('CABLE Input 是播放端、CABLE Output 是录音端（VB-Cable 的命名是反的）', () => {
  // 这是最容易写反的一处：按字面「Input=输入设备」理解必错。
  // VB-Cable：我们往 CABLE Input 写（它是播放端点），QQ 从 CABLE Output 读（它是录音端点）。
  assertEqual(classifyEndpoint('CABLE Input (VB-Audio Virtual Cable)'), 'render', 'CABLE Input 是播放端');
  assertEqual(classifyEndpoint('CABLE Output (VB-Audio Virtual Cable)'), 'capture', 'CABLE Output 是录音端');
});

await ok('普通设备按方位词判定', () => {
  assertEqual(classifyEndpoint('扬声器 (Realtek(R) Audio)'), 'render', '扬声器');
  assertEqual(classifyEndpoint('麦克风阵列 (Realtek(R) Audio)'), 'capture', '麦克风阵列');
  assertEqual(classifyEndpoint('耳机 (BT)'), 'render', '耳机');
  assertEqual(classifyEndpoint('Speakers (USB Audio)'), 'render', '英文 Speakers');
  assertEqual(classifyEndpoint('Microphone (USB Audio)'), 'capture', '英文 Microphone');
  assertEqual(classifyEndpoint(''), 'unknown', '空名');
  assertEqual(classifyEndpoint('某个奇怪的东西'), 'unknown', '认不出来就 unknown，不许瞎猜');
});

await ok('本机真实输出能解析，且未就绪的 HDMI 不算可用', () => {
  const r = parseAudioDevices(REAL_MACHINE);
  assertEqual(r.ok, true, 'ok');
  assertEqual(r.all.length, 5, '全部设备都列出来（含未就绪的）');
  // 数字音频(HDMI) 是 Status=Unknown：插着电视才可用，算进"可用"会骗人
  assert(
    !r.render.some((d) => d.name.includes('HDMI')),
    `Unknown 状态的设备不该算可用，实际 render：${JSON.stringify(r.render.map((d) => d.name))}`
  );
  assert(r.render.length >= 3, '至少有耳机×2 + 扬声器');
  assertEqual(r.capture.length, 1, '只有一个麦克风');
  assertEqual(r.capture[0].name, '麦克风阵列 (Realtek(R) Audio)', '麦克风名字');
});

await ok('本机没有虚拟声卡 → absent，且给的是"要装驱动"这句人话', () => {
  const r = parseAudioDevices(REAL_MACHINE);
  const cable = detectVirtualCable({ render: r.render, capture: r.capture });
  assertEqual(cable.state, 'absent', 'state');
  assertEqual(cable.present, false, 'present');
  assert(cable.hint.includes('VB-Cable'), `应点名要装 VB-Cable，实际：${cable.hint}`);
});

await ok('两端都在 → present，并说出 QQ 里该选哪个麦克风', () => {
  const r = parseAudioDevices(WITH_CABLE);
  const cable = detectVirtualCable({ render: r.render, capture: r.capture });
  assertEqual(cable.state, 'present', 'state');
  assertEqual(cable.present, true, 'present');
  assert(cable.renderName.includes('CABLE Input'), `播放端名字：${cable.renderName}`);
  assert(cable.captureName.includes('CABLE Output'), `录音端名字：${cable.captureName}`);
  assert(cable.hint.includes('CABLE Output'), `应告诉用户 QQ 里选 CABLE Output，实际：${cable.hint}`);
});

await ok('只装播放端 → partial，并说明 QQ 里会选不到麦克风', () => {
  const cable = detectVirtualCable({
    render: [{ name: 'CABLE Input (VB-Audio Virtual Cable)', kind: 'render', status: 'OK' }],
    capture: [{ name: '麦克风阵列 (Realtek(R) Audio)', kind: 'capture', status: 'OK' }]
  });
  assertEqual(cable.state, 'partial', 'state');
  assertEqual(cable.present, false, 'present');
  assert(cable.hint.includes('麦克风'), `应点出 QQ 里选不到麦克风，实际：${cable.hint}`);
});

await ok('只装录音端 → partial，并说明声音没地方可写', () => {
  const cable = detectVirtualCable({
    render: [{ name: '扬声器 (Realtek(R) Audio)', kind: 'render', status: 'OK' }],
    capture: [{ name: 'CABLE Output (VB-Audio Virtual Cable)', kind: 'capture', status: 'OK' }]
  });
  assertEqual(cable.state, 'partial', 'state');
  assert(cable.hint.includes('没地方可写'), `实际：${cable.hint}`);
});

await ok('VoiceMeeter 也认（不只认 VB-Cable）', () => {
  const cable = detectVirtualCable({
    render: [{ name: 'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)', kind: 'render' }],
    capture: [{ name: 'VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)', kind: 'capture' }]
  });
  assertEqual(cable.present, true, 'VoiceMeeter 应该也算装了');
});

await ok('parseAudioDevices 收下单元素数组被 PowerShell 拆成对象的情况', () => {
  const r = parseAudioDevices(JSON.stringify({
    devices: { name: 'CABLE Input (VB-Audio Virtual Cable)', status: 'OK', instanceId: 'y' },
    errors: []
  }));
  assertEqual(r.all.length, 1, '单设备也要解析出来');
  assertEqual(r.render.length, 1, '且方向对');
});

await ok('空 stdout / 非法 JSON / PS 报错都给出可读原因，不抛', () => {
  const empty = parseAudioDevices('');
  assertEqual(empty.ok, false, '空输入 ok=false');
  assert(empty.errors[0].includes('没有返回结果'), `实际：${empty.errors[0]}`);

  const bad = parseAudioDevices('不是 json');
  assertEqual(bad.ok, false, '非法 JSON ok=false');
  assert(bad.errors[0].includes('不是合法 JSON'), `实际：${bad.errors[0]}`);

  const withErr = parseAudioDevices(JSON.stringify({ devices: [], errors: ['拒绝访问'] }));
  assertEqual(withErr.ok, false, 'PS 侧报错 → ok=false');
  assertEqual(withErr.errors, ['拒绝访问'], '错误原样透出');
});

await ok('listAudioDevices 用假 runner：正常路径', async () => {
  const r = await listAudioDevices({ runner: () => ({ status: 0, stdout: WITH_CABLE, stderr: '' }) });
  assertEqual(r.ok, true, 'ok');
  assertEqual(r.virtualCable.present, true, '应判定装了虚拟声卡');
});

await ok('listAudioDevices 用假 runner：spawnSync 的 error 变成可读原因', async () => {
  const r = await listAudioDevices({ runner: () => ({ error: new Error('ENOENT'), stdout: '', stderr: '' }) });
  assertEqual(r.ok, false, 'ok=false');
  assert(r.errors[0].includes('ENOENT'), `实际：${r.errors[0]}`);
  assertEqual(r.virtualCable.state, 'absent', '查不到就当没装');
});

await ok('listAudioDevices：空 stdout 不返回假成功（不拿 exit code 当判据）', async () => {
  const r = await listAudioDevices({ runner: () => ({ status: 0, stdout: '', stderr: '' }) });
  assertEqual(r.ok, false, 'exit 0 但没输出，不能算成功');
});

await ok('listAudioDevices：runner 抛异常也不炸', async () => {
  const r = await listAudioDevices({ runner: () => { throw new Error('被安全软件拦了'); } });
  assertEqual(r.ok, false, 'ok=false');
  assert(r.errors[0].includes('被安全软件拦了'), `实际：${r.errors[0]}`);
});

await ok('listAudioDevices：真机跑一次（Windows 上应真的枚举到设备）', async () => {
  if (process.platform !== 'win32') {
    const r = await listAudioDevices();
    assertEqual(r.ok, false, '非 Windows 应直接说不支持');
    assert(r.errors[0].includes('只支持 Windows'), `实际：${r.errors[0]}`);
    return;
  }
  const r = await listAudioDevices();
  assertEqual(r.ok, true, `真机枚举应成功，errors=${JSON.stringify(r.errors)}`);
  assert(r.all.length > 0, '本机至少有一个音频端点');
  assert(r.render.length > 0, '本机至少有一个播放端点');
  // 不断言 present：这台机器（以及大多数机器）本来就没装 VB-Cable，
  // 断言它装了才是错的。判定逻辑由上面的注入用例覆盖。
  assert(['present', 'partial', 'absent'].includes(r.virtualCable.state), 'state 必须是这三个之一');
});

console.log(`\n[call-devices] ${pass} 项通过${failures.length ? ` / ${failures.length} 项失败` : '，全部通过'}`);
process.exit(failures.length ? 1 : 0);
