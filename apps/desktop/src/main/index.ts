import path from 'node:path';
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
import {
  clearStoredServerUrl,
  readStoredServerUrl,
  resolveStartupConsoleTarget,
  writeStoredServerUrl,
} from './clientConfig.js';
import {
  buildConsoleUrl,
  createWindowOptions,
  isTrustedConsoleNavigation,
  resolveConsoleUrl,
} from './windowConfig.js';

let mainWindow: BrowserWindow | null = null;
let islandWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

let consoleUrl: string | null = resolveConsoleUrl();
let configLocked = false;
let configSource = 'setup';
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function createIcon(): Electron.NativeImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <defs>
        <linearGradient id="agenthubTrayGradient" gradientUnits="userSpaceOnUse" x1="3.91" y1="16" x2="28.09" y2="16">
          <stop offset="0" stop-color="#79D1FF"/>
          <stop offset="1" stop-color="#3EA5FF"/>
        </linearGradient>
      </defs>
      <g transform="rotate(-45 16 16)" fill="url(#agenthubTrayGradient)">
        <path d="M10.88 7.31h3.5v17.38h-3.5z"/>
        <path d="M3.91 14.25h10.47v3.5H3.91z"/>
        <path d="M17.63 7.31h3.5v17.38h-3.5z"/>
        <path d="M17.63 14.25h10.47v3.5h-10.47z"/>
      </g>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function preloadPath(): string {
  return path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs');
}

function loadConsole(window: BrowserWindow, view: 'main' | 'island'): void {
  if (!consoleUrl) {
    showSetup();
    return;
  }
  void window.loadURL(buildConsoleUrl(consoleUrl, view));
}

function openExternalUrl(url: string): void {
  try {
    const target = new URL(url);
    if (target.protocol === 'http:' || target.protocol === 'https:') {
      void shell.openExternal(target.toString());
    }
  } catch {
    // Invalid navigation targets are ignored.
  }
}

function protectConsoleNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (consoleUrl && isTrustedConsoleNavigation(url, consoleUrl)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

function setupHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentHub Server</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e5edf7; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100vw - 48px)); }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0 0 22px; color: #94a3b8; line-height: 1.5; }
    label { display: block; margin-bottom: 8px; color: #cbd5e1; font-size: 13px; }
    input { box-sizing: border-box; width: 100%; padding: 13px 14px; border-radius: 8px; border: 1px solid #334155; background: #111827; color: #f8fafc; font-size: 15px; outline: none; }
    input:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18); }
    button { margin-top: 14px; width: 100%; border: 0; border-radius: 8px; padding: 12px 14px; background: #2563eb; color: white; font-size: 15px; font-weight: 650; cursor: pointer; }
    .error { min-height: 20px; margin-top: 10px; color: #fca5a5; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>AgentHub</h1>
    <p>连接到你的 self-host AgentHub 服务器。</p>
    <form id="form">
      <label for="server">服务器地址</label>
      <input id="server" type="url" placeholder="https://agenthub.example.com" autocomplete="url" autofocus />
      <button type="submit">继续</button>
      <div id="error" class="error"></div>
    </form>
  </main>
  <script>
    const form = document.getElementById('form');
    const input = document.getElementById('server');
    const error = document.getElementById('error');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      const result = await window.agentHubDesktop.saveServerUrl(input.value);
      if (!result.ok) error.textContent = result.error || '服务器地址不可用';
    });
  </script>
</body>
</html>`;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions({ kind: 'main', preloadPath: preloadPath() }));
  protectConsoleNavigation(window);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.on('close', (event) => {
    if (!(app as typeof app & { isQuiting?: boolean }).isQuiting) {
      event.preventDefault();
      window.hide();
    }
  });
  loadConsole(window, 'main');
  return window;
}

function createIslandWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions({ kind: 'island', preloadPath: preloadPath() }));
  protectConsoleNavigation(window);
  window.on('closed', () => {
    if (islandWindow === window) islandWindow = null;
  });
  window.on('close', (event) => {
    if (!(app as typeof app & { isQuiting?: boolean }).isQuiting) {
      event.preventDefault();
      window.hide();
    }
  });
  loadConsole(window, 'island');
  return window;
}

function ensureMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  return mainWindow;
}

function ensureIslandWindow(): BrowserWindow {
  if (!islandWindow || islandWindow.isDestroyed()) {
    islandWindow = createIslandWindow();
  }
  return islandWindow;
}

function ensureSetupWindow(): BrowserWindow {
  if (!setupWindow || setupWindow.isDestroyed()) {
    const window = new BrowserWindow(createWindowOptions({ kind: 'setup', preloadPath: preloadPath() }));
    setupWindow = window;
    window.on('closed', () => {
      if (setupWindow === window) setupWindow = null;
    });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(setupHtml())}`);
  }
  return setupWindow;
}

