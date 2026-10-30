import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, BookMarked, Check, RefreshCw, Sparkles, ThumbsDown, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

type Candidate = Awaited<ReturnType<typeof api.memesPending>>['pending'][number];

function timeAgo(ts: number) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export function MemesPage() {
  const { mode } = useConsoleMode();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (mode === 'demo') {
      setCandidates([]);
      setRejectedCount(0);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const data = await api.memesPending();
      setCandidates(data.pending);
      setRejectedCount(data.rejectedCount);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读不到候选列表');
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (key: string, kind: 'confirm' | 'reject') => {
    setBusyKey(key);
    setNotice('');
    try {
      const fn = kind === 'confirm' ? api.confirmMeme : api.rejectMeme;
      const result = await fn(key);
      setNotice(result.reason);
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusyKey('');
    }
  };

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="群梗库"
          description="AI 在群里听到新梗时会提成「候选」，但它这时候并不算懂 —— 只有你确认过，才会进入它真正会用的梗库。"
          actions={
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
              刷新
            </Button>
          }
        />

        {/* 这条横幅是这一页存在的理由，别删：候选和已知必须一眼分得清 */}
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[11.5px] leading-5 text-muted">
          <BookMarked className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            候选期间，AI <span className="font-medium text-foreground">查不到、也用不了</span>这些梗。
            确认后它才会在聊天里自然使用；拒绝过的梗不会再被提起。
          </span>
        </div>

        {notice ? (
          <div className="mt-3 rounded-lg border border-primary/25 bg-primary-soft/50 px-3 py-2 text-[11.5px] text-primary">
            {notice}
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger" role="alert">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="mt-4">
          <SectionCard
            icon={Sparkles}
            title="待确认"
            description={
              loading
                ? '正在读取…'
                : `${candidates.length} 条候选${rejectedCount ? ` · 已拒绝过 ${rejectedCount} 个` : ''}`
            }
            contentClassName="p-0"
          >
            {loading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-20 rounded-lg" />
                <Skeleton className="h-20 rounded-lg" />
              </div>
            ) : candidates.length === 0 ? (
              <EmptyState
                icon={BookMarked}
                title={mode === 'demo' ? '演示模式下不读真实候选' : '没有待确认的梗'}
                description={
                  mode === 'demo'
                    ? '这里的候选来自真实运行时的群聊记录，演示模式不会去读它。'
                    : '它在群里遇到没见过的梗、并且说得清意思时，才会提一个上来。大多数时候这里是空的。'
                }
                compact
              />
            ) : (
              <ul className="divide-y divide-border/60">
                {candidates.map((item) => (
                  <li key={item.key} className="px-4 py-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="text-[13px] font-medium text-foreground">{item.key}</span>
                      {item.hits > 1 ? (
                        <Badge variant="neutral" className="px-1.5 py-0">
                          听到 {item.hits} 次
                        </Badge>
                      ) : null}
                      {item.tone ? (
                        <Badge variant="neutral" className="px-1.5 py-0">
                          {item.tone}
                        </Badge>
                      ) : null}
                      {item.lastSeenAt ? (
                        <span className="text-[10.5px] text-muted">{timeAgo(item.lastSeenAt)}</span>
                      ) : null}
                      <span className="ml-auto flex shrink-0 gap-1.5">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyKey === item.key}
                          onClick={() => void act(item.key, 'reject')}
                        >
                          <ThumbsDown />
                          不是梗
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busyKey === item.key}
                          onClick={() => void act(item.key, 'confirm')}
                        >
                          <Check />
                          收录
                        </Button>
                      </span>
                    </div>

                    <p className="mt-1.5 text-[12px] leading-5 text-foreground/90">{item.meaning}</p>
                    {item.usage ? (
                      <p className="mt-1 text-[11.5px] leading-5 text-muted">用法：{item.usage}</p>
                    ) : null}
                    {item.aliases.length ? (
                      <p className="mt-1 text-[11px] text-muted">
                        也叫：{item.aliases.join('、')}
                      </p>
                    ) : null}
                    <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted/80">
                      <Users className="h-3 w-3" />
                      {item.source || '群里听来的'}
                      {item.chatKey ? ` · ${item.chatKey}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <p className="mt-4 px-1 text-[10.5px] leading-5 text-muted/80">
          确认后想要改释义，可以直接编辑 <code className="rounded bg-surface-muted px-1">data/memes.json</code>；
          候选池在 <code className="rounded bg-surface-muted px-1">data/memes-pending.json</code>（含被拒名单）。
        </p>
      </div>
    </div>
  );
}
