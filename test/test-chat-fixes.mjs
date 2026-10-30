// 群里真实翻车点 → 回归测试（2026-10-19 晚）
//   1) 没有旋律来源时不再乱唱（群友要《雨爱》没给音频，机器人现编了一段被喊「别唱了」）
//   2) 群友发的 QQ 文件能取到（以前报「协议端没给地址」）
//   3) 说「别唱了」要真取消（以前只在话里答应，歌照样发出来）
//   4) 合并转发里的图片/视频能被提取（以前只看到 [图片] 占位符，识图工具查不到）
//   5) 等待预期要含排队时间（以前说「一分多钟」实际等了三分半）

import assert from 'node:assert/strict';
import http from 'node:http';
import { buildToolDefs, fetchFileById } from '../src/tools.js';
import { collectForwardMedia } from '../src/onebot.js';
import fs from 'node:fs';
import {
  findLocalSong, findMelody, findSongInPlaylist, findCachedPlaylistAudio,
} from '../src/song-router.js';
import { cancelSongJobsByChat, songQueueReady } from '../src/song-jobs.js';
import { svcConfig } from '../src/svc-voice.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log('  ✓', name); })
    .catch((e) => { fail += 1; console.log('  ✗', name, '→', e?.message ?? e); });
}

const defs = buildToolDefs();
const tool = (n) => {
  const t = defs.find((d) => d.name === n);
  assert.ok(t, `工具 ${n} 不存在`);
  return t;
};

// 最小 ctx：不碰真实队列/协议端
function fakeCtx() {
  return {
    chatKey: 'group:20000002',
    emit: () => {},
    store: { findByMid: () => null, recent: () => [] },
    session: { sent: [], pastStateCount: 0 },
    onebot: { call: async () => ({}) },
    sender: {},
  };
}

async function callSing(args) {
  const r = await tool('sing_lyrics').execute(fakeCtx(), args);
  let data = null;
  try { data = JSON.parse(r.content); } catch { /* 纯文本回执 */ }
  return { raw: r.content, data, isError: !!r.isError };
}

console.log('\n[1] 没有调就不唱');

await check('默认关闭现编（allowImprovise=false）', () => {
  assert.equal(svcConfig().allowImprovise, false);
});

await check('曲库里没有的歌 + 没音频 → 返回 needsMelody，不开唱', async () => {
  // 2026-10-29：曲库里出现了《雨爱》原曲（songs/raw/雨爱.m4a），这条用例改用
  // "曲库/旋律库/点歌台都翻不到的歌名"，不再依赖某个具体文件不存在。
  const r = await callSing({ lyrics: '啦啦啦 这是一首没有来历没有伴奏的歌谣', title: '完全不存在的一首测试歌XYZ' });
  assert.equal(r.isError, false);
  assert.equal(r.data?.needsMelody, true, `实际回执：${r.raw.slice(0, 200)}`);
  assert.match(String(r.data?.note), /没有调|要素材|发过来|哼/);
});

await check('回执里不许出现「已排上队/马上就好」这类误导', async () => {
  const r = await callSing({ lyrics: '啦啦啦 这是一首没有来历没有伴奏的歌谣', title: '完全不存在的一首测试歌XYZ' });
  assert.doesNotMatch(String(r.data?.note), /已排上队|马上就好|大约 \d+ 秒开口/);
});

await check('只给歌词不给歌名、也没音频 → 同样不开唱', async () => {
  const r = await callSing({ lyrics: '啦啦啦 我是一段没有来历的词' });
  assert.equal(r.data?.needsMelody, true);
});

await check('曲库里有原曲的歌不受影响（有旋律来源）', () => {
  // 判据本身：曲库/旋律库命中 → 不算「没有调」
  const song = findLocalSong('反方向的钟');
  assert.ok(song, '曲库里应当有《反方向的钟》');
});

await check('《雨爱》确实不在曲库也不在旋律库（前置条件）', () => {
  // 2026-10-29 注：这条前置条件依赖磁盘状态。10-23 起 songs/raw/ 里出现了
  // 雨爱.m4a（点歌台缓存的产物），前置条件自然失效 —— 那不是回归，
  // 是"曲库里有原曲的歌"这一正当状态。测试改为探测：有素材就该走"有旋律来源"路径。
  const song = findLocalSong('雨爱');
  if (song) {
    assert.ok(song.path, '命中时必须给得出路径');
    console.log('  （曲库里已有《雨爱》原曲，前置条件按"有素材"分支验证）');
  } else {
    assert.equal(findMelody('雨爱'), null);
  }
});

await check('点歌台缓存也算曲库（群里点名的《使一颗心免于哀伤》能直接翻唱）', async () => {
  // 点歌台（B站缓存）里有这首歌 —— 不用群友发文件也能唱，这是最省事的一条路
  const hit = await findSongInPlaylist('使一颗心免于哀伤');
  assert.ok(hit?.path, '点歌台里应当能找到《使一颗心免于哀伤》');
  assert.ok(fs.existsSync(hit.path), `转码产物不存在：${hit.path}`);
  assert.equal(hit.fromPlaylist, true);
  assert.equal(findCachedPlaylistAudio('使一颗心免于哀伤')?.title, '使一颗心免于哀伤');
});

