import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
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
import { pickSessionImage, type NativePendingImage } from './nativeImagePicker';
import { useNativeVoiceRecorder } from './useNativeVoiceRecorder';

type SessionDetailApi = Pick<
  MobileApi,
  | 'getSession'
  | 'getSessionTimeline'
  | 'listJobs'
  | 'listPermissions'
  | 'respondPermission'
  | 'sendSessionInput'
  | 'transcribeVoice'
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

function recordingDuration(durationMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
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

function isMarkdownText(value: string) {
  const text = value.trim();
  if (!text) return false;
  return /(^#\s)|(^[-*]\s)|(^\d+\.\s)|(```)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)/m.test(text);
}

function toolSummary(item: NativeTimelineItem) {
  if (typeof item.payload?.summary === 'string' && item.payload.summary.trim()) return item.payload.summary.trim();
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  return '工具执行完成';
}

function toolOutput(item: NativeTimelineItem) {
  if (typeof item.payload?.output === 'string' && item.payload.output.trim()) return item.payload.output.trim();
  if (typeof item.payload?.result === 'string' && item.payload.result.trim()) return item.payload.result.trim();
  return '';
}

function extractLocalPaths(text: string): string[] {
  const matches = text.match(/[A-Za-z]:[\\/][^\s)\]]+/g) ?? [];
  const normalized = matches.map((value) => value.replace(/\\/g, '/').replace(/[)>.,]+$/g, ''));
  return [...new Set(normalized)];
}

