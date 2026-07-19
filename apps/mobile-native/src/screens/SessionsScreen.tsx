import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type {
  MobileApi,
  NativeProviderSnapshot,
  NativeSessionControls,
  NativeSessionStartInput,
  NativeSessionStatus,
  NativeSessionSummary,
  NativeUserPreferences,
  NativeWorkerSummary,
} from '../api/mobileApi';
import { RuntimeOverview } from '../features/cockpit/RuntimeOverviewView';
import { projectRuntimeOverview } from '../features/cockpit/runtimeOverview';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, sessionActivityAt, sessionStatusLabel, sortSessionsByRecentActivity } from './resourcePresentation';
import { SessionDetailScreen } from './SessionDetailScreen';

type SessionsApi = Pick<
  MobileApi,
  | 'askSessionBtw'
  | 'archiveSession'
  | 'forkSession'
  | 'getSession'
  | 'getSessionTimeline'
  | 'getSettings'
  | 'listJobs'
  | 'listPermissions'
  | 'listProviderSnapshots'
  | 'listSessions'
  | 'listTasks'
  | 'listWorkers'
  | 'respondPermission'
  | 'renameSession'
  | 'sendSessionInput'
  | 'startSession'
  | 'transcribeVoice'
  | 'terminateSession'
  | 'unarchiveSession'
  | 'updateSessionControls'
>;

interface RequestedFileTarget {
  sessionId: string;
  path: string;
}

interface SessionLaunchDraft {
  workerId: string;
  backend: string;
  workspaceRoot: string;
  title: string;
  prompt: string;
  model: string;
  namespace: string;
  sandboxMode: string;
  approvalMode: string;
  permissionMode: string;
  interactionBridge: string;
  agent: string;
  thinking: '' | 'true' | 'false';
  yolo: boolean;
}

type SessionArchiveView = 'active' | 'archived';

const emptyLaunchDraft: SessionLaunchDraft = {
  workerId: '',
  backend: '',
  workspaceRoot: '',
  title: '',
  prompt: '',
  model: '',
  namespace: '',
  sandboxMode: '',
  approvalMode: '',
  permissionMode: '',
  interactionBridge: '',
  agent: '',
  thinking: '',
  yolo: false,
};

const defaultComposerPreferences: Pick<NativeUserPreferences, 'quick_replies' | 'voice_language'> = {
  quick_replies: ['继续', '不对，重新来', '等等', '收到，继续', '先停一下'],
  voice_language: 'zh-CN',
};

