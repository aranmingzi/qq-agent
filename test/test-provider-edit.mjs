// 服务商目录的增删改：providers.js 新增的四个能力的单测。
//
// 每条断言都对着一个**真实会踩的坑**，不是为了凑覆盖率：
//   ⚠️ reorderProviderModels 只传部分 id 时，绝不能把没传到的模型删掉
//   ⚠️ deleteProvider 删掉当前 api.provider 指向的那家时，必须清空悬空 id
//   ⚠️ removeModelsFromProvider 必须同时清 modelNames（否则名字表残留）
//   ⚠️ updateProviderMeta 撞地址必须报错（两家同 URL = 降级链静默少一家）
//
// 跑法：node test/test-provider-edit.mjs（自带隔离目录，不需要外部环境变量）
//
// ⚠️ 数据目录必须在 import config.js **之前**设死：config.js 在模块初始化时就算好 DATA_DIR。
// 不隔离的话，`seed()` 会把真实 data/config.json 的 providers 覆盖成 m1..m4 / b1..b2 ——
// 那是真生产配置，覆盖掉等于把 6 家服务商全删了，而且不会有任何报错。
// 所以这里用**动态 import**，并且**总是**用临时目录（不接受外部覆盖，避免有人手滑指到 data/）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TMP_DIR = path.join(process.cwd(), 'data', '_test-provider-edit');
process.env.QQ_AGENT_DATA_DIR = TMP_DIR;
fs.rmSync(TMP_DIR, { recursive: true, force: true });

