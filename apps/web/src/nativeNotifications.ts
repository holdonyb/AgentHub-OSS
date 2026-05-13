import type { LocalNotificationsPlugin } from '@capacitor/local-notifications';

type NativePermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
type NativeNotificationState = NativePermissionState | 'unsupported' | 'failed';
type NativeNotificationResult = 'scheduled' | 'permission-denied' | 'unsupported' | 'failed';

interface NativeNotificationBridge {
  platform: string;
  localNotifications: Pick<
    LocalNotificationsPlugin,
    'addListener' | 'checkPermissions' | 'createChannel' | 'requestPermissions' | 'schedule'
  >;
}

interface NativeNotifierDeps {
  load: () => Promise<NativeNotificationBridge | null>;
}

interface PendingPermissionNotification {
  permissionId: string;
  sessionId: string;
  count: number;
  title: string;
  body: string;
}

interface StatusNotification {
  id: string;
  sessionId?: string;
  title: string;
  body: string;
}

interface NativeNotificationAction {
  permissionId?: unknown;
  sessionId?: unknown;
}

const approvalChannelId = 'agenthub-approvals-v2';

function isNativeBridge(bridge: NativeNotificationBridge | null): bridge is NativeNotificationBridge {
  return Boolean(bridge && bridge.platform !== 'web');
}

function nativeNotificationId(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash || 1;
}

async function loadNativeBridge(): Promise<NativeNotificationBridge | null> {
  const [{ Capacitor }, { LocalNotifications }] = await Promise.all([
    import('@capacitor/core'),
    import('@capacitor/local-notifications'),
  ]);
  if (!Capacitor.isNativePlatform()) return null;
  return {
    platform: Capacitor.getPlatform(),
    localNotifications: LocalNotifications,
  };
}

export function createNativeNotifier(deps: NativeNotifierDeps) {
  async function requestPermission(): Promise<NativeNotificationState> {
    try {
      const bridge = await deps.load();
      if (!isNativeBridge(bridge)) return 'unsupported';
      const current = await bridge.localNotifications.checkPermissions();
      if (current.display === 'granted' || current.display === 'denied') return current.display;
      const next = await bridge.localNotifications.requestPermissions();
      return next.display;
    } catch {
      return 'failed';
    }
  }

  async function ensureAndroidChannel(bridge: NativeNotificationBridge) {
    if (bridge.platform !== 'android') return;
    await bridge.localNotifications.createChannel({
      id: approvalChannelId,
      name: 'AgentHub 审批提醒',
      description: 'Codex、Claude、Kimi 等会话需要你处理时弹出提醒',
      importance: 5,
      visibility: 1,
      lights: true,
      lightColor: '#2563eb',
      vibration: true,
    });
  }

  async function scheduleVisibleNotification(
    bridge: NativeNotificationBridge,
    payload: {
      id: string;
      title: string;
      body: string;
      largeBody?: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<NativeNotificationResult> {
    const permission = await requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'permission-denied' : 'failed';
    await ensureAndroidChannel(bridge);
    await bridge.localNotifications.schedule({
      notifications: [
        {
          id: nativeNotificationId(payload.id),
          title: payload.title,
          body: payload.body,
          largeBody: payload.largeBody,
          summaryText: 'AgentHub',
          channelId: approvalChannelId,
          group: approvalChannelId,
          smallIcon: 'ic_stat_agenthub',
          sound: 'default',
          autoCancel: true,
          extra: payload.extra,
        },
      ],
    });
    return 'scheduled';
  }

  async function notifyPendingPermission(payload: PendingPermissionNotification): Promise<NativeNotificationResult> {
    try {
      const bridge = await deps.load();
      if (!isNativeBridge(bridge)) return 'unsupported';
      return scheduleVisibleNotification(bridge, {
        id: payload.permissionId,
        title: payload.title,
        body: payload.body,
        largeBody: `${payload.body}\n\n共有 ${payload.count} 个审批待处理`,
        extra: {
          permissionId: payload.permissionId,
          sessionId: payload.sessionId,
        },
      });
    } catch {
      return 'failed';
    }
  }

  async function notifyStatus(payload: StatusNotification): Promise<NativeNotificationResult> {
    try {
      const bridge = await deps.load();
      if (!isNativeBridge(bridge)) return 'unsupported';
      return scheduleVisibleNotification(bridge, {
        id: `status:${payload.id}`,
        title: payload.title,
        body: payload.body,
        largeBody: payload.body,
        extra: {
          kind: 'status',
          id: payload.id,
          ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        },
      });
    } catch {
      return 'failed';
    }
  }

  async function listenForActions(callback: (action: NativeNotificationAction) => void) {
    const bridge = await deps.load();
    if (!isNativeBridge(bridge)) return () => undefined;
    const handle = await bridge.localNotifications.addListener('localNotificationActionPerformed', (event) => {
      callback((event.notification.extra ?? {}) as NativeNotificationAction);
    });
    return () => void handle.remove();
  }

  return {
    listenForActions,
    notifyPendingPermission,
    notifyStatus,
    requestPermission,
  };
}

const nativeNotifier = createNativeNotifier({ load: loadNativeBridge });

export function requestNativeNotificationPermission() {
  return nativeNotifier.requestPermission();
}

export function notifyNativePendingPermission(payload: PendingPermissionNotification) {
  return nativeNotifier.notifyPendingPermission(payload);
}

export function notifyNativeStatus(payload: StatusNotification) {
  return nativeNotifier.notifyStatus(payload);
}

export function listenForNativeNotificationActions(callback: (action: NativeNotificationAction) => void) {
  return nativeNotifier.listenForActions(callback);
}
