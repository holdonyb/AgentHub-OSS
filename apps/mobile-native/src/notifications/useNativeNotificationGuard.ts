import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileApi } from '../api/mobileApi';
import {
  deliverNewNotifications,
  enableNativeNotifications,
  nativeNotificationsEnabled,
} from './nativeNotifications';
import { notificationSignals } from './notificationSignals';

type NotificationApi = Pick<MobileApi, 'listJobs' | 'listPermissions'>;

export interface NativeNotificationGuardState {
  enabled: boolean;
  pendingCount: number;
  syncing: boolean;
  enable(): Promise<void>;
  refresh(): Promise<void>;
}

export function useNativeNotificationGuard(
  api: NotificationApi,
  onError?: (error: unknown) => void,
): NativeNotificationGuardState {
  const [enabled, setEnabled] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      const [permissionPayload, jobPayload, permissionGranted] = await Promise.all([
        api.listPermissions(undefined, 'pending'),
        api.listJobs(),
        nativeNotificationsEnabled(),
      ]);
      const signals = notificationSignals(permissionPayload.items, jobPayload.items);
      setPendingCount(signals.length);
      setEnabled(permissionGranted);
      await deliverNewNotifications(signals);
    } catch (error) {
      onError?.(error);
    } finally {
      inFlight.current = false;
      setSyncing(false);
    }
  }, [api, onError]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const enable = useCallback(async () => {
    try {
      setEnabled(await enableNativeNotifications());
      await refresh();
    } catch (error) {
      onError?.(error);
    }
  }, [onError, refresh]);

  return { enabled, pendingCount, syncing, enable, refresh };
}
