// 媒体权限处理器的测试。
//
// 为什么值得单独测：这段代码决定「谁能抓系统混音」。写错一个 origin 判定，
// 就是把整台电脑的声音送给任意页面 —— 而且用户完全不会察觉。
// electron/main.js 在测试里 import 不了（要 app 就绪），所以逻辑抽到了
// src/call-media.js，这里塞假 session 把三个 handler 真的调用一遍。

import assert from 'node:assert/strict';
import {
  installCallMediaHandlers,
  isLocalOrigin,
  ALLOWED_PERMISSIONS
} from '../src/call-media.js';

let pass = 0;
async function ok(name, fn) {
  try {
    await fn();
  } catch (error) {
    error.message = `[${name}] ${error.message}`;
    throw error;
  }
  pass += 1;
  console.log(`  ✓ ${name}`);
}

/** 假 session：把 handler 存下来，测试里手动调用。 */
function fakeSession() {
  const handlers = {};
  return {
    handlers,
    setPermissionCheckHandler(fn) { handlers.check = fn; },
    setPermissionRequestHandler(fn) { handlers.request = fn; },
    setDisplayMediaRequestHandler(fn, opts) { handlers.display = fn; handlers.displayOpts = opts; }
  };
}

await ok('isLocalOrigin：本机回环地址放行（带路径也要放行）', () => {
  assert.equal(isLocalOrigin('http://127.0.0.1:3210'), true);
  assert.equal(isLocalOrigin('http://localhost:3210'), true);
  assert.equal(isLocalOrigin('https://127.0.0.1'), true);
  assert.equal(isLocalOrigin('http://[::1]:3210'), true);
  // Electron 的 requestingUrl 常常带路径，锚定结尾的正则会误拒
  assert.equal(isLocalOrigin('http://127.0.0.1:3210/console/'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:3210/console/index.html?x=1'), true);
});

await ok('isLocalOrigin：前缀伪装与外部地址一律拒', () => {
  // 这个用例是整个模块最该有的一个：startsWith('http://127.0.0.1') 会放过它
  assert.equal(isLocalOrigin('http://127.0.0.1.evil.com'), false);
  assert.equal(isLocalOrigin('http://evil.com/127.0.0.1'), false);
  assert.equal(isLocalOrigin('http://192.168.1.5:3210'), false);
  assert.equal(isLocalOrigin('file:///c:/x.html'), false);
  assert.equal(isLocalOrigin(''), false);
  assert.equal(isLocalOrigin(null), false);
  assert.equal(isLocalOrigin(undefined), false);
});

await ok('三个 handler 都装上了，且没开系统选择器', () => {
  const session = fakeSession();
  installCallMediaHandlers({ session });
  assert.equal(typeof session.handlers.check, 'function');
  assert.equal(typeof session.handlers.request, 'function');
  assert.equal(typeof session.handlers.display, 'function');
  // useSystemPicker 在 Windows 上无效，开着只会让行为变得不可预测
  assert.equal(session.handlers.displayOpts.useSystemPicker, false);
});

await ok('没给 session 直接抛（不许静默装不上）', () => {
  assert.throws(() => installCallMediaHandlers({}), /需要 Electron 的 session/);
  assert.throws(() => installCallMediaHandlers(), /需要 Electron 的 session/);
});

await ok('check handler：本机给 media，外网一律 false', () => {
  const session = fakeSession();
  installCallMediaHandlers({ session });
  const check = session.handlers.check;
  assert.equal(check(null, 'media', 'http://127.0.0.1:3210'), true);
  assert.equal(check(null, 'display-capture', 'http://localhost:3210'), true);
  assert.equal(check(null, 'speaker-selection', 'http://127.0.0.1:3210'), true);
  assert.equal(check(null, 'media', 'http://evil.com'), false);
  // 不在白名单里的权限，即使是本机也不给
  assert.equal(check(null, 'geolocation', 'http://127.0.0.1:3210'), false);
  assert.equal(check(null, 'usb', 'http://127.0.0.1:3210'), false);
});

await ok('request handler：本机批准，外网拒绝并记账', () => {
  const session = fakeSession();
  const result = installCallMediaHandlers({ session });
  const request = session.handlers.request;

  let got = null;
  request(null, 'media', (v) => { got = v; }, { requestingUrl: 'http://127.0.0.1:3210/console/' });
  assert.equal(got, true);
  assert.deepEqual(result.granted, ['media']);

  request(null, 'media', (v) => { got = v; }, { requestingUrl: 'http://evil.com/x' });
  assert.equal(got, false);
  assert.deepEqual(result.rejected, ['media']);
});

await ok('request handler：不认识的权限直接拒，连 origin 都不看', () => {
  const session = fakeSession();
  installCallMediaHandlers({ session });
  const request = session.handlers.request;
  let got = null;
  request(null, 'geolocation', (v) => { got = v; }, { requestingUrl: 'http://127.0.0.1:3210' });
  assert.equal(got, false);
});

await ok('display handler：本机给 audio=loopback，video 明确为 null', () => {
  const session = fakeSession();
  installCallMediaHandlers({ session });
  const display = session.handlers.display;
  let streams = null;
  display({ securityOrigin: 'http://127.0.0.1:3210' }, (s) => { streams = s; });
  assert.equal(streams.audio, 'loopback');
  // video 必须是 null 而不是 undefined：给 undefined 会被当成"抓整页"
  assert.equal(streams.video, null);
  assert.ok('video' in streams, 'video 键必须存在且为 null');
});

await ok('display handler：外网来源回空对象（什么都不给，也不会挂住）', () => {
  const session = fakeSession();
  installCallMediaHandlers({ session });
  const display = session.handlers.display;
  let streams = null;
  display({ securityOrigin: 'http://evil.com' }, (s) => { streams = s; });
  assert.deepEqual(streams, {});
  assert.equal(streams.audio, undefined);
});

await ok('display handler：requestingUrl 也能认（两个 API 字段名不同）', () => {
  const session = fakeSession();
  installCallMediaHandlers({ session });
  const display = session.handlers.display;
  let streams = null;
  display({ requestingUrl: 'http://localhost:3210/' }, (s) => { streams = s; });
  assert.equal(streams.audio, 'loopback');
});

await ok('installCallMediaHandlers 返回的 granted/rejected 可以清空', () => {
  const session = fakeSession();
  const result = installCallMediaHandlers({ session });
  session.handlers.request(null, 'media', () => {}, { requestingUrl: 'http://127.0.0.1:1' });
  assert.equal(result.granted.length, 1);
  result.reset();
  assert.equal(result.granted.length, 0);
  assert.equal(result.rejected.length, 0);
});

await ok('ALLOWED_PERMISSIONS 是冻结的，且只有三项', () => {
  assert.deepEqual([...ALLOWED_PERMISSIONS], ['media', 'speaker-selection', 'display-capture']);
  assert.throws(() => { ALLOWED_PERMISSIONS.push('usb'); }, /object is not extensible|Cannot add/);
});

await ok('自定义 origin 判定能替换（给测试/别的宿主留口子）', () => {
  const session = fakeSession();
  const result = installCallMediaHandlers({
    session,
    isAllowedOrigin: (origin) => origin === 'app://qqagent'
  });
  let got = null;
  session.handlers.request(null, 'media', (v) => { got = v; }, { requestingUrl: 'app://qqagent' });
  assert.equal(got, true);
  assert.deepEqual(result.granted, ['media']);
  session.handlers.request(null, 'media', (v) => { got = v; }, { requestingUrl: 'http://127.0.0.1:3210' });
  assert.equal(got, false);
});

await ok('session 缺某个 handler 时不崩（老版本 Electron）', () => {
  const partial = { setPermissionCheckHandler() {} };
  assert.doesNotThrow(() => installCallMediaHandlers({ session: partial }));
});

console.log(`\n[call-media] ${pass} 项通过，全部通过`);
