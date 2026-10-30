// 表情包"用得更丰富"的自检：冷却 / 配额 / 场景分散 / 查询排序 / 换发兜底。
// 跑：node test/test-sticker-pick.mjs（秒级、不碰网络、只读系统临时目录）
//
// 这一层守的是**同一个病**：只要一张图"随时可用"，模型就永远选它。
// 所以每条用例都对着一个已经踩过的自锁：
//   ① 3 张常用吃掉 68/90 次发送 → 冷却必须生效；
//   ② useCount=1 的图既不是"常用"也不是"新面孔"→ 变成黑洞，用过一次就再也出现不了；
//   ③ list_stickers 同分按次数降序 → 主动查询也全是老脸。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 产品代码 import 时会读 DATA_DIR，必须先指到临时目录（别动真库）
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-stickers-'));

const {
  normalizeStickerEntry, pickStickerCandidates, formatStickerList,
  rankStickerAlternatives, buildStickerContext, STICKER_SCENES, PICK_COOLDOWN_MS
} = await import('../src/stickers.js');

const NOW = 1_790_000_000_000;
const HOUR = 3600 * 1000;
const SCENES = STICKER_SCENES.filter((s) => s !== '无语');

const mk = (id, opts = {}) => normalizeStickerEntry({
  id,
  resId: id,
  url: `https://example.com/${id}.png`,
  desc: opts.desc || `表情${id}`,
  tags: opts.tags || [],
  usage: opts.usage || '',
  useCount: opts.useCount || 0,
  lastUsedAt: opts.lastUsedAt || 0
});

// 招牌三张：真实数据里 useCount 36 / 21 / 11，今天刚发过
const veterans = [
  mk('v36', { useCount: 36, lastUsedAt: NOW - 1 * HOUR, tags: ['嫌弃'] }),
  mk('v21', { useCount: 21, lastUsedAt: NOW - 2 * HOUR, tags: ['害羞'] }),
  mk('v11', { useCount: 11, lastUsedAt: NOW - 3 * HOUR, tags: ['怼人'] })
];
const crowd = Array.from({ length: 40 }, (_, i) =>
  mk(`new${i}`, { tags: [SCENES[i % SCENES.length]], usage: i % 2 ? '配合吐槽' : '' }));

