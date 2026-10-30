// 人设回路（src/vibe.js）自检 —— 26 项，全离线，不等真实时间。
//
// 这些断言锁的是"分寸"，不是"实现"：每条都对应一个会被用户直接感知的行为，
// 改权重/阈值时如果踩到它们，说明手感被改坏了。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EMOTIONS, DEFAULTS, VibeStore, collectSignals, decayBlend, detectSay,
  driftLayers, gapTier, humanGap, isFaceOnly, ledgerFacts, lowMoodDetail, lowMoodOf,
  renderVibe, settingsOf, vibeKey, LOW_MOOD_STRONG, LOW_MOOD_WEAK
} from '../src/vibe.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-vibe-'));
const NOW = 1792500000000; // 固定时间戳，避免"现在"漂移
let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };

const at = (min) => NOW - min * 60000;
const his = (min, text, extra = {}) => ({ self: false, senderId: '1001', text, ts: at(min), mid: `m${min}`, ...extra });
const me = (min, text) => ({ self: true, senderId: '999', text, ts: at(min), mid: `s${min}` });

try {
  // ── 1. 情绪表本身 ────────────────────────────────────────────────────────
  assert.ok(EMOTIONS.平静, '必须有平静兜底');
  for (const [name, e] of Object.entries(EMOTIONS)) {
    assert.ok(String(e.tone || '').length > 4, `${name} 缺 tone`);
    assert.ok(Array.isArray(e.say) && e.say.length >= 1, `${name} 缺 say（表达菜单）`);
    assert.ok(String(e.not || '').length > 4, `${name} 缺 not（硬禁止）`);
    assert.ok(!/^别/.test(e.not), `${name} 的 not 不该以"别"开头（渲染层会加"别："）`);
  }
  ok(`${Object.keys(EMOTIONS).length} 种情绪，每种都有 tone / say / not`);

  // 故意不收的高浓度关系向情绪：这个角色是群里的玩伴，不是恋爱陪伴。
  for (const banned of ['吃醋', '受伤', '崩溃', '撒娇']) {
    assert.ok(!EMOTIONS[banned], `不该收「${banned}」——那是换人格，不是修回路`);
  }
  ok('不吃醋 / 不受伤 / 不崩溃 / 不撒娇：没有越界成恋爱陪伴向');

  // ── 2. 语气判定 ──────────────────────────────────────────────────────────
  assert.ok(detectSay('你好厉害啊').some((h) => h.id === 'praise'), '夸要认出来');
  assert.ok(detectSay('你这脑子是笨死了').some((h) => h.id === 'harsh'), '难听的要认出来');
  assert.ok(detectSay('你敢不敢').some((h) => h.id === 'provoke'), '激将法要认出来');
  assert.ok(!detectSay('今天天气不错').length, '普通闲聊不该有情绪判定');
  ok('夸 / 怼 / 激将 / 普通闲聊 四类判定正确');

  assert.strictEqual(lowMoodOf('今天加班到十点，累死了'), '累死');
  assert.strictEqual(lowMoodOf('累死了刚打完游戏，太爽了'), '累死', '命中就报，不做上下文推理（宁可多接一句情绪）');
  assert.strictEqual(lowMoodOf('我先去睡了'), '');
  ok('对方低落的词表：口语能认，普通话不误伤');

  // ── 2b. 词表分级（v1.4.0 去噪）：日常轻吐槽不该被当成"他此刻很难受" ────────
  // 老版本是一张 64 词的大表，「离谱 / 好烦 / 睡不着 / 头大」单词命中就判低落，
  // 结果群里有人随口一句吐槽，她就得收起幽默去哄人。现在弱信号要攒够两个。
  for (const lone of ['这图好离谱', '我也睡不着', '好烦', '今天麻了', '有点头大']) {
    assert.strictEqual(lowMoodOf(lone), '', `单个日常吐槽不算低落：${lone}`);
    assert.strictEqual(lowMoodDetail(lone).level, '', `level 必须是空：${lone}`);
  }
  ok('弱信号单个不算：离谱 / 睡不着 / 好烦 / 麻了 / 头大 各自命中都不算低落');

  assert.strictEqual(lowMoodOf('好烦啊，头大'), '好烦+头大', '两个弱信号凑一起才算');
  assert.strictEqual(lowMoodDetail('好烦啊，头大').level, 'weak');
  assert.strictEqual(lowMoodDetail('今天真的绷不住了').level, 'strong');
  ok('两个弱信号凑一起才算（"好烦+头大"），强信号单个就算（"绷不住"）');

  assert.ok(LOW_MOOD_STRONG.includes('累死') && !LOW_MOOD_STRONG.includes('离谱'), '强表不收日常吐槽');
  assert.ok(LOW_MOOD_WEAK.includes('离谱') && !LOW_MOOD_WEAK.includes('失业'), '弱表不收真事');
  ok(`两级词表不混：强 ${LOW_MOOD_STRONG.length} 个（真事）/ 弱 ${LOW_MOOD_WEAK.length} 个（吐槽）`);

  // 弱信号不许把"心疼"推到跟真低落一样高（老版本一律 0.20，会连续几轮都在心疼）。
  const loneMood = collectSignals({ recent: [], triggerEntries: [his(1, '好烦')], speakerId: '1001', selfTimes: [], kind: 'private', now: NOW });
  assert.ok(!driftLayers(loneMood).some((l) => l.emotion === '心疼'), '单句吐槽不该让她的心情变成心疼');
  const weakMood = collectSignals({ recent: [], triggerEntries: [his(1, '好烦啊，头大')], speakerId: '1001', selfTimes: [], kind: 'private', now: NOW });
  const weakHeart = driftLayers(weakMood).find((l) => l.emotion === '心疼');
  const strongMood = collectSignals({ recent: [], triggerEntries: [his(1, '我真的绷不住了')], speakerId: '1001', selfTimes: [], kind: 'private', now: NOW });
  const strongHeart = driftLayers(strongMood).find((l) => l.emotion === '心疼');
  assert.ok(weakHeart && strongHeart, '两级信号都要产生心疼');
  assert.ok(weakHeart.intensity < strongHeart.intensity, '弱信号的心疼必须比强信号轻');
  assert.ok(strongHeart.intensity >= 0.18, '真低落要给足分量');
  ok(`分级加权：弱 ${weakHeart.intensity} < 强 ${strongHeart.intensity}（不再一视同仁）`);

  // 渲染措辞也要分级：弱信号不能写"状态不对"那种重话（那是过度哄人的表演）。
  const weakText = renderVibe({ blend: [], cause: '', signals: weakMood, baseline: 50 });
  assert.ok(weakText.includes('有点丧'), '弱信号用留余地的说法');
  assert.ok(!weakText.includes('状态不对'), '弱信号不该用"状态不对"的重话');
  assert.ok(weakText.includes('好烦、头大'), '命中的词要用顿号连成人话，不能吐 "+"');
  const strongText = renderVibe({ blend: [], cause: '', signals: strongMood, baseline: 50 });
  assert.ok(strongText.includes('状态不对') || strongText.includes('心疼'), '强信号照样先接情绪');
  ok('渲染分级：弱信号"有点丧"留余地，强信号才"状态不对 · 先接情绪"');

  // ── 2c. 上下文否决（分级之后剩下的误判，靠词表解决不了）──────────────────
  // 这一层**不是原包带的**：拿本项目 2131 条真实群消息跑出来才看见 ——
  // 原包抽样 101 条、命中 1 条，样本太小，看不出"笑哭了"和"粘贴小说"这两类。
  assert.strictEqual(lowMoodDetail('我真他妈笑哭了').vetoed, '他在笑（笑哭了）');
  assert.strictEqual(lowMoodOf('我真他妈笑哭了'), '', '"笑哭了"是开心，判成心疼是方向错');
  assert.strictEqual(lowMoodOf('我真的绷不住了'), '绷不住', '没带"笑"就照常判');
  assert.strictEqual(lowMoodOf('你被骂了还笑死'), '被骂', '"笑"只否决带"哭"的命中，不能一刀切');
  const novel = `南京总统府，1937年7月6日，夜里十一点。${'他把电报扔到桌上。'.repeat(30)}他崩溃了`;
  assert.ok(novel.length > 120);
  assert.strictEqual(lowMoodOf(novel), '', '转发/粘贴的长文里，情绪词说的是文本里的人');
  assert.strictEqual(lowMoodOf('好家伙，把人唱得绷不住了'), '', '他在评论别人，不是自己难受');
  ok('上下文否决：笑哭了 / 长文粘贴 / 说别人 —— 三类字面命中但方向错的都拦住了');

  assert.ok(isFaceOnly('[表情:笑哭]'), '纯 QQ 表情算"只发表情"');
  assert.ok(isFaceOnly('[表情包:狗头][表情:捂脸]'));
  assert.ok(!isFaceOnly('[表情:笑哭] 你笑什么'), '带文字就不算');
  assert.ok(!isFaceOnly('好好好'));
  ok('"只甩了个表情"的判定不误伤带字消息');

  // ── 3. 账本：只数事实，且群里不乱数 ──────────────────────────────────────
  // 真机上踩过：群里她说 12 条、这个人回 6 条，账本却报"这段基本是你一个人在说"——
  // 那 12 条是跟 4 个人说的。所以"你说的比他多"这条**只在私聊算**。
  const groupRecent = [me(30, '在吗你们'), his(28, '嗯'), me(25, '？'), his(22, '哦'), me(20, '算了')];
  const gSig = collectSignals({ recent: groupRecent, triggerEntries: [his(1, '哦')], speakerId: '1001', selfTimes: [at(30), at(25), at(20)], kind: 'group', now: NOW });
  assert.strictEqual(gSig.ratioEligible, false, '群里不算"你说得多"');
  assert.strictEqual(gSig.shortEligible, false, '群里他只说了 2 条，采样不够');
  assert.deepStrictEqual(ledgerFacts(gSig), [], '采样不够就一句都不说');
  ok('群里不乱算账：他只说 2 条时不记账');

  // 群里他本人说了 4 条，其中 3 条是"嗯/哦/好" —— 这个是真信号，但"你说得多"仍然不算。
  const gMore = collectSignals({
    recent: [me(40, '我来'), me(38, '啊'), me(36, '这'), me(34, '个'), me(32, '好'), his(30, '嗯'), his(28, '哦'), his(26, '好'), his(24, '在')],
    triggerEntries: [his(1, '哦')], speakerId: '1001', selfTimes: [at(40), at(38), at(36), at(34), at(32)], kind: 'group', now: NOW
  });
  assert.strictEqual(gMore.shortEligible, true);
  const gFacts = ledgerFacts(gMore);
  assert.ok(gFacts.some((f) => /只回两三个字|连着/.test(f)), '他连着回几个字要记');
  assert.ok(!gFacts.some((f) => /你说了/.test(f)), '群里绝不能说"你说了 N 条他才回 M 条"');
  ok('群里：他连着回几个字会记，但不算"你比他话多"');

  const pSig = collectSignals({ recent: [me(20, '在吗'), his(18, '嗯'), me(15, '干啥呢'), his(12, '[表情:笑哭]')], triggerEntries: [his(1, '哦')], speakerId: '1001', selfTimes: [at(20), at(15)], kind: 'private', now: NOW });
  const facts = ledgerFacts(pSig);
  assert.ok(facts.length >= 1, '私聊里他连着几个字就该记账');
  assert.ok(facts.every((f) => /条|表情/.test(f)), '账本只说数量，不下判断');
  assert.ok(facts.join('').length <= 80, '账本要短');
  ok('私聊记账：只报数量（几条 / 几个字 / 几个表情），不带评价');

  // ── 4. 衰减：连续淡下去，不整点跳变 ──────────────────────────────────────
  const blend0 = [{ emotion: '委屈', intensity: 0.4 }];
  const d0 = decayBlend(blend0, NOW, NOW);
  const half = decayBlend(blend0, NOW, NOW + DEFAULTS.halfLifeMin * 60000);
  const almost = decayBlend(blend0, NOW, NOW + DEFAULTS.halfLifeMin * 60000 - 60000);
  assert.ok(Math.abs(d0[0].intensity - 0.4) < 1e-9, '刚发生时不衰减');
  assert.ok(Math.abs(half[0].intensity - 0.2) < 1e-9, '一个半衰期正好掉一半');
  assert.ok(almost[0].intensity > 0.2 && almost[0].intensity < 0.21, '半衰期前一分钟是连续值，不是阶梯');
  assert.deepStrictEqual(decayBlend(blend0, NOW, NOW + 24 * 3600 * 1000), [], '一天后淡到不显示');
  ok('半衰期：40 分钟掉一半，连续衰减，没有整点跳变');

  // ── 5. 弱信号要攒，强信号当场就有 ────────────────────────────────────────
  const weak = collectSignals({ recent: [his(20, '嗯'), his(18, '哦')], triggerEntries: [his(1, '嗯')], speakerId: '1001', selfTimes: [], kind: 'private', now: NOW });
  assert.ok(!renderVibe({ blend: [], cause: '', signals: weak, baseline: 50 }).includes('此刻的心情'), '单轮的"回得短"不该当场变脸');
  ok('弱信号（只回两三个字）单轮不上脸');

  const harshSig = collectSignals({ recent: [], triggerEntries: [his(1, '你这脑子是笨死了')], speakerId: '1001', selfTimes: [], kind: 'private', now: NOW });
  const harshBlend = [{ emotion: '委屈', intensity: 0.18 }];
  assert.ok(renderVibe({ blend: harshBlend, cause: '他说了难听的', signals: harshSig, baseline: 50 }).includes('【你此刻的心情】'), '被怼要当场有反应');
  ok('强信号（被怼）当场就上脸');

  // ── 6. 沉默档：三档，且不升级成人格崩塌 ──────────────────────────────────
  assert.strictEqual(gapTier(5 * 60000), null, '5 分钟不算什么');
  assert.strictEqual(gapTier(30 * 60000).name, 'waiting');
  assert.strictEqual(gapTier(2 * 3600000).name, 'miffed');
  assert.strictEqual(gapTier(10 * 3600000).name, 'moved-on');
  assert.ok(gapTier(30 * 60000).maxMsgs <= 1, '第一档最多主动补 1 条');
  assert.ok(gapTier(2 * 3600000).not.includes('冷暴力'), '第二档要写清"别赌气不理人"');
  assert.ok(!gapTier(10 * 3600000).not.includes('不要我'), '最重一档也不许出现"你是不是不要我了"（那是恋爱陪伴向）');
  ok('沉默三档：10 分钟 / 1 小时 / 6 小时，最重也只到"别扭"，不到崩塌');

  assert.strictEqual(humanGap(45 * 1000), '不到一分钟');
  assert.strictEqual(humanGap(30 * 60000), '30 分钟');
  assert.strictEqual(humanGap(3 * 3600000), '3 小时');
  assert.strictEqual(humanGap(26 * 3600000), '1 天');
  ok('时间人话：不到一分钟 / 30 分钟 / 3 小时 / 1 天');

  // ── 7. 渲染：空就是空，别硬凑 ────────────────────────────────────────────
  assert.strictEqual(renderVibe({ blend: [], cause: '', signals: null, baseline: 50 }), '', '什么都没有就返回空串');
  assert.strictEqual(renderVibe({ blend: [], cause: '', signals: null, baseline: 50, settings: { ...DEFAULTS, enabled: false } }), '', '关掉就一个字符都不注入');
  ok('自然优先：没情绪不注入，关掉就真关');

  const neutral = collectSignals({ recent: [me(5, '在吗'), his(3, '在的，啥事')], triggerEntries: [his(1, '在的，啥事')], speakerId: '1001', selfTimes: [at(5)], kind: 'private', now: NOW });
  assert.strictEqual(renderVibe({ blend: [], cause: '', signals: neutral, baseline: 50 }), '', '正常一问一答不该冒出提示');
  ok('正常一问一答：完全不打扰');

  const block = renderVibe({
    blend: [{ emotion: '委屈', intensity: 0.3 }, { emotion: '别扭', intensity: 0.16 }],
    cause: '他说了难听的',
    signals: harshSig,
    baseline: 74
  });
  assert.ok(block.includes('委屈里带一点别扭'), '主情绪 + 副层要合成一句话');
  assert.ok(block.includes('可以：') && block.includes('别：'), '每个情绪都要给表达菜单和禁止项');
  assert.ok(block.includes('【底色】'), '底色明显偏高时要提一句');
  assert.ok(block.length < 600, `单轮注入不该超过 600 字（当前 ${block.length}）`);
  ok(`渲染块结构完整且受控（${block.length} 字 < 600）`);

  // 脏数据防线：vibe.json 里留了个已经不存在的情绪名，不能把整轮提示词炸掉。
  const hi = renderVibe({ blend: [{ emotion: '心愿', intensity: 1 }], cause: '', signals: null, baseline: 50, settings: DEFAULTS });
  assert.strictEqual(hi, '', '未知情绪直接跳过，不渲染、不崩');
  const mixed = renderVibe({ blend: [{ emotion: '心愿', intensity: 1 }, { emotion: '开心', intensity: 0.3 }], cause: '', signals: null, baseline: 50 });
  assert.ok(mixed.includes('开心'), '未知情绪跳过之后，认识的那个照常渲染');
  ok('未知情绪不会渲染出脏字，也不会把整轮弄崩');

  // ── 8. 状态隔离与存储 ────────────────────────────────────────────────────
  assert.strictEqual(vibeKey('group:1', '1001'), 'group:1|1001');
  assert.strictEqual(vibeKey('group:1', ''), 'group:1', '拿不到人号就退回按会话存');
  ok('状态按「会话 + 人」存：同一个群里，跟 A 别扭不影响跟 B 说话');

  const file = path.join(tempDir, 'vibe.json');
  const store = new VibeStore(file);
  const k = vibeKey('group:1', '1001');
  store.observe(k, [{ emotion: '开心', intensity: 0.2 }], '被夸了', { now: NOW });
  const kept = new VibeStore(file).get(k, NOW);
  assert.strictEqual(kept.blend[0].emotion, '开心', '换一个实例也要读得到（落盘了）');
  assert.strictEqual(kept.cause, '被夸了');
  assert.deepStrictEqual(new VibeStore(file).get(k, NOW + 6 * 3600 * 1000).blend, [], '6 小时后自然淡掉');
  ok('落盘 + 冷却：重启还在，六小时后自己淡掉');

  // 弱信号必须能攒起来（踩过的坑：dropBelow 设太大，0.06 每次读盘就被筛掉，攒十轮还是 0.06）
  const s2 = new VibeStore(path.join(tempDir, 'vibe2.json'));
  const k2 = vibeKey('private:2', '2002');
  for (let i = 0; i < 3; i += 1) s2.observe(k2, [{ emotion: '别扭', intensity: 0.06 }], '小别扭', { now: NOW });
  assert.ok(Math.abs(s2.get(k2, NOW).blend[0].intensity - 0.18) < 1e-9, '0.06 × 3 必须能攒到 0.18');
  ok('小信号能累加：0.06 攒三轮 = 0.18（不会再被读盘筛掉）');

  const s3 = new VibeStore(path.join(tempDir, 'vibe3.json'));
  const k3 = vibeKey('group:3', '3003');
  for (let i = 0; i < 6; i += 1) s3.observe(k3, [{ emotion: '兴奋', intensity: 0.4 }, { emotion: '开心', intensity: 0.4 }, { emotion: '得意', intensity: 0.4 }], '叠太多', { now: NOW });
  const sum3 = s3.get(k3, NOW).blend.reduce((a, b) => a + b.intensity, 0);
  assert.ok(sum3 <= DEFAULTS.ceiling + 1e-9, `总强度必须封顶在 ${DEFAULTS.ceiling}（当前 ${sum3.toFixed(2)}）`);
  ok('情绪叠加有总强度上限：叠太多会被压回去，不会每句都在演');

  // ── 9. 配置容错 ──────────────────────────────────────────────────────────
  assert.strictEqual(settingsOf(null).halfLifeMin, DEFAULTS.halfLifeMin);
  assert.strictEqual(settingsOf({ enabled: false }).enabled, false);
  assert.strictEqual(settingsOf({ 乱写: 1 }).乱写, undefined, '不认识的键不该混进设置');
  assert.strictEqual(settingsOf({ halfLifeMin: 0 }).halfLifeMin, 0, '用户显式写的值要尊重');
  ok('配置容错：缺省值、关开关、脏键、显式 0 都处理了');

  console.log(`\n人设回路自检通过：${n} 组断言`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
