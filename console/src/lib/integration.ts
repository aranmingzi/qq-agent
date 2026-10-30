/** React 控制台被 QQ Agent 后端挂在 /console/ 下时，旧版 UI 仍在 /legacy/ 可访问。 */
export function isIntegratedConsole() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/console');
}

export function openLegacyConsole() {
  window.location.assign('/legacy/');
}
