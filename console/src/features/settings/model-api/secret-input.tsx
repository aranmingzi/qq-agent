import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip } from '@/components/ui/tooltip';

interface SecretInputProps {
  id?: string;
  label: string;
  description?: string;
  configured: boolean;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}

/**
 * 已保存密钥永不回显。输入新值时才有显示/隐藏切换；
 * 组件不写入 localStorage，也不会把密钥拼进日志或 URL。
 */
export function SecretInput({
  id,
  label,
  description,
  configured,
  hint,
  value,
  onChange,
  placeholder = '输入 API Key',
  error,
  disabled,
  required,
}: SecretInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(!configured);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (configured && !value) setEditing(false);
  }, [configured, value]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const showStored = configured && !editing && !value;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>
          {label}
          {required ? <span className="ml-0.5 text-danger">*</span> : null}
        </Label>
        {configured && !editing ? (
          <Badge variant="success" className="px-1.5 py-0">
            已保存
          </Badge>
        ) : null}
      </div>

      {showStored ? (
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-muted px-3">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">
            {hint || '••••••••••••'}
          </span>
          <Tooltip content="出于安全考虑，后端不会把已保存的密钥回传浏览器">
            <span className="text-[10.5px] text-muted">不可回显</span>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11.5px]"
            onClick={() => setEditing(true)}
            disabled={disabled}
          >
            <KeyRound />
            替换
          </Button>
        </div>
      ) : (
        <div className="relative">
          <Input
            ref={inputRef}
            id={inputId}
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={configured ? '输入新密钥（留空则保留已保存密钥）' : placeholder}
            autoComplete="new-password"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            aria-describedby={cn(description ? descriptionId : '', error ? errorId : '') || undefined}
            className="pr-20 font-mono text-[12px]"
          />
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisible((current) => !current)}
              aria-label={visible ? '隐藏 API Key' : '显示 API Key'}
              disabled={disabled}
              className="text-muted"
            >
              {visible ? <EyeOff /> : <Eye />}
            </Button>
            {configured ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-[10.5px] text-muted"
                onClick={() => {
                  onChange('');
                  setEditing(false);
                }}
                disabled={disabled}
              >
                取消
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {description ? (
        <p id={descriptionId} className="text-[11px] leading-5 text-muted">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[11px] leading-5 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
