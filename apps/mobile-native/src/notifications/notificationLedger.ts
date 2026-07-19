import { AgentHubApiError } from '@agenthub/client-core';
import type { MobileApi, NativeNotificationRecord } from '../api/mobileApi';

type LedgerApi = Pick<MobileApi, 'listNotifications' | 'markNotificationDelivered'>;

export interface NotificationLedgerSyncResult {
  available: boolean;
  pendingCount: number;
}

export interface NotificationDeliveryLifecycle {
  stage(notification: NativeNotificationRecord): Promise<void>;
  confirm(notification: NativeNotificationRecord): Promise<void>;
  discard(notificationId: string): Promise<void>;
}

export async function syncNotificationLedger(
  api: LedgerApi,
  csrfToken: string,
  deliver: (notification: NativeNotificationRecord) => Promise<unknown>,
  deliveryEnabled: boolean,
  lifecycle?: NotificationDeliveryLifecycle,
): Promise<NotificationLedgerSyncResult> {
  let records: NativeNotificationRecord[];
  try {
    records = (await api.listNotifications()).items;
  } catch (error) {
    if (error instanceof AgentHubApiError && error.status === 404) {
      return { available: false, pendingCount: 0 };
    }
    throw error;
  }

  const activeRecords = records.filter((record) => ['pending', 'delivered'].includes(record.status));
  if (!deliveryEnabled) return { available: true, pendingCount: activeRecords.length };
  for (const record of activeRecords) {
    if (record.status !== 'pending') continue;
    await lifecycle?.stage(record);
    const transition = await api.markNotificationDelivered(record.notification_id, csrfToken);
    if (!transition.claimed) {
      await lifecycle?.discard(record.notification_id);
      continue;
    }
    await lifecycle?.confirm(transition.notification);
    await deliver(transition.notification);
    await lifecycle?.discard(record.notification_id);
  }
  return { available: true, pendingCount: activeRecords.length };
}
