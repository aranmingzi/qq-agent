import { useEffect, useRef } from 'react';
import {
  AlertTriangle,
  Inbox,
  RefreshCw,
  Search,
  SearchX,
  X,
} from 'lucide-react';
import type { SessionFilter, SessionSummary } from '@/types';
import { formatDateTime, formatTokens } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DataMode } from '@/types';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';

const filters: Array<{ id: SessionFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'done', label: '已发言' },
  { id: 'noreply', label: '未回复' },
  { id: 'error', label: '出错' },
  { id: 'aborted', label: '已中止' },
];

interface ConversationListProps {
  sessions: SessionSummary[];
  counts: Record<SessionFilter, number>;
  query: string;
  onQueryChange: (value: string) => void;
  filter: SessionFilter;
  onFilterChange: (filter: SessionFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  mode: DataMode;
}

function SessionSkeleton() {
  return (
    <div className="border-b border-border/70 px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-14" />
      </div>
      <Skeleton className="mt-2.5 h-3 w-full" />
      <Skeleton className="mt-1.5 h-3 w-3/4" />
      <div className="mt-3 flex items-center gap-2">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-10" />
      </div>
    </div>
  );
}

export function ConversationList({
  sessions,
  counts,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  loading,
  error,
  refreshing,
  onRefresh,
  mode,
}: ConversationListProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>, direction: 1 | -1) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-session-item]') ?? [],
    );
    const index = buttons.indexOf(event.currentTarget);
    const next = buttons[index + direction];
    next?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              最近会话
            </h2>
            <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10.5px] tabular-nums text-muted">
              {counts.all}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            aria-label="刷新会话列表"
            title="刷新会话列表"
            disabled={refreshing}
          >
            <RefreshCw className={cn(refreshing && 'animate-spin')} />
          </Button>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
          每次运行生成一个会话，用完即弃
        </p>

        <div className="relative mt-3">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索群号、触发内容…"
            aria-label="搜索会话"
            className="h-8 pl-8 pr-16 text-[12.5px]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="清空搜索"
              className="focus-ring absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-surface-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-surface-muted px-1 font-mono text-[10px] leading-4 text-muted">
              /
            </kbd>
          )}
        </div>

        <div
          className="mt-2.5 grid grid-cols-6 gap-1"
          role="group"
          aria-label="按状态筛选"
        >
          {filters.map((item) => {
            const active = filter === item.id;
            const count = counts[item.id] ?? 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onFilterChange(item.id)}
                aria-pressed={active}
                className={cn(
                  'focus-ring flex h-6 min-w-0 items-center justify-center gap-1 rounded-md px-1 text-[10.5px] transition-colors',
                  active
                    ? 'bg-primary-soft font-medium text-primary'
                    : 'text-muted hover:bg-surface-muted hover:text-foreground',
                )}
              >
                {item.label}
                <span
                  className={cn(
                    'tabular-nums text-[9px]',
                    active ? 'text-primary/70' : 'text-muted/60',
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={listRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div aria-busy="true" aria-label="正在加载会话">
            {Array.from({ length: 6 }).map((_, index) => (
              <SessionSkeleton key={index} />
            ))}
          </div>
        ) : error ? (
          <EmptyState
            icon={AlertTriangle}
            title="会话列表加载失败"
            description={error}
            compact
            action={
              <Button variant="secondary" size="sm" onClick={onRefresh}>
                <RefreshCw />
                重试
              </Button>
            }
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={query || filter !== 'all' ? SearchX : Inbox}
            title={query || filter !== 'all' ? '没有匹配的会话' : '今天还没有运行会话'}
            description={
              query || filter !== 'all'
                ? '换一个关键词，或清除筛选条件后再试。'
                : '当机器人被消息触发后，每次运行都会在这里生成一条记录。'
            }
            compact
            action={
              query || filter !== 'all' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onQueryChange('');
                    onFilterChange('all');
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={onRefresh}>
                  <RefreshCw />
                  刷新
                </Button>
              )
            }
          />
        ) : (
          <ul aria-label="会话列表" className="divide-y divide-border/70">
            {sessions.map((session) => {
              const active = session.id === selectedId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    data-session-item
                    onClick={() => onSelect(session.id)}
                    onKeyDown={(event) => moveFocus(event, event.key === 'ArrowDown' ? 1 : -1)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'focus-ring group relative block w-full px-4 py-3.5 text-left transition-colors',
                      active
                        ? 'bg-primary-soft/55'
                        : 'hover:bg-surface-muted/70 focus-visible:bg-surface-muted/70',
                    )}
                  >
                    {active ? (
                      <span
                        className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r-full bg-primary"
                        aria-hidden="true"
                      />
                    ) : null}
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
                        {session.chatName}
                      </span>
                      <time
                        className="shrink-0 text-[10.5px] tabular-nums text-muted"
                        dateTime={new Date(session.startedAt).toISOString()}
                      >
                        {formatDateTime(session.startedAt)}
                      </time>
                    </div>
                    <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-[12.5px] leading-5 text-muted">
                      {session.triggerSummary || '（无触发内容）'}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <StatusBadge status={session.status} />
                      <span className="text-[10.5px] tabular-nums text-muted">
                        {formatTokens(session.usage.totalTokens)} tok
                      </span>
                      <span className="h-1 w-1 rounded-full bg-border-strong" aria-hidden="true" />
                      <span className="text-[10.5px] tabular-nums text-muted">
                        {session.rounds} 轮
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2 text-[10.5px] text-muted">
        <span className="tabular-nums">
          显示 {sessions.length} 条 · 最近 80 条
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              mode === 'demo' ? 'bg-warning' : 'bg-success',
            )}
            aria-hidden="true"
          />
          {mode === 'demo' ? '演示快照' : '每 4 秒刷新'}
        </span>
      </div>
    </div>
  );
}
