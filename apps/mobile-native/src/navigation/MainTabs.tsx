import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeUser } from '../api/mobileApi';
import { colors } from '../ui/theme';
import { nativeTabs, type NativeTabKey } from './tabDefinitions';

type RootTabParamList = Record<NativeTabKey, undefined>;
const Tab = createBottomTabNavigator<RootTabParamList>();

const screenCopy: Record<Exclude<NativeTabKey, 'me'>, { title: string; detail: string }> = {
  sessions: { title: '会话', detail: '服务器连接已验证' },
  tasks: { title: '任务', detail: '服务器连接已验证' },
  files: { title: '文件', detail: '服务器连接已验证' },
  workers: { title: '节点', detail: '服务器连接已验证' },
};

function ConnectedScreen({ tab, serverUrl }: { tab: Exclude<NativeTabKey, 'me'>; serverUrl: string }) {
  const copy = screenCopy[tab];
  return (
    <View style={styles.screen}>
      <Text style={styles.eyebrow}>AGENTHUB</Text>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.detail}>{copy.detail}</Text>
      <Text numberOfLines={2} style={styles.serverUrl}>{serverUrl}</Text>
    </View>
  );
}

function ProfileScreen({
  user,
  serverUrl,
  busy,
  error,
  onLogout,
  onChangeServer,
}: {
  user: NativeUser;
  serverUrl: string;
  busy: boolean;
  error: string | null;
  onLogout(): Promise<void>;
  onChangeServer(): Promise<void>;
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
  user: NativeUser;
  serverUrl: string;
  busy: boolean;
  error: string | null;
  onLogout(): Promise<void>;
  onChangeServer(): Promise<void>;
}

export function MainTabs({ user, serverUrl, busy, error, onLogout, onChangeServer }: MainTabsProps) {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={({ route }) => {
          const definition = nativeTabs.find((tab) => tab.key === route.name)!;
          return {
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
            {() => tab.key === 'me' ? (
              <ProfileScreen
                busy={busy}
                error={error}
                onChangeServer={onChangeServer}
                onLogout={onLogout}
                serverUrl={serverUrl}
                user={user}
              />
            ) : (
              <ConnectedScreen serverUrl={serverUrl} tab={tab.key} />
            )}
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
  detail: { color: colors.muted, fontSize: 15 },
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
