// 价格表：把"每百万 token 多少钱"从代码里挪进数据文件（学自 TT 整合包 prices.json）。
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────────
// 以前单价是 config.api 里的两个数字，带来三个具体问题：
//   ① 闲时/高峰两套价写不进去 —— 凌晨 2–8 点是半价，一到点就得手改配置；
//   ② 缓存命中价没地方放 —— 它跟输入价差 50 倍，混在一个字段里必算错；
//   ③ 图片成本完全没有模型 —— 一张图不是"多少钱"，是按缩图后像素折算 token 再封顶。
//
// 所以价格表的条目是：
//   { in, out, cached, peak?: { in, out, cached }, peakRule, image? }
// 其中 in/out/cached 是**闲时**价，peak 是高峰价；peakRule 决定"现在算不算高峰"。
//
// ── 兜底方向 ──────────────────────────────────────────────────────────────
// 查不到模型 → 回落 config.api 的三个价（宁可沿用旧配置，也不要算成 0 元显得免费）。
// 价格表文件坏了 → 同样回落，并打一条 warn（不静默）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const PRICES_FILE = path.join(DATA_DIR, 'prices.json');

let cache = null;          // { at, prices }
const CACHE_MS = 30000;    // 改完价格表 30 秒内生效，不必重启

/** 读价格表（带 mtime 无关的短缓存：这是低频读、高频用的配置）。 */
export function loadPrices() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.prices;
  let prices = null;
  try {
    const doc = JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
    if (doc && typeof doc === 'object' && doc.prices && typeof doc.prices === 'object') prices = doc.prices;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[prices] 读取 ${PRICES_FILE} 失败（已回落 config 单价）：${error?.message ?? error}`);
    }
  }
  cache = { at: Date.now(), prices };
  return prices;
}

/** 缓存失效（测试/改价后立即生效用）。 */
export function clearPriceCache() {
  cache = null;
}

/**
 * 现在是不是「高峰时段」。
 *
 * ⚠️ 两家的时段定义不一样，这是把它们放同一张表的唯一理由：
 *   硅基   —— 2–8 点闲时，其余（含凌晨 0–2、白天）都是高峰价
 *   官方   —— 工作日 9–12、14–18 高峰，其余时间 + 整个周末都是闲时价
 * 所以「哪家便宜」取决于现在是几点、星期几，不是固定结论（周末官方是硅基的一半）。
 *
 * @param {string} rule  peakRules 里的名字
 * @param {Date}   [at]
 */
export function isPeakNow(rule, at = new Date()) {
  const key = String(rule || 'none');
  if (key === 'none') return false;
  const hour = at.getHours();
  const day = at.getDay();              // 0=周日 6=周六
  if (key === 'siliconflow') {
    // 2:00–7:59 闲时
    return !(hour >= 2 && hour < 8);
  }
  if (key === 'deepseek-official') {
    if (day === 0 || day === 6) return false;      // 周末全天空闲
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  }
  return false;                          // 未知规则 → 当闲时（不虚高）
}

/**
 * 某模型此刻生效的单价。
 * @returns {{ in:number, out:number, cached:number, peak:boolean, rule:string, model:string, src:'table'|'config' }}
 */
export function priceOf(model, { at = new Date(), prices = null } = {}) {
  const cfg = getConfig().api || {};
  const table = prices || loadPrices();
  const id = String(model || cfg.model || '').trim();
  const entry = id && table ? table[id] : null;

  if (!entry) {
    // 回落 config：没有缓存价时按输入价的 2% 估（DeepSeek / 硅基都是 0.04 vs 2.00）
    const inPrice = Number(cfg.priceInputPerM) || 0;
    const outPrice = Number(cfg.priceOutputPerM) || 0;
    const cached = Number(cfg.priceCachePerM ?? inPrice * 0.02) || 0;
    return { in: inPrice, out: outPrice, cached, peak: false, rule: 'none', model: id, src: 'config' };
  }

  const rule = String(entry.peakRule || 'none');
  const peak = isPeakNow(rule, at) && entry.peak && typeof entry.peak === 'object';
  const pick = (k) => Number((peak ? entry.peak[k] : entry[k]) ?? entry[k]) || 0;
  return {
    in: pick('in'),
    out: pick('out'),
    cached: Number((peak ? entry.peak.cached : entry.cached) ?? pick('in') * 0.02) || 0,
    peak: !!peak,
    rule,
    model: id,
    src: 'table'
  };
}

/**
 * 某模型的两套价（闲时 + 高峰），供"按档分桶"的用量精确计价。
 * peak 为 null 表示该模型不分时段（等于两套一样）。
 * @returns {{ off:{in:number,out:number,cached:number}, peak:{in:number,out:number,cached:number}|null, model:string }}
 */
export function ratesOf(model) {
  const cfg = getConfig().api || {};
  const table = loadPrices();
  const id = String(model || cfg.model || '').trim();
  const entry = id && table ? table[id] : null;
  if (!entry) {
    const inPrice = Number(cfg.priceInputPerM) || 0;
    const outPrice = Number(cfg.priceOutputPerM) || 0;
    const cached = Number(cfg.priceCachePerM ?? inPrice * 0.02) || 0;
    return { off: { in: inPrice, out: outPrice, cached }, peak: null, model: id };
  }
  const off = {
    in: Number(entry.in) || 0,
    out: Number(entry.out) || 0,
    cached: Number(entry.cached ?? (Number(entry.in) || 0) * 0.02) || 0
  };
  const peak = entry.peak && typeof entry.peak === 'object'
    ? {
      in: Number(entry.peak.in ?? entry.in) || 0,
      out: Number(entry.peak.out ?? entry.out) || 0,
      cached: Number(entry.peak.cached ?? off.cached) || 0
    }
    : null;
  return { off, peak, model: id };
}

/** 价格表里全部模型的"此刻单价"快照（控制台展示用）。 */
export function priceTableSnapshot(at = new Date()) {
  const table = loadPrices() || {};
  return Object.keys(table).map((id) => ({ model: id, ...priceOf(id, { at, prices: table }) }));
}
