// 拍一拍 / @ 的自检：事件解析、去重键、分寸（冷却/心情/深夜）、名字找号。
// 跑：node test/test-gesture.mjs（秒级、不碰网络、不等真实时间）
import assert from 'node:assert/strict';

const {
  parsePokeEvent, pokeTextOf, pokeBudget, shouldPokeBack, pokeStreak, atBudget, matchMember, describeMembers, POKE_MARK
} = await import('../src/gesture.js');
const { decideWake } = await import('../src/reply-gate.js');

const SELF = '999000111';
const at = (h, m = 0) => new Date(2026, 9, 19, h, m, 0).getTime();   // 本地时间，2026-10-19

function pokeEvent(changes = {}) {
  return {
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    self_id: Number(SELF), group_id: 456, user_id: 789, target_id: Number(SELF), time: 100,
    ...changes
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

console.log('— 入站：这一拍是不是冲我来的 —');

ok('群里拍我 → aboutSelf', () => {
  const p = parsePokeEvent(pokeEvent(), SELF);
  assert.equal(p.ok, true);
  assert.equal(p.aboutSelf, true);
  assert.equal(p.chatKey, 'group:456');
  assert.equal(p.fromId, '789');
});

ok('群里拍别人 → 不是我，不唤醒', () => {
  const p = parsePokeEvent(pokeEvent({ target_id: 888 }), SELF);
  assert.equal(p.ok, true);
  assert.equal(p.aboutSelf, false);
});

ok('私聊拍我（target_id 缺省由协议端给 user_id）', () => {
  const p = parsePokeEvent(pokeEvent({ group_id: null, target_id: Number(SELF) }), SELF);
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'private');
  assert.equal(p.chatKey, 'private:789');
  assert.equal(p.aboutSelf, true);
});

ok('私聊没给 target_id 也算拍我（私聊只有两个人）', () => {
  const p = parsePokeEvent(pokeEvent({ group_id: null, target_id: null }), SELF);
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'private');
  assert.equal(p.aboutSelf, true);
});

ok('群里 target_id 缺失 → 不触发（绝不猜成"拍我"）', () => {
  assert.equal(parsePokeEvent(pokeEvent({ target_id: null }), SELF).ok, false);
  assert.equal(parsePokeEvent(pokeEvent({ target_id: 0 }), SELF).ok, false);
  assert.equal(parsePokeEvent(pokeEvent({ target_id: '' }), SELF).ok, false);
});

ok('自己拍的（事件回显）直接丢', () => {
  assert.equal(parsePokeEvent(pokeEvent({ user_id: Number(SELF) }), SELF).ok, false);
  assert.equal(parsePokeEvent(pokeEvent({ user_id: 111, sender_id: Number(SELF) }), SELF).ok, false);
});

ok('不是 poke 的事件不认', () => {
  assert.equal(parsePokeEvent(pokeEvent({ notice_type: 'group_ban' }), SELF).ok, false);
  assert.equal(parsePokeEvent(pokeEvent({ sub_type: 'other' }), SELF).ok, false);
  assert.equal(parsePokeEvent(null, SELF).ok, false);
});

