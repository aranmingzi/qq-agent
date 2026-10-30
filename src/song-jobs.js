// 点歌任务的编排：把「唱歌 / 翻唱」包成异步 job，立即回执、后台跑、完成后主动推送。
//
// 为什么需要这一层（而不是让 tools.js 直接 await）：
//   QQ 群里等 3 分钟等同于失败。用户需要的是「点完就能走」，
//   而不是盯着一个卡住的对话。所以流程改成：
//     tool 被调用 → 0.1s 内返回「已排队 #2，预计 45 秒」→ 模型回一句 → 群友该干嘛干嘛
//     队列在后台跑 → 完成时主动 sendFile / sendVoice 到原会话
//
// 进度来源（不重构 Python 的前提下拿到真实进度）：
//   - 翻唱：route_a.py 本来就会打 `[1/5] [2/5] ...`，直接映射成百分比
//   - 唱歌：sing_engine 没有阶段输出，用「字数估时 + 实时 elapsed 推算」，
//     配合 `[melody]` 这类关键行做锚点。误差大但足以让用户看到「在动」。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';
import { JobQueue } from './job-queue.js';
import { singLyrics } from './sing-song.js';
import { coverSong } from './cover-song.js';
import { svcConfig } from './svc-voice.js';
import { saveVoiceBuffer, deliverSing, deliverCover } from './song-deliver.js';
import { findLocalSong, findCachedPlaylistAudio } from './song-router.js';
import { extractMelodyForSong, melodyAutoReady, windowForLyrics } from './melody-auto.js';

let queue = null;
let sender = null;
let logFn = () => {};
let emitFn = () => {};

const canceledError = () => Object.assign(new Error('已取消'), { code: 'CANCELED', retryable: false });

/** 每个会话同时最多排几首。防刷屏，也防一个人把 GPU 占满一晚上。 */
const MAX_ACTIVE_PER_CHAT = 2;

/**
 * 初始化（在 app.js 里 sender 建好之后调用一次）。
 * @param {object} p
 * @param {object} [p.emit] 控制台事件出口（把队列事件转给 SSE，前端就能实时看作业）
 */
export function initSongJobs({ sender: s, log = null, emit = null, concurrency = 1 } = {}) {
  if (s) sender = s;
  if (log) logFn = log;
  if (emit) emitFn = emit;
  if (queue) return queue;
  queue = new JobQueue({
    concurrency,
    journalPath: path.join(DATA_DIR, 'jobs.jsonl'),
    log: (m) => logFn(m),
    onEvent: (type, payload) => {
      if (type === 'job.stage' && payload.msg) logFn(`[job ${payload.jobId}] ${payload.stage}：${payload.msg}`);
      // 转给 /api/events（SSE）。前端/外部面板可以直接订阅，不用轮询。
      if (type.startsWith('job.')) {
        try {
          const err = payload.error;
          emitFn(type, {
            jobId: payload.jobId, group: payload.group, status: payload.status,
            stage: payload.stage, progress: payload.progress, etaMs: payload.etaMs,
            msg: payload.msg || '', position: payload.position ?? null,
            error: err ? { code: err.code || '', message: String(err.message ?? err) } : null,
          });
        } catch { /* 控制台断线不影响队列 */ }
      }
    },
  });
  logFn('[queue] 点歌队列已启动（concurrency=1，日志 data/jobs.jsonl）');
  loadCostHistory();
  return queue;
}

/** 这个会话当前排了几首（排队中 + 运行中）。 */
function activeOf(chatKey) {
  if (!queue) return 0;
  return queue.list({ group: chatKey, limit: 50 })
    .filter((j) => j.status === 'queued' || j.status === 'running').length;
}

function guardFlood(chatKey) {
  const n = activeOf(chatKey);
  if (n >= MAX_ACTIVE_PER_CHAT) {
    const e = new Error(`这个会话已经排了 ${n} 首，等一首唱完再点`);
    e.code = 'QUEUE_FULL';
    e.retryable = false;
    throw e;
  }
}

export function songQueueReady() {
  return !!queue && !!sender;
}

export function songJobStatus(id) {
  if (!queue) return null;
  // 缓存命中的 id 形如 cache_<key>，不是真实 job，返回一个等价终态让调用方不用特判
  if (String(id || '').startsWith('cache_')) {
    return { id, status: 'succeeded', cached: true, stage: 'deliver', progress: 100, etaMs: 0, position: 0 };
  }
  return queue.get(id);
}

