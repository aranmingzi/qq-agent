// 🔴 时区铁律（记忆系统 00 铁律 0.5 / 01 第六节）：
//   服务器系统时区是 UTC，但用户在**中国（UTC+8）** —— 所有面向用户的时间必须是北京时间。
//   TZ 必须在任何 new Date() 之前设置，且 ESM 的 import 会先于模块体执行，
//   所以这三行放在**所有 import 之上**。
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getConfig, updateConfig as updateConfigRaw, ROOT, DATA_DIR, resolvePersona, getConfigIntegrity } from './config.js';
import { setRuntimeSecrets, collectSecretsFromConfig, maskSecrets } from './egress.js';
import { personaAliases } from './personas.js';
import { customPersonaId, findCustomPersonaIndex, withStableIds } from './persona-store.js';
import { qwenAsrConfig, transcribeSpeech } from './qwen-audio.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, collectForwardMedia, forwardIdFromData } from './onebot.js';
import { qqFaceTable } from './qq-face.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { initSongJobs, listSongJobs, songJobStatus, cancelSongJob } from './song-jobs.js';
import { initPlayback } from './playback.js';
import { initPlaylistCommands, handlePlaylistCommand } from './playlist-commands.js';
import { ensureLibrary, buildLibrary, loadLibrary, getPlaylistMeta, searchTracks } from './playlist.js';
import { SessionRegistry } from './sessions.js';
import { setSideUsageRecorder } from './side-usage.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, estimateCost, chatCompletion } from './llm.js';
import { priceOf } from './prices.js';
import { listPosts as listQzonePosts, remainingQuota, ugcRightLabel, UGC_RIGHTS, findPost as findQzonePost, countPostsOn, normalizeUgcRight } from './qzone.js';
import { listEntries as listDiaryEntries, readPublicEntry, listDiaryChatKeys } from './diary.js';
import { wikiStatusLite } from './meme-wiki.js';
import { buildSnapshot, restoreSnapshot } from './identity.js';
import { sweepStaleTmp } from './tmp-janitor.js';
import { resetFactsCache } from './memory-facts.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeModelsFromProvider, reorderProviderModels, updateProviderMeta, deleteProvider } from './providers.js';
import { scanModelsVision, visionResults } from './vision-scan.js';
import { qwenVisionInfo, testQwenVision } from './qwen-vision.js';
import { deepseekVisionInfo, testDeepseekVision, visionRoute } from './vision-client.js';
import { qrInfo, readQrBuffer } from './napcat-qr.js';
import { NapCatWebui } from './napcat-webui.js';
import { QrRefreshGuard } from './qr-refresh-guard.js';
import { OneBotHealth } from './onebot-health.js';
import { isBanned, noteBan, banRemainingMs, clearBan } from './ban-state.js';
import { ScheduledTaskRunner } from './scheduled-tasks.js';
import { loadVoiceBytes } from './tools.js';
import { ensureRvcService, rvcStatus, stopRvcService, restartRvcService, listRvcModels } from './rvc-voice.js';
import { listGsvVoices, gsvHealth, gsvSpeak, ensureGsvService } from './gpt-sovits.js';
import { resolveTone, formatToneHint, describeTone, toneCoverage } from './voice-delivery.js';
import { stopNapcatProcesses, findQQExecutable, buildNapcatLaunchArgs } from './napcat-process.js';
import { ensureOnebotConfigs } from './napcat-onebot-config.js';
import { createEventBus, todayKey } from './util.js';
import { parsePokeEvent, pokeTextOf, shouldPokeBack, pokeStreak } from './gesture.js';
import { listPending, confirmMeme, rejectMeme } from './memes.js';
import { presetList, getPreset, presetPatch } from './brain-presets.js';
import { EventLog, formatSse, cursorFrom } from './event-log.js';
import { SendLedger } from './send-ledger.js';
import { auditRisk } from './risk-audit.js';
import { getExpressions } from './expression-learner.js';
import { getMentionWait } from './action-planner.js';
import { installNetProxy, netProxyStatus } from './net-proxy.js';

// 全局出站网络：连接超时 + 海外域名走代理。
// 两件事必须一起做，否则就是"配了 key 却连接超时"：
//   · 连接超时：undici 默认 10s，openrouter.ai 这类海外端点握手慢会直接
//     报 "Connect Timeout Error ... timeout: 10000ms"（不是请求超时，那是 llm.js 的 180s）。
//   · 代理分流：fetch 不读 HTTP_PROXY 环境变量（Node 24 才有 --use-env-proxy），
//     国内能直连、Google 系被阻断 —— 详见 src/net-proxy.js 顶部注释。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认行为，绝不崩主进程。
const NET_STATUS = await installNetProxy({ connectTimeoutMs: 30_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');
const CONSOLE_DIR = path.resolve(__dirname, '..', 'ui-console');
// 手机轻量版（零构建单文件 PWA，只做"看状态 + 调设置"）
const MOBILE_DIR = path.resolve(__dirname, '..', 'ui-mobile');

// ── 密钥脱敏 ────────────────────────────────────────────────────────────────
// 后端不再向浏览器回传明文密钥；只返回「是否已配置 + 掩码」。
// 旧版 UI 仍会把掩码写回保存，因此写入前统一剥离掩码值。
function maskSecretValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.includes('****') || text.includes('••')) return text;
  // 只用 ASCII 星号：掩码会出现在配置回显、日志、二维码说明里，
  // 非 ASCII 圆点一旦被按 ASCII 编码写出去就变成问号，
  // 前端再原样提交回来时就没有任何办法认出它是掩码了（会当成真密钥落盘）。
  if (text.length <= 8) return '********';
  return text.slice(0, 3) + '****' + text.slice(-4);
}

function isMaskedSecret(value) {
  const text = String(value ?? '');
  // 连续问号是掩码被 ASCII 编码毁掉后的残骸，同样不能当密钥用
  return text.includes('••') || text.includes('****') || /\?{4,}/.test(text);
}


export function publicConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const clone = structuredClone(cfg);
  if (clone.api?.apiKey) clone.api.apiKey = maskSecretValue(clone.api.apiKey);
  if (clone.vision?.qwen?.apiKey) {
    clone.vision.qwen.apiKey = maskSecretValue(clone.vision.qwen.apiKey);
  }
  if (Array.isArray(clone.providers)) {
    clone.providers = clone.providers.map((provider) => ({
      ...provider,
      apiKey: provider?.apiKey ? maskSecretValue(provider.apiKey) : '',
      hasKey: !!provider?.apiKey
    }));
  }
  if (clone.snowluma) {
    if (clone.snowluma.accessToken) {
      clone.snowluma.accessToken = maskSecretValue(clone.snowluma.accessToken);
    }
    if (clone.snowluma.httpAccessToken) {
      clone.snowluma.httpAccessToken = maskSecretValue(clone.snowluma.httpAccessToken);
    }
  }
  if (Array.isArray(clone.webSearch?.anysearchKeys)) {
    clone.webSearch.anysearchKeys = clone.webSearch.anysearchKeys.map((key) =>
      key ? maskSecretValue(key) : ''
    );
  }
  // 控制台访问令牌不下发给浏览器：手机端只靠 cookie 认证，拿到明文等于把门钥匙
  // 一起交出去（XSS 或截图泄露即失守）。前端也没有任何地方需要读它。
  if (clone.server?.token) {
    clone.server.token = maskSecretValue(clone.server.token);
    clone.server.hasToken = true;
  } else if (clone.server) {
    clone.server.hasToken = false;
  }
  return clone;
}

const SECRET_FIELD_NAMES = new Set(['apiKey', 'accessToken', 'httpAccessToken', 'token']);

// ── 手机轻量版的配置写权限白名单 ────────────────────────────────────────────
// 手机只用来"调设置"，不该拥有 PC 控制台的全量写权限。
// 这里**故意不包含**：server（令牌/监听地址）、allow/deny（白名单）、
// providers（含密钥目录）、customPersonas、personaBindings、masterQQ、snowluma。
// 想加一项先想清楚：手机丢了或令牌泄露，这项被改会有什么后果。
const MOBILE_CONFIG_GROUPS = {
  api: [
    'model', 'complexModel', 'provider', 'temperature', 'maxOutputTokens',
    'complexMaxOutputTokens', 'maxRounds', 'thinkingMode', 'vision', 'preset'
  ],
  persona: ['botName', 'selfNickname', 'participation', 'roleText', 'customRules'],
  audio: ['enabled', 'voice', 'instruction', 'autoAsr'],
  talk: ['enabled', 'windowMs'],
  gate: ['enabled', 'dryRun', 'probability'],
  proactive: ['enabled', 'probability'],
  sticker: ['enabled', 'maxPerRun'],
  mood: ['enabled'],
  diary: ['enabled'],
  // 空间发布：手机能开能关、能改可见范围，但不能改「发什么」（内容只来自本地日记）
  qzone: ['enabled', 'autoPublishDiary', 'ugcRight'],
  memoryFacts: ['enabled'],
  svc: ['singDry', 'coverDry', 'allowImprovise'],
  budget: ['dailyCostYuan']
};
const MOBILE_CONFIG_SCALARS = [
  'groupMentionProbability',
  'wakeDelayMs',
  'directWakeDelayMs',
  'allowAllWhenEmpty'
];

/** 从任意 patch 里只挑出手机端允许改的字段；顺带报告被丢弃的键。 */
function pickMobileConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const picked = {};
  const ignored = [];
  for (const key of Object.keys(source)) {
    if (MOBILE_CONFIG_SCALARS.includes(key)) {
      picked[key] = source[key];
      continue;
    }
    const allowedKeys = MOBILE_CONFIG_GROUPS[key];
    const node = source[key];
    if (!allowedKeys || !node || typeof node !== 'object' || Array.isArray(node)) {
      ignored.push(key);
      continue;
    }
    const subset = {};
    for (const [subKey, subValue] of Object.entries(node)) {
      if (allowedKeys.includes(subKey)) subset[subKey] = subValue;
      else ignored.push(`${key}.${subKey}`);
    }
    if (Object.keys(subset).length) picked[key] = subset;
  }
  // 手机端下拉框只能给字符串：往配置里写 "64" 会让控制台的数值比较全部错位
  if (picked.qzone && picked.qzone.ugcRight !== undefined) {
    picked.qzone.ugcRight = normalizeUgcRight(picked.qzone.ugcRight);
  }
  return { picked, ignored };
}


