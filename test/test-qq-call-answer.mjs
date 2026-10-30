// 自动接听（src/qq-call-answer.js）的行为测试
//
// 纪律：这里**不测源码文本**。`assert.match(src, /authorize/)` 这种断言在把整段逻辑
// 删掉之后照样绿 —— 上一轮的教训。凡是能注入的一律注入（scan / answer / runner / isEnabled），
// 所以本文件不启动 PowerShell、不依赖 Windows、不需要来电。
import {
  DEFAULT_WINDOW_PATTERN,
  DEFAULT_ANSWER_PATTERN,
  DEFAULT_REJECT_PATTERN,
  buildCallScanScript,
  parseCallScan,
  rankCallButton,
  looksLikeCallButton,
  CALL_BUTTON_MAX_CHARS,
  decideAnswer,
  scanCallWindows,
  invokeAnswer,
  createCallWatcher
} from '../src/qq-call-answer.js';

let pass = 0;
let fail = 0;

async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`✗ ${name}\n    ${error?.message ?? error}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || '不相等'}\n      实际: ${a}\n      期望: ${e}`);
}

/** 造一份窗口树 fixture。 */
function win(pid, title, buttonNames, { cls = 'Chrome_WidgetWin_1' } = {}) {
  return {
    pid,
    title,
    cls,
    buttons: buttonNames.map((n) => (typeof n === 'string' ? { name: n, enabled: true, automationId: '' } : n))
  };
}

/** 假 runner：按顺序返回预设结果，并记录被调用的脚本。 */
function fakeRunner(...results) {
  const calls = [];
  const runner = (script) => {
    calls.push(script);
    const next = results.length > 1 ? results.shift() : results[0];
    return typeof next === 'function' ? next(script) : next;
  };
  runner.calls = calls;
  return runner;
}

const jsonResult = (obj) => ({ status: 0, stdout: JSON.stringify(obj), stderr: '', error: null });

// ── 1. 常量 ─────────────────────────────────────────────────────────────
await ok('默认常量是文档里写的那些值', () => {
  assertEqual(DEFAULT_WINDOW_PATTERN, '通话');
  assertEqual(DEFAULT_ANSWER_PATTERN, '接听|接受|接起');
  assertEqual(DEFAULT_REJECT_PATTERN, '挂断|拒绝|关闭');
});

// ── 2. buildCallScanScript ──────────────────────────────────────────────
await ok('扫描脚本带上 UIA 程序集、UTF8 输出、普通数组容器', () => {
  const script = buildCallScanScript({});
  assert(script.includes('UIAutomationClient'), '缺少 UIAutomationClient');
  assert(script.includes('UIAutomationTypes'), '缺少 UIAutomationTypes');
  // 中文窗口标题/按钮名必须走 UTF8，否则 Node 按 utf8 解 GBK 会乱码、JSON.parse 直接抛
  assert(script.includes('[Console]::OutputEncoding'), '缺少 UTF8 输出编码设置');
  // PowerShell 5.1 解析不了"元素是 object 的泛型 List"，会 exit 1 且无 stderr
  assert(script.includes('$out = @()'), '缺少普通数组容器');
  assert(script.includes("$ErrorActionPreference = 'SilentlyContinue'"), '缺少 SilentlyContinue');
  assert(script.includes('ConvertTo-Json'), '缺少 JSON 输出');
});

await ok('扫描脚本默认只钻标题匹配「通话」的窗口', () => {
  const script = buildCallScanScript({});
  assert(script.includes('-match') && script.includes('通话'), '默认没有标题过滤');
  const all = buildCallScanScript({ includeAll: true });
  assert(!all.includes('-match'), 'includeAll 时不该再有标题过滤');
});

await ok('窗口标题里的单引号不会破坏 PowerShell 语法', () => {
  const script = buildCallScanScript({ windowPattern: "it's a 通话" });
  assert(script.includes("it''s a 通话"), '单引号没有被转义成两个');
});

