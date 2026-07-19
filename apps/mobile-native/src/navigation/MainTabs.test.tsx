import type { ReactElement } from 'react';
import type { NativeNotificationRecord, NativeSettings } from '../api/mobileApi';
import { ProfileScreen } from './MainTabs';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.2' } }));
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ pause: jest.fn(), play: jest.fn(), seekTo: jest.fn() }),
  useAudioPlayerStatus: () => ({ currentTime: 0, duration: 0, playing: false }),
}));
jest.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({}) }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: jest.fn(async () => undefined),
  downloadAsync: jest.fn(async () => ({ uri: 'file:///cache/download', status: 200, headers: {} })),
  writeAsStringAsync: jest.fn(async () => undefined),
  EncodingType: { Base64: 'base64' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
}));
jest.mock('../notifications/useNativeNotificationGuard', () => ({
  useNativeNotificationGuard: () => ({
    enabled: true,
    enable: jest.fn(async () => undefined),
    pendingCount: 0,
    refresh: jest.fn(async () => undefined),
    syncing: false,
  }),
}));
jest.mock('../screens/useNativeVoiceRecorder', () => ({
  useNativeVoiceRecorder: () => ({
    durationMillis: 0,
    isRecording: false,
    startRecording: jest.fn(async () => undefined),
    stopRecording: jest.fn(async () => null),
  }),
}));

interface TestInstance {
  props: Record<string, unknown>;
  findByProps(props: Record<string, unknown>): TestInstance;
}

interface TestRenderer {
  root: TestInstance;
  toJSON(): unknown;
  unmount(): void;
}

interface TestRendererApi {
  act(callback: () => void | Promise<void>): void | Promise<void>;
  create(element: ReactElement): TestRenderer;
}

const { act, create } = jest.requireActual('react-test-renderer') as TestRendererApi;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: TestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
});

