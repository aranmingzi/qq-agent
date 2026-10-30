// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  moods: {},
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  // 「当前正在编辑的是哪一条模板」。以前只靠 roleText 文本反查：改一个字就匹配不上，
  // 删除按钮消失、下拉回显为空，用户以为模板丢了，于是重新"添加人设" → 多出一条副本。
  personaAppliedId: '',
  // 覆盖人设前的临时备份（仅本页面会话内有效，刷新即失效）
  personaBackup: null,
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'capabilities',
  rvc: null
};

// ── 工具函数 ──
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

// 时间一律按**北京时间**渲染：进程已锁 TZ=Asia/Shanghai（见 src/server.js 首行），
// 所以这里的 getHours()/getMonth() 取到的就是北京时间，不是服务器 UTC。
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = { done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  const modelOk = !!(cfg.api.model && cfg.api.baseUrl);
  checks.push({ ok: modelOk, label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（必填）', fix: modelOk ? null : 'settings-api' });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  const acct2 = status?.onebot?.account || {};
  const acctOffline2 = acct2.online === false;
  // 分两条报：WS 连接 / 账号在线。只报前者会把"账号掉线"判成健康（2026-09-14 事故）
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot（SnowLuma）未连接 —— 请到 SnowLuma 页签启动', fix: obOk ? null : 'snowluma-tab' });
  if (obOk) {
    const mins2 = acct2.offlineMs ? Math.round(acct2.offlineMs / 60000) : 0;
    checks.push({
      ok: !acctOffline2,
      label: acctOffline2
        ? `⚠ QQ 账号已离线${mins2 ? `（${mins2} 分钟）` : ''} —— 机器人收不到消息，请重新登录`
        : (acct2.online === true ? 'QQ 账号在线' : 'QQ 账号状态未探测（稍候自动重试）'),
      fix: acctOffline2 ? 'snowluma-tab' : null
    });
  }
  return { ready: modelOk && allowOk && obOk && !acctOffline2, checks };
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  if (state.paused && state.pauseReason === 'budget') {
    show = true;
    const cap = state.config?.budget?.dailyCostYuan || 0;
    const cost = state.status?.usage?.cost ?? 0;
    html = `💰 已触发今日预算上限（¥${cost.toFixed(2)} / ¥${cap}），机器人自动暂停。可先 <a href="#" id="banner-goto-settings">设置 → 预算保险丝</a> 调整上限，然后选择"恢复"（补处理积压消息）或"恢复并全部标为已读"（丢弃积压）。`;
  } else if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请确认 SnowLuma 已启动，且设置里的 WS/HTTP 地址正确。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'settings') loadSettings();
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    // ⚠️ 关键：WS 连着 ≠ 账号可用。NapCat 的 WS 在账号离线时依然在监听，
    // 只看 connected 会让"掉线"显示成"已连接"（2026-09-14 事故）。
    const acct = s.onebot.account || {};
    const acctOffline = acct.online === false;
    const acctUnknown = acct.online === null || acct.online === undefined;
    if (acctOffline) {
      dot.className = 'dot dot-off';
      const mins = acct.offlineMs ? Math.round(acct.offlineMs / 60000) : 0;
      label.textContent = `⚠ QQ 账号已离线${mins ? `（${mins} 分钟）` : ''} —— 机器人收不到消息，请检查登录`;
    } else if (s.onebot.connected) {
      dot.className = 'dot ' + (acctUnknown ? 'dot-wait' : 'dot-on');
      label.textContent = `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
        + (acctUnknown ? ' · 账号状态未探测' : '');
    } else {
      dot.className = 'dot ' + (s.onebot.everConnected ? 'dot-wait' : 'dot-off');
      label.textContent = 'OneBot 未连接';
    }
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}${s.orchestrator.complexModel ? ` / 复杂：${s.orchestrator.complexModel}` : ''}`;
    const u = s.usage;
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${u.cost ? ` · ¥${u.cost.toFixed(2)}` : ''}`;
    // 显式展示时区（记忆系统 01 第六节：页面时间必须让用户看到北京时间）
    const tzEl = document.getElementById('tz-label');
    if (tzEl) {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const off = -d.getTimezoneOffset() / 60;
      tzEl.textContent = `北京时间 ${p2(d.getHours())}:${p2(d.getMinutes())}（UTC${off >= 0 ? '+' : ''}${off}）`;
    }
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 重启 ──
// 服务是自己关掉再拉起的，所以中途 fetch 失败是正常现象：
// 判据只有一个 —— /api/status 的 startedAt 换成了别的值（新进程）。
function showRestartOverlay(text) {
  let el = $('#restart-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'restart-overlay';
    el.className = 'loading-overlay';
    el.innerHTML = '<div class="loading-card">'
      + '<div class="loading-title">QQ Agent 正在重启</div>'
      + '<div class="loading-sub" id="restart-status"></div>'
      + '<div class="loading-spinner"></div>'
      + '</div>';
    document.body.appendChild(el);
  }
  if (text) {
    const sub = $('#restart-status');
    if (sub) sub.textContent = text;
  }
  return el;
}

async function waitRestarted(prevStartedAt) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) continue;
      const s = await res.json();
      // 旧进程的 startedAt 一定不等于新进程的；拿到别的值就是真的重启了
      if (Number(s.startedAt) && Number(s.startedAt) !== Number(prevStartedAt)) return true;
    } catch { /* 服务还没起来：继续等 */ }
  }
  return false;
}

$('#restart-btn')?.addEventListener('click', async (event) => {
  const btn = event.currentTarget;
  if (btn.disabled) return;
  if (!confirm('重启会中断正在处理的消息，并重新启动 SnowLuma 和 OneBot。\n确定现在重启？')) return;

  let prevStartedAt = Number(state.status?.startedAt) || 0;
  if (!prevStartedAt) {
    try { prevStartedAt = Number((await api('/api/status')).startedAt) || 0; } catch { /* ignore */ }
  }

  btn.disabled = true;
  showRestartOverlay('正在停止服务…');
  let accepted = true;
  try {
    await api('/api/restart', { method: 'POST', body: JSON.stringify({ reason: '面板按钮' }) });
  } catch (error) {
    // 老进程还没有这个接口：别傻等 2 分钟，直接告诉用户先手动重启一次
    if (Number(error?.status) === 404) {
      accepted = false;
      showRestartOverlay('当前进程还是旧版本，没有重启接口。请先手动关闭 QQ Agent 再打开一次，之后这个按钮就能用了。');
      btn.disabled = false;
      return;
    }
    /* 其他错误：多半是响应还没读完连接就被关了，属于正常流程 */
  }
  if (!accepted) return;
  showRestartOverlay('正在重新启动 SnowLuma 与 OneBot，请稍候…');

  if (await waitRestarted(prevStartedAt)) {
    showRestartOverlay('已重启，正在刷新页面…');
    setTimeout(() => location.reload(), 250);
    return;
  }
  btn.disabled = false;
  showRestartOverlay('等待超时：2 分钟内服务没有回来。请检查桌面端窗口，或手动重新启动 QQ Agent。');
});

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => { loadSessions(); refreshStatus(); });
  es.addEventListener('session-update', (ev) => {
    const id = JSON.parse(ev.data).sessionId;
    if (id === state.currentSessionId) loadSessionDetail(id, { quiet: true });
    const item = state.sessions.find((s) => s.id === id);
    if (item && item.status !== 'done' && item.status !== 'noreply') loadSessions({ quiet: true });
  });
  es.addEventListener('session-end', () => {
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });  es.addEventListener('onebot-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('status', () => refreshStatus());
  // 账号健康事件：掉线/恢复时立即刷新界面，不必等 15 秒轮询
  es.addEventListener('onebot-health', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-log', (ev) => {
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    const data = await api('/api/sessions?limit=80');
    state.sessions = data.sessions || [];
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const running = state.sessions.find((s) => s.status === 'running');
      if (running) selectSession(running.id);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
setInterval(() => {
  if (state.tab === 'sessions') loadSessions({ quiet: true });
  if (state.tab === 'chats') loadChats({ quiet: true });
  if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
  if (state.tab === 'settings') refreshStatus();
}, 4000);

function renderSessionList() {
  const box = $('#session-items');
  box.innerHTML = state.sessions.map((s) => {
    const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
    return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''}" data-id="${s.id}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          <span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span>
          <span>${s.rounds || 0} 轮</span>
        </div>
      </div>`;
  }).join('');
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    try {
      const mood = await api(`/api/moods?chatKey=${encodeURIComponent(s.chatKey || '')}`);
      s.mood = mood.mood || null;
    } catch { s.mood = null; }
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

// ── 复制支持 ─────────────────────────────────────────────────────────
// 右键/快捷键由 Electron 主进程提供（electron/main.js）；这里给关键区块加"复制"按钮。
// 注意：内容可能很长且含引号，所以按钮只带一个 key，原文放在 copyRegistry 里，
// 由点击时查表写入剪贴板（避免把大段文本塞进 HTML 属性）。
const copyRegistry = new Map();

function registerCopy(text) {
  const key = 'cp' + copyRegistry.size;
  copyRegistry.set(key, String(text ?? ''));
  return key;
}

function copyButton(key, label = '复制', cls = 'btn-copy') {
  return `<button class="${cls}" data-copy="${key}" type="button">${label}</button>`;
}

async function writeClipboard(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* 非安全上下文/无权限 → 退回 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function flashButton(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1000);
}

/** 整个会话导出成纯文本（系统提示 + 输入 + 工具 + 思考 + 已发送）。 */
function sessionToText(s) {
  const out = [`# 会话 ${s.id}｜${s.chatKey}｜${s.status}`];
  if (s.startedAt) out.push('开始：' + new Date(s.startedAt).toLocaleString('zh-CN'));
  if (s.model) out.push('模型：' + s.model);
  if (s.triggerSummary) out.push('触发：' + s.triggerSummary);
  if (s.systemPrompt) out.push('\n===== 系统提示 =====\n' + s.systemPrompt);
  if (s.userPrompt) out.push('\n===== 本次输入 =====\n' + s.userPrompt);
  for (const item of s.messages || []) {
    if (item.toolCall) {
      out.push(`\n[工具 ${item.toolCall.name}${item.toolCall.isError ? ' 失败' : ''}]\n参数：${JSON.stringify(item.toolCall.args)}\n结果：${item.toolCall.result}`);
    } else if (item.role === 'assistant' && typeof item.content === 'string' && item.content.trim()) {
      out.push('\n[思考（不发送）]\n' + item.content);
    }
  }
  for (const sent of s.sent || []) out.push(`\n[已发送到 QQ${sent.at ? ' ' + sent.at : ''}]\n${sent.text}`);
  if (s.error) out.push('\n[错误] ' + s.error);
  if (s.finishReason) out.push('\n[finish] ' + s.finishReason);
  return out.join('\n');
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.mood?.label || ''}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = s.chatKey.replace('group:', '群 ').replace('private:', '私聊 ');
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};
  copyRegistry.clear();

  const html = [];
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}${s.mood ? ` <span class="mood-badge">${esc(s.mood.label)}</span>` : ''}</h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        ${s.systemPrompt ? copyButton(registerCopy(s.systemPrompt), '复制系统提示', 'btn btn-small') : ''}
        ${s.userPrompt ? copyButton(registerCopy(s.userPrompt), '复制本次输入', 'btn btn-small') : ''}
        ${copyButton(registerCopy(sessionToText(s)), '复制全部会话', 'btn btn-small')}
        ${s.mood ? `<button class="btn btn-small" id="session-mood-reset-btn">重置情绪</button>` : ''}
      </div>
    </div>`);

  if (s.systemPrompt) {
    html.push(`
      <details class="collapsible">
        <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
        <div class="coll-body">${esc(s.systemPrompt)}</div>
      </details>`);
  }
  if (s.userPrompt) {
    html.push(`
      <details class="collapsible" open>
        <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
        <div class="coll-body">${esc(s.userPrompt)}</div>
      </details>`);
  }

  html.push('<div class="msg-flow">');
  for (const item of s.messages || []) {
    if (item.toolCall) {
      html.push(`
        <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
          <div class="tool-head">
            <span class="tool-name">${esc(item.toolCall.name)}</span>
            ${copyButton(registerCopy(`[${item.toolCall.name}]\n${JSON.stringify(item.toolCall.args, null, 1)}\n\n${item.toolCall.result || ''}`))}
          </div>
          <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
          <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
        </div>`);
    } else if (item.toolImages) {
      html.push(`
        <div class="tool-card">
          <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
          <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
        </div>`);
    } else if (item.role === 'assistant') {
      const text = typeof item.content === 'string' ? item.content : '';
      if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
      html.push(`
        <div class="bubble bubble-assistant">
          <div class="asr-label">思考（不发送）${copyButton(registerCopy(text || '（无文本输出，仅调用工具）'))}</div>
          ${esc(text || '（无文本输出，仅调用工具）')}
        </div>`);
    }
  }
  // 发出的消息
  for (const sent of s.sent || []) {
    html.push(`
      <div class="sent-badge">
        <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}${copyButton(registerCopy(sent.text))}</div>
        ${esc(sent.text)}
      </div>`);
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ok = await writeClipboard(copyRegistry.get(btn.dataset.copy));
      flashButton(btn, ok ? '已复制' : '复制失败');
    });
  });
  const moodResetBtn = $('#session-mood-reset-btn', detail);
  if (moodResetBtn) {
    moodResetBtn.addEventListener('click', async () => {
      await api('/api/moods/reset', {
        method: 'POST',
        body: JSON.stringify({ chatKey: s.chatKey })
      });
      lastDetailFp = null;
      loadSessionDetail(s.id);
    });
  }
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  if (s.status === 'running') {
    // 运行中轮询（仅当前打开的会话详情）
    setTimeout(() => { if (state.currentSessionId === s.id && state.tab === 'sessions') loadSessionDetail(s.id, { quiet: true }); }, 1500);
  }
}

// ── SnowLuma 页签：防闪烁基础设施 ──
// 本页每 4 秒被全局定时器刷新一次。早期实现每次都 `box.innerHTML = ...` 整块重建卡片，
// 导致二维码 <img> 与日志 <pre> 反复销毁重建、图片重复下载 → 屏幕持续闪烁。
// 现在：骨架只建一次（事件也只绑一次），之后只"按需打补丁"更新变化的文本；
// 二维码仅在 NapCat 换码（qrAt 变化）时才换 src。
const SL = { built: false, bound: false, qrTimer: null, qrAt: '', loggedIn: null, logText: '' };

function slEl(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = slEl(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setDot(id, on) {
  const el = slEl(id);
  if (!el) return;
  const want = on ? 'dot dot-on' : 'dot dot-off';
  if (el.className !== want) el.className = want;
}

/** 建立卡片骨架 + 绑定事件（只做一次）。 */
function buildSnowlumaSkeleton() {
  const box = slEl('snowluma-page');
  if (!box || SL.built) return;
  box.innerHTML = `
    <div class="snowluma-page-card">
      <div class="snowluma-head">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="snowluma-qr" id="sl-qr-panel"></div>
      </div>
      <div class="sl-login" id="sl-login-panel"></div>
      <!-- 账号总览与一键切号（2026-09-16 新增，见 renderAccountsPanel） -->
      <div class="sl-accounts" id="sl-accounts-panel"></div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-run"></span>
        <span>SnowLuma：<strong id="sl-txt-run"></strong></span>
        <span class="muted" id="sl-txt-pid"></span>
        <span class="muted" id="sl-txt-mode"></span>
      </div>
      <div class="snowluma-state-row">
        <span class="dot" id="sl-dot-ob"></span>
        <span>OneBot：<strong id="sl-txt-ob"></strong></span>
        <span class="muted" id="sl-txt-obws"></span>
      </div>
      <div class="snowluma-state-row muted"><span id="sl-txt-dir"></span></div>
      <div class="snowluma-state-row">
        <span>WebUI：</span>
        <span id="sl-webui-slot"></span>
      </div>
      <div class="snowluma-actions">
        <button class="btn btn-primary" id="sl-start-btn">启动 SnowLuma</button>
        <button class="btn btn-danger" id="sl-stop-btn">关闭 SnowLuma</button>
        <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
        <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
        <span id="sl-hint" class="muted" style="font-size:12px"></span>
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">运行日志（实时滚动，仅保留最近 2000 行）</div>
        <pre class="snowluma-logs-view" id="sl-logs"></pre>
      </div>
    </div>`;
  SL.built = true;
  bindSnowlumaEvents();
}

function bindSnowlumaEvents() {
  if (SL.bound) return;
  SL.bound = true;

  slEl('sl-start-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-start-btn');
    btn.disabled = true; btn.textContent = '启动中…';
    setText('sl-hint', '');
    try {
      const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
      setText('sl-hint', r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。' : ('启动失败：' + r.error)));
    } catch (e) { setText('sl-hint', '启动失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
  });

  slEl('sl-stop-btn')?.addEventListener('click', async () => {
    const btn = slEl('sl-stop-btn');
    // NapCat 是注入进 QQ.exe 的：关网关 = 退出被注入的那个 QQ 客户端。
    // 不说清楚就动手，用户会以为"我把 QQ 弄崩了"。
    if (!window.confirm('关闭网关会一并退出被 NapCat 注入的那个 QQ 客户端（其它 QQ 窗口不受影响）。\n\n确定要关闭吗？')) return;
    btn.disabled = true; btn.textContent = '关闭中…';
    setText('sl-hint', '');
    try {
      const r = await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
      const hit = (r.matched || []).map((m) => `${m.name}(${m.pid}) 占 ${m.port}`).join('，');
      if (r.stopped) {
        setText('sl-hint', `已关闭：PID ${r.killed.join(', ')}${hit ? `（${hit}）` : ''}`);
      } else if (r.errors?.length) {
        setText('sl-hint', `关闭失败：${r.errors.join('；')}`);
      } else {
        setText('sl-hint', `没有找到运行中的网关进程（已按端口 ${(r.ports || []).join('/') || '?'} 查找）`);
      }
    } catch (e) { setText('sl-hint', '关闭失败：' + e.message); }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
  });

  slEl('sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());
  slEl('sl-open-folder-btn')?.addEventListener('click', async () => {
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { setText('sl-hint', '失败：' + e.message); }
  });
}

// ── 账号密码登录（含人机验证中转）──
// 目的：QQ 风控掉线时，用户可在面板里自助用账密登录，不必找管理员扫码。
// 安全：**密码明文不出浏览器** —— 前端算 MD5 后只把 passwordMd5 发给后端。
// 人机验证走腾讯 TCaptcha（NapCat 返回的 proofWaterUrl 里带 aid/sid），
// 验证通过拿到 ticket/randstr 再回传后端完成登录。
const SLLogin = { uin: '', passwordMd5: '', capSid: '', capAid: '', busy: false, timer: null, waiting: false };

/** 纯 JS MD5（同步，无依赖）。密码只在这里转成 MD5，明文不上行。 */
function md5(str) {
  // 精简实现（RFC 1321），足够登录用
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function au(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function tb(str2) {
    const n = ((str2.length + 8) >> 6) + 1;
    const blk = new Array(n * 16).fill(0);
    for (let i = 0; i < str2.length; i++) blk[i >> 2] |= str2.charCodeAt(i) << ((i % 4) * 8);
    blk[str2.length >> 2] |= 0x80 << ((str2.length % 4) * 8);
    blk[n * 16 - 2] = str2.length * 8;
    return blk;
  }
  function hex(num) { let s2 = ''; for (let i = 0; i < 4; i++) s2 += ('0' + ((num >> (i * 8)) & 0xff).toString(16)).slice(-2); return s2; }
  const utf8 = unescape(encodeURIComponent(str));
  const x = tb(utf8);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function slLoginMsg(text, kind) {
  const el = slEl('sl-login-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'sl-login-msg' + (kind ? ' ' + kind : '');
}

function loginErrorText(message) {
  const text = String(message || '登录失败');
  if (/(fetch failed|ECONNREFUSED|连接|network)/i.test(text)) {
    return '连接不到 NapCat WebUI，请先启动 SnowLuma 网关。';
  }
  if (/Unauthorized|401/i.test(text)) {
    return 'NapCat WebUI 凭据已失效，请重启 SnowLuma 后重试。';
  }
  if (/QQ Is Logined/i.test(text)) {
    return '当前 QQ 已经登录，无需再次执行账号密码登录。';
  }
  if (/密码登录功能未初始化/.test(text)) {
    return '当前 NapCat Worker 尚未初始化密码登录，请重启 SnowLuma 后重试。';
  }
  return text;
}

async function waitForLoginResult(timeoutMs = 60000) {
  if (SLLogin.waiting) return;
  SLLogin.waiting = true;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const r = await api('/api/snowluma/login/status');
      if (!r.ok) {
        slLoginMsg('登录状态查询失败：' + loginErrorText(r.error), 'err');
        return;
      }
      if (r.status?.isLogin) {
        slLoginMsg('登录成功，账号已上线 ✧', 'ok');
        await loadSnowlumaPage({ quiet: true });
        return;
      }
      if (r.status?.loginError) {
        slLoginMsg('登录失败：' + loginErrorText(r.status.loginError), 'err');
        return;
      }
    }
    slLoginMsg('登录请求已提交，但暂未上线。请查看下方日志，或改用二维码/快速登录。', 'warn');
  } catch (error) {
    slLoginMsg('登录结果轮询失败：' + loginErrorText(error?.message), 'err');
  } finally {
    SLLogin.waiting = false;
  }
}

function renderSnowlumaLogin(info) {
  const box = slEl('sl-login-panel');
  if (!box) return;
  if (!info?.available) {
    box.innerHTML = '<div class="muted" style="font-size:12.5px">未找到 NapCat WebUI 配置，无法使用账密登录。</div>';
    return;
  }
  if (info.running === false) {
    box.innerHTML = '<div class="muted" style="font-size:12.5px">NapCat WebUI 未运行。请先在 SnowLuma 页签启动网关，随后这里会自动恢复账号密码登录。</div>';
    return;
  }
  box.innerHTML = `
    <div class="sl-login-title">账号密码登录 <span class="muted">（风控掉线时用，免扫码）</span></div>
    <div class="field-row">
      <div class="field" style="max-width:170px">
        <label>QQ 号</label>
        <input type="text" id="sl-uin" placeholder="如 3831864262" autocomplete="username">
      </div>
      <div class="field">
        <label>QQ 密码 <span class="muted">（仅在本机浏览器算 MD5，明文不上传）</span></label>
        <input type="password" id="sl-pwd" placeholder="密码" autocomplete="current-password">
      </div>
    </div>
    <div class="snowluma-actions">
      <button class="btn btn-primary btn-small" id="sl-do-login">登录</button>
      <button class="btn btn-small" id="sl-quick-login">快速登录（已登录过的号）</button>
      <span class="muted" id="sl-quick-list" style="font-size:12px"></span>
    </div>
    <div class="sl-login-msg" id="sl-login-msg"></div>
    <div id="sl-captcha-slot"></div>`;

  slEl('sl-do-login')?.addEventListener('click', doPasswordLogin);
  slEl('sl-quick-login')?.addEventListener('click', doQuickLogin);
  loadQuickList();
}

async function loadQuickList() {
  try {
    const r = await api('/api/snowluma/login/status');
    const list = r.quickList || [];
    const el = slEl('sl-quick-list');
    if (el) el.textContent = list.length ? ('可用：' + list.join('、')) : '（暂无快速登录记录）';
    const uinEl = slEl('sl-uin');
    if (uinEl && !uinEl.value && list.length === 1) uinEl.value = list[0];
  } catch { /* ignore */ }
}

async function doQuickLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  if (!uin) return slLoginMsg('请先填 QQ 号', 'err');
  slLoginMsg('正在快速登录 ' + uin + ' …');
  try {
    const r = await api('/api/snowluma/login/quick', { method: 'POST', body: JSON.stringify({ uin }) });
    if (!r.ok) return slLoginMsg('快速登录失败：' + loginErrorText(r.error), 'err');
    slLoginMsg('已请求快速登录，请稍候观察状态…', 'ok');
    waitForLoginResult();
  } catch (e) { slLoginMsg('失败：' + loginErrorText(e.message), 'err'); }
}

async function doPasswordLogin() {
  const uin = (slEl('sl-uin')?.value || '').trim();
  const pwd = slEl('sl-pwd')?.value || '';
  if (!uin || !pwd) return slLoginMsg('请填 QQ 号与密码', 'err');
  if (!/^\d{5,12}$/.test(uin)) return slLoginMsg('QQ 号格式不对', 'err');
  SLLogin.uin = uin;
  SLLogin.passwordMd5 = md5(pwd);          // 明文到此为止，不上行
  if (slEl('sl-pwd')) slEl('sl-pwd').value = '';
  slLoginMsg('正在登录…');
  try {
    const r = await api('/api/snowluma/login/password', {
      method: 'POST',
      body: JSON.stringify({ uin, passwordMd5: SLLogin.passwordMd5 })
    });
    if (!r.ok) return slLoginMsg('登录失败：' + loginErrorText(r.error), 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    if (r.needCaptcha) {
      slLoginMsg('需要人机验证，请在下方完成', 'warn');
      return showCaptcha(r.proofWaterUrl);
    }
    slLoginMsg('登录请求已发送，正在等待账号上线…', 'ok');
    waitForLoginResult();
  } catch (e) { slLoginMsg('失败：' + loginErrorText(e.message), 'err'); }
}


/* ───────────────────────── 账号总览与一键切号（2026-09-16 新增）─────────────────────────
 *
 * 背景：用户点了原来的「快速登录（已登录过的号）」按钮，提示「已请求快速登录，请稍候观察状态…」
 *       然后**永远没反应**。查明真凶：该按钮调的是 NapCat 的 SetQuickLoginQQ，
 *       它**只是设定『下次快速登录用哪个号』，完全不触发登录动作** —— 状态自然不会变。
 *
 * 用户诉求：「直接展示后台在线账号，然后切换过去」。
 * 本区块因此：
 *   ① 列出每个 QQ 实例**当前真实登录的账号**（UIN + 昵称 + 端点）；
 *   ② 列出已缓存可快速登录的号；
 *   ③ 提供「切到此号」按钮 → 先设定、再询问是否重启生效（两步，避免误操作掉线）。
 *
 * 数据来自外部桌面应用的 /api/qq/accounts（面板后端已透传，令牌不下发浏览器）。
 */
async function renderAccountsPanel() {
  const box = slEl('sl-accounts-panel');
  if (!box) return;
  let d;
  try {
    const r = await api('/api/accounts/overview');
    if (!r.ok) { box.innerHTML = '<div class="muted" style="font-size:12px">账号总览不可用：' + (r.error || '') + '</div>'; return; }
    d = r.data;
  } catch (e) {
    box.innerHTML = '<div class="muted" style="font-size:12px">账号总览读取失败：' + e.message + '</div>';
    return;
  }

  const rows = (d.instances || []).map((i) => `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${i.online ? 'on' : 'off'}">${i.online ? '在线' : '离线'}</span>
      <span class="sl-acct-label">${esc(i.label)}</span>
      <span class="sl-acct-uin">${i.online ? esc(i.uin + (i.nick ? '　' + i.nick : '')) : '—'}</span>
      <span class="muted" style="font-size:11px">${i.oneBotPort ? ':' + i.oneBotPort : ''}</span>
    </div>`).join('');

  const cached = (d.quickList || []).length
    ? d.quickList.map((q) => esc(q)).join('、')
    : '（无）';

  const switches = (d.switchable || []).map((s) => {
    const isCurrent = s.online && s.from === 'bot';
    return `
    <div class="sl-acct-row">
      <span class="sl-acct-pill ${s.online ? 'on' : 'off'}">${s.online ? '在线' : '已缓存'}</span>
      <span class="sl-acct-uin">${esc(s.uin)}${s.nick ? '　' + esc(s.nick) : ''}</span>
      <span class="muted" style="font-size:11px">${esc(s.fromLabel)}</span>
      <span style="flex:1"></span>
      ${isCurrent
        ? '<span class="sl-acct-cur">✓ 当前使用中</span>'
        : `<button class="btn btn-small" data-switch-uin="${esc(s.uin)}" data-switch-nick="${esc(s.nick || '')}">切到此号</button>`}
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="sl-accounts-title">后台在线账号 <span class="muted" style="font-size:11.5px">${esc(d.note || '')}</span></div>
    <div class="sl-accounts-card">
      ${rows || '<div class="muted" style="font-size:12px">未发现实例</div>'}
      <div class="muted" style="font-size:11.5px;margin-top:8px">已缓存可快速登录：${cached}</div>
    </div>
    <div class="sl-accounts-title" style="margin-top:12px">切换机器人登录账号</div>
    <div class="sl-accounts-card">
      ${switches || '<div class="muted" style="font-size:12px">暂无可切换账号</div>'}
      <div class="muted" style="font-size:11px;margin-top:8px;line-height:1.7">
        点「切到此号」= 先把它设为机器人的快速登录账号，再询问是否重启 NapCat 生效。<br>
        ⚠️ 重启期间机器人会短暂离线（30–60 秒）；同一 QQ 号不能在两处同时在线（会互踢）。
      </div>
    </div>`;

  // 绑定切号按钮
  box.querySelectorAll('[data-switch-uin]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uin = btn.getAttribute('data-switch-uin');
      const nick = btn.getAttribute('data-switch-nick') || '';
      const ok = window.confirm(
        '将把 QQ 机器人的快速登录账号设为 ' + uin + (nick ? '（' + nick + '）' : '') + '。\n\n' +
        '⚠️ 这一步只是「设定」；需要重启 NapCat 才会真正用它登录，\n' +
        '   期间机器人会短暂离线（约 30–60 秒）。\n\n' +
        '另外：同一个 QQ 号不能在两处同时在线，否则会互踢。\n\n' +
        '确定继续吗？'
      );
      if (!ok) return;
      btn.disabled = true;
      btn.textContent = '设定中…';
      try {
        const r1 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-quick-login', uin })
        });
        if (!r1.ok) { alert('设定失败：' + (r1.error || '')); btn.disabled = false; btn.textContent = '切到此号'; return; }
        btn.textContent = '重启中…';
        const r2 = await api('/api/accounts/switch', {
          method: 'POST',
          body: JSON.stringify({ action: 'bot-restart' })
        });
        alert(r2.ok ? ('已设定并重启机器人。\n\n' + (r2.message || '') + '\n\n约 30–60 秒后完成登录，可稍后刷新查看。')
                    : ('设定成功，但重启失败：' + (r2.error || r2.message || '')));
      } catch (e) {
        alert('操作失败：' + e.message);
      }
      btn.disabled = false;
      btn.textContent = '切到此号';
      setTimeout(renderAccountsPanel, 1500);
    });
  });
}

// 注：HTML 转义复用文件顶部已有的 esc()（第 50 行），不重复定义。

/** 登录面板只渲染一次（否则 4 秒定时刷新会把用户输入冲掉）。 */
function renderSnowlumaLoginOnce() {
  const box = slEl('sl-login-panel');
  if (!box) return;
  api('/api/snowluma/login/info')
    .then((info) => {
      const stateKey = `${!!info.available}:${!!info.running}`;
      if (box.dataset.ready === '1' && box.dataset.state === stateKey) return;
      box.dataset.ready = '1';
      box.dataset.state = stateKey;
      renderSnowlumaLogin(info);
    })
    .catch(() => {
      box.dataset.ready = '';
      box.dataset.state = '';
    });
}

// ── 新设备扫码验证 ──
// QQ 检测到"新设备登录"时会要求用**手机 QQ 扫码**确认（不是登录二维码，是设备验证）。
// 流程：GetNewDeviceQRCode 取 str_url → 渲染二维码 → 每 2.5s 轮询 PollNewDeviceQR
//       → 手机确认后拿 str_nt_succ_token → NewDeviceLogin 完成登录。
const SLDev = { uin: '', passwordMd5: '', bytesToken: '', timer: null };

function stopDevPoll() {
  if (SLDev.timer) { clearInterval(SLDev.timer); SLDev.timer = null; }
}

async function startNewDeviceVerify(jumpUrl, sig) {
  stopDevPoll();
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  SLDev.uin = SLLogin.uin;
  SLDev.passwordMd5 = SLLogin.passwordMd5;
  slLoginMsg('检测到新设备：请用**手机 QQ** 扫码确认（不是登录码）', 'warn');
  slot.innerHTML = '<div class="sl-captcha-box"><div class="muted">正在获取验证二维码…</div></div>';

  try {
    const r = await api('/api/snowluma/login/new-device-qr', {
      method: 'POST',
      body: JSON.stringify({ uin: SLDev.uin, jumpUrl })
    });
    if (!r.ok) { slot.innerHTML = ''; return slLoginMsg('获取验证二维码失败：' + r.error, 'err'); }
    const qr = r.qr || {};
    SLDev.bytesToken = qr.bytes_token || '';
    if (!qr.str_url) { slot.innerHTML = ''; return slLoginMsg('NapCat 未返回验证二维码', 'err'); }

    const imgTag = r.qrImage
      ? '<img class="sl-devqr-img" src="' + r.qrImage + '" alt="新设备验证二维码">'
      : '<div class="muted">（服务端未生成图片，请点下方链接）</div>';
    slot.innerHTML = '<div class="sl-captcha-box">'
      + '<div class="sl-login-title">用手机 QQ 扫码完成设备验证</div>'
      + imgTag
      + '<div class="sl-devqr-hint" id="sl-devqr-hint">等待扫码…</div>'
      + '<div class="muted" style="font-size:12px;word-break:break-all">扫码不了可复制：'
      + '<a href="' + esc(qr.str_url) + '" target="_blank" rel="noopener">验证链接</a></div>'
      + '</div>';

    startDevPoll();
  } catch (e) {
    slot.innerHTML = '';
    slLoginMsg('失败：' + e.message, 'err');
  }
}

function startDevPoll() {
  stopDevPoll();
  SLDev.timer = setInterval(async () => {
    try {
      const r = await api('/api/snowluma/login/new-device-poll', {
        method: 'POST',
        body: JSON.stringify({ uin: SLDev.uin, bytesToken: SLDev.bytesToken })
      });
      if (!r.ok) return;
      const p = r.poll || {};
      const st = p.uint32_guarantee_status;
      if (st === 3) {
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '已扫描，请在手机上确认…';
      } else if (st === 1) {
        stopDevPoll();
        const h = slEl('sl-devqr-hint');
        if (h) h.textContent = '验证成功，正在登录…';
        // 用返回的 token 完成登录
        await finishNewDeviceLogin(p.str_nt_succ_token || SLDev.bytesToken);
      }
    } catch { /* 轮询失败继续 */ }
  }, 2500);
}

async function finishNewDeviceLogin(sig) {
  try {
    const r = await api('/api/snowluma/login/new-device', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLDev.uin, passwordMd5: SLDev.passwordMd5, newDevicePullQrCodeSig: sig
      })
    });
    if (!r.ok) return slLoginMsg('设备验证后登录失败：' + r.error, 'err');
    slLoginMsg('登录成功 ✧ 稍候即可收发消息', 'ok');
    const slot = slEl('sl-captcha-slot');
    if (slot) slot.innerHTML = '';
  } catch (e) { slLoginMsg('失败：' + e.message, 'err'); }
}

/** 渲染腾讯 TCaptcha：解析 proofWaterUrl 里的 aid/sid，动态加载 TCaptcha.js。 */
function showCaptcha(proofWaterUrl) {
  const slot = slEl('sl-captcha-slot');
  if (!slot) return;
  let aid = '', sid = '';
  try {
    const q = proofWaterUrl.includes('?') ? proofWaterUrl.split('?')[1].split('#')[0] : '';
    for (const kv of q.split('&')) {
      const [k, v] = kv.split('=');
      if (k === 'aid') aid = decodeURIComponent(v || '');
      if (k === 'sid') sid = decodeURIComponent(v || '');
    }
  } catch { /* ignore */ }
  SLLogin.capAid = aid || '2081081773';
  SLLogin.capSid = sid;
  slot.innerHTML = '<div class="sl-captcha-box"><div id="sl-captcha-target"></div>'
    + '<div class="muted" style="font-size:12px">若验证码未出现，点此手动打开：'
    + '<a href="' + esc(proofWaterUrl) + '" target="_blank" rel="noopener">验证链接</a></div></div>';

  const load = (src) => new Promise((resolve, reject) => {
    if (window.TencentCaptcha) return resolve();
    const sc = document.createElement('script');
    sc.src = src; sc.onload = () => resolve(); sc.onerror = () => reject(new Error('load fail'));
    document.head.appendChild(sc);
  });
  load('https://captcha.gtimg.com/TCaptcha.js')
    .catch(() => load('https://ssl.captcha.qq.com/TCaptcha.js'))
    .then(() => {
      const cap = new window.TencentCaptcha(SLLogin.capAid, (res) => {
        if (res.ret === 0 && res.ticket) return submitCaptcha(res.ticket, res.randstr);
        slLoginMsg('验证未通过或已取消', 'err');
      }, { type: 'popup', showHeader: false, uin: SLLogin.uin, sid: SLLogin.capSid });
      cap.show();
    })
    .catch(() => slLoginMsg('验证码脚本加载失败，请点上面的验证链接手动完成', 'err'));
}

async function submitCaptcha(ticket, randstr) {
  slLoginMsg('验证通过，正在提交…');
  try {
    const r = await api('/api/snowluma/login/captcha', {
      method: 'POST',
      body: JSON.stringify({
        uin: SLLogin.uin, passwordMd5: SLLogin.passwordMd5,
        ticket, randstr, sid: SLLogin.capSid
      })
    });
    if (!r.ok) return slLoginMsg('验证码登录失败：' + loginErrorText(r.error), 'err');
    if (r.needNewDevice) return startNewDeviceVerify(r.jumpUrl, r.newDevicePullQrCodeSig);
    slLoginMsg('验证已提交，正在等待账号上线…', 'ok');
    waitForLoginResult();
  } catch (e) { slLoginMsg('失败：' + loginErrorText(e.message), 'err'); }
}

// ── 卡片右上角的登录二维码 ──
async function renderSnowlumaQr(connectedHint, selfHint) {
  const box = slEl('sl-qr-panel');
  if (!box) return;

  const showLoggedIn = (nick, uid) => {
    if (SL.loggedIn === true) return;
    SL.loggedIn = true;
    box.innerHTML = '<div class="sl-qr-done">✅ 已登录'
      + (nick ? '<br><strong>' + esc(nick) + '</strong>' : '')
      + (uid ? '<br><span class="muted">' + esc(String(uid)) + '</span>' : '')
      + '</div>';
    stopSnowlumaQrTimer();
  };

  if (connectedHint === true) return showLoggedIn(selfHint?.nickname, selfHint?.userId);

  try {
    const r = await api('/api/snowluma/qr');
    if (r.loggedIn) return showLoggedIn(r.self?.nickname, r.self?.userId);
    SL.loggedIn = false;

    if (!r.exists) {
      if (box.querySelector('.sl-qr-img') || !box.querySelector('.sl-qr-empty')) {
        box.innerHTML = '<div class="sl-qr-empty">等待 NapCat 生成二维码…<br>'
          + '<span class="muted">若长时间无二维码，可手动刷新或检查下方日志</span></div>'
          + '<div class="sl-qr-actions"><button class="btn btn-small" id="sl-qr-refresh-btn">刷新二维码</button></div>';
      }
      bindSnowlumaQrRefresh(box);
      return;
    }

    const age = Math.round((r.ageMs || 0) / 1000);
    const stale = age > 150;   // NapCat 约 2 分钟换一次
    const hint = stale ? '⏳ 二维码可能已过期，等待刷新…' : ('用手机 QQ 扫码 · ' + age + 's 前刷新');

    const img = box.querySelector('.sl-qr-img');
    if (!img) {
      box.innerHTML = '<div class="sl-qr-title">扫码登录 QQ</div>'
        + '<img class="sl-qr-img" src="/api/snowluma/qr.png?t=' + Date.now() + '" alt="登录二维码">'
        + '<div class="sl-qr-actions"><button class="btn btn-small" id="sl-qr-refresh-btn">刷新二维码</button></div>'
        + '<div class="sl-qr-hint" id="sl-qr-hint"></div>';
      SL.qrAt = r.qrAt;
    } else if (r.qrAt && r.qrAt !== SL.qrAt) {
      SL.qrAt = r.qrAt;                    // 仅在 NapCat 换码时换图，避免闪烁
      img.src = '/api/snowluma/qr.png?t=' + Date.now();
    }
    bindSnowlumaQrRefresh(box);
    setText('sl-qr-hint', hint);
    startSnowlumaQrTimer();
  } catch (e) {
    if (!box.querySelector('.sl-qr-empty')) {
      box.innerHTML = '<div class="sl-qr-empty">二维码加载失败<br><span class="muted">' + esc(e.message) + '</span></div>';
    }
  }
}

function bindSnowlumaQrRefresh(box) {
  const btn = box?.querySelector('#sl-qr-refresh-btn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      const r = await api('/api/snowluma/login/refresh-qr', { method: 'POST', body: '{}' });
      if (!r.ok) throw new Error(r.error || '刷新失败');
      SL.qrAt = '';
      await new Promise((resolve) => setTimeout(resolve, 900));
      await renderSnowlumaQr(false, null);
      setText('sl-qr-hint', '二维码已手动刷新，请使用最新二维码。');
    } catch (error) {
      const text = String(error?.message || error);
      setText('sl-qr-hint', /QQ Is Logined/i.test(text) ? '当前 QQ 已登录，无需刷新。' : `刷新失败：${text}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '刷新二维码';
    }
  });
}

