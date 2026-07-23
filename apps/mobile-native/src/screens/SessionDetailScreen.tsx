import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  LayoutChangeEvent,
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
  NativeJob,
  NativePermission,
  NativePermissionAction,
  NativeProviderSnapshot,
  NativeSessionControls,
  NativeSessionSummary,
  NativeTimelineItem,
} from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { formatLastActivity, parseApiDate, sessionActivityAt, sessionStatusLabel } from './resourcePresentation';
import {
  buildQuestionResponse,
  permissionChoices,
  permissionQuestions,
  sortedTimeline,
  timelineAttachments,
  type NativePermissionChoice,
} from './sessionDetailPresentation';
import { pickSessionImage, type NativePendingImage } from './nativeImagePicker';
import { pickSessionFile, type NativePendingFile } from './nativeSessionFilePicker';
import { RichMarkdown } from './RichMarkdown';
import { useNativeVoiceRecorder } from './useNativeVoiceRecorder';

type SessionDetailApi = Pick<
  MobileApi,
  | 'askSessionBtw'
  | 'archiveSession'
  | 'forkSession'
  | 'getSession'
  | 'getSessionTimeline'
  | 'listJobs'
  | 'listPermissions'
  | 'listProviderSnapshots'
  | 'respondPermission'
  | 'renameSession'
  | 'sendSessionInput'
  | 'transcribeVoice'
  | 'terminateSession'
  | 'unarchiveSession'
  | 'updateSessionControls'
>;

type SessionActionKind = 'rename' | 'fork' | 'btw' | 'archive' | 'unarchive' | null;

interface SessionThreadData {
  session: NativeSessionSummary;
  timeline: NativeTimelineItem[];
  timelineHasMore: boolean;
  permissions: NativePermission[];
  jobs: NativeJob[];
}