ok('去重键：同一次不同时间算两次，同一个算一次', () => {
  const a = parsePokeEvent(pokeEvent(), SELF).dedupeKey;
  const b = parsePokeEvent(pokeEvent(), SELF).dedupeKey;
  const c = parsePokeEvent(pokeEvent({ time: 101 }), SELF).dedupeKey;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

console.log('— 正文 —');

ok('拍我写成"拍了拍你"（闸门靠这句话叫醒它）', () => {
  const p = parsePokeEvent(pokeEvent(), SELF);
  const text = pokeTextOf(p, { fromName: '小明', selfId: SELF });
  assert.ok(text.startsWith(POKE_MARK));
  assert.ok(text.includes('拍了拍你'));
});

ok('拍别人写清是谁拍谁', () => {
  const p = parsePokeEvent(pokeEvent({ target_id: 888 }), SELF);
  assert.equal(pokeTextOf(p, { fromName: '小明', targetName: '小红', selfId: SELF }), '[拍一拍] 小明 拍了拍 小红');
});

ok('自己拍自己', () => {
  const p = parsePokeEvent(pokeEvent({ user_id: 888, target_id: 888 }), SELF);
  assert.equal(pokeTextOf(p, { fromName: '小明', selfId: SELF }), '[拍一拍] 小明 拍了拍自己');
});

console.log('— 闸门认"被拍" —');

ok('拍了拍你 → 唤醒理由 poke（掷中说句话）', () => {
  const d = decideWake({
    kind: 'group',
    entries: [{ text: '[拍一拍] 小明 拍了拍你' }],
    cfg: { gate: { enabled: true, probability: 0, pokeReplyProb: 0.6 } },
    now: at(15),
    rng: () => 0.1          // 掷中
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'poke');
});

ok('被拍但掷不中 → 不唤醒（回拍已经在入站做完了，不说话也正常）', () => {
  const d = decideWake({
    kind: 'group',
    entries: [{ text: '[拍一拍] 小明 拍了拍你' }],
    cfg: { gate: { enabled: true, probability: 0, pokeReplyProb: 0.6 } },
    now: at(15),
    rng: () => 0.9          // 掷不中
  });
  assert.equal(d.wake, false);
  assert.equal(d.reason, 'poke-quiet');
});

ok('pokeReplyProb=1 → 每次被拍都接一句', () => {
  const d = decideWake({
    kind: 'group',
    entries: [{ text: '[拍一拍] 小明 拍了拍你' }],
    cfg: { gate: { enabled: true, pokeReplyProb: 1 } },
    now: at(15),
    rng: () => 0.999
  });
  assert.equal(d.wake, true);
  assert.equal(d.reason, 'poke');
});

ok('dryRun 演练开着也照样可以不接话（这条判据不演练）', () => {
  const d = decideWake({
    kind: 'group',
    entries: [{ text: '[拍一拍] 小明 拍了拍你' }],
    cfg: { gate: { enabled: true, dryRun: true, pokeReplyProb: 0.6 } },
    now: at(15),
    rng: () => 0.9
  });
  assert.equal(d.wake, false);
  assert.equal(d.reason, 'poke-quiet');
});

ok('别人之间拍 → 不因它唤醒', () => {
  const d = decideWake({
    kind: 'group',
    entries: [{ text: '[拍一拍] 小明 拍了拍 小红' }],
    cfg: { gate: { enabled: true, probability: 0 } },
    now: at(15)
  });
  assert.equal(d.wake, false);
});

console.log('— 出站分寸：拍 —');

ok('正常情况可以拍', () => {
  const v = pokeBudget({ now: at(15), moodScore: 60, cfg: {} });
  assert.equal(v.allow, true);
  assert.ok(v.delayMs >= 0);
});

ok('同一会话 45 秒内不重复', () => {
  const v = pokeBudget({ now: at(15, 0) + 10000, lastPokeAt: at(15, 0), moodScore: 60 });
  assert.equal(v.allow, false);
  assert.ok(v.reason.includes('刚拍过'));
});

ok('同一个人 20 分钟内不重复', () => {
  const v = pokeBudget({
    now: at(15, 30), lastPokeAt: 0, targetId: '789',
    lastPokeToTargetAt: at(15, 20), moodScore: 60
  });
  assert.equal(v.allow, false);
});

ok('一轮最多一次', () => {
  assert.equal(pokeBudget({ now: at(15), moodScore: 60, pokesThisRun: 1 }).allow, false);
});

ok('深夜 0~6 点不主动拍', () => {
  assert.equal(pokeBudget({ now: at(3), moodScore: 70 }).allow, false);
  assert.equal(pokeBudget({ now: at(6), moodScore: 70 }).allow, true);   // 6 点整已过点
});

ok('心情低落不主动招惹，但被拍可以回拍', () => {
  assert.equal(pokeBudget({ now: at(15), moodScore: 20 }).allow, false);
  assert.equal(pokeBudget({ now: at(15), moodScore: 20, inbound: true, lastPokeAt: 0 }).allow, true);
});

ok('回拍也有手速限制（8 秒）', () => {
  const now = at(15, 0) + 3000;
  assert.equal(pokeBudget({ now, moodScore: 60, inbound: true, lastPokeAt: at(15, 0) }).allow, false);
});

console.log('— 自动回拍（别人拍我 → 立刻拍回去）—');

ok('第一次被拍就回拍，深夜/低心情也照回', () => {
  assert.equal(shouldPokeBack({ now: at(3), fromId: '789' }).allow, true);
  assert.equal(shouldPokeBack({ now: at(15), fromId: '789', cfg: { sadMoodBelow: 100 } }).allow, true);
});

ok('同一个人 60 秒内只回一次（挡住连拍）', () => {
  const now = at(15, 1);
  const v = shouldPokeBack({ now, fromId: '789', lastBackAt: now - 20000, lastBackTargetId: '789' });
  assert.equal(v.allow, false);
  assert.ok(v.reason.includes('刷屏'));
});

ok('换个人被拍可以回（不受别人那一次的影响）', () => {
  const now = at(15, 1);
  const v = shouldPokeBack({ now, fromId: '790', lastBackAt: now - 20000, lastBackTargetId: '789' });
  assert.equal(v.allow, true);
});

ok('60 秒前回过，现在可以再回', () => {
  const now = at(15, 5);
  const v = shouldPokeBack({ now, fromId: '789', lastBackAt: now - 61000, lastBackTargetId: '789' });
  assert.equal(v.allow, true);
});

console.log('— 出站分寸：@ —');

ok('私聊不能 @', () => {
  assert.equal(atBudget({ kind: 'private', targetId: '789' }).allow, false);
});

ok('群里一轮最多一个', () => {
  assert.equal(atBudget({ kind: 'group', targetId: '789', atsThisRun: 0 }).allow, true);
  assert.equal(atBudget({ kind: 'group', targetId: '789', atsThisRun: 1 }).allow, false);
});

ok('不知道 @ 谁就不 @', () => {
  assert.equal(atBudget({ kind: 'group', targetId: '' }).allow, false);
});

console.log('— 名字找号 —');

const members = [
  { id: '789', name: '小明' },
  { id: '790', name: '小明同学' },
  { id: '791', name: '小红' }
];

ok('QQ 号直接命中', () => {
  assert.equal(matchMember('791', members).name, '小红');
});

ok('昵称精确命中', () => {
  assert.equal(matchMember('小红', members).id, '791');
});

ok('唯一包含匹配也能用', () => {
  assert.equal(matchMember('小红红', members).id, '791');
});

ok('重名/对不上就不猜', () => {
  assert.equal(matchMember('小明', members).id, '789');     // 精确优先，不算重名
  assert.equal(matchMember('小', members), null);           // 多个候选 → null
  assert.equal(matchMember('不存在的人', members), null);
  assert.equal(matchMember('', members), null);
});

ok('成员提示文案可读', () => {
  assert.equal(describeMembers(members.slice(0, 2)), '小明(789)、小明同学(790)');
});

// ── 连戳炸毛 ──────────────────────────────────────────────────────────────
// 分寸靠断言锁住，不靠感觉：第 1~3 下正常，第 4 下起不再回拍；
// 隔太久（默认 5 分钟）重新从 1 数；阈值可配。
const G = { pokeStreakResetMs: 5 * 60 * 1000, pokeAngryAt: 4 };
const T0 = at(15, 0);

function chain(gapsMs) {
  let s = { count: 0, lastAt: 0 };
  const out = [];
  let t = T0;
  for (const gap of gapsMs) {
    t += gap;
    const r = pokeStreak({ count: s.count, lastAt: s.lastAt, now: t, cfg: G });
    out.push(r);
    s = { count: r.count, lastAt: t };
  }
  return out;
}

ok('连戳：前三下还陪玩，第四下起毛了', () => {
  const r = chain([0, 60000, 60000, 60000]);
  assert.deepEqual(r.map((x) => x.count), [1, 2, 3, 4]);
  assert.deepEqual(r.map((x) => x.angry), [false, false, false, true]);
});

ok('连戳：第三下给个"有点勤"的提示，但不拦回拍', () => {
  const r = chain([0, 60000, 60000]);
  assert.equal(r[2].level, 'annoyed');
  assert.equal(r[2].angry, false, '只是攒着，还没到能甩脸色的程度');
  assert.match(r[2].note, /第 3 下/);
});

ok('连戳：隔超过 5 分钟重新从 1 数', () => {
  const r = chain([0, 60000, 60000, 60000, 6 * 60 * 1000]);
  assert.equal(r[4].count, 1);
  assert.equal(r[4].angry, false, '人家隔了六分钟才戳一下，不算骚扰');
});

ok('连戳：到点后继续戳一直算"还毛着"，不会自己降回去', () => {
  const r = chain([0, 60000, 60000, 60000, 60000, 60000]);
  assert.equal(r[5].angry, true);
  assert.match(r[5].note, /连着戳了你 6 下/);
});

ok('连戳：阈值可配，没人能把它配成"两下就炸"', () => {
  const one = pokeStreak({ count: 0, lastAt: 0, now: T0, cfg: { pokeAngryAt: 1 } });
  assert.equal(one.angry, false, '至少 2 下才可能毛（Math.max(2, …) 兜底）');
  const two = pokeStreak({ count: 1, lastAt: T0 - 1000, now: T0, cfg: { pokeAngryAt: 2 } });
  assert.equal(two.angry, true);
});

ok('连戳：没到阈值时 note 为空，不往存档里塞噪音', () => {
  const r = pokeStreak({ count: 0, lastAt: 0, now: T0, cfg: G });
  assert.equal(r.note, '');
  assert.equal(r.level, 'calm');
});

console.log(`\n通过 ${pass} 项`);
