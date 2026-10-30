// QQ 内置表情识别自检：node test/test-qq-face.mjs
// 覆盖：id→名字、未知 id 兜底、mface、老存档文本规整、「只发了个表情」判定、消息段转文本。
import assert from 'node:assert/strict';
import { faceInfo, faceName, faceText, marketFaceText, normalizeFaceText, isStickerOnlyText, qqFaceTable } from '../src/qq-face.js';
import { segmentsToText } from '../src/onebot.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

console.log('QQ 内置表情识别：');

check('映射表已生成（>200 条，且带图号）', () => {
  const table = qqFaceTable();
  assert.ok(Object.keys(table).length > 200, '映射表条数太少，先跑 node tools/gen-qq-face.mjs');
  assert.equal(table['182']?.n, '笑哭');
  assert.equal(table['182']?.e, '252');
});

check('id → 名字', () => {
  assert.equal(faceName('182'), '笑哭');
  assert.equal(faceName('264'), '捂脸');
  assert.equal(faceInfo('14')?.name, '微笑');
  assert.equal(faceInfo('14')?.em, '100');
});

check('未知 / 空 id 不瞎编', () => {
  assert.equal(faceName('999999'), '');
  assert.equal(faceText('999999'), '[表情]');
  assert.equal(faceText(''), '[表情]');
  assert.equal(faceText('abc'), '[表情]');
});

check('face 段 → [表情:名字]', () => {
  assert.equal(faceText('182'), '[表情:笑哭]');
  assert.equal(faceText(182), '[表情:笑哭]');
});

check('mface 段 → [表情包:名字]', () => {
  assert.equal(marketFaceText({ summary: '[狗头]' }), '[表情包:狗头]');
  assert.equal(marketFaceText({ summary: '呲牙' }), '[表情包:呲牙]');
  assert.equal(marketFaceText({}), '[表情包]');
});

check('老存档 [表情182] 规整成 [表情:笑哭]', () => {
  assert.equal(normalizeFaceText('笑死[表情182]'), '笑死[表情:笑哭]');
  assert.equal(normalizeFaceText('[表情13][表情2]'), '[表情:呲牙][表情:色]');
});

check('规整是幂等的', () => {
  const once = normalizeFaceText('a[表情182]b[表情]c');
  assert.equal(normalizeFaceText(once), once);
  assert.equal(normalizeFaceText('[表情:笑哭]'), '[表情:笑哭]');
  assert.equal(normalizeFaceText('[表情 ： 笑哭]'), '[表情:笑哭]');
});

check('表情包标记不会被当成表情规整', () => {
  assert.equal(normalizeFaceText('[表情包:狗头]'), '[表情包:狗头]');
});

check('未知 id 的老文本退化成裸 [表情]', () => {
  assert.equal(normalizeFaceText('嗯[表情387]'), '嗯[表情]');
});

check('没有表情的文本原样返回', () => {
  assert.equal(normalizeFaceText('你好呀'), '你好呀');
  assert.equal(normalizeFaceText(''), '');
  assert.equal(normalizeFaceText(undefined), '');
});

check('「只发了个表情」判定（连续对话收口用）', () => {
  assert.equal(isStickerOnlyText('[表情:笑哭]'), true);
  assert.equal(isStickerOnlyText('[表情]'), true);
  assert.equal(isStickerOnlyText('[表情:笑哭][表情包:狗头]'), true);
  assert.equal(isStickerOnlyText('  [表情:笑哭]  '), true);
  assert.equal(isStickerOnlyText('[表情:笑哭] 哈哈'), false);
  assert.equal(isStickerOnlyText('哈哈'), false);
  assert.equal(isStickerOnlyText(''), false);
});

await checkAsync('segmentsToText 里 face / mface 都认得出', async () => {
  const text = await segmentsToText([
    { type: 'text', data: { text: '太搞笑了' } },
    { type: 'face', data: { id: '182' } },
    { type: 'mface', data: { summary: '[狗头]' } },
    { type: 'face', data: { id: '387' } },
  ]);
  assert.equal(text, '太搞笑了[表情:笑哭][表情包:狗头][表情]');
});

await checkAsync('segmentsToText: 只有表情时不带裸数字', async () => {
  const text = await segmentsToText([{ type: 'face', data: { id: '14' } }]);
  assert.equal(text, '[表情:微笑]');
  assert.ok(!/\d/.test(text), '不该再出现数字 id');
});

console.log(`\n全部通过：${passed} 项`);
if (process.exitCode) {
  console.error('有断言失败');
}
