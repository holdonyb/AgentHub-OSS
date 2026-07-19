import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeSpawnOptions } from './native-build-config.mjs';

test('uses the Windows command shell for .cmd build tools', () => {
  assert.deepEqual(nativeSpawnOptions('win32'), { shell: true });
});

test('does not add a shell on Unix build hosts', () => {
  assert.deepEqual(nativeSpawnOptions('linux'), {});
  assert.deepEqual(nativeSpawnOptions('darwin'), {});
});
