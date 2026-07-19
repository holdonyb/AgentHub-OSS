import { Ionicons } from '@expo/vector-icons';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type {
  MobileApi,
  NativeProviderSnapshot,
  NativeTaskArtifact,
  NativeTaskAuthorityPreset,
  NativeTaskCreateInput,
  NativeTaskExecution,
  NativeTaskReviewAction,
  NativeTaskStatus,
  NativeTaskSummary,
  NativeTaskTemplateKey,
  NativeWorkerSummary,
} from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { RichMarkdown } from './RichMarkdown';
import { formatLastActivity, taskStatusLabel } from './resourcePresentation';

type TasksApi = Pick<
  MobileApi,
  'createTask' | 'getTask' | 'listProviderSnapshots' | 'listTasks' | 'listWorkers' | 'reviewTask'
>;

interface TaskDraft {
  title: string;
  brief: string;
  successCriteria: string;
  targetWorkerId: string;
  backend: string;
  workspaceRoot: string;
  relevantPaths: string;
  templateKey: NativeTaskTemplateKey;
  authorityPreset: NativeTaskAuthorityPreset;
}

type TaskInboxFilter = 'all' | 'ready_to_review' | 'blocked' | 'working' | 'archived';

const emptyTaskDraft: TaskDraft = {
  title: '',
  brief: '',
  successCriteria: '',
  targetWorkerId: '',
  backend: '',
  workspaceRoot: '',
  relevantPaths: '',
  templateKey: 'implement_feature',
  authorityPreset: 'feature',
};

const inboxFilters: ReadonlyArray<{ key: TaskInboxFilter; label: string; description: string }> = [
  { key: 'ready_to_review', label: '待验收', description: '等待你确认交付结果' },
  { key: 'blocked', label: '已阻塞', description: '需要审批或人工处理' },
  { key: 'working', label: '执行中', description: '排队或正在执行' },
  { key: 'all', label: '全部任务', description: '查看完整任务列表' },
  { key: 'archived', label: '已归档', description: '查看和恢复历史任务' },
];

function matchesInboxFilter(task: NativeTaskSummary, filter: TaskInboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ready_to_review') return task.status === 'ready_to_review';
  if (filter === 'blocked') return task.status === 'blocked' || task.status === 'needs_approval';
  if (filter === 'working') return task.status === 'working' || task.status === 'queued';
  if (filter === 'archived') return task.status === 'archived';
  return true;
}

