import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVersionMismatches, versionFromReleaseTag } from './release-version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readText(relativePath) {
  return readFile(path.join(repoRoot, relativePath), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

function matchVersion(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Unable to read ${label}`);
  return match[1];
}

const packagePaths = [
  ['root', 'package.json'],
  ['web', 'apps/web/package.json'],
  ['capacitor-android', 'apps/mobile/package.json'],
  ['react-native', 'apps/mobile-native/package.json'],
  ['desktop', 'apps/desktop/package.json'],
  ['protocol-ts', 'packages/protocol/package.json'],
  ['client-core', 'packages/client-core/package.json'],
  ['worker-cli', 'packages/worker-cli/package.json'],
];

const packages = await Promise.all(
  packagePaths.map(async ([name, relativePath]) => ({
    name,
    version: (await readJson(relativePath)).version,
  })),
);
const expectedVersion = packages[0].version;
const nativeConfig = await readJson('apps/mobile-native/app.json');
const protocolPyproject = await readText('packages/protocol/pyproject.toml');
const androidGradle = await readText('apps/mobile/android/app/build.gradle');
const codexAppServer = await readText('workers/shared/agenthub_worker/codex_app_server.py');

const entries = [
  ...packages,
  { name: 'react-native-app', version: nativeConfig.expo.version },
  {
    name: 'protocol-python',
    version: matchVersion(protocolPyproject, /^version\s*=\s*"([^"]+)"/m, 'Python protocol version'),
  },
  {
    name: 'capacitor-android-versionName',
    version: matchVersion(androidGradle, /versionName\s+"([^"]+)"/, 'Android versionName'),
  },
  {
    name: 'codex-app-server-client',
    version: matchVersion(codexAppServer, /"version":\s*"([^"]+)"/, 'Codex app-server client version'),
  },
];

const mismatches = findVersionMismatches(expectedVersion, entries);
if (mismatches.length > 0) {
  throw new Error(`Release versions are not aligned:\n${mismatches.map((item) => `- ${item}`).join('\n')}`);
}

const releaseTag = process.env.AGENTHUB_RELEASE_TAG?.trim();
if (releaseTag) {
  const taggedVersion = versionFromReleaseTag(releaseTag);
  if (taggedVersion !== expectedVersion) {
    throw new Error(`Release tag ${releaseTag} does not match package version ${expectedVersion}`);
  }
}

process.stdout.write(`${expectedVersion}\n`);
