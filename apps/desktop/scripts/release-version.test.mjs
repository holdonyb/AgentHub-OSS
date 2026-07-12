import { describe, expect, it } from 'vitest';
import { findVersionMismatches, versionFromReleaseTag } from '../../../scripts/release-version.mjs';

describe('release version contract', () => {
  it('reports every component that differs from the release version', () => {
    expect(
      findVersionMismatches('1.0.0', [
        { name: 'root', version: '1.0.0' },
        { name: 'desktop', version: '0.1.1' },
        { name: 'native', version: '0.1.4' },
      ]),
    ).toEqual([
      'desktop: expected 1.0.0, found 0.1.1',
      'native: expected 1.0.0, found 0.1.4',
    ]);
  });

  it('accepts a fully aligned release', () => {
    expect(
      findVersionMismatches('1.0.0', [
        { name: 'root', version: '1.0.0' },
        { name: 'worker', version: '1.0.0' },
      ]),
    ).toEqual([]);
  });

  it('requires a semantic v-prefixed release tag', () => {
    expect(versionFromReleaseTag('v1.0.0')).toBe('1.0.0');
    expect(() => versionFromReleaseTag('worker-v1.0.0')).toThrow(/must match/i);
    expect(() => versionFromReleaseTag('v1')).toThrow(/must match/i);
  });
});