// ── 3. parseCallScan ───────────────────────────────────────────────────
await ok('parseCallScan 解析正常结构', () => {
  const r = parseCallScan(JSON.stringify({
    windows: [win(14616, '和某某的通话', ['接听', '挂断'])],
    errors: []
  }));
  assertEqual(r.ok, true);
  assertEqual(r.windows.length, 1);
  assertEqual(r.windows[0].pid, 14616);
  assertEqual(r.windows[0].title, '和某某的通话');
  assertEqual(r.windows[0].buttons.map((b) => b.name), ['接听', '挂断']);
  assertEqual(r.errors, []);
});

await ok('parseCallScan 收下单元素数组被 PowerShell 拆成对象的情况', () => {
  // PS 5.1 的 ConvertTo-Json 对单元素数组会输出成对象而不是数组
  const r = parseCallScan(JSON.stringify({
    windows: { pid: 1, title: '通话', cls: 'X', buttons: { name: '接听', enabled: true } },
    errors: []
  }));
  assertEqual(r.windows.length, 1);
  assertEqual(r.windows[0].buttons.length, 1);
  assertEqual(r.windows[0].buttons[0].name, '接听');
});

await ok('parseCallScan 丢掉没有名字的按钮，但保留 enabled=false 的', () => {
  const r = parseCallScan(JSON.stringify({
    windows: [win(1, '通话', [{ name: '', enabled: true }, { name: '接听', enabled: false }])],
    errors: []
  }));
  assertEqual(r.windows[0].buttons.length, 1);
  assertEqual(r.windows[0].buttons[0].name, '接听');
  assertEqual(r.windows[0].buttons[0].enabled, false);
});

await ok('parseCallScan 空输入 / 非法 JSON 不抛，给出可读原因', () => {
  const empty = parseCallScan('');
  assertEqual(empty.ok, false);
  assert(empty.errors[0].includes('没有返回结果'), `原因不对：${empty.errors[0]}`);

  const bad = parseCallScan('not json at all');
  assertEqual(bad.ok, false);
  assert(bad.errors[0].includes('不是合法 JSON'), `原因不对：${bad.errors[0]}`);

  assertEqual(parseCallScan(null).ok, false);
  assertEqual(parseCallScan(undefined).ok, false);
});

await ok('parseCallScan 把 PowerShell 侧的 errors 透出来，并因此 ok=false', () => {
  const r = parseCallScan(JSON.stringify({ windows: [], errors: ['UIA 挂了'] }));
  assertEqual(r.ok, false);
  assertEqual(r.errors, ['UIA 挂了']);
});

// ── 4. rankCallButton ──────────────────────────────────────────────────
await ok('rankCallButton 视频 3 / 精确接听 2 / 其他 1', () => {
  assertEqual(rankCallButton('视频接听'), 3);
  assertEqual(rankCallButton('接听'), 2);
  assertEqual(rankCallButton('接受'), 2);
  assertEqual(rankCallButton('接起'), 2);
  assertEqual(rankCallButton('接听语音'), 1);
  assertEqual(rankCallButton('挂断'), 1);
  assertEqual(rankCallButton(''), 1);
});

// ── 5. decideAnswer ────────────────────────────────────────────────────
await ok('没有窗口 → none', () => {
  const d = decideAnswer({ windows: [] });
  assertEqual(d.action, 'none');
  assertEqual(d.target, null);
  assertEqual(d.candidates, 0);
  assert(d.reason.includes('没有找到'), `原因不对：${d.reason}`);
});

await ok('只有「挂断」→ none（绝不能把挂断当接听）', () => {
  const d = decideAnswer({ windows: [win(1, '通话', ['挂断', '拒绝', '关闭'])] });
  assertEqual(d.action, 'none');
  assertEqual(d.target, null);
});

