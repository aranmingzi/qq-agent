// 多人并发应答（crowd.js / waiting 的 crowd 窗口 / 提示词那段）的行为断言。
//
// 这几条判据的共同点是"它们决定群里看到的样子"：
//   · 谁算"在等我"—— 只有 @我/引用我/点我名/@全体，别人的话不算；
//   · 几个人算几个 —— 一个人连发三条算一个，不是三个；
//   · 窗口要放宽 —— 否则第二个人必然落进下一轮，退化成"一人一条"；
//   · 有硬顶 —— 一群人轮流 @ 时不能永远重置计时器。
//
// 全部是纯函数，不需要起服务、不等真实时间。
import assert from 'node:assert';

import { crowdOf, isMultiAsk, describeCrowd, CROWD_LEVEL } from '../src/crowd.js';
import { mergeWindowMs, capWait, MERGE_DEFAULTS } from '../src/waiting.js';
import { renderCrowd } from '../src/prompt.js';

const NOW = 1000000;

/** 群聊口径的默认入参：它自己叫「小鲸鱼」，QQ 999。 */
const OPT = {
  kind: 'group',
  selfIds: ['999'],
  selfNickname: '小鲸鱼',
  aliases: ['小鲸鱼', '鲸鱼'],
  now: NOW
};

const m = (senderId, senderName, text, extra = {}) => ({
  senderId, senderName, text, ts: extra.ts ?? 1000, ...extra
});

// ── ① 没人找它 ────────────────────────────────────────────────────────
{
  const r = crowdOf([], OPT);
  assert.equal(r.level, CROWD_LEVEL.NONE);
  assert.equal(r.totalAskers, 0);
  assert.equal(isMultiAsk(r), false);
}

// ── ② 一个人在跟它说 → solo，提示词不该多说一句 ─────────────────────────
{
  const r = crowdOf([m('1', '阿伟', '今晚几点开黑？', { atSelf: true })], OPT);
  assert.equal(r.level, CROWD_LEVEL.SOLO);
  assert.equal(r.totalAskers, 1);
  assert.equal(isMultiAsk(r), false);
  assert.equal(renderCrowd(r), '', '只有一个人时这一段必须整段不出现');
}

// ── ③ 两个人都在 @ 它 → pair，且**先问的排前面** ────────────────────────
{
  const r = crowdOf([
    m('1', '阿伟', '今晚几点开黑？', { atSelf: true, ts: 1000 }),
    m('2', '小鱼', '刚才那个梗是什么', { atSelf: true, ts: 2000 })
  ], OPT);
  assert.equal(r.level, CROWD_LEVEL.PAIR);
  assert.equal(r.totalAskers, 2);
  assert.deepEqual(r.askers.map((a) => a.name), ['阿伟', '小鱼']);
  assert.equal(isMultiAsk(r), true);

  const text = renderCrowd(r);
  assert.ok(text.includes('这两个人都在跟你说话'), '两个人时用轻一点的措辞');
  assert.ok(text.includes('阿伟') && text.includes('小鱼'), '两个人都要列出来');
  assert.ok(text.includes('最多两条消息'), '要有"别一人一条"的量级约束');
  assert.ok(!/@阿伟[：:]/.test(text), '不能拼成"@谁：…"的成品句式（那就是模板了）');
}

// ── ④ 一个人连发三条只算一个（人数不是条数）──────────────────────────
{
  const r = crowdOf([
    m('1', '阿伟', '在吗', { atSelf: true, ts: 1000 }),
    m('1', '阿伟', '问你个事', { atSelf: true, ts: 1100 }),
    m('1', '阿伟', '今晚几点开黑？', { atSelf: true, ts: 1200 }),
    m('2', '小鱼', '我也想问', { atSelf: true, ts: 1300 })
  ], OPT);
  assert.equal(r.totalAskers, 2, '连发三条还是一个人');
  assert.equal(r.askers[0].msgs, 3);
  assert.deepEqual(r.askers[0].asks, ['今晚几点开黑？'], '敲门话（在吗/问你个事）不该占一个诉求位');
  assert.equal(r.askers[0].ask, '今晚几点开黑？');
}

// ── ④b 同一个人的两件不同的事，都要留在提示词里 ────────────────────────
// 这是"漏掉某人"最难查的成因：不是没看到人，是没看到那件事。
{
  const r = crowdOf([
    m('1', '阿伟', '你上次说的那个配置发我一下', { atSelf: true, ts: 1000 }),
    m('1', '阿伟', '今晚几点开黑？', { atSelf: true, ts: 2000 }),
    m('2', '小鱼', '那个梗是什么', { atSelf: true, ts: 3000 })
  ], OPT);
  assert.deepEqual(r.askers[0].asks, ['你上次说的那个配置发我一下', '今晚几点开黑？']);
  assert.ok(renderCrowd(r).includes('配置'), '渲染出来的提示词里不能丢掉前一件事');
}