interface SessionControlsDraft {
  model: string;
  sandbox_mode: string;
  approval_mode: string;
  permission_mode: string;
  interaction_bridge: string;
  yolo: boolean;
  thinking: string;
  agent: string;
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

const MIN_COMPOSER_CLEARANCE = 116;
const TIMELINE_BOTTOM_GUTTER = 18;

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
  const date = parseApiDate(value);
  if (!date) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function timelineItemStatusLabel(status: string | null | undefined): string | null {
  switch (status?.trim().toLowerCase()) {
    case 'queued':
      return '排队中';
    case 'running':
      return '运行中';
    case 'needs_reply':
      return '待回复';
    case 'failed':
    case 'error':
      return '失败';
    case 'cancelled':
    case 'canceled':
      return '已取消';
    default:
      return null;
  }
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

function timelineSearchContent(item: NativeTimelineItem): string {
  let payloadText = '';
  try {
    payloadText = JSON.stringify(item.payload ?? {});
  } catch {
    payloadText = '';
  }
  return [item.text, item.tool_name, toolSummary(item), toolOutput(item), payloadText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function extractLocalPaths(text: string): string[] {
  const windowsMatches = text.match(/[A-Za-z]:[\\/][^\s)\]]+/g) ?? [];
  const posixMatches = [...text.matchAll(/(?:^|[\s([{'\"：])(\/(?!\/)[^\s)\]}>，。；,]+)/g)]
    .map((match) => match[1] ?? '');
  const normalized = [...windowsMatches, ...posixMatches]
    .map((value) => value.replace(/\\/g, '/').replace(/[)>，。；,;]+$/g, ''));
  return [...new Set(normalized)];
}

function attachmentSize(sizeBytes: number | null) {
  if (sizeBytes === null || sizeBytes < 0) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isWorkerLocalPath(value: string) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/');
}

function normalizeWorkerPath(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/').trim();
  return normalized || null;
}

function itemKey(item: NativeTimelineItem): string {
  return `${item.session_id}:${item.seq}`;
}

function valueFromControls(controls: NativeSessionControls | undefined, key: keyof NativeSessionControls) {
  const value = controls?.[key];
  return typeof value === 'string' ? value : '';
}

function controlsDraftFromSession(session: NativeSessionSummary): SessionControlsDraft {
  const controls = session.controls;
  return {
    model: valueFromControls(controls, 'model'),
    sandbox_mode: valueFromControls(controls, 'sandbox_mode'),
    approval_mode: valueFromControls(controls, 'approval_mode'),
    permission_mode: valueFromControls(controls, 'permission_mode'),
    interaction_bridge: valueFromControls(controls, 'interaction_bridge'),
    yolo: controls?.yolo === true,
    thinking: typeof controls?.thinking === 'boolean' ? String(controls.thinking) : '',
    agent: valueFromControls(controls, 'agent'),
  };
}

function modeOptions(provider: NativeProviderSnapshot | null, kind: string, fallback: string[]) {
  const fromProvider = (provider?.modes ?? [])
    .filter((mode) => mode.kind === kind)
    .map((mode) => String(mode.id ?? ''))
    .filter(Boolean);
  return fromProvider.length > 0 ? fromProvider : fallback;
}

function modelOptions(provider: NativeProviderSnapshot | null) {
  return (provider?.models ?? [])
    .map((model) => {
      const id = [model.id, model.name].find((value) => typeof value === 'string' && value.trim());
      const label = [model.label, model.name, model.id].find((value) => typeof value === 'string' && value.trim());
      if (!id || !label) return null;
      return { id: String(id), label: String(label) };
    })
    .filter((value): value is { id: string; label: string } => Boolean(value));
}

function controlsSummary(session: NativeSessionSummary) {
  const controls = controlsDraftFromSession(session);
  const parts = [
    controls.model || 'default model',
    controls.sandbox_mode || 'default sandbox',
    controls.permission_mode || controls.approval_mode || 'default permission',
  ];
  return parts.join(' / ');
}

function buildControlsPayload(draft: SessionControlsDraft, backend: string): NativeSessionControls {
  const payload: NativeSessionControls = {};
  if (draft.model) payload.model = draft.model;
  if (draft.sandbox_mode) payload.sandbox_mode = draft.sandbox_mode;
  if (backend.toLowerCase() !== 'claude' && draft.approval_mode) payload.approval_mode = draft.approval_mode;
  if (draft.permission_mode) payload.permission_mode = draft.permission_mode;
  if (draft.interaction_bridge) payload.interaction_bridge = draft.interaction_bridge;
  if (draft.agent) payload.agent = draft.agent;
  if (draft.yolo) payload.yolo = true;
  if (draft.thinking === 'true') payload.thinking = true;
  if (draft.thinking === 'false') payload.thinking = false;
  return payload;
}

function PermissionCard({
  permission,
  busy,
  error,
  focused = false,
  onRespond,
}: {
  permission: NativePermission;
  busy: boolean;
  error?: string;
  focused?: boolean;
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
    <View
      accessibilityLabel={`${focused ? '通知定位：' : '待处理：'}${permission.title}`}
      style={[styles.permissionCard, focused && styles.permissionCardFocused]}
    >
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
  canOperate = true,
  canTerminate,
  quickReplies = ['继续', 'Implement the plan', '不对，重新来'],
  voiceLanguage = 'zh-CN',
  onBack,
  onOpenFile,
  onRequestError,
  focusedPermissionId = null,
  onFocusedPermissionHandled,
}: {
  api: SessionDetailApi;
  session: NativeSessionSummary;
  csrfToken: string;
  canOperate?: boolean;
  canTerminate: boolean;
  quickReplies?: string[];
  voiceLanguage?: string;
  onBack(): void;
  onOpenFile?(sessionId: string, path: string): void;
  onRequestError?(error: unknown): void;
  focusedPermissionId?: string | null;
  onFocusedPermissionHandled?(permissionId: string): void;
}) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Array<NativePendingImage | NativePendingFile>>([]);
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
  const [composerHeight, setComposerHeight] = useState(MIN_COMPOSER_CLEARANCE);
  const [replyMode, setReplyMode] = useState<'direct' | 'plan'>('direct');
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [attachmentPickerVisible, setAttachmentPickerVisible] = useState(false);
  const [readerContent, setReaderContent] = useState<{ title: string; text: string; markdown: boolean } | null>(null);
  const [readerTab, setReaderTab] = useState<'text' | 'markdown'>('text');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());
  const [expandedToolItems, setExpandedToolItems] = useState<Set<string>>(() => new Set());
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [sessionAction, setSessionAction] = useState<SessionActionKind>(null);
  const [sessionActionTitle, setSessionActionTitle] = useState('');
  const [sessionActionPrompt, setSessionActionPrompt] = useState('');
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [sessionActionNotice, setSessionActionNotice] = useState<string | null>(null);
  const [controlsDraft, setControlsDraft] = useState<SessionControlsDraft>(() => controlsDraftFromSession(session));
  const [controlsBusy, setControlsBusy] = useState(false);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [providerSnapshot, setProviderSnapshot] = useState<NativeProviderSnapshot | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');
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
  const replyDisabledReason = !canOperate
    ? '当前账户只有查看权限'
    : currentSession.archived_at
      ? '会话已归档，恢复后才能回复'
      : currentSession.status === 'terminated'
        ? '会话已结束，不能继续发送消息'
        : null;
  const replyDisabled = Boolean(replyDisabledReason);
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
  const normalizedMessageQuery = messageQuery.trim().toLowerCase();
  const visibleTimelineItems = useMemo(() => {
    if (!normalizedMessageQuery) return timelineItems;
    return timelineItems.filter((item) => timelineSearchContent(item).includes(normalizedMessageQuery));
  }, [normalizedMessageQuery, timelineItems]);
  const hasOlderTimeline = olderHasMore ?? data?.timelineHasMore ?? false;
  const visiblePermissions = useMemo(() => {
    const pending = (data?.permissions ?? []).filter(
      (permission) => !resolvedPermissionIds.has(permission.permission_id),
    );
    if (!focusedPermissionId) return pending;
    return [...pending].sort((left, right) => {
      if (left.permission_id === focusedPermissionId) return -1;
      if (right.permission_id === focusedPermissionId) return 1;
      return 0;
    });
  }, [data?.permissions, focusedPermissionId, resolvedPermissionIds]);

  useEffect(() => {
    setOlderTimeline([]);
    setOlderHasMore(null);
    setOlderError(null);
    setResolvedPermissionIds(new Set());
    setReplyMode('direct');
    setReaderContent(null);
    setAttachmentPickerVisible(false);
    setExpandedItems(new Set());
    setExpandedToolItems(new Set());
    setActionSheetVisible(false);
    setSessionAction(null);
    setSessionActionError(null);
    setControlsDraft(controlsDraftFromSession(session));
    setControlsError(null);
    setMessageSearchOpen(false);
    setMessageQuery('');
  }, [session.session_id]);

  useEffect(() => {
    if (!sentJob || !data) return;
    const updated = data.jobs.find((job) => job.job_id === sentJob.job_id);
    if (updated && updated.status !== sentJob.status) setSentJob(updated);
  }, [data, sentJob]);

  useEffect(() => {
    setControlsDraft(controlsDraftFromSession(currentSession));
  }, [currentSession]);

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
    const timer = setInterval(() => void resource.reload(), active ? 3_000 : 15_000);
    return () => clearInterval(timer);
  }, [currentJob?.status, currentSession.status, resource.reload]);

  useEffect(() => {
    if (timelineItems.length === 0) return;
    if (focusedPermissionId || messageSearchOpen || normalizedMessageQuery) return;
    const latest = timelineItems[timelineItems.length - 1];
    if (!latest) return;
    const latestKey = `${latest.session_id}:${latest.seq}:${latest.created_at}`;
    if (lastTimelineKey.current === latestKey) return;
    lastTimelineKey.current = latestKey;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  }, [focusedPermissionId, messageSearchOpen, normalizedMessageQuery, timelineItems]);

  useEffect(() => {
    if (!focusedPermissionId) return;
    const permission = visiblePermissions.find((item) => item.permission_id === focusedPermissionId);
    if (!permission) return;
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ animated: false, offset: 0 }));
    onFocusedPermissionHandled?.(focusedPermissionId);
  }, [focusedPermissionId, onFocusedPermissionHandled, visiblePermissions]);

  async function sendReply() {
    const prompt = reply.trim();
    if ((!prompt && attachments.length === 0) || sending || replyDisabled) return;
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
      setSendError('一次最多添加 5 个附件');
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
    if (transcribing || sending || replyDisabled) return;
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
        { ...recording, language: voiceLanguage },
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
    setReaderContent({ title: '全文阅读', text, markdown: isMarkdownText(text) });
    setReaderTab(isMarkdownText(text) ? 'markdown' : 'text');
  }

  function openToolReader(output: string) {
    setReaderContent({ title: '工具输出', text: output, markdown: false });
    setReaderTab('text');
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

  function openSessionAction(action: SessionActionKind) {
    setSessionAction(action);
    setSessionActionTitle(action === 'rename' ? currentSession.title : '');
    setSessionActionPrompt('');
    setSessionActionError(null);
  }

  function closeSessionActions() {
    if (sessionActionBusy || controlsBusy) return;
    setActionSheetVisible(false);
    setSessionAction(null);
    setSessionActionError(null);
  }

  async function loadProviderSnapshot() {
    setProviderLoading(true);
    setControlsError(null);
    try {
      const payload = await api.listProviderSnapshots();
      const matched = payload.items.find((item) => (
        item.worker_id === currentSession.worker_id && item.backend.toLowerCase() === currentSession.backend.toLowerCase()
      )) ?? null;
      setProviderSnapshot(matched);
    } catch (error) {
      onRequestError?.(error);
      setControlsError(errorMessage(error));
    } finally {
      setProviderLoading(false);
    }
  }

  async function saveControls() {
    if (controlsBusy) return;
    setControlsBusy(true);
    setControlsError(null);
    try {
      const response = await api.updateSessionControls(
        session.session_id,
        buildControlsPayload(controlsDraft, currentSession.backend),
        csrfToken,
      );
      setSessionOverride(response.session);
      setSessionActionNotice('运行控制已更新');
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setControlsError(errorMessage(error));
    } finally {
      setControlsBusy(false);
    }
  }

  async function submitSessionAction() {
    if (!sessionAction || sessionActionBusy) return;
    const prompt = sessionActionPrompt.trim();
    const title = sessionActionTitle.trim();
    if ((sessionAction === 'fork' || sessionAction === 'btw') && !prompt) {
      setSessionActionError('请填写要继续处理的问题');
      return;
    }
    if (sessionAction === 'rename' && !title) {
      setSessionActionError('会话名称不能为空');
      return;
    }
    setSessionActionBusy(true);
    setSessionActionError(null);
    try {
      if (sessionAction === 'rename') {
        const response = await api.renameSession(session.session_id, title, csrfToken);
        setSessionOverride(response.session);
        setSessionActionNotice('会话名称已更新');
      } else if (sessionAction === 'fork') {
        await api.forkSession(session.session_id, {
          prompt,
          ...(title ? { title } : {}),
        }, csrfToken);
        setSessionActionNotice('Fork 请求已排队');
      } else if (sessionAction === 'btw') {
        await api.askSessionBtw(session.session_id, {
          prompt,
          ...(title ? { title } : {}),
        }, csrfToken);
        setSessionActionNotice('BTW 提问已排队，不会打断当前会话');
      } else if (sessionAction === 'archive') {
        const response = await api.archiveSession(session.session_id, csrfToken);
        setSessionOverride(response.session);
        setSessionActionNotice('会话已归档');
      } else {
        const response = await api.unarchiveSession(session.session_id, csrfToken);
        setSessionOverride(response.session);
        setSessionActionNotice('会话已恢复到收件箱');
      }
      setActionSheetVisible(false);
      setSessionAction(null);
      await resource.reload();
    } catch (error) {
      onRequestError?.(error);
      setSessionActionError(errorMessage(error));
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function openMarkdownLink(value: string) {
    if (isWorkerLocalPath(value)) {
      onOpenFile?.(session.session_id, value.replace(/\\/g, '/'));
      return;
    }
    try {
      const supported = await Linking.canOpenURL(value);
      if (!supported) throw new Error('当前设备无法打开这个链接');
      await Linking.openURL(value);
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    }
  }

  async function openTimelineAttachment(path: string | null | undefined, url: string | null | undefined) {
    const normalizedPath = normalizeWorkerPath(path);
    if (normalizedPath) {
      onOpenFile?.(session.session_id, normalizedPath);
      return;
    }
    if (!url) return;
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) throw new Error('当前设备无法打开这个附件链接');
      await Linking.openURL(url);
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    }
  }

  async function addFile() {
    if (attachments.length >= 5) {
      setSendError('一次最多添加 5 个附件');
      return;
    }
    try {
      const file = await pickSessionFile();
      if (!file) return;
      setAttachments((current) => [...current, file]);
      setSendError(null);
    } catch (error) {
      onRequestError?.(error);
      setSendError(errorMessage(error));
    }
  }

  function handleComposerLayout(event: LayoutChangeEvent) {
    const nextHeight = Math.max(
      MIN_COMPOSER_CLEARANCE,
      Math.ceil(event.nativeEvent.layout.height),
    );
    setComposerHeight((current) => (current === nextHeight ? current : nextHeight));
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
    const canOpenToolReader = isTool && output.length > 120;
    const fileLinks = !isTool ? extractLocalPaths(text) : [];
    const persistedAttachments = timelineAttachments(item);
    const inlineMarkdown = canExpandInline && !expanded && text.length > 1_200
      ? `${text.slice(0, 1_200)}…`
      : text;
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
        ) : supportsMarkdown ? (
          <RichMarkdown onLinkPress={(url) => void openMarkdownLink(url)} value={inlineMarkdown || '暂无内容'} />
        ) : (
          <Text numberOfLines={canExpandInline && !expanded ? 6 : undefined} selectable style={styles.timelineText}>
            {text || '暂无内容'}
          </Text>
        )}
        {persistedAttachments.length > 0 ? (
          <View accessibilityLabel={`附件 ${persistedAttachments.length}`} style={styles.persistedAttachmentGroup}>
            <Text style={styles.persistedAttachmentTitle}>附件 {persistedAttachments.length}</Text>
            <View style={styles.persistedAttachmentRow}>
              {persistedAttachments.map((attachment, index) => (
                <Pressable
                  accessibilityLabel={`附件 ${attachment.filename}`}
                  accessibilityRole={attachment.path || attachment.url ? 'button' : undefined}
                  disabled={!attachment.path && !attachment.url}
                  key={`${attachment.filename}-${index}`}
                  onPress={() => void openTimelineAttachment(attachment.path, attachment.url)}
                  style={({ pressed }) => [
                    styles.persistedAttachmentChip,
                    pressed && (attachment.path || attachment.url) ? styles.pressed : null,
                  ]}
                >
                  <Ionicons color={colors.accent} name={attachment.content_type.startsWith('image/') ? 'image-outline' : 'document-text-outline'} size={15} />
                  <View style={styles.persistedAttachmentCopy}>
                    <Text numberOfLines={1} style={styles.persistedAttachmentName}>{attachment.filename}</Text>
                    <Text numberOfLines={1} style={styles.persistedAttachmentMeta}>
                      {[attachment.content_type, attachmentSize(attachment.size_bytes)].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  {attachment.path || attachment.url ? (
                    <Ionicons color={colors.muted} name="chevron-forward" size={14} />
                  ) : null}
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
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
          {canOpenToolReader ? (
            <Pressable
              accessibilityLabel="全文阅读工具输出"
              accessibilityRole="button"
              onPress={() => openToolReader(output)}
              style={({ pressed }) => [styles.readerButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name="expand-outline" size={15} />
              <Text style={styles.readerButtonText}>全文阅读</Text>
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
        {timelineItemStatusLabel(item.status) ? (
          <View style={styles.timelineFooter}>
            <Text style={styles.timelineStatus}>{timelineItemStatusLabel(item.status)}</Text>
          </View>
        ) : null}
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
        <Text style={styles.activityText}>{formatLastActivity(sessionActivityAt(currentSession))}</Text>
      </View>
      {sessionActionNotice ? (
        <View style={styles.sessionActionNotice}>
          <Ionicons color={colors.success} name="checkmark-circle-outline" size={16} />
          <Text style={styles.sessionActionNoticeText}>{sessionActionNotice}</Text>
        </View>
      ) : null}

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
              focused={permission.permission_id === focusedPermissionId}
              key={permission.permission_id}
              onRespond={(action, response) => void respondPermission(permission, action, response)}
              permission={permission}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>消息</Text>
        <View style={styles.messageHeadingActions}>
          <Text accessibilityLiveRegion="polite" style={styles.orderText}>
            {normalizedMessageQuery ? `${visibleTimelineItems.length} 条匹配` : '最新在下'}
          </Text>
          <Pressable
            accessibilityLabel={messageSearchOpen ? '关闭消息搜索' : '搜索会话消息'}
            accessibilityRole="button"
            onPress={() => {
              setMessageSearchOpen((current) => {
                if (current) setMessageQuery('');
                return !current;
              });
            }}
            style={({ pressed }) => [styles.messageSearchButton, pressed && styles.pressed]}
          >
            <Ionicons color={colors.accent} name={messageSearchOpen ? 'close' : 'search'} size={18} />
          </Pressable>
        </View>
      </View>
      {messageSearchOpen ? (
        <View style={styles.messageSearchRow}>
          <Ionicons color={colors.muted} name="search" size={18} />
          <TextInput
            accessibilityLabel="消息搜索关键词"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setMessageQuery}
            placeholder="搜索当前已加载消息"
            placeholderTextColor={colors.muted}
            returnKeyType="search"
            style={styles.messageSearchInput}
            value={messageQuery}
          />
          {messageQuery ? (
            <Pressable
              accessibilityLabel="清空消息搜索"
              accessibilityRole="button"
              onPress={() => setMessageQuery('')}
              style={({ pressed }) => [styles.messageSearchClear, pressed && styles.pressed]}
            >
              <Ionicons color={colors.muted} name="close-circle" size={19} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
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
          {canOperate ? (
            <Pressable
              accessibilityLabel="打开会话操作"
              accessibilityRole="button"
              onPress={() => {
                setSessionAction(null);
                setSessionActionError(null);
                void loadProviderSnapshot();
                setActionSheetVisible(true);
              }}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name="ellipsis-horizontal" size={22} />
            </Pressable>
          ) : null}
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
            accessibilityLabel="会话消息列表"
            contentContainerStyle={[
              styles.timelineList,
              { paddingBottom: composerHeight + TIMELINE_BOTTOM_GUTTER },
            ]}
            data={visibleTimelineItems}
            keyExtractor={(item) => `${item.session_id}:${item.seq}`}
            ListEmptyComponent={(
              <View style={styles.emptyTimeline}>
                <Ionicons color={colors.muted} name="chatbubble-ellipses-outline" size={25} />
                <Text style={styles.emptyText}>{normalizedMessageQuery ? '没有匹配的消息' : '暂无消息'}</Text>
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

        <View onLayout={handleComposerLayout} style={styles.composer}>
          {replyDisabledReason ? (
            <View accessibilityLabel="回复不可用原因" style={styles.replyDisabledNotice}>
              <Ionicons color={colors.muted} name="information-circle-outline" size={16} />
              <Text style={styles.replyDisabledText}>{replyDisabledReason}</Text>
            </View>
          ) : null}
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
            <View accessibilityLabel="待发送附件" style={styles.attachmentRow}>
              {attachments.map((attachment, index) => (
                <View key={`${attachment.filename}-${index}`} style={styles.attachmentChip}>
                  {attachment.content_type.startsWith('image/') ? (
                    <Image source={{ uri: attachment.preview_uri }} style={styles.attachmentImage} />
                  ) : (
                    <View style={styles.attachmentFileIcon}>
                      <Ionicons color={colors.accent} name="document-text-outline" size={18} />
                    </View>
                  )}
                  <View style={styles.attachmentCopy}>
                    <Text numberOfLines={1} style={styles.attachmentName}>{attachment.filename}</Text>
                    <Text numberOfLines={1} style={styles.attachmentMeta}>{attachment.content_type}</Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`移除附件 ${attachment.filename}`}
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
          <Pressable
            accessibilityLabel={composerOptionsOpen ? '收起回复选项' : '展开回复选项'}
            accessibilityRole="button"
            onPress={() => setComposerOptionsOpen((open) => !open)}
            style={({ pressed }) => [styles.composerOptionsToggle, pressed && styles.pressed]}
          >
            <Ionicons color={colors.accent} name="options-outline" size={16} />
            <Text style={styles.composerOptionsText}>{replyMode === 'plan' ? '计划模式' : '直接模式'}</Text>
            {quickReplies.length > 0 ? <Text style={styles.composerOptionsMeta}>快捷回复 {quickReplies.length}</Text> : null}
            <Ionicons color={colors.muted} name={composerOptionsOpen ? 'chevron-up' : 'chevron-down'} size={15} />
          </Pressable>
          {composerOptionsOpen ? (
            <ScrollView
              contentContainerStyle={styles.modeRow}
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
            >
              <Pressable
                accessibilityLabel="切换到直接模式"
                accessibilityRole="button"
                accessibilityState={{ selected: replyMode === 'direct' }}
                disabled={replyDisabled}
                onPress={() => setReplyMode('direct')}
                style={({ pressed }) => [
                  styles.modeButton,
                  replyMode === 'direct' && styles.modeButtonSelected,
                  replyDisabled && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.modeButtonText, replyMode === 'direct' && styles.modeButtonTextSelected]}>直接</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="切换到计划模式"
                accessibilityRole="button"
                accessibilityState={{ selected: replyMode === 'plan' }}
                disabled={replyDisabled}
                onPress={() => setReplyMode('plan')}
                style={({ pressed }) => [
                  styles.modeButton,
                  replyMode === 'plan' && styles.modeButtonSelected,
                  replyDisabled && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.modeButtonText, replyMode === 'plan' && styles.modeButtonTextSelected]}>计划</Text>
              </Pressable>
              {quickReplies.map((quickReply) => (
                <Pressable
                  accessibilityLabel={`快捷回复 ${quickReply}`}
                  accessibilityRole="button"
                  disabled={replyDisabled}
                  key={quickReply}
                  onPress={() => {
                    setReply(quickReply);
                    setSendError(null);
                    setComposerOptionsOpen(false);
                  }}
                  style={({ pressed }) => [styles.quickReplyButton, replyDisabled && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.quickReplyText}>{quickReply}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.composerRow}>
            <Pressable
              accessibilityLabel="添加附件"
              accessibilityRole="button"
              disabled={sending || replyDisabled}
              onPress={() => setAttachmentPickerVisible(true)}
              style={({ pressed }) => [styles.attachButton, replyDisabled && styles.disabled, pressed && styles.pressed]}
            >
              <Ionicons color={colors.accent} name="attach-outline" size={21} />
            </Pressable>
            <Pressable
              accessibilityLabel={voiceRecorder.isRecording ? '停止录音并识别' : '开始语音输入'}
              accessibilityRole="button"
              disabled={transcribing || sending || replyDisabled}
              onPress={() => void toggleVoiceRecording()}
              style={({ pressed }) => [
                styles.attachButton,
                voiceRecorder.isRecording && styles.recordingButton,
                replyDisabled && styles.disabled,
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
              editable={!sending && !replyDisabled}
              multiline
              onChangeText={(value) => {
                setReply(value);
                if (sendError) setSendError(null);
              }}
              placeholder={replyDisabledReason || '输入回复'}
              placeholderTextColor={colors.muted}
              style={styles.replyInput}
              textAlignVertical="top"
              value={reply}
            />
            <Pressable
              accessibilityLabel="发送回复"
              accessibilityRole="button"
              disabled={(!reply.trim() && attachments.length === 0) || sending || replyDisabled}
              onPress={() => void sendReply()}
              style={({ pressed }) => [
                styles.sendButton,
                ((!reply.trim() && attachments.length === 0) || sending || replyDisabled) && styles.disabled,
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
          animationType="fade"
          onRequestClose={() => setAttachmentPickerVisible(false)}
          transparent
          visible={attachmentPickerVisible}
        >
          <Pressable
            accessibilityLabel="关闭添加附件"
            accessibilityRole="button"
            onPress={() => setAttachmentPickerVisible(false)}
            style={styles.attachmentPickerBackdrop}
          >
            <Pressable
              accessibilityLabel="附件类型"
              accessibilityRole="none"
              onPress={(event) => event.stopPropagation()}
              style={styles.attachmentPickerSheet}
            >
              <Text style={styles.attachmentPickerTitle}>添加附件</Text>
              <Text style={styles.attachmentPickerHint}>图片、文档和压缩包均会随本次消息发送</Text>
              <Pressable
                accessibilityLabel="选择图片附件"
                accessibilityRole="button"
                onPress={() => {
                  setAttachmentPickerVisible(false);
                  void addImage();
                }}
                style={({ pressed }) => [styles.attachmentPickerAction, pressed && styles.pressed]}
              >
                <Ionicons color={colors.accent} name="image-outline" size={20} />
                <View style={styles.attachmentPickerCopy}>
                  <Text style={styles.attachmentPickerActionTitle}>选择图片</Text>
                  <Text style={styles.attachmentPickerActionHint}>拍摄或从相册选择</Text>
                </View>
              </Pressable>
              <Pressable
                accessibilityLabel="选择文件附件"
                accessibilityRole="button"
                onPress={() => {
                  setAttachmentPickerVisible(false);
                  void addFile();
                }}
                style={({ pressed }) => [styles.attachmentPickerAction, pressed && styles.pressed]}
              >
                <Ionicons color={colors.accent} name="document-attach-outline" size={20} />
                <View style={styles.attachmentPickerCopy}>
                  <Text style={styles.attachmentPickerActionTitle}>选择文件</Text>
                  <Text style={styles.attachmentPickerActionHint}>支持文本、PDF、压缩包等，单个不超过 8 MB</Text>
                </View>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
        <Modal
          animationType="slide"
          onRequestClose={closeSessionActions}
          transparent
          visible={actionSheetVisible}
        >
          <View style={styles.sessionActionBackdrop}>
            <SafeAreaView edges={['bottom']} style={styles.sessionActionSheet}>
              <View style={styles.sessionActionHeader}>
                <View style={styles.sessionActionHeaderCopy}>
                  <Text style={styles.eyebrow}>SESSION ACTIONS</Text>
                  <Text style={styles.sessionActionTitle}>{sessionAction ? actionTitle(sessionAction) : '会话操作'}</Text>
                </View>
                <Pressable
                  accessibilityLabel="关闭会话操作"
                  accessibilityRole="button"
                  disabled={sessionActionBusy}
                  onPress={closeSessionActions}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                >
                  <Ionicons color={colors.text} name="close" size={20} />
                </Pressable>
              </View>
              {sessionActionError ? <Text accessibilityRole="alert" style={styles.sessionActionError}>{sessionActionError}</Text> : null}
              {controlsError && sessionAction === null ? <Text accessibilityRole="alert" style={styles.sessionActionError}>{controlsError}</Text> : null}
              {sessionAction === null ? (
                <ScrollView contentContainerStyle={styles.sessionActionOverview} keyboardShouldPersistTaps="handled">
                  <View style={styles.sessionActionList}>
                    <SessionActionButton accessibilityLabel="重命名会话" icon="pencil-outline" label="重命名" onPress={() => openSessionAction('rename')} />
                    <SessionActionButton accessibilityLabel="Fork 会话" icon="git-branch-outline" label="Fork 会话" onPress={() => openSessionAction('fork')} />
                    <SessionActionButton accessibilityLabel="BTW 提问" icon="chatbubble-ellipses-outline" label="BTW 单次提问" onPress={() => openSessionAction('btw')} />
                    {currentSession.archived_at ? (
                      <SessionActionButton accessibilityLabel="恢复会话" icon="archive-outline" label="恢复到收件箱" onPress={() => openSessionAction('unarchive')} />
                    ) : (
                      <SessionActionButton accessibilityLabel="归档会话" icon="archive-outline" label="归档会话" onPress={() => openSessionAction('archive')} />
                    )}
                  </View>
                  <View style={styles.controlsSection}>
                    <View style={styles.sectionHeading}>
                      <Text style={styles.sectionTitle}>运行控制</Text>
                      {providerLoading ? <ActivityIndicator color={colors.accent} size="small" /> : null}
                    </View>
                    <Text style={styles.controlsHint}>当前 {controlsSummary(currentSession)}</Text>
                    {modelOptions(providerSnapshot).length > 0 ? (
                      <ControlChoiceGroup
                        options={modelOptions(providerSnapshot).map((option) => ({ label: option.label, value: option.id }))}
                        selectedValue={controlsDraft.model}
                        title="模型"
                        onSelect={(value) => setControlsDraft((current) => ({ ...current, model: value }))}
                      />
                    ) : null}
                    <ControlChoiceGroup
                      options={modeOptions(providerSnapshot, 'sandbox_mode', ['read-only', 'workspace-write', 'danger-full-access']).map((value) => ({ label: value, value }))}
                      selectedValue={controlsDraft.sandbox_mode}
                      title="沙箱"
                      onSelect={(value) => setControlsDraft((current) => ({ ...current, sandbox_mode: value }))}
                    />
                    {currentSession.backend.toLowerCase() !== 'claude' ? (
                      <ControlChoiceGroup
                        options={modeOptions(providerSnapshot, 'approval_mode', ['never', 'on-request', 'on-failure', 'untrusted']).map((value) => ({ label: value, value }))}
                        selectedValue={controlsDraft.approval_mode}
                        title="审批"
                        onSelect={(value) => setControlsDraft((current) => ({ ...current, approval_mode: value }))}
                      />
                    ) : null}
                    <ControlChoiceGroup
                      options={modeOptions(providerSnapshot, 'permission_mode', ['default', 'auto', 'plan', 'dontAsk', 'bypassPermissions']).map((value) => ({ label: value, value }))}
                      selectedValue={controlsDraft.permission_mode}
                      title="权限策略"
                      onSelect={(value) => setControlsDraft((current) => ({ ...current, permission_mode: value }))}
                    />
                    <ControlChoiceGroup
                      options={modeOptions(providerSnapshot, 'interaction_bridge', ['compatibility', 'tmux', 'psmux']).map((value) => ({ label: value, value }))}
                      selectedValue={controlsDraft.interaction_bridge}
                      title="交互桥"
                      onSelect={(value) => setControlsDraft((current) => ({ ...current, interaction_bridge: value }))}
                    />
                    <ControlChoiceGroup
                      options={[
                        { label: 'auto', value: '' },
                        { label: 'thinking on', value: 'true' },
                        { label: 'thinking off', value: 'false' },
                      ]}
                      selectedValue={controlsDraft.thinking}
                      title="思考"
                      onSelect={(value) => setControlsDraft((current) => ({ ...current, thinking: value }))}
                    />
                    <Text style={styles.controlLabel}>Agent</Text>
                    <TextInput
                      accessibilityLabel="Agent 名称"
                      onChangeText={(value) => setControlsDraft((current) => ({ ...current, agent: value }))}
                      placeholder="可选，例如 coder / planner"
                      placeholderTextColor={colors.muted}
                      style={styles.sessionActionInput}
                      value={controlsDraft.agent}
                    />
                    <Pressable
                      accessibilityLabel="切换 Yolo"
                      accessibilityRole="switch"
                      accessibilityState={{ checked: controlsDraft.yolo }}
                      onPress={() => setControlsDraft((current) => ({ ...current, yolo: !current.yolo }))}
                      style={({ pressed }) => [styles.toggleRow, pressed && styles.pressed]}
                    >
                      <View>
                        <Text style={styles.toggleTitle}>Yolo</Text>
                        <Text style={styles.toggleHint}>开启后会优先使用宽权限运行。</Text>
                      </View>
                      <View style={[styles.toggleBadge, controlsDraft.yolo && styles.toggleBadgeSelected]}>
                        <Text style={[styles.toggleBadgeText, controlsDraft.yolo && styles.toggleBadgeTextSelected]}>
                          {controlsDraft.yolo ? '已开启' : '关闭'}
                        </Text>
                      </View>
                    </Pressable>
                    <View style={styles.sessionActionFooter}>
                      <Pressable
                        accessibilityLabel="重置运行控制"
                        accessibilityRole="button"
                        disabled={controlsBusy}
                        onPress={() => {
                          setControlsDraft(controlsDraftFromSession(currentSession));
                          setControlsError(null);
                        }}
                        style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
                      >
                        <Text style={styles.secondaryActionText}>重置</Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel="保存运行控制"
                        accessibilityRole="button"
                        disabled={controlsBusy}
                        onPress={() => void saveControls()}
                        style={({ pressed }) => [styles.primaryAction, pressed && styles.pressed, controlsBusy && styles.disabled]}
                      >
                        {controlsBusy ? <ActivityIndicator color={colors.surface} size="small" /> : null}
                        <Text style={styles.primaryActionText}>{controlsBusy ? '保存中' : '保存运行控制'}</Text>
                      </Pressable>
                    </View>
                  </View>
                </ScrollView>
              ) : (
                <ScrollView contentContainerStyle={styles.sessionActionForm} keyboardShouldPersistTaps="handled">
                  {sessionAction === 'rename' ? (
                    <>
                      <Text style={styles.sessionActionHint}>只修改列表显示名称，不会改变底层 runtime session。</Text>
                      <TextInput
                        accessibilityLabel="会话名称"
                        onChangeText={setSessionActionTitle}
                        placeholder="会话名称"
                        placeholderTextColor={colors.muted}
                        style={styles.sessionActionInput}
                        value={sessionActionTitle}
                      />
                    </>
                  ) : sessionAction === 'fork' || sessionAction === 'btw' ? (
                    <>
                      <Text style={styles.sessionActionHint}>{sessionAction === 'fork' ? '基于当前会话上下文创建新的分支会话。' : '基于当前上下文做一次旁路提问，不会向原会话写入消息。'}</Text>
                      <TextInput
                        accessibilityLabel={sessionAction === 'fork' ? 'Fork 标题' : 'BTW 标题'}
                        onChangeText={setSessionActionTitle}
                        placeholder="标题（可选）"
                        placeholderTextColor={colors.muted}
                        style={styles.sessionActionInput}
                        value={sessionActionTitle}
                      />
                      <TextInput
                        accessibilityLabel={sessionAction === 'fork' ? 'Fork 提示词' : 'BTW 提示词'}
                        multiline
                        onChangeText={setSessionActionPrompt}
                        placeholder={sessionAction === 'fork' ? '说明分支会话要继续做什么' : '写下不打断当前工作的单次问题'}
                        placeholderTextColor={colors.muted}
                        style={[styles.sessionActionInput, styles.sessionActionPrompt]}
                        textAlignVertical="top"
                        value={sessionActionPrompt}
                      />
                    </>
                  ) : (
                    <Text style={styles.sessionActionHint}>{sessionAction === 'archive' ? '归档后会从默认收件箱隐藏，历史和文件仍保留。' : '恢复后会重新出现在默认收件箱。'}</Text>
                  )}
                  <View style={styles.sessionActionFooter}>
                    <Pressable
                      accessibilityLabel="返回会话操作"
                      accessibilityRole="button"
                      disabled={sessionActionBusy}
                      onPress={() => {
                        setSessionAction(null);
                        setSessionActionError(null);
                      }}
                      style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
                    >
                      <Text style={styles.secondaryActionText}>返回</Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={submitActionLabel(sessionAction)}
                      accessibilityRole="button"
                      disabled={sessionActionBusy}
                      onPress={() => void submitSessionAction()}
                      style={({ pressed }) => [styles.primaryAction, pressed && styles.pressed, sessionActionBusy && styles.disabled]}
                    >
                      {sessionActionBusy ? <ActivityIndicator color={colors.surface} size="small" /> : null}
                      <Text style={styles.primaryActionText}>{sessionActionBusy ? '提交中' : submitActionText(sessionAction)}</Text>
                    </Pressable>
                  </View>
                </ScrollView>
              )}
            </SafeAreaView>
          </View>
        </Modal>
        <Modal
          animationType="slide"
          onRequestClose={() => setReaderContent(null)}
          transparent
          visible={Boolean(readerContent)}
        >
          <View style={styles.readerBackdrop}>
            <View style={styles.readerSheet}>
              <View style={styles.readerHeader}>
                <Text style={styles.readerTitle}>{readerContent?.title || '全文阅读'}</Text>
                <View style={styles.readerHeaderActions}>
                  <Pressable
                    accessibilityLabel="复制阅读内容"
                    accessibilityRole="button"
                    onPress={() => void copyTimelineText(readerContent?.text || '')}
                    style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                  >
                    <Ionicons color={colors.text} name="copy-outline" size={19} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel="关闭全文阅读"
                    accessibilityRole="button"
                    onPress={() => setReaderContent(null)}
                    style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                  >
                    <Ionicons color={colors.text} name="close" size={20} />
                  </Pressable>
                </View>
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
                {readerContent?.markdown ? (
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
                {readerTab === 'markdown' && readerContent?.markdown ? (
                  <RichMarkdown onLinkPress={(url) => void openMarkdownLink(url)} value={readerContent.text} />
                ) : (
                  <Text selectable style={styles.readerBody}>{readerContent?.text || ''}</Text>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function SessionActionButton({
  accessibilityLabel,
  icon,
  label,
  onPress,
}: {
  accessibilityLabel: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.sessionActionButton, pressed && styles.pressed]}
    >
      <Ionicons color={colors.accent} name={icon} size={20} />
      <Text style={styles.sessionActionButtonText}>{label}</Text>
      <Ionicons color={colors.muted} name="chevron-forward" size={18} />
    </Pressable>
  );
}

function ControlChoiceGroup({
  title,
  options,
  selectedValue,
  onSelect,
}: {
  title: string;
  options: Array<{ label: string; value: string }>;
  selectedValue: string;
  onSelect(value: string): void;
}) {
  return (
    <View style={styles.controlGroup}>
      <Text style={styles.controlLabel}>{title}</Text>
      <View style={styles.controlChoices}>
        <ControlChoiceChip
          label="default"
          selected={selectedValue === ''}
          accessibilityLabel={`选择${title} default`}
          onPress={() => onSelect('')}
        />
        {options.map((option) => (
          <ControlChoiceChip
            key={`${title}-${option.value}`}
            label={option.label}
            selected={selectedValue === option.value}
            accessibilityLabel={`选择${title} ${option.label}`}
            onPress={() => onSelect(option.value)}
          />
        ))}
      </View>
    </View>
  );
}

function ControlChoiceChip({
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
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.controlChip, selected && styles.controlChipSelected, pressed && styles.pressed]}
    >
      <Text style={[styles.controlChipText, selected && styles.controlChipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function actionTitle(action: Exclude<SessionActionKind, null>): string {
  if (action === 'rename') return '重命名会话';
  if (action === 'fork') return 'Fork 会话';
  if (action === 'btw') return 'BTW 单次提问';
  if (action === 'archive') return '归档会话';
  return '恢复会话';
}

function submitActionText(action: Exclude<SessionActionKind, null>): string {
  if (action === 'rename') return '保存名称';
  if (action === 'fork') return '提交 Fork';
  if (action === 'btw') return '提交 BTW';
  if (action === 'archive') return '确认归档';
  return '确认恢复';
}

function submitActionLabel(action: Exclude<SessionActionKind, null>): string {
  if (action === 'rename') return '保存会话名称';
  if (action === 'fork') return '提交 Fork';
  if (action === 'btw') return '提交 BTW';
  if (action === 'archive') return '确认归档会话';
  return '确认恢复会话';
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
  timelineList: { paddingHorizontal: 14 },
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
  sessionActionNotice: { alignItems: 'center', flexDirection: 'row', gap: 7, paddingHorizontal: 4, paddingTop: 10 },
  sessionActionNoticeText: { color: colors.success, fontSize: 13, fontWeight: '700' },
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
  sessionActionBackdrop: { backgroundColor: 'rgba(15, 23, 42, 0.48)', flex: 1, justifyContent: 'flex-end' },
  sessionActionSheet: { backgroundColor: colors.canvas, borderTopLeftRadius: 14, borderTopRightRadius: 14, maxHeight: '80%' },
  sessionActionHeader: { alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: 'row', gap: 12, padding: 16 },
  sessionActionHeaderCopy: { flex: 1, gap: 3 },
  sessionActionTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  sessionActionError: { backgroundColor: '#FEF3F2', color: colors.danger, fontSize: 13, lineHeight: 19, marginHorizontal: 16, marginTop: 14, padding: 10 },
  sessionActionList: { padding: 16 },
  sessionActionButton: { alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: 'row', gap: 12, minHeight: 58, paddingHorizontal: 4 },
  sessionActionButtonText: { color: colors.text, flex: 1, fontSize: 15, fontWeight: '700' },
  sessionActionOverview: { gap: 14, paddingBottom: 20 },
  sessionActionForm: { gap: 12, padding: 16 },
  sessionActionHint: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  sessionActionInput: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 7, borderWidth: 1, color: colors.text, fontSize: 14, minHeight: 44, paddingHorizontal: 12 },
  sessionActionPrompt: { minHeight: 118, paddingTop: 11 },
  sessionActionFooter: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', paddingTop: 6 },
  controlsSection: { gap: 12, paddingHorizontal: 16 },
  controlsHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  controlGroup: { gap: 8 },
  controlLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  controlChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  controlChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 34,
    paddingHorizontal: 12,
  },
  controlChipSelected: { backgroundColor: '#EEF6FF', borderColor: colors.accent },
  controlChipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  controlChipTextSelected: { color: colors.accent },
  toggleRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  toggleTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  toggleHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 2 },
  toggleBadge: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 30,
    minWidth: 64,
    paddingHorizontal: 12,
  },
  toggleBadgeSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleBadgeText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  toggleBadgeTextSelected: { color: colors.surface },
  permissionSection: { gap: 10, paddingTop: 18 },
  sectionHeading: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between', paddingBottom: 9, paddingTop: 18 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  orderText: { color: colors.muted, fontSize: 11 },
  messageHeadingActions: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  messageSearchButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  messageSearchRow: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 12,
  },
  messageSearchInput: { color: colors.text, flex: 1, fontSize: 15, minHeight: 44, paddingVertical: 10 },
  messageSearchClear: { alignItems: 'center', height: 34, justifyContent: 'center', width: 34 },
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
  persistedAttachmentGroup: { gap: 6 },
  persistedAttachmentTitle: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  persistedAttachmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  persistedAttachmentChip: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    maxWidth: 240,
    minHeight: 42,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  permissionCardFocused: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.accent,
    borderWidth: 2,
  },
  persistedAttachmentCopy: { flexShrink: 1, gap: 1 },
  persistedAttachmentName: { color: colors.text, flexShrink: 1, fontSize: 12, fontWeight: '700' },
  persistedAttachmentMeta: { color: colors.muted, fontSize: 10 },
  readerButton: { alignItems: 'center', flexDirection: 'row', gap: 4, minHeight: 32 },
  readerButtonText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  emptyTimeline: { alignItems: 'center', gap: 7, paddingBottom: 40, paddingTop: 34 },
  emptyText: { color: colors.muted, fontSize: 13 },
  composer: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 6,
    paddingBottom: 8,
    paddingHorizontal: 10,
    paddingTop: 7,
  },
  replyDisabledNotice: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 6,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  replyDisabledText: { color: colors.muted, flex: 1, fontSize: 12, lineHeight: 17 },
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
  attachmentFileIcon: { alignItems: 'center', backgroundColor: colors.surfaceMuted, borderRadius: 4, height: 32, justifyContent: 'center', width: 32 },
  attachmentCopy: { flexShrink: 1, gap: 1 },
  attachmentName: { color: colors.text, flexShrink: 1, fontSize: 12, fontWeight: '600' },
  attachmentMeta: { color: colors.muted, fontSize: 10 },
  attachmentRemove: { alignItems: 'center', height: 28, justifyContent: 'center', width: 28 },
  recordingState: { alignItems: 'center', flexDirection: 'row', gap: 7, minHeight: 24 },
  recordingDot: { backgroundColor: colors.danger, borderRadius: 4, height: 8, width: 8 },
  recordingText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  composerOptionsToggle: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 6,
    minHeight: 28,
    paddingHorizontal: 2,
  },
  composerOptionsText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  composerOptionsMeta: { color: colors.muted, fontSize: 11 },
  modeRow: { flexDirection: 'row', gap: 7, paddingRight: 12 },
  modeButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: 12,
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
    minHeight: 32,
    paddingHorizontal: 11,
  },
  quickReplyText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  composerRow: { alignItems: 'flex-end', flexDirection: 'row', gap: 7 },
  attachButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
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
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  sendButton: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 7, height: 44, justifyContent: 'center', width: 44 },
  sendState: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  sendStateError: { color: colors.danger },
  sendStateSuccess: { color: colors.success },
  attachmentPickerBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(11, 18, 32, 0.42)',
    flex: 1,
    justifyContent: 'flex-end',
    padding: 16,
  },
  attachmentPickerSheet: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    maxWidth: 520,
    padding: 16,
    width: '100%',
  },
  attachmentPickerTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  attachmentPickerHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 3 },
  attachmentPickerAction: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 11,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  attachmentPickerCopy: { flex: 1, gap: 2 },
  attachmentPickerActionTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  attachmentPickerActionHint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
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
  readerHeaderActions: { alignItems: 'center', flexDirection: 'row', gap: 6 },
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
