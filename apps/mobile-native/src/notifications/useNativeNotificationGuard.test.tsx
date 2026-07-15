import type { ReactElement } from 'react';
import type { MobileApi } from '../api/mobileApi';
import {
  consumeLastNotificationResponse,
  deliverClaimedNotification,
  deliverNewNotifications,
  nativeNotificationsEnabled,
  subscribeToNotificationResponses,
} from './nativeNotifications';
import { syncNotificationLedger } from './notificationLedger';
import { useNativeNotificationGuard, type NativeNotificationGuardState } from './useNativeNotificationGuard';

jest.mock('./nativeNotifications', () => ({
  consumeLastNotificationResponse: jest.fn(),
  deliverClaimedNotification: jest.fn(),
  deliverNewNotifications: jest.fn(),
  enableNativeNotifications: jest.fn(),
  nativeNotificationsEnabled: jest.fn(),
  subscribeToNotificationResponses: jest.fn(),
}));
jest.mock('./notificationLedger', () => ({ syncNotificationLedger: jest.fn() }));

const { act, create } = jest.requireActual('react-test-renderer') as {
  act(callback: () => void | Promise<void>): void | Promise<void>;
  create(element: ReactElement): { unmount(): void };
};

let currentHook: NativeNotificationGuardState;
const api = {
  listNotifications: jest.fn(),
  markNotificationDelivered: jest.fn(),
  listPermissions: jest.fn(),
  listJobs: jest.fn(),
  markNotificationRead: jest.fn(),
} as unknown as MobileApi;

function Probe() {
  currentHook = useNativeNotificationGuard(api, 'csrf-token', undefined, onOpenSession);
  return null;
}

const onOpenSession = jest.fn();
let notificationResponseListener: ((target: { notificationId: string; sessionId: string | null }) => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(nativeNotificationsEnabled).mockResolvedValue(true);
  jest.mocked(consumeLastNotificationResponse).mockResolvedValue(null);
  jest.mocked(syncNotificationLedger).mockResolvedValue({ available: true, pendingCount: 2 });
  jest.mocked(subscribeToNotificationResponses).mockImplementation((listener) => {
    notificationResponseListener = listener;
    return jest.fn();
  });
  jest.mocked(api.listPermissions).mockResolvedValue({ items: [] });
  jest.mocked(api.listJobs).mockResolvedValue({ items: [] });
});

it('opens and marks read the notification that launched the app', async () => {
  jest.mocked(consumeLastNotificationResponse).mockResolvedValue({
    notificationId: 'notice-cold',
    sessionId: 'session-cold',
  });
  jest.mocked(api.markNotificationRead).mockResolvedValue({
    claimed: false,
    notification: {} as never,
  });
  let renderer!: { unmount(): void };

  await act(async () => {
    renderer = create(<Probe />);
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(onOpenSession).toHaveBeenCalledWith('session-cold');
  expect(api.markNotificationRead).toHaveBeenCalledWith('notice-cold', 'csrf-token');
  await act(async () => renderer.unmount());
});

it('marks a tapped notification read and opens its session', async () => {
  jest.mocked(api.markNotificationRead).mockResolvedValue({
    claimed: false,
    notification: {} as never,
  });
  let renderer!: { unmount(): void };
  await act(async () => {
    renderer = create(<Probe />);
  });

  await act(async () => {
    notificationResponseListener?.({ notificationId: 'notice-1', sessionId: 'session-1' });
    await Promise.resolve();
  });

  expect(api.markNotificationRead).toHaveBeenCalledWith('notice-1', 'csrf-token');
  expect(onOpenSession).toHaveBeenCalledWith('session-1');
  await act(async () => renderer.unmount());
});

it('prefers the server ledger and passes the delivery claimant the CSRF token', async () => {
  let renderer!: { unmount(): void };
  await act(async () => {
    renderer = create(<Probe />);
  });

  expect(syncNotificationLedger).toHaveBeenCalledWith(api, 'csrf-token', deliverClaimedNotification, true);
  expect(api.listPermissions).not.toHaveBeenCalled();
  expect(api.listJobs).not.toHaveBeenCalled();
  expect(currentHook.pendingCount).toBe(2);
  await act(async () => renderer.unmount());
});

it('uses legacy local notification inference only when the ledger endpoint is unavailable', async () => {
  jest.mocked(syncNotificationLedger).mockResolvedValue({ available: false, pendingCount: 0 });
  jest.mocked(api.listPermissions).mockResolvedValue({ items: [] });
  jest.mocked(api.listJobs).mockResolvedValue({ items: [] });
  let renderer!: { unmount(): void };

  await act(async () => {
    renderer = create(<Probe />);
  });

  expect(api.listPermissions).toHaveBeenCalledWith(undefined, 'pending');
  expect(api.listJobs).toHaveBeenCalled();
  expect(deliverNewNotifications).toHaveBeenCalledWith([]);
  await act(async () => renderer.unmount());
});
