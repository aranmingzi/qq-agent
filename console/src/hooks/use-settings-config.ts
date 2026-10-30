import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig } from '@/types';
import { api } from '@/lib/api';
import { demoAppConfig } from '@/lib/demo-settings';
import { sleep } from '@/lib/utils';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { useToast } from '@/providers/toast-provider';

export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'error';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch as T) ?? base;
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    next[key] = isPlainObject(value) && isPlainObject(next[key])
      ? mergeDeep(next[key], value)
      : value;
  }
  return next as T;
}

export function useSettingsConfig() {
  const { mode } = useConsoleMode();
  const toast = useToast();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SettingsSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setPhase('loading');
    setError(null);
    try {
      let next: AppConfig;
      if (mode === 'demo') {
        await sleep(180);
        next = demoAppConfig;
      } else {
        next = await api.rawConfig();
      }
      if (current !== requestId.current) return;
      setConfig(next);
      setPhase('ready');
      setSaveState('idle');
    } catch (cause) {
      if (current !== requestId.current) return;
      setPhase('error');
      setError(cause instanceof Error ? cause.message : '配置读取失败');
    }
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!config) return null;
      setSaveState('saving');
      setSaveError(null);
      try {
        let next: AppConfig;
        if (mode === 'demo') {
          await sleep(320);
          next = mergeDeep(config, patch);
        } else {
          next = (await api.saveRawConfig(patch)) ?? config;
        }
        setConfig(next);
        setSaveState('saved');
        toast({
          title: mode === 'demo' ? '已保存到本地演示状态' : '设置已保存',
          description:
            mode === 'demo'
              ? '演示模式不会写入 QQ Agent 后端。'
              : '部分连接类设置需要重启应用或服务后生效。',
          variant: 'success',
        });
        return next;
      } catch (cause) {
        setSaveState('error');
        const message = cause instanceof Error ? cause.message : '保存失败，请稍后重试';
        setSaveError(message);
        toast({ title: '保存失败', description: message, variant: 'error' });
        return null;
      }
    },
    [config, mode, toast],
  );

  return {
    mode,
    config,
    phase,
    error,
    saveState,
    saveError,
    load,
    save,
  };
}
