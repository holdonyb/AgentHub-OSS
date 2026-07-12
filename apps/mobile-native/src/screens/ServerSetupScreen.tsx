import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { validateServerUrl, type ServerConfig, type ServerUrlValidationReason } from '../config/serverConfig';
import { BrandHeader } from '../ui/BrandHeader';
import { colors } from '../ui/theme';

const validationMessages: Record<ServerUrlValidationReason, string> = {
  required: '请输入 AgentHub 服务器地址',
  invalid_url: '请输入完整的服务器 URL',
  origin_only: '只填写服务器 origin，不要包含路径、参数或账号信息',
  https_required: '生产服务器必须使用 HTTPS',
  private_http_only: 'HTTP 仅允许 localhost 或 Tailscale 私网地址',
};

interface ServerSetupScreenProps {
  busy: boolean;
  initialError?: string | null;
  onSave(config: ServerConfig): Promise<void>;
}

export function ServerSetupScreen({ busy, initialError = null, onSave }: ServerSetupScreenProps) {
  const [serverUrl, setServerUrl] = useState('');
  const [allowPrivateHttp, setAllowPrivateHttp] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function handleSave() {
    const result = validateServerUrl(serverUrl, { allowPrivateHttp });
    if (!result.ok) {
      setError(validationMessages[result.reason]);
      return;
    }
    setError(null);
    try {
      await onSave({ serverUrl: result.url, allowPrivateHttp });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '服务器配置保存失败');
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.keyboard}
    >
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <BrandHeader subtitle="连接你的自托管服务器" />
        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>服务器 URL</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setServerUrl}
              placeholder="https://agenthub.example.com"
              placeholderTextColor="#98A2B3"
              style={styles.input}
              value={serverUrl}
            />
          </View>
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.label}>允许私网 HTTP</Text>
              <Text style={styles.help}>仅用于 localhost 或 Tailscale 开发环境</Text>
            </View>
            <Switch
              onValueChange={setAllowPrivateHttp}
              trackColor={{ false: colors.border, true: '#9BC7F6' }}
              thumbColor={allowPrivateHttp ? colors.accent : '#FFFFFF'}
              value={allowPrivateHttp}
            />
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void handleSave()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
              busy && styles.disabled,
            ]}
          >
            <Text style={styles.primaryButtonText}>{busy ? '正在保存…' : '继续'}</Text>
          </Pressable>
          <Text style={styles.securityNote}>配置保存在设备安全存储中，密码不会被保存。</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  keyboard: { backgroundColor: colors.canvas, flex: 1 },
  screen: {
    flexGrow: 1,
    gap: 38,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 44,
  },
  form: { gap: 22 },
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
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'space-between',
  },
  switchCopy: { flex: 1, gap: 4 },
  help: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    minHeight: 52,
    justifyContent: 'center',
  },
  primaryButtonPressed: { backgroundColor: colors.accentPressed },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  securityNote: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
