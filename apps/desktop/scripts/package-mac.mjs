import { spawnSync } from 'node:child_process';
import { hasNotarizationCredentials, macBuilderArgs } from './package-mac-config.mjs';
import { assertDesktopPackagingNodeVersion, resolveElectronBuilderCli } from './package-runtime.mjs';

if (process.platform !== 'darwin') {
  throw new Error('macOS desktop packages must be built on a macOS host');
}

assertDesktopPackagingNodeVersion();
const cli = resolveElectronBuilderCli();
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const notarized = signed && hasNotarizationCredentials(process.env);
const result = spawnSync(process.execPath, [cli, ...macBuilderArgs({ signed, notarized })], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
