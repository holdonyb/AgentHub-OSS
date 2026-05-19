import path from 'node:path';
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } from 'electron';
import { buildConsoleUrl, createWindowOptions, resolveConsoleUrl } from './windowConfig.js';

let mainWindow: BrowserWindow | null = null;
let islandWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const consoleUrl = resolveConsoleUrl();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function createIcon(): Electron.NativeImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
      <rect width="32" height="32" rx="8" fill="#0f172a"/>
      <path d="M8 10h16v12H8z" fill="#f8fafc"/>
      <path d="M11 14l3 2-3 2" fill="none" stroke="#0f766e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 19h5" stroke="#2563eb" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function preloadPath(): string {
  return path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs');
}

function loadConsole(window: BrowserWindow, view: 'main' | 'island'): void {
  void window.loadURL(buildConsoleUrl(consoleUrl, view));
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions({ kind: 'main', preloadPath: preloadPath() }));
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

function showMain(): void {
  const window = ensureMainWindow();
  window.show();
  window.focus();
}

function showIsland(): void {
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
        { label: '在浏览器打开', click: () => void shell.openExternal(consoleUrl) },
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
    { label: '在浏览器打开', click: () => void shell.openExternal(consoleUrl) },
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
  updateMenu();
  tray = new Tray(createIcon());
  tray.setToolTip('AgentHub');
  tray.on('click', showIsland);
  updateTray();
  ensureMainWindow();
  ensureIslandWindow();
  showMain();
}

app.whenReady().then(boot);
app.on('second-instance', showMain);
app.on('activate', showMain);
app.on('window-all-closed', () => {
  // Keep tray app alive.
});

ipcMain.handle('agenthub:getConfig', () => ({ consoleUrl, platform: process.platform }));
ipcMain.handle('agenthub:showMain', () => showMain());
ipcMain.handle('agenthub:showIsland', () => showIsland());
ipcMain.handle('agenthub:openExternalConsole', () => shell.openExternal(consoleUrl));
