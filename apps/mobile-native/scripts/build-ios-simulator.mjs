import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executable } from './native-build-config.mjs';

if (process.platform !== 'darwin') {
  throw new Error('The AgentHub iOS native client must be compiled on macOS with Xcode');
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd = appRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, EXPO_NO_GIT_STATUS: '1' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(executable('npx'), ['expo', 'prebuild', '--clean', '--platform', 'ios', '--no-install']);
run('pod', ['install'], path.join(appRoot, 'ios'));
run('xcodebuild', [
  '-workspace',
  'ios/AgentHub.xcworkspace',
  '-scheme',
  'AgentHub',
  '-configuration',
  'Release',
  '-sdk',
  'iphonesimulator',
  '-derivedDataPath',
  'dist/ios-simulator',
  'CODE_SIGNING_ALLOWED=NO',
  'build',
]);
