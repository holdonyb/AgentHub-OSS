import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { macArtifactName, macBuilderArgs } from './package-mac-config.mjs';

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
    ]);
    expect(macArtifactName('0.1.4', 'arm64', 'dmg')).toBe('AgentHub-0.1.4-macos-arm64.dmg');
  });

  it('does not disable signing when Apple credentials are supplied', () => {
    expect(macBuilderArgs({ signed: true })).not.toContain('--config.mac.identity=null');
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
    expect(workflow).toContain('name: agenthub-desktop-macos');
    expect(workflow).toContain('- build-macos-desktop');
  });
});