// 固定随机序列：让"随机"在这份测试里可复现（顺序仍被打乱，只是每次都一样）
function seeded(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

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

/**
 * 目标条目在**所有**随机序列下都不该被选中（返回命中的 seed，0 = 从没出现）。
 * 为什么要扫 20 个 seed：单跑一次靠"随机没抽到"是假绿 —— 闸拆掉了照样绿。
 * 池子必须够大（≥ limit），否则 pickStickerCandidates 会为了"候选不空"主动放宽冷却，
 * 那是产品该有的兜底，但拿它测闸就永远测不出来。
 */
function neverPicked(target, pool, opts = {}) {
  for (let i = 1; i <= 20; i += 1) {
    const picked = pickStickerCandidates(pool, { limit: 8, random: seeded(i * 977), ...opts });
    if (picked.some((e) => e.id === target.id)) return i;
  }
  return 0;
}

console.log('\n冷却：发过的先藏起来');

// ⚠️ 用例必须让"只有一道闸能挡住"，否则两处判据互相兜底 → 拆哪一处都还是绿。
// 6h 冷却和"今日排除"范围高度重叠（都在当天），所以这条用例特意放在凌晨：
// 上次发送是**昨晚**（跨天、不触发今日排除），但只过了 3 小时（只有冷却能挡）。
const nightNow = new Date(NOW).setHours(1, 0, 0, 0);
const lastEvening = nightNow - 3 * HOUR;

ok('6 小时内发过的招牌不进候选（这是"别总用同一张"的真机制）', () => {
  assert.equal(new Date(lastEvening).getDate() !== new Date(nightNow).getDate(), true, '用例前提：跨天');
  const v = { ...veterans[0], lastUsedAt: lastEvening };
  const hit = neverPicked(v, [v, ...crowd.slice(0, 20)], { now: nightNow, dailyCap: 1 });
  assert.equal(hit, 0, `3 小时前刚发过的图又进了候选（seed ${hit}）`);
});

ok('冷却过后老图能回来（不然就是从"霸榜"变成"永不录用"）', () => {
  const stale = veterans.map((v) => ({ ...v, lastUsedAt: NOW - 30 * HOUR }));
  const picked = pickStickerCandidates([...stale, ...crowd], { limit: 8, now: NOW, random: seeded() });
  assert(picked.some((e) => stale.some((v) => v.id === e.id)), '冷却到期仍一张老图都不给，等于把经验清零');
});

// 这条相反：昨天晚上发的不该挡（冷却过了），今天凌晨发的必须挡（一天一张）。
ok('今天已发过的老图当天不再上候选（过了 6h 也一样：一天只发一次）', () => {
  const dayStart = new Date(NOW).setHours(0, 0, 0, 0);
  const late = new Date(NOW).setHours(23, 0, 0, 0);
  const morning = { ...veterans[0], lastUsedAt: dayStart + HOUR };
  assert.equal(late - morning.lastUsedAt > 6 * HOUR, true, '用例前提：距上次发送已超过冷却窗口');
  const hit = neverPicked(morning, [morning, ...crowd.slice(0, 20)], { now: late, dailyCap: 1 });
  assert.equal(hit, 0, `候选里放着它、真发却被 dailyPerIdCap 拦（seed ${hit}），模型会白挨一次拒绝`);
});

ok('全部都在冷却期时不返回空（宁可复用也别让她没图可发）', () => {
  const busy = crowd.map((e) => ({ ...e, lastUsedAt: NOW - 10 * 60 * 1000 }));
  const picked = pickStickerCandidates(busy, { limit: 8, now: NOW, random: seeded() });
  assert.equal(picked.length, 8, '候选空了模型就只能打字');
});

console.log('\n配额：老中青都得有');

ok('用过一次的图不是黑洞（旧逻辑里它既不算常用也不算新面孔）', () => {
  const once = [mk('once1', { useCount: 1, lastUsedAt: NOW - 30 * HOUR, tags: ['嘲讽'] })];
  const picked = pickStickerCandidates([...once, ...crowd.slice(0, 4)], {
    limit: 8, now: NOW, random: seeded()
  });
  assert(picked.some((e) => e.id === 'once1'), '用过一次的图被永久排除，库里会只剩"0 次"和"36 次"两极');
});

ok('候选里不会全是陌生人（至少留 1 张熟脸兜底）', () => {
  const known = [mk('k1', { useCount: 3, lastUsedAt: NOW - 30 * HOUR, tags: ['吐槽'] })];
  const picked = pickStickerCandidates([...known, ...crowd], { limit: 8, now: NOW, random: seeded() });
  assert(picked.some((e) => e.id === 'k1'), '一张熟的都没有，模型会不敢发');
});

ok('候选数够 limit，不多不少', () => {
  const picked = pickStickerCandidates(crowd, { limit: 10, now: NOW, random: seeded() });
  assert.equal(picked.length, 10);
});

ok('老手位不是每轮都给（给了就成固定招牌）', () => {
  const stale = veterans.map((v) => ({ ...v, lastUsedAt: NOW - 30 * HOUR }));
  let withVet = 0;
  const runs = 30;
  for (let i = 0; i < runs; i += 1) {
    const picked = pickStickerCandidates([...stale, ...crowd], { limit: 8, now: NOW, random: seeded(1000 + i) });
    if (picked.some((e) => Number(e.useCount) >= 10)) withVet += 1;
  }
  assert(withVet > 0, '一张熟脸都不给，模型反而不敢发');
  assert(withVet < runs, `老手 ${withVet}/${runs} 轮都在候选里，这又是一张固定招牌`);
});

console.log('\n场景分散：8 个候选得覆盖 8 种语气');

ok('同一场景最多 3 张（否则全是"无语"，还是找不到贴题的）', () => {
  const dull = Array.from({ length: 24 }, (_, i) => mk(`dull${i}`, { tags: ['无语'] }));
  const others = SCENES.slice(0, 12).map((s, i) => mk(`o${i}`, { tags: [s] }));
  const picked = pickStickerCandidates([...dull, ...others], { limit: 8, now: NOW, random: seeded() });
  const same = picked.filter((e) => (e.tags || []).includes('无语')).length;
  assert(same <= 3, `"无语"占了 ${same}/8 个候选`);
});

console.log('\n查询排序：同档内不许"次数多的在前"');

const listFixture = [
  mk('hot', { useCount: 20, lastUsedAt: NOW - 1 * HOUR, tags: ['嘲讽'], usage: '被呛时' }),
  ...Array.from({ length: 6 }, (_, i) => mk(`cool${i}`, { useCount: 0, tags: ['嘲讽'], usage: '阴阳怪气时' }))
];

ok('按场景查，常用那张不会霸在第一位', () => {
  const r = formatStickerList(listFixture, '嘲讽', 3);
  assert(!r.stickers.some((s) => s.id === 'hot'), `结果里还是那张 20 次的: ${r.stickers.map((s) => s.id).join(',')}`);
});

ok('返回字段不再暴露 useCount（露出了就是推荐指数）', () => {
  const r = formatStickerList(listFixture, '嘲讽', 3);
  assert.equal('useCount' in r.stickers[0], false, 'useCount 又把自锁带回来了');
  assert.equal(r.stickers[0].fresh, true);
});

ok('不带 query 的裸列表也不是次数榜', () => {
  const r = formatStickerList(listFixture, '', 3);
  assert.equal(r.stickers[0].id === 'hot', false);
});

console.log('\n换发兜底：别糊同一张');

ok('换发候选优先最近没用过 + 用得最少的', () => {
  const pool = [
    mk('uhot', { useCount: 30, lastUsedAt: NOW - 1 * HOUR, tags: ['吐槽'] }),
    mk('ucold', { useCount: 0, lastUsedAt: 0, tags: ['吐槽'] })
  ];
  const [first] = rankStickerAlternatives(pool, { excludeIds: ['x'], wantTags: ['吐槽'], limit: 2 });
  assert.equal(first.id, 'ucold', '换发又换成了那张最常见的');
});

console.log('\n提示词段');

ok('候选里带「没发过」标记 + 明确"轮换"', () => {
  const ctx = buildStickerContext(crowd, 8, { cooldownMs: PICK_COOLDOWN_MS });
  assert(ctx.includes('没发过'), '不标出来模型对陌生图会犹豫');
  assert(ctx.includes('轮换'), '候选池的语义要写清楚');
  assert(ctx.includes('不用先查'));
});

ok('空库不崩、不吐半截段', () => {
  assert.equal(buildStickerContext([], 8), '');
});

ok('场景索引指向 list_stickers：工具没挂时它就不该出现', () => {
  const withQ = buildStickerContext(crowd, 8, { cooldownMs: PICK_COOLDOWN_MS, canQuery: true });
  const noQ = buildStickerContext(crowd, 8, { cooldownMs: PICK_COOLDOWN_MS, canQuery: false });

  // 这两句都指向 list_stickers，而它在 stickerBox 包里（98% 的轮次没装载）。
  // 摆出来 = 告诉她一个她手上没有的工具。
  assert(withQ.includes('list_stickers'), '能查时要告诉她可以换池子');
  assert(!noQ.includes('list_stickers'), '不能查时就不许提 list_stickers');
  assert(withQ.includes('场景索引'), '能查时才摆场景目录');
  assert(!noQ.includes('场景索引'), '没有钥匙就别摆目录');

  // 但候选必须照给 —— 她用候选里的 id 可以直接 send_sticker（那个工具是常驻的）
  assert(noQ.includes('本轮候选'), '候选与 list_stickers 无关，不能一起砍掉');
  assert(noQ.length < withQ.length, `不能查时该更短，实测 ${withQ.length} → ${noQ.length}`);
});

ok('不传 canQuery 时行为不变（老调用方/离线工具不受影响）', () => {
  // ⚠️ 候选池是**随机轮换**的，两次调用拿到的候选不同 —— 只能比对受 canQuery 影响的那两句，
  //    比全文会得到"看起来像 bug 的随机差异"。
  const dft = buildStickerContext(crowd, 8, { cooldownMs: PICK_COOLDOWN_MS });
  const on = buildStickerContext(crowd, 8, { cooldownMs: PICK_COOLDOWN_MS, canQuery: true });
  for (const k of ['场景索引', 'list_stickers']) {
    assert.equal(dft.includes(k), on.includes(k), `默认与 canQuery:true 对 ${k} 的处理必须一致`);
  }
  assert(dft.includes('场景索引'), '默认仍摆场景索引（老调用方行为不变）');
  assert(dft.includes('list_stickers'), '默认仍提 list_stickers');
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
if (process.exitCode) process.exit(1);
