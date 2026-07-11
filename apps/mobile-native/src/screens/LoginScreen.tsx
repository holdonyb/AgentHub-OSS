import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BrandHeader } from '../ui/BrandHeader';
import { colors } from '../ui/theme';

interface LoginScreenProps {
  serverUrl: string;
  busy: boolean;
  error: string | null;
  onLogin(email: string, password: string): Promise<void>;
  onChangeServer(): Promise<void>;
}

export function LoginScreen({ serverUrl, busy, error, onLogin, onChangeServer }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.keyboard}
    >
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <BrandHeader subtitle="登录你的控制平面" />
        <View style={styles.serverRow}>
          <View style={styles.serverCopy}>
            <Text style={styles.serverLabel}>当前服务器</Text>
            <Text numberOfLines={1} style={styles.serverUrl}>{serverUrl}</Text>
          </View>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void onChangeServer()}>
            <Text style={styles.link}>更换</Text>
          </Pressable>
        </View>
        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>邮箱</Text>
            <TextInput
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setEmail}
              style={styles.input}
              value={email}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>密码</Text>
            <TextInput
              autoComplete="current-password"
              onChangeText={setPassword}
              secureTextEntry
              style={styles.input}
              value={password}
            />
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy || !email.trim() || !password}
            onPress={() => void onLogin(email.trim(), password)}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
              (busy || !email.trim() || !password) && styles.disabled,
            ]}
          >
            <Text style={styles.primaryButtonText}>{busy ? '正在登录…' : '登录'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { backgroundColor: colors.canvas, flex: 1 },
  screen: {
    flexGrow: 1,
    gap: 30,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 44,
  },
  serverRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 14,
    paddingBottom: 14,
  },
  serverCopy: { flex: 1, gap: 3 },
  serverLabel: { color: colors.muted, fontSize: 12 },
  serverUrl: { color: colors.text, fontSize: 14, fontWeight: '600' },
  link: { color: colors.accent, fontSize: 14, fontWeight: '700', padding: 8 },
  form: { gap: 20 },
  field: { gap: 8 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    justifyContent: 'center',
    minHeight: 52,
  },
  primaryButtonPressed: { backgroundColor: colors.accentPressed },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
