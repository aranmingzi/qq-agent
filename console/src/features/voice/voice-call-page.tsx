import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  Speaker,
  Volume2,
  Zap,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  VoiceCall,
  fetchCallStatus,
  fetchVoiceStatus,
  saveOutputLabel,
  type CaptureMode,
  type VoiceState,
  type VoiceStatus,
} from '@/lib/voice-client';
import { matchByLabel, toOutputDevices, type OutputDevice } from '@/lib/call-output';

// 语音通话页：在控制台里像打电话一样跟它说话。
//
// ── 为什么放在控制台而不是 QQ 客户端里 ────────────────────────────────
// QQ 的语音/视频通话走的是闭源的 AVSDK/NTRTC，协议端（NapCat/Lagrange）
// 根本没有对应接口 —— 不是没实现，是协议层不给你。这一点写进 README 了，
// 免得后来的人再花一天去查一遍。
//
// ── 这一版的界面为什么这么排 ──────────────────────────────────────────
// 上一版把「听谁」「送去哪」「状态」「计时」「电平」「按钮」「两句提示」
// 全塞进同一张卡里，再把通话记录放到第三张卡 —— 结果人一开口，回复在
// 屏幕外面，得滚下去才看得到；同时电平条每 8ms 触发一次 setState，
// 整页跟着抖。这一版拆成三块，各管一件事：
//
//   通话台   现在是什么状态、我能按什么        （主区，恒定在上）
//   通话记录 它说了什么                        （右侧，和通话台并排）
//   通话设置 听谁、送去哪                      （只在通话开始前后需要看）
//
// 颜色也收窄了：上一版六种状态配六个色（emerald/sky/amber/violet…），
// 那是最典型的「每个状态都要有个颜色」的过度设计。现在只留三档 ——
// 灰（没在动）、绿（在收音）、蓝（在处理），一眼能分辨就够了。

const STATE_TEXT: Record<VoiceState, string> = {
  idle: '还没开始',
  listening: '在听',
  transcribing: '在听写',
  thinking: '在想',
  speaking: '在说',
  closed: '已挂断',
};

/** 状态点的颜色：只有三档，别再加。 */
const STATE_DOT: Record<VoiceState, string> = {
  idle: 'bg-muted/40',
  listening: 'bg-success',
  transcribing: 'bg-primary',
  thinking: 'bg-primary',
  speaking: 'bg-primary',
  closed: 'bg-muted/40',
};

const STATE_HINT: Record<VoiceState, string> = {
  idle: '按「开始通话」，它就开始听你说话。',
  listening: '直接说话就行，你停下来它会自己接话。',
  transcribing: '正在把你刚说的话转成文字…',
  thinking: '在想怎么回你…',
  speaking: '它在说。这时候你开口会把它打断（抢话）。',
  closed: '这一通已经结束了，可以再打一通。',
};

type Line = { who: '你' | '它' | '系统'; text: string; at: number };

const CAPTURE_TEXT: Record<CaptureMode, string> = {
  mic: '麦克风',
  loopback: '系统声音',
};

const CAPTURE_HINT: Record<CaptureMode, string> = {
  mic: '对着电脑说话。适合在控制台里直接跟它聊。',
  loopback: '抓系统混音：QQ 正在放出来的对方声音会被它听见。需要 QQ Agent 桌面版。',
};

const DEFAULT_OUTPUT_TEXT = '系统默认设备（打 QQ 电话对方听不见）';
// Radix 的 Select 不允许 value=""（会直接抛错），所以"不选任何设备"
// 必须有一个真实存在的哨兵值，转成空串再存。
const OUTPUT_SENTINEL = '__default__';

