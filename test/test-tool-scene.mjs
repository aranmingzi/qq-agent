// 工具按场景装载自测（P1）。
//
// 断言围绕三件事，不是"省了多少字"：
//   ① **裁掉的不许是必需器官** —— send_message / finish / get_message_images /
//      send_sticker / web_search / memory_* / get_sticker_image 必须常驻。
//      裁掉 send_message = 她整轮说不出话；裁掉 get_sticker_image = 她瞎发表情。
//   ② **装回来的路径必须真的通** —— 包名映射、关键词命中、粘住、过期，
//      任何一环错了的表现都是"她忽然不会唱歌了"，而不是报错。
//   ③ **不该裁的地方一个字都不许动** —— enabled:false（私聊）时原样返回同一批对象。
import assert from 'node:assert';
import {
  PACK_OF, PACKS, PACK_NAMES, packOfTool,
  selectPacks, stampPacks, omittedLabels, describeOmitted, selectToolDefs
} from '../src/tool-scene.js';
import { buildToolDefs, toOpenAiTools } from '../src/tools.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[tool-scene]');

// ── 1. 包映射 ────────────────────────────────────────────────
ok('① 唱歌全家都在 song 包里（含 cancel_song —— 少它就没法"说停就停"）', () => {
  for (const n of ['sing_lyrics', 'sing_cover', 'sing_convert', 'play_song', 'queue_status', 'cancel_song']) {
    assert.strictEqual(packOfTool(n), 'song', n);
  }
});

ok('①b send_voice 不算唱歌，必须常驻（"发个语音"和"唱首歌"是两件事）', () => {
  assert.strictEqual(packOfTool('send_voice'), null);
});

ok('② 聊天主循环的工具**没有**包（= 常驻）', () => {
  for (const n of ['send_message', 'finish', 'get_message_images', 'send_sticker', 'web_search',
    'memory_append', 'memory_query', 'memory_remove', 'diary', 'send_poke',
    'get_recent_messages', 'search_messages', 'get_active_members', 'get_message_detail',
    'report_feedback', 'wait_for_mention', 'load_tools']) {
    assert.strictEqual(packOfTool(n), null, `${n} 不该被裁`);
  }
});

ok('③ get_sticker_image 故意常驻：它是"发之前先看一眼"的安全阀', () => {
  assert.strictEqual(packOfTool('get_sticker_image'), null);
});

ok('④ 映射里不许出现不存在的包名', () => {
  for (const [tool, pack] of Object.entries(PACK_OF)) {
    assert.ok(PACKS[pack], `${tool} 指向了未定义的包 ${pack}`);
  }
  assert.deepStrictEqual(PACK_NAMES.sort(), Object.keys(PACKS).sort());
});

// ── 2. 关键词 → 包 ───────────────────────────────────────────
ok('⑤ 闲聊不点亮任何包（这是省字的主路径）', () => {
  assert.deepStrictEqual(selectPacks({ text: '今天好热啊，你们开空调了吗' }).matched, []);
});

ok('⑥ 点歌关键词点亮 song', () => {
  for (const t of ['唱首歌', '@我 来一首', '点歌 稻香', '这首歌好听', '帮我翻唱一下', '放首歌听听']) {
    assert.deepStrictEqual(selectPacks({ text: t }).matched, ['song'], t);
  }
});

ok('⑦ 链接 / "看看这个"点亮 webRead', () => {
  for (const t of ['https://www.bilibili.com/video/BV1xx', '这个链接讲啥', '帮我看看这个视频', '读了这篇文章']) {
    assert.ok(selectPacks({ text: t }).matched.includes('webRead'), t);
  }
});

ok('⑧ 表情 / 收藏点亮 stickerBox', () => {
  for (const t of ['你这表情包哪来的', '要不要斗图', '收藏了这个表情']) {
    assert.ok(selectPacks({ text: t }).matched.includes('stickerBox'), t);
  }
});

ok('⑨ 问梗点亮 meme', () => {
  for (const t of ['这是什么梗', '这梗好老了', '最近有啥新梗']) {
    assert.ok(selectPacks({ text: t }).matched.includes('meme'), t);
  }
});

// ── 3. 粘住 / 过期 ──────────────────────────────────────────
ok('⑩ 上一轮点过歌、这一轮没关键词 → 仍然装着（唱到一半工具不能没）', () => {
  const now = 1_000_000_000_000;
  const prev = stampPacks({}, ['song'], now);
  const r = selectPacks({ text: '这首太难听了吧', prev, now: now + 60_000 });
  assert.ok(r.active.has('song'), '1 分钟后必须还装着');
  assert.deepStrictEqual(r.kept, ['song']);
  assert.deepStrictEqual(r.matched, [], '不是关键词命中的，别谎报');
});

ok('⑪ 超过 stickyMs 自动卸掉（否则一次点歌挂一整天 = 白裁）', () => {
  const now = 1_000_000_000_000;
  const prev = stampPacks({}, ['song'], now);
  const r = selectPacks({ text: '那算了', prev, now: now + PACKS.song.stickyMs + 1000 });
  assert.ok(!r.active.has('song'));
});

