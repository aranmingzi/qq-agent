// 验收：从**真实降级链**里取出 DSH 网关那两个端点，用生产 chatCompletion 跑一遍。
// 与 probe-dsh-expiring.mjs 的区别：那个是"指定 baseUrl 直接打"，这个是"按 QQagent
// 真的会走的路径走"——端点来自 buildFallbackChain()，参数来自 config，思考参数来自
// thinking-dialect.js 的方言判定。三者任何一处配错，这里就会红。
import { buildFallbackChain } from '../src/model-fallback.js';
import { chatCompletion } from '../src/llm.js';
import { dialectFor } from '../src/thinking-dialect.js';
import { priceOf } from '../src/prices.js';
import { buildToolDefs, toOpenAiTools } from '../src/tools.js';

// 用**全量**工具：截断工具集会让模型"合理地"选择不说话，把测试变成假红。
const tools = toOpenAiTools(buildToolDefs());
const chain = buildFallbackChain({});
const gw = chain.filter((e) => /8326/.test(e.baseUrl));

console.log(`链长 ${chain.length}；网关条目 ${gw.length}`);
if (!gw.length) { console.error('❌ 网关不在降级链里 —— 检查 providers 的 models 顺序'); process.exit(1); }

let bad = 0;
for (const ep of gw) {
  const d = dialectFor({ baseUrl: ep.baseUrl, model: ep.model });
  const body = {};
  d.apply(body, 'off');
  const okDialect = d.dialect === 'local-openai' && body.reasoning_effort === 'none';
  console.log(`\n── ${ep.model}`);
  console.log(`   方言=${d.dialect} 发出去的思考参数=${JSON.stringify(body)} ${okDialect ? '✅' : '❌'}`);
  if (!okDialect) bad++;

  const messages = [
    { role: 'system', content: '你是群里的角色，用中文短句回话，别用书面语。'.repeat(20) },
    { role: 'user', content: '【新消息】张三：几点了？记得用 send_message 回他一句' }
  ];
  const t0 = Date.now();
  try {
    const r = await chatCompletion({ messages, tools, model: ep.model, baseUrl: ep.baseUrl, apiKey: ep.apiKey, thinking: 'off', maxTokens: 600 });
    const ms = Date.now() - t0;
    const tc = r.message?.tool_calls || [];
    const rs = r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const price = priceOf(ep.model);
    console.log(`   ${ms}ms tool_calls=${tc.length} rs=${rs} prompt=${r.usage?.prompt_tokens} 单价in=${price.in} ${tc.length ? '✅' : '❌'}`);
    if (!tc.length) bad++;
  } catch (e) {
    console.log(`   ❌ ${String(e?.message || e).slice(0, 140)}`);
    bad++;
  }
}

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
