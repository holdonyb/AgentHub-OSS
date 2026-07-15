import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileApi } from '../api/mobileApi';
import {
  consumeLastNotificationResponse,
  deliverClaimedNotification,
  deliverNewNotifications,
  enableNativeNotifications,
  nativeNotificationsEnabled,
  subscribeToNotificationResponses,
} from './nativeNotifications';
import { notificationSignals } from './notificationSignals';
import { syncNotificationLedger } from './notificationLedger';
import { registerCurrentPushDevice } from './pushRegistration';

type NotificationApi = Pick<
  MobileApi,
  'listJobs' | 'listNotifications' | 'listPermissions' | 'markNotificationDelivered' | 'markNotificationRead' | 'upsertPushDevice' | 'revokePushDevice'
>;

export interface NativeNotificationGuardState {
  enabled: boolean;
  pendingCount: number;
  syncing: boolean;
  enable(): Promise<void>;
  refresh(): Promise<void>;
}

export function useNativeNotificationGuard(
  api: NotificationApi,
  csrfToken: string,
  onError?: (error: unknown) => void,
  onOpenSession?: (sessionId: string) => void,
): NativeNotificationGuardState {
  const [enabled, setEnabled] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);
  const pushRegistrationAttempted = useRef(false);
  const handledResponses = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      const permissionGranted = await nativeNotificationsEnabled();
      setEnabled(permissionGranted);
      if (permissionGranted && !pushRegistrationAttempted.current) {
        pushRegistrationAttempted.current = true;
        try {
          await registerCurrentPushDevice(api, csrfToken);
        } catch (error) {
          onError?.(error);
        }
      }
      const ledger = await syncNotificationLedger(api, csrfToken, deliverClaimedNotification, permissionGranted);
      if (ledger.available) {
        setPendingCount(ledger.pendingCount);
        return;
      }
      const [permissionPayload, jobPayload] = await Promise.all([
        api.listPermissions(undefined, 'pending'),
        api.listJobs(),
      ]);
      const legacySignals = notificationSignals(permissionPayload.items, jobPayload.items);
      setPendingCount(legacySignals.length);
      await deliverNewNotifications(legacySignals);
    } catch (error) {
      onError?.(error);
    } finally {
      inFlight.current = false;
      setSyncing(false);
    }
  }, [api, csrfToken, onError]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleNotificationResponse = useCallback(({ notificationId, sessionId }: {
    notificationId: string;
    sessionId: string | null;
  }) => {
    if (handledResponses.current.has(notificationId)) return;
    handledResponses.current.add(notificationId);
    if (sessionId) onOpenSession?.(sessionId);
    void api.markNotificationRead(notificationId, csrfToken).catch((error) => onError?.(error));
  }, [api, csrfToken, onError, onOpenSession]);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeToNotificationResponses((target) => {
      if (active) handleNotificationResponse(target);
    });
    void consumeLastNotificationResponse()
      .then((target) => {
        if (active && target) handleNotificationResponse(target);
      })
      .catch((error) => onError?.(error));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [handleNotificationResponse, onError]);

  const enable = useCallback(async () => {
    try {
      setEnabled(await enableNativeNotifications());
      pushRegistrationAttempted.current = false;
      await refresh();
    } catch (error) {
      onError?.(error);
    }
  }, [onError, refresh]);

  return { enabled, pendingCount, syncing, enable, refresh };
}