export function SessionsScreen({
  api,
  onRequestError,
  csrfToken = '',
  canOperate = false,
  canTerminate = false,
  requestedSessionId = null,
  requestedPermissionId = null,
  onRequestedSessionHandled,
  onRequestedPermissionHandled,
  onOpenFile,
  onOpenTask,
}: {
  api: SessionsApi;
  onRequestError?(error: unknown): void;
  csrfToken?: string;
  canOperate?: boolean;
  canTerminate?: boolean;
  requestedSessionId?: string | null;
  requestedPermissionId?: string | null;
  onRequestedSessionHandled?(sessionId: string): void;
  onRequestedPermissionHandled?(permissionId: string): void;
  onOpenFile?(target: RequestedFileTarget): void;
  onOpenTask?(taskId: string): void;
}) {
  const [selectedSession, setSelectedSession] = useState<NativeSessionSummary | null>(null);
  const [viewMode, setViewMode] = useState<'overview' | 'inbox'>('inbox');
  const [query, setQuery] = useState('');
  const [archiveView, setArchiveView] = useState<SessionArchiveView>('active');
  const [backendFilter, setBackendFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | NativeSessionStatus>('all');
  const [workerFilter, setWorkerFilter] = useState('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchNotice, setLaunchNotice] = useState<string | null>(null);
  const [launchWorkers, setLaunchWorkers] = useState<NativeWorkerSummary[]>([]);
  const [launchProviders, setLaunchProviders] = useState<NativeProviderSnapshot[]>([]);
  const [launchDraft, setLaunchDraft] = useState<SessionLaunchDraft>(emptyLaunchDraft);
  const [batchSelecting, setBatchSelecting] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [composerPreferences, setComposerPreferences] = useState(defaultComposerPreferences);
  const loadComposerPreferences = useCallback(async () => {
    try {
      const loaded = await api.getSettings();
      setComposerPreferences({
        quick_replies: loaded.preferences.quick_replies,
        voice_language: loaded.preferences.voice_language,
      });
    } catch (error) {
      onRequestError?.(error);
    }
  }, [api, onRequestError]);
  const loadSessions = useCallback(
    async () => (await api.listSessions({ archived: archiveView === 'archived' })).items,
    [api, archiveView],
  );
  const resource = useAsyncResource(loadSessions, { onError: onRequestError });
  const loadOverviewContext = useCallback(async () => {
    const [workersPayload, permissionsPayload, tasksPayload] = await Promise.all([
      api.listWorkers(),
      api.listPermissions(undefined, 'pending'),
      api.listTasks(undefined),
    ]);
    return {
      workers: workersPayload.items,
      permissions: permissionsPayload.items,
      tasks: tasksPayload.items,
    };
  }, [api]);
  const overviewResource = useAsyncResource(loadOverviewContext, { onError: onRequestError });
  const sessions = useMemo(
    () => sortSessionsByRecentActivity(resource.data ?? []),
    [resource.data],
  );
  const overviewProjection = useMemo(
    () => projectRuntimeOverview(
      sessions,
      overviewResource.data?.workers ?? [],
      overviewResource.data?.permissions ?? [],
      overviewResource.data?.tasks ?? [],
    ),
    [overviewResource.data, sessions],
  );
  const availableBackends = useMemo(
    () => ['all', ...new Set(sessions.map((item) => item.backend?.trim().toLowerCase()).filter(Boolean))],
    [sessions],
  );
  const availableStatuses = useMemo(
    () => [...new Set(sessions.map((item) => item.status))],
    [sessions],
  );
  const availableWorkers = useMemo(
    () => [...new Set(sessions.map((item) => item.worker_id).filter(Boolean))],
    [sessions],
  );
  const activeFilterCount = Number(backendFilter !== 'all')
    + Number(statusFilter !== 'all')
    + Number(workerFilter !== 'all');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      if (backendFilter !== 'all' && session.backend?.trim().toLowerCase() !== backendFilter) return false;
      if (statusFilter !== 'all' && session.status !== statusFilter) return false;
      if (workerFilter !== 'all' && session.worker_id !== workerFilter) return false;
      const haystack = [
        session.title,
        session.backend,
        session.worker_id,
        session.project_name,
        session.workspace_root,
        session.last_message,
        session.activity_summary,
      ].filter(Boolean).join(' ').toLowerCase();
      return !normalizedQuery || haystack.includes(normalizedQuery);
    });
  }, [backendFilter, normalizedQuery, sessions, statusFilter, workerFilter]);
  const availableLaunchWorkers = useMemo(
    () => launchWorkers.filter((worker) => worker.reachable_backends.length > 0 && worker.status !== 'offline'),
    [launchWorkers],
  );
  const launchWorker = useMemo(
    () => availableLaunchWorkers.find((worker) => worker.worker_id === launchDraft.workerId) ?? null,
    [availableLaunchWorkers, launchDraft.workerId],
  );
  const launchBackends = useMemo(
    () => normalizedBackends(launchWorker),
    [launchWorker],
  );
  const launchProvider = useMemo(
    () => launchProviders.find((provider) => (
      provider.worker_id === launchDraft.workerId && provider.backend.toLowerCase() === launchDraft.backend
    )),
    [launchDraft.backend, launchDraft.workerId, launchProviders],
  );
  const launchModels = useMemo(() => providerModels(launchProvider), [launchProvider]);
  const launchSandboxModes = useMemo(() => providerModes(launchProvider, 'sandbox_mode'), [launchProvider]);
  const launchApprovalModes = useMemo(() => providerModes(launchProvider, 'approval_mode'), [launchProvider]);
  const launchPermissionModes = useMemo(() => providerModes(launchProvider, 'permission_mode'), [launchProvider]);
  const launchInteractionBridges = useMemo(() => providerModes(launchProvider, 'interaction_bridge'), [launchProvider]);
  const launchAgents = useMemo(() => providerModes(launchProvider, 'agent'), [launchProvider]);
  const supportsLaunchThinking = launchProvider?.features?.thinking === true;
  const supportsLaunchYolo = launchProvider?.features?.yolo === true;

  useEffect(() => {
    void loadComposerPreferences();
  }, [loadComposerPreferences]);

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (previousState !== 'active' && nextState === 'active') {
        void resource.reload();
        void loadComposerPreferences();
        if (viewMode === 'overview') void overviewResource.reload();
      }
      previousState = nextState;
    });
    const timer = setInterval(() => {
      void resource.reload();
      if (viewMode === 'overview') void overviewResource.reload();
    }, 15_000);

    return () => {
      clearInterval(timer);
      subscription?.remove?.();
    };
  }, [loadComposerPreferences, overviewResource.reload, resource.reload, viewMode]);

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

  useEffect(() => {
    setBatchSelecting(false);
    setSelectedSessionIds(new Set());
    setBatchConfirmOpen(false);
    setBatchError(null);
  }, [archiveView]);

  function toggleBatchSession(sessionId: string) {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  async function submitBatchArchive() {
    const sessionIds = [...selectedSessionIds];
    if (sessionIds.length === 0) return;
    setBatchBusy(true);
    setBatchError(null);
    try {
      const mutate = archiveView === 'archived' ? api.unarchiveSession : api.archiveSession;
      await Promise.all(sessionIds.map((sessionId) => mutate(sessionId, csrfToken)));
      setBatchConfirmOpen(false);
      setBatchSelecting(false);
      setSelectedSessionIds(new Set());
      setLaunchNotice(archiveView === 'archived' ? `已恢复 ${sessionIds.length} 个会话` : `已归档 ${sessionIds.length} 个会话`);
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setBatchError(errorMessage(error));
    } finally {
      setBatchBusy(false);
    }
  }

  async function openLaunch() {
    setLaunchOpen(true);
    setLaunchLoading(true);
    setLaunchError(null);
    try {
      const [workersPayload, providersPayload] = await Promise.all([
        api.listWorkers(),
        api.listProviderSnapshots(),
      ]);
      const workers = workersPayload.items.filter((worker) => (
        worker.status !== 'offline' && worker.reachable_backends.length > 0
      ));
      setLaunchWorkers(workers);
      setLaunchProviders(providersPayload.items);
      const initialWorker = workers.find((worker) => worker.worker_id === launchDraft.workerId) ?? workers[0];
      if (initialWorker) {
        const backend = normalizedBackends(initialWorker).includes(launchDraft.backend)
          ? launchDraft.backend
          : normalizedBackends(initialWorker)[0] ?? '';
        setLaunchDraft((current) => ({
          ...current,
          workerId: initialWorker.worker_id,
          backend,
          workspaceRoot: initialWorker.workspace_roots?.includes(current.workspaceRoot)
            ? current.workspaceRoot
            : initialWorker.workspace_roots?.[0] ?? '',
          model: '',
          sandboxMode: '',
          approvalMode: '',
          permissionMode: '',
          interactionBridge: '',
          agent: '',
          thinking: '',
          yolo: false,
        }));
      }
    } catch (error) {
      onRequestError?.(error);
      setLaunchError(errorMessage(error));
    } finally {
      setLaunchLoading(false);
    }
  }

  function chooseLaunchWorker(worker: NativeWorkerSummary) {
    const backend = normalizedBackends(worker)[0] ?? '';
    setLaunchDraft((current) => ({
      ...current,
      workerId: worker.worker_id,
      backend,
      workspaceRoot: worker.workspace_roots?.[0] ?? '',
      model: '',
      sandboxMode: '',
      approvalMode: '',
      permissionMode: '',
      interactionBridge: '',
      agent: '',
      thinking: '',
      yolo: false,
    }));
  }

  function chooseLaunchBackend(backend: string) {
    setLaunchDraft((current) => ({
      ...current,
      backend,
      model: '',
      sandboxMode: '',
      approvalMode: '',
      permissionMode: '',
      interactionBridge: '',
      agent: '',
      thinking: '',
      yolo: false,
    }));
  }

  async function submitLaunch() {
    const prompt = launchDraft.prompt.trim();
    if (!launchDraft.workerId || !launchDraft.backend || !launchDraft.workspaceRoot || !prompt) {
      setLaunchError('请选择节点、后端和工作目录，并填写初始提示词');
      return;
    }
    setLaunchBusy(true);
    setLaunchError(null);
    try {
      const controls: NativeSessionControls = {
        ...(launchDraft.model ? { model: launchDraft.model } : {}),
        ...(launchDraft.sandboxMode ? { sandbox_mode: launchDraft.sandboxMode } : {}),
        ...(launchDraft.backend !== 'claude' && launchDraft.approvalMode
          ? { approval_mode: launchDraft.approvalMode }
          : {}),
        ...(launchDraft.permissionMode ? { permission_mode: launchDraft.permissionMode } : {}),
        ...(launchDraft.interactionBridge ? { interaction_bridge: launchDraft.interactionBridge } : {}),
        ...(launchDraft.agent ? { agent: launchDraft.agent } : {}),
        ...(launchDraft.thinking ? { thinking: launchDraft.thinking === 'true' } : {}),
        ...(launchDraft.yolo ? { yolo: true } : {}),
      };
      const payload: NativeSessionStartInput = {
        worker_id: launchDraft.workerId,
        backend: launchDraft.backend,
        workspace_root: launchDraft.workspaceRoot,
        ...(launchDraft.namespace.trim() ? { namespace: launchDraft.namespace.trim() } : {}),
        prompt,
        ...(launchDraft.title.trim() ? { title: launchDraft.title.trim() } : {}),
        ...(Object.keys(controls).length > 0 ? { controls } : {}),
      };
      await api.startSession(payload, csrfToken);
      setLaunchOpen(false);
      setLaunchDraft(emptyLaunchDraft);
      setLaunchNotice('创建请求已排队，节点会在可用后启动会话');
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setLaunchError(errorMessage(error));
    } finally {
      setLaunchBusy(false);
    }
  }

  if (selectedSession) {
    return (
      <SessionDetailScreen
        api={api}
        canOperate={canOperate}
        canTerminate={canTerminate}
        csrfToken={csrfToken}
        onBack={() => {
          setSelectedSession(null);
          void resource.reload();
        }}
        onRequestError={onRequestError}
        focusedPermissionId={requestedPermissionId}
        onFocusedPermissionHandled={onRequestedPermissionHandled}
        onOpenFile={(sessionId, path) => onOpenFile?.({ sessionId, path })}
        quickReplies={composerPreferences.quick_replies}
        session={selectedSession}
        voiceLanguage={composerPreferences.voice_language}
      />
    );
  }

  function renderSession({ item }: { item: NativeSessionSummary }) {
    const summary = item.activity_summary || item.last_message || item.project_name || item.workspace_root || '';
    const selected = selectedSessionIds.has(item.session_id);
    return (
      <Pressable
        accessibilityLabel={batchSelecting ? `选择会话 ${item.title}` : `打开会话 ${item.title}`}
        accessibilityRole="button"
        accessibilityState={batchSelecting ? { selected } : undefined}
        onPress={() => batchSelecting ? toggleBatchSession(item.session_id) : setSelectedSession(item)}
        style={({ pressed }) => [
          styles.card,
          selected && styles.cardSelected,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.cardTitleRow}>
          <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
          <Ionicons color={selected ? colors.accent : colors.muted} name={batchSelecting ? (selected ? 'checkmark-circle' : 'ellipse-outline') : 'chevron-forward'} size={20} />
        </View>
        <View style={styles.metadataRow}>
          <View style={styles.badge}><Text style={styles.badgeText}>{item.backend}</Text></View>
          <Text numberOfLines={1} style={styles.workerText}>{item.worker_id}</Text>
        </View>
        {summary ? <Text numberOfLines={3} style={styles.summaryText}>{summary}</Text> : null}
        <View style={styles.footerRow}>
          <Text style={styles.statusText}>{sessionStatusLabel(item.status)}</Text>
          <Text style={styles.activityText}>{formatLastActivity(sessionActivityAt(item))}</Text>
        </View>
      </Pressable>
    );
  }

  const showEmptyMatches = (Boolean(normalizedQuery) || backendFilter !== 'all' || activeFilterCount > 0)
    && sessions.length > 0
    && filteredSessions.length === 0;
  const fullState = resource.loading || (resource.error !== null && resource.data === null) || (sessions.length === 0 && !normalizedQuery);
  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ResourceHeader
        eyebrow="SESSION INBOX"
        onRefresh={resource.reload}
        refreshLabel="刷新会话"
        refreshing={resource.loading || resource.refreshing}
        title="会话"
      />
      {canOperate ? (
        <View style={styles.launchActionWrap}>
          <Pressable
            accessibilityLabel="新建会话"
            accessibilityRole="button"
            onPress={() => void openLaunch()}
            style={({ pressed }) => [styles.launchAction, pressed && styles.cardPressed]}
          >
            <Ionicons color={colors.surface} name="add" size={18} />
            <Text style={styles.launchActionText}>新建会话</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.viewModeSwitch}>
        <Pressable
          accessibilityLabel="查看运行总览"
          accessibilityRole="button"
          accessibilityState={{ selected: viewMode === 'overview' }}
          onPress={() => {
            setArchiveView('active');
            setFilterOpen(false);
            setViewMode('overview');
            void overviewResource.reload();
          }}
          style={[styles.viewModeButton, viewMode === 'overview' && styles.viewModeButtonSelected]}
        >
          <Ionicons color={viewMode === 'overview' ? colors.surface : colors.muted} name="pulse-outline" size={17} />
          <Text style={[styles.viewModeText, viewMode === 'overview' && styles.viewModeTextSelected]}>总览</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="查看会话收件箱"
          accessibilityRole="button"
          accessibilityState={{ selected: viewMode === 'inbox' }}
          onPress={() => setViewMode('inbox')}
          style={[styles.viewModeButton, viewMode === 'inbox' && styles.viewModeButtonSelected]}
        >
          <Ionicons color={viewMode === 'inbox' ? colors.surface : colors.muted} name="chatbubbles-outline" size={17} />
          <Text style={[styles.viewModeText, viewMode === 'inbox' && styles.viewModeTextSelected]}>会话</Text>
        </Pressable>
      </View>
      {viewMode === 'inbox' ? <View style={styles.searchWrap}>
        <Ionicons color={colors.muted} name="search-outline" size={18} />
        <TextInput
          accessibilityLabel="搜索会话"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="搜索会话、项目或 worker"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={query}
        />
        {query ? (
          <Pressable
            accessibilityLabel="清空搜索"
            accessibilityRole="button"
            onPress={() => setQuery('')}
            style={({ pressed }) => [styles.clearButton, pressed && styles.cardPressed]}
          >
            <Ionicons color={colors.muted} name="close-circle" size={18} />
          </Pressable>
        ) : null}
      </View> : null}
      {viewMode === 'inbox' ? <View style={styles.archiveSwitch}>
        <Pressable
          accessibilityLabel="查看活动会话"
          accessibilityRole="button"
          onPress={() => {
            setArchiveView('active');
            setBackendFilter('all');
          }}
          style={({ pressed }) => [styles.archiveChip, archiveView === 'active' && styles.archiveChipSelected, pressed && styles.cardPressed]}
        >
          <Text style={[styles.archiveChipText, archiveView === 'active' && styles.archiveChipTextSelected]}>收件箱</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="查看归档会话"
          accessibilityRole="button"
          onPress={() => {
            setArchiveView('archived');
            setBackendFilter('all');
          }}
          style={({ pressed }) => [styles.archiveChip, archiveView === 'archived' && styles.archiveChipSelected, pressed && styles.cardPressed]}
        >
          <Text style={[styles.archiveChipText, archiveView === 'archived' && styles.archiveChipTextSelected]}>归档</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="打开会话筛选"
          accessibilityRole="button"
          onPress={() => setFilterOpen(true)}
          style={({ pressed }) => [styles.filterButton, activeFilterCount > 0 && styles.filterButtonActive, pressed && styles.cardPressed]}
        >
          <Ionicons color={activeFilterCount > 0 ? colors.surface : colors.accent} name="options-outline" size={17} />
          <Text style={[styles.filterButtonText, activeFilterCount > 0 && styles.filterButtonTextActive]}>
            {activeFilterCount > 0 ? `已筛选 ${activeFilterCount} 项` : '筛选'}
          </Text>
        </Pressable>
      </View> : null}
      {viewMode === 'inbox' && canOperate ? (
        <View style={styles.batchBar}>
          {batchSelecting ? (
            <>
              <Text style={styles.batchCount}>已选 {selectedSessionIds.size} 个</Text>
              <Pressable
                accessibilityLabel="取消批量选择"
                accessibilityRole="button"
                disabled={batchBusy}
                onPress={() => {
                  setBatchSelecting(false);
                  setSelectedSessionIds(new Set());
                }}
                style={({ pressed }) => [styles.batchSecondary, pressed && styles.cardPressed]}
              >
                <Text style={styles.batchSecondaryText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={archiveView === 'archived' ? '恢复所选会话' : '归档所选会话'}
                accessibilityRole="button"
                disabled={selectedSessionIds.size === 0 || batchBusy}
                onPress={() => setBatchConfirmOpen(true)}
                style={({ pressed }) => [styles.batchPrimary, (selectedSessionIds.size === 0 || batchBusy) && styles.disabled, pressed && styles.cardPressed]}
              >
                <Text style={styles.batchPrimaryText}>{archiveView === 'archived' ? '恢复' : '归档'}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityLabel="批量选择会话"
              accessibilityRole="button"
              onPress={() => setBatchSelecting(true)}
              style={({ pressed }) => [styles.batchSecondary, pressed && styles.cardPressed]}
            >
              <Ionicons color={colors.accent} name="checkbox-outline" size={17} />
              <Text style={styles.batchSecondaryText}>批量选择</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {viewMode === 'inbox' ? <ScrollView
        contentContainerStyle={styles.filterWrap}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
      >
        {availableBackends.map((backend) => {
          const selected = backend === backendFilter;
          return (
            <ChoiceChip
              accessibilityLabel={backend === 'all' ? '筛选全部后端' : `筛选后端 ${backend}`}
              key={backend}
              label={backend === 'all' ? '全部' : backend}
              onPress={() => setBackendFilter(backend)}
              selected={selected}
            />
          );
        })}
      </ScrollView> : null}
      {launchNotice ? (
        <View style={styles.noticeBanner}>
          <Ionicons color={colors.success} name="checkmark-circle-outline" size={18} />
          <Text style={styles.noticeText}>{launchNotice}</Text>
          <Pressable
            accessibilityLabel="关闭创建提示"
            accessibilityRole="button"
            onPress={() => setLaunchNotice(null)}
            style={styles.noticeClose}
          >
            <Ionicons color={colors.muted} name="close" size={17} />
          </Pressable>
        </View>
      ) : null}
      {viewMode === 'overview' ? (
        <RuntimeOverview
          error={overviewResource.error}
          loading={resource.loading || overviewResource.loading}
          onOpenSession={(item) => setSelectedSession(item.session)}
          onOpenTask={(taskId) => onOpenTask?.(taskId)}
          onRefresh={() => {
            void resource.reload();
            void overviewResource.reload();
          }}
          projection={overviewProjection}
          refreshing={resource.refreshing || overviewResource.refreshing}
        />
      ) : fullState ? (
        <ResourceState
          empty={sessions.length === 0}
          emptyText={archiveView === 'archived' ? '暂无归档会话' : '暂无会话'}
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
          data={filteredSessions}
          keyExtractor={(item) => item.session_id}
          ListEmptyComponent={showEmptyMatches ? (
            <View style={styles.emptyMatch}>
              <Ionicons color={colors.muted} name="search-outline" size={22} />
              <Text style={styles.emptyMatchText}>没有匹配的会话</Text>
            </View>
          ) : null}
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
      <Modal animationType="slide" onRequestClose={() => setFilterOpen(false)} transparent visible={filterOpen && viewMode === 'inbox'}>
        <View style={styles.modalBackdrop}>
          <View style={styles.filterSheet}>
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetEyebrow}>会话筛选</Text>
                <Text style={styles.sheetTitle}>缩小会话范围</Text>
              </View>
              <Pressable accessibilityLabel="关闭会话筛选" accessibilityRole="button" onPress={() => setFilterOpen(false)} style={styles.sheetClose}>
                <Ionicons color={colors.text} name="close" size={22} />
              </Pressable>
            </View>
            <Text style={styles.filterSectionTitle}>状态</Text>
            <View style={styles.filterChoices}>
              <ChoiceChip accessibilityLabel="筛选全部状态" label="全部" onPress={() => setStatusFilter('all')} selected={statusFilter === 'all'} />
              {availableStatuses.map((status) => (
                <ChoiceChip
                  accessibilityLabel={`筛选状态 ${sessionStatusLabel(status)}`}
                  key={status}
                  label={sessionStatusLabel(status)}
                  onPress={() => setStatusFilter(status)}
                  selected={statusFilter === status}
                />
              ))}
            </View>
            <Text style={styles.filterSectionTitle}>节点</Text>
            <View style={styles.filterChoices}>
              <ChoiceChip accessibilityLabel="筛选全部节点" label="全部" onPress={() => setWorkerFilter('all')} selected={workerFilter === 'all'} />
              {availableWorkers.map((workerId) => (
                <ChoiceChip
                  accessibilityLabel={`筛选节点 ${workerId}`}
                  key={workerId}
                  label={workerId}
                  onPress={() => setWorkerFilter(workerId)}
                  selected={workerFilter === workerId}
                />
              ))}
            </View>
            <View style={styles.filterFooter}>
              <Pressable
                accessibilityLabel="重置会话筛选"
                accessibilityRole="button"
                onPress={() => {
                  setBackendFilter('all');
                  setStatusFilter('all');
                  setWorkerFilter('all');
                }}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.cardPressed]}
              >
                <Text style={styles.secondaryButtonText}>重置</Text>
              </Pressable>
              <Pressable accessibilityLabel="完成会话筛选" accessibilityRole="button" onPress={() => setFilterOpen(false)} style={({ pressed }) => [styles.primaryButton, pressed && styles.cardPressed]}>
                <Text style={styles.primaryButtonText}>完成</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal animationType="fade" onRequestClose={() => !batchBusy && setBatchConfirmOpen(false)} transparent visible={batchConfirmOpen}>
        <View style={styles.modalBackdrop}>
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>
              {archiveView === 'archived'
                ? `确认恢复 ${selectedSessionIds.size} 个会话`
                : `确认归档 ${selectedSessionIds.size} 个会话`}
            </Text>
            <Text style={styles.confirmDescription}>
              {archiveView === 'archived' ? '这些会话会重新回到收件箱。' : '这些会话会移到归档，之后仍可恢复。'}
            </Text>
            {batchError ? <Text accessibilityRole="alert" style={styles.launchError}>{batchError}</Text> : null}
            <View style={styles.confirmActions}>
              <Pressable accessibilityLabel="取消批量操作" accessibilityRole="button" disabled={batchBusy} onPress={() => setBatchConfirmOpen(false)} style={({ pressed }) => [styles.secondaryButton, pressed && styles.cardPressed]}>
                <Text style={styles.secondaryButtonText}>取消</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={archiveView === 'archived' ? `确认恢复 ${selectedSessionIds.size} 个会话` : `确认归档 ${selectedSessionIds.size} 个会话`}
                accessibilityRole="button"
                disabled={batchBusy}
                onPress={() => void submitBatchArchive()}
                style={({ pressed }) => [styles.primaryButton, batchBusy && styles.disabled, pressed && styles.cardPressed]}
              >
                {batchBusy ? <ActivityIndicator color={colors.surface} size="small" /> : null}
                <Text style={styles.primaryButtonText}>{archiveView === 'archived' ? '确认恢复' : '确认归档'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        onRequestClose={() => !launchBusy && setLaunchOpen(false)}
        transparent
        visible={launchOpen}
      >
        <View style={styles.modalBackdrop}>
          <SafeAreaView edges={['bottom']} style={styles.launchSheet}>
            <View style={styles.launchHeader}>
              <View style={styles.launchHeaderCopy}>
                <Text style={styles.launchEyebrow}>NEW SESSION</Text>
                <Text style={styles.launchTitle}>新建会话</Text>
                <Text style={styles.launchDescription}>只显示节点实际上报的后端、工作目录和模型。</Text>
              </View>
              <Pressable
                accessibilityLabel="关闭新建会话"
                accessibilityRole="button"
                disabled={launchBusy}
                onPress={() => setLaunchOpen(false)}
                style={({ pressed }) => [styles.closeButton, pressed && styles.cardPressed]}
              >
                <Ionicons color={colors.text} name="close" size={20} />
              </Pressable>
            </View>
            {launchLoading ? (
              <View style={styles.launchLoading}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.launchLoadingText}>正在读取节点能力</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={styles.launchContent} keyboardShouldPersistTaps="handled">
                {launchError ? <Text accessibilityRole="alert" style={styles.launchError}>{launchError}</Text> : null}
                {availableLaunchWorkers.length === 0 ? (
                  <Text style={styles.launchEmpty}>没有可用节点。请先在“节点”页确认 worker 在线并已发现 agent runtime。</Text>
                ) : (
                  <>
                    <LaunchChoiceSection label="节点">
                      {availableLaunchWorkers.map((worker) => (
                        <ChoiceChip
                          accessibilityLabel={`选择节点 ${worker.machine_name || worker.worker_id}`}
                          key={worker.worker_id}
                          label={worker.machine_name || worker.worker_id}
                          onPress={() => chooseLaunchWorker(worker)}
                          selected={worker.worker_id === launchDraft.workerId}
                        />
                      ))}
                    </LaunchChoiceSection>
                    <LaunchChoiceSection label="后端">
                      {launchBackends.map((backend) => (
                        <ChoiceChip
                          accessibilityLabel={`选择后端 ${backend}`}
                          key={backend}
                          label={backend}
                          onPress={() => chooseLaunchBackend(backend)}
                          selected={backend === launchDraft.backend}
                        />
                      ))}
                    </LaunchChoiceSection>
                    <LaunchChoiceSection label="工作目录">
                      {(launchWorker?.workspace_roots ?? []).map((workspaceRoot) => (
                        <ChoiceChip
                          accessibilityLabel={`选择工作目录 ${workspaceRoot}`}
                          key={workspaceRoot}
                          label={workspaceRoot}
                          onPress={() => setLaunchDraft((current) => ({ ...current, workspaceRoot }))}
                          selected={workspaceRoot === launchDraft.workspaceRoot}
                        />
                      ))}
                    </LaunchChoiceSection>
                    <LaunchChoiceSection label="模型">
                      <ChoiceChip
                        accessibilityLabel="选择模型 default"
                        label="default"
                        onPress={() => setLaunchDraft((current) => ({ ...current, model: '' }))}
                        selected={!launchDraft.model}
                      />
                      {launchModels.map((model) => (
                        <ChoiceChip
                          accessibilityLabel={`选择模型 ${model.label}`}
                          key={model.id}
                          label={model.label}
                          onPress={() => setLaunchDraft((current) => ({ ...current, model: model.id }))}
                          selected={model.id === launchDraft.model}
                        />
                      ))}
                    </LaunchChoiceSection>
                    {launchSandboxModes.length > 0 ? (
                      <LaunchChoiceSection label="沙箱权限">
                        <ChoiceChip accessibilityLabel="选择沙箱 default" label="default" onPress={() => setLaunchDraft((current) => ({ ...current, sandboxMode: '' }))} selected={!launchDraft.sandboxMode} />
                        {launchSandboxModes.map((mode) => (
                          <ChoiceChip accessibilityLabel={`选择沙箱 ${mode.id}`} key={mode.id} label={mode.label} onPress={() => setLaunchDraft((current) => ({ ...current, sandboxMode: mode.id }))} selected={launchDraft.sandboxMode === mode.id} />
                        ))}
                      </LaunchChoiceSection>
                    ) : null}
                    {launchApprovalModes.length > 0 && launchDraft.backend !== 'claude' ? (
                      <LaunchChoiceSection label="审批策略">
                        <ChoiceChip accessibilityLabel="选择审批 default" label="default" onPress={() => setLaunchDraft((current) => ({ ...current, approvalMode: '' }))} selected={!launchDraft.approvalMode} />
                        {launchApprovalModes.map((mode) => (
                          <ChoiceChip accessibilityLabel={`选择审批 ${mode.id}`} key={mode.id} label={mode.label} onPress={() => setLaunchDraft((current) => ({ ...current, approvalMode: mode.id }))} selected={launchDraft.approvalMode === mode.id} />
                        ))}
                      </LaunchChoiceSection>
                    ) : null}
                    {launchPermissionModes.length > 0 ? (
                      <LaunchChoiceSection label="权限模式">
                        <ChoiceChip accessibilityLabel="选择权限模式 default" label="default" onPress={() => setLaunchDraft((current) => ({ ...current, permissionMode: '' }))} selected={!launchDraft.permissionMode} />
                        {launchPermissionModes.map((mode) => (
                          <ChoiceChip accessibilityLabel={`选择权限模式 ${mode.id}`} key={mode.id} label={mode.label} onPress={() => setLaunchDraft((current) => ({ ...current, permissionMode: mode.id }))} selected={launchDraft.permissionMode === mode.id} />
                        ))}
                      </LaunchChoiceSection>
                    ) : null}
                    {launchInteractionBridges.length > 0 ? (
                      <LaunchChoiceSection label="交互通道">
                        <ChoiceChip accessibilityLabel="选择交互通道 default" label="default" onPress={() => setLaunchDraft((current) => ({ ...current, interactionBridge: '' }))} selected={!launchDraft.interactionBridge} />
                        {launchInteractionBridges.map((mode) => (
                          <ChoiceChip accessibilityLabel={`选择交互通道 ${mode.id}`} key={mode.id} label={mode.label} onPress={() => setLaunchDraft((current) => ({ ...current, interactionBridge: mode.id }))} selected={launchDraft.interactionBridge === mode.id} />
                        ))}
                      </LaunchChoiceSection>
                    ) : null}
                    {launchAgents.length > 0 ? (
                      <LaunchChoiceSection label="Agent">
                        <ChoiceChip accessibilityLabel="选择 Agent default" label="default" onPress={() => setLaunchDraft((current) => ({ ...current, agent: '' }))} selected={!launchDraft.agent} />
                        {launchAgents.map((mode) => (
                          <ChoiceChip accessibilityLabel={`选择 Agent ${mode.id}`} key={mode.id} label={mode.label} onPress={() => setLaunchDraft((current) => ({ ...current, agent: mode.id }))} selected={launchDraft.agent === mode.id} />
                        ))}
                      </LaunchChoiceSection>
                    ) : null}
                    {supportsLaunchThinking ? (
                      <LaunchChoiceSection label="思考模式">
                        <ChoiceChip accessibilityLabel="选择思考模式 default" label="default" onPress={() => setLaunchDraft((current) => ({ ...current, thinking: '' }))} selected={!launchDraft.thinking} />
                        <ChoiceChip accessibilityLabel="开启思考模式" label="开启" onPress={() => setLaunchDraft((current) => ({ ...current, thinking: 'true' }))} selected={launchDraft.thinking === 'true'} />
                        <ChoiceChip accessibilityLabel="关闭思考模式" label="关闭" onPress={() => setLaunchDraft((current) => ({ ...current, thinking: 'false' }))} selected={launchDraft.thinking === 'false'} />
                      </LaunchChoiceSection>
                    ) : null}
                    {supportsLaunchYolo ? (
                      <LaunchChoiceSection label="自动执行">
                        <ChoiceChip accessibilityLabel="启用 YOLO" label="YOLO" onPress={() => setLaunchDraft((current) => ({ ...current, yolo: !current.yolo }))} selected={launchDraft.yolo} />
                      </LaunchChoiceSection>
                    ) : null}
                    <Text style={styles.fieldLabel}>命名空间（可选）</Text>
                    <TextInput
                      accessibilityLabel="会话命名空间"
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={(namespace) => setLaunchDraft((current) => ({ ...current, namespace }))}
                      placeholder="例如 default 或 release"
                      placeholderTextColor={colors.muted}
                      style={styles.launchInput}
                      value={launchDraft.namespace}
                    />
                    <Text style={styles.fieldLabel}>标题（可选）</Text>
                    <TextInput
                      accessibilityLabel="会话标题"
                      onChangeText={(title) => setLaunchDraft((current) => ({ ...current, title }))}
                      placeholder="让会话列表更容易识别"
                      placeholderTextColor={colors.muted}
                      style={styles.launchInput}
                      value={launchDraft.title}
                    />
                    <Text style={styles.fieldLabel}>初始提示词</Text>
                    <TextInput
                      accessibilityLabel="初始提示词"
                      autoCapitalize="sentences"
                      multiline
                      onChangeText={(prompt) => setLaunchDraft((current) => ({ ...current, prompt }))}
                      placeholder="描述希望这个会话完成的事情"
                      placeholderTextColor={colors.muted}
                      style={[styles.launchInput, styles.launchPrompt]}
                      textAlignVertical="top"
                      value={launchDraft.prompt}
                    />
                    <Pressable
                      accessibilityLabel="创建会话"
                      accessibilityRole="button"
                      disabled={launchBusy}
                      onPress={() => void submitLaunch()}
                      style={({ pressed }) => [styles.submitLaunch, pressed && styles.cardPressed, launchBusy && styles.disabled]}
                    >
                      {launchBusy ? <ActivityIndicator color={colors.surface} size="small" /> : <Ionicons color={colors.surface} name="play" size={16} />}
                      <Text style={styles.submitLaunchText}>{launchBusy ? '正在提交' : '创建会话'}</Text>
                    </Pressable>
                  </>
                )}
              </ScrollView>
            )}
          </SafeAreaView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function LaunchChoiceSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.choiceSection}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.choiceWrap}>{children}</View>
    </View>
  );
}

function ChoiceChip({
  accessibilityLabel,
  label,
  onPress,
  selected,
}: {
  accessibilityLabel: string;
  label: string;
  onPress(): void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.choiceChip, selected && styles.choiceChipSelected, pressed && styles.cardPressed]}
    >
      <Text numberOfLines={1} style={[styles.choiceChipText, selected && styles.choiceChipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function normalizedBackends(worker: NativeWorkerSummary | null | undefined): string[] {
  const values = worker?.reachable_backends ?? [];
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function providerModels(provider: NativeProviderSnapshot | undefined): Array<{ id: string; label: string }> {
  const known = new Set<string>();
  const models: Array<{ id: string; label: string }> = [];
  for (const candidate of provider?.models ?? []) {
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id || known.has(id)) continue;
    known.add(id);
    const rawLabel = candidate.label;
    models.push({ id, label: typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel : id });
  }
  return models;
}

function providerModes(provider: NativeProviderSnapshot | undefined, kind: string): Array<{ id: string; label: string }> {
  const known = new Set<string>();
  const modes: Array<{ id: string; label: string }> = [];
  for (const candidate of provider?.modes ?? []) {
    if (candidate.kind !== kind) continue;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id || known.has(id)) continue;
    known.add(id);
    const rawLabel = candidate.label;
    modes.push({ id, label: typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel : id });
  }
  return modes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请重试';
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.canvas, flex: 1 },
  batchBar: { alignItems: 'center', flexDirection: 'row', gap: 10, justifyContent: 'flex-end', paddingBottom: 8, paddingHorizontal: 16 },
  batchCount: { color: colors.muted, flex: 1, fontSize: 13, fontWeight: '700' },
  batchPrimary: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 7, minHeight: 36, justifyContent: 'center', paddingHorizontal: 16 },
  batchPrimaryText: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  batchSecondary: { alignItems: 'center', borderColor: colors.border, borderRadius: 7, borderWidth: 1, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 36, paddingHorizontal: 12 },
  batchSecondaryText: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  cardSelected: { borderColor: colors.accent, borderWidth: 2 },
  confirmActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 18 },
  confirmCard: { alignSelf: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 8, borderWidth: 1, maxWidth: 420, padding: 20, width: '88%' },
  confirmDescription: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
  confirmTitle: { color: colors.text, fontSize: 19, fontWeight: '900' },
  viewModeSwitch: {
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 12,
    padding: 3,
  },
  viewModeButton: {
    alignItems: 'center',
    borderRadius: 6,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 36,
    minWidth: 104,
    paddingHorizontal: 14,
  },
  viewModeButtonSelected: { backgroundColor: colors.accent },
  viewModeText: { color: colors.muted, fontSize: 14, fontWeight: '800' },
  viewModeTextSelected: { color: colors.surface },
  launchActionWrap: { paddingBottom: 10, paddingHorizontal: 16 },
  launchAction: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 44,
  },
  launchActionText: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  list: { gap: 10, paddingBottom: 28, paddingHorizontal: 16 },
  archiveSwitch: { flexDirection: 'row', gap: 8, marginBottom: 10, paddingHorizontal: 16 },
  archiveChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    minWidth: 88,
    paddingHorizontal: 16,
  },
  archiveChipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  archiveChipText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  archiveChipTextSelected: { color: colors.surface },
  filterButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 38,
    paddingHorizontal: 13,
  },
  filterButtonActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterButtonText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  filterButtonTextActive: { color: colors.surface },
  filterScroll: { marginBottom: 12 },
  filterWrap: { gap: 8, paddingHorizontal: 16 },
  searchWrap: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    marginHorizontal: 16,
    paddingHorizontal: 12,
  },
  searchInput: {
    color: colors.text,
    flex: 1,
    fontSize: 14,
    minHeight: 46,
  },
  clearButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
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
  summaryText: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: -2 },
  badge: { backgroundColor: colors.surfaceMuted, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  workerText: { color: colors.muted, flex: 1, fontSize: 12 },
  footerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  statusText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  activityText: { color: colors.muted, fontSize: 12 },
  emptyMatch: { alignItems: 'center', gap: 8, paddingTop: 36 },
  emptyMatchText: { color: colors.muted, fontSize: 13 },
  noticeBanner: {
    alignItems: 'center',
    backgroundColor: '#ECFDF3',
    borderColor: '#ABEFC6',
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
    marginHorizontal: 16,
    padding: 10,
  },
  noticeText: { color: colors.success, flex: 1, fontSize: 13, lineHeight: 18 },
  noticeClose: { alignItems: 'center', height: 28, justifyContent: 'center', width: 28 },
  modalBackdrop: { backgroundColor: 'rgba(15, 23, 42, 0.48)', flex: 1, justifyContent: 'flex-end' },
  filterSheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    gap: 13,
    maxHeight: '78%',
    padding: 18,
  },
  sheetHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: 12 },
  sheetEyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800' },
  sheetTitle: { color: colors.text, fontSize: 21, fontWeight: '800', marginTop: 3 },
  sheetClose: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    marginLeft: 'auto',
    width: 40,
  },
  filterSectionTitle: { color: colors.text, fontSize: 13, fontWeight: '800', marginTop: 2 },
  filterChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filterFooter: { flexDirection: 'row', gap: 10, marginTop: 8 },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 46,
  },
  secondaryButtonText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flex: 2,
    justifyContent: 'center',
    minHeight: 46,
  },
  primaryButtonText: { color: colors.surface, fontSize: 14, fontWeight: '800' },
  launchSheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: '92%',
    minHeight: '56%',
  },
  launchHeader: {
    alignItems: 'flex-start',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 18,
  },
  launchHeaderCopy: { flex: 1, gap: 4 },
  launchEyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800' },
  launchTitle: { color: colors.text, fontSize: 22, fontWeight: '800' },
  launchDescription: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  closeButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  launchLoading: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', padding: 32 },
  launchLoadingText: { color: colors.muted, fontSize: 14 },
  launchContent: { gap: 14, padding: 18, paddingBottom: 32 },
  launchError: { backgroundColor: '#FEF3F2', color: colors.danger, fontSize: 13, lineHeight: 19, padding: 10 },
  launchEmpty: { color: colors.muted, fontSize: 14, lineHeight: 21, paddingVertical: 18, textAlign: 'center' },
  choiceSection: { gap: 8 },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: '800' },
  choiceWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceChip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    maxWidth: '100%',
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 11,
  },
  choiceChipSelected: { backgroundColor: colors.surfaceMuted, borderColor: colors.accent },
  choiceChipText: { color: colors.muted, fontSize: 13, fontWeight: '700', maxWidth: 280 },
  choiceChipTextSelected: { color: colors.accent },
  launchInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  launchPrompt: { minHeight: 112, paddingTop: 12 },
  submitLaunch: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginTop: 4,
    minHeight: 48,
  },
  submitLaunchText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.52 },
});