const { getConfig, updateConfig } = await import('../src/config.js');
const {
  currentProviders,
  updateProviderMeta,
  removeModelsFromProvider,
  removeModelFromProvider,
  reorderProviderModels,
  deleteProvider,
  addModelsToProvider
} = await import('../src/providers.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([true, name]);
    console.log(`✅ ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`❌ ${name}\n   ${String(e?.message || e).split('\n').slice(0, 3).join('\n   ')}`);
  }
}

function seed() {
  updateConfig({
    api: { provider: 'p_alpha', baseUrl: 'https://alpha.test/v1', apiKey: 'k-alpha', model: 'm1' },
    providers: [
      {
        id: 'p_alpha',
        displayName: '甲家',
        api: 'openai',
        baseURL: 'https://alpha.test/v1',
        apiKey: 'k-alpha',
        models: ['m1', 'm2', 'm3', 'm4'],
        modelNames: { m1: 'M-1', m2: 'M-2', m3: 'M-3', m4: 'M-4' }
      },
      {
        id: 'p_beta',
        displayName: '乙家',
        api: 'openai',
        baseURL: 'https://beta.test/v1',
        apiKey: 'k-beta',
        models: ['b1', 'b2']
      }
    ]
  });
}

const modelsOf = (id) => (currentProviders().find((p) => p.id === id)?.models || []).slice();

// ── 改信息 ────────────────────────────────────────────────
check('改名生效，模型列表不动', () => {
  seed();
  updateProviderMeta('p_alpha', { displayName: '甲家改名' });
  const p = currentProviders().find((x) => x.id === 'p_alpha');
  assert.equal(p.displayName, '甲家改名');
  assert.deepEqual(p.models, ['m1', 'm2', 'm3', 'm4']);
});

check('空字段不覆盖（传空串不该把名字/地址/密钥清空）', () => {
  seed();
  updateProviderMeta('p_alpha', { displayName: '', baseUrl: '', apiKey: '' });
  const p = currentProviders().find((x) => x.id === 'p_alpha');
  assert.equal(p.displayName, '甲家');
  assert.equal(p.baseURL, 'https://alpha.test/v1');
  assert.equal(p.apiKey, 'k-alpha');
});

check('改地址时抹掉尾部斜杠', () => {
  seed();
  updateProviderMeta('p_alpha', { baseUrl: 'https://gamma.test/v1///' });
  assert.equal(currentProviders().find((x) => x.id === 'p_alpha').baseURL, 'https://gamma.test/v1');
});

check('撞地址必须报错（两家同 URL 会让降级链静默少一家）', () => {
  seed();
  assert.throws(() => updateProviderMeta('p_alpha', { baseUrl: 'https://beta.test/v1' }), /占用/);
  // 报错后原来那家不能被改坏
  assert.equal(currentProviders().find((x) => x.id === 'p_alpha').baseURL, 'https://alpha.test/v1');
});

check('改密钥写 apiKeyFrom=manual', () => {
  seed();
  updateProviderMeta('p_alpha', { apiKey: 'k-new' });
  const p = currentProviders().find((x) => x.id === 'p_alpha');
  assert.equal(p.apiKey, 'k-new');
  assert.equal(p.apiKeyFrom, 'manual');
});

// ── 删模型 ────────────────────────────────────────────────
check('批量删模型：列表和 modelNames 同时清', () => {
  seed();
  const p = removeModelsFromProvider('p_alpha', ['m2', 'm4']);
  assert.deepEqual(p.models, ['m1', 'm3']);
  assert.equal(p.modelNames.m2, undefined);
  assert.equal(p.modelNames.m4, undefined);
  assert.equal(p.modelNames.m1, 'M-1');
  // 落盘的也要对，不能只改内存
  const onDisk = (getConfig().providers || []).find((x) => x.id === 'p_alpha');
  assert.deepEqual(onDisk.models, ['m1', 'm3']);
});

check('删单个模型（旧接口仍走同一条路）', () => {
  seed();
  const p = removeModelFromProvider('p_alpha', 'm3');
  assert.deepEqual(p.models, ['m1', 'm2', 'm4']);
});

check('删不存在的服务商返回 null（不抛、不写盘）', () => {
  seed();
  assert.equal(removeModelsFromProvider('nope', ['m1']), null);
  assert.deepEqual(modelsOf('p_alpha'), ['m1', 'm2', 'm3', 'm4']);
});

// ── 重排（= 链位） ─────────────────────────────────────────
check('重排：只传部分 id 时，没传到的必须保留并接在末尾', () => {
  seed();
  const p = reorderProviderModels('p_alpha', ['m3']);
  assert.deepEqual(p.models, ['m3', 'm1', 'm2', 'm4'], '传 1 个只该把它提到最前，不能删掉其余');
});

check('重排：未知 id 忽略，不写进列表', () => {
  seed();
  const p = reorderProviderModels('p_alpha', ['m2', 'zzz', 'b1']);
  assert.deepEqual(p.models, ['m2', 'm1', 'm3', 'm4'], '不属于这家的 id 一律丢弃');
});

check('重排：重复 id 只留一次', () => {
  seed();
  const p = reorderProviderModels('p_alpha', ['m1', 'm1', 'm2']);
  assert.deepEqual(p.models, ['m1', 'm2', 'm3', 'm4']);
});

check('重排：空数组 = 不变（不能把模型列表清空）', () => {
  seed();
  const p = reorderProviderModels('p_alpha', []);
  assert.deepEqual(p.models, ['m1', 'm2', 'm3', 'm4']);
});

check('重排后落盘顺序与返回一致', () => {
  seed();
  reorderProviderModels('p_alpha', ['m4', 'm3', 'm2', 'm1']);
  const onDisk = (getConfig().providers || []).find((x) => x.id === 'p_alpha');
  assert.deepEqual(onDisk.models, ['m4', 'm3', 'm2', 'm1']);
});

// ── 删服务商 ──────────────────────────────────────────────
check('删整个服务商：目录里没了，别家不受影响', () => {
  seed();
  const r = deleteProvider('p_beta');
  assert.equal(r.provider.id, 'p_beta');
  assert.deepEqual(currentProviders().map((p) => p.id), ['p_alpha']);
  assert.deepEqual(modelsOf('p_alpha'), ['m1', 'm2', 'm3', 'm4']);
});

check('删当前在用的服务商：api.provider 必须清空（否则悬空 id 留在配置里）', () => {
  seed();
  const r = deleteProvider('p_alpha');
  assert.equal(r.apiProviderCleared, true);
  assert.equal(getConfig().api.provider, '');
  // 接入点本身不动 —— 删目录不等于换模型
  assert.equal(getConfig().api.baseUrl, 'https://alpha.test/v1');
  assert.equal(getConfig().api.model, 'm1');
});

check('删不存在的服务商返回 null', () => {
  seed();
  assert.equal(deleteProvider('nope'), null);
  assert.equal(currentProviders().length, 2);
});

// ── 加模型（回归：改完之后仍然只追加不覆盖）────────────────
check('追加模型：已存在的不重复加，modelNames 补全', () => {
  seed();
  addModelsToProvider('p_alpha', ['m4', 'm5']);
  const p = currentProviders().find((x) => x.id === 'p_alpha');
  assert.deepEqual(p.models, ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(p.modelNames.m5, 'm5');
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
// 收了尾再退出：留个空目录也容易被误当成"有数据"。
fs.rmSync(TMP_DIR, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
