import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus } from '@/types';
import { api } from '@/lib/api';
import { demoStatus } from '@/lib/demo-data';
import { useConsoleMode } from '@/providers/console-mode-provider';

export function useAppStatus() {
  const { mode } = useConsoleMode();
  const [status, setStatus] = useState<AppStatus | null>(mode === 'demo' ? demoStatus : null);
  const [loading, setLoading] = useState(mode === 'live');
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      if (mode === 'demo') {
        setStatus(demoStatus);
        setLoading(false);
        setError(null);
        return;
      }
      const current = ++requestId.current;
      if (!options.quiet) setLoading(true);
      try {
        const next = await api.status();
        if (current !== requestId.current) return;
        setStatus(next);
        setError(null);
      } catch (cause) {
        if (current !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : '状态读取失败');
      } finally {
        if (current === requestId.current) setLoading(false);
      }
    },
    [mode],
  );

  useEffect(() => {
    setStatus(mode === 'demo' ? demoStatus : null);
    setError(null);
    void refresh();
  }, [mode, refresh]);

  useEffect(() => {
    if (mode !== 'live') return;
    const timer = window.setInterval(() => void refresh({ quiet: true }), 15_000);
    return () => window.clearInterval(timer);
  }, [mode, refresh]);

  return { status, loading, error, refresh };
}
