import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const testFiles = (await readdir(new URL('.', import.meta.url)))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `scripts/${name}`);

if (testFiles.length === 0) {
  throw new Error('No native script tests were found');
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
