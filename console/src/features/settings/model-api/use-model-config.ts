import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrainPreset,
  ModelConfigBundle,
  PresetId,
  Provider,
} from '@/types';
import { api } from '@/lib/api';
import { demoModelConfig, demoPresets } from '@/lib/demo-data';
import { maskSecret } from '@/lib/format';
import { sleep } from '@/lib/utils';
import { useConsoleMode } from '@/providers/console-mode-provider';
import { useToast } from '@/providers/toast-provider';

export const PARAM_LIMITS = {
  temperature: { min: 0, max: 2, step: 0.1 },
  maxRounds: { min: 1, max: 40, step: 1 },
  maxOutputTokens: { min: 64, max: 4096, step: 64 },
  complexMaxOutputTokens: { min: 64, max: 8192, step: 64 },
} as const;

export interface ModelForm {
  providerId: string;
  baseUrl: string;
  model: string;
  temperature: number | null;
  maxRounds: number | null;
  maxOutputTokens: number | null;
  complexMaxOutputTokens: number | null;
  complexModel: string;
  thinkingMode: 'off' | 'auto';
  vision: boolean;
  routing: {
    enabled: boolean;
    auto: boolean;
    allowModelEscalation: boolean;
  };
  visionMode: 'native' | 'qwen';
  qwenBaseUrl: string;
  qwenModel: string;
  webSearchEnabled: boolean;
  webSearchProvider: 'auto' | 'bing' | 'anysearch';
  searchUrl: string;
  preset: PresetId | null;
}

export type FormErrors = Partial<
  Record<keyof ModelForm | 'apiKey' | 'qwenKey', string>
>;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type AsyncState = 'idle' | 'running' | 'success' | 'error';

function formFromBundle(bundle: ModelConfigBundle): ModelForm {
  return {
    providerId: bundle.api.provider,
    baseUrl: bundle.api.baseUrl,
    model: bundle.api.model,
    temperature: bundle.api.temperature,
    maxRounds: bundle.api.maxRounds,
    maxOutputTokens: bundle.api.maxOutputTokens,
    complexMaxOutputTokens: bundle.api.complexMaxOutputTokens,
    complexModel: bundle.api.complexModel,
    thinkingMode: bundle.api.thinkingMode,
    vision: bundle.api.vision,
    routing: { ...bundle.api.routing },
    visionMode: bundle.vision.mode,
    qwenBaseUrl: bundle.vision.qwen.baseUrl,
    qwenModel: bundle.vision.qwen.model,
    webSearchEnabled: bundle.webSearch.enabled,
    webSearchProvider: bundle.webSearch.provider,
    searchUrl: bundle.webSearch.searchUrl,
    preset: (bundle.api.preset as PresetId | null) ?? null,
  };
}

