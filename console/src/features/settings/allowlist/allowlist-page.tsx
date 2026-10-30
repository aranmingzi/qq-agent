import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  MessageSquare,
  Plus,
  Search,
  ShieldCheck,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import type { AllowConfig, OneBotAccountItem } from '@/types';
import { api } from '@/lib/api';
import { isIntegratedConsole, openLegacyConsole } from '@/lib/integration';
import { maskRosterId, rosterAlias } from '@/lib/privacy';
import { usePrivacyMode } from '@/hooks/use-privacy-mode';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { SaveStatus } from '@/components/save-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

function ListPicker({
  title,
  description,
  items,
  selected,
  onChange,
  searchPlaceholder,
  emptyHint,
  kind,
  hidden,
  aliasById,
}: {
  title: string;
  description: string;
  items: OneBotAccountItem[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
  emptyHint: string;
  kind: 'group' | 'friend';
  hidden: boolean;
  aliasById: Map<string, string>;
}) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState('');

  const merged = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) map.set(String(item.id), item.name || String(item.id));
    for (const id of selected) if (!map.has(id)) map.set(id, '');
    return Array.from(map.entries()).map(([id, name], index) => ({
      id,
      name,
      alias: aliasById.get(id) ?? rosterAlias(kind, index),
    }));
  }, [aliasById, items, kind, selected]);

  useEffect(() => {
    if (hidden) setQuery('');
  }, [hidden]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return merged;
    if (hidden) {
      return merged.filter((item) => item.alias.toLowerCase().includes(keyword));
    }
    return merged.filter(
      (item) =>
        item.id.toLowerCase().includes(keyword) ||
        item.name.toLowerCase().includes(keyword),
    );
  }, [hidden, merged, query]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  const addManual = () => {
    const value = manual.trim();
    if (!/^\d+$/.test(value)) return;
    if (!selected.includes(value)) onChange([...selected, value]);
    setManual('');
  };

  return (
    <SectionCard
      icon={title.includes('群') ? Users : MessageSquare}
      title={title}
      description={description}
      actions={
        <span className="text-[11px] tabular-nums text-muted">
          已选 {selected.length} / {merged.length}
        </span>
      }
      contentClassName="p-0"
    >
      <div className="space-y-3 p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={hidden ? '隐私模式下仅可按别名搜索' : searchPlaceholder}
            aria-label={hidden ? '隐私模式下仅可按别名搜索' : searchPlaceholder}
            className="h-8 pl-8 pr-8 text-[12px]"
            disabled={hidden}
          />
          {hidden ? (
            <Lock
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-warning"
              aria-hidden="true"
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={manual}
            onChange={(event) => setManual(event.target.value.replace(/\D/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addManual();
              }
            }}
            placeholder={hidden ? '手动输入号码（仅本次输入可见）' : '手动输入 QQ 号 / 群号'}
            aria-label={`手动添加到${title}`}
            className="h-8 text-[12px]"
            type={hidden ? 'password' : 'text'}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={addManual}
            disabled={!/^\d+$/.test(manual.trim())}
          >
            <Plus />
            添加
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-muted">勾选后立即反映在保存的配置中</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onChange(merged.map((item) => item.id))}
              className="focus-ring rounded px-1.5 py-0.5 text-[10.5px] text-primary hover:bg-primary-soft"
            >
              全选
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              className="focus-ring rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-muted"
            >
              清空
            </button>
          </div>
        </div>
      </div>
      <div className="scrollbar-thin max-h-[300px] overflow-y-auto border-t border-border">
        {filtered.length ? (
          <ul className="divide-y divide-border/60">
            {filtered.map((item) => {
              const checked = selected.includes(item.id);
              const displayName = hidden ? item.alias : item.name || item.alias;
              const displayId = hidden ? maskRosterId() : item.id;
              return (
                <li key={item.id}>
                  <label
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 px-4 py-2.5 transition-colors',
                      checked ? 'bg-primary-soft/40' : 'hover:bg-surface-muted/60',
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(item.id)}
                      aria-label={`选择 ${hidden ? item.alias : displayName}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[12.5px] font-medium text-foreground">
                          {displayName}
                        </span>
                        {hidden ? (
                          <Lock
                            className="h-2.5 w-2.5 shrink-0 text-muted/60"
                            aria-hidden="true"
                          />
                        ) : null}
                        {checked ? (
                          <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                        ) : null}
                      </span>
                      <span className="block font-mono text-[10.5px] text-muted">{displayId}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={Search} title="没有匹配项" description={emptyHint} compact />
        )}
      </div>
    </SectionCard>
  );
}

export function AllowlistPage() {
  const settings = useSettingsConfig();
  const privacy = usePrivacyMode();
  const [draft, setDraft] = useState<AllowConfig | null>(null);
  const [baseline, setBaseline] = useState('');
  const [groups, setGroups] = useState<OneBotAccountItem[]>([]);
  const [friends, setFriends] = useState<OneBotAccountItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingLists, setLoadingLists] = useState(false);

  useEffect(() => {
    if (!settings.config) return;
    const next = settings.config.allow;
    setDraft({ groups: [...(next.groups || [])], private: [...(next.private || [])] });
    setBaseline(JSON.stringify(next));
  }, [settings.config]);

  useEffect(() => {
    if (settings.mode !== 'live') {
      setGroups([
        { id: '20000001', name: '相亲相爱一家龙' },
        { id: '20000002', name: '电科奶龙群二群' },
        { id: '20000003', name: '测试群' },
      ]);
      setFriends([
        { id: '10000001', name: '西西弗斯7' },
        { id: '20000004', name: '5班刘靠靠' },
      ]);
      return;
    }
    setLoadingLists(true);
    Promise.all([api.onebotGroups(), api.onebotFriends()])
      .then(([groupList, friendList]) => {
        setGroups(groupList);
        setFriends(friendList);
        setListError(null);
      })
      .catch((cause) => {
        setListError(cause instanceof Error ? cause.message : '无法从 QQ 账号读取列表');
      })
      .finally(() => setLoadingLists(false));
  }, [settings.mode]);

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);

  // 账号里存在、但没勾上的群 —— 这些群里她一句话都不会说，也不留记录。
  // 必须让人一眼看到数量：否则"她怎么在这个群不理我"永远查不出原因。
  const silentGroupCount = useMemo(
    () => groups.filter((item) => !(draft?.groups ?? []).includes(String(item.id))).length,
    [groups, draft?.groups],
  );

  const groupAliases = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach((item, index) => map.set(String(item.id), rosterAlias('group', index)));
    (draft?.groups ?? []).forEach((id, index) => {
      if (!map.has(id)) map.set(id, `手动群聊 ${String(index + 1).padStart(2, '0')}`);
    });
    return map;
  }, [draft?.groups, groups]);

  const friendAliases = useMemo(() => {
    const map = new Map<string, string>();
    friends.forEach((item, index) => map.set(String(item.id), rosterAlias('friend', index)));
    (draft?.private ?? []).forEach((id, index) => {
      if (!map.has(id)) map.set(id, `手动好友 ${String(index + 1).padStart(2, '0')}`);
    });
    return map;
  }, [draft?.private, friends]);

  const save = async () => {
    if (!draft) return;
    // ⚠️ 以前这里无条件带上 `deny: { groups: [], private: [] }` 和
    //    `allowAllWhenEmpty: false`：在这页点一次「保存白名单」，就会把
    //    （本页根本没展示的）黑名单**静默清空**、把「允许全部」关掉 ——
    //    用户改的是"加一个群"，丢的是两个不相干的设置，而且没有任何提示。
    //    现在只提交本页真正编辑的 allow；allowAllWhenEmpty 仅当用户把名单清空
    //    时才显式关掉（否则"清空保存"仍然会让机器人对所有人说话，与页面文案不符）。
    const patch: Record<string, unknown> = {
      allow: { groups: draft.groups, private: draft.private },
    };
    if (draft.groups.length === 0 && draft.private.length === 0) {
      patch.allowAllWhenEmpty = false;
    }
    const next = await settings.save(patch);
    if (next) {
      setBaseline(JSON.stringify(next.allow));
      privacy.hide();
    }
  };

  if (settings.phase === 'loading' || !draft) {
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="mt-2 h-4 w-96" />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </div>
    );
  }

  if (settings.phase === 'error') {
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="聊天白名单" />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="白名单配置加载失败"
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
      <div className="mx-auto max-w-[1100px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="聊天白名单"
          description="只在这里勾上的群和好友，机器人才会响应。没勾的群会完全静默 —— 不收消息、不回复、也不留聊天记录，看起来就像她没上线。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {privacy.hidden ? (
                <Button variant="ghost" size="sm" onClick={privacy.requestReveal}>
                  <Eye />
                  显示真实信息
                </Button>
              ) : (
                <Button variant="subtle" size="sm" onClick={privacy.hide}>
                  <EyeOff />
                  立即隐藏
                </Button>
              )}
              <SaveStatus dirty={dirty} state={settings.saveState} />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDraft(JSON.parse(baseline) as AllowConfig)}
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
                <ShieldCheck />
                保存白名单
              </Button>
            </div>
          }
        />

        {settings.saveError ? (
          <div className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger" role="alert">
            {settings.saveError}
          </div>
        ) : null}

        {privacy.hidden ? (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-success/20 bg-success-soft/50 px-3 py-2 text-[11px] leading-5 text-success">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              隐私保护已开启：真实群名、好友昵称、QQ 号 / 群号均不在页面中渲染。需要核对时再临时显示。
            </span>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-warning/25 bg-warning-soft/60 px-3 py-2 text-[11px] leading-5 text-warning">
            <Eye className="h-3.5 w-3.5 shrink-0" />
            真实群名与号码已临时显示；切到后台或 2 分钟后自动隐藏。
            <button
              type="button"
              onClick={privacy.hide}
              className="focus-ring ml-auto rounded px-1.5 py-0.5 text-[10.5px] underline underline-offset-2"
            >
              立即隐藏
            </button>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[11px] text-muted">
          <ShieldCheck className="h-3.5 w-3.5 text-success" />
          允许 {draft.groups.length} 个群 · {draft.private.length} 个好友
          {groups.length > 0 ? (
            <>
              <span className="h-1 w-1 rounded-full bg-border-strong" />
              <span className={silentGroupCount > 0 ? 'text-warning' : undefined}>
                {silentGroupCount > 0
                  ? `另有 ${silentGroupCount} 个群她不会说话（连记录都不留）`
                  : '账号里的群已全部勾上'}
              </span>
            </>
          ) : null}
          <span className="h-1 w-1 rounded-full bg-border-strong" />
          {draft.groups.length + draft.private.length === 0
            ? '当前为空，机器人不会响应任何消息'
            : '保存后立即生效'}
          {isIntegratedConsole() ? (
            <button
              type="button"
              onClick={openLegacyConsole}
              className="focus-ring ml-auto inline-flex items-center gap-1 rounded text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              旧版白名单
            </button>
          ) : null}
        </div>

        {listError ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2 text-[11.5px] leading-5 text-warning">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            无法从 QQ 账号读取群/好友列表：{listError}。仍可手动输入号码。
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <ListPicker
            title="群聊白名单"
            description={loadingLists ? '正在从 QQ 账号读取群列表…' : '勾选允许机器人参与的群。真实信息默认隐藏。'}
            items={groups}
            selected={draft.groups}
            onChange={(next) => setDraft((current) => (current ? { ...current, groups: next } : current))}
            searchPlaceholder="搜索群名或群号"
            emptyHint="点击「全选」拉入全部群，或手动输入群号。"
            kind="group"
            hidden={privacy.hidden}
            aliasById={groupAliases}
          />
          <ListPicker
            title="好友白名单"
            description={loadingLists ? '正在从 QQ 账号读取好友列表…' : '勾选允许机器人回复的私聊好友。真实信息默认隐藏。'}
            items={friends}
            selected={draft.private}
            onChange={(next) => setDraft((current) => (current ? { ...current, private: next } : current))}
            searchPlaceholder="搜索好友名或 QQ 号"
            emptyHint="点击「全选」拉入全部好友，或手动输入 QQ 号。"
            kind="friend"
            hidden={privacy.hidden}
            aliasById={friendAliases}
          />
        </div>

        {draft.groups.length + draft.private.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {draft.groups.map((id) => (
              <span
                key={`g-${id}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10.5px] text-muted"
              >
                {privacy.hidden
                  ? groupAliases.get(id) || '群聊'
                  : `群 ${id}`}
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) =>
                      current ? { ...current, groups: current.groups.filter((x) => x !== id) } : current,
                    )
                  }
                  aria-label={`移除 ${privacy.hidden ? groupAliases.get(id) || '群聊' : `群 ${id}`}`}
                  className="focus-ring rounded text-muted hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {draft.private.map((id) => (
              <span
                key={`p-${id}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10.5px] text-muted"
              >
                {privacy.hidden
                  ? friendAliases.get(id) || '好友'
                  : `私聊 ${id}`}
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) =>
                      current ? { ...current, private: current.private.filter((x) => x !== id) } : current,
                    )
                  }
                  aria-label={`移除 ${privacy.hidden ? friendAliases.get(id) || '好友' : `私聊 ${id}`}`}
                  className="focus-ring rounded text-muted hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={privacy.confirmOpen}
        onOpenChange={privacy.setConfirmOpen}
        title="显示真实群友 / 好友信息？"
        description="将在这一个页面里显示真实群名、好友昵称、QQ 号 / 群号，可能被屏幕共享、录屏或旁观者看到。显示状态只保留在内存中，切到后台或 2 分钟后会自动隐藏，不会写入配置或日志。"
        confirmLabel="显示真实信息"
        onConfirm={privacy.confirmReveal}
      />
    </div>
  );
}
