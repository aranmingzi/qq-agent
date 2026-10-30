import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, FolderOpen, Plug, Save, Undo2 } from 'lucide-react';
import type { SnowlumaConfig } from '@/types';
import { api } from '@/lib/api';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { useToast } from '@/providers/toast-provider';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { SaveStatus } from '@/components/save-status';
import { TextField, ToggleRow } from '@/components/settings-field';
import { SecretInput } from '@/features/settings/model-api/secret-input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function OneBotSettingsPage() {
  const settings = useSettingsConfig();
  const toast = useToast();
  const [draft, setDraft] = useState<SnowlumaConfig | null>(null);
  const [baseline, setBaseline] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [httpToken, setHttpToken] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!settings.config) return;
    const next = { ...settings.config.snowluma };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setAccessToken('');
    setHttpToken('');
  }, [settings.config]);

  const dirty = Boolean(
    draft &&
      (JSON.stringify(draft) !== baseline ||
        accessToken.trim().length > 0 ||
        httpToken.trim().length > 0),
  );
  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!draft) return result;
    if (draft.wsUrl && !/^wss?:\/\//i.test(draft.wsUrl)) result.wsUrl = '应以 ws:// 或 wss:// 开头';
    if (draft.httpUrl && !/^https?:\/\//i.test(draft.httpUrl)) result.httpUrl = '应以 http:// 或 https:// 开头';
    return result;
  }, [draft]);
  const invalid = Object.keys(errors).length > 0;

  const save = async () => {
    if (!draft || invalid) return;
    const next = await settings.save({
      snowluma: {
        dir: draft.dir.trim(),
        autoLaunch: draft.autoLaunch,
        wsUrl: draft.wsUrl.trim(),
        httpUrl: draft.httpUrl.trim(),
        ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
        ...(httpToken.trim() ? { httpAccessToken: httpToken.trim() } : {}),
      },
    });
    if (next) {
      setDraft({ ...next.snowluma });
      setBaseline(JSON.stringify(next.snowluma));
      setAccessToken('');
      setHttpToken('');
    }
  };

  const openFolder = async () => {
    setOpening(true);
    try {
      if (settings.mode === 'demo') {
        toast({ title: '演示模式不打开文件夹', variant: 'info' });
      } else {
        await api.openSnowlumaFolder();
      }
    } catch (error) {
      toast({
        title: '打开文件夹失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setOpening(false);
    }
  };

  if (settings.phase === 'loading' || !draft) {
    return (
      <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-2 h-4 w-96" />
        <Skeleton className="mt-6 h-[440px] rounded-xl" />
      </div>
    );
  }

  if (settings.phase === 'error') {
    return (
      <div className="mx-auto max-w-[900px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="OneBot" />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="OneBot 配置加载失败"
            description={settings.error || '请稍后重试。'}
            action={
              <Button variant="secondary" size="sm" onClick={() => void settings.load()}>
                重新加载
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[900px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="OneBot"
          description="SnowLuma 协议端目录、WebSocket / HTTP 地址与访问令牌。修改连接地址后需要重启应用生效。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SaveStatus dirty={dirty} state={settings.saveState} />
              <Button variant="ghost" size="sm" onClick={() => void openFolder()} disabled={opening}>
                <FolderOpen />
                打开目录
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(JSON.parse(baseline) as SnowlumaConfig);
                  setAccessToken('');
                  setHttpToken('');
                }}
                disabled={!dirty || settings.saveState === 'saving'}
              >
                <Undo2 />
                放弃更改
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void save()}
                disabled={!dirty || invalid || settings.saveState === 'saving'}
              >
                <Save />
                保存 OneBot
              </Button>
            </div>
          }
        />

        {settings.saveError || invalid ? (
          <div className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger" role="alert">
            {settings.saveError || `有 ${Object.keys(errors).length} 项需要修正。`}
          </div>
        ) : null}

        <SectionCard
          className="mt-5"
          icon={Plug}
          title="SnowLuma 程序"
          description="留空时自动使用项目内 snowluma/ 文件夹。"
        >
          <div className="space-y-4">
            <TextField
              id="onebot-dir"
              label="程序目录"
              value={draft.dir}
              onChange={(value) => setDraft({ ...draft, dir: value })}
              placeholder="C:\\QQagent\\snowluma"
              mono
              description="SnowLuma 的启动与日志已移动到顶部「SnowLuma」页签。"
            />
            <ToggleRow
              id="onebot-autolaunch"
              title="QQ Agent 启动时自动拉起 SnowLuma"
              description="仅在 SnowLuma 未运行时启动。"
              checked={draft.autoLaunch}
              onCheckedChange={(checked) => setDraft({ ...draft, autoLaunch: checked })}
            />
          </div>
        </SectionCard>

        <SectionCard
          className="mt-4"
          icon={Plug}
          title="连接配置"
          description="WebSocket 用于收消息，HTTP 用于发消息。令牌以掩码保存，输入新值才会替换。"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="onebot-ws"
              label="WebSocket 地址（收消息）"
              value={draft.wsUrl}
              onChange={(value) => setDraft({ ...draft, wsUrl: value })}
              placeholder="ws://127.0.0.1:3001"
              mono
              error={errors.wsUrl}
            />
            <TextField
              id="onebot-http"
              label="HTTP 地址（发消息）"
              value={draft.httpUrl}
              onChange={(value) => setDraft({ ...draft, httpUrl: value })}
              placeholder="http://127.0.0.1:3000"
              mono
              error={errors.httpUrl}
            />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <SecretInput
              id="onebot-access-token"
              label="WebSocket 令牌"
              configured={Boolean(draft.accessToken)}
              hint={draft.accessToken}
              value={accessToken}
              onChange={setAccessToken}
              placeholder="输入 WebSocket 访问令牌"
              description="已保存的令牌不会回传；留空表示保留原值。"
            />
            <SecretInput
              id="onebot-http-token"
              label="HTTP 令牌"
              configured={Boolean(draft.httpAccessToken)}
              hint={draft.httpAccessToken}
              value={httpToken}
              onChange={setHttpToken}
              placeholder="与 WS 不同时填写"
              description="SnowLuma 默认把 WS / HTTP 令牌分开。"
            />
          </div>
          <p className="mt-3 text-[10.5px] leading-4 text-muted">
            修改 WebSocket / HTTP 地址后需要重启应用；令牌与地址保存后会写入配置。
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
