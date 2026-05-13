import { describe, expect, it, vi } from 'vitest';
import { createNativeNotifier } from './nativeNotifications';

describe('native Android notifications', () => {
  it('requests permission, creates an urgent channel, and schedules a pending approval notification', async () => {
    const localNotifications = {
      checkPermissions: vi.fn().mockResolvedValue({ display: 'prompt' }),
      requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
      createChannel: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue({ notifications: [{ id: 123 }] }),
    };
    const notifier = createNativeNotifier({
      load: vi.fn().mockResolvedValue({ platform: 'android', localNotifications }),
    });

    const result = await notifier.notifyPendingPermission({
      permissionId: 'perm-1',
      sessionId: 'sess-1',
      count: 1,
      title: 'AgentHub 需要你处理审批',
      body: '允许执行 pytest',
    });

    expect(result).toBe('scheduled');
    expect(localNotifications.requestPermissions).toHaveBeenCalled();
    expect(localNotifications.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agenthub-approvals-v2',
        importance: 5,
        visibility: 1,
        vibration: true,
      }),
    );
    expect(localNotifications.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          title: 'AgentHub 需要你处理审批',
          body: '允许执行 pytest',
          channelId: 'agenthub-approvals-v2',
          group: 'agenthub-approvals-v2',
          smallIcon: 'ic_stat_agenthub',
          sound: 'default',
          autoCancel: true,
          extra: expect.objectContaining({ permissionId: 'perm-1', sessionId: 'sess-1' }),
        }),
      ],
    });
    expect(localNotifications.schedule.mock.calls[0][0].notifications[0]).not.toHaveProperty('schedule');
  });

  it('schedules a visible test notification after Android notification permission is enabled', async () => {
    const localNotifications = {
      checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
      requestPermissions: vi.fn(),
      createChannel: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue({ notifications: [{ id: 456 }] }),
    };
    const notifier = createNativeNotifier({
      load: vi.fn().mockResolvedValue({ platform: 'android', localNotifications }),
    });

    const result = await notifier.notifyStatus({
      id: 'setup-check',
      title: 'AgentHub 通知已开启',
      body: '之后需要你审批或选择时会在通知栏和锁屏提醒。',
    });

    expect(result).toBe('scheduled');
    expect(localNotifications.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          title: 'AgentHub 通知已开启',
          body: '之后需要你审批或选择时会在通知栏和锁屏提醒。',
          channelId: 'agenthub-approvals-v2',
          smallIcon: 'ic_stat_agenthub',
          sound: 'default',
          autoCancel: true,
        }),
      ],
    });
    expect(localNotifications.schedule.mock.calls[0][0].notifications[0]).not.toHaveProperty('schedule');
  });

  it('keeps a session id on generic status notification actions', async () => {
    const localNotifications = {
      checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
      requestPermissions: vi.fn(),
      createChannel: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue({ notifications: [{ id: 789 }] }),
    };
    const notifier = createNativeNotifier({
      load: vi.fn().mockResolvedValue({ platform: 'android', localNotifications }),
    });

    const result = await notifier.notifyStatus({
      id: 'session:sess-1:2026-04-26T10:00:00Z',
      sessionId: 'sess-1',
      title: 'AgentHub 会话等待回复',
      body: '修复移动控制台：等你回复：确认标题和摘要',
    });

    expect(result).toBe('scheduled');
    expect(localNotifications.schedule).toHaveBeenCalledWith({
      notifications: [
        expect.objectContaining({
          extra: expect.objectContaining({
            kind: 'status',
            id: 'session:sess-1:2026-04-26T10:00:00Z',
            sessionId: 'sess-1',
          }),
        }),
      ],
    });
  });

  it('reports unsupported instead of touching browser notification APIs when not running native', async () => {
    const localNotifications = {
      checkPermissions: vi.fn(),
      requestPermissions: vi.fn(),
      createChannel: vi.fn(),
      schedule: vi.fn(),
    };
    const notifier = createNativeNotifier({
      load: vi.fn().mockResolvedValue({ platform: 'web', localNotifications }),
    });

    await expect(
      notifier.notifyPendingPermission({
        permissionId: 'perm-1',
        sessionId: 'sess-1',
        count: 1,
        title: 'AgentHub 需要你处理审批',
        body: '允许执行 pytest',
      }),
    ).resolves.toBe('unsupported');
    expect(localNotifications.schedule).not.toHaveBeenCalled();
  });
});
