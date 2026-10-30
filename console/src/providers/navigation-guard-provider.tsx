import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmDialog } from '@/components/ui/dialog';
import { navigateTo } from '@/lib/router';

interface NavigationGuard {
  dirty: boolean;
  discard?: () => void;
}

interface NavigationGuardContextValue {
  registerGuard: (guard: NavigationGuard | null) => void;
  requestNavigation: (href: string) => void;
}

const NavigationGuardContext = createContext<NavigationGuardContextValue | null>(null);

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const [guard, setGuard] = useState<NavigationGuard | null>(null);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const registerGuard = useCallback((next: NavigationGuard | null) => {
    setGuard(next);
  }, []);

  const requestNavigation = useCallback(
    (href: string) => {
      if (guard?.dirty) {
        setPendingHref(href);
        return;
      }
      navigateTo(href);
    },
    [guard],
  );

  const confirmLeave = () => {
    guard?.discard?.();
    if (pendingHref) navigateTo(pendingHref);
    setPendingHref(null);
  };

  const value = useMemo(
    () => ({ registerGuard, requestNavigation }),
    [registerGuard, requestNavigation],
  );

  return (
    <NavigationGuardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={Boolean(pendingHref)}
        onOpenChange={(open) => {
          if (!open) setPendingHref(null);
        }}
        title="有未保存的更改"
        description="当前页的模型参数或密钥修改尚未保存。离开后这些修改会丢失，已保存的配置不会被改动。"
        confirmLabel="放弃更改并离开"
        cancelLabel="继续编辑"
        tone="danger"
        onConfirm={confirmLeave}
      />
    </NavigationGuardContext.Provider>
  );
}

export function useNavigationGuard() {
  const value = useContext(NavigationGuardContext);
  if (!value) throw new Error('useNavigationGuard 必须在 NavigationGuardProvider 内使用');
  return value;
}
