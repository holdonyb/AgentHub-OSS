import { existsSync as nodeExistsSync } from 'node:fs';

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/\/$/, '');
}

function sdkLooksValid(androidHome, existsSync) {
  const normalized = normalizePath(androidHome);
  return existsSync(`${normalized}/platforms`) && existsSync(`${normalized}/platform-tools`);
}

export function resolveAndroidHome({
  env = process.env,
  existsSync = nodeExistsSync,
} = {}) {
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}/Android/Sdk` : '',
    env.USERPROFILE ? `${env.USERPROFILE}/AppData/Local/Android/Sdk` : '',
    'C:/Android/Sdk',
    'E:/Android/Sdk',
    'E:/Android/android-sdk',
  ];

  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (value && sdkLooksValid(value, existsSync)) {
      return normalizePath(value);
    }
  }

  return null;
}

export function applyResolvedAndroidHome(env = process.env, existsSync = nodeExistsSync) {
  const androidHome = resolveAndroidHome({ env, existsSync });
  if (!androidHome) return null;
  env.ANDROID_HOME = androidHome;
  env.ANDROID_SDK_ROOT = androidHome;
  return androidHome;
}
