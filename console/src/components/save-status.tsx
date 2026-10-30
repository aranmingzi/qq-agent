import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SaveStatus({
  dirty,
  state,
  className,
}: {
  dirty: boolean;
  state: SaveState;
  className?: string;
}) {
  const meta =
    state === 'saving'
      ? { icon: Loader2, label: '保存中…', tone: 'text-muted', spin: true }
      : state === 'error'
        ? { icon: AlertCircle, label: '保存失败', tone: 'text-danger', spin: false }
        : dirty
          ? { icon: Circle, label: '未保存更改', tone: 'text-warning', spin: false }
          : state === 'saved'
            ? { icon: CheckCircle2, label: '已保存', tone: 'text-success', spin: false }
            : { icon: CheckCircle2, label: '已同步', tone: 'text-muted', spin: false };
  const Icon = meta.icon;
  return (
    <span
      role="status"
      className={cn('inline-flex items-center gap-1.5 text-[11.5px]', meta.tone, className)}
    >
      <Icon className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