function itemKey(item: NativeTimelineItem): string {
  return `${item.session_id}:${item.seq}`;
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
  onOpenFile,
  onRequestError,
}: {
  api: SessionDetailApi;
  session: NativeSessionSummary;
  csrfToken: string;
  canTerminate: boolean;
  onBack(): void;
  onOpenFile?(sessionId: string, path: string): void;
  onRequestError?(error: unknown): void;
}) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<NativePendingImage[]>([]);
  const [transcribing, setTranscribing] = useState(false);
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
  const [replyMode, setReplyMode] = useState<'direct' | 'plan'>('direct');
  const [readerItem, setReaderItem] = useState<NativeTimelineItem | null>(null);
  const [readerTab, setReaderTab] = useState<'text' | 'markdown'>('text');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());
  const [expandedToolItems, setExpandedToolItems] = useState<Set<string>>(() => new Set());
  const permissionSubmitting = useRef(new Set<string>());
  const listRef = useRef<FlatList<NativeTimelineItem>>(null);
  const lastTimelineKey = useRef<string | null>(null);
  const voiceRecorder = useNativeVoiceRecorder();

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
    setReplyMode('direct');
    setReaderItem(null);
    setExpandedItems(new Set());
    setExpandedToolItems(new Set());
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

  useEffect(() => {
    if (timelineItems.length === 0) return;
    const latest = timelineItems[timelineItems.length - 1];
    if (!latest) return;
    const latestKey = `${latest.session_id}:${latest.seq}:${latest.created_at}`;
    if (lastTimelineKey.current === latestKey) return;
    lastTimelineKey.current = latestKey;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  }, [timelineItems]);

  async function sendReply() {
    const prompt = reply.trim();
    if ((!prompt && attachments.length === 0) || sending || currentSession.status === 'terminated') return;
    setSending(true);
    setSendError(null);
    try {
      const response = await api.sendSessionInput(
        session.session_id,
        {
          prompt,
          reply_mode: replyMode,
          ...(attachments.length > 0
            ? {
                attachments: attachments.map(({ filename, content_type, data_base64 }) => ({
                  filename,
                  content_type,
                  data_base64,
                })),
              }
            : {}),
        },
        csrfToken,
      );
      setSentJob(response.job);
      setReply('');
      setAttachments([]);
      setReplyMode('direct');
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  async function addImage() {
    if (attachments.length >= 5) {
      setSendError('一次最多添加 5 张图片');
      return;
    }
    try {
      const image = await pickSessionImage();
      if (!image) return;
      setAttachments((current) => [...current, image]);
      setSendError(null);
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    }
  }

  async function toggleVoiceRecording() {
    if (transcribing || sending || currentSession.status === 'terminated') return;
    setSendError(null);
    try {
      if (!voiceRecorder.isRecording) {
        await voiceRecorder.startRecording();
        return;
      }
      setTranscribing(true);
      const recording = await voiceRecorder.stopRecording();
      if (!recording) throw new Error('没有录到有效声音');
      const result = await api.transcribeVoice(
        { ...recording, language: 'zh-CN' },
        csrfToken,
      );
      const text = result.text.trim();
      if (!text) throw new Error('没有识别到文字');
      setReply((current) => current ? `${current}${current.endsWith('\n') ? '' : '\n'}${text}` : text);
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    } finally {
      setTranscribing(false);
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

  function openReader(item: NativeTimelineItem) {
    const text = item.text || '';
    setReaderItem(item);
    setReaderTab(isMarkdownText(text) ? 'markdown' : 'text');
  }

  async function copyTimelineText(text: string) {
    if (!text.trim()) return;
    try {
      await Clipboard.setStringAsync(text);
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    }
  }

  function renderTimelineItem(item: NativeTimelineItem) {
    const isTool = item.item_type === 'tool_call';
    const text = item.text || '';
    const supportsMarkdown = !isTool && isMarkdownText(text);
    const canOpenReader = Boolean(text.trim()) && (text.length > 120 || supportsMarkdown);
    const canExpandInline = !isTool && text.trim().length > 120;
    const expanded = expandedItems.has(itemKey(item));
    const toolExpanded = expandedToolItems.has(itemKey(item));
    const output = isTool ? toolOutput(item) : '';
    const fileLinks = !isTool ? extractLocalPaths(text) : [];
    return (
      <View style={[
        styles.timelineItem,
        item.role === 'user' && styles.timelineItemUser,
        item.item_type === 'error' && styles.timelineItemError,
      ]}>
        <View style={styles.timelineMeta}>
          <Text style={styles.timelineRole}>{timelineLabel(item)}</Text>
          <Text style={styles.timelineTime}>{timelineTime(item.created_at)}</Text>
        </View>
        {isTool ? (
          <View style={styles.toolCard}>
            <Text style={styles.toolName}>{item.tool_name || 'tool_call'}</Text>
            <Text numberOfLines={toolExpanded ? undefined : 2} selectable style={styles.timelineText}>{toolSummary(item)}</Text>
            {toolExpanded && output ? (
              <Text selectable style={styles.toolOutput}>{output}</Text>
            ) : null}
          </View>
        ) : (
          <Text numberOfLines={canExpandInline && !expanded ? 6 : undefined} selectable style={styles.timelineText}>
            {text || '暂无内容'}
          </Text>
        )}
        {fileLinks.length > 0 ? (
          <View style={styles.fileLinkRow}>
            {fileLinks.slice(0, 3).map((path) => (
              <Pressable
                accessibilityLabel={`打开文件 ${path.split('/').pop() || path}`}
                accessibilityRole="button"
                key={path}
                onPress={() => onOpenFile?.(session.session_id, path)}
                style={({ pressed }) => [styles.fileLinkButton, pressed && styles.pressed]}
              >
                <Ionicons color={colors.accent} name="document-text-outline" size={15} />
                <Text numberOfLines={1} style={styles.fileLinkText}>{path.split('/').pop() || path}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.timelineActions}>
          {isTool && output ? (
            <Pressable
              accessibilityLabel={toolExpanded ? '收起工具输出' : '查看工具输出'}
              accessibilityRole="button"
              onPress={() => setExpandedToolItems((current) => {
                const next = new Set(current);
                if (toolExpanded) next.delete(itemKey(item));
                else next.add(itemKey(item));
                return next;
              })}
              style={({ pressed }) => [styles.readerButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name={toolExpanded ? 'chevron-up-outline' : 'code-slash-outline'} size={15} />
              <Text style={styles.readerButtonText}>{toolExpanded ? '收起工具输出' : '查看工具输出'}</Text>
            </Pressable>
          ) : null}
          {canExpandInline ? (
            <Pressable
              accessibilityLabel={expanded ? '收起全文' : '展开全文'}
              accessibilityRole="button"
              onPress={() => setExpandedItems((current) => {
                const next = new Set(current);
                if (expanded) next.delete(itemKey(item));
                else next.add(itemKey(item));
                return next;
              })}
              style={({ pressed }) => [styles.readerButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name={expanded ? 'chevron-up-outline' : 'chevron-down-outline'} size={15} />
              <Text style={styles.readerButtonText}>{expanded ? '收起' : '展开全文'}</Text>
            </Pressable>
          ) : null}
          {!isTool && text.trim() ? (
            <Pressable
              accessibilityLabel="复制全文"
              accessibilityRole="button"
              onPress={() => void copyTimelineText(text)}
              style={({ pressed }) => [styles.readerButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name="copy-outline" size={15} />
              <Text style={styles.readerButtonText}>复制全文</Text>
            </Pressable>
          ) : null}
          {canOpenReader ? (
            <Pressable
              accessibilityLabel="全文阅读"
              accessibilityRole="button"
              onPress={() => openReader(item)}
              style={({ pressed }) => [styles.readerButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name="expand-outline" size={15} />
              <Text style={styles.readerButtonText}>全文阅读</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.timelineFooter}>
          {item.status ? <Text style={styles.timelineStatus}>{item.status}</Text> : <View />}
        </View>
      </View>
    );
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
            ref={listRef}
            refreshControl={(
              <RefreshControl
                colors={[colors.accent]}
                onRefresh={() => void resource.reload()}
                refreshing={resource.refreshing}
                tintColor={colors.accent}
              />
            )}
            renderItem={({ item }) => renderTimelineItem(item)}
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
          {attachments.length > 0 ? (
            <View accessibilityLabel="待发送图片" style={styles.attachmentRow}>
              {attachments.map((attachment, index) => (
                <View key={`${attachment.filename}-${index}`} style={styles.attachmentChip}>
                  <Image source={{ uri: attachment.preview_uri }} style={styles.attachmentImage} />
                  <Text numberOfLines={1} style={styles.attachmentName}>{attachment.filename}</Text>
                  <Pressable
                    accessibilityLabel={`移除图片 ${attachment.filename}`}
                    accessibilityRole="button"
                    onPress={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    style={styles.attachmentRemove}
                  >
                    <Ionicons color={colors.muted} name="close" size={16} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {voiceRecorder.isRecording ? (
            <View accessibilityLiveRegion="polite" style={styles.recordingState}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>
                录音中 {recordingDuration(voiceRecorder.durationMillis)} · 点击停止并识别
              </Text>
            </View>
          ) : null}
          <View style={styles.modeRow}>
            <Pressable
              accessibilityLabel="切换到直接模式"
              accessibilityRole="button"
              accessibilityState={{ selected: replyMode === 'direct' }}
              onPress={() => setReplyMode('direct')}
              style={({ pressed }) => [
                styles.modeButton,
                replyMode === 'direct' && styles.modeButtonSelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.modeButtonText, replyMode === 'direct' && styles.modeButtonTextSelected]}>直接</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="切换到计划模式"
              accessibilityRole="button"
              accessibilityState={{ selected: replyMode === 'plan' }}
              onPress={() => setReplyMode('plan')}
              style={({ pressed }) => [
                styles.modeButton,
                replyMode === 'plan' && styles.modeButtonSelected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.modeButtonText, replyMode === 'plan' && styles.modeButtonTextSelected]}>计划</Text>
            </Pressable>
            {(['继续', 'Implement the plan', '不对，重新来'] as const).map((quickReply) => (
              <Pressable
                accessibilityLabel={`快捷回复 ${quickReply}`}
                accessibilityRole="button"
                key={quickReply}
                onPress={() => {
                  setReply(quickReply);
                  setSendError(null);
                }}
                style={({ pressed }) => [styles.quickReplyButton, pressed && styles.pressed]}
              >
                <Text style={styles.quickReplyText}>{quickReply}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.composerRow}>
            <Pressable
              accessibilityLabel="添加图片"
              accessibilityRole="button"
              disabled={sending || currentSession.status === 'terminated'}
              onPress={() => void addImage()}
              style={({ pressed }) => [styles.attachButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name="image-outline" size={21} />
            </Pressable>
            <Pressable
              accessibilityLabel={voiceRecorder.isRecording ? '停止录音并识别' : '开始语音输入'}
              accessibilityRole="button"
              disabled={transcribing || sending || currentSession.status === 'terminated'}
              onPress={() => void toggleVoiceRecording()}
              style={({ pressed }) => [
                styles.attachButton,
                voiceRecorder.isRecording && styles.recordingButton,
                pressed && styles.pressed,
              ]}
            >
              {transcribing ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <Ionicons
                  color={voiceRecorder.isRecording ? colors.surface : colors.accent}
                  name={voiceRecorder.isRecording ? 'stop' : 'mic-outline'}
                  size={21}
                />
              )}
            </Pressable>
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
              disabled={(!reply.trim() && attachments.length === 0) || sending || currentSession.status === 'terminated'}
              onPress={() => void sendReply()}
              style={({ pressed }) => [
                styles.sendButton,
                ((!reply.trim() && attachments.length === 0) || sending || currentSession.status === 'terminated') && styles.disabled,
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
        <Modal
          animationType="slide"
          onRequestClose={() => setReaderItem(null)}
          transparent
          visible={Boolean(readerItem)}
        >
          <View style={styles.readerBackdrop}>
            <View style={styles.readerSheet}>
              <View style={styles.readerHeader}>
                <Text style={styles.readerTitle}>全文阅读</Text>
                <Pressable
                  accessibilityLabel="关闭全文阅读"
                  accessibilityRole="button"
                  onPress={() => setReaderItem(null)}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                >
                  <Ionicons color={colors.text} name="close" size={20} />
                </Pressable>
              </View>
              <View style={styles.readerTabs}>
                <Pressable
                  accessibilityLabel="原文"
                  accessibilityRole="button"
                  onPress={() => setReaderTab('text')}
                  style={({ pressed }) => [
                    styles.readerTab,
                    readerTab === 'text' && styles.readerTabSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.readerTabText, readerTab === 'text' && styles.readerTabTextSelected]}>原文</Text>
                </Pressable>
                {readerItem && isMarkdownText(readerItem.text || '') ? (
                  <Pressable
                    accessibilityLabel="Markdown"
                    accessibilityRole="button"
                    onPress={() => setReaderTab('markdown')}
                    style={({ pressed }) => [
                      styles.readerTab,
                      readerTab === 'markdown' && styles.readerTabSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.readerTabText, readerTab === 'markdown' && styles.readerTabTextSelected]}>Markdown</Text>
                  </Pressable>
                ) : null}
              </View>
              <ScrollView contentContainerStyle={styles.readerScroll}>
                <Text selectable style={styles.readerBody}>{readerItem?.text || ''}</Text>
              </ScrollView>
            </View>
          </View>
        </Modal>
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
  timelineActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  timelineFooter: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 20 },
  toolCard: { gap: 6 },
  toolName: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  toolOutput: {
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.muted,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    padding: 10,
  },
  fileLinkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fileLinkButton: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 12,
  },
  fileLinkText: { color: colors.accent, fontSize: 12, fontWeight: '700', maxWidth: 180 },
  readerButton: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 32 },
  readerButtonText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
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
  attachmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  attachmentChip: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    maxWidth: 190,
    padding: 5,
  },
  attachmentImage: { borderRadius: 4, height: 32, width: 32 },
  attachmentName: { color: colors.text, flexShrink: 1, fontSize: 12, fontWeight: '600' },
  attachmentRemove: { alignItems: 'center', height: 28, justifyContent: 'center', width: 28 },
  recordingState: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 24 },
  recordingDot: { backgroundColor: colors.danger, borderRadius: 4, height: 8, width: 8 },
  recordingText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 14,
  },
  modeButtonSelected: { backgroundColor: '#EEF6FF', borderColor: colors.accent },
  modeButtonText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  modeButtonTextSelected: { color: colors.accent },
  quickReplyButton: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 12,
  },
  quickReplyText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 9 },
  attachButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  recordingButton: { backgroundColor: colors.danger, borderColor: colors.danger },
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
  readerBackdrop: {
    backgroundColor: 'rgba(11, 18, 32, 0.42)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  readerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '86%',
    paddingBottom: 18,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  readerHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  readerTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  readerTabs: { flexDirection: 'row', gap: 8, paddingBottom: 12, paddingTop: 14 },
  readerTab: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 38,
    paddingHorizontal: 16,
  },
  readerTabSelected: { backgroundColor: '#EEF6FF', borderColor: colors.accent },
  readerTabText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  readerTabTextSelected: { color: colors.accent },
  readerScroll: { paddingBottom: 28 },
  readerBody: { color: colors.text, fontSize: 15, lineHeight: 24 },
  pressed: { opacity: 0.68 },
  disabled: { opacity: 0.45 },
});
