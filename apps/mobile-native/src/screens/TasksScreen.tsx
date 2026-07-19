import { Ionicons } from '@expo/vector-icons';
import {
  useCallback,
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
  NativeTaskArtifact,
  NativeTaskAuthorityPreset,
  NativeTaskCreateInput,
  NativeTaskExecution,
  NativeTaskReviewAction,
  NativeTaskStatus,
  NativeTaskSummary,
  NativeTaskTemplateKey,
} from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, taskStatusLabel } from './resourcePresentation';

type TasksApi = Pick<MobileApi, 'createTask' | 'getTask' | 'listTasks' | 'reviewTask'>;

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

type TaskInboxFilter = 'all' | 'ready_to_review' | 'blocked' | 'working';

const emptyTaskDraft: TaskDraft = {
  title: '',
  brief: '',
  successCriteria: '',
  targetWorkerId: '',
  backend: 'codex',
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
];

function matchesInboxFilter(task: NativeTaskSummary, filter: TaskInboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ready_to_review') return task.status === 'ready_to_review';
  if (filter === 'blocked') return task.status === 'blocked' || task.status === 'needs_approval';
  if (filter === 'working') return task.status === 'working' || task.status === 'queued';
  return true;
}

export function TasksScreen({
  api,
  canOperate = false,
  csrfToken = '',
  onRequestError,
}: {
  api: TasksApi;
  canOperate?: boolean;
  csrfToken?: string;
  onRequestError?(error: unknown): void;
}) {
  const [filterKey, setFilterKey] = useState<TaskInboxFilter>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>(emptyTaskDraft);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const loadTasks = useCallback(async () => (await api.listTasks(undefined)).items, [api]);
  const resource = useAsyncResource(loadTasks, {
    onError: onRequestError,
    resetKey: 'all',
  });
  const tasks = resource.data ?? [];
  const counts = useMemo(() => ({
    ready_to_review: tasks.filter((task) => matchesInboxFilter(task, 'ready_to_review')).length,
    blocked: tasks.filter((task) => matchesInboxFilter(task, 'blocked')).length,
    working: tasks.filter((task) => matchesInboxFilter(task, 'working')).length,
    all: tasks.length,
  }), [tasks]);
  const filteredTasks = useMemo(
    () => tasks.filter((task) => matchesInboxFilter(task, filterKey)),
    [filterKey, tasks],
  );

  if (selectedTaskId) {
    return (
      <TaskDetailScreen
        api={api}
        canOperate={canOperate}
        csrfToken={csrfToken}
        onBack={() => setSelectedTaskId(null)}
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
              setMutationError(null);
              setComposerOpen(true);
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
      {fullState ? (
        <ResourceState
          empty={filteredTasks.length === 0}
          emptyText={tasks.length === 0 ? '当前暂无任务' : '当前分组下暂无任务'}
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
        busy={mutationBusy}
        draft={draft}
        error={mutationError}
        onChange={setDraft}
        onClose={() => {
          if (!mutationBusy) setComposerOpen(false);
        }}
        onSubmit={submitTask}
        visible={composerOpen}
      />
    </View>
  );
}

function TaskComposer({
  visible,
  busy,
  draft,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  busy: boolean;
  draft: TaskDraft;
  error: string | null;
  onChange: Dispatch<SetStateAction<TaskDraft>>;
  onClose(): void;
  onSubmit(): Promise<void>;
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
              <Text style={styles.fieldTitle}>Agent 后端</Text>
              <View style={styles.choiceRow}>
                {['codex', 'claude', 'kimi', 'opencode'].map((backend) => (
                  <ChoiceChip
                    key={backend}
                    label={backend === 'opencode' ? 'OpenCode' : `${backend.charAt(0).toUpperCase()}${backend.slice(1)}`}
                    onPress={() => patchDraft({ backend })}
                    selected={draft.backend === backend}
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
              accessibilityLabel="目标节点"
              autoCapitalize="none"
              onChangeText={(targetWorkerId) => patchDraft({ targetWorkerId })}
              placeholder="例如 worker-main"
              title="目标节点"
              value={draft.targetWorkerId}
            />
            <FormField
              accessibilityLabel="工作目录"
              autoCapitalize="none"
              onChangeText={(workspaceRoot) => patchDraft({ workspaceRoot })}
              placeholder="例如 E:/Work/AgentHub-OSS"
              title="工作目录"
              value={draft.workspaceRoot}
            />
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
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
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
}: {
  api: TasksApi;
  canOperate: boolean;
  csrfToken: string;
  taskId: string;
  onBack(): void;
  onRequestError?(error: unknown): void;
}) {
  const loadTask = useCallback(() => api.getTask(taskId), [api, taskId]);
  const resource = useAsyncResource(loadTask, { onError: onRequestError, resetKey: taskId });
  const detail = resource.data;
  const [taskOverride, setTaskOverride] = useState<NativeTaskSummary | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const task = taskOverride ?? detail?.task ?? null;

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
          <DetailSection title="任务说明" text={detail.task.brief_markdown || '暂无任务说明'} />
          <DetailSection
            title="验收标准"
            text={detail.task.success_criteria_markdown || '暂无验收标准'}
          />
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>产物（{detail.artifacts.length}）</Text>
            {detail.artifacts.length === 0 ? (
              <Text style={styles.sectionEmpty}>暂无产物</Text>
            ) : detail.artifacts.map((artifact) => <ArtifactRow artifact={artifact} key={artifact.artifact_id} />)}
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

function DetailSection({ title, text }: { title: string; text: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionBody}>{text}</Text>
    </View>
  );
}

function ArtifactRow({ artifact }: { artifact: NativeTaskArtifact }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons color={colors.accent} name="document-text-outline" size={19} />
      <View style={styles.detailRowCopy}>
        <Text style={styles.detailRowTitle}>{artifact.title}</Text>
        <Text numberOfLines={2} style={styles.detailRowMetadata}>
          {artifact.kind}{artifact.path ? ` · ${artifact.path}` : ''}
        </Text>
      </View>
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
