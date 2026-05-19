import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentHubDesktop', {
  getConfig: () => ipcRenderer.invoke('agenthub:getConfig') as Promise<{ consoleUrl: string; platform: string }>,
  showMain: () => ipcRenderer.invoke('agenthub:showMain') as Promise<void>,
  showIsland: () => ipcRenderer.invoke('agenthub:showIsland') as Promise<void>,
  openExternalConsole: () => ipcRenderer.invoke('agenthub:openExternalConsole') as Promise<void>,
});
