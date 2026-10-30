import { useEffect, useState } from 'react';
import { cachedQqFaces, loadQqFaces, type QqFace } from '@/lib/qq-face';
import { useConsoleMode } from '@/providers/console-mode-provider';

/** QQ 内置表情映射（id → 名字/图号）。整张表只拉一次，失败就当空表（只显示名字）。 */
export function useQqFaces(): Record<string, QqFace> {
  const { mode } = useConsoleMode();
  const [faces, setFaces] = useState<Record<string, QqFace>>(() => cachedQqFaces() ?? {});

  useEffect(() => {
    if (mode === 'demo') return;
    let alive = true;
    void loadQqFaces().then((next) => {
      if (alive) setFaces((prev) => (prev === next ? prev : next));
    });
    return () => {
      alive = false;
    };
  }, [mode]);

  return faces;
}
