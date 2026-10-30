#!/usr/bin/env node
// 拟人度离线指标（零在线成本）：从本地存档统计机器人 vs 人类的韵律差异。
//
// 用途：
//   1) 改造前后各跑 3 天，对比验收（报告《机器感诊断与奥卡姆剃刀改进-2026-10-24》§7 的指标表）；
//   2) 长期日跑：指标连续恶化即回滚提示词/配置。
//
// 用法：node scripts/human-metrics.mjs [--days 3] [--out data/human-metrics]
// 输出：控制台摘要 + <out>/<dayKey>.json 快照（只含计数，不含任何消息原文）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'));
const DATA_DIR = path.join(ROOT, 'data');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DAYS = Math.max(1, Number(arg('days', '3')) || 3);
const OUT_DIR = path.resolve(ROOT, arg('out', 'data/human-metrics'));

const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : 0);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const p90 = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * 0.9)] : 0);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// ── 指标正则（与报告 §1.1 同口径）──────────────────────────────
const RX = {
  cnSpace: /[\u4e00-\u9fff] +[\u4e00-\u9fff]/,          // 空格当标点
  question: /[？?]/,                                     // 反问/提问
  endPunct: /[。！？!?~～…]$/,                           // 句末标点
  markdown: /(^|\n)\s*([-*]|\d+[.、])|\*\*/,             // 列表/加粗
  multiBang: /！.*！/,
  parenAside: /（[^）]{2,20}）/,
  // 内部指标泄漏：调性一致 0.92 / 质检 9/9 项通过 / 4.43亿token 之类
  leak: /调性一致|质检\s*\d+\s*[/／]\s*\d+|\d+(\.\d+)?\s*亿\s*token|\d+\.\d{2}\s*分/,
  sticker: /^\[表情包：[^\]]*（([^（）]+)）\]\s*$/,
  pokeOut: /^\[拍一拍\] 你拍了拍/
};

function emptyBucket() {
  return {
    bot: 0, human: 0,
    botLens: [], humanLens: [],
    botHits: {}, humanHits: {},
    dupBotTexts: {},
    stickers: {}, pokes: {},
    leaks: 0,
    runs: { ge2: 0, max: 0 },
    feedback: { botMsgs: 0, humanAfterBot60s: 0, quotedByHuman: 0 }
  };
}
const newBucket = emptyBucket;

function countHits(bucket, text, self) {
  const hit = (re) => re.test(text);
  for (const [k, re] of Object.entries(RX)) {
    if (k === 'sticker' || k === 'pokeOut') continue;
    if (!hit(re)) continue;
    if (self) bucket.botHits[k] = (bucket.botHits[k] || 0) + 1;
    else bucket.humanHits[k] = (bucket.humanHits[k] || 0) + 1;
  }
}

