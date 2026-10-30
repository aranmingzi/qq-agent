import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2, X } from 'lucide-react';
import type { Provider } from '@/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from './secret-input';

/** 与后端 `model-fallback.js::MAX_PER_PROVIDER` 对齐：每家的前 2 个模型会进降级链。 */
const CHAIN_SLOTS = 2;

/** 模型输入框容忍逗号/换行/分号混写，这是从别处复制列表过来最常见的形态。 */
function parseModelList(raw: string) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,，;；]+/)) {
    const id = token.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ProviderManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: Provider[];
  /** 当前「基础设置」里选中的服务商，用来提示「正在使用」。 */
  activeProviderId: string;
  /**
   * 单个服务商被改动（增/改/删模型/重排）。父级只把这一条合并进本地目录，
   * **不整页重载** —— 重载会让 phase 回到 loading，页面闪骨架屏、对话框被卸载重建。
   */
  onProviderChanged: (provider: Provider) => void;
  onProviderRemoved: (providerId: string) => void;
}

/**
 * 服务商目录的增删改面板。
 *
 * 交互上的三个刻意的取舍：
 *   ① 名称/地址/密钥用「草稿 + 保存」，避免每敲一个字就落盘一次；
 *   ② 模型列表用「即时生效」，因为上移/下移/删除都是单步可逆操作，
 *      再让用户点一次保存反而容易漏点 —— 而顺序就是链位，漏点会让人以为没生效；
 *   ③ 新增走右侧面板而不是弹第三层对话框：叠三层弹窗在窄屏上会互相遮挡。
 */
