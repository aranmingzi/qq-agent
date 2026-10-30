import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'focus-ring h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-foreground shadow-sm transition-colors',
        'hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted disabled:opacity-70',
        'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/25',
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';
