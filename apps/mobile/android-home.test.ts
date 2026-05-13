import { describe, expect, it } from 'vitest';
import { applyResolvedAndroidHome, resolveAndroidHome } from './scripts/android-home.mjs';

describe('local Android SDK resolver', () => {
  it('prefers an existing ANDROID_HOME', () => {
    const androidHome = resolveAndroidHome({
      env: { ANDROID_HOME: 'D:/Android/Sdk', LOCALAPPDATA: 'C:/Users/me/AppData/Local' },
      existsSync: (path: string) =>
        path === 'D:/Android/Sdk/platforms' || path === 'D:/Android/Sdk/platform-tools',
    });

    expect(androidHome).toBe('D:/Android/Sdk');
  });

  it('detects Android Studio SDK from LOCALAPPDATA', () => {
    const androidHome = resolveAndroidHome({
      env: { LOCALAPPDATA: 'C:/Users/me/AppData/Local' },
      existsSync: (path: string) =>
        path === 'C:/Users/me/AppData/Local/Android/Sdk/platforms' ||
        path === 'C:/Users/me/AppData/Local/Android/Sdk/platform-tools',
    });

    expect(androidHome).toBe('C:/Users/me/AppData/Local/Android/Sdk');
  });

  it('sets both Android SDK environment variables for Gradle', () => {
    const env: Record<string, string> = { ANDROID_SDK_ROOT: 'E:/Android/Sdk' };
    const androidHome = applyResolvedAndroidHome(
      env,
      (path: string) => path === 'E:/Android/Sdk/platforms' || path === 'E:/Android/Sdk/platform-tools',
    );

    expect(androidHome).toBe('E:/Android/Sdk');
    expect(env.ANDROID_HOME).toBe('E:/Android/Sdk');
    expect(env.ANDROID_SDK_ROOT).toBe('E:/Android/Sdk');
  });
});
