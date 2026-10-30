import { CircleHelp, type LucideIcon } from 'lucide-react';
import type { AppStatus } from '@/types';
import { BrandMark } from '@/components/brand-mark';
import { Badge } from '@/components/ui/badge';
import { primaryNav, settingsGroups } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { useNavigationGuard } from '@/providers/navigation-guard-provider';

interface AppSidebarProps {
  path: string;
  status: AppStatus | null;
  onNavigate?: () => void;
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  hint,
  onNavigate,
  child,
  trailing,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  hint?: string;
  onNavigate?: () => void;
  child?: boolean;
  trailing?: React.ReactNode;
}) {
  const { requestNavigation } = useNavigationGuard();
  return (
    <a
      href={`#${href}`}
      onClick={(event) => {
        event.preventDefault();
        requestNavigation(href);
        onNavigate?.();
      }}
      aria-current={active ? 'page' : undefined}
      title={hint}
      className={cn(
        'focus-ring group relative flex items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
        child ? 'h-8' : 'h-9',
        active
          ? 'bg-primary-soft font-medium text-primary'
          : 'text-muted hover:bg-surface-muted hover:text-foreground',
      )}
    >
      {active ? (
        <span
          className={cn(
            'absolute left-0 w-[3px] rounded-r-full bg-primary',
            child ? 'top-1.5 bottom-1.5' : 'top-2 bottom-2',
          )}
          aria-hidden="true"
        />
      ) : null}
      <Icon
        className={cn('shrink-0', child ? 'h-3.5 w-3.5' : 'h-[17px] w-[17px]')}
        strokeWidth={active ? 2 : 1.75}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
      {trailing}
    </a>
  );
}

export function AppSidebar({ path, status, onNavigate }: AppSidebarProps) {
  const { requestNavigation } = useNavigationGuard();
  const settingsActive = path.startsWith('/settings');
  const connected = status?.onebot.connected ?? false;
  const snowlumaRunning = status?.snowluma.running ?? false;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4">
        <BrandMark size={34} online={connected} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">
              QQ Agent
            </span>
            <span className="rounded border border-border px-1 py-px text-[9.5px] font-medium uppercase tracking-wider text-muted">
              Beta
            </span>
          </div>
          <p className="truncate text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">
            Agent Console
          </p>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-4">
        <p className="mb-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted/80">
          工作台
        </p>
        <nav aria-label="主导航" className="space-y-0.5">
          {primaryNav.map((item) => {
            const active = item.match ? item.match(path) : path === item.href;
            return (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={active}
                hint={item.hint}
                onNavigate={onNavigate}
                trailing={
                  item.label === 'SnowLuma' ? (
                    <span
                      className={cn(
                        'ml-auto h-1.5 w-1.5 rounded-full',
                        snowlumaRunning ? 'bg-success' : 'bg-muted/50',
                      )}
                      title={snowlumaRunning ? 'SnowLuma 运行中' : 'SnowLuma 未运行'}
                    />
                  ) : item.label === '设置' ? (
                    <span className="ml-auto text-[10px] text-muted/60">
                      {settingsActive ? '·' : ''}
                    </span>
                  ) : null
                }
              />
            );
          })}
        </nav>

        {settingsActive ? (
          <div className="relative mt-2 pl-3">
            <span
              className="absolute bottom-1 left-[15px] top-1 w-px bg-border"
              aria-hidden="true"
            />
            <div className="space-y-4">
              {settingsGroups.map((group) => (
                <div key={group.label}>
                  <p className="mb-1 px-2.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted/70">
                    {group.label}
                  </p>
                  <nav aria-label={`${group.label}设置`} className="space-y-0.5">
                    {group.items.map((item) => {
                      const active = item.match ? item.match(path) : path === item.href;
                      return (
                        <NavLink
                          key={item.href}
                          href={item.href}
                          label={item.label}
                          icon={item.icon}
                          active={active}
                          onNavigate={onNavigate}
                          child
                        />
                      );
                    })}
                  </nav>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-6 border-t border-border pt-4">
          <a
            href="#/snowluma"
            onClick={(event) => {
              event.preventDefault();
              requestNavigation('/snowluma');
              onNavigate?.();
            }}
            className="focus-ring flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
          >
            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0">
              <span className="block text-[12px] font-medium">网关与日志</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-muted/80">
                排查 OneBot 连接问题
              </span>
            </span>
          </a>
        </div>
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <div className="rounded-lg border border-border bg-surface p-3 shadow-card">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">
              连接状态
            </span>
            <Badge variant={connected ? 'success' : 'neutral'} className="px-1.5 py-0">
              {connected ? '在线' : '离线'}
            </Badge>
          </div>
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2 text-[11.5px]">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  snowlumaRunning ? 'bg-success' : 'bg-muted/50',
                )}
                aria-hidden="true"
              />
              <span className="text-muted">SnowLuma</span>
              <span className="ml-auto text-foreground">
                {snowlumaRunning ? '运行中' : '未运行'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11.5px]">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  connected ? 'bg-success' : 'bg-warning',
                )}
                aria-hidden="true"
              />
              <span className="text-muted">OneBot</span>
              <span className="ml-auto truncate text-foreground">
                {connected ? status?.onebot.self?.nickname || '已连接' : '未连接'}
              </span>
            </div>
          </div>
        </div>
        <p className="mt-2 px-1 text-[10px] text-muted/70">控制台重构 · v0.1</p>
      </div>
    </div>
  );
}
