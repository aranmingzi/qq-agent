import { ConversationList } from '@/features/sessions/conversation-list';
import { ConversationDetail } from '@/features/sessions/conversation-detail';
import { useSessions } from '@/features/sessions/use-sessions';
import { cn } from '@/lib/utils';

export function SessionsPage() {
  const sessions = useSessions();

  return (
    <div className="flex h-full min-h-0">
      <section
        className={cn(
          'flex min-h-0 w-full flex-col border-r border-border bg-surface lg:w-[344px] lg:shrink-0',
          sessions.selectedId ? 'hidden lg:flex' : 'flex',
        )}
        aria-label="会话列表面板"
      >
        <ConversationList
          sessions={sessions.filtered}
          counts={sessions.counts}
          query={sessions.query}
          onQueryChange={sessions.setQuery}
          filter={sessions.filter}
          onFilterChange={sessions.setFilter}
          selectedId={sessions.selectedId}
          onSelect={sessions.setSelectedId}
          loading={sessions.listPhase === 'loading'}
          error={sessions.listError}
          refreshing={sessions.refreshing}
          onRefresh={() => void sessions.reload()}
          mode={sessions.mode}
        />
      </section>

      <section
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col bg-background',
          sessions.selectedId ? 'flex' : 'hidden lg:flex',
        )}
        aria-label="会话详情面板"
      >
        <ConversationDetail
          summary={sessions.selectedSummary}
          detail={sessions.detail}
          phase={sessions.detailPhase}
          error={sessions.detailError}
          resetting={sessions.resetting}
          mode={sessions.mode}
          onBack={() => sessions.setSelectedId(null)}
          onRetry={() => void sessions.retryDetail()}
          onResetMood={sessions.resetMood}
        />
      </section>
    </div>
  );
}