await ok('一个名字同时匹配接听和挂断时，挂断优先（reject 先判）', () => {
  // 默认两套正则不重叠（「挂断」本身就不匹配「接听」），所以这条守卫平时是冗余的。
  // 但用户可以改 answerPattern —— 一旦改宽（比如把「关闭」也写进接听），
  // 就必须保证「挂断类永远不算接听」这条铁律还在。这里把顺序锁死。
  const d = decideAnswer({
    windows: [win(1, '通话', ['关闭'])],
    answerPattern: '接听|关闭',
    rejectPattern: '挂断|拒绝|关闭'
  });
  assertEqual(d.action, 'none', '同时匹配时必须判挂断，不能接');
  assertEqual(d.target, null);
});

await ok('「接听」→ answer，target 带 pid/title/name', () => {
  const d = decideAnswer({ windows: [win(7, '和甲的通话', ['挂断', '接听'])] });
  assertEqual(d.action, 'answer');
  assertEqual(d.target, { pid: 7, title: '和甲的通话', name: '接听' });
  assertEqual(d.matchedName, '接听');
});

await ok('「视频接听」+ preferVideo → video-answer', () => {
  const d = decideAnswer({ windows: [win(7, '通话', ['视频接听', '挂断'])], preferVideo: true });
  assertEqual(d.action, 'video-answer');
  assertEqual(d.matchedName, '视频接听');
});

await ok('只有「视频接听」且 preferVideo=false → none，并说明会开摄像头', () => {
  const d = decideAnswer({ windows: [win(7, '通话', ['视频接听', '挂断'])], preferVideo: false });
  assertEqual(d.action, 'none');
  assert(d.reason.includes('摄像头'), `原因没提摄像头：${d.reason}`);
});

await ok('语音接听和视频接听同时存在、preferVideo=false → 选语音', () => {
  const d = decideAnswer({ windows: [win(7, '通话', ['视频接听', '接听'])], preferVideo: false });
  assertEqual(d.action, 'answer');
  assertEqual(d.matchedName, '接听');
});

await ok('同时存在、preferVideo=true → 选视频', () => {
  const d = decideAnswer({ windows: [win(7, '通话', ['接听', '视频接听'])], preferVideo: true });
  assertEqual(d.action, 'video-answer');
  assertEqual(d.matchedName, '视频接听');
});

await ok('多个候选按 rank 取最高（不按数组顺序）', () => {
  const d = decideAnswer({ windows: [win(7, '通话', ['接听', '视频接听'])], preferVideo: true });
  assertEqual(d.matchedName, '视频接听');
  const d2 = decideAnswer({ windows: [win(7, '通话', ['接听', '接听语音'])], preferVideo: false });
  assertEqual(d2.matchedName, '接听', '精确匹配应该压过「接听语音」');
});

await ok('enabled=false 的按钮不点（Invoke 会抛）', () => {
  const d = decideAnswer({
    windows: [win(7, '通话', [{ name: '接听', enabled: false }])]
  });
  assertEqual(d.action, 'none');
});

await ok('pid 无效的窗口跳过', () => {
  const d = decideAnswer({ windows: [win(0, '通话', ['接听']), win(-3, '通话', ['接听'])] });
  assertEqual(d.action, 'none');
});

await ok('跨多个窗口时取第一个有接听按钮的', () => {
  const d = decideAnswer({
    windows: [win(1, '无按钮窗口', []), win(2, '通话', ['接听'])]
  });
  assertEqual(d.action, 'answer');
  assertEqual(d.target.pid, 2);
});

await ok('非法正则 → none 且说明是哪个 pattern 坏了（不静默、不退化成全匹配）', () => {
  const d = decideAnswer({ windows: [win(1, '通话', ['接听'])], answerPattern: '接听(' });
  assertEqual(d.action, 'none');
  assert(d.reason.includes('answerPattern'), `没指出哪个坏了：${d.reason}`);

  const d2 = decideAnswer({ windows: [win(1, '通话', ['接听'])], rejectPattern: '[[' });
  assertEqual(d2.action, 'none');
  assert(d2.reason.includes('rejectPattern'), `没指出哪个坏了：${d2.reason}`);
});