function serializeForm(form: ModelForm) {
  return JSON.stringify(form);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(value: string) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function validate(
  form: ModelForm,
  options: {
    keyConfigured: boolean;
    keyValue: string;
    providerChanged: boolean;
    qwenConfigured: boolean;
    qwenKeyValue: string;
  },
): FormErrors {
  const errors: FormErrors = {};
  if (!form.providerId) errors.providerId = '请选择服务商';
  if (!form.baseUrl.trim()) errors.baseUrl = '请输入 Base URL';
  else if (!isHttpUrl(form.baseUrl.trim())) errors.baseUrl = '请输入以 http:// 或 https:// 开头的地址';
  if (!form.model.trim()) errors.model = '请选择或填写模型';
  if (!options.keyConfigured && !options.keyValue.trim()) {
    errors.apiKey = '该服务商尚未配置密钥';
  }

  const checkNumber = (
    key: 'temperature' | 'maxRounds' | 'maxOutputTokens' | 'complexMaxOutputTokens',
    label: string,
    integer = false,
  ) => {
    const value = form[key];
    const limits = PARAM_LIMITS[key];
    if (value == null) {
      errors[key] = `请输入${label}`;
      return;
    }
    if (!Number.isFinite(value)) {
      errors[key] = `${label}必须是有效数字`;
      return;
    }
    if (integer && !Number.isInteger(value)) {
      errors[key] = `${label}必须是整数`;
      return;
    }
    if (value < limits.min || value > limits.max) {
      errors[key] = `范围 ${limits.min}–${limits.max}`;
    }
  };

  checkNumber('temperature', '温度');
  checkNumber('maxRounds', '工具轮数', true);
  checkNumber('maxOutputTokens', '普通输出上限', true);
  checkNumber('complexMaxOutputTokens', '复杂输出上限', true);

  if (form.webSearchEnabled) {
    if (!form.searchUrl.trim()) errors.searchUrl = '请输入搜索地址';
    else if (!isHttpUrl(form.searchUrl.trim())) errors.searchUrl = '请输入有效的 HTTP(S) 地址';
  }

  if (form.vision && form.visionMode === 'qwen') {
    if (!form.qwenBaseUrl.trim()) errors.qwenBaseUrl = '请输入 Qwen-VL Base URL';
    else if (!isHttpUrl(form.qwenBaseUrl.trim())) errors.qwenBaseUrl = '请输入有效的 HTTP(S) 地址';
    if (!form.qwenModel.trim()) errors.qwenModel = '请输入识图模型';
    if (!options.qwenConfigured && !options.qwenKeyValue.trim()) {
      errors.qwenKey = 'Qwen-VL 尚未配置密钥';
    }
  }

  return errors;
}

function matchesPreset(form: ModelForm, preset: BrainPreset) {
  return (
    form.temperature === preset.temperature &&
    form.maxRounds === preset.maxRounds &&
    form.maxOutputTokens === preset.maxOutputTokens &&
    form.complexMaxOutputTokens === preset.complexMaxOutputTokens &&
    form.thinkingMode === preset.thinkingMode
  );
}

export function useModelConfig() {
  const { mode } = useConsoleMode();
  const toast = useToast();
  const [bundle, setBundle] = useState<ModelConfigBundle | null>(null);
  const [presets, setPresets] = useState<BrainPreset[]>(demoPresets);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [baseline, setBaseline] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [qwenKeyValue, setQwenKeyValue] = useState('');
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyHint, setKeyHint] = useState('');
  const [qwenConfigured, setQwenConfigured] = useState(false);
  const [qwenHint, setQwenHint] = useState('');
  const [testState, setTestState] = useState<AsyncState>('idle');
  const [testNote, setTestNote] = useState('');
  const [fetchState, setFetchState] = useState<AsyncState>('idle');
  const [fetchNote, setFetchNote] = useState('');
  const originProvider = useRef('');
  const loadRequest = useRef(0);

  const applyBundle = useCallback((next: ModelConfigBundle, restorableKey = true) => {
    setBundle(next);
    const nextForm = formFromBundle(next);
    setForm(nextForm);
    setBaseline(serializeForm(nextForm));
    originProvider.current = next.api.provider;
    if (restorableKey) {
      setKeyConfigured(next.api.apiKeyConfigured);
      setKeyHint(next.api.apiKeyHint);
      setQwenConfigured(next.vision.qwen.apiKeyConfigured);
      setQwenHint(next.vision.qwen.apiKeyHint);
    }
    setApiKeyValue('');
    setQwenKeyValue('');
  }, []);

  const load = useCallback(async () => {
    const current = ++loadRequest.current;
    setPhase('loading');
    setLoadError(null);
    try {
      if (mode === 'demo') {
        await sleep(220);
        if (current !== loadRequest.current) return;
        applyBundle(demoModelConfig);
        setPresets(demoPresets);
      } else {
        const [config, presetList] = await Promise.all([api.config(), api.presets()]);
        if (current !== loadRequest.current) return;
        applyBundle(config);
        setPresets(presetList.length ? presetList : demoPresets);
      }
      setPhase('ready');
      setSaveState('idle');
    } catch (error) {
      if (current !== loadRequest.current) return;
      setPhase('error');
      setLoadError(error instanceof Error ? error.message : '模型配置读取失败');
    }
  }, [applyBundle, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = bundle?.providers ?? [];
  const provider: Provider | undefined = useMemo(
    () => providers.find((item) => item.id === form?.providerId),
    [form?.providerId, providers],
  );

  /**
   * 服务商目录的就地更新（增 / 改 / 删都不重新 load）。
   *
   * 为什么不用 `load()` 刷新：它会把 `phase` 置成 `loading`，页面随即早退成骨架屏。
   * 「管理服务商」里每点一次（上移、删模型、保存）都会闪一次白屏，已经打开的
   * 对话框还会被整个卸载重建 —— 这就是界面点起来卡的原因。
   * 而那几个接口本身已经回传了最新的 provider，直接合并即可：零额外请求、不打断操作。
   */
  const providersRef = useRef<Provider[]>([]);

  useEffect(() => {
    providersRef.current = bundle?.providers ?? [];
  }, [bundle?.providers]);

  /** 只修「已经失效的选择」，不碰用户正在编辑的其他字段。 */
  const reconcileForm = useCallback((list: Provider[]) => {
    setForm((current) => {
      if (!current) return current;
      const active = list.find((item) => item.id === current.providerId);
      if (active) {
        if (active.models.includes(current.model)) return current;
        return { ...current, model: active.models[0] ?? '' };
      }
      // 当前选中的服务商被删掉了：退到第一家，一家都不剩就清空，让校验提示去接手。
      const fallback = list[0];
      if (!fallback) return { ...current, providerId: '', model: '' };
      return {
        ...current,
        providerId: fallback.id,
        baseUrl: fallback.baseURL,
        model: fallback.models[0] ?? '',
      };
    });
  }, []);

  const commitProviders = useCallback(
    (list: Provider[]) => {
      providersRef.current = list;
      setBundle((current) => (current ? { ...current, providers: list } : current));
      reconcileForm(list);
    },
    [reconcileForm],
  );

  const applyProviderPatch = useCallback(
    (incoming?: Provider | null) => {
      if (!incoming?.id) return;
      const list = providersRef.current.slice();
      const index = list.findIndex((item) => item.id === incoming.id);
      if (index >= 0) list[index] = { ...list[index], ...incoming };
      else list.push(incoming);
      commitProviders(list);
    },
    [commitProviders],
  );

  const applyProviderRemoval = useCallback(
    (providerId: string) => {
      commitProviders(providersRef.current.filter((item) => item.id !== providerId));
    },
    [commitProviders],
  );

  const matchedPreset = useMemo(() => {
    if (!form) return null;
    return presets.find((preset) => matchesPreset(form, preset)) ?? null;
  }, [form, presets]);

  const errors = useMemo(() => {
    if (!form) return {};
    return validate(form, {
      keyConfigured,
      keyValue: apiKeyValue,
      providerChanged: originProvider.current !== '' && form.providerId !== originProvider.current,
      qwenConfigured,
      qwenKeyValue,
    });
  }, [apiKeyValue, form, keyConfigured, qwenConfigured, qwenKeyValue]);

  const dirty = useMemo(() => {
    if (!form) return false;
    return (
      serializeForm(form) !== baseline ||
      apiKeyValue.trim().length > 0 ||
      qwenKeyValue.trim().length > 0
    );
  }, [apiKeyValue, baseline, form, qwenKeyValue]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const setField = useCallback(<K extends keyof ModelForm>(key: K, value: ModelForm[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSaveState('idle');
    setSaveError(null);
  }, []);

  const changeProvider = useCallback(
    (providerId: string) => {
      const nextProvider = providers.find((item) => item.id === providerId);
      if (!nextProvider) return;
      setForm((current) =>
        current
          ? {
              ...current,
              providerId,
              baseUrl: nextProvider.baseURL,
              model: nextProvider.models[0] ?? '',
            }
          : current,
      );
      setApiKeyValue('');
      if (providerId === originProvider.current) {
        setKeyConfigured(bundle?.api.apiKeyConfigured ?? false);
        setKeyHint(bundle?.api.apiKeyHint ?? '');
      } else {
        setKeyConfigured(Boolean(nextProvider.hasKey));
        setKeyHint(nextProvider.apiKey || '');
      }
      setTestState('idle');
      setTestNote('');
      setSaveState('idle');
      setSaveError(null);
    },
    [bundle?.api.apiKeyConfigured, bundle?.api.apiKeyHint, providers],
  );

  const applyPreset = useCallback((presetId: string) => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    setForm((current) =>
      current
        ? {
            ...current,
            temperature: preset.temperature,
            maxRounds: preset.maxRounds,
            maxOutputTokens: preset.maxOutputTokens,
            complexMaxOutputTokens: preset.complexMaxOutputTokens,
            thinkingMode: preset.thinkingMode,
            preset: preset.id,
          }
        : current,
    );
    setSaveState('idle');
    setSaveError(null);
  }, [presets]);

  const discard = useCallback(() => {
    if (!form) return;
    const restored = JSON.parse(baseline) as ModelForm;
    setForm(restored);
    setApiKeyValue('');
    setQwenKeyValue('');
    setKeyConfigured(bundle?.api.apiKeyConfigured ?? false);
    setKeyHint(bundle?.api.apiKeyHint ?? '');
    setQwenConfigured(bundle?.vision.qwen.apiKeyConfigured ?? false);
    setQwenHint(bundle?.vision.qwen.apiKeyHint ?? '');
    setShowErrors(false);
    setSaveError(null);
    setSaveState('idle');
    setTestState('idle');
    setTestNote('');
  }, [baseline, bundle, form]);

  const save = useCallback(async () => {
    if (!form) return false;
    setShowErrors(true);
    const nextErrors = validate(form, {
      keyConfigured,
      keyValue: apiKeyValue,
      providerChanged: originProvider.current !== '' && form.providerId !== originProvider.current,
      qwenConfigured,
      qwenKeyValue,
    });
    const errorCount = Object.keys(nextErrors).length;
    if (errorCount > 0) {
      setSaveState('error');
      setSaveError(`请先修正 ${errorCount} 个字段后再保存。`);
      window.setTimeout(() => {
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      }, 0);
      return false;
    }

    setSaveState('saving');
    setSaveError(null);
    try {
      const apiPatch: Record<string, unknown> = {
        provider: form.providerId,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        temperature: form.temperature,
        maxRounds: form.maxRounds,
        maxOutputTokens: form.maxOutputTokens,
        complexMaxOutputTokens: form.complexMaxOutputTokens,
        complexModel: form.complexModel.trim(),
        thinkingMode: form.thinkingMode,
        vision: form.vision,
        routing: { ...form.routing },
        // 没匹配到任何预设就是「自定义参数」，不能写一个后端不认识的 'custom' 进去
        preset: matchedPreset?.id ?? null,
      };
      if (apiKeyValue.trim()) apiPatch.apiKey = apiKeyValue.trim();

      const visionPatch = {
        mode: form.visionMode,
        qwen: {
          baseUrl: form.qwenBaseUrl.trim(),
          model: form.qwenModel.trim(),
          ...(qwenKeyValue.trim() ? { apiKey: qwenKeyValue.trim() } : {}),
        },
      };

      const webSearchPatch = {
        enabled: form.webSearchEnabled,
        provider: form.webSearchProvider,
        searchUrl: form.searchUrl.trim(),
      };

      if (mode === 'demo') {
        await sleep(380);
        const typedKey = apiKeyValue.trim();
        const typedQwenKey = qwenKeyValue.trim();
        const nextBundle: ModelConfigBundle = {
          ...bundle!,
          api: {
            ...bundle!.api,
            provider: form.providerId,
            baseUrl: form.baseUrl.trim(),
            model: form.model.trim(),
            temperature: form.temperature ?? 0,
            maxRounds: form.maxRounds ?? 0,
            maxOutputTokens: form.maxOutputTokens ?? 0,
            complexMaxOutputTokens: form.complexMaxOutputTokens ?? 0,
            complexModel: form.complexModel.trim(),
            thinkingMode: form.thinkingMode,
            vision: form.vision,
            routing: { ...form.routing },
            preset: matchedPreset?.id ?? null,
            apiKeyConfigured: keyConfigured || Boolean(typedKey),
            apiKeyHint: typedKey ? maskSecret(typedKey) : keyHint,
          },
          vision: {
            ...bundle!.vision,
            mode: form.visionMode,
            qwen: {
              ...bundle!.vision.qwen,
              baseUrl: form.qwenBaseUrl.trim(),
              model: form.qwenModel.trim(),
              apiKeyConfigured: qwenConfigured || Boolean(typedQwenKey),
              apiKeyHint: typedQwenKey ? maskSecret(typedQwenKey) : qwenHint,
            },
          },
          webSearch: {
            ...bundle!.webSearch,
            enabled: form.webSearchEnabled,
            provider: form.webSearchProvider,
            searchUrl: form.searchUrl.trim(),
          },
        };
        applyBundle(nextBundle);
        setPresets((current) => current);
        setSaveState('saved');
        toast({
          title: '已保存到本地演示状态',
          description: '演示模式不会写入 QQ Agent 后端；连接本地服务后才会真实保存。',
          variant: 'success',
        });
        return true;
      }

      const saved = await api.saveConfig({
        api: apiPatch,
        vision: visionPatch,
        webSearch: webSearchPatch,
      });
      // 回包必须是完整配置。拿到空壳（比如哪天又忘了拆 { ok, config }）就绝对不能
      // applyBundle——那会把表单清成空值、密钥变「未保存」，用户只能全部重填一遍。
      if (saved.api.baseUrl && saved.api.provider) {
        applyBundle(saved);
      } else {
        await load();
      }
      setSaveState('saved');
      toast({
        title: '模型配置已保存',
        description: '下一次运行会使用新的模型与参数。',
        variant: 'success',
      });
      return true;
    } catch (error) {
      setSaveState('error');
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试');
      return false;
    }
  }, [
    apiKeyValue,
    applyBundle,
    bundle,
    form,
    keyConfigured,
    keyHint,
    load,
    matchedPreset?.id,
    mode,
    qwenConfigured,
    qwenHint,
    qwenKeyValue,
    toast,
  ]);

  const testConnection = useCallback(async () => {
    if (!form) return;
    if (mode === 'demo') {
      setTestState('idle');
      setTestNote('');
      toast({
        title: '演示模式不发起真实请求',
        description: '连接本地服务并输入新密钥后，测试才会真正请求模型。',
        variant: 'info',
      });
      return;
    }
    if (!form.baseUrl.trim() || !form.model.trim()) {
      setTestState('error');
      setTestNote('请先填写 Base URL 和模型。');
      return;
    }
    const providerSame = form.providerId === bundle?.api.provider;
    const baseUnchanged =
      stripTrailingSlash(form.baseUrl) === stripTrailingSlash(bundle?.api.baseUrl ?? '');
    const savedKeyUsable =
      keyConfigured && (providerSame ? baseUnchanged : Boolean(provider?.hasKey));
    if (!apiKeyValue.trim() && !savedKeyUsable) {
      setTestState('error');
      setTestNote(
        providerSame
          ? 'Base URL 已修改，请输入新密钥后再测试，避免把已保存密钥发到新地址。'
          : '该服务商尚未保存密钥，请输入新密钥后再测试。',
      );
      return;
    }
    setTestState('running');
    setTestNote('');
    try {
      const result = apiKeyValue.trim()
        ? await api.testChat({
            baseUrl: form.baseUrl.trim(),
            apiKey: apiKeyValue.trim(),
            model: form.model.trim(),
          })
        : await api.testSavedKey({
            providerId: form.providerId,
            model: form.model.trim(),
          });
      const ok = result.ok !== false;
      setTestState(ok ? 'success' : 'error');
      const latency = Number(result.latencyMs);
      const note = typeof result.note === 'string' ? result.note : '';
      const usedSaved = !apiKeyValue.trim();
      setTestNote(
        ok
          ? `连接成功${Number.isFinite(latency) ? ` · ${latency}ms` : ''}${note ? ` · ${note}` : ''}${
              usedSaved ? ' · 使用已保存密钥' : ''
            }`
          : note || '上游返回失败，请检查模型与密钥。',
      );
    } catch (error) {
      setTestState('error');
      setTestNote(error instanceof Error ? error.message : '测试请求失败');
    }
  }, [apiKeyValue, bundle, form, keyConfigured, mode, provider, toast]);

  const fetchModels = useCallback(async () => {
    if (!form) return;
    if (mode === 'demo') {
      setFetchState('idle');
      setFetchNote('');
      toast({
        title: '演示模式不发起真实请求',
        description: '连接本地服务并输入新密钥后，才能从服务商拉取模型列表。',
        variant: 'info',
      });
      return;
    }
    if (!form.baseUrl.trim()) {
      setFetchState('error');
      setFetchNote('请先填写 Base URL。');
      return;
    }
    // 已保存的密钥可以用：后端只会把它用在同一个 Base URL 上（见 resolveRequestKey），
    // 所以这里不必强迫用户为了刷新一次模型列表重新粘贴一遍 key。
    const reusesSavedKey = Boolean(
      keyConfigured &&
        (form.providerId === bundle?.api.provider
          ? stripTrailingSlash(form.baseUrl) === stripTrailingSlash(bundle?.api.baseUrl ?? '')
          : provider?.hasKey),
    );
    if (!apiKeyValue.trim() && !reusesSavedKey) {
      setFetchState('error');
      setFetchNote('请先输入该服务商的密钥，或先保存一次 Base URL 与密钥。');
      return;
    }
    setFetchState('running');
    setFetchNote('');
    try {
      const models = await api.fetchModels({
        baseUrl: form.baseUrl.trim(),
        apiKey: apiKeyValue.trim(),
      });
      if (!models.length) {
        setFetchState('error');
        setFetchNote('服务商没有返回可用模型。');
        return;
      }
      // 拉到之后必须写进模型目录：模型列表只存在后端 providers[] 里，
      // 只改前端 state 的话「保存设置」不会带上它，刷新页面就白拉了。
      const providerId = form.providerId;
      const known = bundle?.providers.find((item) => item.id === providerId);
      const sameBase = known
        ? stripTrailingSlash(known.baseURL) === stripTrailingSlash(form.baseUrl.trim())
        : false;
      if (sameBase) {
        await api.addProviderModels(providerId, models);
        setBundle((current) => {
          if (!current) return current;
          return {
            ...current,
            providers: current.providers.map((item) =>
              item.id === providerId
                ? (() => {
                    // 后端是「追加」语义：本地也必须是并集，否则刚拉完列表，
                    // 目录里原有但服务商没返回的模型会从下拉里消失。
                    const merged = [...item.models];
                    for (const model of models) if (!merged.includes(model)) merged.push(model);
                    const modelNames: Record<string, string> = { ...item.modelNames };
                    for (const model of merged) modelNames[model] = modelNames[model] ?? model;
                    return { ...item, models: merged, modelNames };
                  })()
                : item,
            ),
          };
        });
        setFetchState('success');
        setFetchNote(`已获取 ${models.length} 个模型，并写入模型目录。`);
      } else {
        // 新 Base URL：目录里没有这个服务商，新建一个（后端会生成 id 并切过去）
        await api.createProvider({
          baseUrl: form.baseUrl.trim(),
          apiKey: apiKeyValue.trim(),
          models,
        });
        await load();
        setFetchState('success');
        setFetchNote(`已新建服务商并写入 ${models.length} 个模型。`);
      }
    } catch (error) {
      setFetchState('error');
      setFetchNote(error instanceof Error ? error.message : '获取模型列表失败');
    }
  }, [
    apiKeyValue,
    bundle?.api.baseUrl,
    bundle?.api.provider,
    bundle?.providers,
    form,
    keyConfigured,
    load,
    mode,
    provider?.hasKey,
    toast,
  ]);

  return {
    mode,
    phase,
    loadError,
    bundle,
    form,
    presets,
    providers,
    provider,
    providerChanged:
      Boolean(originProvider.current) && form?.providerId !== originProvider.current,
    canTestSaved: Boolean(
      form &&
        keyConfigured &&
        (form.providerId === bundle?.api.provider
          ? stripTrailingSlash(form.baseUrl) === stripTrailingSlash(bundle?.api.baseUrl ?? '')
          : provider?.hasKey),
    ),
    matchedPreset,
    errors: showErrors ? errors : ({} as FormErrors),
    allErrors: errors,
    showErrors,
    dirty,
    saveState,
    saveError,
    setField,
    changeProvider,
    applyProviderPatch,
    applyProviderRemoval,
    applyPreset,
    apiKeyValue,
    setApiKeyValue,
    keyConfigured,
    keyHint,
    qwenKeyValue,
    setQwenKeyValue,
    qwenConfigured,
    qwenHint,
    testState,
    testNote,
    fetchState,
    fetchNote,
    save,
    discard,
    testConnection,
    fetchModels,
    reload: load,
  };
}
