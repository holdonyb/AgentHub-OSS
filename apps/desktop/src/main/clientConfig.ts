import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG_FILENAME = 'agenthub-desktop.json';

export type StartupConsoleSource = 'stored' | 'argv' | 'desktop_env' | 'public_env' | 'setup';

export type StartupConsoleTarget = {
  source: StartupConsoleSource;
  consoleUrl: string | null;
  locked: boolean;
};

export function normalizeServerUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function argvUrl(argv: string[]): string | null {
  return argv
    .map((value) => value.trim())
    .find((value) => value.startsWith('--url='))
    ?.slice('--url='.length) ?? null;
}

export function resolveStartupConsoleTarget({
  argv = process.argv,
  env = process.env,
  storedUrl,
}: {
  argv?: string[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  storedUrl?: string | null;
} = {}): StartupConsoleTarget {
  const candidates: Array<[StartupConsoleSource, string | null | undefined, boolean]> = [
    ['stored', storedUrl, false],
    ['argv', argvUrl(argv), true],
    ['desktop_env', env.AGENTHUB_DESKTOP_URL, true],
    ['public_env', env.AGENTHUB_PUBLIC_BASE_URL, true],
  ];

  for (const [source, value, locked] of candidates) {
    const consoleUrl = normalizeServerUrl(value);
    if (consoleUrl) return { source, consoleUrl, locked };
  }

  return { source: 'setup', consoleUrl: null, locked: false };
}

export function desktopConfigPath(userDataPath: string): string {
  return path.join(userDataPath, CONFIG_FILENAME);
}

export function readStoredServerUrl(userDataPath: string): string | null {
  const filePath = desktopConfigPath(userDataPath);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { serverUrl?: unknown };
    return typeof parsed.serverUrl === 'string' ? normalizeServerUrl(parsed.serverUrl) : null;
  } catch {
    return null;
  }
}

export function writeStoredServerUrl(userDataPath: string, serverUrl: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  if (!normalized) throw new Error('Invalid AgentHub server URL');
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(desktopConfigPath(userDataPath), `${JSON.stringify({ serverUrl: normalized }, null, 2)}\n`, 'utf-8');
  return normalized;
}

export function clearStoredServerUrl(userDataPath: string): void {
  const filePath = desktopConfigPath(userDataPath);
  if (existsSync(filePath)) rmSync(filePath);
}
