import { CloudDrizzle, Minus, Smile, Sparkles } from 'lucide-react';
import type { Mood } from '@/types';
import { cn } from '@/lib/utils';

const moodMeta = (label: string) => {
  if (label === '很兴奋') {
    return {
      icon: Sparkles,
      className: 'border-primary/20 bg-primary-soft text-primary',
    };
  }
  if (label === '开心') {
    return {
      icon: Smile,
      className: 'border-success/20 bg-success-soft text-success',
    };
  }
  if (label === '有点低落') {
    return {
      icon: CloudDrizzle,
      className: 'border-warning/25 bg-warning-soft text-warning',
    };
  }
  return {
    icon: Minus,
    className: 'border-border bg-surface-muted text-muted',
  };
};

interface MoodBadgeProps {
  mood?: Mood | null;
  className?: string;
}

/**
 * 情绪只展示后端已有的 label。后端 score 用于内部衰减与标签计算，
 * 当前没有公开的区间定义，因此这里不渲染百分比、仪表盘或虚构分数。
 */
export function MoodBadge({ mood, className }: MoodBadgeProps) {
  if (!mood) return null;
  const meta = moodMeta(mood.label);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4',
        meta.className,
        className,
      )}
      title="当前聊天的情绪状态；仅影响后续回复语气"
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {mood.label}
    </span>
  );
}
