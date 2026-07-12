import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  androidGradleExecutable,
  missingAndroidSigningEnvironment,
} from '../../mobile-native/scripts/native-build-config.mjs';

describe('native mobile build configuration', () => {
  it('requires every Android release signing value', () => {
    expect(missingAndroidSigningEnvironment({})).toEqual([
      'AGENTHUB_ANDROID_KEYSTORE_FILE',
      'AGENTHUB_ANDROID_KEYSTORE_PASSWORD',
      'AGENTHUB_ANDROID_KEY_ALIAS',
      'AGENTHUB_ANDROID_KEY_PASSWORD',
    ]);
    expect(
      missingAndroidSigningEnvironment({
        AGENTHUB_ANDROID_KEYSTORE_FILE: 'key.jks',
        AGENTHUB_ANDROID_KEYSTORE_PASSWORD: 'store-password',
        AGENTHUB_ANDROID_KEY_ALIAS: 'upload',
        AGENTHUB_ANDROID_KEY_PASSWORD: 'key-password',
      }),
    ).toEqual([]);
  });

  it('uses the platform-native Gradle wrapper', () => {
    expect(androidGradleExecutable('win32')).toBe('gradlew.bat');
    expect(androidGradleExecutable('linux')).toBe('./gradlew');
    expect(androidGradleExecutable('darwin')).toBe('./gradlew');
  });

  it('exposes separate debug and signed release Android build commands', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../mobile-native/package.json', import.meta.url), 'utf8'),
    );

    expect(packageJson.scripts['build:android:debug']).toBe(
      'node scripts/build-android-debug.mjs',
    );
    expect(packageJson.scripts['build:android:release']).toBe(
      'node scripts/build-android-release.mjs',
    );
  });
});
