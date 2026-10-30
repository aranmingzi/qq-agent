// 语音活动检测（VAD）：把连续推来的 PCM 帧切成「一段人话」。
//
// ── 为什么要有这个文件 ─────────────────────────────────────────────────
// 打电话的体验好坏，八成取决于「什么时候认为你说完了」。
// 早了 → 它抢话，你一句话被切成三句；晚了 → 每轮都要干等一秒多。
//
// ── 为什么不用神经网络 VAD ──────────────────────────────────────────────
// Silero VAD 效果确实好，但要 `onnxruntime-node`（原生依赖，跨平台打包是坑）。
// 本项目连 ffmpeg 都是「碰运气找得到就用」（src/media-tools.js:27-45），
// 再引入一个原生依赖会让"能不能跑起来"变成不确定事件。
// 能量阈值 VAD 在安静房间够用，而且**完全可解释** —— 调不准的时候
// 你能看着电平条自己调阈值，而不是对着一个黑盒干瞪眼。
// 接口留成状态机，将来换成 Silero 只需要换 createVad 的实现。
//
// ── 纪律 ──────────────────────────────────────────────────────────────
// 纯函数式状态机：可注入时钟、零 IO、零依赖。时间一律由调用方给（`at`），
// 这样测试里不用 sleep，也不会因为机器卡顿产生偶发失败。
import { pcmDurationMs, int16ToFloat32, DEFAULT_SAMPLE_RATE } from './pcm.js';

/** 一帧 20ms：16000Hz × 0.02s × 2字节 = 640 字节。够细，又不至于每帧都算一次开销大的事。 */
export const DEFAULT_FRAME_MS = 20;

/** 默认阈值：RMS 0.012 大约等于「比房间底噪明显高、但还不到正常说话音量」。 */
export const DEFAULT_THRESHOLD = 0.012;

/**
 * 建一个 VAD 状态机。
 *
 * @param {object} [options]
 * @param {number} [options.threshold=0.012]   RMS 超过它才算"有声"
 * @param {number} [options.minSpeechMs=250]   连续有声多久才认「开始说话」（挡键盘声/关门声）
 * @param {number} [options.silenceMs=700]     连续无声多久才认「说完了」
 * @param {number} [options.preRollMs=200]     开始说话前额外保留多久，防止吃掉第一个字
 * @param {number} [options.keepTailMs=200]    结尾保留多久静音，防止削掉尾音
 * @param {number} [options.sampleRate=16000]
 * @param {() => number} [options.now]         时钟，测试可注入
 */
