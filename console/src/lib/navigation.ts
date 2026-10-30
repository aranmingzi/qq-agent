import {
  Archive,
  BookMarked,
  Cpu,
  HeartPulse,
  LayoutGrid,
  MessageSquare,
  MessagesSquare,
  Mic,
  PhoneCall,
  PhoneIncoming,
  Monitor,
  Plug,
  Quote,
  Settings2,
  ShieldCheck,
  UserRound,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  match?: (path: string) => boolean;
  hint?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const primaryNav: NavItem[] = [
  {
    label: '会话',
    href: '/sessions',
    icon: MessagesSquare,
    match: (path) => path.startsWith('/sessions'),
    hint: '每次运行 = 一个会话',
  },
  {
    label: '存档',
    href: '/archive',
    icon: Archive,
    match: (path) => path.startsWith('/archive'),
    hint: '只读消息存档',
  },
  {
    label: '运行体检',
    href: '/health',
    icon: HeartPulse,
    match: (path) => path.startsWith('/health'),
    hint: '风控、卡住的发送、刚才为什么回',
  },
  {
    label: 'SnowLuma',
    href: '/snowluma',
    icon: Waypoints,
    match: (path) => path.startsWith('/snowluma'),
    hint: 'OneBot 网关与运行日志',
  },
  {
    label: '设置',
    href: '/settings/capabilities',
    icon: Settings2,
    match: (path) => path.startsWith('/settings'),
    hint: '能力、模型与连接配置',
  },
];

export const settingsGroups: NavGroup[] = [
  {
    label: '智能体',
    items: [
      {
        label: '能力总览',
        href: '/settings/capabilities',
        icon: LayoutGrid,
        match: (path) => path.startsWith('/settings/capabilities'),
      },
      {
        label: '模型 API',
        href: '/settings/model',
        icon: Cpu,
        match: (path) => path.startsWith('/settings/model'),
      },
      {
        label: '人设',
        href: '/settings/persona',
        icon: UserRound,
        match: (path) => path.startsWith('/settings/persona'),
      },
    ],
  },
  {
    label: '消息',
    items: [
      {
        label: '聊天白名单',
        href: '/settings/allowlist',
        icon: ShieldCheck,
        match: (path) => path.startsWith('/settings/allowlist'),
      },
      {
        label: '聊天设置',
        href: '/settings/chat',
        icon: MessageSquare,
        match: (path) => path.startsWith('/settings/chat'),
      },
      {
        label: '群梗库',
        href: '/settings/memes',
        icon: BookMarked,
        match: (path) => path.startsWith('/settings/memes'),
      },
      {
        label: '表达库',
        href: '/settings/expressions',
        icon: Quote,
        match: (path) => path.startsWith('/settings/expressions'),
      },
    ],
  },
  {
    label: '语音与连接',
    items: [
      {
        label: '语音通话',
        href: '/voice',
        icon: PhoneCall,
        match: (path) => path.startsWith('/voice'),
      },
      {
        label: 'QQ 通话',
        href: '/qq-call',
        icon: PhoneIncoming,
        match: (path) => path.startsWith('/qq-call'),
      },
      {
        label: '语音音色',
        href: '/settings/voice',
        icon: Mic,
        match: (path) => path.startsWith('/settings/voice'),
      },
      {
        label: '桌面端',
        href: '/settings/desktop',
        icon: Monitor,
        match: (path) => path.startsWith('/settings/desktop'),
      },
      {
        label: 'OneBot',
        href: '/settings/onebot',
        icon: Plug,
        match: (path) => path.startsWith('/settings/onebot'),
      },
    ],
  },
];

export const routeTitles: Record<string, { title: string; section: string }> = {
  '/sessions': { title: '会话', section: '运行' },
  '/archive': { title: '存档', section: '运行' },
  '/health': { title: '运行体检', section: '运行' },
  '/voice': { title: '语音通话', section: '运行' },
  '/qq-call': { title: 'QQ 通话', section: '运行' },
  '/snowluma': { title: 'SnowLuma', section: '网关' },
  '/settings/capabilities': { title: '能力总览', section: '设置' },
  '/settings/model': { title: '模型 API', section: '设置' },
  '/settings/persona': { title: '人设', section: '设置' },
  '/settings/allowlist': { title: '聊天白名单', section: '设置' },
  '/settings/chat': { title: '聊天设置', section: '设置' },
  '/settings/memes': { title: '群梗库', section: '设置' },
  '/settings/expressions': { title: '表达库', section: '设置' },
  '/settings/voice': { title: '语音音色', section: '设置' },
  '/settings/desktop': { title: '桌面端', section: '设置' },
  '/settings/onebot': { title: 'OneBot', section: '设置' },
};

export function titleForPath(path: string) {
  return routeTitles[path] ?? { title: '控制台', section: 'QQ Agent' };
}
