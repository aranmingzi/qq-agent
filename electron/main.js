import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, session, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installCallMediaHandlers as installCallMedia } from '../src/call-media.js';

app.setName('QQ Agent');
app.setAppUserModelId('com.qqagent.desktop');
app.disableHardwareAcceleration();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
const ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
const APP_ICON = fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG;
// 便携版（包根有 portable.flag）：Electron 私有数据（缓存、GPU 缓存、单实例锁）收回包内。
// 这样换电脑直接拷文件夹，也不会和同一台机器上的另一个副本抢同一把锁。
if (fs.existsSync(path.join(ROOT, 'portable.flag'))) {
  const portableUserData = path.join(ROOT, 'data', 'electron');
  try {
    fs.mkdirSync(portableUserData, { recursive: true });
    app.setPath('userData', portableUserData);
  } catch (error) {
    console.warn('[portable] userData 重定向失败，退回默认目录：', error?.message);
  }
}
// 新版 React 控制台是默认入口；QQAGENT_UI=legacy 可临时回退旧版。
const UI_PREFIX = process.env.QQAGENT_UI === 'legacy' ? '/legacy/' : '/console/';
const uiUrl = (port) => `http://127.0.0.1:${port}${UI_PREFIX}`;

let mainWindow = null;
let core = null;
let tray = null;
let quitting = false;

// 单实例锁：正常双击只允许一个实例；但"重启"时 app.relaunch 会**先起新进程**，
// 旧进程还要 120ms 才退，新进程这时拿不到锁。早期写法直接 app.quit()，
// 结果"重启"变成"静默关掉、再也起不来"（日志里只有 exit 0，没有任何输出，很难查）。
// 所以拿不到锁时先重试等旧进程释放，实在等不到才退。
let gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  for (let i = 0; i < 24 && !gotLock; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    gotLock = app.requestSingleInstanceLock();
  }
  if (gotLock) console.log('[lock] 重启中：等旧实例释放后拿到单实例锁');
}
if (!gotLock) {
  console.warn('[lock] 已有实例在运行，本进程退出');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({
    openAtLogin: !!cfg.server?.autoStart,
    path: process.execPath,
    args: [ROOT]
  });
}

function showWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
    return;
  }
  createWindow(core?.lastPort ?? 3210);
}

function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON);
  tray = new Tray(icon);
  tray.setToolTip('QQ Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    {
      label: '暂停 / 恢复',
      click: () => {
        if (!core) return;
        core.orchestrator.setPaused(!core.orchestrator.paused);
      }
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!core?.getConfig().server?.autoStart,
      click: (item) => {
        if (!core) return;
        core.updateConfig({ server: { autoStart: item.checked } });
        applyAutoStart();
      }
    },
    { type: 'separator' },
    {
      label: '重启 QQ Agent',
      click: () => {
        if (!core) return;
        Promise.resolve(core.restart({ reason: '托盘菜单' })).catch((error) => {
          console.error('[tray] restart failed:', error);
        });
      }
    },
    { type: 'separator' },
    {
      label: '退出 QQ Agent',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('double-click', () => showWindow());
}

/**
 * 编辑菜单（Electron 角色项）：保证 Ctrl/Cmd + C/V/X/A/Z 在输入框、消息区都能用。
 * 菜单栏本身由 BrowserWindow 的 autoHideMenuBar 隐藏，不占界面（按 Alt 才会露出来）。
 */
function installEditMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    }
  ]));
}

/**
 * 给「耳朵」开口子：允许渲染进程用 getDisplayMedia 抓系统混音（loopback）。
 *
 * 逻辑本体在 src/call-media.js（那边能用假 session 真跑测试，
 * 这里只负责把 Electron 的 session 递进去）。
 */
function installCallMediaHandlers() {
  const handlers = installCallMedia({
    session: session.defaultSession,
    log: (...args) => console.log(...args)
  });
  console.log('[通话] 媒体权限处理器已安装（loopback 系统混音采集）');
  return handlers;
}

/** 右键菜单：Electron 默认没有，所以"右键复制/粘贴"必须自己挂。 */
function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];
    const hasSelection = String(params.selectionText || '').trim().length > 0;
    if (params.isEditable) {
      items.push({ role: 'cut', label: '剪切', enabled: params.editFlags ? params.editFlags.canCut : true });
      items.push({ role: 'copy', label: '复制', enabled: params.editFlags ? params.editFlags.canCopy : true });
      items.push({ role: 'paste', label: '粘贴', enabled: params.editFlags ? params.editFlags.canPaste : true });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: '全选' });
    } else if (hasSelection) {
      items.push({ role: 'copy', label: '复制' });
      items.push({
        label: '复制（去掉换行）',
        click: () => clipboard.writeText(String(params.selectionText).replace(/\s*\n\s*/g, ' '))
      });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: '全选' });
    } else {
      items.push({ role: 'selectAll', label: '全选' });
    }
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow(port) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'QQ Agent',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#080b11' : '#f8fafc',
    autoHideMenuBar: true,
    icon: APP_ICON,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  installEditMenu();
  attachContextMenu(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[window] load failed:', code, desc);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(uiUrl(port)).catch(() => {});
      }
    }, 1500);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] renderer gone:', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.on('close', (event) => {
    if (!quitting && core?.getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(uiUrl(port)).catch((error) => {
    console.error('[window] loadURL failed:', error);
  });
  return mainWindow;
}

app.whenReady().then(async () => {
  try {
    await session.defaultSession.setProxy({ mode: 'direct' });
    // 语音通话的「耳朵」要抓系统混音，必须先把 display-capture 的权限口子开对。
    // 放在 createApp 之前：控制台页面一起来就可能要开麦。
    try {
      installCallMediaHandlers();
    } catch (error) {
      console.warn('[call] 媒体权限处理器安装失败（语音通话的耳朵会不可用）：', error?.message ?? error);
    }
    const { createApp } = await import('../src/app.js');
    core = createApp({
      log: (...args) => console.log(...args),
      // 面板/托盘点"重启"时由 core.restart() 调用：停服完成后 Electron 自己换一个新进程
      restartHook: () => {
        quitting = true;
        const args = process.argv.slice(1);
        try {
          console.log('[restart] 交给 Electron 换进程，args =', JSON.stringify(args));
          app.relaunch(args.length ? { args } : {});
        } catch (error) {
          console.error('[restart] app.relaunch failed:', error);
        }
        // 给新进程一点时间先把单实例锁的等待逻辑挂上，再退自己
        setTimeout(() => app.exit(0), 400);
      }
    });
    const port = await core.start();
    core.lastPort = port;
    applyAutoStart();
    createWindow(port);
    createTray();
  } catch (error) {
    console.error('[electron] startup failed:', error);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  try { core?.stop(); } catch { /* ignore */ }
});
