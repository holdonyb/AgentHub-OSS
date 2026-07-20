import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';

interface ResourceHeaderProps {
  actions?: ReactNode;
  compact?: boolean;
  eyebrow?: string;
  title: string;
  refreshLabel: string;
  refreshing: boolean;
  onRefresh(): Promise<void>;
}

export function ResourceHeader({
  actions,
  compact = false,
  eyebrow,
  title,
  refreshLabel,
  refreshing,
  onRefresh,
}: ResourceHeaderProps) {
  return (
    <View style={[styles.header, compact && styles.headerCompact]}>
      <View style={styles.headerCopy}>
        {!compact && eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={[styles.title, compact && styles.titleCompact]}>{title}</Text>
      </View>
      <View style={styles.headerActions}>
        {actions}
        <Pressable
          accessibilityLabel={refreshLabel}
          accessibilityRole="button"
          disabled={refreshing}
          onPress={() => void onRefresh()}
          style={({ pressed }) => [
            styles.iconButton,
            pressed && styles.buttonPressed,
            refreshing && styles.buttonDisabled,
          ]}
        >
          {refreshing ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : (
            <Ionicons color={colors.accent} name="refresh" size={21} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

interface ResourceStateProps {
  empty: boolean;
  emptyText: string;
  error: string | null;
  failureTitle: string;
  loading: boolean;
  loadingText: string;
  retryLabel: string;
  onRetry(): Promise<void>;
}

export function ResourceState({
  empty,
  emptyText,
  error,
  failureTitle,
  loading,
  loadingText,
  retryLabel,
  onRetry,
}: ResourceStateProps) {
  if (loading) {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.stateText}>{loadingText}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.state}>
        <Ionicons color={colors.danger} name="alert-circle-outline" size={30} />
        <Text style={styles.failureTitle}>{failureTitle}</Text>
        <Text style={styles.stateText}>{error}</Text>
        <Pressable
          accessibilityLabel={retryLabel}
          accessibilityRole="button"
          onPress={() => void onRetry()}
          style={({ pressed }) => [styles.retryButton, pressed && styles.buttonPressed]}
        >
          <Ionicons color={colors.surface} name="refresh" size={17} />
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      </View>
    );
  }
  if (empty) {
    return (
      <View style={styles.state}>
        <Ionicons color={colors.muted} name="file-tray-outline" size={30} />
        <Text style={styles.stateText}>{emptyText}</Text>
      </View>
    );
  }
  return null;
}

export function ResourceErrorBanner({
  error,
  retryLabel,
  onRetry,
}: {
  error: string;
  retryLabel: string;
  onRetry(): Promise<void>;
}) {
  return (
    <View style={styles.errorBanner}>
      <Ionicons color={colors.danger} name="warning-outline" size={18} />
      <Text numberOfLines={2} style={styles.errorBannerText}>{error}</Text>
      <Pressable
        accessibilityLabel={retryLabel}
        accessibilityRole="button"
        onPress={() => void onRetry()}
        style={({ pressed }) => [styles.bannerRetry, pressed && styles.buttonPressed]}
      >
        <Text style={styles.bannerRetryText}>重试</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 18,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  headerCompact: { paddingBottom: 10, paddingTop: 10 },
  headerCopy: { flex: 1, gap: 4 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800' },
  title: { color: colors.text, fontSize: 26, fontWeight: '700' },
  titleCompact: { fontSize: 22 },
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
  state: {
    alignItems: 'center',
    flex: 1,
    gap: 10,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 80,
  },
  stateText: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  failureTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  retryButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    marginTop: 4,
    minHeight: 42,
    paddingHorizontal: 18,
  },
  retryText: { color: colors.surface, fontSize: 14, fontWeight: '700' },
  errorBanner: {
    alignItems: 'center',
    backgroundColor: '#FEF3F2',
    borderColor: '#FECDCA',
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    padding: 12,
  },
  errorBannerText: { color: colors.danger, flex: 1, fontSize: 13, lineHeight: 18 },
  bannerRetry: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 5 },
  bannerRetryText: { color: colors.danger, fontSize: 13, fontWeight: '700' },
  buttonPressed: { opacity: 0.65 },
  buttonDisabled: { opacity: 0.55 },
});
