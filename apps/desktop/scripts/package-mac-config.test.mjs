import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hasNotarizationCredentials, macArtifactName, macBuilderArgs } from './package-mac-config.mjs';

describe('package-mac-config', () => {
  it('builds unsigned dmg and zip artifacts for both supported architectures', () => {
    expect(macBuilderArgs({ signed: false })).toEqual([
      '--mac',
      'dmg',
      'zip',
      '--x64',
      '--arm64',
      '--publish',
      'never',
      '--config.mac.identity=null',
      '--config.mac.hardenedRuntime=false',
      '--config.mac.notarize=false',
    ]);
    expect(macArtifactName('1.0.0', 'arm64', 'dmg')).toBe('AgentHub-1.0.0-macos-arm64.dmg');
  });

  it('does not disable signing when Apple credentials are supplied', () => {
    expect(macBuilderArgs({ signed: true, notarized: false })).not.toContain('--config.mac.identity=null');
    expect(macBuilderArgs({ signed: true, notarized: false })).toContain('--config.mac.notarize=false');
  });

  it('enables notarization only with a signed build and complete Apple credentials', () => {
    expect(
      hasNotarizationCredentials({
        APPLE_ID: 'release@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
        APPLE_TEAM_ID: 'TEAM123456',
      }),
    ).toBe(true);
    expect(hasNotarizationCredentials({ APPLE_ID: 'release@example.com' })).toBe(false);
    expect(macBuilderArgs({ signed: true, notarized: true })).toContain('--config.mac.notarize=true');
    expect(() => macBuilderArgs({ signed: false, notarized: true })).toThrow(/signed build/i);
  });

  it('declares macOS packaging metadata and scripts', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts['package:mac']).toBe('npm run build && node scripts/package-mac.mjs');
    expect(packageJson.build.mac.target).toEqual(['dmg', 'zip']);
    expect(packageJson.build.mac.artifactName).toBe('AgentHub-${version}-macos-${arch}.${ext}');
    expect(packageJson.build.files).toContain('assets/icon.png');
  });

  it('builds and publishes macOS artifacts from a native runner', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('build-macos-desktop:');
    expect(workflow).toContain('runs-on: macos-latest');
    expect(workflow).toContain('npm run desktop:package:mac');
    expect(workflow).toContain('npm run mobile:native:build:ios');
    expect(workflow).toContain('name: agenthub-desktop-macos');
    expect(workflow).toContain('- build-macos-desktop');
    expect(workflow).toContain('CSC_LINK: ${{ secrets.AGENTHUB_MACOS_CSC_LINK }}');
    expect(workflow).toContain('CSC_KEY_PASSWORD: ${{ secrets.AGENTHUB_MACOS_CSC_KEY_PASSWORD }}');
    expect(workflow).toContain('APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.AGENTHUB_APPLE_APP_SPECIFIC_PASSWORD }}');
    expect(workflow).not.toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");

    const ciWorkflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ciWorkflow).toContain('npm run mobile:native:build:ios');
  });
});
