import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNavigationContainerRef, NavigationContainer } from '@react-navigation/native';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MobileApi, NativeUser } from '../api/mobileApi';
import { useNativeNotificationGuard } from '../notifications/useNativeNotificationGuard';
import { FilesScreen } from '../screens/FilesScreen';
import { SessionsScreen } from '../screens/SessionsScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { WorkersScreen } from '../screens/WorkersScreen';
import { colors } from '../ui/theme';
import { nativeTabs, type NativeTabKey } from './tabDefinitions';

type RootTabParamList = Record<NativeTabKey, undefined>;
const Tab = createBottomTabNavigator<RootTabParamList>();

function ProfileScreen({
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
}: {
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
}) {
  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>账户</Text>
      <Text style={styles.title}>{user.email}</Text>
      <Text style={styles.role}>{user.role.toUpperCase()}</Text>
      <View style={styles.profileDetails}>
        <Text style={styles.detailLabel}>服务器</Text>
        <Text style={styles.serverUrl}>{serverUrl}</Text>
      </View>
      <View style={styles.profileDetails}>
        <View style={styles.settingHeader}>
          <View style={styles.settingCopy}>
            <Text style={styles.detailLabel}>通知</Text>
            <Text style={styles.settingValue}>
              {notificationEnabled ? '已开启' : '未开启'} · 待处理 {notificationPendingCount}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={notificationSyncing}
            onPress={() => void (notificationEnabled ? onRefreshNotifications() : onEnableNotifications())}
            style={({ pressed }) => [styles.settingButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.settingButtonText}>
              {notificationSyncing ? '同步中' : notificationEnabled ? '同步' : '开启'}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.settingHint}>审批、用户选择和失败任务会发送原生提醒。</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void onLogout()}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
      >
        <Text style={styles.secondaryButtonText}>退出登录</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void onChangeServer()}
        style={({ pressed }) => [styles.textButton, pressed && styles.buttonPressed]}
      >
        <Text style={styles.textButtonText}>更换服务器</Text>
      </Pressable>
    </View>
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
  const navigationRef = useRef(createNavigationContainerRef<RootTabParamList>()).current;
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
  const openNotificationSession = useCallback((sessionId: string) => {
    setRequestedSessionId(sessionId);
    if (navigationRef.isReady()) navigationRef.navigate('sessions');
  }, [navigationRef]);
  const handleRequestedSessionHandled = useCallback((sessionId: string) => {
    setRequestedSessionId((current) => current === sessionId ? null : current);
  }, []);
  const notificationGuard = useNativeNotificationGuard(api, csrfToken, onRequestError, openNotificationSession);
  return (
    <NavigationContainer ref={navigationRef}>
      <Tab.Navigator
        screenOptions={({ route }) => {
          const definition = nativeTabs.find((tab) => tab.key === route.name)!;
          return {
            headerShown: !definition.ownsHeader,
            headerShadowVisible: false,
            headerStyle: { backgroundColor: colors.canvas },
            headerTitleStyle: { color: colors.text, fontSize: 18, fontWeight: '700' },
            tabBarActiveTintColor: colors.accent,
            tabBarInactiveTintColor: colors.muted,
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
                    canTerminate={user.role === 'owner' || user.role === 'admin'}
                    csrfToken={csrfToken}
                    onRequestError={onRequestError}
                    onRequestedSessionHandled={handleRequestedSessionHandled}
                    requestedSessionId={requestedSessionId}
                  />
                );
              }
              if (tab.key === 'tasks') {
                return (
                  <TasksScreen
                    api={api}
                    canOperate={user.role !== 'viewer'}
                    csrfToken={csrfToken}
                    onRequestError={onRequestError}
                  />
                );
              }
              if (tab.key === 'workers') {
                return <WorkersScreen api={api} onRequestError={onRequestError} />;
              }
              if (tab.key === 'files') {
                return (
                  <FilesScreen
                    api={api}
                    canEdit={user.role !== 'viewer'}
                    csrfToken={csrfToken}
                    onRequestError={onRequestError}
                  />
                );
              }
              if (tab.key === 'me') {
                return (
                  <ProfileScreen
                    busy={busy}
                    error={error}
                    onChangeServer={onChangeServer}
                    notificationEnabled={notificationGuard.enabled}
                    notificationPendingCount={notificationGuard.pendingCount}
                    notificationSyncing={notificationGuard.syncing}
                    onEnableNotifications={notificationGuard.enable}
                    onLogout={onLogout}
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
    flex: 1,
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 34,
  },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  detailLabel: { color: colors.muted, fontSize: 12 },
  serverUrl: { color: colors.text, fontSize: 14, lineHeight: 20 },
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
  textButton: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  textButtonText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  buttonPressed: { opacity: 0.65 },
});
