import { Ionicons } from '@expo/vector-icons';
import { useCallback } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { MobileApi, NativeWorkerSummary } from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import {
  formatLastActivity,
  workerCapabilityLabels,
  workerStatusLabel,
} from './resourcePresentation';

type WorkersApi = Pick<MobileApi, 'listWorkers'>;

export function WorkersScreen({
  api,
  onRequestError,
}: {
  api: WorkersApi;
  onRequestError?(error: unknown): void;
}) {
  const loadWorkers = useCallback(async () => (await api.listWorkers()).items, [api]);
  const resource = useAsyncResource(loadWorkers, { onError: onRequestError });
  const workers = resource.data ?? [];

  function renderWorker({ item }: { item: NativeWorkerSummary }) {
    const capabilities = workerCapabilityLabels(item.reachable_backends, item.capabilities);
    return (
      <View style={styles.card}>
        <View style={styles.cardTitleRow}>
          <View style={styles.machineCopy}>
            <Text numberOfLines={1} style={styles.cardTitle}>{item.machine_name || item.worker_id}</Text>
            <Text numberOfLines={1} style={styles.workerId}>{item.worker_id} · {item.os}</Text>
          </View>
          <View style={[styles.statusBadge, workerStatusTone(item.status)]}>
            <View style={[styles.statusDot, workerStatusDot(item.status)]} />
            <Text style={[styles.statusText, workerStatusTextTone(item.status)]}>
              {workerStatusLabel(item.status)}
            </Text>
          </View>
        </View>
        <View style={styles.divider} />
        <View style={styles.capabilityHeader}>
          <Ionicons color={colors.muted} name="hardware-chip-outline" size={17} />
          <Text style={styles.capabilityLabel}>能力</Text>
        </View>
        {capabilities.length === 0 ? (
          <Text style={styles.emptyCapabilities}>暂无已上报能力</Text>
        ) : (
          <View style={styles.capabilities}>
            {capabilities.map((capability) => (
              <View key={capability} style={styles.capabilityBadge}>
                <Text style={styles.capabilityText}>{capability}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={styles.heartbeat}>最近心跳 {formatLastActivity(item.last_heartbeat_at)}</Text>
      </View>
    );
  }

  const fullState = resource.loading || (resource.error !== null && resource.data === null) || workers.length === 0;
  return (
    <View style={styles.screen}>
      <ResourceHeader
        eyebrow="RUNTIME FLEET"
        onRefresh={resource.reload}
        refreshLabel="刷新节点"
        refreshing={resource.loading || resource.refreshing}
        title="节点"
      />
      {fullState ? (
        <ResourceState
          empty={workers.length === 0}
          emptyText="暂无节点"
          error={resource.error}
          failureTitle="节点加载失败"
          loading={resource.loading}
          loadingText="正在加载节点"
          onRetry={resource.reload}
          retryLabel="重试加载节点"
        />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={workers}
          keyExtractor={(item) => item.worker_id}
          ListHeaderComponent={resource.error ? (
            <ResourceErrorBanner
              error={resource.error}
              onRetry={resource.reload}
              retryLabel="重试加载节点"
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
          renderItem={renderWorker}
        />
      )}
    </View>
  );
}

function workerStatusTone(status: NativeWorkerSummary['status']) {
  if (status === 'online') return styles.statusOnline;
  if (status === 'degraded') return styles.statusDegraded;
  return styles.statusOffline;
}

function workerStatusDot(status: NativeWorkerSummary['status']) {
  if (status === 'online') return styles.dotOnline;
  if (status === 'degraded') return styles.dotDegraded;
  return styles.dotOffline;
}

function workerStatusTextTone(status: NativeWorkerSummary['status']) {
  if (status === 'online') return styles.textOnline;
  if (status === 'degraded') return styles.textDegraded;
  return styles.textOffline;
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
  cardTitleRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  machineCopy: { flex: 1, gap: 4 },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  workerId: { color: colors.muted, fontSize: 12 },
  statusBadge: {
    alignItems: 'center',
    borderRadius: 5,
    flexDirection: 'row',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  statusOnline: { backgroundColor: '#ECFDF3' },
  statusDegraded: { backgroundColor: '#FFFAEB' },
  statusOffline: { backgroundColor: colors.surfaceMuted },
  statusDot: { borderRadius: 4, height: 7, width: 7 },
  dotOnline: { backgroundColor: colors.success },
  dotDegraded: { backgroundColor: '#DC6803' },
  dotOffline: { backgroundColor: colors.muted },
  statusText: { fontSize: 12, fontWeight: '700' },
  textOnline: { color: colors.success },
  textDegraded: { color: '#B54708' },
  textOffline: { color: colors.muted },
  divider: { backgroundColor: colors.border, height: 1 },
  capabilityHeader: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  capabilityLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  capabilities: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  capabilityBadge: { backgroundColor: colors.surfaceMuted, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 5 },
  capabilityText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  emptyCapabilities: { color: colors.muted, fontSize: 12 },
  heartbeat: { color: colors.muted, fontSize: 12 },
});
