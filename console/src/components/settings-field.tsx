import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function Field({
  label,
  htmlFor,
  description,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-[11px] leading-4 text-danger">
          {error}
        </p>
      ) : description ? (
        <p className="text-[11px] leading-4 text-muted">{description}</p>
      ) : null}
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  description,
  error,
  disabled,
  mono,
  className,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: ReactNode;
  error?: string;
  disabled?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      description={description}
      error={error}
      className={className}
    >
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        className={mono ? 'font-mono text-[12px]' : undefined}
      />
    </Field>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  description,
  error,
  disabled,
  className,
}: {
  id: string;
  label: ReactNode;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  description?: ReactNode;
  error?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      description={description}
      error={error}
      className={className}
    >
      <div className="relative">
        <Input
          id={id}
          type="number"
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = Number(event.target.value);
            onChange(Number.isNaN(next) ? 0 : next);
          }}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          className={cn('tabular-nums', unit && 'pr-12')}
        />
        {unit ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10.5px] text-muted">
            {unit}
          </span>
        ) : null}
      </div>
    </Field>
  );
}

export function ToggleRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-muted/35 px-3.5 py-3',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer">
          {title}
        </Label>
        {description ? (
          <p className="mt-0.5 text-[11px] leading-5 text-muted">{description}</p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="mt-0.5"
      />
    </div>
  );
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  onChange,
  options,
  description,
  disabled,
  className,
}: {
  id: string;
  label: ReactNode;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Field label={label} htmlFor={id} description={description} className={className}>
      <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
        <SelectTrigger id={id} aria-label={typeof label === 'string' ? label : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
