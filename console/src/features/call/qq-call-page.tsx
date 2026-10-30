import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Cable,
  Ear,
  Hand,
  Loader2,
  RefreshCw,
  ScanSearch,
} from 'lucide-react';
import type { CallConfig } from '@/types';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { ToggleRow } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  answerCall,
  fetchCallDevices,
  fetchCallStatus,
  probeCallWindows,
  type CallDevices,
  type CallProbeResult,
  type CallStatus,
} from '@/lib/voice-client';

// QQ 通话页：让它在**真的 QQ 客户端**里替你接电话。
//
// 为什么这件事只能这么做：
// QQ 的通话走闭源 AVSDK/NTRTC，协议端（NapCat / Lagrange.Core）根本没有
// 通话接口 —— 不是没实现，是协议层不给你。所以唯一的入口是操作系统：
//   手  = UIA 无障碍接口点「接听」按钮（系统级，封不掉）
//   耳朵 = Electron 的 loopback 采集把 QQ 正在放的声音录下来
//   嘴  = 把 TTS 播进虚拟声卡（VB-Cable），QQ 的麦克风选它
//
// ⚠️ 这三步里「接电话」是唯一不可回退的动作 —— 一旦接起来对方就在等了，
// 没有"撤销"。所以默认全关。
//
// ── 这一版的界面为什么这么排 ──────────────────────────────────────────
// 上一版是六张卡平铺：三块拼图 + 手 + 耳朵 + 嘴 + 说明，外加九个开关。
// 问题很具体：**没有任何一处回答"我现在到底能不能接"**。用户得自己把
// 三张卡里的三个 Badge 在脑子里做一次与运算，而接电话恰恰是最不该猜的动作。
//
// 这一版先给结论再给操作：
//   ① 一句话结论（能接 / 不能接）+ 缺什么      ← 唯一的判断入口
//   ② 三个条件并排，各自一句话                  ← 结论的依据
//   ③ 设置（可以提前配好）和 操作（现在就做）分开 ← 配置别长得像按钮
//
// 颜色也收窄到三档：绿 = 通、黄 = 缺、红 = 出错。上一版每个状态一个色，
// 那是把"有状态"当成了"要有颜色"。

const CABLE_TEXT: Record<string, string> = {
  present: '装好了',
  partial: '只装了一半',
  absent: '没装',
};

const CABLE_HINT: Record<string, string> = {
  present: '录音端和播放端都在。在 QQ 里把麦克风选成 CABLE Output 就能听见它。',
  partial: '少一个端点，声音会走错路。建议重装一次 VB-Cable。',
  absent: '对方听不到它说话。装 VB-Cable 之后这一格的提示会变。',
};