export function createVad(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sampleRate = Number(options.sampleRate) > 0 ? Number(options.sampleRate) : DEFAULT_SAMPLE_RATE;

  let threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : DEFAULT_THRESHOLD;
  const minSpeechMs = Math.max(0, Number(options.minSpeechMs ?? 250));
  const silenceMs = Math.max(0, Number(options.silenceMs ?? 700));
  const preRollMs = Math.max(0, Number(options.preRollMs ?? 200));
  const keepTailMs = Math.max(0, Number(options.keepTailMs ?? 200));

  /** @type {'idle'|'speech'} */
  let state = 'idle';
  /** 还没开始说话时滚动保存的最近若干帧，用来补 pre-roll。 */
  let preRoll = [];
  /** 正在累积的这一段。 */
  let frames = [];
  /** 连续有声的毫秒数（idle 态下判断 minSpeechMs）。 */
  let voicedRunMs = 0;
  /** 连续无声的毫秒数（speech 态下判断 silenceMs）。 */
  let silenceRunMs = 0;
  /** 这一段从什么时候开始（含 pre-roll），给上层做超时判断。 */
  let segmentStartedAt = null;
  /** 最近一帧的 RMS，给 UI 电平条用。 */
  let level = 0;
  /** 平滑后的 RMS，避免电平条疯狂抖动。 */
  let smoothLevel = 0;

  function reset() {
    state = 'idle';
    preRoll = [];
    frames = [];
    voicedRunMs = 0;
    silenceRunMs = 0;
    segmentStartedAt = null;
    level = 0;
    smoothLevel = 0;
  }

  /** 一帧的 RMS（0..1，按 int16 满幅归一）。 */
  function frameRms(frame) {
    if (!frame || frame.length < 2) return 0;
    const samples = int16ToFloat32(frame);
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  /** 把 frames 里的帧按顺序拼成一个 Buffer。 */
  function joinFrames(list) {
    if (list.length === 0) return Buffer.alloc(0);
    return Buffer.concat(list.map((f) => f.buf));
  }

  /**
   * 收尾：丢掉结尾多余的静音，但保留 keepTailMs。
   *
   * 为什么不是「全丢掉」：能量判据对爆破音、齿音这类弱音不太敏感，
   * 一刀切在最后一个有声帧上，很容易把「说」字的尾巴削掉，
   * 识别出来就成了「说」。保留 200ms 是廉价保险。
   */
  function trimTail(list) {
    let lastVoiced = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].voiced) { lastVoiced = i; break; }
    }
    if (lastVoiced < 0) return list;         // 整段都没声，交给上层当噪音丢掉
    let end = lastVoiced + 1;
    let tail = 0;
    for (let i = lastVoiced + 1; i < list.length; i += 1) {
      if (tail + list[i].ms > keepTailMs) break;
      tail += list[i].ms;
      end = i + 1;
    }
    return list.slice(0, end);
  }

  /**
   * 推一帧。
   *
   * @param {Buffer|Uint8Array} frame  裸 PCM（16bit 小端）
   * @param {number} [at]              这一帧**开始**的时刻（ms）。省略就用注入的时钟。
   * @returns {{event: null|'speech-start'|'speech-end', segment: Buffer|null, ms: number}}
   */
  function push(frame, at) {
    const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame ?? []);
    const ms = pcmDurationMs(buf.length, sampleRate, 1);
    if (buf.length === 0) return { event: null, segment: null, ms: 0 };

    const t = Number.isFinite(at) ? Number(at) : now();
    level = frameRms(buf);
    // 快升慢降：说话立刻抬起来，停下慢慢落，电平条才看得懂。
    smoothLevel = level > smoothLevel ? level : smoothLevel * 0.8 + level * 0.2;
    const voiced = level >= threshold;

    if (state === 'idle') {
      preRoll.push({ buf, voiced, ms, at: t });
      // 只留 preRollMs（+ 正在累积的有声段）的尾巴，否则内存会一直涨。
      let total = preRoll.reduce((n, f) => n + f.ms, 0);
      while (preRoll.length > 1 && total > preRollMs + Math.max(minSpeechMs, 0)) {
        total -= preRoll[0].ms;
        preRoll.shift();
      }

      if (!voiced) {
        voicedRunMs = 0;
        return { event: null, segment: null, ms };
      }

      voicedRunMs += ms;
      if (voicedRunMs < minSpeechMs) return { event: null, segment: null, ms };

      // 说话成立：把 pre-roll（含刚攒够的那几帧）整段变成这一段的开头。
      state = 'speech';
      frames = preRoll.slice();
      preRoll = [];
      silenceRunMs = 0;
      // 起点取**第一帧自己的时间戳**，而不是「当前时间减去估计时长」——
      // 后者在有 pre-roll 或调用方传入的时间戳不连续时会算出负数。
      segmentStartedAt = frames.length > 0 ? frames[0].at : t;
      voicedRunMs = 0;
      return { event: 'speech-start', segment: null, ms };
    }

    // state === 'speech'
    frames.push({ buf, voiced, ms, at: t });
    if (voiced) {
      silenceRunMs = 0;
    } else {
      silenceRunMs += ms;
      if (silenceRunMs >= silenceMs) {
        const kept = trimTail(frames);
        const segment = joinFrames(kept);
        state = 'idle';
        frames = [];
        silenceRunMs = 0;
        voicedRunMs = 0;
        segmentStartedAt = null;
        return { event: 'speech-end', segment, ms };
      }
    }
    return { event: null, segment: null, ms };
  }

  /**
   * 强制收尾（用户点了「发送」，或者要打断它）。
   * 没在说话就返回 null —— 上层据此判断「这次没什么可识别的」。
   */
  function flush() {
    if (state !== 'speech') return null;
    const kept = trimTail(frames);
    const segment = joinFrames(kept);
    reset();
    return segment.length > 0 ? segment : null;
  }

  /** 通话中它说话时要用更高的阈值，否则会听见自己。 */
  function setThreshold(next) {
    const v = Number(next);
    if (Number.isFinite(v) && v > 0) threshold = v;
    return threshold;
  }

  return {
    push,
    flush,
    reset,
    setThreshold,
    get threshold() { return threshold; },
    get state() { return state; },
    get level() { return level; },
    get smoothLevel() { return smoothLevel; },
    snapshot() {
      return {
        state,
        threshold,
        level,
        smoothLevel,
        voicedRunMs,
        silenceRunMs,
        segmentMs: frames.reduce((n, f) => n + f.ms, 0),
        segmentStartedAt,
        minSpeechMs,
        silenceMs
      };
    }
  };
}
