import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { MobileApi, NativeSessionSummary } from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, sessionStatusLabel } from './resourcePresentation';

type SessionsApi = Pick<MobileApi, 'listSessions'>;

export function SessionsScreen({
  api,
  onRequestError,
}: {
  api: SessionsApi;
  onRequestError?(error: unknown): void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const loadSessions = useCallback(async () => (await api.listSessions()).items, [api]);
  const resource = useAsyncResource(loadSessions, { onError: onRequestError });
  const sessions = resource.data ?? [];

  function renderSession({ item }: { item: NativeSessionSummary }) {
    const selected = item.session_id === selectedSessionId;
    return (
      <Pressable
        accessibilityLabel={`选择会话 ${item.title}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => setSelectedSessionId(item.session_id)}
        style={({ pressed }) => [
          styles.card,
          selected && styles.cardSelected,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.cardTitleRow}>
          <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
          {selected ? <Ionicons color={colors.accent} name="checkmark-circle" size={20} /> : null}
        </View>
        <View style={styles.metadataRow}>
          <View style={styles.badge}><Text style={styles.badgeText}>{item.backend}</Text></View>
          <Text numberOfLines={1} style={styles.workerText}>{item.worker_id}</Text>
        </View>
        <View style={styles.footerRow}>
          <Text style={styles.statusText}>{sessionStatusLabel(item.status)}</Text>
          <Text style={styles.activityText}>{formatLastActivity(item.last_activity_at)}</Text>
        </View>
      </Pressable>
    );
  }

  const fullState = resource.loading || (resource.error !== null && resource.data === null) || sessions.length === 0;
  return (
    <View style={styles.screen}>
      <ResourceHeader
        eyebrow="SESSION INBOX"
        onRefresh={resource.reload}
        refreshLabel="刷新会话"
        refreshing={resource.loading || resource.refreshing}
        title="会话"
      />
      {fullState ? (
        <ResourceState
          empty={sessions.length === 0}
          emptyText="暂无会话"
          error={resource.error}
          failureTitle="会话加载失败"
          loading={resource.loading}
          loadingText="正在加载会话"
          onRetry={resource.reload}
          retryLabel="重试加载会话"
        />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={sessions}
          keyExtractor={(item) => item.session_id}
          ListHeaderComponent={resource.error ? (
            <ResourceErrorBanner
              error={resource.error}
              onRetry={resource.reload}
              retryLabel="重试加载会话"
            />
          ) : null}
          refreshControl={(
            <RefreshControl
              colors={[colors.accent]}
              onRefresh={() => void resource.reload()}
              refreshing={resource.refreshing}
              tintColor={colors.accent}
            />
          )}
          renderItem={renderSession}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.canvas, flex: 1 },
  list: { gap: 10, paddingBottom: 28, paddingHorizontal: 16 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 12,
    padding: 15,
  },
  cardSelected: { borderColor: colors.accent, borderWidth: 2, padding: 14 },
  cardPressed: { opacity: 0.72 },
  cardTitleRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  cardTitle: { color: colors.text, flex: 1, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  metadataRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  badge: { backgroundColor: colors.surfaceMuted, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  workerText: { color: colors.muted, flex: 1, fontSize: 12 },
  footerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  statusText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  activityText: { color: colors.muted, fontSize: 12 },
});
