import type { BrowserWindowConstructorOptions } from 'electron';

export const DEFAULT_CONSOLE_URL = 'https://agenthub.example.com';

export function resolveConsoleUrl({
  env = process.env,
  argv = process.argv,
}: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  argv?: string[];
} = {}): string {
  const argValue = argv
    .map((value) => value.trim())
    .find((value) => value.startsWith('--url='))
    ?.slice('--url='.length);
  const value = (argValue || env.AGENTHUB_DESKTOP_URL || DEFAULT_CONSOLE_URL).trim();
  return value.replace(/\/$/, '');
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
  kind: 'main' | 'island';
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

  return {
    ...common,
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: 'AgentHub',
  };
}
