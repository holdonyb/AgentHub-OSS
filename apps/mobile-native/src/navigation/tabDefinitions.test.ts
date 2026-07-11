import { nativeTabs } from './tabDefinitions';

describe('native tab shell', () => {
  it('exposes the five agreed product areas in order', () => {
    expect(nativeTabs.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: 'sessions', label: '会话' },
      { key: 'tasks', label: '任务' },
      { key: 'files', label: '文件' },
      { key: 'workers', label: '节点' },
      { key: 'me', label: '我的' },
    ]);
  });

  it('lets the session flow own its list and detail headers', () => {
    expect(nativeTabs.find((tab) => tab.key === 'sessions')?.ownsHeader).toBe(true);
    expect(nativeTabs.find((tab) => tab.key === 'tasks')?.ownsHeader).toBe(false);
  });
});
