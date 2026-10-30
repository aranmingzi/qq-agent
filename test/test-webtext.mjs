// 网址/网页解析的自检：URL 归一化、字符集、解压、HTML 提纯、QQ 卡片取链接。
// 跑：node test/test-webtext.mjs（秒级、不碰网络）
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

const {
  normalizeUrl, firstUrlIn, decodeBody, sniffCharset, charsetFromContentType,
  htmlToText, extractTitle, looksEmptyBody, decodeEntities
} = await import('../src/html-text.js');
const { decompressBody } = await import('../src/safe-fetch.js');
const { cardLinkFromJson } = await import('../src/onebot.js');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name + '\n       ' + (error?.message ?? error));
    process.exitCode = 1;
  }
}

console.log('— URL 归一化 —');

ok('缺协议头自动补 https', () => {
  assert.equal(normalizeUrl('b23.tv/abc'), 'https://b23.tv/abc');
  assert.equal(normalizeUrl('www.bilibili.com/video/BV1xx'), 'https://www.bilibili.com/video/BV1xx');
});

ok('完整 URL 原样保留（含查询串）', () => {
  assert.equal(normalizeUrl('https://example.com/a?b=1&c=2#d'), 'https://example.com/a?b=1&c=2#d');
});

ok('Markdown 链接只取地址', () => {
  assert.equal(normalizeUrl('[点这里](https://example.com/x)'), 'https://example.com/x');
});

ok('去掉中文句尾标点与引号', () => {
  assert.equal(normalizeUrl('https://example.com/x。'), 'https://example.com/x');
  assert.equal(normalizeUrl('“https://example.com/y”，'), 'https://example.com/y');
});

ok('全角字符折成半角', () => {
  assert.equal(normalizeUrl('ｈｔｔｐｓ：／／ｅｘａｍｐｌｅ．ｃｏｍ／ａ'), 'https://example.com/a');
});

ok('不是网址就说不是（不瞎猜）', () => {
  assert.equal(normalizeUrl('唱首歌'), '');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('ftp://example.com/x'), '');
});

ok('从一句话里抠链接', () => {
  assert.equal(firstUrlIn('你看这个 https://example.com/a?x=1 挺好'), 'https://example.com/a?x=1');
  assert.equal(firstUrlIn('没有链接'), '');
});

console.log('— 字符集 —');

ok('从 Content-Type 取 charset', () => {
  assert.equal(charsetFromContentType('text/html; charset=GBK'), 'gbk');
  assert.equal(charsetFromContentType('text/html'), '');
});

ok('从 meta 嗅 charset', () => {
  const buf = Buffer.from('<html><head><meta charset="gb2312"></head>', 'latin1');
  assert.equal(sniffCharset(buf), 'gb2312');
});

ok('GBK 字节按声明解码（以前这里出来是乱码）', () => {
  // '中文' 的 GBK 编码
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBody(gbk, { contentType: 'text/html; charset=gbk' }), '中文');
  assert.equal(decodeBody(gbk, { contentType: 'text/html; charset=gb2312' }), '中文');
  assert.equal(decodeBody(gbk), '中文');   // 没声明也要猜对
});

ok('UTF-8 中文不会被动坏', () => {
  const buf = Buffer.from('中文内容', 'utf8');
  assert.equal(decodeBody(buf, { contentType: 'text/html; charset=utf-8' }), '中文内容');
  assert.equal(decodeBody(buf), '中文内容');
});

console.log('— 解压 —');

ok('gzip / deflate / br 都能解', () => {
  const src = Buffer.from('hello 世界', 'utf8');
  assert.equal(decompressBody(zlib.gzipSync(src), 'gzip').toString('utf8'), 'hello 世界');
  assert.equal(decompressBody(zlib.deflateSync(src), 'deflate').toString('utf8'), 'hello 世界');
  assert.equal(decompressBody(zlib.brotliCompressSync(src), 'br').toString('utf8'), 'hello 世界');
});

ok('没声明编码就当明文', () => {
  const src = Buffer.from('plain', 'utf8');
  assert.equal(decompressBody(src, '').toString('utf8'), 'plain');
});

console.log('— HTML 提纯 —');

const PAGE = `<!doctype html><html><head>
<title>标题里的名字</title>
<style>.a{color:red}</style>
<script>var secret = "不该出现";</script>
</head><body>
<nav>菜单一 菜单二</nav>
<h1>正文标题</h1>
<p>第一段 &amp; 内容。</p>
<p>第二段&nbsp;内容。</p>
<div style="display:none">隐藏的模板文本</div>
<footer>版权声明</footer>
</body></html>`;

ok('拿得到标题', () => {
  assert.equal(extractTitle(PAGE), '标题里的名字');
});

ok('去 script/style/导航/页脚/隐藏元素', () => {
  const { text } = htmlToText(PAGE);
  assert.ok(!text.includes('不该出现'), 'script 内容漏出来了');
  assert.ok(!text.includes('color:red'), 'style 内容漏出来了');
  assert.ok(!text.includes('菜单一'), 'nav 漏出来了');
  assert.ok(!text.includes('版权声明'), 'footer 漏出来了');
  assert.ok(!text.includes('隐藏的模板文本'), 'display:none 漏出来了');
});

ok('正文与段落都在，实体已解码', () => {
  const { text, title } = htmlToText(PAGE);
  assert.equal(title, '标题里的名字');
  assert.ok(text.includes('正文标题'));
  assert.ok(text.includes('第一段 & 内容'));
  assert.ok(text.includes('第二段 内容'));
});

ok('实体解码（数字 + 命名）', () => {
  assert.equal(decodeEntities('&lt;a&gt; &#20320; &#x597d; &hellip;'), '<a> 你 好 …');
});

ok('空页面能被识别', () => {
  assert.equal(looksEmptyBody('短'), true);
  assert.equal(looksEmptyBody('足够的正文'.repeat(40)), false);
});

console.log('— QQ 卡片取链接 —');

ok('structmsg 新闻卡', () => {
  const data = { data: JSON.stringify({ app: 'com.tencent.structmsg', meta: { news: { title: '一篇文章', desc: '摘要', jumpUrl: 'https://mp.weixin.qq.com/s/abc' } } }) };
  const r = cardLinkFromJson(data);
  assert.equal(r.url, 'https://mp.weixin.qq.com/s/abc');
  assert.equal(r.title, '一篇文章');
});

ok('公众号卡（qqdocurl）', () => {
  const data = { data: JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '公众号', qqdocurl: 'https://mp.weixin.qq.com/s/xyz' } } }) };
  assert.equal(cardLinkFromJson(data).url, 'https://mp.weixin.qq.com/s/xyz');
});

ok('拿不到就说拿不到', () => {
  assert.equal(cardLinkFromJson({ data: '{"app":"x","meta":{}}' }).url, '');
  assert.equal(cardLinkFromJson({}).url, '');
});

console.log(`\n通过 ${pass} 项`);
