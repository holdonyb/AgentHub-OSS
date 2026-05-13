import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentHubDesktop', {
  getConfig: () =>
    ipcRenderer.invoke('agenthub:getConfig') as Promise<{
      consoleUrl: string | null;
      platform: string;
      configSource: string;
      configLocked: boolean;
      requiresSetup: boolean;
    }>,
  saveServerUrl: (url: string) => ipcRenderer.invoke('agenthub:saveServerUrl', url) as Promise<{ ok: boolean; error?: string }>,
  clearServerUrl: () => ipcRenderer.invoke('agenthub:clearServerUrl') as Promise<boolean>,
  showMain: () => ipcRenderer.invoke('agenthub:showMain') as Promise<void>,
  showIsland: () => ipcRenderer.invoke('agenthub:showIsland') as Promise<void>,
  openExternalConsole: () => ipcRenderer.invoke('agenthub:openExternalConsole') as Promise<void>,
});
