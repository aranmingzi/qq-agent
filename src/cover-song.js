// 原曲翻唱（路线 A）：原曲 → Demucs 分离 → 原唱 F0 → RVC 音色迁移 → 混音母带 → 质检
//
// 相比 sing_engine.py（歌词→算法生成旋律），这是「按原曲真唱」：
// 分离原曲伴奏 + 用原唱的真实 F0 + RVC 换成胡桃音色 + 专业母带链，
// 输出 44.1kHz 真立体声成品。
//
// 关键：RVC 走 CLI 子进程（route_a.py 内建），与常驻 RVC 服务（说话用）抢 4GB 显存。
// 所以翻唱前要停常驻服务、翻唱后重启，避免 OOM。
//
// 依赖：diffsinger-hutao/route_a.py 及同目录的 separate/pitch_track/mix_master/metrics/qc/rvc_inference
//       diffsinger-env 的 python（跑 route_a）+ rvc/py310 的 python（跑 demucs 和 RVC）

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './config.js';
import { wavDurationSec } from './util.js';
import { stopRvcService, ensureRvcService, rvcStatus } from './rvc-voice.js';
import { isKgmFile, decryptKgmToAudio } from './kgm.js';
import { resolveLinkAudio } from './link-audio.js';
import { ddspConfig, ensureDdspService, stopDdspService } from './ddsp-voice.js';
import { svcConfig, normalizeSeparator, isMdxSeparator } from './svc-voice.js';

const DS_DIR = path.join(ROOT, 'diffsinger-hutao');
const DS_PY = path.join(ROOT, 'diffsinger-env', 'Scripts', 'python.exe');
const ROUTE_A = path.join(DS_DIR, 'route_a.py');

/** 原曲翻唱引擎是否就绪。 */
export function coverReady() {
  try {
    return fs.existsSync(DS_PY) && fs.existsSync(ROUTE_A);
  } catch {
    return false;
  }
}

/**
 * 翻唱一首原曲（路线 A 一键流程）。
 * @param {object} opts
 * @param {string} opts.src   原曲音频路径（wav/flac/mp3/m4a）
 * @param {string} opts.name  歌名（输出命名）
 * @param {number} opts.dur   时长秒（默认 60）
 * @param {number} opts.start 起始秒（默认 0，主歌常不在开头）
 * @param {string} opts.model RVC 模型名（默认 hutao）
 * @param {number} opts.indexRate / protect / enhance / f0up   RVC 参数
 * @param {string} opts.demucsDevice 分离设备：auto（默认，显存够就 GPU）/ cuda / cpu
 * @param {string} opts.separator 人声分离后端：htdemucs（默认）/ htdemucs_ft / mdx_kim / mdx_vocft。
 *                 留空 = 读配置 audio.svc.separator（控制台 设置→语音→唱歌转换 里的下拉）。
 * @param {boolean} opts.dry    true=只出干声（清唱人声），不混原曲伴奏、不做母带
 * @param {function} opts.log  日志回调
 * @param {object} opts.signal 取消信号（AbortController.signal）
 * @returns {Promise<{buffer, ext, seconds, report, out, costMs, dry}>} 或抛错
 */
