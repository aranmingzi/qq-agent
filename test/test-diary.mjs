// 日记自检：只测 diary.js 与提示词拼装，不碰模型、不碰真实 data/。
//   QQ_AGENT_DATA_DIR 指到临时目录，跑完删掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-diary-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const {
  chatSlug, entryPath, parseEntry, writeEntry, readEntry, listEntries, hasEntry,
  yesterdayKey, collectTranscript, buildWritePrompt, parseDraft, writeDiaryFor, formatForPrompt
} = await import('../src/diary.js');

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

const KEY = 'group:1001';
const DAY = '2026-10-19';

console.log('日记');

ok('会话键 → 目录名（冒号不能进路径）', () => {
  assert.equal(chatSlug(KEY), 'group_1001');
  assert.ok(entryPath(KEY, DAY).includes(path.join('diary', 'group_1001', '2026-10-19.md')));
});

ok('没有日记时，提示词里整段不出现', () => {
  assert.equal(formatForPrompt('group:9999'), '');
});

ok('写入 → 读回（标题/正文/frontmatter 都对）', () => {
  const r = writeEntry(KEY, DAY, { title: '群里的破事', body: '今天群里又在吵谁的网速。', meta: { messages: 42 } });
  assert.equal(r.ok, true);
  const e = readEntry(KEY, DAY);
  assert.equal(e.title, '群里的破事');
  assert.match(e.body, /网速/);
  assert.equal(e.meta.messages, '42');
  assert.equal(hasEntry(KEY, DAY), true);
});