await ok('三道闸各自独立生效（只删一条也要能被测出来）', () => {
  // 长标题按钮会同时被「长度 / 冒号 / 黑名单」三条命中，
  // 所以只测它的话，删掉任意单条闸门测试仍然是绿的 —— 那是假通过。
  // 这里给每道闸一个只踩它的用例：
  // ① 只踩长度：短、无冒号、无黑名单词，但就是太长
  const onlyLength = '接听电话并把这个通话转给另一个人处理';
  assertEqual(onlyLength.length > CALL_BUTTON_MAX_CHARS, true, '这个用例要真的超长');
  assertEqual(/[：:]/.test(onlyLength), false, '不能含冒号');
  assertEqual(/设置|自动|开关|说明|计划|教程|帮助/.test(onlyLength), false, '不能命中黑名单');
  assertEqual(looksLikeCallButton(onlyLength), false, '长度闸要独立拦住它');

  // ② 只踩冒号：很短，但带冒号
  const onlyColon = '接听：语音';
  assertEqual(onlyColon.length <= CALL_BUTTON_MAX_CHARS, true);
  assertEqual(looksLikeCallButton(onlyColon), false, '冒号闸要独立拦住它');

  // ③ 只踩黑名单：短、无冒号，含「自动」
  const onlyBlacklist = '自动接听';
  assertEqual(onlyBlacklist.length <= CALL_BUTTON_MAX_CHARS, true);
  assertEqual(/[：:]/.test(onlyBlacklist), false);
  assertEqual(looksLikeCallButton(onlyBlacklist), false, '黑名单闸要独立拦住它');
});

await ok('自定义 answerPattern 生效', () => {
  const d = decideAnswer({ windows: [win(1, '通话', ['Answer', '挂断'])], answerPattern: 'Answer' });
  assertEqual(d.action, 'answer');
  assertEqual(d.matchedName, 'Answer');
});

// ── 误点防护：名字里有「接听」不等于它是接听按钮 ──────────────────────
//
// 这不是假想出来的边界。本机 probe 用 windowPattern='QQ' 扫到了 DSH 窗口
// 「QQagent — DeepSeek Harness」，里面有个按钮叫
// 「打开计划：QQ 通话三步落地计划（自动接听 → 环回耳朵 → 虚拟声卡嘴）」。
// 旧逻辑只看 answerPattern 命中，就会去点这个计划按钮 —— 点下去会打开面板，
// 而真正的来电还在响。

await ok('looksLikeCallButton：真按钮通过，标题式/设置式按钮不通过', () => {
  for (const good of ['接听', '接受', '接起', '视频接听', '接听语音']) {
    assertEqual(looksLikeCallButton(good), true, `「${good}」应该被认成接听按钮`);
  }
  for (const bad of [
    '打开计划：QQ 通话三步落地计划（自动接听 → 环回耳朵 → 虚拟声卡嘴）',
    '设置接听',
    '自动接听',
    '接听说明',
    '',
    '   '
  ]) {
    assertEqual(looksLikeCallButton(bad), false, `「${bad}」不该被认成接听按钮`);
  }
});

await ok('长标题按钮不会被点，但要出现在 skipped 里（不静默）', () => {
  const longName = '打开计划：QQ 通话三步落地计划（自动接听 → 环回耳朵 → 虚拟声卡嘴）';
  const d = decideAnswer({
    windows: [{ pid: 56680, title: 'QQagent — DeepSeek Harness', buttons: [{ name: longName, enabled: true }] }]
  });
  assertEqual(d.action, 'none', '绝不能去点计划面板');
  assertEqual(d.target, null);
  assertEqual(d.skipped.length, 1);
  assertEqual(d.skipped[0].name, longName);
  assert(d.reason.includes('不像接听动作'), `原因要说明为什么没点：${d.reason}`);
});

