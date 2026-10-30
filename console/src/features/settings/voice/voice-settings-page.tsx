import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AudioLines,
  ExternalLink,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Undo2,
  Users,
  Wand2,
} from 'lucide-react';
import type { AudioConfig, RvcStatus } from '@/types';
import { api } from '@/lib/api';
import { isIntegratedConsole, openLegacyConsole } from '@/lib/integration';
import { cn } from '@/lib/utils';
import { useSettingsConfig } from '@/hooks/use-settings-config';
import { useToast } from '@/providers/toast-provider';
import { PageHeader } from '@/components/page-header';
import { SectionCard } from '@/components/section-card';
import { EmptyState } from '@/components/empty-state';
import { SaveStatus } from '@/components/save-status';
import { NumberField, SelectField, TextField, ToggleRow } from '@/components/settings-field';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const ttsModels = [
  'qwen-audio-3.0-tts-plus',
  'qwen-audio-3.0-tts-flash',
  'cosyvoice-v3-flash',
];

const methods = [
  { value: 'rmvpe', label: 'rmvpe（质量最好，推荐）' },
  { value: 'harvest', label: 'harvest（稳）' },
  { value: 'pm', label: 'pm（最快）' },
  { value: 'crepe', label: 'crepe（最慢）' },
];

// 必须与后端 route_a.py --separator 的 choices 一一对应（src/svc-voice.js::SEPARATOR_MODELS）。
// 前端多写一个值，后端 argparse 直接退出码 2，整单翻唱失败。
const separatorModels = [
  { value: 'htdemucs', label: 'Demucs v4（默认，速度正常）' },
  { value: 'htdemucs_ft', label: 'Demucs 微调版（人声更干净，慢约 4 倍）' },
  { value: 'mdx_kim', label: 'UVR MDX Kim Vocal 2（密集编曲泄漏少）' },
  { value: 'mdx_vocft', label: 'UVR MDX-NET Voc_FT（同系，风格略不同）' },
];

type GsvVoice = {
  key: string;
  name: string;
  version: string;
  emotions: string[];
  speed: number;
  available: boolean;
  missing: string[];
  loaded: boolean;
};

/** 试听可选的 16 种情绪（与 src/voice-delivery.js 的 TONE_TABLE 对应）。 */
const TONE_EMOTIONS = [
  '开心', '兴奋', '得意', '好奇', '害羞', '别扭', '委屈', '失落',
  '没劲', '嫌弃', '假生气', '心疼', '累', '平静', '吃惊', '恐惧',
];

type GsvToneCoverage = {
  voice: string;
  refEmotions: string[];
  paramOnly: string[];
  tags: string[];
};

type GsvVoicesResponse = {
  ok: boolean;
  service: { ok: boolean; reason?: string };
  current: string;
  allowModelPick: boolean;
  autoStart: boolean;
  preferOverGsv: boolean;
  toneAuto?: boolean;
  toneStrength?: number;
  toneParams?: boolean;
  voices: GsvVoice[];
  coverage?: GsvToneCoverage[];
};

/** 演示模式下的音色清单（与本地 GSV_VOICES 对应，仅供预览界面）。 */
const demoGsvVoices: GsvVoice[] = [
  { key: 'hutao', name: '胡桃', version: 'v4', emotions: ['中立', '开心', '生气', '难过', '吃惊', '恐惧'], speed: 1, available: true, missing: [], loaded: false },
  { key: 'nahida', name: '纳西妲', version: 'v4', emotions: ['中立', '开心', '生气', '难过', '吃惊', '恐惧'], speed: 1, available: true, missing: [], loaded: false },
  { key: 'liuying', name: '流萤', version: 'v2ProPlus', emotions: ['中立', '开心', '生气', '难过', '吃惊', '恐惧'], speed: 1, available: true, missing: [], loaded: false },
  { key: 'furina', name: '芙宁娜', version: 'v4', emotions: ['中立', '开心', '生气', '难过', '吃惊', '恐惧'], speed: 1, available: true, missing: [], loaded: false },
  { key: 'ayaka', name: '神里绫华', version: 'v4', emotions: ['中立', '开心', '生气', '难过', '吃惊', '恐惧'], speed: 1.15, available: true, missing: [], loaded: false },
  { key: 'sparkle', name: '花火', version: 'v2ProPlus', emotions: ['中立', '开心', '生气', '难过', '吃惊', '恐惧'], speed: 1, available: true, missing: [], loaded: false },
];

