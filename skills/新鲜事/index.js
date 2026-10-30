// 新鲜事 —— 查 B站热门 / 抖音热榜
// 声明 web_fetch 权限，通过宿主受管的 api.fetch 访问 B站官方 API 和抖音热榜接口。
// 用途：别人问「最近有啥新鲜事 / B站有什么火的 / 抖音热搜」时，模型可调用本工具拿实时榜单。

let cfg = () => ({});
let httpFetch = () => Promise.reject(new Error('本扩展包的网络出口未接线（宿主未提供受管 fetch）'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 读取一个 JSON 接口，带超时与 UA。 */
async function getJson(url) {
  const res = await httpFetch(url, {
    headers: { 'user-agent': UA, 'accept': 'application/json' },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmtWan(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

/** B站热门视频（官方接口，免登录）。 */
async function biliHot(limit) {
  const j = await getJson(`https://api.bilibili.com/x/web-interface/popular?ps=${Math.min(30, Math.max(1, limit))}&pn=1`);
  if (j.code !== 0) throw new Error(`B站接口 code=${j.code} ${j.message || ''}`);
  const list = (j.data?.list || []).slice(0, limit);
  if (!list.length) return { platform: 'B站', title: 'B站热门', items: [], note: '暂无数据' };
  const items = list.map((v, i) => ({
    rank: i + 1,
    title: String(v.title || ''),
    up: String(v.owner?.name || ''),
    play: fmtWan(v.stat?.view),
    danmaku: fmtWan(v.stat?.danmaku),
    bvid: String(v.bvid || ''),
    url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ''
  }));
  return { platform: 'B站', title: 'B站热门视频', items };
}

/** 抖音热榜（iesdouyin 热搜接口）。 */
async function douyinHot(limit) {
  const j = await getJson('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/');
  if (j.status_code !== 0 && j.status_code !== undefined && j.status_code !== 0) {
    // 该接口用 status_code 字段
  }
  const words = Array.isArray(j.word_list) ? j.word_list : [];
  if (!words.length) return { platform: '抖音', title: '抖音热榜', items: [], note: '暂无数据' };
  const items = words.slice(0, limit).map((w, i) => ({
    rank: i + 1,
    title: String(w.word || ''),
    hot: fmtWan(w.hot_value),
    label: w.label === 1 ? '官方' : (w.label === 3 ? '热' : ''),
    url: ''
  }));
  return { platform: '抖音', title: '抖音热榜', items };
}

/** 把榜单拼成给模型看的文本。 */
function formatBoard(b) {
  if (!b.items.length) return `${b.platform}${b.title}：${b.note || '暂无数据'}`;
  const lines = b.items.map((it) => {
    const tag = it.label ? ` [${it.label}]` : '';
    const extra = it.up ? ` · UP ${it.up} · 播放 ${it.play}` : (it.hot ? ` · 热度 ${it.hot}` : '');
    const link = it.url ? `\n    ${it.url}` : '';
    return `${it.rank}. ${it.title}${tag}${extra}${link}`;
  });
  return `【${b.platform} · ${b.title}】\n${lines.join('\n')}`;
}

export function setup(api) {
  cfg = api.config;
  httpFetch = api.fetch;
  api.registerTool({
    id: 'fresh_news',
    name: '查新鲜事',
    description: '查 B站热门视频 或 抖音热榜（热搜）。用于「最近有啥新鲜事 / B站有什么火的 / 抖音热搜」这类问题；返回实时榜单。source 传 bilibili=查B站热门，douyin=查抖音热榜，both=两个都查。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '来源：bilibili / douyin / both（默认 both）' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 10' }
      },
      required: []
    },
    async execute(_ctx, args) {
      try {
        const source = String(args?.source || 'both').toLowerCase();
        const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
        const want = { bili: source === 'bilibili' || source === 'both', douyin: source === 'douyin' || source === 'both' };
        const parts = [];
        const errors = [];
        if (want.bili) {
          try { parts.push(formatBoard(await biliHot(limit))); } catch (e) { errors.push(`B站：${e?.message ?? e}`); }
        }
        if (want.douyin) {
          try { parts.push(formatBoard(await douyinHot(limit))); } catch (e) { errors.push(`抖音：${e?.message ?? e}`); }
        }
        if (!parts.length) return { content: `查新鲜事失败：${errors.join('；') || '未知错误'}`, isError: true };
        const body = parts.join('\n\n');
        return { content: body + (errors.length ? `\n\n（部分失败：${errors.join('；')}）` : '') };
      } catch (e) {
        return { content: `查新鲜事失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
