// 拍一拍的出站参数形态（2026-10-22 修的那个 bug 的回归网）
//
// 病根：NapCat 的 poke schema 把 user_id / group_id 定成**字符串**
//       （snowluma/napcat.mjs 的 `Nwe`：p.String()），而我们一直传 Number。
//       被 TypeBox 挡回来的每一次，回拍都是"判定通过、实际没发"。
//       实测 94 次「已经拍回去了」、真发出 0 次。
//
// 这里钉住四件事：
//   ① 首选形态必须是字符串（当前协议端要的）；
//   ② 字符串形态全线失败时，要退到数字形态（照顾按 int64 校验的协议端）；
//   ③ 结果不确定（可能已经拍出去了）时**不许**换形态重试 —— 那会连拍两下；
//   ④ 群/私聊参数不同（私聊不带 group_id）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { OneBotClient } from '../src/onebot.js';

/** 起一个 mock OneBot HTTP：记录每次调用，按 judge 决定成败。 */
function createMock({ judge }) {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const action = String(req.url || '').replace(/^\//, '');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    state.calls.push({ action, body });
    const r = judge({ action, body }) || {};
    if (r.raw !== undefined) {
      res.writeHead(r.status || 200, { 'content-type': 'application/json' });
      res.end(String(r.raw));
      return;
    }
    res.writeHead(r.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.ok === false
      ? { status: 'failed', retcode: r.retcode ?? 1200, message: r.message ?? 'failed', wording: r.wording ?? '' }
      : { status: 'ok', retcode: 0, data: null, message: '' }));
  });
  return {
    state,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return server.address().port;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function okReply() { return { ok: true }; }

let passed = 0;
function pass(name, extra = '') {
  passed += 1;
  console.log(`  ok  ${name}${extra ? ` —— ${extra}` : ''}`);
}

// ── ① 首选形态：字符串 + 扩展名，一次成功 ─────────────────────────────
{
  const mock = createMock({ judge: okReply });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await ob.sendPoke('group', '456', '114');

  assert.equal(mock.state.calls.length, 1, '第一次就成功时不该再试别的形态');
  const c = mock.state.calls[0];
  assert.equal(c.action, 'group_poke');
  assert.equal(typeof c.body.user_id, 'string', 'user_id 必须是字符串：' + JSON.stringify(c.body));
  assert.equal(typeof c.body.group_id, 'string', 'group_id 必须是字符串：' + JSON.stringify(c.body));
  assert.equal(c.body.user_id, '114');
  assert.equal(c.body.group_id, '456');
  await mock.close();
  pass('群拍：首选「字符串 + group_poke」，ID 是字符串');
}

// ── ② 字符串被拒（老协议端按 int64 校验）→ 退到数字形态 ────────────────
{
  const mock = createMock({
    judge: ({ body }) => (typeof body.user_id === 'string'
      ? { ok: false, retcode: 1200, message: '参数类型错误' }
      : okReply())
  });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await ob.sendPoke('group', '456', '114');

  assert.ok(mock.state.calls.length >= 3, '字符串两种都该试过：' + JSON.stringify(mock.state.calls));
  const last = mock.state.calls.at(-1);
  assert.equal(typeof last.body.user_id, 'number', '最终应退到数字形态：' + JSON.stringify(last.body));
  assert.equal(last.body.user_id, 114);
  await mock.close();
  pass('群拍：字符串被拒 → 自动退到数字形态', `共试 ${mock.state.calls.length} 种`);
}

// ── ③ 结果不确定 → 立刻停手，不许换形态（否则连拍两下）────────────────
{
  const mock = createMock({ judge: () => ({ status: 200, raw: '<html>不是 JSON</html>' }) });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(
    () => ob.sendPoke('group', '456', '114'),
    (e) => e?.uncertain === true,
    '应抛出"结果不确定"'
  );
  assert.equal(mock.state.calls.length, 1, '不确定时只能发过一次：可能已经拍出去了，再试就是连拍');
  await mock.close();
  pass('结果不确定 → 不再换形态重试（避免连拍两下）');
}

// ── ④ 全线失败 → 抛错，且四种形态都试过 ───────────────────────────────
{
  const mock = createMock({ judge: () => ({ ok: false, retcode: 1200, message: '参数错误' }) });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(() => ob.sendPoke('group', '456', '114'));
  assert.equal(mock.state.calls.length, 4, 'group_poke/send_poke × 字符串/数字 共 4 种：'
    + JSON.stringify(mock.state.calls.map((c) => c.action + ':' + typeof c.body.user_id)));
  await mock.close();
  pass('全线失败：四种形态都试过后才报错');
}

// ── ⑤ 私聊：只带 user_id，不带 group_id ───────────────────────────────
{
  const mock = createMock({ judge: okReply });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await ob.sendPoke('private', '777', null);

  const c = mock.state.calls[0];
  assert.equal(c.action, 'friend_poke');
  assert.equal(c.body.user_id, '777');
  assert.equal('group_id' in c.body, false, '私聊不该带 group_id（带了就会被当成群拍）');
  await mock.close();
  pass('私聊拍：friend_poke + 只带 user_id');
}

// ── ⑥ 动作不存在（404）→ 换标准名 send_poke ───────────────────────────
{
  const mock = createMock({
    judge: ({ action }) => (action === 'group_poke' ? { status: 404, ok: false, retcode: 1404 } : okReply())
  });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await ob.sendPoke('group', '456', '114');

  assert.equal(mock.state.calls[0].action, 'group_poke');
  assert.equal(mock.state.calls.at(-1).action, 'send_poke', '扩展名不支持时应退到标准名');
  assert.ok(ob.capabilities().unsupported.includes('group_poke'), '撞过一次就该记下来，别每次都撞');
  await mock.close();
  pass('扩展名不支持 → 退到标准名 send_poke，并记进 unsupported');
}

// ── ⑦ 发包能力整台坏了（NapCat 不认当前 QQ 版本）→ 只试一次就停，且不拉黑接口 ──
//    实测原文：packetBackend发包能力不可用……PacketBackend 不支持当前QQ版本架构：9.9.36-53644
//    里面有"不支持"三个字，很容易被 looksUnsupported 误判成"没有这个接口"。
//    两者的处理完全不同：接口没有 → 换动作名；发包坏了 → 换名字也白发。
{
  const NO_PACKET = 'packetBackend发包能力不可用，请参照文档检查packetBackend状态。'
    + '错误堆栈信息：[Core] [Packet] PacketBackend 不支持当前QQ版本架构：9.9.36-53644-x64';
  const mock = createMock({ judge: () => ({ ok: false, retcode: 400, message: NO_PACKET }) });
  const port = await mock.listen();
  const ob = new OneBotClient({ wsUrl: '', httpUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(
    () => ob.sendPoke('group', '456', '114'),
    (e) => e?.code === 'EPLATFORM_NO_PACKET',
    '应识别成"发包能力不可用"而不是"接口不存在"'
  );
  assert.equal(mock.state.calls.length, 1, '发包坏了换形态也发不出去，只该试一次：'
    + JSON.stringify(mock.state.calls.map((c) => c.action)));
  assert.equal(ob.capabilities().unsupported.length, 0,
    '不该把 group_poke 拉黑：接口是好的，坏的是发包后端（拉黑后就再也查不出真病因）：'
    + JSON.stringify(ob.capabilities().unsupported));
  await mock.close();
  pass('发包后端不可用 → 只试一次、且不误拉黑接口');
}

console.log(`\n拍一拍参数形态：${passed} 项通过`);
