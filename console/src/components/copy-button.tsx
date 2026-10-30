import { useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { copyText } from '@/lib/clipboard';
import { Button, type ButtonProps } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  text: string | (() => string);
  label?: string;
  copiedLabel?: string;
  failedLabel?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  iconOnly?: boolean;
  className?: string;
  onResult?: (ok: boolean) => void;
}

export function CopyButton({
  text,
  label = '复制',
  copiedLabel = '已复制',
  failedLabel = '复制失败',
  variant = 'ghost',
  size = 'sm',
  iconOnly,
  className,
  onResult,
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async () => {
    const value = typeof text === 'function' ? text() : text;
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    onResult?.(ok);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  const currentLabel =
    state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : label;

  const button = (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => void handleCopy()}
      aria-label={iconOnly ? currentLabel : undefined}
      className={cn(iconOnly && 'px-0', className)}
    >
      <Icon className={cn(state === 'copied' && 'text-success', state === 'failed' && 'text-danger')} />
      {iconOnly ? null : <span>{currentLabel}</span>}
    </Button>
  );

  if (!iconOnly) return button;

  return (
    <Tooltip content={currentLabel}>
      <span className="inline-flex">{button}</span>
    </Tooltip>
  );
}
