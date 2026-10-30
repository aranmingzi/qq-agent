import { ArrowRight, ExternalLink, Wrench } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { titleForPath } from '@/lib/navigation';
import { navigateTo } from '@/lib/router';
import { isIntegratedConsole, openLegacyConsole } from '@/lib/integration';

export function SettingsPlaceholderPage({ path }: { path: string }) {
  const { title } = titleForPath(path);
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader
          title={title}
          description="该页沿用现有设置分组与字段，按相同设计语言迁移。当前重构先交付会话、模型 API、能力总览与 SnowLuma。"
        />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={Wrench}
            title="该设置页尚未迁移"
            description="原页面与接口仍然保留，没有删除任何字段或业务规则。迁移时将继续复用 SectionCard、ParameterControl、SecretInput 与统一的保存状态组件。"
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigateTo('/settings/model')}
                >
                  查看已迁移的模型 API
                  <ArrowRight />
                </Button>
                {isIntegratedConsole() ? (
                  <Button variant="ghost" size="sm" onClick={openLegacyConsole}>
                    <ExternalLink />
                    打开旧版设置
                  </Button>
                ) : null}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}
