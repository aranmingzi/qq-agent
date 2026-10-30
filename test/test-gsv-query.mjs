// `/tts?` 参数拼装自测（阶段 0）。
//
// 为什么要有这个测试：这几个参数以前是糊在 gsvSpeak 里的，
// 想验证「到底发了什么」只能真起一个 GPT-SoVITS 服务听一遍 —— 慢、不确定、没法回归。
// 抽成纯函数 buildTtsQuery 之后，这里断言的就是**唯一真相源**。
//
// 断言的重点是四条纪律：
//   ① 默认配置下发出的参数集合必须和改造前**完全一致**（回归基线，多一个键都算破约）；
//   ② sample_steps 只对 v4 生效 —— v2ProPlus 音色下发它等于骗人；
//   ③ 脏输入一律当作"没配"，绝不产出 NaN 让服务端 400；
//   ④ seed = -1 不下发（保住今天"每次随机"的行为）。
import assert from 'node:assert';
import { buildTtsQuery, voiceVersion, GSV_VOICES } from '../src/gpt-sovits.js';

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name);
    throw e;
  }
}

// 改造前 gsvSpeak 固定会发的 8 个键，一个不多一个不少。
const BASELINE_KEYS = [
  'text',
  'text_lang',
  'ref_audio_path',
  'prompt_lang',
  'prompt_text',
  'text_split_method',
  'media_type',
  'speed_factor',
];

const base = {
  text: '今天天气还不错',
  refPath: '/abs/ref.wav',
  promptText: '参考音频对应的文本',
  speedFactor: 1.0,
  plan: null,
  version: 'v4',
  audio: {},
};

const q = (over) => buildTtsQuery({ ...base, ...over });

console.log('[gsv-query]');

ok('① 默认配置 = 改造前的 8 个键，完全一致', () => {
  const r = q();
  assert.deepStrictEqual([...r.query.keys()].sort(), [...BASELINE_KEYS].sort());
  assert.strictEqual(r.query.get('text'), '今天天气还不错');
  assert.strictEqual(r.query.get('text_lang'), 'zh');
  assert.strictEqual(r.query.get('prompt_lang'), 'zh');
  assert.strictEqual(r.query.get('ref_audio_path'), '/abs/ref.wav');
  assert.strictEqual(r.query.get('text_split_method'), 'cut5');
  assert.strictEqual(r.query.get('media_type'), 'wav');
  assert.strictEqual(r.query.get('speed_factor'), '1');
  assert.deepStrictEqual(r.params, {});
  assert.strictEqual(r.sampleSteps, undefined);
  assert.strictEqual(r.seed, undefined);
});

ok('① audio 传 null / 非对象也能拼出基线（不炸）', () => {
  for (const audio of [null, undefined, 0, '', 'nope']) {
    const r = q({ audio });
    assert.deepStrictEqual([...r.query.keys()].sort(), [...BASELINE_KEYS].sort());
  }
});

ok('① 文本两端空白被裁掉，缺字段退化成空串而不是 "undefined"', () => {
  assert.strictEqual(q({ text: '  你好  ' }).query.get('text'), '你好');
  const r = q({ text: undefined, refPath: undefined, promptText: undefined });
  assert.strictEqual(r.query.get('text'), '');
  assert.strictEqual(r.query.get('ref_audio_path'), '');
  assert.strictEqual(r.query.get('prompt_text'), '');
});

ok('① speed_factor 脏值一律退成 1（NaN/0/负数/字符串空格）', () => {
  for (const s of [NaN, 0, -1, undefined, null, '', 'abc']) {
    assert.strictEqual(q({ speedFactor: s }).query.get('speed_factor'), '1', `speedFactor=${String(s)}`);
  }
  assert.strictEqual(q({ speedFactor: 1.15 }).query.get('speed_factor'), '1.15');
});

ok('② sample_steps 在 v4 上生效并回传', () => {
  const r = q({ audio: { gsvSampleSteps: 16 } });
  assert.strictEqual(r.query.get('sample_steps'), '16');
  assert.strictEqual(r.sampleSteps, 16);
});

ok('② sample_steps 在 v2ProPlus 上**不下发**（发它是骗人）', () => {
  const r = q({ version: 'v2ProPlus', audio: { gsvSampleSteps: 16 } });
  assert.strictEqual(r.query.get('sample_steps'), null);
  assert.strictEqual(r.sampleSteps, undefined);
  // 其余键仍是基线，没被这个分支带歪
  assert.deepStrictEqual([...r.query.keys()].sort(), [...BASELINE_KEYS].sort());
});

ok('② sample_steps 等于服务端默认 32 时不下发', () => {
  const r = q({ audio: { gsvSampleSteps: 32 } });
  assert.strictEqual(r.query.get('sample_steps'), null);
  assert.strictEqual(r.sampleSteps, undefined);
});

ok('② sample_steps 越界被夹到 [8, 64]', () => {
  assert.strictEqual(q({ audio: { gsvSampleSteps: 999 } }).query.get('sample_steps'), '64');
  assert.strictEqual(q({ audio: { gsvSampleSteps: 1 } }).query.get('sample_steps'), '8');
  assert.strictEqual(q({ audio: { gsvSampleSteps: -20 } }).query.get('sample_steps'), '8');
  assert.strictEqual(q({ audio: { gsvSampleSteps: 63.6 } }).query.get('sample_steps'), '64');
});

ok('② sample_steps 脏输入一律不下发', () => {
  for (const v of [NaN, null, undefined, '', 'abc', {}]) {
    assert.strictEqual(q({ audio: { gsvSampleSteps: v } }).query.get('sample_steps'), null, `v=${String(v)}`);
  }
});