export function listSongJobs(opts) {
  return queue ? queue.list(opts) : [];
}

export function cancelSongJob(id) {
  return queue ? queue.cancel(id) : { ok: false, reason: 'queue_not_ready' };
}

/**
 * 取消某个会话所有在途（排队中 + 运行中）的点歌作业。
 * 群里实测：群友说「别唱了」，模型嘴上答应「欸 那我不唱了」，
 * 队列里的作业照跑，两分钟后又把歌发出来 —— 所以「不唱」必须是真取消。
 * @returns {{ok:boolean, canceled:number, labels:string[]}}
 */
export function cancelSongJobsByChat(chatKey, { includeRunning = true } = {}) {
  if (!queue) return { ok: false, canceled: 0, labels: [], reason: 'queue_not_ready' };
  const jobs = queue.list({ group: chatKey, limit: 50 })
    .filter((j) => j.status === 'queued' || (includeRunning && j.status === 'running'));
  const labels = [];
  let canceled = 0;
  for (const j of jobs) {
    const r = queue.cancel(j.id);
    if (r?.ok) { canceled += 1; labels.push(j.meta?.label || j.meta?.args?.title || '一首歌'); }
  }
  if (canceled) logFn(`[queue] 已取消 ${chatKey} 的 ${canceled} 首：${labels.join('、')}`);
  return { ok: true, canceled, labels };
}

// ── 估时（只用于给用户一个心理预期，不参与调度）─────────────────────────
// 实测基线（4GB 卡）：12 字 + RVC ≈ 80s；22 字纯 DiffSinger ≈ 22s。
// 宁可估多一点：说「预计 1 分半」然后 80 秒到，比说「17 秒」然后等 80 秒体验好得多。
function estimateSingMs(charCount = 20, { vc = false } = {}) {
  return 9000 + Math.max(4, charCount) * 800 + (vc ? 50000 : 0);
}
function estimateCoverMs(durSec = 60) {
  // 实测：15s 素材全程 142s（分离 58 + F0 10 + RVC 54 + 母带 2，另有固定开销）
  // → 固定成本约 110s，之后约 2.2s/秒素材
  return 110000 + Math.max(10, durSec) * 2200;
}
function estimateMelodyMs(durSec = 24) {
  // 实测 12s 窗口约 25s（含首次 CUDA 初始化摊销）；Demucs 约 1×实时，
  // CREPE 约 0.3×实时，加固定开销。24s 窗口约 50s。
  return 18000 + Math.max(8, durSec) * 1300;
}

// ── 用实测校准估时 ──────────────────────────────────────────────────────
// 群里翻过车：同一段歌词第一次 81s、第二次 216s、第三次 124s，而公式只给 75s，
// 于是「大概一分多钟」变成等了三分半 —— 等待预期崩一次，后面说什么都没人信。
// 原因是耗时几乎与歌词长度无关，主要看 GPU 当时忙不忙（Demucs / RVC 常驻服务抢显存）。
// 所以基线只当下限，实际口径取「最近几次同类作业实测的中位数」。
const costSamples = { sing: [], cover: [] };
const MAX_SAMPLES = 6;

function noteCost(kind, ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 3000 || v > 20 * 60000) return;   // 异常的（秒回缓存 / 卡死）不采
  const a = costSamples[kind] || (costSamples[kind] = []);
  a.push(v);
  if (a.length > MAX_SAMPLES) a.shift();
}

function calibrated(kind, baseMs) {
  const a = costSamples[kind] || [];
  if (a.length < 2) return baseMs;
  const med = [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  // 只往上修不往下砍：宁可早到，不要让用户等过头
  return Math.round(Math.max(baseMs, med * 1.05));
}

/** 启动时从 journal 里回填最近几次实测耗时，免得重启后又回到乐观基线。 */
function loadCostHistory() {
  try {
    const p = path.join(DATA_DIR, 'jobs.jsonl');
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).slice(-300);
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j?.type !== 'done' || !j.result?.costMs) continue;
      const kind = String(j.key || '').startsWith('cover|') ? 'cover' : 'sing';
      noteCost(kind, j.result.costMs);
    }
    const n = costSamples.sing.length + costSamples.cover.length;
    if (n) logFn(`[queue] 载入历史耗时 ${n} 条用于校准等待时间`);
  } catch { /* 读不了就用基线 */ }
}