await ok('真接听按钮和长标题按钮同时存在 → 只点真按钮', () => {
  const d = decideAnswer({
    windows: [{
      pid: 7,
      title: '和甲的通话',
      buttons: [
        { name: '打开计划：QQ 通话三步落地计划（自动接听）', enabled: true },
        { name: '接听', enabled: true }
      ]
    }]
  });
  assertEqual(d.action, 'answer');
  assertEqual(d.matchedName, '接听');
  assertEqual(d.skipped.length, 1, '长标题要记进 skipped');
});

await ok('只有设置项没有真按钮 → none 且点名看到了什么', () => {
  const d = decideAnswer({ windows: [win(1, '通话设置', ['设置接听', '自动接听'])] });
  assertEqual(d.action, 'none');
  assert(d.reason.includes('设置接听'), `要点名：${d.reason}`);
});

// ── 6. scanCallWindows（注入 runner，不真跑 PowerShell）────────────────
// 这些都是 async 的：runner 改成异步之后，spawnSync 不再冻住事件循环，
// 但调用方必须 await —— 忘了 await 拿到的是 Promise，断言会全变成 undefined。
await ok('scanCallWindows 非 Windows 直接给结论', async () => {
  if (process.platform === 'win32') return; // 本机是 Windows，跳过
  const r = await scanCallWindows();
  assertEqual(r.ok, false);
  assert(r.errors[0].includes('Windows'), r.errors[0]);
});

await ok('scanCallWindows 解析 runner 的 stdout', async () => {
  const runner = fakeRunner(jsonResult({ windows: [win(9, '通话', ['接听'])], errors: [] }));
  const r = await scanCallWindows({ runner });
  if (process.platform !== 'win32') return; // 非 Windows 会提前返回
  assertEqual(r.ok, true);
  assertEqual(r.windows[0].pid, 9);
  assertEqual(runner.calls.length, 1);
  assert(runner.calls[0].includes('UIAutomationClient'), 'runner 收到的脚本不对');
});

await ok('scanCallWindows 把 runner 的 error 变成可读原因', async () => {
  const runner = fakeRunner({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });
  const r = await scanCallWindows({ runner });
  if (process.platform !== 'win32') return;
  assertEqual(r.ok, false);
  assert(r.errors[0].includes('ENOENT'), r.errors[0]);
});

await ok('scanCallWindows 空 stdout 时不返回假成功', async () => {
  const runner = fakeRunner({ status: 1, stdout: '  ', stderr: 'UIA 不可用', error: null });
  const r = await scanCallWindows({ runner });
  if (process.platform !== 'win32') return;
  assertEqual(r.ok, false);
  assert(r.errors[0].includes('UIA 不可用'), r.errors[0]);
});

// ── 7. invokeAnswer ────────────────────────────────────────────────────
await ok('invokeAnswer 参数不全时直接拒绝，不调 PowerShell', async () => {
  const runner = fakeRunner(jsonResult({ ok: true }));
  const noPid = await invokeAnswer({ pid: 0, buttonName: '接听', runner });
  assertEqual(noPid.ok, false);
  const noName = await invokeAnswer({ pid: 5, buttonName: '', runner });
  assertEqual(noName.ok, false);
  assertEqual(runner.calls.length, 0, '参数不全不该调 PowerShell');
});

await ok('invokeAnswer 解析 ok:true', async () => {
  const runner = fakeRunner(jsonResult({ ok: true, errors: [] }));
  const r = await invokeAnswer({ pid: 5, buttonName: '接听', runner });
  if (process.platform !== 'win32') return;
  assertEqual(r.ok, true);
  assertEqual(r.clicked, true);
  assert(runner.calls[0].includes('InvokePattern'), '脚本里没有 InvokePattern');
  assert(runner.calls[0].includes("'接听'"), '脚本里没有按钮名');
});

