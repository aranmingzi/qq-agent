// 识图提示词与「长图切段」规划。
//
// ── 为什么要改（2026-10-26 实测）──────────────────────────────────────────
// 旧契约是一句话：「用不超过 120 字说清这是什么、图上的关键文字；不要分点、
// 不要小标题、不要描述配色构图」。它把任务定义成了**念关键字**，而不是**读懂**：
// 同一张弹幕密集的直播图，旧契约只给「这是B站直播截图，弹幕含'塔菲私码了'」；
// 三段式契约第一句就能给「观众困惑她是否下播，弹幕反复追问」——后者才是
// 主模型能拿去回话的东西。信息一多，只罗列字 = 主模型看到一堆碎片，只能猜。
//
// ── 分段为什么有用（同一批实测）──────────────────────────────────────────
// 1094×2214 的长图整张送：in=2503 token，上半段内容整段丢失（三段内容只认出后两段）。
// 纵向切三段分别送：in=939×3，三段全部读准。成本几乎相同，并行跑耗时也不变。
// 所以「信息要素很多时理解不了主要意思」有很大一部分不是模型笨，是**图被缩没了**。
//
// ── 试过但无效的（别再试）────────────────────────────────────────────────
// `vl_high_resolution_images: true` / `max_pixels: 3000000` 在 DashScope 兼容模式
// 对这版 qwen3-vl-plus 完全无效：2188×1000 的图，四种传法 prompt_tokens 都是 2127。

/** 复杂图（群友发的图/截图/表格）：先给主旨，再给有界要点，再给必须原样引用的字。 */
export const VISION_STRUCT = [
  '先读懂这张图想表达什么，再写结论。严格按三行给：',
  '① 主旨：一句话说这张图在说什么（谁、什么事、什么结论）；',
  '② 要点：最多 4 条，每条不超过 20 字，优先人、动作、数字、结论，不要重复主旨；',
  '③ 原文：只抄对理解有必要的字（标题、金额、错误码、命令、榜单名、关键对话），最多 60 字；',
  '   图里刷屏的重复符号或同一句话出现多次时，只抄一次并注明"满屏重复"，不要整屏展开。没有就写"无"。',
  '总长不超过 220 字，不用 Markdown、不写小标题、不描述配色构图和画面细节。',
  '看不清的地方写"看不清"。只写图上真能看到的：不要推断图里没有的人物、来源、私聊、经历，'
  + '也不要把读错的字圆成一个说得通的说法。'
].join('\n');

/** 表情包/梗图：不需要结构，但要「先一句话说梗，再补关键文字」。 */
export const VISION_BRIEF = [
  '用不超过 80 字说清这是什么梗、什么情绪、图上的关键文字。',
  '先给一句话主旨，再补关键文字；不分点、不写小标题、不描述配色构图和画面细节。',
  '看不清就说看不清，不要编造，也不要把读错的字圆成说得通的说法。'
].join('\n');

/** 给切出来的某一段加的前缀：不说明白，模型会把每段当成一张完整的图各写一遍主旨。 */
export function segmentNote(index, total) {
  const pos = total <= 1 ? '' : (index === 0 ? '最上面一段' : (index === total - 1 ? '最下面一段' : `第 ${index + 1} 段`));
  return `这是同一张长截图的一部分（${pos}，共 ${total} 段，从上往下）。只描述这一段里看得见的内容，不要猜其他段。`;
}

/**
 * 判定要不要切段。
 * 判据取「像素总量」和「高宽比」的较大者：手机竖屏截图（1080×2400）像素超限、
 * 聊天长截图（1080×6000）两样都超，都得切。
 * @returns {{count:number, reason:string}}
 */
export function planImageSegments({ width, height } = {}, {
  maxPixels = 1_200_000,
  maxAspect = 2.2,
  maxSegments = 4,
  minSegHeight = 320
} = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return { count: 1, reason: '尺寸未知' };
  const pixels = w * h;
  const aspect = h / w;
  const byPixels = pixels / maxPixels;
  const byAspect = aspect / maxAspect;
  const need = Math.max(byPixels, byAspect);
  if (need <= 1) return { count: 1, reason: `${w}×${h} ${Math.round(pixels / 1000)}K px，比例 ${aspect.toFixed(1)}，不用切` };
  let count = Math.min(maxSegments, Math.ceil(need));
  if (count < 2) count = 2;
  // 切得太碎（每段不到 minSegHeight）就不切：碎片化反而让每段失去上下文
  if (h / count < minSegHeight) {
    return { count: 1, reason: `${w}×${h} 切成 ${count} 段后每段不足 ${minSegHeight}px，放弃切分` };
  }
  return {
    count,
    reason: `${w}×${h}（${Math.round(pixels / 1000)}K px，比例 ${aspect.toFixed(1)}）超过单图上限，切 ${count} 段`
  };
}

export const SEGMENT_LABEL = ['上半', '中部', '下部', '末段'];
export function segmentLabel(index, total) {
  if (total <= 1) return '';
  if (total === 2) return index === 0 ? '上半' : '下半';
  if (total === 3) return ['上半', '中部', '下半'][index] || `第${index + 1}段`;
  return SEGMENT_LABEL[index] || `第${index + 1}段`;
}