/** 这个会话前面还有多少秒才轮到新作业（运行中按剩余比例估）。 */
function queueWaitMs(chatKey) {
  if (!queue) return 0;
  const jobs = queue.list({ group: chatKey, limit: 50 })
    .filter((j) => j.status === 'queued' || j.status === 'running');
  return jobs.reduce((s, j) => s + (j.status === 'running'
    ? Math.max(0, (j.etaMs || 0) * (1 - (j.progress || 0) / 100))
    : (j.etaMs || 0)), 0);
}

/** 同会话是否已经有相同标题的在途作业（防「到伴奏/带伴奏」连点两次）。 */
function findDupJob(chatKey, label, selfId = '') {
  if (!queue || !label) return null;
  return queue.list({ group: chatKey, limit: 50 })
    .find((j) => j.id !== selfId && (j.status === 'queued' || j.status === 'running')
      && j.meta?.label === label) || null;
}

function shortReason(err) {
  const raw = String(err?.message ?? err ?? '未知错误').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 160);
}

// ── 唱歌（歌词 → DiffSinger）──────────────────────────────────────────
/**
 * @param {object} p
 * @param {string} p.chatKey
 * @param {object} p.parsed   parseLyrics 的结果（只用 charCount）
 * @param {object} p.args     工具原始参数
 * @param {string|number|null} p.replyToMessageId
 */
export function submitSing({ chatKey, parsed, args, replyToMessageId = null }) {
  if (!songQueueReady()) throw new Error('点歌队列未启动');
  guardFlood(chatKey);
  const voice = args.voice || 'hutao';
  const melodyName = args.melody || '';
  const voiceLabel = { hutao: '胡桃', nahida: '纳西妲', robin: '知更鸟' }[voice] || '胡桃';
  // 干声还是带伴奏：工具没明说就用设置里的默认值（默认干声）。
  // 注意 args.noAcc 是「不要伴奏」，和 withAcc 反着；只在这两个值里取，
  // 不要把 undefined 也读成 false（否则默认就变成带伴奏了）。
  const withAcc = (args.noAcc === undefined || args.noAcc === null)
    ? !svcConfig().singDry
    : args.noAcc !== true;

  // 只有歌词 + 报了歌名、旋律库里又没有这首 → 现场从原曲扒一段旋律（P2 的落地）。
  // 这一步放在 run 里跑（不能在这里跑），否则工具调用又会卡住。
  const title = String(args.title || '').trim();
  let melodyPlan = null;
  if (!melodyName && args.noMelody !== true && title && melodyAutoReady()) {
    // 点歌台缓存（B站原曲）也算「有原曲」：tools 那边已经把 mp3 转好码了，
    // 这里同步查一下就行 —— 不查的话上面答应「按原曲唱」、这里却走现编，前后不一致。
    const local = findLocalSong(title) || findCachedPlaylistAudio(title);
    if (local) {
      melodyPlan = {
        src: local.path,
        title: local.base,
        // 群友给了 start 就尊重它；没给则由 Python 侧自动挑「人声最密」的一段
        start: args.start === undefined || args.start === null ? null : Number(args.start),
        dur: windowForLyrics(parsed?.charCount || 20),
        separate: true,          // 原曲是混音，必须先分离出人声
      };
    }
  }
  // 群友发来的参考音频（哼唱 / 一小段原曲）：曲库和旋律库都没有这首歌时的救命稻草。
  // 有了它就能按真实旋律唱，而不是算法现编。哼唱本来就是纯人声，不用再分离。
  if (!melodyPlan && !melodyName && args.noMelody !== true
      && args.refAudio && fs.existsSync(args.refAudio) && melodyAutoReady()) {
    melodyPlan = {
      src: args.refAudio,
      title: title || '群友发的参考',
      start: args.start === undefined || args.start === null ? null : Number(args.start),
      dur: windowForLyrics(parsed?.charCount || 20),
      separate: false,
      fromRef: true,
    };
  }

  // 内容寻址键：同一个群友连点两次完全相同的参数 → 直接复用，不重复烧 GPU
  const key = 'sing|' + [
    voice, args.lyrics, melodyName, Number(args.melodyTrans) || 0,
    Number(args.bpm) || 92, args.key || 'B3',
    withAcc ? 1 : 0, args.noVc === true ? 0 : 1,
    args.noMelody === true ? 0 : 1,
    melodyPlan ? `${melodyPlan.src}:${melodyPlan.start}:${melodyPlan.dur}` : 'noauto',
  ].join('|');

  const meta = {
    chatKey, args, parsed, voice, voiceLabel, melodyName, replyToMessageId,
    replyTo: replyToMessageId, milestoneSent: false, t0: Date.now(),
    vcOn: args.noVc !== true && svcConfig().vc !== false,
    withAcc,
    melodyPlan,
    // 「查队列」显示用：有歌名显示歌名，否则显示歌词开头
    label: title ? `《${title}》` : `「${String(args.lyrics || '').slice(0, 12)}」`,
  };

  const etaMs = calibrated('sing', estimateSingMs(parsed?.charCount || 20, { vc: meta.vcOn })
    + (melodyPlan ? estimateMelodyMs(melodyPlan.dur) : 0));

  const sub = queue.add({
    group: chatKey,
    key,
    priority: 10,
    etaMs,
    maxAttempts: 2,
    meta,
    run: (ctl) => runSing(ctl, meta),
    onDone: (result) => doneSing(result, meta),
    onFail: (err) => failSing(err, meta),
  });
  // 命中历史成品：必须补投递给「这次」的请求者，否则「秒回」会变成「什么都不发」
  if (sub.cached && sub.result) {
    doneSing(sub.result, meta).catch((e) => logFn(`[唱歌] 缓存投递失败：${e?.message ?? e}`));
  }
  // 回执里带上「前面还有多久」——工具直接把这个数说给用户，比只报自己这首准得多
  sub.waitMs = Math.round(queueWaitMs(chatKey) / 1000);
  sub.dupOf = findDupJob(chatKey, meta.label, sub.id)?.id || '';
  return sub;
}

