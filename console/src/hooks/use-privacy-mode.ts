import { useCallback, useEffect, useRef, useState } from 'react';
import { PRIVACY_AUTO_HIDE_MS } from '@/lib/privacy';

/**
 * 真实群名/QQ 号默认隐藏；只在用户显式确认后临时显示。
 * 显示状态只存在内存：刷新页面、切到后台或超时都会重新隐藏。
 */
export function usePrivacyMode(autoHideMs = PRIVACY_AUTO_HIDE_MS) {
  const [hidden, setHidden] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const hide = useCallback(() => {
    clearTimer();
    setHidden(true);
  }, []);

  const requestReveal = useCallback(() => setConfirmOpen(true), []);

  const confirmReveal = useCallback(() => {
    setHidden(false);
    setConfirmOpen(false);
    clearTimer();
    timer.current = window.setTimeout(() => setHidden(true), autoHideMs);
  }, [autoHideMs]);

  useEffect(() => {
    if (hidden) return;
    const onVisibility = () => {
      if (document.hidden) hide();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimer();
    };
  }, [hidden, hide]);

  return {
    hidden,
    confirmOpen,
    setConfirmOpen,
    requestReveal,
    confirmReveal,
    hide,
  };
}