ok('② 夹取后正好回到 32 时也不下发（比如传入 32.4）', () => {
  const r = q({ audio: { gsvSampleSteps: 32.2 } });
  assert.strictEqual(r.query.get('sample_steps'), null);
});

ok('④ seed = -1 不下发，保住"每次随机"', () => {
  const r = q({ audio: { gsvSeed: -1 } });
  assert.strictEqual(r.query.get('seed'), null);
  assert.strictEqual(r.seed, undefined);
});

ok('④ seed 给整数就下发并回传', () => {
  const r = q({ audio: { gsvSeed: 12345 } });
  assert.strictEqual(r.query.get('seed'), '12345');
  assert.strictEqual(r.seed, 12345);
  // 小数截断（服务端要 int）
  assert.strictEqual(q({ audio: { gsvSeed: 42.9 } }).query.get('seed'), '42');
  assert.strictEqual(q({ audio: { gsvSeed: 0 } }).query.get('seed'), '0');
});

ok('④ seed 脏输入不下发', () => {
  for (const v of [NaN, null, undefined, '', 'abc', {}]) {
    assert.strictEqual(q({ audio: { gsvSeed: v } }).query.get('seed'), null, `v=${String(v)}`);
  }
});

ok('③ 任何组合都不会产出 NaN / undefined 字符串', () => {
  const r = q({
    text: undefined,
    speedFactor: NaN,
    audio: { gsvSampleSteps: NaN, gsvSeed: NaN, toneParams: true },
  });
  for (const [k, v] of r.query.entries()) {
    assert.ok(!String(v).includes('NaN'), `${k}=${v} 含 NaN`);
    assert.ok(v !== 'undefined', `${k}=undefined 会被服务端当字符串`);
    assert.ok(v !== 'null', `${k}=null 同上`);
  }
});

ok('③ 韵律参数：plan 未启用时一个都不发', () => {
  const plan = {
    enabled: false,
    params: { temperature: 1.2, topK: 20, topP: 0.9, fragmentInterval: 0.2, repetitionPenalty: 1.3 },
  };
  const r = q({ plan });
  assert.deepStrictEqual(r.params, {});
  assert.strictEqual(r.query.get('temperature'), null);
});

ok('③ 韵律参数：plan 启用 + toneParams 开 → 只发非默认项', () => {
  const plan = {
    enabled: true,
    params: { temperature: 1.2, topK: 15, topP: 1, fragmentInterval: 0.2, repetitionPenalty: 1.35 },
  };
  const r = q({ plan, audio: { toneParams: true } });
  // topK 15 / topP 1 / repetitionPenalty 1.35 都等于默认值 → 不发
  assert.strictEqual(r.query.get('temperature'), '1.2');
  assert.strictEqual(r.query.get('fragment_interval'), '0.2');
  assert.strictEqual(r.query.get('top_k'), null);
  assert.strictEqual(r.query.get('top_p'), null);
  assert.strictEqual(r.query.get('repetition_penalty'), null);
  assert.deepStrictEqual(r.params, { temperature: 1.2, fragment_interval: 0.2 });
});

ok('③ 韵律参数：audio.toneParams=false 一键回退老行为', () => {
  const plan = { enabled: true, params: { temperature: 1.2, topK: 20 } };
  const r = q({ plan, audio: { toneParams: false } });
  assert.strictEqual(r.query.get('temperature'), null);
  assert.deepStrictEqual(r.params, {});
});

ok('② voiceVersion 能按权重路径判出版本', () => {
  assert.strictEqual(voiceVersion({ sovits: 'SoVITS_weights_v4/x.pth' }), 'v4');
  assert.strictEqual(voiceVersion({ sovits: 'SoVITS_weights_v2ProPlus/y.pth' }), 'v2ProPlus');
  assert.strictEqual(voiceVersion({}), 'v4'); // 缺字段当 v4，不抛
  assert.strictEqual(voiceVersion(null), 'v4');
});

ok('② 全部真实音色的版本判定与配置一致', () => {
  const v4 = ['hutao', 'nahida', 'furina', 'ayaka'];
  const v2 = ['sparkle', 'liuying'];
  for (const k of v4) {
    assert.ok(GSV_VOICES[k], `缺音色 ${k}`);
    assert.strictEqual(voiceVersion(GSV_VOICES[k]), 'v4', `${k} 应是 v4`);
  }
  for (const k of v2) {
    assert.ok(GSV_VOICES[k], `缺音色 ${k}`);
    assert.strictEqual(voiceVersion(GSV_VOICES[k]), 'v2ProPlus', `${k} 应是 v2ProPlus`);
  }
});

ok('② sample_steps + seed 可以同时下发，互不覆盖', () => {
  const r = q({ audio: { gsvSampleSteps: 24, gsvSeed: 777 } });
  assert.strictEqual(r.query.get('sample_steps'), '24');
  assert.strictEqual(r.query.get('seed'), '777');
  assert.strictEqual(r.sampleSteps, 24);
  assert.strictEqual(r.seed, 777);
  assert.strictEqual(r.query.get('speed_factor'), '1', '不该动语速');
});

ok('① 明确不发的四个参数：任何配置下都不出现', () => {
  const r = q({ audio: { gsvSampleSteps: 16, gsvSeed: 1, toneParams: true } });
  for (const forbidden of ['aux_ref_audio_paths', 'streaming_mode', 'parallel_infer', 'batch_size']) {
    assert.strictEqual(r.query.get(forbidden), null, `${forbidden} 不该被下发`);
  }
});

console.log(`\n[gsv-query] ${pass} 组断言全部通过`);
