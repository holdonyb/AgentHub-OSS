import {
  formatLastActivity,
  sessionStatusLabel,
  taskStatusLabel,
  workerCapabilityLabels,
  workerStatusLabel,
} from './resourcePresentation';

describe('native resource presentation', () => {
  it('translates server statuses into concise Chinese labels', () => {
    expect(sessionStatusLabel('needs_reply')).toBe('待回复');
    expect(taskStatusLabel('ready_to_review')).toBe('待验收');
    expect(workerStatusLabel('degraded')).toBe('异常');
  });

  it('formats last activity without depending on the device locale', () => {
    const now = new Date('2026-07-11T12:00:00.000Z');

    expect(formatLastActivity('2026-07-11T11:58:00.000Z', now)).toBe('2 分钟前');
    expect(formatLastActivity('2026-07-09T12:00:00.000Z', now)).toBe('2 天前');
    expect(formatLastActivity(null, now)).toBe('暂无活动');
  });

  it('shows only enabled worker capabilities without duplicating backends', () => {
    expect(
      workerCapabilityLabels(
        ['codex', 'claude'],
        { codex: true, claude: false, psmux: true, metadata: { version: 1 } },
      ),
    ).toEqual(['codex', 'claude', 'psmux']);
  });
});
