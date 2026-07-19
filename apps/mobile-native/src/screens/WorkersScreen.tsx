import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState, type ReactNode } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { MobileApi, NativeProviderSnapshot, NativeWorkerSummary } from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import {
  formatLastActivity,
  workerCapabilityLabels,
  workerStatusLabel,
} from './resourcePresentation';

type WorkersApi = Pick<MobileApi, 'listProviderSnapshots' | 'listWorkers'> &
  Partial<Pick<MobileApi, 'loginProvider' | 'logoutProvider'>>;

export function WorkersScreen({
  api,
  canManage = false,
  csrfToken = '',
  onRequestError,
}: {
  api: WorkersApi;
  canManage?: boolean;
  csrfToken?: string;
  onRequestError?(error: unknown): void;
}) {
  const loadWorkers = useCallback(async () => (await api.listWorkers()).items, [api]);
  const resource = useAsyncResource(loadWorkers, { onError: onRequestError });
  const workers = resource.data ?? [];
  const [selectedWorker, setSelectedWorker] = useState<NativeWorkerSummary | null>(null);

  if (selectedWorker) {
    return (
      <WorkerDetailScreen
        api={api}
        canManage={canManage}
        csrfToken={csrfToken}
        onBack={() => setSelectedWorker(null)}
        onRequestError={onRequestError}
        worker={selectedWorker}
      />
    );
  }

  function renderWorker({ item }: { item: NativeWorkerSummary }) {
    const capabilities = workerCapabilityLabels(item.reachable_backends, item.capabilities);
    return (
      <Pressable
        accessibilityLabel={`查看节点 ${item.machine_name || item.worker_id}`}
        accessibilityRole="button"
        onPress={() => setSelectedWorker(item)}
        style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      >
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
        <View style={styles.cardFooter}>
          <Text style={styles.heartbeat}>最近心跳 {formatLastActivity(item.last_heartbeat_at)}</Text>
          <Ionicons color={colors.muted} name="chevron-forward" size={18} />
        </View>
      </Pressable>
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

function WorkerDetailScreen({
  api,
  canManage,
  csrfToken,
  worker,
  onBack,
  onRequestError,
}: {
  api: WorkersApi;
  canManage: boolean;
  csrfToken: string;
  worker: NativeWorkerSummary;
  onBack(): void;
  onRequestError?(error: unknown): void;
}) {
  const loadProviders = useCallback(async () => {
    const payload = await api.listProviderSnapshots();
    return payload.items.filter((provider) => provider.worker_id === worker.worker_id);
  }, [api, worker.worker_id]);
  const resource = useAsyncResource(loadProviders, { onError: onRequestError, resetKey: worker.worker_id });
  const providers = resource.data ?? [];
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);

  async function runProviderAction(provider: NativeProviderSnapshot, action: 'login' | 'logout') {
    const mutate = action === 'login' ? api.loginProvider : api.logoutProvider;
    if (!mutate || providerBusy) return;
    setProviderBusy(provider.backend);
    setProviderNotice(null);
    setProviderError(null);
    try {
      await mutate(worker.worker_id, provider.backend, csrfToken);
      setProviderNotice(`${provider.backend} ${action === 'login' ? '登录' : '退出'}任务已排队`);
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setProviderError(error instanceof Error ? error.message : 'Provider 操作失败');
    } finally {
      setProviderBusy(null);
    }
  }
  return (
    <View style={styles.screen}>
      <View style={styles.detailHeader}>
        <Pressable accessibilityLabel="返回节点列表" accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          <Ionicons color={colors.text} name="arrow-back" size={21} />
        </Pressable>
        <View style={styles.detailHeaderCopy}>
          <Text style={styles.detailEyebrow}>NODE DETAIL</Text>
          <Text numberOfLines={1} style={styles.detailHeaderTitle}>{worker.machine_name || worker.worker_id}</Text>
        </View>
        <Pressable accessibilityLabel="刷新节点状态" accessibilityRole="button" disabled={resource.loading || resource.refreshing} onPress={() => void resource.reload()} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          <Ionicons color={colors.accent} name="refresh" size={20} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={styles.detailContent}
        refreshControl={<RefreshControl colors={[colors.accent]} onRefresh={() => void resource.reload()} refreshing={resource.refreshing} tintColor={colors.accent} />}
      >
        <View style={styles.detailLead}>
          <View style={[styles.statusBadge, workerStatusTone(worker.status)]}>
            <View style={[styles.statusDot, workerStatusDot(worker.status)]} />
            <Text style={[styles.statusText, workerStatusTextTone(worker.status)]}>{workerStatusLabel(worker.status)}</Text>
          </View>
          <Text selectable style={styles.detailIdentifier}>{worker.worker_id}</Text>
          <Text style={styles.detailMetadata}>{worker.os}{worker.worker_version ? ` · ${worker.worker_version}` : ''}</Text>
          <Text style={styles.detailMetadata}>最近心跳 {formatLastActivity(worker.last_heartbeat_at)}</Text>
        </View>
        <DetailSection title="可用后端">
          <View style={styles.capabilities}>
            {worker.reachable_backends.map((backend) => <View key={backend} style={styles.capabilityBadge}><Text style={styles.capabilityText}>{backend}</Text></View>)}
          </View>
        </DetailSection>
        <DetailSection title="工作目录">
          {(worker.workspace_roots ?? []).length === 0 ? <Text style={styles.emptyCapabilities}>节点未上报工作目录</Text> : null}
          {(worker.workspace_roots ?? []).map((root) => <Text selectable key={root} style={styles.workspaceRoot}>{root}</Text>)}
        </DetailSection>
        <DetailSection title="运行参数">
          {worker.runtime_settings ? (
            <View style={styles.runtimeSettings}>
              <Text style={styles.runtimeSetting}>并发任务 {worker.runtime_settings.max_concurrent_jobs}</Text>
              <Text style={styles.runtimeSetting}>任务轮询 {worker.runtime_settings.job_poll_interval_seconds} 秒</Text>
              <Text style={styles.runtimeSetting}>心跳 {worker.runtime_settings.heartbeat_interval_seconds} 秒</Text>
            </View>
          ) : <Text style={styles.emptyCapabilities}>节点尚未上报运行参数</Text>}
        </DetailSection>
        <DetailSection title="Provider 状态">
          {resource.loading ? <Text style={styles.emptyCapabilities}>正在读取 Provider 状态</Text> : null}
          {resource.error ? <ResourceErrorBanner error={resource.error} onRetry={resource.reload} retryLabel="重试读取 Provider 状态" /> : null}
          {!resource.loading && providers.length === 0 ? <Text style={styles.emptyCapabilities}>尚未收到 Provider 快照</Text> : null}
          {providerNotice ? <Text accessibilityLiveRegion="polite" style={styles.providerNotice}>{providerNotice}</Text> : null}
          {providerError ? <Text accessibilityRole="alert" style={styles.providerDiagnostic}>{providerError}</Text> : null}
          {providers.map((provider) => (
            <ProviderCard
              busy={providerBusy === provider.backend}
              canManage={canManage && worker.status !== 'offline'}
              key={provider.backend}
              onAction={(action) => void runProviderAction(provider, action)}
              provider={provider}
            />
          ))}
        </DetailSection>
      </ScrollView>
    </View>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <View style={styles.detailSection}><Text style={styles.detailSectionTitle}>{title}</Text>{children}</View>;
}

function ProviderCard({
  busy,
  canManage,
  onAction,
  provider,
}: {
  busy: boolean;
  canManage: boolean;
  onAction(action: 'login' | 'logout'): void;
  provider: NativeProviderSnapshot;
}) {
  const models = provider.models
    .map((model) => [model.label, model.name, model.id].find((value) => typeof value === 'string' && value.trim()))
    .filter((value): value is string => Boolean(value));
  return (
    <View style={styles.providerCard}>
      <View style={styles.providerHeading}>
        <Text style={styles.providerTitle}>{provider.backend}</Text>
        <Text style={[styles.providerStatus, provider.status === 'ready' && styles.providerStatusReady]}>{provider.status === 'ready' ? '已就绪' : provider.status}</Text>
      </View>
      <Text style={styles.providerMeta}>认证 {provider.auth_status === 'ready' ? '已登录' : provider.auth_status}</Text>
      {models.length > 0 ? <Text numberOfLines={2} style={styles.providerMeta}>模型 {models.join(' · ')}</Text> : null}
      {typeof provider.diagnostics.message === 'string' ? <Text numberOfLines={3} style={styles.providerDiagnostic}>{provider.diagnostics.message}</Text> : null}
      {canManage ? (
        <Pressable
          accessibilityLabel={`${provider.auth_status === 'ready' ? '退出' : '登录'} ${provider.backend}`}
          accessibilityRole="button"
          disabled={busy}
          onPress={() => onAction(provider.auth_status === 'ready' ? 'logout' : 'login')}
          style={({ pressed }) => [styles.providerAction, busy && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.providerActionText}>{busy ? '排队中' : provider.auth_status === 'ready' ? '退出登录' : '登录 Provider'}</Text>
        </Pressable>
      ) : null}
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
  cardFooter: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
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
  detailHeader: { alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  detailHeaderCopy: { flex: 1, gap: 2 },
  detailEyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800' },
  detailHeaderTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  iconButton: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 7, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  detailContent: { gap: 12, padding: 16, paddingBottom: 28 },
  detailLead: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 7, borderWidth: 1, gap: 7, padding: 14 },
  detailIdentifier: { color: colors.text, fontSize: 16, fontWeight: '800' },
  detailMetadata: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  detailSection: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 7, borderWidth: 1, gap: 10, padding: 14 },
  detailSectionTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  workspaceRoot: { color: colors.muted, fontFamily: 'monospace', fontSize: 12, lineHeight: 19 },
  runtimeSettings: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  runtimeSetting: { backgroundColor: colors.surfaceMuted, borderRadius: 5, color: colors.text, fontSize: 12, fontWeight: '700', paddingHorizontal: 9, paddingVertical: 7 },
  providerCard: { backgroundColor: colors.surfaceMuted, borderRadius: 6, gap: 5, padding: 11 },
  providerHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  providerTitle: { color: colors.text, fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },
  providerStatus: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  providerStatusReady: { color: colors.success },
  providerMeta: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  providerDiagnostic: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  providerNotice: { color: colors.success, fontSize: 12, lineHeight: 18 },
  providerAction: { alignItems: 'center', alignSelf: 'flex-start', borderColor: colors.accent, borderRadius: 6, borderWidth: 1, justifyContent: 'center', marginTop: 4, minHeight: 36, paddingHorizontal: 12 },
  providerActionText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.65 },
});