async function runSing(ctl, meta) {
  const { args, parsed } = meta;
  const est = estimateSingMs(parsed?.charCount || 20, { vc: meta.vcOn });
  const melEst = meta.melodyPlan ? estimateMelodyMs(meta.melodyPlan.dur) : 0;
  const started = Date.now();
  let phase = meta.melodyPlan ? 'melody' : 'render';
  let phaseStart = started;

  // 引擎没有阶段输出，用 elapsed 推算进度。
  // 用指数曲线而不是线性：线性的会在估时用完后卡在 92% 不动，
  // 用户看到「进度条不走了」比看到慢更慌；指数曲线会一直缓慢爬升。
  //
  // 两段式：扒谱占 4~36%，渲染占 38~96%。扒谱期间 Demucs 一分多钟不吐一行日志，
  // 没有这条假曲线用户会以为任务死了。
  const ticker = setInterval(() => {
    const el = Date.now() - phaseStart;
    if (phase === 'melody') {
      ctl.progress({
        stage: 'melody',
        pct: 4 + 32 * (1 - Math.exp(-el / Math.max(4000, melEst * 0.75))),
        etaMs: Math.max(2000, melEst * Math.exp(-el / Math.max(4000, melEst * 0.75)))
          + est * 0.5,
        msg: el < 6000 ? '找原曲的旋律' : (el < melEst * 0.7 ? '分离人声、提取音高' : '整理谱面'),
      });
    } else {
      const e2 = Date.now() - phaseStart;
      ctl.progress({
        stage: 'render',
        pct: 38 + 58 * (1 - Math.exp(-e2 / est)),
        etaMs: Math.max(1500, est * Math.exp(-e2 / est)),
        msg: e2 < 9000 ? '加载模型' : (meta.vcOn && e2 > est * 0.55 ? '换声（RVC）' : '演唱中'),
      });
    }
  }, 2500);
  ticker.unref?.();

  try {
    // ── 阶段 0：现场扒旋律（只有歌词 + 歌名时才会走到）──
    let melody = meta.melodyName;
    let melodyLabel = '';
    let autoInfo = null;
    if (meta.melodyPlan) {
      ctl.progress({
        stage: 'melody', pct: 4, etaMs: melEst,
        msg: meta.melodyPlan.fromRef ? '从你发的这段里提旋律' : '从原曲提旋律',
      });
      try {
        const m = await extractMelodyForSong({
          src: meta.melodyPlan.src,
          title: meta.melodyPlan.title,
          start: meta.melodyPlan.start,
          dur: meta.melodyPlan.dur,
          separate: meta.melodyPlan.separate !== false,
          signal: ctl.signal,
          log: (x) => ctl.log(x),
          onProgress: (p) => ctl.progress({ stage: 'melody', pct: 4 + p.pct * 0.32, msg: p.msg }),
        });
        if (m.ok) {
          melody = m.path;
          melodyLabel = m.title;
          autoInfo = m;
          ctl.log(`[扒谱] 用《${m.title}》的旋律：${m.notes} 音，解释率 `
            + `${Math.round((m.quality?.pitch_fit || 0) * 100)}%${m.cached ? '（缓存）' : ''}`);
        } else {
          // 扒不准就不用——跑调的「原曲旋律」比算法旋律更难听
          meta.melodyFailed = m.reason;
          ctl.log(`[扒谱] 放弃这段谱：${m.reason}`);
        }
      } catch (e) {
        meta.melodyFailed = String(e?.message ?? e);
        ctl.log(`[扒谱] 异常，回退算法旋律：${meta.melodyFailed}`);
      }
      if (ctl.isCanceled()) throw canceledError();
      phase = 'render';
      phaseStart = Date.now();
    }

    ctl.progress({ stage: 'render', pct: 38, etaMs: est, msg: '加载声库' });

    const r = await singLyrics(args.lyrics, {
      style: args.style,
      withMelody: args.noMelody !== true,
      useDiffSinger: true,
      voice: meta.voice,
      bpm: args.bpm || 92,
      key: args.key || 'B3',
      withAcc: meta.withAcc,
      vc: args.noVc === true ? false : undefined,
      melody,
      melodyLabel,
      melodyTrans: Number(args.melodyTrans) || 0,
      signal: ctl.signal,
      log: (m) => ctl.log(m),
      onLine: (line) => {
        if (/\[melody\]/.test(line)) ctl.progress({ stage: 'render', pct: 55, msg: '按旋律排谱' });
        else if (/✅|完成/.test(line)) ctl.progress({ stage: 'render', pct: 94, msg: '渲染完成' });
      },
    });
    if (ctl.isCanceled()) throw canceledError();

    ctl.progress({ stage: 'deliver', pct: 96, etaMs: 800, msg: '写入并发送' });
    const file = saveVoiceBuffer(r.buffer, r.ext || 'wav', 'lyrics');

    return {
      file,
      seconds: r.vocalSec || 0,
      engine: r.engine || '',
      melodyName: r.melodyName || '',
      singer: r.singer || meta.voiceLabel,
      note: r.note || '',
      melodyAuto: autoInfo ? {
        fit: autoInfo.quality?.pitch_fit ?? null,
        cached: !!autoInfo.cached,
        bpm: autoInfo.bpm ?? null,
        notes: autoInfo.notes ?? null,
        costMs: autoInfo.costMs ?? 0,
      } : null,
      melodyFailed: meta.melodyFailed || '',
      costMs: Date.now() - meta.t0,
    };
  } finally {
    clearInterval(ticker);
  }
}

