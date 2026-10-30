// 人设模板条目的 id 稳定性。
//
// 这组断言锁的是两个真实事故：
//   ① 以前 id = 数组下标 `custom_${i}`。删掉中间一条后 id 全部平移，
//      前端拿旧 id 去删/改，操作的是**另一条**人设（静默改错，无报错）。
//   ② 控制台只有「添加人设」没有「保存回模板」。用户想改已有模板只能重新粘一遍，
//      每改一次就多一条同名副本 —— 原模板一个字没变，下拉里一堆同名条目。
import assert from 'node:assert/strict';
import { customPersonaId, findCustomPersonaIndex, withStableIds } from '../src/persona-store.js';

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

const STABLE = /^custom_(?!\d+$)[A-Za-z0-9]+$/;

console.log('\n[1] 稳定 id 的判定');

ok('新格式 custom_<随机/指纹> 视为稳定', () => {
  assert.equal(customPersonaId({ id: 'custom_9f3a1b2c' }, 7), 'custom_9f3a1b2c');
  assert.match('custom_9f3a1b2c', STABLE);
});

ok('旧的下标格式 custom_0 / custom_12 不算稳定 id（它天生会随删除漂移）', () => {
  assert.equal(customPersonaId({ id: 'custom_0' }, 0), 'custom_0');   // 兼容读取时仍能反查
  assert.doesNotMatch('custom_0', STABLE);
  assert.doesNotMatch('custom_12', STABLE);
});

ok('非法 id（非 custom_ 前缀 / 带短横线 / 空）退回下标', () => {
  assert.equal(customPersonaId({ id: 'xiaojingyu' }, 1), 'custom_1');
  assert.equal(customPersonaId({ id: 'custom_a-b' }, 2), 'custom_2');
  assert.equal(customPersonaId({ id: '' }, 4), 'custom_4');
  assert.equal(customPersonaId(null, 5), 'custom_5');
});

console.log('\n[2] withStableIds：写盘前把 id 固化');

const legacy = [{ name: '大肥鱼', text: '甲' }, { name: '恶毒鲸鱼', text: '乙' }, { name: '新人设', text: '丙' }];

ok('老数据（无 id）补成合法稳定 id', () => {
  const fixed = withStableIds(legacy);
  assert.equal(fixed.length, 3);
  for (const p of fixed) assert.match(p.id, STABLE);
});

ok('迁移是确定性的：同样内容两次调用得到同样的 id（重启也不变）', () => {
  const a = withStableIds(legacy).map((p) => p.id);
  const b = withStableIds(legacy).map((p) => p.id);
  assert.deepEqual(a, b);
});

ok('旧下标 id（custom_0）会被换成指纹 id，而不是原样保留', () => {
  const fixed = withStableIds([{ id: 'custom_0', name: '甲', text: '正文' }]);
  assert.notEqual(fixed[0].id, 'custom_0');
  assert.match(fixed[0].id, STABLE);
});

ok('不修改原数组（避免就地改写调用方的数据）', () => {
  const copy = [{ name: 'A', text: 'x' }];
  withStableIds(copy);
  assert.equal(copy[0].id, undefined);
});

ok('已有的稳定 id 不被覆盖', () => {
  const fixed = withStableIds([{ id: 'custom_abcd1234', name: 'A', text: 'x' }, { name: 'B', text: 'y' }]);
  assert.equal(fixed[0].id, 'custom_abcd1234');
  assert.match(fixed[1].id, STABLE);
});

ok('两条完全相同的人设不会撞 id', () => {
  const fixed = withStableIds([{ name: 'A', text: '同' }, { name: 'A', text: '同' }]);
  assert.notEqual(fixed[0].id, fixed[1].id);
});

ok('传入非数组不炸', () => {
  assert.deepEqual(withStableIds(undefined), []);
  assert.deepEqual(withStableIds(null), []);
});

console.log('\n[3] 删除中间一条后，剩余条目的 id 不漂移（核心回归）');

ok('删掉第 1 条，丙的 id 还是它自己那个', () => {
  const stable = withStableIds([{ name: '甲', text: '1' }, { name: '乙', text: '2' }, { name: '丙', text: '3' }]);
  const removed = stable.filter((_, i) => i !== 1);      // 删「乙」
  const after = withStableIds(removed);
  assert.deepEqual(after.map((p) => p.name), ['甲', '丙']);
  assert.equal(after[0].id, stable[0].id);
  assert.equal(after[1].id, stable[2].id);               // 不被顶成「乙」的 id
});

ok('删掉第 0 条同理', () => {
  const stable = withStableIds([{ name: '甲', text: '1' }, { name: '乙', text: '2' }, { name: '丙', text: '3' }]);
  const after = withStableIds(stable.filter((_, i) => i !== 0));
  assert.deepEqual(after.map((p) => p.id), [stable[1].id, stable[2].id]);
});

console.log('\n[4] findCustomPersonaIndex');

ok('按稳定 id 找到正确下标', () => {
  const list = withStableIds([{ name: '甲', text: '1' }, { name: '乙', text: '2' }]);
  assert.equal(findCustomPersonaIndex(list, list[1].id), 1);
  assert.equal(findCustomPersonaIndex(list, list[0].id), 0);
});

ok('找不到 / 空 id / 内置 id 都返回 -1（不能误删内置模板）', () => {
  const list = withStableIds([{ name: '甲', text: '1' }]);
  assert.equal(findCustomPersonaIndex(list, 'custom_zzzz9999'), -1);
  assert.equal(findCustomPersonaIndex(list, ''), -1);
  assert.equal(findCustomPersonaIndex(list, 'xiaojingyu'), -1);
  assert.equal(findCustomPersonaIndex(null, 'custom_0'), -1);
});

ok('旧前端还拿着 custom_1 → 按下标兜底命中，不直接 404', () => {
  const list = withStableIds([{ name: '甲', text: '1' }, { name: '乙', text: '2' }]);
  assert.equal(findCustomPersonaIndex(list, 'custom_1'), 1);
});

ok('下标越界的老 id 不被瞎兜底', () => {
  const list = withStableIds([{ name: '甲', text: '1' }]);
  assert.equal(findCustomPersonaIndex(list, 'custom_9'), -1);
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}\n`);