function startSnowlumaQrTimer() {
  if (SL.qrTimer) return;
  SL.qrTimer = setInterval(() => {
    if (state.tab !== 'snowluma') return;
    if (SL.loggedIn === true) { stopSnowlumaQrTimer(); return; }
    renderSnowlumaQr(false, null);
  }, 5000);
}
function stopSnowlumaQrTimer() {
  if (SL.qrTimer) { clearInterval(SL.qrTimer); SL.qrTimer = null; }
}

// ── SnowLuma 独立页签 ──

// 只重画日志区（轻量）：SSE 每来一行就触发，绝不整页刷新。
// ⚠️ 此前这个函数根本不存在，SSE 收到日志就抛 ReferenceError —— 日志永远不实时刷新。
//    这里补上并做 300ms 节流，避免 NapCat 日志量大时把面板刷爆。
let _slLogTimer = null;
function refreshSnowlumaLogs() {
  if (_slLogTimer) return;
  _slLogTimer = setTimeout(async () => {
    _slLogTimer = null;
    try {
      const pre = slEl('sl-logs');
      if (!pre) return;
      const logs = await api('/api/snowluma/logs');
      const logText = (logs.logs || []).map((l) => {
        const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
        return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
      }).join('\n') || '暂无日志';
      if (logText !== SL.logText) {
        SL.logText = logText;
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
        pre.textContent = logText;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }
    } catch { /* 忽略：下一行日志会再触发一次 */ }
  }, 300);
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs')
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    buildSnowlumaSkeleton();
    {
      const _s = s;
      const _running = !!( _s.snowluma?.running );
      const _obOk = !!_s.onebot?.connected;
      const _pid = _s.snowluma?.pid ?? null;
      const _embedded = !!_s.snowluma?.embedded;
      const _webui = _s.snowluma?.webuiUrl || '';

      setDot('sl-dot-run', _running);
      setText('sl-txt-run', _running ? '运行中' : '未运行');
      setText('sl-txt-pid', _pid ? ('pid ' + _pid) : '');
      setText('sl-txt-mode', _embedded ? '内置模式（随 QQ Agent 退出）' : (_running ? '独立模式' : ''));

      setDot('sl-dot-ob', _obOk);
      const _acct = _s.onebot?.account || {};
      const _acctOff = _acct.online === false;
      if (_acctOff) {
        const _m = _acct.offlineMs ? Math.round(_acct.offlineMs / 60000) : 0;
        setText('sl-txt-ob', '⚠ 账号已离线' + (_m ? ('（' + _m + ' 分钟）') : ''));
        setDot('sl-dot-ob', false);
      } else {
        setText('sl-txt-ob', _obOk ? ('已连接' + (_s.onebot.self ? ('（' + _s.onebot.self.nickname + '）') : '')) : '未连接');
        setDot('sl-dot-ob', _obOk);
      }
      setText('sl-txt-obws', _acctOff
        ? ('账号离线 —— 扫码或检查登录' + (_acct.lastError ? ('（' + _acct.lastError + '）') : ''))
        : (_s.onebot?.error ? ('WS ：' + _s.onebot.error) : ''));
      setText('sl-txt-dir', '目录：' + (dir || '（未找到项目内 snowluma/ 文件夹）'));

      const webSlot = slEl('sl-webui-slot');
      if (webSlot) {
        const want = _webui
          ? ('<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">' + esc(_webui) + '</button>')
          : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>';
        if (webSlot.innerHTML !== want) {
          webSlot.innerHTML = want;
          const b = slEl('sl-open-webui-btn');
          if (b) b.addEventListener('click', async () => {
            try {
              const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
              if (!r.ok) setText('sl-hint', r.error);
            } catch (e) { setText('sl-hint', '打开失败：' + e.message); }
          });
        }
      }

      const startBtn = slEl('sl-start-btn');
      if (startBtn) {
        const label = _running ? '已运行' : '启动 SnowLuma';
        if (startBtn.textContent !== label) startBtn.textContent = label;
        if (startBtn.disabled !== _running) startBtn.disabled = _running;
      }
      const stopBtn = slEl('sl-stop-btn');
      if (stopBtn && stopBtn.disabled === _running) stopBtn.disabled = !_running;

      // 日志：内容变化才写，并保持贴底滚动
      const pre = slEl('sl-logs');
      if (pre && logText !== SL.logText) {
        SL.logText = logText;
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
        pre.textContent = logText;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }

      // ⚠️ 必须传「账号是否真的在线」，不能传 _obOk（= WS 是否连着）。
      //    NapCat 的 WS 在账号离线时依然在监听，传 _obOk 会让面板误显示
      //    「✅ 已登录」，于是**不显示二维码**，用户想重登都没码可扫。
      //    （2026-09-16 事故：掉线后二维码消失，用户无法自助恢复）
      renderSnowlumaQr(_acctOff === false, _s.onebot?.self || null);
    renderSnowlumaLoginOnce();
    // 账号总览与一键切号：每轮刷新都重渲染（数据实时变化，且没有用户输入需要保留）
    renderAccountsPanel().catch(() => {});
    }

  } catch (e) {
    if (!quiet) console.error(e);
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const [data, moodData] = await Promise.all([
      api('/api/chats'),
      api('/api/moods').catch(() => ({ moods: {} }))
    ]);
    state.chats = data.chats || [];
    state.moods = moodData.moods || {};
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息
      loadChatMessages(state.currentChatKey);
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  box.innerHTML = state.chats.map((c) => {
    const name = c.key.replace('group:', '群 ').replace('private:', '私聊 ');
    const mood = state.moods?.[c.key];
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${mood ? `<span class="mood-badge">${esc(mood.label)}</span>` : ''}
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

async function loadChatMessages(key) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=200`);
    state.chatMessages = data.messages || [];
    renderChatMessages();
  } catch (e) {
    $('#chat-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const name = key.replace('group:', '群 ').replace('private:', '私聊 ');
  const meta = state.chats.find((c) => c.key === key) || {};
  const mood = state.moods?.[key] || null;
  const detail = $('#chat-detail');
  const rows = state.chatMessages.map((m) => `
    <tr class="${m.read ? '' : 'unread'}">
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`).join('');
  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub">
        <span>共 ${meta.total || 0} 条 · 存储于 data/messages/</span>
        ${mood ? `<span>情绪：${esc(mood.label)}</span>` : ''}
      </div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-mood-reset-btn">重置情绪</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息（不走模型）" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <table class="archive-table"><tbody>${rows}</tbody></table>`;
  $('#chat-wake-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  });
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key);
  });
  $('#chat-mood-reset-btn').addEventListener('click', async () => {
    try {
      const r = await api('/api/moods/reset', {
        method: 'POST',
        body: JSON.stringify({ chatKey: key })
      });
      state.moods[key] = r.mood;
      renderChatList();
      renderChatMessages();
    } catch (e) {
      alert('重置情绪失败：' + e.message);
    }
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    const btn = $('#chat-testsend-btn');
    btn.textContent = '发送中…';
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, { method: 'POST', body: JSON.stringify({ text }) });
      btn.textContent = '已发出 ✓';
      input.value = '';
      loadChatMessages(key);
    } catch (e) {
      btn.textContent = `失败：${e.message}`.slice(0, 40);
    }
    setTimeout(() => { btn.textContent = '发送'; }, 2500);
  });
}

