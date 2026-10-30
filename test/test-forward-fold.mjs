// 合并转发「连续重复折叠」自测。
//
// 目的是既保住"刷屏"这个事实、又不让它占满预算、也不让模型把它当语感来源。
// 四条边界必须守住：
//   ① 连续相同 → `（连续 N 条）`，N 要真数对；
//   ② 中间夹了别的内容就重新开一段（不许跨段合并）；
//   ③ 同一句话由**不同人**发的，要标"多人"，否则模型会以为是一个人连发；
//   ④ 空消息节点不许折叠（每条空消息都是独立节点，折了就丢条数）。
import assert from 'node:assert';
import { forwardPayloadToText } from '../src/onebot.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }
const aok = async (name, fn) => { await fn(); pass += 1; console.log('  ✓', name); };

/** 造一个 get_forward_msg 形状的 node。 */
function node({ id = 1001, name = '群友A', text = '' }) {
  return {
    type: 'node',
    data: {
      user_id: id,
      nickname: name,
      message: [{ type: 'text', data: { text } }]
    }
  };
}

const wrap = (nodes) => ({ messages: nodes });

console.log('[forward-fold]');

await aok('① 连续 3 条相同 → 折成一行并标条数', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ text: '哈哈哈哈' }),
    node({ text: '哈哈哈哈' }),
    node({ text: '哈哈哈哈' })
  ]));
  assert.match(text, /哈哈哈哈（连续 3 条）/, `实际：${text}`);
  // 只应出现一次正文（折叠生效），不是 3 行
  assert.strictEqual(text.split('哈哈哈哈').length - 1, 1, `正文出现了多次：${text}`);
});

await aok('① 不连续/不重复的不动', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ text: '早上好' }),
    node({ text: '吃了吗' }),
    node({ text: '早上好' })
  ]));
  assert.ok(!text.includes('（连续'), `不该折叠：${text}`);
  assert.strictEqual(text.split('早上好').length - 1, 2);
});

await aok('② 中间夹别的内容 → 重新开一段', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ text: '啊' }),
    node({ text: '啊' }),
    node({ text: '换个话题' }),
    node({ text: '啊' }),
    node({ text: '啊' }),
    node({ text: '啊' })
  ]));
  assert.match(text, /啊（连续 2 条）/, `前段：${text}`);
  assert.match(text, /啊（连续 3 条）/, `后段：${text}`);
});

await aok('③ 不同人发同一句 → 标"多人"', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ id: 1, name: '甲', text: '收到' }),
    node({ id: 2, name: '乙', text: '收到' }),
    node({ id: 3, name: '丙', text: '收到' })
  ]));
  assert.match(text, /收到（连续 3 条，多人）/, `实际：${text}`);
});

await aok('③ 同一人 → 不带"多人"', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ id: 9, name: '刷屏侠', text: '6' }),
    node({ id: 9, name: '刷屏侠', text: '6' })
  ]));
  assert.match(text, /6（连续 2 条）/, `实际：${text}`);
  assert.ok(!text.includes('多人'));
});

await aok('④ 空消息节点不折叠', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ text: '' }),
    node({ text: '' }),
    node({ text: '' })
  ]));
  assert.ok(!text.includes('（连续'), `空消息不该折叠：${text}`);
});

await aok('④ 折叠后仍保留"还有 N 条未展开"', async () => {
  const nodes = Array.from({ length: 40 }, () => node({ text: '刷屏' }));
  const text = await forwardPayloadToText(wrap(nodes), { maxNodes: 10 });
  assert.match(text, /刷屏（连续 10 条）/);
  assert.match(text, /还有 30 条未展开/);
});

await aok('④ 折叠不会让总长度超过 maxChars', async () => {
  const nodes = Array.from({ length: 30 }, (_, i) => node({ name: `人${i}`, text: `第${i}条不一样的内容` }));
  const text = await forwardPayloadToText(wrap(nodes), { maxChars: 100 });
  assert.ok(text.length <= 100, `超长了：${text.length}`);
});

await aok('⑤ 原有行为不变：发送者带 QQ 号、空转发返回空串', async () => {
  const text = await forwardPayloadToText(wrap([node({ id: 10000001, name: '岁月永恒喵', text: '在吗' })]));
  assert.match(text, /岁月永恒喵\(QQ:10000001\)：在吗/);
  assert.strictEqual(await forwardPayloadToText({}), '');
});

// 2026-10-26 修的真 bug：折叠拿的是**裁剪后**的文本比，
// 于是两条完全不同的长消息只要开头一段相同就被判成"连续 2 条"，后半段永久丢失。
await aok('⑥ 前段相同、后段不同的长消息**不许**折叠', async () => {
  const common = '今天群里聊的那个事情'.repeat(20);   // 远长于每条的裁剪预算
  const text = await forwardPayloadToText(wrap([
    node({ name: '张三', text: `${common}——最后决定用方案A` }),
    node({ name: '张三', text: `${common}——最后决定用方案B` })
  ]), { maxNodes: 30, maxChars: 400 });
  assert.ok(!text.includes('（连续'), `不该折叠却折了：${text.slice(0, 160)}`);
});

await aok('⑥ 真的完全相同的长消息**仍然要**折叠', async () => {
  const same = '哈哈哈哈哈'.repeat(30);
  const text = await forwardPayloadToText(wrap([
    node({ name: '张三', text: same }),
    node({ name: '张三', text: same }),
    node({ name: '张三', text: same })
  ]), { maxNodes: 30, maxChars: 400 });
  assert.match(text, /（连续 3 条）/);
});

await aok('⑦ 多人连发时不署其中一人的名（署名会失真）', async () => {
  const text = await forwardPayloadToText(wrap([
    node({ id: 1, name: '张三', text: '收到' }),
    node({ id: 2, name: '李四', text: '收到' })
  ]));
  assert.match(text, /（连续 2 条，多人）/);
  assert.ok(!text.includes('张三：'), `多人连发不该署第一个人的名：${text}`);
});

console.log(`\n[forward-fold] ${pass} 项全过`);
