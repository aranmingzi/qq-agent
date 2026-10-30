import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Globe2,
  GraduationCap,
  Library,
  Loader2,
  MinusCircle,
  RefreshCw,
  Search,
  Wrench,
} from 'lucide-react';
import type { Capabilities, ToolCapability } from '@/types';
import { api } from '@/lib/api';
import { demoCapabilities } from '@/lib/demo-data';
import { sleep } from '@/lib/utils';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

function useCapabilities() {
  const { mode } = useConsoleMode();
  const [data, setData] = useState<Capabilities | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (quiet = false) => {
    if (!quiet) setPhase('loading');
    else setRefreshing(true);
    try {
      let next: Capabilities;
      if (mode === 'demo') {
        await sleep(180);
        next = demoCapabilities;
      } else {
        next = await api.capabilities();
      }
      setData(next);
      setPhase('ready');
      setError(null);
    } catch (cause) {
      setPhase('error');
      setError(cause instanceof Error ? cause.message : '能力总览加载失败');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, phase, error, refreshing, reload: load, mode };
}

function FeatureCard({
  icon: Icon,
  title,
  description,
  status,
  statusVariant,
  children,
}: {
  icon: typeof GraduationCap;
  title: string;
  description: string;
  status: string;
  statusVariant: 'success' | 'warning' | 'neutral' | 'danger';
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-muted text-muted">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <Badge variant={statusVariant}>{status}</Badge>
      </div>
      <h3 className="mt-3 text-[13px] font-semibold text-foreground">{title}</h3>
      <p className="mt-0.5 text-[11.5px] leading-5 text-muted">{description}</p>
      {children ? <div className="mt-3 space-y-1.5 border-t border-border pt-3">{children}</div> : null}
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 text-right font-medium text-foreground/85">{value}</span>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolCapability }) {
  return (
    <AccordionItem value={tool.name} className="border-b border-border last:border-b-0">
      <AccordionTrigger className="py-3 pr-2">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono text-[12px] font-medium text-foreground">
              {tool.name}
            </code>
            {tool.masterOnly ? (
              <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                主人专属
              </Badge>
            ) : null}
            <span className="text-[10px] text-muted">{tool.params.length} 个参数</span>
          </span>
          <span className="mt-0.5 line-clamp-1 block text-[11px] font-normal leading-5 text-muted">
            {tool.description || '暂无说明'}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="space-y-3 pl-0.5">
          <p className="break-words text-[12px] leading-6 text-muted">
            {tool.description || '接口未提供说明。'}
          </p>
          {tool.params.length ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_64px] gap-2 border-b border-border bg-surface-muted px-3 py-1.5 text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted">
                <span>参数</span>
                <span>类型</span>
                <span>必填</span>
              </div>
              <div className="divide-y divide-border/70">
                {tool.params.map((param) => (
                  <div
                    key={param.name}
                    className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_64px] items-start gap-2 px-3 py-2"
                  >
                    <code className="break-all font-mono text-[11px] text-foreground">
                      {param.name}
                    </code>
                    <code className="break-all font-mono text-[10.5px] text-muted">
                      {param.type || '未提供'}
                    </code>
                    <span className="text-[10.5px] text-muted">
                      {param.required === true ? (
                        <span className="text-danger">必填</span>
                      ) : param.required === false ? (
                        '可选'
                      ) : (
                        '—'
                      )}
                    </span>
                    {param.description ? (
                      <span className="col-span-3 text-[10.5px] leading-4 text-muted/90">
                        {param.description}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-[11px] text-muted">
              该工具没有参数。
            </p>
          )}
          {tool.params.some((param) => !param.type) ? (
            <p className="text-[10.5px] leading-4 text-muted">
              当前接口只返回参数名，类型与必填信息未提供时显示为「未提供 / —」。
            </p>
          ) : null}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function CapabilitiesPage() {
  const { data, phase, error, refreshing, reload, mode } = useCapabilities();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    if (!data) return [];
    const keyword = query.trim().toLowerCase();
    const map = new Map<string, ToolCapability[]>();
    for (const tool of data.tools) {
      if (
        keyword &&
        !tool.name.toLowerCase().includes(keyword) &&
        !tool.description.toLowerCase().includes(keyword) &&
        !tool.group.toLowerCase().includes(keyword)
      ) {
        continue;
      }
      const list = map.get(tool.group) ?? [];
      list.push(tool);
      map.set(tool.group, list);
    }
    return Array.from(map.entries());
  }, [data, query]);

  if (phase === 'loading') {
    return (
      <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-5 h-64 rounded-xl" />
      </div>
    );
  }

  if (phase === 'error' || !data) {
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <div className="mx-auto max-w-[1180px] px-4 py-6 sm:px-6 lg:px-8">
          <PageHeader title="能力总览" description="机器人当前具备的工具与服务状态。" />
          <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
            <EmptyState
              icon={AlertCircle}
              title="能力总览加载失败"
              description={error || '请确认后端可用后重试。'}
              action={
                <Button variant="secondary" size="sm" onClick={() => void reload()}>
                  <RefreshCw />
                  重试
                </Button>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  const { features } = data;
  const kbReady = features.kb === 'ready';
  const searchReady = features.search.enabled;
  const identityCount = features.identityModes.length;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="能力总览"
          description={`机器人当前具备 ${data.total} 个工具。以下状态由服务端实时生成，与运行中的代码一致。`}
          actions={
            <div className="flex items-center gap-2">
              <Badge variant={mode === 'demo' ? 'warning' : 'success'}>
                {mode === 'demo' ? '演示数据' : '实时'}
              </Badge>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void reload(true)}
                disabled={refreshing}
              >
                <RefreshCw className={refreshing ? 'animate-spin' : ''} />
                刷新
              </Button>
            </div>
          }
        />

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FeatureCard
            icon={GraduationCap}
            title="学习模式（多身份）"
            description="按身份切换学习模式、题库与教学上下文。"
            status={identityCount ? `已配置 ${identityCount} 个` : '未配置'}
            statusVariant={identityCount ? 'success' : 'neutral'}
          >
            <MetaLine label="身份模式" value={identityCount ? `${identityCount} 个` : '0 个'} />
            <MetaLine label="状态" value={identityCount ? '可用' : '未配置身份模式'} />
          </FeatureCard>

          <FeatureCard
            icon={Library}
            title="知识库"
            description="题库 / 教材检索、学习进度与学习档案。"
            status={kbReady ? '已就绪' : '未安装'}
            statusVariant={kbReady ? 'success' : 'warning'}
          >
            <MetaLine label="能力" value={kbReady ? '题库 / 教材 / 进度' : '—'} />
            <MetaLine label="状态" value={kbReady ? '可调用' : '未检测到知识库数据'} />
          </FeatureCard>

          <FeatureCard
            icon={Globe2}
            title="联网搜索"
            description="web_search / web_fetch 工具与搜索引擎。"
            status={searchReady ? '已启用' : '已关闭'}
            statusVariant={searchReady ? 'success' : 'neutral'}
          >
            <MetaLine label="搜索引擎" value={features.search.effective || features.search.provider} />
            <MetaLine
              label="AnySearch"
              value={features.search.anysearchAvailable ? '已配置' : '未配置'}
            />
          </FeatureCard>

          <FeatureCard
            icon={CalendarClock}
            title="定时任务"
            description="主人可在 QQ 里直接下达「X 点提醒我…」。"
            status={features.scheduled.count ? `${features.scheduled.count} 条待触发` : '0 条待触发'}
            statusVariant={features.scheduled.count ? 'success' : 'neutral'}
          >
            <MetaLine label="待触发" value={`${features.scheduled.count} 条`} />
            <MetaLine label="状态" value={features.scheduled.count ? '等待触发' : '暂无任务'} />
          </FeatureCard>
        </div>

        <SectionCard
          className="mt-5"
          icon={Wrench}
          title="工具清单"
          description={`共 ${data.total} 个工具，按服务端分组展示。展开查看参数类型、必填项与说明。`}
          actions={
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索工具名或用途"
                aria-label="搜索工具"
                className="h-8 w-[220px] pl-8 text-[12px]"
              />
            </div>
          }
          contentClassName="p-0"
        >
          {groups.length ? (
            <div className="divide-y divide-border">
              {groups.map(([group, tools]) => (
                <div key={group}>
                  <div className="flex items-center justify-between bg-surface-muted/40 px-5 py-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                      {group}
                    </h3>
                    <span className="text-[10.5px] text-muted">{tools.length} 个工具</span>
                  </div>
                  <div className="px-5">
                    <Accordion type="multiple">
                      {tools.map((tool) => (
                        <ToolCard key={tool.name} tool={tool} />
                      ))}
                    </Accordion>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Search}
              title="没有匹配的工具"
              description="换一个关键词，或清空搜索后查看全部工具。"
              compact
              action={
                <Button variant="secondary" size="sm" onClick={() => setQuery('')}>
                  清空搜索
                </Button>
              }
            />
          )}
        </SectionCard>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-muted">
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-success" /> 可用
          </span>
          <span className="inline-flex items-center gap-1">
            <MinusCircle className="h-3 w-3 text-muted" /> 未配置
          </span>
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3" /> 状态来自服务端
          </span>
        </div>
      </div>
    </div>
  );
}
