const COMPLEX_PATTERNS = [
  /```/,
  /(代码|报错|异常|堆栈|traceback|stack\s*trace|调试|重构|实现|架构|接口|数据库|SQL|正则|算法|复杂度|证明|推导|数学|公式|逻辑推理)/i,
  /(分析|总结|归纳|长文|文档|合同|论文|报告|方案|规划|风险|可行性|决策)/i,
  /(文件|附件|表格|Excel|PDF|Word|PPT|图片内容|网页正文|链接正文)/i
];

function triggerText(triggerEntries = []) {
  return triggerEntries
    .map((m) => String(m?.text || ''))
    .filter(Boolean)
    .join('\n');
}

function hasComplexMedia(triggerEntries = []) {
  return triggerEntries.some((m) =>
    Array.isArray(m?.media) && m.media.some((item) => item?.kind === 'file'));
}

export function isComplexRequest(text, { hasMedia = false } = {}) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (value.length >= 800) return true;
  if (hasMedia && /(分析|识别|读取|看看|解释|总结|报错|代码|文档|表格|图片)/i.test(value)) return true;
  return COMPLEX_PATTERNS.some((pattern) => pattern.test(value));
}

export function chooseInitialModel({ cfg, triggerEntries = [], taskContext = null, pushTask = null }) {
  const api = cfg?.api || {};
  const chatModel = String(api.model || '').trim();
  const complexModel = String(api.complexModel || '').trim();
  const routing = api.routing || {};

  if (!chatModel) return '';
  if (!routing.enabled || !routing.auto || !complexModel || complexModel === chatModel) return chatModel;
  if (pushTask?.kind === 'schedule' || pushTask?.kind === 'reminder') return chatModel;
  if (taskContext) return complexModel;

  const text = triggerText(triggerEntries);
  const nativeMedia = cfg.vision?.mode === 'qwen' ? false : hasComplexMedia(triggerEntries);
  return isComplexRequest(text, { hasMedia: nativeMedia }) ? complexModel : chatModel;
}

export function formatModelChain(chain = []) {
  const list = [...new Set(chain.map((x) => String(x || '').trim()).filter(Boolean))];
  return list.length ? list.join('→') : '';
}
