import { AgentHubApiError } from '@agenthub/client-core';
import type { MobileApi, NativeNotificationRecord } from '../api/mobileApi';
import { syncNotificationLedger } from './notificationLedger';

const pendingRecord: NativeNotificationRecord = {
  notification_id: 'notice-1',
  notification_type: 'approval',
  source_type: 'permission',
  source_id: 'permission-1',
  session_id: 'session-1',
  title: '等待审批',
  body: '允许执行测试',
  severity: 'warning',
  status: 'pending',
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
  delivered_at: null,
  read_at: null,
  acknowledged_at: null,
  dismissed_at: null,
};

it('claims pending ledger records before delivering them locally', async () => {
  const api = {
    listNotifications: jest.fn().mockResolvedValue({ items: [pendingRecord] }),
    markNotificationDelivered: jest.fn().mockResolvedValue({
      claimed: true,
      notification: { ...pendingRecord, status: 'delivered' },
    }),
  } as unknown as MobileApi;
  const deliver = jest.fn().mockResolvedValue(true);

  await expect(syncNotificationLedger(api, 'csrf-token', deliver, true)).resolves.toEqual({
    available: true,
    pendingCount: 1,
  });
  expect(api.markNotificationDelivered).toHaveBeenCalledWith('notice-1', 'csrf-token');
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ notification_id: 'notice-1' }));
});

it('does not display a record claimed by another client', async () => {
  const api = {
    listNotifications: jest.fn().mockResolvedValue({ items: [pendingRecord] }),
    markNotificationDelivered: jest.fn().mockResolvedValue({
      claimed: false,
      notification: { ...pendingRecord, status: 'delivered' },
    }),
  } as unknown as MobileApi;
  const deliver = jest.fn();

  await syncNotificationLedger(api, 'csrf-token', deliver, true);

  expect(deliver).not.toHaveBeenCalled();
});

it('reports an unavailable ledger only for older servers', async () => {
  const api = {
    listNotifications: jest.fn().mockRejectedValue(
      new AgentHubApiError({ status: 404, message: 'Not found' }),
    ),
  } as unknown as MobileApi;

  await expect(syncNotificationLedger(api, 'csrf-token', jest.fn(), true)).resolves.toEqual({
    available: false,
    pendingCount: 0,
  });
});

it('keeps pending records unclaimed while native notification permission is disabled', async () => {
  const api = {
    listNotifications: jest.fn().mockResolvedValue({ items: [pendingRecord] }),
    markNotificationDelivered: jest.fn(),
  } as unknown as MobileApi;
  const deliver = jest.fn();

  await expect(syncNotificationLedger(api, 'csrf-token', deliver, false)).resolves.toEqual({
    available: true,
    pendingCount: 1,
  });
  expect(api.markNotificationDelivered).not.toHaveBeenCalled();
  expect(deliver).not.toHaveBeenCalled();
});
