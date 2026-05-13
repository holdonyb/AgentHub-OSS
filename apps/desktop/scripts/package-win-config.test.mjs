import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR,
  DEFAULT_ELECTRON_MIRROR,
  buildDesktopPackagingEnv,
  electronArchiveName,
  electronArchiveUrl,
} from './package-win-config.mjs';

describe('desktop packaging mirror config', () => {
  it('defaults Electron downloads to China-friendly mirrors', () => {
    const env = buildDesktopPackagingEnv({});

    expect(env.ELECTRON_MIRROR).toBe(DEFAULT_ELECTRON_MIRROR);
    expect(env.npm_config_electron_mirror).toBe(DEFAULT_ELECTRON_MIRROR);
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe(DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR);
  });

  it('respects explicit standard mirror variables', () => {
    const env = buildDesktopPackagingEnv({
      ELECTRON_MIRROR: 'https://example.com/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://example.com/builder/',
    });

    expect(env.ELECTRON_MIRROR).toBe('https://example.com/electron/');
    expect(env.npm_config_electron_mirror).toBe('https://example.com/electron/');
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe('https://example.com/builder/');
  });

  it('accepts AgentHub-specific mirror overrides when standard variables are absent', () => {
    const env = buildDesktopPackagingEnv({
      AGENTHUB_ELECTRON_MIRROR: 'https://agenthub.example.com/electron/',
      AGENTHUB_ELECTRON_BUILDER_BINARIES_MIRROR: 'https://agenthub.example.com/builder/',
    });

    expect(env.ELECTRON_MIRROR).toBe('https://agenthub.example.com/electron/');
    expect(env.npm_config_electron_mirror).toBe('https://agenthub.example.com/electron/');
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe('https://agenthub.example.com/builder/');
  });

  it('builds Electron archive names and mirror URLs for electron-builder cache prewarm', () => {
    expect(electronArchiveName({ version: '36.2.1' })).toBe('electron-v36.2.1-win32-x64.zip');
    expect(electronArchiveUrl({ mirror: 'https://mirror.example.com/electron', version: '36.2.1' })).toBe(
      'https://mirror.example.com/electron/36.2.1/electron-v36.2.1-win32-x64.zip',
    );
  });
});