export function ProviderManagerDialog({
  open,
  onOpenChange,
  providers,
  activeProviderId,
  onProviderChanged,
  onProviderRemoved,
}: ProviderManagerDialogProps) {
  const [selectedId, setSelectedId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftBase, setDraftBase] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState('');
  const [addBase, setAddBase] = useState('');
  const [addKey, setAddKey] = useState('');
  const [addModels, setAddModels] = useState('');

  const selected = providers.find((item) => item.id === selectedId) ?? providers[0];

  // 打开时补一次选中；删掉当前项后 selectedId 会被清空，这里负责重新落位。
  useEffect(() => {
    if (!open) return;
    if (!selectedId && providers.length) setSelectedId(providers[0].id);
    if (selectedId && !providers.some((item) => item.id === selectedId)) {
      setSelectedId(providers[0]?.id ?? '');
    }
  }, [open, providers, selectedId]);

  // 只在「切换服务商」时重置草稿。不能依赖 selected 对象本身 ——
  // 每次改完父级会回传新的 providers 数组，那样会把正在输入的内容清掉。
  // 提示语（note/error）不在这里清：新增/删除后选中项会跟着变，
  // 一清就等于把「已新增「X」」这类结果立刻抹掉。改由用户主动切列表时清。
  useEffect(() => {
    if (!selected) return;
    setDraftName(selected.displayName ?? '');
    setDraftBase(selected.baseURL ?? '');
    setDraftKey('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  /** 每次打开清一次提示；目录为空时直接落到新增面板，否则用户找不到入口。 */
  useEffect(() => {
    if (!open) return;
    setError('');
    setNote('');
    setAdding(providers.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function resetAddForm() {
    setAddName('');
    setAddBase('');
    setAddKey('');
    setAddModels('');
  }

  async function run<T>(action: () => Promise<T>, okMessage: string | ((result: T) => string)) {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await action();
      setNote(typeof okMessage === 'function' ? okMessage(result) : okMessage);
      return result;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function saveMeta() {
    if (!selected) return;
    const payload: { providerId: string; displayName?: string; baseUrl?: string; apiKey?: string } = {
      providerId: selected.id,
    };
    if (draftName.trim() && draftName.trim() !== selected.displayName) payload.displayName = draftName.trim();
    if (draftBase.trim() && draftBase.trim() !== selected.baseURL) payload.baseUrl = draftBase.trim();
    if (draftKey.trim()) payload.apiKey = draftKey.trim();
    if (Object.keys(payload).length === 1) {
      setNote('没有需要保存的改动');
      return;
    }
    const updated = await run(() => api.updateProviderMeta(payload), '已保存');
    if (updated) {
      onProviderChanged(updated as Provider);
      setDraftKey('');
    }
  }

  async function submitAdd() {
    const base = addBase.trim();
    if (!base) {
      setError('Base URL 不能为空');
      return;
    }
    if (!isHttpUrl(base)) {
      setError('Base URL 需要以 http:// 或 https:// 开头');
      return;
    }
    const models = parseModelList(addModels);
    const result = await run(
      () =>
        api.createProvider({
          baseUrl: base,
          apiKey: addKey.trim(),
          displayName: addName.trim(),
          models,
        }),
      (res) =>
        res.created
          ? `已新增「${res.provider?.displayName ?? ''}」`
          : `这个 Base URL 已存在，模型已合并到「${res.provider?.displayName ?? ''}」`,
    );
    if (!result?.provider) return;
    onProviderChanged(result.provider);
    setSelectedId(result.provider.id);
    resetAddForm();
    setAdding(false);
  }

  async function moveModel(index: number, direction: -1 | 1) {
    if (!selected) return;
    const list = [...(selected.models ?? [])];
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    const updated = await run(() => api.reorderProviderModels(selected.id, list), '顺序已更新');
    if (updated) onProviderChanged(updated);
  }

  async function removeModel(modelId: string) {
    if (!selected) return;
    const updated = await run(() => api.removeProviderModels(selected.id, [modelId]), '已移除模型');
    if (updated) onProviderChanged(updated);
  }

  async function confirmDelete() {
    if (!selected) return;
    const removedId = selected.id;
    const result = await run(() => api.deleteProvider(removedId), '服务商已删除');
    setConfirmOpen(false);
    if (!result) return;
    onProviderRemoved(removedId);
    setSelectedId('');
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>管理服务商</DialogTitle>
            <DialogDescription>
              模型顺序就是降级链顺序，每家的前 {CHAIN_SLOTS} 个模型会被实际尝试。
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid max-h-[70vh] gap-4 overflow-auto md:grid-cols-[220px_minmax(0,1fr)]">
            {/* 左：服务商列表 */}
            <div className="space-y-1 self-start rounded-lg border border-border bg-surface p-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-[11px] text-muted">共 {providers.length} 家</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={() => {
                    setAdding(true);
                    setError('');
                    setNote('');
                  }}
                >
                  <Plus aria-hidden="true" />
                  新增
                </Button>
              </div>

              {providers.length === 0 ? (
                <p className="px-1 py-6 text-center text-[12px] leading-5 text-muted">
                  目录里还没有服务商，右侧填一下即可新建。
                </p>
              ) : null}

              {providers.map((item) => {
                const active = !adding && item.id === selected?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setSelectedId(item.id);
                      setError('');
                      setNote('');
                    }}
                    className={cn(
                      'focus-ring w-full rounded-md px-2.5 py-2 text-left transition-colors',
                      active ? 'bg-primary-soft text-foreground' : 'text-muted hover:bg-surface-muted',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{item.displayName}</span>
                      {item.id === activeProviderId ? (
                        <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
                          使用中
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted">
                      {item.models?.length ?? 0} 个模型
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 右：新增 / 编辑 */}
            {adding ? (
              <div className="min-w-0 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="pm-add-name">名称</Label>
                    <Input
                      id="pm-add-name"
                      value={addName}
                      onChange={(event) => setAddName(event.target.value)}
                      placeholder="留空则取域名"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pm-add-base">Base URL</Label>
                    <Input
                      id="pm-add-base"
                      value={addBase}
                      onChange={(event) => setAddBase(event.target.value)}
                      placeholder="https://…/v1"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <SecretInput
                      label="API Key"
                      description="可以留空，之后回「基础设置」里再填也一样。"
                      configured={false}
                      hint=""
                      value={addKey}
                      onChange={setAddKey}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="pm-add-models">模型</Label>
                    <textarea
                      id="pm-add-models"
                      value={addModels}
                      onChange={(event) => setAddModels(event.target.value)}
                      rows={3}
                      placeholder="每行一个，或用逗号分隔；也可以先留空，回「基础设置」点「获取列表」拉取"
                      className="focus-ring w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[12px] text-foreground placeholder:font-sans placeholder:text-muted"
                    />
                    <p className="text-[11px] leading-4 text-muted">
                      {parseModelList(addModels).length
                        ? `将写入 ${parseModelList(addModels).length} 个模型，前 ${CHAIN_SLOTS} 个进降级链`
                        : '暂不写入模型：这家暂时没有可用模型，保存设置时会提示'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" onClick={() => void submitAdd()} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                    创建服务商
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setAdding(false);
                      resetAddForm();
                      setError('');
                      setNote('');
                    }}
                  >
                    取消
                  </Button>
                  {note ? <span className="text-[12px] text-success">{note}</span> : null}
                  {error ? (
                    <span className="text-[12px] text-danger" role="alert">
                      {error}
                    </span>
                  ) : null}
                </div>

                <p className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-[11px] leading-5 text-muted">
                  建好之后回到「基础设置 → 服务商」选中它，再点「保存设置」才会真正切过去。新增不会自动改动当前接入点。
                </p>
              </div>
            ) : selected ? (
              <div className="min-w-0 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="pm-name">名称</Label>
                    <Input
                      id="pm-name"
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      placeholder="显示名"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="pm-base">Base URL</Label>
                    <Input
                      id="pm-base"
                      value={draftBase}
                      onChange={(event) => setDraftBase(event.target.value)}
                      placeholder="https://…/v1"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <SecretInput
                      label="API Key"
                      description="留空表示不修改。已保存的密钥永不回显。"
                      configured={Boolean(selected.hasKey)}
                      hint={selected.apiKey ?? ''}
                      value={draftKey}
                      onChange={setDraftKey}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" onClick={() => void saveMeta()} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                    保存信息
                  </Button>
                  {note ? <span className="text-[12px] text-success">{note}</span> : null}
                  {error ? (
                    <span className="text-[12px] text-danger" role="alert">
                      {error}
                    </span>
                  ) : null}
                </div>

                <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-baseline justify-between">
                    <Label>模型（顺序即链位）</Label>
                    <span className="text-[11px] text-muted">{selected.models?.length ?? 0} 个</span>
                  </div>

                  {(selected.models?.length ?? 0) === 0 ? (
                    <p className="py-3 text-center text-[12px] leading-5 text-muted">
                      这家还没有模型。回「基础设置」点「获取模型列表」即可写入，或在这里新增时直接填。
                    </p>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {selected.models.map((modelId, index) => (
                        <li key={modelId} className="flex items-center gap-2 py-1.5">
                          <span
                            className={cn(
                              'w-6 shrink-0 text-center text-[11px] tabular-nums',
                              index < CHAIN_SLOTS ? 'font-semibold text-primary' : 'text-muted',
                            )}
                            title={index < CHAIN_SLOTS ? '会进降级链' : ''}
                          >
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12.5px]" title={modelId}>
                            {selected.modelNames?.[modelId] ?? modelId}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="上移"
                            disabled={busy || index === 0}
                            onClick={() => void moveModel(index, -1)}
                          >
                            <ArrowUp aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="下移"
                            disabled={busy || index === (selected.models?.length ?? 1) - 1}
                            onClick={() => void moveModel(index, 1)}
                          >
                            <ArrowDown aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="移除模型"
                            disabled={busy}
                            onClick={() => void removeModel(modelId)}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="truncate text-[11px] text-muted">{selected.id}</span>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmOpen(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    删除此服务商
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`删除「${selected?.displayName ?? ''}」？`}
        description={
          <>
            目录条目和它的 {selected?.models?.length ?? 0} 个模型会一起移除。
            {selected?.id === activeProviderId
              ? ' 这家当前正在使用，删除后会清空「正在使用的服务商」标记，接入点本身不变。'
              : ' 其他服务商不受影响。'}
          </>
        }
        confirmLabel="删除"
        tone="danger"
        loading={busy}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
