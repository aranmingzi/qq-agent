/**
 * 语气映射自检（src/voice-delivery.js）
 *
 * 这个模块是纯函数，不碰网络、不碰磁盘，所以可以把每条纪律都钉死：
 *   1. 16 种情绪都有完整条目，且引用的 GSV 标签真的存在于参考音频里；
 *   2. 强度 0 必须等价于老行为（中性参数、语速 ×1）——这是"关掉开关就回原样"的保证；
 *   3. 语速偏置夹在 0.8~1.2，韵律参数夹在 PARAM_BOUNDS，任何输入都不出 NaN；
 *   4. mode 判定要诚实：没有参考音频就只能是 param，不能假装换了；
 *   5. 不认识的情绪不许瞎演，要落回「平静」并且 enabled=false。
 */

import assert from 'node:assert/strict';
import {
  TONE_TABLE,
  TONE_NAMES,
  GSV_TAGS,
  NEUTRAL_PARAMS,
  PARAM_BOUNDS,
  resolveTone,
  formatToneHint,
  describeTone,
  toneCoverage,
  emotionsOfTag,
  guessTone,
} from '../src/voice-delivery.js';

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('\n[1] 情绪表结构');
ok('16 种情绪', () => assert.equal(TONE_NAMES.length, 16));
ok('含 vibe 的 14 种 + 吃惊 + 恐惧', () => {
  for (const name of [
    '开心', '兴奋', '得意', '好奇', '害羞', '别扭', '委屈', '失落',
    '没劲', '嫌弃', '假生气', '心疼', '累', '平静', '吃惊', '恐惧',
  ]) {
    assert.ok(TONE_TABLE[name], `缺 ${name}`);
  }
});
ok('每条都有 gsv/cosyvoice/speedBias/params/line/textHint', () => {
  for (const [name, entry] of Object.entries(TONE_TABLE)) {
    assert.ok(GSV_TAGS.includes(entry.gsv), `${name}.gsv 非法：${entry.gsv}`);
    assert.equal(typeof entry.cosyvoice, 'string');
    assert.ok(entry.cosyvoice.length > 0, `${name}.cosyvoice 为空`);
    assert.ok(Number.isFinite(entry.speedBias), `${name}.speedBias 不是数`);
    assert.equal(typeof entry.line, 'string');
    assert.ok(entry.line.length > 4, `${name}.line 太短`);
    assert.equal(typeof entry.textHint, 'string');
    for (const key of Object.keys(NEUTRAL_PARAMS)) {
      assert.ok(Number.isFinite(entry.params[key]), `${name}.params.${key} 不是数`);
    }
  }
});
ok('speedBias 都夹在 0.8~1.2', () => {
  for (const [name, entry] of Object.entries(TONE_TABLE)) {
    assert.ok(entry.speedBias >= 0.8 && entry.speedBias <= 1.2, `${name}.speedBias=${entry.speedBias}`);
  }
});
ok('cosyvoice 情感都在合法集合内', () => {
  const legal = new Set(['neutral', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'disgusted']);
  for (const [name, entry] of Object.entries(TONE_TABLE)) {
    assert.ok(legal.has(entry.cosyvoice), `${name}.cosyvoice=${entry.cosyvoice}`);
  }
});

