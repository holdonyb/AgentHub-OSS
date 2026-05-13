import type { BrowserWindowConstructorOptions } from 'electron';
import { resolveStartupConsoleTarget } from './clientConfig.js';

export function resolveDefaultConsoleUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  return resolveStartupConsoleTarget({ env, argv: [], storedUrl: null }).consoleUrl;
}

export function resolveConsoleUrl({
  env = process.env,
  argv = process.argv,
  storedUrl = null,
}: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  argv?: string[];
  storedUrl?: string | null;
} = {}): string | null {
  return resolveStartupConsoleTarget({ env, argv, storedUrl }).consoleUrl;
}

export function buildConsoleUrl(baseUrl: string, view: 'main' | 'island'): string {
  const url = new URL(baseUrl);
  if (view === 'island') {
    url.searchParams.set('view', 'island');
  }
  return url.toString().replace(/\/$/, '');
}

export function createWindowOptions({
  kind,
  preloadPath,
}: {
  kind: 'main' | 'island' | 'setup';
  preloadPath: string;
}): BrowserWindowConstructorOptions {
  const common: BrowserWindowConstructorOptions = {
    show: false,
    backgroundColor: '#f5f7fa',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };

  if (kind === 'island') {
    return {
      ...common,
      width: 460,
      height: 740,
      minWidth: 360,
      minHeight: 520,
      title: 'AgentHub Island',
      frame: true,
      alwaysOnTop: true,
      skipTaskbar: true,
    };
  }

  if (kind === 'setup') {
    return {
      ...common,
      width: 560,
      height: 440,
      minWidth: 460,
      minHeight: 360,
      title: 'AgentHub Server',
      frame: true,
      resizable: true,
    };
  }

  return {
    ...common,
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: 'AgentHub',
  };
}
