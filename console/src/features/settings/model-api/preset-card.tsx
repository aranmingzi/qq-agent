import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Brain, GraduationCap, Scale, Zap, type LucideIcon } from 'lucide-react';
import type { BrainPreset } from '@/types';
import { cn } from '@/lib/utils';

const presetIcons: Record<string, LucideIcon> = {
  fast: Zap,
  balanced: Scale,
  complex: Brain,
  tutor: GraduationCap,
};

interface PresetCardProps {
  preset: BrainPreset;
  selected: boolean;
}

export function PresetCard({ preset, selected }: PresetCardProps) {
  const Icon = presetIcons[preset.id] ?? Zap;
  const descriptionId = `preset-${preset.id}-desc`;

  return (
    <RadioGroupPrimitive.Item
      value={preset.id}
      data-testid={`preset-${preset.id}`}
      aria-describedby={descriptionId}
      className={cn(
        'focus-ring group relative flex min-h-[126px] flex-col rounded-lg border p-3 text-left transition-colors',
        'border-border bg-surface hover:border-border-strong',
        'data-[state=checked]:border-primary/45 data-[state=checked]:bg-primary-soft/40',
      )}
    >
      <span className="flex items-start gap-2.5">
        <span
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors',
            selected
              ? 'border-primary/20 bg-primary/10 text-primary'
              : 'border-border bg-surface-muted text-muted',
          )}
          aria-hidden="true"
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-foreground">{preset.name}</span>
            {selected ? (
              <span className="rounded bg-primary/10 px-1 py-px text-[9.5px] font-medium text-primary">
                当前
              </span>
            ) : null}
          </span>
          <span id={descriptionId} className="mt-0.5 block text-[10.5px] leading-4 text-muted">
            {preset.description}
          </span>
        </span>
      </span>

      <span className="mt-auto space-y-1 pt-3 text-[10px] text-muted">
        <span className="flex items-center justify-between gap-2">
          <span>温度 / 轮数</span>
          <span className="font-mono text-foreground/80">
            {preset.temperature.toFixed(1)} / {preset.maxRounds}
          </span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span>输出 / 复杂</span>
          <span className="font-mono text-foreground/80">
            {preset.maxOutputTokens} / {preset.complexMaxOutputTokens}
          </span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span>思考</span>
          <span className="text-foreground/80">
            {preset.thinkingMode === 'off' ? '关闭' : '自动'}
          </span>
        </span>
      </span>

      <RadioGroupPrimitive.Indicator asChild>
        <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full border border-primary bg-primary text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-white" />
        </span>
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
