import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktopPackagingEnv } from './package-win-config.mjs';
import { prewarmElectronDistCache } from './electron-dist-cache.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const desktopRoot = path.resolve(scriptDir, '..');
const command = process.execPath;
const env = buildDesktopPackagingEnv();
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
const electronVersion = packageJson.build?.electronVersion;

if (!electronVersion) {
  throw new Error('apps/desktop/package.json build.electronVersion is required for deterministic packaging');
}

console.log(`Using ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`);
console.log(`Using ELECTRON_BUILDER_BINARIES_MIRROR=${env.ELECTRON_BUILDER_BINARIES_MIRROR}`);

prewarmElectronDistCache({
  cacheDir: path.join(desktopRoot, '.electron-dist-cache'),
  env,
  mirror: env.ELECTRON_MIRROR,
  version: electronVersion,
});

const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
const result = spawnSync(command, [
  cli,
  '--win',
  'portable',
  '--publish',
  'never',
  '--config.electronDist=.electron-dist-cache',
], {
  env,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
