// 扩展包清单的自检：重点是 configSchema 必须活到 api.config()。
// 跑：node test/test-plugin-schema.mjs（秒级、不碰网络、不写盘）
//
// 锁的是一条曾经真实踩过的坑（Estrella 作者注释里写明）：
//   清单里写了 configSchema，但加载器只留了键名（schemaKeys）、把本体丢了，
//   于是 `api.config()` 返回空对象、插件读到 undefined、静默走错分支。
//   测试全绿 —— 因为测试自己传了 settings；生产没人传，就坏在那儿。
//   所以下面第 4 条是**没有 settings 的纯 schema 场景**，那才是生产。
import assert from 'node:assert/strict';

const { normalizeManifest, normalizeConfigSchema, schemaDefaults, PLUGIN_API_VERSION } =
  await import('../src/plugin-manifest.js');
const { settingsOf, buildApi } = await import('../src/plugin-api.js');

const raw = (extra = {}) => ({
  id: 'demo-plugin',
  name: '演示包',
  version: '1.2.0',
  apiVersion: PLUGIN_API_VERSION,
  entry: 'index.js',
  ...extra
});

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name + '\n       ' + (error?.message ?? error));
    process.exitCode = 1;
  }
}

const SCHEMA = {
  volume: { type: 'number', label: '音量', default: 60, min: 0, max: 100, help: '0~100' },
  mode: { type: 'select', label: '模式', default: 'soft', options: [{ value: 'soft', label: '温和' }, { value: 'sharp', label: '尖锐' }] },
  enabled: { type: 'boolean', default: true },
  note: { type: 'text', label: '备注' },        // 故意不给 default
  token: { type: 'secret', default: '' }
};

console.log('\n清单层：本体要留住');

ok('configSchema 不再只剩键名，本体连同 default 一起留下', () => {
  const { manifest, fatal } = normalizeManifest(raw({ configSchema: SCHEMA }));
  assert.equal(fatal.length, 0);
  assert.ok(manifest.configSchema, 'configSchema 本体必须存在');
  assert.equal(manifest.configSchema.volume.default, 60);
  assert.equal(manifest.configSchema.mode.default, 'soft');
  assert.deepEqual(manifest.schemaKeys, ['volume', 'mode', 'enabled', 'note', 'token'], '键名顺序保持清单里的顺序');
});

ok('schemaDefaults 只收有 default 的键（"没设默认值"和"默认值为空"是两件事）', () => {
  const { manifest } = normalizeManifest(raw({ configSchema: SCHEMA }));
  const d = schemaDefaults(manifest.configSchema);
  assert.deepEqual(d, { volume: 60, mode: 'soft', enabled: true, token: '' });
  assert.equal('note' in d, false, 'note 没写 default，就不该出现在默认值里');
});

ok('未知 type 按 string 处理，不拒绝整个清单', () => {
  const problems = [];
  const s = normalizeConfigSchema({ weird: { type: 'colour-picker', default: 'red' } }, problems);
  assert.equal(s.weird.type, 'string');
  assert.equal(s.weird.default, 'red');
  assert.ok(problems.some((p) => p.code === 'bad-schema-type'));
});

ok('单个坏字段只丢自己，不影响别的字段', () => {
  const problems = [];
  const s = normalizeConfigSchema({ good: { type: 'boolean', default: false }, bad: 'oops', worse: null }, problems);
  assert.deepEqual(Object.keys(s), ['good']);
  assert.equal(problems.filter((p) => p.code === 'bad-schema-field').length, 2);
});

ok('没有 label 就用键名当标签（控制台不用再猜）', () => {
  const s = normalizeConfigSchema({ auto: { type: 'number' } });
  assert.equal(s.auto.label, 'auto');
});

console.log('\n消费层：api.config() 必须拿得到默认值');

ok('★ 只写 configSchema、不写 settings 时，config() 也能拿到默认值（生产场景）', () => {
  const { manifest } = normalizeManifest(raw({ configSchema: SCHEMA }));
  const cfg = settingsOf(manifest)();
  assert.equal(cfg.volume, 60, '这里拿到 undefined 就是当年那个"生产坏、测试绿"的 bug');
  assert.equal(cfg.mode, 'soft');
  assert.equal(cfg.enabled, true);
});

ok('用户填的值盖过 schema 默认值', () => {
  const { manifest } = normalizeManifest(raw({ configSchema: SCHEMA }));
  const cfg = settingsOf(manifest, { volume: 20, mode: 'sharp' })();
  assert.equal(cfg.volume, 20);
  assert.equal(cfg.mode, 'sharp');
  assert.equal(cfg.enabled, true, '没被覆盖的仍然走默认');
});

ok('settings 静态值盖过 schema 默认值，又低于用户值', () => {
  const { manifest } = normalizeManifest(raw({ configSchema: SCHEMA, settings: { volume: 80 } }));
  assert.equal(settingsOf(manifest)().volume, 80, 'settings 比 schema default 优先');
  assert.equal(settingsOf(manifest, { volume: 5 })().volume, 5, '用户值最高');
});

ok('buildApi 里 api.config() 也是这套合并（插件真正读到的那个）', () => {
  const { manifest } = normalizeManifest(raw({ configSchema: SCHEMA }));
  const api = buildApi({ manifest });
  const cfg = api.config();
  assert.equal(cfg.volume, 60);
  assert.equal(cfg.mode, 'soft');
});

ok('老清单没写 configSchema 也照旧能跑（向后兼容）', () => {
  const { manifest, fatal } = normalizeManifest(raw({ settings: { legacy: 1 } }));
  assert.equal(fatal.length, 0);
  assert.deepEqual(manifest.configSchema, {});
  assert.equal(settingsOf(manifest)().legacy, 1);
});

console.log(`\n通过 ${pass} 项`);
