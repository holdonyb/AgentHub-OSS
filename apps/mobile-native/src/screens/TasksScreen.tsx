import { Ionicons } from '@expo/vector-icons';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {
  MobileApi,
  NativeTaskArtifact,
  NativeTaskExecution,
  NativeTaskStatus,
  NativeTaskSummary,
} from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, taskStatusLabel } from './resourcePresentation';

type TasksApi = Pick<MobileApi, 'getTask' | 'listTasks'>;

const taskFilters: ReadonlyArray<{ label: string; status: NativeTaskStatus | undefined }> = [
  { label: '全部', status: undefined },
  { label: '草稿', status: 'draft' },
  { label: '排队中', status: 'queued' },
  { label: '执行中', status: 'working' },
  { label: '受阻', status: 'blocked' },
  { label: '待审批', status: 'needs_approval' },
  { label: '待验收', status: 'ready_to_review' },
  { label: '已完成', status: 'accepted' },
  { label: '已拒绝', status: 'rejected' },
  { label: '失败', status: 'failed' },
  { label: '已取消', status: 'cancelled' },
];

export function TasksScreen({
  api,
  onRequestError,
}: {
  api: TasksApi;
  onRequestError?(error: unknown): void;
}) {
  const [status, setStatus] = useState<NativeTaskStatus | undefined>(undefined);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const loadTasks = useCallback(async () => (await api.listTasks(status)).items, [api, status]);
  const resource = useAsyncResource(loadTasks, {
    onError: onRequestError,
    resetKey: status ?? 'all',
  });
  const tasks = resource.data ?? [];

  if (selectedTaskId) {
    return (
      <TaskDetailScreen
        api={api}
        onBack={() => setSelectedTaskId(null)}
        onRequestError={onRequestError}
        taskId={selectedTaskId}
      />
    );
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
        title="任务"
      />
      <ScrollView
        contentContainerStyle={styles.filterContent}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filters}
      >
        {taskFilters.map((filter) => {
          const selected = filter.status === status;
          return (
            <Pressable
              accessibilityLabel={`筛选任务：${filter.label}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={filter.status ?? 'all'}
              onPress={() => setStatus(filter.status)}
              style={({ pressed }) => [
                styles.filter,
                selected && styles.filterSelected,
                pressed && styles.cardPressed,
              ]}
            >
              <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{filter.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {fullState ? (
        <ResourceState
          empty={tasks.length === 0}
          emptyText="当前筛选下暂无任务"
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
          data={tasks}
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
    </View>
  );
}

function TaskDetailScreen({
  api,
  taskId,
  onBack,
  onRequestError,
}: {
  api: TasksApi;
  taskId: string;
  onBack(): void;
  onRequestError?(error: unknown): void;
}) {
  const loadTask = useCallback(() => api.getTask(taskId), [api, taskId]);
  const resource = useAsyncResource(loadTask, { onError: onRequestError, resetKey: taskId });
  const detail = resource.data;

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
            <Text style={[styles.status, taskStatusTone(detail.task.status)]}>
              {taskStatusLabel(detail.task.status)}
            </Text>
            <Text style={styles.detailTitle}>{detail.task.title}</Text>
            <Text style={styles.detailMetadata}>
              {detail.task.target_worker_id ?? '未指定节点'} · {detail.task.backend ?? '未指定后端'}
            </Text>
            <Text style={styles.detailMetadata}>更新于 {formatLastActivity(detail.task.updated_at)}</Text>
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
        </ScrollView>
      )}
    </View>
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
  filters: { flexGrow: 0, maxHeight: 48 },
  filterContent: { gap: 7, paddingHorizontal: 16, paddingBottom: 10 },
  filter: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  filterSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  filterTextSelected: { color: colors.surface },
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
});
