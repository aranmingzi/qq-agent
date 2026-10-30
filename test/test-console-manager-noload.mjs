// 守卫：控制台「管理服务商」的每次改动必须是本地增量更新，不能整页 reload。
//
// 为什么用源码断言：这个 bug 只在手点时表现为「闪一下 + 对话框重开」，
// 没有任何接口层面的痕迹，跑 HTTP 测试永远绿。它唯一可自动化的把手就是
// 「管理面板这条路径上不许出现 reload / onChanged」。
//
// 真实事故（2026-10-27）：onChanged={() => model.reload()} → load() 把 phase 置 loading
// → 页面早退成 <ModelPageSkeleton/> → 对话框被卸载重建、表单里刚敲的密钥被清空。
// 每点一次上移/删除都闪一次，这就是「点击 UI 卡顿」。
//
// 跑法：node test/test-console-manager-noload.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const dialog = read('console/src/features/settings/model-api/provider-manager-dialog.tsx');
const page = read('console/src/features/settings/model-api/model-api-page.tsx');
const hook = read('console/src/features/settings/model-api/use-model-config.ts');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (error) {
    results.push([false, name, error?.message]);
  }
}

check('管理面板不引用 reload', () => {
  assert.equal(/reload\s*\(/.test(dialog), false, '对话框里出现了 reload( —— 会整页闪骨架屏');
});

check('页面不再向对话框传 onChanged', () => {
  assert.equal(/onChanged=/.test(page), false, 'onChanged 会把整页重载接回来');
});

check('页面传的是增量回调', () => {
  for (const prop of ['onProviderChanged={', 'onProviderRemoved={']) {
    assert.equal(page.includes(prop), true, `缺少 ${prop}`);
  }
});

check('hook 暴露 applyProviderPatch / applyProviderRemoval', () => {
  for (const fn of ['applyProviderPatch', 'applyProviderRemoval']) {
    assert.equal(hook.includes(`${fn},`), true, `use-model-config 返回值里没有 ${fn}`);
  }
});

check('增量更新不碰 phase（否则照样闪骨架屏）', () => {
  const body = hook.slice(hook.indexOf('const commitProviders'), hook.indexOf('const applyProviderPatch'));
  assert.ok(body.length > 40, '找不到 commitProviders，锚点失效');
  assert.equal(body.includes("setPhase("), false, 'commitProviders 里改了 phase');
  assert.equal(body.includes('loadRequest'), false, 'commitProviders 里发起了重新加载');
});

check('对话框每次改动都回传最新 provider', () => {
  // 五个改动入口：保存信息 / 新增 / 重排 / 删模型 / 删服务商
  const patched = (dialog.match(/onProviderChanged\(/g) ?? []).length;
  assert.ok(patched >= 4, `只有 ${patched} 处回传，改动会显示不出来`);
  assert.equal(dialog.includes('onProviderRemoved('), true, '删除服务商后目录不会更新');
});

const failed = results.filter(([ok]) => !ok);
for (const [ok, name, message] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` —— ${message}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