export function VoiceCallPage() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [state, setState] = useState<VoiceState>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<CaptureMode>('mic');
  // 嘴：声音往哪个设备送。打 QQ 电话必须送进虚拟声卡，
  // 否则声音只从你自己的扬声器出来，对方一个字都听不到。
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [outputId, setOutputId] = useState('');
  const [outputNote, setOutputNote] = useState('');
  const callRef = useRef<VoiceCall | null>(null);

  // ── 电平条不进 React ────────────────────────────────────────────────
  // 上一版是 onLevel: setLevel，即每个音频回调都 setState 一次。
  // 即使把回调限到 20 次/秒，那仍然是每秒 20 次整页重渲染 ——
  // 一个只用来画一条 3px 线的数字，不该有这种权力。
  // 现在电平写进 ref，由 requestAnimationFrame 直接改 DOM 的 transform，
  // React 在整个通话期间一次都不用为它渲染。
  const barRef = useRef<HTMLDivElement | null>(null);
  const levelRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const paintLevel = useCallback(() => {
    rafRef.current = null;
    const node = barRef.current;
    if (!node) return;
    // 阈值 0.012 是 VAD 的判定线，乘 25 让它落在条子中段，再夹到 0~1。
    const ratio = Math.min(1, Math.max(0, levelRef.current * 25));
    node.style.transform = `scaleX(${ratio.toFixed(3)})`;
  }, []);

  const onLevel = useCallback(
    (value: number) => {
      levelRef.current = value;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(paintLevel);
    },
    [paintLevel],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const listRef = useRef<HTMLDivElement | null>(null);

  const push = useCallback((who: Line['who'], text: string) => {
    if (!text) return;
    setLines((prev) => [...prev.slice(-60), { who, text, at: Date.now() }]);
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatusError('');
    try {
      setStatus(await fetchVoiceStatus());
    } catch (err) {
      setStatus(null);
      setStatusError((err as Error)?.message ?? String(err));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // 读输出设备列表，并把上次选的那个认回来。
  //
  // 两件事必须一起做：
  // 1. 浏览器只在**授权过麦克风之后**才给得出设备标签，所以这里要等
  //    enumerateDevices() 返回非空标签，否则会显示一串空名字让用户没法选。
  // 2. 上次存的只有标签（deviceId 换端口就失效），所以要用 matchByLabel 认回来；
  //    认不回来必须明说，不能悄悄回落到系统默认 —— 那样对方听不见，
  //    而用户会以为"通话功能坏了"。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const entries = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const list = toOutputDevices(entries);
        setOutputs(list);
        let saved = '';
        try {
          saved = (await fetchCallStatus()).mouth.outputLabel;
        } catch {
          saved = '';
        }
        if (cancelled) return;
        if (saved) {
          const hit = matchByLabel(list, saved);
          if (hit) {
            setOutputId(hit.deviceId);
            setOutputNote('');
          } else {
            setOutputNote(`上次选的「${saved}」现在找不到了，可能驱动被卸了或者改了名。`);
          }
        }
      } catch (err) {
        if (!cancelled) setOutputNote(`读不到声音输出设备：${(err as Error)?.message ?? String(err)}`);
      }
    };
    void load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, []);

  // 选设备 = 立刻生效（切当前播放上下文）+ 记住（下次还用它）。
  const chooseOutput = useCallback(
    async (deviceId: string) => {
      setOutputId(deviceId);
      setOutputNote('');
      if (!deviceId) {
        void saveOutputLabel('').catch(() => {});
        return;
      }
      const picked = outputs.find((item) => item.deviceId === deviceId);
      if (!picked) return;
      const applied = await callRef.current?.setOutputDevice(deviceId).catch(() => false);
      try {
        await saveOutputLabel(picked.label);
      } catch (err) {
        setOutputNote(`记住了这次选择，但保存失败：${(err as Error)?.message ?? String(err)}`);
        return;
      }
      if (applied === false) {
        setOutputNote('这个浏览器不支持切换输出设备，声音还是从系统默认设备出来。');
      }
    },
    [outputs],
  );

  // 通话计时：只在真正通话中走，挂断就停
  useEffect(() => {
    if (state !== 'listening' && state !== 'transcribing' && state !== 'thinking' && state !== 'speaking') {
      return;
    }
    const timer = window.setInterval(() => {
      setElapsed(callRef.current?.elapsedMs ?? 0);
    }, 500);
    return () => window.clearInterval(timer);
  }, [state]);

  // 新的一行出来就滚到底 —— 否则人在说话的时候，回复在视野外面。
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      void callRef.current?.close();
      callRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError('');
    setLines([]);
    setElapsed(0);
    try {
      const call = new VoiceCall({
        onState: setState,
        onAsr: (text) => push('你', text),
        onReply: (text) => push('它', text),
        onError: (message, code) => {
          // 后端已经把「为什么失败」分好类了，这里原样显示，
          // 不要改写成"出错了" —— 用户排障全靠这句话。
          setError(code ? `${message}（${code}）` : message);
        },
        onDropped: (reason) => push('系统', `没送去识别：${reason}`),
        onClosed: (reason) => {
          push('系统', `通话结束：${reason}`);
          setState('closed');
        },
        onLevel,
        onLog: (line) => console.info('[voice]', line),
      });
      callRef.current = call;
      await call.connect();
      await call.startCapture(mode);
      // 先把声音出口摆好再开始说话：playCtx 是懒创建的，
      // 等第一句回复到了再切设备，那一句就已经从默认扬声器出去了。
      if (outputId) {
        const applied = await call.setOutputDevice(outputId).catch(() => false);
        if (applied === false) {
          push('系统', '这个浏览器不支持切换输出设备，声音会从系统默认设备出来 —— 打 QQ 电话时对方听不见。');
        }
      }
      push('系统', `通话已接通，正在听：${CAPTURE_TEXT[mode]}`);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      setError(message);
      push('系统', `接通失败：${message}`);
      void callRef.current?.close();
      callRef.current = null;
      setState('idle');
    } finally {
      setBusy(false);
    }
  }, [push, mode, outputId, onLevel]);

  const hangup = useCallback(async () => {
    setBusy(true);
    try {
      await callRef.current?.close();
    } finally {
      callRef.current = null;
      levelRef.current = 0;
      if (barRef.current) barRef.current.style.transform = 'scaleX(0)';
      setBusy(false);
      setState('closed');
      setElapsed(0);
    }
  }, []);

  const inCall = state !== 'idle' && state !== 'closed';
  const blocked = useMemo(() => {
    if (!status) return [];
    const list = [...status.problems];
    if (status.micRequiresSecureContext && !window.isSecureContext) {
      list.push('当前地址不是 localhost / HTTPS，浏览器不会给麦克风权限。请用 http://127.0.0.1 打开这个页面。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      list.push('这个浏览器不支持麦克风采集（需要 Chrome / Edge / Firefox）。');
    }
    return list;
  }, [status]);

  const clock = `${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(
    Math.floor((elapsed % 60000) / 1000),
  ).padStart(2, '0')}`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="运行"
        title="语音通话"
        description="自动断句、自动听懂、用你的人设音色回话。它说话时你开口就会被打断。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void refreshStatus()} disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      {statusError || blocked.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[12.5px] leading-5 text-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            {statusError ? <p>拿不到通话状态：{statusError}</p> : null}
            {blocked.map((item) => (
              <p key={item}>{item}</p>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-[12.5px] leading-5 text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] xl:items-start">
        {/* ── 通话台 ──────────────────────────────────────────────── */}
        <SectionCard title="通话台" icon={PhoneCall} contentClassName="p-0">
          <div className="flex flex-col items-center gap-7 px-5 py-10">
            <div className="flex flex-col items-center gap-2.5">
              <div className="flex items-baseline gap-2.5">
                <span className={`h-2 w-2 rounded-full ${STATE_DOT[state]}`} aria-hidden="true" />
                <span className="text-[17px] font-medium tracking-[-0.01em] text-foreground">
                  {STATE_TEXT[state]}
                </span>
                {inCall ? (
                  <span className="text-[13px] tabular-nums text-muted">{clock}</span>
                ) : null}
              </div>
              <p className="max-w-sm text-center text-[12.5px] leading-5 text-muted">
                {STATE_HINT[state]}
              </p>
            </div>

            {/* 电平：一条 192px 的细线。它是「麦克风到底有没有在收音」的唯一证据，
                没有它，用户分不清"没开麦"和"没识别"。没有边框、没有背景框，
                因为它不需要被看见，只需要被读到。 */}
            <div className="relative h-[3px] w-48 overflow-hidden rounded-full bg-surface-muted">
              <div
                ref={barRef}
                className="h-full w-full origin-left rounded-full bg-success"
                style={{ transform: 'scaleX(0)' }}
              />
            </div>

            {!inCall ? (
              <Button size="lg" onClick={() => void start()} disabled={busy || blocked.length > 0}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneCall className="h-4 w-4" />}
                开始通话
              </Button>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2.5">
                <Button
                  variant="secondary"
                  onClick={() => callRef.current?.commit()}
                  title="把还没说完的这段立刻送去识别"
                >
                  <Zap className="h-4 w-4" />
                  说完了
                </Button>
                <Button
                  variant="outline"
                  onClick={() => callRef.current?.interrupt()}
                  title="让它闭嘴（打断播放）"
                >
                  <MicOff className="h-4 w-4" />
                  打断
                </Button>
                <Button variant="danger" onClick={() => void hangup()} disabled={busy}>
                  <PhoneOff className="h-4 w-4" />
                  挂断
                </Button>
              </div>
            )}

            <p className="max-w-sm text-center text-[11.5px] leading-5 text-muted/80">
              说完了不用按按钮 —— 你停{' '}
              {Math.round((status?.vad.silenceMs ?? 700) / 100) / 10} 秒它就接话。
            </p>
          </div>
        </SectionCard>

        {/* ── 通话记录 ────────────────────────────────────────────── */}
        <SectionCard
          title="通话记录"
          icon={Volume2}
          contentClassName="p-0"
          description="只在这一页，不写进 QQ 记录"
        >
          <div ref={listRef} className="max-h-[520px] min-h-[180px] overflow-y-auto px-5 py-4">
            {lines.length === 0 ? (
              <p className="py-8 text-center text-[12.5px] text-muted">还没有内容。</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {lines.map((line) => (
                  <li key={`${line.at}-${line.text}`} className="flex flex-col gap-1">
                    <span
                      className={`text-[11px] font-medium ${
                        line.who === '你' ? 'text-muted' : line.who === '它' ? 'text-primary' : 'text-muted/70'
                      }`}
                    >
                      {line.who}
                    </span>
                    <span
                      className={`text-[13px] leading-6 ${
                        line.who === '系统' ? 'text-muted' : 'text-foreground'
                      }`}
                    >
                      {line.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>

        {/* ── 通话设置 ────────────────────────────────────────────── */}
        <div className="xl:col-span-2">
          <SectionCard
            title="通话设置"
            icon={Speaker}
            description={
              status
                ? `识别 ${status.asrModel || '未配置'} · 回复 ${status.ttsFormat} · 上限 ${Math.round(
                    status.limits.maxCallMs / 60000,
                  )} 分钟 / ${status.limits.maxTurns} 轮`
                : '正在读取状态…'
            }
            contentClassName="px-5 py-5"
          >
            <div className="grid gap-5 md:grid-cols-2">
              {/* 听谁 */}
              <div className="flex flex-col gap-2">
                <span className="text-[12px] font-medium text-foreground">从哪里听</span>
                <div className="flex gap-2">
                  {(['mic', 'loopback'] as CaptureMode[]).map((item) => (
                    <Button
                      key={item}
                      size="sm"
                      variant={mode === item ? 'primary' : 'outline'}
                      onClick={() => setMode(item)}
                      disabled={inCall}
                      className="flex-1"
                    >
                      {item === 'mic' ? <Mic className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                      {CAPTURE_TEXT[item]}
                    </Button>
                  ))}
                </div>
                <p className="text-[11.5px] leading-5 text-muted">{CAPTURE_HINT[mode]}</p>
              </div>

              {/* 送去哪 */}
              <div className="flex flex-col gap-2">
                <span className="text-[12px] font-medium text-foreground">声音送到哪</span>
                <Select
                  value={outputId || OUTPUT_SENTINEL}
                  onValueChange={(value) => void chooseOutput(value === OUTPUT_SENTINEL ? '' : value)}
                  disabled={inCall}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={DEFAULT_OUTPUT_TEXT} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={OUTPUT_SENTINEL}>{DEFAULT_OUTPUT_TEXT}</SelectItem>
                    {outputs.map((item) => (
                      <SelectItem key={item.deviceId} value={item.deviceId}>
                        {item.label || '（没有名字的设备）'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11.5px] leading-5 text-muted">
                  {outputNote
                    ? outputNote
                    : outputId
                      ? '打 QQ 电话时选虚拟声卡，并在 QQ 里把麦克风也选成它。'
                      : '现在只能从你自己的扬声器出来。打 QQ 电话前先选虚拟声卡（如 CABLE Input）。'}
                </p>
              </div>
            </div>

            {mode === 'loopback' && inCall ? (
              <p className="mt-4 border-t border-border pt-4 text-[11.5px] leading-5 text-warning">
                正在抓系统混音。如果你自己也开着扬声器，它会把两边都听进去 ——
                打 QQ 电话时建议戴耳机，或者把 QQ 的声音只送到虚拟声卡。
              </p>
            ) : null}
          </SectionCard>
        </div>
      </div>

      <details className="group rounded-xl border border-border bg-surface px-5 py-3.5">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[12px] font-medium text-muted">
          为什么只能在控制台里打，不能在 QQ 里打
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-[12px] leading-6 text-muted">
          <p>
            QQ 的语音/视频通话走的是闭源的 AVSDK/NTRTC，协议端（NapCat、Lagrange.Core）都没有对应接口，
            官方机器人 API 的语音能力只对 QQ 频道的语音子频道开放、而且只能播不能收。
            所以「在 QQ 里接电话」在协议层做不到，不是没写。
          </p>
          <p>
            这一页把整条链路（麦克风 → 16k PCM → 断句 → 识别 → 人设回复 → 语音合成 → 播放）
            都放在本机，不经过 QQ 服务器，也就不受它的限制。
          </p>
        </div>
      </details>
    </div>
  );
}
