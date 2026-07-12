import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertDesktopPackagingNodeVersion,
  resolveElectronBuilderCli,
  supportsDesktopPackagingNode,
} from './package-runtime.mjs';

describe('desktop package runtime', () => {
  it('resolves electron-builder from the desktop workspace instead of assuming root hoisting', () => {
    expect(existsSync(resolveElectronBuilderCli())).toBe(true);
  });

  it('keeps the packaged Electron runtime aligned with the installed dependency', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

    expect(packageJson.build.electronVersion).toBe(packageJson.devDependencies.electron);
  });

  it('requires the Node baseline used by the secure desktop packaging toolchain', () => {
    expect(supportsDesktopPackagingNode('22.12.0')).toBe(true);
    expect(supportsDesktopPackagingNode('24.0.0')).toBe(true);
    expect(supportsDesktopPackagingNode('20.19.4')).toBe(false);
    expect(() => assertDesktopPackagingNodeVersion('20.9.0')).toThrow(/Node 22\.12\.0 or newer/);
  });

  it('pins repository and release workflows to Node 22 LTS or newer', () => {
    const rootPackage = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    const workflows = ['ci.yml', 'release.yml', 'android-apk.yml'].map((name) =>
      readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8'),
    );

    expect(rootPackage.engines.node).toBe('>=22.12.0');
    for (const workflow of workflows) {
      expect(workflow).not.toMatch(/node-version:\s*['"]?20/);
      expect(workflow).toContain("node-version: '22.23.1'");
    }
  });
});