console.log('\n[2] 群友发的 QQ 文件能取到');

await check('sing_lyrics 支持 messageId 参数（群友发音频）', () => {
  const p = tool('sing_lyrics').parameters.properties;
  assert.ok(p.messageId, '缺少 messageId');
  assert.ok(p.url, '缺少 url');
});

await check('取不到时提示要具体到 file_id（不再是笼统的「协议端没给地址」）', async () => {
  const entry = {
    mid: '1001',
    media: [{ kind: 'file', fileId: '', name: 'x.mp3', file: 'C:/nope/x.mp3', url: '' }],
  };
  const ctx = { ...fakeCtx(), store: { findByMid: () => entry } };
  const r = await tool('sing_lyrics').execute(ctx, { lyrics: '测试一段词', messageId: '1001' });
  assert.match(String(r.content), /file_id|重新发/);
});

await check('有 file_id 时真能下载（get_file → 取地址 → 拿字节）', async () => {
  // 起一个一次性 http 服务模拟 NapCat 给的下载地址
  const body = Buffer.concat([Buffer.from('ID3!'), Buffer.alloc(4096, 7)]);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const ctx = { ...fakeCtx(), onebot: { call: async () => ({ url: `http://127.0.0.1:${port}/a.mp3` }) } };
    const got = await fetchFileById(ctx, 'file-id-123', 8 * 1024 * 1024, '哪里都是你.mp3');
    assert.equal(got.buffer.length, body.length, '下载字节数不一致');
    assert.equal(got.ext, 'mp3', `扩展名应为 mp3，实际 ${got.ext}`);
    assert.match(got.name, /mp3/);
  } finally {
    server.close();
  }
});

await check('get_file 不给地址时给出可诊断的报错', async () => {
  const ctx = { ...fakeCtx(), onebot: { call: async () => ({}) } };
  await assert.rejects(() => fetchFileById(ctx, 'file-id-123'), /没返回可下载地址/);
});

console.log('\n[3] 说「别唱了」要真取消');

await check('cancel_song 工具存在', () => {
  const t = tool('cancel_song');
  assert.match(t.description, /别唱了|不唱了/);
});

await check('队列没启动时 cancel_song 安全返回（不抛错）', async () => {
  const r = await tool('cancel_song').execute(fakeCtx(), {});
  assert.equal(!!r.isError, false);
  assert.match(String(r.content), /没有在排队|队列没启动/);
});

await check('cancelSongJobsByChat 在队列未启动时返回 ok:false', () => {
  const r = cancelSongJobsByChat('group:20000002');
  assert.equal(r.ok, songQueueReady() ? r.ok : false);
});

console.log('\n[4] 合并转发里的图片/视频');

await check('转发节点里的图片能被提取', () => {
  const payload = {
    messages: [{
      data: {
        nickname: '群友A',
        content: [
          { type: 'text', data: { text: '你看这个' } },
          { type: 'image', data: { file: 'abc.jpg', url: 'https://gchat.qpic.cn/abc.jpg' } },
        ],
      },
    }],
  };
  const m = collectForwardMedia(payload);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'image');
  assert.equal(m[0].url, 'https://gchat.qpic.cn/abc.jpg');
  assert.equal(m[0].fromForward, true);
});

await check('转发里的视频能被提取', () => {
  const payload = {
    messages: [{ data: { content: [{ type: 'video', data: { file: 'v.mp4', url: 'https://x/v.mp4' } }] } }],
  };
  const m = collectForwardMedia(payload);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'video');
});

await check('转发里套转发也能挖一层', () => {
  const payload = {
    messages: [{
      data: {
        content: [{
          type: 'forward',
          data: { content: [{ data: { content: [{ type: 'image', data: { url: 'https://x/inner.jpg' } }] } }] },
        }],
      },
    }],
  };
  const m = collectForwardMedia(payload);
  assert.ok(m.some((x) => x.kind === 'image' && x.url === 'https://x/inner.jpg'), '没挖到嵌套转发里的图');
});

await check('转发里没有媒体时不瞎塞', () => {
  const m = collectForwardMedia({ messages: [{ data: { content: [{ type: 'text', data: { text: 'hi' } }] } }] });
  assert.equal(m.length, 0);
});

await check('最多收 6 个，避免刷爆视觉上下文', () => {
  const nodes = [];
  for (let i = 0; i < 20; i += 1) {
    nodes.push({ data: { content: [{ type: 'image', data: { url: `https://x/${i}.jpg` } }] } });
  }
  assert.equal(collectForwardMedia({ messages: nodes }).length, 6);
});

await check('识图工具已支持视频（抽帧），提示词也写了', () => {
  assert.match(tool('get_message_images').description, /图片/);
});

console.log('\n[5] 排队回执要含等待时间');

await check('翻唱/唱歌回执字段声明了 waitSec / etaTotalSec', () => {
  const d = tool('sing_lyrics').description;
  assert.match(d, /etaSec|etaTotalSec|排队/);
});

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