export function QqCallPage() {
  const settings = useSettingsConfig();
  const [status, setStatus] = useState<CallStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [devices, setDevices] = useState<CallDevices | null>(null);
  const [probe, setProbe] = useState<CallProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [answering, setAnswering] = useState('');
  const [answerNote, setAnswerNote] = useState('');
  const [draft, setDraft] = useState<CallConfig | null>(null);

  const refresh = useCallback(async () => {
    setStatusError('');
    const [nextStatus, nextDevices] = await Promise.all([
      fetchCallStatus().catch((err: Error) => {
        setStatusError(err?.message ?? String(err));
        return null;
      }),
      fetchCallDevices().catch(() => null),
    ]);
    if (nextStatus) setStatus(nextStatus);
    if (nextDevices) setDevices(nextDevices);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 配置草稿只在首次读到配置时初始化一次 —— 之后用户改什么就是什么，
  // 不能被后台刷新覆盖（否则刚点开的开关会自己弹回去）。
  useEffect(() => {
    if (!settings.config?.call || draft) return;
    setDraft({ ...settings.config.call });
  }, [settings.config, draft]);

  const save = useCallback(
    async (patch: Partial<CallConfig>) => {
      if (!draft) return;
      const next = { ...draft, ...patch };
      setDraft(next);
      const saved = await settings.save({ call: next });
      // 开关类配置后端是实时读的（看门狗 isEnabled 每次都读配置），
      // 但状态接口里的 problems 是按当前配置算的，所以保存完要立刻重读一遍，
      // 否则面板会停在「保存前」的那句话上。
      if (saved) await refresh();
    },
    [draft, refresh, settings],
  );

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError('');
    try {
      setProbe(await probeCallWindows({ includeAll: false }));
    } catch (err) {
      setProbe(null);
      setProbeError((err as Error)?.message ?? String(err));
    } finally {
      setProbing(false);
    }
  }, []);

  const answer = useCallback(
    async (pid: number, buttonName: string) => {
      setAnswering(`${pid}:${buttonName}`);
      setAnswerNote('');
      try {
        const result = await answerCall(pid, buttonName);
        setAnswerNote(result.message || (result.ok ? '点下去了。' : '没点成，原因见上面的探测结果。'));
        await refresh();
      } catch (err) {
        setAnswerNote((err as Error)?.message ?? String(err));
      } finally {
        setAnswering('');
      }
    },
    [refresh],
  );

  const problems = status?.problems ?? [];
  const cable = devices?.virtualCable ?? status?.mouth.cable ?? null;

  // 三块拼图。以前它们分散在三张卡里，各自的 Badge 要用户自己做与运算；
  // 现在合并成一行结论 + 一行依据。
  const parts = useMemo(
    () => [
      {
        key: 'hand',
        icon: Hand,
        name: '手',
        sub: '自动点「接听」',
        ok: Boolean(status?.enabled && status?.autoAnswer),
        text: status?.autoAnswer
          ? '会替你点接听'
          : status?.enabled
            ? '扫到了只记账，不点'
            : '功能关着，不会扫窗口',
      },
      {
        key: 'ear',
        icon: Ear,
        name: '耳朵',
        sub: '听系统声音',
        ok: Boolean(status?.loopback.available),
        text: status?.loopback.available ? '能录到 QQ 放出来的声音' : status?.loopback.reason || '录不到系统声音',
      },
      {
        key: 'mouth',
        icon: Cable,
        name: '嘴',
        sub: '送进虚拟声卡',
        ok: Boolean(cable?.present),
        text: CABLE_HINT[cable?.state ?? 'absent'] ?? CABLE_HINT.absent,
      },
    ],
    [status, cable],
  );

  const missing = useMemo(() => parts.filter((part) => !part.ok), [parts]);
  // 只有"手"真的就绪时才叫「能接」—— 耳朵没开也能接，只是听不见；
  // 但手没开就没人点接听，这是唯一的硬条件。
  const canAnswer = Boolean(status?.enabled && status?.autoAnswer);

  if (settings.phase === 'loading' && !draft) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="运行"
        title="QQ 通话"
        description="在真的 QQ 客户端里替你接电话。接电话没有撤销，所以默认全关。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={probing}>
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        }
      />

      {statusError ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-[12.5px] leading-5 text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">拿不到通话状态：{statusError}</span>
        </div>
      ) : null}

      {/* ── ① 一句话结论 ────────────────────────────────────────── */}
      <div
        className={`flex flex-col gap-2 rounded-xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${
          canAnswer ? 'border-success/25 bg-success-soft' : 'border-border bg-surface'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${canAnswer ? 'bg-success' : 'bg-muted/40'}`}
            aria-hidden="true"
          />
          <span className="text-[15px] font-medium text-foreground">
            {status ? (canAnswer ? '会替你接电话' : '不会接电话') : '正在读状态…'}
          </span>
          <span className="min-w-0 truncate text-[12.5px] text-muted">
            {status
              ? canAnswer
                ? missing.length
                  ? `（还差：${missing.map((item) => item.name).join('、')}）`
                  : ''
                : draft?.enabled
                  ? '「真的点接听」还关着'
                  : 'QQ 通话功能还关着'
              : ''}
          </span>
        </div>
        {status ? (
          <span className="shrink-0 text-[11.5px] text-muted">
            每 {Math.round(status.watch.intervalMs / 100) / 10} 秒扫一次 · 只看标题含「
            {status.watch.windowPattern}」的窗口
          </span>
        ) : null}
      </div>

      {/* ── ② 三个条件 ──────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-3">
        {parts.map((part) => {
          const Icon = part.icon;
          return (
            <div key={part.key} className="rounded-xl border border-border bg-surface px-4 py-3.5">
              <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                <span className="text-[12.5px] font-medium text-foreground">{part.name}</span>
                <span className="text-[11.5px] text-muted">{part.sub}</span>
                <span
                  className={`ml-auto h-1.5 w-1.5 rounded-full ${part.ok ? 'bg-success' : 'bg-warning'}`}
                  aria-hidden="true"
                />
              </div>
              <p className="mt-1.5 text-[11.5px] leading-5 text-muted">{part.text}</p>
            </div>
          );
        })}
      </div>

      {problems.length ? (
        <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[12.5px] leading-5 text-warning">
          <p className="font-medium">后端还报了几条问题：</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {problems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
        {/* ── ③ 设置：可以提前配好 ─────────────────────────────── */}
        <SectionCard title="设置" icon={Hand} contentClassName="px-5 py-2" description="改完立刻存，下次开机还在">
          <div className="flex flex-col divide-y divide-border">
            <ToggleRow
              id="call-enabled"
              title="打开 QQ 通话功能"
              description="总闸。关着的时候接口照常可查，但不会扫窗口。"
              checked={draft?.enabled === true}
              onCheckedChange={(next) => void save({ enabled: next })}
              disabled={!draft}
            />
            <ToggleRow
              id="call-auto-answer"
              title="真的点「接听」"
              description="关着 = 只看不接，扫到来电只发事件。这是唯一不可回退的动作。"
              checked={draft?.autoAnswer === true}
              onCheckedChange={(next) => void save({ autoAnswer: next })}
              disabled={!draft || draft.enabled !== true}
            />
            <ToggleRow
              id="call-prefer-video"
              title="优先接视频"
              description="默认不接：视频会开摄像头，而且这条链路还没验证通过。"
              checked={draft?.preferVideo === true}
              onCheckedChange={(next) => void save({ preferVideo: next })}
              disabled={!draft || draft.enabled !== true}
            />
            <ToggleRow
              id="call-loopback"
              title="采集系统声音"
              description="要在 QQ Agent 桌面版里打开，普通浏览器拿不到系统混音。"
              checked={draft?.loopbackEnabled !== false}
              onCheckedChange={(next) => void save({ loopbackEnabled: next })}
              disabled={!draft}
            />
          </div>
          {status ? (
            <p className="border-t border-border py-3 text-[11.5px] leading-5 text-muted">
              断句：静音 {status.vad.silenceMs}ms 接话 · 预录 {status.vad.preRollMs}ms（不留会丢第一个字）·
              尾巴 {status.vad.keepTailMs}ms
            </p>
          ) : null}
        </SectionCard>

        {/* ── ④ 操作：现在就能做 ───────────────────────────────── */}
        <SectionCard
          title="扫描"
          icon={ScanSearch}
          contentClassName="px-5 py-4"
          description="干跑只读，不点任何按钮"
          actions={
            <Button variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing}>
              {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
              扫一次
            </Button>
          }
        >
          {probeError ? <p className="text-[12px] leading-5 text-danger">探测失败：{probeError}</p> : null}

          {!probe && !probeError ? (
            <p className="py-2 text-[12px] leading-5 text-muted">
              有来电时点「扫一次」，可以看到 QQ 弹出的通话窗口里「接听」按钮到底叫什么。
              QQ 改版之后先来这里确认，再决定要不要开自动接听。
            </p>
          ) : null}

          {probe ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-[12.5px] font-medium text-foreground">
                  {probe.decision.action === 'answer' ? '可以接' : '不接'}
                </span>
                <span className="min-w-0 break-words text-[11.5px] text-muted">{probe.decision.reason}</span>
              </div>
              {probe.errors.length ? (
                <p className="text-[11.5px] leading-5 text-danger">{probe.errors.join('；')}</p>
              ) : null}
              {probe.windows.length === 0 ? (
                <p className="text-[11.5px] leading-5 text-muted">
                  没扫到含「通话」的窗口。平时这里就是空的，有来电再看。
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {probe.windows.map((win) => (
                    <li key={win.pid} className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2.5">
                      <p className="text-[12px] text-foreground">
                        {win.title || '（无标题）'}
                        <span className="ml-1.5 text-[11px] text-muted">pid {win.pid}</span>
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {win.buttons.length === 0 ? (
                          <span className="text-[11.5px] text-muted">没有按钮</span>
                        ) : (
                          win.buttons.map((btn) => (
                            <Button
                              key={`${win.pid}-${btn.name}`}
                              variant="outline"
                              size="sm"
                              disabled={answering !== ''}
                              onClick={() => void answer(win.pid, btn.name)}
                            >
                              {answering === `${win.pid}:${btn.name}` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : null}
                              {btn.name}
                            </Button>
                          ))
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {answerNote ? <p className="text-[11.5px] leading-5 text-muted">{answerNote}</p> : null}
            </div>
          ) : null}

          {status?.watcher ? (
            <p className="mt-3 border-t border-border pt-3 text-[11.5px] leading-5 text-muted">
              看门狗：{status.watcher.running ? '在跑' : '没跑'} ·{status.watcher.canClick ? '会点接听' : '不会点'} · 已接{' '}
              {String(status.watcher.answered ?? 0)} 次 · 出错 {String(status.watcher.errors ?? 0)} 次
              {status.watcher.lastAction ? ` · 最近：${String(status.watcher.lastAction)}` : ''}
            </p>
          ) : null}
          {status?.watcher?.lastReason ? (
            <p className="text-[11.5px] leading-5 text-muted">最近一次判断：{String(status.watcher.lastReason)}</p>
          ) : null}
          {Array.isArray(status?.watcher?.lastSkipped) && (status?.watcher?.lastSkipped?.length ?? 0) > 0 ? (
            <p className="text-[11.5px] leading-5 text-warning">
              看到 {status?.watcher?.lastSkipped?.length} 个名字带「接听」的按钮但没点（不像通话动作）：
              {(status?.watcher?.lastSkipped ?? []).map((b) => `「${String(b?.name ?? '')}」`).join('、')}
            </p>
          ) : null}

          {devices?.all?.length ? (
            <details className="group mt-3 border-t border-border pt-3">
              <summary className="flex cursor-pointer list-none items-center justify-between text-[11.5px] text-muted">
                系统音频端点（{devices.all.length} 个）
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              </summary>
              <ul className="mt-2 flex flex-col gap-0.5">
                {devices.all.map((dev) => (
                  <li key={`${dev.kind}-${dev.name}`} className="text-[11.5px] leading-5 text-muted">
                    <span className="text-foreground">{dev.name}</span>
                    <span className="ml-1.5 opacity-70">{dev.kind}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <p className="mt-3 border-t border-border pt-3 text-[11.5px] leading-5 text-muted">
            把声音播到哪个设备在
            <a className="mx-1 text-primary underline-offset-2 hover:underline" href="#/voice">
              语音通话
            </a>
            页设置 —— 浏览器只认自己那套设备 id，不认 Windows 的端点 id。
            {cable?.present ? ` 现在是「${CABLE_TEXT[cable.state] ?? ''}」：${cable.renderName || 'CABLE Input'}。` : ''}
          </p>
        </SectionCard>
      </div>

      <details className="group rounded-xl border border-border bg-surface px-5 py-3.5">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[12px] font-medium text-muted">
          为什么不能走协议端，只能从操作系统下手
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-[12px] leading-6 text-muted">
          <p>
            QQ 的语音/视频通话走闭源 AVSDK → NTRTC，NapCat 的 action 列表里没有任何通话接口，
            Lagrange.Core 的功能表把「语音通话」标成不支持，官方机器人 API 的语音能力只对
            QQ 频道的语音子频道开放、而且只能播不能收。
          </p>
          <p>
            所以这里的做法是在操作系统层面替 QQ 装一副手和耳朵和嘴：UIA 点按钮、环回录声音、
            虚拟声卡送声音。不需要破解协议，也就不会被版本更新打死 —— 代价是必须跑在有图形界面的
            Windows 上，而且 QQ 的界面结构一改，接听正则就要跟着改。
          </p>
        </div>
      </details>

      {settings.phase === 'error' ? (
        <div className="rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="配置加载失败"
            description={settings.error || '请稍后重试。'}
            action={
              <Button variant="secondary" size="sm" onClick={() => void settings.load()}>
                重新加载
              </Button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