// 记录实测耗时用于下次校准（在 run 外面记，取消/失败的作业不采）
function trackSingCost(result) { if (result?.costMs) noteCost('sing', result.costMs); }
function trackCoverCost(result) { if (result?.costMs) noteCost('cover', result.costMs); }

async function doneSing(result, meta) {
  const { chatKey, args } = meta;
  trackSingCost(result);
  // 语音条里已经能听出来，再补一句文字让上下文完整（也方便模型后续接话）
  const sec = Math.round(result.seconds);
  let head;
  if (result.melodyName) {
    const fit = Number(result.melodyAuto?.fit);
    head = `《${result.melodyName}》唱好了，${sec} 秒`
      + (Number.isFinite(fit) && fit > 0 ? `（旋律是刚按原曲扒的，音高贴合 ${Math.round(fit * 100)}%）` : '')
      + '。';
  } else if (result.melodyFailed) {
    // 扒不准时如实说，别让群友以为「原曲就长这样」
    head = `原曲那段扒得不准（${String(result.melodyFailed).slice(0, 40)}），先用现编的调唱了，${sec} 秒。`;
  } else {
    head = `唱好了，${sec} 秒（这段的调是我现编的）。`;
  }
  // 干声（清唱）要说明，否则群友会问「怎么没伴奏」
  if (meta.withAcc === false) head += '这是清唱版，只有人声没伴奏；想要带伴奏的我再唱一遍。';
  await safeText(chatKey, head);
  const d = await deliverSing(sender, chatKey, {
    file: result.file,
    seconds: result.seconds,
    engine: result.engine,
    melodyName: result.melodyName,
    singer: result.singer,
    hq: args?.hq === true,
    full: args?.full === true,
    replyToMessageId: meta.replyToMessageId ?? null,
  });
  logFn(`[唱歌] 已投递 ${meta.chatKey}（${d.mode} ${Math.round(result.seconds)}s，队列内耗时 ${Math.round((result.costMs || 0) / 1000)}s）`);
}

