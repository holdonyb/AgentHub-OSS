import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import {
  consumeLastNotificationResponse,
  deliverClaimedNotification,
  deliverNewNotifications,
  enableNativeNotifications,
  subscribeToNotificationResponses,
  type NativeNotificationSignal,
} from './nativeNotifications';

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(),
  clearLastNotificationResponseAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

const permissionSignal: NativeNotificationSignal = {
  id: 'permission:approval-1',
  title: '等待审批',
  body: '允许执行测试命令',
  sessionId: 'session-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as never);
  jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ granted: true } as never);
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  jest.mocked(Notifications.getLastNotificationResponseAsync).mockResolvedValue(null);
});

it('requests notification access when it is not already granted', async () => {
  await expect(enableNativeNotifications()).resolves.toBe(true);
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
});

it('uses the first sync as a baseline without notifying old approvals', async () => {
  await deliverNewNotifications([permissionSignal]);

  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    'agenthub.nativeNotifications.v1',
    JSON.stringify({ initialized: true, deliveredIds: ['permission:approval-1'] }),
  );
});

it('notifies only signals not present in the durable delivered set', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify({
    initialized: true,
    deliveredIds: ['permission:approval-1'],
  }));
  const failedJob: NativeNotificationSignal = {
    id: 'job:job-2:failed',
    title: '任务失败',
    body: '模型容量不足',
    sessionId: 'session-2',
  };

  await deliverNewNotifications([permissionSignal, failedJob]);

  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
    content: expect.objectContaining({
      title: '任务失败',
      body: '模型容量不足',
      data: { sessionId: 'session-2', signalId: 'job:job-2:failed' },
    }),
    trigger: null,
  });
});

it('delivers an authoritative ledger record without using the legacy local baseline', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);

  await deliverClaimedNotification({
    notification_id: 'notice-1',
    title: '等待你的选择',
    body: '请选择维护窗口',
    session_id: 'session-1',
  });

  expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
    content: expect.objectContaining({
      title: '等待你的选择',
      body: '请选择维护窗口',
      data: { sessionId: 'session-1', notificationId: 'notice-1' },
    }),
    trigger: null,
  });
});

it('consumes the notification response that launched the app', async () => {
  jest.mocked(Notifications.getLastNotificationResponseAsync).mockResolvedValue({
    notification: {
      request: {
        content: {
          data: { notificationId: 'notice-cold', sessionId: 'session-cold' },
        },
      },
    },
  } as never);

  await expect(consumeLastNotificationResponse()).resolves.toEqual({
    notificationId: 'notice-cold',
    sessionId: 'session-cold',
  });
  expect(Notifications.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
});

it('subscribes to notification responses and removes the native listener on cleanup', () => {
  const remove = jest.fn();
  let nativeListener: ((response: unknown) => void) | undefined;
  jest.mocked(Notifications.addNotificationResponseReceivedListener).mockImplementation((listener) => {
    nativeListener = listener as (response: unknown) => void;
    return { remove } as never;
  });
  const listener = jest.fn();

  const unsubscribe = subscribeToNotificationResponses(listener);
  nativeListener?.({
    notification: {
      request: {
        content: { data: { notificationId: 'notice-live', sessionId: 'session-live' } },
      },
    },
  });
  unsubscribe();

  expect(listener).toHaveBeenCalledWith({
    notificationId: 'notice-live',
    sessionId: 'session-live',
  });
  expect(remove).toHaveBeenCalledTimes(1);
});
