import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type {
  MobileApi,
  NativeJob,
  NativePermission,
  NativePermissionAction,
  NativeSessionSummary,
  NativeTimelineItem,
} from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, sessionStatusLabel } from './resourcePresentation';
import {
  buildQuestionResponse,
  permissionChoices,
  permissionQuestions,
  sortedTimeline,
  type NativePermissionChoice,
} from './sessionDetailPresentation';

type SessionDetailApi = Pick<
  MobileApi,
  | 'getSession'
  | 'getSessionTimeline'
  | 'listJobs'
  | 'listPermissions'
  | 'respondPermission'
  | 'sendSessionInput'
  | 'terminateSession'
>;

interface SessionThreadData {
  session: NativeSessionSummary;
  timeline: NativeTimelineItem[];
  timelineHasMore: boolean;
  permissions: NativePermission[];
  jobs: NativeJob[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

function timelineLabel(item: NativeTimelineItem): string {
  if (item.role === 'user') return '你';
  if (item.role === 'assistant') return 'Agent';
  if (item.item_type === 'tool_call') return item.tool_name ? `工具 · ${item.tool_name}` : '工具';
  if (item.item_type === 'reasoning') return '思考';
  if (item.item_type === 'goal') return '目标';
  if (item.item_type === 'error') return '错误';
  return item.role ?? item.item_type;
}

function timelineTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function sendStateText(job: NativeJob | null, sending: boolean, sendError: string | null) {
  if (sending) return { kind: 'active' as const, text: '正在发送' };
  if (sendError) return { kind: 'error' as const, text: `发送失败：${sendError}` };
  if (!job) return null;
  if (job.status === 'queued') {
    return { kind: 'active' as const, text: job.queue_reason_text || '排队中' };
  }
  if (job.status === 'running') return { kind: 'active' as const, text: '运行中' };
  if (job.status === 'failed') {
    return { kind: 'error' as const, text: `失败：${job.error_text || '执行失败'}` };
  }
  if (job.status === 'cancelled') return { kind: 'error' as const, text: '已取消' };
  return { kind: 'success' as const, text: '已完成' };
}

function PermissionCard({
  permission,
  busy,
  error,
  onRespond,
}: {
  permission: NativePermission;
  busy: boolean;
  error?: string;
  onRespond(action: NativePermissionAction, response?: Record<string, unknown>): void;
}) {
  const questions = useMemo(() => permissionQuestions(permission), [permission]);
  const choices = useMemo(() => permissionChoices(permission), [permission]);
  const [selected, setSelected] = useState<Record<string, NativePermissionChoice>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const canSubmitQuestions = questions.length > 0 && questions.every((question) => {
    const answer = selected[question.id];
    if (!answer) return false;
    return !answer.freeform || Boolean(freeform[question.id]?.trim());
  });

  function submitQuestions() {
    if (busy || !canSubmitQuestions) return;
    onRespond('answer', buildQuestionResponse(selected, freeform, note));
  }

  function answerChoice(choice: NativePermissionChoice) {
    if (busy) return;
    onRespond('answer', {
      choice: choice.id,
      label: choice.label,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  }

  return (
    <View accessibilityLabel={`待处理：${permission.title}`} style={styles.permissionCard}>
      <View style={styles.permissionHeading}>
        <View style={styles.permissionIcon}>
          <Ionicons color={colors.accent} name="shield-checkmark-outline" size={19} />
        </View>
        <View style={styles.permissionCopy}>
          <Text style={styles.permissionTitle}>{permission.title}</Text>
          {permission.description ? (
            <Text style={styles.permissionDescription}>{permission.description}</Text>
          ) : null}
        </View>
      </View>

      {questions.map((question) => {
        const questionTitle = question.header || question.question || question.id;
        return (
          <View key={question.id} style={styles.question}>
            <Text style={styles.questionTitle}>{questionTitle}</Text>
            {question.question && question.question !== questionTitle ? (
              <Text style={styles.questionText}>{question.question}</Text>
            ) : null}
            <View style={styles.choiceList}>
              {question.options.map((choice) => {
                const isSelected = selected[question.id]?.id === choice.id;
                return (
                  <Pressable
                    accessibilityLabel={`选择 ${questionTitle}：${choice.label}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected, disabled: busy }}
                    disabled={busy}
                    key={choice.id}
                    onPress={() => setSelected((current) => ({ ...current, [question.id]: choice }))}
                    style={({ pressed }) => [
                      styles.choice,
                      isSelected && styles.choiceSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={[styles.radio, isSelected && styles.radioSelected]}>
                      {isSelected ? <View style={styles.radioDot} /> : null}
                    </View>
                    <View style={styles.choiceCopy}>
                      <Text style={[styles.choiceLabel, isSelected && styles.choiceLabelSelected]}>
                        {choice.label}
                      </Text>
                      {choice.description ? (
                        <Text style={styles.choiceDescription}>{choice.description}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {selected[question.id]?.freeform ? (
              <TextInput
                accessibilityLabel={`${questionTitle} 的其他内容`}
                editable={!busy}
                multiline
                onChangeText={(value) => setFreeform((current) => ({ ...current, [question.id]: value }))}
                placeholder="输入其他选择"
                placeholderTextColor={colors.muted}
                style={styles.noteInput}
                value={freeform[question.id] ?? ''}
              />
            ) : null}
          </View>
        );
      })}

      {(questions.length > 0 || choices.length > 0) ? (
        <TextInput
          accessibilityLabel={`${permission.title} 的补充说明`}
          editable={!busy}
          multiline
          onChangeText={setNote}
          placeholder="补充说明（可选）"
          placeholderTextColor={colors.muted}
          style={styles.noteInput}
          value={note}
        />
      ) : null}

      {questions.length > 0 ? (
        <View style={styles.permissionActions}>
          <Pressable
            accessibilityLabel={`拒绝 ${permission.title}`}
            accessibilityRole="button"
            disabled={busy}
            onPress={() => onRespond('deny')}
            style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryActionText}>拒绝</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`提交 ${permission.title} 的选择`}
            accessibilityRole="button"
            disabled={busy || !canSubmitQuestions}
            onPress={submitQuestions}
            style={({ pressed }) => [
              styles.primaryAction,
              (busy || !canSubmitQuestions) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {busy ? <ActivityIndicator color={colors.surface} size="small" /> : null}
            <Text style={styles.primaryActionText}>{busy ? '提交中' : '提交选择'}</Text>
          </Pressable>
        </View>
      ) : choices.length > 0 ? (
        <View style={styles.choiceActionList}>
          {choices.map((choice) => (
            <Pressable
              accessibilityLabel={`选择 ${permission.title}：${choice.label}`}
              accessibilityRole="button"
              disabled={busy}
              key={choice.id}
              onPress={() => answerChoice(choice)}
              style={({ pressed }) => [styles.choiceAction, pressed && styles.pressed]}
            >
              <Text style={styles.choiceActionText}>{choice.label}</Text>
              {choice.description ? <Text style={styles.choiceActionDescription}>{choice.description}</Text> : null}
            </Pressable>
          ))}
          <Pressable
            accessibilityLabel={`拒绝 ${permission.title}`}
            accessibilityRole="button"
            disabled={busy}
            onPress={() => onRespond('deny')}
            style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryActionText}>拒绝</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.permissionActions}>
          <Pressable
            accessibilityLabel={`拒绝 ${permission.title}`}
            accessibilityRole="button"
            disabled={busy}
            onPress={() => onRespond('deny')}
            style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryActionText}>拒绝</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`批准 ${permission.title}`}
            accessibilityRole="button"
            disabled={busy}
            onPress={() => onRespond('allow')}
            style={({ pressed }) => [styles.primaryAction, pressed && styles.pressed]}
          >
            {busy ? <ActivityIndicator color={colors.surface} size="small" /> : null}
            <Text style={styles.primaryActionText}>{busy ? '提交中' : '批准'}</Text>
          </Pressable>
        </View>
      )}
      {error ? (
        <Text
          accessibilityLabel={`${permission.title} 提交错误`}
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.inlineError}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function SessionDetailScreen({
  api,
  session,
  csrfToken,
  canTerminate,
  onBack,
  onRequestError,
}: {
  api: SessionDetailApi;
  session: NativeSessionSummary;
  csrfToken: string;
  canTerminate: boolean;
  onBack(): void;
  onRequestError?(error: unknown): void;
}) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentJob, setSentJob] = useState<NativeJob | null>(null);
  const [sessionOverride, setSessionOverride] = useState<NativeSessionSummary | null>(null);
  const [showTerminateConfirm, setShowTerminateConfirm] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [terminateError, setTerminateError] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState<Set<string>>(() => new Set());
  const [permissionErrors, setPermissionErrors] = useState<Record<string, string>>({});
  const [resolvedPermissionIds, setResolvedPermissionIds] = useState<Set<string>>(() => new Set());
  const [olderTimeline, setOlderTimeline] = useState<NativeTimelineItem[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const permissionSubmitting = useRef(new Set<string>());
  const listRef = useRef<FlatList<NativeTimelineItem>>(null);

  const loadThread = useCallback(async (): Promise<SessionThreadData> => {
    const [sessionPayload, timelinePayload, permissionPayload, jobsPayload] = await Promise.all([
      api.getSession(session.session_id),
      api.getSessionTimeline(session.session_id),
      api.listPermissions(session.session_id, 'pending'),
      api.listJobs(),
    ]);
    return {
      session: sessionPayload.session,
      timeline: sortedTimeline(timelinePayload.items),
      timelineHasMore: timelinePayload.has_more,
      permissions: permissionPayload.items.filter((permission) => permission.status === 'pending'),
      jobs: jobsPayload.items.filter((job) => job.target_session_id === session.session_id),
    };
  }, [api, session.session_id]);
  const resource = useAsyncResource(loadThread, {
    onError: onRequestError,
    resetKey: session.session_id,
  });
  const data = resource.data;
  const currentSession = sessionOverride ?? data?.session ?? session;
  const recoveredJob = data?.jobs.find((job) => job.kind === 'session_input') ?? null;
  const currentJob = sentJob
    ? data?.jobs.find((job) => job.job_id === sentJob.job_id) ?? sentJob
    : recoveredJob;
  const sendState = sendStateText(currentJob, sending, sendError);
  const timelineItems = useMemo(() => {
    const byKey = new Map<string, NativeTimelineItem>();
    for (const item of [...olderTimeline, ...(data?.timeline ?? [])]) {
      byKey.set(`${item.session_id}:${item.seq}`, item);
    }
    return sortedTimeline([...byKey.values()]);
  }, [data?.timeline, olderTimeline]);
  const hasOlderTimeline = olderHasMore ?? data?.timelineHasMore ?? false;
  const visiblePermissions = (data?.permissions ?? []).filter(
    (permission) => !resolvedPermissionIds.has(permission.permission_id),
  );

  useEffect(() => {
    setOlderTimeline([]);
    setOlderHasMore(null);
    setOlderError(null);
    setResolvedPermissionIds(new Set());
  }, [session.session_id]);

  useEffect(() => {
    if (!sentJob || !data) return;
    const updated = data.jobs.find((job) => job.job_id === sentJob.job_id);
    if (updated && updated.status !== sentJob.status) setSentJob(updated);
  }, [data, sentJob]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  useEffect(() => {
    const active = ['queued', 'running'].includes(currentSession.status) ||
      (currentJob ? ['queued', 'running'].includes(currentJob.status) : false);
    if (!active) return undefined;
    const timer = setInterval(() => void resource.reload(), 3_000);
    return () => clearInterval(timer);
  }, [currentJob?.status, currentSession.status, resource.reload]);

  async function sendReply() {
    const prompt = reply.trim();
    if (!prompt || sending || currentSession.status === 'terminated') return;
    setSending(true);
    setSendError(null);
    try {
      const response = await api.sendSessionInput(
        session.session_id,
        { prompt },
        csrfToken,
      );
      setSentJob(response.job);
      setReply('');
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function respondPermission(
    permission: NativePermission,
    action: NativePermissionAction,
    response: Record<string, unknown> = {},
  ) {
    if (permissionSubmitting.current.has(permission.permission_id)) return;
    permissionSubmitting.current.add(permission.permission_id);
    setPermissionBusy((current) => new Set(current).add(permission.permission_id));
    setPermissionErrors((current) => ({ ...current, [permission.permission_id]: '' }));
    try {
      await api.respondPermission(
        permission.permission_id,
        action,
        response,
        csrfToken,
      );
      setResolvedPermissionIds((current) => new Set(current).add(permission.permission_id));
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setPermissionErrors((current) => ({
        ...current,
        [permission.permission_id]: errorMessage(error),
      }));
    } finally {
      permissionSubmitting.current.delete(permission.permission_id);
      setPermissionBusy((current) => {
        const next = new Set(current);
        next.delete(permission.permission_id);
        return next;
      });
    }
  }

  async function loadOlderTimeline() {
    if (olderLoading || !hasOlderTimeline) return;
    const oldest = timelineItems[0];
    if (!oldest) return;
    setOlderLoading(true);
    setOlderError(null);
    try {
      const payload = await api.getSessionTimeline(session.session_id, {
        beforeCreatedAt: oldest.created_at,
        beforeSeq: oldest.seq,
        limit: 100,
      });
      setOlderTimeline((current) => {
        const byKey = new Map<string, NativeTimelineItem>();
        for (const item of [...payload.items, ...current]) {
          byKey.set(`${item.session_id}:${item.seq}`, item);
        }
        return sortedTimeline([...byKey.values()]);
      });
      setOlderHasMore(payload.has_more);
    } catch (error) {
      onRequestError?.(error);
      setOlderError(errorMessage(error));
    } finally {
      setOlderLoading(false);
    }
  }

  async function terminateSession() {
    if (terminating) return;
    setTerminating(true);
    setTerminateError(null);
    try {
      const response = await api.terminateSession(session.session_id, csrfToken);
      setSessionOverride(response.session);
      setShowTerminateConfirm(false);
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setTerminateError(errorMessage(error));
    } finally {
      setTerminating(false);
    }
  }

  const detailHeader = data ? (
    <View style={styles.detailHeaderContent}>
      {resource.error ? (
        <ResourceErrorBanner
          error={resource.error}
          onRetry={resource.reload}
          retryLabel="重试加载会话详情"
        />
      ) : null}
      <View style={styles.sessionMeta}>
        <View style={styles.metaRow}>
          <View style={styles.backendBadge}>
            <Text style={styles.backendText}>{currentSession.backend}</Text>
          </View>
          <Text style={styles.metaText}>{currentSession.worker_id}</Text>
          <Text style={styles.metaDivider}>·</Text>
          <Text style={styles.statusText}>{sessionStatusLabel(currentSession.status)}</Text>
        </View>
        {currentSession.project_name || currentSession.workspace_root ? (
          <Text numberOfLines={2} style={styles.workspaceText}>
            {[currentSession.project_name, currentSession.workspace_root].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
        <Text style={styles.activityText}>{formatLastActivity(currentSession.last_activity_at)}</Text>
      </View>

      {canTerminate && currentSession.status !== 'terminated' ? (
        <View style={styles.terminateArea}>
          {!showTerminateConfirm ? (
            <Pressable
              accessibilityLabel="终止会话"
              accessibilityRole="button"
              onPress={() => setShowTerminateConfirm(true)}
              style={({ pressed }) => [styles.terminateButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.danger} name="stop-circle-outline" size={18} />
              <Text style={styles.terminateButtonText}>终止会话</Text>
            </Pressable>
          ) : (
            <View style={styles.confirmCard}>
              <Text style={styles.confirmTitle}>确认终止这个会话？</Text>
              <Text style={styles.confirmText}>终止后不能继续发送消息。</Text>
              <View style={styles.confirmActions}>
                <Pressable
                  accessibilityLabel="取消终止会话"
                  accessibilityRole="button"
                  disabled={terminating}
                  onPress={() => setShowTerminateConfirm(false)}
                  style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryActionText}>取消</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="确认终止会话"
                  accessibilityRole="button"
                  disabled={terminating}
                  onPress={() => void terminateSession()}
                  style={({ pressed }) => [styles.dangerAction, pressed && styles.pressed]}
                >
                  {terminating ? <ActivityIndicator color={colors.surface} size="small" /> : null}
                  <Text style={styles.dangerActionText}>{terminating ? '终止中' : '确认终止'}</Text>
                </Pressable>
              </View>
            </View>
          )}
          {terminateError ? (
            <Text
              accessibilityLabel="终止会话错误"
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
              style={styles.inlineError}
            >
              {terminateError}
            </Text>
          ) : null}
        </View>
      ) : null}

      {visiblePermissions.length > 0 ? (
        <View style={styles.permissionSection}>
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>待你处理</Text>
            <View style={styles.countBadge}><Text style={styles.countText}>{visiblePermissions.length}</Text></View>
          </View>
          {visiblePermissions.map((permission) => (
            <PermissionCard
              busy={permissionBusy.has(permission.permission_id)}
              error={permissionErrors[permission.permission_id]}
              key={permission.permission_id}
              onRespond={(action, response) => void respondPermission(permission, action, response)}
              permission={permission}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>消息</Text>
        <Text style={styles.orderText}>最新在下</Text>
      </View>
      {hasOlderTimeline ? (
        <Pressable
          accessibilityLabel="加载更早消息"
          accessibilityRole="button"
          disabled={olderLoading}
          onPress={() => void loadOlderTimeline()}
          style={({ pressed }) => [styles.loadOlderButton, pressed && styles.pressed]}
        >
          {olderLoading ? <ActivityIndicator color={colors.accent} size="small" /> : (
            <Ionicons color={colors.accent} name="time-outline" size={17} />
          )}
          <Text style={styles.loadOlderText}>{olderLoading ? '加载中' : '加载更早消息'}</Text>
        </Pressable>
      ) : null}
      {olderError ? (
        <Text
          accessibilityLabel="加载更早消息错误"
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          style={styles.inlineError}
        >
          {olderError}
        </Text>
      ) : null}
    </View>
  ) : null;

  return (
    <SafeAreaView accessibilityLabel="会话详情安全区域" edges={['top', 'bottom']} style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="返回会话列表"
            accessibilityRole="button"
            onPress={onBack}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Ionicons color={colors.text} name="arrow-back" size={22} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>会话详情</Text>
            <Text numberOfLines={1} style={styles.headerTitle}>{currentSession.title}</Text>
          </View>
          <Pressable
            accessibilityLabel="刷新会话详情"
            accessibilityRole="button"
            disabled={resource.loading || resource.refreshing}
            onPress={() => void resource.reload()}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            {resource.loading || resource.refreshing ? (
              <ActivityIndicator color={colors.accent} size="small" />
            ) : (
              <Ionicons color={colors.accent} name="refresh" size={21} />
            )}
          </Pressable>
        </View>

        {resource.loading || (resource.error !== null && data === null) ? (
          <ResourceState
            empty={false}
            emptyText="暂无消息"
            error={resource.error}
            failureTitle="会话详情加载失败"
            loading={resource.loading}
            loadingText="正在加载会话详情"
            onRetry={resource.reload}
            retryLabel="重试加载会话详情"
          />
        ) : (
          <FlatList
            contentContainerStyle={styles.timelineList}
            data={timelineItems}
            keyExtractor={(item) => `${item.session_id}:${item.seq}`}
            ListEmptyComponent={(
              <View style={styles.emptyTimeline}>
                <Ionicons color={colors.muted} name="chatbubble-ellipses-outline" size={25} />
                <Text style={styles.emptyText}>暂无消息</Text>
              </View>
            )}
            ListHeaderComponent={detailHeader}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            ref={listRef}
            refreshControl={(
              <RefreshControl
                colors={[colors.accent]}
                onRefresh={() => void resource.reload()}
                refreshing={resource.refreshing}
                tintColor={colors.accent}
              />
            )}
            renderItem={({ item }) => (
              <View style={[
                styles.timelineItem,
                item.role === 'user' && styles.timelineItemUser,
                item.item_type === 'error' && styles.timelineItemError,
              ]}>
                <View style={styles.timelineMeta}>
                  <Text style={styles.timelineRole}>{timelineLabel(item)}</Text>
                  <Text style={styles.timelineTime}>{timelineTime(item.created_at)}</Text>
                </View>
                <Text selectable style={styles.timelineText}>{item.text || '暂无内容'}</Text>
                {item.status ? <Text style={styles.timelineStatus}>{item.status}</Text> : null}
              </View>
            )}
          />
        )}

        <View style={styles.composer}>
          {sendState ? (
            <Text
              accessibilityLabel="回复状态"
              accessibilityLiveRegion="polite"
              accessibilityRole={sendState.kind === 'error' ? 'alert' : undefined}
              style={[
              styles.sendState,
              sendState.kind === 'error' && styles.sendStateError,
              sendState.kind === 'success' && styles.sendStateSuccess,
              ]}
            >
              {sendState.text}
            </Text>
          ) : null}
          <View style={styles.composerRow}>
            <TextInput
              accessibilityLabel="回复内容"
              editable={!sending && currentSession.status !== 'terminated'}
              multiline
              onChangeText={(value) => {
                setReply(value);
                if (sendError) setSendError(null);
              }}
              placeholder={currentSession.status === 'terminated' ? '会话已结束' : '输入回复'}
              placeholderTextColor={colors.muted}
              style={styles.replyInput}
              textAlignVertical="top"
              value={reply}
            />
            <Pressable
              accessibilityLabel="发送回复"
              accessibilityRole="button"
              disabled={!reply.trim() || sending || currentSession.status === 'terminated'}
              onPress={() => void sendReply()}
              style={({ pressed }) => [
                styles.sendButton,
                (!reply.trim() || sending || currentSession.status === 'terminated') && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              {sending ? (
                <ActivityIndicator color={colors.surface} size="small" />
              ) : (
                <Ionicons color={colors.surface} name="send" size={20} />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.canvas, flex: 1 },
  keyboardView: { flex: 1 },
  header: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 64,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  headerCopy: { flex: 1, gap: 2 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800' },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  iconButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  timelineList: { paddingBottom: 18, paddingHorizontal: 14 },
  detailHeaderContent: { paddingTop: 14 },
  sessionMeta: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 8,
    padding: 14,
  },
  metaRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  backendBadge: { backgroundColor: colors.surfaceMuted, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  backendText: { color: colors.text, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  metaText: { color: colors.muted, flexShrink: 1, fontSize: 12 },
  metaDivider: { color: colors.border, fontSize: 13 },
  statusText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  workspaceText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  activityText: { color: colors.muted, fontSize: 12 },
  terminateArea: { alignItems: 'flex-start', gap: 8, paddingTop: 10 },
  terminateButton: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 44, paddingHorizontal: 6 },
  terminateButtonText: { color: colors.danger, fontSize: 13, fontWeight: '700' },
  confirmCard: {
    backgroundColor: '#FEF3F2',
    borderColor: '#FECDCA',
    borderRadius: 7,
    borderWidth: 1,
    gap: 7,
    padding: 13,
    width: '100%',
  },
  confirmTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  confirmText: { color: colors.danger, fontSize: 13 },
  confirmActions: { flexDirection: 'row', gap: 9, justifyContent: 'flex-end' },
  permissionSection: { gap: 10, paddingTop: 18 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between', paddingBottom: 9, paddingTop: 18 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  orderText: { color: colors.muted, fontSize: 11 },
  loadOlderButton: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 14,
  },
  loadOlderText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  countBadge: { backgroundColor: colors.surfaceMuted, borderRadius: 10, minWidth: 22, paddingHorizontal: 7, paddingVertical: 3 },
  countText: { color: colors.accent, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  permissionCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  permissionHeading: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  permissionIcon: { alignItems: 'center', backgroundColor: colors.surfaceMuted, borderRadius: 6, height: 34, justifyContent: 'center', width: 34 },
  permissionCopy: { flex: 1, gap: 4 },
  permissionTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  permissionDescription: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  question: { gap: 8 },
  questionTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  questionText: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  choiceList: { gap: 8 },
  choice: {
    alignItems: 'flex-start',
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
    padding: 11,
  },
  choiceSelected: { backgroundColor: '#EEF6FF', borderColor: colors.accent },
  radio: { alignItems: 'center', borderColor: colors.border, borderRadius: 9, borderWidth: 1, height: 18, justifyContent: 'center', marginTop: 1, width: 18 },
  radioSelected: { borderColor: colors.accent },
  radioDot: { backgroundColor: colors.accent, borderRadius: 4, height: 8, width: 8 },
  choiceCopy: { flex: 1, gap: 3 },
  choiceLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  choiceLabelSelected: { color: colors.accent },
  choiceDescription: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  noteInput: {
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    fontSize: 13,
    minHeight: 48,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  permissionActions: { flexDirection: 'row', gap: 9, justifyContent: 'flex-end' },
  primaryAction: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 7, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44, paddingHorizontal: 15 },
  primaryActionText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
  secondaryAction: { alignItems: 'center', borderColor: colors.border, borderRadius: 7, borderWidth: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 15 },
  secondaryActionText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  dangerAction: { alignItems: 'center', backgroundColor: colors.danger, borderRadius: 7, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44, paddingHorizontal: 15 },
  dangerActionText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
  choiceActionList: { gap: 8 },
  choiceAction: { borderColor: colors.accent, borderRadius: 7, borderWidth: 1, gap: 3, justifyContent: 'center', minHeight: 48, paddingHorizontal: 12, paddingVertical: 9 },
  choiceActionText: { color: colors.accent, fontSize: 13, fontWeight: '800' },
  choiceActionDescription: { color: colors.muted, fontSize: 12 },
  inlineError: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  timelineItem: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    gap: 7,
    marginBottom: 9,
    padding: 13,
  },
  timelineItemUser: { backgroundColor: '#EEF6FF', borderColor: '#BFDBFE' },
  timelineItemError: { backgroundColor: '#FEF3F2', borderColor: '#FECDCA' },
  timelineMeta: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  timelineRole: { color: colors.text, fontSize: 12, fontWeight: '800' },
  timelineTime: { color: colors.muted, fontSize: 11 },
  timelineText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  timelineStatus: { color: colors.muted, fontSize: 11 },
  emptyTimeline: { alignItems: 'center', gap: 7, paddingBottom: 40, paddingTop: 34 },
  emptyText: { color: colors.muted, fontSize: 13 },
  composer: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 7,
    paddingBottom: 10,
    paddingHorizontal: 12,
    paddingTop: 9,
  },
  composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 9 },
  replyInput: {
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 132,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  sendButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 7, height: 48, justifyContent: 'center', width: 48 },
  sendState: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  sendStateError: { color: colors.danger },
  sendStateSuccess: { color: colors.success },
  pressed: { opacity: 0.68 },
  disabled: { opacity: 0.45 },
});
