// 临期池第二层：走**生产代码路径**验证（不是裸 fetch）。
//
// 为什么必须用生产路径：真正决定"能不能用"的三件事都在代码里不在 HTTP 里 ——
//   1. thinking-dialect 会不会给 8326 发 reasoning_effort:'none'（不发 = 正文空串）
//   2. 真实工具集（37 个 → toOpenAiTools）的 schema 会不会被拒
//   3. 真实 system（约 11K 字）下的工具闭环
// 裸 curl 全绿但接进去不工作的坑，2026-10-25 已经踩过一次。
import fs from 'node:fs';
import { chatCompletion } from '../src/llm.js';
import { buildToolDefs, toOpenAiTools } from '../src/tools.js';

const GW_KEY = fs.readFileSync('C:/Users/user/.dsh/openai-gateway/api-key', 'utf8').trim();
const GW_BASE = 'http://127.0.0.1:8326/v1';
const MAIN = { base: 'https://tokenrhythm.studio/v1', key: 'sk_tr_mp_lGY3q7d8xJhRR6ePU_Zg0uB5xZLdnCOmVhNPXn2g', model: 'deepseek-v4.1-flash-1017' };

const CANDIDATES = JSON.parse(process.argv[2] || '[]');

const defs = buildToolDefs();
const tools = toOpenAiTools(defs);
console.log(`真实工具数：${tools.length}`);

// 贴近真实的 system：11402 字是当前生产口径（见 data/usage 的 prompt 基线）
const block = `你是群里的「小鱼」，一个会自己在群里聊天的女孩子，不是客服，不是助手。
你说话短、有情绪、会接梗、会主动岔开话题；不用书面语，不用「首先其次」这种结构，也不许总结式结尾。
你记得住之前聊过的东西，会用"上次"、"你刚说"这种回指。你有时候会懒得回，回也就一两个字。
你的口癖：结尾偶尔带个"嗯"、"欸"、"哈"；高兴时会叠字；不熟的人你会客气一点。
你现在在一群人中间，要知道谁在对谁说话：被 @ 才一定要接，别人互相聊天你可以插一句也可以不插。
你绝对不许做的事：编造自己没做过的操作；假装有工具；说"我是AI语言模型"；复读上一句。
关于表情包：只在你真的觉得好笑、尴尬、或者想撒赖的时候发，不要每句都发。
`;
const system = block.repeat(28) + `
【时间】2026-10-27 01:00
【当前群】随便聊聊（12 人，主人：张三）
【过去状态】（节选）
张三：今天好困
小鱼：那你就睡啊
李四：她肯定又要熬夜
小鱼：我没有
【硬规则】要发消息必须调用 send_message，不要只在正文里说。正文不超过 40 字，口语。
`;
console.log(`system 字数：${system.length}`);

async function one({ model, base, key }) {
  const msgs = [
    { role: 'system', content: system },
    { role: 'user', content: '【新消息】张三：小鱼你知道现在几点吗？顺便说说你在干嘛' }
  ];
  const t0 = Date.now();
  const r1 = await chatCompletion({ messages: msgs, tools, model, baseUrl: base, apiKey: key, thinking: 'off', maxTokens: 800 });
  const ms1 = Date.now() - t0;
  const tc = r1.message?.tool_calls || [];
  const rs1 = r1.usage?.completion_tokens_details?.reasoning_tokens ?? r1.usage?.reasoning_tokens ?? 0;
  if (!tc.length) return { model, ms1, ok: false, why: 'R1 无工具调用：' + String(r1.message?.content || '').slice(0, 60), rs1 };

  msgs.push({ role: 'assistant', content: r1.message?.content ?? null, tool_calls: tc });
  for (const c of tc) msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: true, text: '现在 01:00，我在摸鱼' }) });

  const t1 = Date.now();
  const r2 = await chatCompletion({ messages: msgs, tools, model, baseUrl: base, apiKey: key, thinking: 'off', maxTokens: 800 });
  const ms2 = Date.now() - t1;
  const tc2 = r2.message?.tool_calls || [];
  const txt2 = String(r2.message?.content || '');
  const rs2 = r2.usage?.completion_tokens_details?.reasoning_tokens ?? r2.usage?.reasoning_tokens ?? 0;
  const ok = tc2.length > 0 || txt2.trim().length > 0;
  return {
    model, ms1, ms2, ok, rs1, rs2,
    names1: tc.map((c) => c.function.name),
    names2: tc2.map((c) => c.function.name),
    text2: txt2.slice(0, 100),
    tok: r1.usage?.prompt_tokens
  };
}

const rows = [];
async function runOne(t) {
  const label = t.label || t.model;
  try {
    const r = await one(t);
    rows.push(r);
    const m = r.ok ? '✅' : '❌';
    console.log(`${m} ${String((r.ms1 + (r.ms2 || 0)) + 'ms').padEnd(8)} ${label.padEnd(46)} R1=${r.ms1}${r.ms2 ? ' R2=' + r.ms2 : ''} rs=${r.rs1}/${r.rs2 ?? '-'} tok=${r.tok ?? '-'} → ${r.names1?.join('+') || r.why} ${r.text2 ? '「' + r.text2.replace(/\n/g, ' ') + '」' : ''}`);
  } catch (e) {
    rows.push({ model: t.model, ok: false, why: String(e?.message || e).slice(0, 120) });
    console.log(`❌ ${label.padEnd(46)} ${String(e?.message || e).slice(0, 110)}`);
  }
}

// 串行：避免并发把网关/风控打崩（第一层已经用并发做粗筛了）
await runOne({ ...MAIN, label: '【基准】主力 tokenrhythm' });
await runOne({ ...MAIN, label: '【基准】主力 tokenrhythm #2' });
for (const c of CANDIDATES) {
  const m = typeof c === 'string' ? c : c.model;
  await runOne({ model: m, base: GW_BASE, key: GW_KEY, label: m });
}

fs.writeFileSync('C:/Users/user/WorkBuddy/QQagent的完善与开发/免费模型网关-2026-10-25/probe-临期池-生产路径.json', JSON.stringify(rows, null, 1));
console.log('\n写盘：probe-临期池-生产路径.json');