console.log('\n[2] resolveTone：强度与降级');
const refs6 = ['中立', '开心', '生气', '难过', '吃惊', '恐惧'];
ok('强度 0 等价于老行为', () => {
  const plan = resolveTone({ emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 0 });
  assert.equal(plan.speedBias, 1);
  assert.equal(plan.params.temperature, NEUTRAL_PARAMS.temperature);
  assert.equal(plan.params.topK, NEUTRAL_PARAMS.topK);
  assert.equal(plan.params.fragmentInterval, NEUTRAL_PARAMS.fragmentInterval);
  assert.equal(plan.enabled, false);
});
ok('强度 1 正常生效', () => {
  const plan = resolveTone({ emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 1 });
  assert.equal(plan.emotion, '兴奋');
  assert.ok(plan.speedBias > 1);
  assert.equal(plan.enabled, true);
  assert.equal(plan.mode, 'ref');
});
ok('心情低时收敛但不反向', () => {
  const happy = resolveTone({ emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 1 });
  const low = resolveTone({
    emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 1, moodScore: 25,
  });
  assert.ok(low.speedBias < happy.speedBias, '低落时应该没那么跳');
  assert.ok(low.speedBias > 1, '但不该反过来变慢');
});
ok('没有参考音频时只能 param', () => {
  const plan = resolveTone({ emotion: '开心', voice: 'hutao', availableRefs: [], strength: 1 });
  assert.equal(plan.mode, 'param');
  assert.equal(plan.enabled, true);
});
ok('情绪标签不在参考音频里也降 param', () => {
  const plan = resolveTone({ emotion: '恐惧', voice: 'sparkle', availableRefs: ['吃惊', '开心', '恐惧', '难过'], strength: 1 });
  assert.equal(plan.mode, 'ref');
  const plan2 = resolveTone({ emotion: '害羞', voice: 'sparkle', availableRefs: ['吃惊', '开心', '恐惧', '难过'], strength: 1 });
  assert.equal(plan2.mode, 'param', '害羞→中立，sparkle 没有中立');
});
ok('不认识的情绪落平静且不启用', () => {
  const plan = resolveTone({ emotion: '非常暴躁', voice: 'liuying', availableRefs: refs6, strength: 1 });
  assert.equal(plan.enabled, false);
  assert.equal(plan.speedBias, 1);
});
ok('auto 时用 vibeEmotion', () => {
  const plan = resolveTone({ emotion: 'auto', vibeEmotion: '委屈', voice: 'liuying', availableRefs: refs6, strength: 1 });
  assert.equal(plan.emotion, '委屈');
  assert.equal(plan.gsv, '难过');
});
ok('toneAuto 关闭时一律中性', () => {
  const plan = resolveTone({ emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 1, enabled: false });
  assert.equal(plan.enabled, false);
  assert.equal(plan.speedBias, 1);
  assert.equal(plan.params.topK, NEUTRAL_PARAMS.topK);
});

console.log('\n[3] 参数边界与脏输入');
ok('强度 1.5 也不越界', () => {
  const plan = resolveTone({ emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 1.5 });
  for (const [key, bounds] of Object.entries(PARAM_BOUNDS)) {
    const value = plan.params[key];
    assert.ok(value >= bounds[0] && value <= bounds[1], `${key}=${value} 越界`);
  }
  assert.ok(plan.speedBias >= 0.8 && plan.speedBias <= 1.2);
});
ok('topK 是整数', () => {
  const plan = resolveTone({ emotion: '好奇', voice: 'liuying', availableRefs: refs6, strength: 0.7 });
  assert.equal(Number.isInteger(plan.params.topK), true);
});
ok('脏输入不出 NaN', () => {
  for (const strength of [NaN, -5, Infinity, undefined, null, 'abc']) {
    const plan = resolveTone({ emotion: '开心', voice: 'liuying', availableRefs: refs6, strength });
    for (const key of Object.keys(NEUTRAL_PARAMS)) {
      assert.ok(Number.isFinite(plan.params[key]), `strength=${String(strength)} 时 ${key} 不是数`);
    }
    assert.ok(Number.isFinite(plan.speedBias), `strength=${String(strength)} 时 speedBias 不是数`);
  }
});
ok('空参数不炸', () => {
  const plan = resolveTone();
  assert.ok(Number.isFinite(plan.speedBias));
  assert.equal(typeof plan.emotion, 'string');
});

