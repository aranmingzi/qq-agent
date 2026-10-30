// 看视频（video-intel）自检：判据与纯逻辑不联网；联网部分用 VIDEO_LIVE=1 单跑。
// 联网之所以不放进常规自检：B站接口有风控（412），把"网络抖动"当成 bug 会养出假红。
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e?.message || e)); }
};
const okAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e?.message || e)); }
};

const {
  findVideoUrl, normalizeVideoUrl, parseBiliRef, mmss,
  aggregateDanmaku, chapterText, pickSubtitleTrack, vttToText, json3ToText,
  buildDigest, videoConfig, isQuietHour, canAutoWatch, noteAutoWatch,
  fetchIntel, watchVideo, videoSupportSummary, readVideoCache
} = await import('../src/video-intel.js');

console.log('\n[视频] 找链接');
ok('B站完整链接', () => {
  const r = findVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2');
  assert.equal(r?.site, 'bilibili');
  assert.match(r?.url || '', /BV1GJ411x7h7/);
});
ok('b23.tv 短链', () => {
  const r = findVideoUrl('https://b23.tv/abc123');
  assert.equal(r?.site, 'bilibili');
});
ok('裸 BV 号（群里最常见的分享形态）', () => {
  const r = findVideoUrl('这个 BV1GJ411x7h7 笑死我了');
  assert.equal(r?.bare, true);
  assert.equal(r?.url, 'https://www.bilibili.com/video/BV1GJ411x7h7');
});
ok('中文标点贴着链接也不会被吞进去', () => {
  const r = findVideoUrl('看看这个：https://www.bilibili.com/video/BV1GJ411x7h7，超好笑');
  assert.equal(r?.url, 'https://www.bilibili.com/video/BV1GJ411x7h7');
});
ok('YouTube / 抖音', () => {
  assert.equal(findVideoUrl('https://www.youtube.com/watch?v=abc')?.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(findVideoUrl('https://www.douyin.com/video/123')?.site, 'douyin');
});
ok('音乐平台链接不算视频（那是翻唱的地盘）', () => {
  assert.equal(findVideoUrl('https://music.163.com/song?id=186016'), null);
});
ok('普通文章链接不算视频', () => {
  assert.equal(findVideoUrl('https://example.com/article/1'), null);
});
ok('纯文本没有链接', () => {
  assert.equal(findVideoUrl('今天天气不错'), null);
});

console.log('\n[视频] URL 归一化与解析');
ok('查询串不计入缓存键', () => {
  assert.equal(
    normalizeVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333.999'),
    normalizeVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?vd_source=abc')
  );
});
ok('分 P 单独成键（p=2 讲的不是 p=1）', () => {
  assert.notEqual(
    normalizeVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=1'),
    normalizeVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=2')
  );
});
ok('BV / av / 分P 都能认', () => {
  assert.deepEqual(parseBiliRef('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3'), { bvid: 'BV1GJ411x7h7', aid: 0, page: 3 });
  assert.deepEqual(parseBiliRef('https://www.bilibili.com/video/av170001'), { bvid: '', aid: 170001, page: 1 });
});
ok('mmss 时长的两种形态', () => {
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(65), '1:05');
  assert.equal(mmss(3725), '1:02:05');
});

console.log('\n[视频] 弹幕聚合');
const dmXml = '<i><chatserver>x</chatserver>'
  + '<d p="10.1,1,25,16777215,1,0,a,1">哈哈哈哈</d>'
  + '<d p="20.0,1,25,16777215,1,0,a,2">哈哈哈哈</d>'
  + '<d p="30.0,1,25,16777215,1,0,a,3">第三段</d>'
  + '<d p="600.0,1,25,16777215,1,0,a,4">结尾</d>'
  + '<d p="610.0,1,25,16777215,1,0,a,5">结尾</d>'
  + '<d p="620.0,1,25,16777215,1,0,a,6">' + '刷屏'.repeat(30) + '</d>'
  + '</i>';
ok('高频计数 + 超长弹幕丢弃', () => {
  const a = aggregateDanmaku(dmXml, { topN: 10 });
  assert.equal(a.count, 5, '超长那条不该计数');
  assert.equal(a.top[0].text, '哈哈哈哈');
  assert.equal(a.top[0].n, 2);
});
ok('时间线按桶取代表弹幕', () => {
  const a = aggregateDanmaku(dmXml, { duration: 630, buckets: 4 });
  assert.ok(a.timeline.length >= 2, '应该有至少两个桶有内容');
  assert.equal(a.timeline[0].at, 0);
  assert.equal(a.timeline[0].text, '哈哈哈哈');
});
ok('短视频不切桶（桶里没东西，切了更看不懂）', () => {
  const a = aggregateDanmaku(dmXml, { duration: 60, buckets: 6 });
  assert.equal(a.timeline.length, 0);
});
ok('没有弹幕时是空结果而不是报错', () => {
  const a = aggregateDanmaku('', {});
  assert.equal(a.count, 0);
  assert.deepEqual(a.top, []);
  assert.deepEqual(a.timeline, []);
});