// ── ⑤ 明确对别人说的不算"在等我"（最关键的一条）──────────────────────
{
  const r = crowdOf([
    m('1', '阿伟', '@小鱼 你别理他', { atOthers: ['2'], ts: 1000 }),
    m('2', '小鱼', '你俩聊', { ts: 1100 })
  ], OPT);
  assert.equal(r.totalAskers, 0, '旁人的对谈不是待办');
  assert.equal(r.level, CROWD_LEVEL.NONE);
  assert.equal(r.backdropCount, 2);
  assert.equal(renderCrowd(r), '');
}

// 同一个人先 @ 它、后聊别的 → 他仍是"在等我"的那个人，不能被算进旁观者
{
  const r = crowdOf([
    m('1', '阿伟', '在吗', { atSelf: true, ts: 1000 }),
    m('1', '阿伟', '算了当我没说', { ts: 1100 })
  ], OPT);
  assert.equal(r.totalAskers, 1);
  assert.equal(r.backdropCount, 0, '只要说过一句在等我，就不能把他当成背景');
}

// ── ⑥ @全体成员 记下来（措辞要能区分"叫我一个人"和"叫所有人"）─────────
{
  const r = crowdOf([
    m('1', '阿伟', '@全体成员 开会了', { atOthers: ['all'], ts: 1000 }),
    m('2', '小鱼', '来了', { atSelf: true, ts: 1100 })
  ], OPT);
  assert.equal(r.broadcast, true);
  assert.equal(r.totalAskers, 2);
  assert.ok(renderCrowd(r).includes('@全体'));
}

// ── ⑦ 超过 maxAskers 只报数量（别把提示词撑成花名册）──────────────────
{
  const r = crowdOf(
    [1, 2, 3, 4, 5].map((i) => m(String(i), `群友${i}`, '在吗', { atSelf: true, ts: 1000 + i })),
    { ...OPT, maxAskers: 3 }
  );
  assert.equal(r.level, CROWD_LEVEL.CROWD);
  assert.equal(r.askers.length, 3);
  assert.equal(r.more, 2);
  assert.ok(renderCrowd(r).includes('还有 2 个人也在找你'));
}

// ── ⑧ 私聊不存在"多人"，但结构要完整（调用方不用到处判空）───────────────
{
  const r = crowdOf([
    m('7', '阿伟', '在吗', { ts: 1000 }),
    m('7', '阿伟', '人呢', { ts: 2000 })
  ], { ...OPT, kind: 'private' });
  assert.equal(r.level, CROWD_LEVEL.SOLO);
  assert.equal(r.totalAskers, 1);
  assert.equal(r.senders ?? r.senderCount, 1);
  assert.equal(renderCrowd(r), '');
}

// ── ⑨ 合并窗口：多人时放宽，但只能放宽不能收紧 ─────────────────────────
{
  assert.equal(mergeWindowMs({ urgent: true, normalMs: 1800, directMs: 500 }), 500, '单人被 @ 还是 500ms 直通');
  assert.equal(
    mergeWindowMs({ urgent: true, crowd: true, normalMs: 1800, directMs: 500, crowdMs: 2600 }),
    2600, '两个人在等 → 等他们说完，否则第二个人必然落到下一轮'
  );
  assert.equal(
    mergeWindowMs({ urgent: false, crowd: true, normalMs: 1800, directMs: 500, crowdMs: 2600 }),
    2600
  );
  assert.equal(
    mergeWindowMs({ urgent: false, crowd: true, normalMs: 1800, directMs: 500, crowdMs: 1000 }),
    1800, 'crowdMs 配得比普通窗口短时不许反而更短'
  );
  assert.equal(MERGE_DEFAULTS.crowdMs, 2600);
}

// ── ⑩ 硬顶：一群人轮流 @ 时，不能每句都把计时器重置到天荒地老 ──────────
{
  assert.equal(capWait({ since: 1000, now: 2000, windowMs: 2600, maxWaitMs: 6000 }), 2600, '没到硬顶就用窗口');
  assert.equal(capWait({ since: 1000, now: 6000, windowMs: 2600, maxWaitMs: 6000 }), 1000, '只剩 1 秒就只等 1 秒');
  assert.equal(capWait({ since: 1000, now: 9000, windowMs: 2600, maxWaitMs: 6000 }), 0, '超了立刻进场，不许再拖');
  assert.equal(capWait({ since: 1000, now: 9000, windowMs: 2600, maxWaitMs: 0 }), 2600, 'maxWaitMs=0 表示不设上限');
}

// ── ⑪ 日志行：要能一眼看出这轮为什么是"多人" ──────────────────────────
{
  const r = crowdOf([
    m('1', '阿伟', '几点开黑？', { atSelf: true, ts: 1000 }),
    m('2', '小鱼', '那个梗', { atSelf: true, ts: 1500 }),
    m('3', '老张', '今天好热', { ts: 1600 })
  ], OPT);
  const line = describeCrowd('group:123', r);
  assert.ok(line.includes('2 人在等你'));
  assert.ok(line.includes('阿伟') && line.includes('小鱼'));
  assert.ok(line.includes('另有 1 人在聊别的'));
}

console.log('[crowd] 多人并发应答 12 组断言全部通过');