async function failSing(err, meta) {
  if (err?.code === 'CANCELED') return;
  logFn(`[唱歌] 失败 ${meta.chatKey}：${shortReason(err)}`);
  await safeText(meta.chatKey, `这首没唱成：${shortReason(err)}。换个短点的词或者再点一次试试。`);
}

// ── 翻唱（原曲 → RVC）────────────────────────────────────────────────
export function submitCover({ chatKey, args }) {
  if (!songQueueReady()) throw new Error('点歌队列未启动');
  guardFlood(chatKey);
  const name = args.name || 'cover';
  const dur = Number(args.dur) || 60;
  const start = Number(args.start) || 0;
  // 干声（只人声）还是带原曲伴奏：工具没明说就用设置默认值（默认干声）
  const dry = (args.dry === undefined || args.dry === null)
    ? svcConfig().coverDry
    : args.dry !== false;
  // 人声分离后端（设置→语音→唱歌转换）：必须进缓存键。
  // 换后端等于换了一份 stems，不加这个维度会直接命中旧分离结果 —— 用户改了下拉却听不出任何变化。
  const separator = svcConfig().separator;

  // 让「同一个文件 + 同一段 + 同一模型」命中缓存；文件换了要重新算
  let stamp = '';
  try {
    const st = fs.statSync(args.src);
    stamp = `${st.size}_${Math.round(st.mtimeMs)}`;
  } catch { stamp = String(args.src); }
  const key = `cover|${stamp}|${start}|${dur}|${name}|${dry ? 'dry' : 'mix'}|${separator}`;

  const meta = {
    chatKey, args, name, dur, start, dry, separator, milestoneSent: false, t0: Date.now(),
    label: name ? `《${name}》${dry ? '（清唱）' : ''}` : '翻唱',
  };

  const sub = queue.add({
    group: chatKey,
    key,
    priority: 10,
    etaMs: calibrated('cover', estimateCoverMs(dur)),
    maxAttempts: 2,
    meta,
    run: (ctl) => runCover(ctl, meta),
    onDone: (result) => doneCover(result, meta),
    onFail: (err) => failCover(err, meta),
  });
  if (sub.cached && sub.result) {
    doneCover(sub.result, meta).catch((e) => logFn(`[翻唱] 缓存投递失败：${e?.message ?? e}`));
  }
  sub.waitMs = Math.round(queueWaitMs(chatKey) / 1000);
  sub.dupOf = findDupJob(chatKey, meta.label, sub.id)?.id || '';
  return sub;
}

const COVER_STAGE_PCT = { 1: 15, 2: 35, 3: 62, 4: 88, 5: 96 };
const COVER_STAGE_MSG = {
  1: '分离人声与伴奏', 2: '提取原唱音高', 3: 'RVC 换声', 4: '混音母带', 5: '质检',
};

