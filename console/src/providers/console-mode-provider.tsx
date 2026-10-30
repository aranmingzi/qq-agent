import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DataMode } from '@/types';
import { api } from '@/lib/api';
import { useToast } from '@/providers/toast-provider';

interface ConsoleModeContextValue {
  mode: DataMode;
  changing: boolean;
  changeMode: (mode: DataMode) => Promise<boolean>;
}

const ConsoleModeContext = createContext<ConsoleModeContextValue | null>(null);

function initialMode(): DataMode {
  if (typeof window === 'undefined') return 'demo';
  const query = new URLSearchParams(window.location.search);
  const explicit = query.get('mode');
  if (explicit === 'live' || explicit === 'demo') return explicit;

  // Electron 集成构建挂在 /console/，与后端同源，默认直接使用真实数据。
  if (window.location.pathname.startsWith('/console')) return 'live';

  const configured = import.meta.env.VITE_DEFAULT_MODE;
  if (configured === 'live' || configured === 'demo') return configured;

  return 'demo';
}

export function ConsoleModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DataMode>(initialMode);
  const [changing, setChanging] = useState(false);
  const toast = useToast();

  const changeMode = useCallback(
    async (next: DataMode) => {
      if (next === mode) return true;
      if (next === 'demo') {
        setMode('demo');
        toast({
          title: '已切换到演示数据',
          description: '所有操作只更新本地演示状态，不会写入 QQ Agent 后端。',
          variant: 'info',
        });
        return true;
      }

      setChanging(true);
      try {
        const status = await api.status();
        setMode('live');
        toast({
          title: '已连接本地 QQ Agent',
          description: `OneBot ${status.onebot.connected ? '已连接' : '未连接'} · 模型 ${status.orchestrator.model}`,
          variant: 'success',
        });
        return true;
      } catch (error) {
        toast({
          title: '无法连接本地服务',
          description:
            error instanceof Error
              ? `${error.message}。请确认 QQ Agent 正在 127.0.0.1:3210 运行。`
              : '请确认 QQ Agent 正在 127.0.0.1:3210 运行。',
          variant: 'error',
        });
        return false;
      } finally {
        setChanging(false);
      }
    },
    [mode, toast],
  );

  const value = useMemo(() => ({ mode, changing, changeMode }), [mode, changing, changeMode]);

  return <ConsoleModeContext.Provider value={value}>{children}</ConsoleModeContext.Provider>;
}

export function useConsoleMode() {
  const value = useContext(ConsoleModeContext);
  if (!value) throw new Error('useConsoleMode 必须在 ConsoleModeProvider 内使用');
  return value;
}
