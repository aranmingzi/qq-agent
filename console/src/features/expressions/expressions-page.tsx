import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  BookMarked,
  Check,
  MessageCircleHeart,
  Plus,
  Quote,
  RefreshCw,
  Sparkles,
  ThumbsDown,
  TrendingDown,
} from 'lucide-react';
import type { ExpressionEntry } from '@/lib/api';
import { api } from '@/lib/api';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

function timeAgo(ts: number) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export function ExpressionsPage() {
  const { mode } = useConsoleMode();
  const [pending, setPending] = useState<ExpressionEntry[]>([]);
  const [library, setLibrary] = useState<ExpressionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    if (mode === 'demo') {
      setPending([]);
      setLibrary([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const data = await api.expressions();
      setPending(data.pending);
      setLibrary(data.library);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读不到表达库');
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, kind: 'promote' | 'reject') => {
    setBusy(id);
    setNotice('');
    try {
      const r = kind === 'promote' ? await api.promoteExpression(id) : await api.rejectExpression(id);
      setNotice(r.ok ? (kind === 'promote' ? '已转正：以后会被当作语感参考' : '已丢掉') : r.reason);
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const submitDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy('add');
    setNotice('');
    try {
      const r = await api.addExpression(text);
      setNotice(r.ok ? `已加入正式库：${text}` : r.reason);
      if (r.ok) setDraft('');
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '添加失败');
    } finally {
      setBusy('');
    }
  };

  const faded = library.filter((x) => x.weight <= 1.5).length;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="表达库"
          description="她从群里学「怎么说」。学到的先进候选，你点头之后才会被当成语感参考 —— 参考，不是指令。"
          actions={
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
              刷新
            </Button>
          }
        />

        {/* 这条横幅和群梗库同理：候选与已生效必须一眼分得清 */}
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[11.5px] leading-5 text-muted">
          <BookMarked className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            候选期间这些口头禅<b className="font-medium text-foreground">不会出现在她的提示词里</b>。
            转正后也只作为「群里最近这么说话」的参考，不会硬塞进回复。
          </span>
        </div>

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
          <SectionCard
            icon={Sparkles}
            title="待确认"
            description={
              loading ? '正在读取…' : `${pending.length} 条候选（按"还新鲜"排序）`
            }
            contentClassName="p-0"
          >
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-14 rounded-lg" />
                <Skeleton className="h-14 rounded-lg" />
              </div>
            ) : mode === 'demo' ? (
              <EmptyState
                icon={Sparkles}
                title="演示模式下不读真实候选"
                description="候选来自这台机器真实的群聊记录，演示模式不会去碰它。"
                compact
              />
            ) : pending.length === 0 ? (
              <EmptyState
                icon={MessageCircleHeart}
                title="没有待确认的表达"
                description="群里同一句话反复出现两次以上，她才会提一个候选上来。长期为空很正常。"
                compact
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {pending.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <span className="text-[13.5px] font-medium text-foreground">{item.text}</span>
                    <Badge variant="neutral" className="px-1.5 py-0">
                      出现 {item.count} 次
                    </Badge>
                    {item.chatKeys.length ? (
                      <span className="text-[10.5px] text-muted">
                        来自 {item.chatKeys.length} 个会话
                      </span>
                    ) : null}
                    {item.lastSeen ? (
                      <span className="text-[10.5px] text-muted">{timeAgo(item.lastSeen)}</span>
                    ) : null}
                    <span className="ml-auto flex shrink-0 gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => void act(item.id, 'reject')}
                      >
                        <ThumbsDown />
                        丢掉
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => void act(item.id, 'promote')}
                      >
                        <Check />
                        转正
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            icon={Quote}
            title="正式库"
            description={
              loading
                ? '正在读取…'
                : `${library.length} 条${faded ? ` · ${faded} 条快过期了` : ''}`
            }
            contentClassName="p-0"
          >
            <div className="flex flex-col gap-2 border-b border-border bg-surface-muted/40 px-4 py-3 sm:flex-row sm:items-center">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitDraft();
                }}
                placeholder="自己加一条（2–14 字、中文、不是问句）"
                className="sm:max-w-sm"
                disabled={mode === 'demo'}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void submitDraft()}
                disabled={busy === 'add' || !draft.trim() || mode === 'demo'}
              >
                <Plus />
                加入正式库
              </Button>
              <span className="text-[10.5px] leading-5 text-muted">
                手动加的直接生效，不进候选。
              </span>
            </div>

            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-12 rounded-lg" />
              </div>
            ) : library.length === 0 ? (
              <EmptyState
                icon={Quote}
                title="正式库还是空的"
                description="她还没有学到任何被确认过的表达。可以先在上面手动加一条试试。"
                compact
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {library.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <span className="text-[13px] text-foreground">{item.text}</span>
                    <Badge variant="primary" className="px-1.5 py-0">
                      {item.source === 'manual' ? '手动' : `出现 ${item.count} 次`}
                    </Badge>
                    {item.weight <= 1.5 ? (
                      <span className="flex items-center gap-1 text-[10.5px] text-warning">
                        <TrendingDown className="h-3 w-3" />
                        快过期
                      </span>
                    ) : null}
                    {item.lastSeen ? (
                      <span className="ml-auto text-[10.5px] text-muted">
                        最后听到 {timeAgo(item.lastSeen)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <p className="mt-4 px-1 text-[10.5px] leading-5 text-muted/80">
          15 天不出现权重会衰减到 0 并自动淘汰；候选在{' '}
          <code className="rounded bg-surface-muted px-1">data/expressions-pending.json</code>，
          正式库在 <code className="rounded bg-surface-muted px-1">data/expressions.json</code>。
        </p>
      </div>
    </div>
  );
}
