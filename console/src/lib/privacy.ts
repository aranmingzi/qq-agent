export const PRIVACY_AUTO_HIDE_MS = 120_000;

export function rosterAlias(kind: 'group' | 'friend', index: number) {
  return `${kind === 'group' ? '群聊' : '好友'} ${String(index + 1).padStart(2, '0')}`;
}

/** 隐藏态下连尾号也不展示，避免通过尾号在群列表里反查。 */
export function maskRosterId() {
  return '••••••••';
}

export interface RosterDisplayItem {
  key: string;
  alias: string;
  displayName: string;
  displayId: string;
}

export function buildRosterDisplay(
  items: Array<{ id: string; name: string }>,
  kind: 'group' | 'friend',
  hidden: boolean,
): RosterDisplayItem[] {
  return items.map((item, index) => ({
    key: item.id,
    alias: rosterAlias(kind, index),
    displayName: hidden ? rosterAlias(kind, index) : item.name || item.id,
    displayId: hidden ? maskRosterId() : item.id,
  }));
}
