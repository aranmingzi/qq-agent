import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Info,
  MessageSquareWarning,
  Plug,
  Power,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Wallet,
} from 'lucide-react';
import type {
  GateDecision,
  MentionWaitItem,
  PendingSendBundle,
  RestartState,
  RiskAudit,
  RiskItem,
  RiskLevel,
  SkipBundle,
  SkipRecord,
} from '@/lib/api';
import { api } from '@/lib/api';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// ── 小工具 ───────────────────────────────────────────────────────────────────

function timeAgo(ts: number) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return `${Math.round(-diff / 60_000)} 分钟后`;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

function duration(ms: number) {
  if (!ms || ms < 0) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时${min % 60 ? ` ${min % 60} 分钟` : ''}`;
}

const RISK_META: Record<RiskLevel, { label: string; badge: 'success' | 'primary' | 'warning' | 'danger'; icon: typeof Info }> = {
  ok: { label: '正常', badge: 'success', icon: CheckCircle2 },
  info: { label: '提示', badge: 'primary', icon: Info },
  warn: { label: '需要注意', badge: 'warning', icon: AlertTriangle },
  critical: { label: '有风险', badge: 'danger', icon: ShieldAlert },
};

// critical 排最前，ok 排最后 —— 打开这一页的目的是先看坏消息
const LEVEL_ORDER: Record<RiskLevel, number> = { critical: 0, warn: 1, info: 2, ok: 3 };

// 闸门 reason → 人话。漏项就原样显示英文，不做猜测性翻译。
const REASON_TEXT: Record<string, string> = {
  private: '私聊消息',
  at: '被 @ 了',
  'at-all': '有人 @ 全体',
  named: '被点名',
  'reply-self': '回复了她',
  keyword: '命中关键词',
  poke: '被拍了一下',
  continuation: '接着刚才那个人的话',
  probability: '概率命中',
  score: '打分通过',
  skipped: '判据判为不接',
  'dry-run': '演练模式（本来会跳过）',
  'waiting-mention': '说了等被叫',
  'poke-quiet': '拍回去了，这次不接话',
  'gate-off': '闸门是关的，全部放行',
  'to-others': '群友之间在说话，没接',
};

function JudgeRow({ item }: { item: GateDecision }) {
  const meta = item.wake ? { label: '唤醒', variant: 'success' as const } : { label: '不唤醒', variant: 'neutral' as const };
  const tone = item.wouldSkip && item.wake ? 'warning' as const : meta.variant;
  const signals = item.signals;
  const chips: string[] = [];
  if (signals) {
    if (signals.question) chips.push('问句');
    if (signals.multiParty) chips.push('多人在聊');
    if (signals.recentSelf) chips.push('活跃期');
    if (signals.longSilence) chips.push('冷场');
    if (signals.count) chips.push(`${signals.count} 条`);
  }
  // 寻址（v4：她在旁听，还是被叫到了）—— 这是"她为什么没接这句"最常见的原因
  if (item.toOther) chips.push('对别人说');
  else if (item.sideTalk) chips.push('两人在对谈');

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone}>{item.wouldSkip && item.wake ? '本来会跳过' : meta.label}</Badge>
        <span className="text-[12.5px] font-medium text-foreground">
          {REASON_TEXT[item.reason] ?? item.reason ?? '未知'}
        </span>
        {item.reason === 'waiting-mention' && item.waitRemainingMs > 0 ? (
          <span className="text-[11px] text-muted">还剩 {duration(item.waitRemainingMs)}</span>
        ) : null}
        {item.tier ? (
          <Badge variant="outline" className="px-1.5 py-0">
            档位 {item.tier}
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">{timeAgo(item.at)}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted">
        <code className="rounded bg-surface-muted px-1 py-0.5 text-[10.5px]">{item.chatKey}</code>
        {item.probability !== null ? <span>p={item.probability.toFixed(3)}</span> : null}
        {item.score !== null ? <span>分={item.score.toFixed(2)}</span> : null}
        {chips.length ? <span>· {chips.join(' · ')}</span> : null}
        {item.continuation ? <span>· 接话轮</span> : null}
      </div>
    </li>
  );
}

function SkipRow({ item }: { item: SkipRecord }) {
  const detail = Object.entries(item.detail ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 6)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={item.spent ? 'warning' : 'success'} className="px-1.5 py-0">
          {item.label}
        </Badge>
        {!item.spent ? (
          <span className="flex items-center gap-0.5 text-[10.5px] text-success">
            <Wallet className="h-3 w-3" />
            没花模型钱
          </span>
        ) : null}
        <code className="rounded bg-surface-muted px-1 py-0.5 text-[10.5px] text-muted">
          {item.chatKey || '—'}
        </code>
        <span className="ml-auto shrink-0 text-[10.5px] text-muted">{timeAgo(item.at)}</span>
      </div>
      <p className="mt-1.5 break-words text-[12px] leading-5 text-foreground/90">{item.reason}</p>
      {item.hint ? <p className="mt-0.5 text-[11px] leading-5 text-muted">{item.hint}</p> : null}
      {item.action ? (
        <p className="mt-0.5 text-[11px] leading-5 text-foreground/80">→ {item.action}</p>
      ) : null}
      {detail.length ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted">
          {detail.map((d) => (
            <span key={d}>{d}</span>
          ))}
          {item.traceId ? <span>#{item.traceId}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

export function HealthPage() {
  const { mode } = useConsoleMode();
  const [risk, setRisk] = useState<RiskAudit | null>(null);
  const [sends, setSends] = useState<PendingSendBundle | null>(null);
  const [restart, setRestart] = useState<RestartState | null>(null);
  const [decisions, setDecisions] = useState<GateDecision[]>([]);
  const [waits, setWaits] = useState<MentionWaitItem[]>([]);
  const [skips, setSkips] = useState<SkipBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [showOk, setShowOk] = useState(false);
  // 跳过记录默认只看"花了钱的"：没花钱的跳过是正常运转，占满屏幕反而看不清重点
  const [onlySpent, setOnlySpent] = useState(true);

  const load = useCallback(async () => {
    if (mode === 'demo') {
      setRisk(null);
      setSends(null);
      setRestart(null);
      setDecisions([]);
      setWaits([]);
      setSkips(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    // 六路并发：任何一路失败都不该让整页白屏，所以用 allSettled 再做局部降级
    const results = await Promise.allSettled([
      api.riskAudit(),
      api.pendingSends(),
      api.restartState(),
      api.gateDecisions(),
      api.mentionWait(),
      api.skips(80),
    ] as const);

    const [r, s, rs, g, w, sk] = results;
    const failures: string[] = [];
    if (r.status === 'fulfilled') setRisk(r.value);
    else failures.push('风控自检');
    if (s.status === 'fulfilled') setSends(s.value);
    else failures.push('发送台账');
    if (rs.status === 'fulfilled') setRestart(rs.value);
    else failures.push('重连状态');
    if (g.status === 'fulfilled') setDecisions(g.value);
    else failures.push('闸门判定');
    if (w.status === 'fulfilled') setWaits(w.value);
    else failures.push('等待被叫');
    if (sk.status === 'fulfilled') setSkips(sk.value);
    else failures.push('跳过记录');

    setError(failures.length ? `有 ${failures.length} 项读不到：${failures.join('、')}` : null);
    setLoading(false);
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolveOne = async (fp: string) => {
    setBusy(fp);
    setNotice('');
    try {
      const ok = await api.resolveSend(fp);
      setNotice(ok ? '已结清：这条不会再被拦着重发' : '没有这条记录（可能已经结清了）');
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const retry = async () => {
    setBusy('retry');
    setNotice('');
    try {
      const next = await api.retryOneBot();
      setRestart(next);
      setNotice('已放行一次重连，稍后看状态是否恢复');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '重试失败');
    } finally {
      setBusy('');
    }
  };

  const visibleRisk = (risk?.items ?? [])
    .slice()
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const problemItems = visibleRisk.filter((i) => i.level !== 'ok');
  const okItems = visibleRisk.filter((i) => i.level === 'ok');
  const shownRisk = showOk ? visibleRisk : problemItems;

  const openSends = sends?.items ?? [];

  // 跳过记录：默认只显示"花了钱却没开口"的那些（真正值得看一眼的）
  const allSkips = skips?.items ?? [];
  const shownSkips = onlySpent ? allSkips.filter((s) => s.spent) : allSkips;
  const spentSkips = allSkips.filter((s) => s.spent).length;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="运行体检"
          description="她现在的状态：会不会被风控盯上、有没有卡在半路的发送、刚才那条消息为什么回或没回。"
          actions={
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
              刷新
            </Button>
          }
        />

        {notice ? (
          <div className="mt-3 rounded-lg border border-primary/25 bg-primary-soft/50 px-3 py-2 text-[11.5px] text-primary">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div
            className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
          {/* ── 1. 风控自检 ─────────────────────────────────────────── */}
          <SectionCard
            icon={ShieldCheck}
            title="风控自检"
            description={
              loading
                ? '正在检查…'
                : (risk?.summary ?? '没有读到自检结果')
            }
            actions={
              okItems.length ? (
                <Button variant="ghost" size="sm" onClick={() => setShowOk((v) => !v)}>
                  {showOk ? '只看问题' : `展开 ${okItems.length} 项正常`}
                </Button>
              ) : null
            }
            contentClassName="p-0"
          >
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
              </div>
            ) : mode === 'demo' ? (
              <EmptyState
                icon={ShieldCheck}
                title="演示模式下不做自检"
                description="自检读的是这台机器上真实的配置与发送量，演示模式没有这些数据。"
                compact
              />
            ) : shownRisk.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="没有发现问题"
                description="所有检查项都通过了。发送频率、闸门、权限边界、预算都没踩到风险线。"
                compact
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {shownRisk.map((item: RiskItem) => {
                  const meta = RISK_META[item.level] ?? RISK_META.info;
                  const Icon = meta.icon;
                  return (
                    <li key={item.code} className="flex items-start gap-2.5 px-4 py-3">
                      <Icon
                        className={cn(
                          'mt-0.5 h-4 w-4 shrink-0',
                          item.level === 'critical'
                            ? 'text-danger'
                            : item.level === 'warn'
                              ? 'text-warning'
                              : item.level === 'ok'
                                ? 'text-success'
                                : 'text-primary',
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12.5px] font-medium text-foreground">{item.title}</span>
                          <Badge variant={meta.badge} className="px-1.5 py-0">
                            {meta.label}
                          </Badge>
                        </div>
                        {item.detail ? (
                          <p className="mt-1 text-[11.5px] leading-5 text-muted">{item.detail}</p>
                        ) : null}
                        {item.hint ? (
                          <p className="mt-0.5 text-[11.5px] leading-5 text-foreground/80">
                            → {item.hint}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          {/* ── 2. 协议端连接 ───────────────────────────────────────── */}
          <SectionCard
            icon={Plug}
            title="协议端连接"
            description="重连不是无限次的：窗口内失败太多次就会停下来等人处理，避免把账号刷进风控。"
            actions={
              <Button
                variant={restart?.exhausted ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => void retry()}
                disabled={busy === 'retry' || mode === 'demo'}
              >
                <RotateCw className={cn(busy === 'retry' && 'animate-spin')} />
                立即重连
              </Button>
            }
          >
            {loading ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : !restart ? (
              <EmptyState
                icon={Plug}
                title="读不到连接状态"
                description="这不代表没连上，只代表控制台问不到。先看 SnowLuma 页的运行日志。"
                compact
              />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={restart.exhausted ? 'danger' : restart.failures ? 'warning' : 'success'}>
                    {restart.exhausted ? '已停止自动重连' : restart.failures ? '正在重连' : '连接稳定'}
                  </Badge>
                  {restart.connectedAt ? (
                    <span className="flex items-center gap-1 text-[11.5px] text-muted">
                      <Clock className="h-3 w-3" />
                      已连 {duration(Date.now() - restart.connectedAt)}
                    </span>
                  ) : null}
                </div>

                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: '窗口内失败', value: `${restart.failures} / ${restart.max}` },
                    { label: '剩余次数', value: String(restart.remaining) },
                    { label: '上次失败', value: restart.lastFailureAt ? timeAgo(restart.lastFailureAt) : '—' },
                    {
                      label: '自动重连',
                      value: restart.exhausted ? '已停' : restart.nextRetryAt ? timeAgo(restart.nextRetryAt) : '—',
                    },
                  ].map((cell) => (
                    <div key={cell.label} className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2">
                      <dt className="text-[10.5px] text-muted">{cell.label}</dt>
                      <dd className="mt-0.5 text-[13px] font-medium text-foreground">{cell.value}</dd>
                    </div>
                  ))}
                </dl>

                {restart.exhausted ? (
                  <p className="flex items-start gap-1.5 text-[11.5px] leading-5 text-warning">
                    <Power className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    预算已用完，她不会自己再连。确认 QQ 那边正常后点「立即重连」，
                    或者重启应用（重启会清零预算）。
                  </p>
                ) : null}
              </div>
            )}
          </SectionCard>

          {/* ── 3. 发送待确认 ───────────────────────────────────────── */}
          <SectionCard
            icon={MessageSquareWarning}
            title="发送待确认"
            description={
              loading
                ? '正在读取…'
                : sends
                  ? `未结清 ${sends.open} 条${sends.resolved ? ` · 已结清 ${sends.resolved} 条` : ''}`
                  : '没有读到台账'
            }
            contentClassName="p-0"
          >
            <div className="flex items-start gap-2 border-b border-border bg-surface-muted/40 px-4 py-2.5 text-[11px] leading-5 text-muted">
              <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                这些消息<b className="font-medium text-foreground">可能已经发出去了，也可能没发出去</b>
                —— 协议端当时只能给「不确定」。所以她不会自动重发（重发就是刷屏）。
                你去群里看一眼，确认之后点结清。
              </span>
            </div>

            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-16 rounded-lg" />
              </div>
            ) : openSends.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="没有卡住的发送"
                description="所有消息都有确定结果。这里长期为空是好事。"
                compact
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {openSends.map((item) => (
                  <li key={item.fp} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="warning" className="px-1.5 py-0">
                        {item.tries > 1 ? `试过 ${item.tries} 次` : '结果不确定'}
                      </Badge>
                      <code className="rounded bg-surface-muted px-1 py-0.5 text-[10.5px] text-muted">
                        {item.chatKey}
                      </code>
                      <span className="ml-auto text-[10.5px] text-muted">{timeAgo(item.at)}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/90">
                      {item.text}
                    </p>
                    {item.error ? (
                      <p className="mt-1 break-words text-[10.5px] text-muted/80">{item.error}</p>
                    ) : null}
                    <div className="mt-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy === item.fp}
                        onClick={() => void resolveOne(item.fp)}
                      >
                        <CheckCircle2 />
                        已在群里确认
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {/* ── 4. 闸门判定 ─────────────────────────────────────────── */}
          <SectionCard
            icon={Activity}
            title="刚才为什么回 / 不回"
            description="每个会话最近一次的唤醒判定。判据是可解释的，不是玄学。"
            contentClassName="p-0"
          >
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
              </div>
            ) : mode === 'demo' ? (
              <EmptyState
                icon={Activity}
                title="演示模式下没有判定记录"
                description="判定记录来自真实运行时接收到的消息。"
                compact
              />
            ) : decisions.length === 0 ? (
              <EmptyState
                icon={Timer}
                title="还没有判定记录"
                description="等有消息进来跑过一轮闸门，这里就会出现「为什么回 / 为什么没回」。重启应用会清空。"
                compact
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {decisions.map((item) => (
                  <JudgeRow key={`${item.chatKey}-${item.at}`} item={item} />
                ))}
              </ul>
            )}
          </SectionCard>

          {/* ── 5. 没开口的账 ───────────────────────────────────────── */}
          <SectionCard
            icon={Wallet}
            title="刚才为什么没开口"
            description={
              loading
                ? '正在读取…'
                : (skips?.summary ?? '没有读到跳过记录')
            }
            actions={
              allSkips.length ? (
                <Button variant="ghost" size="sm" onClick={() => setOnlySpent((v) => !v)}>
                  {onlySpent ? `看全部 ${allSkips.length} 条` : '只看花了钱的'}
                </Button>
              ) : null
            }
            contentClassName="p-0"
          >
            <div className="flex items-start gap-2 border-b border-border bg-surface-muted/40 px-4 py-2.5 text-[11px] leading-5 text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                她大部分时间都在<b className="font-medium text-foreground">决定不说话</b>
                ，这本身是正常的。这里区分两件事：
                <b className="font-medium text-foreground">没花模型钱</b>的（额度满、退避中、判据不接）
                是省钱，不用管；
                <b className="font-medium text-foreground">花了钱却没开口</b>的（判据出错、出口拦截、整轮报错）
                才值得看一眼。
              </span>
            </div>

            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
              </div>
            ) : mode === 'demo' ? (
              <EmptyState
                icon={Wallet}
                title="演示模式下没有跳过记录"
                description="跳过记录来自真实运行时每一轮的决定。"
                compact
              />
            ) : allSkips.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="没有「没开口」的记录"
                description="要么这段时间每条都回了，要么还没跑到过一轮。重启应用会清空内存里的记录。"
                compact
              />
            ) : shownSkips.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="没有花了钱却没开口的"
                description={`这 ${allSkips.length} 次没开口全都没花模型钱 —— 那是省下的，不是故障。`}
                compact
              />
            ) : (
              <>
                {skips && skips.rows.length ? (
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2">
                    {skips.rows.slice(0, 8).map((row) => (
                      <Badge
                        key={row.stage}
                        variant={row.spent ? 'warning' : 'neutral'}
                        className="px-1.5 py-0"
                        title={row.hint}
                      >
                        {row.label} {row.count}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <ul className="divide-y divide-border/60">
                  {shownSkips.map((item) => (
                    <SkipRow key={`${item.traceId}-${item.at}-${item.stage}`} item={item} />
                  ))}
                </ul>
                {onlySpent && spentSkips < allSkips.length ? (
                  <p className="border-t border-border/60 px-4 py-2 text-[10.5px] text-muted">
                    另有 {allSkips.length - spentSkips} 次没开口没花模型钱，已折叠。
                  </p>
                ) : null}
              </>
            )}
          </SectionCard>

          {/* ── 6. 等待被叫 ─────────────────────────────────────────── */}
          {waits.length ? (
            <SectionCard
              icon={Timer}
              title="正在等被叫"
              description="她主动安静下来的会话。被 @ 或点名会立刻解除，不会一直不吭声。"
              contentClassName="p-0"
            >
              <ul className="divide-y divide-border/60">
                {waits.map((item) => (
                  <li key={item.chatKey} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <code className="rounded bg-surface-muted px-1 py-0.5 text-[10.5px] text-muted">
                      {item.chatKey}
                    </code>
                    <span className="text-[12px] text-foreground">
                      还剩 {duration(item.remainingMs)}
                    </span>
                    {item.note ? (
                      <span className="text-[11.5px] text-muted">· {item.note}</span>
                    ) : null}
                    <span className="ml-auto text-[10.5px] text-muted">{timeAgo(item.at)} 开始</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>

        <p className="mt-4 px-1 text-[10.5px] leading-5 text-muted/80">
          自检只读、不改配置；台账在{' '}
          <code className="rounded bg-surface-muted px-1">data/send-pending.jsonl</code>，
          等被叫状态在 <code className="rounded bg-surface-muted px-1">data/mention-wait.json</code>。
        </p>
      </div>
    </div>
  );
}
