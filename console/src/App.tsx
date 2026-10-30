import { useState, type ReactNode } from 'react';
import type { AppStatus } from '@/types';
import { AppSidebar } from '@/components/app-sidebar';
import { ConsoleHeader } from '@/components/console-header';
import { AppSidebarMobile } from '@/components/app-sidebar-mobile';
import { useAppStatus } from '@/hooks/use-app-status';
import { useHashRoute } from '@/lib/router';
import { SessionsPage } from '@/features/sessions/sessions-page';
import { ArchivePage } from '@/features/archive/archive-page';
import { SnowLumaPage } from '@/features/snowluma/snowluma-page';
import { CapabilitiesPage } from '@/features/settings/capabilities/capabilities-page';
import { ModelApiPage } from '@/features/settings/model-api/model-api-page';
import { PersonaPage } from '@/features/settings/persona/persona-page';
import { AllowlistPage } from '@/features/settings/allowlist/allowlist-page';
import { ChatSettingsPage } from '@/features/settings/chat/chat-settings-page';
import { VoiceSettingsPage } from '@/features/settings/voice/voice-settings-page';
import { DesktopSettingsPage } from '@/features/settings/desktop/desktop-settings-page';
import { OneBotSettingsPage } from '@/features/settings/onebot/onebot-settings-page';
import { MemesPage } from '@/features/memes/memes-page';
import { HealthPage } from '@/features/health/health-page';
import { ExpressionsPage } from '@/features/expressions/expressions-page';
import { VoiceCallPage } from '@/features/voice/voice-call-page';
import { QqCallPage } from '@/features/call/qq-call-page';
import { SettingsPlaceholderPage } from '@/features/settings/settings-placeholder-page';
import { RouteErrorBoundary } from '@/components/route-error-boundary';

const routeTitles: Record<string, string> = {
  '/archive': '存档',
  '/health': '运行体检',
  '/qq-call': 'QQ 通话',
  '/voice': '语音通话',
  '/snowluma': 'SnowLuma',
  '/settings/model': '模型 API',
  '/settings/capabilities': '能力总览',
  '/settings/persona': '人设',
  '/settings/allowlist': '聊天白名单',
  '/settings/chat': '聊天设置',
  '/settings/voice': '语音音色',
  '/settings/desktop': '桌面端',
  '/settings/onebot': 'OneBot',
  '/settings/memes': '群梗库',
  '/settings/expressions': '表达库',
};

function RouteView({
  path,
  status,
  onRefreshStatus,
}: {
  path: string;
  status: AppStatus | null;
  onRefreshStatus: () => void;
}) {
  // 每个路由单独包一层错误边界：某页渲染崩溃只倒这一块，
  // 侧边栏还在，用户能点走 —— 而不是整个控制台白屏。
  const label = Object.entries(routeTitles).find(([prefix]) => path.startsWith(prefix))?.[1];
  const guarded = (node: ReactNode) => (
    <RouteErrorBoundary label={label ?? '此页面'}>{node}</RouteErrorBoundary>
  );
  if (path.startsWith('/archive')) return guarded(<ArchivePage />);
  if (path.startsWith('/health')) return guarded(<HealthPage />);
  // 顺序有讲究：/qq-call 必须排在 /voice 之前吗？不用 —— 两者前缀不重叠，
  // 但都必须排在 /settings 之前。/qq-call 是「真的 QQ 客户端里接电话」，
  // /voice 是「在控制台里跟它打电话」，是完全不同的两件事，别合并。
  if (path.startsWith('/qq-call')) return guarded(<QqCallPage />);
  // 通话页必须排在 /settings 之前，且路径不能叫 /settings/voice ——
  // 那个是「语音音色」设置页，两者是不同东西。
  if (path.startsWith('/voice')) return guarded(<VoiceCallPage />);
  if (path.startsWith('/snowluma'))
    return guarded(<SnowLumaPage status={status} onRefreshStatus={onRefreshStatus} />);
  if (path.startsWith('/settings/model')) return guarded(<ModelApiPage />);
  if (path.startsWith('/settings/capabilities')) return guarded(<CapabilitiesPage />);
  if (path.startsWith('/settings/persona')) return guarded(<PersonaPage />);
  if (path.startsWith('/settings/allowlist')) return guarded(<AllowlistPage />);
  if (path.startsWith('/settings/chat')) return guarded(<ChatSettingsPage />);
  if (path.startsWith('/settings/voice')) return guarded(<VoiceSettingsPage />);
  if (path.startsWith('/settings/desktop')) return guarded(<DesktopSettingsPage />);
  if (path.startsWith('/settings/onebot')) return guarded(<OneBotSettingsPage />);
  if (path.startsWith('/settings/memes')) return guarded(<MemesPage />);
  if (path.startsWith('/settings/expressions')) return guarded(<ExpressionsPage />);
  if (path.startsWith('/settings')) return guarded(<SettingsPlaceholderPage path={path} />);
  return guarded(<SessionsPage />);
}

export default function App() {
  const { path } = useHashRoute();
  const { status, loading, error, refresh } = useAppStatus();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-border lg:block">
        <AppSidebar path={path} status={status} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[248px]">
        <ConsoleHeader
          path={path}
          status={status}
          statusLoading={loading}
          statusError={error}
          onOpenSidebar={() => setSidebarOpen(true)}
          onRefreshStatus={() => void refresh()}
        />
        <main className="min-h-0 flex-1 overflow-hidden">
          <RouteView
            path={path}
            status={status}
            onRefreshStatus={() => void refresh()}
          />
        </main>
      </div>

      <AppSidebarMobile
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        path={path}
        status={status}
      />
    </div>
  );
}
