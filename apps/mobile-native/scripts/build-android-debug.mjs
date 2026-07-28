import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidGradleExecutable,
  enforceAndroidRuntimeConfig,
  expectedAndroidRuntimeConfig,
  executable,
  nativeSpawnOptions,
} from './native-build-config.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd = appRoot) {
  const result = spawnSync(command, args, {
    ...nativeSpawnOptions(),
    cwd,
    env: {
      ...process.env,
      EXPO_NO_GIT_STATUS: '1',
      NODE_ENV: process.env.NODE_ENV || 'development',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(executable('npx'), ['expo', 'prebuild', '--clean', '--platform', 'android', '--no-install']);
enforceAndroidRuntimeConfig(appRoot, expectedAndroidRuntimeConfig(appRoot));
run(
  androidGradleExecutable(),
  ['app:assembleDebug', '-PreactNativeArchitectures=arm64-v8a', '--no-daemon'],
  path.join(appRoot, 'android'),
);
run('python', ['scripts/verify_android_runtime.py', 'android/app/build/outputs/apk/debug/app-debug.apk']);
