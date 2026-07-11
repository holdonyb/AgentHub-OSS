import { createRequire } from 'node:module';

export function supportsDesktopPackagingNode(version) {
  const [major = 0, minor = 0] = String(version)
    .replace(/^v/, '')
    .split('.', 2)
    .map((part) => Number.parseInt(part, 10) || 0);
  return major > 22 || (major === 22 && minor >= 12);
}

export function assertDesktopPackagingNodeVersion(version = process.versions.node) {
  if (!supportsDesktopPackagingNode(version)) {
    throw new Error(
      `Desktop packaging requires Node 22.12.0 or newer; current version is ${version}. ` +
        'Use the repository .nvmrc or the Node version configured in GitHub Actions.',
    );
  }
}

export function resolveElectronBuilderCli(fromUrl = import.meta.url) {
  return createRequire(fromUrl).resolve('electron-builder/cli.js');
}
