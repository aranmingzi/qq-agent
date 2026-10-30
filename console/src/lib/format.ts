const timeZone = 'Asia/Shanghai';

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const fullDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partsToMap(value: string) {
  return value.replace(/\//g, '-');
}

export function formatDateTime(ts?: number | null) {
  if (!ts) return '—';
  return partsToMap(dateTime.format(new Date(ts)));
}

export function formatClock(ts?: number | null) {
  if (!ts) return '—';
  return clock.format(new Date(ts));
}

export function formatFull(ts?: number | null) {
  if (!ts) return '—';
  return partsToMap(fullDate.format(new Date(ts)));
}

export function formatTokens(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

export function formatNumber(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function formatDuration(startedAt?: number | null, endedAt?: number | null) {
  if (!startedAt) return '—';
  const end = endedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function chatLabel(chatKey: string, chatName?: string) {
  if (chatName) return chatName;
  if (chatKey.startsWith('group:')) return `群 ${chatKey.slice(6)}`;
  if (chatKey.startsWith('private:')) return `私聊 ${chatKey.slice(8)}`;
  return chatKey;
}

export function chatKind(chatKey: string): 'group' | 'private' | 'other' {
  if (chatKey.startsWith('group:')) return 'group';
  if (chatKey.startsWith('private:')) return 'private';
  return 'other';
}

export function chatId(chatKey: string) {
  const index = chatKey.indexOf(':');
  return index >= 0 ? chatKey.slice(index + 1) : chatKey;
}

export function relativeTime(ts: number, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return formatDateTime(ts);
}

export function maskSecret(secret: string | null | undefined, visibleTail = 4) {
  if (!secret) return '';
  const value = secret.trim();
  if (value.length <= visibleTail) return '••••••••';
  return `••••••••••••${value.slice(-visibleTail)}`;
}