await ok('invokeAnswer 把 ok:false 的错误透出来', async () => {
  const runner = fakeRunner(jsonResult({ ok: false, errors: ['没找到名为「接听」的按钮'] }));
  const r = await invokeAnswer({ pid: 5, buttonName: '接听', runner });
  if (process.platform !== 'win32') return;
  assertEqual(r.ok, false);
  assert(r.errors[0].includes('没找到'), r.errors[0]);
});

await ok('invokeAnswer 遇到非法 JSON 不抛', async () => {
  const runner = fakeRunner({ status: 0, stdout: 'garbage', stderr: '', error: null });
  const r = await invokeAnswer({ pid: 5, buttonName: '接听', runner });
  if (process.platform !== 'win32') return;
  assertEqual(r.ok, false);
  assert(r.errors[0].includes('不是合法 JSON'), r.errors[0]);
});

// ── 8. createCallWatcher ──────────────────────────────────────────────
await ok('watcher: 同一窗口连扫 5 次只点 1 次（冷却生效）', async () => {
  const answered = [];
  const scan = () => ({ ok: true, windows: [win(42, '通话', ['接听'])], errors: [] });
  const answer = ({ pid, buttonName }) => { answered.push(`${pid}:${buttonName}`); return { ok: true, errors: [] }; };
  const watcher = createCallWatcher({ scan, answer, intervalMs: 600, cooldownMs: 20000 });

  for (let i = 0; i < 5; i += 1) await watcher.check();
  assertEqual(answered, ['42:接听'], `应该只点一次，实际点了 ${answered.length} 次`);
  assertEqual(watcher.snapshot().answered, 1);
});

await ok('watcher: 点失败后只压 3 秒，不像成功那样压 20 秒', async () => {
  let attempts = 0;
  const scan = () => ({ ok: true, windows: [win(42, '通话', ['接听'])], errors: [] });
  const answer = () => { attempts += 1; return { ok: false, errors: ['窗口已关'] }; };
  const watcher = createCallWatcher({ scan, answer, cooldownMs: 20000, retryMs: 0 });

  await watcher.check();
  await watcher.check();
  assertEqual(attempts, 2, 'retryMs=0 时第二次应该已经重试');
});

await ok('watcher: 窗口消失后同一个 pid 能再点（冷却被清掉）', async () => {
  const answered = [];
  let phase = 'call';
  const scan = () => ({
    ok: true,
    windows: phase === 'call' ? [win(42, '通话', ['接听'])] : [],
    errors: []
  });
  const answer = ({ pid }) => { answered.push(pid); return { ok: true, errors: [] }; };
  const watcher = createCallWatcher({ scan, answer, cooldownMs: 20000 });

  await watcher.check();          // 点一次
  assertEqual(answered.length, 1);
  phase = 'gone';
  await watcher.check();          // 窗口消失 → 清冷却
  phase = 'call';
  await watcher.check();          // 应该能再点
  assertEqual(answered.length, 2, `第二通电话没接上，answered=${JSON.stringify(answered)}`);
});

await ok('watcher: isEnabled=false 时零扫描零点击', async () => {
  let scans = 0;
  const scan = () => { scans += 1; return { ok: true, windows: [], errors: [] }; };
  const watcher = createCallWatcher({ scan, answer: () => ({ ok: true }), isEnabled: () => false });
  const r = await watcher.check();
  assertEqual(scans, 0, '不该扫描');
  assertEqual(r.action, 'disabled');
});

await ok('watcher: scan 抛异常时 check 不抛，且记录 lastError', async () => {
  const watcher = createCallWatcher({
    scan: () => { throw new Error('PowerShell 炸了'); },
    answer: () => ({ ok: true })
  });
  const r = await watcher.check();
  assertEqual(r.action, 'error');
  assert(watcher.snapshot().lastError.includes('PowerShell 炸了'), watcher.snapshot().lastError);
});

await ok('watcher: scan 返回 ok=false 时记录原因，不点击', async () => {
  let clicked = 0;
  const watcher = createCallWatcher({
    scan: () => ({ ok: false, windows: [], errors: ['UIA 不可用'] }),
    answer: () => { clicked += 1; return { ok: true }; }
  });
  await watcher.check();
  assertEqual(clicked, 0);
  assert(watcher.snapshot().lastError.includes('UIA 不可用'), watcher.snapshot().lastError);
});

