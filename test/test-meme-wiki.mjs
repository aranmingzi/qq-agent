// 梗百科（src/meme-wiki.js）的自检。
// 跑：node test/test-meme-wiki.mjs（秒级、不联网、只写系统临时目录）
//
// 这一层最容易骗自己的地方是「看起来查到了」：
//   · 把「你是什么」匹配到「你是什么冠军」—— 查到一条**不相干**的梗，
//     比查不到更糟（模型会拿着错词条振振有词）。
//   · 联网闸门写两遍（worthSearch 里一处 + lookupMemeWiki 里一处），
//     拆一处另一处兜住 → 测试永远绿。所以这里用**计数 fetch** 判，不用返回值判。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const M = await import('../src/meme-wiki.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-memewiki-'));
const WIKI = path.join(DIR, 'wiki.json');

const ITEMS = [
  { t: '典', g: ['文字梗', '嘲讽'], u: '当对方说陈词滥调时回一个「典」，表示太经典了。', o: '来源：贴吧「典中典」。' },
  { t: '尊嘟假嘟', g: ['谐音'], u: '「真的假的」的可爱谐音；用来撒娇或装傻。', o: '来源：短视频口播。' },
  { t: '尊嘟', g: ['谐音'], u: '「真的」的谐音。', o: '来源同上。' },
  { t: '你是什么冠军', g: ['反问'], u: '「你是什么冠军」用于阴阳怪气地反问。', o: '来源：电竞采访。' },
  { t: 'YYDS', g: ['缩写'], u: '永远的神，夸人/夸物。', o: '来源：饭圈。' }
];
fs.writeFileSync(WIKI, JSON.stringify({ schema: 1, built_at: '2026-01-01', count: ITEMS.length, source: 'test', items: ITEMS }));

const find = (q) => M.lookupLocal(q, { file: WIKI });
const reset = () => M._resetForTest();

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
async function okAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ok  ' + name);
  } catch (error) {
    console.error('  FAIL ' + name + '\n       ' + (error?.message ?? error));
    process.exitCode = 1;
  }
}

console.log('\n本地词库');
ok('① 读得出来，count/builtAt 对得上', () => {
  reset();
  const st = M.wikiStatus({ file: WIKI });
  assert.equal(st.available, true);
  assert.equal(st.count, ITEMS.length);
  assert.equal(st.builtAt, '2026-01-01');
});

ok('② 精确命中：不给多余提示', () => {
  const r = find('典');
  assert.equal(r.title, '典');
  assert.equal(r.note, '');
  assert.match(r.usage, /陈词滥调/);
});

ok('③ 只认完整标题：消息是标题的前缀不算（不许查到不相干的梗）', () => {
  assert.equal(find('你是什么'), null, '「你是什么」不该命中「你是什么冠军」');
  assert.equal(find('你是什么冠军')?.title, '你是什么冠军');
  assert.equal(find('你说你是什么冠军啊')?.title, '你是什么冠军', '消息里含完整标题才算');
});

ok('④ 多条命中时取最长的标题（尊嘟假嘟 优先于 尊嘟）', () => {
  assert.equal(find('尊嘟假嘟啊')?.title, '尊嘟假嘟');
  assert.equal(find('尊嘟')?.title, '尊嘟');
});

ok('⑤ 大小写兜底：yyds → YYDS', () => {
  assert.equal(find('yyds')?.title, 'YYDS');
  assert.equal(find('Yyds')?.title, 'YYDS');
});

ok('⑥ 词库文件坏了不抛错、不崩（退化成只有在线检索）', () => {
  const bad = path.join(DIR, 'bad.json');
  fs.writeFileSync(bad, '{ 这不是 json');
  reset();
  assert.equal(M.loadWiki({ file: bad }), null);
  assert.equal(M.lookupLocal('典', { file: bad }), null);
  assert.equal(M.wikiStatus({ file: bad }).available, false);
});

ok('⑦ 词库文件不存在也不抛错', () => {
  reset();
  assert.equal(M.lookupLocal('典', { file: path.join(DIR, 'nope.json') }), null);
});

console.log('\n正文处理');
ok('⑧ content_html → 文本 + 按小标题拆开（用法/出处/其它）', () => {
  const text = M.htmlToText('<h2>来源</h2><p>来自贴吧 &amp; 弹幕。</p><h2>用法</h2><p>直接回一个「典」。</p><ul><li>例：典。</li></ul>');
  const s = M.splitSections(text);
  assert.match(s.origin, /贴吧 & 弹幕/);
  assert.match(s.usage, /直接回一个「典」/);
  assert.match(s.usage, /例：典/, 'list 项要留在用法段里');
});

ok('⑨ 给模型看的顺序是「怎么用」在前、「出处」在后（顺序反了模型就念百科）', () => {
  const out = M.formatEntry(find('典'));
  const iUse = out.indexOf('【怎么用 / 怎么接】');
  const iOrigin = out.indexOf('【出处');
  assert.ok(iUse > 0 && iOrigin > iUse, '怎么用必须在出处之前');
  assert.ok(out.includes('仅用于理解，别照搬'), '出处要带"别照搬"的说明');
});

