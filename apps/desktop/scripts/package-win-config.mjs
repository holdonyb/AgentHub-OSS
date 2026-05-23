export const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
export const DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR =
  'https://npmmirror.com/mirrors/electron-builder-binaries/';
export const DEFAULT_ELECTRON_DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

function pickMirror(env, primaryKey, overrideKey, fallback) {
  return env[primaryKey] || env[overrideKey] || fallback;
}

export function normalizeMirrorUrl(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

export function electronArchiveName({ version, platform = 'win32', arch = 'x64' }) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

export function electronArchiveUrl({ mirror, version, platform = 'win32', arch = 'x64' }) {
  return `${normalizeMirrorUrl(mirror)}${version}/${electronArchiveName({ version, platform, arch })}`;
}

export function buildDesktopPackagingEnv(env = process.env) {
  const next = { ...env };
  const electronMirror = pickMirror(
    next,
    'ELECTRON_MIRROR',
    'AGENTHUB_ELECTRON_MIRROR',
    DEFAULT_ELECTRON_MIRROR,
  );
  const builderMirror = pickMirror(
    next,
    'ELECTRON_BUILDER_BINARIES_MIRROR',
    'AGENTHUB_ELECTRON_BUILDER_BINARIES_MIRROR',
    DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR,
  );

  next.ELECTRON_MIRROR = electronMirror;
  next.npm_config_electron_mirror = electronMirror;
  next.electron_mirror = electronMirror;
  next.ELECTRON_BUILDER_BINARIES_MIRROR = builderMirror;

  return next;
}
