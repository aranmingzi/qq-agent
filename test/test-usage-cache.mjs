// 缓存计量自测（P0）。
//
// 断言围绕"尺子准不准"，不是省钱：
//   ① 硅基流动真实返回的 `prompt_tokens_details.cached_tokens` 必须读到 ——
//      这是原来漏掉的那个键，漏读的后果是所有输入按全价计；
//   ② DeepSeek 官方的 `prompt_cache_hit_tokens` 仍然要认（不能修一家坏一家）；
//   ③ 命中数不许超过 prompt（超了会让"未命中部分"变成负数）；
//   ④ 没有缓存字段时记 0，不许瞎猜；
//   ⑤ 计价必须是 (prompt - cached) × 输入价 + cached × 缓存价，
//      不能把 cached 再加一遍（那会把账单算高）。
import assert from 'node:assert';
import { cachedTokensOf, addUsage, emptyUsage, estimateCost } from '../src/llm.js';

let pass = 0;
function ok(name, fn) { fn(); pass += 1; console.log('  ✓', name); }

console.log('[usage-cache]');

ok('① 硅基流动：prompt_tokens_details.cached_tokens（实测原样）', () => {
  const usage = {
    completion_tokens: 1,
    prompt_tokens: 2713,
    total_tokens: 2714,
    prompt_tokens_details: { cached_tokens: 2688 }
  };
  assert.strictEqual(cachedTokensOf(usage), 2688);
  const acc = addUsage(emptyUsage(), usage, { model: 'Qwen/Qwen3-8B' });
  assert.strictEqual(acc.cachedTokens, 2688);
});

ok('① 首次请求 cached_tokens=0 → 记 0，不抛错', () => {
  const acc = addUsage(emptyUsage(), { prompt_tokens: 2713, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } });
  assert.strictEqual(acc.cachedTokens, 0);
});

ok('② DeepSeek 官方 prompt_cache_hit_tokens 仍然认', () => {
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 100, prompt_cache_hit_tokens: 90 }), 90);
  const acc = addUsage(emptyUsage(), { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 90 });
  assert.strictEqual(acc.cachedTokens, 90);
});

ok('② Anthropic 风格 / 简写也能认', () => {
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 50, cache_read_input_tokens: 30 }), 30);
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 50, prompt_cache_hit: 20 }), 20);
});

ok('③ 命中数不许超过 prompt', () => {
  const acc = addUsage(emptyUsage(), { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 999 } });
  assert.strictEqual(acc.cachedTokens, 100);
});

ok('④ 没有缓存字段 → 0（不猜）', () => {
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 100, completion_tokens: 3 }), 0);
  assert.strictEqual(cachedTokensOf(null), 0);
  assert.strictEqual(cachedTokensOf(undefined), 0);
  assert.strictEqual(cachedTokensOf({}), 0);
});

ok('④ 脏数据（字符串/NaN/负数）不污染累计', () => {
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 'abc' } }), 0);
  assert.strictEqual(cachedTokensOf({ prompt_tokens: 10, prompt_cache_hit_tokens: -5 }), 0);
  const acc = addUsage(emptyUsage(), { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: -5 });
  assert.strictEqual(acc.cachedTokens, 0);
});

ok('⑤ 分段累加：两次调用命中数相加', () => {
  const acc = emptyUsage();
  addUsage(acc, { prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 900 } });
  addUsage(acc, { prompt_tokens: 1200, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1100 } });
  assert.strictEqual(acc.promptTokens, 2200);
  assert.strictEqual(acc.cachedTokens, 2000);
});

ok('⑤ 计价：命中部分按缓存价，剩余按输入价（不重复计）', () => {
  // 造一份已知价格：输入 1 元/M、缓存 0.02 元/M、输出 0 元/M
  const usage = {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 1_000_000,
    byRate: { peak: null, off: { prompt: 1_000_000, completion: 0, cached: 1_000_000 } }
  };
  const cost = estimateCost(usage, { model: 'Qwen/Qwen3-8B' });
  // 全命中 ⇒ 只花缓存价。具体单价随 data/prices.json 变，只断言"远小于全价"。
  const full = estimateCost({ ...usage, cachedTokens: 0, byRate: { peak: null, off: { prompt: 1_000_000, completion: 0, cached: 0 } } }, { model: 'Qwen/Qwen3-8B' });
  assert.ok(full > 0, '全价成本应 > 0');
  assert.ok(cost < full / 2, `命中缓存应显著便宜（全价 ${full}，命中 ${cost}）`);
  assert.ok(cost > 0, '缓存不是免费');
});

console.log(`\n[usage-cache] ${pass} 项全过`);
