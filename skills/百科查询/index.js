// 百科查询 —— 注册一个 encyclo_lookup 工具，查词条简介
// 演示 skill 型扩展包：声明 web_fetch 权限 → 通过宿主受管的 api.fetch 访问网络。
// 源：优先百度百科（国内可达），失败回退萌娘百科（ACG 词条更全）。

let cfg = () => ({});
let httpFetch = () => Promise.reject(new Error('本扩展包的网络出口未接线（宿主未提供受管 fetch）'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function source() {
  return String(cfg()?.source || 'auto').trim() || 'auto';
}

/** 百度百科：返回 { title, desc, url }，查不到返回 null。 */
async function fromBaidu(term) {
  const url = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_length=200&bk_key=' + encodeURIComponent(term);
  const res = await httpFetch(url, { headers: { 'user-agent': UA, 'accept': 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json();
  if (!j || j.error || !j.desc) return null;
  return {
    title: String(j.title || term),
    desc: String(j.desc || '').replace(/\s+/g, ' ').trim(),
    url: j.lemmaId ? `https://baike.baidu.com/item/${encodeURIComponent(term)}` : ''
  };
}

/** 萌娘百科：返回 { title, desc, url }，查不到返回 null。 */
async function fromMoegirl(term) {
  const url = 'https://zh.moegirl.org.cn/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&titles=' + encodeURIComponent(term);
  const res = await httpFetch(url, { headers: { 'user-agent': UA, 'accept': 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json();
  const pages = j?.query?.pages || {};
  for (const pid of Object.keys(pages)) {
    const p = pages[pid];
    if (p && p.extract && !p.missing) {
      const extract = String(p.extract).replace(/\s+/g, ' ').trim().slice(0, 600);
      return { title: String(p.title || term), desc: extract, url: `https://zh.moegirl.org.cn/${encodeURIComponent(p.title)}` };
    }
  }
  return null;
}

export function setup(api) {
  cfg = api.config;
  httpFetch = api.fetch;
  api.registerTool({
    id: 'encyclo_lookup',
    name: '百科查询',
    description: '查一个名词/人物/事件的百科简介。用于「XX 是什么」这类问题；返回摘要和链接。',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: '要查的词条（人名/地名/概念等）' }
      },
      required: ['term']
    },
    async execute(_ctx, args) {
      try {
        const term = String(args?.term || '').trim();
        if (!term) return { content: '缺 term', isError: true };
        const src = source();
        let info = null;
        const errors = [];

        if (src === 'auto' || src === 'baidu') {
          try { info = await fromBaidu(term); } catch (e) { errors.push(`百度：${e?.message ?? e}`); }
        }
        if (!info && (src === 'auto' || src === 'moegirl')) {
          try { info = await fromMoegirl(term); } catch (e) { errors.push(`萌娘：${e?.message ?? e}`); }
        }

        if (!info) {
          return { content: `没查到「${term}」的词条${errors.length ? `（${errors.join('；')}）` : ''}，可能名称不对或太冷门。`, isError: false };
        }
        return { content: `【${info.title}】\n${info.desc}${info.url ? `\n更多：${info.url}` : ''}` };
      } catch (e) {
        return { content: `百科查询失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