// ── 设置视图 ──
async function loadSettings() {
  const [cfg, tplData, provData, visionData, capData, rvcData, singData, gsvData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/capabilities').catch(() => null),
    api('/api/rvc').catch(() => null),
    api('/api/sing').catch(() => null),
    api('/api/gsv/voices').catch(() => null)
  ]);
  state.config = cfg;
  state.capabilities = capData;
  state.rvc = rvcData;
  state.sing = singData;
  state.gsv = gsvData;
  loadSearchKeys().catch(() => {});
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) {
    // customRules 必须一起带过来：applyPersonaTemplate() 覆盖时要用它。
    // 以前只存了 name/text/builtin，选自定义人设时 tpl.customRules 恒为
    // undefined，会把人家的「管理员附加规则」静默清空。
    state.personaTemplates[t.id] = {
      name: t.name,
      text: t.text,
      customRules: t.customRules || '',
      builtin: !!t.builtin
    };
  }
  renderSettings();
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <button class="btn btn-small" id="save-tpl-btn">存为新模板</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往 SnowLuma 页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '【官方资料】' : (r?.source === 'probe' ? '【在线探测】' : '');
  const t = (cls, text) => `<span class="vbadge ${cls}" title="${esc(src + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片');
  if (r.verdict === 'no-vision') return t('no', '无图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  if (!provs.length) return '<div class="muted" style="padding:10px;font-size:12px">目录为空——点"从 DSH 导入"。</div>';
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey && p.apiKey) {
    $('#cfg-apikey').value = p.apiKey;
    notes.push(`密钥已填充（${p.apiKeyFrom === 'manual' ? '手动保存' : `来自环境变量 ${p.apiKeyFrom}`}）`);
  } else {
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('（DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型）');
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  // 菜单由 schema.js 数据驱动（window.QQAGENT_SCHEMA.SETTINGS_SECTIONS）
  const menu = (window.QQAGENT_SCHEMA?.SETTINGS_SECTIONS || []).map((sec) => [sec.id, sec.label]);
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${(s?.onebot?.account?.online === false) ? 'dot-off' : (s?.onebot?.connected ? 'dot-on' : 'dot-off')}"></span><span>${(s?.onebot?.account?.online === false) ? '⚠ 账号已离线' : (s?.onebot?.connected ? '运行中' : '未就绪')}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${(window.QQAGENT_SCHEMA?.sectionIcon || (() => ''))(id)}<span>${label}</span></button>`).join('')}
    </div>`;
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
      if (el.dataset.section === 'voice') refreshRvcStatus().catch(() => {});
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    capabilities: () => renderCapabilitiesSection(c),
    api: () => renderApiSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    chat: () => renderChatSection(c),
    voice: () => renderVoiceSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  // section 说明（desc）来自 schema.js；找不到则用空串
  const secDesc = (window.QQAGENT_SCHEMA?.getSection?.(sec)?.desc) || '';
  return `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>
    ${secDesc ? `<div class="section-desc">${esc(secDesc)}</div>` : ''}
    ${render()}`;
}

function rvcStatusText(rvc) {
  if (!rvc) return '状态未知（点下面的「刷新状态」）';
  const h = rvc.health;
  if (!h) return rvc.enabled ? '音色服务未运行（启动 QQ Agent 时会自动拉起，也可以点「保存并重启服务」）' : '音色转换未启用';
  const gpu = h.gpu ? `（${h.gpu}）` : '';
  return `运行中：模型 ${h.model} · 设备 ${h.device}${gpu} · 采样率 ${h.tgt_sr} · 已转换 ${h.count} 次 · 上次 ${h.lastCostMs}ms`;
}

function renderVoiceSection(c) {
  const a = c.audio || {};
  const r = a.rvc || {};
  const rvc = state.rvc || null;
  const sing = state.sing || null;
  const banks = (sing && sing.diffSinger && sing.diffSinger.banks) || [];
  const seedReady = !!(sing && sing.seedVc && sing.seedVc.ready);
  const svc = a.svc || {};
  // 角色本音清单：优先用后端 /api/gsv/voices（带"文件是否齐全"），拿不到就用内置兜底
  const gsv = state.gsv || null;
  const gsvList = gsv && Array.isArray(gsv.voices) && gsv.voices.length
    ? gsv.voices
    : [
        { key: 'hutao', name: '胡桃', version: 'v4' },
        { key: 'nahida', name: '纳西妲', version: 'v4' },
        { key: 'sparkle', name: '花火', version: 'v2ProPlus' },
        { key: 'liuying', name: '流萤', version: 'v2ProPlus' },
        { key: 'furina', name: '芙宁娜', version: 'v4' },
        { key: 'ayaka', name: '神里绫华', version: 'v4' },
        { key: 'robin', name: '知更鸟', version: 'RVC' },
      ];
  const curGsv = String(a.gsvVoice || 'hutao');
  const gsvOptions = gsvList.slice();
  if (!gsvOptions.some((v) => v.key === curGsv)) gsvOptions.push({ key: curGsv, name: curGsv, version: '', available: true });
  const gsvPicked = gsvList.find((v) => v.key === curGsv);
  const gsvHint = gsvPicked && gsvPicked.available === false
    ? '这个音色缺文件：' + (gsvPicked.missing || []).join('、') + '；选了也会降级成千问 TTS'
    : '首次切换要加载权重（1~5 秒）；v4 走 48kHz 声码器，比 v2ProPlus 慢一些。';
  const gsvServiceOk = !!(gsv && gsv.service && gsv.service.ok);
  const ttsModels = ['qwen-audio-3.0-tts-plus', 'qwen-audio-3.0-tts-flash', 'cosyvoice-v3-flash'];
  const curTts = a.model || 'qwen-audio-3.0-tts-plus';
  if (!ttsModels.includes(curTts)) ttsModels.push(curTts);
  const modelNames = ((rvc && rvc.models) || []).map((m) => m.name);
  const curModel = r.model || modelNames[0] || 'hutao';
  if (!modelNames.includes(curModel)) modelNames.push(curModel);
  const methods = [['rmvpe', 'rmvpe（质量最好，推荐）'], ['harvest', 'harvest（稳）'], ['pm', 'pm（最快）'], ['crepe', 'crepe（最慢）']];
  const curMethod = r.method || 'rmvpe';
  return `
    <h3 id="settings-voice">语音音色</h3>
    <div class="hint">发语音的链路：文字 → 角色本音（GPT-SoVITS 本地模型，优先）→ 失败时降级 千问 TTS →（可选）RVC 换音色 → 作为 QQ 语音消息发出。</div>

    <h3>角色本音（用谁的声音说话）</h3>
    <div class="hint">这里选的就是实际发出去的音色。没选过的默认胡桃。改动保存后下一句生效：第一次换成某个音色要加载权重，约 1~5 秒。</div>
    <div class="field-row">
      <div class="field"><label>音色</label>
        <select id="cfg-audio-gsvvoice">
          ${gsvOptions.map((v) => `<option value="${esc(v.key)}" ${v.key === curGsv ? 'selected' : ''}>${esc(v.name)}${v.version ? '（' + esc(v.version) + '）' : ''}${v.available === false ? ' · 缺文件' : ''}</option>`).join('')}
        </select>
        <div class="hint">${esc(gsvHint)}</div></div>
      <div class="field"><label>试听</label>
        <button class="btn btn-small" id="gsv-preview-btn" type="button">用这个音色念一句</button>
        <button class="btn btn-small" id="gsv-start-btn" type="button">启动本音服务</button>
        <div id="gsv-preview-result" class="hint" style="margin-top:6px">${gsvServiceOk ? '推理服务在线' : '推理服务没在跑，点左边按钮启动（冷启动 30~90 秒）'}</div></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-audio-gsvautostart" ${a.gsvAutoStart !== false ? 'checked' : ''} />
      <label for="cfg-audio-gsvautostart">服务没跑时自动启动（关掉则必须手动启动，否则一律降级千问 TTS）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-audio-gsvpick" ${a.gsvAllowModelPick === true ? 'checked' : ''} />
      <label for="cfg-audio-gsvpick">允许模型临时换音色（关掉 = 上面选的说了算；打开后模型能按语境自己挑人，音色容易乱跳）</label></div>

    <h3>语音合成</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-audio-enabled" ${a.enabled !== false ? 'checked' : ''} />
      <label for="cfg-audio-enabled">启用语音（让机器人能发语音、能听语音）</label></div>
    <div class="field-row">
      <div class="field"><label>语音合成模型</label>
        <select id="cfg-audio-model">
          ${ttsModels.map((m) => `<option value="${esc(m)}" ${m === curTts ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <div class="hint">plus / flash 是 qwen-audio-3.0 系列；cosyvoice-v3-flash 走同一个接口，音色库更长。</div></div>
      <div class="field"><label>音色（留空 = 用模型默认）</label>
        <input type="text" id="cfg-audio-voice" value="${esc(a.voice || '')}" placeholder="longanlingxin / longanhuan_v3.6 / Cherry" />
        <div class="hint">音色和模型要配套：plus 默认 longanlingxin，flash 默认 longanhuan_v3.6。</div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>默认语气/情绪指令（可留空）</label>
        <input type="text" id="cfg-audio-instruction" value="${esc(a.instruction || '')}" placeholder="例如：语气自然，带一点傲娇俏皮，像和熟人聊天" />
        <div class="hint">一句话描述语气/情绪/语速，每次语音都带上；发语音时模型也能按上下文临时覆盖（style 参数）。</div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>单条语音最多合成多少字</label>
        <input type="number" id="cfg-audio-maxchars" min="10" max="600" value="${esc(a.maxChars ?? 150)}" />
        <div class="hint">做过音色转换时耗时基本随字数走：GPU 约 0.12× 实时，CPU 约 1.1× 实时。太长会把语音拖慢。</div></div>
    </div>

    <h3>RVC 音色转换</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rvc-enabled" ${r.enabled === true ? 'checked' : ''} />
      <label for="cfg-rvc-enabled">启用音色转换（把 TTS 的声音换成下面的音色）</label></div>
    <div class="field-row">
      <div class="field"><label>音色模型</label>
        <select id="cfg-rvc-model">
          ${modelNames.map((m) => `<option value="${esc(m)}" ${m === curModel ? 'selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
        <div class="hint">模型文件放在 rvc\\models\\ 里（.pth）。加新音色就把 .pth 丢进去，再刷新本页。</div></div>
      <div class="field"><label>运行设备</label>
        <select id="cfg-rvc-device">
          <option value="auto" ${(r.device || 'auto') === 'auto' ? 'selected' : ''}>自动（有显卡就用显卡）</option>
          <option value="cuda:0" ${r.device === 'cuda:0' ? 'selected' : ''}>显卡 cuda:0</option>
          <option value="cpu:0" ${r.device === 'cpu:0' ? 'selected' : ''}>CPU</option>
        </select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>升降调（半音，-24 ~ +24）</label>
        <input type="number" id="cfg-rvc-f0up" min="-24" max="24" step="1" value="${esc(r.f0upKey ?? 0)}" />
        <div class="hint">觉得音色偏低就 +12，偏高就 -12；0 = 不改。</div></div>
      <div class="field"><label>音高提取方法</label>
        <select id="cfg-rvc-method">
          ${methods.map(([v, label]) => `<option value="${v}" ${v === curMethod ? 'selected' : ''}>${label}</option>`).join('')}
        </select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>清辅音/呼吸保留（0~0.5，越大越有活人感）</label>
        <input type="number" id="cfg-rvc-protect" min="0" max="0.5" step="0.05" value="${esc(r.protect ?? 0.33)}" />
        <div class="hint">调高可减少金属感、更像真人，但过高可能引入气声。</div></div>
      <div class="field"><label>索引率（0~1，检索索引介入强度）</label>
        <input type="number" id="cfg-rvc-indexrate" min="0" max="1" step="0.05" value="${esc(r.indexRate ?? 0.5)}" />
        <div class="hint">音色身份感强但杂音多就调低。</div></div>
    </div>
    <div class="field"><label>后处理强度（0~1，压金属感/底噪）</label>
      <input type="number" id="cfg-rvc-enhance" min="0" max="1" step="0.1" value="${esc(r.enhance ?? 1)}" />
      <div class="hint">1 = 默认（压掉声码器编造的超高频、补厚度）；0 = 关闭。</div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rvc-fallback" ${r.fallbackToRaw !== false ? 'checked' : ''} />
      <label for="cfg-rvc-fallback">转换失败时用原始 TTS 声音发出去（关掉则直接报错、不发声）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-rvc-prefergsv" ${r.preferOverGsv === true ? 'checked' : ''} />
      <label for="cfg-rvc-prefergsv">胡桃也走音色转换（打开 = 「千问 TTS → RVC」快路径，快但不像；关掉 = 用本音模型，更像但每句要等几秒）</label></div>

    <h3>音色服务</h3>
    <div class="field"><label>当前状态</label>
      <div id="rvc-status" class="hint" style="margin-top:4px">${esc(rvcStatusText(rvc))}</div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="rvc-refresh-btn" type="button">刷新状态</button>
        <button class="btn btn-small" id="rvc-restart-btn" type="button">保存并重启服务</button>
        <button class="btn btn-small" id="rvc-stop-btn" type="button">停止服务</button>
        <span id="rvc-action-result" class="muted"></span>
      </div>
      <div class="hint" style="margin-top:6px">只有换音色模型和换运行设备需要「保存并重启服务」（重启后首次加载模型约 10~30 秒）；开关、升降调、音高提取方法保存后下一次发语音就生效。</div></div>

    <h3>唱歌</h3>
    <div class="hint">四种唱歌方式：<b>清唱</b>（「唱：歌词」时不要伴奏）、<b>翻唱</b>（发歌换成胡桃音色 / 按原曲真翻唱）、<b>语音片段唱</b>（发一段语音→换胡桃音色）、<b>完整唱</b>（整首原曲真翻唱）。</div>
    <div class="field"><label>唱歌引擎</label>
      <div class="hint" style="margin-top:4px">
        DiffSinger 声库：${banks.length ? banks.map((b) => esc(b.name)).join('、') : '未检测到（未就绪）'}<br/>
        Seed-VC（新语音转换模型）：${seedReady ? '已就绪' : '未下载权重'}
      </div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-svc-enabled" ${svc.enabled === true ? 'checked' : ''} />
      <label for="cfg-svc-enabled">启用歌声转换（发歌/发音频翻唱时，把人声换成胡桃音色）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-svc-mixinstrumental" ${svc.mixInstrumental !== false ? 'checked' : ''} />
      <label for="cfg-svc-mixinstrumental">翻唱时保留原曲伴奏（关掉 = 清唱，只要胡桃人声）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-svc-singdry" ${svc.singDry !== false ? 'checked' : ''} />
      <label for="cfg-svc-singdry">「唱：歌词」默认干声（只出人声，不加自动伴奏；关掉 = 带伴奏）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-svc-coverdry" ${svc.coverDry !== false ? 'checked' : ''} />
      <label for="cfg-svc-coverdry">按原曲翻唱默认干声（不混原曲伴奏、不做母带；关掉 = 混音成品）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-svc-improvise" ${svc.allowImprovise === true ? 'checked' : ''} />
      <label for="cfg-svc-improvise">没有原曲时允许现编一段调去唱（<b>不建议</b>：现编的调听着就是跑调，群里会被喊「别唱了」；关掉 = 没有旋律来源就老实跟群友要音频）</label></div>
    <div class="hint">唱歌转换引擎是 so-vits-svc（GPU 服务，端口 3212）；「歌词点唱」走 DiffSinger，不占这个服务。
      干声 = 只有人声，能听清音准和咬字；带伴奏 = 人声叠在原曲/自动伴奏上，更像「成品」。
      群友在群里说「清唱」「带伴奏」时也可以临时改，不用动这里。开关保存后下一次点歌生效。</div>`;
}

async function refreshRvcStatus() {
  try {
    state.rvc = await api('/api/rvc');
  } catch {
    state.rvc = null;
  }
  const node = document.querySelector('#rvc-status');
  if (node) node.textContent = rvcStatusText(state.rvc);
  return state.rvc;
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>大脑预设（一键切换模型参数组合）</label>
      <div id="brain-preset-bar" class="preset-bar" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      <div class="hint" id="preset-hint">预设只改「温度 / 输出上限 / 思考 / 轮数」，不会覆盖你已选好的模型。当前：${esc(c.api.preset || '未使用预设')}</div>
    </div>
    <div class="field"><label>模型目录（点击选择）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}` : '尚未选择模型'}</div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" value="${esc(c.api.baseUrl)}" placeholder="https://api.example.com" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label><input type="text" id="cfg-apikey" value="${esc(c.api.apiKey)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>普通聊天单次输出上限（tokens）</label><input type="number" id="cfg-maxoutput" min="64" max="4096" value="${esc(c.api.maxOutputTokens ?? 320)}" /></div>
      <div class="field"><label>复杂任务单次输出上限（tokens）</label><input type="number" id="cfg-complexmaxoutput" min="64" max="8192" value="${esc(c.api.complexMaxOutputTokens ?? 1000)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>复杂任务模型（可选）</label>
        <input type="text" id="cfg-complexmodel" placeholder="例如 deepseek-v4-pro" value="${esc(c.api.complexModel || '')}" />
        <div class="hint">代码、数学、长文、文件和网页正文推理会切到这个模型；留空则始终使用普通聊天模型。</div></div>
      <div class="field"><label>自动模型路由</label>
        <div class="checkbox-row"><input type="checkbox" id="cfg-routing-enabled" ${c.api.routing?.enabled !== false ? 'checked' : ''} />
          <label for="cfg-routing-enabled">启用模型路由</label></div>
        <div class="checkbox-row"><input type="checkbox" id="cfg-routing-auto" ${c.api.routing?.auto !== false ? 'checked' : ''} />
          <label for="cfg-routing-auto">按问题复杂度自动选择</label></div>
        <div class="checkbox-row"><input type="checkbox" id="cfg-routing-escalation" ${c.api.routing?.allowModelEscalation !== false ? 'checked' : ''} />
          <label for="cfg-routing-escalation">允许模型主动请求深推理</label></div>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>推理模型的思考</label>
        <div class="checkbox-row"><input type="checkbox" id="cfg-thinking-off" ${c.api.thinkingMode === 'off' ? 'checked' : ''} />
          <label for="cfg-thinking-off">关闭思考（更快更省）</label></div>
        <div class="hint">不勾 = auto：正常开思考，只有在"输出被截断导致答不出话"时自动改走不思考兜底。勾上 = 全程不思考：实测同一道编程题 9s / 880 tokens 出完整答案（开思考要 37s / 3100 tokens），代价是复杂推理会弱一点。</div>
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div class="field"><label>识图模式</label>
      <select id="cfg-vision-mode">
        <option value="native" ${(c.vision?.mode || 'native') === 'native' ? 'selected' : ''}>原生多模态（由当前聊天模型直接看图）</option>
        <option value="qwen" ${c.vision?.mode === 'qwen' ? 'selected' : ''}>Qwen-VL 独立识图（主模型只接收识别文字）</option>
      </select>
      <div class="hint">Qwen-VL 模式下，即使主聊天模型不支持图片，也能通过独立识图工具理解图片和表情。</div>
    </div>
    <div class="field-row">
      <div class="field"><label>Qwen-VL Base URL</label>
        <input type="text" id="cfg-qwen-baseurl" value="${esc(c.vision?.qwen?.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1')}" /></div>
      <div class="field"><label>Qwen-VL 模型</label>
        <input type="text" id="cfg-qwen-model" value="${esc(c.vision?.qwen?.model || 'qwen3-vl-plus')}" /></div>
    </div>
    <div class="field"><label>Qwen / DashScope API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-qwen-key" value="${esc(c.vision?.qwen?.apiKey || '')}" style="flex:1" />
        <button class="btn btn-small" type="button" id="test-qwen-vision-btn">测试识图</button>
        <span id="qwen-vision-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint">也可使用环境变量 DASHSCOPE_API_KEY 或 QIANWEN_API_KEY。设置页中的 Key 优先。</div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索引擎</label>
      <select id="cfg-searchprovider">
        <option value="auto" ${(c.webSearch?.provider || 'auto') === 'auto' ? 'selected' : ''}>自动（优先 AnySearch，失败回退 Bing）— 推荐</option>
        <option value="anysearch" ${c.webSearch?.provider === 'anysearch' ? 'selected' : ''}>AnySearch（需配置 API key，结果更全）</option>
        <option value="bing" ${c.webSearch?.provider === 'bing' ? 'selected' : ''}>Bing 网页抓取（免 key）</option>
      </select>
      <div class="hint" style="margin-top:4px">未配置 key 时，自动模式会回退到 Bing 网页抓取。</div></div>
    <div class="field"><label>AnySearch API Key</label>
      <div id="search-key-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <button class="btn btn-small" type="button" id="add-search-key-btn">+ 添加一个 Key</button>
        <button class="btn btn-small btn-primary" type="button" id="save-search-keys-btn">保存 Key</button>
        <span id="search-key-result" class="muted"></span>
      </div>
      <div class="hint" style="margin-top:4px">支持多个 Key 轮换（某个额度用尽时自动换下一个）。已保存的 Key 只显示首尾，重新填写才会覆盖；环境变量注入的 Key 优先且不在此显示。</div></div>
    <div class="field"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>

    <div class="settings-divider"></div>

    <h3>手动添加提供商</h3>
    <div class="field"><label>Base URL（可填写）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-baseurl" placeholder="例如 http://127.0.0.1:8787/v1 或 https://api.example.com/v1" style="flex:1" />
        <button class="btn btn-small" id="fetch-models-btn">获取列表</button>
      </div></div>
    <div class="field"><label>API Key</label><input type="text" id="new-apikey" placeholder="sk-..." /></div>
    <div class="field"><label>模型 id（两列：左侧模型 ID，右侧模型目录中显示的名字；可添加多行）</label>
      <div id="model-rows"></div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
      </div>
      <div class="hint">「获取列表」会从上面的 Base URL 拉取模型，并在弹窗里勾选加入列表。</div></div>
    <div class="field-row">
      <div class="field"><button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button></div>
      <div class="field"><button class="btn btn-danger" id="delete-model-btn">删除模型…</button></div>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}

function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div id="persona-backup-bar" style="display:flex;gap:8px;align-items:center;min-height:20px"></div>
    <div class="field"><label>角色设定（每轮注入，群友不可修改）</label>
      <div class="hint" style="margin-bottom:6px">选模板不会直接覆盖：会先问「覆盖还是追加」，覆盖前自动备份、可一键还原。</div>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderPersonaSaveBar()}`;
}


// ── 能力面板：展示机器人当前具备的工具与功能（数据来自 /api/capabilities）──
function renderCapabilitiesSection(c) {
  const cap = state.capabilities;
  if (!cap) {
    return `
      <h3 id="settings-caps">能力总览</h3>
      <div class="hint">正在加载能力清单…</div>`;
  }
  const tools = cap.tools || [];
  const f = cap.features || {};

  // 按分组聚合
  const groups = {};
  for (const t of tools) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push(t);
  }
  const ORDER = ['消息与互动', '信息获取', '学习/知识库', '记忆', '主人专属', '其它'];
  const orderedNames = ORDER.filter((g) => groups[g]).concat(Object.keys(groups).filter((g) => !ORDER.includes(g)));
  const GROUP_ICON = {
    '消息与互动': '💬', '信息获取': '🔎', '学习/知识库': '📚',
    '记忆': '🧠', '主人专属': '👑', '其它': '🔧'
  };

  const toolCards = orderedNames.map((g) => {
    const list = groups[g];
    return `
      <div class="cap-group">
        <div class="cap-group-title">${GROUP_ICON[g] || '🔧'} ${esc(g)}
          <span class="cap-count">（${list.length}）</span></div>
        <div class="cap-tools">
          ${list.map((t) => `
            <div class="cap-tool">
              <div class="cap-tool-name">
                <code>${esc(t.name)}</code>
                ${t.masterOnly ? '<span class="cap-badge">主人专属</span>' : ''}
              </div>
              <div class="cap-tool-desc">${esc(String(t.description || '').slice(0, 110))}${(t.description || '').length > 110 ? '…' : ''}</div>
              ${t.params && t.params.length ? `<div class="cap-tool-params">参数：<code>${t.params.map(esc).join('</code>、<code>')}</code></div>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');

  // 关键功能状态卡
  const sr = f.search || {};
  const sc = f.scheduled || {};
  const modes = f.identityModes || [];
  const modeRows = modes.length
    ? modes.map((m) => `· <b>${esc(m.label)}</b>：说「${(m.enter || []).map(esc).join('」/「')}」进入，说「${(m.exit || []).map(esc).join('」/「')}」退出`).join('<br>')
    : '<span class="cap-off">（未配置身份模式）</span>';

  return `
    <h3 id="settings-caps">能力总览</h3>
    <div class="hint" style="margin-bottom:12px">
      机器人当前具备 <b>${cap.total || tools.length}</b> 个工具。以下清单由服务端实时生成，与运行中的代码一致。
    </div>

    <div class="cap-grid">
      <div class="cap-card">
        <div class="cap-card-title">🎓 学习模式（多身份）</div>
        <div class="cap-card-body">
          已配置 <b>${modes.length}</b> 个模式<br>
          ${modeRows}
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">📚 知识库</div>
        <div class="cap-card-body">
          状态：${f.kb === 'ok' ? '<span class="cap-ok">✅ 已就绪</span>' : '<span class="cap-off">未安装</span>'}<br>
          能力：题库 / 教材检索 / 学习进度 / 学习档案
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">🔎 联网搜索</div>
        <div class="cap-card-body">
          状态：${sr.enabled ? '<span class="cap-ok">✅ 已启用</span>' : '<span class="cap-off">未启用</span>'}<br>
          当前引擎：<b>${esc(String(sr.effective || '未知'))}</b><br>
          AnySearch Key：${sr.anysearchAvailable ? '<span class="cap-ok">已配置</span>' : '<span class="cap-off">未配置</span>'}
        </div>
      </div>
      <div class="cap-card">
        <div class="cap-card-title">⏱️ 定时任务</div>
        <div class="cap-card-body">
          待触发：<b>${sc.count || 0}</b> 条${sc.items && sc.items.length ? '<br>' + sc.items.map((x) => '· ' + esc(x)).join('<br>') : (sc.count ? '' : '<br><span class="cap-off">（主人可以在 QQ 里直接下达：X点提醒我…）</span>')}
        </div>
      </div>
    </div>

    <h3 style="margin:20px 0 12px">工具清单</h3>
    ${toolCards}`;
}

// ── AnySearch Key 管理 ──────────────────────────────
function renderSearchKeyRows() {
  const box = $('#search-key-rows');
  if (!box) return;
  const sk = state.searchKeys || {};
  const masked = sk.configKeys || [];
  const envCount = sk.envCount || 0;
  const rows = [];
  if (envCount > 0) {
    rows.push('<div class="muted" style="font-size:12px;margin-bottom:6px">检测到 ' + envCount + ' 个环境变量注入的 Key（优先使用，不在此显示）</div>');
  }
  const n = Math.max(masked.length, 1);
  for (let i = 0; i < n; i++) {
    const v = masked[i] || '';
    rows.push('<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
      '<input type="text" class="search-key-input" data-idx="' + i + '" placeholder="粘贴 AnySearch API Key" value="' + esc(v) + '" style="flex:1" />' +
      '<button class="btn btn-small" type="button" data-del-key="' + i + '" title="删除这一项">✕</button>' +
      '</div>');
  }
  box.innerHTML = rows.join('');
  box.querySelectorAll('[data-del-key]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.delKey);
      const inputs = [...box.querySelectorAll('.search-key-input')];
      if (inputs[idx]) inputs[idx].value = '';
      el.closest('div').style.opacity = '.4';
      el.disabled = true;
    });
  });
}

