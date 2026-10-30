import { startTransition, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookMarked,
  Check,
  ChevronDown,
  ExternalLink,
  Plus,
  RotateCcw,
  Save,
  Undo2,
  X,
} from 'lucide-react';
import type { PersonaConfig, PersonaTemplate } from '@/types';
import { api } from '@/lib/api';
import { isIntegratedConsole, openLegacyConsole } from '@/lib/integration';
import { cn } from '@/lib/utils';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { SaveStatus } from '@/components/save-status';
import { Field, SelectField, TextField } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const builtinTemplates: PersonaTemplate[] = [
  {
    id: 'whale',
    name: '小鲸鱼（默认）',
    text: '你是「小鲸鱼」，一个混在 QQ 群里的群友。说话像真人，短句为主，爱接梗但不刷屏；被点名时认真回答，不主动说教。',
    builtin: true,
  },
  {
    id: 'tsundere',
    name: '傲娇助手',
    text: '你是一个嘴上嫌弃、实际很可靠的傲娇助手。语气短促，偶尔别扭地关心主人，但正事一定认真完成。',
    builtin: true,
  },
  {
    id: 'blank',
    name: '空白模板',
    text: '',
    builtin: true,
  },
];

/** 人设名 → 机器人名字：去掉结尾的括号注释与点缀符号。'小鲸鱼（默认）'→'小鲸鱼'、'恶毒鲸鱼·'→'恶毒鲸鱼' */
function personaDisplayName(name: string): string {
  return String(name || '')
    .replace(/[（(][^（）()]*[）)]\s*$/g, '')
    .replace(/[（(].*$/g, '')
    .replace(/[·・、,，.。:：\s]+$/g, '')
    .trim();
}

/** 空白无关的人设文本比较：手抄/手改留下的行尾空格、空行不该让"当前人设"掉回未选中 */
function normalizeRoleText(text: string): string {
  return String(text || '').replace(/\s+/g, '');
}

/** 该模板能不能顺带把机器人名字改过去（空白/占位模板没有"角色名"，不能改） */
function canRenameTo(template: PersonaTemplate, currentName: string): boolean {
  const name = personaDisplayName(template.name);
  if (!name || name === String(currentName || '').trim()) return false;
  if (/需自行填写|通用模板/.test(template.name)) return false;
  if (/__[^_]{1,40}__/.test(template.text)) return false;
  return true;
}

export function PersonaPage() {
  const settings = useSettingsConfig();
  const [draft, setDraft] = useState<PersonaConfig | null>(null);
  const [baseline, setBaseline] = useState('');
  const [templates, setTemplates] = useState<PersonaTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  // 模板下拉面板：以前用的是 Radix Select + 弹窗确认。
  // 那两个都要走 Portal（Select 关一次、Dialog 再挂一次，带遮罩模糊和焦点锁），
  // 点一条模板要连着卸/挂两棵子树 —— 实测一次点击能吃掉 140ms+ 主线程，
  // 用户看到的就是"点人设会卡一下"。现在换成页面内的轻量面板：点一条就地应用，
  // 不弹窗、不 Portal，顺带把每行的 × 删除按钮也放下了（Select 的 role=option 里塞不了按钮）。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [applyMode, setApplyMode] = useState<'overwrite' | 'append'>('overwrite');
  const [renameBot, setRenameBot] = useState(true);
  // 撤销要连"名字"和"附加规则"一起还原，只备份 roleText 会让撤销后停在新名字上
  const [backup, setBackup] = useState<{ roleText: string; customRules: string; botName: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newText, setNewText] = useState('');
  const [newRules, setNewRules] = useState('');
  const [busy, setBusy] = useState(false);
  // 「当前编辑的是哪一条模板」。以前没有这个状态，全靠 roleText 文本反查：
  // 只要改一个字（甚至一个行尾空格）就匹配不上，下拉掉回"未应用模板"，
  // 用户以为模板丢了/没保存，于是重新"添加人设"，列表里就多出一条副本。
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [templateSaveState, setTemplateSaveState] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const [templateSaveMsg, setTemplateSaveMsg] = useState('');

  useEffect(() => {
    if (!settings.config) return;
    const next = settings.config.persona;
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [settings.config]);

  useEffect(() => {
    if (settings.mode === 'demo') {
      setTemplates(builtinTemplates);
      setTemplatesError(null);
      return;
    }
    let cancelled = false;
    setTemplatesError(null);
    void api
      .personaTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch((cause) => {
        if (cancelled) return;
        // 接口失败时**不要**再塞一批 demo 占位模板：那三条 40 字的占位文本一旦被应用，
        // 六千字的角色卡就被静默换成一句话，看着像"人设被降级了"。
        setTemplates([]);
        setTemplatesError(cause instanceof Error ? cause.message : '人设模板加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [settings.mode]);

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);

  // 刷新页面后还没有 appliedId → 按文本反查一次，把「当前是哪条模板」恢复出来。
  // 只在 null 时推断：一旦用户选过模板就由 appliedId 说话，改字也不会跳走。
  useEffect(() => {
    if (appliedId || !draft || !templates.length) return;
    const norm = normalizeRoleText(draft.roleText);
    if (!norm) return;
    const hit = templates.find(
      (item) => normalizeRoleText(item.text) && normalizeRoleText(item.text) === norm,
    );
    if (hit) setAppliedId(hit.id);
  }, [appliedId, draft, templates]);

  const update = <K extends keyof PersonaConfig>(key: K, value: PersonaConfig[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  // 面板开着时才挂监听：点外面 / 按 Esc 收起，不额外常驻一个 document 监听器
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
        setConfirmDeleteId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Esc 先收掉行内删除确认，再收面板
      if (confirmDeleteId) {
        setConfirmDeleteId(null);
        return;
      }
      setPickerOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen, confirmDeleteId]);

  const applyTemplate = (template: PersonaTemplate) => {
    if (!draft) return;
    const renameTo =
      applyMode === 'overwrite' && renameBot && canRenameTo(template, draft.botName)
        ? personaDisplayName(template.name)
        : '';
    setBackup({ roleText: draft.roleText, customRules: draft.customRules, botName: draft.botName });
    // ⚠️ 先把面板关掉（这一次渲染很便宜），把"写入 6000 字角色卡 + 重排文本框"放进 transition：
    //    否则点击的这一帧要等文本框重排完才画出来，看起来就是"点了没反应"。
    setPickerOpen(false);
    setConfirmDeleteId(null);
    setTemplateSaveState('idle');
    setTemplateSaveMsg('');
    startTransition(() => {
      setDraft((current) => {
        if (!current) return current;
        const roleText =
          applyMode === 'append'
            ? [current.roleText.trim(), template.text.trim()].filter(Boolean).join('\n\n')
            : template.text;
        // 覆盖 = 换人设，旧人设的「管理员附加规则」必须跟着走。
        // 以前这里写的是 `template.customRules || current.customRules`，模板没带规则就保留旧的，
        // 于是新人设 + 旧人设的口吻约束一起被注入系统提示，两套规则互相打架。
        // 追加 = 保留旧规则（原本为空时才用模板自带的）。
        const customRules =
          applyMode === 'append'
            ? current.customRules || template.customRules || ''
            : template.customRules ?? '';
        return { ...current, roleText, customRules, botName: renameTo || current.botName };
      });
      // 记住"当前编辑的是哪一条模板"。改文本不会把它清掉，所以"改完 → 保存回模板"有明确的落点。
      setAppliedId(template.id);
    });
  };

  const createPersona = async () => {
    if (!newName.trim() || !newText.trim()) return;
    setBusy(true);
    try {
      const payload = {
        name: newName.trim(),
        text: newText.trim(),
        customRules: newRules.trim() || undefined,
      };
      if (settings.mode === 'live') {
        // 后端对同名做了「就地更新」，返回里会带 updated 标记 —— 不再默默多一条副本
        const res = await api.createPersona(payload);
        setTemplates(await api.personaTemplates());
        if (typeof res.id === 'string' && res.id) setAppliedId(res.id);
      } else {
        const clash = templates.find(
          (item) => !item.builtin && item.name.trim() === payload.name,
        );
        if (clash) {
          setTemplates((current) =>
            current.map((item) =>
              item.id === clash.id
                ? { ...item, name: payload.name, text: payload.text, customRules: payload.customRules }
                : item,
            ),
          );
          setAppliedId(clash.id);
        } else {
          const created: PersonaTemplate = {
            id: `demo_${Date.now()}`,
            name: payload.name,
            text: payload.text,
            customRules: payload.customRules,
            builtin: false,
          };
          setTemplates((current) => [...current, created]);
          setAppliedId(created.id);
        }
      }
      setCreateOpen(false);
      setNewName('');
      setNewText('');
      setNewRules('');
    } finally {
      setBusy(false);
    }
  };

  /** 把当前角色设定存成一条自定义人设（内置模板改不了，只能走这条路；无模板时也走这里） */
  const openCreateFromDraft = () => {
    if (!draft) return;
    const base = activeTemplate ? personaDisplayName(activeTemplate.name) : '';
    setNewName(base ? `${base}（自定义）` : '');
    setNewText(draft.roleText);
    setNewRules(draft.customRules);
    setCreateOpen(true);
  };

  /**
   * 保存修改回当前那条自定义模板（就地更新）。
   * ⚠️ 这是这次修的核心：控制台以前只有「添加人设」，没有"改模板"，
   *    用户想改一条已有模板只能把全文粘进新建弹窗，于是每改一次就多一条副本，
   *    下拉里一堆同名条目，原模板却一个字都没变。
   */
  const saveToTemplate = async () => {
    if (!draft || !activeTemplate || activeTemplate.builtin) return;
    setBusy(true);
    setTemplateSaveState('saving');
    setTemplateSaveMsg('');
    try {
      if (settings.mode === 'live') {
        await api.updatePersona(activeTemplate.id, {
          text: draft.roleText,
          customRules: draft.customRules,
        });
      }
      setTemplates((current) =>
        current.map((item) =>
          item.id === activeTemplate.id
            ? { ...item, text: draft.roleText, customRules: draft.customRules }
            : item,
        ),
      );
      setAppliedId(activeTemplate.id);
      setTemplateSaveState('ok');
      // 顺手把「当前人设」一起落盘：他正在编辑的这份就是这个模板的内容，
      // 不一起存的话刷新后人设和模板又对不上，还得再点一次「保存人设」。
      let personaSaved = true;
      if (dirty) {
        const next = await settings.save({ persona: draft });
        personaSaved = Boolean(next);
        if (next) setBaseline(JSON.stringify(next.persona));
      }
      setTemplateSaveMsg(
        personaSaved
          ? `已更新「${activeTemplate.name}」，当前人设已生效`
          : `已更新「${activeTemplate.name}」，但当前人设没保存成功，请点右上角「保存人设」重试`,
      );
    } catch (cause) {
      setTemplateSaveState('error');
      setTemplateSaveMsg(cause instanceof Error ? cause.message : '模板保存失败');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 删掉一条自定义人设（面板里每行右侧的 ×）。
   * 只删模板本身，编辑框里已经写进去的角色设定不动 —— 删模板不该顺手改人设。
   */
  const deleteTemplate = async (template: PersonaTemplate) => {
    if (busy || template.builtin) return;
    setBusy(true);
    try {
      if (settings.mode === 'live') {
        await api.deletePersona(template.id);
      }
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      // 删掉的正是当前这条 → 清掉 appliedId，否则下拉会指向一个不存在的模板
      if (appliedId === template.id) setAppliedId(null);
      setTemplateSaveState('idle');
      setTemplateSaveMsg(`已删除自定义人设「${template.name}」`);
    } catch (cause) {
      setTemplateSaveState('error');
      setTemplateSaveMsg(cause instanceof Error ? cause.message : '删除自定义人设失败');
    } finally {
      setConfirmDeleteId(null);
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const next = await settings.save({ persona: draft });
    if (next) setBaseline(JSON.stringify(next.persona));
  };

  if (settings.phase === 'loading' || !draft) {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="mt-2 h-4 w-80" />
        <Skeleton className="mt-6 h-96 rounded-xl" />
      </div>
    );
  }

  if (settings.phase === 'error') {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="人设" />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="人设配置加载失败"
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

  // 当前角色设定对应的人设模板。
  // 下拉必须回显它：以前 value 是一个只在下拉 onChange 里赋值的独立 state，
  // 而 onChange 只打开弹窗、不改 state —— Radix 受控 Select 会立刻把显示值弹回去，
  // 于是"点模板没反应"，删除按钮也永远不出现。
  // ⚠️ 比较用 normalizeRoleText（忽略空白）：文本框里手改一个行尾空格不该掉回「未应用模板」。
  // 当前正在编辑的那条模板：优先用记下的 appliedId（改过字也不会掉），
  // 刷新页面 / 换设备时退回按文本反查。
  // ⚠️ 以前只有文本反查：改一个字（哪怕行尾空格）就掉回「未应用模板」，
  //    用户以为模板丢了 → 重新"添加人设" → 列表里多出一条副本，原模板没变。
  const normalizedRole = normalizeRoleText(draft.roleText);
  const appliedTemplate = appliedId
    ? templates.find((item) => item.id === appliedId) ?? null
    : null;
  const textMatchedTemplate =
    templates.find(
      (item) => normalizeRoleText(item.text) && normalizeRoleText(item.text) === normalizedRole,
    ) ?? null;
  const activeTemplate = appliedTemplate ?? textMatchedTemplate;
  // 编辑框里的内容跟模板原文不一样 → 有"未保存回模板"的改动
  const templateDirty = Boolean(
    activeTemplate &&
    draft &&
    (normalizeRoleText(draft.roleText) !== normalizeRoleText(activeTemplate.text) ||
      String(draft.customRules || '') !== String(activeTemplate.customRules || '')),
  );
  const customTemplates = templates.filter((item) => !item.builtin);
  // 新建时重名 → 后端会就地更新那一条（不再默默多出副本），这里提前说清楚
  const nameClash = newName.trim()
    ? templates.find((item) => !item.builtin && item.name.trim() === newName.trim()) ?? null
    : null;
  // 自定义的那条名字里常自带「（自定义）」，别再叠一层
  const templateLabel = (item: PersonaTemplate) =>
    item.builtin || /（自定义）\s*$/.test(item.name) ? item.name : `${item.name}（自定义）`;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="人设"
          description="机器人的性格、口吻与角色设定。角色设定每轮注入，群友不可修改。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SaveStatus dirty={dirty} state={settings.saveState} />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(JSON.parse(baseline) as PersonaConfig);
                  setBackup(null);
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
                disabled={!dirty || settings.saveState === 'saving'}
              >
                <Save />
                保存人设
              </Button>
            </div>
          }
        />

        {settings.saveError ? (
          <div className="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[12px] text-danger" role="alert">
            {settings.saveError}
          </div>
        ) : null}

        <div className="mt-5 space-y-5">
          <SectionCard
            icon={BookMarked}
            title="选择人设模板"
            description="点一条模板即应用（覆盖或追加）；覆盖前会自动备份，可撤销。自定义人设可在列表里点 × 删除。"
            // 下拉面板是卡片内绝对定位的，卡片默认 overflow-hidden 会把它裁掉
            className="overflow-visible"
            actions={
              <div className="flex items-center gap-2">
                {isIntegratedConsole() ? (
                  <Button variant="ghost" size="sm" onClick={openLegacyConsole}>
                    <ExternalLink />
                    旧版设置
                  </Button>
                ) : null}
                <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  添加人设
                </Button>
              </div>
            }
          >
            <div ref={pickerRef} className="relative">
              <Field label="人设模板" htmlFor="persona-template">
                <button
                  type="button"
                  id="persona-template"
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                  onClick={() => {
                    setPickerOpen((open) => !open);
                    setConfirmDeleteId(null);
                  }}
                  className="focus-ring flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-left text-[13px] text-foreground shadow-sm transition-colors hover:border-border-strong"
                >
                  <span className="truncate">
                    {activeTemplate ? templateLabel(activeTemplate) : '未应用模板（当前为手写人设）'}
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 text-muted transition-transform',
                      pickerOpen && 'rotate-180',
                    )}
                  />
                </button>
              </Field>
              {pickerOpen ? (
                <div
                  role="listbox"
                  aria-label="人设模板"
                  className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 animate-fade-in overflow-hidden rounded-xl border border-border bg-elevated text-foreground shadow-popover"
                >
                  {/* 覆盖/追加 + 改名直接放在面板里：点一条就应用，不再弹「确认应用」对话框 */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-2.5 py-2">
                    <div className="flex items-center gap-0.5 rounded-lg bg-surface-muted/70 p-0.5">
                      {(['overwrite', 'append'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={applyMode === mode}
                          onClick={() => setApplyMode(mode)}
                          className={cn(
                            'rounded-md px-2 py-0.5 text-[11px] transition-colors',
                            applyMode === mode
                              ? 'bg-surface text-foreground shadow-sm ring-1 ring-border'
                              : 'text-muted hover:text-foreground',
                          )}
                        >
                          {mode === 'overwrite' ? '覆盖' : '追加'}
                        </button>
                      ))}
                    </div>
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={renameBot}
                        onChange={(event) => setRenameBot(event.target.checked)}
                        className="h-3 w-3 accent-primary"
                      />
                      覆盖时同时改名为模板名
                    </label>
                  </div>
                  <div className="scrollbar-thin max-h-[300px] overflow-y-auto p-1">
                    <button
                      type="button"
                      onClick={() => setPickerOpen(false)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12.5px] text-muted transition-colors hover:bg-surface-muted"
                      title="当前角色设定不来自任何模板（手写/手改）"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {activeTemplate ? null : <Check className="h-3.5 w-3.5 text-primary" />}
                      </span>
                      <span className="truncate">未应用模板（当前为手写人设）</span>
                    </button>
                    {templates.map((item) => {
                      const isActive = activeTemplate?.id === item.id;
                      const confirming = confirmDeleteId === item.id;
                      return (
                        <div
                          key={item.id}
                          className={cn(
                            'flex items-center gap-1 rounded-md transition-colors',
                            isActive ? 'bg-surface-muted/60' : 'hover:bg-surface-muted',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => applyTemplate(item)}
                            title={
                              item.builtin
                                ? `${item.name}（内置模板，写在代码里，删不掉）`
                                : `${item.name}（点击应用）`
                            }
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-[12.5px]"
                          >
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                              {isActive ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                            </span>
                            <span className="truncate">{templateLabel(item)}</span>
                          </button>
                          {item.builtin ? null : confirming ? (
                            <span className="flex shrink-0 items-center gap-1 pr-1.5">
                              <button
                                type="button"
                                onClick={() => void deleteTemplate(item)}
                                disabled={busy}
                                className="rounded-md bg-danger-soft px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-60"
                              >
                                删除
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(item.id)}
                              aria-label={`删除自定义人设「${item.name}」`}
                              title="删除这条自定义人设"
                              className="mr-1.5 shrink-0 rounded-md p-1 text-muted/70 transition-colors hover:bg-danger-soft hover:text-danger"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {templates.length ? null : (
                      <p className="px-2 py-2 text-[11px] text-muted">还没读到任何模板。</p>
                    )}
                  </div>
                  <p className="border-t border-border px-2.5 py-1.5 text-[10.5px] leading-4 text-muted">
                    点一条即应用（原内容已备份，可撤销）；自定义人设右侧 × 可删除，内置模板写在代码里删不掉。
                  </p>
                </div>
              ) : null}
            </div>
            {activeTemplate ? (
              <p className="mt-2 text-[11px] text-muted">
                当前模板：<span className="text-fg">{activeTemplate.name}</span>
                {activeTemplate.builtin ? '（内置，改不了，只能另存副本）' : '（自定义，可直接保存回去）'}
                {templateDirty ? (
                  <span className="ml-1 text-warning">· 有改动还没存回模板</span>
                ) : null}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-muted">
                当前是手写人设，不属于任何模板；想留存就点右侧「存为新模板」。
              </p>
            )}
            {templatesError ? (
              <p className="mt-2 text-[11px] text-danger">
                人设模板列表读取失败（{templatesError}）；下拉里只保留"未应用模板"，不会用占位文本顶替你的角色设定。
              </p>
            ) : null}
            {customTemplates.length ? (
              <div className="mt-3 rounded-lg border border-border bg-surface-muted/30 px-3 py-2.5">
                <p className="text-[11px] text-muted">
                  自定义人设（{customTemplates.length}）· 删除请点上方模板右侧的 ×
                </p>
                <ul className="mt-1.5 space-y-1">
                  {customTemplates.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {activeTemplate?.id === item.id ? (
                        <Badge variant="success" className="px-1.5 py-0">
                          当前
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {backup ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-surface-muted/40 px-3 py-2">
                <span className="text-[11px] text-muted">已备份应用前的角色设定 / 名字 / 附加规则</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-7 text-[11px]"
                  onClick={() => {
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            roleText: backup.roleText,
                            customRules: backup.customRules,
                            botName: backup.botName,
                          }
                        : current,
                    );
                    setBackup(null);
                  }}
                >
                  <RotateCcw />
                  撤销上次应用
                </Button>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            icon={BookMarked}
            title="角色与展示"
            description="机器人名字、群内展示名和参与度会写入系统提示。"
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <TextField
                id="persona-botname"
                label="机器人名字"
                value={draft.botName}
                onChange={(value) => update('botName', value)}
                placeholder="小鲸鱼"
              />
              <TextField
                id="persona-selfnick"
                label="群内展示名（可选）"
                value={draft.selfNickname}
                onChange={(value) => update('selfNickname', value)}
                placeholder="留空则使用 QQ 昵称"
              />
              <SelectField
                id="persona-participation"
                label="参与度"
                value={draft.participation}
                onChange={(value) => update('participation', value)}
                options={[
                  { value: 'low', label: '安静型' },
                  { value: 'medium', label: '普通群友' },
                  { value: 'high', label: '活跃型' },
                ]}
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={BookMarked}
            title="角色设定"
            description="每轮注入系统提示，群友不可修改。支持较长角色卡。"
            actions={
              activeTemplate && !activeTemplate.builtin ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void saveToTemplate()}
                  disabled={!templateDirty || busy || templateSaveState === 'saving'}
                  title={
                    activeTemplate.builtin
                      ? '内置模板写在代码里，不能覆盖'
                      : '把上面的文字直接写回这条模板'
                  }
                >
                  <Save />
                  保存回「{activeTemplate.name}」
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={openCreateFromDraft} disabled={busy}>
                  <Plus />
                  {activeTemplate ? '另存为自定义人设' : '存为新模板'}
                </Button>
              )
            }
          >
            <Field label="角色设定" htmlFor="persona-roletext">
              <Textarea
                id="persona-roletext"
                value={draft.roleText}
                onChange={(event) => update('roleText', event.target.value)}
                className="min-h-[260px] font-mono text-[12px] leading-6"
                placeholder="例如：你是运维群里的老油条……"
              />
            </Field>
            <div className="mt-4">
              <Field
                label="管理员附加规则（可选）"
                htmlFor="persona-customrules"
                description="追加到系统提示末尾，适合临时约束或管理员指令。"
              >
                <Textarea
                  id="persona-customrules"
                  value={draft.customRules}
                  onChange={(event) => update('customRules', event.target.value)}
                  className="min-h-[100px]"
                  placeholder="例如：不要在群里提及本次配置。"
                />
              </Field>
            </div>
            {templateSaveMsg ? (
              <p
                className={
                  templateSaveState === 'error'
                    ? 'mt-3 text-[11px] text-danger'
                    : 'mt-3 text-[11px] text-success'
                }
              >
                {templateSaveMsg}
              </p>
            ) : null}
            {activeTemplate?.builtin ? (
              <p className="mt-3 text-[11px] text-muted">
                「{activeTemplate.name}」是内置模板，写在代码里，改不动；改完点右上角「另存为自定义人设」，
                会存成一条新的自定义人设并自动选中它。
              </p>
            ) : null}
          </SectionCard>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加自定义人设</DialogTitle>
            <DialogDescription>自定义人设保存在配置里，可重复选用。</DialogDescription>
          </DialogHeader>
          <div className="mt-3 space-y-3">
            <Field label="人设名称" htmlFor="new-persona-name">
              <input
                id="new-persona-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                className="focus-ring h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px]"
                placeholder="例如：毒舌老哥"
              />
            </Field>
            {nameClash ? (
              <p className="rounded-lg border border-warning/30 bg-warning-soft/40 px-3 py-2 text-[11px] text-warning">
                已存在同名自定义人设「{nameClash.name}」：保存会<span className="font-medium">更新那一条</span>，不会新增副本。
                想另存一份请改个名字。
              </p>
            ) : null}
            <Field label="角色设定" htmlFor="new-persona-text">
              <Textarea
                id="new-persona-text"
                value={newText}
                onChange={(event) => setNewText(event.target.value)}
                className="min-h-[160px]"
                placeholder="写下角色卡内容…"
              />
            </Field>
            <Field
              label="管理员附加规则（可选）"
              htmlFor="new-persona-rules"
              description="随人设一起保存，应用该人设时追加到系统提示末尾。"
            >
              <Textarea
                id="new-persona-rules"
                value={newRules}
                onChange={(event) => setNewRules(event.target.value)}
                className="min-h-[80px]"
                placeholder="例如：不要在群里提及本次配置。"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="md" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => void createPersona()}
              disabled={busy || !newName.trim() || !newText.trim()}
            >
              添加人设
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
