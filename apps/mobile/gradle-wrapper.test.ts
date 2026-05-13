import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Android Gradle wrapper', () => {
  it('is tracked as executable for Linux CI runners', () => {
    const stage = execFileSync(
      'git',
      ['ls-files', '--stage', 'apps/mobile/android/gradlew'],
      { cwd: new URL('../..', import.meta.url), encoding: 'utf-8' },
    );

    expect(stage.split(/\s+/)[0]).toBe('100755');
  });

  it('uses a project-local Gradle user home to avoid global Windows lock conflicts', () => {
    const buildScript = readFileSync(
      new URL('scripts/build-apk.mjs', import.meta.url),
      'utf-8',
    );

    expect(buildScript).toContain('GRADLE_USER_HOME');
    expect(buildScript).toContain('AGENTHUB_GRADLE_USER_HOME');
    expect(buildScript).toContain('buildEnv.AGENTHUB_GRADLE_USER_HOME || buildEnv.GRADLE_USER_HOME');
    expect(buildScript).toContain('.runtime');
    expect(buildScript).toContain('gradle-home');
  });
});
