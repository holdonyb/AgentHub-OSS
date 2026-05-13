import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_ELECTRON_DOWNLOAD_CHUNK_SIZE,
  electronArchiveName,
  electronArchiveUrl,
} from './package-win-config.mjs';

function curlCommand() {
  return process.platform === 'win32' ? 'curl.exe' : 'curl';
}

function runCurl(args, env, options = {}) {
  const result = spawnSync(curlCommand(), args, {
    encoding: options.encoding ?? 'utf8',
    env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`curl failed with exit code ${result.status}: ${result.stderr || result.stdout || args.join(' ')}`);
  }
  return result;
}

export function remoteFileSize(url, env) {
  const result = runCurl(['-I', '-L', '--fail', '--max-time', '60', url], env);
  const matches = [...`${result.stdout}\n${result.stderr}`.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
  const last = matches.at(-1);
  if (!last) throw new Error(`Could not read Content-Length for ${url}`);
  return Number(last[1]);
}

export function prewarmElectronDistCache({
  cacheDir,
  env,
  mirror,
  version,
  platform = 'win32',
  arch = 'x64',
  chunkSize = DEFAULT_ELECTRON_DOWNLOAD_CHUNK_SIZE,
}) {
  mkdirSync(cacheDir, { recursive: true });

  const archiveName = electronArchiveName({ version, platform, arch });
  const archiveUrl = electronArchiveUrl({ mirror, version, platform, arch });
  const archivePath = path.join(cacheDir, archiveName);
  const expectedSize = remoteFileSize(archiveUrl, env);

  if (existsSync(archivePath) && statSync(archivePath).size === expectedSize) {
    console.log(`Using cached Electron archive ${archivePath}`);
    return archivePath;
  }

  const tempPath = `${archivePath}.tmp`;
  const partDir = path.join(cacheDir, 'parts');
  rmSync(tempPath, { force: true });
  rmSync(partDir, { recursive: true, force: true });
  mkdirSync(partDir, { recursive: true });

  console.log(`Downloading Electron ${version} in ${Math.ceil(expectedSize / chunkSize)} chunks from ${archiveUrl}`);
  try {
    for (let start = 0; start < expectedSize; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, expectedSize - 1);
      const partPath = path.join(partDir, `part-${String(Math.floor(start / chunkSize)).padStart(4, '0')}.bin`);
      runCurl(
        [
          '-L',
          '--fail',
          '--retry',
          '5',
          '--retry-all-errors',
          '--range',
          `${start}-${end}`,
          '--output',
          partPath,
          archiveUrl,
        ],
        env,
        { stdio: 'inherit' },
      );
      appendFileSync(tempPath, readFileSync(partPath));
      rmSync(partPath, { force: true });
    }
  } finally {
    rmSync(partDir, { recursive: true, force: true });
  }

  const actualSize = statSync(tempPath).size;
  if (actualSize !== expectedSize) {
    rmSync(tempPath, { force: true });
    throw new Error(`Electron archive size mismatch: expected ${expectedSize}, got ${actualSize}`);
  }

  rmSync(archivePath, { force: true });
  renameSync(tempPath, archivePath);
  console.log(`Cached Electron archive ${archivePath}`);
  return archivePath;
}