await ok('watcher: answer 抛异常时不会把循环打挂', async () => {
  const watcher = createCallWatcher({
    scan: () => ({ ok: true, windows: [win(42, '通话', ['接听'])], errors: [] }),
    answer: () => { throw new Error('Invoke 失败'); }
  });
  const r = await watcher.check();
  assertEqual(r.action, 'failed');
  assert(watcher.snapshot().lastError.includes('Invoke 失败'), watcher.snapshot().lastError);
});

await ok('watcher: options() 能改窗口匹配模式和 preferVideo', async () => {
  let seenOpts = null;
  const watcher = createCallWatcher({
    scan: (opts) => { seenOpts = opts; return { ok: true, windows: [], errors: [] }; },
    answer: () => ({ ok: true }),
    options: () => ({ windowPattern: '来电', preferVideo: true })
  });
  await watcher.check();
  assertEqual(seenOpts.windowPattern, '来电');
});

await ok('watcher: start/stop 管理定时器，snapshot.running 跟随', async () => {
  const watcher = createCallWatcher({
    scan: () => ({ ok: true, windows: [], errors: [] }),
    answer: () => ({ ok: true }),
    intervalMs: 600
  });
  assertEqual(watcher.snapshot().running, false);
  watcher.start();
  assertEqual(watcher.snapshot().running, true);
  // start 会立刻扫一次（来电是突发的，不能等第一个 interval）
  await new Promise((r) => setTimeout(r, 50));
  assert(watcher.snapshot().scans >= 1, 'start 后应该已经扫过一次');
  watcher.stop();
  assertEqual(watcher.snapshot().running, false);
  const after = watcher.snapshot().scans;
  await new Promise((r) => setTimeout(r, 100));
  assertEqual(watcher.snapshot().scans, after, 'stop 之后不该继续扫');
});

await ok('watcher: 没有来电时返回 none，且不点击', async () => {
  let clicked = 0;
  const watcher = createCallWatcher({
    scan: () => ({ ok: true, windows: [win(1, '聊天窗口', ['发送', '关闭'])], errors: [] }),
    answer: () => { clicked += 1; return { ok: true }; }
  });
  const r = await watcher.check();
  assertEqual(r.action, 'none');
  assertEqual(clicked, 0);
});

// 重入锁：runner 改成异步之后，一次扫描（实测 1.4 秒）比 600ms 的间隔还长。
// 不锁就会并发起一堆 PowerShell，每个都在抢 UIA 的 COM 单线程 ——
// 这既拖慢机器，也会让"已点过"的冷却判断错乱。
await ok('watcher: 上一轮没结束时第二轮直接跳过，不并发跑 scan', async () => {
  let concurrent = 0;
  let peak = 0;
  let scans = 0;
  const watcher = createCallWatcher({
    scan: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      scans += 1;
      await new Promise((r) => setTimeout(r, 80));
      concurrent -= 1;
      return { ok: true, windows: [], errors: [] };
    },
    answer: () => ({ ok: true })
  });
  const first = watcher.check();
  // 第二轮在第一轮还没结束时发起
  await new Promise((r) => setTimeout(r, 10));
  const second = await watcher.check();
  assertEqual(second.action, 'busy', '应明确说"上一轮还没结束"，而不是静默排队');
  await first;
  assertEqual(peak, 1, `scan 并发峰值必须为 1，实际 ${peak}`);
  assertEqual(scans, 1, `只该真的扫一次，实际 ${scans}`);
  // 锁必须能释放：第一轮结束后还能正常扫
  await watcher.check();
  assertEqual(scans, 2, '锁没释放，之后再也扫不了了');
});

// ── 收尾 ──────────────────────────────────────────────────────────────
console.log(`\n${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
