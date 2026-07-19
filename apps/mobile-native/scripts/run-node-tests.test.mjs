import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('runs native script tests through the cross-platform Node test runner', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.match(packageJson.scripts.test, /^node scripts\/run-node-tests\.mjs && /);
  assert.doesNotMatch(packageJson.scripts.test, /\*\.test\.mjs/);
});
