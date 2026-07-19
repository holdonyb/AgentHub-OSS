import { createMobileApi } from '../../api/mobileApi';
import { nativeTabs } from '../../navigation/tabDefinitions';
import { parseMarkdownBlocks } from '../../screens/richMarkdownPresentation';
import { sessionActivityAt, sortSessionsByRecentActivity } from '../../screens/resourcePresentation';
import { mobileParityFixture, mobileParityOperations } from './mobileParityFixtures';

describe('native mobile parity acceptance contract', () => {
  it('keeps every phone tab connected to actionable API operations', () => {
    const api = createMobileApi('https://agenthub.example.com');

    expect(nativeTabs.map((tab) => tab.key)).toEqual(['sessions', 'tasks', 'files', 'workers', 'me']);
    for (const tab of nativeTabs) {
      const operations = mobileParityOperations[tab.key];
      expect(operations.length).toBeGreaterThan(0);
      for (const operation of operations) expect(typeof api[operation]).toBe('function');
    }
  });

  it('links approvals, tasks, artifacts, files and notifications through one scoped fixture', () => {
    const { file, notifications, permissions, sessions, taskDetail, workers } = mobileParityFixture;
    const approval = permissions[0]!;
    const notification = notifications[0]!;
    const artifact = taskDetail.artifacts[0]!;

    expect(sessions.find((session) => session.session_id === approval.session_id)?.worker_id).toBe(workers[0]!.worker_id);
    expect(notification.source_id).toBe(approval.permission_id);
    expect(notification.session_id).toBe(approval.session_id);
    expect(taskDetail.task.latest_session_id).toBe(approval.session_id);
    expect(taskDetail.task.target_worker_id).toBe(workers[0]!.worker_id);
    expect(artifact.path).toBe(file.path);
    expect(file.is_editable).toBe(true);
  });

  it('preserves all configured backends and treats timezone-less activity as UTC', () => {
    const { providers, sessions, workers } = mobileParityFixture;
    const sorted = sortSessionsByRecentActivity(sessions);

    expect(workers[0]!.reachable_backends).toEqual(['codex', 'claude', 'kimi']);
    expect(providers.map((provider) => provider.backend)).toEqual(['codex', 'claude', 'kimi']);
    expect(sorted[0]!.backend).toBe('claude');
    expect(sessionActivityAt(sorted[0]!)).toBe('2026-07-19T12:03:00');
  });

  it('provides Markdown, editable file and account preferences for the reader and composer', () => {
    const { file, settings, taskDetail, timeline } = mobileParityFixture;

    expect(parseMarkdownBlocks(timeline[0]!.text).some((block) => block.kind === 'heading')).toBe(true);
    expect(parseMarkdownBlocks(taskDetail.task.success_criteria_markdown).some((block) => block.kind === 'unordered_list')).toBe(true);
    expect(file.preview_kind).toBe('text');
    expect(settings.preferences.quick_replies).toContain('先给结论');
  });
});