function showSetup(): void {
  const window = ensureSetupWindow();
  window.show();
  window.focus();
}

function showMain(): void {
  if (!consoleUrl) {
    showSetup();
    return;
  }
  const window = ensureMainWindow();
  window.show();
  window.focus();
}

function showIsland(): void {
  if (!consoleUrl) {
    showSetup();
    return;
  }
  const window = ensureIslandWindow();
  window.show();
  window.focus();
}

function updateMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'AgentHub',
      submenu: [
        { label: '打开控制台', click: showMain },
        { label: '打开 AgentHub Island', click: showIsland },
        { label: '服务器设置', click: showSetup },
        { label: '在浏览器打开', click: () => (consoleUrl ? void shell.openExternal(consoleUrl) : showSetup()) },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            (app as typeof app & { isQuiting?: boolean }).isQuiting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateTray(): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开控制台', click: showMain },
    { label: '打开 AgentHub Island', click: showIsland },
    { label: '服务器设置', click: showSetup },
    { label: '在浏览器打开', click: () => (consoleUrl ? void shell.openExternal(consoleUrl) : showSetup()) },
    { type: 'separator' },
    {
      label: '退出 AgentHub',
      click: () => {
        (app as typeof app & { isQuiting?: boolean }).isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

async function boot(): Promise<void> {
  app.setAppUserModelId('xin.ifix.agenthub.desktop');
  const target = resolveStartupConsoleTarget({
    argv: process.argv,
    env: process.env,
    storedUrl: readStoredServerUrl(app.getPath('userData')),
  });
  consoleUrl = target.consoleUrl;
  configLocked = target.locked;
  configSource = target.source;
  updateMenu();
  tray = new Tray(createIcon());
  tray.setToolTip('AgentHub');
  tray.on('click', showIsland);
  updateTray();
  if (consoleUrl) {
    ensureMainWindow();
    ensureIslandWindow();
    showMain();
  } else {
    showSetup();
  }
}

app.whenReady().then(boot);
app.on('second-instance', showMain);
app.on('activate', showMain);
app.on('window-all-closed', () => {
  // Keep tray app alive.
});

ipcMain.handle('agenthub:getConfig', () => ({
  consoleUrl,
  platform: process.platform,
  configSource,
  configLocked,
  requiresSetup: !consoleUrl,
}));
ipcMain.handle('agenthub:saveServerUrl', (_event, value: string) => {
  try {
    if (configLocked) return { ok: false, error: '当前地址由启动参数或环境变量锁定' };
    consoleUrl = writeStoredServerUrl(app.getPath('userData'), value);
    configLocked = false;
    configSource = 'stored';
    setupWindow?.close();
    setupWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) loadConsole(mainWindow, 'main');
    if (islandWindow && !islandWindow.isDestroyed()) loadConsole(islandWindow, 'island');
    updateMenu();
    updateTray();
    showMain();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid AgentHub server URL' };
  }
});
ipcMain.handle('agenthub:clearServerUrl', () => {
  if (configLocked) return false;
  clearStoredServerUrl(app.getPath('userData'));
  const target = resolveStartupConsoleTarget({
    argv: process.argv,
    env: process.env,
    storedUrl: null,
  });
  consoleUrl = target.consoleUrl;
  configLocked = target.locked;
  configSource = target.source;
  setupWindow?.close();
  setupWindow = null;
  if (consoleUrl) {
    if (mainWindow && !mainWindow.isDestroyed()) loadConsole(mainWindow, 'main');
    if (islandWindow && !islandWindow.isDestroyed()) loadConsole(islandWindow, 'island');
    showMain();
  } else {
    mainWindow?.destroy();
    islandWindow?.destroy();
    mainWindow = null;
    islandWindow = null;
    showSetup();
  }
  return true;
});
ipcMain.handle('agenthub:showMain', () => showMain());
ipcMain.handle('agenthub:showIsland', () => showIsland());
ipcMain.handle('agenthub:openExternalConsole', () => (consoleUrl ? shell.openExternal(consoleUrl) : showSetup()));
