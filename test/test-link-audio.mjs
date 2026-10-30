// 链接 → 音频 的纯逻辑自检（不联网）。
// 联网部分（yt-dlp 下载、B站搜索）靠人工/文档里的探针命令验证，这里只锁「判据」。
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e?.message || e)); }
};

const {
  classifyUrl, parseMusicTitle, pickBestTrack, pickUrlFromText, linkSupportSummary
} = await import('../src/link-audio.js');

console.log('\n[链接] 站点分流');
ok('B站长链 → video', () => {
  assert.equal(classifyUrl('https://www.bilibili.com/video/BV1GJ411x7h7').kind, 'video');
});
ok('b23.tv 短链 → video', () => {
  assert.equal(classifyUrl('https://b23.tv/abc123').kind, 'video');
});
ok('网易云歌曲页 → music', () => {
  assert.equal(classifyUrl('https://music.163.com/song?id=186016').kind, 'music');
});
ok('网易云短链 163cn.tv → music', () => {
  assert.equal(classifyUrl('https://163cn.tv/abc').kind, 'music');
});
ok('QQ音乐歌曲页 → music', () => {
  assert.equal(classifyUrl('https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV').kind, 'music');
});
ok('酷狗/酷我 → music', () => {
  assert.equal(classifyUrl('https://www.kugou.com/song/#hash=x').kind, 'music');
  assert.equal(classifyUrl('https://www.kuwo.cn/play_detail/123').kind, 'music');
});
ok('.mp3 结尾 → direct（不受站点影响）', () => {
  assert.equal(classifyUrl('https://cdn.example.com/a.mp3').kind, 'direct');
  assert.equal(classifyUrl('https://cdn.example.com/a.flac?token=1').kind, 'direct');
});
ok('B站音频直链仍按 direct 处理', () => {
  assert.equal(classifyUrl('https://upos-sz-mirrorcos.bilivideo.com/x.m4a').kind, 'direct');
});
ok('YouTube / 抖音 → video', () => {
  assert.equal(classifyUrl('https://www.youtube.com/watch?v=abc').kind, 'video');
  assert.equal(classifyUrl('https://youtu.be/abc').kind, 'video');
  assert.equal(classifyUrl('https://www.douyin.com/video/123').kind, 'video');
});
ok('不认识的站点 → unknown（不硬试）', () => {
  assert.equal(classifyUrl('https://example.com/article/1').kind, 'unknown');
});
ok('非 http 链接直接判无效', () => {
  assert.equal(classifyUrl('ftp://a/b.mp3').kind, 'invalid');
  assert.equal(classifyUrl('BV1GJ411x7h7').kind, 'invalid');
  assert.equal(classifyUrl('').kind, 'invalid');
});
ok('大小写/端口/子域都不影响判断', () => {
  assert.equal(classifyUrl('HTTPS://WWW.BILIBILI.COM/video/BV1xx').kind, 'video');
  assert.equal(classifyUrl('https://music.163.com:443/song?id=1').kind, 'music');
});

console.log('\n[链接] 从文本里捞链接（模型常把链接塞进 title）');
ok('中文标点后面的链接能截干净', () => {
  assert.equal(pickUrlFromText('唱这个 https://b23.tv/abc 好听吗'), 'https://b23.tv/abc');
  assert.equal(pickUrlFromText('（https://b23.tv/abc）'), 'https://b23.tv/abc');
  assert.equal(pickUrlFromText('没有链接'), '');
});
ok('链接后面跟着中文标点不会粘进去', () => {
  const got = pickUrlFromText('听 https://music.163.com/song?id=1，然后唱');
  assert.equal(got, 'https://music.163.com/song?id=1');
});

