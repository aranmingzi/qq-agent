import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Database,
  Eye,
  FileText,
  KeyRound,
  Loader2,
  Network,
  Plug,
  PlugZap,
  Save,
  ShieldCheck,
  Settings2,
  SlidersHorizontal,
  Undo2,
  Zap,
} from 'lucide-react';
import type { BrainPreset } from '@/types';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tooltip } from '@/components/ui/tooltip';
import { RadioGroup } from '@/components/ui/radio-group';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PresetCard } from '@/features/settings/model-api/preset-card';
import { ParameterControl } from '@/features/settings/model-api/parameter-control';
import { SecretInput } from '@/features/settings/model-api/secret-input';
import { ProviderManagerDialog } from '@/features/settings/model-api/provider-manager-dialog';
import { useNavigationGuard } from '@/providers/navigation-guard-provider';
import {
  PARAM_LIMITS,
  useModelConfig,
  type ModelForm,
  type SaveState,
} from '@/features/settings/model-api/use-model-config';

function SaveIndicator({
  dirty,
  state,
  compact,
}: {
  dirty: boolean;
  state: SaveState;
  compact?: boolean;
}) {
  const meta =
    state === 'saving'
      ? { icon: Loader2, label: '保存中…', className: 'text-muted', spin: true }
      : state === 'error'
        ? { icon: AlertCircle, label: '保存失败', className: 'text-danger', spin: false }
        : dirty
          ? { icon: Circle, label: '未保存更改', className: 'text-warning', spin: false }
          : state === 'saved'
            ? { icon: CheckCircle2, label: '已保存', className: 'text-success', spin: false }
            : { icon: CheckCircle2, label: '已同步', className: 'text-muted', spin: false };
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11.5px]',
        meta.className,
        compact && 'text-[11px]',
      )}
      role="status"
    >
      <Icon className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function SwitchRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  badge,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-muted/35 px-3.5 py-3',
        disabled && 'opacity-60',
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id} className="cursor-pointer">
            {title}
          </Label>
          {badge}
        </div>
        <p className="mt-0.5 text-[11px] leading-5 text-muted">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="mt-0.5"
      />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[11px] text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[11.5px] font-medium text-foreground">{value}</dd>
    </div>
  );
}

