import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidGradleExecutable,
  executable,
  missingAndroidSigningEnvironment,
} from './native-build-config.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const missing = missingAndroidSigningEnvironment();
if (missing.length > 0) {
  throw new Error(`Native Android release signing is missing: ${missing.join(', ')}`);
}

function run(command, args, cwd = appRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, EXPO_NO_GIT_STATUS: '1' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(executable('npx'), ['expo', 'prebuild', '--clean', '--platform', 'android', '--no-install']);
run(
  androidGradleExecutable(),
  ['app:assembleRelease', 'app:bundleRelease', '--no-daemon'],
  path.join(appRoot, 'android'),
);
