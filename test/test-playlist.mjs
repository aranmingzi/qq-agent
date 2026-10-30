// 点歌台自检：node test/test-playlist.mjs
//
// 覆盖四层里最容易回归的部分：
//   1. B站标题解析（真实缓存里的 6 种标题写法）
//   2. 指令解析（哪些该进、哪些必须放给模型）
//   3. 检索判定（精确命中 vs 多候选）
//   4. 转码交付（m4s 私有头 / mp3 时长 / 语音片段）
//
// 需要本机已有 B站缓存；没有的话第 4 段会跳过。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTitle } from '../src/playlist.js';
import { parsePlaylistCommand } from '../src/playlist-commands.js';
import { ensureLibrary, resolvePlayQuery, formatLibraryPage } from '../src/playlist.js';
import { ensureMp3, ensureSnippetWav, isAudioCached } from '../src/playback.js';
import { probeMedia } from '../src/media-tools.js';

const pass = (name) => console.log(`  ✓ ${name}`);
let failed = 0;
function check(name, fn) {
  try { fn(); pass(name); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

console.log('[1] 标题解析');
const cases = [
  { raw: '【AI纳西妲】《青花瓷》纳西妲一直在等你！', title: '青花瓷', artist: '纳西妲' },
  { raw: '【AI纳西妲】《好想爱这个世界啊（片段）》', title: '好想爱这个世界啊', artist: '纳西妲' },
  { raw: '胡桃《把回忆拼好给你》完整版｜B站最强AI调音', title: '把回忆拼好给你', artist: '胡桃' },
  { raw: '反方向的钟 - May', title: '反方向的钟', artist: 'May' },
  { raw: '《崩坏：星穹铁道》EP：「使一颗心免于哀伤」', title: '使一颗心免于哀伤' },
  { raw: '【胡桃/檐上猫】一只小懒猫，喵~', title: '一只小懒猫，喵', artist: '胡桃/檐上猫' },
  { raw: '《妈妈的话》纳西妲', title: '妈妈的话', artist: '纳西妲' },
];
for (const c of cases) {
  check(c.raw, () => {
    const p = parseTitle(c.raw, { uploader: '测试UP' });
    assert.equal(p.title, c.title, `title=${p.title}`);
    if (c.artist) assert.equal(p.artist, c.artist, `artist=${p.artist}`);
  });
}
check('合集识别', () => {
  assert.equal(parseTitle('胡桃翻唱大合集', { duration: 1833 }).kind, 'collection');
  assert.equal(parseTitle('好想爱这个世界啊（片段）', { duration: 74 }).kind, 'clip');
  assert.equal(parseTitle('青花瓷', { duration: 240 }).kind, 'song');
});

console.log('[2] 指令解析');
const cmdCases = [
  ['#点歌 青花瓷', 'play', '青花瓷'],
  ['点歌 青花瓷', 'play', '青花瓷'],
  ['点歌青花瓷', 'play', '青花瓷'],
  ['@我 #点歌 7', 'play', '7'],
  ['#点歌', 'play', ''],
  ['#歌单 2', 'list', '2'],
  ['#搜歌 纳西妲', 'search', '纳西妲'],
  ['#随机', 'random', ''],
  ['#重扫歌单', 'rebuild', ''],
  ['#点歌帮助', 'help', ''],
];
for (const [text, cmd, arg] of cmdCases) {
  check(text, () => {
    const p = parsePlaylistCommand(text);
    assert.ok(p, '应当被识别为指令');
    assert.equal(p.cmd, cmd);
    assert.equal(p.arg, arg);
  });
}
const nonCommands = ['点歌', '歌单', '随机', '点歌姬今天好可爱', '放首歌听听', '我想点歌但不知道点啥'];
for (const text of nonCommands) {
  check(`不拦截：${text}`, () => assert.equal(parsePlaylistCommand(text), null));
}

console.log('[3] 歌单与检索');
let lib = null;
try {
  lib = await ensureLibrary({ log: () => {} });
} catch (error) {
  console.log(`  ! 跳过：${error?.message ?? error}`);
}
if (lib) {
  check(`歌单可用（${lib.stats.playable} 首 / ${lib.stats.collections} 合集）`, () => {
    assert.ok(lib.stats.playable >= 1, '至少要有一首可点播');
  });
  check('分页展示', () => {
    const text = formatLibraryPage(1, { lib });
    assert.match(text, /点歌台/);
    assert.match(text, /#点歌/);
  });
  for (const [q, expect] of [['青花瓷', '青花瓷'], ['使一颗心免于哀伤', '使一颗心免于哀伤'], ['反方向的钟', '反方向的钟'], ['后来我们的爱', '后来我们的爱']]) {
    const r = resolvePlayQuery(q, { lib });
    check(`精确命中：${q}`, () => {
      assert.ok(r.track, `未命中（reason=${r.reason}）`);
      assert.equal(r.track.title, expect);
    });
  }
  check('歌手查询返回多候选而不是乱播', () => {
    const r = resolvePlayQuery('纳西妲', { lib });
    assert.equal(r.track, null);
    assert.ok(r.candidates.length >= 2);
  });
  check('序号点播', () => {
    const r = resolvePlayQuery('1', { lib });
    assert.ok(r.track && r.track.no === 1);
  });
  check('BV 号精确点播', () => {
    const t = lib.tracks.find((x) => x.source?.bvid);
    assert.ok(t, '歌单里应有带 bvid 的曲目');
    for (const q of [
      t.source.bvid,
      t.source.bvid.toLowerCase(),
      `https://www.bilibili.com/video/${t.source.bvid}/?spm_id_from=333.999`,
      `#点歌 ${t.source.bvid}`,
    ]) {
      const r = resolvePlayQuery(q, { lib });
      assert.equal(r.reason, 'bvid', `应识别为 BV 点播：${q}`);
      assert.equal(r.track.id, t.id);
    }
  });
  check('未缓存的 BV 号不瞎猜', () => {
    const r = resolvePlayQuery('BV1d2ng6VEft', { lib });
    assert.equal(r.reason, 'notCached');
    assert.equal(r.track, null);
  });
  check('点名合集只提示、不自动播', () => {
    const r = resolvePlayQuery('胡桃翻唱大合集', { lib });
    assert.equal(r.reason, 'collection');
    assert.equal(r.track, null);
  });
  check('两字歌手不误判成合集', () => {
    const r = resolvePlayQuery('胡桃', { lib });
    assert.notEqual(r.reason, 'collection');
  });

  console.log('[4] 转码与试听');
  const playable = lib.tracks.filter((t) => t.status === 'ok' && t.kind !== 'collection');
  const target = playable.slice().sort((a, b) => a.duration - b.duration)[0];
  if (!target) {
    console.log('  ! 跳过：没有可播曲目');
  } else {
    const mp3 = await ensureMp3(target, { log: () => {} });
    const st = fs.statSync(mp3);
    check(`转码《${target.title}》→ mp3（${(st.size / 1048576).toFixed(2)}MB）`, () => {
      assert.ok(st.size > 200 * 1024, 'mp3 太小，可能没成功');
      assert.equal(isAudioCached(target), true, '缓存签名不匹配');
    });
    const p = await probeMedia(mp3);
    check(`mp3 时长有效（${Math.round(p.duration)}s）`, () => {
      assert.ok(p.ok && p.duration > 10);
      if (target.duration) assert.ok(Math.abs(p.duration - target.duration) <= 4, `时长差太多：${p.duration} vs ${target.duration}`);
    });
    const wav = await ensureSnippetWav(target, { seconds: 10 });
    const wst = fs.statSync(wav);
    check(`试听片段（${(wst.size / 1024).toFixed(0)}KB）`, () => {
      assert.ok(wst.size > 100 * 1024);
    });
  }
}

console.log('');
if (failed) {
  console.error(`失败 ${failed} 项`);
  process.exit(1);
}
console.log('全部通过');