async function render(element: ReactElement): Promise<TestRenderer> {
  let renderer!: TestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  mounted.push(renderer);
  return renderer;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function press(instance: TestInstance): void {
  const onPress = instance.props.onPress;
  if (typeof onPress !== 'function') throw new Error('Expected a pressable');
  onPress();
}

function changeText(instance: TestInstance, value: string): void {
  const onChangeText = instance.props.onChangeText;
  if (typeof onChangeText !== 'function') throw new Error('Expected a text input');
  onChangeText(value);
}

function renderedText(renderer: TestRenderer): string {
  function collect(value: unknown): string[] {
    if (typeof value === 'string' || typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.flatMap(collect);
    if (typeof value !== 'object' || value === null) return [];
    return collect((value as { children?: unknown }).children);
  }
  return collect(renderer.toJSON()).join(' ').replace(/\s+/g, ' ').trim();
}

function settings(preferences: Partial<NativeSettings['preferences']> = {}): NativeSettings {
  return {
    preferences: {
      locale: 'zh-CN',
      theme_mode: 'light',
      voice_mode: 'streaming',
      voice_language: 'zh-CN',
      quick_replies: ['继续', '不对，重新来'],
      ...preferences,
    },
    worker_runtime_defaults: {
      max_concurrent_jobs: 2,
      job_poll_interval_seconds: 5,
      heartbeat_interval_seconds: 15,
    },
    options: {
      voice_languages: [
        { value: 'zh-CN', label: '中文' },
        { value: 'en-US', label: 'English' },
      ],
    },
    limits: {},
  };
}

function notification(overrides: Partial<NativeNotificationRecord> = {}): NativeNotificationRecord {
  return {
    notification_id: 'notification-1',
    notification_type: 'approval',
    source_type: 'permission',
    source_id: 'permission-1',
    session_id: 'session-1',
    title: '需要选择部署方式',
    body: '请选择 Tailscale 或 HTTPS relay。',
    severity: 'warning',
    status: 'pending',
    created_at: '2026-07-19T08:00:00Z',
    updated_at: '2026-07-19T08:00:00Z',
    delivered_at: null,
    read_at: null,
    acknowledged_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

describe('native profile settings', () => {
  it('updates voice language and newline-separated quick replies', async () => {
    const patchPreferences = jest.fn(async (payload: Partial<NativeSettings['preferences']>) => ({
      preferences: { ...settings().preferences, ...payload },
    }));
    const api = {
      dismissNotification: jest.fn(),
      getLatestRelease: jest.fn(async () => ({
        version: '1.0.2',
        source: 'github',
        downloadUrl: 'https://example.com/app.apk',
      })),
      getSettings: jest.fn(async () => settings()),
      listNotifications: jest.fn(async () => ({ items: [] })),
      markAllNotificationsRead: jest.fn(),
      markNotificationRead: jest.fn(),
      patchPreferences,
    };
    const renderer = await render(
      <ProfileScreen
        api={api as never}
        busy={false}
        csrfToken="csrf-token"
        error={null}
        notificationEnabled
        notificationPendingCount={0}
        notificationSyncing={false}
        onChangeServer={jest.fn(async () => undefined)}
        onEnableNotifications={jest.fn(async () => undefined)}
        onLogout={jest.fn(async () => undefined)}
        onOpenSession={jest.fn()}
        onOpenTask={jest.fn()}
        onRefreshNotifications={jest.fn(async () => undefined)}
        serverUrl="https://agenthub.example.com"
        user={{ email: 'owner@example.com', role: 'owner' } as never}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '使用 English 语音语言' })));
    expect(patchPreferences).toHaveBeenCalledWith({ voice_language: 'en-US' }, 'csrf-token');

    await act(async () => changeText(
      renderer.root.findByProps({ accessibilityLabel: '快捷回复，每行一条' }),
      '继续推进\n换个方案\n继续推进',
    ));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '保存快捷回复' })));

    expect(patchPreferences).toHaveBeenLastCalledWith(
      { quick_replies: ['继续推进', '换个方案'] },
      'csrf-token',
    );
  });

  it('marks the notification inbox read and dismisses individual notifications', async () => {
    const markAllNotificationsRead = jest.fn(async () => ({ updated: 2 }));
    const dismissNotification = jest.fn(async () => ({ notification: notification({ status: 'dismissed' }), claimed: false }));
    const api = {
      dismissNotification,
      getLatestRelease: jest.fn(async () => ({ version: '1.0.2', source: 'github', downloadUrl: null })),
      getSettings: jest.fn(async () => settings()),
      listNotifications: jest.fn(async () => ({
        items: [
          notification(),
          notification({ notification_id: 'notification-2', title: '任务失败', source_type: 'job', source_id: 'job-1' }),
        ],
      })),
      markAllNotificationsRead,
      markNotificationRead: jest.fn(),
      patchPreferences: jest.fn(),
    };
    const renderer = await render(
      <ProfileScreen
        api={api as never}
        busy={false}
        csrfToken="csrf-token"
        error={null}
        notificationEnabled
        notificationPendingCount={2}
        notificationSyncing={false}
        onChangeServer={jest.fn(async () => undefined)}
        onEnableNotifications={jest.fn(async () => undefined)}
        onLogout={jest.fn(async () => undefined)}
        onOpenSession={jest.fn()}
        onOpenTask={jest.fn()}
        onRefreshNotifications={jest.fn(async () => undefined)}
        serverUrl="https://agenthub.example.com"
        user={{ email: 'owner@example.com', role: 'owner' } as never}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开通知收件箱' })));
    await settle();
    expect(renderedText(renderer)).toContain('需要选择部署方式');
    expect(renderedText(renderer)).toContain('任务失败');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '全部通知标为已读' })));
    await settle();
    expect(markAllNotificationsRead).toHaveBeenCalledWith('csrf-token');
    expect(renderedText(renderer)).toContain('已读');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '收起通知 任务失败' })));
    await settle();
    expect(dismissNotification).toHaveBeenCalledWith('notification-2', 'csrf-token');
    expect(renderedText(renderer)).not.toContain('任务失败');
  });

  it('opens a permission notification at its exact session approval', async () => {
    const markNotificationRead = jest.fn(async () => ({ notification: notification({ status: 'read' }), claimed: false }));
    const onOpenSession = jest.fn();
    const api = {
      dismissNotification: jest.fn(),
      getLatestRelease: jest.fn(async () => ({ version: '1.0.2', source: 'github', downloadUrl: null })),
      getSettings: jest.fn(async () => settings()),
      listNotifications: jest.fn(async () => ({ items: [notification()] })),
      markAllNotificationsRead: jest.fn(),
      markNotificationRead,
      patchPreferences: jest.fn(),
    };
    const renderer = await render(
      <ProfileScreen
        api={api as never}
        busy={false}
        csrfToken="csrf-token"
        error={null}
        notificationEnabled
        notificationPendingCount={1}
        notificationSyncing={false}
        onChangeServer={jest.fn(async () => undefined)}
        onEnableNotifications={jest.fn(async () => undefined)}
        onLogout={jest.fn(async () => undefined)}
        onOpenSession={onOpenSession}
        onOpenTask={jest.fn()}
        onRefreshNotifications={jest.fn(async () => undefined)}
        serverUrl="https://agenthub.example.com"
        user={{ email: 'owner@example.com', role: 'owner' } as never}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开通知收件箱' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开通知 需要选择部署方式' })));
    await settle();

    expect(markNotificationRead).toHaveBeenCalledWith('notification-1', 'csrf-token');
    expect(onOpenSession).toHaveBeenCalledWith('session-1', 'permission-1');
  });
});