ok('⑫ stampPacks 会清掉过期项，状态不会无限长', () => {
  const now = 1_000_000_000_000;
  const st = { song: now - PACKS.song.stickyMs - 1, meme: now };
  const next = stampPacks(st, [], now);
  assert.ok(!('song' in next), '过期项要删掉');
  assert.ok('meme' in next, '没过期的要留着');
});

ok('⑬ stampPacks 不认识的名字直接忽略（模型可能编个包名）', () => {
  const next = stampPacks({}, ['song', 'nonsense', ''], 1_000_000_000_000);
  assert.deepStrictEqual(Object.keys(next), ['song']);
});

// ── 4. 过滤 ─────────────────────────────────────────────────
const defs = buildToolDefs();

ok('⑭ enabled:false 原样返回同一批对象（私聊路径，一个字节都不许变）', () => {
  const r = selectToolDefs(defs, { enabled: false });
  assert.strictEqual(r.defs.length, defs.length);
  assert.strictEqual(r.removed.length, 0);
  for (let i = 0; i < defs.length; i += 1) assert.strictEqual(r.defs[i], defs[i]);
});

ok('⑮ 不装任何包时，常驻工具一个不少', () => {
  const { defs: kept } = selectToolDefs(defs, { active: new Set(), enabled: true });
  const names = new Set(kept.map((d) => d.name));
  for (const n of ['send_message', 'finish', 'get_message_images', 'send_sticker', 'web_search',
    'memory_append', 'get_sticker_image', 'load_tools']) {
    assert.ok(names.has(n), `裁掉了 ${n}`);
  }
});

ok('⑯ 不装任何包时，重工具确实被裁掉', () => {
  const { removed } = selectToolDefs(defs, { active: new Set(), enabled: true });
  for (const n of ['sing_lyrics', 'sing_cover', 'play_song', 'cancel_song',
    'list_stickers', 'web_fetch', 'watch_video', 'search_meme']) {
    assert.ok(removed.includes(n), `该裁没裁：${n}`);
  }
  // send_voice 例外：它不是唱歌，是"用语音说话"，必须常驻
  assert.ok(!removed.includes('send_voice'), 'send_voice 不该被裁（"发个语音"≠"唱首歌"）');
});

ok('⑰ 真的省下了三成以上（用真实工具定义量）', () => {
  const size = (arr) => JSON.stringify(toOpenAiTools(arr)).length;
  const before = size(defs);
  const after = size(selectToolDefs(defs, { active: new Set(), enabled: true }).defs);
  // 实测轨迹：2026-10-25 24185 → 15047（省 38%）；2026-10-26 24808 → 15670（省 37%）。
  // 分子分母都是常驻工具，一起涨（search_messages 加了 before/after 两个翻页参数），
  // 所以比率只会被**常驻工具**稀释 —— 那是"该常驻的东西变多了"，不是"裁得不够"。
  // 阈值取 0.68 = 保底省 32%，给工具定义的自然生长留余量；
  // 真退化成"裁不动了"（比如某天常驻工具暴涨）时比率会跳到 0.9 以上，这条必须报警。
  assert.ok(after < before * 0.68, `只省了 ${(100 - (after / before) * 100).toFixed(0)}%：${before} → ${after}`);
});

ok('⑱ 装了 song 包，唱歌工具全部回来（含 cancel_song）', () => {
  const { defs: kept } = selectToolDefs(defs, { active: new Set(['song']), enabled: true });
  const names = new Set(kept.map((d) => d.name));
  for (const n of ['sing_lyrics', 'sing_cover', 'sing_convert', 'play_song', 'queue_status', 'cancel_song']) {
    assert.ok(names.has(n), `装了还没回来：${n}`);
  }
  // 别的包不许顺带回来
  assert.ok(!names.has('web_fetch'), '装 song 不该带出 webRead');
});

// ── 5. 提示词文案 ───────────────────────────────────────────
ok('⑲ 全装着时提示词为空串（整段不出现，别留一句废话）', () => {
  assert.strictEqual(describeOmitted(new Set(PACK_NAMES)), '');
  assert.deepStrictEqual(omittedLabels(new Set(PACK_NAMES)), []);
});

ok('⑳ 没装的时候要写清"用 load_tools 拿"，而不是只说"没有"', () => {
  const s = describeOmitted(new Set());
  assert.ok(s.includes('load_tools'), s);
  assert.ok(s.includes('唱歌'), s);
  // 只说"没装"会让模型直接回答"我没有这个功能"（安全规则正好这么要求它）
  assert.ok(!/^【按需工具】[^。]*没有/.test(s));
});

ok('㉑ 已装的包不出现在"目前没装"里', () => {
  const s = describeOmitted(new Set(['song']));
  const tail = s.split('目前没装：')[1] || '';
  assert.ok(!tail.includes('唱歌'), `已装的还列在没装里：${tail}`);
  assert.ok(tail.includes('表情库'), tail);
});

console.log(`\n[tool-scene] ${pass} 项通过`);
