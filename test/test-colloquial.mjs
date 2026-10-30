// 口语化模块单元测试：验证只做安全改写、不误改语义、不删关键信息

import { colloquialize, toSpeechText } from '../src/colloquial.js';

let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log('── 口语化基础 ──');
assert('空输入返回空', colloquialize('') === '');
assert('短句且已有停顿不重写', toSpeechText('在的，咋了？') === '在的，咋了？');
assert('书面连接词被删', !colloquialize('综上所述，我们要抓紧').includes('综上所述'));
assert('「但是」→「不过」', colloquialize('但是我不这么想').includes('不过'));
assert('「没有」→「没」', colloquialize('我还没有吃饭').includes('还没'));

console.log('── 不误改语义（关键信息保留）──');
const keyInfo = '明天下午三点在会议室开项目评审会，记得带上季度报告';
const out = toSpeechText(keyInfo);
assert('保留关键数字「三点」', out.includes('三点'));
assert('保留「会议室」', out.includes('会议室'));
assert('保留「季度报告」', out.includes('季度报告'));

console.log('── 不误伤英文/数字 ──');
const en = 'DeepSeek V3 的 API 价格是每百万 token 两元';
const outEn = toSpeechText(en);
assert('保留 DeepSeek', outEn.includes('DeepSeek'));
assert('保留 V3', outEn.includes('V3'));

console.log('── 长句拆短 + 停顿 ──');
const long = '她沉默了很久，最终还是没有说出口，因为她不知道该如何面对这个结果';
const outLong = toSpeechText(long);
assert('加了停顿（省略号）', outLong.includes('…'));
assert('比原文更像口语', outLong.includes('没说出口'));

console.log('── 长度上限保护 ──');
const veryLong = '这是一个非常长的句子，'.repeat(50);
const outCap = toSpeechText(veryLong, { maxLen: 100 });
assert('截断到上限', outCap.length <= 100);

console.log(`\n结果：${pass} 通过 · ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
