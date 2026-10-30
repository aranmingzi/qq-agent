import { useState } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import type { ToolCallRecord } from '@/types';
import { cn } from '@/lib/utils';
import { toolCallToText } from '@/lib/session-text';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/copy-button';

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCallCard({ toolCall }: { toolCall: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(() => {
    const length = toolCall.result.length + stringify(toolCall.args).length;
    return length < 900;
  });
  const args = stringify(toolCall.args);
  const copyValue = toolCallToText(toolCall.name, toolCall.args, toolCall.result);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-surface shadow-card',
        toolCall.isError ? 'border-danger/30' : 'border-border',
      )}
    >
      <div className="flex items-center gap-1 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:text-primary"
        >
          <span
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded',
              toolCall.isError ? 'bg-danger-soft text-danger' : 'bg-surface-muted text-muted',
            )}
          >
            <Wrench className="h-3 w-3" aria-hidden="true" />
          </span>
          <span className="truncate font-mono text-[11.5px] font-medium text-foreground">
            {toolCall.name}
          </span>
          {toolCall.isError ? (
            <Badge variant="danger" className="shrink-0 px-1.5 py-0 text-[10px]">
              失败
            </Badge>
          ) : (
            <Badge variant="neutral" className="shrink-0 px-1.5 py-0 text-[10px]">
              工具
            </Badge>
          )}
          <ChevronDown
            className={cn(
              'ml-auto h-3.5 w-3.5 shrink-0 text-muted transition-transform',
              expanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
        <CopyButton
          text={copyValue}
          iconOnly
          size="icon-sm"
          label="复制工具调用"
          className="text-muted"
        />
      </div>

      {expanded ? (
        <div className="space-y-2 border-t border-border/70 bg-surface-muted/40 px-2.5 py-2">
          <div>
            <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted">
              参数
            </p>
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-surface px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground">
              {args || '（无参数）'}
            </pre>
          </div>
          <div>
            <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-[0.1em] text-muted">
              结果
            </p>
            <pre
              className={cn(
                'scrollbar-thin max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 font-mono text-[11px] leading-5',
                toolCall.isError
                  ? 'border-danger/20 bg-danger-soft/60 text-danger'
                  : 'border-border/70 bg-surface text-muted',
              )}
            >
              {toolCall.result || '（无返回）'}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
