import { useId } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tooltip } from '@/components/ui/tooltip';

interface ParameterControlProps {
  id: string;
  label: string;
  description?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  error?: string;
  disabled?: boolean;
  hint?: string;
}

export function ParameterControl({
  id,
  label,
  description,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  error,
  disabled,
  hint,
}: ParameterControlProps) {
  const autoId = useId();
  const inputId = id || autoId;
  const errorId = `${inputId}-error`;
  const descriptionId = `${inputId}-description`;
  const sliderValue = Math.min(max, Math.max(min, value ?? min));

  return (
    <div className={cn('space-y-2', disabled && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <Label htmlFor={inputId}>{label}</Label>
            {description ? (
              <Tooltip content={description}>
                <button
                  type="button"
                  className="focus-ring mt-0.5 rounded-full text-muted transition-colors hover:text-foreground"
                  aria-label={`${label}说明`}
                >
                  <Info className="h-3 w-3" />
                </button>
              </Tooltip>
            ) : null}
          </div>
          {hint ? (
            <p id={descriptionId} className="mt-0.5 text-[10.5px] leading-4 text-muted">
              {hint}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[10.5px] text-muted">
          {min}–{max}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Slider
          value={[sliderValue]}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onValueChange={(next) => onChange(next[0] ?? null)}
          aria-label={label}
          aria-valuetext={`${value ?? min}${unit ? ` ${unit}` : ''}`}
          className="min-w-0 flex-1"
        />
        <div className="relative w-[104px] shrink-0">
          <Input
            id={inputId}
            type="number"
            inputMode="decimal"
            value={value ?? ''}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                onChange(null);
                return;
              }
              const parsed = Number(raw);
              onChange(Number.isNaN(parsed) ? null : parsed);
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : hint ? descriptionId : undefined}
            className={cn('h-8 pr-10 text-right font-mono text-[11.5px]', unit && 'pr-10')}
          />
          {unit ? (
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted">
              {unit}
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-[11px] leading-4 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
