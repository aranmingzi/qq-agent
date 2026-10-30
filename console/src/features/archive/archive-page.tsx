import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Archive,
  CheckCheck,
  ExternalLink,
  Inbox,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { ChatMessage, ChatSummary } from '@/types';
import { api } from '@/lib/api';
import { demoChatMessages, demoChats, demoMoods } from '@/lib/demo-data';
import { chatLabel, formatDateTime, formatNumber } from '@/lib/format';
import { isIntegratedConsole, openLegacyConsole } from '@/lib/integration';
import { cn, sleep } from '@/lib/utils';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { useToast } from '@/providers/toast-provider';
import { useMediaQuery } from '@/hooks/use-media-query';
import { MoodBadge } from '@/components/mood-badge';
import { EmptyState } from '@/components/empty-state';
import { QqMessageText } from '@/components/qq-message-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ConfirmDialog,
} from '@/components/ui/dialog';

function useArchive() {
  const { mode } = useConsoleMode();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagePhase, setMessagePhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [messageError, setMessageError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const autoSelected = useRef(false);

  const loadChats = useCallback(
    async (quiet = false) => {
      if (!quiet) setPhase('loading');
      else setRefreshing(true);
      try {
        let next: ChatSummary[];
        if (mode === 'demo') {
          await sleep(180);
          next = demoChats.map((chat) => ({
            ...chat,
            mood: chat.mood ?? demoMoods[chat.chatKey] ?? null,
          }));
        } else {
          const [list, moods] = await Promise.all([api.chats(), api.moods()]);
          next = list.map((chat) => ({
            ...chat,
            mood: moods[chat.chatKey] ?? chat.mood ?? null,
          }));
        }
        setChats(next);
        setPhase('ready');
        setError(null);
      } catch (cause) {
        setPhase('error');
        setError(cause instanceof Error ? cause.message : '消息存档加载失败');
      } finally {
        setRefreshing(false);
      }
    },
    [mode],
  );

  useEffect(() => {
    autoSelected.current = false;
    setSelectedKey(null);
    setMessages([]);
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (!isDesktop || phase !== 'ready' || autoSelected.current) return;
    autoSelected.current = true;
    if (chats[0]) setSelectedKey(chats[0].chatKey);
  }, [chats, isDesktop, phase]);

  const loadMessages = useCallback(
    async (chatKey: string) => {
      setMessagePhase('loading');
      setMessageError(null);
      try {
        let next: ChatMessage[];
        if (mode === 'demo') {
          await sleep(160);
          next = demoChatMessages[chatKey] ?? [];
        } else {
          next = await api.chatMessages(chatKey, 200);
        }
        setMessages(next);
        setMessagePhase('ready');
      } catch (cause) {
        setMessagePhase('error');
        setMessageError(cause instanceof Error ? cause.message : '消息加载失败');
      }
    },
    [mode],
  );

  useEffect(() => {
    if (!selectedKey) return;
    void loadMessages(selectedKey);
  }, [selectedKey, loadMessages]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return chats.filter((chat) => {
      if (unreadOnly && chat.unread <= 0) return false;
      if (!keyword) return true;
      return (
        chatLabel(chat.chatKey).toLowerCase().includes(keyword) ||
        chat.chatKey.toLowerCase().includes(keyword) ||
        chat.lastText.toLowerCase().includes(keyword)
      );
    });
  }, [chats, query, unreadOnly]);

  const selectedChat = chats.find((chat) => chat.chatKey === selectedKey) ?? null;

  return {
    mode,
    chats,
    filtered,
    selectedKey,
    setSelectedKey,
    selectedChat,
    messages,
    messagePhase,
    messageError,
    retryMessages: () => (selectedKey ? loadMessages(selectedKey) : Promise.resolve()),
    phase,
    error,
    refreshing,
    reload: loadChats,
    query,
    setQuery,
    unreadOnly,
    setUnreadOnly,
  };
}

