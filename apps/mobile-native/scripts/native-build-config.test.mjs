import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { expectedAndroidRuntimeConfig, nativeSpawnOptions } from './native-build-config.mjs';

test('uses the Windows command shell for .cmd build tools', () => {
  assert.deepEqual(nativeSpawnOptions('win32'), { shell: true });
});

test('does not add a shell on Unix build hosts', () => {
  assert.deepEqual(nativeSpawnOptions('linux'), {});
  assert.deepEqual(nativeSpawnOptions('darwin'), {});
});

test('derives Android runtime flags from app.json', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-native-build-config-'));
  fs.writeFileSync(
    path.join(tempRoot, 'app.json'),
    JSON.stringify({
      expo: {
        jsEngine: 'hermes',
        newArchEnabled: true,
      },
    }),
    'utf8',
  );

  assert.deepEqual(expectedAndroidRuntimeConfig(tempRoot), {
    newArchEnabled: true,
    hermesEnabled: true,
  });
});