ok('同一天默认不覆盖（不重写、不烧第二次钱）', () => {
  const r = writeEntry(KEY, DAY, { title: 'x', body: '不该写进去的内容啊啊啊' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exists');
  assert.match(readEntry(KEY, DAY).body, /网速/);
});

ok('overwrite=true 才允许重写', () => {
  const r = writeEntry(KEY, DAY, { title: '改过', body: '换了一版正文，长度也够了。', overwrite: true });
  assert.equal(r.ok, true);
  assert.equal(readEntry(KEY, DAY).title, '改过');
});

ok('正文太短直接拒绝（不落半截文件）', () => {
  const r = writeEntry(KEY, '2026-10-18', { body: '嗯' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-body');
});

ok('日期格式不合法一律拒绝（防路径穿越）', () => {
  assert.equal(writeEntry(KEY, '../../etc/passwd', { body: '这个长度够长了哦' }).ok, false);
  assert.equal(readEntry(KEY, '../x'), null);
});

ok('列表新的在前', () => {
  writeEntry(KEY, '2026-10-17', { body: '前天那篇日记，长度也够了。' });
  writeEntry(KEY, '2026-10-19', { body: '今天这篇日记，长度也够了。', overwrite: true });
  const list = listEntries(KEY, { limit: 5 });
  assert.deepEqual(list.map((e) => e.date), ['2026-10-19', '2026-10-17']);
});

ok('解析：没有 frontmatter 的老文件也能读', () => {
  const p = parseEntry('# 裸标题\n\n只有正文。');
  assert.equal(p.title, '裸标题');
  assert.equal(p.body, '只有正文。');
});

ok('昨天 = 北京时间减一天', () => {
  assert.equal(yesterdayKey(Date.parse('2026-10-20T10:00:00+08:00')), '2026-10-19');
  assert.equal(yesterdayKey(Date.parse('2026-11-01T06:30:00+08:00')), '2026-10-31');
});

ok('聊天记录只取那一天，且标注"我"与发言人', () => {
  const base = Date.parse('2026-10-19T21:00:00+08:00');
  const store = {
    recent: () => [
      { ts: base - 86400000, senderName: '前天的', text: '这条不该出现' },
      { ts: base, senderName: '小明', text: '今天这条要出现' },
      { ts: base + 60000, self: true, text: '我回的这句' }
    ]
  };
  const tr = collectTranscript(store, KEY, { date: '2026-10-19' });
  assert.equal(tr.count, 2);
  assert.ok(tr.lines.some((l) => l.includes('小明') && l.includes('要出现')));
  assert.ok(!tr.lines.some((l) => l.includes('不该出现')));
  assert.ok(tr.lines.some((l) => l.includes('我：')));
});

ok('日记提示词：带日期、带地点、明令不许编', () => {
  const [sys, user] = buildWritePrompt({
    persona: { botName: '小鲸鱼', roleText: '傲娇' },
    chatName: '测试群', kind: 'group', date: DAY, transcript: ['21:00 小明：今天好累']
  });
  assert.match(sys.content, /只能写下面聊天记录里真实出现过的人和事/);
  assert.match(sys.content, /小鲸鱼/);
  assert.match(user.content, /测试群/);
  assert.match(user.content, /今天好累/);
});

ok('模型输出容错：JSON / 代码块 / 纯文本都能解析', () => {
  // public 是「可发到空间」的脱敏简版，只在 diary.publicSafe 打开时才要求模型给
  assert.deepEqual(parseDraft('{"title":"标题","body":"正文内容"}'), { title: '标题', body: '正文内容', public: '' });
  assert.equal(parseDraft('{"title":"甲","body":"乙","public":"丙"}').public, '丙');
  assert.equal(parseDraft('```json\n{"title":"甲","body":"乙"}\n```').body, '乙');
  const plain = parseDraft('随手写的一行标题\n后面是正文');
  assert.equal(plain.title, '随手写的一行标题');
  assert.equal(plain.body, '后面是正文');
});

await okAsync('消息太少的日子不硬编（返回 too-quiet）', async () => {
  const store = { recent: () => [{ ts: Date.now(), senderName: 'a', text: 'hi' }] };
  const r = await writeDiaryFor('group:quiet', {
    store, date: '2026-10-19', cfg: { minMessages: 12 },
    chatCompletion: async () => { throw new Error('不该调用模型'); }
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-quiet');
});

await okAsync('正常生成：落盘一篇，标题来自模型', async () => {
  const ts = Date.parse('2026-10-19T20:00:00+08:00');
  const store = {
    recent: () => Array.from({ length: 20 }, (_, i) => ({
      ts: ts + i * 60000, senderName: '小明', text: `第 ${i} 条消息`
    }))
  };
  const r = await writeDiaryFor('group:busy', {
    store, date: '2026-10-19', cfg: { minMessages: 5 },
    chatCompletion: async () => ({ message: { content: '{"title":"忙碌的一天","body":"今天群里聊了很多，我基本上都在潜水看他们吵。"}' } })
  });
  assert.equal(r.ok, true);
  const e = readEntry('group:busy', '2026-10-19');
  assert.equal(e.title, '忙碌的一天');
  assert.match(e.body, /潜水/);
});

await okAsync('同一天已写过就不再调模型', async () => {
  const store = { recent: () => [] };
  let called = 0;
  const r = await writeDiaryFor('group:busy', {
    store, date: '2026-10-19', cfg: {},
    chatCompletion: async () => { called += 1; return { message: { content: '{}' } }; }
  });
  assert.equal(r.reason, 'exists');
  assert.equal(called, 0);
});

await okAsync('模型输出太空 → 拒绝落盘（bad-draft）', async () => {
  const ts = Date.parse('2026-10-19T20:00:00+08:00');
  const store = {
    recent: () => Array.from({ length: 20 }, (_, i) => ({ ts: ts + i * 1000, senderName: 'a', text: `x${i}` }))
  };
  const r = await writeDiaryFor('group:blank', {
    store, date: '2026-10-19', cfg: {},
    chatCompletion: async () => ({ message: { content: '{"title":"空","body":"嗯。"}' } })
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-draft');
});

ok('提示词里的日记块：有标题、有截断、有"就是昨天"的提示', () => {
  writeEntry(KEY, '2026-10-19', {
    title: '长的一篇',
    body: '今天群里从早聊到晚，先是吵网速，后来又聊到谁在摸鱼，我基本都在潜水。'.repeat(3),
    overwrite: true
  });
  const text = formatForPrompt(KEY, { entries: 2, chars: 60, now: Date.parse('2026-10-20T09:00:00+08:00') });
  assert.match(text, /【我的日记/);
  assert.match(text, /10-19/);
  assert.match(text, /…/);           // 截断生效
  assert.match(text, /就是"昨天"/);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项`);