function main() {
  const now = Date.now();
  const dayStart = new Date(now - (DAYS - 1) * 86400000);
  dayStart.setHours(0, 0, 0, 0);
  const since = dayStart.getTime();

  const msgDir = path.join(DATA_DIR, 'messages');
  const files = fs.existsSync(msgDir)
    ? fs.readdirSync(msgDir).filter((f) => /^(group|private)_.+\.json$/.test(f))
    : [];

  const overall = newBucket();
  const perChat = {};
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(msgDir, f), 'utf8')); } catch { continue; }
    const ms = (data.messages || []).filter((m) => (m.ts || 0) >= since);
    if (!ms.length) continue;
    const bucket = newBucket();
    let prevSelfAt = 0;
    let lastBotTs = -1;
    for (const m of ms) {
      const text = String(m.text || '').trim();
      const self = !!m.self;
      if (!text) continue;
      bucket[self ? 'bot' : 'human'] += 1;
      const len = text.replace(/\s+/g, '').length;
      (self ? bucket.botLens : bucket.humanLens).push(len);
      countHits(bucket, text, self);
      if (self) {
        if (RX.leak.test(text)) bucket.leaks += 1;
        const sm = text.match(RX.sticker);
        if (sm) bucket.stickers[sm[1]] = (bucket.stickers[sm[1]] || 0) + 1;
        if (RX.pokeOut.test(text)) bucket.pokes[text.slice(0, 40)] = (bucket.pokes[text.slice(0, 40)] || 0) + 1;
        bucket.dupBotTexts[text.slice(0, 120)] = (bucket.dupBotTexts[text.slice(0, 120)] || 0) + 1;
        lastBotTs = m.ts;
        bucket.feedback.botMsgs += 1;
      } else {
        if (prevSelfAt && m.ts - prevSelfAt <= 60000) bucket.feedback.humanAfterBot60s += 1;
        if (m.reply?.self) bucket.feedback.quotedByHuman += 1;
        prevSelfAt = 0;
      }
      prevSelfAt = self ? m.ts : prevSelfAt;
    }
    // 连发 = 中间无人类消息的连续 self 条数（与报告 §1.1 同口径）
    let run = 0; let ge2 = 0; let maxRun = 0;
    for (const m of ms) {
      const self = !!m.self && String(m.text || '').trim();
      if (self) { run += 1; if (run === 2) ge2 += 1; maxRun = Math.max(maxRun, run); }
      else run = 0;
    }
    bucket.runs.ge2 = ge2;
    bucket.runs.max = maxRun;
    perChat[f.replace(/\.json$/, '')] = bucket;
    const merge = (dst, src) => {
      dst.bot += src.bot; dst.human += src.human;
      dst.botLens.push(...src.botLens.slice(0, 4000)); dst.humanLens.push(...src.humanLens.slice(0, 4000));
      for (const [k, v] of Object.entries(src.botHits)) dst.botHits[k] = (dst.botHits[k] || 0) + v;
      for (const [k, v] of Object.entries(src.humanHits)) dst.humanHits[k] = (dst.humanHits[k] || 0) + v;
      dst.leaks += src.leaks; dst.runs.ge2 += src.runs.ge2; dst.runs.max = Math.max(dst.runs.max, src.runs.max);
      for (const [k, v] of Object.entries(src.stickers)) dst.stickers[k] = (dst.stickers[k] || 0) + v;
      for (const [k, v] of Object.entries(src.pokes)) dst.pokes[k] = (dst.pokes[k] || 0) + v;
      for (const [k, v] of Object.entries(src.dupBotTexts)) dst.dupBotTexts[k] = (dst.dupBotTexts[k] || 0) + v;
      dst.feedback.botMsgs += src.feedback.botMsgs;
      dst.feedback.humanAfterBot60s += src.feedback.humanAfterBot60s;
      dst.feedback.quotedByHuman += src.feedback.quotedByHuman;
      return dst;
    };
    merge(overall, bucket);
  }

  // ── token 面板（data/usage/<day>.json）────────────────────────
  const tokenDays = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let u = null;
    try { u = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage', `${key}.json`), 'utf8')); } catch { }
    if (u) tokenDays.push({
      day: key,
      promptTokens: u.promptTokens || 0,
      completionTokens: u.completionTokens || 0,
      cachedTokens: u.cachedTokens || 0,
      calls: u.calls || 0,
      runs: u.runs || 0,
      uncachedInput: Math.max(0, (u.promptTokens || 0) - (u.cachedTokens || 0)),
      side: u.side || null
    });
  }

  // ── 气泡分布（sessions 文件，最近 N 天内结束的）──────────────
  const bubbles = {};
  const sessDir = path.join(DATA_DIR, 'sessions');
  let sessSeen = 0, sessSpoke = 0, sessSilent = 0;
  try {
    const filesS = fs.readdirSync(sessDir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 600);
    for (const f of filesS) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch { continue; }
      if ((d.startedAt || 0) < since) continue;
      sessSeen += 1;
      const sent = Array.isArray(d.sent) ? d.sent.length : 0;
      if (sent > 0) { sessSpoke += 1; bubbles[sent] = (bubbles[sent] || 0) + 1; }
      else sessSilent += 1;
    }
  } catch { /* 无 sessions 目录 */ }

  // ── 汇总输出 ────────────────────────────────────────────────
  const line = (t) => process.stdout.write(t + '\n');
  const b = overall;
  const bl = b.botLens, hl = b.humanLens;
  const rate = (hits, n) => pct(hits || 0, n);
  const ratio = hl.length && bl.length ? Math.round((median(bl) / Math.max(1, median(hl))) * 100) / 100 : null;
  const hp90v = p90(hl);
  const overP90 = bl.length ? pct(bl.filter((x) => x > hp90v).length, bl.length) : 0;
  const dupRedundant = Object.values(b.dupBotTexts).reduce((s, n) => s + Math.max(0, n - 1), 0);
  const topSticker = Object.entries(b.stickers).sort((x, y) => y[1] - x[1])[0] || null;

  line(`══ 拟人度指标（近 ${DAYS} 天，机器人 vs 人类）══`);
  line(`消息量: 机器人 ${b.bot} / 人类 ${b.human}，机器人占比 ${pct(b.bot, b.bot + b.human)}%`);
  line(`中位长度: ${median(bl)} vs ${median(hl)}（比值 ${ratio}）；均值 ${Math.round(mean(bl))} vs ${Math.round(mean(hl))}；p90 ${p90(bl)} vs ${hp90v}`);
  line(`机器人超人类p90占比: ${overP90}%`);
  for (const [k, label] of [['cnSpace', '空格分句'], ['question', '含问号'], ['endPunct', '句末标点'], ['markdown', '列表加粗'], ['multiBang', '双叹以上'], ['parenAside', '括号旁白']]) {
    line(`${label}: 机器人 ${rate(b.botHits[k], bl.length)}% vs 人类 ${rate(b.humanHits[k], hl.length)}%`);
  }
  line(`连发≥2 段数: ${b.runs.ge2}，最长连发: ${b.runs.max}`);
  line(`完全重复(多余条): ${dupRedundant}`);
  line(`同一表情包最多次数: ${topSticker ? `${topSticker[1]} 次（id 前缀 ${String(topSticker[0]).slice(0, 12)}）` : '无'}`);
  line(`内部指标泄漏(可疑): ${b.leaks}`);
  line(`拍一拍(机器人主动): ${Object.values(b.pokes).reduce((s, n) => s + n, 0)}`);
  line(`反馈代理: 60s内人类接话率 ${pct(b.feedback.humanAfterBot60s, b.feedback.botMsgs)}%，被引用 ${b.feedback.quotedByHuman}`);
  line(`会话: ${sessSeen} 个，说话率 ${pct(sessSpoke, sessSeen)}%，气泡分布 ${JSON.stringify(bubbles)}`);
  line('── token（按天）──');
  for (const t of tokenDays) {
    line(`${t.day}: prompt ${(t.promptTokens / 1e6).toFixed(2)}M（uncached ${(t.uncachedInput / 1e6).toFixed(2)}M / cached ${(t.cachedTokens / 1e6).toFixed(2)}M）completion ${(t.completionTokens / 1e3).toFixed(0)}K calls ${t.calls} runs ${t.runs}${t.side ? ` side=${JSON.stringify(t.side)}` : ''}`);
  }

  // 快照落盘（只有计数，无原文）
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const dayKey = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}-${String(new Date(now).getDate()).padStart(2, '0')}`;
    const snapshot = {
      dayKey, days: DAYS, since: new Date(since).toISOString(), generatedAt: new Date().toISOString(),
      overall: {
        bot: b.bot, human: b.human,
        botShare: pct(b.bot, b.bot + b.human),
        medianBot: median(bl), medianHuman: median(hl), ratio,
        meanBot: Math.round(mean(bl)), meanHuman: Math.round(mean(hl)),
        p90Bot: p90(bl), p90Human: hp90v, overP90,
        rates: {
          bot: Object.fromEntries(Object.entries(b.botHits).map(([k, v]) => [k, rate(v, bl.length)])),
          human: Object.fromEntries(Object.entries(b.humanHits).map(([k, v]) => [k, rate(v, hl.length)]))
        },
        runs: b.runs, dupRedundant,
        topSticker: topSticker ? { count: topSticker[1] } : null,
        leaks: b.leaks, pokes: Object.values(b.pokes).reduce((s, n) => s + n, 0),
        feedback: {
          humanAfterBot60sPct: pct(b.feedback.humanAfterBot60s, b.feedback.botMsgs),
          quotedByHuman: b.feedback.quotedByHuman
        },
        sessions: { seen: sessSeen, speakRate: pct(sessSpoke, sessSeen), bubbles }
      },
      perChat: Object.fromEntries(Object.entries(perChat).map(([k, v]) => [k, {
        bot: v.bot, human: v.human, leaks: v.leaks, runs: v.runs,
        medianBot: median(v.botLens), medianHuman: median(v.humanLens)
      }])),
      tokenDays
    };
    const out = path.join(OUT_DIR, `${dayKey}.json`);
    fs.writeFileSync(out, JSON.stringify(snapshot, null, 1), 'utf8');
    line(`快照: ${out}`);
  } catch (e) {
    line(`快照写盘失败: ${e?.message || e}`);
  }
}

main();
