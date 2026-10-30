import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, MessageSquare, Save, Undo2 } from 'lucide-react';
import type { AppConfig } from '@/types';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { SaveStatus } from '@/components/save-status';
import { NumberField, ToggleRow } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface ChatDraft {
  wakeDelayMs: number;
  directWakeDelayMs: number;
  drainDelayMs: number;
  maxConcurrentRuns: number;
  send: AppConfig['send'];
  proactive: AppConfig['proactive'];
  sticker: AppConfig['sticker'];
  store: AppConfig['store'];
}

function pick(config: AppConfig): ChatDraft {
  return {
    wakeDelayMs: config.wakeDelayMs,
    directWakeDelayMs: config.directWakeDelayMs,
    drainDelayMs: config.drainDelayMs,
    maxConcurrentRuns: config.maxConcurrentRuns,
    send: { ...config.send },
    proactive: { ...config.proactive },
    sticker: { ...config.sticker },
    store: { ...config.store },
  };
}

export function ChatSettingsPage() {
  const settings = useSettingsConfig();
  const [draft, setDraft] = useState<ChatDraft | null>(null);
  const [baseline, setBaseline] = useState('');

  useEffect(() => {
    if (!settings.config) return;
    const next = pick(settings.config);
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [settings.config]);

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!draft) return result;
    if (draft.wakeDelayMs < 0) result.wakeDelayMs = '不能小于 0';
    if (draft.directWakeDelayMs < 0) result.directWakeDelayMs = '不能小于 0';
    if (draft.drainDelayMs < 0) result.drainDelayMs = '不能小于 0';
    if (draft.maxConcurrentRuns < 1 || draft.maxConcurrentRuns > 8) {
      result.maxConcurrentRuns = '范围 1–8';
    }
    if (draft.send.minGapMs < 200) result.minGapMs = '不能小于 200ms';
    if (draft.send.maxGapMs < draft.send.minGapMs) result.maxGapMs = '不能小于最小间隔';
    if (draft.send.maxPerMinute < 1) result.maxPerMinute = '至少 1 条/分钟';
    if (draft.proactive.checkIntervalMinMs < 60_000) result.proMin = '不能小于 60000ms';
    if (draft.proactive.checkIntervalMaxMs < draft.proactive.checkIntervalMinMs) {
      result.proMax = '不能小于检查间隔下限';
    }
    if (draft.proactive.probability < 0 || draft.proactive.probability > 1) {
      result.probability = '范围 0–1';
    }
    if (draft.store.pastStateLimit < 10 || draft.store.pastStateLimit > 500) {
      result.pastLimit = '范围 10–500';
    }
    if (draft.store.pastStateMaxChars < 1000 || draft.store.pastStateMaxChars > 60_000) {
      result.pastChars = '范围 1000–60000';
    }
    return result;
  }, [draft]);
  const invalid = Object.keys(errors).length > 0;

  const update = (patch: Partial<ChatDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!draft || invalid) return;
    const next = await settings.save({
      wakeDelayMs: draft.wakeDelayMs,
      directWakeDelayMs: draft.directWakeDelayMs,
      drainDelayMs: draft.drainDelayMs,
      maxConcurrentRuns: draft.maxConcurrentRuns,
      send: draft.send,
      proactive: draft.proactive,
      sticker: draft.sticker,
      store: draft.store,
    });
    if (next) setBaseline(JSON.stringify(pick(next)));
  };

  if (settings.phase === 'loading' || !draft) {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="mt-2 h-4 w-96" />
        <Skeleton className="mt-6 h-[560px] rounded-xl" />
      </div>
    );
  }

  if (settings.phase === 'error') {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="聊天设置" />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="聊天设置加载失败"
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
      <div className="mx-auto max-w-[960px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="聊天设置"
          description="回复节奏、发送保护、主动开话题与发给模型的历史预算。保存后下一次运行生效。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SaveStatus dirty={dirty} state={settings.saveState} />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDraft(JSON.parse(baseline) as ChatDraft)}
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
                保存设置
              </Button>
            </div>
          }
        />

        {settings.saveError || invalid ? (
          <div className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger" role="alert">
            {settings.saveError || `有 ${Object.keys(errors).length} 项参数需要修正。`}
          </div>
        ) : null}

        <div className="mt-5 space-y-5">
          <SectionCard
            icon={MessageSquare}
            title="运行节奏"
            description="控制消息聚批、批次间隔和并发处理数。"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="chat-wake-delay"
                label="普通群聊聚批窗口"
                value={draft.wakeDelayMs}
                onChange={(value) => update({ wakeDelayMs: value })}
                min={0}
                unit="ms"
                error={errors.wakeDelayMs}
                description="收到普通群聊消息后等待多久再启动一次运行。"
              />
              <NumberField
                id="chat-direct-delay"
                label="私聊 / @ / 引用快速响应"
                value={draft.directWakeDelayMs}
                onChange={(value) => update({ directWakeDelayMs: value })}
                min={0}
                unit="ms"
                error={errors.directWakeDelayMs}
              />
              <NumberField
                id="chat-drain-delay"
                label="批次间隔"
                value={draft.drainDelayMs}
                onChange={(value) => update({ drainDelayMs: value })}
                min={0}
                unit="ms"
                error={errors.drainDelayMs}
                description="上一轮结束到下一轮处理的间隔。"
              />
              <NumberField
                id="chat-max-runs"
                label="同时处理几个会话"
                value={draft.maxConcurrentRuns}
                onChange={(value) => update({ maxConcurrentRuns: value })}
                min={1}
                max={8}
                unit="个"
                error={errors.maxConcurrentRuns}
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={MessageSquare}
            title="发送保护"
            description="控制机器人连续发消息的频率，避免刷屏或被风控。"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField
                id="chat-min-gap"
                label="相邻消息最小间隔"
                value={draft.send.minGapMs}
                onChange={(value) => update({ send: { ...draft.send, minGapMs: value } })}
                min={200}
                unit="ms"
                error={errors.minGapMs}
              />
              <NumberField
                id="chat-max-gap"
                label="相邻消息最大间隔"
                value={draft.send.maxGapMs}
                onChange={(value) => update({ send: { ...draft.send, maxGapMs: value } })}
                min={500}
                unit="ms"
                error={errors.maxGapMs}
              />
              <NumberField
                id="chat-max-per-minute"
                label="每分钟最多发送"
                value={draft.send.maxPerMinute}
                onChange={(value) => update({ send: { ...draft.send, maxPerMinute: value } })}
                min={1}
                unit="条"
                error={errors.maxPerMinute}
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={MessageSquare}
            title="主动开话题"
            description="冷场时按概率主动开话题；关闭后只在收到消息时运行。"
          >
            <ToggleRow
              id="chat-proactive"
              title="冷场时按概率主动开话题"
              description="开启后会按检查间隔寻找冷场机会。"
              checked={draft.proactive.enabled}
              onCheckedChange={(checked) =>
                update({ proactive: { ...draft.proactive, enabled: checked } })
              }
            />
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <NumberField
                id="chat-pro-min"
                label="检查间隔下限"
                value={draft.proactive.checkIntervalMinMs}
                onChange={(value) =>
                  update({ proactive: { ...draft.proactive, checkIntervalMinMs: value } })
                }
                min={60_000}
                unit="ms"
                error={errors.proMin}
                disabled={!draft.proactive.enabled}
              />
              <NumberField
                id="chat-pro-max"
                label="检查间隔上限"
                value={draft.proactive.checkIntervalMaxMs}
                onChange={(value) =>
                  update({ proactive: { ...draft.proactive, checkIntervalMaxMs: value } })
                }
                min={120_000}
                unit="ms"
                error={errors.proMax}
                disabled={!draft.proactive.enabled}
              />
              <NumberField
                id="chat-pro-probability"
                label="触发概率"
                value={draft.proactive.probability}
                onChange={(value) =>
                  update({ proactive: { ...draft.proactive, probability: value } })
                }
                min={0}
                max={1}
                step={0.05}
                error={errors.probability}
                disabled={!draft.proactive.enabled}
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={MessageSquare}
            title="表情包与历史记录"
            description="控制表情包工具和每次运行携带的历史记录预算。"
          >
            <ToggleRow
              id="chat-sticker"
              title="启用表情包"
              description="收藏表情同步 + 发送工具；关闭后模型无法发送收藏表情。"
              checked={draft.sticker.enabled}
              onCheckedChange={(checked) => update({ sticker: { enabled: checked } })}
            />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <NumberField
                id="chat-past-limit"
                label="历史消息最多条数"
                value={draft.store.pastStateLimit}
                onChange={(value) =>
                  update({ store: { ...draft.store, pastStateLimit: value } })
                }
                min={10}
                max={500}
                unit="条"
                error={errors.pastLimit}
              />
              <NumberField
                id="chat-past-chars"
                label="历史记录字符预算"
                value={draft.store.pastStateMaxChars}
                onChange={(value) =>
                  update({ store: { ...draft.store, pastStateMaxChars: value } })
                }
                min={1000}
                max={60000}
                step={500}
                unit="字符"
                error={errors.pastChars}
                description="超出预算时从最旧的消息开始丢弃。"
              />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
