import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'py-10' : 'py-20',
        className,
      )}
    >
      <div
        className={cn(
          'relative mb-4 flex items-center justify-center rounded-xl border border-border bg-surface text-muted shadow-card',
          compact ? 'h-10 w-10' : 'h-12 w-12',
        )}
        aria-hidden="true"
      >
        <div className="absolute inset-0 rounded-xl bg-dots opacity-40" />
        <Icon className={cn('relative', compact ? 'h-[18px] w-[18px]' : 'h-5 w-5')} />
      </div>
      <p className={cn('font-medium text-foreground', compact ? 'text-[13px]' : 'text-sm')}>
        {title}
      </p>
      {description ? (
        <p className="mt-1.5 max-w-sm text-[12.5px] leading-5 text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
