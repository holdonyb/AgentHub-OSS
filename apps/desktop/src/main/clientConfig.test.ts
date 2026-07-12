import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, resolveStartupConsoleTarget } from './clientConfig';

describe('AgentHub desktop client config', () => {
  it('normalizes valid http and https server URLs', () => {
    expect(normalizeServerUrl(' https://agenthub.example.com/control/ ')).toBe('https://agenthub.example.com/control');
    expect(normalizeServerUrl('http://100.99.254.119:8019')).toBe('http://100.99.254.119:8019');
  });

  it('rejects invalid or unsupported server URLs', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeServerUrl('ftp://agenthub.example.com')).toBeNull();
    expect(normalizeServerUrl('not-a-url')).toBeNull();
  });

  it('prefers explicit CLI and environment configuration over the stored server URL', () => {
    expect(
      resolveStartupConsoleTarget({
        argv: ['electron', '.', '--url=https://cli.example.com/console/'],
        env: {
          AGENTHUB_DESKTOP_URL: 'https://desktop.example.com',
          AGENTHUB_PUBLIC_BASE_URL: 'https://public.example.com',
        },
        storedUrl: 'https://stored.example.com',
      }),
    ).toEqual({ source: 'argv', consoleUrl: 'https://cli.example.com/console', locked: true });

    expect(
      resolveStartupConsoleTarget({
        argv: ['electron', '.'],
        env: {
          AGENTHUB_DESKTOP_URL: 'https://desktop.example.com',
          AGENTHUB_PUBLIC_BASE_URL: 'https://public.example.com',
        },
        storedUrl: 'https://stored.example.com',
      }),
    ).toEqual({ source: 'desktop_env', consoleUrl: 'https://desktop.example.com', locked: true });

    expect(
      resolveStartupConsoleTarget({
        argv: ['electron', '.'],
        env: {},
        storedUrl: 'https://stored.example.com',
      }),
    ).toEqual({ source: 'stored', consoleUrl: 'https://stored.example.com', locked: false });
  });

  it('requires first-launch setup when no usable server URL exists', () => {
    expect(resolveStartupConsoleTarget({ argv: ['electron', '.'], env: {}, storedUrl: null })).toEqual({
      source: 'setup',
      consoleUrl: null,
      locked: false,
    });
  });
});
