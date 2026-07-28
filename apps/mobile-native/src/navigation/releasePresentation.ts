import type { NativeReleaseMetadata } from '../api/mobileApi';

export interface ReleaseStatusPresentation {
  action: 'check' | 'download';
  detail: string;
  latestLabel: string;
}

function versionParts(value: string | null): number[] | null {
  if (!value) return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part));
}

function compareVersions(left: string, right: string): number | null {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

export function presentReleaseStatus(
  currentVersion: string,
  latestVersion: string | null,
  source: NativeReleaseMetadata['source'],
): ReleaseStatusPresentation {
  if (!latestVersion) {
    return {
      action: 'download',
      detail: source === 'server' ? '版本信息暂不可用，可使用稳定下载入口' : '暂未拿到版本号，可稍后重试',
      latestLabel: '最新版本未知',
    };
  }

  const comparison = compareVersions(latestVersion, currentVersion);
  if (comparison !== null && comparison > 0) {
    return {
      action: 'download',
      detail: `发现新版本 ${latestVersion}`,
      latestLabel: `最新 ${latestVersion}`,
    };
  }

  return {
    action: 'check',
    detail: '已是最新版',
    latestLabel: `最新 ${latestVersion}`,
  };
}