/** 写入前剥掉前端回传的掩码密钥，避免把「••••」保存成真实配置。 */
function stripMaskedSecrets(node) {
  if (Array.isArray(node)) {
    for (const item of node) stripMaskedSecrets(item);
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (SECRET_FIELD_NAMES.has(key) && isMaskedSecret(value)) {
      delete node[key];
      continue;
    }
    if (key === 'anysearchKeys' && Array.isArray(value)) {
      node[key] = value.filter((item) => !isMaskedSecret(item));
      continue;
    }
    stripMaskedSecrets(value);
  }
  return node;
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/** 只允许把已保存密钥用于「已保存的 Base URL」，避免把密钥发到任意地址。 */
function storedKeyForBaseUrl(baseUrl) {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return '';
  const cfg = getConfig();
  if (normalizeBaseUrl(cfg.api?.baseUrl) === target && cfg.api?.apiKey) {
    return String(cfg.api.apiKey);
  }
  const provider = (cfg.providers || []).find(
    (item) => normalizeBaseUrl(item.baseURL) === target && item.apiKey
  );
  return provider ? String(provider.apiKey) : '';
}

/** 请求里带明文就用明文；带掩码/空值则尝试用同 Base URL 的已保存密钥。 */
function resolveRequestKey(requestedKey, baseUrl) {
  const key = String(requestedKey ?? '').trim();
  if (key && !isMaskedSecret(key)) return key;
  return storedKeyForBaseUrl(baseUrl);
}

function savedKeyForTest(providerId, requestedModel) {
  const cfg = getConfig();
  const id = String(providerId || cfg.api?.provider || '');
  const provider = (cfg.providers || []).find((item) => item.id === id);
  if (provider?.apiKey) {
    return {
      baseUrl: provider.baseURL,
      apiKey: provider.apiKey,
      model: requestedModel || cfg.api?.model || provider.models?.[0] || '',
      providerId: provider.id
    };
  }
  if (cfg.api?.apiKey && normalizeBaseUrl(cfg.api.baseUrl) === normalizeBaseUrl(provider?.baseURL || cfg.api.baseUrl)) {
    return {
      baseUrl: cfg.api.baseUrl,
      apiKey: cfg.api.apiKey,
      model: requestedModel || cfg.api.model || '',
      providerId: cfg.api.provider || ''
    };
  }
  return null;
}


// ── 白名单判断 ─────────────────────────────────────────────────────────
// 判据已抽到 src/whitelist.js（唯一实现）：发送前的复核也要用它，
// 留在本文件里就等于只有入站能判、出站只能"相信入站时判断过"。
import { allowed as allowedIn, denyReason } from './whitelist.js';
import { recordSkip, recentSkips, skipStats, SKIP_STAGES } from './skip-log.js';
import { explainStats, summarizeStats, stageTable, describeStage } from './skip-labels.js';
import { attachVoiceGateway } from './voice-gateway.js';
import { createCallWatcher, scanCallWindows, decideAnswer, invokeAnswer } from './qq-call-answer.js';
import { listAudioDevices } from './audio-devices.js';
import { findVideoUrl, videoConfig, watchVideo, canAutoWatch, noteAutoWatch, isQuietHour } from './video-intel.js';

function allowed(kind, id, cfg) {
  return allowedIn(kind, id, cfg);
}

/**
 * 调用外部桌面应用的内部 API（带访问令牌）。
 *
 * ⚠️ 令牌从 600 的 config.json 读取，**只在本进程使用**，不下发给浏览器。
 * 用于面板的「账号总览 / 一键切号」—— 复用桌面侧已实现且已做安全校验的能力
 * （桌面侧已限制 URL 白名单 + 改配置前自动备份），避免两处重复实现。
 */
async function deskApi(pathname, method = 'GET', body) {
  const cfgPath = '/path/to/desktop-app/data/config.json';
  let token = '';
  try {
    token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).authToken || '';
  } catch (error) {
    throw new Error('读不到桌面令牌（' + cfgPath + '）');
  }
  if (!token) throw new Error('桌面令牌为空');
  const res = await fetch('http://127.0.0.1:8090' + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desk-Token': token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json().catch(() => ({}));
  return data?.data !== undefined ? data.data : data;
}

export function createApp({ log = console.log, restartHook = null } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();
  // SSE 事件日志：带 seq，断线重连按 after 补发（2026-10-22 生态调研 P0-2）
  const eventLog = new EventLog({ capacity: 500 });
  // 发送台账：结果不确定的消息落账，避免重复投递（P0-1）
  const sendLedger = new SendLedger();
  // 登录失败计数：ip -> { count, until }，只用于挡住暴力猜令牌
  const loginFails = new Map();
  // 本进程启动时刻：面板点"重启"后靠它判断新进程是否已经起来（毫秒时间戳，不会重复）
  const startedAt = Date.now();
  let onRestart = typeof restartHook === 'function' ? restartHook : null;
  let restarting = false;
  let tmpSwept = { removed: 0, freed: 0, failed: 0 };

  // ── 出口凭据闸门（egress.js）──────────────────────────────────────────
  // 把"本次生效的密钥值"装进运行时阻断集。必须在任何发送之前 ——
  // 装在组件构造之后等于首批消息裸奔（那时候 NapCat 可能已经连上、群里已经在聊）。
  // 只在值匹配这一层需要"知道具体值"，形态匹配不需要。
  const sealSecrets = () => {
    try {
      return setRuntimeSecrets(collectSecretsFromConfig(getConfig()));
    } catch (error) {
      console.warn('[egress] 装入运行时密钥失败（出口闸门只剩形态匹配）：', error?.message ?? error);
      return 0;
    }
  };
  sealSecrets();

  // 配置写回后必须重装：否则"刚在面板换的 Key"不在阻断集里，
  // 模型复述它的时候闸门认不出来（这类漏拦只会在最不该发生的时候发生）。
  const updateConfig = (patch) => {
    const next = updateConfigRaw(patch);
    sealSecrets();
    return next;
  };

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    return fs.existsSync(bundled) ? bundled : '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 机器人小号的 QQ 号：配置了就在启动 NapCat 时用 -q 快速登录（免扫码）。 */
  function snowlumaAccountQQ() {
    return String(getConfig().snowluma?.accountQQ || '').trim();
  }

  function snowlumaHttpPort() {
    try {
      const u = new URL(String(getConfig().snowluma?.httpUrl || 'http://127.0.0.1:3000'));
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3000;
  }

  /**
   * 补/修 NapCat 的 OneBot 端口配置。
   * 治的是"NapCat 找不到 onebot11_<号>.json 时自己生成一份没有端口的配置 →
   * 换了号登录就永远离线、且没有任何报错"这个坑（详见 src/napcat-onebot-config.js）。
   */
  function repairOnebotConfigs(where = '') {
    try {
      const dir = snowlumaDir();
      if (!dir) return;
      const r = ensureOnebotConfigs(dir, {
        httpPort: snowlumaHttpPort(),
        wsPort: snowlumaWsPort(),
        token: String(getConfig().snowluma?.accessToken || ''),
        log: (line) => pushSnowlumaLog(line, 'stdout')
      });
      if (!r.ok) {
        pushSnowlumaLog('[OneBot 配置] ' + r.error + (where ? '（' + where + '）' : ''), 'stderr');
        return;
      }
      const changed = r.changes.filter((c) => c.action !== 'ok');
      if (changed.length) {
        emit('log', { text: '[OneBot 配置] ' + (where || '检查') + '：' + changed.map((c) => c.file + ' ' + c.action).join('，') });
      }
    } catch (e) {
      pushSnowlumaLog('[OneBot 配置] 补配置失败：' + (e && e.message ? e.message : e), 'stderr');
    }
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    // NapCat 文件日志量比较大（fileLogLevel=debug 时尤其），缓冲放宽到 2000 行，
    // 否则有用的启动/登录信息几秒就被冲掉了。
    if (snowlumaLogs.length > 2000) snowlumaLogs.splice(0, snowlumaLogs.length - 2000);
    try { log(`[snowluma] ${line.text}`); } catch { /* ignore */ }
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  // ── NapCat 文件日志跟随 ────────────────────────────────────────────────
  // NapCat 实际跑在 QQ.exe 进程里，它的 stdout 未必会继承到我们这里；
  // 但它自带 winston 文件日志（config/napcat.json 的 fileLog 开关），
  // 落在 snowluma/logs/<时间戳>.log。这里 tail 最新那个文件、把新增内容
  // 实时灌进「运行日志」面板 —— 这样既不用弹终端窗口，也不会丢日志。
  const snowlumaTail = { timer: null, dir: '', file: '', offset: 0 };

  function latestNapcatLogFile(dir) {
    try {
      const logsDir = path.join(dir, 'logs');
      if (!fs.existsSync(logsDir)) return '';
      let best = '';
      let bestMtime = 0;
      for (const name of fs.readdirSync(logsDir)) {
        if (!/\.log$/i.test(name)) continue;
        const full = path.join(logsDir, name);
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = full; }
      }
      return best;
    } catch {
      return '';
    }
  }

  function pumpNapcatLogFile() {
    const dir = snowlumaTail.dir;
    if (!dir) return;
    const file = latestNapcatLogFile(dir);
    if (!file) return;
    if (file !== snowlumaTail.file) {
      // NapCat 每次启动都会新建一个 <时间戳>.log，换文件就从头跟
      snowlumaTail.file = file;
      snowlumaTail.offset = 0;
      pushSnowlumaLog(`开始跟随 NapCat 日志：${path.basename(file)}`, 'stdout');
    }
    try {
      const size = fs.statSync(file).size;
      if (size < snowlumaTail.offset) snowlumaTail.offset = 0; // 文件被截断/重建
      if (size <= snowlumaTail.offset) return;
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(size - snowlumaTail.offset, 256 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, snowlumaTail.offset);
        snowlumaTail.offset += len;
        for (const line of buf.toString('utf8').split(/\r?\n/)) {
          // 去掉 winston colorize 留下的 ANSI 转义，面板里不解析颜色
          if (line.trim()) pushSnowlumaLog(line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''), 'stdout');
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* 文件还没生成 / 被独占：下一轮再试 */
    }
  }

  function startSnowlumaLogTail(dir) {
    const target = dir || snowlumaDir();
    if (!target) return;
    // 目录变了（设置里改了 SnowLuma 目录）就重置跟随位置
    if (target !== snowlumaTail.dir) {
      snowlumaTail.file = '';
      snowlumaTail.offset = 0;
    }
    snowlumaTail.dir = target;
    if (snowlumaTail.timer) return;
    // 先跑一次，把已经落盘的内容立刻显示出来
    pumpNapcatLogFile();
    snowlumaTail.timer = setInterval(pumpNapcatLogFile, 1000);
    snowlumaTail.timer.unref?.();
  }

  function stopSnowlumaLogTail() {
    if (snowlumaTail.timer) {
      clearInterval(snowlumaTail.timer);
      snowlumaTail.timer = null;
    }
    snowlumaTail.file = '';
    snowlumaTail.offset = 0;
  }

  /** 打开 NapCat 自带的文件日志（fileLog=true）。日志落盘后我们才能 tail 到面板。 */
  function enableNapcatFileLog(dir) {
    try {
      const file = path.join(dir, 'config', 'napcat.json');
      if (!fs.existsSync(file)) return false;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.fileLog === true) return true;
      raw.fileLog = true;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
      pushSnowlumaLog('已开启 NapCat 文件日志（config/napcat.json → fileLog=true），面板直接跟随日志内容', 'stdout');
      return true;
    } catch (error) {
      pushSnowlumaLog(`开启 NapCat 文件日志失败：${error?.message ?? error}`, 'stderr');
      return false;
    }
  }

  /** 快速关闭 SnowLuma/NapCat。既支持内置子进程，也支持手工启动并注入 QQ 的进程树。 */
  function stopSnowluma() {
    if (snowlumaStopping) return { stopped: false, ids: [], killed: [], errors: ['关闭请求正在执行'] };
    snowlumaStopping = true;
    try {
      const result = stopNapcatProcesses({
        dir: snowlumaDir(),
        embeddedPid: snowlumaProc?.pid ?? null
      });
      snowlumaProc = null;
      // 判据要留痕：以前只回 PID，看不出"为什么没找到 / 杀的是不是机器人那个 QQ"。
      // 现在把"按哪些端口找的、命中了谁"一起写进日志，关不掉时能立刻自证。
      const portsText = (result.ports || []).join('/') || '(无)';
      const hitText = (result.matched || [])
        .map((m) => `${m.name}(${m.pid}) 占 ${m.port}`)
        .join('，') || '无';
      pushSnowlumaLog(`[关闭] 按端口 ${portsText} 查找；命中：${hitText}`, result.matched?.length ? 'stdout' : 'stderr');
      if (result.stopped) {
        pushSnowlumaLog(`已关闭 SnowLuma/NapCat 进程树：${result.killed.join(', ')}`, 'stdout');
      } else if (result.errors.length) {
        pushSnowlumaLog(`关闭 SnowLuma 失败：${result.errors.join('；')}`, 'stderr');
      } else if (!result.ids.length) {
        pushSnowlumaLog(`没有找到正在运行的 SnowLuma/NapCat 进程（已按端口 ${portsText} 找过）。`, 'stderr');
      }
      return result;
    } finally {
      snowlumaStopping = false;
    }
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe；NapCat 版本则直接隐藏启动，不弹终端。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    repairOnebotConfigs('启动 QQ 前');   // 先保证端口配置在，协议端登录时才会开 3000/3001
    // 日志落盘 + 跟随：这样 NapCat 的输出进面板「运行日志」，不需要给它一个终端窗口。
    enableNapcatFileLog(dir);
    startSnowlumaLogTail(dir);
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    // 单实例保证：先把可能残留的旧 NapCat/QQ 清掉。
    // 否则旧实例占着 3000（HTTP），新实例登录后 3001 起得来、3000 起不来 → 只能收消息、发不出、显示未登录。
    try {
      const stale = await stopNapcatProcesses({ dir });
      if (stale.stopped) {
        pushSnowlumaLog(`已清理残留的 NapCat/QQ 进程（PID ${stale.killed.join(', ')}），避免 3000 端口冲突`, 'stdout');
      }
    } catch (e) {
      pushSnowlumaLog(`清理残留进程失败（忽略，继续启动）：${e && e.message ? e.message : e}`, 'stderr');
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // NapCat 独立版：直接启动引导器并注入 Hook，完全绕过 launcher*.bat / cmd.exe。
    const launcherExe = path.join(dir, 'NapCatWinBootMain.exe');
    const hookDll = path.join(dir, 'NapCatWinBootHook.dll');
    const patchPackage = path.join(dir, 'qqnt.json');
    const mainMjs = path.join(dir, 'napcat.mjs');
    const loadFile = path.join(dir, 'loadNapCat.js');
    const required = [launcherExe, hookDll, patchPackage, mainMjs];
    const missing = required.filter((file) => !fs.existsSync(file));
    if (missing.length) {
      return { ok: false, error: `SnowLuma/NapCat 文件不完整，缺少：${missing.join('、')}` };
    }
    const qqExe = findQQExecutable();
    if (!qqExe) return { ok: false, error: '找不到 QQ.exe，请确认 QQNT 已安装且安装信息可读取' };

    fs.writeFileSync(
      loadFile,
      `(async () => { await import(${JSON.stringify(pathToFileURL(mainMjs).href)}); })()\n`,
      'utf8'
    );
    const env = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: patchPackage,
      NAPCAT_LOAD_PATH: loadFile,
      NAPCAT_INJECT_PATH: hookDll,
      NAPCAT_LAUNCHER_PATH: launcherExe,
      NAPCAT_MAIN_PATH: mainMjs.replace(/\\/g, '/')
    };
    // ⚠️ 不要加 detached: true。
    //    NapCatWinBootMain.exe 是 CONSOLE 子系统程序，detached 会让 Windows 给它
    //    新建一个控制台窗口（就是那个弹出来的终端），而且实测 detached 下
    //    stdio 管道根本收不到任何输出（进程 code=0 但 stdout 为空）。
    //    这里用 windowsHide（CREATE_NO_WINDOW）+ 非 detached：既不弹窗口，
    //    stdout/stderr 也照样能进「运行日志」。
    const launchArgs = buildNapcatLaunchArgs({ qqExe, hookDll, accountQQ: snowlumaAccountQQ() });
    if (launchArgs.includes('-q')) {
      pushSnowlumaLog(`使用快速登录（QQ ${snowlumaAccountQQ()}），免扫码`, 'stdout');
    }
    const child = spawn(launcherExe, launchArgs, {
      cwd: dir,
      env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    snowlumaProc = child;
    child.stdout.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) pushSnowlumaLog(line, 'stdout');
      }
    });
    child.stderr.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) pushSnowlumaLog(line, 'stderr');
      }
    });
    child.on('exit', (code, signal) => {
      snowlumaProc = null;
      pushSnowlumaLog(`NapCat 引导进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
    });
    child.on('error', (error) => {
      snowlumaProc = null;
      pushSnowlumaLog(`NapCat 启动失败：${error?.message ?? error}`, 'stderr');
    });
    child.unref();
    pushSnowlumaLog(`SnowLuma/NapCat 已在后台无窗口启动（引导进程 pid=${child.pid}），日志见下方运行日志`, 'stdout');
    startSnowlumaLogTail(dir);
    emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
    return { ok: true, launched: true, embedded: false, pid: child.pid };
  }

  /**
   * 事件负载脱敏：**日志也算出口**。
   *
   * 为什么在 emit 这一层做（而不是让每个调用方记得脱敏）：
   *   我们有 40+ 处 `emit('log', {text})`，其中不少会把模型原文、接口报错、
   *   配置片段直接拼进去。逐个改必然漏，而漏掉的那一处就是"Key 出现在面板日志里"。
   *   收口在这里，新加的日志自动被覆盖 —— 与记忆闸门装在唯一写入口是同一个道理。
   */
  function scrubPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    let out = payload;
    for (const key of ['text', 'message', 'error', 'line', 'summary', 'detail', 'wording']) {
      const v = payload[key];
      if (typeof v !== 'string' || !v) continue;
      const masked = maskSecrets(v);
      if (masked === v) continue;
      if (out === payload) out = { ...payload };
      out[key] = masked;
    }
    return out;
  }

  const emit = (type, payload) => {
    const safe = scrubPayload(payload);
    bus.emit(type, safe);
    const line = `event: ${type}\ndata: ${JSON.stringify(safe ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 2000);
  store.setArchiveEnabled(cfg.store?.archiveHistory !== false);
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 300);
  // 旁路模型调用（唤醒预判/日记/事实提取/记忆整理/必回重试）的 usage 从此入总账
  setSideUsageRecorder((purpose, usage, opts) => sessions.recordSideUsage(purpose, usage, opts));
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  // 重连预算耗尽：不是"再等等就好"，而是需要人看一眼（SSE 会推红）
  onebot.onExhausted = (v) => {
    log(`⚠ 协议端反复连不上，已停止自动重连：${v.reason}`);
    emit('onebot-exhausted', { ...v, at: Date.now() });
  };
  const stickers = new StickerManager(onebot);
  // 今日发送计数（风控自检用；进程内即可，重启归零不算错）
  const sendStats = { day: todayKey(), count: 0 };
  // 出站许可复核的**延迟引用**：sender 要先于 orchestrator 构造（点歌/播放都要用它），
  // 而复核需要 orchestrator 的暂停/预算状态。用一个盒子递过去，两边都不必互相 import。
  const sendGateRef = { fn: null };
  const sender = new SendQueue({
    onebot, store, ledger: sendLedger,
    beforeSend: ({ chatKey }) => sendGateRef.fn?.({ chatKey }),
    onSent: ({ chatKey, text }) => {
      if (todayKey() !== sendStats.day) { sendStats.day = todayKey(); sendStats.count = 0; }
      sendStats.count += 1;
      log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`);
    }
  });
  // 点歌队列：GPU 并发固定 1（Demucs / RVC / DiffSinger 在 4GB 显存上不能并存），
  // 入队即回执、完成主动推送。见 docs/ARCH-升级方案-2026-10-19.md §3。
  initSongJobs({ sender, log, emit });
  // 点歌台：B站缓存 → 歌单 → 群里点播原曲（与上面的「唱歌」是两条独立链路）
  initPlayback({ log });
  initPlaylistCommands({ sender, log });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });
  // 接线只有这一处：sender 每次发送前重判白名单/暂停/预算的**现值**
  sendGateRef.fn = ({ chatKey }) => orchestrator.gateBeforeSend(chatKey);

  // 通用定时任务（主人在 QQ 里下的提醒/定时指令）
  // ── NapCat WebUI 客户端（账密登录 / 人机验证代理）──
  const napcatWebui = new NapCatWebui({ log });



  // ── QQ 账号健康探针 ──
  // 只用 WS 连接状态判断健康是不够的：NapCat 的 WS 在**账号离线**时依然在监听，
  // 会导致控制台误报"已连接"（2026-09-14 事故：掉线 5 小时无人发现）。
  // 这里周期性调 get_status 拿真实的 online 标志，掉线时推 SSE 事件 + 打印告警。
  const onebotHealth = new OneBotHealth({ onebot, log });
  onebotHealth.on('offline', (st) => {
    log('[health] ⚠ QQ 账号离线，机器人将无法收发消息。请检查 NapCat 登录状态。');
    emit('onebot-health', { online: false, since: st.offlineSince, error: st.lastError });
  });
  onebotHealth.on('recovered', () => {
    log('[health] ✔ QQ 账号已恢复在线。');
    emit('onebot-health', { online: true, at: Date.now() });
  });

  // ── 登录二维码刷新守护 ──
  // NapCat 的自动刷新循环会卡死（2026-09-16 事故），进程却还活着，
  // 外部健康检查查不出来。这里靠"二维码文件是否还在更新"来发现并踢活。
  const qrGuard = new QrRefreshGuard({
    napcatWebui,
    // ⚠️ 必须用「账号是否在线」，**不能**用 onebot.connected（WS 是否连着）！
    //    NapCat 的 WS 在账号离线时依然在监听 → connected 恒为 true → 守护误以为
    //    "已登录"，直接跳过检查，于是二维码再旧也不会被踢活（2026-09-17 事故）。
    //    这是同一个坑第三次出现（前两次：控制台显示、二维码面板），务必保持警惕。
    isLoggedIn: () => onebotHealth.snapshot().online === true,
    dir: () => snowlumaDir(),
    log
  });

  const scheduledRunner = new ScheduledTaskRunner({ orchestrator, log });

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 登录后会在 snowluma/config/onebot_<uin>.json 里写入随机 accessToken。
  // 脱敏发布/全新副本中 qq-agent 的 token 为空，若不自动同步会一直 401。这里在
  // OneBot 未连接时读取 SnowLuma 配置，把 HTTP/WS 令牌补进我们的配置。
  let lastSyncTokenSig = '';
  function syncSnowlumaTokens() {
    try {
      const dir = snowlumaDir();
      if (!dir) return false;
      const cfgDir = path.join(dir, 'config');
      const files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      if (!files.length) return false;
      const data = JSON.parse(fs.readFileSync(path.join(cfgDir, files[0]), 'utf8'));
      const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
      const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
      const wsToken = String(ws?.accessToken ?? '');
      const httpToken = String(http?.accessToken ?? '');
      const sig = `${wsToken}|${httpToken}`;
      if (!sig || sig === lastSyncTokenSig) return false;
      const cur = getConfig();
      if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== httpToken) {
        updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken } });
        log('[onebot] 已从 SnowLuma 配置同步 OneBot 访问令牌');
      }
      lastSyncTokenSig = sig;
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时自动同步一次令牌并重连
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    if (syncSnowlumaTokens()) {
      const cur = getConfig();
      onebot.wsUrl = String(cur.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(cur.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(cur.snowluma?.accessToken || '');
      onebot.httpToken = String(cur.snowluma?.httpAccessToken || cur.snowluma?.accessToken || '');
      onebot.reconnect();
    }
  }
  onebot.onStatus((status) => {
    if (!status.connected && String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  const pokeSeen = new Map();  // 入站拍一拍去重：dedupeKey -> 收到时间（30 秒窗口）
  // 回拍账本：chatKey -> { at, targetId }。只管「别人拍我 → 我拍回去」的去重，
  // 不落盘 —— 进程重启最多多回一次，不值得为它写盘（真正的分寸判据仍在 gesture.js）。
  const pokeBackSeen = new Map();
  // 连戳账本：`会话|谁` -> { count, at }。只在内存（重启清零可以接受：
  // 重启后再被戳两下就重新数，最坏是少毛一次，不会多毛）。
  const pokeStreakSeen = new Map();
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  // 引用原文的解析结果按 message_id 缓存：一条被引用的消息会被解析多次
  // （segmentsToText 渲染一遍、寻址再读一遍），每次都调 get_msg 是白跑一趟。
  const replyCache = new Map();
  async function resolveReply(messageId) {
    const key = String(messageId ?? '');
    if (replyCache.has(key)) return replyCache.get(key);
    let out = null;
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      const senderId = String(msg?.sender?.user_id ?? msg?.user_id ?? '');
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      out = { sender: String(senderName), senderId, text: String(text).slice(0, 120) };
    } catch {
      out = null;
    }
    replyCache.set(key, out);
    if (replyCache.size > 400) replyCache.clear(); // 简单防膨胀
    return out;
  }

  /**
   * 定向消息里的语音自动转成文字（私聊 / @我 / 叫名字）——"该它听的必须听到"，
   * 不依赖模型自己想起来调 voice_to_text；其他语音仍由模型按需调用（省成本）。
   * 任何失败都只记日志、原样返回，绝不影响消息入库。
   */
  async function autoTranscribeIncoming(kind, id, text, media) {
    try {
      const cfgNow = getConfig();
      const mode = String(cfgNow.audio?.autoAsr || 'direct');
      if (cfgNow.audio?.enabled === false || mode === 'off') return text;
      const recs = (media || []).filter((m) => m && m.kind === 'record');
      if (!recs.length) return text;
      const chatKey = kind + ':' + id;
      if (mode !== 'all') {
        const persona = resolvePersona(chatKey).persona;
        const aliases = personaAliases(persona, [onebot.selfNickname]);
        const directed = kind === 'private'
          || String(text).includes('@我')
          || aliases.some((a) => String(text).includes(a));
        if (!directed) return text;
      }
      const asr = qwenAsrConfig();
      if (!asr.enabled || !asr.apiKey) return text;
      const max = Math.max(1, Math.min(3, Number(cfgNow.audio?.autoAsrMaxPerMessage) || 1));
      const said = [];
      for (const rec of recs.slice(0, max)) {
        const audio = await loadVoiceBytes({ onebot, chatKey }, rec);
        const one = await Promise.race([
          transcribeSpeech({ buffer: audio.buffer, format: audio.format }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('自动转写超时')), 15000))
        ]);
        if (one) said.push(String(one).trim());
      }
      if (!said.length) return text;
      const cleaned = String(text).replace(/\[语音\]/g, '').trim();
      const merged = (cleaned ? cleaned + ' ' : '') + '[语音内容：' + said.join(' / ') + ']';
      log('[voice] 自动转写：' + merged.slice(0, 60));
      return merged;
    } catch (e) {
      log('[voice] 自动转写失败（不影响入库）:', e?.message || e);
      return text;
    }
  }

  /**
   * 把合并转发里的图片/视频/语音补进 media 列表（去重）。
   * 转发段有两种形态：① 内容直接内联在 data.content（新版本 NapCat 常见）；
   * ② 只给转发 id，要调 get_forward_msg 拉。两种都要兜住。
   */
  async function collectForwardMediaInto(segments, media) {
    if (!Array.isArray(segments) || !Array.isArray(media)) return;
    for (const seg of segments) {
      if (seg?.type !== 'forward') continue;
      const d = seg.data ?? {};
      let payload = d.content ?? null;
      if (!payload) {
        const fid = forwardIdFromData(d);
        if (!fid) continue;
        try {
          payload = await onebot.getForwardMsg(fid);
        } catch (e) {
          log('[forward] 拉取转发内容失败（图片可能取不到）:', e?.message ?? e);
          continue;
        }
      }
      const found = collectForwardMedia(payload, { max: 6 });
      for (const m of found) {
        const dup = media.some((x) => x.kind === m.kind
          && ((x.url && x.url === m.url) || (x.file && x.file === m.file) || (x.fileId && x.fileId === m.fileId)));
        if (!dup) media.push(m);
      }
      if (found.length) log(`[forward] 转发里取出 ${found.length} 个媒体（${found.map((m) => m.kind).join(',')}）`);
    }
  }

  /**
   * 群友发的视频链接 → 自己先看一遍，把总结发回去。
   *
   * 为什么不交给模型：模型手里只有一个 URL，它唯一的诚实回答是"我看不了视频"。
   * 「去抓标题/简介/章节/字幕/弹幕/评论」是代码的活，抓完再让模型归纳（video-intel.js）。
   *
   * 分寸（照 gesture 那套来）：深夜不自动开口、同一会话有冷却、同一链接 30 分钟内不重复。
   * 失败一律**静默**（只进日志）：解析不出来还回一句"我看不了"，比沉默更吵。
   *
   * @returns {Promise<false|true|'only-link'>}
   *   false=没管；true=发过总结（消息里还有别的话，留给模型接）；
   *   'only-link'=整条就一个链接，总结发完这条就算处理完了（不再叫模型回一句）。
   */
  async function autoWatchVideo(chatKey, text, messageId) {
    const cfg = videoConfig();
    if (!cfg.enabled || !cfg.autoReply) return false;
    if (isQuietHour(cfg)) return false;
    const hit = findVideoUrl(text);
    if (!hit) return false;
    // 想让人唱歌/点歌的链接不自动总结 —— 那是点歌台和 sing_lyrics 的活，
    // 这时候插一句"这个视频讲了什么"会把对方的话头带跑。
    if (/翻唱|唱一(首|个|下|段)|用你的声音|点歌|歌单/.test(String(text || ''))) return false;
    const verdict = canAutoWatch(chatKey, hit.url, cfg);
    if (!verdict.ok) {
      if (verdict.reason) log(`[视频] 跳过：${verdict.reason}`);
      return false;
    }
    noteAutoWatch(chatKey, hit.url);   // 先记账再抓：同一条消息被重推时不会抓两遍
    let res = null;
    try {
      res = await watchVideo(hit.url, {
        log,
        personaName: String(getConfig().persona?.botName || '').trim(),
        timeoutMs: cfg.timeoutMs
      });
    } catch (e) {
      log(`[视频] 没看懂：${e?.message ?? e}`);
      return false;
    }
    if (!res?.ok || !res?.text) {
      log(`[视频] 没看懂：${res?.error || '没拿到内容'}`);
      return false;
    }
    try {
      await sender.sendTextBatch(chatKey, [res.text], { replyToMessageId: messageId ?? null });
    } catch (e) {
      log(`[视频] 总结没发出去：${e?.message ?? e}`);
      return false;
    }
    // 这条消息除链接外还有没有别的话：没有的话已经答过了，再叫模型回一句就是重复。
    // （"看下这个" "讲啥的" 这种也算没别的话 —— 意图就是让你看视频。）
    const rest = String(text || '')
      .split(hit.raw).join(' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[\s，。、；;：:！!？?~～"'（）()【】\[\]]/g, '')
      .replace(/看(看|一下|下|这个|视频)?|讲(啥|什么|了啥)|说(说|啥|什么)|总结|大概|这个视频|视频|链接|有人(发|看过)?|谁/g, '');
    if (rest.length <= 4) {
      try { store.markRead(chatKey, messageId); } catch { /* 标记失败最多是模型再回一句 */ }
      try {
        recordSkip({
          stage: SKIP_STAGES.DIRECTIVE,
          chatKey,
          reason: '视频链接由代码看过后直接总结，未进模型',
          detail: { text: String(text || '').slice(0, 60) }
        });
      } catch { /* 记账失败不影响总结已发出去 */ }
      return 'only-link';
    }
    return true;
  }

  // 白名单外会话的留痕节流（chatKey -> 上次记账时间）。
  //
  // 为什么要有：白名单外以前是**纯静默 return**，既不记录也不留痕。实测后果是
  // 「我把群加了白名单，她还是不说话」和「机器人挂了」在控制台上长得一模一样 ——
  // 用户只能靠猜。2026-10-25 就发生过一次：白名单只剩两个群，其余 13 个群
  // 全部无声丢弃，群友在群里喊「鱼死机了」，而面板上一条记录都没有。
  //
  // 只留痕、不跑模型：白名单是硬边界，不能因为"记一笔"就把 17K 提示词烧出去。
  // 必须节流：活跃群里每条消息写一行会把 240 行的环形缓冲冲干净。
  const allowMissLogged = new Map();
  const ALLOW_MISS_GAP_MS = 10 * 60 * 1000;

  function noteAllowMiss(kind, id, chatKey) {
    const now = Date.now();
    if (now - (allowMissLogged.get(chatKey) || 0) < ALLOW_MISS_GAP_MS) return;
    allowMissLogged.set(chatKey, now);
    try {
      recordSkip({
        stage: SKIP_STAGES.GATE,
        chatKey,
        reason: kind === 'group'
          ? '这个群不在白名单里，消息被直接丢弃（要让她说话，在「聊天白名单」里勾上这个群）'
          : '这个人不在私聊白名单里，消息被直接丢弃（要让她回话，在「聊天白名单」里勾上这个人）',
        detail: { allowMiss: true }
      });
    } catch { /* 记账失败不能反过来影响入站 */ }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) {
      // 白名单外：仍然**不记录内容、不跑模型**，只留一条「被白名单挡了」的痕迹。
      noteAllowMiss(kind, id, `${kind}:${id}`);
      return;
    }

    // ── 被禁言的群直接跳过 ────────────────────────────────────────────────
    // 不跳过的话，每条消息都会完整跑一轮（拼 17K 提示词 → 调模型 → 发送被拒绝），
    // 表现是"群里什么都没发生"，账上却每轮都在花钱 —— 这类漏在用量统计里看不见。
    if (kind === 'group' && isBanned(`group:${id}`)) {
      const left = Math.max(1, Math.round(banRemainingMs(`group:${id}`) / 60000));
      recordSkip({
        stage: SKIP_STAGES.GATE,
        chatKey: `group:${id}`,
        reason: `这个群被禁言了（还剩约 ${left} 分钟），不发消息也不跑模型`,
        detail: { banned: true, remainingMin: left }
      });
      return;
    }

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');
    const media = segments ? extractMediaFromSegments(segments) : [];
    // 合并转发里的图/视频：段里只有转发 id，媒体得把转发内容拉出来才取得到。
    // 不补这一步的话，模型只看到 [图片] 占位符，get_message_images 又查不到 media —— 就是「转发的图看不见」。
    await collectForwardMediaInto(segments, media);

    // ── 寻址（@ 了谁 / 引用了谁）──────────────────────────────────────
    // 这一步只扫原始 id，**不联网**：@ 的 QQ 号、引用的 message_id 都在段里。
    // 名字放到 segmentsToText 之后再解析 —— 那时 resolveAtName / resolveReply
    // 的缓存已经被热过一遍，不会为了寻址多打一次接口。
    // 为什么非要结构化：以前只有文本里的 "@张三"，没人去读它，于是
    // 「@张三 吃了吗」和「@我 吃了吗」在闸门眼里是一回事（都是 @ 开头）。
    const atRefs = { self: false, all: false, others: [] };
    let replyRefId = '';
    if (segments) {
      for (const seg of segments) {
        const d = seg?.data ?? {};
        if (seg?.type === 'at') {
          const qq = String(d.qq ?? '').trim();
          if (!qq) continue;
          if (qq === 'all') atRefs.all = true;
          else if (onebot.selfId && qq === String(onebot.selfId)) atRefs.self = true;
          else atRefs.others.push(qq);
        } else if (seg?.type === 'reply' && d.id !== undefined && d.id !== null) {
          replyRefId = String(d.id);
        }
      }
    }

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null,
        resolveForward: (forwardId) => onebot.getForwardMsg(forwardId),
        selfId: onebot.selfId            // 命中自己 → 文本里标「@我」（唤醒闸门要用）
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 定向消息里的语音先自动转成文字（写进消息文本，提示词/存档里直接就是文字）
    text = await autoTranscribeIncoming(kind, id, text, media);
    if (!text && !media.length) return;
    const chatKey = kind + ':' + id;

    // 寻址三件套落库（此刻两个缓存都已热，不额外联网）
    let atOthers = null;
    if (atRefs.others.length) {
      const names = [];
      for (const qq of atRefs.others.slice(0, 6)) {
        // 解析不出来就留 QQ 号：寻址判定只要有"这是另一个人"就够了，不需要好看
        const n = kind === 'group' ? await resolveAtName(id, qq) : null;
        names.push(n || qq);
      }
      atOthers = names;
    }
    if (atRefs.all) atOthers = [...(atOthers || []), 'all'];
    let replyRef = null;
    if (replyRefId) {
      const r = await resolveReply(replyRefId);
      // 拿到原文但拿不到发送者（比如引用了自己的话、接口只回了空名片）时也照记：
      // addressee.js 只关心"引用的这条是不是我发的"
      if (r && (r.senderId || r.sender || r.text)) {
        replyRef = {
          sender: r.sender,
          senderId: r.senderId,
          text: r.text,
          self: onebot.selfId ? String(r.senderId) === String(onebot.selfId) : false
        };
      }
    }

    store.appendIncoming(chatKey, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      atSelf: atRefs.self,
      atOthers,
      reply: replyRef,
      media
    });
    emit('chat-update', chatKey);
    // 点歌台的确定性指令（#点歌 / #歌单 / #搜歌 …）在这里截获：
    // 命中就自己回，不进模型 —— 点播要的是「立刻、稳定」，不是让模型猜意图。
    try {
      const handled = await handlePlaylistCommand({
        chatKey,
        text,
        senderId,
        senderName,
        messageId: event.message_id ?? null,
      });
      if (handled) {
        // 指令已经由代码回复，标记这条已读，避免下一次模型运行又把它当成「群友在说话」
        try { store.markRead(chatKey, event.message_id); } catch { /* 已读标记失败不影响点播 */ }
        // 留一条：这条消息**没进模型**，是代码直接处理的。
        // 不记的话，用户在面板上看到"它没回这条"，而实际上它回了 —— 只是没走模型。
        try {
          recordSkip({
            stage: SKIP_STAGES.DIRECTIVE,
            chatKey,
            reason: '点歌台指令由代码直接处理，未进模型',
            detail: { text: String(text || '').slice(0, 60) }
          });
        } catch { /* 记账失败不影响点播 */ }
        return;
      }
    } catch (error) {
      log('[playlist] 指令处理失败:', error?.message ?? error);
    }

    // 群友甩视频链接 → 自己先看一遍（确定性的「看视频」，不赌模型这一轮会不会想起调工具）。
    // 拍一拍要当场回拍、点歌要当场播，同理：链接进来就先把它读一遍，
    // 否则模型只能看着一个 URL 说"我看不了视频"——那是它唯一诚实的选项。
    try {
      await autoWatchVideo(chatKey, text, event.message_id ?? null);
    } catch (error) {
      log('[视频] 自动看视频出错:', error?.message ?? error);
    }
    // ⚠️ 这里**不 return**：消息里只有链接时 autoWatchVideo 会自行标记已读，
    // 但同一批里可能还有别的未读消息，直接返回会把它们一起晾着。
    // 所有消息都交给模型处理（入库 + 触发），由模型根据上下文自主决定是否回复。
    // 系统提示已引导：@/点名/针对自己的必回；无关群聊/别人的图/别人的引用 → 模型选择安静结束（不回复）。
    orchestrator.onIncoming(chatKey);
  }

  async function ingestPoke(event) {
    // 判定全在 gesture.js（纯函数）：只有"拍的是机器人"才唤醒，
    // 别人之间的拍一拍只留档当背景 —— 群里的互动它不必每条都插一句。
    const p = parsePokeEvent(event, onebot.selfId);
    if (!p.ok) return;
    if (!allowed(p.kind, p.kind === 'group' ? p.chatKey.split(':')[1] : p.fromId, getConfig())) return;

    // 同一个 poke 协议端可能重复推送：按 "会话|谁|拍谁|时间" 去重（30 秒窗口）
    const nowTs = Date.now();
    if (pokeSeen.has(p.dedupeKey)) return;
    pokeSeen.set(p.dedupeKey, nowTs);
    if (pokeSeen.size > 200) {
      for (const [k, ts] of pokeSeen) if (nowTs - ts > 30000) pokeSeen.delete(k);
    }

    let fromName = p.fromId;
    let targetName = p.targetId;
    if (p.kind === 'group') {
      const groupId = p.chatKey.split(':')[1];
      fromName = (await resolveAtName(groupId, p.fromId)) || p.fromId;
      targetName = p.aboutSelf ? '你' : ((await resolveAtName(groupId, p.targetId)) || p.targetId);
    } else if (p.aboutSelf) {
      targetName = '你';
    }

    const text = pokeTextOf(p, { fromName, targetName, selfId: onebot.selfId });

    // 别人拍我 → 当场拍回去（确定性动作，不赌模型这一轮会不会想起 send_poke）。
    // 为什么放在入站而不是工具里：回拍是「被戳了一下」的手反射；让它先过一遍模型推理，
    // 就变成「想一想要不要拍」，实测经常只回一句「干嘛」就完了 —— 在群里看着像装死。
    // 分寸仍归 gesture.pokeBudget(inbound)：8 秒手速 + 同一个人 60 秒只回一次；
    // 深夜/心情低不设限（被拍了装死比回拍更假）。
    let wantBack = false;
    let streak = { count: 0, angry: false, level: 'calm', note: '' };
    if (p.aboutSelf) {
      const gCfg = getConfig().gesture || {};

      // ① 先数一下被戳到第几下了 —— 连戳到点就不陪玩了。
      // 顺序很重要：先数后判，否则"第 4 下要不要回拍"永远拿不到最新的 count。
      const sk = `${p.chatKey}|${p.fromId}`;
      const prevStreak = pokeStreakSeen.get(sk) || { count: 0, at: 0 };
      streak = pokeStreak({ count: prevStreak.count, lastAt: prevStreak.at, now: nowTs, cfg: gCfg });
      pokeStreakSeen.set(sk, { count: streak.count, at: nowTs });
      if (pokeStreakSeen.size > 200) {
        const ttl = Math.max(1000, Number(gCfg.pokeStreakResetMs ?? 5 * 60 * 1000));
        for (const [k, v] of pokeStreakSeen) if (nowTs - v.at > ttl) pokeStreakSeen.delete(k);
      }

      const prev = pokeBackSeen.get(p.chatKey) || { at: 0, targetId: '' };
      // gesture.enabled=false 是「关掉拍一拍」的总闸：档案照记（模型知道被拍了），但不动手。
      // 连戳到炸毛也一并停手 —— 被戳烦了还每次都回拍，就成弹簧了。
      const verdict = gCfg.enabled === false
        ? { allow: false, reason: '拍一拍已关闭' }
        : streak.angry
          ? { allow: false, reason: `连着被戳 ${streak.count} 下，有点毛了` }
          : shouldPokeBack({
            now: nowTs,
            fromId: p.fromId,
            lastBackAt: prev.at,
            lastBackTargetId: prev.targetId,
            cfg: gCfg
          });
      if (verdict.allow) {
        wantBack = true;
        // 配额在**决定拍**的时候就占掉：失败是稀有的，但"被连戳 + 每次都重试"不稀有。
        pokeBackSeen.set(p.chatKey, { at: nowTs, targetId: p.fromId });
        if (pokeBackSeen.size > 200) {
          for (const [k, v] of pokeBackSeen) if (nowTs - v.at > 3600 * 1000) pokeBackSeen.delete(k);
        }
      }
    }

    // 回拍要在**写存档之前**真的发出去。
    // 存档里那句"（已经拍回去了）"是给模型看的，它据此决定"这件事已经办了、不用再拍"。
    // 以前是判定通过就先把这句话写进去、发送另起炉灶异步跑 —— 于是发送失败时
    // 模型照样被告知"已经拍回去了"，一句话把两道保险都拆掉（实测 94 次回拍、0 次真发出，
    // 全靠这句"已经拍回去了"瞒着）。现在：拍不出去就照实说没拍成。
    let pokedBack = false;
    if (wantBack) {
      const backTarget = p.kind === 'group' ? Number(p.fromId) : null;
      // 最多等 2.5 秒：发送链上可能排着别的消息，但不能让一次入站事件卡死在这里。
      // 超时**不取消**发送（它还在跑，成功了照样留档），只是这一轮先按"没拍成"记账。
      pokedBack = await Promise.race([
        sender.poke(p.chatKey, backTarget, { targetName: p.kind === 'group' ? fromName : '' })
          .then(() => true)
          .catch((e) => { log('[拍一拍] 回拍失败:', e?.message ?? e); return false; }),
        new Promise((r) => setTimeout(() => r(false), 2500))
      ]);
    }

    store.appendIncoming(p.chatKey, {
      mid: null,
      ts: p.at,
      senderId: p.fromId,
      senderName: '（拍一拍事件）',
      // 括号里的说明是给模型看的：它一读就知道「已经拍回去了」，
      // 不用再调 send_poke（调了也会被手速预算拦掉，白跑一趟）。
      text: pokedBack
        ? `${text}${streak.note}（已经拍回去了）`
        : (streak.angry
          ? `${text}${streak.note}（这次没拍回去）`
          : (wantBack ? `${text}${streak.note}（想拍回去但没拍成）` : text)),
      media: []
    });
    emit('chat-update', p.chatKey);

    // 拍别人：只当背景，不触发（对方没叫它）。要让它连别人的互动也接，
    // 把 gesture.othersWake 打开即可。
    if (p.aboutSelf || getConfig().gesture?.othersWake === true) {
      orchestrator.onIncoming(p.chatKey);
    }
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // 禁言：只关心"被禁的是不是自己"。OneBot v11 的 group_ban 事件里
    // user_id 是被操作的人，duration 为 0 表示解禁。
    if (event.post_type === 'notice' && event.notice_type === 'group_ban' && event.group_id != null) {
      if (String(event.user_id ?? '') !== onebot.selfId) return;
      const key = `group:${event.group_id}`;
      const duration = Number(event.duration) || 0;
      if (String(event.sub_type) === 'ban' || duration > 0) {
        const r = noteBan(key, { durationSec: duration, reason: `平台推送禁言（操作者 ${event.operator_id || '?'}）` });
        log(`[禁言] ${key} 被禁言 ${Math.round(r.ms / 60000)} 分钟，期间不再处理该群消息`);
      } else {
        clearBan(key);
        log(`[禁言] ${key} 已解禁`);
      }
      return;
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  // ── 语音通话网关 ──
  // 挂在**同一个** server 上（用 upgrade 事件 + ws 的 noServer 模式）：
  // 不新开端口、不加依赖、不改任何现有路由。鉴权直接复用下面的 authorize()。
  //
  // 为什么不走 HTTP 长轮询：通话是双向高频小包（每 20~60ms 一帧音频），
  // 长轮询的延迟和开销都受不了；而项目里本来就装了 ws（onebot.js 在用）。
  let voiceGateway = null;
  let voiceGatewayError = '';
  function ensureVoiceGateway() {
    if (voiceGateway || voiceGatewayError) return voiceGateway;
    const vcfg = getConfig().voice || {};
    const ccfg = getConfig().call || {};
    if (vcfg.enabled === false) {
      voiceGatewayError = 'config.voice.enabled=false';
      return null;
    }
    try {
      voiceGateway = attachVoiceGateway({
        server,
        authorize,
        log,
        config: {
          maxCallMs: vcfg.maxCallMs,
          maxTurns: vcfg.maxTurns,
          vadThreshold: vcfg.vadThreshold,
          vadMinSpeechMs: vcfg.vadMinSpeechMs,
          // 打 QQ 电话时这两项要用 config.call 里的宽松值：
          // 对方的声从系统混音里来，断得急（700ms）会把一句话从中间劈开。
          vadSilenceMs: ccfg.vadSilenceMs ?? vcfg.vadSilenceMs,
          vadPreRollMs: ccfg.vadPreRollMs,
          vadKeepTailMs: ccfg.vadKeepTailMs,
          bargeIn: vcfg.bargeIn,
          replyMaxChars: vcfg.replyMaxChars,
          historyTurns: vcfg.historyTurns,
          ttsFormat: vcfg.ttsFormat,
          idleTimeoutMs: vcfg.idleTimeoutMs,
          // 展示用：前端拿它显示「用哪个模型听懂你」
          asrModel: qwenAsrConfig().model || ''
        }
      });
      log('[语音] 通话网关已挂载：/voice/ws');
    } catch (error) {
      voiceGatewayError = String(error?.message ?? error);
      log(`[语音] 通话网关挂载失败：${voiceGatewayError}`);
      voiceGateway = null;
    }
    return voiceGateway;
  }

  // ── QQ 通话：自动接听看门狗 ──
  // 和 voiceGateway 一样懒挂载（测试会建 app 但不 start，构造期就起定时器会拖住进程）。
  // 默认 config.call.enabled=false —— 替用户接电话是高风险动作，必须显式打开。
  let callWatcher = null;
  let callWatcherError = '';
  function ensureCallWatcher() {
    if (callWatcher) return callWatcher;
    // 「没开」这个结论**不能缓存**：在面板上把开关打开之后，下一次请求就该真的挂上。
    // （voiceGateway 那边把 disabled 缓存进了 voiceGatewayError，改配置必须重启；
    //   这里不重复那个坑 —— 看门狗本来就是"随时能开能关"的东西。）
    const ccfg = getConfig().call || {};
    if (ccfg.enabled !== true) return null;
    if (callWatcherError) return null;
    try {
      callWatcher = createCallWatcher({
        scan: (opts) => scanCallWindows(opts),
        answer: ({ pid, buttonName }) => invokeAnswer({ pid, buttonName }),
        intervalMs: ccfg.scanIntervalMs,
        cooldownMs: ccfg.answerCooldownMs,
        // 只有 autoAnswer 打开才真的点「接听」；否则只探测 + 发事件。
        isEnabled: () => getConfig().call?.autoAnswer === true,
        options: () => {
          const c = getConfig().call || {};
          return {
            windowPattern: c.windowPattern,
            answerPattern: c.answerPattern,
            rejectPattern: c.rejectPattern,
            preferVideo: c.preferVideo
          };
        },
        log
      });
      callWatcher.start();
      log(`[通话] 自动接听看门狗已启动（间隔 ${ccfg.scanIntervalMs}ms，autoAnswer=${ccfg.autoAnswer === true}）`);
    } catch (error) {
      callWatcherError = String(error?.message ?? error);
      log(`[通话] 看门狗启动失败：${callWatcherError}`);
      callWatcher = null;
    }
    return callWatcher;
  }

  // 音频设备枚举的缓存。
  //
  // 为什么一定要缓存：一次 PowerShell 枚举本机实测 3.5~4.1 秒，而
  //   - /api/call/status（两个通话面板每次打开都调）要它的 virtualCable；
  //   - /api/call/devices（「声音送到哪」的下拉框）要整张表；
  //   - 面板还会在保存配置后立刻重读一次状态。
  // 不缓存的话，光是打开页面就要串行等四秒，用户看到的就是「卡顿、无法加载」。
  //
  // 为什么是「过期的也先给」：30 秒一到就让下一个请求去等四秒，等于把卡顿
  // 随机分配给某次打开面板。所以有过期值时立刻返回旧值，同时在后台重查 ——
  // 设备插拔本来也不是打开面板那一刻发生的事，慢半分钟没有代价。
  const AUDIO_CACHE_MS = 30_000;
  const audioCache = { at: 0, value: null, inflight: null };

  function refreshAudioDevices() {
    // 并发合并：面板同时发 status + devices 时只跑一次 PowerShell，
    // 否则两个请求各起一个，白白多等四秒。
    if (audioCache.inflight) return audioCache.inflight;
    const task = (async () => {
      try {
        const value = await listAudioDevices();
        audioCache.value = value;
        audioCache.at = Date.now();
        return value;
      } finally {
        audioCache.inflight = null;
      }
    })();
    audioCache.inflight = task;
    return task;
  }

  /** fresh=false：有过期值就直接给旧值并在后台重查；没有值才真的等。 */
  async function audioDevicesCached({ fresh = false } = {}) {
    if (fresh) audioCache.at = 0;
    const age = Date.now() - audioCache.at;
    if (audioCache.value) {
      if (age >= AUDIO_CACHE_MS) refreshAudioDevices().catch(() => {});
      return audioCache.value;
    }
    return refreshAudioDevices();
  }

  function json(res, code, data, headers = null) {
    const base = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    res.writeHead(code, headers ? { ...base, ...headers } : base);
    res.end(JSON.stringify(data));
  }

  /** 唱歌引擎状态：扫描 DiffSinger 声库 + Seed-VC 权重 + SVC 服务开关。 */
  function singStatus() {
    const dsDir = path.join(ROOT, 'diffsinger-hutao');
    const banks = [];
    // 扫描 diffsinger-hutao/ 下所有带 character.txt 的声库目录。
    // ★ 别再写死目录名：之前硬编码 ['hu2_tao2','na4_xi1_da2']，新装的知更鸟
    //   （zhi1_geng4_niao3）怎么都不出现在唱歌音色列表里，看着像"装不上"。
    let dirs = [];
    try {
      dirs = fs.readdirSync(dsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { dirs = []; }
    for (const d of dirs) {
      const cp = path.join(dsDir, d, 'character.txt');
      if (fs.existsSync(cp)) {
        let name = d;
        try {
          const m = fs.readFileSync(cp, 'utf8').match(/^name=(.*)$/m);
          if (m) name = m[1].trim();
        } catch { /* 忽略 */ }
        banks.push({ id: d, name });
      }
    }
    const seedCkpt = path.join(ROOT, 'seed-vc', 'checkpoints',
      'DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema.pth');
    const svc = (getConfig().audio || {}).svc || {};
    return {
      diffSinger: { ready: banks.length > 0, banks },
      seedVc: { ready: fs.existsSync(seedCkpt) },
      svc: { enabled: svc.enabled === true, model: svc.model || 'hutao', mixInstrumental: svc.mixInstrumental !== false },
    };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  // ── 控制台鉴权 ──────────────────────────────────────────────────────────
  // 三种凭证来源，优先级：header > cookie > query。
  //   header  : PC 端 / 脚本（x-console-token）
  //   cookie  : 手机浏览器（EventSource 不能带自定义 header，只能靠同源 cookie）
  //   query   : 仅兼容老调用与 curl 调试；会进访问日志，手机端不要用
  const AUTH_COOKIE = 'qqagent_token';

  function parseCookies(req) {
    const raw = String(req.headers.cookie || '');
    const out = {};
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      if (!key) continue;
      try {
        out[key] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        out[key] = part.slice(idx + 1).trim();
      }
    }
    return out;
  }

  function consoleToken() {
    return String(getConfig().server?.token ?? '').trim();
  }

  /** 定长比较，避免按字符逐位比较泄露令牌前缀。 */
  function sameToken(a, b) {
    const left = Buffer.from(String(a ?? ''), 'utf8');
    const right = Buffer.from(String(b ?? ''), 'utf8');
    if (!left.length || left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  }

  function authorize(req) {
    const token = consoleToken();
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    const given =
      req.headers['x-console-token'] ||
      parseCookies(req)[AUTH_COOKIE] ||
      url.searchParams.get('token') ||
      '';
    return sameToken(given, token);
  }

  function authCookieHeader(value, maxAgeSec) {
    // 局域网一般是 http，不能加 Secure（否则浏览器直接丢弃）。
    // HttpOnly 挡住 JS 读取，SameSite=Lax 挡住跨站表单；Path=/ 让 SSE 也能带上。
    return `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`;
  }

  /** 请求是否来自本机（用于只允许本机操作的接口）。 */
  function isLocalRequest(req) {
    const remote = String(req.socket?.remoteAddress || '');
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  }

  /**
   * 私网 IPv4 判定。
   * 之所以要判：PPPoE 拨号网卡（"宽带连接"）会直接持有公网 IP，
   * 它和 WiFi 网卡一样都是"非回环 IPv4"，排在前面的地址会被当访问地址印给用户。
   */
  function isPrivateIPv4(ip) {
    const parts = String(ip).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // 运营商级 NAT
    if (parts[0] === 169 && parts[1] === 254) return true; // 链路本地，连不上但不是公网
    return false;
  }

  /** 按网卡枚举本机 IPv4，拆成私网/公网两组。 */
  function describeAddresses() {
    const priv = [];
    const pub = [];
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list || []) {
          if (!item || item.family !== 'IPv4' || item.internal) continue;
          (isPrivateIPv4(item.address) ? priv : pub).push(item.address);
        }
      }
    } catch {
      /* 拿不到就算了，日志少一行不影响启动 */
    }
    // 去重（同一地址可能挂在多个虚拟网卡上）
    return { private: [...new Set(priv)], public: [...new Set(pub)] };
  }

  /** 本机所有非回环 IPv4，私网优先。 */
  function localIPv4List() {
    const { private: priv, public: pub } = describeAddresses();
    return [...priv, ...pub];
  }

  /**
   * 监听地址审计：非回环监听但没设令牌 → 强制退回 127.0.0.1。
   * 宁可手机连不上，也不能让同网段任何人都能改模型密钥、切 QQ 账号。
   */
  function auditBindHost() {
    const wanted = String(getConfig().server?.bindHost || '127.0.0.1').trim();
    const allowed = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::']);
    if (!allowed.has(wanted)) return '127.0.0.1';
    const loopback = wanted === '127.0.0.1' || wanted === 'localhost';
    if (!loopback && !consoleToken()) {
      log('⚠ server.bindHost 想监听外网但没有设置 server.token，已强制退回 127.0.0.1。请在设置里先填访问令牌。');
      return '127.0.0.1';
    }
    return wanted;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE（支持 ?after= / Last-Event-ID 续传，见 event-log.js）
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write('retry: 3000\n\n');
      const after = cursorFrom(req, url);
      const rep = after === null ? { items: [], cursor: eventLog.cursor(), gap: false } : eventLog.since(after);
      res.write(formatSse({ type: 'hello', payload: { cursor: rep.cursor, replayed: rep.items.length, gap: rep.gap } }));
      for (const ev of rep.items) {
        try { res.write(formatSse(ev)); } catch { break; }
      }
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ── 登录入口（必须排在 authorize 之前：登录本身不可能"已经登录"）──────
    if (pathname === '/api/auth/status' && req.method === 'GET') {
      const required = !!consoleToken();
      return json(res, 200, {
        required,
        authed: authorize(req),
        // 只回"要不要登录"，不回令牌、不回任何长度/前缀信息
        mobile: true
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const expected = consoleToken();
      if (!expected) {
        // 没设令牌 = 本机免登录模式，直接放行（不写 cookie，避免制造"已登录"假象）
        return json(res, 200, { ok: true, required: false });
      }
      const ip = String(req.socket?.remoteAddress || '');
      const now = Date.now();
      const bucket = loginFails.get(ip) || { count: 0, until: 0 };
      if (bucket.until > now) {
        return json(res, 429, { error: `尝试次数过多，请 ${Math.ceil((bucket.until - now) / 1000)} 秒后再试` });
      }
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        body = {};
      }
      if (!sameToken(String(body?.token ?? ''), expected)) {
        const count = bucket.count + 1;
        // 5 分钟内错 8 次锁 5 分钟：局域网里最坏情况也就挡住手抖，不影响正常使用
        loginFails.set(ip, { count, until: count >= 8 ? now + 5 * 60 * 1000 : 0 });
        if (count >= 8) loginFails.set(ip, { count: 0, until: now + 5 * 60 * 1000 });
        return json(res, 401, { error: '令牌不对' });
      }
      loginFails.delete(ip);
      return json(res, 200, { ok: true, required: true }, {
        'set-cookie': authCookieHeader(expected, 30 * 24 * 3600)
      });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, {
        'set-cookie': authCookieHeader('', 0)
      });
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        return json(res, 200, {
          // 进程身份：面板靠 startedAt 变化判断"重启完成"，pid 用于排查多实例
          startedAt,
          pid: process.pid,
          tmpSwept,
          restarting,
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null,
            // 账号级健康（与"WS 是否连上"不同：账号离线时 WS 仍可能连着）
            account: onebotHealth.snapshot(),
            // 综合结论：WS 连着 **且** 账号在线，才算真正可用
            healthy: !!onebot.connected && onebotHealth.snapshot().online !== false
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          usage: {
            ...usage,
            cost: estimateCost(usage)
          },
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          // 配置完整性：status 不为 'ok' 说明这份配置是坏的/读不出来的，
          // 面板要显式显示"你现在跑在出厂设置上"，否则用户只会觉得"她今天怪怪的"
          configIntegrity: getConfigIntegrity(),
          // 梗百科：只 stat + 读文件头，不加载词库（面板会轮询这个接口）
          memeWiki: wikiStatusLite(),
          // 出站网络：配了代理却没生效（或压根没配）是"连接超时"的第一嫌疑，
          // 面板上要能一眼看到，否则每次都要去翻日志。
          net: { ...NET_STATUS, ...netProxyStatus() }
        });
      }

      // 用量：按模型跨日聚合（回答"这个月各家花了多少"，而不只是"今天多少"）
      if (pathname === '/api/usage/by-model' && method === 'GET') {
        const days = Number(url.searchParams.get('days') || 30);
        const rows = sessions.usageByModel(days).map((r) => ({
          ...r,
          cost: estimateCost(r, { model: r.model })
        }));
        const total = rows.reduce((acc, r) => ({
          totalTokens: acc.totalTokens + r.totalTokens,
          promptTokens: acc.promptTokens + r.promptTokens,
          completionTokens: acc.completionTokens + r.completionTokens,
          cachedTokens: acc.cachedTokens + r.cachedTokens,
          calls: acc.calls + r.calls,
          cost: acc.cost + r.cost
        }), { totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0, cost: 0 });
        total.cost = Math.round(total.cost * 100) / 100;
        return json(res, 200, { ok: true, days: Math.min(365, Math.max(1, days || 30)), models: rows, total, price: priceOf(cfgNow.api?.model) });
      }

      // 用量历史：按天归档在 data/usage/<day>.json（不随 sessions 清理而丢）
      if (pathname === '/api/usage/history' && method === 'GET') {
        const days = Number(url.searchParams.get('days') || 7);
        const px = priceOf(cfgNow.api?.model);
        const list = sessions.usageHistory(days).map((d) => ({
          ...d,
          cost: Math.round(estimateCost(d) * 100) / 100
        }));
        const total = list.reduce((acc, d) => ({
          promptTokens: acc.promptTokens + (d.promptTokens || 0),
          completionTokens: acc.completionTokens + (d.completionTokens || 0),
          totalTokens: acc.totalTokens + (d.totalTokens || 0),
          runs: acc.runs + (d.runs || 0),
          cost: acc.cost + (d.cost || 0)
        }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, runs: 0, cost: 0 });
        total.cost = Math.round(total.cost * 100) / 100;
        return json(res, 200, {
          ok: true,
          days: list,
          total,
          price: {
            // 来自 data/prices.json（含闲时/高峰两套价与时段规则），查不到才回落 config
            ...px,
            inputPerM: px.in,
            outputPerM: px.out,
            cachePerM: px.cached,
            provider: cfgNow.api?.provider ?? '',
            model: cfgNow.api?.model ?? ''
          }
        });
      }

      if (pathname === '/api/moods' && method === 'GET') {
        const chatKey = String(url.searchParams.get('chatKey') || '').trim();
        if (chatKey) {
          return json(res, 200, { ok: true, chatKey, mood: orchestrator.mood.get(chatKey) });
        }
        return json(res, 200, { ok: true, moods: orchestrator.mood.list() });
      }

      // QQ 内置表情映射：控制台据此把「[表情:笑哭]」渲染成真表情图（拿不到就只显示名字）
      if (pathname === '/api/qq-faces' && method === 'GET') {
        return json(res, 200, { ok: true, faces: qqFaceTable() });
      }

      // 群梗候选：模型只能提，人能确认/拒绝。候选永远不进提示词（见 memes.js）。
      // ── 发送台账（结果不确定的消息）────────────────────────────────
      if (pathname === '/api/send/pending' && method === 'GET') {
        const chatKey = String(url.searchParams.get('chatKey') || '').trim() || null;
        return json(res, 200, { ...sendLedger.stats(), items: sendLedger.pending({ chatKey, limit: 100 }) });
      }
      if (pathname === '/api/send/resolve' && method === 'POST') {
        try {
          const body = await readBody(req);
          const fp = String(body?.fp || '').trim();
          if (!fp) return json(res, 400, { error: '缺少 fp' });
          const ok = sendLedger.resolve(fp, String(body?.by || 'manual'));
          return json(res, ok ? 200 : 400, { ok, error: ok ? undefined : '没有这条待确认记录（可能已经结清）' });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 表达学习（候选库 / 正式库）──────────────────────────────────
      if (pathname === '/api/expressions' && method === 'GET') {
        const lib = getExpressions();
        return json(res, 200, {
          stats: lib.stats(),
          pending: lib.pendingList().slice(0, 100),
          library: lib.libraryList().slice(0, 100),
        });
      }
      if (pathname === '/api/expressions/promote' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = getExpressions().promote(String(body?.id || ''));
          return json(res, r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/expressions/reject' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = getExpressions().reject(String(body?.id || ''));
          return json(res, r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/expressions/add' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = getExpressions().add(String(body?.text || ''));
          return json(res, r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── "等被叫"状态（安静到什么时候、被谁叫会解除）────────────────
      if (pathname === '/api/mention-wait' && method === 'GET') {
        return json(res, 200, { items: getMentionWait().list() });
      }

      // ── 风控自检（只读，不改配置）──────────────────────────────────
      if (pathname === '/api/risk/audit' && method === 'GET') {
        return json(res, 200, auditRisk(getConfig(), { todaySent: sendStats.count }));
      }

      // ── 闸门最后判定（"她刚才为什么回/不回"）─────────────────────
      if (pathname === '/api/gate/last' && method === 'GET') {
        const items = [...orchestrator.lastDecision.entries()]
          // targets 是逐条的寻址结论，只给排障用、不进接口（前端只需要两个汇总标志）
          .map(([chatKey, { targets, ...d }]) => ({ chatKey, ...d }))
          .sort((a, b) => (b.at || 0) - (a.at || 0))
          .slice(0, 30);
        return json(res, 200, { items });
      }

      // ── 跳过记录（"她刚才为什么没回"的完整账）─────────────────────
      // 90% 的时间她都在"决定不说话"，而这件事以前在日志里只有沉默。
      // 这一页是排障入口：先按 stage 看哪一类最多，再看具体原因与 traceId。
      //
      // 2026-10-29 第 13 轮：这个接口从第 1 轮就存在，但**没有任何前端调它**，
      // 于是二十个 stage 只以裸的英文短横线串（`send-quota` / `model-silent`…）
      // 躺在日志里 —— 等于这个功能没做。这次把中文标签一并吐出来，
      // 标签的唯一实现在 `src/skip-labels.js`（不在前端各写一份，那必然漂移）。
      if (pathname === '/api/skips' && method === 'GET') {
        const u = new URL(req.url, 'http://x');
        const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 50));
        const sinceMs = Math.max(0, Number(u.searchParams.get('since')) || 0);
        const since = sinceMs ? Date.now() - sinceMs : 0;
        const stats = skipStats({ since });
        return json(res, 200, {
          // 每条记录都带上人话，前端不必知道 stage 的语义
          items: recentSkips(limit)
            .filter((r) => !since || r.at >= since)
            .map((r) => {
              const d = describeStage(r.stage);
              return { ...r, label: d.label, hint: d.hint, action: d.action, spent: d.spent };
            }),
          stats,
          // 翻译 + 排序后的统计行（面板直接渲染这张表，不用自己排）
          rows: explainStats(stats),
          // 一句话结论：多少次没开口里有几次是**没花钱**的
          summary: summarizeStats(stats),
          // 全量阶段表：面板的图例/筛选器用它，保证和枚举永远同步
          stages: stageTable()
        });
      }

      // ── 语音通话状态 ─────────────────────────────────────────────────
      // 前端在打开通话页之前先问一次：能不能打、为什么不能打。
      // 这里必须把「不能打」的原因说清楚（没开、没 Key、网关没挂上），
      // 否则用户看到的就是一个按了没反应的按钮。
      if (pathname === '/api/voice/status' && method === 'GET') {
        const vcfg = cfgNow.voice || {};
        // 断句参数可能被 config.call 覆盖（打 QQ 电话要更宽松），这里要报生效值。
        const ccfg = cfgNow.call || {};
        const gw = vcfg.enabled === false ? null : ensureVoiceGateway();
        const acfg = qwenAsrConfig();
        const problems = [];
        if (vcfg.enabled === false) problems.push('语音通话已在配置里关闭（config.voice.enabled=false）');
        if (voiceGatewayError) problems.push(`通话网关没挂上：${voiceGatewayError}`);
        if (!acfg.enabled) problems.push('语音识别没开（config.audio.asr.enabled=false）');
        if (!acfg.apiKey) problems.push('没有 DashScope Key：语音识别和合成都要用它，请到 设置 → 模型 API → 识图 里填');
        return json(res, 200, {
          enabled: vcfg.enabled !== false,
          ready: !!gw && problems.length === 0,
          problems,
          // 浏览器只在 localhost / HTTPS 下给麦克风权限 —— 用局域网 IP 打开会拿不到，
          // 这不是 bug，得在页面上直说，否则用户会以为是程序坏了。
          micRequiresSecureContext: true,
          wsPath: '/voice/ws',
          vad: {
            threshold: vcfg.vadThreshold,
            minSpeechMs: vcfg.vadMinSpeechMs,
            // 实际生效的是哪个：开了 QQ 通话就走 call 的宽松值，否则走 voice 默认。
            // 这里必须报"生效值"而不是配置里那一行 —— 否则面板显示 0.7 秒，
            // 用户听到的却是 0.9 秒才接话，越查越乱。
            silenceMs: ccfg.vadSilenceMs ?? vcfg.vadSilenceMs,
            preRollMs: ccfg.vadPreRollMs ?? 200,
            keepTailMs: ccfg.vadKeepTailMs ?? 200
          },
          asrModel: acfg.model || '',
          ttsFormat: vcfg.ttsFormat || 'mp3',
          limits: { maxCallMs: vcfg.maxCallMs, maxTurns: vcfg.maxTurns, idleTimeoutMs: vcfg.idleTimeoutMs },
          stats: gw ? gw.stats() : null
        });
      }

      // ── QQ 通话（真的 QQ 客户端，不是控制台里那个 voice）─────────────
      // 三步里每一步都可能"没装好"，所以状态接口必须把「能不能用」拆开说清楚：
      // 手（UIA 接听）/ 耳朵（loopback）/ 嘴（虚拟声卡）。只说"未就绪"等于没说。
      if (pathname === '/api/call/status' && method === 'GET') {
        const ccfg = cfgNow.call || {};
        const problems = [];
        const enabled = ccfg.enabled === true;
        if (!enabled) problems.push('QQ 通话功能没开（config.call.enabled=false）—— 替用户接电话是高风险动作，默认关着');
        if (process.platform !== 'win32') problems.push('自动接听只支持 Windows（UIA 是 Windows 无障碍接口）');
        if (enabled && ccfg.autoAnswer !== true) problems.push('只看不接：config.call.autoAnswer=false，扫到来电只发事件，不会点「接听」');
        if (callWatcherError) problems.push(`看门狗没起来：${callWatcherError}`);

        // 面板上刚把开关打开时，这里顺手挂上 —— 否则用户得重启进程才生效。
        if (enabled) ensureCallWatcher();

        // 虚拟声卡是"嘴"的前置。查失败也不能让整个接口 500 —— 面板要能显示原因。
        // ★ 必须带缓存：这一个 PowerShell 枚举本机要 3.5~4.1 秒，而两个面板每次打开
        //   都会调 /api/call/status。不缓存的话页面自己就要等四秒才出得来 —— 那就是
        //   用户看到的「卡顿、无法加载」。过期后先给旧值再后台重查，见 audioDevicesCached。
        let cable = null;
        try {
          cable = (await audioDevicesCached()).virtualCable;
        } catch (error) {
          cable = { state: 'absent', present: false, renderName: '', captureName: '', hint: `查音频设备时出错：${error?.message ?? error}` };
        }
        if (cable && !cable.present) problems.push(`对方暂时听不到它说话：${cable.hint}`);

        return json(res, 200, {
          enabled,
          autoAnswer: ccfg.autoAnswer === true,
          ready: enabled && process.platform === 'win32' && !!cable?.present,
          problems,
          platform: process.platform,
          watch: {
            // 600ms 一轮；只在标题含「通话」的窗口里找按钮（全树扫一轮 >20 秒会错过来电）
            intervalMs: ccfg.scanIntervalMs,
            windowPattern: ccfg.windowPattern,
            answerPattern: ccfg.answerPattern,
            rejectPattern: ccfg.rejectPattern,
            preferVideo: ccfg.preferVideo === true,
            cooldownMs: ccfg.answerCooldownMs
          },
          // 耳朵：Electron 的系统声音环回。浏览器侧只在这个容器里才拿得到 getDisplayMedia。
          loopback: {
            enabled: ccfg.loopbackEnabled !== false,
            // 只有 Electron 主进程里有这个字段；纯 node 跑 app.js（npm test）时是 undefined。
            available: !!process.versions.electron,
            reason: process.versions.electron
              ? ''
              : '系统声音环回要靠 Electron 的 setDisplayMediaRequestHandler，用浏览器打开控制台拿不到 QQ 的声音'
          },
          vad: {
            silenceMs: ccfg.vadSilenceMs,
            preRollMs: ccfg.vadPreRollMs,
            keepTailMs: ccfg.vadKeepTailMs,
            bargeInRatio: ccfg.bargeInRatio
          },
          // 嘴：服务端只知道"装没装、叫什么"；真正选设备要用浏览器的 enumerateDevices。
          // 这两个 id 不能混用 —— 系统端点 id 喂给 setSinkId 会 NotFoundError。
          mouth: {
            outputDeviceId: ccfg.outputDeviceId || '',
            outputHint: ccfg.outputHint || '',
            // 上次手动选中的设备标签。浏览器 deviceId 按 origin 加盐哈希、换端口就失效，
            // 所以持久化的是标签，前端拿它去 enumerateDevices() 里重新认。
            outputLabel: ccfg.outputLabel || '',
            cable,
            note: '服务端返回的是系统端点名（判断装没装）；浏览器要用自己的 enumerateDevices() 拿 deviceId 去 setSinkId'
          },
          watcher: callWatcher ? callWatcher.snapshot() : null
        });
      }

      // 干跑一次扫描：把当前所有窗口和按钮原样吐出来。
      // 这是「接听按钮到底叫什么」的唯一可靠来源 —— 我们手上只有 ohwhale 的正则，
      // 没有本机 QQ 版本的真实按钮名。QQ 改版后先来这里看一眼再改 config。
      if (pathname === '/api/call/probe' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const includeAll = body?.includeAll === true;
        const result = await scanCallWindows({
          windowPattern: body?.windowPattern || cfgNow.call?.windowPattern || '通话',
          includeAll
        });
        const decision = decideAnswer({
          windows: result.windows,
          answerPattern: body?.answerPattern || cfgNow.call?.answerPattern,
          rejectPattern: body?.rejectPattern || cfgNow.call?.rejectPattern,
          preferVideo: cfgNow.call?.preferVideo === true
        });
        return json(res, 200, {
          ok: result.ok,
          errors: result.errors,
          windows: result.windows,
          decision
        });
      }

      // 手动点一次（用探测结果里看到的名字）。给"看门狗不敢用，先手动试一次"留条路。
      if (pathname === '/api/call/answer' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const pid = Number(body?.pid);
        const buttonName = String(body?.buttonName ?? '').trim();
        if (!Number.isFinite(pid) || pid <= 0) return json(res, 400, { ok: false, error: 'pid 不对' });
        if (!buttonName) return json(res, 400, { ok: false, error: 'buttonName 不能为空' });
        const result = await invokeAnswer({ pid, buttonName });
        if (result.ok) log(`[通话] 手动接听：pid=${pid} 按钮「${buttonName}」`);
        return json(res, result.ok ? 200 : 500, result);
      }

      // 音频设备列表：装没装虚拟声卡、叫什么名字。
      if (pathname === '/api/call/devices' && method === 'GET') {
        // 支持 ?fresh=1 强制重查（用户刚插上声卡或刚装完 VB-Cable 时用）。
        const result = await audioDevicesCached({ fresh: url.searchParams.get('fresh') === '1' });
        return json(res, 200, result);
      }

      // 记住"上次把声音送进哪个设备"。
      //
      // 存的是**标签**不是 deviceId：浏览器的 deviceId 按 origin 加盐哈希，
      // 换个端口（3210 → 3211）就全变了，存下来下次认不回来。
      // 标签是驱动给的固定名字，重启、换端口都还在。
      // 传空 label = 忘掉这个选择，回到按 outputHint 自动认。
      if (pathname === '/api/call/output' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const label = String(body?.label ?? '').trim().slice(0, 200);
        const next = updateConfig({ call: { outputLabel: label } });
        log(`[通话] 声音输出设备${label ? `设为「${label}」` : '已清空（回到自动认）'}`);
        return json(res, 200, { ok: true, outputLabel: next.call?.outputLabel || '' });
      }

      // ── 协议端重连状态 / 人工重试（重连预算耗尽后唯一出路）────────
      if (pathname === '/api/onebot/restart-state' && method === 'GET') {
        return json(res, 200, onebot.restartState());
      }
      if (pathname === '/api/onebot/retry' && method === 'POST') {
        onebot.retryNow();
        return json(res, 200, { ok: true, state: onebot.restartState() });
      }

      // ── QQ 空间（qzone.js）：把她的日记发到她自己的空间 ──────────────────
      // 状态：今天的配额、最近的发布记录、以及"哪些日记可以发"（含发没发过）
      if (pathname === '/api/qzone/status' && method === 'GET') {
        const qc = cfgNow.qzone || {};
        const today = todayKey();
        const diaries = [];
        // 会话来源两处：还在用的会话（含带身份模式的 key）+ 日记目录里能反解的孤儿目录
        const chats = new Set(store.listChats());
        for (const k of listDiaryChatKeys()) chats.add(k);
        for (const chatKey of chats) {
          for (const e of listDiaryEntries(chatKey, { limit: 3 })) {
            diaries.push({
              chatKey,
              date: e.date,
              title: e.title || '',
              chars: String(e.body || '').length,
              publicReady: !!readPublicEntry(chatKey, e.date),
              post: findQzonePost(chatKey, e.date)
            });
          }
        }
        diaries.sort((a, b) => (a.date === b.date ? 0 : (a.date < b.date ? 1 : -1)));
        return json(res, 200, {
          ok: true,
          enabled: qc.enabled !== false,
          autoPublish: qc.autoPublishDiary !== false,
          publicSafe: qc.publicSafe !== false,
          ugcRight: qc.ugcRight ?? 64,
          ugcRightLabel: ugcRightLabel(qc.ugcRight),
          ugcOptions: UGC_RIGHTS,
          maxPerDay: Number(qc.maxPerDay) || 0,
          countToday: countPostsOn(today),
          quotaLeft: Number.isFinite(remainingQuota(qc, today)) ? remainingQuota(qc, today) : -1,
          posts: listQzonePosts({ limit: 20 }),
          diaries: diaries.slice(0, 40)
        });
      }

      // 手动发一篇：{chatKey, date, force}。force=true 才重发已发过的那天。
      if (pathname === '/api/qzone/publish' && method === 'POST') {
        let payload = null;
        try {
          payload = await readBody(req);
        } catch {
          return json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }
        const chatKey = String(payload?.chatKey || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey（要发哪个会话的日记）' });
        const r = await orchestrator.publishDiaryNow({
          chatKey,
          date: payload?.date ? String(payload.date) : undefined,
          force: payload?.force === true
        });
        const hints = {
          'no-entry': '这一天还没有日记',
          already: '这一天已经发过了（要重发请打开「强制重发」）',
          empty: '日记内容为空，没发出去',
          unsupported: '当前 NapCat 没有 /send_qzone_msg 接口，升级 NapCat 后再试',
          uncertain: '接口没回 tid，结果不确定 —— 先去空间看看，别急着重发',
          'no-onebot': '协议端没连上',
          failed: '协议端返回失败'
        };
        return json(res, 200, {
          ok: r.ok === true,
          tid: r.tid || '',
          date: r.date || '',
          chars: r.chars || 0,
          reason: r.reason || '',
          error: r.ok ? '' : (r.error || hints[r.reason] || '没发出去')
        });
      }

      if (pathname === '/api/memes/pending' && method === 'GET') {
        return json(res, 200, { ok: true, ...listPending() });
      }
      if (pathname === '/api/memes/confirm' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = confirmMeme(body?.key, { patch: body?.patch && typeof body.patch === 'object' ? body.patch : {} });
          // 带上 error 字段：控制台的 request() 只认 error，否则失败原因会被吞成"请求失败（HTTP 400）"
          return json(res, r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason });
        } catch (error) {
          return json(res, 400, { ok: false, reason: String(error?.message ?? error), error: String(error?.message ?? error) });
        }
      }
      if (pathname === '/api/memes/reject' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = rejectMeme(body?.key, { note: body?.note });
          return json(res, r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason });
        } catch (error) {
          return json(res, 400, { ok: false, reason: String(error?.message ?? error), error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/moods/reset' && method === 'POST') {
        try {
          const body = await readBody(req);
          const chatKey = String(body?.chatKey || '').trim();
          if (!chatKey) return json(res, 400, { error: '缺少 chatKey' });
          return json(res, 200, { ok: true, chatKey, mood: orchestrator.mood.reset(chatKey) });
        } catch (error) {
          return json(res, 500, { error: String(error?.message ?? error) });
        }
      }

      // —— RVC 音色服务：把 TTS 声音换成自定义音色 ——
      if (pathname === '/api/rvc' && method === 'GET') {
        return json(res, 200, { ok: true, ...(await rvcStatus()), models: listRvcModels() });
      }

      if (pathname === '/api/rvc/start' && method === 'POST') {
        const result = await ensureRvcService({ log, force: true });
        return json(res, result.ok ? 200 : 500, result);
      }

      if (pathname === '/api/rvc/restart' && method === 'POST') {
        const result = await restartRvcService({ log });
        return json(res, result.ok ? 200 : 500, result);
      }

      if (pathname === '/api/rvc/stop' && method === 'POST') {
        return json(res, 200, { ok: true, stopped: stopRvcService({ force: true }) });
      }

      // —— 角色本音（GPT-SoVITS）：设置里选「用谁的声音」，顺带能试听 ——
      // 以前音色只能由模型在工具参数里挑，设置页根本没有入口，表现就是"切不了"。
      if (pathname === '/api/gsv/start' && method === 'POST') {
        const result = await ensureGsvService({ log: (m) => log('[语音]', m), force: true });
        return json(res, result.ok ? 200 : 500, result);
      }

      if (pathname === '/api/gsv/voices' && method === 'GET') {
        const cfg = getConfig();
        const service = await gsvHealth(1500);
        const voices = listGsvVoices();
        // 知更鸟没有 GPT-SoVITS 模型，说话走「千问 TTS → RVC(robin.pth)」。
        // 它是一种合法选择，所以也列进来，只是版本标成 RVC 并注明依赖。
        const rvcNames = listRvcModels().map((m) => m.name.toLowerCase());
        for (const [key, name] of [['robin', '知更鸟']]) {
          const ok = rvcNames.includes(key);
          voices.push({
            key,
            name,
            version: 'RVC',
            emotions: [],
            speed: 1,
            available: ok,
            missing: ok ? [] : ['rvc/models/' + key + '.pth'],
            loaded: false,
          });
        }
        return json(res, 200, {
          ok: true,
          service,
          current: String(cfg.audio?.gsvVoice || 'hutao'),
          allowModelPick: cfg.audio?.gsvAllowModelPick === true,
          autoStart: cfg.audio?.gsvAutoStart !== false,
          // 胡桃当前是否被 audio.rvc.preferOverGsv 强制走「TTS→RVC」快路径
          preferOverGsv: cfg.audio?.rvc?.preferOverGsv === true,
          // 按语境换语气（voice-delivery.js）的开关与力度 —— 控制台要用它渲染滑块
          toneAuto: cfg.audio?.toneAuto !== false,
          toneStrength: Number.isFinite(Number(cfg.audio?.toneStrength)) ? Number(cfg.audio.toneStrength) : 1,
          toneParams: cfg.audio?.toneParams !== false,
          // 每个音色能真正换参考音频的情绪（胡桃 0 个、流萤 6 个 —— 必须让用户看见差别）
          coverage: voices.map((v) => toneCoverage(v.key, v.emotions || [])),
          voices,
        });
      }

      // 语气预览：给"改之前先听听"用。纯计算，不合成音频，所以毫秒级返回。
      if (pathname === '/api/gsv/tone-plan' && method === 'GET') {
        const cfg = getConfig();
        const u = new URL(req.url, 'http://127.0.0.1');
        const voice = String(u.searchParams.get('voice') || cfg.audio?.gsvVoice || 'hutao');
        const emotion = String(u.searchParams.get('emotion') || '');
        const moodScore = Number(u.searchParams.get('moodScore'));
        const voices = listGsvVoices();
        const hit = voices.find((v) => v.key === voice);
        const plan = resolveTone({
          emotion,
          voice,
          availableRefs: hit?.emotions || [],
          moodScore: Number.isFinite(moodScore) ? moodScore : 50,
          strength: cfg.audio?.toneStrength,
          enabled: cfg.audio?.toneAuto !== false
        });
        return json(res, 200, {
          ok: true,
          voice,
          plan,
          hint: formatToneHint(plan),
          describe: describeTone(plan),
          coverage: toneCoverage(voice, hit?.emotions || [])
        });
      }

      if (pathname === '/api/gsv/preview' && method === 'POST') {
        try {
          const body = await readBody(req);
          const voice = String(body?.voice || '').trim();
          const text = String(body?.text || '').trim() || '你好呀，今天想聊点什么？';
          if (voice === 'robin') {
            return json(res, 400, {
              ok: false,
              error: '知更鸟没有 GPT-SoVITS 模型，说话走「千问 TTS → RVC」，没法在这里试听。'
            });
          }
          const health = await gsvHealth(2000);
          if (!health.ok) {
            // 没在跑就顺手拉起来（gsvSpeak 内部会 ensure，这里只提示会慢）
            log('[语音] 角色本音服务未运行，试听时自动启动');
          }
          // 试听也要能听出"换语气到底差多少"：控制台传 emotion 就按那条情绪合成。
          // 不传 = 老行为（默认参考音频 + 自动语速），保证"改了没效果"能直接 A/B。
          const emotion = String(body?.emotion || '').trim();
          const style = String(body?.style || '').trim();
          const cfgNow = getConfig();
          const hitVoice = listGsvVoices().find((v) => v.key === voice);
          const plan = resolveTone({
            emotion,
            voice,
            availableRefs: hitVoice?.emotions || [],
            moodScore: Number(body?.moodScore) || 50,
            strength: cfgNow.audio?.toneStrength,
            enabled: cfgNow.audio?.toneAuto !== false
          });
          const out = await gsvSpeak(text.slice(0, 60), { voice, style, plan, timeoutMs: 240000 });
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'content-length': out.buffer.length,
            'cache-control': 'no-store',
            'x-gsv-voice': encodeURIComponent(out.voice || voice),
            'x-gsv-cost-ms': String(out.costMs || 0),
            // 试听结果回传用了哪条情绪、有没有真的换参考音频 —— 前端直接显示
            'x-gsv-emotion': encodeURIComponent(out.emotion || ''),
            'x-gsv-mode': String(out.mode || ''),
            'x-gsv-speed': String(out.speed || '')
          });
          return res.end(out.buffer);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // —— 点歌作业：查询 / 取消 ——
      // 队列虽然是进程内的，但没有对外的观测接口时，「在后台跑」就等于「看不见」。
      // 三个接口 + /api/events 里的 job.* 事件，足够控制台/脚本/外部面板接管进度显示。
      if (pathname === '/api/jobs' && method === 'GET') {
        const u = new URL(req.url, 'http://127.0.0.1');
        const group = u.searchParams.get('group') || null;
        const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 50));
        return json(res, 200, { ok: true, jobs: listSongJobs({ group, limit }) });
      }
      const jobHit = pathname.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
      if (jobHit) {
        const id = decodeURIComponent(jobHit[1]);
        if (!jobHit[2] && method === 'GET') {
          const job = songJobStatus(id);
          return json(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'job_not_found' });
        }
        if (jobHit[2] && method === 'POST') {
          const r = cancelSongJob(id);
          return json(res, r.ok ? 200 : 409, { ok: !!r.ok, ...r });
        }
      }

      // —— 点歌台：查看歌单 / 重扫缓存 ——
      // 歌单是扫描产物（library.json），控制台只需要读；重扫是显式动作，避免每次刷新都扫盘。
      if (pathname === '/api/playlist' && method === 'GET') {
        const u = new URL(req.url, 'http://127.0.0.1');
        const q = String(u.searchParams.get('q') || '').trim();
        const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
        const pageSize = Math.max(1, Math.min(200, Number(u.searchParams.get('pageSize')) || 50));
        let lib = loadLibrary();
        try { if (!lib) lib = await ensureLibrary({ log }); } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
        let tracks = lib?.tracks || [];
        if (q) tracks = searchTracks(q, { lib, limit: 200 }).map((x) => x.track);
        const total = tracks.length;
        return json(res, 200, {
          ok: true,
          meta: getPlaylistMeta(),
          total,
          page,
          pageSize,
          tracks: tracks.slice((page - 1) * pageSize, page * pageSize),
        });
      }
      if (pathname === '/api/playlist/rebuild' && method === 'POST') {
        try {
          const lib = await buildLibrary({ log });
          return json(res, 200, {
            ok: true,
            stats: lib.stats,
            generatedAt: lib.generatedAt,
            buildMs: lib.buildMs,
            roots: lib.roots,
            errors: lib.errors,
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // —— 唱歌引擎状态：DiffSinger 声库 / Seed-VC / SVC ——
      if (pathname === '/api/sing' && method === 'GET') {
        return json(res, 200, { ok: true, ...singStatus() });
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-400) });
      }

      // ── 登录二维码（未登录时展示，供扫码）──
      // NapCat 会把二维码写到它的 cache/qrcode.png，约每 2 分钟自动刷新。
      if (pathname === '/api/snowluma/qr' && method === 'GET') {
        const info = qrInfo(snowlumaDir());
        return json(res, 200, {
          exists: info.exists,
          qrAt: info.qrAt,
          ageMs: info.ageMs,
          // ⚠️ 用「账号是否在线」而非「WS 是否连着」——WS 在账号离线时依然在监听，
        //    用 connected 会让面板以为已登录、从而不显示二维码（2026-09-16 事故）。
        loggedIn: onebotHealth.snapshot().online === true,
          onebotError: onebot.lastConnectError || '',
          self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
        });
      }

      if (pathname === '/api/snowluma/qr.png' && method === 'GET') {
        const got = readQrBuffer(snowlumaDir());
        if (!got) return json(res, 404, { error: '暂无二维码（已登录，或 NapCat 未在等待扫码）' });
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'content-length': got.buffer.length
        });
        return res.end(got.buffer);
      }

      // ── NapCat 登录代理（账密登录 / 人机验证 / 新设备）──
      // 目的：QQ 风控掉线后，用户可在面板里用账号密码自助登录，不必找管理员扫码。
      // 安全：**密码明文不出浏览器**（前端算 MD5 后只传 passwordMd5），
      //       整个 /api/snowluma/* 已在 nginx Basic Auth 之后。
      if (pathname === '/api/snowluma/login/info' && method === 'GET') {
        const info = napcatWebui.info(snowlumaDir());
        const running = await isPortOpen('127.0.0.1', info.port || 6099);
        return json(res, 200, { ...info, running });
      }

      if (pathname === '/api/snowluma/login/status' && method === 'GET') {
        try {
          const st = await napcatWebui.loginStatus(snowlumaDir());
          const quick = await napcatWebui.quickList(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, status: st, quickList: quick });
        } catch (error) {
          log('[login] 状态查询失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/password' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.passwordMd5) return json(res, 400, { ok: false, error: '需要 uin 与 passwordMd5' });
          const r = await napcatWebui.passwordLogin(body.uin, body.passwordMd5, snowlumaDir());
          // 三种结果：直接成功(null) / 需要人机验证 / 需要新设备验证
          return json(res, 200, {
            ok: true,
            needCaptcha: !!(r && r.needCaptcha),
            proofWaterUrl: r?.proofWaterUrl || '',
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          log('[login] 账号密码登录失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/captcha' && method === 'POST') {
        try {
          const body = await readBody(req);
          const need = ['uin', 'passwordMd5', 'ticket', 'randstr'];
          for (const k of need) if (!body?.[k]) return json(res, 400, { ok: false, error: '缺少参数 ' + k });
          const r = await napcatWebui.captchaLogin(body.uin, body.passwordMd5, body.ticket, body.randstr, body.sid, snowlumaDir());
          return json(res, 200, {
            ok: true,
            needNewDevice: !!(r && r.needNewDevice),
            jumpUrl: r?.jumpUrl || '',
            newDevicePullQrCodeSig: r?.newDevicePullQrCodeSig || ''
          });
        } catch (error) {
          log('[login] 人机验证登录失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/new-device' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = await napcatWebui.newDeviceLogin(body.uin, body.passwordMd5, body.newDevicePullQrCodeSig, snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          log('[login] 新设备登录失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：取二维码（str_url 给手机 QQ 扫）
      if (pathname === '/api/snowluma/login/new-device-qr' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.jumpUrl) return json(res, 400, { ok: false, error: '需要 uin 与 jumpUrl' });
          const r = await napcatWebui.getNewDeviceQr(body.uin, body.jumpUrl, snowlumaDir());
          // 顺手在服务端把 str_url 渲染成二维码 dataURL，前端直接展示
          let qrImage = '';
          try {
            if (r?.str_url) qrImage = await napcatWebui.newDeviceQrDataUrl(r.str_url);
          } catch (e) {
            log('[login] 新设备二维码生成失败:', e?.message ?? e);
          }
          return json(res, 200, { ok: true, qr: r, qrImage });
        } catch (error) {
          log('[login] 新设备二维码获取失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新设备扫码验证：轮询状态（3=已扫码 / 1=已确认）
      if (pathname === '/api/snowluma/login/new-device-poll' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin || !body?.bytesToken) return json(res, 400, { ok: false, error: '需要 uin 与 bytesToken' });
          const r = await napcatWebui.pollNewDeviceQr(body.uin, body.bytesToken, snowlumaDir());
          return json(res, 200, { ok: true, poll: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 设备指纹：查看 / 重置（缓解风控掉线）
      if (pathname === '/api/snowluma/device' && method === 'GET') {
        try {
          const guid = await napcatWebui.getDeviceGuid(snowlumaDir()).catch((e) => ({ error: String(e?.message ?? e) }));
          const backups = await napcatWebui.getGuidBackups(snowlumaDir()).catch(() => []);
          return json(res, 200, { ok: true, guid, backups });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/device/reset' && method === 'POST') {
        try {
          const r = await napcatWebui.resetDeviceId(snowlumaDir());
          return json(res, 200, { ok: true, result: r });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 账号总览与一键切号（2026-09-16 新增）─────────────────────────────
      // 用户诉求：面板里要能**直接看到后台在线账号并一键切过去**。
      // 原「快速登录」按钮调 SetQuickLoginQQ 只是**设定**、不触发登录，点了没反应（已查明）。
      // 这里改为：透传外部桌面应用已实现好的账号总览与切号能力。
      if (pathname === '/api/accounts/overview' && method === 'GET') {
        try {
          const data = await deskApi('/api/qq/accounts');
          return json(res, 200, { ok: true, data });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/accounts/switch' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.action) return json(res, 400, { ok: false, error: '需要 action' });
          const r = await deskApi('/api/qq/switch', 'POST', body);
          return json(res, 200, r);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/set-quick' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin) return json(res, 400, { ok: false, error: '需要 uin' });
          await napcatWebui.setQuickLogin(body.uin, snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/quick' && method === 'POST') {
        try {
          const body = await readBody(req);
          if (!body?.uin) return json(res, 400, { ok: false, error: '需要 uin' });
          await napcatWebui.quickLogin(body.uin, snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          log('[login] 快速登录失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/login/refresh-qr' && method === 'POST') {
        try {
          await napcatWebui.refreshQr(snowlumaDir());
          return json(res, 200, { ok: true });
        } catch (error) {
          log('[login] 二维码刷新失败:', error?.message ?? error);
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const result = stopSnowluma();
          return json(res, 200, {
            ok: result.stopped,
            stopped: result.stopped,
            killed: result.killed,
            ids: result.ids,
            // 命中的进程 → 占的端口：面板要能回答"到底关的是不是机器人那个 QQ"
            matched: result.matched || [],
            ports: result.ports || [],
            errors: result.errors,
            embedded: snowlumaStatus().embedded,
            pid: snowlumaStatus().pid
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: customPersonaId(p, i),
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 同名就地更新
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const customRules = String(body.customRules ?? '').trim();
        const list = withStableIds(getConfig().customPersonas || []);
        // ⚠️ 同名一律就地更新，不再默默追加一条。
        //    控制台以前只有「添加人设」没有「改模板」，用户想改某条模板只能重新填一遍，
        //    于是每改一次就多一条同名副本，下拉里根本分不清哪个才是当前的。
        //    想真的另存一份，请改名（或走 PATCH 的 fork）。
        const idx = list.findIndex((p) => String(p?.name || '').trim() === name);
        if (idx >= 0) {
          const next = list.slice();
          const cur = next[idx];
          next[idx] = {
            ...cur,
            name,
            text,
            customRules: customRules || String(cur.customRules || '')
          };
          updateConfig({ customPersonas: next });
          return json(res, 200, { ok: true, id: next[idx].id, updated: true });
        }
        const entry = { id: `custom_${crypto.randomBytes(4).toString('hex')}`, name, text };
        if (customRules) entry.customRules = customRules;
        const next = [...list, entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, id: entry.id, updated: false });
      }

      // 修改某一条模板（就地保存）。内置人设在代码里，改不了 → 引导另存。
      const personaEditMatch = /^\/api\/persona-templates\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (personaEditMatch && (method === 'PATCH' || method === 'PUT')) {
        const id = personaEditMatch[1];
        const body = await readBody(req).catch(() => ({}));
        const list = withStableIds(getConfig().customPersonas || []);
        const idx = findCustomPersonaIndex(list, id);
        const text = String(body.text ?? '').trim();
        const name = String(body.name ?? '').trim().slice(0, 50);
        if (idx < 0) {
          const { PERSONAS } = await import('./personas.js');
          const builtin = PERSONAS[id];
          if (builtin) {
            return json(res, 409, {
              ok: false,
              builtin: true,
              error: `「${builtin.name}」是内置模板（写在代码里），不能直接改。可以用「另存为自定义人设」存一份副本再改。`
            });
          }
          return json(res, 404, { ok: false, error: '没有找到这个人设模板，可能已被删除' });
        }
        if (!text) return json(res, 400, { ok: false, error: '角色设定不能为空' });
        const cur = list[idx];
        const next = list.slice();
        next[idx] = {
          ...cur,
          name: name || cur.name,
          text,
          // 没传 customRules 就保留原值（前端只改正文时不该把附加规则清空）
          customRules: body.customRules === undefined
            ? String(cur.customRules || '')
            : String(body.customRules || '').trim()
        };
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, id: next[idx].id, updated: true });
      }

      if (personaEditMatch && method === 'DELETE') {
        const id = personaEditMatch[1];
        const list = withStableIds(getConfig().customPersonas || []);
        const idx = findCustomPersonaIndex(list, id);
        if (idx < 0) return json(res, 404, { ok: false, error: '没有找到这个人设模板，可能已被删除' });
        const next = list.filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: p.apiKey ? maskSecretValue(p.apiKey) : '',
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const provider = (cfgNow.providers || []).find(
            (item) => item.id === String(body.providerId || '')
          );
          // 只传 providerId 时，地址和密钥都必须取「这家」的。
          // 以前这两项回落到 api.baseUrl / api.apiKey，于是「拉 apibox 的模型列表」实际拉到的是
          // 主端点的模型列表：界面提示成功、模型数也对，但数据全是别人的，属于零报错的错数据。
          const baseUrl = String(body.baseUrl || provider?.baseURL || cfgNow.api.baseUrl || '');
          const requestedKey =
            body.apiKey !== undefined && String(body.apiKey).trim()
              ? body.apiKey
              : provider?.apiKey;
          const apiKey = resolveRequestKey(requestedKey, baseUrl);
          if (!apiKey) return json(res, 400, { ok: false, error: '没有可用的 API Key' });
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models, baseUrl });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const provider = (getConfig().providers || []).find((p) => p.id === String(body.providerId || ''));
          const stored = provider?.apiKey || '';
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl || provider?.baseURL || ''),
            apiKey: resolveRequestKey(body.apiKey, body.baseUrl || provider?.baseURL || '') || stored
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 使用已保存密钥测试连通性：密钥不出服务端，也不接受任意 Base URL。
      if (pathname === '/api/providers/test-saved' && method === 'POST') {
        try {
          const body = await readBody(req);
          const target = savedKeyForTest(body.providerId, body.model);
          if (!target) {
            return json(res, 400, {
              ok: false,
              error: '当前服务商尚未保存 API Key；请输入一次新密钥后再测试。'
            });
          }
          const result = await testModelChat({
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            model: target.model
          });
          return json(res, 200, {
            ok: true,
            providerId: target.providerId,
            model: target.model,
            baseUrl: target.baseUrl,
            result
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const baseUrl = String(body.baseUrl ?? '');
          const result = await testModelChat({
            baseUrl,
            apiKey: resolveRequestKey(body.apiKey, baseUrl),
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: isMaskedSecret(body.apiKey) ? '' : String(body.apiKey ?? ''),
            models: body.models || [],
            id: String(body.id ?? ''),
            displayName: String(body.displayName ?? '')
          });
          const safe = r?.provider
            ? { ...r, provider: publicConfig({ providers: [r.provider] }).providers[0] }
            : r;
          return json(res, 200, { ok: true, ...safe });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          const safe = publicConfig({ providers: [p] }).providers[0];
          return json(res, 200, { ok: true, provider: safe });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的模型：modelId 单个删、modelIds 批量删。
      // 批量是必要的——「清空这家重来」逐个删会把中间态落盘 N 次（见 providers.js 注释）。
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const ids = Array.isArray(body.modelIds) ? body.modelIds : [body.modelId];
          const p = removeModelsFromProvider(String(body.providerId ?? ''), ids);
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          const safe = publicConfig({ providers: [p] }).providers[0];
          return json(res, 200, { ok: true, provider: safe });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 修改提供商：名称 / Base URL / 密钥。空字段 = 不改，掩码 = 不改。
      if (pathname === '/api/providers/update' && method === 'POST') {
        try {
          const body = await readBody(req);
          const rawKey = String(body.apiKey ?? '');
          const updated = updateProviderMeta(String(body.providerId ?? ''), {
            displayName: body.displayName,
            baseUrl: body.baseUrl,
            apiKey: isMaskedSecret(rawKey) ? '' : rawKey
          });
          if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
          const safe = publicConfig({ providers: [updated] }).providers[0];
          return json(res, 200, { ok: true, provider: safe });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 重排模型：这个顺序就是降级链的链位（前 MAX_PER_PROVIDER 个会被实际尝试）。
      if (pathname === '/api/providers/models/reorder' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = reorderProviderModels(String(body.providerId ?? ''), body.modelIds || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          const safe = publicConfig({ providers: [p] }).providers[0];
          return json(res, 200, { ok: true, provider: safe });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除整个提供商目录条目。不碰 api.baseUrl/apiKey（那是实际接入点）。
      if (pathname === '/api/providers' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const r = deleteProvider(String(body.providerId ?? ''));
          if (!r) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, {
            ok: true,
            removed: r.provider.id,
            removedModels: (r.provider.models || []).length,
            apiProviderCleared: r.apiProviderCleared
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const providerId = String(body.providerId ?? '');
        const apiKey = String(body.apiKey ?? '');
        // 前端回传的是掩码：说明用户没有改密钥，保持原值。
        if (isMaskedSecret(apiKey)) {
          const existing = currentProviders().find((p) => p.id === providerId);
          return json(res, 200, { ok: true, unchanged: true, hasKey: !!existing?.apiKey });
        }
        const updated = setProviderKey(providerId, apiKey);
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: visionResults(), scanning: visionScan.running, qwen: qwenVisionInfo(), deepseek: deepseekVisionInfo() });
      }

      if (pathname === '/api/vision/deepseek' && method === 'GET') {
        return json(res, 200, { ok: true, deepseek: deepseekVisionInfo() });
      }

      if (pathname === '/api/vision/route' && method === 'GET') {
        // 让控制台能看清「现在到底哪张图走哪家」，不用去读代码里的分支。
        return json(res, 200, {
          ok: true,
          route: getConfig().vision?.route || 'auto',
          sticker: visionRoute({ kind: 'sticker' }),
          message: visionRoute({ kind: 'message' })
        });
      }

      if (pathname === '/api/vision/deepseek/test' && method === 'POST') {
        try {
          const body = await readBody(req);
          const raw = body?.deepseek ?? body ?? null;
          const payload = raw && typeof raw === 'object' && Object.keys(raw).length ? structuredClone(raw) : null;
          if (payload && isMaskedSecret(payload.apiKey)) payload.apiKey = getConfig().vision?.deepseek?.apiKey || '';
          return json(res, 200, await testDeepseekVision(payload));
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/vision/qwen' && method === 'GET') {
        return json(res, 200, { ok: true, qwen: qwenVisionInfo() });
      }

      if (pathname === '/api/vision/qwen/test' && method === 'POST') {
        try {
          const body = await readBody(req);
          const raw = body?.qwen ?? body ?? null;
          // 空对象必须当成「没传」：qwenVisionConfig() 是 raw || 落盘配置 的替换语义，
          // 传 {} 会整份顶掉落盘配置 → 空 apiKey → 明明配好了却报「未配置 API Key」。
          // 控制台点「测试」时如果表单还是初始空态，走的就是这条路径。
          const payload = raw && typeof raw === 'object' && Object.keys(raw).length
            ? structuredClone(raw)
            : null;
          if (payload && isMaskedSecret(payload.apiKey)) {
            payload.apiKey = getConfig().vision?.qwen?.apiKey || '';
          }
          const result = await testQwenVision(payload);
          return json(res, 200, result);
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        return json(res, 200, publicConfig(cfgNow));
      }

      // ── 身份快照：换机器 / 重装的"复活卡" ──────────────────────────────
      // GET  ?recent=40（0 = 不带消息流）
      // POST ?dryRun=1 只校验不写入
      // ⚠️ 快照里没有任何密钥，但**全是明文**：人设、日记、群友发言原话。导出即敏感文件。
      if (pathname === '/api/identity/snapshot' && method === 'GET') {
        try {
          const q = new URL(req.url, 'http://localhost').searchParams;
          const recent = Number(q.get('recent') ?? 40);
          const snap = buildSnapshot({
            perChat: Number.isFinite(recent) ? recent : 40,
            includeRecent: String(q.get('recent') ?? '40') !== '0'
          });
          return json(res, 200, snap);
        } catch (error) {
          return json(res, 500, { error: `导出身份快照失败：${error?.message ?? error}` });
        }
      }

      if (pathname === '/api/identity/restore' && method === 'POST') {
        try {
          const q = new URL(req.url, 'http://localhost').searchParams;
          const payload = await readBody(req);
          const result = restoreSnapshot(payload, {
            includeRecent: q.get('recent') === '1',
            dryRun: q.get('dryRun') === '1' || q.get('dryRun') === 'true'
          });
          // 底层文件被改写，进程内的缓存必须失效，否则下一轮又把旧值写回去
          if (!result.dryRun) {
            try { memory.resetCache(); } catch { /* 没有实例就算了 */ }
            try { resetFactsCache(); } catch { /* 同上 */ }
          }
          return json(res, 200, result);
        } catch (error) {
          // 校验不通过是 400 不是 500：这是"快照不合格"，不是服务坏了
          return json(res, 400, {
            error: String(error?.message ?? error),
            problems: Array.isArray(error?.problems) ? error.problems : []
          });
        }
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = stripMaskedSecrets(await readBody(req));
        // ── 切换服务商时把密钥与端点一起搬过去 ────────────────────────────
        // 以前这里只做 deepMerge：provider 换了，api.apiKey 却还是上一家的。
        // 界面上「已配置」不是假的（目录里确实有 key），但请求会拿旧密钥打新服务商，
        // 表现就是「选完模型测连通性/聊天必然 401」。反过来，用户手填的新密钥
        // 也从来没回写目录，下次在模型选择器里切一次就"看起来又被改回去了"。
        if (patch?.api && typeof patch.api === 'object') {
          const prevProvider = String(getConfig().api?.provider ?? '').trim();
          const nextProviderId = String(patch.api.provider ?? prevProvider).trim();
          const providerChanged = !!nextProviderId && nextProviderId !== prevProvider;
          const target = (getConfig().providers || []).find((p) => p.id === nextProviderId);
          const patchKey = String(patch.api.apiKey ?? '').trim();

          if (providerChanged) {
            // 端点一律跟目录走：只换 provider 不换 baseUrl，等于"拿新密钥打旧域名"——
            // 正是这次换成硅基流动后一直 401、静默降级到小模型的根因。前端切下拉时
            // 虽然会填一次 baseUrl，但改过端点的旧目录值/手填残留都可能带过来，这里兜死。
            if (target?.baseURL) patch.api.baseUrl = target.baseURL;
            // 密钥：这次手填了就算这家的新密钥（下面回写目录）；没填就用目录里这家的。
            // 目录里也没有 → 显式留空，绝不把上一家的密钥发给新服务商。
            if (!patchKey) patch.api.apiKey = target?.apiKey || '';
          }
          // 注意：同家改端点/密钥时【不】回写目录。
          // 试过回写，结果控制台带着上一家的残留 baseUrl 保存一次，就把目录里那家的
          // 端点改脏了（DeepSeek 官方的地址被写成了硅基的），切回去继续 401。
          // 目录是"每家该长什么样"的唯一定义，只允许用户显式编辑（/api/providers）。
          // 新密钥回写目录：两处不一致时，重新选模型会把旧密钥带回来
          if (patchKey && nextProviderId) {
            try {
              setProviderKey(nextProviderId, patchKey);
            } catch {
              /* 目录同步失败不影响配置本身 */
            }
          }
        }
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 2000);
        store.setArchiveEnabled(next.store?.archiveHistory !== false);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: publicConfig(next) });
      }

      // 手机访问开关：只允许在**运行 QQagent 的那台电脑**上操作。
      // 远程能改监听地址和令牌 = 远程能给自己开门，这条必须卡死在本机。
      if (pathname === '/api/mobile/enable' && method === 'POST') {
        if (!isLocalRequest(req)) return json(res, 403, { error: '只能在运行 QQagent 的那台电脑上开关手机访问' });

        const body = await readBody(req).catch(() => ({}));
        const actualPort = (() => {
          const addr = server.address();
          return addr && typeof addr === 'object' ? addr.port : Number(getConfig().server?.port) || 3210;
        })();

        if (body.enable === false) {
          // 关掉时连令牌一起清掉：否则本机控制台会突然开始要登录，用户只会觉得坏了
          const next = updateConfig({ server: { bindHost: '127.0.0.1', token: '' } });
          return json(res, 200, { ok: true, enabled: false, bindHost: next.server.bindHost, needRestart: true });
        }

        let token = String(body.token || '').trim();
        if (!token) token = crypto.randomBytes(18).toString('base64url');
        if (token.length < 12) return json(res, 400, { error: '令牌至少 12 位，太短等于没有' });
        const next = updateConfig({ server: { bindHost: '0.0.0.0', token } });
        const addrs = describeAddresses();
        return json(res, 200, {
          ok: true,
          enabled: true,
          token,
          bindHost: next.server.bindHost,
          needRestart: true,
          // 私网在前：手机同一 WiFi 必然能连的是这一类
          addresses: [...addrs.private, ...addrs.public].map((ip) => `http://${ip}:${actualPort}/m/`),
          privateAddresses: addrs.private.map((ip) => `http://${ip}:${actualPort}/m/`),
          publicAddresses: addrs.public.map((ip) => `http://${ip}:${actualPort}/m/`)
        });
      }

      // 手机扫码进控制台的二维码（只在 setup 流程里用，仅本机可取）
      if (pathname === '/api/mobile/qr' && method === 'GET') {
        if (!isLocalRequest(req)) return json(res, 403, { error: '只能在本机生成' });
        const text = String(url.searchParams.get('url') || '').trim();
        // 只允许本机自己的**内网**地址：一是避免这个接口被当成任意内容的二维码生成器，
        // 二是不给"扫一下就走公网 IP"留口子（家用路由器多数不支持 NAT 回环，扫了也连不上）。
        const okHost = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(text) ||
          describeAddresses().private.some((ip) => text.includes(`//${ip}:`) || text.includes(`//${ip}/`));
        if (!text || !okHost) return json(res, 400, { error: '地址不在本机网卡列表里' });
        try {
          const mod = await import('qrcode');
          const QRCode = mod.default ?? mod;
          const svg = await QRCode.toString(text, {
            type: 'svg',
            margin: 1,
            width: 224,
            color: { dark: '#0F172A', light: '#FFFFFF' }
          });
          res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
          res.end(svg);
        } catch (error) {
          return json(res, 500, { error: '生成二维码失败：' + String(error?.message ?? error) });
        }
        return;
      }

      // 手机轻量版专用写入口：只接受 MOBILE_CONFIG_GROUPS 里的字段。
      // 手机丢了 / cookie 泄露时，攻击面被限制在"改改模型和人设"，碰不到令牌与白名单。
      if (pathname === '/api/mobile/config' && method === 'POST') {
        const raw = await readBody(req).catch(() => ({}));
        const { picked, ignored } = pickMobileConfig(raw);
        if (!Object.keys(picked).length) {
          return json(res, 400, { error: '没有可应用的字段', ignored });
        }
        const next = updateConfig(stripMaskedSecrets(picked));
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, ignored, config: publicConfig(next) });
      }

      if (pathname === '/api/presets' && method === 'GET') {
        const cur = getConfig().api?.preset || '';
        return json(res, 200, { presets: presetList(), current: cur });
      }

      if (pathname === '/api/presets/apply' && method === 'POST') {
        const body = await readBody(req);
        const preset = getPreset(String(body?.id || ''));
        if (!preset) return json(res, 404, { error: `未知预设：${body?.id}` });
        const patch = presetPatch(preset, getConfig().api);
        const next = updateConfig({ api: patch });
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 2000);
        store.setArchiveEnabled(next.store?.archiveHistory !== false);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, preset: preset.id, config: publicConfig(next) });
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        return json(res, 200, { chats });
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read,
          atSelf: m.atSelf === true, atOthers: m.atOthers || [], reply: m.reply
        }));
        return json(res, 200, { chatKey, messages });
      }

      // 联网搜索的 key 状态与设置（key 本身**绝不回传**，只回遮影形态）
      if (pathname === '/api/search-keys' && method === 'GET') {
        try {
          const cfg = getConfig();
          const arr = Array.isArray(cfg.webSearch?.anysearchKeys) ? cfg.webSearch.anysearchKeys : [];
          const envCount = [process.env.ANYSEARCH_API_KEY, process.env.ANYSEARCH_API_KEY_2].filter(Boolean).length;
          return json(res, 200, {
            provider: String(cfg.webSearch?.provider || 'auto'),
            envCount,
            configKeys: arr.map((k) => {
              const s = String(k || '');
              return s ? (s.slice(0, 6) + '****' + s.slice(-4)) : '';
            }),
            configKeyCount: arr.filter((x) => String(x || '').trim()).length,
            total: envCount + arr.filter((x) => String(x || '').trim()).length
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
      // 保存 key：只接受新填入的值（不回显旧的）；传空字符串表示删除该位
      if (pathname === '/api/search-keys' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          if (!Array.isArray(body.keys)) return json(res, 400, { ok: false, error: 'keys 必须是数组' });
          const rawKeys = body.keys.map((k) => String(k ?? '').trim());
          // 判定用户意图：
          //   · 全部为空且显式传了 allowClear → 清空
          //   · 全部为空但没授权清空  → 保留原值（防误点保存把 key 清掉）
          //   · 有新值                → 用新值替换（遮影值 **** 不参与）
          const newOnes = rawKeys.filter((k) => k && !k.includes('****'));
          const hadMasked = rawKeys.some((k) => k.includes('****'));
          const prev = Array.isArray(getConfig().webSearch?.anysearchKeys) ? getConfig().webSearch.anysearchKeys : [];
          let next;
          if (newOnes.length) {
            // 有新填的：替换（若同时含遮影项，说明用户想保留其余，这里简单起见以新值为准）
            next = newOnes;
          } else if (hadMasked) {
            // 只有遮影项 = 用户没改，保持原样
            next = prev;
          } else if (body.allowClear === true) {
            next = [];
          } else {
            next = prev;   // 空提交且未授权清空 → 不动
          }
          updateConfig({ webSearch: { ...(getConfig().webSearch || {}), anysearchKeys: next } });
          return json(res, 200, { ok: true, saved: next.length, unchanged: next === prev });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
      // 能力总览：工具清单 + 关键功能状态（供设置页展示）
      if (pathname === '/api/capabilities' && method === 'GET') {
        try {
          const { buildToolDefs } = await import('./tools.js');
          const defs = buildToolDefs();
          const GROUP_RULES = [
            ['消息与互动', /^(send_message|send_sticker|send_image|send_file|send_poke|receive_file|list_stickers|get_sticker_image|sticker_note|collect_sticker)$/],
            ['信息获取', /^(get_recent_messages|get_active_members|get_message_detail|get_message_images|web_search|web_fetch)$/],
            ['记忆', /^(memory_append|memory_query|memory_remove)$/],
            ['主人专属', /^(dsh_task)$/],
            ['其它', /.*/]
          ];
          const tools = defs.filter((d) => d && d.name).map((d) => {
            let group = '其它';
            for (const [g, re] of GROUP_RULES) { if (re.test(d.name)) { group = g; break; } }
            return {
              name: d.name,
              group,
              description: String(d.description || '').slice(0, 200),
              masterOnly: !!d.masterOnly,
              params: Object.keys(d.parameters?.properties || {})
            };
          });
          const cfg = getConfig();
          // 定时任务摘要
          let scheduled = { count: 0, items: [] };
          try {
            const ST = await import('./scheduled-tasks.js');
            const list = ST.listTasks().filter((t) => t.enabled);
            scheduled = { count: list.length, items: list.slice(0, 8).map((t) => ST.describeTask(t)) };
          } catch (e) { scheduled = { count: 0, items: [], error: String(e?.message || e) }; }
          // 搜索引擎状态
          const hasAnyKey = !!(process.env.ANYSEARCH_API_KEY || process.env.ANYSEARCH_API_KEY_2);
          const searchProvider = String(cfg.webSearch?.provider || 'auto');
          return json(res, 200, {
            tools,
            total: tools.length,
            features: {
              identityModes: Object.entries(cfg.identityModes || {}).map(([k, v]) => ({ id: k, label: v?.label || k, enter: v?.enter || [], exit: v?.exit || [] })),
              personaModes: cfg.personaModes || {},
              customPersonas: (cfg.customPersonas || []).map((p) => p.name),
              search: {
                enabled: cfg.webSearch?.enabled !== false,
                provider: searchProvider,
                anysearchAvailable: hasAnyKey,
                effective: searchProvider === 'bing'
                  ? 'Bing 网页抓取'
                  : (searchProvider === 'anysearch'
                    ? (hasAnyKey ? 'AnySearch' : 'AnySearch（未配置 key，会失败）')
                    : (hasAnyKey ? 'AnySearch（失败自动回退 Bing）' : 'Bing（未配置 AnySearch key）'))
              },
              scheduled
            }
          });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // 补报 DSH 任务：任务已完成但没汇报时（或通知链路故障后），让机器人现在汇报一次
      if (pathname === '/api/dsh/report' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const workDir = String(body.workDir ?? '').trim();
          const chatKey = String(body.chatKey ?? 'private:123456789').trim();
          if (!workDir) return json(res, 400, { ok: false, error: 'workDir 必填' });
          const fsmod = await import('node:fs');
          const pathmod = await import('node:path');
          if (!fsmod.existsSync(workDir)) return json(res, 404, { ok: false, error: '目录不存在' });
          const items = fsmod.readdirSync(workDir, { withFileTypes: true });
          const files = [];
          for (const it of items) {
            const p = pathmod.join(workDir, it.name);
            if (it.isDirectory()) {
              let n = 0; try { n = fsmod.readdirSync(p).length; } catch {}
              files.push({ name: it.name + '/', size: 0, dir: true, entries: n });
            } else {
              let sz = 0; try { sz = fsmod.statSync(p).size; } catch {}
              files.push({ name: it.name, size: sz, dir: false });
            }
          }
          const real = files.filter((f) => (f.dir ? (f.entries || 0) > 0 : (f.size || 0) > 0));
          let reportFile = '', reportText = '';
          const cand = real.find((f) => !f.dir && /回给主人|汇报|report|summary/i.test(f.name) && /\.(txt|md)$/i.test(f.name));
          if (cand) {
            reportFile = cand.name;
            try { reportText = fsmod.readFileSync(pathmod.join(workDir, cand.name), 'utf8').slice(0, 2500); } catch {}
          }
          orchestrator.wake(chatKey, {
            proactive: true,
            taskContext: {
              kind: 'DSH 后台任务（补报）',
              name: pathmod.basename(workDir),
              taskText: String(body.taskText || '').slice(0, 400),
              workDir, files: real, empty: !real.length,
              reportFile, reportText
            }
          }).catch(() => {});
          return json(res, 200, { ok: true, fileCount: real.length, reportFile });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      // 重启：先把响应刷出去（面板要能读到"已受理"），再停服并交给宿主拉起新进程
      if (pathname === '/api/restart' && method === 'POST') {
        if (restarting) return json(res, 200, { ok: true, alreadyRestarting: true });
        const body = await readBody(req).catch(() => ({}));
        const reason = String(body?.reason || '面板按钮').slice(0, 60);
        json(res, 200, { ok: true, restarting: true, startedAt });
        setTimeout(() => {
          restart({ reason }).catch((error) => log('[重启] 失败：', error?.message ?? error));
        }, 250);
        return;
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 静态 UI：新版 React 控制台 /console/；旧版 /legacy/；手机轻量版 /m/
    if (req.method === 'GET') {
      const consoleIndex = path.join(CONSOLE_DIR, 'index.html');
      const hasConsole = fs.existsSync(consoleIndex);
      const redirect = (location) => {
        res.writeHead(302, { location, 'cache-control': 'no-store' });
        res.end();
      };

      if (pathname === '/') return redirect(hasConsole ? '/console/' : '/legacy/');
      if (pathname === '/console') return redirect('/console/');
      if (pathname === '/legacy') return redirect('/legacy/');
      // 手机端短地址：/m 直接进轻量版，省得在手机上敲 /console/
      if (pathname === '/m') return redirect('/m/');

      let baseDir = UI_DIR;
      let file = pathname;
      if (pathname.startsWith('/console/')) {
        // 构建产物缺失时回退旧版，避免 Electron 白屏。
        if (!hasConsole) return redirect('/legacy/');
        baseDir = CONSOLE_DIR;
        file = pathname.slice('/console'.length);
      } else if (pathname.startsWith('/legacy/')) {
        baseDir = UI_DIR;
        file = pathname.slice('/legacy'.length);
      } else if (pathname.startsWith('/m/')) {
        // 零构建，目录不在就走旧版，别让人对着一片 404 猜
        if (!fs.existsSync(path.join(MOBILE_DIR, 'index.html'))) return redirect('/legacy/');
        baseDir = MOBILE_DIR;
        file = pathname.slice('/m'.length);
      }

      if (!file || file === '/') file = '/index.html';
      file = file.replace(/\.\./g, '');
      const fullPath = path.resolve(baseDir, `.${file}`);
      if (fullPath !== baseDir && !fullPath.startsWith(baseDir + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }

      try {
        let data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
          '.json': 'application/json; charset=utf-8',
          '.webmanifest': 'application/manifest+json; charset=utf-8',
          '.map': 'application/json; charset=utf-8'
        };

        // 旧版 index.html 的 app.js / style.css 版本号注入；新版由 Vite 内容哈希管理。
        if (ext === '.html' && baseDir === UI_DIR) {
          const stamp = (f) => { try { return Math.floor(fs.statSync(path.join(UI_DIR, f)).mtimeMs).toString(36); } catch { return '0'; } };
          data = Buffer.from(
            data.toString('utf8')
              .replace('href="/style.css"', 'href="./style.css?v=' + stamp('/style.css') + '"')
              .replace('src="/app.js"', 'src="./app.js?v=' + stamp('/app.js') + '"'),
            'utf8'
          );
        }

        const headers = {
          'content-type': types[ext] ?? 'application/octet-stream',
          'cache-control': 'no-cache'
        };
        // 本机打开页面时自动带上凭证。
        // 原因：Electron 壳、系统浏览器、无痕窗口各有独立的 cookie 仓库 ——
        // 配好令牌后 Electron 里打开 /console/ 会整套 401、界面空白，用户根本看不出原因。
        // 本机 = 这台电脑的主人（他本来就能直接读 data/config.json），给他发凭证不降级安全性；
        // 手机走的是局域网 IP，不是回环地址，拿不到这个自动凭证，仍必须登录。
        if (ext === '.html' && isLocalRequest(req) && consoleToken()) {
          headers['set-cookie'] = authCookieHeader(consoleToken(), 30 * 24 * 3600);
        }
        res.writeHead(200, headers);
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先扫一次陈年临时文件（data/tmp 与原子写残留）。
    // 放在最前面：清完再拉服务，免得清理的 I/O 拖慢首屏。
    try {
      tmpSwept = sweepStaleTmp();
      if (tmpSwept.removed) {
        console.log(`[qq] 启动清理：删掉 ${tmpSwept.removed} 个过期临时文件（${Math.round(tmpSwept.freed / 1024)}KB）`);
      }
    } catch { /* 清理失败绝不能挡住启动 */ }

    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    const bindHost = auditBindHost();
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p, bindHost);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 音频设备枚举预热：一次 PowerShell 要 3.5~4.1 秒。这里尽早（端口刚起来、
    // 窗口还在加载 loading 壳的时候）就在后台跑一遍把缓存填上，用户打开通话面板
    // 时就不会撞上这四秒。不 await —— 启动流程不该为一个下拉框多等四秒。
    if (process.platform === 'win32') {
      audioDevicesCached().catch((error) => log(`[通话] 预查音频设备失败：${error?.message ?? error}`));
    }

    // 补/修 NapCat 的 OneBot 端口配置（换号登录不再"登录了却永远离线"）
    repairOnebotConfigs('启动时');
    if (!globalThis.__onebotCfgTimer) {
      globalThis.__onebotCfgTimer = setInterval(() => repairOnebotConfigs('定期检查'), 300000);
      if (globalThis.__onebotCfgTimer.unref) globalThis.__onebotCfgTimer.unref();
    }

    // 启动账号健康探针（60 秒一次）
    onebotHealth.start();
    qrGuard.start();
    // RVC 音色服务（可选）：提前把模型加载好，第一句语音就不用干等
    ensureRvcService({ log })
      .then((r) => {
        if (r && r.ok) log('RVC 音色服务就绪：' + (r.health?.model || '') + ' @ ' + (r.health?.device || ''));
        else if (r && r.reason) log('RVC 音色服务未启动：' + r.reason);
      })
      .catch(() => {});

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        } else {
          // 已经在跑（手工启动的也算）：直接跟随它的日志，面板不用等重启也有内容
          enableNapcatFileLog(snowlumaDir());
          startSnowlumaLogTail();
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      onebot.accessToken = String(c.snowluma?.accessToken || '');
      onebot.httpToken = String(c.snowluma?.httpAccessToken || c.snowluma?.accessToken || '');
    }
    await onebot.connect();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startDshWatcher(); // DSH 任务完成汇报 watcher
    orchestrator.startDiaryLoop(); // 每天早上给"昨天"写日记（diary.js）
    orchestrator.startReflectionLoop(); // 定期把没处理过的消息按人消化成长期记忆（reflection.js）
    scheduledRunner.start();   // 通用定时任务调度器
    // 语音通话网关：这里才挂（不在 createApp 里挂）——
    // 测试会建 app 但不 start，若在构造期就挂 upgrade 钩子，
    // 每个测试进程都会多一个常驻监听者，还可能把端口占住。
    ensureVoiceGateway();
    // QQ 通话看门狗同样在 start 里起：它是个常驻定时器，构造期起会拖住测试进程。
    ensureCallWatcher();
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    if (bindHost !== '127.0.0.1' && bindHost !== 'localhost') {
      // 手机要用这个地址，光有 127.0.0.1 没用，直接把网卡地址打出来省得去查 ipconfig
      const lan = describeAddresses();
      log(`手机轻量版：/m/  监听 ${bindHost}:${port}${lan.private.length ? '  可试 ' + lan.private.map((ip) => `http://${ip}:${port}/m/`).join(' 或 ') : ''}`);
      if (lan.public.length) {
        // 拨号网卡上的公网 IP 意味着 0.0.0.0 对全网可达，不是"只有家里人能连"
        log(`注意：本机网卡上有公网地址 ${lan.public.join(', ')}，如果路由器/防火墙放行了 ${port}，控制台会从公网可达。别用这个地址，走内网或 Tailscale。`);
      }
      log(`远程访问需要 server.token，当前${consoleToken() ? '已设置' : '未设置（将拒绝外部访问）'}`);
    }
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    onebotHealth.stop();
    qrGuard.stop();
    stopRvcService();
    // 通话网关先关：它有 ws 长连接，不主动断的话 server.close() 会一直等，
    // 端口释放不掉，重启时新进程撞 EADDRINUSE。
    try { voiceGateway?.close(); } catch { /* 退出时不必纠结 */ }
    voiceGateway = null;
    // 看门狗是 setInterval，不停掉的话进程退不干净
    try { callWatcher?.stop(); } catch { /* 同上 */ }
    callWatcher = null;
    try { orchestrator.stopDiaryLoop(); } catch { /* 退出时不必纠结 */ }
    try { orchestrator.stopReflectionLoop(); } catch { /* 同上 */ }
    await orchestrator.abortAll();
    onebot.close();
    // SSE 是长连接：不主动断，server.close() 会一直等它，端口就释放不掉（重启时新进程会撞 EADDRINUSE）
    for (const res of sseClients) {
      try { res.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
      // 先 close 再断已有连接：SSE/keep-alive 不断，端口会一直被占着
      try { server.closeAllConnections?.(); } catch { /* 老版本 Node 没有这个方法 */ }
      const timer = setTimeout(resolve, 1500);
      if (timer.unref) timer.unref();
    });
    stopSnowlumaLogTail();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
  }

  /**
   * 重启：停服务 → 关 NapCat 进程树 → 交给宿主重新拉起。
   * 宿主（Electron 主进程）通过 createApp({ restartHook }) 或 setRestartHook() 注入；
   * 没有宿主时（node src/server.js）就自己 spawn 一个新进程，再退出自己。
   */
  async function restart({ reason = '面板按钮' } = {}) {
    if (restarting) return { ok: false, error: '重启已在进行中' };
    restarting = true;
    log(`[重启] ${reason}：正在停止服务…`);
    // NapCat 是注入进 QQ.exe 的，只 kill 直接子进程会留下占着 3001 的孤儿
    try { stopSnowluma(); } catch (error) { log('[重启] 关闭 SnowLuma 失败：', error?.message ?? error); }
    try { await stop(); } catch (error) { log('[重启] 停止服务失败：', error?.message ?? error); }
    // 留一点时间让端口和 NapCat 进程真正释放，新的进程才抢得到 3001
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (onRestart) {
      try {
        onRestart({ reason });
        return { ok: true, relaunched: 'host' };
      } catch (error) {
        log('[重启] 宿主重启失败，改为自拉起：', error?.message ?? error);
      }
    }
    return relaunchSelf();
  }

  function setRestartHook(fn) {
    onRestart = typeof fn === 'function' ? fn : null;
    return !!onRestart;
  }

  /** 没有宿主时自己拉一个新进程接管，再退出当前进程。 */
  function relaunchSelf() {
    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: ROOT,
        env: process.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      log(`[重启] 已拉起新进程 pid=${child.pid}，当前进程退出`);
    } catch (error) {
      log('[重启] 自拉起失败（请手动重新启动）：', error?.message ?? error);
    }
    setTimeout(() => process.exit(0), 300);
    return { ok: true, relaunched: 'self' };
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, restart, setRestartHook, startedAt, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus, onebotHealth, qrGuard };
}