const previewEmotionOptions = [
  { value: 'auto', label: '自动（按当前心情）' },
  ...TONE_EMOTIONS.map((name) => ({ value: name, label: name })),
];

function statusText(status: RvcStatus | null) {
  if (!status) return '状态不可用';
  if (!status.enabled) return '已禁用（配置中未启用 RVC）';
  if (!status.running) return '未运行';
  if (status.health?.loaded) {
    return `已加载 ${status.health.model || ''} · ${status.health.device || ''}${
      status.health.gpu ? ` · ${status.health.gpu}` : ''
    }`;
  }
  return '运行中，模型尚未加载完成';
}

export function VoiceSettingsPage() {
  const settings = useSettingsConfig();
  const toast = useToast();
  const [draft, setDraft] = useState<AudioConfig | null>(null);
  const [baseline, setBaseline] = useState('');
  const [rvc, setRvc] = useState<RvcStatus | null>(null);
  const [rvcLoading, setRvcLoading] = useState(false);
  const [servicePending, setServicePending] = useState('');
  const [gsv, setGsv] = useState<GsvVoicesResponse | null>(null);
  const [gsvLoading, setGsvLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [gsvStarting, setGsvStarting] = useState(false);
  /** 试听用的情绪（跟真正发语音时一样，走 resolveTone 那条路） */
  const [previewEmotion, setPreviewEmotion] = useState('auto');

  useEffect(() => {
    if (!settings.config) return;
    const next = structuredClone(settings.config.audio);
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [settings.config]);

  const loadRvc = async () => {
    setRvcLoading(true);
    try {
      if (settings.mode === 'demo') {
        setRvc({
          ok: true,
          enabled: true,
          running: true,
          health: {
            ok: true,
            loaded: true,
            model: 'hutao',
            device: 'cuda:0',
            gpu: '演示 GPU',
            uptimeSec: 120,
          },
          models: [{ name: 'hutao' }, { name: 'nahida' }, { name: 'huahuo' }],
        });
      } else {
        setRvc(await api.rvcStatus());
      }
    } catch {
      setRvc(null);
    } finally {
      setRvcLoading(false);
    }
  };

  useEffect(() => {
    void loadRvc();
  }, [settings.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadGsv = async () => {
    setGsvLoading(true);
    try {
      if (settings.mode === 'demo') {
        setGsv({
          ok: true,
          service: { ok: true },
          current: 'hutao',
          allowModelPick: false,
          autoStart: true,
          preferOverGsv: false,
          toneAuto: true,
          toneStrength: 1,
          toneParams: true,
          voices: demoGsvVoices,
          coverage: demoGsvVoices.map((voice) => ({
            voice: voice.key,
            refEmotions: voice.emotions,
            paramOnly: voice.emotions.length > 0 ? [] : ['开心', '生气', '难过', '吃惊', '恐惧', '中立'],
            tags: voice.emotions,
          })),
        });
      } else {
        setGsv(await api.gsvVoices());
      }
    } catch {
      setGsv(null);
    } finally {
      setGsvLoading(false);
    }
  };

  useEffect(() => {
    void loadGsv();
  }, [settings.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 手动拉起角色本音服务（冷启动 30–90 秒）。 */
  const startGsv = async () => {
    setGsvStarting(true);
    toast({ title: '正在启动角色本音服务', description: '首次加载模型约 30–90 秒，期间不要重复点击。', variant: 'info' });
    try {
      const result = await api.gsvStart();
      if (result.ok) {
        toast({ title: '服务已就绪', description: '现在可以试听或直接发语音了。', variant: 'success' });
      } else {
        toast({ title: '启动失败', description: result.reason || '请查看 gpt-sovits-api.log', variant: 'error' });
      }
      await loadGsv();
    } catch (error) {
      toast({
        title: '启动失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setGsvStarting(false);
    }
  };

  /** 试听：让后端用选中的音色念一句，浏览器直接播。 */
  const previewVoice = async () => {
    if (!draft) return;
    setPreviewing(true);
    try {
      const emotion = previewEmotion === 'auto' ? undefined : previewEmotion;
      const blob = await api.gsvPreview(draft.gsvVoice, undefined, { emotion });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
      toast({
        title: '正在试听',
        description: emotion
          ? `情绪：${emotion}。第一次选某个音色要加载权重；服务没启动时冷启动要 30–90 秒。`
          : '按当前心情自动挑语气。第一次选某个音色要加载权重；服务没启动时冷启动要 30–90 秒。',
        variant: 'success',
      });
    } catch (error) {
      toast({
        title: '试听失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setPreviewing(false);
    }
  };

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const errors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!draft) return result;
    if (draft.maxChars < 10 || draft.maxChars > 600) result.maxChars = '范围 10–600';
    if (draft.rvc.f0upKey < -24 || draft.rvc.f0upKey > 24) result.f0up = '范围 -24–24';
    if (draft.rvc.protect < 0 || draft.rvc.protect > 0.5) result.protect = '范围 0–0.5';
    if (draft.rvc.indexRate < 0 || draft.rvc.indexRate > 1) result.indexRate = '范围 0–1';
    if (draft.rvc.enhance < 0 || draft.rvc.enhance > 1) result.enhance = '范围 0–1';
    if (draft.toneStrength !== undefined && (draft.toneStrength < 0 || draft.toneStrength > 1.5)) {
      result.toneStrength = '范围 0–1.5';
    }
    if (draft.gsvSampleSteps !== undefined && (draft.gsvSampleSteps < 8 || draft.gsvSampleSteps > 64)) {
      result.gsvSampleSteps = '范围 8–64';
    }
    if (draft.gsvSeed !== undefined && draft.gsvSeed < -1) {
      result.gsvSeed = '最小 -1';
    }
    return result;
  }, [draft]);
  const invalid = Object.keys(errors).length > 0;

  const update = (patch: Partial<AudioConfig>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const updateRvc = (patch: Partial<AudioConfig['rvc']>) =>
    setDraft((current) =>
      current ? { ...current, rvc: { ...current.rvc, ...patch } } : current,
    );
  const updateSvc = (patch: Partial<AudioConfig['svc']>) =>
    setDraft((current) =>
      current ? { ...current, svc: { ...current.svc, ...patch } } : current,
    );

  const save = async () => {
    if (!draft || invalid) return;
    const next = await settings.save({ audio: draft });
    if (next) setBaseline(JSON.stringify(next.audio));
  };

  const runService = async (action: 'restart' | 'stop') => {
    if (settings.mode === 'demo') {
      toast({
        title: '演示模式不执行服务操作',
        description: '连接本地服务后会真实重启或停止 RVC 音色服务。',
        variant: 'info',
      });
      return;
    }
    setServicePending(action);
    try {
      if (action === 'restart') await api.rvcRestart();
      else await api.rvcStop();
      toast({
        title: action === 'restart' ? '已请求重启音色服务' : '已请求停止音色服务',
        description: action === 'restart' ? '首次加载模型约需 10–30 秒。' : '停止后语音将不再做音色转换。',
        variant: 'success',
      });
      window.setTimeout(() => void loadRvc(), 1000);
    } catch (error) {
      toast({
        title: '服务操作失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        variant: 'error',
      });
    } finally {
      setServicePending('');
    }
  };

  if (settings.phase === 'loading' || !draft) {
    return (
      <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="mt-2 h-4 w-96" />
        <Skeleton className="mt-6 h-[620px] rounded-xl" />
      </div>
    );
  }

  if (settings.phase === 'error') {
    return (
      <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader title="语音音色" />
        <div className="mt-6 rounded-xl border border-border bg-surface shadow-card">
          <EmptyState
            icon={AlertCircle}
            title="语音配置加载失败"
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

  const modelOptions = (rvc?.models?.map((item) => item.name) ?? ['hutao', 'nahida']).filter(Boolean);
  if (!modelOptions.includes(draft.rvc.model)) modelOptions.unshift(draft.rvc.model);
  const selectedGsv = gsv?.voices.find((voice) => voice.key === draft.gsvVoice) ?? null;
  const coverageOfSelected =
    gsv?.coverage?.find((item) => item.voice === draft.gsvVoice) ?? null;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
        <PageHeader
          title="语音音色"
          description="文字 → Qwen TTS →（可选）RVC 换成自定义音色 → QQ 语音。保存后下一次发语音生效。"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SaveStatus dirty={dirty} state={settings.saveState} />
              {isIntegratedConsole() ? (
                <Button variant="ghost" size="sm" onClick={openLegacyConsole}>
                  <ExternalLink />
                  旧版设置
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDraft(JSON.parse(baseline) as AudioConfig)}
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
                保存语音设置
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
            icon={Mic}
            title="语音合成"
            description="让机器人能发语音，也能听语音。"
          >
            <ToggleRow
              id="voice-enabled"
              title="启用语音"
              description="关闭后不会合成或发送语音消息。"
              checked={draft.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SelectField
                id="voice-model"
                label="语音合成模型"
                value={draft.model}
                onChange={(value) => update({ model: value })}
                options={Array.from(new Set([...ttsModels, draft.model])).map((value) => ({
                  value,
                  label: value,
                }))}
                disabled={!draft.enabled}
                description="plus / flash 为 qwen-audio-3.0 系列；cosyvoice-v3-flash 音色库更长。"
              />
              <TextField
                id="voice-name"
                label="音色（留空 = 模型默认）"
                value={draft.voice}
                onChange={(value) => update({ voice: value })}
                placeholder="longanlingxin / longanhuan_v3.6 / Cherry"
                disabled={!draft.enabled}
                mono
              />
              <TextField
                id="voice-instruction"
                label="默认语气 / 情绪指令"
                value={draft.instruction}
                onChange={(value) => update({ instruction: value })}
                placeholder="例如：语气自然，带一点傲娇俏皮"
                disabled={!draft.enabled}
                className="sm:col-span-2"
              />
              <NumberField
                id="voice-maxchars"
                label="单条语音最多合成字数"
                value={draft.maxChars}
                onChange={(value) => update({ maxChars: value })}
                min={10}
                max={600}
                unit="字"
                error={errors.maxChars}
                disabled={!draft.enabled}
                description="做过音色转换时耗时基本随字数增加。"
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={Users}
            title="角色本音"
            description="用本地微调的 GPT-SoVITS 模型说话，比通用 TTS 更像本人。这里选的就是实际发出去的音色。"
            actions={
              <Badge variant={gsv?.service?.ok ? 'success' : 'neutral'}>
                {gsvLoading ? '检查中' : gsv?.service?.ok ? '服务在线' : '服务离线'}
              </Badge>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                id="voice-gsv"
                label="用谁的声音"
                value={draft.gsvVoice}
                onChange={(value) => update({ gsvVoice: value })}
                options={(gsv?.voices ?? []).map((voice) => ({
                  value: voice.key,
                  label: `${voice.name}（${voice.version}）${voice.available ? '' : ' · 不可用'}`,
                }))}
                disabled={!draft.enabled}
                description="保存后下一句生效。第一次换成某个音色要加载权重，约 1–5 秒。"
              />
              <div className="flex items-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void previewVoice()}
                  disabled={previewing || !draft.enabled}
                >
                  {previewing ? <Loader2 className="animate-spin" /> : <Play />}
                  试听
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadGsv()}
                  disabled={gsvLoading}
                >
                  <RefreshCw />
                  刷新
                </Button>
              </div>
            </div>

            {selectedGsv ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                <Badge variant="neutral">采样 {selectedGsv.version === 'v4' ? '48kHz' : selectedGsv.version === 'RVC' ? 'RVC' : '32kHz'}</Badge>
                {selectedGsv.emotions.length > 0 ? (
                  <span>可切情绪：{selectedGsv.emotions.join(' / ')}</span>
                ) : (
                  <span>只有 1 条参考音频，情绪靠语气指令带</span>
                )}
                {selectedGsv.speed !== 1 ? <span>· 默认语速 {selectedGsv.speed}×</span> : null}
              </div>
            ) : null}

            {selectedGsv && !selectedGsv.available ? (
              <div className="mt-3 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12px] text-danger">
                这个音色缺文件：{selectedGsv.missing.join('、')}。选了也会静默降级成千问 TTS。
              </div>
            ) : null}

            {gsv?.preferOverGsv && draft.gsvVoice === 'hutao' ? (
              <div className="mt-3 rounded-lg border border-warning/20 bg-warning-soft px-3 py-2 text-[12px] text-warning">
                胡桃现在走「千问 TTS → RVC」快路径（audio.rvc.preferOverGsv = true），不走本音模型。
                想让胡桃也用本音（更像但更慢），把 RVC 区块里的这个开关关掉。
              </div>
            ) : null}

            {gsv && !gsv.service.ok ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted">
                <span>角色本音服务没在跑（127.0.0.1:9880）。它在后台时不会自己启动，语音会降级成千问 TTS —— 换了音色也听不出区别。</span>
                <Button variant="secondary" size="sm" onClick={() => void startGsv()} disabled={gsvStarting}>
                  {gsvStarting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {gsvStarting ? '启动中…' : '现在启动'}
                </Button>
              </div>
            ) : null}

            <div className="mt-4 space-y-1">
              <ToggleRow
                id="voice-gsv-autostart"
                title="服务没跑时自动启动"
                description="发语音前自动拉起推理服务。关掉后必须手动点「现在启动」，否则一律降级千问 TTS。"
                checked={draft.gsvAutoStart !== false}
                onCheckedChange={(checked) => update({ gsvAutoStart: checked })}
                disabled={!draft.enabled}
              />
              <ToggleRow
                id="voice-gsv-allow-pick"
                title="允许模型临时换音色"
                description="关闭时上面选的音色说了算；打开后模型可以按语境自己挑人（例如“模仿胡桃说话”），但音色容易乱跳。"
                checked={draft.gsvAllowModelPick}
                onCheckedChange={(checked) => update({ gsvAllowModelPick: checked })}
                disabled={!draft.enabled}
              />
            </div>
          </SectionCard>

          {/* ── 语气与情绪（voice-delivery.js）──────────────────────────────
              以前"发语音用什么语气"完全靠模型自己写一句 style，结果是同一个音色
              在开心/难过/生气时听起来一模一样。这一块把情绪做成一等公民：
              每个情绪对应一条参考音频 + 一组韵律参数，模型只需填 emotion。 */}
          <SectionCard
            icon={Wand2}
            title="语气与情绪"
            description="让同一个人在不同语境里换语气：开心时轻快、安慰人时放软、累了就慢下来。关掉后回到「模型自己写一句语气」的老样子。"
            actions={
              <Badge variant={draft.toneAuto !== false ? 'success' : 'neutral'}>
                {draft.toneAuto !== false ? '已启用' : '已关闭'}
              </Badge>
            }
          >
            <ToggleRow
              id="voice-tone-auto"
              title="按语境自动换语气"
              description="把此刻的心情翻译成参考音频 + 语速 + 韵律参数，提示词里会多一行【此刻的语气】。关掉后语音只有一个调。"
              checked={draft.toneAuto !== false}
              onCheckedChange={(checked) => update({ toneAuto: checked })}
              disabled={!draft.enabled}
            />
            <ToggleRow
              id="voice-tone-params"
              title="下发韵律参数（音色微调）"
              description="把 temperature / top_k / top_p / 句间停顿 / 重复惩罚一起发给本音服务。出爆音或咬字发飘时关掉这一项，就只剩语速调节。"
              checked={draft.toneParams !== false}
              onCheckedChange={(checked) => update({ toneParams: checked })}
              disabled={!draft.enabled || draft.toneAuto === false}
            />

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <NumberField
                id="voice-tone-strength"
                label="情绪强度"
                value={Number.isFinite(Number(draft.toneStrength)) ? Number(draft.toneStrength) : 1}
                onChange={(value) => update({ toneStrength: value })}
                min={0}
                max={1.5}
                step={0.1}
                unit="×"
                error={errors.toneStrength}
                description="0 = 完全按老样子，1 = 正常，1.5 = 演得夸张些。心情底色低时会自动收敛 20%。"
                disabled={!draft.enabled || draft.toneAuto === false}
              />
              <div className="space-y-1.5">
                <SelectField
                  id="voice-tone-preview-emotion"
                  label="试听用的情绪"
                  value={previewEmotion}
                  onChange={(value) => setPreviewEmotion(value)}
                  options={previewEmotionOptions}
                  description={
                    coverageOfSelected && coverageOfSelected.refEmotions.includes(previewEmotion)
                      ? '这个音色有对应的情绪参考音频，听感差别最明显。'
                      : '这个音色没有该情绪的参考音频，只靠韵律参数微调，差别较小。'
                  }
                  disabled={!draft.enabled || draft.toneAuto === false}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void previewVoice()}
                  disabled={previewing || !draft.enabled}
                >
                  {previewing ? <Loader2 className="animate-spin" /> : <Play />}
                  按这个情绪试听
                </Button>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted">
              <div className="font-medium text-text">这个音色能真的换几种语气</div>
              {selectedGsv ? (
                <div className="mt-1 space-y-1">
                  <div>
                    <span className="text-text">换参考音频（听感差别最明显）：</span>
                    {coverageOfSelected && coverageOfSelected.refEmotions.length > 0
                      ? coverageOfSelected.refEmotions.join(' / ')
                      : '没有 —— 这个音色只有 1 条参考音频，情绪只能靠韵律参数微调'}
                  </div>
                  <div>
                    <span className="text-text">只调参数：</span>
                    {coverageOfSelected ? coverageOfSelected.paramOnly.join(' / ') : '—'}
                  </div>
                  <div className="text-[11px]">
                    想让某个音色也支持情绪切换，得给它补对应的情绪参考音频（见 gpt-sovits-models/&lt;音色&gt;/…/emotions/）。
                  </div>
                </div>
              ) : (
                <div className="mt-1">选一个音色后显示。</div>
              )}
            </div>

            <div className="mt-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted">
              <div className="font-medium text-text">随语气自动调速</div>
              <div className="mt-1">
                <ToggleRow
                  id="voice-prosody-auto"
                  title="按标点和语气词微调语速"
                  description="连感叹/催促快一点，撒娇/犹豫/省略号慢一点，长句略快。零模型调用、零延迟。关掉后每个音色只有一个固定语速。"
                  checked={draft.prosodyAuto !== false}
                  onCheckedChange={(checked) => update({ prosodyAuto: checked })}
                  disabled={!draft.enabled}
                />
              </div>
            </div>

            {/* ── 合成参数（阶段 0）─────────────────────────────────────────
                这两个是 api_v2 早就支持、但客户端一直没发过的参数。默认值原样保留
                （32 步 / -1 随机），所以不碰它们就等于改造前的行为。 */}
            <div className="mt-3 rounded-lg border border-border bg-surface-muted px-3 py-2 text-[12px] text-muted">
              <div className="font-medium text-text">合成质量与速度</div>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <NumberField
                  id="voice-gsv-sample-steps"
                  label="合成步数"
                  value={
                    Number.isFinite(Number(draft.gsvSampleSteps)) ? Number(draft.gsvSampleSteps) : 32
                  }
                  onChange={(value) => update({ gsvSampleSteps: value })}
                  min={8}
                  max={64}
                  step={1}
                  error={errors.gsvSampleSteps}
                  description="32 = 默认。调低合成更快但音质下降，调高更慢更稳。只对 v4 音色（胡桃/纳西妲/芙宁娜/神里绫华）生效 —— 流萤和花火是 v2ProPlus，这个值对它们不起作用。"
                  disabled={!draft.enabled}
                />
                <NumberField
                  id="voice-gsv-seed"
                  label="随机种子"
                  value={Number.isFinite(Number(draft.gsvSeed)) ? Number(draft.gsvSeed) : -1}
                  onChange={(value) => update({ gsvSeed: value })}
                  min={-1}
                  step={1}
                  error={errors.gsvSeed}
                  description="-1 = 每次随机（默认）。填一个固定整数，同一句话每次念出来都一样，方便对比不同步数的音质，或复现「这句怎么念成这样」。"
                  disabled={!draft.enabled}
                />
              </div>
              <div className="mt-2 text-[11px]">
                改之前可以先量一下：
                <code className="ml-1 rounded bg-surface px-1 py-0.5">
                  node rvc/train/bench_gsv.mjs --voice=hutao --steps=16,24,32
                </code>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            icon={AudioLines}
            title="RVC 音色转换"
            description="把 TTS 声音换成自定义音色。换模型或设备需要重启服务。"
            actions={
              <Badge variant={draft.rvc.enabled ? 'success' : 'neutral'}>
                {draft.rvc.enabled ? '已启用' : '已关闭'}
              </Badge>
            }
          >
            <ToggleRow
              id="rvc-enabled"
              title="启用音色转换"
              checked={draft.rvc.enabled}
              onCheckedChange={(checked) => updateRvc({ enabled: checked })}
            />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <SelectField
                id="rvc-model"
                label="音色模型"
                value={draft.rvc.model}
                onChange={(value) => updateRvc({ model: value })}
                options={modelOptions.map((value) => ({ value, label: value }))}
                disabled={!draft.rvc.enabled}
                description="模型文件放在 rvc/models/ 下（.pth）。"
              />
              <SelectField
                id="rvc-device"
                label="运行设备"
                value={draft.rvc.device}
                onChange={(value) => updateRvc({ device: value })}
                options={[
                  { value: 'auto', label: '自动（有显卡用显卡）' },
                  { value: 'cuda:0', label: '显卡 cuda:0' },
                  { value: 'cpu:0', label: 'CPU' },
                ]}
                disabled={!draft.rvc.enabled}
              />
              <NumberField
                id="rvc-f0up"
                label="升降调（半音）"
                value={draft.rvc.f0upKey}
                onChange={(value) => updateRvc({ f0upKey: value })}
                min={-24}
                max={24}
                error={errors.f0up}
                disabled={!draft.rvc.enabled}
                description="偏低 +12，偏高 -12；0 = 不改。"
              />
              <SelectField
                id="rvc-method"
                label="音高提取方法"
                value={draft.rvc.method}
                onChange={(value) => updateRvc({ method: value })}
                options={methods}
                disabled={!draft.rvc.enabled}
              />
              <NumberField
                id="rvc-protect"
                label="清辅音 / 呼吸保留"
                value={draft.rvc.protect}
                onChange={(value) => updateRvc({ protect: value })}
                min={0}
                max={0.5}
                step={0.05}
                error={errors.protect}
                disabled={!draft.rvc.enabled}
              />
              <NumberField
                id="rvc-indexrate"
                label="索引率"
                value={draft.rvc.indexRate}
                onChange={(value) => updateRvc({ indexRate: value })}
                min={0}
                max={1}
                step={0.05}
                error={errors.indexRate}
                disabled={!draft.rvc.enabled}
              />
              <NumberField
                id="rvc-enhance"
                label="后处理强度"
                value={draft.rvc.enhance}
                onChange={(value) => updateRvc({ enhance: value })}
                min={0}
                max={1}
                step={0.1}
                error={errors.enhance}
                disabled={!draft.rvc.enabled}
              />
            </div>
            <div className="mt-4">
              <ToggleRow
                id="rvc-prefer-over-gsv"
                title="胡桃也走音色转换（不走本音模型）"
                description="打开后胡桃用「千问 TTS → RVC」，快很多但像不像差一档；关掉后胡桃用本音模型，更像但每句要等几秒。"
                checked={draft.rvc.preferOverGsv === true}
                onCheckedChange={(checked) => updateRvc({ preferOverGsv: checked })}
                disabled={!draft.rvc.enabled}
              />
            </div>
            <div className="mt-4">
              <ToggleRow
                id="rvc-fallback"
                title="转换失败时用原始 TTS 声音"
                description="关闭后转换失败将直接报错、不发声。"
                checked={draft.rvc.fallbackToRaw}
                onCheckedChange={(checked) => updateRvc({ fallbackToRaw: checked })}
                disabled={!draft.rvc.enabled}
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={Mic}
            title="唱歌转换"
            description="翻唱 / 语音片段唱时的 SVC 行为。"
          >
            <div className="space-y-3">
              <ToggleRow
                id="svc-enabled"
                title="启用歌声转换"
                description="发歌或发音频翻唱时，把人声换成胡桃音色。"
                checked={draft.svc.enabled}
                onCheckedChange={(checked) => updateSvc({ enabled: checked })}
              />
              <ToggleRow
                id="svc-mix"
                title="翻唱时保留原曲伴奏"
                description="关闭 = 清唱，只保留人声。"
                checked={draft.svc.mixInstrumental}
                onCheckedChange={(checked) => updateSvc({ mixInstrumental: checked })}
                disabled={!draft.svc.enabled}
              />
              <ToggleRow
                id="svc-singdry"
                title="「唱：歌词」默认干声"
                description="关闭 = 自动加伴奏。"
                checked={draft.svc.singDry}
                onCheckedChange={(checked) => updateSvc({ singDry: checked })}
                disabled={!draft.svc.enabled}
              />
              <ToggleRow
                id="svc-coverdry"
                title="按原曲翻唱默认干声"
                description="关闭 = 混音成品。"
                checked={draft.svc.coverDry}
                onCheckedChange={(checked) => updateSvc({ coverDry: checked })}
                disabled={!draft.svc.enabled}
              />
              <SelectField
                id="svc-separator"
                label="翻唱人声分离后端"
                value={draft.svc.separator || 'htdemucs'}
                onChange={(value) => updateSvc({ separator: value })}
                options={separatorModels}
                description="翻唱会先把人声从原曲里剥出来再换声。MDX 系不吃显存（走 CPU），在本机实测 60 秒素材约 47 秒，比 Demucs 还快一截；编曲密集的歌人声泄漏也更少。"
                disabled={!draft.svc.enabled}
              />
              <ToggleRow
                id="svc-improvise"
                title="没有原曲时允许现编一段调"
                description="不建议开启：现编的调容易跑调。"
                checked={draft.svc.allowImprovise}
                onCheckedChange={(checked) => updateSvc({ allowImprovise: checked })}
                disabled={!draft.svc.enabled}
              />
            </div>
          </SectionCard>

          <SectionCard
            icon={AudioLines}
            title="音色服务状态"
            description="RVC 服务运行状态、模型加载情况和操作。"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => void loadRvc()} disabled={rvcLoading}>
                  <RefreshCw className={rvcLoading ? 'animate-spin' : ''} />
                  刷新
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void runService('restart')}
                  disabled={Boolean(servicePending)}
                >
                  {servicePending === 'restart' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  保存并重启
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => void runService('stop')}
                  disabled={Boolean(servicePending)}
                >
                  {servicePending === 'stop' ? <Loader2 className="animate-spin" /> : <Square />}
                  停止服务
                </Button>
              </div>
            }
          >
            <div
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-[12px]',
                rvc?.running
                  ? 'border-success/20 bg-success-soft/60 text-success'
                  : 'border-border bg-surface-muted/40 text-muted',
              )}
            >
              <span
                className={cn(
                  'mt-1 h-1.5 w-1.5 rounded-full',
                  rvc?.running ? 'bg-success' : 'bg-muted',
                )}
              />
              <div>
                <p className="font-medium">{statusText(rvc)}</p>
                <p className="mt-0.5 text-[10.5px] opacity-80">
                  {rvc?.running
                    ? `已运行 ${rvc.health?.uptimeSec ?? 0}s · ${rvc.health?.lastError ? `上次错误：${rvc.health.lastError}` : '无错误'}`
                    : '服务未运行；语音会回退或失败。'}
                </p>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
