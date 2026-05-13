import { describe, expect, it } from 'vitest';
import {
  buildConsoleUrl,
  createWindowOptions,
  resolveDefaultConsoleUrl,
  resolveConsoleUrl,
} from './windowConfig';

describe('AgentHub desktop window config', () => {
  it('requires setup when no public or stored console URL is configured', () => {
    expect(resolveDefaultConsoleUrl({})).toBeNull();
    expect(resolveConsoleUrl({ env: {}, argv: ['node', 'agenthub'] })).toBeNull();
  });

  it('allows shared public or desktop-specific console override without query loss', () => {
    expect(
      resolveDefaultConsoleUrl({
        AGENTHUB_PUBLIC_BASE_URL: 'https://agenthub.example.com/base/',
      }),
    ).toBe('https://agenthub.example.com/base');
    expect(
      resolveConsoleUrl({
        env: { AGENTHUB_DESKTOP_URL: 'http://100.99.254.119:8019/base?token=kept' },
        argv: ['node', 'agenthub'],
      }),
    ).toBe('http://100.99.254.119:8019/base?token=kept');
    expect(buildConsoleUrl('https://agenthub.example.com/app?x=1', 'island')).toBe(
      'https://agenthub.example.com/app?x=1&view=island',
    );
  });

  it('uses isolated browser windows with preload and no Node integration', () => {
    const options = createWindowOptions({ kind: 'main', preloadPath: 'E:/Work/AgentHub/apps/desktop/dist/main/preload.cjs' });

    expect(options.title).toBe('AgentHub');
    expect(options.webPreferences?.preload).toContain('preload.cjs');
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.sandbox).toBe(false);
  });

  it('creates a compact always-on-top island window', () => {
    const options = createWindowOptions({ kind: 'island', preloadPath: 'preload.cjs' });

    expect(options.title).toBe('AgentHub Island');
    expect(options.alwaysOnTop).toBe(true);
    expect(options.skipTaskbar).toBe(true);
    expect(options.width).toBeLessThan(520);
  });

  it('creates a setup window for first-launch server configuration', () => {
    const options = createWindowOptions({ kind: 'setup', preloadPath: 'preload.cjs' });

    expect(options.title).toBe('AgentHub Server');
    expect(options.width).toBeGreaterThan(500);
    expect(options.webPreferences?.contextIsolation).toBe(true);
  });
});
