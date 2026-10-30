// 出站网络分流的纯逻辑测试（不打真实网络）。
//
// 钉住的是三类**静默失效**，共同点都是"看着配了、实际没生效"：
//   ① 域名匹配写成 `endsWith('googleapis.com')` → `notgoogleapis.com` 也被代理，
//      任何拿域名当后缀的野站点都会把请求塞进代理。
//   ② 配置优先级写反（环境变量压过 net.proxyUrl）→ 用户填了代理地址却不起作用。
//   ③ 没有代理 / 协议不支持时没退回直连 → 静默把国内链路一起拖死。
//
// 用法：node test/test-net-proxy.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-net-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { shouldProxyHost, proxyUrlFrom, installNetProxy, netProxyStatus, DEFAULT_PROXY_HOSTS } =
  await import('../src/net-proxy.js');

let pass = 0;
let fail = 0;
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail += 1;
    process.exitCode = 1;
    console.log(`✗ ${name}\n    ${error?.message ?? error}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

await ok('① 海外域名命中，国内域名不命中', () => {
  assert(shouldProxyHost('generativelanguage.googleapis.com') === true, 'Gemini 端点没命中');
  assert(shouldProxyHost('api.openai.com') === true, 'openai 没命中');
  assert(shouldProxyHost('api.deepseek.com') === false, 'deepseek 不该走代理');
  assert(shouldProxyHost('dashscope.aliyuncs.com') === false, '百炼不该走代理');
  assert(shouldProxyHost('127.0.0.1') === false, '本机不该走代理');
});

await ok('② 后缀匹配必须有边界（notgoogleapis.com 不许被代理）', () => {
  assert(shouldProxyHost('notgoogleapis.com') === false, 'notgoogleapis.com 被误判成 Google');
  assert(shouldProxyHost('evil-openai.com') === false, 'evil-openai.com 被误判');
  assert(shouldProxyHost('a.b.googleapis.com') === true, '多级子域应命中');
  assert(shouldProxyHost('GOOGLEAPIS.COM') === true, '大小写不敏感');
  assert(shouldProxyHost('') === false, '空 host 应为 false');
});

await ok('③ 自定义名单整体替换（不是追加）', () => {
  assert(shouldProxyHost('generativelanguage.googleapis.com', ['example.com']) === false,
    '自定义名单下不该再命中内置域名');
  assert(shouldProxyHost('api.example.com', ['example.com']) === true, '自定义名单没生效');
});

await ok('④ 代理地址优先级：配置 > 环境变量 > 空', () => {
  const cfg = { net: { proxyUrl: 'http://127.0.0.1:7897' } };
  const env = { HTTPS_PROXY: 'http://127.0.0.1:9999' };
  const a = proxyUrlFrom({ cfg, env });
  assert(a.url === 'http://127.0.0.1:7897' && a.from.includes('配置'), `配置没赢：${JSON.stringify(a)}`);

  const b = proxyUrlFrom({ cfg: {}, env });
  assert(b.url === 'http://127.0.0.1:9999' && b.from.includes('HTTPS_PROXY'), `env 没兜住：${JSON.stringify(b)}`);

  const c = proxyUrlFrom({ cfg: {}, env: {} });
  assert(c.url === '' && c.from === '', `空配置应返回空：${JSON.stringify(c)}`);
});

await ok('⑤ 没有代理 → 直连（不抛错，不挂起）', async () => {
  // autoDiscover 关掉，否则本机真开着代理会干扰断言
  await installNetProxy({ cfg: { net: { enabled: true } }, env: {}, autoDiscover: false });
  const st = netProxyStatus();
  assert(st.mode === 'direct', `期望 direct，实际 ${st.mode}`);
  assert(st.proxyUrl === '', '直连模式不该有代理地址');
});

await ok('⑥ 有代理 → 装 split dispatcher，且状态可读', async () => {
  const st = await installNetProxy({
    cfg: { net: { enabled: true, proxyUrl: 'http://127.0.0.1:7897' } },
    env: {},
    autoDiscover: false
  });
  assert(st.mode === 'proxy', `期望 proxy，实际 ${st.mode}`);
  assert(st.proxyUrl === 'http://127.0.0.1:7897', '代理地址没记下来');
  assert(st.proxyHosts.length === DEFAULT_PROXY_HOSTS.length, '代理域名名单没记下来');
  assert(netProxyStatus().mode === 'proxy', '/api/status 读到的状态不对');
});

await ok('⑦ net.enabled=false 优先于配置里的代理地址', async () => {
  const st = await installNetProxy({
    cfg: { net: { enabled: false, proxyUrl: 'http://127.0.0.1:7897' } },
    env: {},
    autoDiscover: false
  });
  assert(st.mode === 'direct', `关掉代理后仍用代理：${st.mode}`);
  assert(st.note.includes('已关闭'), `关闭原因没说明：${st.note}`);
});

await ok('⑧ 不支持的代理协议 → 退回直连并说明原因', async () => {
  const st = await installNetProxy({
    cfg: { net: { enabled: true, proxyUrl: 'socks5://127.0.0.1:1080' } },
    env: {},
    autoDiscover: false
  });
  assert(st.mode === 'direct', 'socks5 被当成可用代理了');
  assert(/socks5/.test(st.note), `没说明为什么不支持：${st.note}`);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? `\n✗ 失败 ${fail} 项（通过 ${pass}）` : `\n✓ ${pass}/${pass} 项全过`);
if (fail) process.exit(1);
