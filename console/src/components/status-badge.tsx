import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  MessageSquareOff,
} from 'lucide-react';
import type { SessionStatus } from '@/types';
import { cn } from '@/lib/utils';

export const sessionStatusMeta: Record<
  SessionStatus,
  { label: string; description: string; className: string; icon: typeof CheckCircle2 }
> = {
  running: {
    label: '运行中',
    description: '模型正在处理本次会话',
    className: 'border-primary/20 bg-primary-soft text-primary',
    icon: Loader2,
  },
  done: {
    label: '已发言',
    description: '本次运行已产出并发送消息',
    className: 'border-success/20 bg-success-soft text-success',
    icon: CheckCircle2,
  },
  noreply: {
    label: '未回复',
    description: '判断为本轮无需回复',
    className: 'border-warning/25 bg-warning-soft text-warning',
    icon: MessageSquareOff,
  },
  error: {
    label: '出错',
    description: '本次运行异常终止',
    className: 'border-danger/20 bg-danger-soft text-danger',
    icon: AlertTriangle,
  },
  aborted: {
    label: '已中止',
    description: '运行被手动或外部中止',
    className: 'border-border bg-surface-muted text-muted',
    icon: Ban,
  },
};

interface StatusBadgeProps {
  status: SessionStatus;
  size?: 'sm' | 'md';
  showIcon?: boolean;
  className?: string;
}

export function StatusBadge({ status, size = 'sm', showIcon = true, className }: StatusBadgeProps) {
  const meta = sessionStatusMeta[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border font-medium',
        size === 'sm' ? 'px-1.5 py-0.5 text-[11px] leading-4' : 'px-2 py-1 text-[12px] leading-4',
        meta.className,
        className,
      )}
      title={meta.description}
    >
      {showIcon ? (
        <Icon
          className={cn(
            'h-3 w-3 shrink-0',
            status === 'running' && 'motion-safe:animate-spin',
          )}
          aria-hidden="true"
        />
      ) : (
        <span
          className="h-1.5 w-1.5 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {meta.label}
    </span>
  );
}
