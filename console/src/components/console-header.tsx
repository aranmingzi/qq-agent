import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  Cpu,
  Database,
  ExternalLink,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Power,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { AppStatus } from '@/types';
import { api } from '@/lib/api';
import { formatNumber, formatTokens } from '@/lib/format';
import { isIntegratedConsole, openLegacyConsole } from '@/lib/integration';
import { titleForPath } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { useToast } from '@/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ConsoleHeaderProps {
  path: string;
  status: AppStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  onOpenSidebar: () => void;
  onRefreshStatus: () => void;
}

export function ConsoleHeader({
  path,
  status,
  statusLoading,
  statusError,
  onOpenSidebar,
  onRefreshStatus,
}: ConsoleHeaderProps) {
  const { mode, changing, changeMode } = useConsoleMode();
  const toast = useToast();
  const [paused, setPaused] = useState(status?.paused ?? false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const { title, section } = titleForPath(path);

  useEffect(() => {
    setPaused(status?.paused ?? false);
  }, [status?.paused]);

  const connected = status?.onebot.connected ?? false;
  const accountOnline = status?.onebot.account.online;
  const account = status?.onebot.self;
  const usage = status?.usage;
  const model = status?.orchestrator.model || '未选择';

  const togglePause = async () => {
    if (mode === 'demo') {
      setPaused((value) => !value);
      setPauseOpen(false);
      toast({
        title: paused ? '演示模式：已继续' : '演示模式：已暂停',
        description: '仅切换本地演示状态，未调用 QQ Agent 后端。',
        variant: 'info',
      });
      return;
    }

    setPending(true);
    try {
      await api.pause(!paused);
      setPaused((value) => !value);
      setPauseOpen(false);
      toast({
        title: paused ? '已继续处理消息' : '已暂停机器人',
        description: paused ? '新的消息会恢复正常处理。' : '正在运行的任务不受影响。',
        variant: 'success',
      });
      onRefreshStatus();
    } catch (error) {
      toast({
        title: '操作失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };

  const restart = async () => {
    setRestartOpen(false);
    if (mode === 'demo') {
      toast({
        title: '演示模式不执行重启',
        description: '连接本地服务后，重启会重新拉起 SnowLuma 与 OneBot。',
        variant: 'info',
      });
      return;
    }
    setPending(true);
    try {
      await api.restart();
      toast({
        title: '已发送重启请求',
        description: '服务可能短暂不可用，控制台会自动重试。',
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: '重启失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <header className="z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-md lg:px-6">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onOpenSidebar}
          aria-label="打开导航"
        >
          <Menu />
        </Button>

        <div className="min-w-0 shrink">
          <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted/80">
            {section}
          </p>
          <h1 className="truncate text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground">
            {title}
          </h1>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
          {/* QQ 账号 */}
          {account ? (
            <Tooltip
              content={`QQ ${account.userId} · ${accountOnline === false ? '账号离线' : '账号在线'}`}
            >
              <div className="hidden items-center gap-2 rounded-lg px-1.5 py-1 lg:flex">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary ring-1 ring-primary/10">
                  {account.nickname.slice(0, 1)}
                </span>
                <span className="hidden max-w-[84px] truncate text-[12px] font-medium text-foreground xl:block">
                  {account.nickname}
                </span>
              </div>
            </Tooltip>
          ) : (
            <div className="hidden items-center gap-2 px-1.5 lg:flex">
              <span className="h-7 w-7 animate-pulse rounded-full bg-border" />
              <span className="hidden h-3 w-12 animate-pulse rounded bg-border xl:block" />
            </div>
          )}

          <span className="hidden h-5 w-px bg-border sm:block" />

          {/* 连接状态 */}
          <Tooltip
            content={
              statusError
                ? `状态读取失败：${statusError}`
                : connected
                  ? `OneBot 已连接${account?.nickname ? ` · ${account.nickname}` : ''}${
                      accountOnline === false ? '，但 QQ 账号已离线' : ''
                    }`
                  : 'OneBot 未连接，请到 SnowLuma 页签检查网关'
            }
          >
            <button
              type="button"
              onClick={onRefreshStatus}
              className="focus-ring flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-[12px] text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
              aria-label="刷新连接状态"
            >
              {statusLoading ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : connected && accountOnline !== false ? (
                <Wifi className="h-3.5 w-3.5 text-success" />
              ) : (
                <WifiOff className={cn('h-3.5 w-3.5', statusError ? 'text-danger' : 'text-warning')} />
              )}
              <span className="hidden sm:inline">
                {statusError ? '状态异常' : connected ? '已连接' : '未连接'}
              </span>
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full sm:hidden',
                  statusError ? 'bg-danger' : connected ? 'bg-success' : 'bg-warning',
                )}
                aria-hidden="true"
              />
            </button>
          </Tooltip>

          {/* 模型 */}
          <Tooltip content={`当前模型：${model}`}>
            <div className="hidden h-8 items-center gap-1.5 rounded-lg px-1.5 text-[12px] md:flex">
              <Cpu className="h-3.5 w-3.5 text-muted" />
              <span className="hidden text-muted xl:inline">模型</span>
              <span className="max-w-[120px] truncate font-mono text-[11.5px] text-foreground">
                {model}
              </span>
            </div>
          </Tooltip>

          {/* Token 用量 */}
          <Tooltip
            content={
              usage ? (
                <span className="block leading-5">
                  <span className="block font-medium text-foreground">今日用量</span>
                  <span className="block">运行 {formatNumber(usage.runs)} 次</span>
                  <span className="block">
                    输入 {formatNumber(usage.promptTokens)} tokens
                  </span>
                  <span className="block">
                    输出 {formatNumber(usage.completionTokens)} tokens
                  </span>
                  <span className="block">
                    合计 {formatNumber(usage.totalTokens)} tokens
                  </span>
                </span>
              ) : (
                '用量数据未加载'
              )
            }
          >
            <div className="hidden h-8 items-center gap-1.5 rounded-lg px-1.5 text-[12px] xl:flex">
              <span className="text-muted">今日</span>
              <span className="tabular-nums text-foreground">
                {usage ? `${formatNumber(usage.runs)} 次` : '—'}
              </span>
              <span className="text-border-strong">·</span>
              <span className="tabular-nums text-foreground">
                {usage ? `${formatTokens(usage.totalTokens)} tokens` : '—'}
              </span>
            </div>
          </Tooltip>

          {paused ? (
            <Badge variant="warning" className="hidden md:inline-flex">
              已暂停
            </Badge>
          ) : null}

          <span className="hidden h-5 w-px bg-border sm:block" />

          {/* 数据源 */}
          <DropdownMenu>
            <Tooltip content={mode === 'demo' ? '当前使用演示数据' : '当前连接本地 QQ Agent'}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="focus-ring flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 text-[11.5px] font-medium text-foreground shadow-sm transition-colors hover:bg-surface-muted"
                  aria-label={`切换数据源，当前${mode === 'demo' ? '演示数据' : '本地服务'}`}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      mode === 'demo' ? 'bg-warning' : 'bg-success',
                    )}
                    aria-hidden="true"
                  />
                  <Database className="h-3.5 w-3.5 text-muted" />
                  <span className="hidden lg:inline">
                    {mode === 'demo' ? '演示数据' : '本地服务'}
                  </span>
                  <ChevronDown className="h-3 w-3 text-muted" />
                </button>
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>数据源</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => void changeMode('demo')}
                disabled={changing}
                className="items-start"
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warning-soft text-warning">
                  <Database className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[12.5px] font-medium">
                    演示数据
                    {mode === 'demo' ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                    固定快照，操作只更新本地状态，不写入后端。
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void changeMode('live')}
                disabled={changing}
                className="items-start"
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-success-soft text-success">
                  <Wifi className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[12.5px] font-medium">
                    连接本地服务
                    {mode === 'live' ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                    读取 127.0.0.1:3210。保存、暂停、重置会写入真实运行状态。
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <p className="px-2.5 py-2 text-[10.5px] leading-4 text-muted">
                密钥始终以掩码展示；演示模式不会发起登录、保存或模型调用。
              </p>
            </DropdownMenuContent>
          </DropdownMenu>

          <ThemeToggle />

          <Button
            variant={paused ? 'subtle' : 'ghost'}
            size="sm"
            onClick={() => (paused ? void togglePause() : setPauseOpen(true))}
            disabled={pending}
            aria-label={paused ? '继续机器人' : '暂停机器人'}
            className={cn(paused ? 'gap-1.5' : 'gap-1.5')}
          >
            {pending ? (
              <RefreshCw className="animate-spin" />
            ) : paused ? (
              <Play />
            ) : (
              <Pause />
            )}
            <span className="hidden lg:inline">{paused ? '继续' : '暂停'}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="更多操作">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>控制台</DropdownMenuLabel>
              <DropdownMenuItem onSelect={onRefreshStatus}>
                <RefreshCw className="h-3.5 w-3.5 text-muted" />
                刷新状态
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRestartOpen(true)}>
                <Power className="h-3.5 w-3.5 text-muted" />
                重启机器人
              </DropdownMenuItem>
              {isIntegratedConsole() ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={openLegacyConsole}>
                    <ExternalLink className="h-3.5 w-3.5 text-muted" />
                    旧版控制台（兼容）
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <ConfirmDialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title="暂停机器人？"
        description={
          <>
            暂停后不再处理新的 QQ 消息，正在运行的任务不受影响。恢复后会自动继续。
            {mode === 'demo' ? '（演示模式，仅切换本地状态）' : ''}
          </>
        }
        confirmLabel="暂停"
        tone="danger"
        loading={pending}
        onConfirm={togglePause}
      />

      <ConfirmDialog
        open={restartOpen}
        onOpenChange={setRestartOpen}
        title="重启机器人？"
        description="会重新拉起 SnowLuma 与 OneBot，正在处理的消息可能中断。控制台会短暂失去连接。"
        confirmLabel="重启"
        tone="danger"
        loading={pending}
        onConfirm={restart}
      />
    </>
  );
}
