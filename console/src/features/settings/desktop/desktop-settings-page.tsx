import { useEffect, useState } from 'react';
import { AlertCircle, Monitor, Save, Undo2 } from 'lucide-react';
import type { AppConfig } from '@/types';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { SaveStatus } from '@/components/save-status';
import { ToggleRow } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type DesktopDraft = AppConfig['server'];

export function DesktopSettingsPage() {
  const settings = useSettingsConfig();
  const [draft, setDraft] = useState<DesktopDraft | null>(null);
  const [baseline, setBaseline] = useState('');

  useEffect(() => {
    if (!settings.config) return;
    const next = { ...settings.config.server };
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [settings.config]);

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);

  const save = async () => {
    if (!draft) return;
    const next = await settings.save({ server: draft });
    if (next) setBaseline(JSON.stringify(next.server));
  };

  if (settings.phase === 'loading' || !draft) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="mt-2 h-4 w-80" />
        <Skeleton className="mt-6 h-52 rounded-xl" />
      </div>
    );
  }

  if (settings.phase === 'error') {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="桌面端" />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="桌面端配置加载失败"
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
      <div className="mx-auto max-w-[760px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="桌面端"
          description="开机自启、关闭行为和常驻托盘设置。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SaveStatus dirty={dirty} state={settings.saveState} />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDraft(JSON.parse(baseline) as DesktopDraft)}
                disabled={!dirty || settings.saveState === 'saving'}
              >
                <Undo2 />
                放弃更改
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void save()}
                disabled={!dirty || settings.saveState === 'saving'}
              >
                <Save />
                保存桌面设置
              </Button>
            </div>
          }
        />

        {settings.saveError ? (
          <div className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger" role="alert">
            {settings.saveError}
          </div>
        ) : null}

        <SectionCard
          className="mt-5"
          icon={Monitor}
          title="启动与关闭"
          description="这些设置影响 Electron 桌面端的行为。"
        >
          <div className="space-y-3">
            <ToggleRow
              id="desktop-autostart"
              title="开机自启"
              description="登录 Windows 后自动运行 QQ Agent。"
              checked={draft.autoStart}
              onCheckedChange={(checked) => setDraft({ ...draft, autoStart: checked })}
            />
            <ToggleRow
              id="desktop-tray"
              title="点关闭时最小化到托盘"
              description="关闭后机器人继续常驻；从托盘菜单可真正退出。"
              checked={draft.closeToTray}
              onCheckedChange={(checked) => setDraft({ ...draft, closeToTray: checked })}
            />
          </div>
          <p className="mt-3 text-[10.5px] leading-4 text-muted">
            修改后立即写入配置；开机自启会在保存后同步到系统登录项。
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
