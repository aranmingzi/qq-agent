// xiaoyu 音色接入回归：voiceVersion 分支 + 专属 toneParams 下发 + 文件在位检查。
//
// 断言点（对齐 test-gsv-query.mjs 的纪律）：
//   ① v2 权重不签发 sample_steps（v4 专属参数，v2 下了发等于骗人）；
//   ② xiaoyu 的专属参数（temperature 0.6 / top_k 12 / top_p 0.85）在 plan 开启时覆盖情绪表；
//   ③ 权重与参考音频真实在位 —— 缺文件的话 listGsvVoices 会标不可用并静默降级。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { buildTtsQuery, voiceVersion, GSV_VOICES, listGsvVoices } from '../src/gpt-sovits.js';

console.log('[gsv-xiaoyu]');
let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name); throw e; }
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const v = GSV_VOICES.xiaoyu;
assert.ok(v, 'GSV_VOICES.xiaoyu 缺失');

ok('① voiceVersion(xiaoyu) = v2（weights_v2/ 路径识别）', () => {
  assert.strictEqual(voiceVersion(v), 'v2');
});

ok('② v2 权重不下发 sample_steps，即使配置给了', () => {
  const r = buildTtsQuery({
    text: '你好呀', refPath: '/abs/ref.wav', promptText: '参考',
    speedFactor: 0.95, plan: null, version: 'v2',
    audio: { gsvSampleSteps: 40 },
  });
  assert.strictEqual(r.query.get('sample_steps'), null);
  assert.strictEqual(r.sampleSteps, undefined);
});

ok('③ 专属 toneParams 覆盖：temperature 0.6 / top_k 12 / top_p 0.85', () => {
  const r = buildTtsQuery({
    text: '你好呀', refPath: '/abs/ref.wav', promptText: '参考',
    speedFactor: 0.95, plan: { enabled: true, params: { temperature: 1.02, topK: 16 } },
    version: 'v2', audio: {},
    voiceTone: v.toneParams,
  });
  assert.strictEqual(r.query.get('temperature'), '0.6');
  assert.strictEqual(r.query.get('top_k'), '12');
  assert.strictEqual(r.query.get('top_p'), '0.85');
});

ok('④ 通用情绪参数在非专属音色上不受 voiceTone 影响（回归）', () => {
  const r = buildTtsQuery({
    text: '你好呀', refPath: '/abs/ref.wav', promptText: '参考',
    speedFactor: 1, plan: { enabled: true, params: { temperature: 1.02, topK: 16, topP: 0.98 } },
    version: 'v4', audio: {},
    voiceTone: null,
  });
  assert.strictEqual(r.query.get('temperature'), '1.02');
  assert.strictEqual(r.query.get('top_k'), '16');
  assert.strictEqual(r.query.get('top_p'), '0.98');
});

ok('⑤ 权重 + 4 段参考音频在位（不在位会静默降级千问 TTS）', () => {
  const app = path.join(ROOT, 'gpt-sovits-app', 'GPT-SoVITS-v2pro-20250604');
  assert.ok(fs.existsSync(path.join(app, v.gpt)), '缺 GPT 权重: ' + v.gpt);
  assert.ok(fs.existsSync(path.join(app, v.sovits)), '缺 SoVITS 权重: ' + v.sovits);
  for (const key of Object.keys(v.emotions)) {
    assert.ok(fs.existsSync(path.join(ROOT, v.emotions[key].ref)), '缺参考音频: ' + v.emotions[key].ref);
  }
});

ok('⑥ listGsvVoices 里 xiaoyu 可用', () => {
  const item = listGsvVoices().find((x) => x.key === 'xiaoyu');
  assert.ok(item, 'listGsvVoices 没列出 xiaoyu');
  assert.strictEqual(item.available, true, 'missing=' + JSON.stringify(item.missing));
  assert.deepStrictEqual(item.emotions, ['中立', '开心', '难过', '恐惧']);
});

console.log(`\n[gsv-xiaoyu] ${pass} passed`);