export function TasksScreen({
  api,
  canOperate = false,
  csrfToken = '',
  onRequestError,
  onOpenFile,
  requestedTaskId = null,
  onRequestedTaskHandled,
}: {
  api: TasksApi;
  canOperate?: boolean;
  csrfToken?: string;
  onRequestError?(error: unknown): void;
  onOpenFile?(target: { sessionId: string; path: string }): void;
  requestedTaskId?: string | null;
  onRequestedTaskHandled?(taskId: string): void;
}) {
  const [filterKey, setFilterKey] = useState<TaskInboxFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>(emptyTaskDraft);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [composerLoading, setComposerLoading] = useState(false);
  const [composerWorkers, setComposerWorkers] = useState<NativeWorkerSummary[]>([]);
  const [composerProviders, setComposerProviders] = useState<NativeProviderSnapshot[]>([]);
  const loadTasks = useCallback(async () => {
    const [active, archived] = await Promise.all([
      api.listTasks(undefined),
      api.listTasks(undefined, true),
    ]);
    return { active: active.items, archived: archived.items };
  }, [api]);
  const resource = useAsyncResource(loadTasks, {
    onError: onRequestError,
    resetKey: 'all',
  });
  const activeTasks = resource.data?.active ?? [];
  const archivedTasks = resource.data?.archived ?? [];
  const tasks = filterKey === 'archived' ? archivedTasks : activeTasks;
  const counts = useMemo(() => ({
    ready_to_review: activeTasks.filter((task) => matchesInboxFilter(task, 'ready_to_review')).length,
    blocked: activeTasks.filter((task) => matchesInboxFilter(task, 'blocked')).length,
    working: activeTasks.filter((task) => matchesInboxFilter(task, 'working')).length,
    all: activeTasks.length,
    archived: archivedTasks.length,
  }), [activeTasks, archivedTasks]);
  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (!matchesInboxFilter(task, filterKey)) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        task.title,
        task.brief_markdown,
        task.success_criteria_markdown,
        task.target_worker_id,
        task.backend,
        task.workspace_root,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [filterKey, query, tasks]);
  const availableWorkers = useMemo(
    () => composerWorkers.filter((worker) => worker.status !== 'offline' && normalizedBackends(worker).length > 0),
    [composerWorkers],
  );
  const selectedWorker = useMemo(
    () => availableWorkers.find((worker) => worker.worker_id === draft.targetWorkerId) ?? null,
    [availableWorkers, draft.targetWorkerId],
  );
  const backendOptions = useMemo(
    () => normalizedBackends(selectedWorker),
    [selectedWorker],
  );

  useEffect(() => {
    if (!requestedTaskId) return;
    setSelectedTaskId(requestedTaskId);
    onRequestedTaskHandled?.(requestedTaskId);
  }, [onRequestedTaskHandled, requestedTaskId]);

  if (selectedTaskId) {
    return (
      <TaskDetailScreen
        api={api}
        canOperate={canOperate}
        csrfToken={csrfToken}
        onBack={() => setSelectedTaskId(null)}
        onOpenFile={onOpenFile}
        onRequestError={onRequestError}
        taskId={selectedTaskId}
      />
    );
  }

  async function submitTask() {
    if (!canOperate || mutationBusy) return;
    const title = draft.title.trim();
    const brief = draft.brief.trim();
    if (!title || !brief) {
      setMutationError('请填写任务标题和任务说明');
      return;
    }
    const payload: NativeTaskCreateInput = {
      title,
      brief_markdown: brief,
      success_criteria_markdown: draft.successCriteria.trim(),
      target_worker_id: draft.targetWorkerId.trim() || null,
      backend: draft.backend.trim().toLowerCase() || null,
      workspace_root: draft.workspaceRoot.trim() || null,
      namespace: 'default',
      priority: 100,
      template_key: draft.templateKey,
      authority_preset: draft.authorityPreset,
      relevant_paths: draft.relevantPaths
        .split(/\r?\n/)
        .map((path) => path.trim())
        .filter(Boolean),
      submit: true,
    };
    setMutationBusy(true);
    setMutationError(null);
    try {
      const result = await api.createTask(payload, csrfToken);
      setDraft(emptyTaskDraft);
      setComposerOpen(false);
      setSelectedTaskId(result.task.task_id);
      await resource.reload();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : '任务创建失败');
      onRequestError?.(error);
    } finally {
      setMutationBusy(false);
    }
  }

  async function openComposer() {
    setComposerOpen(true);
    setMutationError(null);
    setComposerLoading(true);
    try {
      const [workersPayload, providersPayload] = await Promise.all([
        api.listWorkers(),
        api.listProviderSnapshots(),
      ]);
      const workers = workersPayload.items.filter((worker) => (
        worker.status !== 'offline' && normalizedBackends(worker).length > 0
      ));
      setComposerWorkers(workers);
      setComposerProviders(providersPayload.items);
      const initialWorker = workers.find((worker) => worker.worker_id === draft.targetWorkerId) ?? workers[0] ?? null;
      if (!initialWorker) {
        setDraft((current) => ({ ...current, targetWorkerId: '', backend: '', workspaceRoot: '' }));
        return;
      }
      const initialBackends = normalizedBackends(initialWorker);
      setDraft((current) => ({
        ...current,
        targetWorkerId: initialWorker.worker_id,
        backend: initialBackends.includes(current.backend) ? current.backend : initialBackends[0] ?? '',
        workspaceRoot: initialWorker.workspace_roots?.includes(current.workspaceRoot)
          ? current.workspaceRoot
          : initialWorker.workspace_roots?.[0] ?? '',
      }));
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : '任务编辑器初始化失败');
      onRequestError?.(error);
    } finally {
      setComposerLoading(false);
    }
  }

  function renderTask({ item }: { item: NativeTaskSummary }) {
    return (
      <Pressable
        accessibilityLabel={`查看任务 ${item.title}`}
        accessibilityRole="button"
        onPress={() => setSelectedTaskId(item.task_id)}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={styles.cardTitleRow}>
          <Text numberOfLines={2} style={styles.cardTitle}>{item.title}</Text>
          <Ionicons color={colors.muted} name="chevron-forward" size={18} />
        </View>
        <View style={styles.metadataRow}>
          <Text style={[styles.status, taskStatusTone(item.status)]}>{taskStatusLabel(item.status)}</Text>
          <Text numberOfLines={1} style={styles.metadataText}>
            {item.target_worker_id ?? '未指定节点'} · {item.backend ?? '未指定后端'}
          </Text>
        </View>
        <View style={styles.cardFooter}>
          <Text style={styles.footerText}>{item.artifact_count} 个产物</Text>
          <Text style={styles.footerText}>{formatLastActivity(item.updated_at)}</Text>
        </View>
      </Pressable>
    );
  }

  const fullState = resource.loading || (resource.error !== null && resource.data === null) || tasks.length === 0;
  return (
    <View style={styles.screen}>
      <ResourceHeader
        eyebrow="WORKBENCH"
        onRefresh={resource.reload}
        refreshLabel="刷新任务"
        refreshing={resource.loading || resource.refreshing}
        title="任务收件箱"
      />
      {canOperate ? (
        <View style={styles.actionBar}>
          <Pressable
            accessibilityLabel="新建任务"
            accessibilityRole="button"
            onPress={() => {
              void openComposer();
            }}
            style={({ pressed }) => [styles.primaryAction, pressed && styles.cardPressed]}
          >
            <Ionicons color={colors.surface} name="add" size={19} />
            <Text style={styles.primaryActionText}>新建任务</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.inboxRail}>
        {inboxFilters.map((filter) => {
          const selected = filter.key === filterKey;
          return (
            <Pressable
              accessibilityLabel={`筛选任务：${filter.label}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={filter.key}
              onPress={() => setFilterKey(filter.key)}
              style={({ pressed }) => [
                styles.inboxCard,
                selected && styles.inboxCardSelected,
                pressed && styles.cardPressed,
              ]}
            >
              <Text style={[styles.inboxCardTitle, selected && styles.inboxCardTitleSelected]}>{filter.label}</Text>
              <Text style={[styles.inboxCardCount, selected && styles.inboxCardCountSelected]}>
                {counts[filter.key]}
              </Text>
              <Text style={[styles.inboxCardDescription, selected && styles.inboxCardDescriptionSelected]}>
                {filter.description}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.searchWrap}>
        <Ionicons color={colors.muted} name="search-outline" size={18} />
        <TextInput
          accessibilityLabel="搜索任务"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="搜索任务标题、说明、节点或后端"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          value={query}
        />
        {query ? (
          <Pressable
            accessibilityLabel="清空任务搜索"
            accessibilityRole="button"
            onPress={() => setQuery('')}
            style={({ pressed }) => [styles.clearButton, pressed && styles.cardPressed]}
          >
            <Ionicons color={colors.muted} name="close-circle" size={18} />
          </Pressable>
        ) : null}
      </View>
      {fullState ? (
        <ResourceState
          empty={filteredTasks.length === 0}
          emptyText={tasks.length === 0 ? '当前暂无任务' : query.trim() ? '没有匹配的任务' : '当前分组下暂无任务'}
          error={resource.error}
          failureTitle="任务加载失败"
          loading={resource.loading}
          loadingText="正在加载任务"
          onRetry={resource.reload}
          retryLabel="重试加载任务"
        />
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={filteredTasks}
          keyExtractor={(item) => item.task_id}
          ListHeaderComponent={resource.error ? (
            <ResourceErrorBanner
              error={resource.error}
              onRetry={resource.reload}
              retryLabel="重试加载任务"
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
          renderItem={renderTask}
        />
      )}
      <TaskComposer
        availableWorkers={availableWorkers}
        backendOptions={backendOptions}
        busy={mutationBusy}
        draft={draft}
        error={mutationError}
        loading={composerLoading}
        onChange={setDraft}
        onClose={() => {
          if (!mutationBusy) setComposerOpen(false);
        }}
        onSelectBackend={(backend) => setDraft((current) => ({ ...current, backend }))}
        onSelectWorker={(worker) => {
          const backends = normalizedBackends(worker);
          setDraft((current) => ({
            ...current,
            targetWorkerId: worker.worker_id,
            backend: backends.includes(current.backend) ? current.backend : backends[0] ?? '',
            workspaceRoot: worker.workspace_roots?.includes(current.workspaceRoot)
              ? current.workspaceRoot
              : worker.workspace_roots?.[0] ?? '',
          }));
        }}
        onSelectWorkspaceRoot={(workspaceRoot) => setDraft((current) => ({ ...current, workspaceRoot }))}
        onSubmit={submitTask}
        selectedWorker={selectedWorker}
        visible={composerOpen}
      />
    </View>
  );
}

function TaskComposer({
  availableWorkers,
  backendOptions,
  visible,
  loading,
  busy,
  draft,
  error,
  onChange,
  onClose,
  onSelectBackend,
  onSelectWorker,
  onSelectWorkspaceRoot,
  onSubmit,
  selectedWorker,
}: {
  availableWorkers: NativeWorkerSummary[];
  backendOptions: string[];
  visible: boolean;
  loading: boolean;
  busy: boolean;
  draft: TaskDraft;
  error: string | null;
  onChange: Dispatch<SetStateAction<TaskDraft>>;
  onClose(): void;
  onSelectBackend(backend: string): void;
  onSelectWorker(worker: NativeWorkerSummary): void;
  onSelectWorkspaceRoot(workspaceRoot: string): void;
  onSubmit(): Promise<void>;
  selectedWorker: NativeWorkerSummary | null;
}) {
  const patchDraft = (patch: Partial<TaskDraft>) => {
    onChange((current) => ({ ...current, ...patch }));
  };
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen" visible={visible}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.composerScreen}>
        <View style={styles.composerHeader}>
          <Pressable
            accessibilityLabel="关闭任务编辑器"
            accessibilityRole="button"
            disabled={busy}
            onPress={onClose}
            style={({ pressed }) => [styles.iconButton, pressed && styles.cardPressed]}
          >
            <Ionicons color={colors.text} name="close" size={22} />
          </Pressable>
          <View style={styles.composerHeaderCopy}>
            <Text style={styles.composerEyebrow}>WORKBENCH</Text>
            <Text style={styles.composerTitle}>新建任务</Text>
          </View>
        </View>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={8}
          style={styles.composerKeyboard}
        >
          <ScrollView
            contentContainerStyle={styles.composerContent}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.formSection}>
              <Text style={styles.fieldTitle}>任务模板</Text>
              <View style={styles.choiceRow}>
                {([
                  ['fix_bug', '修复问题'],
                  ['implement_feature', '实现功能'],
                  ['code_review', '代码审查'],
                  ['release_assistant', '发布助手'],
                ] as const).map(([templateKey, label]) => (
                  <ChoiceChip
                    accessibilityLabel={`选择任务模板 ${label}`}
                    key={templateKey}
                    label={label}
                    onPress={() => patchDraft({ templateKey })}
                    selected={draft.templateKey === templateKey}
                  />
                ))}
              </View>
            </View>
            <FormField
              accessibilityLabel="任务标题"
              onChangeText={(title) => patchDraft({ title })}
              placeholder="一句话说明要交付什么"
              title="任务标题"
              value={draft.title}
            />
            <FormField
              accessibilityLabel="任务说明"
              multiline
              onChangeText={(brief) => patchDraft({ brief })}
              placeholder="背景、范围、约束和已有线索"
              title="任务说明"
              value={draft.brief}
            />
            <FormField
              accessibilityLabel="验收标准"
              multiline
              onChangeText={(successCriteria) => patchDraft({ successCriteria })}
              placeholder="每行一条可验证结果"
              title="验收标准"
              value={draft.successCriteria}
            />
            <View style={styles.formSection}>
              <Text style={styles.fieldTitle}>执行节点</Text>
              {loading ? (
                <View style={styles.inlineLoading}>
                  <ActivityIndicator color={colors.accent} size="small" />
                  <Text style={styles.inlineLoadingText}>正在读取节点能力</Text>
                </View>
              ) : (
                <View style={styles.choiceRow}>
                  {availableWorkers.map((worker) => (
                    <ChoiceChip
                      accessibilityLabel={`选择任务节点 ${worker.machine_name || worker.worker_id}`}
                      key={worker.worker_id}
                      label={worker.machine_name || worker.worker_id}
                      onPress={() => onSelectWorker(worker)}
                      selected={draft.targetWorkerId === worker.worker_id}
                    />
                  ))}
                </View>
              )}
            </View>
            <View style={styles.formSection}>
              <Text style={styles.fieldTitle}>Agent 后端</Text>
              <View style={styles.choiceRow}>
                {backendOptions.map((backend) => (
                  <ChoiceChip
                    accessibilityLabel={`选择任务后端 ${backendLabel(backend)}`}
                    key={backend}
                    label={backendLabel(backend)}
                    onPress={() => onSelectBackend(backend)}
                    selected={draft.backend === backend}
                  />
                ))}
              </View>
            </View>
            <View style={styles.formSection}>
              <Text style={styles.fieldTitle}>工作目录</Text>
              <View style={styles.choiceRow}>
                {(selectedWorker?.workspace_roots ?? []).map((workspaceRoot) => (
                  <ChoiceChip
                    accessibilityLabel={`选择任务工作目录 ${workspaceRoot}`}
                    key={workspaceRoot}
                    label={workspaceRoot}
                    onPress={() => onSelectWorkspaceRoot(workspaceRoot)}
                    selected={draft.workspaceRoot === workspaceRoot}
                  />
                ))}
              </View>
            </View>
            <View style={styles.formSection}>
              <Text style={styles.fieldTitle}>执行权限</Text>
              <View style={styles.choiceRow}>
                {([
                  ['feature', '功能开发'],
                  ['code_fix', '修复代码'],
                  ['read_only', '只读'],
                  ['review_only', '仅审查'],
                ] as const).map(([authorityPreset, label]) => (
                  <ChoiceChip
                    key={authorityPreset}
                    label={label}
                    onPress={() => patchDraft({ authorityPreset })}
                    selected={draft.authorityPreset === authorityPreset}
                  />
                ))}
              </View>
            </View>
            <FormField
              accessibilityLabel="相关路径"
              autoCapitalize="none"
              multiline
              onChangeText={(relevantPaths) => patchDraft({ relevantPaths })}
              placeholder={'每行一个工作区相对路径\napps/web\napps/api'}
              title="相关路径"
              value={draft.relevantPaths}
            />
            {error ? <Text style={styles.formError}>{error}</Text> : null}
          </ScrollView>
          <View style={styles.composerFooter}>
            <Pressable
              accessibilityLabel="创建并派发任务"
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onSubmit()}
              style={({ pressed }) => [
                styles.submitButton,
                pressed && styles.cardPressed,
                busy && styles.buttonDisabled,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.surface} size="small" />
              ) : (
                <Ionicons color={colors.surface} name="paper-plane" size={18} />
              )}
              <Text style={styles.submitButtonText}>{busy ? '正在派发' : '创建并派发'}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function FormField({
  title,
  accessibilityLabel,
  multiline = false,
  ...props
}: ComponentProps<typeof TextInput> & { title: string; accessibilityLabel: string }) {
  return (
    <View style={styles.formSection}>
      <Text style={styles.fieldTitle}>{title}</Text>
      <TextInput
        {...props}
        accessibilityLabel={accessibilityLabel}
        multiline={multiline}
        placeholderTextColor={colors.muted}
        style={[styles.input, multiline && styles.inputMultiline]}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
    </View>
  );
}

function ChoiceChip({
  accessibilityLabel,
  label,
  selected,
  onPress,
}: {
  accessibilityLabel?: string;
  label: string;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceChip,
        selected && styles.choiceChipSelected,
        pressed && styles.cardPressed,
      ]}
    >
      <Text style={[styles.choiceChipText, selected && styles.choiceChipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function TaskDetailScreen({
  api,
  canOperate,
  csrfToken,
  taskId,
  onBack,
  onRequestError,
  onOpenFile,
}: {
  api: TasksApi;
  canOperate: boolean;
  csrfToken: string;
  taskId: string;
  onBack(): void;
  onRequestError?(error: unknown): void;
  onOpenFile?(target: { sessionId: string; path: string }): void;
}) {
  const loadTask = useCallback(() => api.getTask(taskId), [api, taskId]);
  const resource = useAsyncResource(loadTask, { onError: onRequestError, resetKey: taskId });
  const detail = resource.data;
  const [taskOverride, setTaskOverride] = useState<NativeTaskSummary | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const task = taskOverride ?? detail?.task ?? null;

  async function openDetailLink(target: string) {
    const normalized = target.replace(/\\/g, '/').trim();
    if (!normalized) return;
    if (/^https?:\/\//i.test(normalized)) {
      await Linking.openURL(normalized);
      return;
    }
    if (!task?.latest_session_id) return;
    onOpenFile?.({ sessionId: task.latest_session_id, path: normalized.replace(/^\/+/, '') });
  }

  async function submitReview(action: NativeTaskReviewAction) {
    if (!task || reviewBusy || !canOperate) return;
    const note = reviewNote.trim();
    if (action === 'request_changes' && !note) {
      setReviewError('请填写需要修改的内容');
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    try {
      const result = await api.reviewTask(task.task_id, { action, note_markdown: note }, csrfToken);
      setTaskOverride(result.task);
      setReviewNote('');
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : '任务状态更新失败');
      onRequestError?.(error);
    } finally {
      setReviewBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.detailHeader}>
        <Pressable
          accessibilityLabel="返回任务列表"
          accessibilityRole="button"
          onPress={onBack}
          style={({ pressed }) => [styles.iconButton, pressed && styles.cardPressed]}
        >
          <Ionicons color={colors.text} name="arrow-back" size={21} />
        </Pressable>
        <Text numberOfLines={1} style={styles.detailHeaderTitle}>任务详情</Text>
        <Pressable
          accessibilityLabel="刷新任务详情"
          accessibilityRole="button"
          disabled={resource.loading || resource.refreshing}
          onPress={() => void resource.reload()}
          style={({ pressed }) => [styles.iconButton, pressed && styles.cardPressed]}
        >
          <Ionicons color={colors.accent} name="refresh" size={21} />
        </Pressable>
      </View>
      {!detail ? (
        <ResourceState
          empty={false}
          emptyText=""
          error={resource.error}
          failureTitle="任务详情加载失败"
          loading={resource.loading}
          loadingText="正在加载任务详情"
          onRetry={resource.reload}
          retryLabel="重试加载任务详情"
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.detailContent}
          refreshControl={(
            <RefreshControl
              colors={[colors.accent]}
              onRefresh={() => void resource.reload()}
              refreshing={resource.refreshing}
              tintColor={colors.accent}
            />
          )}
        >
          {resource.error ? (
            <ResourceErrorBanner
              error={resource.error}
              onRetry={resource.reload}
              retryLabel="重试加载任务详情"
            />
          ) : null}
          <View style={styles.detailLead}>
            <Text style={[styles.status, taskStatusTone(task?.status ?? detail.task.status)]}>
              {taskStatusLabel(task?.status ?? detail.task.status)}
            </Text>
            <Text style={styles.detailTitle}>{task?.title ?? detail.task.title}</Text>
            <Text style={styles.detailMetadata}>
              {task?.target_worker_id ?? '未指定节点'} · {task?.backend ?? '未指定后端'}
            </Text>
            <Text style={styles.detailMetadata}>更新于 {formatLastActivity(task?.updated_at ?? detail.task.updated_at)}</Text>
          </View>
          <DetailSection onLinkPress={(target) => void openDetailLink(target)} title="任务说明" text={detail.task.brief_markdown || '暂无任务说明'} />
          <DetailSection
            onLinkPress={(target) => void openDetailLink(target)}
            title="验收标准"
            text={detail.task.success_criteria_markdown || '暂无验收标准'}
          />
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>产物（{detail.artifacts.length}）</Text>
            {detail.artifacts.length === 0 ? (
              <Text style={styles.sectionEmpty}>暂无产物</Text>
            ) : detail.artifacts.map((artifact) => (
              <ArtifactRow
                artifact={artifact}
                key={artifact.artifact_id}
                onLinkPress={(target) => void openDetailLink(target)}
                onOpenFile={task?.latest_session_id && artifact.path
                  ? () => onOpenFile?.({ sessionId: task.latest_session_id!, path: artifact.path! })
                  : undefined}
              />
            ))}
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>执行记录（{detail.executions.length}）</Text>
            {detail.executions.length === 0 ? (
              <Text style={styles.sectionEmpty}>暂无执行记录</Text>
            ) : detail.executions.map((execution) => (
              <ExecutionRow execution={execution} key={execution.execution_id} />
            ))}
          </View>
          {task && canOperate ? (
            <TaskReviewPanel
              busy={reviewBusy}
              error={reviewError}
              note={reviewNote}
              onChangeNote={setReviewNote}
              onSubmit={submitReview}
              status={task.status}
            />
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function TaskReviewPanel({
  status,
  note,
  busy,
  error,
  onChangeNote,
  onSubmit,
}: {
  status: NativeTaskStatus;
  note: string;
  busy: boolean;
  error: string | null;
  onChangeNote(value: string): void;
  onSubmit(action: NativeTaskReviewAction): Promise<void>;
}) {
  const canRequestChanges = ['ready_to_review', 'failed', 'blocked', 'rejected'].includes(status);
  const canArchive = ['accepted', 'rejected', 'failed', 'cancelled'].includes(status);
  if (!canRequestChanges && !canArchive && status !== 'archived') return null;
  return (
    <View style={styles.reviewSection}>
      <Text style={styles.sectionTitle}>任务处理</Text>
      {canRequestChanges ? (
        <TextInput
          accessibilityLabel="修改说明"
          multiline
          onChangeText={onChangeNote}
          placeholder="需要调整时，写清楚问题和验收要求"
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.reviewInput]}
          textAlignVertical="top"
          value={note}
        />
      ) : null}
      {error ? <Text style={styles.formError}>{error}</Text> : null}
      <View style={styles.reviewActions}>
        {status === 'ready_to_review' ? (
          <>
            <ReviewButton
              accessibilityLabel="通过验收"
              busy={busy}
              label="通过验收"
              onPress={() => void onSubmit('accept')}
              tone="primary"
            />
            <ReviewButton
              accessibilityLabel="拒绝任务"
              busy={busy}
              label="拒绝"
              onPress={() => void onSubmit('reject')}
              tone="danger"
            />
          </>
        ) : null}
        {canRequestChanges ? (
          <ReviewButton
            accessibilityLabel="退回修改"
            busy={busy || !note.trim()}
            label="退回修改"
            onPress={() => void onSubmit('request_changes')}
            tone="secondary"
          />
        ) : null}
        {canArchive ? (
          <ReviewButton
            accessibilityLabel="归档任务"
            busy={busy}
            label="归档"
            onPress={() => void onSubmit('archive')}
            tone="secondary"
          />
        ) : null}
        {status === 'archived' ? (
          <ReviewButton
            accessibilityLabel="恢复任务"
            busy={busy}
            label="恢复任务"
            onPress={() => void onSubmit('restore')}
            tone="secondary"
          />
        ) : null}
      </View>
    </View>
  );
}

function ReviewButton({
  accessibilityLabel,
  label,
  tone,
  busy,
  onPress,
}: {
  accessibilityLabel: string;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
  busy: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.reviewButton,
        tone === 'primary' && styles.reviewButtonPrimary,
        tone === 'danger' && styles.reviewButtonDanger,
        pressed && styles.cardPressed,
        busy && styles.buttonDisabled,
      ]}
    >
      <Text
        style={[
          styles.reviewButtonText,
          tone === 'primary' && styles.reviewButtonTextPrimary,
          tone === 'danger' && styles.reviewButtonTextDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DetailSection({ title, text, onLinkPress }: { title: string; text: string; onLinkPress?(target: string): void }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <RichMarkdown onLinkPress={onLinkPress} value={text} />
    </View>
  );
}

function normalizedBackends(worker: NativeWorkerSummary | null | undefined): string[] {
  const values = worker?.reachable_backends ?? [];
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function backendLabel(backend: string): string {
  const normalized = backend.trim().toLowerCase();
  if (normalized === 'opencode') return 'OpenCode';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function ArtifactRow({
  artifact,
  onOpenFile,
  onLinkPress,
}: {
  artifact: NativeTaskArtifact;
  onOpenFile?: () => void;
  onLinkPress?(target: string): void;
}) {
  const rowContent = (
    <>
      <Ionicons color={colors.accent} name="document-text-outline" size={19} />
      <View style={styles.detailRowCopy}>
        <Text style={styles.detailRowTitle}>{artifact.title}</Text>
        <Text numberOfLines={2} style={styles.detailRowMetadata}>
          {artifact.kind}{artifact.path ? ` · ${artifact.path}` : ''}
        </Text>
      </View>
      {onOpenFile ? <Ionicons color={colors.muted} name="chevron-forward" size={18} /> : null}
    </>
  );
  const row = onOpenFile ? (
      <Pressable
        accessibilityLabel={`打开产物文件 ${artifact.title}`}
        accessibilityRole="button"
        onPress={onOpenFile}
        style={({ pressed }) => [styles.detailRow, pressed && styles.cardPressed]}
      >
        {rowContent}
      </Pressable>
  ) : (
    <View style={styles.detailRow}>
      {rowContent}
    </View>
  );
  return (
    <View style={styles.artifactBlock}>
      {row}
      {artifact.content_markdown?.trim() ? (
        <View style={styles.artifactMarkdown}>
          <RichMarkdown onLinkPress={onLinkPress} value={artifact.content_markdown} />
        </View>
      ) : null}
    </View>
  );
}

function ExecutionRow({ execution }: { execution: NativeTaskExecution }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons color={colors.muted} name="pulse-outline" size={19} />
      <View style={styles.detailRowCopy}>
        <Text style={styles.detailRowTitle}>第 {execution.attempt_number} 次执行</Text>
        <Text style={styles.detailRowMetadata}>
          {execution.kind} · {execution.status} · {formatLastActivity(execution.updated_at)}
        </Text>
      </View>
    </View>
  );
}

function taskStatusTone(status: NativeTaskStatus) {
  if (status === 'failed' || status === 'rejected' || status === 'blocked') return styles.statusDanger;
  if (status === 'accepted') return styles.statusSuccess;
  return styles.statusActive;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.canvas, flex: 1 },
  actionBar: { alignItems: 'flex-end', paddingBottom: 12, paddingHorizontal: 16 },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 15,
  },
  primaryActionText: { color: colors.surface, fontSize: 14, fontWeight: '700' },
  inboxRail: { gap: 10, paddingBottom: 10, paddingHorizontal: 16 },
  searchWrap: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  searchInput: {
    color: colors.text,
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  clearButton: {
    alignItems: 'center',
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  inboxCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 4,
    minHeight: 84,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inboxCardSelected: { backgroundColor: '#E8F1FD', borderColor: colors.accent },
  inboxCardTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  inboxCardTitleSelected: { color: colors.accent },
  inboxCardCount: { color: colors.muted, fontSize: 22, fontWeight: '800' },
  inboxCardCountSelected: { color: colors.accent },
  inboxCardDescription: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  inboxCardDescriptionSelected: { color: colors.accent },
  list: { gap: 10, paddingBottom: 28, paddingHorizontal: 16, paddingTop: 4 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 12,
    padding: 15,
  },
  cardPressed: { opacity: 0.68 },
  buttonDisabled: { opacity: 0.5 },
  cardTitleRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
  cardTitle: { color: colors.text, flex: 1, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  metadataRow: { alignItems: 'center', flexDirection: 'row', gap: 9 },
  metadataText: { color: colors.muted, flex: 1, fontSize: 12 },
  status: { borderRadius: 4, fontSize: 12, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 4 },
  statusActive: { backgroundColor: '#E8F1FD', color: colors.accent },
  statusDanger: { backgroundColor: '#FEF3F2', color: colors.danger },
  statusSuccess: { backgroundColor: '#ECFDF3', color: colors.success },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { color: colors.muted, fontSize: 12 },
  detailHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
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
  detailHeaderTitle: { color: colors.text, flex: 1, fontSize: 18, fontWeight: '700' },
  detailContent: { paddingBottom: 36, paddingHorizontal: 18 },
  detailLead: { gap: 9, paddingVertical: 22 },
  detailTitle: { color: colors.text, fontSize: 23, fontWeight: '700', lineHeight: 30 },
  detailMetadata: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  section: { borderTopColor: colors.border, borderTopWidth: 1, gap: 10, paddingVertical: 18 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sectionBody: { color: colors.text, fontSize: 14, lineHeight: 22 },
  sectionEmpty: { color: colors.muted, fontSize: 13 },
  artifactBlock: { gap: 10 },
  artifactMarkdown: { paddingLeft: 30, paddingRight: 8 },
  detailRow: {
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 12,
  },
  detailRowCopy: { flex: 1, gap: 4 },
  detailRowTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  detailRowMetadata: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  composerScreen: { backgroundColor: colors.canvas, flex: 1 },
  composerHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  composerHeaderCopy: { flex: 1, gap: 2 },
  composerEyebrow: { color: colors.accent, fontSize: 10, fontWeight: '800' },
  composerTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  composerKeyboard: { flex: 1 },
  composerContent: { gap: 20, paddingBottom: 28, paddingHorizontal: 18, paddingTop: 20 },
  formSection: { gap: 8 },
  fieldTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  inputMultiline: { lineHeight: 21, minHeight: 112 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    paddingHorizontal: 12,
  },
  choiceChipSelected: { backgroundColor: colors.surfaceMuted, borderColor: colors.accent },
  choiceChipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  choiceChipTextSelected: { color: colors.accent, fontWeight: '700' },
  inlineLoading: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 40 },
  inlineLoadingText: { color: colors.muted, fontSize: 13 },
  formError: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  composerFooter: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  submitButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 50,
  },
  submitButtonText: { color: colors.surface, fontSize: 15, fontWeight: '700' },
  reviewSection: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 12,
    paddingBottom: 12,
    paddingTop: 20,
  },
  reviewInput: { lineHeight: 20, minHeight: 88 },
  reviewActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  reviewButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 14,
  },
  reviewButtonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  reviewButtonDanger: { backgroundColor: '#FEF3F2', borderColor: '#FECDCA' },
  reviewButtonText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  reviewButtonTextPrimary: { color: colors.surface },
  reviewButtonTextDanger: { color: colors.danger },
});
