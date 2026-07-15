import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const STORAGE_KEY = 'agenthub.nativeNotifications.v1';
const CHANNEL_ID = 'agenthub-urgent-v1';
const MAX_DELIVERED_IDS = 500;

export interface NativeNotificationSignal {
  id: string;
  title: string;
  body: string;
  sessionId: string | null;
}

export interface ClaimedNativeNotification {
  notification_id: string;
  title: string;
  body: string;
  session_id: string | null;
}

export interface NativeNotificationResponseTarget {
  notificationId: string;
  sessionId: string | null;
}

function responseTarget(
  response: Notifications.NotificationResponse,
): NativeNotificationResponseTarget | null {
  const data = response.notification.request.content.data ?? {};
  const notificationId = typeof data.notificationId === 'string' ? data.notificationId : '';
  if (!notificationId) return null;
  return {
    notificationId,
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
  };
}

interface DeliveryState {
  initialized: boolean;
  deliveredIds: string[];
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function readState(): Promise<DeliveryState> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return { initialized: false, deliveredIds: [] };
    const parsed = JSON.parse(raw) as Partial<DeliveryState>;
    return {
      initialized: parsed.initialized === true,
      deliveredIds: Array.isArray(parsed.deliveredIds)
        ? parsed.deliveredIds.filter((id): id is string => typeof id === 'string').slice(-MAX_DELIVERED_IDS)
        : [],
    };
  } catch {
    return { initialized: false, deliveredIds: [] };
  }
}

async function writeState(deliveredIds: string[]) {
  await SecureStore.setItemAsync(
    STORAGE_KEY,
    JSON.stringify({ initialized: true, deliveredIds: deliveredIds.slice(-MAX_DELIVERED_IDS) }),
  );
}

export async function enableNativeNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'AgentHub 审批与任务',
      importance: Notifications.AndroidImportance.HIGH,
      enableVibrate: true,
      vibrationPattern: [0, 220, 120, 220],
      showBadge: true,
      sound: 'default',
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export async function nativeNotificationsEnabled(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

export async function deliverNewNotifications(signals: NativeNotificationSignal[]): Promise<number> {
  const uniqueSignals = [...new Map(signals.map((signal) => [signal.id, signal])).values()];
  const state = await readState();
  if (!state.initialized) {
    await writeState(uniqueSignals.map((signal) => signal.id));
    return 0;
  }

  const delivered = new Set(state.deliveredIds);
  const nextSignals = uniqueSignals.filter((signal) => !delivered.has(signal.id));
  if (nextSignals.length === 0) return 0;
  if (!(await Notifications.getPermissionsAsync()).granted) return 0;

  let deliveredNow = 0;
  for (const signal of nextSignals) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: signal.title,
        body: signal.body,
        data: { sessionId: signal.sessionId, signalId: signal.id },
        sound: 'default',
      },
      trigger: null,
    });
    delivered.add(signal.id);
    deliveredNow += 1;
  }
  await writeState([...delivered]);
  return deliveredNow;
}

export async function deliverClaimedNotification(
  notification: ClaimedNativeNotification,
): Promise<boolean> {
  if (!(await Notifications.getPermissionsAsync()).granted) return false;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: notification.title,
      body: notification.body,
      data: {
        sessionId: notification.session_id,
        notificationId: notification.notification_id,
      },
      sound: 'default',
    },
    trigger: null,
  });
  return true;
}

export function subscribeToNotificationResponses(
  listener: (target: NativeNotificationResponseTarget) => void,
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const target = responseTarget(response);
    if (target) listener(target);
  });
  return () => subscription.remove();
}

export async function consumeLastNotificationResponse(): Promise<NativeNotificationResponseTarget | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) return null;
  const target = responseTarget(response);
  await Notifications.clearLastNotificationResponseAsync();
  return target;
}
