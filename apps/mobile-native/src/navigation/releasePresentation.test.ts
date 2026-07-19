import { presentReleaseStatus } from './releasePresentation';

describe('native release presentation', () => {
  it('detects a newer semantic version even when the release tag has a v prefix', () => {
    expect(presentReleaseStatus('1.0.2', 'v1.1.0', 'github')).toEqual({
      action: 'download',
      detail: '发现新版本 v1.1.0',
      latestLabel: '最新 v1.1.0',
    });
  });

  it('reports the installed build as current when versions match', () => {
    expect(presentReleaseStatus('1.0.2', 'v1.0.2', 'github')).toEqual({
      action: 'check',
      detail: '已是最新版',
      latestLabel: '最新 v1.0.2',
    });
  });

  it('keeps a stable download path when release metadata is unavailable', () => {
    expect(presentReleaseStatus('1.0.2', null, 'fallback')).toEqual({
      action: 'download',
      detail: '版本信息暂不可用，可使用稳定下载入口',
      latestLabel: '最新版本未知',
    });
  });

  it('does not treat an older remote release as an update', () => {
    expect(presentReleaseStatus('1.2.0', 'v1.1.9', 'github').action).toBe('check');
  });
});
