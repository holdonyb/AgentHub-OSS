import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR,
  DEFAULT_ELECTRON_MIRROR,
  buildDesktopPackagingEnv,
  electronArchiveName,
  electronArchiveUrl,
  normalizeMirrorUrl,
} from './package-win-config.mjs';

describe('package-win-config', () => {
  it('normalizes mirror URLs', () => {
    expect(normalizeMirrorUrl('https://example.com/mirror')).toBe('https://example.com/mirror/');
    expect(normalizeMirrorUrl('https://example.com/mirror/')).toBe('https://example.com/mirror/');
  });

  it('builds archive names and URLs', () => {
    expect(electronArchiveName({ version: '36.2.1' })).toBe('electron-v36.2.1-win32-x64.zip');
    expect(
      electronArchiveUrl({
        mirror: 'https://example.com/electron',
        version: '36.2.1',
      }),
    ).toBe('https://example.com/electron/36.2.1/electron-v36.2.1-win32-x64.zip');
  });

  it('uses public defaults when overrides are absent', () => {
    const env = buildDesktopPackagingEnv({});
    expect(env.ELECTRON_MIRROR).toBe(DEFAULT_ELECTRON_MIRROR);
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe(DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR);
  });

  it('prefers AgentHub-specific overrides', () => {
    const env = buildDesktopPackagingEnv({
      AGENTHUB_ELECTRON_MIRROR: 'https://override.example/electron',
      AGENTHUB_ELECTRON_BUILDER_BINARIES_MIRROR: 'https://override.example/builder',
    });
    expect(env.ELECTRON_MIRROR).toBe('https://override.example/electron');
    expect(env.ELECTRON_BUILDER_BINARIES_MIRROR).toBe('https://override.example/builder');
  });

  it('uses the AgentHub brand icon for Windows packages', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

    expect(packageJson.build.files).toContain('assets/icon.ico');
    expect(packageJson.build.win.icon).toBe('assets/icon.ico');
  });

  it('passes optional Windows signing credentials to the release runner', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('CSC_LINK: ${{ secrets.AGENTHUB_WINDOWS_CSC_LINK }}');
    expect(workflow).toContain('CSC_KEY_PASSWORD: ${{ secrets.AGENTHUB_WINDOWS_CSC_KEY_PASSWORD }}');
  });
});