async function loadSearchKeys() {
  try {
    state.searchKeys = await api('/api/search-keys');
    renderSearchKeyRows();
  } catch (e) { /* 忽略 */ }
}

async function saveSearchKeys() {
  const box = $('#search-key-rows');
  const out = $('#search-key-result');
  if (!box) return;
  const inputs = [...box.querySelectorAll('.search-key-input')];
  const keys = inputs.map((el) => el.value.trim()).filter(Boolean);
  // 只提交新填的（含 **** 的是遮影值，不提交）
  try {
    const r = await fetch('/api/search-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys })
    });
    const j = await r.json();
    if (j.ok) {
      if (out) out.textContent = '已保存 ' + j.saved + ' 个 Key';
      await loadSearchKeys();
    } else if (out) out.textContent = '保存失败：' + (j.error || '');
  } catch (e) {
    if (out) out.textContent = '保存失败：' + e.message;
  }
}

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选（不用查群号）</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>`;
}

function renderChatSection(c) {
  return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>普通群聊聚批窗口（毫秒）</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>私聊/@/引用快速响应（毫秒）</label><input type="number" id="cfg-directwakedelay" min="0" value="${esc(c.directWakeDelayMs ?? 500)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <div class="field-row">
      <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
      <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <h3>发给模型的聊天记录</h3>
    <div class="field-row">
      <div class="field"><label>最多条数</label>
        <input type="number" id="cfg-pastlimit" min="10" max="500" value="${esc(c.store?.pastStateLimit ?? 80)}" />
        <div class="hint">每次运行提示词里"过去状态"最多携带的历史消息条数。</div></div>
      <div class="field"><label>字符预算</label>
        <input type="number" id="cfg-pastchars" min="1000" max="60000" step="500" value="${esc(c.store?.pastStateMaxChars ?? 6000)}" />
        <div class="hint">聊天记录的总字符上限，超出时从最旧的开始丢弃。保存后下次运行立即生效。</div></div>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启（登录 Windows 后自动运行）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘（机器人常驻，从托盘真正退出）</label></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

async function renderBrainPresetBar(c) {
  const bar = $('#brain-preset-bar');
  if (!bar) return;
  let presets = [];
  let current = c.api?.preset || '';
  try {
    const r = await api('/api/presets');
    presets = r.presets || [];
    current = r.current || current;
  } catch (e) {
    // 拉不到就用静态兜底（后端未升级时）
    presets = [];
  }
  if (!presets.length) {
    bar.innerHTML = '<span class="muted">预设列表不可用（后端未升级）</span>';
    return;
  }
  bar.innerHTML = presets.map((p) => {
    const active = p.id === current ? ' preset-active' : '';
    return `<button type="button" class="btn btn-small preset-chip${active}" data-preset="${esc(p.id)}" title="${esc(p.desc)}">${esc(p.icon)} ${esc(p.name)}</button>`;
  }).join('');
  bar.querySelectorAll('.preset-chip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.preset;
      btn.textContent = '切换中…';
      try {
        const r = await api('/api/presets/apply', { method: 'POST', body: JSON.stringify({ id }) });
        if (r.ok) {
          state.config = r.config;
          // 刷新表单里受预设影响的字段显示
          const c2 = state.config;
          const set = (sel, v) => { const el = $(sel); if (el) el.value = v; };
          set('#cfg-temperature', c2.api.temperature);
          set('#cfg-maxrounds', c2.api.maxRounds);
          set('#cfg-maxoutput', c2.api.maxOutputTokens);
          set('#cfg-complexmaxoutput', c2.api.complexMaxOutputTokens);
          const hint = $('#preset-hint');
          if (hint) hint.textContent = `已切换到「${btn.textContent.replace('切换中…', '')}」。已保存，重启后模型参数即生效。当前：${c2.api.preset}`;
          renderBrainPresetBar(c2);
          refreshStatus();
        }
      } catch (e) {
        const hint = $('#preset-hint');
        if (hint) hint.textContent = `切换失败：${e.message}`;
      }
    });
  });
}

function bindSettingsEvents(c) {
  // ── 大脑预设切换 ──
  renderBrainPresetBar(c);
  // AnySearch Key 的添加/保存按钮
  const addKeyBtn = $('#add-search-key-btn');
  if (addKeyBtn) addKeyBtn.addEventListener('click', () => {
    const box = $('#search-key-rows');
    if (!box) return;
    const inputs = box.querySelectorAll('.search-key-input');
    const idx = inputs.length;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    div.innerHTML = '<input type="text" class="search-key-input" data-idx="' + idx + '" placeholder="粘贴 AnySearch API Key" style="flex:1" />' +
      '<button class="btn btn-small" type="button" title="清空">✕</button>';
    div.querySelector('button').addEventListener('click', () => { div.remove(); });
    box.appendChild(div);
  });
  const saveKeyBtn = $('#save-search-keys-btn');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', saveSearchKeys);

  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#cfg-save-result').textContent = '已保存 ✓';
      refreshStatus();
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // ── 模型 API 区块事件 ──
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', async () => {
    const btn = testProviderBtn;
    const out = $('#provider-test-result');
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const apiKey = $('#cfg-apikey')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.textContent = '测试连通性';
  });

  const testQwenBtn = $('#test-qwen-vision-btn');
  if (testQwenBtn) testQwenBtn.addEventListener('click', async () => {
    const btn = testQwenBtn;
    const out = $('#qwen-vision-test-result');
    btn.textContent = '识别中…';
    if (out) out.textContent = '';
    try {
      const qwen = {
        baseUrl: $('#cfg-qwen-baseurl')?.value.trim() || '',
        apiKey: $('#cfg-qwen-key')?.value.trim() || '',
        model: $('#cfg-qwen-model')?.value.trim() || ''
      };
      const r = await api('/api/vision/qwen/test', {
        method: 'POST',
        body: JSON.stringify({ qwen })
      });
      if (out) out.textContent = r.ok
        ? `✓ ${r.note}（${r.latencyMs}ms）`
        : `✗ 测试失败：${r.error || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.textContent = '测试识图';
  });

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    const key = $('#cfg-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th style="width:44%">模型 ID</th><th style="width:44%">模型目录显示名</th><th></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="如 glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="如 智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td style="width:56px;text-align:right"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''}>删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    if (!box) return;
    const qwenSelected = $('#cfg-vision-mode')?.value === 'qwen';
    const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
    if (!qwenSelected && r && r.verdict === 'no-vision') {
      // ⚠️ 这里不能把 checked 改成 false：这个开关是「全局配置」，
      //    "当前模型看不了图"只是这一颗模型的事。以前置 false + disabled，
      //    保存一次就把 api.vision 永久写成 false，换回支持图片的模型也不会自己恢复，
      //    用户完全不知道是哪一步关掉的。现在只禁用，值保持原样。
      box.disabled = true;
      box.checked = state.config.api.vision !== false;
      hint.textContent = '此聊天模型不支持图片输入；开关保持你的全局设置，换回支持图片的模型或改用 Qwen-VL 即可';
    } else {
      box.disabled = false;
      box.checked = state.config.api.vision !== false;
      hint.textContent = qwenSelected
        ? '由独立 Qwen-VL 识图，不要求聊天模型支持图片'
        : (r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '');
    }
  }
  $('#cfg-vision-mode')?.addEventListener('change', () => syncVisionSwitch(c.api.provider, c.api.model));
  syncVisionSwitch(c.api.provider, c.api.model);

  // ── 人设区块事件 ──
  renderPersonaBackupBar();
  const personaPick = $('#cfg-persona-pick');
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      // 当前角色设定用的正是这个人设 → 回落到内置默认，并立刻落盘。
      // 以前只改了 DOM 再 loadSettings()，重渲染会把已删人设的文本从 config 里
      // 又灌回输入框，表现就是"删了又回来了"，点保存还会把它写回去。
      if ((state.config.persona?.roleText || '') === tpl.text) {
        const fallback = state.personaTemplates.xiaojingyu?.text || '';
        await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({ persona: { roleText: fallback, customRules: '' } })
        });
      }
      await loadSettings();
      $('#persona-pick-hint').textContent = '已删除该自定义人设';
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  // 编辑正文时实时刷新「保存回模板」按钮的可用状态与"已修改"提示
  const roleTextInput = $('#cfg-roletext');
  if (roleTextInput) roleTextInput.addEventListener('input', () => syncPersonaButtons());
  const roleRulesInput = $('#cfg-customrules');
  if (roleRulesInput) roleRulesInput.addEventListener('input', () => syncPersonaButtons());

  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  // 把编辑框里的内容存回已有模板（自定义）/ 另存为一条新人设（内置或还没选模板）
  const saveTplBtn = $('#save-tpl-btn');
  if (saveTplBtn) saveTplBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    const tpl = state.personaTemplates[id];
    const roleText = $('#cfg-roletext')?.value ?? '';
    const rules = $('#cfg-customrules')?.value ?? '';
    const hint = $('#persona-pick-hint');
    try {
      if (saveTplBtn.dataset.mode === 'update' && tpl && !tpl.builtin) {
        await api(`/api/persona-templates/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: roleText, customRules: rules })
        });
        tpl.text = roleText;
        tpl.customRules = rules;
        if (hint) hint.textContent = `已保存回「${tpl.name}」，别的会话用到这条模板也会跟着变`;
      } else {
        // 另存：默认名带「（副本）」，避免跟已有条目同名（同名会被后端就地覆盖）
        const base = String(tpl?.name || '新人设').replace(/[（(].*$/, '').trim() || '新人设';
        const name = window.prompt('新人设名称', `${base}（副本）`);
        if (!name || !name.trim()) return;
        const res = await api('/api/persona-templates', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), text: roleText, customRules: rules })
        });
        // 不重新 loadSettings：那会用 config.persona.roleText 覆盖掉编辑框里刚改的内容
        const newId = res && res.id ? res.id : '';
        if (newId) {
          state.personaTemplates[newId] = { name: name.trim(), text: roleText, customRules: rules, builtin: false };
          state.personaAppliedId = newId;
        }
        const input = $('#cfg-persona-pick');
        if (input) input.value = name.trim();
        if (hint) hint.textContent = res && res.updated
          ? `已更新同名人设「${name.trim()}」`
          : `已存为新模板「${name.trim()}」。记得点「保存人设修改」让当前填写生效。`;
      }
      syncPersonaButtons();
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 语音音色区块事件 ──
  const gsvStartBtn = $('#gsv-start-btn');
  if (gsvStartBtn) gsvStartBtn.addEventListener('click', async () => {
    const box = $('#gsv-preview-result');
    if (box) box.textContent = '正在启动角色本音服务（首次加载模型 30~90 秒）…';
    try {
      const r = await api('/api/gsv/start', { method: 'POST', body: '{}' });
      if (box) box.textContent = r && r.ok ? '服务已就绪 ✓' : '启动失败：' + ((r && r.reason) || '未知原因');
    } catch (e) {
      if (box) box.textContent = `启动失败：${e.message}`;
    }
  });
  const gsvPreviewBtn = $('#gsv-preview-btn');
  if (gsvPreviewBtn) gsvPreviewBtn.addEventListener('click', async () => {
    const box = $('#gsv-preview-result');
    const voice = String(($('#cfg-audio-gsvvoice') || {}).value || 'hutao');
    if (box) box.textContent = '正在合成（第一次切这个音色要加载权重，可能几秒）…';
    try {
      const res = await fetch('/api/gsv/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voice })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
      if (box) box.textContent = '正在播放 ✓（记得点保存，试听用的还没写进配置）';
    } catch (e) {
      if (box) box.textContent = `试听失败：${e.message}`;
    }
  });
  const rvcRefreshBtn = $('#rvc-refresh-btn');
  if (rvcRefreshBtn) rvcRefreshBtn.addEventListener('click', async () => {
    const box = $('#rvc-action-result');
    box.textContent = '刷新中…';
    await refreshRvcStatus();
    const h = state.rvc && state.rvc.health;
    box.textContent = h ? '已刷新 ✓' : (state.rvc && state.rvc.enabled ? '服务没在跑' : '音色转换未启用');
  });
  const rvcRestartBtn = $('#rvc-restart-btn');
  if (rvcRestartBtn) rvcRestartBtn.addEventListener('click', async () => {
    const box = $('#rvc-action-result');
    try {
      box.textContent = '保存设置…';
      await saveConfig({ quiet: true });
      box.textContent = '正在重启音色服务（首次加载模型约 10~30 秒）…';
      const r = await api('/api/rvc/restart', { method: 'POST', body: '{}' });
      await refreshRvcStatus();
      box.textContent = r && r.ok ? '服务已重启 ✓' : '服务没起来：' + ((r && r.reason) || '未知原因');
    } catch (e) {
      box.textContent = `重启失败：${e.message}`;
    }
  });
  const rvcStopBtn = $('#rvc-stop-btn');
  if (rvcStopBtn) rvcStopBtn.addEventListener('click', async () => {
    const box = $('#rvc-action-result');
    try {
      await api('/api/rvc/stop', { method: 'POST', body: '{}' });
      await refreshRvcStatus();
      box.textContent = '服务已停止（下次发语音会自动重启）';
    } catch (e) {
      box.textContent = `停止失败：${e.message}`;
    }
  });

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

// ── 人设选择/添加 模态框 ──

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      closeModelModal(overlay);
      if (tpl) applyPersonaTemplate(tpl);
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// 应用人设模板。**不再无条件整体覆盖**（2026-09-17 改）：
//   旧行为 = 点模板直接把 roleText 换掉、还把 customRules 清空，且无提示不可撤销，
//   用户自己写的人设会瞬间丢失。
//   新行为 = 先弹确认框，让用户选「覆盖」还是「追加」，并在覆盖前自动备份旧人设。
// 人设区块的「当前选中哪个模板 / 删除按钮是否显示」同步。
// ⚠️ 必须放模块作用域：设置面板里和 applyPersonaTemplate() 都要用，
//    以前它定义在 renderSettingsSection 内部，applyPersonaTemplate 调它会
//    ReferenceError（选模板后备份还原条出不来）。
function currentPersonaId() {
  const roleText = $('#cfg-roletext')?.value ?? '';
  const applied = state.personaAppliedId || '';
  // 记下的模板还在就认它 —— 改了字也认，否则"改完再点删除/保存回模板"会找不到落点
  if (applied && state.personaTemplates[applied]) return applied;
  const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
  return found ? found[0] : '';
}

function syncPersonaButtons() {
  const id = currentPersonaId();
  const tpl = state.personaTemplates[id];
  const isCustom = Boolean(id) && !tpl?.builtin;
  const delBtn = $('#del-persona-btn');
  if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
  const roleText = $('#cfg-roletext')?.value ?? '';
  const changed = Boolean(tpl) && tpl.text !== roleText;
  const hint = $('#persona-pick-hint');
  if (hint) {
    hint.textContent = tpl
      ? `${tpl.builtin ? '内置人设（写在代码里，改不了）' : '自定义人设'}${changed ? ' · 已修改，还没存回模板' : ''}`
      : '';
  }
  // 「保存回模板 / 另存为」：以前只有「＋ 添加人设」，想改已有模板只能重新粘一遍，
  // 结果每次修改都多出一条同名副本，原模板一个字都没变。
  const saveTplBtn = $('#save-tpl-btn');
  if (saveTplBtn) {
    if (!tpl) {
      saveTplBtn.textContent = '存为新模板';
      saveTplBtn.dataset.mode = 'create';
      saveTplBtn.disabled = !String(roleText || '').trim();
    } else if (tpl.builtin) {
      saveTplBtn.textContent = '另存为自定义人设';
      saveTplBtn.dataset.mode = 'create';
      saveTplBtn.disabled = false;
    } else {
      saveTplBtn.textContent = changed ? `保存回「${tpl.name}」` : '已与模板一致';
      saveTplBtn.dataset.mode = 'update';
      saveTplBtn.disabled = !changed;
    }
  }
}

function applyPersonaTemplate(tpl) {
  const roleEl = $('#cfg-roletext');
  const rulesEl = $('#cfg-customrules');
  if (!roleEl) return;

  // 记住"当前编辑的是哪一条模板"，改文本也不会丢 —— 后面「保存回模板」要靠它
  for (const [id, item] of Object.entries(state.personaTemplates || {})) {
    if (item === tpl) { state.personaAppliedId = id; break; }
  }

  const oldText = roleEl.value || '';
  const oldRules = rulesEl?.value || '';
  const newText = tpl.text || '';
  const newRules = tpl.customRules || '';

  // 无内容可覆盖 → 直接套用，不打扰
  if (!oldText.trim()) {
    roleEl.value = newText;
    if (rulesEl && newRules) rulesEl.value = newRules;
    const input = $('#cfg-persona-pick');
    if (input) input.value = tpl.name;
    syncPersonaButtons();
    return;
  }

  // 已有内容 → 询问覆盖还是追加（追加 = 保留旧人设，把模板接在后面）
  const keepRules = oldRules.trim()
    ? '\n\n（你原有的「附加规则」会保留，不会被模板清掉。）'
    : '';
  const useOverwrite = window.confirm(
    `要把当前人设替换为「${tpl.name}」吗？\n\n`
    + `当前人设：${oldText.length} 字\n`
    + `新模板：${newText.length} 字\n\n`
    + `【确定】= 覆盖（旧人设会先自动备份，可还原）\n`
    + `【取消】= 改为「追加」（保留旧人设，模板内容接在后面）`
    + keepRules
  );

  if (useOverwrite) {
    // 覆盖前备份旧人设，防误操作
    state.personaBackup = { text: oldText, rules: oldRules, at: Date.now() };
    roleEl.value = newText;
    if (rulesEl) rulesEl.value = newRules;   // 覆盖时才替换附加规则
  } else {
    roleEl.value = oldText.trimEnd() + '\n\n---\n\n' + newText;
    // 追加模式保留原有附加规则；若原本为空，则带入模板自带的
    if (rulesEl && !oldRules.trim() && newRules) rulesEl.value = newRules;
  }

  const input = $('#cfg-persona-pick');
  if (input) input.value = tpl.name;
  syncPersonaButtons();
  renderPersonaBackupBar();
}

// 覆盖后可一键还原（仅在本次页面会话内有效，刷新即失效）
function renderPersonaBackupBar() {
  const bar = $('#persona-backup-bar');
  if (!bar) return;
  const b = state.personaBackup;
  if (!b) { bar.innerHTML = ''; return; }
  const t = new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false });
  bar.innerHTML = `<span class="muted" style="font-size:12px">已备份覆盖前的人设（${b.text.length} 字，${t}）</span>
    <button class="btn btn-small" id="persona-restore-btn">还原</button>`;
  const btn = $('#persona-restore-btn');
  if (btn) btn.addEventListener('click', () => {
    const roleEl = $('#cfg-roletext');
    if (roleEl) roleEl.value = b.text;
    const rulesEl = $('#cfg-customrules');
    if (rulesEl) rulesEl.value = b.rules;
    state.personaBackup = null;
    renderPersonaBackupBar();
    syncPersonaButtons();
  });
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本（每轮注入，群友不可修改）"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL, apiKey: p.apiKey || '' } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="model-modal-right" id="ma-list" style="flex:1">
        ${remoteModels.map((m) => `
          <label class="mm-model">
            <input type="checkbox" class="ma-check" value="${esc(m)}" ${existingIds.has(m) ? 'checked disabled' : ''} />
            <span>${esc(m)}</span>
            ${existingIds.has(m) ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
          </label>`).join('') || '<div class="muted" style="padding:10px">没有拉到模型</div>'}
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });
  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'api') {
    // ⚠️ 这里以前漏了 apiKey（和 baseUrl）：表单里改了"当前 API Key"，保存时根本没提交，
    //    deepMerge 于是保留旧值 → 表现就是"改了密钥不生效，永远还是旧的"。
    const typedApiKey = val('#cfg-apikey', c.api.apiKey || '').trim();
    const typedBaseUrl = val('#cfg-baseurl', c.api.baseUrl || '').trim();
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      apiKey: typedApiKey,
      baseUrl: typedBaseUrl || c.api.baseUrl,
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 6,
      maxOutputTokens: Math.max(64, Number(val('#cfg-maxoutput', c.api.maxOutputTokens ?? 320)) || 320),
      complexMaxOutputTokens: Math.max(64, Number(val('#cfg-complexmaxoutput', c.api.complexMaxOutputTokens ?? 1000)) || 1000),
      complexModel: val('#cfg-complexmodel', c.api.complexModel || '').trim(),
      thinkingMode: chk('#cfg-thinking-off', c.api.thinkingMode === 'off') ? 'off' : 'auto',
      routing: {
        enabled: chk('#cfg-routing-enabled', c.api.routing?.enabled !== false),
        auto: chk('#cfg-routing-auto', c.api.routing?.auto !== false),
        allowModelEscalation: chk('#cfg-routing-escalation', c.api.routing?.allowModelEscalation !== false)
      }
    };
    patch.vision = {
      ...(c.vision || {}),
      mode: val('#cfg-vision-mode', c.vision?.mode || 'native'),
      qwen: {
        ...(c.vision?.qwen || {}),
        baseUrl: val('#cfg-qwen-baseurl', c.vision?.qwen?.baseUrl || '').trim(),
        apiKey: val('#cfg-qwen-key', c.vision?.qwen?.apiKey || '').trim(),
        model: val('#cfg-qwen-model', c.vision?.qwen?.model || 'qwen3-vl-plus').trim()
      }
    };
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'auto'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search'
    };
    // 密钥同时写回提供商目录：否则下次在模型选择器里重新选模型时，
    // 会把 provider 里的旧密钥重新写进 api.apiKey，看起来又"改回去了"。
    const providerId = val('#cfg-provider', c.api.provider || '').trim();
    if (providerId && typedApiKey) {
      const prov = (state.providers || []).find((x) => x.id === providerId);
      if (prov && prov.apiKey !== typedApiKey) {
        try {
          await api('/api/providers/set-key', { method: 'POST', body: JSON.stringify({ providerId, apiKey: typedApiKey }) });
          prov.apiKey = typedApiKey;
          prov.apiKeyFrom = 'manual';
        } catch { /* 目录同步失败不影响配置本身已保存 */ }
      }
    }
  }

  if (sec === 'voice') {
    const curRvc = (c.audio && c.audio.rvc) || {};
    const curSvc = (c.audio && c.audio.svc) || {};
    patch.audio = {
      ...(c.audio || {}),
      enabled: chk('#cfg-audio-enabled', c.audio?.enabled !== false),
      model: val('#cfg-audio-model', c.audio?.model || 'qwen-audio-3.0-tts-plus'),
      instruction: String(val('#cfg-audio-instruction', c.audio?.instruction || '') || '').trim(),
      voice: String(val('#cfg-audio-voice', c.audio?.voice || '') || '').trim(),
      // 角色本音：实际发声音色的唯一真相源（配置里叫 gsvVoice，不是 audio.voice）
      gsvVoice: String(val('#cfg-audio-gsvvoice', c.audio?.gsvVoice || 'hutao') || 'hutao').trim(),
      gsvAllowModelPick: chk('#cfg-audio-gsvpick', c.audio?.gsvAllowModelPick === true),
      gsvAutoStart: chk('#cfg-audio-gsvautostart', c.audio?.gsvAutoStart !== false),
      maxChars: Math.max(10, Math.min(600, Number(val('#cfg-audio-maxchars', c.audio?.maxChars ?? 150)) || 150)),
      rvc: {
        ...curRvc,
        enabled: chk('#cfg-rvc-enabled', curRvc.enabled === true),
        model: val('#cfg-rvc-model', curRvc.model || 'hutao'),
        device: val('#cfg-rvc-device', curRvc.device || 'auto'),
        f0upKey: Math.max(-24, Math.min(24, Number(val('#cfg-rvc-f0up', curRvc.f0upKey ?? 0)) || 0)),
        method: val('#cfg-rvc-method', curRvc.method || 'rmvpe'),
        protect: Math.max(0, Math.min(0.5, Number(val('#cfg-rvc-protect', curRvc.protect ?? 0.33)) || 0.33)),
        indexRate: Math.max(0, Math.min(1, Number(val('#cfg-rvc-indexrate', curRvc.indexRate ?? 0.5)) || 0.5)),
        enhance: Math.max(0, Math.min(1, Number(val('#cfg-rvc-enhance', curRvc.enhance ?? 1)) || 1)),
        fallbackToRaw: chk('#cfg-rvc-fallback', curRvc.fallbackToRaw !== false),
        preferOverGsv: chk('#cfg-rvc-prefergsv', curRvc.preferOverGsv === true)
      },
      svc: {
        ...curSvc,
        enabled: chk('#cfg-svc-enabled', curSvc.enabled === true),
        mixInstrumental: chk('#cfg-svc-mixinstrumental', curSvc.mixInstrumental !== false),
        singDry: chk('#cfg-svc-singdry', curSvc.singDry !== false),
        coverDry: chk('#cfg-svc-coverdry', curSvc.coverDry !== false),
        allowImprovise: chk('#cfg-svc-improvise', curSvc.allowImprovise === true)
      }
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || '')
    };
  }

  if (sec === 'allow') {
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    patch.allowAllWhenEmpty = false;
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 1800;
    patch.directWakeDelayMs = Number(val('#cfg-directwakedelay', c.directWakeDelayMs)) || 500;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 800;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 8
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      checkIntervalMinMs: Number(val('#cfg-pro-min', c.proactive?.checkIntervalMinMs)) || 1800000,
      checkIntervalMaxMs: Number(val('#cfg-pro-max', c.proactive?.checkIntervalMaxMs)) || 5400000,
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25
    };
    patch.sticker = { ...c.sticker, enabled: chk('#cfg-sticker', c.sticker?.enabled !== false) };
    patch.store = {
      pastStateLimit: Math.min(500, Math.max(10, Number(val('#cfg-pastlimit', c.store?.pastStateLimit)) || 48)),
      pastStateMaxChars: Math.min(60000, Math.max(1000, Number(val('#cfg-pastchars', c.store?.pastStateMaxChars)) || 4000))
    };
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}

// ── 标签页切换 ──
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $(`#view-${tab.dataset.tab}`).classList.add('active');
    state.tab = tab.dataset.tab;
    if (state.tab === 'sessions') loadSessions();
    if (state.tab === 'chats') loadChats();
    if (state.tab === 'snowluma') loadSnowlumaPage();
    if (state.tab === 'settings') loadSettings();
  });
});

// ── 主题切换（玻璃拟态：浅色默认，可切深色；只影响本页，不改机器人任何行为）──
function initTheme() {
  const btn = $('#theme-btn');
  if (!btn) return;
  // 从 localStorage 恢复上次选择（默认浅色）
  const saved = (() => { try { return localStorage.getItem('qqagent-theme'); } catch { return null; } })();
  const theme = saved === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  btn.textContent = theme === 'dark' ? '☀' : '☾';
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    btn.textContent = next === 'dark' ? '☀' : '☾';
    try { localStorage.setItem('qqagent-theme', next); } catch { /* ignore */ }
  });
}

// ── 启动 ──
(async function init() {
  initTheme();
  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  loadSessions();
})();
