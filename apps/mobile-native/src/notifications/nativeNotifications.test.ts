import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import {
  deliverNewNotifications,
  enableNativeNotifications,
  type NativeNotificationSignal,
} from './nativeNotifications';

jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: jest.fn(),
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