console.log('\n[视频] 章节与字幕轨');
ok('章节文案：纯文本 / JSON / 空', () => {
  assert.equal(chapterText('开场介绍'), '开场介绍');
  assert.equal(chapterText('{"title":"正片"}'), '正片');
  assert.equal(chapterText(''), '');
  assert.equal(chapterText('{坏掉的 json'), '{坏掉的 json');
});
ok('字幕轨：人工字幕优先于自动字幕', () => {
  const meta = {
    subtitles: { 'zh-Hans': [{ ext: 'json3', url: 'https://a/manual' }] },
    automatic_captions: { 'zh-Hans': [{ ext: 'json3', url: 'https://a/auto' }] }
  };
  const t = pickSubtitleTrack(meta);
  assert.equal(t.url, 'https://a/manual');
  assert.equal(t.auto, false);
});
ok('字幕轨：没有中文就退到英文', () => {
  const t = pickSubtitleTrack({ subtitles: {}, automatic_captions: { en: [{ ext: 'vtt', url: 'https://a/en' }] } });
  assert.equal(t.lang, 'en');
  assert.equal(t.auto, true);
});
ok('字幕轨：一条都没有返回 null（不许瞎猜）', () => {
  assert.equal(pickSubtitleTrack({}), null);
  assert.equal(pickSubtitleTrack(null), null);
});
ok('vtt / json3 解析', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好<b>世界</b>\n\n00:00:03.000 --> 00:00:04.000\n第二句\n';
  assert.equal(vttToText(vtt), '你好世界 第二句');
  const j3 = { events: [{ segs: [{ utf8: '你好' }] }, { segs: [{ utf8: ' ' }, { utf8: '世界' }] }] };
  assert.equal(json3ToText(j3), '你好 世界');
});

console.log('\n[视频] 材料文本');
const fakeIntel = {
  site: 'B站', url: 'https://www.bilibili.com/video/BV1', title: '测试视频',
  author: '某UP', duration: 754, desc: '简介内容', dynamic: '', publishedAt: '2026-10-22',
  stats: { view: 12345, like: 0, reply: 0, danmaku: 0 }, cover: '', pages: [], tags: ['知识', '科普'],
  chapters: [{ from: 0, to: 120, title: '开场' }, { from: 120, to: 600, title: '正片' }],
  subtitle: { lang: '中文', text: '字幕内容' },
  danmaku: { count: 10, top: [{ text: '前排', n: 3 }], timeline: [{ at: 60, text: '来了' }] },
  comments: ['讲得真好'], frames: null,
  materials: ['标题', '简介', '章节', '字幕', '弹幕', '热评'], missing: ['AI字幕（要登录，匿名拿不到）']
};
ok('材料文本含关键块', () => {
  const d = buildDigest(fakeIntel, { maxChars: 6000 });
  assert.match(d, /【视频】测试视频/);
  assert.match(d, /UP主\/作者：某UP/);
  assert.match(d, /12:34/);
  assert.match(d, /【章节】/);
  assert.match(d, /【弹幕按时间】/);
  assert.match(d, /【热评】/);
});
ok('缺什么材料必须写进文本（不许静默降级）', () => {
  const d = buildDigest(fakeIntel, { maxChars: 6000 });
  assert.match(d, /【没拿到的材料】/);
  assert.match(d, /AI字幕（要登录/);
});
ok('超预算时硬裁并标注', () => {
  const big = { ...fakeIntel, subtitle: { lang: '中文', text: '字幕'.repeat(5000) } };
  const d = buildDigest(big, { maxChars: 1500 });
  assert.ok(d.length <= 1600, `实际 ${d.length}`);
  assert.match(d, /已截断/);
});
ok('只有标题时也要能出一段（且写明材料不足）', () => {
  const d = buildDigest({ ...fakeIntel, desc: '', chapters: [], subtitle: null, danmaku: null, comments: [], tags: [], missing: ['字幕', '弹幕'] }, { maxChars: 6000 });
  assert.match(d, /【视频】测试视频/);
  assert.match(d, /【没拿到的材料】字幕、弹幕/);
});

console.log('\n[视频] 配置兜底');
ok('默认是开着的', () => {
  const c = videoConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.autoReply, true);
  assert.equal(c.keyframes, false);
});
ok('空字符串不能变 0（Number(\'\') 的老坑）', () => {
  const c = videoConfig({ video: { maxChars: '', cacheHours: '', frameCount: '' } });
  assert.equal(c.maxChars, 6000);
  assert.equal(c.cacheHours, 12);
  assert.equal(c.frameCount, 4);
});
ok('越界值夹回区间', () => {
  const c = videoConfig({ video: { frameCount: 99, maxChars: 1, cacheHours: -5 } });
  assert.equal(c.frameCount, 6);
  assert.equal(c.maxChars, 1000);
  assert.equal(c.cacheHours, 0);
});
ok('关键帧默认关（一个链接不能拖进几百 MB）', () => {
  assert.equal(videoConfig({}).keyframes, false);
  assert.equal(videoConfig({ video: { keyframes: 'true' } }).keyframes, false);
});

