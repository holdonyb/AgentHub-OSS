import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNavigationContainerRef, DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import type {
  MobileApi,
  NativeNotificationRecord,
  NativeReleaseMetadata,
  NativeSettings,
  NativeUser,
} from '../api/mobileApi';
import { useNativeNotificationGuard } from '../notifications/useNativeNotificationGuard';
import { FilesScreen } from '../screens/FilesScreen';
import { SessionsScreen } from '../screens/SessionsScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { WorkersScreen } from '../screens/WorkersScreen';
import { colors } from '../ui/theme';
import { applyThemePreference } from '../ui/themePreference';
import { presentReleaseStatus } from './releasePresentation';
import { parseQuickReplies, quickRepliesText, workerDefaultsText } from './settingsPresentation';
import { nativeTabs, type NativeTabKey } from './tabDefinitions';

type RootTabParamList = Record<NativeTabKey, undefined>;
const Tab = createBottomTabNavigator<RootTabParamList>();

export function ProfileScreen({
  api,
  csrfToken,
  user,
  serverUrl,
  busy,
  error,
  onLogout,
  onChangeServer,
  notificationEnabled,
  notificationPendingCount,
  notificationSyncing,
  onEnableNotifications,
  onRefreshNotifications,
  onOpenSession,
  onOpenTask,
}: {
  api: Pick<
    MobileApi,
    'dismissNotification' | 'getLatestRelease' | 'getSettings' | 'listNotifications' | 'markAllNotificationsRead' | 'markNotificationRead' | 'patchPreferences'
  >;
  csrfToken: string;
  user: NativeUser;
  serverUrl: string;
  busy: boolean;
  error: string | null;
  onLogout(): Promise<void>;
  onChangeServer(): Promise<void>;
  notificationEnabled: boolean;
  notificationPendingCount: number;
  notificationSyncing: boolean;
  onEnableNotifications(): Promise<void>;
  onRefreshNotifications(): Promise<void>;
  onOpenSession(sessionId: string, permissionId?: string | null): void;
  onOpenTask(taskId: string): void;
}) {
  const [settings, setSettings] = useState<NativeSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [quickReplyDraft, setQuickReplyDraft] = useState('');
  const [inboxOpen, setInboxOpen] = useState(false);
  const [notifications, setNotifications] = useState<NativeNotificationRecord[]>([]);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [release, setRelease] = useState<NativeReleaseMetadata | null>(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const currentVersion = Constants.expoConfig?.version ?? '未知';
  const releaseStatus = release
    ? presentReleaseStatus(currentVersion, release.version, release.source)
    : { action: 'check' as const, detail: '尚未检查更新', latestLabel: '等待检查' };

  const loadSettings = useCallback(async () => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const loaded = await api.getSettings();
      setSettings(loaded);
      setQuickReplyDraft(quickRepliesText(loaded.preferences.quick_replies));
      applyThemePreference(loaded.preferences.theme_mode);
    } catch (requestError) {
      setSettingsError(requestError instanceof Error ? requestError.message : '设置加载失败');
    } finally {
      setSettingsBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let active = true;
    setReleaseBusy(true);
    void api.getLatestRelease()
      .then((latest) => {
        if (active) setRelease(latest);
      })
      .finally(() => {
        if (active) setReleaseBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  async function loadInbox() {
    setInboxBusy(true);
    setInboxError(null);
    try {
      const result = await api.listNotifications();
      setNotifications(result.items.filter((item) => item.status !== 'dismissed' && item.status !== 'superseded'));
    } catch (requestError) {
      setInboxError(requestError instanceof Error ? requestError.message : '通知加载失败');
    } finally {
      setInboxBusy(false);
    }
  }

  async function openInbox() {
    setInboxOpen(true);
    await loadInbox();
  }

  async function setVoiceMode(voiceMode: 'streaming' | 'standard') {
    if (!settings || settingsBusy || settings.preferences.voice_mode === voiceMode) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const result = await api.patchPreferences({ voice_mode: voiceMode }, csrfToken);
      setSettings((current) => current ? { ...current, preferences: result.preferences } : current);
    } catch (requestError) {
      setSettingsError(requestError instanceof Error ? requestError.message : '语音偏好保存失败');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function setThemeMode(themeMode: 'dark' | 'light') {
    if (!settings || settingsBusy || settings.preferences.theme_mode === themeMode) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const result = await api.patchPreferences({ theme_mode: themeMode }, csrfToken);
      setSettings((current) => current ? { ...current, preferences: result.preferences } : current);
      applyThemePreference(result.preferences.theme_mode);
    } catch (requestError) {
      setSettingsError(requestError instanceof Error ? requestError.message : '外观偏好保存失败');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function setVoiceLanguage(voiceLanguage: string) {
    if (!settings || settingsBusy || settings.preferences.voice_language === voiceLanguage) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const result = await api.patchPreferences({ voice_language: voiceLanguage }, csrfToken);
      setSettings((current) => current ? { ...current, preferences: result.preferences } : current);
    } catch (requestError) {
      setSettingsError(requestError instanceof Error ? requestError.message : '语音语言保存失败');
    } finally {
      setSettingsBusy(false);
    }
  }

  async function saveQuickReplies() {
    if (!settings || settingsBusy) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const quickReplies = parseQuickReplies(quickReplyDraft);
      const result = await api.patchPreferences({ quick_replies: quickReplies }, csrfToken);
      setSettings((current) => current ? { ...current, preferences: result.preferences } : current);
      setQuickReplyDraft(quickRepliesText(result.preferences.quick_replies));
    } catch (requestError) {
      setSettingsError(requestError instanceof Error ? requestError.message : '快捷回复保存失败');
    } finally {
      setSettingsBusy(false);
    }
  }

  const configuredVoiceLanguages = Array.isArray(settings?.options.voice_languages)
    ? settings.options.voice_languages
        .filter((item): item is { value: string; label: string } => (
          typeof item === 'object' && item !== null &&
          typeof (item as { value?: unknown }).value === 'string' &&
          typeof (item as { label?: unknown }).label === 'string'
        ))
    : [
        { value: 'zh-CN', label: '中文' },
        { value: 'zh-TW', label: '繁體中文' },
        { value: 'en-US', label: 'English' },
      ];

  async function handleReleaseAction() {
    setReleaseBusy(true);
    try {
      if (release && releaseStatus.action === 'download') {
        await Linking.openURL(release.downloadUrl);
        return;
      }
      setRelease(await api.getLatestRelease());
    } finally {
      setReleaseBusy(false);
    }
  }

  async function openNotification(notification: NativeNotificationRecord) {
    try {
      if (notification.status !== 'read') await api.markNotificationRead(notification.notification_id, csrfToken);
      setNotifications((current) => current.map((item) => (
        item.notification_id === notification.notification_id ? { ...item, status: 'read', read_at: item.read_at ?? new Date().toISOString() } : item
      )));
      setInboxOpen(false);
      if (notification.source_type === 'task' && notification.source_id) onOpenTask(notification.source_id);
      else if (notification.session_id) {
        onOpenSession(
          notification.session_id,
          notification.source_type === 'permission' ? notification.source_id : null,
        );
      }
    } catch (requestError) {
      setInboxError(requestError instanceof Error ? requestError.message : '通知状态更新失败');
    }
  }

  async function dismissNotification(notificationId: string) {
    try {
      await api.dismissNotification(notificationId, csrfToken);
      setNotifications((current) => current.filter((item) => item.notification_id !== notificationId));
    } catch (requestError) {
      setInboxError(requestError instanceof Error ? requestError.message : '通知收起失败');
    }
  }

  async function markAllNotificationsRead() {
    if (inboxBusy || !notifications.some((item) => item.status === 'pending' || item.status === 'delivered')) return;
    setInboxBusy(true);
    setInboxError(null);
    try {
      await api.markAllNotificationsRead(csrfToken);
      const readAt = new Date().toISOString();
      setNotifications((current) => current.map((item) => (
        item.status === 'pending' || item.status === 'delivered'
          ? { ...item, status: 'read', read_at: item.read_at ?? readAt }
          : item
      )));
    } catch (requestError) {
      setInboxError(requestError instanceof Error ? requestError.message : '通知状态更新失败');
    } finally {
      setInboxBusy(false);
    }
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.screen}>
        <Text style={styles.eyebrow}>账户</Text>
        <Text selectable style={styles.title}>{user.email}</Text>
        <Text style={styles.role}>{user.role.toUpperCase()}</Text>
        <View style={styles.profileDetails}>
          <Text style={styles.detailLabel}>服务器</Text>
          <Text selectable style={styles.serverUrl}>{serverUrl}</Text>
        </View>
        <View style={styles.profileDetails}>
          <View style={styles.settingHeader}>
            <View style={styles.settingCopy}>
              <Text style={styles.detailLabel}>通知收件箱</Text>
              <Text style={styles.settingValue}>
                {notificationEnabled ? '已开启' : '未开启'} · 待处理 {notificationPendingCount}
              </Text>
            </View>
            <Pressable accessibilityLabel="打开通知收件箱" accessibilityRole="button" onPress={() => void openInbox()} style={({ pressed }) => [styles.settingButton, pressed && styles.buttonPressed]}>
              <Text style={styles.settingButtonText}>查看</Text>
            </Pressable>
          </View>
          <View style={styles.notificationActions}>
            <Pressable accessibilityLabel={notificationEnabled ? '同步通知' : '开启通知'} accessibilityRole="button" disabled={notificationSyncing} onPress={() => void (notificationEnabled ? onRefreshNotifications() : onEnableNotifications())} style={({ pressed }) => [styles.inlineAction, notificationSyncing && styles.disabled, pressed && styles.buttonPressed]}>
              <Ionicons color={colors.accent} name={notificationEnabled ? 'sync-outline' : 'notifications-outline'} size={16} />
              <Text style={styles.inlineActionText}>{notificationSyncing ? '同步中' : notificationEnabled ? '同步' : '开启通知'}</Text>
            </Pressable>
            <Text style={styles.settingHint}>只对审批、选择和失败任务发送提醒。</Text>
          </View>
        </View>
        <View style={styles.profileDetails}>
          <Text style={styles.detailLabel}>外观</Text>
          <View style={styles.preferenceRow}>
            {(['light', 'dark'] as const).map((mode) => {
              const selected = settings?.preferences.theme_mode === mode;
              return (
                <Pressable accessibilityLabel={`使用${mode === 'light' ? '浅色' : '深色'}外观`} accessibilityRole="button" accessibilityState={{ selected }} disabled={settingsBusy || !settings} key={mode} onPress={() => void setThemeMode(mode)} style={({ pressed }) => [styles.preferenceButton, selected && styles.preferenceButtonSelected, pressed && styles.buttonPressed]}>
                  <Ionicons color={selected ? colors.accent : colors.muted} name={mode === 'light' ? 'sunny-outline' : 'moon-outline'} size={16} />
                  <Text style={[styles.preferenceButtonText, selected && styles.preferenceButtonTextSelected]}>{mode === 'light' ? '浅色' : '深色'}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.settingHint}>外观偏好会同步到同一账户。</Text>
        </View>
        <View style={styles.profileDetails}>
          <Text style={styles.detailLabel}>语音输入</Text>
          <View style={styles.preferenceRow}>
            {(['streaming', 'standard'] as const).map((mode) => {
              const selected = settings?.preferences.voice_mode === mode;
              return (
                <Pressable accessibilityLabel={`使用${mode === 'streaming' ? '流式' : '标准'}语音识别`} accessibilityRole="button" accessibilityState={{ selected }} disabled={settingsBusy || !settings} key={mode} onPress={() => void setVoiceMode(mode)} style={({ pressed }) => [styles.preferenceButton, selected && styles.preferenceButtonSelected, pressed && styles.buttonPressed]}>
                  <Text style={[styles.preferenceButtonText, selected && styles.preferenceButtonTextSelected]}>{mode === 'streaming' ? '流式' : '标准'}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.detailLabel}>识别语言</Text>
          <View style={styles.preferenceRow}>
            {configuredVoiceLanguages.map((language) => {
              const selected = settings?.preferences.voice_language === language.value;
              return (
                <Pressable accessibilityLabel={`使用 ${language.label} 语音语言`} accessibilityRole="button" accessibilityState={{ selected }} disabled={settingsBusy || !settings} key={language.value} onPress={() => void setVoiceLanguage(language.value)} style={({ pressed }) => [styles.preferenceButton, selected && styles.preferenceButtonSelected, pressed && styles.buttonPressed]}>
                  <Text style={[styles.preferenceButtonText, selected && styles.preferenceButtonTextSelected]}>{language.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.settingHint}>{settingsBusy ? '正在同步偏好' : '偏好会同步到同一账户的控制台。'}</Text>
          {settingsError ? <Text accessibilityRole="alert" style={styles.error}>{settingsError}</Text> : null}
        </View>
        <View style={styles.profileDetails}>
          <View style={styles.settingHeader}>
            <View style={styles.settingCopy}>
              <Text style={styles.detailLabel}>快捷回复</Text>
              <Text style={styles.settingHint}>每行一条，最多 12 条；会同步到会话输入区。</Text>
            </View>
            <Pressable accessibilityLabel="保存快捷回复" accessibilityRole="button" disabled={settingsBusy || !settings} onPress={() => void saveQuickReplies()} style={({ pressed }) => [styles.settingButton, (settingsBusy || !settings) && styles.disabled, pressed && styles.buttonPressed]}>
              <Text style={styles.settingButtonText}>保存</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="快捷回复，每行一条"
            editable={!settingsBusy && Boolean(settings)}
            multiline
            onChangeText={setQuickReplyDraft}
            placeholder="继续"
            placeholderTextColor={colors.muted}
            style={styles.quickReplyInput}
            value={quickReplyDraft}
          />
        </View>
        <View style={styles.profileDetails}>
          <Text style={styles.detailLabel}>Worker 默认参数</Text>
          <Text style={styles.settingValue}>
            {settings ? workerDefaultsText(settings.worker_runtime_defaults) : '正在读取默认参数'}
          </Text>
          <Text style={styles.settingHint}>新接入 Worker 默认采用这些值，节点实际值请在“节点”详情查看。</Text>
        </View>
        <View style={styles.profileDetails}>
          <View style={styles.settingHeader}>
            <View style={styles.settingCopy}>
              <Text style={styles.detailLabel}>应用更新</Text>
              <Text style={styles.settingValue}>当前 {currentVersion} · {releaseStatus.latestLabel}</Text>
            </View>
            <Pressable accessibilityLabel={releaseStatus.action === 'download' ? '下载原生 APK 更新' : '检查原生 APK 更新'} accessibilityRole="button" disabled={releaseBusy} onPress={() => void handleReleaseAction()} style={({ pressed }) => [styles.settingButton, releaseBusy && styles.disabled, pressed && styles.buttonPressed]}>
              {releaseBusy ? <ActivityIndicator color={colors.accent} size="small" /> : <Text style={styles.settingButtonText}>{releaseStatus.action === 'download' ? '下载' : '检查'}</Text>}
            </Pressable>
          </View>
          <Text style={styles.settingHint}>{releaseStatus.detail}</Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.accountActions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onChangeServer()} style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}>
            <Text style={styles.secondaryButtonText}>更换服务器</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onLogout()} style={({ pressed }) => [styles.dangerButton, pressed && styles.buttonPressed]}>
            <Text style={styles.dangerButtonText}>退出登录</Text>
          </Pressable>
        </View>
      </ScrollView>
      <Modal animationType="slide" onRequestClose={() => setInboxOpen(false)} visible={inboxOpen}>
        <View style={styles.inboxScreen}>
          <View style={styles.inboxHeader}>
            <View><Text style={styles.eyebrow}>NOTIFICATION INBOX</Text><Text style={styles.inboxTitle}>通知</Text></View>
            <View style={styles.inboxHeaderActions}>
              <Pressable accessibilityLabel="刷新通知收件箱" accessibilityRole="button" disabled={inboxBusy} onPress={() => void loadInbox()} style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                {inboxBusy ? <ActivityIndicator color={colors.accent} size="small" /> : <Ionicons color={colors.accent} name="refresh" size={20} />}
              </Pressable>
              <Pressable accessibilityLabel="关闭通知收件箱" accessibilityRole="button" onPress={() => setInboxOpen(false)} style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                <Ionicons color={colors.text} name="close" size={21} />
              </Pressable>
            </View>
          </View>
          <View style={styles.inboxBulkActions}>
            <Pressable
              accessibilityLabel="全部通知标为已读"
              accessibilityRole="button"
              disabled={inboxBusy || !notifications.some((item) => item.status === 'pending' || item.status === 'delivered')}
              onPress={() => void markAllNotificationsRead()}
              style={({ pressed }) => [
                styles.inlineAction,
                (inboxBusy || !notifications.some((item) => item.status === 'pending' || item.status === 'delivered')) && styles.disabled,
                pressed && styles.buttonPressed,
              ]}
            >
              <Ionicons color={colors.accent} name="checkmark-done-outline" size={16} />
              <Text style={styles.inlineActionText}>全部已读</Text>
            </Pressable>
          </View>
          {inboxError ? <Text accessibilityRole="alert" style={styles.inboxError}>{inboxError}</Text> : null}
          <ScrollView contentContainerStyle={styles.inboxList}>
            {notifications.length === 0 && !inboxBusy ? <Text style={styles.emptyInbox}>当前没有待处理通知</Text> : null}
            {notifications.map((notification) => (
              <View key={notification.notification_id} style={styles.notificationCard}>
                <Pressable accessibilityLabel={`打开通知 ${notification.title}`} accessibilityRole="button" onPress={() => void openNotification(notification)} style={({ pressed }) => [styles.notificationCopy, pressed && styles.buttonPressed]}>
                  <View style={styles.notificationHeading}><Text numberOfLines={1} style={styles.notificationTitle}>{notification.title}</Text><Text style={[styles.notificationStatus, notification.status === 'read' && styles.notificationStatusRead]}>{notification.status === 'read' ? '已读' : '未读'}</Text></View>
                  <Text numberOfLines={3} style={styles.notificationBody}>{notification.body || '打开查看详情'}</Text>
                </Pressable>
                <Pressable accessibilityLabel={`收起通知 ${notification.title}`} accessibilityRole="button" onPress={() => void dismissNotification(notification.notification_id)} style={({ pressed }) => [styles.dismissButton, pressed && styles.buttonPressed]}>
                  <Text style={styles.dismissButtonText}>收起</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

interface MainTabsProps {
  api: MobileApi;
  csrfToken: string;
  user: NativeUser;
  serverUrl: string;
  busy: boolean;
  error: string | null;
  onRequestError(error: unknown): void;
  onLogout(): Promise<void>;
  onChangeServer(): Promise<void>;
}

export function MainTabs({
  api,
  csrfToken,
  user,
  serverUrl,
  busy,
  error,
  onRequestError,
  onLogout,
  onChangeServer,
}: MainTabsProps) {
  const colorScheme = useColorScheme();
  const dark = colorScheme === 'dark';
  const navigationTheme = dark
    ? {
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: '#101722',
          border: '#334258',
          card: '#172131',
          primary: '#4EA1FF',
          text: '#E7EDF5',
        },
      }
    : {
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          background: '#F4F7FA',
          border: '#D4DCE6',
          card: '#FFFFFF',
          primary: '#1473E6',
          text: '#111827',
        },
      };
  const navigationRef = useRef(createNavigationContainerRef<RootTabParamList>()).current;
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
  const [requestedPermissionId, setRequestedPermissionId] = useState<string | null>(null);
  const [requestedTaskId, setRequestedTaskId] = useState<string | null>(null);
  const [requestedFileTarget, setRequestedFileTarget] = useState<{ sessionId: string; path: string } | null>(null);
  const openNotificationSession = useCallback((sessionId: string, permissionId?: string | null) => {
    setRequestedSessionId(sessionId);
    setRequestedPermissionId(permissionId ?? null);
    if (navigationRef.isReady()) navigationRef.navigate('sessions');
  }, [navigationRef]);
  const openNotificationTask = useCallback((taskId: string) => {
    setRequestedTaskId(taskId);
    if (navigationRef.isReady()) navigationRef.navigate('tasks');
  }, [navigationRef]);
  const openSessionFile = useCallback((target: { sessionId: string; path: string }) => {
    setRequestedFileTarget(target);
    if (navigationRef.isReady()) navigationRef.navigate('files');
  }, [navigationRef]);
  const handleRequestedSessionHandled = useCallback((sessionId: string) => {
    setRequestedSessionId((current) => current === sessionId ? null : current);
  }, []);
  const handleRequestedPermissionHandled = useCallback((permissionId: string) => {
    setRequestedPermissionId((current) => current === permissionId ? null : current);
  }, []);
  const handleRequestedTaskHandled = useCallback((taskId: string) => {
    setRequestedTaskId((current) => current === taskId ? null : current);
  }, []);
  const handleRequestedFileHandled = useCallback((target: { sessionId: string; path: string }) => {
    setRequestedFileTarget((current) => (
      current?.sessionId === target.sessionId && current?.path === target.path ? null : current
    ));
  }, []);
  const notificationGuard = useNativeNotificationGuard(
    api,
    csrfToken,
    onRequestError,
    openNotificationSession,
    openNotificationTask,
  );
  return (
    <NavigationContainer ref={navigationRef} theme={navigationTheme}>
      <Tab.Navigator
        screenOptions={({ route }) => {
          const definition = nativeTabs.find((tab) => tab.key === route.name)!;
          return {
            headerShown: !definition.ownsHeader,
            headerShadowVisible: false,
            headerStyle: { backgroundColor: colors.canvas },
            headerTitleStyle: { color: colors.text, fontSize: 18, fontWeight: '700' },
            tabBarActiveTintColor: dark ? '#4EA1FF' : '#1473E6',
            tabBarInactiveTintColor: dark ? '#A7B3C4' : '#667085',
            tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
            tabBarStyle: { borderTopColor: colors.border, height: 70, paddingBottom: 9, paddingTop: 7 },
            tabBarIcon: ({ color, size }) => (
              <Ionicons color={color} name={definition.icon as never} size={size} />
            ),
          };
        }}
      >
        {nativeTabs.map((tab) => (
          <Tab.Screen key={tab.key} name={tab.key} options={{ title: tab.label }}>
            {() => {
              if (tab.key === 'sessions') {
                return (
                  <SessionsScreen
                    api={api}
                    canOperate={user.role !== 'viewer'}
                    canTerminate={user.role === 'owner' || user.role === 'admin'}
                    csrfToken={csrfToken}
                    onRequestError={onRequestError}
                    onRequestedSessionHandled={handleRequestedSessionHandled}
                    onRequestedPermissionHandled={handleRequestedPermissionHandled}
                    onOpenFile={openSessionFile}
                    onOpenTask={openNotificationTask}
                    requestedSessionId={requestedSessionId}
                    requestedPermissionId={requestedPermissionId}
                  />
                );
              }
              if (tab.key === 'tasks') {
                return (
                  <TasksScreen
                    api={api}
                    canOperate={user.role !== 'viewer'}
                    csrfToken={csrfToken}
                    onOpenFile={openSessionFile}
                    onRequestError={onRequestError}
                    onRequestedTaskHandled={handleRequestedTaskHandled}
                    requestedTaskId={requestedTaskId}
                  />
                );
              }
              if (tab.key === 'workers') {
                return (
                  <WorkersScreen
                    api={api}
                    canManage={user.role === 'owner' || user.role === 'admin'}
                    csrfToken={csrfToken}
                    onRequestError={onRequestError}
                  />
                );
              }
              if (tab.key === 'files') {
                return (
                  <FilesScreen
                    api={api}
                    canEdit={user.role !== 'viewer'}
                    csrfToken={csrfToken}
                    onRequestError={onRequestError}
                    onRequestedTargetHandled={handleRequestedFileHandled}
                    requestedTarget={requestedFileTarget}
                  />
                );
              }
              if (tab.key === 'me') {
                return (
                  <ProfileScreen
                    api={api}
                    busy={busy}
                    csrfToken={csrfToken}
                    error={error}
                    onChangeServer={onChangeServer}
                    notificationEnabled={notificationGuard.enabled}
                    notificationPendingCount={notificationGuard.pendingCount}
                    notificationSyncing={notificationGuard.syncing}
                    onEnableNotifications={notificationGuard.enable}
                    onLogout={onLogout}
                    onOpenSession={openNotificationSession}
                    onOpenTask={openNotificationTask}
                    onRefreshNotifications={notificationGuard.refresh}
                    serverUrl={serverUrl}
                    user={user}
                  />
                );
              }
              return null;
            }}
          </Tab.Screen>
        ))}
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.canvas,
    gap: 12,
    minHeight: '100%',
    paddingBottom: 32,
    paddingHorizontal: 24,
    paddingTop: 34,
  },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', lineHeight: 28 },
  detailLabel: { color: colors.muted, fontSize: 12 },
  serverUrl: { color: colors.text, fontSize: 13, lineHeight: 18 },
  role: { color: colors.success, fontSize: 12, fontWeight: '800' },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  profileDetails: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 5,
    marginBottom: 10,
    marginTop: 10,
    paddingVertical: 18,
  },
  settingHeader: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  settingCopy: { flex: 1, gap: 4 },
  settingValue: { color: colors.text, fontSize: 14, fontWeight: '700' },
  settingHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  notificationActions: { alignItems: 'flex-start', gap: 8 },
  inlineAction: { alignItems: 'center', flexDirection: 'row', gap: 6, minHeight: 32 },
  inlineActionText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  settingButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    minWidth: 68,
    paddingHorizontal: 12,
  },
  settingButtonText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  preferenceRow: { flexDirection: 'row', gap: 8 },
  preferenceButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 40,
    minWidth: 76,
    paddingHorizontal: 12,
  },
  preferenceButtonSelected: { backgroundColor: colors.surfaceMuted, borderColor: colors.accent },
  preferenceButtonText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  preferenceButtonTextSelected: { color: colors.accent },
  quickReplyInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
    minHeight: 110,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  accountActions: { gap: 10, marginTop: 8 },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  secondaryButtonText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  dangerButton: {
    alignItems: 'center',
    borderColor: '#F3C9C4',
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  dangerButtonText: { color: colors.danger, fontSize: 15, fontWeight: '700' },
  inboxScreen: { backgroundColor: colors.canvas, flex: 1 },
  inboxHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  inboxHeaderActions: { flexDirection: 'row', gap: 8 },
  inboxBulkActions: { alignItems: 'flex-end', paddingHorizontal: 18, paddingTop: 8 },
  iconButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  inboxTitle: { color: colors.text, fontSize: 26, fontWeight: '800', marginTop: 2 },
  inboxError: { color: colors.danger, fontSize: 13, paddingHorizontal: 18, paddingTop: 12 },
  inboxList: { gap: 10, padding: 16 },
  emptyInbox: { color: colors.muted, fontSize: 14, paddingTop: 40, textAlign: 'center' },
  notificationCard: {
    alignItems: 'stretch',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 13,
  },
  notificationCopy: { flex: 1, gap: 6 },
  notificationHeading: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  notificationTitle: { color: colors.text, flex: 1, fontSize: 14, fontWeight: '800' },
  notificationStatus: { color: colors.accent, fontSize: 11, fontWeight: '700' },
  notificationStatusRead: { color: colors.muted },
  notificationBody: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  dismissButton: { alignItems: 'center', justifyContent: 'center', minHeight: 36, paddingHorizontal: 3 },
  dismissButtonText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  buttonPressed: { opacity: 0.65 },
  disabled: { opacity: 0.45 },
});
