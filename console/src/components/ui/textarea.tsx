import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'focus-ring flex min-h-[96px] w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 text-[13px] leading-6 text-foreground shadow-sm transition-colors',
        'hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted disabled:opacity-70',
        'aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  ),
);

Textarea.displayName = 'Textarea';