async function runCover(ctl, meta) {
  // dry 必须从 meta 解构出来：翻唱成品是干声还是混音，全靠它决定。
  // （曾经漏了这一项 —— 直接 ReferenceError: dry is not defined，
  //   作业在 5% 就失败，群里表现成「发的 mp3 下不下来/翻唱不了」。）
  const { args, dur, start, name, dry, separator } = meta;
  ctl.progress({ stage: 'separate', pct: 5, etaMs: estimateCoverMs(dur), msg: '准备原曲' });

  const r = await coverSong({
    src: args.src,
    name,
    start,
    dur,
    dry,
    separator,
    demucsDevice: args.demucsDevice || 'auto',
    signal: ctl.signal,
    log: (m) => {
      ctl.log(m);
      // 阶段缓存命中：可能是 stems / rvc / 整首成品。成品命中会直接跳到投递，
      // 这里给一个明确的阶段名，用户看到「复用上次成品」而不是进度条卡住。
      if (/\[cache\]/.test(m) && /命中/.test(m)) {
        const whole = /成品命中/.test(m);
        ctl.progress({
          stage: 'cache',
          pct: whole ? 92 : 45,
          etaMs: whole ? 1200 : undefined,
          msg: whole ? '复用上次的成品' : '复用已分离的素材',
        });
      }
      // route_a.py 打成 `[1/5] ...`，用它做真实进度锚点
      const hit = String(m).match(/\[(\d)\/5\]/);
      if (hit) {
        const n = Number(hit[1]);
        const pct = COVER_STAGE_PCT[n] || 50;
        ctl.progress({ stage: n <= 2 ? 'separate' : (n === 3 ? 'convert' : 'mix'), pct, msg: COVER_STAGE_MSG[n] });
        // 长任务中途播报一次（只播一次，别刷屏）
        if (n === 3 && !meta.milestoneSent && Date.now() - meta.t0 > 60000) {
          meta.milestoneSent = true;
          safeText(meta.chatKey, '伴奏和人声分离好了，正在换成胡桃的声音，还要一两分钟。');
        }
      }
    },
  }).catch((e) => {
    // 翻唱失败基本是输入/引擎问题（音频坏了、缺模型），重跑只会再烧一遍 GPU
    if (e && e.code !== 'CANCELED' && e.retryable !== false) e.retryable = false;
    throw e;
  });
  if (ctl.isCanceled()) throw canceledError();

  ctl.progress({ stage: 'deliver', pct: 97, etaMs: 800, msg: '写入成品' });
  const file = saveVoiceBuffer(r.buffer, 'wav', 'cover' + '-' + name.slice(0, 20));

  return {
    file,
    seconds: r.seconds || 0,
    name,
    dry: !!dry,
    qc: r.report?.qc ? { passed: r.report.qc.passed, total: r.report.qc.total } : null,
    keySim: r.report?.qc?.dry_key_sim ?? null,
    costMs: Date.now() - meta.t0,
  };
}

async function doneCover(result, meta) {
  trackCoverCost(result);
  // 干声不做成品质检。2026-10-24 剃刀：调性一致度/质检通过率不再念给群友（一眼是机器），
  // 指标仍在 result/日志里，只是不进这段发到群里的人话。
  let tail = '';
  if (result.dry) {
    tail = '清唱版（只有人声，没混原曲伴奏），想要带伴奏的跟我说一声';
  }
  await safeText(meta.chatKey, `《${result.name}》翻唱好了，${Math.round(result.seconds)} 秒${tail}。`);
  await deliverCover(sender, meta.chatKey, {
    file: result.file, seconds: result.seconds, name: result.name,
    full: meta.args?.full === true || meta.args?.hq === true,
  });
  logFn(`[翻唱] 已投递 ${meta.chatKey}（${Math.round(result.seconds)}s，队列内 ${Math.round((result.costMs || 0) / 1000)}s）`);
}

async function failCover(err, meta) {
  if (err?.code === 'CANCELED') return;
  logFn(`[翻唱] 失败 ${meta.chatKey}：${shortReason(err)}`);
  await safeText(meta.chatKey, `这首没翻成：${shortReason(err)}。可以换一段（改 start/dur）再试。`);
}

// 交付阶段的文字发送不能反过来把任务判失败：音频已经生成了，
// 补一句话失败只是少一句话，不该让整单重试。
async function safeText(chatKey, text) {
  try {
    if (!sender) return;
    await sender.sendTextBatch(chatKey, [text]);
  } catch (e) {
    logFn(`[queue] 提示语发送失败（不影响成品）：${e?.message ?? e}`);
  }
}

/** 给控制台/调试用：清掉临时目录里的孤儿产物（队列崩溃时可能留下）。 */
export function sweepOrphanOutputs(maxAgeMs = 24 * 3600 * 1000) {
  const dir = path.join(ROOT, 'data', 'voice');
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > maxAgeMs && /^job-/.test(f)) { fs.unlinkSync(p); removed++; }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return removed;
}
