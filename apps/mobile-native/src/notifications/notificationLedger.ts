import { AgentHubApiError } from '@agenthub/client-core';
import type { MobileApi, NativeNotificationRecord } from '../api/mobileApi';

type LedgerApi = Pick<MobileApi, 'listNotifications' | 'markNotificationDelivered'>;

export interface NotificationLedgerSyncResult {
  available: boolean;
  pendingCount: number;
}

export async function syncNotificationLedger(
  api: LedgerApi,
  csrfToken: string,
  deliver: (notification: NativeNotificationRecord) => Promise<unknown>,
  deliveryEnabled: boolean,
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
    const transition = await api.markNotificationDelivered(record.notification_id, csrfToken);
    if (transition.claimed) await deliver(transition.notification);
  }
  return { available: true, pendingCount: activeRecords.length };
}
