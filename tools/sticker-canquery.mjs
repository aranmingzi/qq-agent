/**
 * 验证【表情包】段里指向 list_stickers 的两句（场景索引 + "换个池子挑"）
 * 只在那个工具真的挂着时才出现。
 *
 * 用法：node tools/sticker-canquery.mjs
 */
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const { buildUserBundle } = await import('../src/prompt.js');

const noop = () => '';
const fake = {
  store: { recent: () => [] },
  memory: { formatForPrompt: noop },
  facts: { formatForPrompt: noop },
  groupFacts: { formatForPrompt: noop },
  diary: { formatForPrompt: noop }
};

// 用**真实表情库**（data/stickers.json）测，假数据的场景数太少会低估收益
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stickers.json'), 'utf8'));
const list = Array.isArray(raw) ? raw : Object.values(raw);
const entries = list.filter((e) => e && typeof e === 'object').map((e) => ({
  ...e,
  // 清空 useCount，让候选不受冷却影响（测的是"段长"，不是轮换）
  useCount: 0
}));
console.log(`真实表情库：${entries.length} 条`);

function bundle(kind, packs) {
  return buildUserBundle({
    chatKey: kind === 'group' ? 'group:20000001' : 'private:10000001',
    kind,
    chatId: kind === 'group' ? '20000001' : '10000001',
    chatName: '测试群',
    store: fake.store,
    memory: fake.memory,
    now: Date.now(),
    messages: [{ sender: '张三', text: '在吗', id: 1 }],
    triggerEntries: [{ sender: '张三', text: '在吗', id: 1 }],
    triggerText: '在吗',
    past: { text: '', count: 0 },
    stickerEntries: entries,
    packs: new Set(packs)
  });
}

const seg = (x) => {
  const m = /【表情包】[\s\S]*?(?=\n【|$)/.exec(x.text);
  return m ? m[0] : '';
};

const cases = [
  ['群聊·无包（98% 的真实情况）', bundle('group', [])],
  ['群聊·表情库已装载', bundle('group', ['stickerBox'])],
  ['私聊（工具全挂）', bundle('private', [])]
];

console.log('=== 【表情包】段 ===');
let base = 0, full = 0;
for (const [name, b] of cases) {
  const s = seg(b);
  if (name.startsWith('群聊·无包')) base = s.length;
  if (name.startsWith('群聊·表情库')) full = s.length;
  console.log(
    `  ${name.padEnd(24)} ${String(s.length).padStart(4)} 字 | 场景索引: ${s.includes('场景索引') ? '有' : '无'} | 提 list_stickers: ${s.includes('list_stickers') ? '有' : '无'}`
  );
}

console.log(`\n  群聊每轮省 ${full - base} 字（98% 的轮次）`);

// 经济账：user 是全价区（system 才是缓存命中区）
const PER_YEAR = 274 * 365;
const saved = full - base;
console.log(`\n=== 经济账（user 全价 ≈ 2 元/M、1.6 字/token、274 轮/天）===`);
console.log(`  每轮省 ${saved} 字 ≈ ${Math.round(saved / 1.6)} token`);
console.log(`  98% 轮次生效 → ${(Math.round(saved / 1.6) * 0.98 / 1e6 * 2 * PER_YEAR).toFixed(1)} 元/年`);

// 关键断言
const g = seg(cases[0][1]);
const q = seg(cases[1][1]);
const p = seg(cases[2][1]);
const ok = [];
if (!g.includes('list_stickers')) ok.push('群聊无包时不提 list_stickers');
else console.error('  ❌ 群聊无包时仍提到 list_stickers');
if (q.includes('list_stickers')) ok.push('表情库装载后恢复查询提示');
else console.error('  ❌ 表情库装载后查询提示没回来');
if (p.includes('list_stickers')) ok.push('私聊（工具全挂）保持可用');
else console.error('  ❌ 私聊把查询提示也砍了');
if (g.includes('本轮候选')) ok.push('候选轮换不受影响');
else console.error('  ❌ 候选丢了');
console.log(`\n  ${ok.join(' / ')}`);