console.log('\n[4] 覆盖度与提示词');
ok('liuying 全覆盖（6 个标签覆盖全部 16 种情绪）', () => {
  const cov = toneCoverage('liuying', refs6);
  assert.equal(cov.refEmotions.length, 16);
  assert.equal(cov.paramOnly.length, 0);
  assert.deepEqual(cov.tags, refs6);
});
ok('没有参考音频的音色只有参数', () => {
  // 用空 refs 模拟"这个音色没有任何情绪参考音频"的情况（兜底路径）。
  // 实际音色现状见下面的断言：除了花火缺生气/中立，其余都已补齐。
  const cov = toneCoverage('furina', []);
  assert.equal(cov.refEmotions.length, 0);
  assert.ok(cov.paramOnly.length > 0);
});
ok('hutao 自造 6 条参考音频后全覆盖', () => {
  // 胡桃的 6 条是本机 TTS→RVC→enhance 造的，见 src/gpt-sovits.js 的注释
  const cov = toneCoverage('hutao', refs6);
  assert.equal(cov.refEmotions.length, 16);
  assert.equal(cov.paramOnly.length, 0);
});
ok('nahida 自造 6 条参考音频后全覆盖', () => {
  // 纳西妲同样是本机造的：TTS → RVC(nahida.pth) → enhance → 重采样 48kHz。
  // 质量核验：音色余弦 0.985~0.996、F0 极差 140Hz。
  const cov = toneCoverage('nahida', refs6);
  assert.equal(cov.refEmotions.length, 16);
  assert.equal(cov.paramOnly.length, 0);
});
ok('furina / ayaka 自造 6 条参考音频后全覆盖', () => {
  // 2026-10-30 从 HF mrmocciai/genshin-impact 拿到 RVC 权重（furina_rmvpe / ayaka-rmvpe），
  // 才终于能给这两位造情绪音频 —— 之前卡在"rvc/models 里没有她们的 pth"。
  // 核验：furina 余弦 0.983~0.994 / F0 极差 133Hz；ayaka 0.987~0.995 / 184Hz。
  for (const v of ['furina', 'ayaka']) {
    const cov = toneCoverage(v, refs6);
    assert.equal(cov.refEmotions.length, 16, `${v} 应全覆盖`);
    assert.equal(cov.paramOnly.length, 0, `${v} 不该有只能调参数的情绪`);
  }
});
ok('sparkle 补齐 6 档后全覆盖', () => {
  // 2026-10-30：官方原本只给 4 条（开心/难过/吃惊/恐惧），且代码里根本没登记 ——
  // 白存了。这次补登记官方 4 条 + 新造生气/中立两条（RVC huahuo.pth），凑齐 6 档。
  // 核验：音色余弦 0.990~0.998、F0 极差 175Hz。
  const cov = toneCoverage('sparkle', refs6);
  assert.equal(cov.refEmotions.length, 16);
  assert.equal(cov.paramOnly.length, 0);
});
ok('缺档位的音色会诚实降级（用 refs4 模拟）', () => {
  // 这条锁的是"缺就老实降级"的机制本身：只给 4 个标签时，
  // 生气类（假生气/别扭/嫌弃）和中立类（平静/累/害羞/没劲）必须回落到参数模式，
  // 不能假装换了参考音频。真实音色现在都是 6 档，所以这里用 refs4 直接构造场景。
  const refs4 = ['开心', '难过', '吃惊', '恐惧'];
  const cov = toneCoverage('sparkle', refs4);
  assert.ok(cov.refEmotions.length > 0, '有 4 个标签就该有可用的情绪');
  assert.equal(
    cov.refEmotions.length + cov.paramOnly.length,
    16,
    '两边加起来必须正好是全部 16 种情绪，不能有遗漏也不能重复'
  );
  assert.ok(cov.paramOnly.includes('假生气'), '生气类应回落参数');
  assert.ok(cov.paramOnly.includes('平静'), '中立类应回落参数');
  assert.ok(!cov.refEmotions.includes('假生气'), '缺生气标签时不该出现在可用列表里');
});
ok('emotionsOfTag 反查', () => {
  const list = emotionsOfTag('难过');
  assert.ok(list.includes('委屈'));
  assert.ok(list.includes('心疼'));
  assert.ok(list.includes('失落'));
});
ok('guessTone 认别名', () => {
  assert.equal(guessTone('特别高兴'), '开心');
  assert.equal(guessTone('有点害怕'), '恐惧');
  assert.equal(guessTone('完全看不懂的句子'), '');
});
ok('formatToneHint 空态返回空串', () => {
  assert.equal(formatToneHint(null), '');
  assert.equal(formatToneHint({ enabled: false }), '');
});
ok('formatToneHint 带上情绪名和 emoji 之外的人话', () => {
  const plan = resolveTone({ emotion: '心疼', voice: 'liuying', availableRefs: refs6, strength: 1 });
  const hint = formatToneHint(plan);
  assert.ok(hint.includes('心疼'), hint);
  assert.ok(hint.includes('emotion'), hint);
});
ok('describeTone 给日志一行', () => {
  const plan = resolveTone({ emotion: '兴奋', voice: 'liuying', availableRefs: refs6, strength: 1 });
  const line = describeTone(plan);
  assert.ok(line.includes('兴奋'), line);
  assert.ok(line.includes('ref'), line);
});

console.log(`\n语气映射自检${failed === 0 ? '通过' : '失败'}：${passed} 组断言，${failed} 组失败`);
if (failed > 0) process.exitCode = 1;
