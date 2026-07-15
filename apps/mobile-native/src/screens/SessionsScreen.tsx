import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MobileApi, NativeSessionSummary } from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, sessionStatusLabel } from './resourcePresentation';
import { SessionDetailScreen } from './SessionDetailScreen';

type SessionsApi = Pick<
  MobileApi,
  | 'getSession'
  | 'getSessionTimeline'
  | 'listJobs'
  | 'listPermissions'
  | 'listSessions'
  | 'respondPermission'
  | 'sendSessionInput'
  | 'transcribeVoice'
  | 'terminateSession'
>;

export function SessionsScreen({
  api,
  onRequestError,
  csrfToken = '',
  canTerminate = false,
  requestedSessionId = null,
  onRequestedSessionHandled,
}: {
  api: SessionsApi;
  onRequestError?(error: unknown): void;
  csrfToken?: string;
  canTerminate?: boolean;
  requestedSessionId?: string | null;
  onRequestedSessionHandled?(sessionId: string): void;
}) {
  const [selectedSession, setSelectedSession] = useState<NativeSessionSummary | null>(null);
  const loadSessions = useCallback(async () => (await api.listSessions()).items, [api]);
  const resource = useAsyncResource(loadSessions, { onError: onRequestError });
  const sessions = resource.data ?? [];

  useEffect(() => {
    if (!requestedSessionId) return;
    let active = true;
    void api.getSession(requestedSessionId)
      .then((payload) => {
        if (active) setSelectedSession(payload.session);
      })
      .catch((error) => onRequestError?.(error))
      .finally(() => onRequestedSessionHandled?.(requestedSessionId));
    return () => {
      active = false;
    };
  }, [api, onRequestError, onRequestedSessionHandled, requestedSessionId]);

  if (selectedSession) {
    return (
      <SessionDetailScreen
        api={api}
        canTerminate={canTerminate}
        csrfToken={csrfToken}
        onBack={() => {
          setSelectedSession(null);
          void resource.reload();
        }}
        onRequestError={onRequestError}
        session={selectedSession}
      />
    );
  }

  function renderSession({ item }: { item: NativeSessionSummary }) {
    return (
      <Pressable
        accessibilityLabel={`打开会话 ${item.title}`}
        accessibilityRole="button"
        onPress={() => setSelectedSession(item)}
        style={({ pressed }) => [
          styles.card,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.cardTitleRow}>
          <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
          <Ionicons color={colors.muted} name="chevron-forward" size={20} />
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
    <SafeAreaView edges={['top']} style={styles.screen}>
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
    </SafeAreaView>
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
