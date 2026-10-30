// QQ 空间发布自检：只测 qzone.js 的纯逻辑 + 幂等账本，不联网、不碰真实 data/。
//   QQ_AGENT_DATA_DIR 指到临时目录，跑完删掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-qzone-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { writeEntry } = await import('../src/diary.js');
const {
  normalizeUgcRight, ugcRightLabel, redactForQzone, stripMarkdown, clampText,
  renderPostText, publishToQzone, publishDiary, findPost, countPostsOn, listPosts,
  forgetPost, remainingQuota
} = await import('../src/qzone.js');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};
const okAsync = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const KEY = 'group:2002';
const DAY = '2026-10-23';

console.log('QQ 空间');

ok('可见范围只认 1/4/64，其它一律退回「仅自己可见」', () => {
  assert.equal(normalizeUgcRight(1), 1);
  assert.equal(normalizeUgcRight('4'), 4);
  assert.equal(normalizeUgcRight(undefined), 64);
  assert.equal(normalizeUgcRight(16), 64);      // 需要带名单的权限不支持
  assert.equal(normalizeUgcRight(999), 64);
  assert.equal(ugcRightLabel(64), '仅自己可见');
});

ok('脱敏：邮箱/手机号/@QQ号/群号', () => {
  assert.equal(redactForQzone('mail me a@b.com'), 'mail me ***');
  assert.equal(redactForQzone('打 13812345678 找我'), '打 *** 找我');
  assert.equal(redactForQzone('谢谢 @123456789'), '谢谢 一个群友');
  assert.equal(redactForQzone('群号：98765432'), '某个群');
  // 普通数字不该被误伤（日期、数量）
  assert.equal(redactForQzone('今天聊了 3 小时，2026 年了'), '今天聊了 3 小时，2026 年了');
});

ok('Markdown 痕迹抹干净（说说只认纯文本）', () => {
  assert.equal(stripMarkdown('**粗体**和`代码`'), '粗体和代码');
  assert.equal(stripMarkdown('## 小标题'), '小标题');
  assert.equal(stripMarkdown('- 第一件事\n- 第二件事'), '· 第一件事\n· 第二件事');
  assert.equal(stripMarkdown('```js\nconsole.log(1)\n```'), '');
});

ok('截断停在句末，不出现半句话', () => {
  const text = '今天很热闹。'.repeat(100);
  const out = clampText(text, 100);
  assert.ok(out.length <= 101, `长度 ${out.length}`);
  assert.ok(out.endsWith('。…'), out.slice(-6));
});

ok('正文：优先用脱敏简版；带标题时加【】', () => {
  const entry = {
    title: '群里的一天',
    body: '全文里写了 @123456789 说的话。',
    publicBody: '今天有个群友说了句很好笑的话，我笑了一路。'
  };
  const withPublic = renderPostText(entry, { preferPublic: true });
  assert.match(withPublic, /^【群里的一天】/);
  assert.match(withPublic, /有个群友/);
  assert.doesNotMatch(withPublic, /123456789/);

  const withoutPublic = renderPostText(entry, { preferPublic: false });
  assert.match(withoutPublic, /一个群友/);      // 退回全文时靠正则兜底

  const noTitle = renderPostText(entry, { preferPublic: true, includeTitle: false });
  assert.doesNotMatch(noTitle, /【/);
});

// ── 发布链路 ───────────────────────────────────────────────────────────────
const calls = [];
const fakeOnebot = {
  selfId: '10000',
  async call(action, params) {
    calls.push({ action, params });
    return { tid: `tid-${calls.length}` };
  }
};

await okAsync('空正文不发', async () => {
  const r = await publishToQzone({ onebot: fakeOnebot, content: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

await okAsync('没有协议端不发（不乱报失败）', async () => {
  const r = await publishToQzone({ onebot: null, content: '随便写点' });
  assert.equal(r.reason, 'no-onebot');
});

await okAsync('没拿到 tid 时算「结果不确定」，不重发', async () => {
  const r = await publishToQzone({ onebot: { async call() { return {}; } }, content: '随便写点' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'uncertain');
});

await okAsync('协议端没这个接口 → unsupported（提示升级 NapCat）', async () => {
  const boom = new Error('no such action');
  boom.code = 'EPLATFORM_UNSUPPORTED';
  const r = await publishToQzone({ onebot: { async call() { throw boom; } }, content: '随便写点' });
  assert.equal(r.reason, 'unsupported');
  assert.match(r.error, /NapCat/);
});

await okAsync('发一篇日记：动作名/参数/权限都对，且记账', async () => {
  writeEntry(KEY, DAY, { title: '热闹的一天', body: '今天群里聊了很多，有人问我在干嘛，我说在听歌。' });
  calls.length = 0;
  const r = await publishDiary({ onebot: fakeOnebot, chatKey: KEY, date: DAY, cfg: { ugcRight: 64 } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'send_qzone_msg');
  assert.equal(calls[0].params.ugc_right, 64);
  assert.match(calls[0].params.content, /热闹的一天/);
  assert.equal(countPostsOn(DAY), 1);
  assert.equal(findPost(KEY, DAY)?.tid, r.tid);
});

await okAsync('同一天不重复发；force 才重发', async () => {
  const again = await publishDiary({ onebot: fakeOnebot, chatKey: KEY, date: DAY, cfg: {} });
  assert.equal(again.reason, 'already');
  const forced = await publishDiary({ onebot: fakeOnebot, chatKey: KEY, date: DAY, cfg: {}, force: true });
  assert.equal(forced.ok, true);
  assert.equal(countPostsOn(DAY), 1);          // 覆盖旧记录，不会变成 2 条
});

await okAsync('没有日记就不发', async () => {
  const r = await publishDiary({ onebot: fakeOnebot, chatKey: 'group:404', date: DAY, cfg: {} });
  assert.equal(r.reason, 'no-entry');
});

ok('配额：发满 maxPerDay 就不再自动发', () => {
  assert.equal(remainingQuota({ maxPerDay: 1 }, DAY), 0);
  assert.equal(remainingQuota({ maxPerDay: 3 }, DAY), 2);
  assert.equal(remainingQuota({ maxPerDay: 0 }, DAY), Infinity);
});

ok('清账后这一天可以再发（说说被删掉的场景）', () => {
  const posts = listPosts();
  assert.ok(posts.length >= 1);
  assert.equal(forgetPost(posts[0].tid), 1);
  assert.equal(findPost(KEY, DAY), null);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项${process.exitCode ? '（有失败）' : ''}`);