function ModelPageSkeleton() {
  return (
    <div className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-5">
          {[320, 420, 120].map((height, index) => (
            <div key={index} className="rounded-xl border border-border bg-surface p-5 shadow-card">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="mt-2 h-3 w-64 max-w-full" />
              <Skeleton className="mt-5 w-full" style={{ height }} />
            </div>
          ))}
        </div>
        <div className="hidden xl:block">
          <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-4 h-32 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ModelApiPage() {
  const model = useModelConfig();
  const { registerGuard } = useNavigationGuard();
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const {
    form,
    bundle,
    provider,
    presets,
    matchedPreset,
    errors,
    allErrors,
    dirty,
    saveState,
    saveError,
    mode,
  } = model;

  /**
   * 管理面板的改动只做局部合并，不再重新加载配置，所以未保存的编辑不会被冲掉，
   * 也就不必先弹「会丢弃修改」的确认框了。
   */
  function openProviderManager() {
    setProviderManagerOpen(true);
  }

  useEffect(() => {
    registerGuard({ dirty, discard: model.discard });
    return () => registerGuard(null);
  }, [dirty, model.discard, registerGuard]);

  const modelOptions = useMemo(() => {
    if (!provider) return form?.model ? [form.model] : [];
    const list = [...provider.models];
    if (form?.model && !list.includes(form.model)) list.unshift(form.model);
    return list;
  }, [form?.model, provider]);

  if (model.phase === 'loading') return <ModelPageSkeleton />;

  if (model.phase === 'error' || !form || !bundle) {
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          <PageHeader
            title="模型 API"
            description="配置主模型、推理参数与路由策略。密钥只在保存时提交。"
          />
          <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
            <EmptyState
              icon={AlertCircle}
              title="模型配置加载失败"
              description={model.loadError || '请确认 QQ Agent 后端可用后重试。'}
              action={
                <Button variant="secondary" size="sm" onClick={() => void model.reload()}>
                  重新加载
                </Button>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  const savedPreset = form.preset
    ? presets.find((preset: BrainPreset) => preset.id === form.preset)
    : null;
  const keyError = errors.apiKey;
  const canTest =
    mode === 'demo' || Boolean(model.apiKeyValue.trim()) || model.canTestSaved;
  const testTone =
    model.testState === 'success'
      ? 'text-success'
      : model.testState === 'error'
        ? 'text-danger'
        : 'text-muted';

  const update = <K extends keyof ModelForm>(key: K, value: ModelForm[K]) =>
    model.setField(key, value);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-4 pb-8 pt-5 sm:px-6 lg:px-8 lg:pt-7">
        <PageHeader
          title="模型 API"
          description="配置主模型、推理参数与路由策略。预设只改参数，不覆盖已选模型；密钥仅在保存或测试时提交。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SaveIndicator dirty={dirty} state={saveState} />
              <Button
                variant="secondary"
                size="sm"
                onClick={model.discard}
                disabled={!dirty || saveState === 'saving'}
              >
                <Undo2 />
                放弃更改
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void model.save()}
                disabled={!dirty || saveState === 'saving'}
              >
                {saveState === 'saving' ? <Loader2 className="animate-spin" /> : <Save />}
                保存设置
              </Button>
            </div>
          }
        />

        {mode === 'demo' ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning/20 bg-warning-soft/70 px-3 py-2 text-[11.5px] leading-5 text-warning">
            <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              当前为演示数据。保存只会更新本地演示状态；测试连通性与获取模型列表不会发起真实请求。
            </span>
          </div>
        ) : null}

        {saveError ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] leading-5 text-danger"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{saveError}</span>
          </div>
        ) : null}

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-5">
            {/* 基础设置 */}
            <SectionCard
              id="model-basic"
              icon={Plug}
              title="基础设置"
              description="服务商、模型与接入密钥。修改后需要保存才会生效。"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="provider-select">服务商</Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5 text-[11px] text-muted hover:text-foreground"
                      onClick={openProviderManager}
                    >
                      <Settings2 aria-hidden="true" />
                      管理
                    </Button>
                  </div>
                  <Select value={form.providerId} onValueChange={model.changeProvider}>
                    <SelectTrigger id="provider-select" aria-label="服务商">
                      <SelectValue placeholder="选择服务商" />
                    </SelectTrigger>
                    <SelectContent>
                      {model.providers.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-4 text-muted">
                    {provider ? provider.baseURL : '尚未选择服务商'}
                  </p>
                  {errors.providerId ? (
                    <p className="text-[11px] text-danger">{errors.providerId}</p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="model-select">模型</Label>
                  <Select value={form.model} onValueChange={(value) => update('model', value)}>
                    <SelectTrigger id="model-select" aria-label="模型">
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((item) => (
                        <SelectItem key={item} value={item}>
                          {provider?.modelNames?.[item] ?? item}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-4 text-muted">
                    {provider?.models.length
                      ? `${provider.models.length} 个可用模型`
                      : '服务商目录为空，请先获取模型列表'}
                  </p>
                  {errors.model ? (
                    <p className="text-[11px] text-danger" role="alert">
                      {errors.model}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="base-url">Base URL</Label>
                  <div className="flex gap-2">
                    <Input
                      id="base-url"
                      value={form.baseUrl}
                      onChange={(event) => update('baseUrl', event.target.value)}
                      placeholder="https://api.example.com"
                      aria-invalid={Boolean(errors.baseUrl)}
                      className="font-mono text-[12px]"
                    />
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={() => void model.fetchModels()}
                      disabled={model.fetchState === 'running'}
                      className="shrink-0"
                    >
                      {model.fetchState === 'running' ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Network />
                      )}
                      获取列表
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4">
                    {errors.baseUrl ? (
                      <span className="text-danger" role="alert">
                        {errors.baseUrl}
                      </span>
                    ) : (
                      <span className="text-muted">OpenAI 兼容接口地址，末尾通常带 /v1</span>
                    )}
                    {model.fetchNote ? (
                      <span
                        className={cn(
                          model.fetchState === 'success' ? 'text-success' : 'text-danger',
                        )}
                      >
                        {model.fetchNote}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="md:col-span-2">
                  <SecretInput
                    id="api-key"
                    label="API Key"
                    configured={model.keyConfigured}
                    hint={model.keyHint}
                    value={model.apiKeyValue}
                    onChange={model.setApiKeyValue}
                    placeholder="输入服务商 API Key"
                    required
                    error={keyError}
                    description="密钥只用于模型请求，不写入日志、URL 或浏览器本地存储。已保存的密钥不会回传明文，输入新值即可替换。"
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Tooltip
                  content={
                    mode === 'live' && !model.apiKeyValue.trim() && !model.canTestSaved
                      ? '已保存的密钥不会回传。请输入一次新密钥，或使用未修改的已保存 Base URL 测试。'
                      : undefined
                  }
                >
                  <span className="inline-flex">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void model.testConnection()}
                      disabled={model.testState === 'running' || !canTest}
                    >
                      {model.testState === 'running' ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <PlugZap />
                      )}
                      测试连通性
                    </Button>
                  </span>
                </Tooltip>
                <div className={cn('flex min-w-0 items-center gap-1.5 text-[11.5px]', testTone)}>
                  {model.testState === 'success' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  ) : model.testState === 'error' ? (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  ) : model.testState === 'running' ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : null}
                  <span className="truncate">
                    {model.testState === 'running'
                      ? '正在请求模型…'
                      : model.testNote ||
                        (mode === 'demo'
                          ? '演示模式不会发起真实请求。'
                          : '使用当前输入或已保存密钥请求一次最小对话。')}
                  </span>
                </div>
                <div className="ml-auto flex items-center gap-1.5 text-[10.5px] text-muted">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  密钥不会写入日志
                </div>
              </div>
            </SectionCard>

            {/* 参数配置 */}
            <SectionCard
              id="model-parameters"
              icon={SlidersHorizontal}
              title="参数配置"
              description="预设会同步温度、输出上限、思考模式与工具轮数。手动修改后会立即显示是否仍匹配某个预设。"
            >
              <RadioGroup
                value={matchedPreset?.id ?? '__custom'}
                onValueChange={model.applyPreset}
                aria-label="大脑预设"
                className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
              >
                {presets.map((preset) => (
                  <PresetCard
                    key={preset.id}
                    preset={preset}
                    selected={matchedPreset?.id === preset.id}
                  />
                ))}
              </RadioGroup>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                {matchedPreset ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                    <span className="text-muted">
                      当前参数与「{matchedPreset.name}」一致
                    </span>
                  </>
                ) : (
                  <>
                    <SlidersHorizontal className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                    <span className="text-muted">当前为自定义参数</span>
                    {savedPreset ? (
                      <span className="text-muted/70">
                        · 已保存预设标记为「{savedPreset.name}」，但参数已被手动调整
                      </span>
                    ) : null}
                  </>
                )}
              </div>

              <Separator className="my-5" />

              <div className="grid gap-x-7 gap-y-5 md:grid-cols-2">
                <ParameterControl
                  id="temperature"
                  label="温度"
                  description="越高越随机，越低越稳定。日常闲聊建议 0.7–1.0。"
                  value={form.temperature}
                  onChange={(value) => update('temperature', value)}
                  min={PARAM_LIMITS.temperature.min}
                  max={PARAM_LIMITS.temperature.max}
                  step={PARAM_LIMITS.temperature.step}
                  error={errors.temperature}
                />
                <ParameterControl
                  id="max-rounds"
                  label="单次运行最大工具轮数"
                  description="模型在一次运行中最多可以连续调用多少轮工具。"
                  value={form.maxRounds}
                  onChange={(value) => update('maxRounds', value)}
                  min={PARAM_LIMITS.maxRounds.min}
                  max={PARAM_LIMITS.maxRounds.max}
                  step={PARAM_LIMITS.maxRounds.step}
                  unit="轮"
                  error={errors.maxRounds}
                />
                <ParameterControl
                  id="max-output"
                  label="普通聊天输出上限"
                  description="日常聊天单次输出的 token 上限。"
                  value={form.maxOutputTokens}
                  onChange={(value) => update('maxOutputTokens', value)}
                  min={PARAM_LIMITS.maxOutputTokens.min}
                  max={PARAM_LIMITS.maxOutputTokens.max}
                  step={PARAM_LIMITS.maxOutputTokens.step}
                  unit="tok"
                  error={errors.maxOutputTokens}
                />
                <ParameterControl
                  id="complex-max-output"
                  label="复杂任务输出上限"
                  description="代码、数学、长文等复杂任务单次输出的 token 上限。"
                  value={form.complexMaxOutputTokens}
                  onChange={(value) => update('complexMaxOutputTokens', value)}
                  min={PARAM_LIMITS.complexMaxOutputTokens.min}
                  max={PARAM_LIMITS.complexMaxOutputTokens.max}
                  step={PARAM_LIMITS.complexMaxOutputTokens.step}
                  unit="tok"
                  error={errors.complexMaxOutputTokens}
                />
              </div>

              <div className="mt-5">
                <SwitchRow
                  id="thinking-off"
                  title="关闭推理模型的思考"
                  description="开启后全程不思考，更快更省；关闭则为 auto，只有输出被截断时才兜底。预设会同步这个开关。"
                  checked={form.thinkingMode === 'off'}
                  onCheckedChange={(checked) => update('thinkingMode', checked ? 'off' : 'auto')}
                  badge={
                    <Badge variant={form.thinkingMode === 'off' ? 'warning' : 'neutral'}>
                      {form.thinkingMode === 'off' ? '全程不思考' : 'auto'}
                    </Badge>
                  }
                />
              </div>

              <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-4 text-muted">
                <Zap className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                参数范围与步长沿用当前后端支持的表单范围；模型级能力元数据尚未由接口提供，切换模型不会改变这些范围。
              </p>
            </SectionCard>

            {/* 高级路由 */}
            <SectionCard
              id="model-advanced"
              icon={Network}
              title="高级路由"
              description="默认折叠。复杂任务模型、识图与联网搜索按需展开。"
              contentClassName="px-5 py-0"
            >
              <Accordion type="multiple" defaultValue={[]}>
                <AccordionItem value="routing">
                  <AccordionTrigger>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                        模型路由
                        <Badge variant={form.routing.enabled ? 'success' : 'neutral'}>
                          {form.routing.enabled ? '已启用' : '已关闭'}
                        </Badge>
                      </span>
                      <span className="text-[11px] font-normal leading-5 text-muted">
                        复杂任务自动切到更强的模型；留空则始终使用当前模型。
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="complex-model">复杂任务模型（可选）</Label>
                      <Input
                        id="complex-model"
                        value={form.complexModel}
                        onChange={(event) => update('complexModel', event.target.value)}
                        placeholder="例如 deepseek-v4-pro"
                        className="font-mono text-[12px]"
                      />
                      <p className="text-[11px] leading-4 text-muted">
                        代码、数学、长文、文件和网页正文推理会切到这个模型；留空则始终使用普通聊天模型。
                      </p>
                    </div>
                    <SwitchRow
                      id="routing-enabled"
                      title="启用模型路由"
                      description="允许后端根据任务类型与复杂度选择模型。"
                      checked={form.routing.enabled}
                      onCheckedChange={(checked) =>
                        update('routing', { ...form.routing, enabled: checked })
                      }
                    />
                    <SwitchRow
                      id="routing-auto"
                      title="按问题复杂度自动选择"
                      description="关闭后只使用显式配置的复杂任务模型。"
                      checked={form.routing.auto}
                      onCheckedChange={(checked) =>
                        update('routing', { ...form.routing, auto: checked })
                      }
                      disabled={!form.routing.enabled}
                    />
                    <SwitchRow
                      id="routing-escalation"
                      title="允许模型主动请求深推理"
                      description="模型可在运行中请求升级到复杂任务模型。"
                      checked={form.routing.allowModelEscalation}
                      onCheckedChange={(checked) =>
                        update('routing', {
                          ...form.routing,
                          allowModelEscalation: checked,
                        })
                      }
                      disabled={!form.routing.enabled}
                    />
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="vision">
                  <AccordionTrigger>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                        识图与多模态
                        <Badge variant={form.vision ? 'success' : 'neutral'}>
                          {form.vision ? (form.visionMode === 'qwen' ? 'Qwen-VL' : '原生') : '已关闭'}
                        </Badge>
                      </span>
                      <span className="text-[11px] font-normal leading-5 text-muted">
                        图片输入、原生识图或独立 Qwen-VL 识图。
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-3">
                    <SwitchRow
                      id="vision-enabled"
                      title="允许图片输入"
                      description="关闭后移除看图工具，模型只会看到 [图片] 占位符。"
                      checked={form.vision}
                      onCheckedChange={(checked) => update('vision', checked)}
                    />
                    {form.vision ? (
                      <>
                        <div className="space-y-1.5">
                          <Label htmlFor="vision-mode">识图模式</Label>
                          <Select
                            value={form.visionMode}
                            onValueChange={(value) =>
                              update('visionMode', value as 'native' | 'qwen')
                            }
                          >
                            <SelectTrigger id="vision-mode" aria-label="识图模式">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="native">原生多模态（当前聊天模型直接看图）</SelectItem>
                              <SelectItem value="qwen">Qwen-VL 独立识图（主模型只接收文字）</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {form.visionMode === 'qwen' ? (
                          <div className="space-y-3 rounded-lg border border-border bg-surface-muted/30 p-3.5">
                            <div className="grid gap-3 md:grid-cols-2">
                              <div className="space-y-1.5">
                                <Label htmlFor="qwen-base-url">Qwen-VL Base URL</Label>
                                <Input
                                  id="qwen-base-url"
                                  value={form.qwenBaseUrl}
                                  onChange={(event) =>
                                    update('qwenBaseUrl', event.target.value)
                                  }
                                  aria-invalid={Boolean(errors.qwenBaseUrl)}
                                  className="font-mono text-[12px]"
                                />
                                {errors.qwenBaseUrl ? (
                                  <p className="text-[11px] text-danger">{errors.qwenBaseUrl}</p>
                                ) : null}
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="qwen-model">Qwen-VL 模型</Label>
                                <Input
                                  id="qwen-model"
                                  value={form.qwenModel}
                                  onChange={(event) => update('qwenModel', event.target.value)}
                                  aria-invalid={Boolean(errors.qwenModel)}
                                  className="font-mono text-[12px]"
                                />
                                {errors.qwenModel ? (
                                  <p className="text-[11px] text-danger">{errors.qwenModel}</p>
                                ) : null}
                              </div>
                            </div>
                            <SecretInput
                              id="qwen-key"
                              label="Qwen / DashScope API Key"
                              configured={model.qwenConfigured}
                              hint={model.qwenHint}
                              value={model.qwenKeyValue}
                              onChange={model.setQwenKeyValue}
                              placeholder="输入 DashScope API Key"
                              error={errors.qwenKey}
                              description="也可使用环境变量 DASHSCOPE_API_KEY；此处配置优先。"
                            />
                          </div>
                        ) : (
                          <p className="flex items-start gap-1.5 rounded-lg border border-border bg-surface-muted/30 px-3.5 py-2.5 text-[11px] leading-5 text-muted">
                            <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            原生模式要求当前聊天模型支持图片输入；否则请改用 Qwen-VL 独立识图。
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="rounded-lg border border-border bg-surface-muted/30 px-3.5 py-2.5 text-[11px] leading-5 text-muted">
                        图片输入已关闭。群友发图时，模型只会看到占位符，不会触发识图调用。
                      </p>
                    )}
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="websearch">
                  <AccordionTrigger>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                        联网搜索
                        <Badge variant={form.webSearchEnabled ? 'success' : 'neutral'}>
                          {form.webSearchEnabled ? form.webSearchProvider : '已关闭'}
                        </Badge>
                      </span>
                      <span className="text-[11px] font-normal leading-5 text-muted">
                        启用 web_search / web_fetch 工具与搜索引擎。
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-3">
                    <SwitchRow
                      id="websearch-enabled"
                      title="启用联网搜索"
                      description="关闭后模型无法调用 web_search / web_fetch。"
                      checked={form.webSearchEnabled}
                      onCheckedChange={(checked) => update('webSearchEnabled', checked)}
                    />
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="search-provider">搜索引擎</Label>
                        <Select
                          value={form.webSearchProvider}
                          onValueChange={(value) =>
                            update(
                              'webSearchProvider',
                              value as 'auto' | 'bing' | 'anysearch',
                            )
                          }
                          disabled={!form.webSearchEnabled}
                        >
                          <SelectTrigger id="search-provider" aria-label="搜索引擎">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">自动（AnySearch 优先，失败回退 Bing）</SelectItem>
                            <SelectItem value="bing">Bing</SelectItem>
                            <SelectItem value="anysearch">AnySearch</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="search-url">搜索地址</Label>
                        <Input
                          id="search-url"
                          value={form.searchUrl}
                          onChange={(event) => update('searchUrl', event.target.value)}
                          disabled={!form.webSearchEnabled}
                          aria-invalid={Boolean(errors.searchUrl)}
                          className="font-mono text-[12px]"
                        />
                        {errors.searchUrl ? (
                          <p className="text-[11px] text-danger">{errors.searchUrl}</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-muted/30 px-3.5 py-2.5">
                      <span className="flex items-center gap-2 text-[11.5px]">
                        <KeyRound className="h-3.5 w-3.5 text-muted" />
                        AnySearch 密钥
                        <Badge
                          variant={
                            bundle.webSearch.anysearchKeyConfigured ? 'success' : 'warning'
                          }
                        >
                          {bundle.webSearch.anysearchKeyConfigured
                            ? `已配置 ${bundle.webSearch.anysearchKeyCount} 个`
                            : '未配置'}
                        </Badge>
                      </span>
                      <span className="text-[10.5px] text-muted">
                        密钥管理尚未迁移到本页；此状态只读，不回显明文。
                      </span>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </SectionCard>
          </div>

          {/* 右侧摘要 */}
          <aside className="hidden xl:block">
            <div className="sticky top-5 space-y-4">
              <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
                <div className="flex items-center gap-2 border-b border-border pb-2.5">
                  <FileText className="h-3.5 w-3.5 text-muted" />
                  <h2 className="text-[12px] font-semibold text-foreground">配置摘要</h2>
                </div>
                <dl className="mt-1 divide-y divide-border/60">
                  <SummaryRow label="服务商" value={provider?.displayName ?? '—'} />
                  <SummaryRow
                    label="模型"
                    value={<span className="font-mono text-[11px]">{form.model || '—'}</span>}
                  />
                  <SummaryRow
                    label="预设"
                    value={
                      matchedPreset ? (
                        <span className="text-primary">{matchedPreset.name}</span>
                      ) : (
                        <span className="text-warning">自定义</span>
                      )
                    }
                  />
                  <SummaryRow label="温度" value={form.temperature ?? '—'} />
                  <SummaryRow
                    label="输出上限"
                    value={`${form.maxOutputTokens ?? '—'} / ${form.complexMaxOutputTokens ?? '—'}`}
                  />
                  <SummaryRow label="工具轮数" value={`${form.maxRounds ?? '—'} 轮`} />
                  <SummaryRow
                    label="密钥"
                    value={
                      model.apiKeyValue ? (
                        <span className="text-warning">待替换</span>
                      ) : model.keyConfigured ? (
                        <span className="text-success">已配置</span>
                      ) : (
                        <span className="text-danger">未配置</span>
                      )
                    }
                  />
                  <SummaryRow
                    label="数据源"
                    value={mode === 'demo' ? '演示数据' : '本地服务'}
                  />
                </dl>
              </div>

              <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted" />
                  <p className="text-[12px] font-medium text-foreground">保存与安全</p>
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-muted">
                  配置保存后，下一次运行生效。API Key 不会写入日志、URL 或浏览器本地存储；
                  已保存的密钥只以掩码占位，输入新值才会替换。
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
                  <SaveIndicator dirty={dirty} state={saveState} compact />
                  <span className="text-[10.5px] text-muted">
                    {allErrors && Object.keys(allErrors).length
                      ? `${Object.keys(allErrors).length} 项待修正`
                      : '校验通过'}
                  </span>
                </div>
              </div>
            </div>
          </aside>
        </div>

        {dirty ? (
          <div className="sticky bottom-0 z-20 mt-6 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 py-3 backdrop-blur">
            <SaveIndicator dirty={dirty} state={saveState} />
            <span className="text-[11px] text-muted">
              修改尚未写入运行配置，保存后下一次运行生效。
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={model.discard}
                disabled={saveState === 'saving'}
              >
                放弃
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void model.save()}
                disabled={saveState === 'saving'}
              >
                {saveState === 'saving' ? <Loader2 className="animate-spin" /> : <Save />}
                保存设置
              </Button>
            </div>
          </div>
        ) : null}

        <ProviderManagerDialog
          open={providerManagerOpen}
          onOpenChange={setProviderManagerOpen}
          providers={model.providers}
          activeProviderId={form?.providerId ?? ''}
          onProviderChanged={model.applyProviderPatch}
          onProviderRemoved={model.applyProviderRemoval}
        />
      </div>
    </div>
  );
}
