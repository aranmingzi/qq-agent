// 前缀稳定性护栏（2026-10-26，P2 拆块测量的产物）。
//
// ── 为什么会有这个文件 ─────────────────────────────────────────────────
// 原本的计划是把【过去状态】拆成"冻结块 + 活动块"，让稳定的旧消息吃前缀缓存。
// 用真实群数据量过之后发现**前提不成立**，于是把结论钉成断言，防止以后（包括我自己）
// 又为了省缓存去重排提示词顺序。
//
// 实测（group_20000005，2026-10-26，真机数据）：
//   · past 段跨轮：字符级最长公共前缀 **11 字**（1.1%）—— 窗口每轮进出 2 行，
//     头部一滑，后面 900 多字节就全作废；行级稳定率虽然有 90%，但前缀缓存只认"从头开始连着的"。
//   · 整个 user 提示词跨轮 LCP **57 字（0.7%）**——第一段就是【当前时间】。
//   · user 8130 字里：role 6212 字（人设，稳定但排在时间后面）、past 1056 字。
//     ⇒ 就算把 past 全部变成可缓存，上限也只有 ~900 字 ≈ 550 token/次；
//        而首页的 role 有 6200 字，它才是大头（现成开关 persona.roleInSystem）。
//   收益换算（deepseek-flash 闲时 in 1.0 / cached 0.02 元每百万）：
//     550 token × 0.98/1M ≈ ¥0.0005/次 × 200 次/天 ≈ ¥0.1/天。
//   为 ¥0.1/天 把【当前时间】挪到历史后面 —— 换掉一条用真实故障换来的纪律，不划算。
//
// 所以这里有两条硬约束（拆了会红）：
//   ① 【当前时间】必须是 user 的第一段（否则模型把旧消息当今天）；
//   ② system 必须逐字节稳定（跨轮、跨会话同一个指纹），否则前缀缓存整段失效。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-prefix-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { ChatStore } = await import('../src/store.js');
const { buildSystemBundle, buildUserBundle, buildPastState } = await import('../src/prompt.js');
const { USER_ORDER } = await import('../src/context-budget.js');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name, '\n    ', error?.message ?? error);
    process.exitCode = 1;
  }
};

console.log('[prompt-prefix]');

ok('① USER_ORDER 的第一段必须是 time（顺序表的唯一真相源）', () => {
  assert.equal(USER_ORDER[0], 'time', '有人把别的段排到时间前面了 —— 先想清楚"过去状态会不会被当成今天"');
});

const CHAT = 'group:880001';
const store = new ChatStore(0);
const BASE = Date.now() - 3600 * 1000;
for (let i = 1; i <= 24; i += 1) {
  store.appendIncoming(CHAT, {
    mid: 600000 + i, ts: BASE + i * 60000, senderId: '10001', senderName: '张三',
    text: `第${i}条消息：今天聊的是周末去哪玩`
  });
}
const ctxOf = (extra = {}) => ({
  store, chatKey: CHAT, kind: 'group', chatId: '880001', chatName: '测试群',
  triggerEntries: store.recent(CHAT, { limit: 2 }), tier: 'direct', runSeq: 1,
  recentCount: 10, lastMessageAt: Date.now(), selfLastMessageAt: 0,
  selfId: '10000', selfNickname: '小鲸鱼儿',
  memory: { formatForPrompt: () => '' },
  ...extra
});

ok('② user 提示词真的以【当前时间】开头（不是只写在 ORDER 表里）', () => {
  const text = buildUserBundle(ctxOf()).text;
  assert.ok(text.startsWith('【当前时间】'), `第一段是：${JSON.stringify(text.slice(0, 40))}`);
});

ok('③ system 两次构建逐字节相同（跨轮稳定 = 前缀缓存的前提）', () => {
  const a = buildSystemBundle({});
  const b = buildSystemBundle({});
  assert.equal(a.text, b.text, 'system 里混进了每轮变化的内容（时间/随机数），前缀缓存会整段失效');
});

ok('④ system 里不含当天日期（防止"顺手把时间塞进静态层"）', () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const text = buildSystemBundle({}).text;
  assert.ok(!text.includes(today), 'system 里出现了今天的日期 —— 它每轮都会变，等于把缓存打断点挪到最前面');
});

ok('⑤ past 渲染是确定性的：同一批消息两次构建逐字相同', () => {
  const a = buildPastState(store, CHAT, { tier: 'direct' });
  const b = buildPastState(store, CHAT, { tier: 'direct' });
  assert.equal(a.text, b.text, 'past 渲染不稳定（是不是用了"刚刚/几分钟前"这种相对时间？）');
});

ok('⑥ past 的行格式带绝对时间（相对时间会让每轮文本都变）', () => {
  const { text } = buildPastState(store, CHAT, { tier: 'direct' });
  assert.match(text, /\[\d{2}-\d{2} \d{2}:\d{2}\]/, '过去状态的行首应该形如 [10-26 15:32]');
  assert.ok(!/刚才|刚刚|分钟前|秒前/.test(text), `出现了相对时间：${text.slice(0, 120)}`);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[prompt-prefix] ${pass} 项通过`);
