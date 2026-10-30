import { useCallback, useEffect, useState } from 'react';

export const SETTINGS_ROOT = '/settings/capabilities';

function readPath() {
  if (typeof window === 'undefined') return '/sessions';
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw === '/') return '/sessions';
  if (raw === '/settings') return SETTINGS_ROOT;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function navigateTo(path: string, options: { replace?: boolean } = {}) {
  const next = `#${path}`;
  if (options.replace) {
    window.location.replace(next);
  } else {
    window.location.hash = path;
  }
}

export function useHashRoute() {
  const [path, setPath] = useState(readPath);

  useEffect(() => {
    const onChange = () => {
      const next = readPath();
      setPath(next);
      if (window.location.hash === '#/settings') {
        window.location.replace(`#${SETTINGS_ROOT}`);
      }
    };
    window.addEventListener('hashchange', onChange);
    if (!window.location.hash) window.location.replace('#/sessions');
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: string) => navigateTo(next), []);
  return { path, navigate };
}

export function isSettingsPath(path: string) {
  return path.startsWith('/settings');
}
