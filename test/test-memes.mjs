// 群梗库的自检：候选 / 确认两级。
// 跑：node test/test-memes.mjs（秒级、不碰网络、只写系统临时目录）
//
// 这一层的核心不是"能不能存"，而是**候选永远不算数**：
// 模型提了候选之后，search 必须查不到它 —— 否则"记成候选"就成了自我授权的后门。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { searchMemes, proposeMeme, listPending, confirmMeme, rejectMeme, PENDING_MAX } =
  await import('../src/memes.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-memes-'));
const MEMES = path.join(DIR, 'memes.json');
const PENDING = path.join(DIR, 'memes-pending.json');
fs.writeFileSync(MEMES, JSON.stringify({
  memes: [{ key: '典', aliases: ['典中典'], meaning: '很典型、套路明显', usage: '调侃', tone: '调侃', tags: ['群聊'] }]
}));

const T = 1_760_000_000_000;
const prop = (o, t = T) => proposeMeme(o, { file: PENDING, memeFile: MEMES, now: t });
const conf = (k, t = T) => confirmMeme(k, { file: PENDING, memeFile: MEMES, now: t });
const rej = (k, t = T) => rejectMeme(k, { file: PENDING, memeFile: MEMES, now: t });
const find = (k) => searchMemes(k, { file: MEMES });

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

console.log('\n候选不进搜索');

ok('现有梗库查得到', () => {
  assert.equal(find('典中典').found, true);
});

ok('新梗提成候选后，搜索依然查不到（关键）', () => {
  const r = prop({ key: '电子木鱼', meaning: '敲着玩、求心安的梗', aliases: ['赛博木鱼'] });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pending');
  assert.equal(find('电子木鱼').found, false, '候选绝不能被当成"它已知的梗"');
  assert.equal(find('赛博木鱼').found, false);
});

ok('候选能被人看到（控制台列表）', () => {
  const { pending } = listPending({ file: PENDING });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].key, '电子木鱼');
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].hits, 1);
});

ok('提案结果里带一句"这轮别拿它当梗用"', () => {
  const r = prop({ key: '另一个梗', meaning: '释义随便' });
  assert.match(r.reason, /别拿它当/);
  // 清掉，别影响后面的计数
  rej('另一个梗');
});

console.log('\n确认之后才算数');

ok('确认后进正式库，搜索立刻能查到', () => {
  const r = conf('电子木鱼');
  assert.equal(r.ok, true);
  assert.equal(r.entry.key, '电子木鱼');
  const got = find('电子木鱼');
  assert.equal(got.found, true);
  assert.equal(got.results[0].meaning, '敲着玩、求心安的梗');
});

ok('确认后候选池里不再有它', () => {
  const { pending } = listPending({ file: PENDING });
  assert.equal(pending.some((e) => e.key === '电子木鱼'), false);
});

ok('确认时可以顺手改释义（人话比模型写的准）', () => {
  prop({ key: '赛博上香', meaning: '模型瞎写的' });
  const r = confirmMeme('赛博上香', {
    file: PENDING, memeFile: MEMES, now: T + 1000,
    patch: { meaning: '在线上烧香求个心安，纯玩梗不带宗教意味' }
  });
  assert.equal(r.ok, true);
  assert.equal(find('赛博上香').results[0].meaning, '在线上烧香求个心安，纯玩梗不带宗教意味');
});

console.log('\n去重与拒绝');

ok('已经收录的再提 → 直接说"已经在库里"', () => {
  const r = prop({ key: '典', meaning: '重复' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'duplicate');
  assert.match(r.reason, /已经在梗库/);
});

ok('别名撞上也算重复', () => {
  const r = prop({ key: '典中典中典', aliases: ['典中典'], meaning: '换个说法但其实是同一个' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'duplicate');
});

ok('同一个梗被提两次 → 只累计次数，不新增条目', () => {
  prop({ key: '开摆', meaning: '摆烂' }, T);
  const before = listPending({ file: PENDING }).pending.length;
  prop({ key: '开摆', meaning: '摆烂' }, T + 5000);
  const { pending } = listPending({ file: PENDING });
  assert.equal(pending.length, before, '不该多出一条');
  assert.equal(pending.find((e) => e.key === '开摆').hits, 2);
});

ok('拒绝后清出池子，且之后同一个梗再提会被挡', () => {
  const r1 = rej('开摆');
  assert.equal(r1.ok, true);
  assert.equal(listPending({ file: PENDING }).pending.some((e) => e.key === '开摆'), false);
  const r2 = prop({ key: '开摆', meaning: '摆烂' }, T + 9000);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 'rejected-before', '被拒过的梗不能反复提');
});

ok('被拒的梗换个别名也挡得住', () => {
  const r = prop({ key: '开摆啊', aliases: ['开摆'], meaning: '摆烂' }, T + 10000);
  assert.equal(r.status, 'rejected-before');
});

console.log('\n参数与容量');

ok('没写释义的提案不算候选（省得攒一堆没用的）', () => {
  const r = prop({ key: '空洞梗', meaning: '' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'bad');
});

ok('空 key 也不收', () => {
  assert.equal(prop({ key: '   ', meaning: '有释义没词' }).ok, false);
});

ok('池子满了就拒绝，不淘汰旧的（淘汰会让它反复重提）', () => {
  for (let i = 0; i < PENDING_MAX + 5; i += 1) {
    prop({ key: `批量梗${i}`, meaning: '压测' }, T + 20000 + i);
  }
  const { pending } = listPending({ file: PENDING });
  assert.equal(pending.length, PENDING_MAX);
  const r = prop({ key: '再来一个', meaning: '应该被拒' }, T + 99999);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'full');
});

ok('确认一个不存在的候选会说清楚', () => {
  const r = conf('根本没有这个梗');
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有/);
});

ok('候选文件是合法 JSON（进程被杀也不会留半个文件）', () => {
  const raw = fs.readFileSync(PENDING, 'utf8');
  const j = JSON.parse(raw);
  assert.ok(Array.isArray(j.pending));
  assert.ok(Array.isArray(j.rejected));
  assert.equal(fs.existsSync(`${PENDING}.tmp`), false, '临时文件应该已经 rename 掉');
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项`);
