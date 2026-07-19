import {
  formatLastActivity,
  sessionActivityAt,
  parseApiDate,
  sessionStatusLabel,
  sortSessionsByRecentActivity,
  taskStatusLabel,
  workerCapabilityLabels,
  workerStatusLabel,
} from './resourcePresentation';
import type { NativeSessionSummary } from '../api/mobileApi';

describe('native resource presentation', () => {
  it('translates server statuses into concise Chinese labels', () => {
    expect(sessionStatusLabel('needs_reply')).toBe('待回复');
    expect(taskStatusLabel('ready_to_review')).toBe('待验收');
    expect(workerStatusLabel('degraded')).toBe('异常');
  });

  it('formats last activity without depending on the device locale', () => {
    const now = new Date('2026-07-11T12:00:00.000Z');

    expect(formatLastActivity('2026-07-11T11:58:00.000Z', now)).toBe('2 分钟前');
    expect(parseApiDate('2026-07-11T11:58:00.000')?.toISOString()).toBe('2026-07-11T11:58:00.000Z');
    expect(formatLastActivity('2026-07-11T11:58:00.000', now)).toBe('2 分钟前');
    expect(formatLastActivity('2026-07-09T12:00:00.000Z', now)).toBe('2 天前');
    expect(formatLastActivity(null, now)).toBe('暂无活动');
  });

  it('orders the inbox by actual recent activity instead of stale attention state', () => {
    const staleNeedsReply = {
      session_id: 'stale-needs-reply',
      title: '旧审批',
      backend: 'codex',
      worker_id: 'worker-main',
      status: 'needs_reply',
      last_activity_at: '2026-07-18T08:00:00',
    } as NativeSessionSummary;
    const freshReady = {
      ...staleNeedsReply,
      session_id: 'fresh-ready',
      title: '刚完成的会话',
      status: 'ready',
      last_activity_at: '2026-07-19T08:00:00',
    } as NativeSessionSummary;

    expect(sortSessionsByRecentActivity([staleNeedsReply, freshReady]).map((item) => item.session_id)).toEqual([
      'fresh-ready',
      'stale-needs-reply',
    ]);
  });

  it('falls back to the session update timestamp before the first transcript activity arrives', () => {
    const existing = {
      session_id: 'existing',
      title: '已有会话',
      backend: 'codex',
      worker_id: 'worker-main',
      status: 'ready',
      last_activity_at: '2026-07-19T08:00:00',
      updated_at: '2026-07-19T08:00:00',
    } as NativeSessionSummary;
    const justCreated = {
      ...existing,
      session_id: 'just-created',
      title: '刚创建的会话',
      last_activity_at: null,
      updated_at: '2026-07-19T09:00:00',
    } as NativeSessionSummary;

    expect(sortSessionsByRecentActivity([existing, justCreated]).map((item) => item.session_id)).toEqual([
      'just-created',
      'existing',
    ]);
    expect(sessionActivityAt(justCreated)).toBe('2026-07-19T09:00:00');
  });

  it('shows the newer session update when transcript activity is stale', () => {
    const session = {
      session_id: 'recently-synced',
      title: '最近同步',
      backend: 'claude',
      worker_id: 'worker-main',
      status: 'needs_reply',
      last_activity_at: '2026-07-19T00:00:00',
      updated_at: '2026-07-19T08:00:00',
    } as NativeSessionSummary;

    expect(sessionActivityAt(session)).toBe('2026-07-19T08:00:00');
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