console.log('\n[视频] 静默时段');
ok('0-6 点静默，白天不静默', () => {
  const c = videoConfig({});
  assert.equal(isQuietHour(c, new Date(2026, 9, 22, 2)), true);
  assert.equal(isQuietHour(c, new Date(2026, 9, 22, 12)), false);
  assert.equal(isQuietHour(c, new Date(2026, 9, 22, 6)), false);
});
ok('from==to 视为不静默（不是"全天静默"）', () => {
  assert.equal(isQuietHour(videoConfig({ video: { quietFromHour: 3, quietToHour: 3 } }), new Date(2026, 9, 22, 10)), false);
});
ok('跨零点的时段（22-6）', () => {
  const c = videoConfig({ video: { quietFromHour: 22, quietToHour: 6 } });
  assert.equal(isQuietHour(c, new Date(2026, 9, 22, 23)), true);
  assert.equal(isQuietHour(c, new Date(2026, 9, 22, 3)), true);
  assert.equal(isQuietHour(c, new Date(2026, 9, 22, 12)), false);
});

console.log('\n[视频] 自动看视频的预算');
ok('第一次可以看', () => {
  const c = videoConfig({});
  assert.equal(canAutoWatch('group:1', 'https://b23.tv/a', c).ok, true);
});
ok('记完账：同一链接 30 分钟内不重复', () => {
  const c = videoConfig({});
  const url = 'https://www.bilibili.com/video/BV1budgetA';
  noteAutoWatch('group:2', url);
  const v = canAutoWatch('group:2', url, c);
  assert.equal(v.ok, false);
  assert.match(v.reason, /刚看过/);
});
ok('不同链接不受"同一个链接"限制，但受冷却限制', () => {
  const c = videoConfig({});
  noteAutoWatch('group:3', 'https://www.bilibili.com/video/BV1coolA');
  const v = canAutoWatch('group:3', 'https://www.bilibili.com/video/BV1coolB', c);
  assert.equal(v.ok, false);
  assert.match(v.reason, /缓一下/);
});
ok('关掉就一律不看，且说得出原因', () => {
  const v = canAutoWatch('group:4', 'https://b23.tv/a', videoConfig({ video: { enabled: false } }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /关闭/);
});
ok('一小时上限到了要挡住', () => {
  const c = videoConfig({ video: { maxPerHour: 2, perChatCooldownMs: 0 } });
  noteAutoWatch('group:5', 'https://www.bilibili.com/video/BV1hourA');
  noteAutoWatch('group:5', 'https://www.bilibili.com/video/BV1hourB');
  const v = canAutoWatch('group:5', 'https://www.bilibili.com/video/BV1hourC', c);
  assert.equal(v.ok, false);
  assert.match(v.reason, /一小时/);
});
ok('冷却为 0 时连着看不再被"缓一下"挡住', () => {
  const c = videoConfig({ video: { perChatCooldownMs: 0 } });
  noteAutoWatch('group:6', 'https://www.bilibili.com/video/BV1zeroA');
  assert.equal(canAutoWatch('group:6', 'https://www.bilibili.com/video/BV1zeroB', c).ok, true);
});

console.log('\n[视频] 对外话术');
ok('一句话说明里同时提到 B站和字幕的限制', () => {
  assert.match(videoSupportSummary(), /B站/);
  assert.match(videoSupportSummary(), /字幕/);
});
ok('缓存文件读不出来是空对象而不是崩', () => {
  const c = readVideoCache();
  assert.equal(typeof c, 'object');
});

// ── 联网部分（VIDEO_LIVE=1 才跑）──────────────────────────────────────
if (process.env.VIDEO_LIVE === '1') {
  const live = process.env.VIDEO_URL || 'https://www.bilibili.com/video/BV1pGnn67EbB';
  console.log('\n[视频] 联网抓取 ' + live);
  await okAsync('抓到标题与材料', async () => {
    const intel = await fetchIntel(live, { log: (m) => console.log('      ' + m) });
    assert.ok(intel.title, '应该有标题');
    assert.ok(intel.duration > 0, '应该有时长');
    assert.ok(intel.materials.length >= 2, '材料不该只有标题');
    console.log('      材料：' + intel.materials.join('/') + ' ｜ 缺：' + (intel.missing.join('/') || '无'));
  });
  if (process.env.VIDEO_SUMMARY === '1') {
    await okAsync('模型能给出总结', async () => {
      const r = await watchVideo(live, { log: (m) => console.log('      ' + m) });
      assert.equal(r.ok, true, r.error);
      assert.ok(r.text.length > 10);
      console.log('      总结：' + r.text.slice(0, 200).replace(/\n/g, ' '));
    });
  }
}

console.log('\n[视频] 结果 ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