console.log('\n预查闸门');
ok('⑩ 重复词折叠：杂鱼杂鱼→杂鱼 / 666666→666', () => {
  assert.equal(M.normalizeQuery('杂鱼杂鱼'), '杂鱼');
  assert.equal(M.normalizeQuery('666666'), '666');
  assert.equal(M.normalizeQuery('已取餐已取餐'), '已取餐');
  assert.equal(M.normalizeQuery('典'), '典', '单字不该被折叠');
});

ok('⑪ 闲聊整句不值得联网，明确问梗才值得', () => {
  assert.equal(M.worthSearch('今天好热啊你们开空调了吗', '今天好热啊你们开空调了吗'), false);
  assert.equal(M.worthSearch('我是谁', '我是谁'), false, '代词开头 → 不联网');
  assert.equal(M.worthSearch('这是什么梗', '尊嘟假嘟'), true, '明确问梗 → 联网');
  assert.equal(M.worthSearch('', '尊嘟假嘟'), true, '短词 → 联网');
  assert.equal(M.worthSearch('', '这个词到底是怎么来的'), false, '太长的整句 → 不联网');
});

console.log('\n在线兜底（注入 fetch，计数判）');
const jsonFetch = (calls, { items = [], detail = null } = {}) => async (url) => {
  calls.push(url);
  if (url.includes('/api/v1/public/memes?') || !detail) {
    return { status: 200, text: JSON.stringify({ items }) };
  }
  return { status: 200, text: JSON.stringify({ item: detail }) };
};

await okAsync('⑫ 本地命中就不联网（fetch 一次都不许发）', async () => {
  reset();
  const calls = [];
  const r = await M.lookupMemeWiki('典', { file: WIKI, online: true, raw: '这是什么梗', fetchImpl: jsonFetch(calls) });
  assert.equal(r.found, true);
  assert.equal(r.tier, 'wiki');
  assert.deepEqual(calls, [], '本地命中还联网 = 白花钱');
});

await okAsync('⑬ 本地没有 + 值得搜 → 列表 + 详情各一次，tier=online', async () => {
  reset();
  const calls = [];
  const fetchImpl = jsonFetch(calls, {
    items: [{ title: '赛博佛祖', slug: '赛博佛祖', summary: '列表摘要' }],
    detail: {
      title: '赛博佛祖',
      slug: '赛博佛祖',
      tags: ['AI'],
      content_html: '<h2>来源</h2><p>AI 念经视频。</p><h2>用法</h2><p>说「赛博佛祖保佑」。 </p>'
    }
  });
  const r = await M.lookupMemeWiki('赛博佛祖', { file: WIKI, online: true, raw: '这是什么梗', fetchImpl });
  assert.equal(r.found, true);
  assert.equal(r.tier, 'online');
  assert.equal(calls.length, 2, '列表 + 详情');
  assert.match(r.text, /赛博佛祖保佑/, '用法要进正文');
  assert.match(r.text, /怎么用/);
});

await okAsync('⑭ 本地没有 + 不像梗 → 联网闸门拦下（fetch 0 次）', async () => {
  reset();
  const calls = [];
  const r = await M.lookupMemeWiki('我是谁', { file: WIKI, online: true, raw: '我是谁', fetchImpl: jsonFetch(calls) });
  assert.equal(r.found, false);
  assert.deepEqual(calls, [], '闲聊整句不该联网');
});

await okAsync('⑮ 在线查过一次就别再查（10 分钟冷却）', async () => {
  reset();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { status: 200, text: JSON.stringify({ items: [] }) };
  };
  const now = 1_800_000_000_000;
  const a = await M.lookupMemeWiki('不存在的梗词', { file: WIKI, online: true, raw: '这是什么梗', fetchImpl, now });
  const b = await M.lookupMemeWiki('不存在的梗词', { file: WIKI, online: true, raw: '这是什么梗', fetchImpl, now: now + 60_000 });
  assert.equal(a.found, false);
  assert.equal(b.found, false);
  assert.equal(calls.length, 1, '冷却期内同一个词只联网一次');
});

await okAsync('⑯ 同一轮里重复查同一个词走缓存（entries 不再联网、返回 cached）', async () => {
  reset();
  const calls = [];
  const fetchImpl = jsonFetch(calls, {
    items: [{ title: '抽象', slug: '抽象' }],
    detail: { title: '抽象', slug: '抽象', tags: [], content_html: '<h2>用法</h2><p>用于揶揄离谱的事。</p>' }
  });
  const first = await M.lookupMemeWiki('抽象', { file: WIKI, online: true, raw: '这是什么梗', fetchImpl });
  const second = await M.lookupMemeWiki('抽象', { file: WIKI, online: true, raw: '这是什么梗', fetchImpl });
  assert.equal(first.tier, 'online');
  assert.equal(second.cached, true);
  assert.equal(calls.length, 2, '第二次走内存缓存');
});

await okAsync('⑰ 接口报错/超时只是查不到，不许抛出去', async () => {
  reset();
  const boom = async () => { throw new Error('ECONNRESET'); };
  const r = await M.lookupMemeWiki('随便一个词', { file: WIKI, online: true, raw: '这是啥', fetchImpl: boom, timeoutMs: 200 });
  assert.equal(r.found, false);
});

console.log(`\n梗百科：${pass} 项通过\n`);