export async function coverSong({
  src, name, dur = 60, start = 0,
  model = 'hutao', indexRate = 0.65, protect = 0.33, enhance = 0, f0up = 0,
  method = 'rmvpe', demucsDevice = 'auto', separator = '', noCache = false, dry = false,
  log = null, signal = null,
} = {}) {
  if (!coverReady()) {
    throw new Error('原曲翻唱引擎未就绪（缺 python 或 route_a.py）');
  }
  // 分离后端：显式传参优先，否则读配置（热生效，改完下拉不用重启）。
  // 走 normalizeSeparator 而不是直接透传：route_a 的 argparse 只认四个值，
  // 传错就是退出码 2，而报错只有 python 的 usage 提示，群里看起来像「引擎挂了」。
  const sepModel = normalizeSeparator(separator || svcConfig().separator);
  // ★ 必须先转绝对路径：route_a.py 以 diffsinger-hutao 为 cwd 启动，
  //   相对路径（如 songs/raw/xxx.wav）会被解析到 diffsinger-hutao/songs/raw/…
  //   结果是 Node 侧 existsSync 通过、Python 侧 FileNotFoundError。
  //
  // 另外 src 允许直接是链接（B站视频 / 网易云歌曲页 / 音频直链）——
  // 群友甩一条链接过来就想听翻唱，不该逼他先下成文件。下载失败时把真实原因带出去。
  let srcAbs = String(src || '').trim()
    ? path.resolve(ROOT, String(src).replace(/^file:\/\//, ''))
    : '';
  if (/^https?:\/\//i.test(String(src || '').trim())) {
    if (log) log('[翻唱] 原曲是链接，先取音频…');
    const got = await resolveLinkAudio(String(src).trim(), {
      dir: path.join(ROOT, 'cache', 'incoming'),
      stem: `cover-${Date.now()}`,
      log,
    });
    srcAbs = got.file;
    if (!name && got.title) name = got.title;
  }
  if (!srcAbs || !fs.existsSync(srcAbs)) {
    throw new Error('找不到原曲：' + (src || '(未指定)'));
  }
  // 曲库里可能躺着酷狗加密文件（群友发过 .kgm.flac，扩展名是 flac、内容是密文）——
  // 不解密的话 route_a.py 会在解码那一步抛「Output file #0 does not contain any stream」。
  // 这里就地解一次，后面全用解密后的 wav。
  const useSrc = isKgmFile(srcAbs)
    ? (await decryptKgmToAudio(fs.readFileSync(srcAbs), {
      stem: path.basename(srcAbs, path.extname(srcAbs)),
      dir: path.join(ROOT, 'cache', 'incoming'),
      log,
    })).file
    : srcAbs;

  const safeName = String(name || 'cover').replace(/[\\/:*?"<>|]/g, '_');
  // 干声和混音是两种成品：文件名必须分开，否则后跑的会把先跑的覆盖掉
  // （缓存键虽然区分了，但 out/ 是给用户直接听的，同名会让人拿到错的那个）。
  const out = path.join(ROOT, 'out', `${safeName}_路线A_${Math.round(dur)}s${dry ? '_干声' : ''}.wav`);
  const report = path.join(ROOT, 'out', `${safeName}_路线A${dry ? '_干声' : ''}_report.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  // 显存协调：翻唱走 CLI 子进程，要独占 4GB 显存，先停常驻 RVC 服务
  let stoppedRvc = false;
  const pre = await rvcStatus().catch(() => null);
  if (pre && pre.health?.loaded) {
    if (log) log('[翻唱] 暂停常驻 RVC 服务，释放显存给翻唱子进程…');
    stopRvcService({ force: true });
    stoppedRvc = true;
    await new Promise((r) => setTimeout(r, 2000)); // 等显存释放
  }

  // 换音色引擎：ddsp=知更鸟 DDSP-SVC（歌声更贴原唱）；起不来就退回 RVC CLI
  const ddspCfg = ddspConfig();
  let rvcMode = 'cli';
  let rvcModel = model;
  if (ddspCfg.enabled) {
    const ready = await ensureDdspService({ log });
    if (ready.ok) {
      rvcMode = 'ddsp';
      rvcModel = ddspCfg.model;
    } else if (log) {
      log('[翻唱] DDSP 不可用，改用 RVC：' + (ready.reason || ''));
    }
  }

  const t0 = Date.now();
  const mdx = isMdxSeparator(sepModel);
  const args = [
    ROUTE_A, '--src', useSrc, '--name', safeName, '--dur', String(dur),
    '--start', String(start), '--rvc-mode', rvcMode, '--rvc-model', rvcModel,
    '--index-rate', String(indexRate), '--protect', String(protect),
    '--enhance', String(enhance), '--f0up', String(f0up), '--method', method,
    // 分离后端必须显式传：route_a 的默认是 htdemucs，不写就永远吃不到配置里的选择
    '--separator', sepModel,
    '--out', out, '--report', report,
  ];
  // MDX 走 audio-separator（ONNX，不认 --demucs-device），传了反而误导排查日志
  if (!mdx) args.push('--demucs-device', demucsDevice);
  if (log) {
    log(`[翻唱] 分离后端：${sepModel}`
      + (mdx ? '（UVR MDX-Net，CPU 跑）' : `（Demucs，设备 ${demucsDevice}）`));
  }
  if (rvcMode === 'ddsp') args.push('--ddsp-url', ddspCfg.url);
  if (dry) args.push('--dry');
  // 默认开阶段缓存（stems / f0 / rvc / final 四级），命中即跳过对应耗时；
  // noCache 只在怀疑缓存脏了、排查音质时用。
  if (noCache) args.push('--no-cache');

  try {
    // tail 提到外层：失败时要把最后的真实报错带出去。
    // 以前只抛「退出码 1」，群里只能看到一句无信息量的失败提示，排查全靠猜。
    let tail = '';
    const code = await new Promise((resolve, reject) => {
      if (log) log(dry
        ? '[翻唱] 启动路线 A（分离→F0→RVC，只出干声），约 2~4 分钟…'
        : '[翻唱] 启动路线 A（分离→F0→RVC→母带→质检），约 4~5 分钟…');
      const child = spawn(DS_PY, args, {
        cwd: DS_DIR,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
      });
      const onData = (chunk) => {
        const s = String(chunk);
        tail = (tail + s).slice(-4000);
        // 把关键进度透传出去
        const m = s.match(/\[\d+\/\d+\].*|\[rvc\].*|\[母带\].*|\[门禁\].*|\[cache\].*|=== 完成 ===/g);
        if (m && log) for (const line of m) log('[翻唱] ' + line.trim());
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const abort = () => { try { child.kill(); } catch { /* ignore */ } };
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }
      child.on('error', (e) => reject(e));
      child.on('close', (c) => resolve(c));
    });

    if (code !== 0) {
      // 退出码非 0 基本是输入/引擎问题（缺模型、音频坏了），重试只会再浪费一遍 GPU
      const brief = tail.split('\n').filter((l) => /Error|error|Traceback|失败|错误|No such|not found/i.test(l)).slice(-3).join(' / ')
        || tail.slice(-300);
      const e = new Error('路线 A 失败（退出码 ' + code + '）：' + brief.replace(/\s+/g, ' ').trim().slice(0, 400));
      e.code = 'ROUTE_A_FAILED';
      e.retryable = false;
      throw e;
    }
    if (!fs.existsSync(out)) {
      throw new Error('翻唱完成但没产出文件：' + out);
    }

    const buffer = fs.readFileSync(out);
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(report, 'utf8')); } catch { /* 忽略 */ }

    if (log) {
      // 把「分离耗时 + 后端」写进完成日志：换成 htdemucs_ft / MDX 之后觉得变慢时，
      // 这一行就是唯一能直接对比的证据（总耗时还掺了 RVC 和母带，看不出来）。
      const sepSec = Number(rep?.separate_sec);
      const sepText = rep?.cache === 'stems-hit' ? '复用缓存'
        : (Number.isFinite(sepSec) ? `${sepSec}s` : '?');
      log('[翻唱] 完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's → ' + out
        + `（分离 ${sepText} / ${sepModel}）`);
    }
    return {
      buffer, ext: 'wav',
      seconds: Math.round(wavDurationSec(buffer) * 10) / 10, // 按 RIFF 头算（mix_master 输出 24bit）
      report: rep, out, costMs: Date.now() - t0,
      dry: !!dry,
      cacheHit: rep?.cache && String(rep.cache).includes('hit') ? rep.cache : null,
      resampleCount: rep?.resample?.count ?? null,
    };
  } finally {
    // 翻唱后重启常驻 RVC 服务，恢复说话音色
    if (stoppedRvc) {
      try { await ensureRvcService({ log: null, force: true }); }
      catch (e) { if (log) log('[翻唱] 常驻 RVC 服务重启失败：' + (e?.message || e)); }
    }
    if (rvcMode === 'ddsp') stopDdspService();
  }
}
