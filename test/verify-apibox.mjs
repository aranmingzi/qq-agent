// 验收 apibox 服务商：从**真实降级链**取出 apibox 那几条，走生产 chatCompletion，跑两轮闭环。
//
// 判据（这三条是踩过坑之后才定下来的）：
//  1) 方言：这些模型名带 gemini，`thinking-dialect.js` 判成 gemini 档 —— 「关思考」= **一个字段都不发**
//     （Gemini 3/4 关不掉思考，发 reasoning_effort:none 会 400）。所以这里断言的是
//     「gemini 档 + 请求体里没有思考字段」，不是 local-openai 那套。
//  2) 第一轮必须真的调工具（或至少吐出正文）。第一轮就空 = 群里静默，最坏的情况。
//  3) 第二轮**允许静默结束**（finish=stop + 空正文）：消息已经通过 send_message 发出去了，
//     模型不再说话是正确收尾，不是缺陷。真正要防的是「第二轮把同一个调用原样重放一遍」——
//     那会在群里重复发消息。
import { buildFallbackChain } from '../src/model-fallback.js';
import { chatCompletion } from '../src/llm.js';
import { dialectFor } from '../src/thinking-dialect.js';
import { priceOf } from '../src/prices.js';
import { buildToolDefs, toOpenAiTools } from '../src/tools.js';

const tools = toOpenAiTools(buildToolDefs());
const chain = buildFallbackChain({});
const eps = chain.filter((e) => /apibox/i.test(e.baseUrl));

console.log(`链长 ${chain.length}；apibox 条目 ${eps.length}；工具数 ${tools.length}`);
if (!eps.length) {
  console.error('❌ apibox 不在降级链里 —— 检查 provider 的 models 顺序');
  process.exit(1);
}

let bad = 0;
for (const ep of eps) {
  const d = dialectFor({ baseUrl: ep.baseUrl, model: ep.model });
  const probe = {};
  d.apply(probe, 'off');
  // gemini 档：关思考就是不发任何字段；其他档才要求 reasoning_effort='none'
  const okDialect =
    d.dialect === 'gemini' ? Object.keys(probe).length === 0 : probe.reasoning_effort === 'none';
  console.log(`\n── ${ep.model}`);
  console.log(`   方言=${d.dialect} 思考参数=${JSON.stringify(probe)} ${okDialect ? '✅' : '❌'}`);
  if (!okDialect) bad++;

  const sys = '你是群里的「小鱼」，说话短、有情绪、会接梗，不用书面语，不总结。'.repeat(12);
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: '【新消息】张三：几点了？记得用 send_message 回他一句' }
  ];

  try {
    const t0 = Date.now();
    const r1 = await chatCompletion({
      messages,
      tools,
      model: ep.model,
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      thinking: 'off',
      maxTokens: 1200
    });
    const ms1 = Date.now() - t0;
    const calls = r1.message?.tool_calls || [];
    const text1 = String(r1.message?.content ?? '');
    const rs1 = r1.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const price = priceOf(ep.model);
    const ok1 = calls.length > 0 || text1.trim().length > 0;
    console.log(
      `   R1 ${ms1}ms calls=${calls.length} rs=${rs1} 正文=「${text1.replace(/\n/g, ' ').slice(0, 34)}」 单价in=${price.in} ${ok1 ? '✅' : '❌'}`
    );
    if (!ok1) {
      bad++;
      continue;
    }
    if (!calls.length) continue; // 第一轮直接说话也可接受，没有第二轮

    const sig = (list) => list.map((c) => `${c.function?.name}:${c.function?.arguments}`).join('|');
    const sig1 = sig(calls);

    const follow = [
      ...messages,
      { role: 'assistant', content: r1.message?.content ?? null, tool_calls: calls },
      ...calls.map((c) => ({
        role: 'tool',
        tool_call_id: c.id,
        content: JSON.stringify({ ok: true, sent: true, now: '2026-10-27 22:10' })
      }))
    ];
    const t1 = Date.now();
    const r2 = await chatCompletion({
      messages: follow,
      tools,
      model: ep.model,
      baseUrl: ep.baseUrl,
      apiKey: ep.apiKey,
      thinking: 'off',
      maxTokens: 1200
    });
    const ms2 = Date.now() - t1;
    const calls2 = r2.message?.tool_calls || [];
    const text2 = String(r2.message?.content ?? '');
    const rs2 = r2.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    if (calls2.length && sig(calls2) === sig1) {
      console.log(`   R2 ${ms2}ms ❌ 原样重放了上一轮的调用（群里会重复发消息）`);
      bad++;
    } else {
      const tail = calls2.length ? `又调了 ${calls2.length} 个（换了参数）` : text2.trim() ? `正文=「${text2.replace(/\n/g, ' ').slice(0, 30)}」` : '静默收尾（正常）';
      console.log(`   R2 ${ms2}ms calls=${calls2.length} rs=${rs2} ${tail} ✅`);
    }
    console.log(`   合计 ${ms1 + ms2}ms`);
  } catch (e) {
    console.log(`   ❌ ${String(e?.message || e).slice(0, 160)}`);
    bad++;
  }
}

console.log(bad ? `\n❌ ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