export function ArchivePage() {
  const archive = useArchive();
  const toast = useToast();
  const [pending, setPending] = useState<'wake' | 'read' | 'send' | ''>('');
  const [wakeOpen, setWakeOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendText, setSendText] = useState('');

  const current = archive.selectedChat;

  const runWake = async () => {
    if (!current) return;
    setWakeOpen(false);
    if (archive.mode === 'demo') {
      toast({
        title: '演示模式不触发运行',
        description: '连接本地服务后，唤醒会真实调用模型并可能产生费用。',
        variant: 'info',
      });
      return;
    }
    setPending('wake');
    try {
      const result = await api.wakeChat(current.chatKey);
      toast({
        title: result.ok ? '已请求唤醒会话' : '会话当前无需唤醒',
        description: result.ok ? '模型会处理当前未读消息。' : '可能没有未读消息或已在运行。',
        variant: result.ok ? 'success' : 'info',
      });
      await archive.reload(true);
    } catch (error) {
      toast({
        title: '唤醒失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setPending('');
    }
  };

  const runMarkRead = async () => {
    if (!current) return;
    setReadOpen(false);
    if (archive.mode === 'demo') {
      toast({
        title: '演示模式不修改未读状态',
        description: '连接本地服务后会真实清空该会话未读。',
        variant: 'info',
      });
      return;
    }
    setPending('read');
    try {
      const result = await api.markChatRead(current.chatKey);
      toast({
        title: '已标记为已读',
        description: `清空 ${result.marked ?? 0} 条未读消息。`,
        variant: 'success',
      });
      await archive.reload(true);
    } catch (error) {
      toast({
        title: '标记已读失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setPending('');
    }
  };

  const runSend = async () => {
    if (!current || !sendText.trim()) return;
    if (archive.mode === 'demo') {
      toast({
        title: '演示模式不发送 QQ 消息',
        description: '连接本地服务后，测试消息会真实发送到目标会话。',
        variant: 'info',
      });
      return;
    }
    setPending('send');
    try {
      await api.testSend(current.chatKey, sendText.trim());
      toast({
        title: '测试消息已发送',
        description: `已直接发送到 ${chatLabel(current.chatKey)}，未经过模型。`,
        variant: 'success',
      });
      setSendOpen(false);
      setSendText('');
      await archive.retryMessages();
      await archive.reload(true);
    } catch (error) {
      toast({
        title: '发送失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setPending('');
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <section
        className={cn(
          'flex min-h-0 w-full flex-col border-r border-border bg-surface lg:w-[344px] lg:shrink-0',
          archive.selectedKey ? 'hidden lg:flex' : 'flex',
        )}
        aria-label="存档会话列表"
      >
        <div className="shrink-0 border-b border-border px-4 pb-3 pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-[13px] font-semibold text-foreground">消息存档</h2>
              <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10.5px] tabular-nums text-muted">
                {archive.chats.length}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void archive.reload()}
              aria-label="刷新消息存档"
              disabled={archive.refreshing}
            >
              <RefreshCw className={archive.refreshing ? 'animate-spin' : ''} />
            </Button>
          </div>
          <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
            JSON 存档 · 已读/未读驱动 · 只读
          </p>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={archive.query}
              onChange={(event) => archive.setQuery(event.target.value)}
              placeholder="搜索群号、私聊或消息…"
              aria-label="搜索消息存档"
              className="h-8 pl-8 pr-8 text-[12.5px]"
            />
            {archive.query ? (
              <button
                type="button"
                onClick={() => archive.setQuery('')}
                aria-label="清空搜索"
                className="focus-ring absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-surface-muted"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => archive.setUnreadOnly(false)}
              aria-pressed={!archive.unreadOnly}
              className={cn(
                'focus-ring h-6 rounded-md px-2 text-[11.5px] transition-colors',
                !archive.unreadOnly
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-muted hover:bg-surface-muted',
              )}
            >
              全部
            </button>
            <button
              type="button"
              onClick={() => archive.setUnreadOnly(true)}
              aria-pressed={archive.unreadOnly}
              className={cn(
                'focus-ring h-6 rounded-md px-2 text-[11.5px] transition-colors',
                archive.unreadOnly
                  ? 'bg-primary-soft font-medium text-primary'
                  : 'text-muted hover:bg-surface-muted',
              )}
            >
              未读
              <span className="ml-1 text-[10px] tabular-nums text-muted">
                {archive.chats.filter((chat) => chat.unread > 0).length}
              </span>
            </button>
          </div>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {archive.phase === 'loading' ? (
            <div aria-busy="true">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="border-b border-border/70 px-4 py-3.5">
                  <div className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-14" />
                  </div>
                  <Skeleton className="mt-2.5 h-3 w-full" />
                  <Skeleton className="mt-1.5 h-3 w-2/3" />
                  <Skeleton className="mt-3 h-3 w-24" />
                </div>
              ))}
            </div>
          ) : archive.phase === 'error' ? (
            <EmptyState
              icon={AlertTriangle}
              title="消息存档加载失败"
              description={archive.error || '请稍后重试。'}
              compact
              action={
                <Button variant="secondary" size="sm" onClick={() => void archive.reload()}>
                  <RefreshCw />
                  重试
                </Button>
              }
            />
          ) : archive.filtered.length === 0 ? (
            <EmptyState
              icon={archive.query || archive.unreadOnly ? Inbox : Archive}
              title={archive.query || archive.unreadOnly ? '没有匹配的存档' : '暂无消息存档'}
              description={
                archive.query || archive.unreadOnly
                  ? '换一个关键词，或查看全部会话。'
                  : '机器人收到并归档消息后，会话会出现在这里。'
              }
              compact
            />
          ) : (
            <ul aria-label="存档会话列表" className="divide-y divide-border/70">
              {archive.filtered.map((chat) => {
                const active = chat.chatKey === archive.selectedKey;
                return (
                  <li key={chat.chatKey}>
                    <button
                      type="button"
                      onClick={() => archive.setSelectedKey(chat.chatKey)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'focus-ring group relative block w-full px-4 py-3.5 text-left transition-colors',
                        active
                          ? 'bg-primary-soft/55'
                          : 'hover:bg-surface-muted/70 focus-visible:bg-surface-muted/70',
                      )}
                    >
                      {active ? (
                        <span className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r-full bg-primary" />
                      ) : null}
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[13.5px] font-semibold text-foreground">
                            {chatLabel(chat.chatKey)}
                          </span>
                          {chat.unread > 0 ? (
                            <span className="rounded-full bg-primary px-1.5 py-px text-[9.5px] font-medium text-white">
                              {chat.unread}
                            </span>
                          ) : null}
                        </span>
                        <MoodBadge mood={chat.mood} className="shrink-0" />
                      </div>
                      <p
                        className={cn(
                          'mt-1 line-clamp-2 min-h-[2.5rem] text-[12.5px] leading-5',
                          chat.lastText ? 'text-muted' : 'italic text-muted/60',
                        )}
                      >
                        {chat.lastText || '（空）'}
                      </p>
                      <div className="mt-2 flex items-center gap-2 text-[10.5px] text-muted">
                        <span className="tabular-nums">{formatNumber(chat.total)} 条</span>
                        <span className="h-1 w-1 rounded-full bg-border-strong" />
                        <time className="tabular-nums" dateTime={new Date(chat.lastTs).toISOString()}>
                          {formatDateTime(chat.lastTs)}
                        </time>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2 text-[10.5px] text-muted">
          <span>显示 {archive.filtered.length} 个会话</span>
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3" />
            消息内容只读
          </span>
        </div>
      </section>

      <section
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col bg-background',
          archive.selectedKey ? 'flex' : 'hidden lg:flex',
        )}
        aria-label="存档详情"
      >
        {!archive.selectedKey ? (
          <EmptyState
            icon={Archive}
            title="选择一个会话查看消息存档"
            description="存档消息内容只读。唤醒与测试发送是显式操作，会真实触发模型或向 QQ 发送消息。"
          />
        ) : archive.messagePhase === 'loading' ? (
          <div className="mx-auto w-full max-w-[820px] animate-pulse px-5 py-6">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="mt-2 h-3.5 w-64" />
            <div className="mt-8 space-y-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton
                  key={index}
                  className={cn('h-16', index % 2 ? 'ml-auto w-2/3' : 'w-3/5')}
                />
              ))}
            </div>
          </div>
        ) : archive.messagePhase === 'error' ? (
          <EmptyState
            icon={AlertTriangle}
            title="消息加载失败"
            description={archive.messageError || '请稍后重试。'}
            action={
              <Button variant="secondary" size="sm" onClick={() => void archive.retryMessages()}>
                <RefreshCw />
                重试
              </Button>
            }
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:px-6">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden"
                  onClick={() => archive.setSelectedKey(null)}
                  aria-label="返回存档列表"
                >
                  <ArrowLeft />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-[15px] font-semibold text-foreground">
                      {chatLabel(archive.selectedChat?.chatKey ?? '')}
                    </h2>
                    <MoodBadge mood={archive.selectedChat?.mood} />
                    <Badge variant="outline">消息存档</Badge>
                    {(archive.selectedChat?.unread ?? 0) > 0 ? (
                      <Badge variant="warning">{archive.selectedChat?.unread} 条未读</Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted">
                    共 {formatNumber(archive.selectedChat?.total ?? 0)} 条消息 · 本次加载{' '}
                    {archive.messages.length} 条 · JSON 持久化
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setReadOpen(true)}
                    disabled={pending !== '' || (archive.selectedChat?.unread ?? 0) <= 0}
                  >
                    <CheckCheck />
                    标记已读
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setWakeOpen(true)}
                    disabled={pending !== ''}
                  >
                    <Sparkles />
                    唤醒一次
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSendOpen(true)}
                    disabled={pending !== ''}
                  >
                    <Send />
                    测试发送
                  </Button>
                </div>
              </div>
            </div>

            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-[820px] space-y-3 px-4 py-5 lg:px-8">
                {archive.messages.length ? (
                  archive.messages.map((message) => (
                    <div
                      key={message.mid || message.id}
                      className={cn('flex', message.self ? 'justify-end' : 'justify-start')}
                    >
                      <div
                        className={cn(
                          'max-w-[82%] rounded-lg border px-3.5 py-2.5',
                          message.self
                            ? 'border-primary/15 bg-primary-soft/60'
                            : 'border-border bg-surface shadow-card',
                        )}
                      >
                        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
                          <span className="font-medium text-foreground/75">
                            {message.senderName}
                          </span>
                          <time className="tabular-nums" dateTime={new Date(message.ts).toISOString()}>
                            {formatDateTime(message.ts)}
                          </time>
                          {message.reply ? (
                            <span className="rounded bg-surface-muted px-1">引用</span>
                          ) : null}
                        </div>
                        <QqMessageText
                          className="whitespace-pre-wrap break-words text-[12.5px] leading-6 text-foreground"
                          text={message.text || '（非文本消息）'}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState
                    icon={Inbox}
                    title="这个会话还没有消息"
                    description="消息归档后会显示在这里。"
                    compact
                  />
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border px-4 py-2 text-[10.5px] text-muted">
              <ShieldCheck className="h-3 w-3" />
              消息内容只读；唤醒 / 标记已读 / 测试发送都是显式写操作
              {isIntegratedConsole() ? (
                <button
                  type="button"
                  onClick={openLegacyConsole}
                  className="focus-ring ml-2 inline-flex items-center gap-1 rounded text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  旧版存档
                </button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={wakeOpen}
        onOpenChange={setWakeOpen}
        title="唤醒一次会话？"
        description={
          <>
            将立即用「{chatLabel(current?.chatKey ?? '')}」当前的未读消息触发一次模型运行，
            可能产生回复与 Token 费用。没有未读时通常不会启动。
          </>
        }
        confirmLabel="唤醒一次"
        loading={pending === 'wake'}
        onConfirm={runWake}
      />

      <ConfirmDialog
        open={readOpen}
        onOpenChange={setReadOpen}
        title="全部标为已读？"
        description="会清空该会话当前的未读标记，机器人不会再处理这些未读消息。消息原文仍保留在存档中。"
        confirmLabel="标记已读"
        tone="danger"
        loading={pending === 'read'}
        onConfirm={runMarkRead}
      />

      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发送测试消息</DialogTitle>
            <DialogDescription>
              直接经 OneBot 发送到「{chatLabel(current?.chatKey ?? '')}」，不经过模型。
              这是一次真实的 QQ 发送操作。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-3">
            <label
              htmlFor="archive-test-send"
              className="mb-1.5 block text-[12.5px] font-medium text-foreground"
            >
              消息内容
            </label>
            <Textarea
              id="archive-test-send"
              value={sendText}
              onChange={(event) => setSendText(event.target.value)}
              placeholder="输入要发送到该会话的文本…"
              className="min-h-[110px]"
            />
            <p className="mt-1.5 text-[10.5px] leading-4 text-muted">
              请确认目标会话与内容。发送后无法撤回。
            </p>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setSendOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => void runSend()}
              disabled={!sendText.trim() || pending === 'send'}
            >
              {pending === 'send' ? <RefreshCw className="animate-spin" /> : <Send />}
              确认发送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