console.log('\n[链接] 音乐平台页面标题 → 歌名/歌手');
ok('网易云：「歌名（英文） - 歌手 - 单曲 - 网易云音乐」', () => {
  const r = parseMusicTitle('晴天（Sunny Day） - 周杰伦 - 单曲 - 网易云音乐');
  assert.equal(r.song, '晴天');
  assert.equal(r.artist, '周杰伦');
});
ok('QQ音乐：后面那一长串站点名要被丢掉', () => {
  const r = parseMusicTitle('晴天 - 周杰伦 - QQ音乐-千万正版音乐海量无损曲库新歌热歌天天畅听的高品质音乐平台！');
  assert.equal(r.song, '晴天');
  assert.equal(r.artist, '周杰伦');
});
ok('og:title 只有纯歌名时优先用它', () => {
  const r = parseMusicTitle('晴天（Sunny Day） - 周杰伦 - 单曲 - 网易云音乐', { ogTitle: '晴天' });
  assert.equal(r.song, '晴天');
});
ok('酷狗常见格式「歌名 - 歌手」也能拆', () => {
  const r = parseMusicTitle('起风了 - 买辣椒也用券 - 酷狗音乐');
  assert.equal(r.song, '起风了');
  assert.equal(r.artist, '买辣椒也用券');
});
ok('拆不出歌手时 artist 为空但不报错', () => {
  const r = parseMusicTitle('起风了 - 网易云音乐');
  assert.equal(r.song, '起风了');
  assert.equal(r.artist, '');
});

console.log('\n[链接] 搜索结果选源（这条决定「唱的是不是原曲」）');
const entries = [
  { id: 'LIVE', title: '【直播回放】晴天 周杰伦 现场', duration: 300, view_count: 9000000 },
  { id: 'COVER', title: '《晴天》翻唱 女生版', duration: 260, view_count: 5000000 },
  { id: 'ACC', title: '晴天 伴奏 纯音乐 无人声', duration: 269, view_count: 8000000 },
  { id: 'GOOD', title: '【Hi-Res无损音质】晴天 - 周杰伦', duration: 269, view_count: 3200000 },
  { id: 'OK2', title: '周杰伦 - 晴天 MV', duration: 270, view_count: 17000000 },
];
ok('直播/翻唱/伴奏一律排除', () => {
  const best = pickBestTrack(entries, { song: '晴天', artist: '周杰伦' });
  assert.ok(['GOOD', 'OK2'].includes(best.id), '选中了 ' + best.id);
});
ok('「无损」那条比普通 MV 分高', () => {
  const only = entries.filter((e) => ['GOOD', 'OK2'].includes(e.id));
  assert.equal(pickBestTrack(only, { song: '晴天', artist: '周杰伦' }).id, 'GOOD');
});
ok('时长过短/过长的结果不要（<45s / >600s）', () => {
  const best = pickBestTrack([
    { id: 'SHORT', title: '晴天 周杰伦 15秒', duration: 15, view_count: 9000000 },
    { id: 'LONG', title: '晴天 周杰伦 两小时循环', duration: 7200, view_count: 9000000 },
    { id: 'MID', title: '晴天 周杰伦', duration: 269, view_count: 100 },
  ], { song: '晴天', artist: '周杰伦' });
  assert.equal(best.id, 'MID');
});
ok('只有歌手对得上、歌名完全不同 → 不选（宁可唱不出来，也别唱错歌）', () => {
  const best = pickBestTrack([
    { id: 'OTHER', title: '七里香 周杰伦', duration: 299, view_count: 99000000 },
  ], { song: '晴天', artist: '周杰伦' });
  assert.equal(best, null);
});
ok('歌名被 emoji/标签包着仍然算命中', () => {
  const best = pickBestTrack([
    { id: 'X', title: '🎵【4K修复】晴天 - 周杰伦 MV', duration: 269, view_count: 1000 },
  ], { song: '晴天', artist: '周杰伦' });
  assert.equal(best?.id, 'X');
});
ok('一条都不合适时返回 null（宁可不唱）', () => {
  assert.equal(pickBestTrack([
    { id: 'A', title: '晴天 直播回放', duration: 300 },
    { id: 'B', title: '晴天 伴奏', duration: 300 },
  ], { song: '晴天' }), null);
});

console.log('\n[链接] 对外话术');
ok('支持范围一句话里同时提到视频站和音乐平台', () => {
  const s = linkSupportSummary();
  assert.match(s, /B站/);
  assert.match(s, /网易云|QQ音乐/);
});

console.log('\n[链接] 结果 ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
