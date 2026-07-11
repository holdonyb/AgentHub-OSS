import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { macBuilderArgs } from './package-mac-config.mjs';

if (process.platform !== 'darwin') {
  throw new Error('macOS desktop packages must be built on a macOS host');
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const cli = path.join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const result = spawnSync(process.execPath, [cli, ...macBuilderArgs({ signed })], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
