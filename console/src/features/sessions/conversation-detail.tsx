import { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  ChevronRight,
  Clock3,
  Copy,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import type { DataMode, SessionDetail, SessionSummary } from '@/types';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTokens,
} from '@/lib/format';
import { sessionToText } from '@/lib/session-text';
import { cn } from '@/lib/utils';
import { useToast } from '@/providers/toast-provider';
import { StatusBadge } from '@/components/status-badge';
import { MoodBadge } from '@/components/mood-badge';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { QqMessageText } from '@/components/qq-message-text';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToolCallCard } from '@/features/sessions/tool-call-card';

interface ConversationDetailProps {
  summary: SessionSummary | null;
  detail: SessionDetail | null;
  phase: 'loading' | 'ready' | 'error';
  error: string | null;
  resetting: boolean;
  mode: DataMode;
  onBack: () => void;
  onRetry: () => void;
  onResetMood: () => Promise<boolean>;
}

function DetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[880px] animate-pulse px-5 py-6 lg:px-8">
      <div className="flex items-start gap-3">
        <Skeleton className="h-9 w-9 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
      </div>
      <div className="mt-6 flex gap-4 border-y border-border py-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-12" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </div>
      <div className="mt-6 space-y-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}

function MetaItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-[88px]">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[12.5px] font-medium tabular-nums text-foreground',
          mono && 'font-mono text-[11.5px]',
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function ConversationDetail({
  summary,
  detail,
  phase,
  error,
  resetting,
  mode,
  onBack,
  onRetry,
  onResetMood,
}: ConversationDetailProps) {
  const toast = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);

  if (!summary && !detail && phase !== 'loading') {
    return (
      <EmptyState
        icon={MessageSquare}
        title="选择一个运行会话"
        description="从左侧列表选择一条会话，查看模型思考、工具调用与已发送的消息。列表会随运行状态自动更新。"
      />
    );
  }

  if (phase === 'loading') return <DetailSkeleton />;

  if (phase === 'error' || !detail) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="会话详情加载失败"
        description={error || '该会话可能已被清理，请刷新列表后重试。'}
        action={
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RefreshCw />
            重试
          </Button>
        }
      />
    );
  }

  const isGroup = detail.chatKey.startsWith('group:');
  const duration = detail.status === 'running' ? '进行中' : formatDuration(detail.startedAt, detail.endedAt);
  const toolCount = detail.messages.filter((item) => item.kind === 'tool').length;

  const handleReset = async () => {
    setResetPending(true);
    const ok = await onResetMood();
    setResetPending(false);
    if (ok) {
      setResetOpen(false);
      toast({
        title: '情绪已重置为「平静」',
        description:
          mode === 'demo'
            ? '演示模式：只更新本地状态，未写入后端。'
            : '仅影响该聊天后续回复的语气，不会删除会话或消息。',
        variant: 'success',
      });
    } else {
      toast({
        title: '重置情绪失败',
        description: '未能写入情绪状态，请检查后端连接后重试。',
        variant: 'error',
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-detail">
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-4 sm:px-5 lg:px-8 lg:pt-6">
          {/* 顶部会话标识 */}
          <div className="flex items-start gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="lg:hidden"
              aria-label="返回会话列表"
            >
              <ArrowLeft />
            </Button>
            <span
              className={cn(
                'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                detail.status === 'error'
                  ? 'border-danger/20 bg-danger-soft text-danger'
                  : 'border-border bg-surface text-muted',
              )}
              aria-hidden="true"
            >
              {isGroup ? <Users className="h-4 w-4" /> : <User className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  className="truncate text-[18px] font-semibold leading-7 tracking-[-0.02em] text-foreground"
                  data-testid="session-title"
                >
                  {detail.chatName}
                </h2>
                <StatusBadge status={detail.status} />
                <MoodBadge mood={detail.mood} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 text-muted/80">触发</span>
                  <span className="max-w-[520px] truncate text-foreground/85">
                    {detail.triggerSummary || '—'}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="h-3 w-3" aria-hidden="true" />
                  {formatClock(detail.startedAt)}
                  {detail.endedAt ? ` – ${formatClock(detail.endedAt)}` : ' · 进行中'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="text-muted/80">模型</span>
                  <code className="rounded bg-surface-muted px-1 py-px font-mono text-[10.5px] text-foreground/85">
                    {detail.model}
                  </code>
                </span>
              </div>
            </div>
          </div>

          {/* 操作区 */}
          <div className="mt-4 flex flex-wrap items-center gap-2 lg:pl-12">
            <CopyButton
              text={() => sessionToText(detail)}
              label="复制全部会话"
              variant="secondary"
              size="sm"
              onResult={(ok) => {
                if (!ok) {
                  toast({
                    title: '复制失败',
                    description: '浏览器拒绝了剪贴板访问，请手动选择文本复制。',
                    variant: 'error',
                  });
                }
              }}
            />
            {detail.mood ? (
              <Button
                variant="danger-ghost"
                size="sm"
                onClick={() => setResetOpen(true)}
                disabled={resetting}
              >
                <RotateCcw className={cn(resetting && 'animate-spin')} />
                重置情绪
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="更多会话操作">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                {detail.systemPrompt ? (
                  <DropdownMenuItem asChild>
                    <CopyButton
                      text={detail.systemPrompt}
                      label="复制系统提示"
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full justify-start px-2.5 py-2 text-[12.5px] font-normal text-foreground"
                    />
                  </DropdownMenuItem>
                ) : null}
                {detail.userPrompt ? (
                  <DropdownMenuItem asChild>
                    <CopyButton
                      text={detail.userPrompt}
                      label="复制本次输入"
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full justify-start px-2.5 py-2 text-[12.5px] font-normal text-foreground"
                    />
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={onRetry}>
                  <RefreshCw className="h-3.5 w-3.5 text-muted" />
                  刷新详情
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="ml-auto hidden items-center gap-1 text-[10.5px] text-muted sm:flex">
              <span className="h-1 w-1 rounded-full bg-border-strong" aria-hidden="true" />
              {detail.status === 'running' ? '运行中自动刷新' : '只读记录'}
            </span>
          </div>

          {/* 摘要条 */}
          <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-y border-border py-3.5">
            <MetaItem label="耗时" value={duration} />
            <MetaItem label="模型调用" value={`${detail.usage.calls} 次`} />
            <MetaItem label="输入" value={`${formatNumber(detail.usage.promptTokens)} tok`} />
            <MetaItem
              label="输出"
              value={`${formatNumber(detail.usage.completionTokens)} tok`}
            />
            <MetaItem
              label="合计"
              value={`${formatTokens(detail.usage.totalTokens)} tok`}
            />
            <MetaItem label="工具轮数" value={`${detail.rounds} 轮`} />
          </div>

          {/* 本次输入 */}
          <section className="mt-6" aria-labelledby="session-input-heading">
            <div className="mb-2 flex items-center justify-between">
              <h3
                id="session-input-heading"
                className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground"
              >
                <MessageSquare className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                本次输入
              </h3>
              {detail.userPrompt ? (
                <CopyButton
                  text={detail.userPrompt}
                  iconOnly
                  size="icon-sm"
                  label="复制本次输入"
                  className="text-muted"
                />
              ) : null}
            </div>
            <div className="rounded-lg border border-border bg-surface px-3.5 py-3 shadow-card">
              <QqMessageText
                className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground"
                text={detail.triggerText || detail.triggerSummary || '—'}
              />
              {detail.userPrompt ? (
                <details className="group mt-2 border-t border-border/70 pt-2">
                  <summary className="focus-ring flex cursor-pointer list-none items-center gap-1 rounded text-[11px] text-muted transition-colors hover:text-foreground">
                    <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                    查看完整输入
                    <span className="text-muted/60">
                      {detail.promptChars
                        ? `${formatNumber(detail.promptChars)} 字符`
                        : `${formatNumber(detail.userPrompt.length)} 字符`}
                    </span>
                  </summary>
                  <pre className="scrollbar-thin mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3 py-2.5 font-mono text-[11px] leading-5 text-muted">
                    {detail.userPrompt}
                  </pre>
                </details>
              ) : null}
            </div>
          </section>

          {/* 系统提示 */}
          {detail.systemPrompt ? (
            <details className="group mt-4 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
              <summary className="focus-ring flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/60">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                <span className="text-[12px] font-medium text-foreground">系统提示</span>
                <span className="text-[10.5px] text-muted">
                  {formatNumber(detail.systemPrompt.length)} 字符 · 每次运行重发
                </span>
                <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted transition-transform group-open:rotate-90" />
                <span onClick={(event) => event.stopPropagation()} className="inline-flex">
                  <CopyButton
                    text={detail.systemPrompt}
                    iconOnly
                    size="icon-sm"
                    label="复制系统提示"
                    className="text-muted"
                  />
                </span>
              </summary>
              <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3.5 py-3 font-mono text-[11px] leading-5 text-muted">
                {detail.systemPrompt}
              </pre>
            </details>
          ) : null}

          {/* 运行过程 */}
          <section className="mt-7" aria-labelledby="session-process-heading">
            <div className="mb-3 flex items-center gap-2">
              <h3
                id="session-process-heading"
                className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground"
              >
                <Wrench className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                运行过程
              </h3>
              <span className="text-[10.5px] text-muted">
                {toolCount} 次工具调用 · {detail.rounds} 轮
              </span>
              {detail.status === 'running' ? (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-primary">
                  <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-primary" />
                  正在运行
                </span>
              ) : null}
            </div>

            {detail.messages.length || detail.sent.length ? (
              <div className="relative space-y-3.5 before:absolute before:bottom-2 before:left-[9px] before:top-2 before:w-px before:bg-border">
                {detail.messages.map((item, index) => {
                  if (item.kind === 'tool') {
                    return (
                      <div key={`tool-${index}`} className="relative pl-7">
                        <span className="absolute left-0 top-2 z-10 flex h-[19px] w-[19px] items-center justify-center rounded-full border border-border bg-surface text-muted">
                          <Wrench className="h-2.5 w-2.5" aria-hidden="true" />
                        </span>
                        <ToolCallCard toolCall={item.toolCall} />
                      </div>
                    );
                  }
                  if (item.kind === 'tool-images') {
                    return (
                      <div key={`images-${index}`} className="relative pl-7">
                        <span className="absolute left-0 top-2 z-10 flex h-[19px] w-[19px] items-center justify-center rounded-full border border-border bg-surface text-muted">
                          <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                        </span>
                        <div className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[12px] text-muted shadow-card">
                          <span className="font-mono text-[11px] text-foreground">
                            {item.tool}
                          </span>
                          <span className="ml-2">→ {item.count} 张图片已作为图像输入注入模型</span>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={`assistant-${index}`} className="relative pl-7">
                      <span className="absolute left-0 top-2 z-10 flex h-[19px] w-[19px] items-center justify-center rounded-full border border-border bg-surface text-muted">
                        <Brain className="h-2.5 w-2.5" aria-hidden="true" />
                      </span>
                      <div className="rounded-lg border border-border/70 bg-surface-muted/55 px-3.5 py-3">
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted">
                            模型思考 · 不发送
                          </span>
                          <CopyButton
                            text={item.content}
                            iconOnly
                            size="icon-sm"
                            label="复制思考内容"
                            className="ml-auto h-6 w-6 text-muted"
                          />
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-6 text-muted">
                          {item.content}
                        </p>
                      </div>
                    </div>
                  );
                })}

                {detail.sent.map((sent, index) => (
                  <div key={`sent-${index}`} className="relative pl-7">
                    <span className="absolute left-0 top-2 z-10 flex h-[19px] w-[19px] items-center justify-center rounded-full border border-primary/20 bg-primary-soft text-primary">
                      <Send className="h-2.5 w-2.5" aria-hidden="true" />
                    </span>
                    <div className="rounded-lg border border-primary/15 bg-primary-soft/55 px-3.5 py-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-primary/80">
                          已发送到 QQ{sent.at ? ` · ${sent.at}` : ''}
                        </span>
                        <CopyButton
                          text={sent.text}
                          iconOnly
                          size="icon-sm"
                          label="复制已发送消息"
                          className="ml-auto h-6 w-6 text-primary/70"
                        />
                      </div>
                      <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">
                        {sent.text}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : detail.status === 'running' ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border px-4 py-6 text-[12.5px] text-muted">
                <RefreshCw className="h-4 w-4 animate-spin text-primary" />
                模型正在处理本次会话，产生步骤后会自动刷新…
              </div>
            ) : (
              <EmptyState
                icon={MessageSquare}
                title="本次运行还没有产生消息"
                description="模型可能尚未开始输出，或本次运行没有可展示的步骤。"
                compact
              />
            )}

            {detail.error ? (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-3 text-[12px] leading-5 text-danger"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium">本次运行出错</p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-danger/85">
                    {detail.error}
                  </p>
                </div>
              </div>
            ) : null}

            {detail.finishReason ? (
              <div className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-[10.5px] text-muted">
                <Copy className="h-3 w-3" aria-hidden="true" />
                结束原因：<span className="text-foreground/80">{detail.finishReason}</span>
                <span className="ml-auto flex items-center gap-1">
                  <Clock3 className="h-3 w-3" aria-hidden="true" />
                  {formatDateTime(detail.endedAt || detail.startedAt)}
                </span>
              </div>
            ) : null}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="重置当前聊天的情绪？"
        description={
          <>
            将把「{detail.chatName}」的情绪重置为「平静」。只影响后续回复的语气，
            不会删除会话或消息。
            {mode === 'demo'
              ? ' 演示模式下只更新本地状态，不写入后端。'
              : ' 这是一次真实写入，会立即影响该聊天的后续运行。'}
          </>
        }
        confirmLabel="重置为平静"
        tone="danger"
        loading={resetPending || resetting}
        onConfirm={handleReset}
      />
    </div>
  );
}
