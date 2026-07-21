import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  Bell,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  FileText,
  Folder,
  Image as ImageIcon,
  GitFork,
  Lock,
  LogIn,
  LogOut,
  Menu,
  MessageCircle,
  Mic,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Moon,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Shield,
  SlidersHorizontal,
  Smartphone,
  Square,
  Sun,
  TerminalSquare,
  X,
  UserCircle,
  Users,
} from 'lucide-react';
import { ChangeEvent, ClipboardEvent, FocusEvent, FormEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { App as CapacitorApp } from '@capacitor/app';
import type {
  AgentArtifact,
  AgentPermission,
  AgentSession,
  AgentTask,
  AgentTaskExecution,
  AgentTimelineItem,
  ConnectionMode,
  Event,
  Job,
  NotificationRecord,
  ProviderSnapshot,
  Role,
  Schedule,
  User,
  Worker,
} from '@agenthub/protocol';
import { apiGet, apiPatch, apiPost, apiPutRaw } from './api';
import {
  listenForNativeNotificationActions,
  notifyNativePendingPermission,
  notifyNativeStatus,
  requestNativeNotificationPermission,
} from './nativeNotifications';
import { startStreamingVoice, type StreamingVoiceController, type VoiceStreamAuthPayload } from './voiceStreaming';
import { RuntimeCockpit } from './RuntimeCockpitView';
import { projectRuntimeCockpit } from './runtimeCockpit';
import {
  formatRelativeTime,
  isLocaleCode,
  localeLabel,
  pickLocale,
  statusText,
  t,
  themeModeLabel,
  voiceLanguageLabel,
  voiceModeLabel,
  type LocaleCode,
} from './i18n';
import {
  buildSandboxedSrcDoc,
  detectMessageRenderKind,
  renderMarkdownPreview,
  sanitizeHtmlPreview,
  sanitizeRunnableHtml,
  type MessageRenderKind,
} from './messageRenderPreview';

type LoadState = 'loading' | 'ready' | 'login' | 'error';
type MobilePane = 'sessions' | 'thread' | 'controls' | 'files' | 'workers' | 'me';
type WorkspaceView = 'explorer' | 'preview';
type ProviderFilter = 'all' | 'codex' | 'claude' | 'kimi' | 'opencode';
type InspectorMode = 'overview' | 'controls';
type SessionArchiveView = 'active' | 'archived';
type TimelineFilter = 'focus' | 'all' | 'messages' | 'tools' | 'events';
type ReplyMode = 'direct' | 'plan';
type FastModeState = 'enabled' | 'disabled' | 'unknown' | 'unavailable';
type PermissionAction = 'allow' | 'deny' | 'answer';
type NotificationState = NotificationPermission | 'unsupported';
type LaunchMode = 'none' | 'start' | 'fork';
type AppMode = 'cockpit' | 'session' | 'workbench';
type NativeMicrophoneState = 'granted' | 'denied' | 'unavailable';
type ApkUpdateStatus = 'idle' | 'checking' | 'ready' | 'failed';
type ThemeMode = 'dark' | 'light';
type VoiceMode = 'streaming' | 'standard';
type VoiceInputMode = 'standard' | 'streaming';
type VoiceInteractionMode = 'dictation' | 'assistant';
type InviteRole = Extract<Role, 'admin' | 'operator' | 'viewer'>;
type CapacitorBackButtonEvent = { canGoBack?: boolean };
type TaskReviewAction = 'accept' | 'reject' | 'archive' | 'restore' | 'request_changes';
type TaskTemplateKey = 'fix_bug' | 'implement_feature' | 'code_review' | 'release_assistant';
type TaskAuthorityPreset = 'read_only' | 'code_fix' | 'feature' | 'review_only';
type TaskInboxFilter = 'all' | 'ready' | 'working' | 'blocked';
type TaskDetail = {
  task: AgentTask;
  artifacts: AgentArtifact[];
  executions: AgentTaskExecution[];
};

const mobilePanes = ['sessions', 'thread', 'controls', 'files', 'workers', 'me'] as const;
const MAX_VOICE_AUDIO_BYTES = 12 * 1024 * 1024;
const RAW_NATIVE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
const PROCESSED_BROWSER_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const AGENTHUB_TRUNCATION_MARKER = '[AgentHub truncated this item]';
const ANDROID_DOWNLOAD_CHANNELS = {
  webview: {
    path: '/downloads/agenthub-android-release.apk',
    filename: 'agenthub-android-release.apk',
    installMode: 'update',
  },
  native: {
    path: '/downloads/agenthub-native-android-release.apk',
    filename: 'agenthub-native-android-release.apk',
    installMode: 'side-by-side',
  },
} as const;
type AndroidDownloadChannelKey = keyof typeof ANDROID_DOWNLOAD_CHANNELS;
const THEME_STORAGE_KEY = 'agenthub.theme';
const APP_MODE_STORAGE_KEY = 'agenthub.appMode';
const LOCALE_STORAGE_KEY = 'agenthub.locale';
const VOICE_INPUT_MODE_STORAGE_KEY = 'agenthub.voiceInputMode';
const VOICE_INTERACTION_MODE_STORAGE_KEY = 'agenthub.voiceInteractionMode';
const NOTIFICATION_READ_STORAGE_KEY = 'agenthub.notifications.read';
const NOTIFICATION_DELIVERED_STORAGE_KEY = 'agenthub.notifications.delivered';
const MOBILE_HISTORY_STATE = 'agenthub-mobile';
const MAX_FILE_EDITOR_CHARS = 1_000_000;
const MAX_REMEMBERED_NOTIFICATION_IDS = 500;
const TASK_TEMPLATES: Array<{
  key: TaskTemplateKey;
  labelZh: string;
  labelEn: string;
  authority: TaskAuthorityPreset;
  criteriaZh: string;
  criteriaEn: string;
}> = [
  {
    key: 'fix_bug',
    labelZh: '修复缺陷',
    labelEn: 'Fix Bug',
    authority: 'code_fix',
    criteriaZh: '- 复现问题并定位根因\n- 添加回归测试\n- 相关测试全部通过',
    criteriaEn: '- Reproduce and identify the root cause\n- Add a regression test\n- Pass relevant tests',
  },
  {
    key: 'implement_feature',
    labelZh: '实现功能',
    labelEn: 'Implement Feature',
    authority: 'feature',
    criteriaZh: '- 功能按说明完成\n- 覆盖关键边界\n- 构建与测试通过',
    criteriaEn: '- Complete the described behavior\n- Cover key edge cases\n- Pass build and tests',
  },
  {
    key: 'code_review',
    labelZh: '代码审查',
    labelEn: 'Code Review',
    authority: 'review_only',
    criteriaZh: '- 按严重程度列出问题\n- 提供文件与行号\n- 不修改产品代码',
    criteriaEn: '- List findings by severity\n- Cite files and lines\n- Do not modify product code',
  },
  {
    key: 'release_assistant',
    labelZh: '发布助手',
    labelEn: 'Release Assistant',
    authority: 'feature',
    criteriaZh: '- 完成发布前验证\n- 生成版本与发布说明\n- 输出可回滚方案',
    criteriaEn: '- Complete release checks\n- Prepare version and notes\n- Provide rollback steps',
  },
];

declare global {
  interface Window {
    AgentHubAndroid?: {
      microphonePermissionState?: () => string;
      requestMicrophonePermission?: () => boolean;
      startNotificationService?: () => boolean;
      stopNotificationService?: () => boolean;
      flushCookies?: () => boolean;
      appVersionName?: () => string;
      appVersionCode?: () => number;
      downloadLatestApk?: (url: string, filename: string) => string;
      copyText?: (text: string) => boolean;
    };
    AgentHubHandleAndroidBack?: () => boolean;
  }
}

interface AuthPayload {
  user: User;
  csrf_token: string;
  space?: {
    space_id: string;
    name: string;
    slug: string;
    mode: string;
    role?: string | null;
  } | null;
}

interface UserPreferences {
  locale: LocaleCode;
  theme_mode: ThemeMode;
  voice_mode: VoiceMode;
  voice_language: string;
  quick_replies: string[];
}

interface WorkerRuntimeDefaults {
  max_concurrent_jobs: number;
  job_poll_interval_seconds: number;
  heartbeat_interval_seconds: number;
}

type WorkerWithRuntimeSettings = Worker & {
  runtime_settings?: Partial<WorkerRuntimeDefaults>;
};

interface AgentHubSettings {
  preferences: UserPreferences;
  worker_runtime_defaults: WorkerRuntimeDefaults;
  options: {
    locales: Array<{ value: LocaleCode; label: string }>;
    theme_modes: Array<{ value: ThemeMode; label: string }>;
    voice_modes: Array<{ value: VoiceMode; label: string }>;
    voice_languages: Array<{ value: string; label: string }>;
  };
  limits: {
    max_session_attachments: number;
    max_session_attachment_bytes: number;
    max_voice_audio_bytes: number;
  };
}

interface ControlsDraft {
  model: string;
  sandbox_mode: string;
  approval_mode: string;
  permission_mode: string;
  interaction_bridge: string;
  agent: string;
  yolo: boolean;
  thinking: string;
  secret_refs: string;
  secret_environment: string;
  secret_namespace: string;
}

interface SessionFastModeSnapshot {
  state: FastModeState;
  service_tier?: string | null;
  reasoning_effort?: string | null;
  supported: boolean;
  observed_at?: string | null;
  error_code?: string | null;
  error_text?: string | null;
}

interface PermissionChoice {
  id: string;
  label: string;
  description?: string;
  questionId?: string;
  value?: unknown;
  freeform?: boolean;
}

interface NativeAppVersion {
  name: string;
  code: number | null;
}

interface ApkUpdateState {
  status: ApkUpdateStatus;
  sizeBytes?: number;
  lastModified?: string;
  error?: string;
}

interface VoiceStreamAuthResponse extends VoiceStreamAuthPayload {}

interface VoiceTurnResponse {
  spoken_text: string;
  status: 'ok' | 'partial' | 'failed';
  actions: Array<Record<string, unknown>>;
}

type ApkUpdateStates = Record<AndroidDownloadChannelKey, ApkUpdateState>;

function AgentHubBrandMark({ size = 22, className = '' }: { size?: number; className?: string }) {
  const gradientId = `agenthub-brand-mark-${useId().replace(/:/g, '')}`;

  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="2.93"
          y1="12"
          x2="21.07"
          y2="12"
        >
          <stop offset="0" stopColor="#79D1FF" />
          <stop offset="1" stopColor="#3EA5FF" />
        </linearGradient>
      </defs>
      <g transform="rotate(-45 12 12)" fill={`url(#${gradientId})`}>
        <path d="M8.16 5.48h2.63v13.03H8.16z" />
        <path d="M2.93 10.69h7.85v2.63H2.93z" />
        <path d="M13.22 5.48h2.63v13.03h-2.63z" />
        <path d="M13.22 10.69h7.85v2.63h-7.85z" />
      </g>
    </svg>
  );
}

interface NotificationInboxItem {
  id: string;
  title: string;
  body: string;
  createdAt?: string | null;
  sessionId?: string | null;
  permissionId?: string | null;
  serverStatus?: NotificationRecord['status'];
}

interface MobileHistoryState {
  agenthub: typeof MOBILE_HISTORY_STATE;
  mobilePane: MobilePane;
  selectedId: string | null;
  notificationInboxOpen: boolean;
  launchMode: LaunchMode;
  workerInstallOpen: boolean;
  fileWorkspaceView: WorkspaceView;
  depth: number;
}

interface PermissionQuestion {
  id: string;
  header: string;
  question: string;
  options: PermissionChoice[];
}

interface TimelinePayload {
  items: AgentTimelineItem[];
  has_more?: boolean;
  next_after_seq?: number;
  next_after_cursor?: string;
}

interface InboxSyncPayload {
  archived: boolean;
  cursor: string;
  items: AgentSession[];
  removed_session_ids: string[];
}

interface SessionSyncPayload {
  session: AgentSession;
  items: AgentTimelineItem[];
  jobs: Job[];
  next_after_seq: number;
  next_after_cursor?: string;
  has_more: boolean;
}

interface PermissionSyncPayload {
  cursor: string;
  items: AgentPermission[];
}

interface SyncStatusPayload {
  selected_session_id?: string | null;
  selected_timeline_digest: string;
}

interface ReplyAttachment {
  filename: string;
  content_type: string;
  data_base64: string;
  size_bytes: number;
  preview_url?: string;
}

interface SlashCommandOption {
  command: string;
  title: string;
  description: string;
  insertText: string;
  backends?: string[];
  action?: 'insert' | 'open-start' | 'open-fork';
  featureKey?: string;
}

const slashCommandOptions: SlashCommandOption[] = [
  {
    command: '/goal',
    title: '目标模式',
    description: 'Codex 原生支持；Claude、Kimi、OpenCode 走 AgentHub 兼容目标提示。',
    insertText: '/goal ',
    backends: ['codex', 'claude', 'kimi', 'opencode'],
    featureKey: 'goal',
  },
  {
    command: '/btw',
    title: '旁路提问',
    description: '基于当前 session 提问，但不写入原后端 session。',
    insertText: '/btw ',
  },
  {
    command: '/stop',
    title: '停止当前任务',
    description: '停止当前会话里正在运行或排队的输入作业。',
    insertText: '/stop',
  },
  {
    command: '/new',
    title: '新建会话',
    description: '打开当前 worker/backend 的新会话面板。',
    insertText: '/new',
    action: 'open-start',
  },
  {
    command: '/fork',
    title: 'Fork 会话',
    description: '从当前 session 派生一个新任务。',
    insertText: '/fork',
    action: 'open-fork',
  },
  {
    command: '/login',
    title: 'Provider 登录',
    description: '给当前 session 的 worker/backend 创建登录任务。',
    insertText: '/login',
  },
  {
    command: '/logout',
    title: 'Provider 退出',
    description: '给当前 session 的 worker/backend 创建退出任务。',
    insertText: '/logout',
  },
];

const attachmentContentTypeByExtension: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
};

const imageExtensionByContentType: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  content_type?: string | null;
  extension?: string | null;
  preview_capability?: 'directory' | 'text' | 'markdown' | 'image' | 'audio' | 'video' | 'download';
  is_editable?: boolean;
  size_bytes?: number | null;
  modified_at?: string | null;
}

interface WorkspaceFileListResult {
  path: string;
  workspace_root?: string;
  entries: WorkspaceFileEntry[];
  truncated?: boolean;
}

interface WorkspaceFileReadResult {
  path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  truncated: boolean;
  modified_at?: string | null;
  preview_kind?: 'text' | 'image' | 'audio' | 'video' | 'download';
  downloadable?: boolean;
  data_base64?: string;
  text?: string;
  transfer_id?: string;
  content_url?: string;
}

interface FileEditorState {
  path: string;
  filename: string;
  text: string;
  expectedModifiedAt?: string | null;
  target: WorkspaceFileTarget;
}

interface WorkspaceFileTarget {
  workerId: string;
  workspaceRoot: string;
  sessionId?: string | null;
  direct: boolean;
}

interface WorkspaceFileMutationResult {
  path: string;
  parent_path?: string;
  previous_path?: string;
  filename?: string;
  content_type?: string | null;
  size_bytes?: number;
  modified_at?: string | null;
  preview_capability?: 'directory' | 'text' | 'markdown' | 'image' | 'audio' | 'video' | 'download';
  is_editable?: boolean;
  kind?: 'directory' | 'file';
  preview_kind?: 'text' | 'image' | 'audio' | 'video' | 'download';
  downloadable?: boolean;
  truncated?: boolean;
  data_base64?: string;
  text?: string;
}

interface WorkspaceDetailsTarget {
  path: string;
  name: string;
  kind: 'directory' | 'file';
  contentType?: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  previewCapability?: 'directory' | 'text' | 'markdown' | 'image' | 'audio' | 'video' | 'download';
  isEditable?: boolean;
  expectedModifiedAt?: string | null;
}

interface SessionLaunchDraft {
  worker_id: string;
  backend: string;
  workspace_root: string;
  namespace: string;
  prompt: string;
  title: string;
  model: string;
  sandbox_mode: string;
  approval_mode: string;
  permission_mode: string;
  interaction_bridge: string;
  yolo: boolean;
  thinking: string;
  agent: string;
}

interface WorkerEnrollmentCreated {
  enrollment_id: string;
  space_id: string;
  label: string;
  created_at: string;
  expires_at: string;
  enrollment_token: string;
}

interface AgentSecret {
  secret_id: string;
  namespace: string;
  environment: string;
  name: string;
  description: string;
  has_value: boolean;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface SecretDraft {
  name: string;
  value: string;
  namespace: string;
  environment: string;
  description: string;
}

interface WorkerInstallDraft {
  worker_id: string;
  label: string;
  os: 'windows' | 'linux' | 'macos';
  connection_mode: ConnectionMode;
  workspace_roots: string;
  session_roots: string;
  reachable_backends: {
    codex: boolean;
    claude: boolean;
    kimi: boolean;
    opencode: boolean;
  };
  expires_in_hours: number;
  api_url: string;
  max_concurrent_jobs: number;
  job_poll_interval_seconds: number;
  heartbeat_interval_seconds: number;
}

interface WorkerRuntimeSettingsDraft {
  max_concurrent_jobs: string;
  job_poll_interval_seconds: string;
  heartbeat_interval_seconds: string;
}

interface InviteDraft {
  email: string;
  role: InviteRole;
  expires_in_hours: string;
}

interface InviteCreated {
  invite_id: string;
  invite_token: string;
  email: string;
  role: Role;
  expires_at: string;
}

interface AgentHubDesktopApi {
  showMain?: () => Promise<void>;
  openExternalConsole?: () => Promise<void>;
}

declare global {
  interface Window {
    agentHubDesktop?: AgentHubDesktopApi;
  }

  var agentHubDesktop: AgentHubDesktopApi | undefined;
}

const roleRank: Record<Role, number> = {
  viewer: 10,
  operator: 20,
  admin: 30,
  owner: 40,
};

const emptyControls: ControlsDraft = {
  model: '',
  sandbox_mode: '',
  approval_mode: '',
  permission_mode: '',
  interaction_bridge: '',
  agent: '',
  yolo: false,
  thinking: '',
  secret_refs: '',
  secret_environment: '',
  secret_namespace: '',
};

const defaultWorkerRuntimeSettings = {
  max_concurrent_jobs: 2,
  job_poll_interval_seconds: 5,
  heartbeat_interval_seconds: 30,
};

const emptyWorkerRuntimeDraft: WorkerRuntimeSettingsDraft = {
  max_concurrent_jobs: '2',
  job_poll_interval_seconds: '5',
  heartbeat_interval_seconds: '30',
};

const emptyInviteDraft: InviteDraft = {
  email: '',
  role: 'operator',
  expires_in_hours: '168',
};

const defaultSecretDraft: SecretDraft = {
  name: '',
  value: '',
  namespace: 'default',
  environment: 'default',
  description: '',
};

function providerFilters(locale: LocaleCode): { id: ProviderFilter; label: string }[] {
  return [
    { id: 'all', label: t(locale, 'allProviders') },
    { id: 'codex', label: 'Codex' },
    { id: 'claude', label: 'Claude' },
    { id: 'kimi', label: 'Kimi' },
    { id: 'opencode', label: 'OpenCode' },
  ];
}

function timelineFilterLabel(locale: LocaleCode, filter: TimelineFilter) {
  const labels: Record<TimelineFilter, string> = {
    focus: t(locale, 'focus'),
    all: t(locale, 'all'),
    messages: t(locale, 'messages'),
    tools: t(locale, 'tools'),
    events: t(locale, 'events'),
  };
  return labels[filter];
}

const OPTIMISTIC_TIMELINE_SEQ_BASE = 1_000_000_000;
const TIMELINE_PROMPT_MATCH_WINDOW_MS = 10 * 60 * 1000;
const TIMELINE_DISPLAY_DUPLICATE_WINDOW_MS = 2_000;

function replyModeLabel(locale: LocaleCode, mode: ReplyMode) {
  return mode === 'plan' ? t(locale, 'plan') : t(locale, 'direct');
}

function sessionFastMode(session?: AgentSession | null): SessionFastModeSnapshot {
  if (!session || session.backend.toLowerCase() !== 'codex') {
    return { state: 'unavailable', supported: false };
  }
  const raw = session.runtime_metadata?.fast_mode;
  if (!raw || typeof raw !== 'object') {
    return { state: 'unknown', supported: true };
  }
  const data = raw as Record<string, unknown>;
  const state = String(data.state ?? 'unknown').toLowerCase();
  const supported = data.supported !== false;
  const errorCode = typeof data.error_code === 'string' ? String(data.error_code) : null;
  const errorText = typeof data.error_text === 'string' ? String(data.error_text) : null;
  return {
    state: state === 'enabled' || state === 'disabled' ? state : state === 'unavailable' || !supported ? 'unavailable' : 'unknown',
    service_tier: typeof data.service_tier === 'string' ? String(data.service_tier) : null,
    reasoning_effort:
      typeof data.reasoning_effort === 'string'
        ? String(data.reasoning_effort)
        : null,
    supported,
    observed_at: typeof data.observed_at === 'string' ? String(data.observed_at) : null,
    error_code: errorCode,
    error_text: errorText,
  };
}

function fastModeLabel(locale: LocaleCode, snapshot: SessionFastModeSnapshot) {
  if (snapshot.state === 'enabled') return pickLocale(locale, '快速已开', 'Fast on');
  if (snapshot.state === 'disabled') return pickLocale(locale, '快速已关', 'Fast off');
  if (snapshot.state === 'unavailable') return pickLocale(locale, '快速不可用', 'Fast unavailable');
  return pickLocale(locale, '快速未知', 'Fast unknown');
}

function fastModeHint(locale: LocaleCode, snapshot: SessionFastModeSnapshot) {
  if (snapshot.state === 'enabled') {
    return pickLocale(
      locale,
      `原生 /fast 已开启${snapshot.reasoning_effort ? ` · ${snapshot.reasoning_effort}` : ''}`,
      `Native /fast is enabled${snapshot.reasoning_effort ? ` · ${snapshot.reasoning_effort}` : ''}`,
    );
  }
  if (snapshot.state === 'unavailable') {
    if (snapshot.error_code === 'thread_not_found') {
      return pickLocale(locale, '这个会话没有绑定可恢复的原生 Codex 线程，不能直接读取或切换 /fast', 'This session is not bound to a resumable native Codex thread, so /fast cannot be read or toggled directly');
    }
    return pickLocale(locale, '这个会话当前不能直接读取或切换原生 /fast', 'This session cannot read or toggle native /fast right now');
  }
  return null;
}

function fastModeFailureMetadata(errorText: string | null | undefined) {
  const detail = String(errorText || '').trim();
  const lowered = detail.toLowerCase();
  if (lowered.includes('thread not found')) {
    return {
      state: 'unavailable',
      supported: false,
      error_code: 'thread_not_found',
      error_text: detail,
    } as const;
  }
  return {
    state: 'unknown',
    supported: true,
    error_code: 'read_failed',
    error_text: detail || null,
  } as const;
}

const fullAccessControls = {
  sandbox_mode: 'danger-full-access',
  approval_mode: 'never',
  permission_mode: 'bypassPermissions',
  yolo: true,
};

function isClaudeBackendName(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase() === 'claude';
}

const maxReplyAttachments = 5;
const maxReplyAttachmentBytes = 8 * 1024 * 1024;

const defaultWorkerInstallDraft: WorkerInstallDraft = {
  worker_id: '',
  label: '',
  os: 'windows',
  connection_mode: 'private',
  workspace_roots: 'C:/Work',
  session_roots: '',
  reachable_backends: {
    codex: true,
    claude: true,
    kimi: true,
    opencode: true,
  },
  expires_in_hours: 24,
  api_url: '',
  max_concurrent_jobs: 2,
  job_poll_interval_seconds: 5,
  heartbeat_interval_seconds: 30,
};

function emptyLaunchDraft(worker?: Worker, session?: AgentSession): SessionLaunchDraft {
  const controls = session ? controlsFromSession(session) : emptyControls;
  const backend = session?.backend ?? worker?.reachable_backends.find((item) => ['codex', 'claude', 'kimi', 'opencode'].includes(item.toLowerCase())) ?? 'codex';
  const workspace = session?.workspace_root ?? worker?.workspace_roots[0] ?? '';
  return {
    worker_id: session?.worker_id ?? worker?.worker_id ?? '',
    backend: backend.toLowerCase(),
    workspace_root: workspace,
    namespace: session?.namespace ?? 'default',
    prompt: '',
    title: '',
    model: controls.model,
    sandbox_mode: controls.sandbox_mode,
    approval_mode: isClaudeBackendName(backend) ? '' : controls.approval_mode,
    permission_mode: controls.permission_mode,
    interaction_bridge: controls.interaction_bridge,
    yolo: controls.yolo,
    thinking: controls.thinking,
    agent: controls.agent,
  };
}

function splitMultiPathInput(value: string) {
  return value
    .split(/\r?\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function workerInstallBackends(draft: WorkerInstallDraft) {
  return (Object.entries(draft.reachable_backends) as Array<[keyof WorkerInstallDraft['reachable_backends'], boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([backend]) => backend);
}

function normalizeWorkerInstallDraft(baseUrl: string, workers: Worker[]): WorkerInstallDraft {
  const suggestedId = workers.length === 0 ? 'worker-01' : `worker-${String(workers.length + 1).padStart(2, '0')}`;
  return {
    ...defaultWorkerInstallDraft,
    worker_id: suggestedId,
    label: suggestedId,
    api_url: baseUrl,
  };
}

function quoteSinglePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteSingleShell(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function workerBundleUrl(apiUrl: string, os: WorkerInstallDraft['os']) {
  const archive = {
    windows: 'agenthub-worker-windows.zip',
    linux: 'agenthub-worker-linux.tar.gz',
    macos: 'agenthub-worker-macos.tar.gz',
  }[os];
  return `${trimTrailingSlash(apiUrl.trim())}/downloads/workers/${archive}`;
}

function workerInstallCommands(draft: WorkerInstallDraft, enrollment: WorkerEnrollmentCreated) {
  const workspaceRoots = splitMultiPathInput(draft.workspace_roots);
  const sessionRoots = splitMultiPathInput(draft.session_roots);
  if (draft.os === 'windows') {
    const workspaceArg = workspaceRoots.map((item) => `-WorkspaceRoot ${quoteSinglePowerShell(item)}`).join(' ');
    const sessionArg = sessionRoots.map((item) => `-SessionRoot ${quoteSinglePowerShell(item)}`).join(' ');
    const modeArg = `-ConnectionMode ${draft.connection_mode}`;
    const startArg = '-StartAtBoot';
    const installRoot = `C:\\ProgramData\\AgentHub\\workers\\${draft.worker_id.trim()}`;
    const bundleUrl = `${workerBundleUrl(draft.api_url, 'windows')}?v=${encodeURIComponent(enrollment.enrollment_id)}`;
    return [
      `$workerRoot = ${quoteSinglePowerShell(installRoot)}`,
      `$bundleUrl = ${quoteSinglePowerShell(bundleUrl)}`,
      `$bundleZip = Join-Path $env:TEMP ${quoteSinglePowerShell(`agenthub-worker-${draft.worker_id.trim()}.zip`)}`,
      `$bundleDir = Join-Path $env:TEMP ${quoteSinglePowerShell(`agenthub-worker-${draft.worker_id.trim()}`)}`,
      `Remove-Item -LiteralPath $bundleDir -Recurse -Force -ErrorAction SilentlyContinue`,
      `Invoke-WebRequest -Uri $bundleUrl -OutFile $bundleZip`,
      `Expand-Archive -LiteralPath $bundleZip -DestinationPath $bundleDir -Force`,
      `powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleDir 'agenthub-worker\\scripts\\install-windows-worker.ps1') -ApiUrl ${quoteSinglePowerShell(
        draft.api_url.trim(),
      )} -EnrollmentToken ${quoteSinglePowerShell(enrollment.enrollment_token)} -WorkerId ${quoteSinglePowerShell(
        draft.worker_id.trim(),
      )} ${modeArg} -InstallRoot $workerRoot -MaxConcurrentJobs ${Math.max(1, Number(draft.max_concurrent_jobs) || 1)} -JobPollSeconds ${Math.max(
        1,
        Number(draft.job_poll_interval_seconds) || 1,
      )} -HeartbeatSeconds ${Math.max(1, Number(draft.heartbeat_interval_seconds) || 1)} ${workspaceArg}${sessionArg ? ` ${sessionArg}` : ''} ${startArg}`,
      `Remove-Item -LiteralPath $bundleDir -Recurse -Force -ErrorAction SilentlyContinue`,
      `Remove-Item -LiteralPath $bundleZip -Force -ErrorAction SilentlyContinue`,
    ].join('\n');
  }
  if (draft.os === 'macos') {
    const safeWorkerId = draft.worker_id.trim().replace(/[^A-Za-z0-9._-]/g, '_') || 'worker';
    const bundleUrl = `${workerBundleUrl(draft.api_url, 'macos')}?v=${encodeURIComponent(enrollment.enrollment_id)}`;
    const workspaceArgs = workspaceRoots.map((item) => `--workspace-root ${quoteSingleShell(item)}`).join(' ');
    const sessionArgs = sessionRoots.map((item) => `--session-root ${quoteSingleShell(item)}`).join(' ');
    return [
      `worker_root="$HOME/Library/Application Support/AgentHub/workers/${safeWorkerId}"`,
      `bundle_url=${quoteSingleShell(bundleUrl)}`,
      `bundle_tar="${'${TMPDIR:-/tmp}'}/agenthub-worker-${safeWorkerId}.tar.gz"`,
      `bundle_dir="$(mktemp -d "${'${TMPDIR:-/tmp}'}/agenthub-worker.XXXXXX")"`,
      `curl -fsSL "$bundle_url" -o "$bundle_tar"`,
      `tar -xzf "$bundle_tar" -C "$bundle_dir"`,
      `bash "$bundle_dir/agenthub-worker/scripts/install-macos-worker.sh" --api-url ${quoteSingleShell(draft.api_url.trim())} --enrollment-token ${quoteSingleShell(enrollment.enrollment_token)} --worker-id ${quoteSingleShell(draft.worker_id.trim())} --connection-mode ${draft.connection_mode} --install-root "$worker_root" --max-concurrent-jobs ${Math.max(1, Number(draft.max_concurrent_jobs) || 1)} --job-poll-seconds ${Math.max(1, Number(draft.job_poll_interval_seconds) || 1)} --heartbeat-seconds ${Math.max(1, Number(draft.heartbeat_interval_seconds) || 1)}${workspaceArgs ? ` ${workspaceArgs}` : ''}${sessionArgs ? ` ${sessionArgs}` : ''}`,
      `rm -rf "$bundle_dir" "$bundle_tar"`,
    ].join('\n');
  }
  const bundleUrl = `${workerBundleUrl(draft.api_url, 'linux')}?v=${encodeURIComponent(enrollment.enrollment_id)}`;
  const serviceName = `agenthub-linux-worker-${draft.worker_id.trim()}.service`;
  const workspaceArgs = workspaceRoots.map((item) => `--workspace-root ${quoteSingleShell(item)}`).join(' ');
  const sessionArgs = sessionRoots.map((item) => `--session-root ${quoteSingleShell(item)}`).join(' ');
  return [
    `worker_root=${quoteSingleShell(`/opt/agenthub-worker/${draft.worker_id.trim()}`)}`,
    `bundle_url=${quoteSingleShell(bundleUrl)}`,
    `bundle_tar=${quoteSingleShell(`/tmp/agenthub-worker-${draft.worker_id.trim()}.tar.gz`)}`,
    `bundle_dir="$(mktemp -d /tmp/agenthub-worker-XXXXXX)"`,
    `curl -fsSL "$bundle_url" -o "$bundle_tar"`,
    `tar -xzf "$bundle_tar" -C "$bundle_dir"`,
    `sudo bash "$bundle_dir/agenthub-worker/scripts/install-linux-worker.sh" --api-url ${quoteSingleShell(draft.api_url.trim())} --enrollment-token ${quoteSingleShell(enrollment.enrollment_token)} --worker-id ${quoteSingleShell(draft.worker_id.trim())} --connection-mode ${draft.connection_mode} --install-root "$worker_root" --service-name ${quoteSingleShell(serviceName)} --max-concurrent-jobs ${Math.max(1, Number(draft.max_concurrent_jobs) || 1)} --job-poll-seconds ${Math.max(1, Number(draft.job_poll_interval_seconds) || 1)} --heartbeat-seconds ${Math.max(1, Number(draft.heartbeat_interval_seconds) || 1)}${workspaceArgs ? ` ${workspaceArgs}` : ''}${sessionArgs ? ` ${sessionArgs}` : ''}`,
    `rm -rf "$bundle_dir" "$bundle_tar"`,
  ].join('\n');
}

function workerInstallSummary(draft: WorkerInstallDraft) {
  const backends = workerInstallBackends(draft);
  return `${draft.os} · ${draft.connection_mode === 'public_relay' ? '公网 relay' : '私网'} · ${backends.length > 0 ? backends.join(', ') : '未选 backend'}`;
}

function controlsFromLaunchDraft(draft: SessionLaunchDraft) {
  const controls: Record<string, string | boolean> = {};
  const isClaude = isClaudeBackendName(draft.backend);
  if (draft.model.trim()) controls.model = draft.model.trim();
  if (draft.sandbox_mode) controls.sandbox_mode = draft.sandbox_mode;
  if (!isClaude && draft.approval_mode) controls.approval_mode = draft.approval_mode;
  if (draft.permission_mode) controls.permission_mode = draft.permission_mode;
  if (draft.interaction_bridge) controls.interaction_bridge = draft.interaction_bridge;
  if (draft.agent.trim()) controls.agent = draft.agent.trim();
  if (draft.yolo) controls.yolo = true;
  if (draft.thinking) controls.thinking = draft.thinking === 'true';
  return controls;
}

function splitSecretRefs(value: string) {
  return value
    .split(/\r?\n|,|;/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function workerBackendOptions(worker: Worker | undefined) {
  const values = worker?.reachable_backends ?? ['codex', 'claude', 'kimi', 'opencode'];
  return values.filter((backend) => ['codex', 'claude', 'kimi', 'opencode'].includes(backend.toLowerCase()));
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function inferReplyAttachmentContentType(file: File) {
  const declared = file.type.split(';', 1)[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  const extension = file.name.split('.').pop()?.trim().toLowerCase() ?? '';
  return attachmentContentTypeByExtension[extension] ?? (declared || 'application/octet-stream');
}

async function fileToReplyAttachment(file: File): Promise<ReplyAttachment> {
  const contentType = inferReplyAttachmentContentType(file);
  if (file.size > maxReplyAttachmentBytes) {
    throw new Error('附件不能超过 8MB');
  }
  const normalizedType = contentType || 'application/octet-stream';
  return {
    filename: file.name || 'attachment.bin',
    content_type: normalizedType,
    data_base64: arrayBufferToBase64(await file.arrayBuffer()),
    size_bytes: file.size,
    preview_url: normalizedType.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  };
}

function fileWithFallbackName(file: File, fallbackName: string, contentType: string) {
  if (file.name.trim()) return file;
  return new File([file], fallbackName, { type: contentType || file.type || 'application/octet-stream', lastModified: file.lastModified });
}

function pastedImageFiles(clipboardData: DataTransfer | null) {
  if (!clipboardData) return [];
  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const seen = new Set<string>();
  return [...Array.from(clipboardData.files ?? []), ...itemFiles]
    .filter((file) => inferReplyAttachmentContentType(file).startsWith('image/'))
    .filter((file) => {
      const key = [file.name, file.type, file.size, file.lastModified].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((image, index) => {
      const contentType = inferReplyAttachmentContentType(image);
      const extension = imageExtensionByContentType[contentType] ?? 'png';
      return fileWithFallbackName(image, `pasted-image-${index + 1}.${extension}`, contentType);
    });
}

function replyAttachmentPayload(attachment: ReplyAttachment) {
  return {
    filename: attachment.filename,
    content_type: attachment.content_type,
    data_base64: attachment.data_base64,
  };
}

function replyAttachmentContentKey(attachment: ReplyAttachment) {
  return `${attachment.content_type}:${attachment.size_bytes}:${attachment.data_base64}`;
}

function statusClass(status: string) {
  if (['needs_reply', 'needs_approval', 'ready_to_review'].includes(status)) return 'status-approval';
  if (['running', 'queued', 'working'].includes(status)) return 'status-running';
  if (['degraded', 'blocked'].includes(status)) return 'status-warning';
  if (['online', 'succeeded', 'accepted'].includes(status)) return 'status-success';
  if (['ready', 'draft', 'terminated', 'archived', 'cancelled'].includes(status)) return 'status-idle';
  if (['offline', 'failed', 'rejected'].includes(status)) return 'status-failed';
  return 'status-idle';
}

function canAdmin(user: User | null) {
  return user ? roleRank[user.role] >= roleRank.admin : false;
}

function canOperate(user: User | null) {
  return user ? roleRank[user.role] >= roleRank.operator : false;
}

function cancellableSessionInputJob(jobs: Job[]) {
  return (
    jobs.find((job) => job.kind === 'session_input' && job.status === 'running') ??
    jobs.find((job) => job.kind === 'session_input' && job.status === 'queued') ??
    null
  );
}

function workerSupportsBackend(worker: Worker | undefined, session: AgentSession | null) {
  if (!worker || !session) return true;
  return worker.reachable_backends.some((backend) => backend.toLowerCase() === session.backend.toLowerCase());
}

function backendLabel(value: string) {
  const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude', kimi: 'Kimi', opencode: 'OpenCode' };
  return labels[value.toLowerCase()] ?? value;
}

function sessionTitle(session: AgentSession) {
  return session.display_title || session.custom_title || session.llm_title || session.heuristic_title || session.title || '未命名会话';
}

function valueFromControls(controls: Record<string, unknown>, key: string) {
  const value = controls[key];
  return typeof value === 'string' ? value : '';
}

function controlsFromSession(session?: AgentSession): ControlsDraft {
  if (!session) return emptyControls;
  const controls = session.controls ?? {};
  const thinking = controls.thinking;
  const secretRefs = Array.isArray(controls.secret_refs)
    ? controls.secret_refs.map((item) => String(item)).filter(Boolean).join('\n')
    : '';
  const backend = session.backend.toLowerCase();
  const approval = valueFromControls(controls, 'approval_mode');
  const permission = valueFromControls(controls, 'permission_mode') || (backend === 'claude' && approval === 'never' ? 'bypassPermissions' : '');
  return {
    model: valueFromControls(controls, 'model'),
    sandbox_mode: valueFromControls(controls, 'sandbox_mode'),
    approval_mode: backend === 'claude' ? '' : approval,
    permission_mode: permission,
    interaction_bridge: valueFromControls(controls, 'interaction_bridge'),
    agent: valueFromControls(controls, 'agent'),
    yolo: controls.yolo === true,
    thinking: typeof thinking === 'boolean' ? String(thinking) : '',
    secret_refs: secretRefs,
    secret_environment: valueFromControls(controls, 'secret_environment'),
    secret_namespace: valueFromControls(controls, 'secret_namespace'),
  };
}

function sameControlsDraft(left: ControlsDraft, right: ControlsDraft) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function workerRuntimeSettingsFromWorker(worker?: WorkerWithRuntimeSettings | null) {
  return {
    max_concurrent_jobs: Number(worker?.runtime_settings?.max_concurrent_jobs ?? defaultWorkerRuntimeSettings.max_concurrent_jobs),
    job_poll_interval_seconds: Number(
      worker?.runtime_settings?.job_poll_interval_seconds ?? defaultWorkerRuntimeSettings.job_poll_interval_seconds,
    ),
    heartbeat_interval_seconds: Number(
      worker?.runtime_settings?.heartbeat_interval_seconds ?? defaultWorkerRuntimeSettings.heartbeat_interval_seconds,
    ),
  };
}

function workerRuntimeDraftFromWorker(worker?: Worker | null): WorkerRuntimeSettingsDraft {
  const settings = workerRuntimeSettingsFromWorker(worker);
  return {
    max_concurrent_jobs: String(settings.max_concurrent_jobs),
    job_poll_interval_seconds: String(settings.job_poll_interval_seconds),
    heartbeat_interval_seconds: String(settings.heartbeat_interval_seconds),
  };
}

function sameWorkerRuntimeDraft(left: WorkerRuntimeSettingsDraft, right: WorkerRuntimeSettingsDraft) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function latestMessages(session: AgentSession) {
  const messages = session.runtime_metadata?.messages;
  return Array.isArray(messages) ? messages.slice(-8) : [];
}

function timelineFallback(session: AgentSession): AgentTimelineItem[] {
  const messages = latestMessages(session);
  const fallbackMessages = messages.length > 0
    ? messages
    : session.last_message
      ? [
          {
            session_id: session.session_id,
            seq: 1,
            role: session.last_role ?? 'assistant',
            kind: session.last_role === 'user' ? 'user_message' : 'assistant_message',
            text: session.last_message,
            created_at: session.last_activity_at ?? '',
          },
        ]
      : [];
  return fallbackMessages.map((message, index) => ({
    session_id: session.session_id,
    seq: index + 1,
    item_type: String(message.kind ?? 'assistant_message') as AgentTimelineItem['item_type'],
    role: String(message.role ?? 'assistant') as AgentTimelineItem['role'],
    text: String(message.text ?? ''),
    tool_call_id: null,
    tool_name: null,
    status: null,
    payload: {},
    created_at: String(message.created_at ?? session.last_activity_at ?? ''),
  }));
}

function sessionTimeline(session: AgentSession, loadedTimeline: AgentTimelineItem[] | undefined) {
  const metadataMessages = latestMessages(session);
  const fallback = timelineFallback(session);
  if (!loadedTimeline || usefulTimelineItems(loadedTimeline).length === 0) {
    return fallback.length > 0 ? fallback : loadedTimeline ?? [];
  }
  if (
    timelineReflectsSessionLastMessage(session, loadedTimeline) ||
    (metadataMessages.length === 0 && !sessionSummaryOutrunsTimeline(session, loadedTimeline)) ||
    fallback.length === 0
  ) {
    return loadedTimeline;
  }
  const existingTexts = new Set(
    loadedTimeline.map((item) => normalizedTimelineSearchText(item.text)).filter(Boolean),
  );
  const maxSeq = Math.max(0, ...loadedTimeline.map((item) => timelineSeq(item)).filter(Number.isFinite));
  const missingFallback = fallback
    .filter((item) => {
      const text = normalizedTimelineSearchText(item.text);
      return Boolean(text) && !existingTexts.has(text);
    })
    .map((item, index) => ({
      ...item,
      seq: maxSeq + index + 1,
    }));
  return missingFallback.length > 0 ? sortTimelineItemsByCreatedAt([...loadedTimeline, ...missingFallback]) : loadedTimeline;
}

function modeOptions(provider: ProviderSnapshot | undefined, kind: string, fallback: string[]) {
  const fromProvider = (provider?.modes ?? [])
    .filter((mode) => mode.kind === kind)
    .map((mode) => String(mode.id));
  return fromProvider.length > 0 ? fromProvider : fallback;
}

function slashQuery(value: string) {
  const trimmed = value.trimStart();
  if (!/^\/[a-zA-Z]*$/.test(trimmed)) return null;
  return trimmed.slice(1).toLowerCase();
}

function parsedSlashCommand(value: string) {
  const match = value.trim().match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    command: `/${match[1].toLowerCase()}`,
    argument: (match[2] ?? '').trim(),
  };
}

function providerFeatureEnabled(provider: ProviderSnapshot | undefined, key: string) {
  const value = provider?.features?.[key];
  return typeof value === 'boolean' ? value : null;
}

function slashCommandDescription(option: SlashCommandOption, provider: ProviderSnapshot | undefined, locale: LocaleCode = 'zh-CN') {
  if (option.command === '/goal') {
    const nativeGoal = providerFeatureEnabled(provider, 'native_goal_command');
    const goalEnabled = providerFeatureEnabled(provider, 'goal');
    if (nativeGoal === true) {
      return pickLocale(locale, '当前 provider 原生支持 /goal。', 'This provider supports /goal natively.');
    }
    if (goalEnabled === false) {
      return pickLocale(locale, '当前 provider 未上报 /goal 能力。', 'This provider does not report /goal support.');
    }
    return pickLocale(
      locale,
      '当前 provider 走 AgentHub 兼容目标提示，不直接透传原生命令。',
      'This provider uses the AgentHub goal compatibility prompt instead of a native slash command.',
    );
  }
  return option.description;
}

function availableSlashCommands(value: string, session: AgentSession | null, provider: ProviderSnapshot | undefined) {
  const query = slashQuery(value);
  if (query === null) return [];
  const backend = session?.backend.toLowerCase();
  return slashCommandOptions.filter((option) => {
    if (option.backends && backend && !option.backends.includes(backend)) return false;
    if (option.featureKey && providerFeatureEnabled(provider, option.featureKey) === false) return false;
    const normalized = option.command.slice(1).toLowerCase();
    return normalized.startsWith(query);
  });
}

function providerFeatureText(provider: ProviderSnapshot | undefined, key: string) {
  const value = provider?.features?.[key];
  return typeof value === 'string' ? value : '';
}

function providerInteractionSummary(provider: ProviderSnapshot | undefined, locale: LocaleCode = 'zh-CN') {
  const bridge = providerFeatureText(provider, 'interaction_bridge');
  if (bridge === 'native') {
    return pickLocale(locale, '原生交互：Plan/选项/审批可在 AgentHub 内处理', 'Native interaction: plans, choices, and approvals can be handled in AgentHub');
  }
  if (bridge === 'compatibility') {
    return pickLocale(locale, '兼容交互：计划后的选择可处理，运行中原生提问需本机或后续桥接', 'Compatibility mode: plan choices are supported; live native prompts still need local access or a later bridge');
  }
  return pickLocale(locale, '交互能力未上报', 'Interaction capabilities not reported');
}

function optionText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function choicesWithFreeform(questionId: string, choices: PermissionChoice[]) {
  const hasFreeform = choices.some((choice) => {
    const normalized = choice.label.trim().toLowerCase();
    return choice.freeform || normalized === 'other' || normalized === '其他' || normalized.startsWith('其他：');
  });
  if (hasFreeform) return choices;
  return [
    ...choices,
    {
      id: `${questionId}:other`,
      label: '其他',
      description: '输入其他选项或补充说明。',
      questionId,
      value: 'other',
      freeform: true,
    },
  ];
}

function permissionChoices(permission: AgentPermission): PermissionChoice[] {
  const source =
    permission.actions?.choices ??
    permission.actions?.options ??
    permission.detail?.choices ??
    permission.detail?.options;
  if (Array.isArray(source)) {
    const choices: PermissionChoice[] = [];
    source.forEach((item, index) => {
      if (typeof item === 'string' || typeof item === 'number') {
        choices.push({ id: String(item), label: String(item), value: item });
        return;
      }
      if (!item || typeof item !== 'object') return;
      const record = item as Record<string, unknown>;
      const id = optionText(record.id) || optionText(record.value) || String(index);
      const label = optionText(record.label) || optionText(record.title) || optionText(record.name) || id;
      const description = optionText(record.description);
      const questionId = optionText(record.question_id) || optionText(record.questionId);
      if (label) choices.push({ id, label, description, questionId, value: record.value ?? record.id ?? id });
    });
    return choices;
  }
  if (source && typeof source === 'object') {
    return Object.entries(source as Record<string, unknown>).map(([id, value]) => ({
      id,
      label: optionText(value) || id,
      value,
    }));
  }
  return [];
}

function requestUserInputQuestionsFromSource(source: unknown): PermissionQuestion[] {
  if (!Array.isArray(source)) return [];
  const questions: PermissionQuestion[] = [];
  source.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const id = optionText(record.id) || `question_${index + 1}`;
    const options = Array.isArray(record.options) ? record.options : [];
    const parsedOptions: PermissionChoice[] = [];
    options.forEach((option, optionIndex) => {
      if (typeof option === 'string' || typeof option === 'number') {
        parsedOptions.push({ id: `${id}:${optionIndex}`, label: String(option), questionId: id });
        return;
      }
      if (!option || typeof option !== 'object') return;
      const optionRecord = option as Record<string, unknown>;
      const label =
        optionText(optionRecord.label) ||
        optionText(optionRecord.title) ||
        optionText(optionRecord.name) ||
        optionText(optionRecord.value);
      if (!label) return;
      parsedOptions.push({
        id: optionText(optionRecord.id) || `${id}:${optionIndex}`,
        label,
        description: optionText(optionRecord.description),
        questionId: id,
        value: optionRecord.value ?? label,
      });
    });
    if (parsedOptions.length === 0) return;
    questions.push({
      id,
      header: optionText(record.header),
      question: optionText(record.question),
      options: choicesWithFreeform(id, parsedOptions),
    });
  });
  return questions;
}

function requestUserInputQuestions(permission: AgentPermission): PermissionQuestion[] {
  return requestUserInputQuestionsFromSource(permission.detail?.questions);
}

function interactionKind(permission: AgentPermission) {
  return String(permission.detail?.source || permission.kind || '').trim();
}

function permissionPlanText(permission: AgentPermission) {
  const value = permission.detail?.plan_text;
  return typeof value === 'string' ? value.replace(/<\/?proposed_plan>/gi, '').trim() : '';
}

function parseRequestUserInputPayload(text?: string | null): Record<string, unknown> | null {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function requestUserInputTimelineQuestions(item: AgentTimelineItem): PermissionQuestion[] {
  const marker = `${item.tool_name ?? ''} ${item.text ?? ''}`.toLowerCase();
  if (!marker.includes('request_user_input') && !marker.includes('requestuserinput')) return [];
  const payloadQuestions = requestUserInputQuestionsFromSource(item.payload?.questions);
  if (payloadQuestions.length > 0) return payloadQuestions;
  const parsed = parseRequestUserInputPayload(item.text);
  return requestUserInputQuestionsFromSource(parsed?.questions);
}

function requestUserInputSummary(questions: PermissionQuestion[]) {
  const labels = questions.map((question) => question.header || question.question || question.id).filter(Boolean);
  return labels.length > 0 ? `需要选择：${labels.join(' / ')}` : '需要选择';
}

function requestQuestionSignature(questions: PermissionQuestion[]) {
  return questions.map((question) => question.id).sort().join('|');
}

function matchingRequestUserInputPermission(permissions: AgentPermission[], questions: PermissionQuestion[]) {
  if (questions.length === 0) return undefined;
  const signature = requestQuestionSignature(questions);
  return (
    permissions.find((permission) => requestQuestionSignature(requestUserInputQuestions(permission)) === signature) ??
    permissions.find((permission) => requestUserInputQuestions(permission).length > 0)
  );
}

function sandboxSummary(session?: AgentSession | null, locale: LocaleCode = 'zh-CN') {
  if (!session) return pickLocale(locale, '权限未选择', 'No permission selected');
  const controls = session.controls ?? {};
  const backend = session.backend.toLowerCase();
  const sandbox = optionText(controls.sandbox_mode) || 'default';
  const approval = optionText(controls.approval_mode) || 'default';
  const permission = optionText(controls.permission_mode) || (backend === 'claude' && approval === 'never' ? 'bypassPermissions' : approval);
  if (controls.yolo === true || sandbox === 'danger-full-access' || permission === 'bypassPermissions') {
    return pickLocale(locale, '全权限', 'Full access');
  }
  if (backend === 'claude' && permission === 'plan') return pickLocale(locale, 'Claude 计划模式', 'Claude plan mode');
  if (backend === 'claude') return pickLocale(locale, `权限 ${permission}`, `Permission ${permission}`);
  if (backend === 'kimi') return controls.yolo === true ? 'Kimi yolo' : 'Kimi default';
  return `${sandbox} / ${approval}`;
}

function quoteCliArg(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function sessionRuntimeSource(session: AgentSession) {
  const runtimeSource = optionText((session.runtime_metadata as Record<string, unknown> | undefined)?.source);
  if (runtimeSource) return runtimeSource;
  return optionText((session.metadata as Record<string, unknown> | undefined)?.source);
}

function isVirtualResumeOnlySession(session: AgentSession) {
  const source = sessionRuntimeSource(session);
  return source === 'autopilot_cockpit';
}

function localResumeCommand(session: AgentSession) {
  if (isVirtualResumeOnlySession(session)) return '';
  const backend = session.backend.toLowerCase();
  const sessionId = quoteCliArg(session.session_id);
  const workspace = session.workspace_root?.trim() ? ` -C ${quoteCliArg(session.workspace_root.trim())}` : '';
  if (backend === 'codex') {
    return `codex resume --all --include-non-interactive${workspace} ${sessionId}`;
  }
  if (backend === 'claude') {
    return `claude --resume ${sessionId}`;
  }
  if (backend === 'kimi') {
    const workDir = session.workspace_root?.trim() ? ` --work-dir ${quoteCliArg(session.workspace_root.trim())}` : '';
    return `kimi${workDir} -S ${sessionId}`;
  }
  if (backend === 'opencode') {
    const workDir = session.workspace_root?.trim() ? ` ${quoteCliArg(session.workspace_root.trim())}` : '';
    return `opencode --session ${sessionId}${workDir}`;
  }
  return `${backend} resume ${sessionId}`;
}

function localResumeHint(session: AgentSession) {
  if (isVirtualResumeOnlySession(session)) {
    return '这是 AgentHub 驾驶舱生成的合成会话，不对应本机 Codex CLI 历史，不能直接用 codex resume 打开。';
  }
  if (session.backend.toLowerCase() === 'codex') {
    return 'AgentHub 新建的 Codex 会话来自 codex exec，普通 resume 列表默认可能隐藏它，所以这里固定带 --all 和 --include-non-interactive。';
  }
  return '在对应 worker 本机运行这条命令，打开同一个后端会话。';
}

function localResumeDetail(session: AgentSession) {
  if (isVirtualResumeOnlySession(session)) {
    const source = sessionRuntimeSource(session) || 'virtual';
    return `Source: ${source} · Runtime: ${session.runtime_session_ref || session.session_id}`;
  }
  return `Workspace: ${session.workspace_root || 'default'} · Runtime: ${session.runtime_session_ref || session.session_id}`;
}

function replyModeHint(mode: ReplyMode, session?: AgentSession | null, provider?: ProviderSnapshot, locale: LocaleCode = 'zh-CN') {
  if (mode === 'plan' && session?.backend.toLowerCase() === 'codex') {
    return pickLocale(locale, 'Codex 原生 Plan；沙箱按当前控制设置，需要选择时会弹出卡片', 'Codex native Plan; sandbox follows current controls, and choices appear as cards');
  }
  if (mode === 'plan') return pickLocale(locale, `计划模式；${providerInteractionSummary(provider, locale)}`, `Plan mode; ${providerInteractionSummary(provider, locale)}`);
  const status = session?.status;
  if (status === 'running' || status === 'queued') {
    return pickLocale(locale, '当前会话忙，发送后会排队到当前作业后执行', 'This session is busy; your message will run after the current job');
  }
  return session ? pickLocale(locale, `当前 ${sandboxSummary(session, locale)}`, `Current ${sandboxSummary(session, locale)}`) : '';
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : '';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? '未知错误');
}

function errorDetail(error: unknown) {
  const name = errorName(error);
  const message = errorMessage(error);
  return name ? `${name}: ${message}` : message;
}

function isMicrophonePermissionError(error: unknown) {
  const name = errorName(error);
  const message = errorMessage(error).toLowerCase();
  return (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    name === 'SecurityError' ||
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('not allowed') ||
    message.includes('权限')
  );
}

function nativeMicrophonePermissionState(): NativeMicrophoneState {
  try {
    const state = window.AgentHubAndroid?.microphonePermissionState?.();
    return state === 'granted' || state === 'denied' ? state : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function requestNativeMicrophonePermission() {
  try {
    return window.AgentHubAndroid?.requestMicrophonePermission?.() === true;
  } catch {
    return false;
  }
}

function startNativeNotificationService() {
  try {
    return window.AgentHubAndroid?.startNotificationService?.() === true;
  } catch {
    return false;
  }
}

function stopNativeNotificationService() {
  try {
    return window.AgentHubAndroid?.stopNotificationService?.() === true;
  } catch {
    return false;
  }
}

function hasNativeAndroidAudioBridge() {
  try {
    return typeof window.AgentHubAndroid?.microphonePermissionState === 'function';
  } catch {
    return false;
  }
}

function voiceMediaConstraints(): MediaStreamConstraints {
  return {
    audio: {
      ...(hasNativeAndroidAudioBridge() ? RAW_NATIVE_AUDIO_CONSTRAINTS : PROCESSED_BROWSER_AUDIO_CONSTRAINTS),
    },
  };
}

function flushNativeCookies() {
  try {
    return window.AgentHubAndroid?.flushCookies?.() === true;
  } catch {
    return false;
  }
}

function nativeAppVersion(): NativeAppVersion | null {
  try {
    const name = window.AgentHubAndroid?.appVersionName?.()?.trim();
    if (!name) return null;
    const code = window.AgentHubAndroid?.appVersionCode?.();
    return { name, code: typeof code === 'number' && Number.isFinite(code) ? code : null };
  } catch {
    return null;
  }
}

function apkDownloadUrl(channel: AndroidDownloadChannelKey) {
  const path = ANDROID_DOWNLOAD_CHANNELS[channel].path;
  if (typeof window === 'undefined') return path;
  return new URL(path, window.location.origin).toString();
}

function apkSizeFromHeaders(headers: Headers) {
  const contentRange = headers.get('content-range');
  const rangeSize = contentRange?.match(/\/(\d+)$/)?.[1];
  const sizeText = rangeSize ?? headers.get('content-length');
  const sizeBytes = sizeText ? Number.parseInt(sizeText, 10) : NaN;
  return Number.isFinite(sizeBytes) ? sizeBytes : undefined;
}

function nativeDownloadLatestApk(url: string, filename: string) {
  try {
    return window.AgentHubAndroid?.downloadLatestApk?.(url, filename) ?? '';
  } catch (error) {
    return `failed:${errorName(error) || 'Error'}`;
  }
}

async function writeTextToClipboard(value: string) {
  const text = String(value ?? '');
  try {
    if (window.AgentHubAndroid?.copyText?.(text) === true) return true;
  } catch {
    // Fall through to the browser clipboard path.
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

function initialThemeMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function initialAppMode(): AppMode {
  try {
    const stored = localStorage.getItem(APP_MODE_STORAGE_KEY);
    return stored === 'cockpit' || stored === 'workbench' ? stored : 'session';
  } catch {
    return 'session';
  }
}

function initialVoiceInputMode(): VoiceInputMode {
  try {
    return localStorage.getItem(VOICE_INPUT_MODE_STORAGE_KEY) === 'streaming' ? 'streaming' : 'standard';
  } catch {
    return 'standard';
  }
}

function initialVoiceInteractionMode(): VoiceInteractionMode {
  try {
    return localStorage.getItem(VOICE_INTERACTION_MODE_STORAGE_KEY) === 'assistant' ? 'assistant' : 'dictation';
  } catch {
    return 'dictation';
  }
}

function initialLocale(): LocaleCode {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocaleCode(stored) ? stored : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function defaultSettings(): AgentHubSettings {
  return {
    preferences: {
      locale: 'zh-CN',
      theme_mode: 'dark',
      voice_mode: 'streaming',
      voice_language: 'zh-CN',
      quick_replies: ['继续', '不对，重新来', '等等', '收到，继续', '先停一下'],
    },
    worker_runtime_defaults: {
      max_concurrent_jobs: 2,
      job_poll_interval_seconds: 5,
      heartbeat_interval_seconds: 30,
    },
    options: {
      locales: [
        { value: 'zh-CN', label: '简体中文' },
        { value: 'zh-TW', label: '繁體中文' },
        { value: 'en-US', label: 'English' },
      ],
      theme_modes: [
        { value: 'dark', label: '深色' },
        { value: 'light', label: '浅色' },
      ],
      voice_modes: [
        { value: 'streaming', label: '流式' },
        { value: 'standard', label: '标准' },
      ],
      voice_languages: [
        { value: 'zh-CN', label: '中文' },
        { value: 'zh-TW', label: '繁體中文' },
        { value: 'en-US', label: 'English' },
      ],
    },
    limits: {
      max_session_attachments: 5,
      max_session_attachment_bytes: 8 * 1024 * 1024,
      max_voice_audio_bytes: MAX_VOICE_AUDIO_BYTES,
    },
  };
}

function readStoredNotificationIdsFromStorage(storageKey: string) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function trimNotificationIds(ids: Set<string>) {
  if (ids.size <= MAX_REMEMBERED_NOTIFICATION_IDS) return ids;
  return new Set(Array.from(ids).slice(-MAX_REMEMBERED_NOTIFICATION_IDS));
}

function readStoredNotificationIds() {
  return readStoredNotificationIdsFromStorage(NOTIFICATION_READ_STORAGE_KEY);
}

function readStoredDeliveredNotificationIds() {
  return readStoredNotificationIdsFromStorage(NOTIFICATION_DELIVERED_STORAGE_KEY);
}

function persistNotificationIds(storageKey: string, ids: Set<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...trimNotificationIds(ids)]));
  } catch {
    // Storage can be unavailable in private WebViews.
  }
}

function isMobilePane(value: unknown): value is MobilePane {
  return typeof value === 'string' && mobilePanes.includes(value as MobilePane);
}

function readMobileHistoryState(value: unknown): MobileHistoryState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<MobileHistoryState>;
  if (state.agenthub !== MOBILE_HISTORY_STATE || !isMobilePane(state.mobilePane)) return null;
  return {
    agenthub: MOBILE_HISTORY_STATE,
    mobilePane: state.mobilePane,
    selectedId: typeof state.selectedId === 'string' ? state.selectedId : null,
    notificationInboxOpen: Boolean(state.notificationInboxOpen),
    launchMode: state.launchMode === 'start' || state.launchMode === 'fork' ? state.launchMode : 'none',
    workerInstallOpen: Boolean(state.workerInstallOpen),
    fileWorkspaceView: state.fileWorkspaceView === 'preview' ? 'preview' : 'explorer',
    depth: typeof state.depth === 'number' && state.depth > 0 ? state.depth : 0,
  };
}

function sameMobileHistoryState(left: MobileHistoryState | null, right: MobileHistoryState) {
  return (
    Boolean(left) &&
    left?.mobilePane === right.mobilePane &&
    left.selectedId === right.selectedId &&
    left.notificationInboxOpen === right.notificationInboxOpen &&
    left.launchMode === right.launchMode &&
    left.workerInstallOpen === right.workerInstallOpen &&
    left.fileWorkspaceView === right.fileWorkspaceView
  );
}

function recordingFailureNotice(error: unknown, nativeState: NativeMicrophoneState = 'unavailable') {
  if (isMicrophonePermissionError(error)) {
    if (nativeState === 'granted') {
      return `麦克风 App 权限已开启，但 Android WebView 仍拒绝录音：${errorDetail(error)}。请重启 AgentHub 或更新 Android System WebView 后再试。`;
    }
    return `麦克风权限未开启。请在安卓系统设置 > 应用 > AgentHub > 权限里允许麦克风，然后回到会话再点语音。错误：${errorDetail(error)}`;
  }
  return `录音失败：${errorMessage(error)}`;
}

function recorderSetupFailureNotice(error: unknown) {
  const name = errorName(error);
  const message = errorMessage(error);
  return `录音初始化失败：${name ? `${name}: ` : ''}${message}`;
}

function voiceTranscribeFailureNotice(error: unknown) {
  const message = errorMessage(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('normal silence audio') || normalized.includes('no valid speech in audio')) {
    return '这次录到的是静音、音量太小，或浏览器选错了麦克风输入设备。请对着麦克风重试；如果还是不行，先检查浏览器站点麦克风权限和系统默认输入设备。';
  }
  if (
    message === '413' ||
    normalized.includes('too large') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('load failed')
  ) {
    return '语音上传失败：录音太长、网络切换或反代限制导致请求中断。请重试；如果仍失败，先分段录音。';
  }
  return `语音识别失败：${message}`;
}

function supportedAudioMimeTypes() {
  if (typeof MediaRecorder.isTypeSupported !== 'function') return [];
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'].filter((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

function createAudioRecorder(stream: MediaStream) {
  const failures: string[] = [];
  for (const mimeType of supportedAudioMimeTypes()) {
    try {
      return new MediaRecorder(stream, { mimeType });
    } catch (error) {
      failures.push(`${mimeType}: ${errorName(error) || 'Error'} ${errorMessage(error)}`);
    }
  }
  try {
    return new MediaRecorder(stream);
  } catch (error) {
    failures.push(`default: ${errorName(error) || 'Error'} ${errorMessage(error)}`);
  }
  throw new Error(failures.join('; ') || 'MediaRecorder unavailable');
}

export function parseApiDate(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T').replace(/\.(\d{3})\d+/, '.$1');
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const hasTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(normalized);
  const parsed = new Date(hasTime && !hasExplicitTimezone ? `${normalized}Z` : normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatWhen(value?: string | null) {
  const parsed = parseApiDate(value);
  if (!parsed) return '';
  return parsed.toLocaleString();
}

function formatRelative(value?: string | null, locale: LocaleCode = 'zh-CN') {
  return formatRelativeTime(locale, value, parseApiDate);
}

function formatFileSize(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'folder';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function sessionTimestamp(session: AgentSession) {
  return parseApiDate(session.last_activity_at ?? session.updated_at)?.getTime() ?? 0;
}

function statusLabel(status: string, locale: LocaleCode = 'zh-CN') {
  return statusText(locale, status);
}

function compactText(value?: string | null, limit = 180) {
  const compacted = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!compacted) return '';
  return compacted.length > limit ? `${compacted.slice(0, limit - 1)}…` : compacted;
}

function commandExitCode(value?: string | null) {
  const match = String(value ?? '').match(/Exit code:\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function hasRawCommandTelemetry(value?: string | null) {
  const text = String(value ?? '');
  return /Exit code:\s*-?\d+/i.test(text) || /Wall time:/i.test(text);
}

function agentOpsActivitySummary(value?: string | null, status = 'ready', limit = 128) {
  const text = compactText(value, limit);
  const exitCode = commandExitCode(value);
  if (exitCode !== null) {
    return exitCode === 0 ? '执行完成 · 查看执行详情' : '执行失败 · 查看执行详情';
  }
  if (hasRawCommandTelemetry(value)) return '工具执行已同步 · 查看执行详情';
  if (text) return text;
  if (status === 'needs_reply') return '等待你处理审批或回复';
  if (status === 'queued') return '已进入队列，等待 worker 领取';
  if (status === 'running') return '正在执行，等待 worker 同步最新结果';
  if (status === 'failed') return '执行失败，查看作业与事件详情';
  return '暂无 transcript 摘要';
}

function agentOpsTaskHeadline(session: AgentSession) {
  const exitCode = commandExitCode(session.activity_summary || session.last_message);
  if (exitCode !== null) return exitCode === 0 ? '执行完成' : '执行失败';
  if (session.status === 'needs_reply') return '等待你处理审批';
  if (session.status === 'running') return '任务正在运行';
  if (session.status === 'queued') return '任务已排队';
  if (session.status === 'failed') return '任务失败';
  return '任务状态';
}

function agentOpsTaskSummary(session: AgentSession) {
  return agentOpsActivitySummary(session.activity_summary || session.last_message, session.status, 160);
}

function notificationState(): NotificationState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function permissionNoticeText(permission: AgentPermission, count: number) {
  const title = permission.title || permission.description || '新的审批请求';
  return `${count} 个审批待处理：${compactText(title, 64)}`;
}

function needsReplyNotificationKey(session: AgentSession) {
  return `${session.session_id}:${session.last_activity_at ?? session.updated_at ?? ''}`;
}

function needsReplyNotificationBody(session: AgentSession) {
  const summary = compactText(session.activity_summary || session.last_message || '等待你回复', 96);
  return `${sessionTitle(session)}：${summary}`;
}

function needsReplyNoticeText(session: AgentSession, count: number) {
  return `${count} 个会话等待回复：${compactText(sessionTitle(session), 64)}`;
}

function jobTime(job: Job) {
  return parseApiDate(job.updated_at ?? job.created_at)?.getTime() ?? 0;
}

function parseJobResult<T>(job?: Job): T | null {
  if (!job?.result_text) return null;
  try {
    return JSON.parse(job.result_text) as T;
  } catch {
    return null;
  }
}

function latestCompletedJob(jobs: Job[], kind: string) {
  return jobs
    .filter((job) => job.kind === kind && job.status === 'succeeded')
    .slice()
    .sort((left, right) => jobTime(right) - jobTime(left))[0];
}

function latestCompletedJobByKinds(jobs: Job[], kinds: string[]) {
  return jobs
    .filter((job) => kinds.includes(job.kind) && job.status === 'succeeded')
    .slice()
    .sort((left, right) => jobTime(right) - jobTime(left))[0];
}

function fileListResult(jobs: Job[]) {
  const result = parseJobResult<WorkspaceFileListResult>(latestCompletedJob(jobs, 'file_list'));
  if (!result || !Array.isArray(result.entries)) return null;
  return result;
}

function fileReadResult(jobs: Job[]) {
  const result = parseJobResult<WorkspaceFileReadResult>(
    latestCompletedJobByKinds(jobs, ['file_read', 'file_write', 'file_transfer_prepare']),
  );
  if (!result || typeof result.path !== 'string' || typeof result.filename !== 'string') return null;
  const transferPreviewKind = result.content_url
    ? workspacePreviewKind(result.path, result.content_type)
    : undefined;
  return {
    ...result,
    preview_kind: result.preview_kind ?? transferPreviewKind ?? 'text',
    downloadable: Boolean(result.downloadable || result.content_url),
    truncated: Boolean(result.truncated),
    text: typeof result.text === 'string' ? result.text : '',
  };
}

const MAX_LEGACY_WORKSPACE_UPLOAD_BYTES = 16 * 1024 * 1024;

async function fileToWorkspaceUploadPayload(file: File) {
  if (file.size > MAX_LEGACY_WORKSPACE_UPLOAD_BYTES) {
    throw new Error('当前 Worker 不支持流式上传，旧版上传仅支持 16 MB 以内文件');
  }
  const contentType = inferReplyAttachmentContentType(file) || 'application/octet-stream';
  return {
    filename: file.name || 'upload.bin',
    content_type: contentType,
    data_base64: arrayBufferToBase64(await file.arrayBuffer()),
    size_bytes: file.size,
  };
}

function fileJobBusy(jobs: Job[]) {
  return jobs.some(
    (job) => ['file_list', 'file_read', 'file_write', 'file_transfer_prepare', 'file_transfer_apply'].includes(job.kind) && ['queued', 'running'].includes(job.status),
  );
}

function isEditableWorkspaceText(file: WorkspaceFileReadResult | null) {
  if (!file) return false;
  if (file.preview_kind !== 'text') return false;
  if (file.truncated) return false;
  return (file.text?.length ?? 0) <= MAX_FILE_EDITOR_CHARS;
}

function isMarkdownWorkspaceFile(file: WorkspaceFileReadResult | null) {
  if (!file || file.preview_kind !== 'text') return false;
  const contentType = (file.content_type || '').toLowerCase();
  return contentType === 'text/markdown' || file.filename.toLowerCase().endsWith('.md') || file.filename.toLowerCase().endsWith('.markdown');
}

function fileEntryCapability(entry: WorkspaceFileEntry) {
  if (entry.kind === 'directory') return 'directory';
  return entry.preview_capability ?? 'download';
}

function workspacePreviewKind(path: string, contentType = ''): 'text' | 'image' | 'audio' | 'video' | 'download' {
  const normalizedType = contentType.toLowerCase();
  if (normalizedType.startsWith('image/')) return 'image';
  if (normalizedType.startsWith('audio/')) return 'audio';
  if (normalizedType.startsWith('video/')) return 'video';
  if (normalizedType.startsWith('text/') || normalizedType.includes('json') || normalizedType.includes('xml')) return 'text';
  const extension = path.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(extension)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(extension)) return 'audio';
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v'].includes(extension)) return 'video';
  if (['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'css', 'scss', 'html', 'env'].includes(extension)) return 'text';
  return 'download';
}

export function isSensitiveWorkspaceFile(path: string) {
  const filename = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const sensitiveNames = new Set([
    '.env',
    '.netrc',
    '.npmrc',
    '.pypirc',
    'application_default_credentials.json',
    'credentials',
    'credentials.json',
    'id_ed25519',
    'id_rsa',
    'kubeconfig',
    'secrets.json',
  ]);
  return sensitiveNames.has(filename) || filename.startsWith('.env.') || /\.(key|p12|pem|pfx)$/.test(filename);
}

function shouldStreamWorkspacePreview(capability: WorkspaceFileEntry['preview_capability'] | undefined, path: string) {
  const normalized = capability === 'markdown' ? 'text' : capability ?? workspacePreviewKind(path);
  return ['image', 'audio', 'video', 'download'].includes(normalized);
}

function fileEntryIcon(entry: WorkspaceFileEntry) {
  const capability = fileEntryCapability(entry);
  if (capability === 'directory') return Folder;
  if (capability === 'image') return ImageIcon;
  if (capability === 'audio' || capability === 'video') return Play;
  return FileText;
}

function previewCapabilityLabel(locale: LocaleCode, capability: 'directory' | 'text' | 'markdown' | 'image' | 'audio' | 'video' | 'download') {
  switch (capability) {
    case 'directory':
      return pickLocale(locale, '目录', 'Directory');
    case 'text':
      return pickLocale(locale, '文本', 'Text');
    case 'markdown':
      return 'Markdown';
    case 'image':
      return pickLocale(locale, '图片', 'Image');
    case 'audio':
      return pickLocale(locale, '音频', 'Audio');
    case 'video':
      return pickLocale(locale, '视频', 'Video');
    default:
      return pickLocale(locale, '下载', 'Download');
  }
}

function decodeBase64Bytes(dataBase64: string) {
  const binary = globalThis.atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function workspaceFileBlob(file: WorkspaceFileReadResult) {
  if (typeof file.data_base64 === 'string' && file.data_base64) {
    return new Blob([decodeBase64Bytes(file.data_base64)], { type: file.content_type || 'application/octet-stream' });
  }
  if (typeof file.text === 'string') {
    return new Blob([file.text], { type: file.content_type || 'text/plain;charset=utf-8' });
  }
  return null;
}

function workspaceFileDataUrl(file: WorkspaceFileReadResult) {
  if (file.content_url) return file.content_url;
  if (typeof file.data_base64 === 'string' && file.data_base64) {
    return `data:${file.content_type || 'application/octet-stream'};base64,${file.data_base64}`;
  }
  return null;
}

function sessionInputJobText(job: Job) {
  if (job.kind !== 'session_input') return '';
  const prompt = typeof job.payload?.prompt === 'string' ? job.payload.prompt.trim() : '';
  const attachments = Array.isArray(job.payload?.attachments) ? job.payload.attachments : [];
  const attachmentNames = attachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return '';
      const record = attachment as Record<string, unknown>;
      return typeof record.filename === 'string' ? record.filename.trim() : '';
    })
    .filter(Boolean);
  const attachmentText = attachmentNames.length > 0 ? `[附件：${attachmentNames.join('、')}]` : '';
  return [prompt || (attachmentText ? '请看这个附件。' : ''), attachmentText].filter(Boolean).join('\n');
}

function shouldShowJobInTimeline(job: Job) {
  return (
    job.kind === 'session_input' &&
    ['queued', 'running'].includes(job.status) &&
    Boolean(sessionInputJobText(job))
  );
}

function timelineItemPayload(item: AgentTimelineItem) {
  return item.payload && typeof item.payload === 'object' ? (item.payload as Record<string, unknown>) : {};
}

function timelineItemAttachments(item: AgentTimelineItem) {
  const payload = timelineItemPayload(item);
  const attachments = payload.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map((attachment) => {
      if (!attachment || typeof attachment !== 'object') return null;
      const record = attachment as Record<string, unknown>;
      const filename = typeof record.filename === 'string' ? record.filename.trim() : '';
      if (!filename) return null;
      return {
        filename,
        content_type: typeof record.content_type === 'string' ? record.content_type : 'application/octet-stream',
        size_bytes: typeof record.size_bytes === 'number' ? record.size_bytes : null,
      };
    })
    .filter((attachment): attachment is { filename: string; content_type: string; size_bytes: number | null } => attachment !== null);
}

function timelineItemJobId(item: AgentTimelineItem) {
  const payload = timelineItemPayload(item);
  const jobId = payload.job_id ?? payload.agenthub_job_id;
  return typeof jobId === 'string' ? jobId : '';
}

function timelineCreatedAtMs(value?: string | null) {
  return parseApiDate(value)?.getTime() ?? null;
}

function timelineTimesClose(left?: string | null, right?: string | null) {
  const leftMs = timelineCreatedAtMs(left);
  const rightMs = timelineCreatedAtMs(right);
  if (leftMs === null || rightMs === null) return false;
  return Math.abs(leftMs - rightMs) <= TIMELINE_PROMPT_MATCH_WINDOW_MS;
}

function stripImageAttachmentMarker(value: string) {
  return value.replace(/\n?\[(?:图片|附件)：[^\]]+\]\s*$/, '').trim();
}

function sameTimelinePrompt(left: string, right: string) {
  return compactText(stripImageAttachmentMarker(left), 400) === compactText(stripImageAttachmentMarker(right), 400);
}

function timelineAlreadyContainsJob(items: AgentTimelineItem[], job: Job) {
  const prompt = sessionInputJobText(job);
  const rawPrompt = typeof job.payload?.prompt === 'string' ? job.payload.prompt.trim() : '';
  return items.some(
    (item) => {
      if (item.item_type !== 'user_message' || item.role !== 'user') return false;
      if (job.job_id && timelineItemJobId(item) === job.job_id) return true;
      if (!timelineTimesClose(item.created_at, job.created_at ?? job.updated_at)) return false;
      return sameTimelinePrompt(item.text, prompt) || (rawPrompt ? sameTimelinePrompt(item.text, rawPrompt) : false);
    },
  );
}

function jobTimelineItems(session: AgentSession | null | undefined, jobs: Job[], timeline: AgentTimelineItem[]) {
  if (!session) return [];
  const maxSeq = Math.max(0, ...timeline.map((item) => Number(item.seq) || 0));
  return jobs
    .filter(shouldShowJobInTimeline)
    .filter((job) => !timelineAlreadyContainsJob(timeline, job))
    .slice()
    .sort((left, right) => jobTime(left) - jobTime(right))
    .map((job, index): AgentTimelineItem => ({
      session_id: session.session_id,
      seq: maxSeq + index + 1,
      item_type: 'user_message',
      role: 'user',
      text: sessionInputJobText(job),
      tool_call_id: null,
      tool_name: null,
      status: null,
      payload: {
        agenthub_job_id: job.job_id,
        agenthub_job_status: job.status,
        agenthub_job_error: job.error_text ?? '',
      },
      created_at: job.created_at ?? job.updated_at ?? new Date(0).toISOString(),
    }));
}

function usefulTimelineItems(items: AgentTimelineItem[]) {
  return items.filter((item) => compactText(item.text) || item.item_type === 'tool_call' || item.item_type === 'error');
}

function timelineSeq(item: AgentTimelineItem) {
  return Number(item.seq) || 0;
}

function compareTimelineItemsByCreatedAt(left: AgentTimelineItem, right: AgentTimelineItem) {
  const leftMs = timelineCreatedAtMs(left.created_at);
  const rightMs = timelineCreatedAtMs(right.created_at);
  if (leftMs !== null && rightMs !== null && leftMs !== rightMs) return leftMs - rightMs;
  return timelineSeq(left) - timelineSeq(right);
}

function sortTimelineItemsByCreatedAt(items: AgentTimelineItem[]) {
  return items.slice().sort(compareTimelineItemsByCreatedAt);
}

function sameTimelineDisplayEcho(left: AgentTimelineItem, right: AgentTimelineItem) {
  if (left.item_type !== 'assistant_message' || right.item_type !== 'assistant_message') return false;
  if (left.role !== right.role) return false;
  if (compactText(left.text, 4_000) !== compactText(right.text, 4_000)) return false;
  const leftMs = timelineCreatedAtMs(left.created_at);
  const rightMs = timelineCreatedAtMs(right.created_at);
  if (leftMs === null || rightMs === null) return false;
  return Math.abs(leftMs - rightMs) <= TIMELINE_DISPLAY_DUPLICATE_WINDOW_MS;
}

function dedupeTimelineItemsForDisplay(items: AgentTimelineItem[]) {
  const deduped: AgentTimelineItem[] = [];
  items.forEach((item) => {
    const previous = deduped[deduped.length - 1];
    if (previous && sameTimelineDisplayEcho(previous, item)) return;
    deduped.push(item);
  });
  return deduped;
}

function timelineBeforeCursor(item: AgentTimelineItem) {
  const seq = timelineSeq(item);
  if (item.created_at) {
    return `before_created_at=${encodeURIComponent(item.created_at)}&before_seq=${seq}`;
  }
  if (Number.isFinite(seq)) return `before=${seq}`;
  return '';
}

function timelineItemUpdatedAtMs(item: AgentTimelineItem) {
  const updatedAt = (item as AgentTimelineItem & { updated_at?: string }).updated_at;
  return parseApiDate(updatedAt ?? item.created_at)?.getTime() ?? 0;
}

function shouldReplaceTimelineItem(existing: AgentTimelineItem, incoming: AgentTimelineItem) {
  const existingUpdatedAt = timelineItemUpdatedAtMs(existing);
  const incomingUpdatedAt = timelineItemUpdatedAtMs(incoming);
  if (incomingUpdatedAt > existingUpdatedAt) return true;
  if (incomingUpdatedAt < existingUpdatedAt) return false;
  const existingText = normalizedTimelineSearchText(existing.text);
  const incomingText = normalizedTimelineSearchText(incoming.text);
  if (!existingText && incomingText) return true;
  if (existingText && !incomingText) return false;
  return true;
}

export function mergeTimelineItems(existing: AgentTimelineItem[], incoming: AgentTimelineItem[]) {
  const bySeq = new Map<number, AgentTimelineItem>();
  [...existing, ...incoming].forEach((item) => {
    const seq = timelineSeq(item);
    const current = bySeq.get(seq);
    if (!current || shouldReplaceTimelineItem(current, item)) {
      bySeq.set(seq, item);
    }
  });
  return sortTimelineItemsByCreatedAt(Array.from(bySeq.values()));
}

function normalizedTimelineSearchText(value: string | null | undefined) {
  return compactText(value ?? '', 8_000).replace(/\s+/g, ' ').trim();
}

function timelineReflectsSessionLastMessage(session: AgentSession | null | undefined, items: AgentTimelineItem[]) {
  const lastMessage = normalizedTimelineSearchText(session?.last_message);
  if (!lastMessage) return true;
  return items.some((item) => {
    const text = normalizedTimelineSearchText(item.text);
    if (!text) return false;
    if (text === lastMessage) return true;
    if (lastMessage.length >= 40 && text.includes(lastMessage)) return true;
    return text.length >= 40 && lastMessage.includes(text);
  });
}

function latestTimelineItemTime(items: AgentTimelineItem[]) {
  return Math.max(0, ...items.map((item) => new Date(item.created_at ?? '').getTime()).filter(Number.isFinite));
}

function isConversationTimelineItem(item: AgentTimelineItem) {
  return ['user_message', 'assistant_message', 'reasoning'].includes(item.item_type);
}

function latestConversationTimelineItemTime(items: AgentTimelineItem[]) {
  return Math.max(
    0,
    ...items
      .filter(isConversationTimelineItem)
      .map((item) => new Date(item.created_at ?? '').getTime())
      .filter(Number.isFinite),
  );
}

function sessionSummaryOutrunsTimeline(session: AgentSession, items: AgentTimelineItem[]) {
  const sessionTime = new Date(session.last_activity_at ?? '').getTime();
  if (!Number.isFinite(sessionTime)) return false;
  const latestConversationTime = latestConversationTimelineItemTime(items);
  if (sessionTime > latestConversationTime) return true;
  return sessionTime === latestConversationTime && latestTimelineItemTime(items) <= latestConversationTime;
}

function optimisticMessageKey(item: AgentTimelineItem) {
  const clientId = item.payload && typeof item.payload.client_id === 'string' ? item.payload.client_id : '';
  return clientId || `${item.session_id}:${compactText(item.text, 400)}:${item.created_at}`;
}

function optimisticMatchesServerItem(pending: AgentTimelineItem, incoming: AgentTimelineItem) {
  const pendingJobId = timelineItemJobId(pending);
  const incomingJobId = timelineItemJobId(incoming);
  return (
    incoming.item_type === 'user_message' &&
    incoming.role === 'user' &&
    ((pendingJobId && incomingJobId && pendingJobId === incomingJobId) ||
      (sameTimelinePrompt(incoming.text, pending.text) && timelineTimesClose(incoming.created_at, pending.created_at)))
  );
}

function isSameOptimisticTimelineItem(left: AgentTimelineItem, right: AgentTimelineItem) {
  return optimisticMessageKey(left) === optimisticMessageKey(right);
}

function resequencePendingTimelineItems(existing: AgentTimelineItem[], pending: AgentTimelineItem[]) {
  const baseSeq = Math.max(0, ...existing.map((item) => Number(item.seq) || 0), OPTIMISTIC_TIMELINE_SEQ_BASE);
  return pending.map((item, index) => ({ ...item, seq: baseSeq + index + 1 }));
}

function timelineFilterFor(item: AgentTimelineItem): TimelineFilter {
  if (item.item_type === 'user_message' || item.item_type === 'assistant_message' || item.item_type === 'reasoning') {
    return 'messages';
  }
  if (item.item_type === 'tool_call') return 'tools';
  return 'events';
}

function isFocusTimelineItem(item: AgentTimelineItem) {
  if (item.item_type === 'tool_call' && requestUserInputTimelineQuestions(item).length > 0) return true;
  return ['user_message', 'assistant_message', 'goal', 'error', 'compaction'].includes(item.item_type);
}

function timelineMatchesFilter(item: AgentTimelineItem, filter: TimelineFilter) {
  if (filter === 'focus') return isFocusTimelineItem(item);
  if (filter === 'all') return true;
  return timelineFilterFor(item) === filter;
}

function timelineTextState(text?: string | null) {
  const raw = String(text ?? '').replace(/<\/?proposed_plan>/gi, '').trim();
  const wasTruncated = raw.includes(AGENTHUB_TRUNCATION_MARKER);
  return {
    value: raw.replace(/\n{0,2}\[AgentHub truncated this item\]\s*$/, '').trimEnd(),
    wasTruncated,
  };
}

function preferredPreviewMode(kind: MessageRenderKind): 'plain' | 'markdown' | 'html' | 'runtime' {
  if (kind === 'html') return 'html';
  if (kind === 'markdown') return 'markdown';
  return 'plain';
}

function decodeLinkPath(value: string) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function stripLinkPathDecorations(value: string) {
  return decodeLinkPath(value.trim()).split('#', 1)[0].split('?', 1)[0].trim();
}

function normalizeWorkspacePath(value: string) {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

export function workspaceJobMatchesTarget(
  job: Job,
  workerId: string,
  workspaceRoot: string,
  workerOs?: string | null,
) {
  if (job.worker_id !== workerId) return false;
  const jobRoot = normalizeWorkspacePath(job.workspace_root ?? '');
  const targetRoot = normalizeWorkspacePath(workspaceRoot);
  if (workerOs?.toLowerCase() === 'windows') {
    return jobRoot.toLowerCase() === targetRoot.toLowerCase();
  }
  return jobRoot === targetRoot;
}

function workspacePathUnderRoot(absolutePath: string, workspaceRoot?: string | null) {
  if (!workspaceRoot) return null;
  const normalizedPath = normalizeWorkspacePath(absolutePath);
  const normalizedRoot = normalizeWorkspacePath(workspaceRoot);
  if (!normalizedRoot) return null;
  const pathKey = normalizedPath.toLowerCase();
  const rootKey = normalizedRoot.toLowerCase();
  if (pathKey === rootKey) return '.';
  if (!pathKey.startsWith(`${rootKey}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function fileHrefToPath(href: string) {
  if (!/^file:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    const pathname = decodeURIComponent(url.pathname);
    return pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
  } catch {
    return null;
  }
}

function isExternalHref(href: string) {
  return /^(https?:|mailto:|tel:)/i.test(href) || href.startsWith('//');
}

function isAbsoluteWorkspacePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/');
}

function isLikelyWorkspaceFile(path: string) {
  return /(?:^|\/)[^/]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(path);
}

function normalizeRelativeWorkspaceFilePath(path: string) {
  const normalized = normalizeWorkspacePath(path).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  if (!isLikelyWorkspaceFile(normalized)) return null;
  return normalized;
}

function workspaceFilePathFromLink(href: string, workspaceRoot?: string | null) {
  const rawHref = stripLinkPathDecorations(href);
  if (!rawHref || rawHref.startsWith('#') || isExternalHref(rawHref)) return null;
  const filePath = fileHrefToPath(rawHref);
  const candidate = filePath ?? rawHref;
  if (isAbsoluteWorkspacePath(candidate)) {
    const relativePath = workspacePathUnderRoot(candidate, workspaceRoot);
    return relativePath ? normalizeRelativeWorkspaceFilePath(relativePath) : null;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(candidate)) return null;
  return normalizeRelativeWorkspaceFilePath(candidate);
}

function TimelineText({
  text,
  allowRenderPreview = false,
  onOpenWorkspaceFile,
}: {
  text?: string | null;
  allowRenderPreview?: boolean;
  onOpenWorkspaceFile?: (href: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const { value, wasTruncated } = timelineTextState(text);
  const shouldCollapse = value.length > 640 || value.split('\n').length > 8;
  const displayText = shouldCollapse && !expanded ? compactText(value, 640) : value;
  const hasText = Boolean(value.trim());
  const detectedKind = useMemo(
    () => (viewerOpen && allowRenderPreview ? detectMessageRenderKind(value) : 'plain'),
    [allowRenderPreview, value, viewerOpen],
  );
  const [viewerMode, setViewerMode] = useState<'plain' | 'markdown' | 'html' | 'runtime'>('plain');
  const canRenderMarkdown = viewerOpen && allowRenderPreview && detectedKind !== 'plain';
  const canRenderHtml = viewerOpen && allowRenderPreview && detectedKind === 'html';
  const shouldRenderMarkdownPreview = viewerOpen && viewerMode === 'markdown' && canRenderMarkdown;
  const shouldRenderHtmlPreview = viewerOpen && viewerMode === 'html' && canRenderHtml;
  const shouldRenderRuntimePreview = viewerOpen && viewerMode === 'runtime' && canRenderHtml;
  const markdownPreview = useMemo(
    () => (shouldRenderMarkdownPreview ? renderMarkdownPreview(value) : ''),
    [shouldRenderMarkdownPreview, value],
  );
  const htmlPreview = useMemo(
    () => (shouldRenderHtmlPreview ? buildSandboxedSrcDoc(sanitizeHtmlPreview(value)) : ''),
    [shouldRenderHtmlPreview, value],
  );
  const runtimeHtmlPreview = useMemo(
    () => (shouldRenderRuntimePreview ? buildSandboxedSrcDoc(sanitizeRunnableHtml(value), { allowScripts: true }) : ''),
    [shouldRenderRuntimePreview, value],
  );
  useEffect(() => {
    setViewerMode(viewerOpen ? preferredPreviewMode(detectedKind) : 'plain');
  }, [detectedKind, viewerOpen]);
  const copyText = async () => {
    if (!hasText) return;
    if (await writeTextToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  const handleMarkdownPreviewClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onOpenWorkspaceFile) return;
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest('a');
    const href = link?.getAttribute('href') || '';
    if (!href || !onOpenWorkspaceFile(href)) return;
    event.preventDefault();
    event.stopPropagation();
    setViewerOpen(false);
  };
  const viewer = (
    <div className="fulltext-backdrop" role="presentation">
      <section className="fulltext-dialog" role="dialog" aria-modal="true" aria-label="全文阅读">
        <header>
          <strong>全文阅读</strong>
          <button className="icon-button" type="button" aria-label="关闭全文阅读" onClick={() => setViewerOpen(false)}>
            <X size={18} />
          </button>
        </header>
        {wasTruncated && <span className="message-truncation-warning">内容已截断</span>}
        {allowRenderPreview && detectedKind !== 'plain' ? (
          <div className="viewer-tabs" role="tablist" aria-label="预览模式">
            <button
              type="button"
              role="tab"
              aria-selected={viewerMode === 'plain'}
              onClick={() => setViewerMode('plain')}
            >
              原文
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewerMode === 'markdown'}
              onClick={() => setViewerMode('markdown')}
            >
              Markdown
            </button>
            {canRenderHtml ? (
              <>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewerMode === 'html'}
                  onClick={() => setViewerMode('html')}
                >
                  HTML
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewerMode === 'runtime'}
                  onClick={() => setViewerMode('runtime')}
                >
                  运行
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {viewerMode === 'plain' ? <pre>{value || '暂无输出'}</pre> : null}
        {viewerMode === 'markdown' ? (
          <div
            className="rich-preview"
            onClick={handleMarkdownPreviewClick}
            dangerouslySetInnerHTML={{ __html: markdownPreview || '<p>暂无输出</p>' }}
          />
        ) : null}
        {viewerMode === 'html' && canRenderHtml ? (
          <iframe className="html-preview-frame" sandbox="" srcDoc={htmlPreview} title="HTML 预览" />
        ) : null}
        {viewerMode === 'runtime' && canRenderHtml ? (
          <>
            <p className="preview-runtime-note">运行模式仅在沙箱 iframe 中执行脚本，不会接触 AgentHub 主界面。</p>
            <iframe
              className="html-preview-frame runtime"
              sandbox="allow-scripts"
              srcDoc={runtimeHtmlPreview}
              title="HTML 运行"
            />
          </>
        ) : null}
        <footer>
          <button className="message-action-button" type="button" onClick={copyText}>
            <Copy size={13} />
            {copied ? '已复制' : '复制全文'}
          </button>
        </footer>
      </section>
    </div>
  );

  return (
    <div className="message-text">
      <p>{displayText || '暂无输出'}</p>
      {wasTruncated && <span className="message-truncation-warning">内容已截断</span>}
      {hasText && (
        <div className="message-actions" aria-label="消息操作">
          {shouldCollapse && (
            <button className="message-action-button" type="button" onClick={() => setExpanded((current) => !current)}>
              {expanded ? '收起' : '展开全文'}
            </button>
          )}
          <button className="message-action-button" type="button" onClick={copyText}>
            <Copy size={13} />
            {copied ? '已复制' : '复制全文'}
          </button>
          <button className="message-action-button" type="button" onClick={() => setViewerOpen(true)}>
            <Maximize2 size={13} />
            全文阅读
          </button>
        </div>
      )}
      {viewerOpen && createPortal(viewer, document.body)}
    </div>
  );
}

function QuestionAnswerForm({
  questions,
  onSubmit,
  onDeny,
  compact = false,
}: {
  questions: PermissionQuestion[];
  onSubmit: (response: Record<string, unknown>) => void;
  onDeny?: () => void;
  compact?: boolean;
}) {
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, PermissionChoice>>({});
  const [freeformText, setFreeformText] = useState<Record<string, string>>({});
  const canSubmit = questions.every((question) => {
    const answer = selectedAnswers[question.id];
    if (!answer) return false;
    return !answer.freeform || Boolean(freeformText[question.id]?.trim());
  });
  const submitAnswers = () => {
    if (!canSubmit) return;
    onSubmit({
      answers: Object.fromEntries(
        questions.map((question) => {
          const answer = selectedAnswers[question.id] as PermissionChoice;
          const text = freeformText[question.id]?.trim() ?? '';
          const label = answer.freeform && text ? `其他：${text}` : answer.label;
          return [
            question.id,
            {
              choice: answer.id,
              label,
              ...(answer.freeform && text ? { text } : {}),
            },
          ];
        }),
      ),
    });
  };

  return (
    <div className="permission-question-stack">
      {questions.map((question) => {
        const selectedAnswer = selectedAnswers[question.id];
        const title = question.header || question.question || question.id;
        return (
          <section className="permission-question" key={question.id}>
            <strong>{title}</strong>
            {question.question && <p>{question.question}</p>}
            <div className="question-options">
              {question.options.map((choice) => {
                const selected = selectedAnswer?.id === choice.id;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    className={selected ? 'selected' : ''}
                    aria-pressed={selected}
                    aria-label={choice.label}
                    onClick={() => setSelectedAnswers((current) => ({ ...current, [question.id]: choice }))}
                  >
                    <span>{choice.label}</span>
                    {choice.description && <small>{choice.description}</small>}
                  </button>
                );
              })}
            </div>
            {selectedAnswer?.freeform && (
              <input
                className="question-freeform-input"
                aria-label={`${title} 的其他内容`}
                value={freeformText[question.id] ?? ''}
                onChange={(event) => setFreeformText((current) => ({ ...current, [question.id]: event.target.value }))}
                placeholder="输入你的其他选择"
              />
            )}
          </section>
        );
      })}
      <div className="permission-actions">
        {onDeny && !compact && (
          <button type="button" onClick={onDeny}>
            暂不处理
          </button>
        )}
        <button className="primary" type="button" disabled={!canSubmit} onClick={submitAnswers}>
          提交选择
        </button>
      </div>
    </div>
  );
}

function RequestUserInputTimeline({
  questions,
  permission,
  onPermission,
}: {
  questions: PermissionQuestion[];
  permission?: AgentPermission;
  onPermission?: (
    permissionId: string,
    action: PermissionAction,
    response?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  if (permission && onPermission) {
    return (
      <QuestionAnswerForm
        questions={questions}
        compact
        onSubmit={(response) => void onPermission(permission.permission_id, 'answer', response)}
      />
    );
  }
  return (
    <div className="request-input-preview">
      <p className="request-input-stale">
        这是历史记录，当前没有可处理交互。刷新后如果顶部仍没有选择卡片，说明该请求已经过期或 worker 尚未同步 active interaction。
      </p>
      {questions.map((question) => (
        <section className="permission-question" key={question.id}>
          <strong>{question.header || question.question || question.id}</strong>
          {question.question && <p>{question.question}</p>}
          <div className="request-input-options">
            {question.options.map((choice) => (
              <span key={choice.id}>
                <b>{choice.label}</b>
                {choice.description && <small>{choice.description}</small>}
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function failureSummary(text?: string | null) {
  const raw = String(text ?? '');
  const value = compactText(raw, 220);
  const lower = raw.toLowerCase();
  if (!value) return '执行失败，展开查看细节';
  if (value.includes("ran out of room in the model's context window") || value.includes('上下文已满')) {
    return '该 Codex 会话上下文已满，需要新开会话或压缩历史后再继续';
  }
  if (raw.includes('INSUFFICIENT_BALANCE') || raw.includes('账户余额不足')) {
    return 'Codex API 余额不足：请充值或切换可用 provider/key 后重试';
  }
  if (lower.includes('invalid_api_key') || lower.includes('incorrect api key')) {
    return 'Codex API Key 无效：请重新登录或更新 OpenAI 兼容 API Key 后重试';
  }
  if (raw.includes('released to unblock queued input')) {
    return 'Worker 超时或失联，系统已释放后续排队输入';
  }
  if (/timed out after/i.test(raw) || /exited\s+(4294967295|-1):/i.test(raw)) {
    return '任务超时或被中断：Codex 已开始执行但没有完成，展开可看最后进度';
  }
  if (value.includes('stdout is not a terminal')) return 'CLI 需要非交互执行模式';
  if (value.includes('skip-git-repo-check')) return '工作目录不是 git 仓库，已加入兼容参数';
  if (value.includes('WinError 2')) return '本机找不到对应 CLI 命令';
  return value.replace(/^.+?exited \d+:\s*/i, '');
}

function jobResultSummary(text?: string | null) {
  const value = compactText(text, 260);
  if (!value) return '等待 worker 回写结果';
  if (/^executed:\s+codex\b/i.test(value) || value.includes('等待 transcript 同步')) {
    return '已送达 Codex，等待 transcript 同步';
  }
  if (/^executed:\s+(claude|kimi)\b/i.test(value)) {
    return '已送达后端 CLI，等待同步';
  }
  return value;
}

function durationLabel(seconds: number) {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${seconds} 秒`;
}

function jobTimeoutSeconds(job: Job) {
  const raw = job.payload?.timeout_seconds;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 3600;
}

function jobStatusHint(job: Job) {
  if (job.status === 'running') {
    return `运行中，超时上限 ${durationLabel(jobTimeoutSeconds(job))}；超过上限后系统会释放后续输入`;
  }
  if (job.status === 'queued') {
    if (typeof job.queue_reason_text === 'string' && job.queue_reason_text.trim()) {
      return job.queue_reason_text.trim();
    }
    if (job.payload?.defer_until_session_ready === true) {
      return '等待当前会话空闲后自动执行';
    }
    return '排队中：同一会话已有作业在运行，会在前一个作业结束或释放后执行';
  }
  if (job.status === 'cancelled') {
    return '这个输入作业已停止，不会继续投递到当前 session';
  }
  return '';
}

function notificationItemsFromState(permissions: AgentPermission[], jobs: Job[]): NotificationInboxItem[] {
  const permissionItems = permissions
    .filter((permission) => permission.status === 'pending')
    .map((permission) => ({
      id: `permission:${permission.permission_id}`,
      title: permission.title || permission.description || '审批待处理',
      body: permission.description || permission.kind || '需要你处理这个请求',
      createdAt: permission.created_at,
      sessionId: permission.session_id,
      permissionId: permission.permission_id,
    }));
  const failedJobItems = jobs
    .filter((job) => job.status === 'failed')
    .map((job) => ({
      id: `job:${job.job_id}`,
      title: `${job.kind} 失败`,
      body: job.error_text || '作业失败，点开查看对应会话',
      createdAt: job.updated_at ?? job.created_at,
      sessionId: job.target_session_id,
    }));
  return [...permissionItems, ...failedJobItems].sort((left, right) => {
    const leftTime = parseApiDate(left.createdAt)?.getTime() ?? 0;
    const rightTime = parseApiDate(right.createdAt)?.getTime() ?? 0;
    return rightTime - leftTime;
  });
}

function timelineLabel(item: AgentTimelineItem) {
  if (item.payload?.agenthub_job_status) return `你 · ${statusLabel(String(item.payload.agenthub_job_status))}`;
  if (item.item_type === 'user_message') return '你';
  if (item.item_type === 'assistant_message') return backendLabel(String(item.role ?? 'Agent'));
  if (item.item_type === 'tool_call') return '工具调用';
  if (item.item_type === 'goal') return '目标';
  if (item.item_type === 'error') return '错误';
  if (item.item_type === 'reasoning') return '推理';
  return '系统事件';
}

function notificationItemsFromRecords(records: NotificationRecord[] = []): NotificationInboxItem[] {
  return records
    .filter((record) => !['dismissed', 'superseded'].includes(record.status))
    .map((record) => ({
      id: record.notification_id,
      title: record.title,
      body: record.body,
      createdAt: record.created_at,
      sessionId: record.session_id,
      permissionId: record.source_type === 'permission' ? record.source_id : null,
      serverStatus: record.status,
    }))
    .sort((left, right) => {
      const leftTime = parseApiDate(left.createdAt)?.getTime() ?? 0;
      const rightTime = parseApiDate(right.createdAt)?.getTime() ?? 0;
      return rightTime - leftTime;
    });
}

export function mergeRevisionedSession(current: AgentSession, incoming: AgentSession): AgentSession {
  const merged = { ...current, ...incoming };
  const currentExecutionRevision = current.execution_status_seq;
  const incomingExecutionRevision = incoming.execution_status_seq;
  if (
    currentExecutionRevision !== undefined &&
    (incomingExecutionRevision === undefined || incomingExecutionRevision < currentExecutionRevision)
  ) {
    merged.status = current.status;
    merged.execution_status = current.execution_status;
    merged.execution_status_source = current.execution_status_source;
    merged.execution_status_seq = current.execution_status_seq;
    merged.execution_status_observed_at = current.execution_status_observed_at;
  }
  const currentAttentionRevision = current.attention_revision;
  const incomingAttentionRevision = incoming.attention_revision;
  if (
    currentAttentionRevision !== undefined &&
    (incomingAttentionRevision === undefined || incomingAttentionRevision < currentAttentionRevision)
  ) {
    merged.attention_status = current.attention_status;
    merged.attention_reason = current.attention_reason;
    merged.attention_revision = current.attention_revision;
    merged.attention_changed_at = current.attention_changed_at;
  }
  return merged;
}

function WorkbenchShell({
  tasks,
  selectedTaskId,
  taskDetail,
  locale,
  onSelectTask,
  onReviewTask,
}: {
  tasks: AgentTask[];
  selectedTaskId: string | null;
  taskDetail: TaskDetail | null;
  locale: LocaleCode;
  onSelectTask: (taskId: string) => void;
  onReviewTask: (action: TaskReviewAction, note?: string) => void;
}) {
  const [filter, setFilter] = useState<TaskInboxFilter>('all');
  const [reviewNote, setReviewNote] = useState('');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const selectedTask = taskDetail?.task ?? tasks.find((task) => task.task_id === selectedTaskId) ?? tasks[0] ?? null;
  const ready = tasks.filter((task) => task.status === 'ready_to_review').length;
  const blocked = tasks.filter((task) => task.status === 'blocked' || task.status === 'needs_approval').length;
  const working = tasks.filter((task) => task.status === 'working' || task.status === 'queued').length;
  const filteredTasks = tasks.filter((task) => {
    if (filter === 'ready') return task.status === 'ready_to_review';
    if (filter === 'blocked') return task.status === 'blocked' || task.status === 'needs_approval';
    if (filter === 'working') return task.status === 'working' || task.status === 'queued';
    return true;
  });
  const statusLabel = (status: string) => {
    const labels: Record<string, [string, string]> = {
      accepted: ['已验收', 'Accepted'],
      archived: ['已归档', 'Archived'],
      blocked: ['已阻塞', 'Blocked'],
      draft: ['草稿', 'Draft'],
      failed: ['失败', 'Failed'],
      needs_approval: ['等待审批', 'Needs approval'],
      queued: ['排队中', 'Queued'],
      ready_to_review: ['待验收', 'Ready to review'],
      rejected: ['已拒绝', 'Rejected'],
      working: ['执行中', 'Working'],
    };
    const label = labels[status];
    return label ? pickLocale(locale, label[0], label[1]) : status;
  };
  const filters: Array<{ key: TaskInboxFilter; label: string; count: number }> = [
    { key: 'ready', label: pickLocale(locale, '待验收', 'Review'), count: ready },
    { key: 'blocked', label: pickLocale(locale, '已阻塞', 'Blocked'), count: blocked },
    { key: 'working', label: pickLocale(locale, '执行中', 'Working'), count: working },
    { key: 'all', label: pickLocale(locale, '全部任务', 'All tasks'), count: tasks.length },
  ];
  const submitReview = (action: TaskReviewAction) => {
    onReviewTask(action, action === 'request_changes' ? reviewNote.trim() : '');
    if (action === 'request_changes') setReviewNote('');
  };
  return (
    <section className={`workbench-layout ${mobileDetailOpen ? 'mobile-task-detail-open' : ''}`} aria-label="Agent Workbench">
      <aside className="task-inbox">
        <div className="task-inbox-head">
          <div>
            <span className="task-eyebrow">Workbench</span>
            <h1>{pickLocale(locale, '任务收件箱', 'Task Inbox')}</h1>
          </div>
        </div>
        <div className="task-status-stack" aria-label="Task status summary">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              className={filter === item.key ? 'selected' : ''}
              aria-pressed={filter === item.key}
              onClick={() => {
                setFilter(item.key);
                setMobileDetailOpen(false);
              }}
            >
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </button>
          ))}
        </div>
      </aside>
      <section className="task-list" aria-label="Tasks">
        <div className="task-list-head">
          <div>
            <strong>{filters.find((item) => item.key === filter)?.label}</strong>
            <span>{filteredTasks.length}</span>
          </div>
        </div>
        {filteredTasks.length === 0 ? (
          <div className="task-empty-state">
            <FileText size={22} />
            <strong>{pickLocale(locale, '这里暂时没有任务', 'No tasks here yet')}</strong>
            <span>{pickLocale(locale, '新建任务，或切换左侧状态查看。', 'Create a task or choose another status.')}</span>
          </div>
        ) : null}
        {filteredTasks.map((task) => (
          <button
            key={task.task_id}
            type="button"
            className={`task-row ${task.task_id === selectedTask?.task_id ? 'selected' : ''}`}
            onClick={() => {
              onSelectTask(task.task_id);
              setMobileDetailOpen(true);
            }}
          >
            <span className={`task-status-dot ${statusClass(task.status)}`} aria-hidden="true" />
            <span className="task-row-copy">
              <strong>{task.title}</strong>
              <small>{task.brief_markdown || pickLocale(locale, '暂无任务说明', 'No task brief')}</small>
              <span className="task-row-meta">
                {backendLabel(task.backend ?? 'agent')} · {statusLabel(task.status)} · {formatRelativeTime(locale, task.updated_at)}
              </span>
            </span>
            <ChevronDown size={16} className="task-row-chevron" aria-hidden="true" />
          </button>
        ))}
      </section>
      <section className="task-detail" aria-label="Task Detail">
        {selectedTask ? (
          <>
            <header className="task-detail-head">
              <button
                type="button"
                className="task-mobile-back"
                aria-label={pickLocale(locale, '返回任务列表', 'Back to task list')}
                onClick={() => setMobileDetailOpen(false)}
              >
                <ArrowLeft size={17} />
                {pickLocale(locale, '返回任务列表', 'Tasks')}
              </button>
              <div>
                <span className="task-eyebrow">
                  {backendLabel(selectedTask.backend ?? 'Agent')} · {selectedTask.target_worker_id ?? pickLocale(locale, '未指定节点', 'No worker')}
                </span>
                <h2>{selectedTask.title}</h2>
                <p>{selectedTask.workspace_root ?? pickLocale(locale, '未指定工作区', 'No workspace')}</p>
              </div>
              <span className={`state-pill ${statusClass(selectedTask.status)}`}>{statusLabel(selectedTask.status)}</span>
            </header>
            <section className="task-detail-section">
              <h3>{pickLocale(locale, '任务说明', 'Brief')}</h3>
              <div className="rich-preview" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(selectedTask.brief_markdown) }} />
            </section>
            {selectedTask.success_criteria_markdown ? (
              <section className="task-detail-section">
                <h3>{pickLocale(locale, '验收标准', 'Success criteria')}</h3>
                <div className="rich-preview" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(selectedTask.success_criteria_markdown) }} />
              </section>
            ) : null}
            <section className="task-detail-section">
              <div className="task-section-heading">
                <h3>{pickLocale(locale, '交付物', 'Artifacts')}</h3>
                <span>{taskDetail?.artifacts.length ?? selectedTask.artifact_count}</span>
              </div>
              {taskDetail?.artifacts.length ? (
                taskDetail.artifacts.map((artifact) => (
                  <article key={artifact.artifact_id} className="artifact-card">
                    <div className="artifact-card-head">
                      <FileText size={16} />
                      <strong>{artifact.title}</strong>
                    </div>
                    <small>{artifact.kind} · v{artifact.version}</small>
                    {artifact.content_markdown ? (
                      <div className="rich-preview" dangerouslySetInnerHTML={{ __html: renderMarkdownPreview(artifact.content_markdown) }} />
                    ) : null}
                  </article>
                ))
              ) : (
                <p className="empty">{pickLocale(locale, 'Agent 完成任务后，交付物会显示在这里。', 'Artifacts will appear when the agent finishes.')}</p>
              )}
            </section>
            <div className="task-review-panel">
              {selectedTask.status === 'ready_to_review' ? (
                <label className="task-review-note">
                  {pickLocale(locale, '返工说明', 'Change request')}
                  <textarea
                    aria-label={pickLocale(locale, '返工说明', 'Change request')}
                    placeholder={pickLocale(locale, '说明需要修改的内容…', 'Describe what needs to change…')}
                    value={reviewNote}
                    onChange={(event) => setReviewNote(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="task-review-actions" role="group" aria-label="Task review actions">
                {selectedTask.status === 'ready_to_review' ? (
                  <>
                    <button type="button" className="task-action-primary" onClick={() => submitReview('accept')}>
                      <Check size={16} />
                      Accept
                    </button>
                    <button type="button" disabled={!reviewNote.trim()} onClick={() => submitReview('request_changes')}>
                      <RotateCcw size={16} />
                      {pickLocale(locale, '要求修改', 'Request changes')}
                    </button>
                  </>
                ) : null}
                {selectedTask.status === 'archived' ? (
                  <button type="button" onClick={() => submitReview('restore')}>
                    <RotateCcw size={16} />
                    {pickLocale(locale, '恢复任务', 'Restore')}
                  </button>
                ) : (
                  <button type="button" onClick={() => submitReview('archive')}>
                    <Archive size={16} />
                    {pickLocale(locale, '归档', 'Archive')}
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="task-detail-empty">
            <FileText size={26} />
            <strong>{pickLocale(locale, '选择一个任务查看详情', 'Select a task to inspect')}</strong>
          </div>
        )}
      </section>
    </section>
  );
}

function App() {
  const isIslandView = new URLSearchParams(window.location.search).get('view') === 'island';
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [appMode, setAppMode] = useState<AppMode>(() => initialAppMode());
  const [mobileModeMenuOpen, setMobileModeMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [taskComposerOpen, setTaskComposerOpen] = useState(false);
  const [taskDraft, setTaskDraft] = useState({
    title: '',
    brief_markdown: '',
    success_criteria_markdown: '',
    target_worker_id: '',
    backend: 'codex',
    workspace_root: '',
    template_key: 'implement_feature' as TaskTemplateKey,
    authority_preset: 'feature' as TaskAuthorityPreset,
    relevant_paths: '',
  });
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [providers, setProviders] = useState<ProviderSnapshot[]>([]);
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [secrets, setSecrets] = useState<AgentSecret[]>([]);
  const [timelineBySession, setTimelineBySession] = useState<Record<string, AgentTimelineItem[]>>({});
  const [timelineHasOlder, setTimelineHasOlder] = useState<Record<string, boolean>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [replyAttachments, setReplyAttachments] = useState<ReplyAttachment[]>([]);
  const [isPreparingAttachment, setIsPreparingAttachment] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
  const [sessionFiltersOpen, setSessionFiltersOpen] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>('overview');
  const [sessionArchiveView, setSessionArchiveView] = useState<SessionArchiveView>('active');
  const [sessionSelectionMode, setSessionSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [revealedSessionActionId, setRevealedSessionActionId] = useState<string | null>(null);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('focus');
  const [replyMode, setReplyMode] = useState<ReplyMode>('direct');
  const [isFastModePending, setIsFastModePending] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('sessions');
  const [mobileSessionActionsOpen, setMobileSessionActionsOpen] = useState(false);
  const [statusDetailsOpen, setStatusDetailsOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [fileWorkerId, setFileWorkerId] = useState('');
  const [fileWorkspaceRoot, setFileWorkspaceRoot] = useState('');
  const [fileWorkspaceView, setFileWorkspaceView] = useState<WorkspaceView>('explorer');
  const [workspaceJobs, setWorkspaceJobs] = useState<Job[]>([]);
  const [fileEditor, setFileEditor] = useState<FileEditorState | null>(null);
  const [isSavingFileEditor, setIsSavingFileEditor] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isTranscriptScrolled, setIsTranscriptScrolled] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => initialThemeMode());
  const [locale, setLocale] = useState<LocaleCode>(() => initialLocale());
  const [settings, setSettings] = useState<AgentHubSettings>(() => defaultSettings());
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>(() => initialVoiceInputMode());
  const [voiceInteractionMode, setVoiceInteractionMode] = useState<VoiceInteractionMode>(() => initialVoiceInteractionMode());
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [notificationPermission, setNotificationPermission] = useState<NotificationState>(() => notificationState());
  const [nativeVersion] = useState<NativeAppVersion | null>(() => nativeAppVersion());
  const [apkUpdates, setApkUpdates] = useState<ApkUpdateStates>({
    webview: { status: 'idle' },
    native: { status: 'idle' },
  });
  const [notificationInboxOpen, setNotificationInboxOpen] = useState(false);
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() => readStoredNotificationIds());
  const [serverNotifications, setServerNotifications] = useState<NotificationRecord[] | null>(null);
  const [dismissedPermissionToastIds, setDismissedPermissionToastIds] = useState<Set<string>>(() => new Set());
  const [focusedPermissionId, setFocusedPermissionId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [isTitleDirty, setIsTitleDirty] = useState(false);
  const [controlsDraft, setControlsDraft] = useState<ControlsDraft>(emptyControls);
  const [isControlsDirty, setIsControlsDirty] = useState(false);
  const controlsDirtyRef = useRef(false);
  const [workerRuntimeDraft, setWorkerRuntimeDraft] = useState<WorkerRuntimeSettingsDraft>(emptyWorkerRuntimeDraft);
  const [isWorkerRuntimeDirty, setIsWorkerRuntimeDirty] = useState(false);
  const workerRuntimeDirtyRef = useRef(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>('none');
  const [launchDraft, setLaunchDraft] = useState<SessionLaunchDraft>(() => emptyLaunchDraft());
  const [workerInstallOpen, setWorkerInstallOpen] = useState(false);
  const [workerInstallDraft, setWorkerInstallDraft] = useState<WorkerInstallDraft>(() =>
    normalizeWorkerInstallDraft(window.location.origin, []),
  );
  const [workerEnrollment, setWorkerEnrollment] = useState<WorkerEnrollmentCreated | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(emptyInviteDraft);
  const [createdInvite, setCreatedInvite] = useState<InviteCreated | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const selectedTaskIdRef = useRef<string | null>(null);
  const sessionsRef = useRef<AgentSession[]>([]);
  const attentionSeenRequestsRef = useRef<Set<string>>(new Set());
  const timelineBySessionRef = useRef<Record<string, AgentTimelineItem[]>>({});
  const hydratedDraftSessionIdRef = useRef<string | null>(null);
  const hydratedWorkerRuntimeIdRef = useRef<string | null>(null);
  const mobilePaneRef = useRef<MobilePane>('sessions');
  const fileWorkspaceViewRef = useRef<WorkspaceView>('explorer');
  const notificationInboxOpenRef = useRef(false);
  const launchModeRef = useRef<LaunchMode>('none');
  const workerInstallOpenRef = useRef(false);
  const applyingMobileHistoryRef = useRef(false);
  const mobileHistoryDepthRef = useRef(0);
  const timelineLoadingRef = useRef<Set<string>>(new Set());
  const deliveredNotificationIdsRef = useRef<Set<string>>(readStoredDeliveredNotificationIds());
  const claimingServerNotificationIdsRef = useRef<Set<string>>(new Set());
  const needsReplyNotificationsPrimed = useRef(false);
  const replyAttachmentsRef = useRef<ReplyAttachment[]>([]);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inboxCursorRef = useRef<Record<SessionArchiveView, string>>({ active: '', archived: '' });
  const permissionCursorRef = useRef('');
  const sessionAfterSeqRef = useRef<Record<string, number>>({});
  const sessionAfterCursorRef = useRef<Record<string, string>>({});
  const selectedTimelineDigestRef = useRef<Record<string, string>>({});
  const transcriptRef = useRef<HTMLElement | null>(null);
  const transcriptSessionRef = useRef<string | null>(null);
  const sessionSwipeStartRef = useRef<{ sessionId: string; x: number; y: number } | null>(null);
  const suppressSessionClickRef = useRef<string | null>(null);
  const shouldScrollTranscriptToBottomRef = useRef(false);
  const transcriptPinnedToBottomRef = useRef(true);
  const preserveTranscriptScrollRef = useRef<{
    sessionId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const pendingOptimisticTimelineRef = useRef<Record<string, AgentTimelineItem[]>>({});
  const fastRefreshRequestedRef = useRef<Set<string>>(new Set());
  const eventsLoadingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number | null>(null);
  const streamingVoiceControllerRef = useRef<StreamingVoiceController | null>(null);
  const streamingVoiceLastTextRef = useRef('');
  const streamingVoiceShouldCommitRef = useRef(false);
  const streamingVoiceStopHandledRef = useRef(false);
  const streamingVoiceManualEditRef = useRef(false);
  const streamingVoiceBaseReplyRef = useRef('');
  const streamingVoiceAppliedTextRef = useRef('');
  const streamingVoiceAudioChunksRef = useRef<Blob[]>([]);
  const streamingVoiceStartedAtRef = useRef<number | null>(null);
  const streamingVoiceStopWaitersRef = useRef<Array<() => void>>([]);
  const [scheduleDraft, setScheduleDraft] = useState({
    name: 'Health check',
    job_kind: 'health_check',
    interval_seconds: 300,
    target_worker_id: '',
  });
  const [secretDraft, setSecretDraft] = useState<SecretDraft>(defaultSecretDraft);
  const text = {
    newSession: pickLocale(locale, '新建会话', 'New Session'),
    syncing: pickLocale(locale, '同步中', 'Syncing'),
    autosync: lastSyncedAt
      ? `${t(locale, 'autosync')} ${formatRelative(lastSyncedAt, locale)}`
      : t(locale, 'autosyncStarting'),
    refreshing: pickLocale(locale, '刷新中', 'Refreshing'),
    refresh: pickLocale(locale, '刷新', 'Refresh'),
    notifications: pickLocale(locale, '通知', 'Notifications'),
    logout: pickLocale(locale, '退出登录', 'Log out'),
    sessionInbox: pickLocale(locale, '会话收件箱', 'Session Inbox'),
    archivedSessions: pickLocale(locale, '会话归档', 'Archived Sessions'),
    activeTab: pickLocale(locale, '收件箱', 'Inbox'),
    archivedTab: pickLocale(locale, '归档', 'Archive'),
    searchPlaceholder: pickLocale(locale, '搜索会话、项目或内容', 'Search sessions, projects, or content'),
    searchLabel: pickLocale(locale, '搜索会话', 'Search sessions'),
    clearSearch: pickLocale(locale, '清空搜索', 'Clear search'),
    sortRecent: pickLocale(locale, '排序：最近活动', 'Sort: recent activity'),
    mobileSessions: pickLocale(locale, '会话', 'Sessions'),
    mobileThread: pickLocale(locale, '对话', 'Chat'),
    mobileFiles: pickLocale(locale, '文件', 'Files'),
    mobileWorkers: pickLocale(locale, '节点', 'Workers'),
    mobileMe: pickLocale(locale, '我的', 'Me'),
    controls: pickLocale(locale, '会话控制', 'Session Controls'),
    preferences: pickLocale(locale, '界面与偏好', 'Interface & Preferences'),
    workerRuntime: pickLocale(locale, 'Worker 默认参数', 'Worker Runtime Defaults'),
  };

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((session) => {
        if (providerFilter !== 'all' && session.backend.toLowerCase() !== providerFilter) return false;
        if (!needle) return true;
        return [
          sessionTitle(session),
          session.activity_summary,
          session.project_name,
          session.backend,
          session.worker_id,
          session.last_message,
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
  }, [providerFilter, query, sessions]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    timelineBySessionRef.current = timelineBySession;
  }, [timelineBySession]);

  const selectedVisibleSessionIds = useMemo(
    () => filteredSessions.map((session) => session.session_id).filter((sessionId) => selectedSessionIds.has(sessionId)),
    [filteredSessions, selectedSessionIds],
  );

  const selectedSession = useMemo(
    () =>
      sessions.find((session) => session.session_id === selectedId) ??
      filteredSessions[0] ??
      sessions[0],
    [filteredSessions, selectedId, sessions],
  );
  const selectedFastMode = useMemo(() => sessionFastMode(selectedSession), [selectedSession]);
  const fileWorker = workers.find((worker) => worker.worker_id === fileWorkerId);

  useEffect(() => {
    if (workers.length === 0) return;
    const currentWorker = workers.find((worker) => worker.worker_id === fileWorkerId);
    if (currentWorker) {
      if (currentWorker.workspace_roots.includes(fileWorkspaceRoot)) return;
      setFileWorkspaceRoot(currentWorker.workspace_roots[0] ?? '');
      return;
    }
    const preferredWorker =
      workers.find((worker) => worker.worker_id === selectedSession?.worker_id) ?? workers[0];
    const preferredRoot =
      preferredWorker.workspace_roots.find((root) => root === selectedSession?.workspace_root) ??
      preferredWorker.workspace_roots[0] ??
      '';
    setFileWorkerId(preferredWorker.worker_id);
    setFileWorkspaceRoot(preferredRoot);
  }, [fileWorkerId, fileWorkspaceRoot, selectedSession?.worker_id, selectedSession?.workspace_root, workers]);

  function updateControlsDraft(updater: ControlsDraft | ((current: ControlsDraft) => ControlsDraft)) {
    controlsDirtyRef.current = true;
    setIsControlsDirty(true);
    setControlsDraft((current) => (typeof updater === 'function' ? updater(current) : updater));
  }

  function updateWorkerRuntimeDraft(
    updater:
      | WorkerRuntimeSettingsDraft
      | ((current: WorkerRuntimeSettingsDraft) => WorkerRuntimeSettingsDraft),
  ) {
    workerRuntimeDirtyRef.current = true;
    setIsWorkerRuntimeDirty(true);
    setWorkerRuntimeDraft((current) => (typeof updater === 'function' ? updater(current) : updater));
  }
  const selectedProvider = useMemo(
    () =>
      selectedSession
        ? providers.find(
            (provider) =>
              provider.worker_id === selectedSession.worker_id && provider.backend === selectedSession.backend,
          ) ?? providers.find((provider) => provider.backend === selectedSession.backend)
        : undefined,
    [providers, selectedSession],
  );
  const selectedTimeline = selectedSession
    ? sessionTimeline(selectedSession, timelineBySession[selectedSession.session_id])
    : [];
  const pendingPermissions = useMemo(
    () => permissions.filter((permission) => permission.status === 'pending'),
    [permissions],
  );
  const runtimeCockpit = useMemo(
    () => projectRuntimeCockpit(sessions, workers, pendingPermissions, tasks),
    [pendingPermissions, sessions, tasks, workers],
  );
  const firstPendingPermission = pendingPermissions[0];
  const visiblePendingPermission =
    pendingPermissions.find((permission) => !dismissedPermissionToastIds.has(permission.permission_id)) ?? null;
  const selectedPermissions = selectedSession
    ? pendingPermissions.filter((permission) => permission.session_id === selectedSession.session_id)
    : [];
  const selectedWorker = selectedSession
    ? workers.find((worker) => worker.worker_id === selectedSession.worker_id)
    : undefined;
  const launchWorker = workers.find((worker) => worker.worker_id === launchDraft.worker_id) ?? workers[0];
  const launchProvider =
    providers.find((provider) => provider.worker_id === launchDraft.worker_id && provider.backend === launchDraft.backend) ??
    providers.find((provider) => provider.backend === launchDraft.backend);
  const taskDraftWorker = workers.find((worker) => worker.worker_id === taskDraft.target_worker_id) ?? workers[0];
  const taskBackendOptions = taskDraftWorker?.reachable_backends ?? [];
  const taskWorkspaceOptions = taskDraftWorker?.workspace_roots ?? [];
  const replyBlockedReason =
    selectedSession && !workerSupportsBackend(selectedWorker, selectedSession)
      ? `当前 worker 不支持 ${backendLabel(selectedSession.backend)}`
      : '';
  const canReply = Boolean(selectedSession && canOperate(user) && !replyBlockedReason);
  const canSendReply = canReply && !isTranscribing && !isPreparingAttachment;
  const visibleSlashCommands = useMemo(
    () => (canReply && replyAttachments.length === 0 ? availableSlashCommands(reply, selectedSession, selectedProvider) : []),
    [canReply, reply, replyAttachments.length, selectedProvider, selectedSession],
  );
  const isRefreshNotice = notice.includes('后台刷新') || notice.startsWith('刷新失败');
  const visibleReplyStatus =
    replyBlockedReason || (notice && !isRefreshNotice && !notice.includes('会话等待回复') ? notice : '');
  const composerHasDraft = reply.trim().length > 0 || replyAttachments.length > 0 || visibleSlashCommands.length > 0;
  const composerCompact =
    !composerExpanded &&
    !composerFocused &&
    !composerHasDraft &&
    !isRecording &&
    !isTranscribing &&
    !isPreparingAttachment;
  const composerFocusedState = !composerExpanded && !composerCompact;
  const threadPaneClassName = `thread-pane ${isTranscriptScrolled && !statusDetailsOpen ? 'is-reading' : ''}`.trim();
  const selectedJobs = selectedSession
    ? jobs
        .filter((job) => job.target_session_id === selectedSession.session_id)
        .sort((left, right) => jobTime(right) - jobTime(left))
    : [];
  const fileJobs = fileWorker && fileWorkspaceRoot
    ? workspaceJobs.filter((job) =>
        workspaceJobMatchesTarget(job, fileWorker.worker_id, fileWorkspaceRoot, fileWorker.os),
      )
    : selectedJobs;
  const selectedCancelableJob = selectedSession ? cancellableSessionInputJob(selectedJobs) : null;
  const selectedTimelineWithJobs = useMemo(
    () => mergeTimelineItems(selectedTimeline, jobTimelineItems(selectedSession, selectedJobs, selectedTimeline)),
    [selectedSession, selectedJobs, selectedTimeline],
  );
  const notificationItems = useMemo(
    () => serverNotifications === null
      ? notificationItemsFromState(permissions, jobs)
      : notificationItemsFromRecords(serverNotifications),
    [jobs, permissions, serverNotifications],
  );
  const effectiveReadNotificationIds = useMemo(() => {
    const next = new Set(readNotificationIds);
    serverNotifications?.forEach((notification) => {
      if (!['pending', 'delivered'].includes(notification.status)) next.add(notification.notification_id);
    });
    return next;
  }, [readNotificationIds, serverNotifications]);
  const unreadNotificationCount = notificationItems.filter((item) => !effectiveReadNotificationIds.has(item.id)).length;
  const compactTimeline = useMemo(
    () => usefulTimelineItems(sortTimelineItemsByCreatedAt(selectedTimelineWithJobs)),
    [selectedTimelineWithJobs],
  );
  const displayTimeline = useMemo(() => dedupeTimelineItemsForDisplay(compactTimeline), [compactTimeline]);
  const timelineFilters = useMemo(() => {
    const counts: Record<TimelineFilter, number> = {
      focus: 0,
      all: displayTimeline.length,
      messages: 0,
      tools: 0,
      events: 0,
    };
    displayTimeline.forEach((item) => {
      if (isFocusTimelineItem(item)) counts.focus += 1;
      counts[timelineFilterFor(item)] += 1;
    });
    return (['focus', 'all', 'messages', 'tools', 'events'] as TimelineFilter[])
      .map((id) => ({ id, label: timelineFilterLabel(locale, id), count: counts[id] }))
      .filter((filter) => filter.id === 'all' || filter.id === 'focus' || filter.count > 0);
  }, [displayTimeline, locale]);
  const visibleTimeline = useMemo(
    () => displayTimeline.filter((item) => timelineMatchesFilter(item, timelineFilter)),
    [displayTimeline, timelineFilter],
  );
  const latestVisibleTimelineKey = useMemo(() => {
    const latest = visibleTimeline[visibleTimeline.length - 1];
    if (!latest) return 'empty';
    return `${latest.seq}:${latest.item_type}:${latest.created_at}:${latest.text}`;
  }, [visibleTimeline]);
  const selectedPermissionStateKey = useMemo(
    () =>
      selectedPermissions.length === 0
        ? 'none'
        : selectedPermissions
            .map((permission) => `${permission.permission_id}:${permission.status}:${permission.resolved_at ?? permission.created_at ?? ''}`)
            .join('|'),
    [selectedPermissions],
  );
  const onlineWorkers = workers.filter((worker) => worker.status === 'online').length;
  const quickReplies = settings.preferences.quick_replies?.filter((item) => item.trim()).slice(0, 12) ?? [];

  function transcriptNearBottom() {
    const transcript = transcriptRef.current;
    if (!transcript) return true;
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 96;
  }

  function updateScrollToBottomState() {
    const transcript = transcriptRef.current;
    if (!transcript) {
      transcriptPinnedToBottomRef.current = true;
      setShowScrollToBottom(false);
      setIsTranscriptScrolled(false);
      return;
    }
    const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 96;
    transcriptPinnedToBottomRef.current = pinned;
    setShowScrollToBottom(!pinned);
    setIsTranscriptScrolled(transcript.scrollTop > 12);
  }

  function scrollTranscriptToBottom(behavior: ScrollBehavior = 'smooth') {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcriptPinnedToBottomRef.current = true;
    transcript.scrollTop = transcript.scrollHeight;
    transcript.scrollTo?.({ top: transcript.scrollHeight, behavior });
    setShowScrollToBottom(false);
  }

  function handleTranscriptScroll() {
    updateScrollToBottomState();
    const transcript = transcriptRef.current;
    const userIsReadingTranscript = Boolean(transcript && transcript.scrollTop > 12);
    if (
      userIsReadingTranscript &&
      composerFocused &&
      !composerExpanded &&
      !composerHasDraft &&
      !isRecording &&
      !isTranscribing &&
      !isPreparingAttachment
    ) {
      setComposerFocused(false);
      replyTextareaRef.current?.blur();
    }
  }

  function handleComposerBlur(event: FocusEvent<HTMLFormElement>) {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setComposerFocused(false);
  }

  function insertQuickReply(value: string) {
    const text = value.trim();
    if (!text || !canReply) return;
    handleReplyChange(reply.trim() ? `${reply.replace(/\s+$/, '')}\n${text}` : text);
    window.setTimeout(() => replyTextareaRef.current?.focus(), 0);
  }

  useLayoutEffect(() => {
    const sessionId = selectedSession?.session_id ?? null;
    const transcript = transcriptRef.current;
    if (!sessionId || !transcript) return;

    if (transcriptSessionRef.current !== sessionId) {
      transcriptSessionRef.current = sessionId;
      shouldScrollTranscriptToBottomRef.current = true;
      preserveTranscriptScrollRef.current = null;
    }

    const preserved = preserveTranscriptScrollRef.current;
    if (preserved && preserved.sessionId === sessionId) {
      const delta = transcript.scrollHeight - preserved.scrollHeight;
      transcript.scrollTop = Math.max(0, preserved.scrollTop + delta);
      preserveTranscriptScrollRef.current = null;
      return;
    }

    if (shouldScrollTranscriptToBottomRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
      if (visibleTimeline.length > 0 || selectedPermissions.length > 0) {
        shouldScrollTranscriptToBottomRef.current = false;
      }
    }
    updateScrollToBottomState();
  }, [selectedSession?.session_id, selectedPermissionStateKey, timelineFilter, latestVisibleTimelineKey]);

  useEffect(() => {
    if (selectedIdRef.current && sessions.some((session) => session.session_id === selectedIdRef.current)) return;
    const nextSelectedId = filteredSessions[0]?.session_id ?? sessions[0]?.session_id ?? null;
    if (nextSelectedId === selectedIdRef.current) return;
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
  }, [filteredSessions, sessions]);

  useEffect(() => {
    const visibleIds = new Set(filteredSessions.map((session) => session.session_id));
    setSelectedSessionIds((current) => {
      const next = new Set(Array.from(current).filter((sessionId) => visibleIds.has(sessionId)));
      return next.size === current.size ? current : next;
    });
  }, [filteredSessions]);

  async function copyTextToClipboard(value: string, successMessage: string) {
    if (!value.trim()) return;
    if (await writeTextToClipboard(value)) {
      setNotice(successMessage);
      return;
    }
    setNotice(value);
  }

  function currentMobileHistoryState(
    overrides: Partial<Omit<MobileHistoryState, 'agenthub'>> = {},
  ): MobileHistoryState {
    return {
      agenthub: MOBILE_HISTORY_STATE,
      mobilePane: overrides.mobilePane ?? mobilePaneRef.current,
      selectedId: overrides.selectedId === undefined ? selectedIdRef.current : overrides.selectedId,
      notificationInboxOpen: overrides.notificationInboxOpen ?? notificationInboxOpenRef.current,
      launchMode: overrides.launchMode ?? launchModeRef.current,
      workerInstallOpen: overrides.workerInstallOpen ?? workerInstallOpenRef.current,
      fileWorkspaceView: overrides.fileWorkspaceView ?? fileWorkspaceViewRef.current,
      depth: overrides.depth ?? mobileHistoryDepthRef.current,
    };
  }

  function mobileHistoryEnabled() {
    return !isIslandView && loadState === 'ready' && typeof window.history?.pushState === 'function';
  }

  function ensureMobileHistoryEntry() {
    if (!mobileHistoryEnabled()) return;
    if (!readMobileHistoryState(window.history.state)) {
      mobileHistoryDepthRef.current = 0;
      window.history.replaceState(currentMobileHistoryState(), '', window.location.href);
    }
  }

  function replaceMobileHistoryState(overrides: Partial<Omit<MobileHistoryState, 'agenthub'>> = {}) {
    if (!mobileHistoryEnabled() || applyingMobileHistoryRef.current) return;
    const next = currentMobileHistoryState(overrides);
    mobileHistoryDepthRef.current = next.depth;
    window.history.replaceState(next, '', window.location.href);
  }

  function pushMobileHistoryState(overrides: Partial<Omit<MobileHistoryState, 'agenthub'>> = {}) {
    if (!mobileHistoryEnabled() || applyingMobileHistoryRef.current) return;
    ensureMobileHistoryEntry();
    const next = currentMobileHistoryState({ ...overrides, depth: mobileHistoryDepthRef.current + 1 });
    if (sameMobileHistoryState(readMobileHistoryState(window.history.state), next)) return;
    window.history.pushState(next, '', window.location.href);
    mobileHistoryDepthRef.current = next.depth;
  }

  function applyMobileHistoryState(state: MobileHistoryState | null) {
    if (!state) return;
    applyingMobileHistoryRef.current = true;
    selectedIdRef.current = state.selectedId;
    mobilePaneRef.current = state.mobilePane;
    notificationInboxOpenRef.current = state.notificationInboxOpen;
    launchModeRef.current = state.launchMode;
    workerInstallOpenRef.current = state.workerInstallOpen;
    fileWorkspaceViewRef.current = state.fileWorkspaceView;
    mobileHistoryDepthRef.current = state.depth;
    setSelectedId(state.selectedId);
    setMobilePane(state.mobilePane);
    setNotificationInboxOpen(state.notificationInboxOpen);
    setLaunchMode(state.launchMode);
    setWorkerInstallOpen(state.workerInstallOpen);
    setFileWorkspaceView(state.fileWorkspaceView);
    if (state.selectedId) {
      void loadTimelineForSession(state.selectedId).catch(() => setNotice('会话详情同步失败，稍后会自动重试'));
    }
    window.setTimeout(() => {
      applyingMobileHistoryRef.current = false;
    }, 0);
  }

  function navigateMobilePane(pane: MobilePane, selectedId?: string | null) {
    const nextSelectedId = selectedId === undefined ? selectedIdRef.current : selectedId;
    mobilePaneRef.current = pane;
    selectedIdRef.current = nextSelectedId;
    notificationInboxOpenRef.current = false;
    launchModeRef.current = 'none';
    workerInstallOpenRef.current = false;
    setMobilePane(pane);
    setSelectedId(nextSelectedId);
    setNotificationInboxOpen(false);
    setLaunchMode('none');
    setWorkerInstallOpen(false);
    pushMobileHistoryState({
      mobilePane: pane,
      selectedId: nextSelectedId,
      notificationInboxOpen: false,
      launchMode: 'none',
      workerInstallOpen: false,
    });
  }

  function handleAndroidNativeBack() {
    if (!mobileHistoryEnabled()) return false;
    const state = readMobileHistoryState(window.history.state);
    if (!state || state.depth <= 0) return false;
    window.history.back();
    return true;
  }

  async function notifyPendingPermission(permission: AgentPermission, count: number) {
    const message = permissionNoticeText(permission, count);
    const body = permission.title || permission.description || '新的审批请求';
    setNotice(message);
    document.title = `(${count}) AgentHub`;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([120, 60, 120]);
    }
    const nativeResult = await notifyNativePendingPermission({
      permissionId: permission.permission_id,
      sessionId: permission.session_id,
      count,
      title: 'AgentHub 需要你处理审批',
      body,
    });
    if (nativeResult === 'scheduled') return;
    if (nativeResult === 'permission-denied') {
      setNotice(`${message}。安卓通知未授权，请点铃铛开启`);
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('AgentHub 需要你处理审批', {
          body,
          tag: permission.permission_id,
        });
      } catch {
        // Some Android WebViews expose Notification but reject construction.
      }
    }
  }

  async function notifyNeedsReplySession(session: AgentSession, count: number) {
    const message = needsReplyNoticeText(session, count);
    const body = needsReplyNotificationBody(session);
    const notificationId = `session:${needsReplyNotificationKey(session)}`;
    setNotice(message);
    document.title = `(${count}) AgentHub`;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([120, 60, 120]);
    }
    const nativeResult = await notifyNativeStatus({
      id: notificationId,
      sessionId: session.session_id,
      title: 'AgentHub 会话等待回复',
      body,
    });
    if (nativeResult === 'scheduled') return;
    if (nativeResult === 'permission-denied') {
      setNotice(`${message}。安卓通知未授权，请点铃铛开启`);
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('AgentHub 会话等待回复', {
          body,
          tag: notificationId,
        });
      } catch {
        // Some Android WebViews expose Notification but reject construction.
      }
    }
  }

  function navigateRemoteWorkspace() {
    setAppMode('session');
    navigateMobilePane('files');
  }

  function changeFileWorkspaceView(view: WorkspaceView, push = view === 'preview') {
    if (view === fileWorkspaceViewRef.current) return;
    fileWorkspaceViewRef.current = view;
    setFileWorkspaceView(view);
    if (push) {
      pushMobileHistoryState({ mobilePane: 'files', fileWorkspaceView: view });
      return;
    }
    replaceMobileHistoryState({ mobilePane: 'files', fileWorkspaceView: view });
  }

  function returnToFileExplorer() {
    const state = readMobileHistoryState(window.history.state);
    if (fileWorkspaceViewRef.current === 'preview' && state && state.depth > 0) {
      window.history.back();
      return;
    }
    changeFileWorkspaceView('explorer', false);
  }

  function rememberDeliveredNotificationIds(ids: string[]) {
    if (ids.length === 0) return;
    const next = new Set(deliveredNotificationIdsRef.current);
    let changed = false;
    ids.forEach((id) => {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    });
    if (!changed) return;
    const trimmed = trimNotificationIds(next);
    deliveredNotificationIdsRef.current = trimmed;
    persistNotificationIds(NOTIFICATION_DELIVERED_STORAGE_KEY, trimmed);
  }

  function alertNewPendingPermissions(nextPermissions: AgentPermission[]) {
    const pending = nextPermissions.filter((permission) => permission.status === 'pending');
    const firstUnseen = pending.find(
      (permission) => !deliveredNotificationIdsRef.current.has(`permission:${permission.permission_id}`),
    );
    rememberDeliveredNotificationIds(pending.map((permission) => `permission:${permission.permission_id}`));
    if (firstUnseen) {
      void notifyPendingPermission(firstUnseen, pending.length);
    }
    if (pending.length === 0) {
      document.title = 'AgentHub';
    }
  }

  function alertNewNeedsReplySessions(nextSessions: AgentSession[], nextPermissions: AgentPermission[]) {
    const pendingPermissionSessions = new Set(
      nextPermissions
        .filter((permission) => permission.status === 'pending')
        .map((permission) => permission.session_id),
    );
    const waitingSessions = nextSessions.filter(
      (session) => session.status === 'needs_reply' && !pendingPermissionSessions.has(session.session_id),
    );
    const activeNotificationIds = waitingSessions.map(
      (session) => `session:${needsReplyNotificationKey(session)}`,
    );
    if (!needsReplyNotificationsPrimed.current) {
      rememberDeliveredNotificationIds(activeNotificationIds);
      needsReplyNotificationsPrimed.current = true;
      return;
    }
    const firstUnseen = waitingSessions.find(
      (session) => !deliveredNotificationIdsRef.current.has(`session:${needsReplyNotificationKey(session)}`),
    );
    rememberDeliveredNotificationIds(activeNotificationIds);
    if (firstUnseen) {
      void notifyNeedsReplySession(firstUnseen, waitingSessions.length);
    }
  }

  function patchServerNotification(nextNotification: NotificationRecord) {
    setServerNotifications((current) =>
      current?.map((notification) =>
        notification.notification_id === nextNotification.notification_id ? nextNotification : notification,
      ) ?? current,
    );
  }

  async function notifyServerLedgerRecord(notification: NotificationRecord) {
    const count = serverNotifications?.filter((item) => ['pending', 'delivered'].includes(item.status)).length ?? 1;
    setNotice(notification.notification_type === 'approval'
      ? `${count} 个审批待处理：${compactText(notification.title, 64)}`
      : notification.title);
    document.title = `(${Math.max(1, count)}) AgentHub`;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([120, 60, 120]);
    }
    const nativeResult = await notifyNativeStatus({
      id: notification.notification_id,
      ...(notification.session_id ? { sessionId: notification.session_id } : {}),
      title: notification.title,
      body: notification.body,
    });
    if (nativeResult === 'scheduled') return;
    if (nativeResult === 'permission-denied') {
      setNotice(`${notification.title}。安卓通知未授权，请点铃铛开启`);
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(notification.title, {
          body: notification.body,
          tag: notification.notification_id,
        });
      } catch {
        // Some Android WebViews expose Notification but reject construction.
      }
    }
  }

  async function claimServerNotification(notification: NotificationRecord) {
    if (!csrfToken || claimingServerNotificationIdsRef.current.has(notification.notification_id)) return;
    claimingServerNotificationIdsRef.current.add(notification.notification_id);
    try {
      const response = await apiPost<{ claimed: boolean; notification: NotificationRecord }>(
        `/api/notifications/${notification.notification_id}/delivered`,
        {},
        csrfToken,
      );
      patchServerNotification(response.notification);
      if (response.claimed) await notifyServerLedgerRecord(response.notification);
    } finally {
      claimingServerNotificationIdsRef.current.delete(notification.notification_id);
    }
  }

  async function loadNotificationLedger() {
    try {
      const payload = await apiGet<{ items?: NotificationRecord[] }>('/api/notifications');
      if (!Array.isArray(payload.items)) {
        setServerNotifications(null);
        return null;
      }
      setServerNotifications(payload.items);
      return payload.items;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        setServerNotifications(null);
        return null;
      }
      setServerNotifications((current) => current ?? []);
      return [];
    }
  }

  async function loadTimelineForSession(sessionId: string, options: { force?: boolean } = {}) {
    if (!options.force && timelineBySessionRef.current[sessionId]) return;
    if (!options.force && timelineLoadingRef.current.has(sessionId)) return;
    const keepPinnedToBottom =
      selectedIdRef.current === sessionId && (transcriptPinnedToBottomRef.current || transcriptNearBottom());
    timelineLoadingRef.current.add(sessionId);
    try {
      const payload = await apiGet<TimelinePayload>(`/api/sessions/${sessionId}/timeline`);
      const merged = mergeServerTimeline(sessionId, timelineBySessionRef.current[sessionId] ?? [], payload.items);
      if (keepPinnedToBottom) {
        shouldScrollTranscriptToBottomRef.current = true;
      }
      setTimelineBySession((current) => ({
        ...current,
        [sessionId]: mergeServerTimeline(sessionId, current[sessionId] ?? [], payload.items),
      }));
      timelineBySessionRef.current = {
        ...timelineBySessionRef.current,
        [sessionId]: merged,
      };
      setTimelineHasOlder((current) => (sessionId in current ? current : { ...current, [sessionId]: Boolean(payload.has_more) }));
      sessionAfterSeqRef.current[sessionId] = payload.next_after_seq ?? Math.max(0, ...merged.map((item) => Number(item.seq) || 0));
      sessionAfterCursorRef.current[sessionId] =
        payload.next_after_cursor || timelineCursorForItems(payload.items) || timelineCursorForItems(merged);
      if (keepPinnedToBottom) {
        window.setTimeout(() => scrollTranscriptToBottom('auto'), 0);
      }
    } finally {
      timelineLoadingRef.current.delete(sessionId);
    }
  }

  async function loadSecretItems(nextUser: User | null) {
    if (!canAdmin(nextUser)) return [];
    try {
      const payload = await apiGet<{ items: AgentSecret[] }>('/api/secrets');
      return payload.items;
    } catch {
      return [];
    }
  }

  async function loadSettings() {
    try {
      const payload = await apiGet<AgentHubSettings>('/api/settings');
      setSettings(payload);
      setLocale(payload.preferences.locale);
      setThemeMode(payload.preferences.theme_mode);
      setVoiceInputMode(payload.preferences.voice_mode);
      setWorkerInstallDraft((current) => ({
        ...current,
        max_concurrent_jobs: payload.worker_runtime_defaults.max_concurrent_jobs,
        job_poll_interval_seconds: payload.worker_runtime_defaults.job_poll_interval_seconds,
        heartbeat_interval_seconds: payload.worker_runtime_defaults.heartbeat_interval_seconds,
      }));
      return payload;
    } catch {
      const payload = defaultSettings();
      setSettings(payload);
      return payload;
    }
  }

  function mergeSessionList(current: AgentSession[], incoming: AgentSession[], removedSessionIds: string[]) {
    const next = new Map(current.map((session) => [session.session_id, session]));
    removedSessionIds.forEach((sessionId) => next.delete(sessionId));
    incoming.forEach((session) => {
      const existing = next.get(session.session_id);
      next.set(session.session_id, existing ? mergeRevisionedSession(existing, session) : session);
    });
    return Array.from(next.values());
  }

  function mergePermissions(current: AgentPermission[], incoming: AgentPermission[]) {
    const next = new Map(current.map((permission) => [permission.permission_id, permission]));
    incoming.forEach((permission) => next.set(permission.permission_id, permission));
    return Array.from(next.values());
  }

  function patchSessionFastMode(
    current: AgentSession[],
    sessionId: string,
    patch: Record<string, unknown>,
  ) {
    return current.map((session) => {
      if (session.session_id !== sessionId) return session;
      const runtimeMetadata =
        session.runtime_metadata && typeof session.runtime_metadata === 'object'
          ? (session.runtime_metadata as Record<string, unknown>)
          : {};
      return {
        ...session,
        runtime_metadata: {
          ...runtimeMetadata,
          fast_mode: {
            ...(runtimeMetadata.fast_mode && typeof runtimeMetadata.fast_mode === 'object'
              ? (runtimeMetadata.fast_mode as Record<string, unknown>)
              : {}),
            ...patch,
          },
        },
      };
    });
  }

  function replaceSessionJobs(current: Job[], sessionId: string, incoming: Job[]) {
    const next = new Map(
      current.filter((job) => job.target_session_id !== sessionId).map((job) => [job.job_id, job]),
    );
    incoming.forEach((job) => next.set(job.job_id, job));
    return Array.from(next.values());
  }

  function inboxCursorForSessions(items: AgentSession[]) {
    if (items.length === 0) return '';
    const ordered = items
      .slice()
      .sort((left, right) =>
        left.updated_at === right.updated_at
          ? left.session_id.localeCompare(right.session_id)
          : new Date(left.updated_at ?? 0).getTime() - new Date(right.updated_at ?? 0).getTime(),
      );
    const tail = ordered[ordered.length - 1];
    return `${tail.updated_at ?? ''}|${tail.session_id}`;
  }

  function timelineCursorForItems(items: AgentTimelineItem[]) {
    const itemUpdatedAt = (item: AgentTimelineItem) => (item as AgentTimelineItem & { updated_at?: string }).updated_at ?? '';
    const ordered = items
      .filter((item) => Number.isFinite(new Date(itemUpdatedAt(item)).getTime()))
      .slice()
      .sort((left, right) => {
        const leftTime = new Date(itemUpdatedAt(left)).getTime();
        const rightTime = new Date(itemUpdatedAt(right)).getTime();
        return leftTime === rightTime ? timelineSeq(left) - timelineSeq(right) : leftTime - rightTime;
      });
    const tail = ordered[ordered.length - 1];
    return tail ? `${itemUpdatedAt(tail)}|${timelineSeq(tail)}` : '';
  }

  function permissionCursorForItems(items: AgentPermission[]) {
    if (items.length === 0) return '';
    const ordered = items
      .slice()
      .sort((left, right) => {
        const leftTime = new Date(left.resolved_at ?? left.created_at).getTime();
        const rightTime = new Date(right.resolved_at ?? right.created_at).getTime();
        return leftTime === rightTime
          ? left.permission_id.localeCompare(right.permission_id)
          : leftTime - rightTime;
      });
    const tail = ordered[ordered.length - 1];
    return `${tail.resolved_at ?? tail.created_at}|${tail.permission_id}`;
  }

  async function loadInboxDelta(archiveView: SessionArchiveView = sessionArchiveView) {
    const params = new URLSearchParams();
    if (archiveView === 'archived') params.set('archived', 'true');
    const cursor = inboxCursorRef.current[archiveView];
    if (cursor) params.set('cursor', cursor);
    const path = params.toString() ? `/api/sync/inbox?${params.toString()}` : '/api/sync/inbox';
    const payload = await apiGet<InboxSyncPayload>(path);
    inboxCursorRef.current[archiveView] = payload.cursor;
    if (payload.items.length === 0 && payload.removed_session_ids.length === 0) return payload;
    const merged = mergeSessionList(sessionsRef.current, payload.items, payload.removed_session_ids);
    if (archiveView === 'active' && serverNotifications === null) {
      alertNewNeedsReplySessions(merged, permissions);
    }
    setSessions((current) => {
      const next = mergeSessionList(current, payload.items, payload.removed_session_ids);
      sessionsRef.current = next;
      return next;
    });
    return payload;
  }

  async function loadPermissionDelta() {
    const params = new URLSearchParams();
    if (permissionCursorRef.current) params.set('cursor', permissionCursorRef.current);
    const path = params.toString() ? `/api/sync/permissions?${params.toString()}` : '/api/sync/permissions';
    const payload = await apiGet<PermissionSyncPayload>(path);
    permissionCursorRef.current = payload.cursor;
    if (payload.items.length === 0) return;
    setPermissions((current) => {
      const next = mergePermissions(current, payload.items);
      if (serverNotifications === null) alertNewPendingPermissions(next);
      return next;
    });
  }

  async function loadSessionDelta(sessionId: string) {
    let afterSeq = sessionAfterSeqRef.current[sessionId] ?? 0;
    let cursor = sessionAfterCursorRef.current[sessionId] || timelineCursorForItems(timelineBySessionRef.current[sessionId] ?? []);
    let payload: SessionSyncPayload | null = null;
    let items: AgentTimelineItem[] = [];
    let jobs: Job[] = [];
    const maxPages = 5;

    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (afterSeq > 0) params.set('after_seq', String(afterSeq));
      const pagePayload = await apiGet<SessionSyncPayload>(`/api/sync/session/${sessionId}?${params.toString()}`);
      payload = pagePayload;
      items = [...items, ...pagePayload.items];
      jobs = pagePayload.jobs;
      const nextCursor = pagePayload.next_after_cursor ?? cursor;
      const nextAfterSeq = pagePayload.next_after_seq;
      const canContinueWithCursor = Boolean(cursor) && Boolean(nextCursor) && nextCursor !== cursor;
      const canContinueWithSeq = !cursor && nextAfterSeq > afterSeq;
      cursor = nextCursor;
      afterSeq = nextAfterSeq;
      if (!pagePayload.has_more || (!canContinueWithCursor && !canContinueWithSeq)) break;
    }

    if (!payload) {
      throw new Error('Session sync returned no payload');
    }
    const keepPinnedToBottom =
      selectedIdRef.current === sessionId && (transcriptPinnedToBottomRef.current || transcriptNearBottom());
    setSessions((current) => {
      const next = mergeSessionList(current, [payload.session], []);
      sessionsRef.current = next;
      return next;
    });
    setJobs((current) => replaceSessionJobs(current, sessionId, jobs));
    if (items.length > 0) {
      if (keepPinnedToBottom) {
        shouldScrollTranscriptToBottomRef.current = true;
      }
      setTimelineBySession((current) => ({
        ...current,
        [sessionId]: mergeServerTimeline(sessionId, current[sessionId] ?? [], items),
      }));
      timelineBySessionRef.current = {
        ...timelineBySessionRef.current,
        [sessionId]: mergeServerTimeline(sessionId, timelineBySessionRef.current[sessionId] ?? [], items),
      };
      if (keepPinnedToBottom) {
        window.setTimeout(() => scrollTranscriptToBottom('auto'), 0);
      }
    }
    sessionAfterSeqRef.current[sessionId] = afterSeq;
    sessionAfterCursorRef.current[sessionId] = cursor || sessionAfterCursorRef.current[sessionId] || '';
    return {
      ...payload,
      items,
      jobs,
      next_after_seq: afterSeq,
      next_after_cursor: cursor,
      has_more: payload.has_more,
    };
  }

  async function loadSyncStatus(sessionId: string | null) {
    const params = new URLSearchParams();
    if (sessionArchiveView === 'archived') params.set('archived', 'true');
    if (sessionId) params.set('selected_session_id', sessionId);
    const path = params.toString() ? `/api/sync/status?${params.toString()}` : '/api/sync/status';
    return apiGet<SyncStatusPayload>(path);
  }

  async function refreshSelectedTimelineIfDigestChanged(sessionId: string, options: { allowFullReload?: boolean } = {}) {
    const statusPayload = await loadSyncStatus(sessionId);
    const nextDigest = statusPayload.selected_timeline_digest || '';
    if (!nextDigest) return;
    const previousDigest = selectedTimelineDigestRef.current[sessionId];
    const hasLoadedTimeline = Boolean(timelineBySessionRef.current[sessionId]);
    if (
      options.allowFullReload &&
      ((previousDigest && previousDigest !== nextDigest) || (!previousDigest && hasLoadedTimeline))
    ) {
      await loadTimelineForSession(sessionId, { force: true });
    }
    selectedTimelineDigestRef.current[sessionId] = nextDigest;
  }

  async function loadEvents() {
    if (eventsLoadingRef.current) return;
    eventsLoadingRef.current = true;
    try {
      const payload = await apiGet<{ items: Event[] }>('/api/events');
      setEvents(payload.items);
    } finally {
      eventsLoadingRef.current = false;
    }
  }

  function openTaskComposer() {
    if (!canOperate(user)) return;
    const worker = workers[0];
    setTaskDraft({
      title: '',
      brief_markdown: '',
      success_criteria_markdown: pickLocale(locale, TASK_TEMPLATES[1].criteriaZh, TASK_TEMPLATES[1].criteriaEn),
      target_worker_id: worker?.worker_id ?? '',
      backend: worker?.reachable_backends?.[0] ?? 'codex',
      workspace_root: worker?.workspace_roots?.[0] ?? '',
      template_key: 'implement_feature',
      authority_preset: 'feature',
      relevant_paths: '',
    });
    setTaskComposerOpen(true);
  }

  async function openTask(taskId: string) {
    selectedTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
    const detail = await apiGet<TaskDetail>(`/api/tasks/${taskId}`);
    setTaskDetail(detail);
  }

  async function loadTasks() {
    const payload = await apiGet<{ items: AgentTask[] }>('/api/tasks');
    setTasks(payload.items);
    const currentTaskId = selectedTaskIdRef.current;
    const nextTaskId = currentTaskId && payload.items.some((task) => task.task_id === currentTaskId)
      ? currentTaskId
      : payload.items[0]?.task_id ?? null;
    selectedTaskIdRef.current = nextTaskId;
    setSelectedTaskId(nextTaskId);
    if (nextTaskId) {
      const detail = await apiGet<TaskDetail>(`/api/tasks/${nextTaskId}`);
      setTaskDetail(detail);
    } else {
      setTaskDetail(null);
    }
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate(user)) return;
    const payload = await apiPost<{ task: AgentTask; job?: Job }>(
      '/api/tasks',
      {
        title: taskDraft.title,
        brief_markdown: taskDraft.brief_markdown,
        success_criteria_markdown: taskDraft.success_criteria_markdown,
        target_worker_id: taskDraft.target_worker_id,
        backend: taskDraft.backend,
        workspace_root: taskDraft.workspace_root,
        template_key: taskDraft.template_key,
        authority_preset: taskDraft.authority_preset,
        relevant_paths: taskDraft.relevant_paths
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean),
        namespace: 'default',
        submit: true,
      },
      csrfToken,
    );
    setTasks((current) => [payload.task, ...current.filter((task) => task.task_id !== payload.task.task_id)]);
    selectedTaskIdRef.current = payload.task.task_id;
    setSelectedTaskId(payload.task.task_id);
    setTaskComposerOpen(false);
    setNotice(pickLocale(locale, '任务已进入队列', 'Task queued'));
    const detail = await apiGet<TaskDetail>(`/api/tasks/${payload.task.task_id}`);
    setTaskDetail(detail);
  }

  async function handleTaskReview(action: TaskReviewAction, note = '') {
    if (!taskDetail || !canOperate(user)) return;
    const payload = await apiPost<{ task: AgentTask }>(
      `/api/tasks/${taskDetail.task.task_id}/review`,
      { action, note_markdown: note },
      csrfToken,
    );
    setTaskDetail((current) => (current ? { ...current, task: payload.task } : current));
    setTasks((current) => current.map((task) => (task.task_id === payload.task.task_id ? payload.task : task)));
    setNotice(pickLocale(locale, '任务状态已更新', 'Task updated'));
  }

  async function loadData(
    nextCsrf?: string,
    nextUser: User | null = user,
    archiveView: SessionArchiveView = sessionArchiveView,
    options: { background?: boolean } = {},
  ) {
    const sessionsPath = archiveView === 'archived' ? '/api/sessions?archived=true' : '/api/sessions';
    const [sessionPayload, workerPayload, jobPayload, schedulePayload, providerPayload, permissionPayload, notificationPayload] = await Promise.all([
      apiGet<{ items: AgentSession[] }>(sessionsPath),
      apiGet<{ items: Worker[] }>('/api/workers'),
      apiGet<{ items: Job[] }>('/api/jobs'),
      apiGet<{ items: Schedule[] }>('/api/schedules'),
      apiGet<{ items: ProviderSnapshot[] }>('/api/providers'),
      apiGet<{ items: AgentPermission[] }>('/api/permissions'),
      loadNotificationLedger(),
    ]);
    const secretItems = options.background ? secrets : await loadSecretItems(nextUser);
    const activeSelectedId = selectedIdRef.current;
    const activeSelectedExists = activeSelectedId
      ? sessionPayload.items.some((session) => session.session_id === activeSelectedId)
      : false;
    const nextSelectedId = activeSelectedExists ? activeSelectedId : sessionPayload.items[0]?.session_id ?? null;
    const keepPinnedToBottom =
      Boolean(nextSelectedId) &&
      nextSelectedId === selectedIdRef.current &&
      (transcriptPinnedToBottomRef.current || transcriptNearBottom());
    const timelinePayload = nextSelectedId
      ? await apiGet<TimelinePayload>(`/api/sessions/${nextSelectedId}/timeline`)
      : { items: [] };
    setSessions(sessionPayload.items);
    setWorkers(workerPayload.items);
    setJobs(jobPayload.items);
    setSchedules(schedulePayload.items);
    setProviders(providerPayload.items);
    setPermissions(permissionPayload.items);
    setSecrets(secretItems);
    if (notificationPayload === null) {
      alertNewPendingPermissions(permissionPayload.items);
      if (archiveView === 'active') {
        alertNewNeedsReplySessions(sessionPayload.items, permissionPayload.items);
      }
    }
    inboxCursorRef.current[archiveView] = inboxCursorForSessions(sessionPayload.items);
    permissionCursorRef.current = permissionCursorForItems(permissionPayload.items);
    setSelectedId((current) => {
      const currentExists = current
        ? sessionPayload.items.some((session) => session.session_id === current)
        : false;
      const resolved = currentExists ? current : nextSelectedId;
      selectedIdRef.current = resolved;
      return resolved;
    });
    setLastSyncedAt(new Date().toISOString());
    await loadTasks().catch((error) => {
      if (String(error.message) !== '404') throw error;
    });
    if (nextSelectedId) {
      sessionAfterSeqRef.current[nextSelectedId] =
        timelinePayload.next_after_seq ?? Math.max(0, ...timelinePayload.items.map((item) => Number(item.seq) || 0));
      sessionAfterCursorRef.current[nextSelectedId] = timelinePayload.next_after_cursor || timelineCursorForItems(timelinePayload.items);
      if (keepPinnedToBottom) {
        shouldScrollTranscriptToBottomRef.current = true;
      }
      setTimelineBySession((current) => ({
        ...current,
        [nextSelectedId]: mergeServerTimeline(nextSelectedId, current[nextSelectedId] ?? [], timelinePayload.items),
      }));
      timelineBySessionRef.current = {
        ...timelineBySessionRef.current,
        [nextSelectedId]: mergeServerTimeline(
          nextSelectedId,
          timelineBySessionRef.current[nextSelectedId] ?? [],
          timelinePayload.items,
        ),
      };
      setTimelineHasOlder((current) => (
        nextSelectedId in current ? current : { ...current, [nextSelectedId]: Boolean(timelinePayload.has_more) }
      ));
      if (keepPinnedToBottom) {
        window.setTimeout(() => scrollTranscriptToBottom('auto'), 0);
      }
    }
    if (nextCsrf) setCsrfToken(nextCsrf);
  }

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setMobileSessionActionsOpen(false);
    setStatusDetailsOpen(false);
    setComposerExpanded(false);
    setFileEditor(null);
  }, [selectedId]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  useEffect(() => {
    try {
      localStorage.setItem(APP_MODE_STORAGE_KEY, appMode);
    } catch {
      // Ignore storage failures in constrained webviews.
    }
    setMobileModeMenuOpen(false);
  }, [appMode]);

  useEffect(() => {
    mobilePaneRef.current = mobilePane;
  }, [mobilePane]);

  useEffect(() => {
    fileWorkspaceViewRef.current = fileWorkspaceView;
  }, [fileWorkspaceView]);

  useEffect(() => {
    notificationInboxOpenRef.current = notificationInboxOpen;
  }, [notificationInboxOpen]);

  useEffect(() => {
    launchModeRef.current = launchMode;
  }, [launchMode]);

  useEffect(() => {
    workerInstallOpenRef.current = workerInstallOpen;
  }, [workerInstallOpen]);

  useEffect(() => {
    if (!mobileHistoryEnabled()) return undefined;
    ensureMobileHistoryEntry();
    const handlePopState = (event: PopStateEvent) => {
      applyMobileHistoryState(readMobileHistoryState(event.state));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [loadState, isIslandView]);

  useEffect(() => {
    window.AgentHubHandleAndroidBack = handleAndroidNativeBack;
    return () => {
      if (window.AgentHubHandleAndroidBack === handleAndroidNativeBack) {
        delete window.AgentHubHandleAndroidBack;
      }
    };
  });

  useEffect(() => {
    if (loadState !== 'ready' || isIslandView) return undefined;
    let active = true;
    let removeListener: (() => void) | null = null;
    void CapacitorApp.addListener('backButton', (event: CapacitorBackButtonEvent) => {
      if (handleAndroidNativeBack()) return;
      if (event.canGoBack && window.history.length > 1) {
        window.history.back();
        return;
      }
      void CapacitorApp.exitApp();
    })
      .then((listener) => {
        if (!active) {
          listener.remove();
          return;
        }
        removeListener = () => listener.remove();
      })
      .catch(() => {
        // The App plugin is unavailable in a plain browser; Android uses the native plugin.
      });
    return () => {
      active = false;
      removeListener?.();
    };
  }, [loadState, isIslandView]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage failures in embedded WebViews.
    }
  }, [themeMode]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore storage failures in embedded WebViews.
    }
  }, [locale]);

  useEffect(() => {
    try {
      localStorage.setItem(VOICE_INPUT_MODE_STORAGE_KEY, voiceInputMode);
    } catch {
      // Ignore storage failures in embedded WebViews.
    }
  }, [voiceInputMode]);

  useEffect(() => {
    try {
      localStorage.setItem(VOICE_INTERACTION_MODE_STORAGE_KEY, voiceInteractionMode);
    } catch {
      // Ignore storage failures in embedded WebViews.
    }
  }, [voiceInteractionMode]);

  useEffect(() => {
    let active = true;
    apiGet<AuthPayload>('/api/auth/me')
      .then(async (payload) => {
        if (!active) return;
        setUser(payload.user);
        setCsrfToken(payload.csrf_token);
        await loadSettings();
        await loadData(payload.csrf_token, payload.user);
        if (active) setLoadState('ready');
      })
      .catch(() => {
        if (active) setLoadState('login');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const nextSessionId = selectedSession?.session_id ?? null;
    const nextTitle = selectedSession ? sessionTitle(selectedSession) : '';
    const nextControls = controlsFromSession(selectedSession);
    if (hydratedDraftSessionIdRef.current !== nextSessionId) {
      hydratedDraftSessionIdRef.current = nextSessionId;
      setTitleDraft(nextTitle);
      setControlsDraft(nextControls);
      setIsTitleDirty(false);
      controlsDirtyRef.current = false;
      setIsControlsDirty(false);
      return;
    }
    if (!isTitleDirty && titleDraft !== nextTitle) {
      setTitleDraft(nextTitle);
    }
    if (!controlsDirtyRef.current && !isControlsDirty && !sameControlsDraft(controlsDraft, nextControls)) {
      setControlsDraft(nextControls);
    }
  }, [
    controlsDraft,
    isControlsDirty,
    isTitleDirty,
    selectedSession?.controls,
    selectedSession?.display_title,
    selectedSession?.session_id,
    titleDraft,
  ]);

  useEffect(() => {
    const nextWorkerId = selectedWorker?.worker_id ?? null;
    const nextDraft = workerRuntimeDraftFromWorker(selectedWorker);
    if (hydratedWorkerRuntimeIdRef.current !== nextWorkerId) {
      hydratedWorkerRuntimeIdRef.current = nextWorkerId;
      setWorkerRuntimeDraft(nextDraft);
      workerRuntimeDirtyRef.current = false;
      setIsWorkerRuntimeDirty(false);
      return;
    }
    if (
      !workerRuntimeDirtyRef.current &&
      !isWorkerRuntimeDirty &&
      !sameWorkerRuntimeDraft(workerRuntimeDraft, nextDraft)
    ) {
      setWorkerRuntimeDraft(nextDraft);
    }
  }, [isWorkerRuntimeDirty, selectedWorker, workerRuntimeDraft]);

  useEffect(() => {
    if (launchMode !== 'none') return;
    if (!launchDraft.worker_id && workers.length > 0) {
      setLaunchDraft(emptyLaunchDraft(workers[0]));
    }
  }, [launchMode, launchDraft.worker_id, workers]);

  useEffect(() => {
    if (!workerInstallOpen) return;
    setWorkerInstallDraft((current) => ({
      ...current,
      api_url: current.api_url || window.location.origin,
      worker_id: current.worker_id || normalizeWorkerInstallDraft(window.location.origin, workers).worker_id,
      label: current.label || current.worker_id || normalizeWorkerInstallDraft(window.location.origin, workers).worker_id,
    }));
  }, [workerInstallOpen, workers]);

  useEffect(() => {
    if (!timelineFilters.some((filter) => filter.id === timelineFilter)) {
      setTimelineFilter('all');
    }
  }, [timelineFilter, timelineFilters]);

  useEffect(() => {
    let cleanupAction: (() => void) | undefined;
    let stopped = false;
    listenForNativeNotificationActions((action) => {
      const sessionId = typeof action.sessionId === 'string' ? action.sessionId : null;
      if (!sessionId) return;
      const permissionId = typeof action.permissionId === 'string' ? action.permissionId : null;
      if (permissionId) setFocusedPermissionId(permissionId);
      openSession(sessionId, 'thread');
      setNotice('');
    })
      .then((cleanup) => {
        if (stopped) cleanup();
        else cleanupAction = cleanup;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      cleanupAction?.();
    };
  }, []);

  useEffect(() => {
    if (!selectedSession || timelineBySession[selectedSession.session_id]) return;
    void loadTimelineForSession(selectedSession.session_id).catch(() => undefined);
  }, [selectedSession?.session_id]);

  useEffect(() => {
    if (!focusedPermissionId || mobilePane !== 'thread') return;
    const target = document.querySelector<HTMLElement>(`[data-permission-id="${focusedPermissionId}"]`);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    setFocusedPermissionId(null);
  }, [focusedPermissionId, mobilePane, selectedSession?.session_id, selectedPermissionStateKey, latestVisibleTimelineKey]);

  useEffect(() => {
    if (loadState === 'ready') startNativeNotificationService();
  }, [loadState]);

  useEffect(() => {
    if (loadState !== 'ready' || serverNotifications === null || !csrfToken) return;
    serverNotifications
      .filter((notification) => notification.status === 'pending')
      .forEach((notification) => void claimServerNotification(notification).catch(() => undefined));
  }, [csrfToken, loadState, serverNotifications]);

  useEffect(() => {
    if (loadState !== 'ready') return;
    void loadEvents().catch(() => undefined);
  }, [loadState]);

  useEffect(() => {
    if (loadState !== 'ready') return undefined;
    let stopped = false;
    let inFlight = false;

    const syncNow = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const selectedSessionId = selectedIdRef.current;
        const selectedBeforeSync =
          selectedSessionId
            ? sessionsRef.current.find((session) => session.session_id === selectedSessionId) ?? null
            : null;
        const inboxDelta = await loadInboxDelta(sessionArchiveView);
        await loadPermissionDelta();
        await loadNotificationLedger();
        if (selectedSessionId) {
          const timelineBeforeDelta = timelineBySessionRef.current[selectedSessionId] ?? [];
          const sessionDelta = await loadSessionDelta(selectedSessionId);
          const selectedInboxSession =
            inboxDelta?.items.find((session) => session.session_id === selectedSessionId) ?? null;
          const selectedSyncedSession = selectedInboxSession ?? sessionDelta.session;
          const summaryChanged =
            Boolean(selectedSyncedSession && selectedBeforeSync) &&
            (
              selectedSyncedSession.last_activity_at !== selectedBeforeSync?.last_activity_at ||
              selectedSyncedSession.last_message !== selectedBeforeSync?.last_message ||
              selectedSyncedSession.activity_summary !== selectedBeforeSync?.activity_summary ||
              selectedSyncedSession.status !== selectedBeforeSync?.status
            );
          const mergedDeltaTimeline = mergeTimelineItems(timelineBeforeDelta, sessionDelta.items);
          const timelineStillMissingSummary =
            summaryChanged && !timelineReflectsSessionLastMessage(selectedSyncedSession, mergedDeltaTimeline);
          const timelineStillBehindSession =
            Boolean(selectedSyncedSession) &&
            sessionSummaryOutrunsTimeline(selectedSyncedSession, mergedDeltaTimeline) &&
            !timelineReflectsSessionLastMessage(selectedSyncedSession, mergedDeltaTimeline);
          if (
            (summaryChanged && (sessionDelta.items.length === 0 || timelineStillMissingSummary)) ||
            timelineStillBehindSession
          ) {
            await loadTimelineForSession(selectedSessionId, { force: true });
          }
          const deltaHasConversationItem = sessionDelta.items.some((item) =>
            ['user_message', 'assistant_message', 'reasoning'].includes(item.item_type),
          );
          await refreshSelectedTimelineIfDigestChanged(selectedSessionId, {
            allowFullReload: sessionDelta.items.length === 0 || !deltaHasConversationItem,
          });
        }
        setLastSyncedAt(new Date().toISOString());
      } catch {
        if (!stopped) setNotice('同步失败，稍后重试');
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => void syncNow(), 15000);
    const handleFocus = () => void syncNow();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void syncNow();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadState, selectedId, sessionArchiveView, user]);

  useEffect(
    () => () => {
      replyAttachmentsRef.current.forEach((attachment) => {
        if (attachment.preview_url) URL.revokeObjectURL(attachment.preview_url);
      });
      replyAttachmentsRef.current = [];
      mediaRecorderRef.current = null;
      recordingStartedAtRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    },
    [],
  );

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = await apiPost<AuthPayload>('/api/auth/login', {
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    flushNativeCookies();
    setUser(payload.user);
    setCsrfToken(payload.csrf_token);
    await loadSettings();
    await loadData(payload.csrf_token);
    setLoadState('ready');
  }

  async function handleRefresh() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setNotice('正在后台刷新，当前会话不会被切换');
    try {
      await loadData();
      void loadEvents().catch(() => undefined);
      setNotice('后台刷新完成');
    } catch (error) {
      setNotice(`刷新失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function handleLocaleChange(nextLocale: LocaleCode) {
    const preferences = await patchPreferences({ locale: nextLocale });
    setNotice(pickLocale(preferences.locale, '语言已更新', 'Language updated'));
  }

  async function handleThemeModeChange(nextTheme: ThemeMode) {
    setThemeMode(nextTheme);
    try {
      await patchPreferences({ theme_mode: nextTheme });
    } catch (error) {
      setNotice(`外观保存失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function handleVoicePreferenceChange(values: Partial<UserPreferences>) {
    await patchPreferences(values);
    setNotice(locale === 'en-US' ? 'Voice defaults saved' : '语音默认项已保存');
  }

  async function handleWorkerRuntimeDefaultsChange(values: Partial<WorkerRuntimeDefaults>) {
    await patchWorkerRuntimeDefaults(values);
    setNotice(locale === 'en-US' ? 'Worker runtime defaults saved' : 'Worker 运行参数已保存');
  }

  async function switchSessionArchiveView(view: SessionArchiveView) {
    if (view === sessionArchiveView) return;
    setSessionArchiveView(view);
    setSessionSelectionMode(false);
    setSelectedSessionIds(new Set());
    selectedIdRef.current = null;
    setSelectedId(null);
    try {
      await loadData(undefined, user, view);
    } catch (error) {
      setNotice(`切换会话视图失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  function openStartSession() {
    launchModeRef.current = 'start';
    notificationInboxOpenRef.current = false;
    setLaunchMode('start');
    setNotificationInboxOpen(false);
    setLaunchDraft(emptyLaunchDraft(workers[0], undefined));
    pushMobileHistoryState({ launchMode: 'start', notificationInboxOpen: false, workerInstallOpen: false });
  }

  function openWorkerInstall() {
    setWorkerEnrollment(null);
    setWorkerInstallDraft(normalizeWorkerInstallDraft(window.location.origin, workers));
    workerInstallOpenRef.current = true;
    notificationInboxOpenRef.current = false;
    setWorkerInstallOpen(true);
    setNotificationInboxOpen(false);
    pushMobileHistoryState({ workerInstallOpen: true, notificationInboxOpen: false, launchMode: 'none' });
  }

  function openInviteDialog() {
    if (!canAdmin(user)) return;
    setInviteDraft(emptyInviteDraft);
    setCreatedInvite(null);
    setInviteOpen(true);
  }

  function openForkSession() {
    if (!selectedSession) return;
    launchModeRef.current = 'fork';
    notificationInboxOpenRef.current = false;
    setLaunchMode('fork');
    setNotificationInboxOpen(false);
    setLaunchDraft(emptyLaunchDraft(selectedWorker ?? workers[0], selectedSession));
    pushMobileHistoryState({ launchMode: 'fork', notificationInboxOpen: false, workerInstallOpen: false });
  }

  function closeLaunchDialog() {
    launchModeRef.current = 'none';
    setLaunchMode('none');
    replaceMobileHistoryState({ launchMode: 'none' });
  }

  function closeWorkerInstall() {
    workerInstallOpenRef.current = false;
    setWorkerInstallOpen(false);
    replaceMobileHistoryState({ workerInstallOpen: false });
  }

  function closeInviteDialog() {
    setInviteOpen(false);
    setCreatedInvite(null);
  }

  function closeNotificationInbox() {
    notificationInboxOpenRef.current = false;
    setNotificationInboxOpen(false);
    replaceMobileHistoryState({ notificationInboxOpen: false });
  }

  async function handleLogout() {
    stopNativeNotificationService();
    await apiPost<{ ok: boolean }>('/api/auth/logout', {}, csrfToken);
    setUser(null);
    setCsrfToken('');
    setSessions([]);
    setWorkers([]);
    setJobs([]);
    setEvents([]);
    setSchedules([]);
    setProviders([]);
    setPermissions([]);
    setSecrets([]);
    setTimelineBySession({});
    pendingOptimisticTimelineRef.current = {};
    selectedIdRef.current = null;
    setSelectedId(null);
    setLoadState('login');
  }

  async function handleLaunchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canOperate(user) || !launchDraft.prompt.trim()) return;
    const payload = {
      worker_id: launchDraft.worker_id,
      backend: launchDraft.backend,
      workspace_root: launchDraft.workspace_root,
      namespace: launchDraft.namespace || 'default',
      prompt: launchDraft.prompt.trim(),
      title: launchDraft.title.trim(),
      controls: controlsFromLaunchDraft(launchDraft),
    };
    if (launchMode === 'fork' && selectedSession) {
      await apiPost<{ job: Job }>(`/api/sessions/${selectedSession.session_id}/fork`, payload, csrfToken);
      setNotice('Fork 已入队');
    } else {
      await apiPost<{ job: Job }>('/api/sessions/start', payload, csrfToken);
      setNotice('新建会话已入队');
    }
    closeLaunchDialog();
    setLaunchDraft((current) => ({ ...current, prompt: '', title: '' }));
    await loadData();
  }

  async function handleProviderAuth(workerId: string, backend: string, action: 'login' | 'logout') {
    if (!canAdmin(user)) return;
    await apiPost<{ job: Job }>(`/api/providers/${workerId}/${backend}/${action}`, {}, csrfToken);
    setNotice(action === 'login' ? `${backendLabel(backend)} 登录任务已创建` : `${backendLabel(backend)} 退出任务已创建`);
    await loadData();
  }

  function archiveConfirmMessage(count: number, archive: boolean) {
    if (archive) {
      return count === 1
        ? t(locale, 'confirmArchiveSingle')
        : t(locale, 'confirmArchiveMany', { count: String(count) });
    }
    return count === 1
      ? t(locale, 'confirmRestoreSingle')
      : t(locale, 'confirmRestoreMany', { count: String(count) });
  }

  async function archiveSessions(sessionIds: string[], archive: boolean) {
    if (sessionIds.length === 0 || !canOperate(user)) return;
    if (!window.confirm(archiveConfirmMessage(sessionIds.length, archive))) return;
    const action = archive ? 'archive' : 'unarchive';
    try {
      for (const sessionId of sessionIds) {
        await apiPost<{ session: AgentSession }>(`/api/sessions/${sessionId}/${action}`, {}, csrfToken);
      }
      if (selectedSession && sessionIds.includes(selectedSession.session_id)) {
        selectedIdRef.current = null;
        setSelectedId(null);
      }
      setSessionSelectionMode(false);
      setSelectedSessionIds(new Set());
      setNotice(
        archive
          ? sessionIds.length > 1
            ? t(locale, 'sessionsArchived', { count: String(sessionIds.length) })
            : t(locale, 'sessionArchived')
          : sessionIds.length > 1
            ? t(locale, 'sessionsRestored', { count: String(sessionIds.length) })
            : t(locale, 'sessionRestored'),
      );
      await loadData(undefined, user, sessionArchiveView);
    } catch (error) {
      setNotice(
        t(locale, 'archiveFailed', {
          action: archive ? t(locale, 'archive') : t(locale, 'restore'),
          message: error instanceof Error ? error.message : t(locale, 'unknownError'),
        }),
      );
    }
  }

  async function handleArchiveSession(archive: boolean) {
    if (!selectedSession || !canOperate(user)) return;
    await archiveSessions([selectedSession.session_id], archive);
  }

  async function handleBatchArchiveSessions(archive: boolean) {
    if (!canOperate(user) || selectedVisibleSessionIds.length === 0) return;
    await archiveSessions(selectedVisibleSessionIds, archive);
  }

  function toggleSessionSelection(sessionId: string) {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }

  function setAllVisibleSessionsSelected(selected: boolean) {
    setSelectedSessionIds(selected ? new Set(filteredSessions.map((session) => session.session_id)) : new Set());
  }

  function handleSessionPointerDown(event: PointerEvent<HTMLElement>, sessionId: string) {
    if (event.pointerType === 'mouse' || sessionSelectionMode || !canOperate(user)) return;
    sessionSwipeStartRef.current = { sessionId, x: event.clientX, y: event.clientY };
  }

  function handleSessionPointerEnd(event: PointerEvent<HTMLElement>, sessionId: string) {
    const start = sessionSwipeStartRef.current;
    sessionSwipeStartRef.current = null;
    if (!start || start.sessionId !== sessionId) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 42 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
    suppressSessionClickRef.current = sessionId;
    setRevealedSessionActionId(deltaX < 0 ? sessionId : null);
  }

  function handleSessionRowClick(sessionId: string) {
    if (suppressSessionClickRef.current === sessionId) {
      suppressSessionClickRef.current = null;
      return;
    }
    if (revealedSessionActionId === sessionId) {
      setRevealedSessionActionId(null);
      return;
    }
    openSession(sessionId);
  }

  async function handleCancelCurrentJob() {
    if (!selectedSession || !selectedCancelableJob || !canOperate(user)) return;
    try {
      const payload = await apiPost<{ job: Job }>(`/api/jobs/${selectedCancelableJob.job_id}/cancel`, {}, csrfToken);
      setJobs((current) => current.map((job) => (job.job_id === payload.job.job_id ? { ...job, ...payload.job } : job)));
      setNotice('当前任务已停止');
      await loadData();
    } catch (error) {
      setNotice(`停止失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  function launchPayloadFromSession(session: AgentSession, prompt: string) {
    return {
      worker_id: session.worker_id,
      backend: session.backend,
      workspace_root: session.workspace_root,
      namespace: session.namespace || 'default',
      prompt,
      title: '',
      controls: controlsFromSession(session),
    };
  }

  async function runLaunchSlashCommand(mode: 'start' | 'fork', prompt: string) {
    if (!selectedSession) return;
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      if (mode === 'fork') openForkSession();
      else openStartSession();
      return;
    }
    const payload = launchPayloadFromSession(selectedSession, normalizedPrompt);
    setReply('');
    setReplyAttachmentsSafely([]);
    if (mode === 'fork') {
      await apiPost<{ job: Job }>(`/api/sessions/${selectedSession.session_id}/fork`, payload, csrfToken);
      setNotice('Fork 已入队');
    } else {
      await apiPost<{ job: Job }>('/api/sessions/start', payload, csrfToken);
      setNotice('新建会话已入队');
    }
    await loadData();
  }

  function providerBackendFromSlashArgument(argument: string) {
    const backend = argument.trim().toLowerCase();
    if (!backend) return selectedSession?.backend ?? '';
    if (['codex', 'claude', 'kimi', 'opencode'].includes(backend)) return backend;
    setNotice('用法：/login、/logout，或指定 /login codex、/logout claude、/login kimi、/login opencode');
    return '';
  }

  async function runProviderAuthSlashCommand(action: 'login' | 'logout', argument: string) {
    if (!selectedSession) return;
    if (!canAdmin(user)) {
      setNotice('Provider 登录/退出需要 admin 权限');
      return;
    }
    const backend = providerBackendFromSlashArgument(argument);
    if (!backend) return;
    setReply('');
    await handleProviderAuth(selectedSession.worker_id, backend, action);
  }

  async function handleCreateWorkerEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin(user)) return;
    const label = workerInstallDraft.label.trim() || workerInstallDraft.worker_id.trim();
    const enrollment = await apiPost<WorkerEnrollmentCreated>(
      '/api/worker-enrollments',
      {
        label,
        expires_in_hours: workerInstallDraft.expires_in_hours,
      },
      csrfToken,
    );
    setWorkerEnrollment(enrollment);
    setNotice(`已生成 worker enrollment：${workerInstallSummary(workerInstallDraft)}`);
  }

  async function handleCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin(user)) return;
    const email = inviteDraft.email.trim();
    if (!email) {
      setNotice('请输入邀请邮箱');
      return;
    }
    const expiresInHours = Math.max(1, Number.parseInt(inviteDraft.expires_in_hours, 10) || 24);
    const invite = await apiPost<InviteCreated>(
      '/api/invites',
      {
        email,
        role: inviteDraft.role,
        expires_in_hours: expiresInHours,
      },
      csrfToken,
    );
    setCreatedInvite(invite);
    setNotice(`邀请已创建：${invite.email}`);
  }

  async function handleNotificationSetup() {
    const nativePermission = await requestNativeNotificationPermission();
    if (nativePermission !== 'unsupported') {
      if (nativePermission === 'granted') {
        const serviceStarted = startNativeNotificationService();
        setNotice(serviceStarted ? '安卓系统通知已开启，后台通知守护已启动' : '安卓系统通知已开启');
        void notifyNativeStatus({
          id: 'setup-check',
          title: 'AgentHub 通知已开启',
          body: '之后需要你审批或选择时会在通知栏和锁屏提醒。',
        });
      } else if (nativePermission === 'denied') {
        setNotice('安卓系统通知被拒绝，需要在系统设置里允许 AgentHub 通知');
      } else {
        setNotice('安卓系统通知暂时不可用，AgentHub 仍会显示页面顶部提醒');
      }
      return;
    }
    if (typeof Notification === 'undefined') {
      setNotificationPermission('unsupported');
      setNotice('当前浏览器不支持系统通知，AgentHub 会在页面顶部提示审批');
      return;
    }
    if (Notification.permission === 'granted') {
      setNotificationPermission('granted');
      setNotice('浏览器通知已开启');
      return;
    }
    if (Notification.permission === 'denied') {
      setNotificationPermission('denied');
      setNotice('浏览器通知被系统拒绝，需要在浏览器或 App 设置里开启');
      return;
    }
    const nextPermission = await Notification.requestPermission();
    setNotificationPermission(nextPermission);
    setNotice(nextPermission === 'granted' ? '浏览器通知已开启' : '浏览器通知未开启，仍会显示页面顶部提醒');
  }

  async function handleCheckApkUpdate() {
    setApkUpdates({ webview: { status: 'checking' }, native: { status: 'checking' } });
    const entries = await Promise.all(
      (Object.keys(ANDROID_DOWNLOAD_CHANNELS) as AndroidDownloadChannelKey[]).map(async (channel) => {
        try {
          const url = apkDownloadUrl(channel);
          let response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
          if (!response.ok) {
            response = await fetch(url, {
              method: 'GET',
              headers: { Range: 'bytes=0-0' },
              cache: 'no-store',
            });
          }
          if (!response.ok) throw new Error(String(response.status));
          return [channel, {
            status: 'ready',
            sizeBytes: apkSizeFromHeaders(response.headers),
            lastModified: response.headers.get('last-modified') ?? undefined,
          } satisfies ApkUpdateState] as const;
        } catch (error) {
          return [channel, { status: 'failed', error: errorMessage(error) } satisfies ApkUpdateState] as const;
        }
      }),
    );
    const nextUpdates = Object.fromEntries(entries) as unknown as ApkUpdateStates;
    setApkUpdates(nextUpdates);
    const failures = entries.filter(([, update]) => update.status === 'failed');
    setNotice(failures.length === 0 ? '已检查 Android 安装包' : `部分安装包检查失败：${failures.map(([channel]) => channel).join(', ')}`);
  }

  async function patchPreferences(values: Partial<UserPreferences>) {
    const payload = await apiPatch<{ preferences: UserPreferences }>('/api/settings/preferences', values, csrfToken);
    setSettings((current) => ({ ...current, preferences: payload.preferences }));
    setLocale(payload.preferences.locale);
    setThemeMode(payload.preferences.theme_mode);
    setVoiceInputMode(payload.preferences.voice_mode);
    return payload.preferences;
  }

  async function patchWorkerRuntimeDefaults(values: Partial<WorkerRuntimeDefaults>) {
    const payload = await apiPatch<{ worker_runtime_defaults: WorkerRuntimeDefaults }>(
      '/api/settings/worker-runtime',
      values,
      csrfToken,
    );
    setSettings((current) => ({ ...current, worker_runtime_defaults: payload.worker_runtime_defaults }));
    setWorkerInstallDraft((current) => ({
      ...current,
      max_concurrent_jobs: payload.worker_runtime_defaults.max_concurrent_jobs,
      job_poll_interval_seconds: payload.worker_runtime_defaults.job_poll_interval_seconds,
      heartbeat_interval_seconds: payload.worker_runtime_defaults.heartbeat_interval_seconds,
    }));
    return payload.worker_runtime_defaults;
  }

  function handleDownloadApk(channel: AndroidDownloadChannelKey) {
    const descriptor = ANDROID_DOWNLOAD_CHANNELS[channel];
    const url = apkDownloadUrl(channel);
    const result = nativeDownloadLatestApk(url, descriptor.filename);
    if (result.startsWith('enqueued:')) {
      setNotice('APK 下载已开始，完成后点系统通知安装');
      return;
    }
    if (result.startsWith('failed:')) {
      window.open(url, '_blank', 'noopener,noreferrer');
      setNotice(`系统下载启动失败，已打开 APK 下载地址：${result.replace(/^failed:/, '')}`);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    setNotice('已打开 APK 下载地址');
  }

  function handleRestartNotificationGuard() {
    setNotice(startNativeNotificationService() ? '后台通知守护已重新启动' : '当前环境没有原生通知守护或通知权限未开启');
  }

  function handleOpenPendingPermission(permission: AgentPermission | null = firstPendingPermission) {
    if (!permission) return;
    setFocusedPermissionId(permission.permission_id);
    openSession(permission.session_id, 'thread');
    setDismissedPermissionToastIds((current) => new Set(current).add(permission.permission_id));
    setNotice('');
  }

  function handleDismissPendingPermissionToast(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setDismissedPermissionToastIds(
      (current) => new Set([...current, ...pendingPermissions.map((permission) => permission.permission_id)]),
    );
  }

  function markNotificationIdsRead(ids: string[]) {
    setReadNotificationIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      const trimmed = trimNotificationIds(next);
      persistNotificationIds(NOTIFICATION_READ_STORAGE_KEY, trimmed);
      return trimmed;
    });
  }

  function handleMarkAllNotificationsRead() {
    markNotificationIdsRead(notificationItems.map((item) => item.id));
    if (serverNotifications !== null) {
      setServerNotifications((current) => current?.map((notification) =>
        ['pending', 'delivered'].includes(notification.status)
          ? { ...notification, status: 'read' as const, read_at: new Date().toISOString() }
          : notification,
      ) ?? current);
      void apiPost('/api/notifications/read-all', {}, csrfToken).catch(() => {
        void loadNotificationLedger().catch(() => undefined);
      });
    }
  }

  function handleOpenNotificationItem(item: NotificationInboxItem) {
    markNotificationIdsRead([item.id]);
    if (serverNotifications !== null) {
      void apiPost<{ notification: NotificationRecord }>(
        `/api/notifications/${item.id}/read`,
        {},
        csrfToken,
      )
        .then((response) => patchServerNotification(response.notification))
        .catch(() => undefined);
      if (item.sessionId) {
        markSessionAttentionSeen(item.sessionId, true);
      }
    }
    closeNotificationInbox();
    if (item.permissionId) {
      const permission = pendingPermissions.find((candidate) => candidate.permission_id === item.permissionId) ?? null;
      if (permission) {
        handleOpenPendingPermission(permission);
        return;
      }
    }
    if (item.sessionId) {
      openSession(item.sessionId, 'thread');
    }
  }

  function showSessionList() {
    const state = readMobileHistoryState(window.history.state);
    if (mobileHistoryEnabled() && state && state.depth > 0) {
      window.history.go(-state.depth);
      return;
    }
    mobilePaneRef.current = 'sessions';
    notificationInboxOpenRef.current = false;
    launchModeRef.current = 'none';
    workerInstallOpenRef.current = false;
    setMobilePane('sessions');
    setNotificationInboxOpen(false);
    setLaunchMode('none');
    setWorkerInstallOpen(false);
    replaceMobileHistoryState({
      mobilePane: 'sessions',
      notificationInboxOpen: false,
      launchMode: 'none',
      workerInstallOpen: false,
      depth: 0,
    });
  }

  function handleOpenSessionList() {
    showSessionList();
    setNotice('');
  }

  function openSession(sessionId: string, pane: MobilePane = 'thread') {
    shouldScrollTranscriptToBottomRef.current = true;
    preserveTranscriptScrollRef.current = null;
    setIsTranscriptScrolled(false);
    markSessionAttentionSeen(sessionId);
    navigateMobilePane(pane, sessionId);
    void loadTimelineForSession(sessionId, { force: true }).catch(() => setNotice('会话详情同步失败，稍后会自动重试'));
  }

  function markSessionAttentionSeen(sessionId: string, force = false) {
    if (attentionSeenRequestsRef.current.has(sessionId)) return;
    const session = sessionsRef.current.find((candidate) => candidate.session_id === sessionId);
    if (!force && session?.attention_status !== 'unseen') return;
    attentionSeenRequestsRef.current.add(sessionId);
    void apiPost<{ session: AgentSession }>(
      `/api/sessions/${sessionId}/attention/seen`,
      {},
      csrfToken,
    )
      .then((response) => patchSession(response.session))
      .catch(() => undefined)
      .finally(() => attentionSeenRequestsRef.current.delete(sessionId));
  }

  async function handleTopbarBellClick() {
    if (notificationItems.length > 0) {
      const nextOpen = !notificationInboxOpenRef.current;
      notificationInboxOpenRef.current = nextOpen;
      setNotificationInboxOpen(nextOpen);
      if (nextOpen) {
        pushMobileHistoryState({ notificationInboxOpen: true });
      } else {
        replaceMobileHistoryState({ notificationInboxOpen: false });
      }
      return;
    }
    await handleNotificationSetup();
  }

  function patchSession(nextSession: AgentSession) {
    setSessions((current) =>
      current.map((session) => (session.session_id === nextSession.session_id ? nextSession : session)),
    );
  }

  function patchWorker(nextWorker: Worker) {
    setWorkers((current) =>
      current.map((worker) => (worker.worker_id === nextWorker.worker_id ? nextWorker : worker)),
    );
  }

  async function handleLoadOlderTimeline() {
    if (!selectedSession || loadingOlder) return;
    const currentTimeline = timelineBySession[selectedSession.session_id] ?? [];
    const oldestItem = sortTimelineItemsByCreatedAt(currentTimeline)[0];
    if (!oldestItem) return;
    const cursor = timelineBeforeCursor(oldestItem);
    if (!cursor) return;
    const transcript = transcriptRef.current;
    preserveTranscriptScrollRef.current = transcript
      ? {
          sessionId: selectedSession.session_id,
          scrollHeight: transcript.scrollHeight,
          scrollTop: transcript.scrollTop,
        }
      : null;
    setLoadingOlder(true);
    setNotice('');
    try {
      const payload = await apiGet<TimelinePayload>(
        `/api/sessions/${selectedSession.session_id}/timeline?${cursor}&limit=100`,
      );
      setTimelineBySession((current) => ({
        ...current,
        [selectedSession.session_id]: mergeTimelineItems(current[selectedSession.session_id] ?? [], payload.items),
      }));
      setTimelineHasOlder((current) => ({ ...current, [selectedSession.session_id]: Boolean(payload.has_more) }));
      if (!payload.has_more && payload.items.length === 0) setNotice('已加载全部可用历史');
    } catch (error) {
      preserveTranscriptScrollRef.current = null;
      setNotice(`加载历史失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setLoadingOlder(false);
    }
  }

  function mergeServerTimeline(sessionId: string, existing: AgentTimelineItem[], incoming: AgentTimelineItem[]) {
    const pending = pendingOptimisticTimelineRef.current[sessionId] ?? [];
    const matchedPending = pending.filter((pendingItem) =>
      incoming.some((incomingItem) => optimisticMatchesServerItem(pendingItem, incomingItem)),
    );
    const existingWithoutPendingOptimistic =
      pending.length > 0
        ? existing.filter((existingItem) => !pending.some((pendingItem) => isSameOptimisticTimelineItem(existingItem, pendingItem)))
        : existing;
    const existingWithoutConfirmedOptimistic =
      matchedPending.length > 0
        ? existingWithoutPendingOptimistic.filter(
            (existingItem) => !matchedPending.some((pendingItem) => isSameOptimisticTimelineItem(existingItem, pendingItem)),
          )
        : existingWithoutPendingOptimistic;
    const mergedIncoming = mergeTimelineItems(existingWithoutConfirmedOptimistic, incoming);
    if (pending.length === 0) return mergedIncoming;
    const remaining = pending.filter(
      (pendingItem) => !matchedPending.some((matchedItem) => isSameOptimisticTimelineItem(pendingItem, matchedItem)),
    );
    if (remaining.length === 0) {
      delete pendingOptimisticTimelineRef.current[sessionId];
      return mergedIncoming;
    }
    pendingOptimisticTimelineRef.current[sessionId] = remaining;
    const synthetic = resequencePendingTimelineItems(mergedIncoming, remaining);
    return mergeTimelineItems(mergedIncoming, synthetic);
  }

  function appendOptimisticUserMessage(item: AgentTimelineItem) {
    shouldScrollTranscriptToBottomRef.current = true;
    setTimelineBySession((current) => ({
      ...current,
      [item.session_id]: mergeTimelineItems(current[item.session_id] ?? [], [item]),
    }));
  }

  function rememberOptimisticUserMessage(item: AgentTimelineItem) {
    const key = optimisticMessageKey(item);
    const current = pendingOptimisticTimelineRef.current[item.session_id] ?? [];
    if (current.some((pendingItem) => optimisticMessageKey(pendingItem) === key)) return;
    pendingOptimisticTimelineRef.current[item.session_id] = [...current, item];
  }

  function replaceOptimisticUserMessage(previous: AgentTimelineItem, next: AgentTimelineItem) {
    const key = optimisticMessageKey(previous);
    setTimelineBySession((current) => ({
      ...current,
      [previous.session_id]: (current[previous.session_id] ?? []).map((timelineItem) =>
        optimisticMessageKey(timelineItem) === key ? next : timelineItem,
      ),
    }));
  }

  function discardOptimisticUserMessage(sessionId: string, item: AgentTimelineItem) {
    const key = optimisticMessageKey(item);
    const pending = pendingOptimisticTimelineRef.current[sessionId] ?? [];
    const nextPending = pending.filter((pendingItem) => optimisticMessageKey(pendingItem) !== key);
    if (nextPending.length > 0) {
      pendingOptimisticTimelineRef.current[sessionId] = nextPending;
    } else {
      delete pendingOptimisticTimelineRef.current[sessionId];
    }
    setTimelineBySession((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).filter((timelineItem) => optimisticMessageKey(timelineItem) !== key),
    }));
  }

  function setReplyAttachmentsSafely(nextAttachments: ReplyAttachment[]) {
    const nextSet = new Set(nextAttachments);
    replyAttachmentsRef.current.forEach((attachment) => {
      if (!nextSet.has(attachment) && attachment.preview_url) URL.revokeObjectURL(attachment.preview_url);
    });
    replyAttachmentsRef.current = nextAttachments;
    setReplyAttachments(nextAttachments);
  }

  function removeReplyAttachment(index: number) {
    setReplyAttachmentsSafely(replyAttachmentsRef.current.filter((_, attachmentIndex) => attachmentIndex !== index));
  }

  async function prepareReplyAttachments(files: File[], options?: { pasted?: boolean }) {
    const current = replyAttachmentsRef.current;
    const availableSlots = maxReplyAttachments - current.length;
    if (availableSlots <= 0) {
      setNotice(`最多同时发送 ${maxReplyAttachments} 个附件`);
      return;
    }
    const selectedFiles = files.slice(0, availableSlots);
    if (files.length > selectedFiles.length) {
      setNotice(`最多同时发送 ${maxReplyAttachments} 个附件，已保留前 ${maxReplyAttachments} 个`);
    }
    const hasOnlyImages = selectedFiles.every((file) => inferReplyAttachmentContentType(file).startsWith('image/'));
    setIsPreparingAttachment(true);
    setNotice(options?.pasted ? '正在处理粘贴图片…' : hasOnlyImages ? '正在处理图片…' : '正在处理附件…');
    try {
      const nextAttachments = await Promise.all(selectedFiles.map((file) => fileToReplyAttachment(file)));
      const seenContent = new Set(current.map(replyAttachmentContentKey));
      const uniqueNextAttachments = nextAttachments.filter((attachment) => {
        const key = replyAttachmentContentKey(attachment);
        if (seenContent.has(key)) {
          if (attachment.preview_url) URL.revokeObjectURL(attachment.preview_url);
          return false;
        }
        seenContent.add(key);
        return true;
      });
      if (uniqueNextAttachments.length === 0) {
        setNotice(options?.pasted ? '这张图片已经在待发送附件里' : '这些附件已经在待发送列表里');
        return;
      }
      setReplyAttachmentsSafely([...current, ...uniqueNextAttachments]);
      setNotice(
        options?.pasted
          ? `已粘贴 ${uniqueNextAttachments.length} 张图片`
          : `已附加 ${uniqueNextAttachments.length} 个文件`,
      );
    } catch (error) {
      setNotice(`附件上传失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsPreparingAttachment(false);
    }
  }

  async function handleReplyAttachment(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    try {
      await prepareReplyAttachments(files);
    } finally {
      input.value = '';
    }
  }

  async function handleReplyPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = pastedImageFiles(event.clipboardData);
    if (images.length === 0) return;
    if (!event.clipboardData.getData('text')) {
      event.preventDefault();
    }
    await prepareReplyAttachments(images, { pasted: true });
  }

  function appendVoiceTranscript(text: string) {
    const normalized = text.trim();
    if (!normalized) return false;
    setReply((current) => (current.trim() ? `${current.trimEnd()}\n${normalized}` : normalized));
    return true;
  }

  function applyStreamingVoicePartial(text: string) {
    const normalized = text.trim();
    const previous = streamingVoiceLastTextRef.current;
    streamingVoiceLastTextRef.current = normalized;
    if (streamingVoiceManualEditRef.current) {
      if (!normalized) return;
      const suffix = normalized.startsWith(previous) ? normalized.slice(previous.length) : '';
      if (!suffix) return;
      setReply((current) => `${current}${suffix}`);
      return;
    }
    streamingVoiceAppliedTextRef.current = normalized;
    setReply(normalized ? `${streamingVoiceBaseReplyRef.current}${normalized}` : streamingVoiceBaseReplyRef.current);
  }

  function resetStreamingVoiceComposerState() {
    streamingVoiceLastTextRef.current = '';
    streamingVoiceBaseReplyRef.current = '';
    streamingVoiceAppliedTextRef.current = '';
    streamingVoiceManualEditRef.current = false;
  }

  function resetStreamingVoiceAudioState() {
    streamingVoiceAudioChunksRef.current = [];
    streamingVoiceStartedAtRef.current = null;
  }

  function resolveStreamingVoiceStopWaiters() {
    const waiters = streamingVoiceStopWaitersRef.current.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  function speakVoiceAssistantReply(text: string) {
    const spoken = text.trim();
    if (!spoken || typeof window.speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.lang = settings.preferences.voice_language || 'zh-CN';
      window.speechSynthesis.speak(utterance);
    } catch {
      // Text feedback remains the source of truth when browser TTS is unavailable.
    }
  }

  async function submitVoiceAssistantTurn(utterance: string) {
    if (!selectedSession) {
      setNotice('请先选择一个会话');
      return;
    }
    setNotice('语音助手正在处理');
    const payload = await apiPost<VoiceTurnResponse>(
      '/api/voice/turn',
      {
        session_id: selectedSession.session_id,
        utterance,
        source: window.AgentHubAndroid ? 'android' : 'web',
      },
      csrfToken,
    );
    const spoken = payload.spoken_text.trim() || (payload.status === 'failed' ? '语音助手处理失败' : '语音助手已处理');
    setNotice(spoken);
    speakVoiceAssistantReply(spoken);
    await Promise.allSettled([
      loadInboxDelta(sessionArchiveView),
      loadPermissionDelta(),
      loadSessionDelta(selectedSession.session_id),
    ]);
  }

  async function stopStreamingVoiceRecording(options?: { commit?: boolean; notice?: string }) {
    if (!isRecording || voiceInputMode !== 'streaming') return;
    const controller = streamingVoiceControllerRef.current;
    streamingVoiceShouldCommitRef.current = options?.commit ?? true;
    if (!controller) {
      await finalizeStreamingVoice();
      return;
    }
    if (options?.notice) setNotice(options.notice);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      streamingVoiceStopWaitersRef.current.push(finish);
      controller.stop();
      window.setTimeout(() => {
        const index = streamingVoiceStopWaitersRef.current.indexOf(finish);
        if (index >= 0) streamingVoiceStopWaitersRef.current.splice(index, 1);
        finish();
      }, 2500);
    });
  }

  async function transcribeRecordedAudio(contentType: string) {
    const chunks = audioChunksRef.current;
    audioChunksRef.current = [];
    const startedAt = recordingStartedAtRef.current;
    recordingStartedAtRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
    if (chunks.length === 0) {
      setNotice('没有录到声音');
      return;
    }
    const audioBlob = new Blob(chunks, { type: contentType || 'audio/webm' });
    const durationMs = startedAt === null ? null : Math.max(0, Math.round(Date.now() - startedAt));
    if (audioBlob.size > MAX_VOICE_AUDIO_BYTES) {
      setNotice('录音太长：当前语音超过 12MB，请分段录音后再识别。');
      return;
    }
    setIsTranscribing(true);
    try {
      setNotice(
        voiceInteractionMode === 'assistant'
          ? '正在识别语音，稍后交给语音助手处理'
          : '正在识别语音；你可以继续输入，结果会追加到当前输入末尾',
      );
      const payload = await apiPost<{ text: string }>(
        '/api/voice/transcribe',
        {
          filename: contentType.includes('mp4') ? 'voice.m4a' : 'voice.webm',
          content_type: audioBlob.type || 'audio/webm',
          data_base64: arrayBufferToBase64(await audioBlob.arrayBuffer()),
          duration_ms: durationMs,
          chunk_count: chunks.length,
          language: settings.preferences.voice_language || 'zh-CN',
        },
        csrfToken,
      );
      const text = payload.text.trim();
      if (!text) {
        setNotice('没有识别到文字');
        return;
      }
      if (voiceInteractionMode === 'assistant') {
        try {
          await submitVoiceAssistantTurn(text);
        } catch (error) {
          setNotice(`语音助手处理失败：${errorMessage(error)}`);
        }
        return;
      }
      appendVoiceTranscript(text);
      setNotice('语音已转文字');
    } catch (error) {
      setNotice(voiceTranscribeFailureNotice(error));
    } finally {
      setIsTranscribing(false);
    }
  }

  async function transcribeStreamingFallbackAudio() {
    const chunks = streamingVoiceAudioChunksRef.current;
    if (chunks.length === 0) return false;
    const contentType = chunks.find((chunk) => chunk.type)?.type || 'audio/webm';
    const audioBlob = new Blob(chunks, { type: contentType });
    const startedAt = streamingVoiceStartedAtRef.current;
    const durationMs = startedAt === null ? null : Math.max(0, Math.round(Date.now() - startedAt));
    if (audioBlob.size > MAX_VOICE_AUDIO_BYTES) {
      setNotice('录音太长：当前语音超过 12MB，请切到标准模式分段录音。');
      return true;
    }
    setIsTranscribing(true);
    try {
      setNotice('流式识别没有拿到文字，正在用标准识别补救');
      const payload = await apiPost<{ text: string }>(
        '/api/voice/transcribe',
        {
          filename: contentType.includes('mp4') ? 'voice.m4a' : 'voice.webm',
          content_type: audioBlob.type || 'audio/webm',
          data_base64: arrayBufferToBase64(await audioBlob.arrayBuffer()),
          duration_ms: durationMs,
          chunk_count: chunks.length,
          language: settings.preferences.voice_language || 'zh-CN',
        },
        csrfToken,
      );
      const text = payload.text.trim();
      if (!text) {
        setNotice('没有识别到文字');
        return true;
      }
      appendVoiceTranscript(text);
      setNotice('语音已转文字');
      return true;
    } catch (error) {
      setNotice(voiceTranscribeFailureNotice(error));
      return true;
    } finally {
      setIsTranscribing(false);
    }
  }

  async function fetchVoiceStreamAuth() {
    return apiPost<VoiceStreamAuthResponse>('/api/voice/stream-auth', {}, csrfToken);
  }

  async function finalizeStreamingVoice() {
    if (streamingVoiceStopHandledRef.current) return;
    streamingVoiceStopHandledRef.current = true;
    setIsRecording(false);
    streamingVoiceControllerRef.current = null;
    const text = streamingVoiceLastTextRef.current.trim();
    const shouldCommit = streamingVoiceShouldCommitRef.current;
    streamingVoiceShouldCommitRef.current = false;
    resetStreamingVoiceComposerState();
    if (!shouldCommit) {
      resetStreamingVoiceAudioState();
      resolveStreamingVoiceStopWaiters();
      return;
    }
    if (!text) {
      const fallbackAttempted = await transcribeStreamingFallbackAudio();
      resetStreamingVoiceAudioState();
      resolveStreamingVoiceStopWaiters();
      if (fallbackAttempted) return;
      setNotice('没有识别到文字');
      return;
    }
    resetStreamingVoiceAudioState();
    resolveStreamingVoiceStopWaiters();
    setNotice('流式语音已转文字');
  }

  async function startStandardVoiceRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice('当前环境不支持录音');
      return;
    }
    const nativeStateBeforeRequest = nativeMicrophonePermissionState();
    if (nativeStateBeforeRequest === 'denied') {
      const alreadyGranted = requestNativeMicrophonePermission();
      if (!alreadyGranted) {
        setNotice('已向安卓请求麦克风权限。允许后再点一次语音。');
        return;
      }
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(voiceMediaConstraints());
    } catch (error) {
      setIsRecording(false);
      setNotice(recordingFailureNotice(error, nativeMicrophonePermissionState()));
      return;
    }

    try {
      const recorder = createAudioRecorder(stream);
      audioChunksRef.current = [];
      mediaStreamRef.current = stream;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => void transcribeRecordedAudio(recorder.mimeType || 'audio/webm');
      mediaRecorderRef.current = recorder;
      recordingStartedAtRef.current = Date.now();
      recorder.start(250);
      setIsRecording(true);
      setNotice('正在录音');
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      mediaRecorderRef.current = null;
      recordingStartedAtRef.current = null;
      setIsRecording(false);
      setNotice(recorderSetupFailureNotice(error));
    }
  }

  async function startStreamingVoiceRecording() {
    const nativeStateBeforeRequest = nativeMicrophonePermissionState();
    if (nativeStateBeforeRequest === 'denied') {
      const alreadyGranted = requestNativeMicrophonePermission();
      if (!alreadyGranted) {
        setNotice('已向安卓请求麦克风权限。允许后再点一次语音。');
        return;
      }
    }
    setIsTranscribing(true);
    resetStreamingVoiceComposerState();
    resetStreamingVoiceAudioState();
    streamingVoiceBaseReplyRef.current = reply.trim() ? `${reply.trimEnd()}\n` : '';
    streamingVoiceShouldCommitRef.current = false;
    streamingVoiceStopHandledRef.current = false;
    try {
      const auth = await fetchVoiceStreamAuth();
      const controller = await startStreamingVoice({
        auth,
        mediaConstraints: voiceMediaConstraints(),
        onStart: () => {
          if (streamingVoiceStartedAtRef.current === null) streamingVoiceStartedAtRef.current = Date.now();
          setIsRecording(true);
          setNotice('正在流式识别语音');
        },
        onAudioChunk: (chunk) => {
          if (chunk.size > 0) streamingVoiceAudioChunksRef.current.push(chunk);
        },
        onPartialText: (text) => {
          const normalized = String(text || '').trim();
          applyStreamingVoicePartial(normalized);
          if (normalized) setNotice('正在流式识别语音');
        },
        onRecovering: (attempt) => {
          setNotice(`流式语音连接中断，正在第 ${attempt} 次重连…`);
        },
        onClose: () => {
          void finalizeStreamingVoice();
        },
        onError: () => {
          setIsRecording(false);
          streamingVoiceControllerRef.current = null;
          streamingVoiceShouldCommitRef.current = false;
          resetStreamingVoiceComposerState();
          resetStreamingVoiceAudioState();
          resolveStreamingVoiceStopWaiters();
          setNotice('流式语音连接中断，请重试；如仍失败可切到标准模式。');
        },
      });
      streamingVoiceControllerRef.current = controller;
      setNotice('正在流式识别语音');
    } catch (error) {
      streamingVoiceControllerRef.current = null;
      resetStreamingVoiceComposerState();
      resetStreamingVoiceAudioState();
      resolveStreamingVoiceStopWaiters();
      const message = errorMessage(error);
      if (message.includes('not configured')) {
        setNotice('流式语音未配置完成，请先切到标准模式，或补齐服务端 Doubao streaming 凭据。');
      } else {
        setNotice(`流式语音启动失败：${message}`);
      }
    } finally {
      setIsTranscribing(false);
    }
  }

  async function handleVoiceToggle() {
    if (isRecording) {
      if (voiceInteractionMode === 'dictation' && voiceInputMode === 'streaming') {
        await stopStreamingVoiceRecording({ commit: true, notice: '正在结束流式录音' });
        return;
      }
      const recorder = mediaRecorderRef.current;
      if (recorder && typeof recorder.requestData === 'function') {
        try {
          recorder.requestData();
        } catch {
          // Some WebViews throw when requestData races with stop; the final stop still happens below.
        }
      }
      recorder?.stop();
      return;
    }
    if (voiceInteractionMode === 'assistant') {
      await startStandardVoiceRecording();
      return;
    }
    if (voiceInputMode === 'streaming') {
      await startStreamingVoiceRecording();
      return;
    }
    await startStandardVoiceRecording();
  }

  function handleReplyChange(nextValue: string) {
    if (isRecording && voiceInputMode === 'streaming') {
      const applied = streamingVoiceAppliedTextRef.current;
      const expected = `${streamingVoiceBaseReplyRef.current}${applied}`;
      if (!streamingVoiceManualEditRef.current && nextValue === expected) {
        setReply(nextValue);
        return;
      }
      if (!streamingVoiceManualEditRef.current && applied && nextValue.endsWith(applied)) {
        streamingVoiceBaseReplyRef.current = nextValue.slice(0, nextValue.length - applied.length);
      } else {
        streamingVoiceManualEditRef.current = true;
        streamingVoiceBaseReplyRef.current = nextValue;
        streamingVoiceAppliedTextRef.current = '';
      }
    }
    setReply(nextValue);
  }

  async function waitForSessionJobCompletion(sessionId: string, jobId: string, options?: { attempts?: number; delayMs?: number }) {
    const attempts = options?.attempts ?? 15;
    const delayMs = options?.delayMs ?? 250;
    let latestPayload: SessionSyncPayload | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latestPayload = await loadSessionDelta(sessionId);
      const matched = latestPayload.jobs.find((job) => job.job_id === jobId);
      if (matched && !['queued', 'running'].includes(matched.status)) return matched;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
    return latestPayload?.jobs.find((job) => job.job_id === jobId) ?? null;
  }

  function rememberWorkspaceJob(nextJob: Job) {
    setWorkspaceJobs((current) => {
      const existingIndex = current.findIndex((job) => job.job_id === nextJob.job_id);
      if (existingIndex < 0) return [nextJob, ...current];
      return current.map((job, index) => (index === existingIndex ? { ...job, ...nextJob } : job));
    });
  }

  async function waitForWorkspaceJobCompletion(jobId: string, options?: { attempts?: number; delayMs?: number }) {
    const attempts = options?.attempts ?? 20;
    const delayMs = options?.delayMs ?? 300;
    let matched: Job | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const payload = await apiGet<{ job: Job }>(`/api/jobs/${jobId}`);
      matched = payload.job;
      rememberWorkspaceJob(matched);
      if (!['queued', 'running'].includes(matched.status)) return matched;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }
    }
    return matched;
  }

  async function refreshSelectedSessionFastMode(options?: { silent?: boolean; force?: boolean }) {
    if (!selectedSession || !canOperate(user)) return;
    if (selectedSession.backend.toLowerCase() !== 'codex') return;
    if (isFastModePending) return;
    const requestKey = selectedSession.session_id;
    if (!options?.force && fastRefreshRequestedRef.current.has(requestKey)) return;
    fastRefreshRequestedRef.current.add(requestKey);
    setIsFastModePending(true);
    if (!options?.silent) setNotice(pickLocale(locale, '正在读取原生 /fast 状态', 'Reading native /fast state'));
    try {
      const response = await apiPost<{ job: Job; session: AgentSession }>(
        `/api/sessions/${selectedSession.session_id}/fast/refresh`,
        {},
        csrfToken,
      );
      setSessions((current) => mergeSessionList(current, [response.session], []));
      const finished = await waitForSessionJobCompletion(selectedSession.session_id, response.job.job_id, { attempts: 12, delayMs: 1000 });
      if (finished?.status === 'failed') {
        setSessions((current) => patchSessionFastMode(current, selectedSession.session_id, fastModeFailureMetadata(finished.error_text)));
        setNotice(finished.error_text || pickLocale(locale, '读取 /fast 状态失败', 'Failed to read /fast state'));
      } else if (!finished || ['queued', 'running'].includes(finished.status)) {
        if (!options?.silent) {
          setNotice(pickLocale(locale, '已提交 /fast 状态同步，稍后更新', 'Fast state sync queued; it will update shortly'));
        }
      } else if (!options?.silent) {
        setNotice(pickLocale(locale, '已刷新 /fast 状态', 'Fast state refreshed'));
      }
    } catch (error) {
      if (!options?.silent) setNotice(`读取 /fast 状态失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsFastModePending(false);
    }
  }

  async function handleToggleFastMode(enabled: boolean, options?: { silent?: boolean }) {
    if (!selectedSession || !canOperate(user)) return;
    if (selectedSession.backend.toLowerCase() !== 'codex') {
      setNotice(pickLocale(locale, '只有 Codex session 支持原生 /fast', 'Only Codex sessions support native /fast'));
      return;
    }
    if (isFastModePending) return;
    setIsFastModePending(true);
    setNotice(
      enabled
        ? pickLocale(locale, '正在开启原生 /fast', 'Enabling native /fast')
        : pickLocale(locale, '正在关闭原生 /fast', 'Disabling native /fast'),
    );
    try {
      const response = await apiPost<{ job: Job; session: AgentSession }>(
        `/api/sessions/${selectedSession.session_id}/fast`,
        { enabled },
        csrfToken,
      );
      setSessions((current) => mergeSessionList(current, [response.session], []));
      const finished = await waitForSessionJobCompletion(selectedSession.session_id, response.job.job_id, { attempts: 12, delayMs: 1000 });
      if (finished?.status === 'failed') {
        setSessions((current) => patchSessionFastMode(current, selectedSession.session_id, fastModeFailureMetadata(finished.error_text)));
        setNotice(finished.error_text || pickLocale(locale, '切换 /fast 失败', 'Failed to toggle /fast'));
        return;
      }
      if (!finished || ['queued', 'running'].includes(finished.status)) {
        setNotice(pickLocale(locale, '已提交 /fast 切换，稍后更新状态', 'Fast toggle queued; state will update shortly'));
        return;
      }
      setNotice(
        enabled
          ? pickLocale(locale, '原生 /fast 已开启', 'Native /fast enabled')
          : pickLocale(locale, '原生 /fast 已关闭', 'Native /fast disabled'),
      );
    } catch (error) {
      setNotice(`切换 /fast 失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsFastModePending(false);
    }
  }

  function insertSlashCommand(option: SlashCommandOption) {
    if (option.action === 'open-start') {
      setReply('');
      openStartSession();
      return;
    }
    if (option.action === 'open-fork') {
      setReply('');
      openForkSession();
      return;
    }
    setReply(option.insertText);
    setNotice(`${option.command} 已插入`);
    window.setTimeout(() => replyTextareaRef.current?.focus(), 0);
  }

  async function submitReply() {
    const currentAttachments = replyAttachmentsRef.current;
    if (!selectedSession || !canOperate(user)) return;
    if (isPreparingAttachment) {
      setNotice('附件还在处理，完成后再发送');
      return;
    }
    if (isTranscribing) {
      setNotice('语音识别还在进行，完成后会追加到输入框再发送');
      return;
    }
    if (isRecording && voiceInputMode === 'streaming') {
      await stopStreamingVoiceRecording({ commit: true, notice: '正在结束流式录音并发送' });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    const currentReplyValue = replyTextareaRef.current?.value ?? reply;
    if (!currentReplyValue.trim() && currentAttachments.length === 0) return;
    const slashCommand = currentAttachments.length > 0 ? null : parsedSlashCommand(currentReplyValue);
    if (slashCommand?.command === '/new') {
      await runLaunchSlashCommand('start', slashCommand.argument);
      return;
    }
    if (slashCommand?.command === '/fork') {
      await runLaunchSlashCommand('fork', slashCommand.argument);
      return;
    }
    if (slashCommand?.command === '/btw') {
      const prompt = slashCommand.argument;
      if (!prompt) {
        setNotice('用法：/btw 这里写旁路问题');
        return;
      }
      await apiPost<{ job: Job }>(`/api/sessions/${selectedSession.session_id}/btw`, { prompt }, csrfToken);
      setReply('');
      setNotice('BTW 旁路问题已入队，不会写入原后端 session');
      await loadData();
      return;
    }
    if (slashCommand?.command === '/stop') {
      if (!selectedCancelableJob) {
        setNotice('当前没有可停止的输入作业');
        return;
      }
      await handleCancelCurrentJob();
      setReply('');
      return;
    }
    if (slashCommand?.command === '/login') {
      await runProviderAuthSlashCommand('login', slashCommand.argument);
      return;
    }
    if (slashCommand?.command === '/logout') {
      await runProviderAuthSlashCommand('logout', slashCommand.argument);
      return;
    }
    if (replyBlockedReason) {
      setNotice(replyBlockedReason);
      return;
    }
    const rawPrompt = currentReplyValue.trim();
    const inputPayload: Record<string, unknown> =
      replyMode === 'plan' ? { prompt: rawPrompt, reply_mode: 'plan' } : { prompt: rawPrompt };
    if (currentAttachments.length > 0) inputPayload.attachments = currentAttachments.map(replyAttachmentPayload);
    const imageCount = currentAttachments.filter((attachment) => attachment.content_type.startsWith('image/')).length;
    const attachmentSummary =
      currentAttachments.length > 0
        ? currentAttachments
            .map((attachment) => `${attachment.content_type.startsWith('image/') ? '图片' : '附件'}：${attachment.filename}`)
            .join('，')
        : '';
    const fallbackPrompt =
      imageCount === currentAttachments.length && imageCount > 1
        ? '请看这些图片。'
        : imageCount === 1 && currentAttachments.length === 1
          ? '请看这张图片。'
          : '请看这些附件。';
    const optimisticText = currentAttachments.length > 0
      ? `${rawPrompt || fallbackPrompt}\n[${attachmentSummary}]`
      : rawPrompt;
    const currentTimeline = timelineBySession[selectedSession.session_id] ?? [];
    const nextSeq = Math.max(0, ...currentTimeline.map((item) => Number(item.seq) || 0), OPTIMISTIC_TIMELINE_SEQ_BASE) + 1;
    const optimisticItem: AgentTimelineItem = {
      session_id: selectedSession.session_id,
      seq: nextSeq,
      item_type: 'user_message',
      role: 'user',
      text: optimisticText,
      tool_call_id: null,
      tool_name: null,
      status: null,
      payload: {
        optimistic: true,
        client_id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      },
      created_at: new Date().toISOString(),
    };
    setNotice('正在发送…');
    appendOptimisticUserMessage(optimisticItem);
    setReply('');
    setReplyAttachmentsSafely([]);
    setComposerFocused(false);
    replyTextareaRef.current?.blur();
    let response: { job: Job };
    try {
      response = await apiPost<{ job: Job }>(
        `/api/sessions/${selectedSession.session_id}/input`,
        inputPayload,
        csrfToken,
      );
    } catch (error) {
      discardOptimisticUserMessage(selectedSession.session_id, optimisticItem);
      setReply(currentReplyValue);
      setReplyAttachmentsSafely(currentAttachments);
      setNotice(`发送失败：${error instanceof Error ? error.message : '未知错误'}`);
      return;
    }

    const confirmedOptimisticItem: AgentTimelineItem = {
      ...optimisticItem,
      payload: {
        ...timelineItemPayload(optimisticItem),
        job_id: response.job.job_id,
        agenthub_job_status: response.job.status,
        agenthub_job_error: response.job.error_text ?? '',
      },
    };
    replaceOptimisticUserMessage(optimisticItem, confirmedOptimisticItem);
    rememberOptimisticUserMessage(confirmedOptimisticItem);
    const queuedNotice =
      selectedSession.status === 'running' || selectedSession.status === 'queued'
        ? '已排队，当前作业结束后自动执行'
        : '已入队，worker 会自动执行';
    setNotice(queuedNotice);
    try {
      await loadData();
    } catch {
      setNotice(`${queuedNotice}；刷新失败，稍后自动同步`);
    }
  }

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitReply();
  }

  function handleReplyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (visibleSlashCommands.length > 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      insertSlashCommand(visibleSlashCommands[0]);
      return;
    }
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    void submitReply();
  }

  async function runWorkspaceJob<T>(
    endpoint: string,
    body: Record<string, unknown>,
    options: {
      queuedNotice: string;
      startNotice: string;
      successNotice?: string;
      attempts?: number;
      delayMs?: number;
      target?: WorkspaceFileTarget | null;
    },
  ) {
    if (!canOperate(user)) return null;
    const target = options.target ?? activeWorkspaceFileTarget();
    if (!target) return null;
    const operation = endpoint.split('/').pop() ?? '';
    const requestEndpoint = target.direct ? `/api/workspaces/files/${operation}` : endpoint;
    const requestBody = target.direct
      ? { worker_id: target.workerId, workspace_root: target.workspaceRoot, ...body }
      : body;
    const response = await apiPost<{ job: Job }>(requestEndpoint, requestBody, csrfToken);
    if (target.direct) rememberWorkspaceJob(response.job);
    setNotice(options.startNotice);
    const finished = target.direct
      ? await waitForWorkspaceJobCompletion(response.job.job_id, {
          attempts: options.attempts ?? 20,
          delayMs: options.delayMs ?? 300,
        })
      : await waitForSessionJobCompletion(target.sessionId || '', response.job.job_id, {
          attempts: options.attempts ?? 20,
          delayMs: options.delayMs ?? 300,
        });
    if (finished?.status === 'failed') {
      throw new Error(finished.error_text || '未知错误');
    }
    if (!finished || ['queued', 'running'].includes(finished.status)) {
      setNotice(options.queuedNotice);
      return null;
    }
    if (options.successNotice) setNotice(options.successNotice);
    return parseJobResult<T>(finished);
  }

  function activeWorkspaceFileTarget(): WorkspaceFileTarget | null {
    if (fileWorker && fileWorkspaceRoot) {
      return {
        workerId: fileWorker.worker_id,
        workspaceRoot: fileWorkspaceRoot,
        direct: true,
      };
    }
    if (!selectedSession) return null;
    return {
      workerId: selectedSession.worker_id,
      workspaceRoot: selectedSession.workspace_root,
      sessionId: selectedSession.session_id,
      direct: false,
    };
  }

  function handleFileWorkerChange(workerId: string) {
    const worker = workers.find((item) => item.worker_id === workerId);
    setFileWorkerId(workerId);
    setFileWorkspaceRoot(worker?.workspace_roots[0] ?? '');
    setWorkspaceJobs([]);
    setFileEditor(null);
    changeFileWorkspaceView('explorer', false);
  }

  function handleFileWorkspaceRootChange(workspaceRoot: string) {
    setFileWorkspaceRoot(workspaceRoot);
    setWorkspaceJobs([]);
    setFileEditor(null);
    changeFileWorkspaceView('explorer', false);
  }

  async function handleFileList(path = '.') {
    if (!activeWorkspaceFileTarget() || !canOperate(user)) return;
    try {
      await runWorkspaceJob<WorkspaceFileListResult>(
        `/api/sessions/${selectedSession?.session_id ?? ''}/files/list`,
        { path },
        {
          startNotice: path === '.' ? t(locale, 'syncingWorkspaceFiles') : t(locale, 'openingPath', { path }),
          queuedNotice: pickLocale(locale, '文件列表已入队，稍后自动同步', 'File list queued and will sync shortly'),
          successNotice: path === '.' ? t(locale, 'workspaceFilesUpdated') : t(locale, 'pathExpanded', { path }),
        },
      );
    } catch (error) {
      setNotice(pickLocale(locale, `文件列表失败：${error instanceof Error ? error.message : '未知错误'}`, `File list failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
    }
  }

  async function handleFileRead(
    path: string,
    target?: WorkspaceFileTarget | null,
    previewCapability?: WorkspaceFileEntry['preview_capability'],
  ) {
    const resolvedTarget = target ?? activeWorkspaceFileTarget();
    if (!resolvedTarget || !canOperate(user)) return;
    const revealSensitive = isSensitiveWorkspaceFile(path);
    if (
      revealSensitive &&
      !window.confirm(
        pickLocale(
          locale,
          `“${path}”可能包含密钥或凭据。确认仅在当前预览中打开？`,
          `“${path}” may contain keys or credentials. Open it for this preview?`,
        ),
      )
    ) {
      return;
    }
    const targetWorker = workers.find((worker) => worker.worker_id === resolvedTarget.workerId);
    const canStream =
      resolvedTarget.direct &&
      targetWorker?.capabilities?.file_transfer_v2 === true &&
      shouldStreamWorkspacePreview(previewCapability, path);
    try {
      if (canStream) {
        let response: { transfer: { transfer_id: string }; job: Job };
        try {
          response = await apiPost<{ transfer: { transfer_id: string }; job: Job }>(
            '/api/workspaces/files/transfers',
            {
              worker_id: resolvedTarget.workerId,
              workspace_root: resolvedTarget.workspaceRoot,
              path,
              ...(revealSensitive ? { reveal_sensitive: true } : {}),
            },
            csrfToken,
          );
        } catch (error) {
          const apiError = error as { status?: number; code?: string | null };
          if (apiError.code !== 'TRANSFER_UNSUPPORTED' && apiError.status !== 404) throw error;
          await runWorkspaceJob<WorkspaceFileReadResult>(
            `/api/sessions/${resolvedTarget.sessionId ?? selectedSession?.session_id ?? ''}/files/read`,
            { path, max_bytes: 512_000, ...(revealSensitive ? { reveal_sensitive: true } : {}) },
            {
              startNotice: `正在读取 ${path}`,
              queuedNotice: `文件读取已入队：${path}`,
              successNotice: `文件已就绪：${path}`,
              target: resolvedTarget,
            },
          );
          return;
        }
        rememberWorkspaceJob(response.job);
        setNotice(`正在准备 ${path}`);
        const finished = await waitForWorkspaceJobCompletion(response.job.job_id, { attempts: 30, delayMs: 300 });
        if (finished?.status === 'failed') throw new Error(finished.error_text || '文件传输失败');
        if (!finished || ['queued', 'running'].includes(finished.status)) {
          setNotice(`文件仍在准备：${path}`);
          return;
        }
        setNotice(`文件已就绪：${path}`);
        return;
      }
      await runWorkspaceJob<WorkspaceFileReadResult>(
        `/api/sessions/${resolvedTarget.sessionId ?? selectedSession?.session_id ?? ''}/files/read`,
        { path, max_bytes: 512_000, ...(revealSensitive ? { reveal_sensitive: true } : {}) },
        {
          startNotice: `正在读取 ${path}`,
          queuedNotice: `文件读取已入队：${path}`,
          successNotice: `文件已就绪：${path}`,
          target: resolvedTarget,
        },
      );
    } catch (error) {
      setNotice(`文件预览失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  function handleOpenWorkspaceFileLink(href: string) {
    if (!selectedSession || !canOperate(user)) return false;
    const path = workspaceFilePathFromLink(href, selectedSession.workspace_root);
    if (!path) return false;
    const matchingWorker = workers.find((worker) => worker.worker_id === selectedSession.worker_id);
    const target: WorkspaceFileTarget = matchingWorker
      ? {
          workerId: matchingWorker.worker_id,
          workspaceRoot: selectedSession.workspace_root,
          direct: true,
        }
      : {
          workerId: selectedSession.worker_id,
          workspaceRoot: selectedSession.workspace_root,
          sessionId: selectedSession.session_id,
          direct: false,
        };
    setFileWorkerId(target.workerId);
    setFileWorkspaceRoot(target.workspaceRoot);
    setWorkspaceJobs([]);
    navigateMobilePane('files', selectedSession.session_id);
    changeFileWorkspaceView('preview', true);
    void handleFileRead(path, target);
    return true;
  }

  function handleOpenFileEditor(file: WorkspaceFileReadResult) {
    if (file.preview_kind !== 'text') {
      setNotice('当前只支持编辑文本文件');
      return;
    }
    if (file.truncated) {
      setNotice('文件内容已截断，先缩小文件或用本地编辑器处理');
      return;
    }
    if ((file.text?.length ?? 0) > MAX_FILE_EDITOR_CHARS) {
      setNotice('超过 1 MB 的文本先下载到本地编辑更稳');
      return;
    }
    const target = activeWorkspaceFileTarget();
    if (!target) return;
    setFileEditor({
      path: file.path,
      filename: file.filename,
      text: file.text || '',
      expectedModifiedAt: file.modified_at,
      target,
    });
  }

  async function handleFileWrite(path: string, textValue: string, expectedModifiedAt?: string | null, target?: WorkspaceFileTarget | null) {
    if (!(target ?? activeWorkspaceFileTarget()) || !canOperate(user) || isSavingFileEditor) return false;
    setIsSavingFileEditor(true);
    try {
      const saved = await runWorkspaceJob<WorkspaceFileReadResult>(
        `/api/sessions/${target?.sessionId ?? selectedSession?.session_id ?? ''}/files/write`,
        { path, text: textValue, expected_modified_at: expectedModifiedAt ?? null },
        {
          startNotice: `正在保存 ${path}`,
          queuedNotice: `保存已入队：${path}`,
          successNotice: `已保存 ${path}`,
          target,
        },
      );
      if (!saved) return false;
      if (saved && typeof saved.path === 'string' && typeof saved.text === 'string') {
        setFileEditor({
          path: saved.path,
          filename: saved.filename,
          text: saved.text,
          expectedModifiedAt: saved.modified_at,
          target: target ?? activeWorkspaceFileTarget()!,
        });
      }
      return true;
    } catch (error) {
      setNotice(`保存失败：${error instanceof Error ? error.message : '未知错误'}`);
      return false;
    } finally {
      setIsSavingFileEditor(false);
    }
  }

  async function handleFileUpload(path: string, file: File, overwrite = false) {
    const target = activeWorkspaceFileTarget();
    if (!target || !canOperate(user)) return null;
    const filename = file.name || 'upload.bin';
    const contentType = inferReplyAttachmentContentType(file) || 'application/octet-stream';
    const targetWorker = workers.find((worker) => worker.worker_id === target.workerId);
    const canStream = target.direct && targetWorker?.capabilities?.file_transfer_v2 === true;
    try {
      if (canStream) {
        try {
          const created = await apiPost<{
            transfer: { transfer_id: string; content_url?: string };
          }>(
            '/api/workspaces/files/upload-transfers',
            {
              worker_id: target.workerId,
              workspace_root: target.workspaceRoot,
              path,
              filename,
              content_type: contentType,
              overwrite,
            },
            csrfToken,
          );
          const contentUrl = created.transfer.content_url || `/api/workspaces/files/transfers/${created.transfer.transfer_id}/content`;
          setNotice(`正在上传 ${filename}`);
          const uploaded = await apiPutRaw<{ transfer: { transfer_id: string }; job: Job }>(
            contentUrl,
            file,
            contentType,
            csrfToken,
          );
          rememberWorkspaceJob(uploaded.job);
          const finished = await waitForWorkspaceJobCompletion(uploaded.job.job_id, { attempts: 30, delayMs: 350 });
          if (finished?.status === 'failed') throw new Error(finished.error_text || '文件写入失败');
          if (!finished || ['queued', 'running'].includes(finished.status)) {
            setNotice(`上传已入队：${filename}`);
            return null;
          }
          const saved = parseJobResult<WorkspaceFileMutationResult>(finished);
          setNotice(`已上传 ${filename}`);
          return saved;
        } catch (error) {
          const apiError = error as { status?: number; code?: string | null };
          if (apiError.code !== 'TRANSFER_UNSUPPORTED' && apiError.status !== 404) throw error;
        }
      }
      const upload = await fileToWorkspaceUploadPayload(file);
      const saved = await runWorkspaceJob<WorkspaceFileMutationResult>(
        `/api/sessions/${selectedSession?.session_id ?? ''}/files/upload`,
        { path, ...upload, overwrite },
        {
          startNotice: `正在上传 ${upload.filename}`,
          queuedNotice: `上传已入队：${upload.filename}`,
          successNotice: `已上传 ${upload.filename}`,
          attempts: 24,
          delayMs: 350,
        },
      );
      return saved;
    } catch (error) {
      setNotice(`上传失败：${error instanceof Error ? error.message : '未知错误'}`);
      return null;
    }
  }

  async function handleFileCreate(path: string, textValue = '', overwrite = false) {
    if (!activeWorkspaceFileTarget() || !canOperate(user)) return null;
    try {
      const created = await runWorkspaceJob<WorkspaceFileMutationResult>(
        `/api/sessions/${selectedSession?.session_id ?? ''}/files/create`,
        { path, text: textValue, overwrite },
        {
          startNotice: `正在新建 ${path}`,
          queuedNotice: `新建已入队：${path}`,
          successNotice: `已新建 ${path}`,
        },
      );
      return created;
    } catch (error) {
      setNotice(`新建失败：${error instanceof Error ? error.message : '未知错误'}`);
      return null;
    }
  }

  async function handleFileMkdir(path: string) {
    if (!activeWorkspaceFileTarget() || !canOperate(user)) return null;
    try {
      const created = await runWorkspaceJob<WorkspaceFileMutationResult>(
        `/api/sessions/${selectedSession?.session_id ?? ''}/files/mkdir`,
        { path },
        {
          startNotice: `正在创建目录 ${path}`,
          queuedNotice: `目录创建已入队：${path}`,
          successNotice: `已创建目录 ${path}`,
        },
      );
      return created;
    } catch (error) {
      setNotice(`创建目录失败：${error instanceof Error ? error.message : '未知错误'}`);
      return null;
    }
  }

  async function handleFileRename(path: string, newPath: string, expectedModifiedAt?: string | null) {
    if (!activeWorkspaceFileTarget() || !canOperate(user)) return null;
    try {
      const renamed = await runWorkspaceJob<WorkspaceFileMutationResult>(
        `/api/sessions/${selectedSession?.session_id ?? ''}/files/rename`,
        { path, new_path: newPath, expected_modified_at: expectedModifiedAt ?? null },
        {
          startNotice: `正在重命名 ${path}`,
          queuedNotice: `重命名已入队：${path}`,
          successNotice: `已重命名为 ${newPath}`,
        },
      );
      return renamed;
    } catch (error) {
      setNotice(`重命名失败：${error instanceof Error ? error.message : '未知错误'}`);
      return null;
    }
  }

  function handleDownloadWorkspaceFile(file: WorkspaceFileReadResult) {
    if (file.content_url) {
      const anchor = document.createElement('a');
      anchor.href = file.content_url;
      anchor.download = file.filename || file.path.split('/').pop() || 'agenthub-file';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setNotice(`已开始下载 ${file.filename || file.path}`);
      return;
    }
    const blob = workspaceFileBlob(file);
    if (!blob) {
      setNotice('这个文件当前还不能直接下载');
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename || file.path.split('/').pop() || 'agenthub-file';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(`已开始下载 ${file.filename || file.path}`);
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedTitle = String(new FormData(event.currentTarget).get('custom_title') ?? '').trim();
    const nextTitle = submittedTitle || titleDraft.trim();
    if (!selectedSession || !nextTitle || !canOperate(user)) return;
    const payload = await apiPost<{ session: AgentSession }>(
      `/api/sessions/${selectedSession.session_id}/rename`,
      { custom_title: nextTitle },
      csrfToken,
    );
    patchSession(payload.session);
    hydratedDraftSessionIdRef.current = payload.session.session_id;
    setTitleDraft(sessionTitle(payload.session));
    setIsTitleDirty(false);
    setNotice('标题已保存');
  }

  async function handleControls(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSession || !canOperate(user)) return;
    const isClaude = isClaudeBackendName(selectedSession.backend);
    const payload: Record<string, string | boolean | string[] | null> = {};
    if (controlsDraft.model.trim()) payload.model = controlsDraft.model.trim();
    if (controlsDraft.sandbox_mode) payload.sandbox_mode = controlsDraft.sandbox_mode;
    if (!isClaude && controlsDraft.approval_mode) payload.approval_mode = controlsDraft.approval_mode;
    if (controlsDraft.permission_mode) payload.permission_mode = controlsDraft.permission_mode;
    if (controlsDraft.interaction_bridge) payload.interaction_bridge = controlsDraft.interaction_bridge;
    if (controlsDraft.agent.trim()) payload.agent = controlsDraft.agent.trim();
    if (controlsDraft.yolo) payload.yolo = true;
    if (controlsDraft.thinking) payload.thinking = controlsDraft.thinking === 'true';
    const existingControls = selectedSession.controls ?? {};
    const secretRefs = splitSecretRefs(controlsDraft.secret_refs);
    const hadSecretConfig =
      Array.isArray(existingControls.secret_refs) ||
      typeof existingControls.secret_environment === 'string' ||
      typeof existingControls.secret_namespace === 'string';
    if (secretRefs.length > 0 || hadSecretConfig) payload.secret_refs = secretRefs;
    if (controlsDraft.secret_environment.trim() || typeof existingControls.secret_environment === 'string') {
      payload.secret_environment = controlsDraft.secret_environment.trim() || null;
    }
    if (controlsDraft.secret_namespace.trim() || typeof existingControls.secret_namespace === 'string') {
      payload.secret_namespace = controlsDraft.secret_namespace.trim() || null;
    }
    const response = await apiPatch<{ session: AgentSession }>(
      `/api/sessions/${selectedSession.session_id}/controls`,
      payload,
      csrfToken,
    );
    patchSession(response.session);
    hydratedDraftSessionIdRef.current = response.session.session_id;
    setControlsDraft(controlsFromSession(response.session));
    controlsDirtyRef.current = false;
    setIsControlsDirty(false);
    setNotice('控制已保存');
  }

  async function handleWorkerRuntimeSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorker || !canAdmin(user)) return;
    const payload = {
      max_concurrent_jobs: Number(workerRuntimeDraft.max_concurrent_jobs),
      job_poll_interval_seconds: Number(workerRuntimeDraft.job_poll_interval_seconds),
      heartbeat_interval_seconds: Number(workerRuntimeDraft.heartbeat_interval_seconds),
    };
    const response = await apiPatch<{ worker: Worker }>(
      `/api/workers/${selectedWorker.worker_id}/runtime-settings`,
      payload,
      csrfToken,
    );
    patchWorker(response.worker);
    hydratedWorkerRuntimeIdRef.current = response.worker.worker_id;
    setWorkerRuntimeDraft(workerRuntimeDraftFromWorker(response.worker));
    workerRuntimeDirtyRef.current = false;
    setIsWorkerRuntimeDirty(false);
    setNotice(`Worker 运行参数已保存：${response.worker.worker_id}`);
  }

  async function handleSecretSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin(user)) return;
    const payload = {
      name: secretDraft.name.trim().toUpperCase(),
      value: secretDraft.value,
      namespace: secretDraft.namespace.trim() || 'default',
      environment: secretDraft.environment.trim() || 'default',
      description: secretDraft.description.trim(),
    };
    if (!payload.name || !payload.value) {
      setNotice('Secret 名称和值不能为空');
      return;
    }
    const response = await apiPost<{ secret: AgentSecret }>('/api/secrets', payload, csrfToken);
    setSecrets((current) => [
      response.secret,
      ...current.filter((item) => item.secret_id !== response.secret.secret_id && !(item.name === response.secret.name && item.namespace === response.secret.namespace && item.environment === response.secret.environment)),
    ]);
    setSecretDraft((current) => ({ ...current, name: '', value: '', description: '' }));
    setNotice(`Secret 已保存：${response.secret.name}`);
  }

  async function handleApplyFullAccessControls() {
    if (!selectedSession || !canOperate(user)) return;
    const payload = isClaudeBackendName(selectedSession.backend)
      ? { permission_mode: 'bypassPermissions' }
      : fullAccessControls;
    const response = await apiPatch<{ session: AgentSession }>(
      `/api/sessions/${selectedSession.session_id}/controls`,
      payload,
      csrfToken,
    );
    patchSession(response.session);
    hydratedDraftSessionIdRef.current = response.session.session_id;
    setControlsDraft(controlsFromSession(response.session));
    controlsDirtyRef.current = false;
    setIsControlsDirty(false);
    setNotice('已切换为全权限');
  }

  async function handlePermission(
    permissionId: string,
    action: PermissionAction,
    response: Record<string, unknown> = {},
  ) {
    if (!canOperate(user)) return;
    const payload = await apiPost<{ permission: AgentPermission }>(
      `/api/permissions/${permissionId}/respond`,
      { action, response },
      csrfToken,
    );
    setPermissions((current) =>
      current.map((permission) =>
        permission.permission_id === permissionId ? payload.permission : permission,
      ),
    );
    setNotice(`Permission ${payload.permission.status}`);
    await loadData();
  }

  async function handleCreateSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin(user)) return;
    await apiPost<{ schedule: Schedule }>(
      '/api/schedules',
      {
        name: scheduleDraft.name,
        job_kind: scheduleDraft.job_kind,
        interval_seconds: Number(scheduleDraft.interval_seconds),
        target_worker_id: scheduleDraft.target_worker_id || null,
        enabled: true,
      },
      csrfToken,
    );
    setNotice('Schedule created');
    await loadData();
  }

  function handleOpenFullConsole() {
    const desktopApi = globalThis.agentHubDesktop ?? window.agentHubDesktop;
    if (desktopApi?.showMain) {
      void desktopApi.showMain();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    window.location.href = url.toString();
  }

  if (loadState === 'loading') {
    return <main className="center-shell text-ink bg-paper">Loading AgentHub...</main>;
  }

  if (loadState === 'login') {
    return (
      <main className="login-shell text-ink bg-paper">
        <form className="login-panel" onSubmit={handleLogin}>
          <div className="brand-row">
            <AgentHubBrandMark size={24} />
            <span>AgentHub</span>
          </div>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button type="submit">
            <LogIn size={17} />
            Sign in
          </button>
        </form>
      </main>
    );
  }

  if (isIslandView) {
    return (
      <IslandConsole
        user={user}
        sessions={sessions}
        selectedSession={selectedSession}
        selectedId={selectedId}
        setSelectedId={(sessionId) => openSession(sessionId)}
        reply={reply}
        setReply={setReply}
        notice={notice}
        titleDraft={titleDraft}
        setTitleDraft={(value) => {
          setTitleDraft(value);
          setIsTitleDirty(true);
        }}
        controlsDraft={controlsDraft}
        setControlsDraft={updateControlsDraft}
        replyBlockedReason={replyBlockedReason}
        canReply={canReply}
        onRefresh={handleRefresh}
        onReply={handleReply}
        onReplyChange={handleReplyChange}
        onReplyKeyDown={handleReplyKeyDown}
        onRename={handleRename}
        onControls={handleControls}
        permissions={selectedPermissions}
        onPermission={handlePermission}
        onOpenFullConsole={handleOpenFullConsole}
      />
    );
  }

  return (
    <main className={`app-shell mode-${appMode} theme-${themeMode} text-ink bg-paper`}>
      <header className="topbar">
        <div className="brand-row">
          <button
            className="icon-button mobile-only topbar-menu-button"
            type="button"
            aria-label={t(locale, 'openSessionList')}
            title={t(locale, 'openSessionList')}
            onClick={handleOpenSessionList}
          >
            <Menu size={20} />
          </button>
          <AgentHubBrandMark size={22} />
          <span>AgentHub</span>
        </div>
        <div className="mobile-worker-signal">
          <span className="status-dot status-good" />
          {t(locale, 'workerSignal', { online: onlineWorkers, total: workers.length })}
        </div>
        <div className="mobile-mode-menu">
          <button
            className="mobile-mode-trigger"
            type="button"
            aria-label={pickLocale(locale, '切换工作区', 'Switch workspace')}
            aria-expanded={mobileModeMenuOpen}
            onClick={() => setMobileModeMenuOpen((current) => !current)}
          >
            <span>
              {appMode === 'session'
                ? pickLocale(locale, '会话', 'Sessions')
                : appMode === 'cockpit'
                  ? pickLocale(locale, '运行总览', 'Runtime')
                  : pickLocale(locale, '任务工作台', 'Tasks')}
            </span>
            <ChevronDown size={15} />
          </button>
          {mobileModeMenuOpen ? (
            <div className="mobile-mode-popover" role="menu">
              <button
                type="button"
                role="menuitem"
                className={appMode === 'session' ? 'selected' : ''}
                onClick={() => {
                  setAppMode('session');
                  setMobileModeMenuOpen(false);
                }}
              >
                <MessageCircle size={19} />
                <span>
                  <strong>{pickLocale(locale, '会话', 'Sessions')}</strong>
                  <small>{pickLocale(locale, '查看和控制 Agent 会话', 'View and control agent sessions')}</small>
                </span>
                {appMode === 'session' ? <Check size={17} /> : null}
              </button>
              <button
                type="button"
                role="menuitem"
                className={appMode === 'cockpit' ? 'selected' : ''}
                onClick={() => {
                  setAppMode('cockpit');
                  setMobileModeMenuOpen(false);
                }}
              >
                <Activity size={19} />
                <span>
                  <strong>{pickLocale(locale, '运行总览', 'Runtime overview')}</strong>
                  <small>{pickLocale(locale, '按状态总览所有 Agent', 'See every agent grouped by state')}</small>
                </span>
                {appMode === 'cockpit' ? <Check size={17} /> : null}
              </button>
              <button
                type="button"
                role="menuitem"
                className={appMode === 'workbench' ? 'selected' : ''}
                onClick={() => {
                  setAppMode('workbench');
                  setMobileModeMenuOpen(false);
                }}
              >
                <FileText size={19} />
                <span>
                  <strong>{pickLocale(locale, '任务工作台', 'Task workbench')}</strong>
                  <small>{pickLocale(locale, '下发、验收和返工结构化任务', 'Dispatch, review, and rework structured tasks')}</small>
                </span>
                {appMode === 'workbench' ? <Check size={17} /> : null}
              </button>
              <div className="mobile-mode-worker-status">
                <span className="status-dot status-good" />
                {t(locale, 'workerSignal', { online: onlineWorkers, total: workers.length })}
              </div>
            </div>
          ) : null}
        </div>
        <div className="app-mode-switch" role="group" aria-label="AgentHub mode">
          <button
            type="button"
            className={appMode === 'cockpit' ? 'selected' : ''}
            aria-pressed={appMode === 'cockpit'}
            onClick={() => setAppMode('cockpit')}
          >
            {pickLocale(locale, '运行总览', 'Runtime')}
          </button>
          <button
            type="button"
            className={appMode === 'workbench' ? 'selected' : ''}
            aria-pressed={appMode === 'workbench'}
            onClick={() => setAppMode('workbench')}
          >
            {pickLocale(locale, '任务工作台', 'Workbench')}
          </button>
          <button
            type="button"
            className={appMode === 'session' ? 'selected' : ''}
            aria-pressed={appMode === 'session'}
            onClick={() => setAppMode('session')}
          >
            {pickLocale(locale, '会话', 'Sessions')}
          </button>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button desktop-workspace-action"
            type="button"
            aria-label={pickLocale(locale, '远程工作区', 'Remote workspace')}
            title={pickLocale(locale, '远程工作区', 'Remote workspace')}
            onClick={navigateRemoteWorkspace}
          >
            <Folder size={17} />
          </button>
          <button
            className="icon-button primary-top-action"
            type="button"
            aria-label={appMode === 'workbench' ? pickLocale(locale, '新建任务', 'New task') : text.newSession}
            onClick={appMode === 'workbench' ? openTaskComposer : openStartSession}
            disabled={!canOperate(user)}
          >
            <Plus size={17} />
            <span>{appMode === 'workbench' ? pickLocale(locale, '新建任务', 'New task') : text.newSession}</span>
          </button>
          <span className="sync-chip">
            {isRefreshing ? text.syncing : text.autosync}
          </span>
          {user && <span className="role-chip">{user.role}</span>}
          <button
            className="icon-button theme-switch-button"
            type="button"
            title={themeMode === 'dark' ? t(locale, 'switchToLight') : t(locale, 'switchToDark')}
            aria-label={themeMode === 'dark' ? t(locale, 'switchToLight') : t(locale, 'switchToDark')}
            onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {themeMode === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{themeMode === 'dark' ? t(locale, 'light') : t(locale, 'dark')}</span>
          </button>
          <button
            className={`icon-button refresh-button ${isRefreshing ? 'refreshing' : ''}`}
            type="button"
            title="Refresh"
            aria-label={isRefreshing ? text.refreshing : text.refresh}
            aria-busy={isRefreshing}
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={isRefreshing ? 'spin-icon' : ''} size={17} />
            <span>{isRefreshing ? text.refreshing : text.refresh}</span>
          </button>
          <button
            className={`icon-button notification-button ${unreadNotificationCount > 0 ? 'has-alert' : ''}`}
            title={text.notifications}
            type="button"
            aria-label={
              notificationItems.length > 0
                ? t(locale, 'notificationBell', { count: unreadNotificationCount })
                : `${text.notifications}${notificationPermission === 'granted' ? pickLocale(locale, '已开启', ' enabled') : ''}`
            }
            onClick={handleTopbarBellClick}
          >
            <Bell size={17} />
            {unreadNotificationCount > 0 && <span className="notification-badge">{unreadNotificationCount}</span>}
          </button>
          <button className="icon-button" type="button" onClick={handleLogout}>
            <LogOut size={17} />
            {text.logout}
          </button>
        </div>
      </header>

      {notificationInboxOpen && (
        <NotificationInbox
          items={notificationItems}
          readIds={effectiveReadNotificationIds}
          locale={locale}
          onOpenItem={handleOpenNotificationItem}
          onMarkAllRead={handleMarkAllNotificationsRead}
          onClose={closeNotificationInbox}
        />
      )}

      {visiblePendingPermission && (
        <div className="notification-toast" role="group" aria-label={t(locale, 'approvalToast')}>
          <button
            type="button"
            className="notification-toast-main"
            onClick={() => handleOpenPendingPermission(visiblePendingPermission)}
          >
            <Bell size={17} />
            <span>
              <strong>{pendingPermissions.length} 个审批待处理</strong>
              <small>{visiblePendingPermission.title || visiblePendingPermission.description || visiblePendingPermission.kind}</small>
            </span>
          </button>
          <button
            type="button"
            className="notification-toast-close"
            aria-label="收起审批提示"
            onClick={handleDismissPendingPermissionToast}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {isRefreshNotice && (
        <div
          className={`global-status-toast ${visiblePendingPermission ? 'with-notification-toast' : ''}`}
          role="status"
          aria-live="polite"
        >
          <RefreshCw className={isRefreshing ? 'spin-icon' : ''} size={16} />
          <span>{notice}</span>
        </div>
      )}

      {appMode === 'cockpit' ? (
        <RuntimeCockpit
          projection={runtimeCockpit}
          locale={locale}
          onOpenSession={(sessionId) => {
            setAppMode('session');
            openSession(sessionId, 'thread');
          }}
          onOpenTask={(taskId) => {
            setAppMode('workbench');
            void openTask(taskId).catch(() => setNotice(pickLocale(locale, '任务详情同步失败，稍后重试', 'Task sync failed. Try again.')));
          }}
        />
      ) : appMode === 'workbench' ? (
        <WorkbenchShell
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          taskDetail={taskDetail}
          locale={locale}
          onSelectTask={(taskId) => {
            void openTask(taskId).catch(() => setNotice('任务详情同步失败，稍后重试'));
          }}
          onReviewTask={(action, note) => {
            void handleTaskReview(action, note).catch(() => setNotice('任务状态更新失败，稍后重试'));
          }}
        />
      ) : (
      <section className={`workspace mobile-pane-${mobilePane}`}>
        <aside className="session-list" aria-label={text.mobileSessions}>
          <div className="section-heading">
            <h1>
              {sessionArchiveView === 'archived' ? text.archivedSessions : text.sessionInbox}
              <span className="session-count-inline">{pickLocale(locale, `${filteredSessions.length} 个`, `${filteredSessions.length}`)}</span>
            </h1>
          </div>
          <div className="session-view-tabs" role="group" aria-label={t(locale, 'sessionView')}>
            <button
              type="button"
              className={sessionArchiveView === 'active' ? 'selected' : ''}
              onClick={() => void switchSessionArchiveView('active')}
            >
              {text.activeTab}
            </button>
            <button
              type="button"
              className={sessionArchiveView === 'archived' ? 'selected' : ''}
              onClick={() => void switchSessionArchiveView('archived')}
            >
              {text.archivedTab}
            </button>
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              aria-label={text.searchLabel}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={text.searchPlaceholder}
            />
            {query && (
              <button
                type="button"
                className="search-clear-button"
                aria-label={text.clearSearch}
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <button
            type="button"
            className="session-filter-toggle"
            aria-label={pickLocale(locale, '筛选会话', 'Filter sessions')}
            aria-expanded={sessionFiltersOpen}
            onClick={() => setSessionFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal size={15} />
            <span>{pickLocale(locale, '筛选会话', 'Filter sessions')}</span>
            <ChevronDown size={14} />
          </button>
          <div
            className={`session-filter-drawer ${sessionFiltersOpen ? 'is-open' : ''}`}
            data-open={sessionFiltersOpen}
          >
            <div className="provider-filter" aria-label={pickLocale(locale, 'Provider 筛选', 'Provider filters')}>
              {providerFilters(locale).map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={providerFilter === filter.id ? 'selected' : ''}
                  onClick={() => setProviderFilter(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="sort-row">
              <span>{text.sortRecent}</span>
              <SlidersHorizontal size={15} />
            </div>
            {canOperate(user) && (
              <div className="session-bulk-toolbar" role="group" aria-label={t(locale, 'sessionBulkActions')}>
                {sessionSelectionMode ? (
                  <>
                    <button type="button" onClick={() => setAllVisibleSessionsSelected(true)}>
                      {t(locale, 'selectAllVisible')}
                    </button>
                    <button type="button" onClick={() => setAllVisibleSessionsSelected(false)}>
                      {t(locale, 'clearSelection')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBatchArchiveSessions(sessionArchiveView !== 'archived')}
                      disabled={selectedVisibleSessionIds.length === 0}
                    >
                      {sessionArchiveView === 'archived' ? t(locale, 'restoreSelected') : t(locale, 'archiveSelected')}
                    </button>
                    <span className="session-bulk-count">
                      {t(locale, 'selectedCount', { count: String(selectedVisibleSessionIds.length) })}
                    </span>
                    <button
                      type="button"
                      className="session-bulk-cancel"
                      onClick={() => {
                        setSessionSelectionMode(false);
                        setSelectedSessionIds(new Set());
                      }}
                    >
                      {t(locale, 'cancelSelection')}
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setSessionSelectionMode(true)}>
                    {t(locale, 'selectSessions')}
                  </button>
                )}
              </div>
            )}
          </div>
          {filteredSessions.length === 0 && (
            <p className="empty">{sessionArchiveView === 'archived' ? t(locale, 'noArchivedSessions') : t(locale, 'noSessions')}</p>
          )}
          {filteredSessions.map((session) => (
            <div
              key={session.session_id}
              className={`session-row-shell ${sessionSelectionMode ? 'selecting' : ''} ${revealedSessionActionId === session.session_id ? 'action-open' : ''}`}
              onPointerDown={(event) => handleSessionPointerDown(event, session.session_id)}
              onPointerUp={(event) => handleSessionPointerEnd(event, session.session_id)}
              onPointerCancel={() => {
                sessionSwipeStartRef.current = null;
              }}
            >
              {sessionSelectionMode && (
                <button
                  type="button"
                  className={`session-select-toggle ${selectedSessionIds.has(session.session_id) ? 'selected' : ''}`}
                  aria-label={t(locale, 'toggleSessionSelection', { title: sessionTitle(session) })}
                  aria-pressed={selectedSessionIds.has(session.session_id)}
                  onClick={() => toggleSessionSelection(session.session_id)}
                >
                  {selectedSessionIds.has(session.session_id) ? '✓' : ''}
                </button>
              )}
              <div className="session-row-swipe-frame">
                <button
                  type="button"
                  className={`session-row ${session.session_id === selectedSession?.session_id ? 'selected' : ''}`}
                  onClick={() => handleSessionRowClick(session.session_id)}
                >
                  <span className={`status-dot ${statusClass(session.status)}`} />
                  <span className="session-row-body">
                    <span className="session-row-top">
                      <strong>{sessionTitle(session)}</strong>
                      <span className={`mini-state ${statusClass(session.status)}`}>{statusLabel(session.status, locale)}</span>
                    </span>
                    <span className="session-row-meta">
                      <span className="backend-mark">
                        <TerminalSquare size={14} />
                        {backendLabel(session.backend)}
                      </span>
                      <span>{session.project_name} / {session.namespace}</span>
                      <small>{formatRelative(session.last_activity_at, locale) || formatWhen(session.last_activity_at)}</small>
                    </span>
                    <span className="session-row-bottom">
                      <small>{agentOpsActivitySummary(session.activity_summary || session.last_message, session.status)}</small>
                    </span>
                  </span>
                </button>
                {canOperate(user) && (
                  <button
                    type="button"
                    className="session-row-quick-action"
                    aria-label={sessionArchiveView === 'archived' ? t(locale, 'restoreSessionFromList') : t(locale, 'archiveSessionFromList')}
                    aria-hidden={revealedSessionActionId === session.session_id ? undefined : true}
                    tabIndex={revealedSessionActionId === session.session_id ? 0 : -1}
                    title={sessionArchiveView === 'archived' ? t(locale, 'restoreSessionFromList') : t(locale, 'archiveSessionFromList')}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRevealedSessionActionId(null);
                      void archiveSessions([session.session_id], sessionArchiveView !== 'archived');
                    }}
                  >
                    {sessionArchiveView === 'archived' ? <RotateCcw size={16} /> : <Archive size={16} />}
                    <span>{sessionArchiveView === 'archived' ? t(locale, 'restore') : t(locale, 'archive')}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </aside>

        <section className={threadPaneClassName}>
          {selectedSession ? (
            <>
              <div className="thread-head">
                <div>
                  <p>{backendLabel(selectedSession.backend)} · {selectedSession.namespace}</p>
                  <h2>{sessionTitle(selectedSession)}</h2>
                  <small>{agentOpsTaskSummary(selectedSession)}</small>
                  <button
                    type="button"
                    className={`thread-status-strip ${statusDetailsOpen ? 'expanded' : ''}`}
                    aria-label={pickLocale(locale, statusDetailsOpen ? '收起会话状态' : '展开会话状态', statusDetailsOpen ? 'Collapse session status' : 'Expand session status')}
                    aria-expanded={statusDetailsOpen}
                    onClick={() => setStatusDetailsOpen((open) => !open)}
                  >
                    <span className={`state-pill ${statusClass(selectedSession.status)}`}>
                      {statusLabel(selectedSession.status, locale)}
                    </span>
                    <span>{backendLabel(selectedSession.backend)}</span>
                    <span>{selectedSession.worker_id}</span>
                    <span>{sandboxSummary(selectedSession, locale)}</span>
                    <span>{formatWhen(selectedSession.last_activity_at) || selectedSession.project_name}</span>
                    <ChevronDown className="thread-status-expander" size={14} />
                  </button>
                </div>
                <div className={`thread-head-actions ${mobileSessionActionsOpen ? 'menu-open' : ''}`}>
                  <button
                    type="button"
                    className="icon-button mobile-control-shortcut"
                    onClick={() => navigateMobilePane('controls')}
                  >
                    <SlidersHorizontal size={16} />
                    {pickLocale(locale, '控制', 'Controls')}
                  </button>
                  <button
                    type="button"
                    className="icon-button desktop-session-action"
                    onClick={() => void handleCancelCurrentJob()}
                    disabled={!selectedCancelableJob || !canOperate(user)}
                  >
                    <Square size={16} />
                    {pickLocale(locale, '停止当前任务', 'Stop Current Task')}
                  </button>
                  <button
                    type="button"
                    className="icon-button desktop-session-action"
                    onClick={openForkSession}
                    disabled={!canOperate(user)}
                  >
                    <GitFork size={16} />
                    Fork
                  </button>
                  <button
                    type="button"
                    className="icon-button desktop-session-action"
                    aria-label={sessionArchiveView === 'archived' ? t(locale, 'restoreSession') : t(locale, 'archiveSession')}
                    title={sessionArchiveView === 'archived' ? t(locale, 'restoreSession') : t(locale, 'archiveSession')}
                    onClick={() => void handleArchiveSession(sessionArchiveView !== 'archived')}
                    disabled={!canOperate(user)}
                  >
                    {sessionArchiveView === 'archived' ? <RotateCcw size={16} /> : <Archive size={16} />}
                    {sessionArchiveView === 'archived' ? t(locale, 'restore') : t(locale, 'archive')}
                  </button>
                  <div className="mobile-session-menu">
                    <button
                      type="button"
                      className="icon-button mobile-session-menu-button"
                      aria-label="更多会话操作"
                      aria-expanded={mobileSessionActionsOpen}
                      onClick={() => setMobileSessionActionsOpen((open) => !open)}
                    >
                      <MoreHorizontal size={17} />
                    </button>
                    {mobileSessionActionsOpen && (
                      <div className="mobile-session-menu-popover" role="menu" aria-label="更多会话操作">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMobileSessionActionsOpen(false);
                            void handleCancelCurrentJob();
                          }}
                          disabled={!selectedCancelableJob || !canOperate(user)}
                        >
                          <Square size={16} />
                          {pickLocale(locale, '停止当前任务', 'Stop Current Task')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMobileSessionActionsOpen(false);
                            openForkSession();
                          }}
                          disabled={!canOperate(user)}
                        >
                          <GitFork size={16} />
                          Fork
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMobileSessionActionsOpen(false);
                            void handleArchiveSession(sessionArchiveView !== 'archived');
                          }}
                          disabled={!canOperate(user)}
                        >
                          {sessionArchiveView === 'archived' ? <RotateCcw size={16} /> : <Archive size={16} />}
                          {sessionArchiveView === 'archived' ? t(locale, 'restore') : t(locale, 'archive')}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <section className="message-block" aria-label="Transcript" ref={transcriptRef} onScroll={handleTranscriptScroll}>
                {selectedPermissions.length > 0 && (
                  <section className="permission-stack thread-interactions" aria-label="当前待处理交互">
                    {selectedPermissions.map((permission) => (
                      <PendingInteractionCard
                        key={permission.permission_id}
                        permission={permission}
                        onPermission={handlePermission}
                      />
                    ))}
                  </section>
                )}

                <div className="timeline-tabs" aria-label="Timeline filters">
                  <span className="timeline-order">最新在下</span>
                  {timelineFilters.map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      className={timelineFilter === filter.id ? 'selected' : ''}
                      onClick={() => setTimelineFilter(filter.id)}
                    >
                      {filter.label}
                      <span>{filter.count}</span>
                    </button>
                  ))}
                </div>

                {timelineHasOlder[selectedSession.session_id] && (
                  <button
                    type="button"
                    className="load-older-button"
                    onClick={handleLoadOlderTimeline}
                    disabled={loadingOlder}
                  >
                    {loadingOlder ? '加载中…' : '加载更早历史'}
                  </button>
                )}

                {visibleTimeline.length > 0 ? (
                  visibleTimeline.map((message) => {
                    const requestQuestions = requestUserInputTimelineQuestions(message);
                    const requestPermission = matchingRequestUserInputPermission(selectedPermissions, requestQuestions);
                    const attachments = timelineItemAttachments(message);
                    return (
                      <article className={`message-line item-${message.item_type}`} key={`${message.seq}-${message.item_type}`}>
                        <div className="message-avatar">
                          {message.item_type === 'user_message' ? <Users size={15} /> : message.item_type === 'tool_call' ? <Activity size={15} /> : <TerminalSquare size={15} />}
                        </div>
                        <div>
                          <strong>
                            {requestQuestions.length > 0 ? '选择请求' : timelineLabel(message)}
                            <small>{formatWhen(message.created_at)}</small>
                          </strong>
                          {requestQuestions.length > 0 ? (
                            <details className="timeline-detail request-input-detail" open>
                              <summary>{requestUserInputSummary(requestQuestions)}</summary>
                              <RequestUserInputTimeline
                                questions={requestQuestions}
                                permission={requestPermission}
                                onPermission={handlePermission}
                              />
                            </details>
                          ) : message.item_type === 'tool_call' || message.item_type === 'error' ? (
                            <details className="timeline-detail">
                              <summary>
                                {message.item_type === 'error'
                                  ? failureSummary(message.text)
                                  : compactText(message.tool_name || message.text, 90) || '工具调用'}
                              </summary>
                              <TimelineText text={message.text} onOpenWorkspaceFile={handleOpenWorkspaceFileLink} />
                            </details>
                          ) : (
                            <>
                              <TimelineText
                                text={message.text}
                                allowRenderPreview={message.item_type === 'assistant_message'}
                                onOpenWorkspaceFile={handleOpenWorkspaceFileLink}
                              />
                              {attachments.length > 0 && (
                                <div className="timeline-attachments" aria-label="消息附件">
                                  {attachments.map((attachment, index) => (
                                    <span className="timeline-attachment-chip" key={`${attachment.filename}-${index}`}>
                                      {attachment.content_type.startsWith('image/') ? (
                                        <ImageIcon size={13} />
                                      ) : (
                                        <FileText size={13} />
                                      )}
                                      <span>{attachment.filename}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <p className="empty">{selectedSession.last_message || selectedSession.activity_summary || '当前空闲'}</p>
                )}

              </section>
              {showScrollToBottom && (
                <button
                  type="button"
                  className="scroll-to-bottom-button"
                  aria-label="滚动到最新消息"
                  title="滚动到最新消息"
                  onClick={() => scrollTranscriptToBottom()}
                >
                  <ArrowDown size={16} />
                </button>
              )}

              <form
                className={`reply-box ${isTranscribing ? 'is-transcribing' : ''} ${composerExpanded ? 'is-expanded' : ''} ${composerCompact ? 'is-compact' : ''} ${composerFocusedState ? 'is-focused' : ''}`}
                onSubmit={handleReply}
                onFocus={() => setComposerFocused(true)}
                onBlur={handleComposerBlur}
              >
                <label className="reply-title" htmlFor="reply">{pickLocale(locale, '回复当前会话', 'Reply to this session')}</label>
                <div className="reply-mode-tabs" role="group" aria-label={pickLocale(locale, '回复模式', 'Reply mode')}>
                  {(['direct', 'plan'] as ReplyMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={replyMode === mode ? 'selected' : ''}
                      aria-pressed={replyMode === mode}
                      onClick={() => setReplyMode(mode)}
                    >
                      {replyModeLabel(locale, mode)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={selectedFastMode.state === 'enabled' ? 'selected' : ''}
                    aria-pressed={selectedFastMode.state === 'enabled'}
                    onClick={() => void handleToggleFastMode(selectedFastMode.state !== 'enabled')}
                    disabled={!canReply || selectedFastMode.state === 'unavailable' || isFastModePending}
                    title={fastModeHint(locale, selectedFastMode) ?? undefined}
                  >
                    {isFastModePending ? pickLocale(locale, '快速处理中', 'Fast...') : pickLocale(locale, '快速', 'Fast')}
                  </button>
                  <span className="reply-mode-hint">{replyModeHint(replyMode, selectedSession, selectedProvider, locale)}</span>
                </div>
                <textarea
                  id="reply"
              ref={replyTextareaRef}
              aria-label={pickLocale(locale, '回复当前会话', 'Reply to this session')}
              value={reply}
              onChange={(event) => handleReplyChange(event.target.value)}
              onKeyDown={handleReplyKeyDown}
              onPaste={handleReplyPaste}
                  rows={2}
                  placeholder="输入你的消息..."
                  enterKeyHint="enter"
                  disabled={!canReply}
                />
                {visibleSlashCommands.length > 0 && (
                  <div className="slash-command-palette" role="listbox" aria-label="Slash commands">
                    {visibleSlashCommands.map((option) => (
                      <button
                        key={option.command}
                        type="button"
                        role="option"
                        aria-selected="false"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertSlashCommand(option)}
                      >
                        <code>{option.command}</code>
                        <span>
                          <strong>{option.title}</strong>
                          <small>{slashCommandDescription(option, selectedProvider, locale)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {replyAttachments.length > 0 && (
                  <div className="reply-attachments" aria-label="待发送附件">
                    {replyAttachments.map((attachment, index) => (
                      <div className="reply-attachment" key={`${attachment.filename}-${index}`}>
                        {attachment.preview_url ? (
                          <img src={attachment.preview_url} alt="" />
                        ) : (
                          <span className="reply-attachment-file" aria-hidden="true">
                            <FileText size={18} />
                          </span>
                        )}
                        <span>
                          <strong>{attachment.filename}</strong>
                          <small>{Math.max(1, Math.round(attachment.size_bytes / 1024))} KB</small>
                        </span>
                        <button type="button" aria-label={`移除附件 ${attachment.filename}`} onClick={() => removeReplyAttachment(index)}>
                          <X size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
            {visibleReplyStatus && <div className="reply-status">{visibleReplyStatus}</div>}
                <div className="voice-mode-bar">
                  <div className="voice-mode-toggle voice-interaction-toggle" role="group" aria-label="语音交互模式">
                    <button
                      type="button"
                      className={voiceInteractionMode === 'dictation' ? 'selected' : ''}
                      aria-pressed={voiceInteractionMode === 'dictation'}
                      onClick={() => setVoiceInteractionMode('dictation')}
                      disabled={isRecording}
                    >
                      听写
                    </button>
                    <button
                      type="button"
                      className={voiceInteractionMode === 'assistant' ? 'selected' : ''}
                      aria-pressed={voiceInteractionMode === 'assistant'}
                      onClick={() => setVoiceInteractionMode('assistant')}
                      disabled={isRecording}
                    >
                      助手
                    </button>
                  </div>
                  <div className="voice-mode-toggle" role="group" aria-label="语音输入模式">
                    <button
                      type="button"
                      className={voiceInputMode === 'streaming' ? 'selected' : ''}
                      aria-pressed={voiceInputMode === 'streaming'}
                      onClick={() => setVoiceInputMode('streaming')}
                      disabled={isRecording || voiceInteractionMode === 'assistant'}
                    >
                      流式
                    </button>
                    <button
                      type="button"
                      className={voiceInputMode === 'standard' ? 'selected' : ''}
                      aria-pressed={voiceInputMode === 'standard'}
                      onClick={() => setVoiceInputMode('standard')}
                      disabled={isRecording || voiceInteractionMode === 'assistant'}
                    >
                      标准
                    </button>
                  </div>
                </div>
                <div className="reply-footer">
                  {quickReplies.length > 0 && (
                    <div className="quick-reply-strip" aria-label="快捷回复">
                      {quickReplies.map((quickReply) => (
                        <button
                          key={quickReply}
                          type="button"
                          className="quick-reply-chip"
                          onClick={() => insertQuickReply(quickReply)}
                          disabled={!canReply}
                        >
                          {quickReply}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="reply-actions">
                  <input
                    id="reply-attachment"
                    className="reply-file-input"
                    type="file"
                    aria-label="上传附件"
                    multiple
                    onChange={handleReplyAttachment}
                    disabled={!canReply}
                  />
                  <label className="sr-only" htmlFor="reply-attachment">上传图片</label>
                  <label
                    className="reply-icon-button reply-tool-button"
                    htmlFor="reply-attachment"
                    title="添加图片或文件"
                  >
                    <ImageIcon size={16} />
                  </label>
                  <button
                    type="button"
                    className={`reply-icon-button voice-action ${isRecording ? 'recording' : ''} ${isTranscribing ? 'transcribing' : ''}`}
                    aria-label={isRecording ? '停止' : '语音'}
                    title={
                      isRecording
                        ? '停止录音'
                        : isTranscribing
                          ? '正在识别语音'
                          : voiceInteractionMode === 'assistant'
                            ? '语音助手'
                            : voiceInputMode === 'streaming'
                              ? '流式语音输入'
                              : '标准语音输入'
                    }
                    aria-busy={isTranscribing}
                    onClick={handleVoiceToggle}
                    disabled={!canReply || isTranscribing}
                  >
                    {isRecording ? (
                      <Square size={16} />
                    ) : isTranscribing ? (
                      <RefreshCw className="spin-icon" size={16} />
                    ) : (
                      <Mic size={16} />
                    )}
                    {isRecording && <span className="recording-pulse" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="reply-icon-button composer-expand-button"
                    aria-label={composerExpanded ? '收起输入框' : '展开输入框'}
                    title={composerExpanded ? '收起输入框' : '展开输入框'}
                    onClick={() => setComposerExpanded((expanded) => !expanded)}
                  >
                    {composerExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                  <button className="reply-send-button" type="submit" aria-label="发送" title="发送" disabled={!canSendReply}>
                    <Send size={17} />
                  </button>
                  </div>
                </div>
              </form>
            </>
          ) : (
            <div className="empty-detail">Select a session.</div>
          )}
        </section>

        <aside className="ops-rail" aria-label="Controls" data-inspector-mode={inspectorMode}>
          <h2 className="rail-title">{text.controls}</h2>
          <div className="inspector-switch">
            <div className="inspector-tabs" role="tablist" aria-label={pickLocale(locale, '检查器视图', 'Inspector view')}>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorMode === 'overview'}
                className={inspectorMode === 'overview' ? 'selected' : ''}
                onClick={() => setInspectorMode('overview')}
              >
                {pickLocale(locale, '概览', 'Overview')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorMode === 'controls'}
                className={inspectorMode === 'controls' ? 'selected' : ''}
                onClick={() => setInspectorMode('controls')}
              >
                {pickLocale(locale, '控制', 'Controls')}
              </button>
            </div>
            <button
              type="button"
              className="inspector-files-button"
              onClick={navigateRemoteWorkspace}
              aria-label={pickLocale(locale, '打开工作区', 'Open workspace')}
              title={pickLocale(locale, '打开工作区', 'Open workspace')}
            >
              <Folder size={16} />
            </button>
          </div>
          <Panel title={text.preferences} icon={<Smartphone size={16} />} defaultOpen={false}>
            <PreferencesEditor
              locale={locale}
              preferences={settings.preferences}
              options={settings.options}
              onSave={handleVoicePreferenceChange}
              onLocaleChange={handleLocaleChange}
              onThemeModeChange={handleThemeModeChange}
            />
          </Panel>
          {canAdmin(user) && (
            <Panel title={text.workerRuntime} icon={<Cpu size={16} />} defaultOpen={false}>
              <WorkerRuntimeDefaultsEditor
                locale={locale}
                runtime={settings.worker_runtime_defaults}
                onSave={handleWorkerRuntimeDefaultsChange}
              />
            </Panel>
          )}
          {selectedSession && (
            <>
              <section className="inspector-overview" aria-label={pickLocale(locale, '当前会话概览', 'Current session overview')}>
                <span className={`state-pill ${statusClass(selectedSession.status)}`}>
                  {statusLabel(selectedSession.status, locale)}
                </span>
                <div>
                  <strong>{agentOpsTaskHeadline(selectedSession)}</strong>
                  <p>{agentOpsTaskSummary(selectedSession)}</p>
                </div>
              </section>

              <Panel title={pickLocale(locale, '本机恢复', 'Local Resume')} icon={<TerminalSquare size={16} />} defaultOpen={false}>
                <div className="local-resume-panel">
                  <p>{localResumeHint(selectedSession)}</p>
                  {localResumeCommand(selectedSession) ? <code>{localResumeCommand(selectedSession)}</code> : null}
                  <small>{localResumeDetail(selectedSession)}</small>
                </div>
              </Panel>

              {selectedWorker && canAdmin(user) && (
                <Panel title={pickLocale(locale, 'Worker 运行参数', 'Worker Runtime')} icon={<Cpu size={16} />} defaultOpen={false}>
                  <form className="editor-panel" onSubmit={handleWorkerRuntimeSettings}>
                    <div className="control-summary">
                      <span>
                        <Cpu size={15} />
                        {selectedWorker.worker_id} · {selectedWorker.machine_name}
                      </span>
                      <small>{selectedWorker.os} · {statusLabel(selectedWorker.status, locale)}</small>
                    </div>
                    <div className="control-fields">
                      <label>
                        {t(locale, 'maxConcurrentJobs')}
                        <input
                          aria-label={pickLocale(locale, 'Worker 最大并发', 'Worker max concurrent jobs')}
                          type="number"
                          min={1}
                          max={32}
                          value={workerRuntimeDraft.max_concurrent_jobs}
                          onChange={(event) =>
                            updateWorkerRuntimeDraft((current) => ({
                              ...current,
                              max_concurrent_jobs: event.target.value,
                            }))
                          }
                          disabled={!canAdmin(user)}
                        />
                      </label>
                      <label>
                        {pickLocale(locale, 'Job 轮询秒数', 'Job Poll Interval (s)')}
                        <input
                          aria-label={pickLocale(locale, 'Worker job 轮询秒数', 'Worker job poll interval')}
                          type="number"
                          min={1}
                          max={300}
                          value={workerRuntimeDraft.job_poll_interval_seconds}
                          onChange={(event) =>
                            updateWorkerRuntimeDraft((current) => ({
                              ...current,
                              job_poll_interval_seconds: event.target.value,
                            }))
                          }
                          disabled={!canAdmin(user)}
                        />
                      </label>
                      <label>
                        {pickLocale(locale, '心跳秒数', 'Heartbeat Interval (s)')}
                        <input
                          aria-label={pickLocale(locale, 'Worker 心跳秒数', 'Worker heartbeat interval')}
                          type="number"
                          min={1}
                          max={300}
                          value={workerRuntimeDraft.heartbeat_interval_seconds}
                          onChange={(event) =>
                            updateWorkerRuntimeDraft((current) => ({
                              ...current,
                              heartbeat_interval_seconds: event.target.value,
                            }))
                          }
                          disabled={!canAdmin(user)}
                        />
                      </label>
                    </div>
                    <button type="submit" disabled={!canAdmin(user)}>
                      <Check size={16} />
                      {pickLocale(locale, '保存 Worker 参数', 'Save Worker Runtime')}
                    </button>
                  </form>
                </Panel>
              )}

              <Panel title={pickLocale(locale, '模型与工具', 'Models & Tools')} icon={<Bot size={16} />} defaultOpen={false}>
                <form className="editor-panel" onSubmit={handleControls}>
                  <div className="control-summary">
                    <span>
                      <Shield size={15} />
                      {pickLocale(locale, '当前权限：', 'Current permission: ')}{sandboxSummary(selectedSession, locale)}
                    </span>
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={handleApplyFullAccessControls}
                      disabled={!canOperate(user)}
                    >
                      {pickLocale(locale, '应用全权限', 'Apply Full Access')}
                    </button>
                  </div>
                  {selectedSession?.backend.toLowerCase() === 'codex' && (
                    <div className="control-summary">
                      <span>
                        <Activity size={15} />
                        {pickLocale(locale, '原生 /fast：', 'Native /fast: ')}
                        {fastModeLabel(locale, selectedFastMode)}
                      </span>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="secondary-action"
                          onClick={() => void refreshSelectedSessionFastMode({ force: true })}
                          disabled={!canOperate(user) || isFastModePending}
                        >
                          {pickLocale(locale, '同步快速状态', 'Sync Fast State')}
                        </button>
                        <button
                          type="button"
                          className="secondary-action"
                          onClick={() => void handleToggleFastMode(selectedFastMode.state !== 'enabled')}
                          disabled={!canOperate(user) || isFastModePending}
                        >
                          {selectedFastMode.state === 'enabled'
                            ? pickLocale(locale, '关闭快速', 'Disable Fast')
                            : pickLocale(locale, '开启快速', 'Enable Fast')}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="control-fields">
                    <label>
                      {pickLocale(locale, '模型', 'Model')}
                      <select
                        aria-label={pickLocale(locale, '模型', 'Model')}
                        value={controlsDraft.model}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, model: event.target.value }))}
                        disabled={!canOperate(user)}
                      >
                        <option value="">default</option>
                        {controlsDraft.model &&
                          !selectedProvider?.models?.some((model) => model.id === controlsDraft.model) && (
                            <option value={controlsDraft.model}>{controlsDraft.model}</option>
                          )}
                        {selectedProvider?.models?.map((model) => (
                          <option value={model.id} key={model.id}>
                            {model.label ?? model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {pickLocale(locale, '沙箱', 'Sandbox')}
                      <select
                        aria-label={pickLocale(locale, '沙箱', 'Sandbox')}
                        value={controlsDraft.sandbox_mode}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, sandbox_mode: event.target.value }))}
                        disabled={!canOperate(user)}
                      >
                        <option value="">default</option>
                        {modeOptions(selectedProvider, 'sandbox_mode', [
                          'read-only',
                          'workspace-write',
                          'danger-full-access',
                        ]).map((value) => (
                          <option value={value} key={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!isClaudeBackendName(selectedProvider?.backend) ? (
                      <label>
                        {pickLocale(locale, '审批', 'Approval')}
                        <select
                          aria-label={pickLocale(locale, '审批', 'Approval')}
                          value={controlsDraft.approval_mode}
                          onChange={(event) => updateControlsDraft((current) => ({ ...current, approval_mode: event.target.value }))}
                          disabled={!canOperate(user)}
                        >
                          <option value="">default</option>
                          {modeOptions(selectedProvider, 'approval_mode', ['never', 'on-request', 'on-failure', 'untrusted']).map(
                            (value) => (
                              <option value={value} key={value}>
                                {value}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    ) : null}
                    <label>
                      {pickLocale(locale, '权限策略', 'Permission Policy')}
                      <select
                        aria-label={pickLocale(locale, '权限策略', 'Permission Policy')}
                        value={controlsDraft.permission_mode}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, permission_mode: event.target.value }))}
                        disabled={!canOperate(user)}
                      >
                        <option value="">default</option>
                        {modeOptions(selectedProvider, 'permission_mode', [
                          'default',
                          'auto',
                          'plan',
                          'dontAsk',
                          'bypassPermissions',
                        ]).map((value) => (
                          <option value={value} key={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {pickLocale(locale, '交互桥', 'Interaction Bridge')}
                      <select
                        aria-label={pickLocale(locale, '交互桥', 'Interaction Bridge')}
                        value={controlsDraft.interaction_bridge}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, interaction_bridge: event.target.value }))}
                        disabled={!canOperate(user)}
                      >
                        <option value="">default</option>
                        {modeOptions(selectedProvider, 'interaction_bridge', ['compatibility', 'tmux', 'psmux']).map((value) => (
                          <option value={value} key={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {pickLocale(locale, '执行器', 'Executor')}
                      <input
                        aria-label={pickLocale(locale, '执行器', 'Executor')}
                        value={controlsDraft.agent}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, agent: event.target.value }))}
                        placeholder="codex exec / kimi -p"
                        disabled={!canOperate(user)}
                      />
                    </label>
                    <label>
                      {pickLocale(locale, '思考', 'Thinking')}
                      <select
                        aria-label={pickLocale(locale, '思考', 'Thinking')}
                        value={controlsDraft.thinking}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, thinking: event.target.value }))}
                        disabled={!canOperate(user)}
                      >
                        <option value="">default</option>
                        <option value="true">on</option>
                        <option value="false">off</option>
                      </select>
                    </label>
                    <label>
                      {pickLocale(locale, 'Secret 环境', 'Secret Environment')}
                      <input
                        aria-label={pickLocale(locale, 'Secret 环境', 'Secret Environment')}
                        value={controlsDraft.secret_environment}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, secret_environment: event.target.value }))}
                        placeholder="default / test / prod"
                        disabled={!canOperate(user)}
                      />
                    </label>
                    <label>
                      {pickLocale(locale, 'Secret 命名空间', 'Secret Namespace')}
                      <input
                        aria-label={pickLocale(locale, 'Secret 命名空间', 'Secret Namespace')}
                        value={controlsDraft.secret_namespace}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, secret_namespace: event.target.value }))}
                        placeholder="default"
                        disabled={!canOperate(user)}
                      />
                    </label>
                  </div>
                  <label className="secret-ref-field">
                    {pickLocale(locale, 'Secret 引用', 'Secret References')}
                    <textarea
                      aria-label={pickLocale(locale, 'Secret 引用', 'Secret References')}
                      value={controlsDraft.secret_refs}
                      onChange={(event) => updateControlsDraft((current) => ({ ...current, secret_refs: event.target.value }))}
                      placeholder="OPENAI_API_KEY&#10;KIMI_API_KEY"
                      rows={3}
                      disabled={!canOperate(user)}
                    />
                  </label>
                  <label className="toggle-row">
                    <input
                      aria-label="Yolo"
                      type="checkbox"
                      checked={controlsDraft.yolo}
                      onChange={(event) => updateControlsDraft((current) => ({ ...current, yolo: event.target.checked }))}
                      disabled={!canOperate(user)}
                    />
                    {pickLocale(locale, '自动确认', 'Auto confirm')} <small>YOLO</small>
                  </label>
                  <button type="submit" disabled={!canOperate(user)}>
                    <Check size={16} />
                    {pickLocale(locale, '保存控制', 'Save Controls')}
                  </button>
                </form>
              </Panel>

              <Panel title={pickLocale(locale, '重命名', 'Rename')} icon={<Save size={16} />} defaultOpen={false}>
                <form className="editor-panel" onSubmit={handleRename}>
                  <label>
                    {pickLocale(locale, '会话标题', 'Session Title')}
                    <input
                      aria-label={pickLocale(locale, '会话标题', 'Session Title')}
                      name="custom_title"
                      value={titleDraft}
                      onChange={(event) => {
                        setTitleDraft(event.target.value);
                        setIsTitleDirty(true);
                      }}
                      disabled={!canOperate(user)}
                    />
                  </label>
                  <button type="submit" disabled={!canOperate(user)}>
                    <Check size={16} />
                    {pickLocale(locale, '保存标题', 'Save Title')}
                  </button>
                </form>
              </Panel>
            </>
          )}

          <Panel title={pickLocale(locale, 'Provider 状态', 'Provider Status')} icon={<TerminalSquare size={16} />} defaultOpen={false}>
            {providers.length > 0 ? (
              providers.map((provider) => (
                <div className="provider-row" key={`${provider.worker_id}-${provider.backend}`}>
                  <div>
                    <strong>{backendLabel(provider.backend)}</strong>
                    <small>
                      {provider.worker_id} · {statusLabel(provider.status, locale)} · {provider.auth_status ?? 'unknown'}
                    </small>
                    <span className="provider-interaction">{providerInteractionSummary(provider, locale)}</span>
                  </div>
                  {canAdmin(user) && (
                    <div className="provider-actions">
                      <button type="button" onClick={() => handleProviderAuth(provider.worker_id, provider.backend, 'login')}>
                        {pickLocale(locale, '登录', 'Log in')}
                      </button>
                      <button type="button" onClick={() => handleProviderAuth(provider.worker_id, provider.backend, 'logout')}>
                        {backendLabel(provider.backend)} {pickLocale(locale, '退出', 'Log out')}
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="empty">{pickLocale(locale, '暂无 Provider 快照。', 'No provider snapshots.')}</p>
            )}
          </Panel>

          {canAdmin(user) && (
            <Panel title="Secrets" icon={<Lock size={16} />} defaultOpen={false}>
              <form className="secret-form" onSubmit={handleSecretSubmit}>
                <div className="control-fields">
                  <label>
                    {pickLocale(locale, 'Secret 名称', 'Secret Name')}
                    <input
                      aria-label={pickLocale(locale, 'Secret 名称', 'Secret Name')}
                      value={secretDraft.name}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="OPENAI_API_KEY"
                    />
                  </label>
                  <label>
                    {pickLocale(locale, 'Secret 环境配置', 'Secret Environment')}
                    <input
                      aria-label={pickLocale(locale, 'Secret 环境配置', 'Secret Environment')}
                      value={secretDraft.environment}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, environment: event.target.value }))}
                      placeholder="default / test / prod"
                    />
                  </label>
                  <label>
                    {pickLocale(locale, 'Secret 命名空间配置', 'Secret Namespace')}
                    <input
                      aria-label={pickLocale(locale, 'Secret 命名空间配置', 'Secret Namespace')}
                      value={secretDraft.namespace}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, namespace: event.target.value }))}
                      placeholder="default"
                    />
                  </label>
                  <label>
                    {pickLocale(locale, 'Secret 值', 'Secret Value')}
                    <input
                      aria-label={pickLocale(locale, 'Secret 值', 'Secret Value')}
                      type="password"
                      value={secretDraft.value}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, value: event.target.value }))}
                      placeholder="只保存，不显示"
                    />
                  </label>
                </div>
                <label className="secret-ref-field">
                  {pickLocale(locale, '描述', 'Description')}
                  <input
                    aria-label={pickLocale(locale, 'Secret 描述', 'Secret Description')}
                    value={secretDraft.description}
                    onChange={(event) => setSecretDraft((current) => ({ ...current, description: event.target.value }))}
                    placeholder="例如：prod OpenAI-compatible key"
                  />
                </label>
                <button type="submit">{pickLocale(locale, '保存 Secret', 'Save Secret')}</button>
              </form>
              <div className="secret-list" aria-label="Secrets list">
                {secrets.length === 0 && <p className="empty">{pickLocale(locale, '暂无 Secret。保存后在会话控制里引用名称。', 'No secrets yet. Save one, then reference its name in session controls.')}</p>}
                {secrets.slice(0, 8).map((secret) => (
                  <div className="secret-row" key={secret.secret_id}>
                    <strong>{secret.name}</strong>
                    <small>{secret.environment} · {secret.namespace}</small>
                    {secret.description && <span>{secret.description}</span>}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel title={pickLocale(locale, '节点健康', 'Worker Health')} icon={<Activity size={16} />} defaultOpen={false}>
            {(selectedWorker ? [selectedWorker] : workers).map((worker) => (
              <div className="rail-row" key={worker.worker_id}>
                <span className={`status-dot ${statusClass(worker.status)}`} />
                <span>{worker.worker_id}</span>
                <small>{statusLabel(worker.status, locale)}</small>
              </div>
            ))}
            {workers.length === 0 && <p className="empty">{pickLocale(locale, '暂无在线节点。', 'No online workers.')}</p>}
            {canAdmin(user) && (
              <button type="button" onClick={openWorkerInstall}>
                {t(locale, 'addWorker')}
              </button>
            )}
          </Panel>
          {selectedJobs.length > 0 && (
            <Panel title={pickLocale(locale, '当前作业', 'Current Jobs')} icon={<TerminalSquare size={16} />}>
              {selectedJobs.slice(0, 4).map((job) => {
                const hint = jobStatusHint(job);
                return (
                  <details className="job-row" key={job.job_id} open={job.status === 'running' || job.status === 'queued'}>
                    <summary>
                      <span className={`status-dot ${statusClass(job.status)}`} />
                      <span>{job.kind}</span>
                      <small>{statusLabel(job.status, locale)}</small>
                    </summary>
                    {hint && <p className="job-hint">{hint}</p>}
                    {job.error_text ? (
                      <p className="job-error">{failureSummary(job.error_text)}</p>
                    ) : job.result_text ? (
                      <p className="job-result">{jobResultSummary(job.result_text)}</p>
                    ) : (
                      <p className="empty">{pickLocale(locale, '等待 worker 处理。', 'Waiting for worker.')}</p>
                    )}
                    {(job.error_text || job.result_text) && (
                      <details className="raw-detail">
                        <summary>{pickLocale(locale, '原始输出', 'Raw Output')}</summary>
                        <code>{job.error_text || job.result_text}</code>
                      </details>
                    )}
                  </details>
                );
              })}
            </Panel>
          )}
          {schedules.length > 0 || canAdmin(user) ? (
          <Panel title={pickLocale(locale, '计划任务', 'Schedules')} icon={<CalendarClock size={16} />} defaultOpen={false}>
            {schedules.slice(0, 6).map((schedule) => (
              <div className="event-row" key={schedule.schedule_id}>
                <span>{schedule.name}</span>
                <small>{schedule.enabled ? 'enabled' : 'disabled'} · {schedule.job_kind}</small>
              </div>
            ))}
            {schedules.length === 0 && <p className="empty">{pickLocale(locale, '暂无计划任务。', 'No schedules.')}</p>}
            {canAdmin(user) && (
              <form className="schedule-form" onSubmit={handleCreateSchedule}>
                <input
                  aria-label="Schedule name"
                  value={scheduleDraft.name}
                  onChange={(event) => setScheduleDraft({ ...scheduleDraft, name: event.target.value })}
                />
                <select
                  aria-label="Schedule job kind"
                  value={scheduleDraft.job_kind}
                  onChange={(event) => setScheduleDraft({ ...scheduleDraft, job_kind: event.target.value })}
                >
                  <option value="health_check">health_check</option>
                  <option value="session_discovery">session_discovery</option>
                  <option value="observer">observer</option>
                  <option value="reflector">reflector</option>
                  <option value="memory_extract">memory_extract</option>
                </select>
                <input
                  aria-label="Schedule interval"
                  type="number"
                  min={30}
                  value={scheduleDraft.interval_seconds}
                  onChange={(event) =>
                    setScheduleDraft({ ...scheduleDraft, interval_seconds: Number(event.target.value) })
                  }
                />
                <select
                  aria-label="Schedule worker"
                  value={scheduleDraft.target_worker_id}
                  onChange={(event) => setScheduleDraft({ ...scheduleDraft, target_worker_id: event.target.value })}
                >
                  <option value="">any worker</option>
                  {workers.map((worker) => (
                    <option value={worker.worker_id} key={worker.worker_id}>
                      {worker.worker_id}
                    </option>
                  ))}
                </select>
                <button type="submit">{pickLocale(locale, '创建计划', 'Create Schedule')}</button>
              </form>
            )}
          </Panel>
          ) : null}
          {events.length > 0 && (
          <Panel title={pickLocale(locale, '审计事件', 'Audit Events')} icon={<Lock size={16} />} defaultOpen={false}>
            {events.slice(0, 6).map((event) => (
              <div className="event-row" key={event.event_id}>
                <span>{event.event_type}</span>
                <small>{event.actor_type}:{event.actor_id}</small>
              </div>
            ))}
          </Panel>
          )}
          {canAdmin(user) && (
            <button type="button" className="invite-button" onClick={openInviteDialog}>
              {pickLocale(locale, '邀请用户', 'Invite User')}
            </button>
          )}
        </aside>

        {mobilePane === 'files' && (
        <MobileFilesPane
          session={selectedSession}
          workers={workers}
          workerId={fileWorkerId}
          workspaceRoot={fileWorkspaceRoot || selectedSession?.workspace_root || ''}
          workspaceView={fileWorkspaceView}
          jobs={fileJobs}
          attachments={replyAttachments}
          locale={locale}
          onWorkerChange={handleFileWorkerChange}
          onWorkspaceRootChange={handleFileWorkspaceRootChange}
          onWorkspaceViewChange={changeFileWorkspaceView}
          onWorkspaceBack={returnToFileExplorer}
          onCopyPath={(value) => void copyTextToClipboard(value, 'file path 已复制')}
          onCopyText={(value) => void copyTextToClipboard(value, '文件内容已复制')}
          onDownload={handleDownloadWorkspaceFile}
          onEdit={handleOpenFileEditor}
          onList={(path) => void handleFileList(path)}
          onRead={(path, capability) => void handleFileRead(path, undefined, capability)}
          onUpload={(path, file, overwrite) => handleFileUpload(path, file, overwrite)}
          onCreate={(path, text, overwrite) => handleFileCreate(path, text, overwrite)}
          onMkdir={(path) => handleFileMkdir(path)}
          onRename={(path, nextPath, expectedModifiedAt) => handleFileRename(path, nextPath, expectedModifiedAt)}
        />
        )}
        {mobilePane === 'workers' && (
          <MobileWorkersPane
            workers={workers}
            jobs={jobs}
            providers={providers}
            locale={locale}
            canAdmin={canAdmin(user)}
            onAddWorker={openWorkerInstall}
          />
        )}
        {mobilePane === 'me' && (
          <MobileMePane
            user={user}
            notificationPermission={notificationPermission}
            secrets={secrets}
            pendingCount={pendingPermissions.length}
            workers={workers}
            lastSyncedAt={lastSyncedAt}
            nativeVersion={nativeVersion}
            apkUpdates={apkUpdates}
            apkUrls={{ webview: apkDownloadUrl('webview'), native: apkDownloadUrl('native') }}
            locale={locale}
            preferences={settings.preferences}
            options={settings.options}
            workerRuntimeDefaults={settings.worker_runtime_defaults}
            themeMode={themeMode}
            canAdmin={canAdmin(user)}
            onLocaleChange={handleLocaleChange}
            onThemeModeChange={handleThemeModeChange}
            onVoicePreferenceChange={handleVoicePreferenceChange}
            onWorkerRuntimeDefaultsChange={handleWorkerRuntimeDefaultsChange}
            onNotificationSetup={() => void handleNotificationSetup()}
            onRestartNotificationGuard={handleRestartNotificationGuard}
            onCheckApkUpdate={() => void handleCheckApkUpdate()}
            onDownloadApk={handleDownloadApk}
            onCopyApkUrl={(channel) => void copyTextToClipboard(apkDownloadUrl(channel), 'APK 地址已复制')}
            onLogout={handleLogout}
          />
        )}
      </section>
      )}

      {taskComposerOpen && (
        <div className="dialog-backdrop task-composer-backdrop" role="presentation">
          <form
            className="launch-dialog task-composer"
            role="dialog"
            aria-modal="true"
            aria-label={pickLocale(locale, '新建任务', 'New task')}
            onSubmit={handleCreateTask}
          >
            <div className="dialog-head">
              <div>
                <p>Workbench</p>
                <h2>{pickLocale(locale, '新建任务', 'New task')}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={pickLocale(locale, '关闭', 'Close')}
                onClick={() => setTaskComposerOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="task-template-picker" role="group" aria-label={pickLocale(locale, '任务模板', 'Task template')}>
              {TASK_TEMPLATES.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  className={taskDraft.template_key === template.key ? 'selected' : ''}
                  aria-pressed={taskDraft.template_key === template.key}
                  onClick={() =>
                    setTaskDraft((current) => ({
                      ...current,
                      template_key: template.key,
                      authority_preset: template.authority,
                      success_criteria_markdown: pickLocale(locale, template.criteriaZh, template.criteriaEn),
                    }))
                  }
                >
                  {pickLocale(locale, template.labelZh, template.labelEn)}
                </button>
              ))}
            </div>
            <div className="task-composer-fields">
              <label className="task-field-wide">
                {pickLocale(locale, '任务标题', 'Task title')}
                <input
                  aria-label={pickLocale(locale, '任务标题', 'Task title')}
                  value={taskDraft.title}
                  placeholder={pickLocale(locale, '用一句话说明要完成的结果', 'Describe the outcome in one sentence')}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))}
                  required
                />
              </label>
              <label className="task-field-wide">
                {pickLocale(locale, '任务说明', 'Task brief')}
                <textarea
                  aria-label={pickLocale(locale, '任务说明', 'Task brief')}
                  value={taskDraft.brief_markdown}
                  placeholder={pickLocale(locale, '提供背景、范围和必要约束', 'Add context, scope, and constraints')}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, brief_markdown: event.target.value }))}
                  required
                />
              </label>
              <label className="task-field-wide">
                {pickLocale(locale, '验收标准', 'Success criteria')}
                <textarea
                  aria-label={pickLocale(locale, '验收标准', 'Success criteria')}
                  value={taskDraft.success_criteria_markdown}
                  onChange={(event) =>
                    setTaskDraft((current) => ({ ...current, success_criteria_markdown: event.target.value }))
                  }
                />
              </label>
              <label>
                {pickLocale(locale, '目标节点', 'Worker')}
                <select
                  aria-label={pickLocale(locale, '目标节点', 'Worker')}
                  value={taskDraft.target_worker_id}
                  onChange={(event) => {
                    const worker = workers.find((item) => item.worker_id === event.target.value);
                    setTaskDraft((current) => ({
                      ...current,
                      target_worker_id: event.target.value,
                      backend: worker?.reachable_backends?.[0] ?? '',
                      workspace_root: worker?.workspace_roots?.[0] ?? '',
                    }));
                  }}
                  required
                >
                  {workers.length === 0 ? <option value="">{pickLocale(locale, '暂无可用节点', 'No workers available')}</option> : null}
                  {workers.map((worker) => (
                    <option key={worker.worker_id} value={worker.worker_id}>
                      {worker.machine_name || worker.worker_id} · {worker.status}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Agent
                <select
                  aria-label="Agent"
                  value={taskDraft.backend}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, backend: event.target.value }))}
                  required
                >
                  {taskBackendOptions.map((backend) => (
                    <option key={backend} value={backend}>{backendLabel(backend)}</option>
                  ))}
                </select>
              </label>
              <label>
                {pickLocale(locale, '工作区', 'Workspace')}
                <select
                  aria-label={pickLocale(locale, '工作区', 'Workspace')}
                  value={taskDraft.workspace_root}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, workspace_root: event.target.value }))}
                  required
                >
                  {taskWorkspaceOptions.map((workspace) => (
                    <option key={workspace} value={workspace}>{workspace}</option>
                  ))}
                </select>
              </label>
              <label>
                {pickLocale(locale, '权限范围', 'Authority')}
                <select
                  aria-label={pickLocale(locale, '权限范围', 'Authority')}
                  value={taskDraft.authority_preset}
                  onChange={(event) =>
                    setTaskDraft((current) => ({ ...current, authority_preset: event.target.value as TaskAuthorityPreset }))
                  }
                >
                  <option value="read_only">{pickLocale(locale, '只读分析', 'Read only')}</option>
                  <option value="code_fix">{pickLocale(locale, '修复代码', 'Code fix')}</option>
                  <option value="feature">{pickLocale(locale, '实现功能', 'Feature work')}</option>
                  <option value="review_only">{pickLocale(locale, '仅审查', 'Review only')}</option>
                </select>
              </label>
              <label className="task-field-wide">
                {pickLocale(locale, '相关路径', 'Relevant paths')}
                <textarea
                  className="task-paths-field"
                  aria-label={pickLocale(locale, '相关路径', 'Relevant paths')}
                  value={taskDraft.relevant_paths}
                  placeholder={pickLocale(locale, '每行一个文件或目录，可留空', 'One file or directory per line, optional')}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, relevant_paths: event.target.value }))}
                />
              </label>
            </div>
            <div className="task-composer-actions">
              <button type="button" className="secondary-action" onClick={() => setTaskComposerOpen(false)}>
                {pickLocale(locale, '取消', 'Cancel')}
              </button>
              <button
                type="submit"
                className="primary-top-action"
                disabled={
                  !taskDraft.title.trim() ||
                  !taskDraft.brief_markdown.trim() ||
                  !taskDraft.target_worker_id ||
                  !taskDraft.backend ||
                  !taskDraft.workspace_root
                }
              >
                {pickLocale(locale, '提交任务', 'Submit task')}
              </button>
            </div>
          </form>
        </div>
      )}

      {launchMode !== 'none' && (
        <SessionLaunchDialog
          mode={launchMode}
          draft={launchDraft}
          workers={workers}
          launchWorker={launchWorker}
          provider={launchProvider}
          selectedSession={selectedSession}
          canSubmit={canOperate(user)}
          onChange={setLaunchDraft}
          onClose={closeLaunchDialog}
          onSubmit={handleLaunchSubmit}
        />
      )}
      {workerInstallOpen && (
        <WorkerInstallDialog
          draft={workerInstallDraft}
          enrollment={workerEnrollment}
          canSubmit={canAdmin(user)}
          onChange={setWorkerInstallDraft}
          onClose={closeWorkerInstall}
          onSubmit={handleCreateWorkerEnrollment}
        />
      )}
      {inviteOpen && (
        <InviteUserDialog
          draft={inviteDraft}
          created={createdInvite}
          onChange={setInviteDraft}
          onClose={closeInviteDialog}
          onCopy={(value, message) => void copyTextToClipboard(value, message)}
          onSubmit={handleCreateInvite}
        />
      )}

      {appMode === 'session' ? (
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button type="button" className={mobilePane === 'sessions' ? 'selected' : ''} onClick={showSessionList}>
            <MessageCircle size={18} />
            {text.mobileSessions}
          </button>
          <button type="button" className={mobilePane === 'thread' ? 'selected' : ''} onClick={() => navigateMobilePane('thread')}>
            <Play size={18} />
            {text.mobileThread}
          </button>
          <button type="button" className={mobilePane === 'files' ? 'selected' : ''} onClick={() => navigateMobilePane('files')}>
            <Folder size={18} />
            {text.mobileFiles}
          </button>
          <button type="button" className={mobilePane === 'workers' ? 'selected' : ''} onClick={() => navigateMobilePane('workers')}>
            <Cpu size={18} />
            {text.mobileWorkers}
          </button>
          <button
            type="button"
            className={mobilePane === 'me' ? 'selected' : ''}
            onClick={() => navigateMobilePane('me')}
          >
            <UserCircle size={18} />
            {text.mobileMe}
          </button>
        </nav>
      ) : null}
      {fileEditor && (
        <WorkspaceTextEditorDialog
          locale={locale}
          state={fileEditor}
          saving={isSavingFileEditor}
          onClose={() => setFileEditor(null)}
          onSave={(nextText) => handleFileWrite(fileEditor.path, nextText, fileEditor.expectedModifiedAt, fileEditor.target)}
        />
      )}
    </main>
  );
}

function NotificationInbox({
  items,
  readIds,
  locale,
  onOpenItem,
  onMarkAllRead,
  onClose,
}: {
  items: NotificationInboxItem[];
  readIds: Set<string>;
  locale: LocaleCode;
  onOpenItem: (item: NotificationInboxItem) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}) {
  const unreadCount = items.filter((item) => !readIds.has(item.id)).length;
  return (
    <section className="notification-inbox" role="dialog" aria-label={t(locale, 'notificationInbox')}>
      <header>
        <div>
          <p>{unreadCount > 0 ? t(locale, 'unreadCount', { count: unreadCount }) : t(locale, 'allRead')}</p>
          <h2>{t(locale, 'notifications')}</h2>
        </div>
        <button type="button" className="native-icon-button" aria-label={t(locale, 'closeNotificationInbox')} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="notification-inbox-actions">
        <button type="button" className="message-action-button" onClick={onMarkAllRead} disabled={items.length === 0}>
          <Check size={13} />
          {t(locale, 'markAllRead')}
        </button>
      </div>
      <div className="notification-inbox-list">
        {items.length === 0 && <p className="empty">{t(locale, 'emptyNotifications')}</p>}
        {items.map((item) => {
          const unread = !readIds.has(item.id);
          return (
            <button
              type="button"
              className={`notification-inbox-item ${unread ? 'unread' : ''}`}
              key={item.id}
              onClick={() => onOpenItem(item)}
            >
              <span className="notification-inbox-dot" />
              <span>
                <strong>{item.title}</strong>
                <small>{item.body}</small>
              </span>
              <em>{unread ? t(locale, 'unread') : t(locale, 'read')}</em>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MobileFilesPane({
  session,
  workers,
  workerId,
  workspaceRoot,
  workspaceView,
  jobs,
  attachments,
  locale,
  onWorkerChange,
  onWorkspaceRootChange,
  onWorkspaceViewChange,
  onWorkspaceBack,
  onCopyPath,
  onCopyText,
  onDownload,
  onEdit,
  onList,
  onRead,
  onUpload,
  onCreate,
  onMkdir,
  onRename,
}: {
  session?: AgentSession | null;
  workers: Worker[];
  workerId: string;
  workspaceRoot: string;
  workspaceView: WorkspaceView;
  jobs: Job[];
  attachments?: ReplyAttachment[];
  locale: LocaleCode;
  onWorkerChange: (workerId: string) => void;
  onWorkspaceRootChange: (workspaceRoot: string) => void;
  onWorkspaceViewChange: (view: WorkspaceView, push?: boolean) => void;
  onWorkspaceBack: () => void;
  onCopyPath: (value: string) => void;
  onCopyText: (value: string) => void;
  onDownload: (file: WorkspaceFileReadResult) => void;
  onEdit: (file: WorkspaceFileReadResult) => void;
  onList: (path: string) => void;
  onRead: (path: string, capability?: WorkspaceFileEntry['preview_capability']) => void;
  onUpload: (path: string, file: File, overwrite?: boolean) => Promise<WorkspaceFileMutationResult | null>;
  onCreate: (path: string, text: string, overwrite?: boolean) => Promise<WorkspaceFileMutationResult | null>;
  onMkdir: (path: string) => Promise<WorkspaceFileMutationResult | null>;
  onRename: (path: string, newPath: string, expectedModifiedAt?: string | null) => Promise<WorkspaceFileMutationResult | null>;
}) {
  const selectedFileWorker = workers.find((worker) => worker.worker_id === workerId);
  const workspaceRoots = selectedFileWorker?.workspace_roots ?? (workspaceRoot ? [workspaceRoot] : []);
  const listResult = fileListResult(jobs);
  const readResult = fileReadResult(jobs);
  const busy = fileJobBusy(jobs);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [detailsTarget, setDetailsTarget] = useState<WorkspaceDetailsTarget | null>(null);
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [imageLightbox, setImageLightbox] = useState(false);
  const currentPath = listResult?.path || '.';
  const parentPath =
    currentPath === '.'
      ? null
      : currentPath.includes('/')
        ? currentPath.slice(0, currentPath.lastIndexOf('/')) || '.'
        : '.';
  const previewLines = readResult?.text?.split(/\r?\n/).filter((line) => line.trim()) ?? [];
  const previewHeadline = previewLines[0] ?? '';
  const previewSummary = previewLines.find((line) => line !== previewHeadline) ?? '';
  const imagePreviewUrl = readResult?.preview_kind === 'image' ? workspaceFileDataUrl(readResult) : null;
  const mediaPreviewUrl =
    readResult && (readResult.preview_kind === 'audio' || readResult.preview_kind === 'video') ? workspaceFileDataUrl(readResult) : null;
  const markdownHtml = readResult?.text && isMarkdownWorkspaceFile(readResult) ? renderMarkdownPreview(readResult.text) : '';
  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const entries = listResult?.entries ?? [];
    if (!normalized) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(normalized) || entry.path.toLowerCase().includes(normalized));
  }, [listResult?.entries, query]);

  useEffect(() => {
    if (!readResult?.path) return;
    setRecentPaths((current) => [readResult.path, ...current.filter((item) => item !== readResult.path)].slice(0, 8));
    if (!isMarkdownWorkspaceFile(readResult)) setMarkdownPreview(true);
  }, [readResult?.path, readResult?.filename, readResult?.modified_at]);

  useEffect(() => {
    onWorkspaceViewChange('explorer', false);
    setQuery('');
    setDetailsTarget(null);
  }, [workerId, workspaceRoot]);

  function openDirectory(path: string) {
    onWorkspaceViewChange('explorer', false);
    onList(path);
  }

  function openFile(path: string, capability?: WorkspaceFileEntry['preview_capability']) {
    onWorkspaceViewChange('preview', true);
    onRead(path, capability);
  }

  function openDetailsForEntry(entry: WorkspaceFileEntry) {
    setDetailsTarget({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      modifiedAt: entry.modified_at,
      previewCapability: fileEntryCapability(entry),
      isEditable: entry.is_editable,
    });
  }

  function openDetailsForPreview() {
    if (!readResult) return;
    setDetailsTarget({
      path: readResult.path,
      name: readResult.filename,
      kind: 'file',
      contentType: readResult.content_type,
      sizeBytes: readResult.size_bytes,
      modifiedAt: readResult.modified_at,
      previewCapability: readResult.preview_kind === 'text' && isMarkdownWorkspaceFile(readResult) ? 'markdown' : (readResult.preview_kind ?? 'download'),
      isEditable: isEditableWorkspaceText(readResult),
      expectedModifiedAt: readResult.modified_at,
    });
  }

  async function handleCreateFileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('path') ?? '').trim();
    const text = String(form.get('text') ?? '');
    if (!name) return;
    const nextPath = currentPath === '.' ? name : `${currentPath}/${name}`;
    const created = await onCreate(nextPath, text, false);
    if (!created?.path) return;
    setShowCreateFile(false);
    onList(currentPath);
    openFile(created.path);
  }

  async function handleCreateFolderSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('path') ?? '').trim();
    if (!name) return;
    const nextPath = currentPath === '.' ? name : `${currentPath}/${name}`;
    const created = await onMkdir(nextPath);
    if (!created?.path) return;
    setShowCreateFolder(false);
    onList(currentPath);
  }

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detailsTarget) return;
    const form = new FormData(event.currentTarget);
    const nextName = String(form.get('new_name') ?? '').trim();
    if (!nextName) return;
    const parent = detailsTarget.path.includes('/') ? detailsTarget.path.slice(0, detailsTarget.path.lastIndexOf('/')) : '.';
    const nextPath = parent === '.' ? nextName : `${parent}/${nextName}`;
    const renamed = await onRename(detailsTarget.path, nextPath, detailsTarget.expectedModifiedAt);
    if (!renamed?.path) return;
    setShowRename(false);
    setDetailsTarget(null);
    onList(parent === '.' ? '.' : parent);
    if (detailsTarget.kind === 'file') openFile(renamed.path);
  }

  async function handleUploadInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const uploaded = await onUpload(currentPath, file, false);
    if (!uploaded?.path) return;
    onList(currentPath);
  }

  return (
    <section className="mobile-panel files-pane" aria-label={t(locale, 'filePane')}>
      <input ref={fileInputRef} type="file" hidden onChange={handleUploadInput} />
      <div className="mobile-panel-head">
        <div>
          <p>{selectedFileWorker?.machine_name || selectedFileWorker?.worker_id || (session ? sessionTitle(session) : t(locale, 'currentNoSession'))}</p>
          <h2>{t(locale, 'fileBrowser')}</h2>
        </div>
        <button type="button" className={`native-icon-button ${busy ? 'loading' : ''}`} disabled={!workspaceRoot} onClick={() => onList(currentPath)} aria-label={pickLocale(locale, '刷新文件', 'Refresh files')}>
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="file-context-card">
        {workers.length > 0 && (
          <div className="file-target-grid">
            <label>
              <span>{pickLocale(locale, '文件 Worker', 'File worker')}</span>
              <select aria-label={pickLocale(locale, '文件 Worker', 'File worker')} value={workerId} onChange={(event) => onWorkerChange(event.target.value)}>
                {workers.map((worker) => (
                  <option key={worker.worker_id} value={worker.worker_id}>
                    {worker.machine_name || worker.worker_id} · {worker.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{pickLocale(locale, '工作区根目录', 'Workspace root')}</span>
              <select
                aria-label={pickLocale(locale, '工作区根目录', 'Workspace root')}
                value={workspaceRoot}
                disabled={workspaceRoots.length === 0}
                onChange={(event) => onWorkspaceRootChange(event.target.value)}
              >
                {workspaceRoots.map((root) => (
                  <option key={root} value={root}>{root}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {workers.length === 0 && (
          <>
            <span>{t(locale, 'workspace')}</span>
            <code>{workspaceRoot || t(locale, 'workspaceUnbound')}</code>
          </>
        )}
        <div className="file-toolbar">
          <button
            type="button"
            className="message-action-button"
            aria-label={t(locale, 'copyFilePath')}
            disabled={!workspaceRoot}
            onClick={() => onCopyPath(workspaceRoot)}
          >
            <Copy size={13} />
            {t(locale, 'copyPath')}
          </button>
          <button
            type="button"
            className="message-action-button"
            aria-label={pickLocale(locale, '浏览工作区', 'Browse workspace')}
            disabled={!workspaceRoot}
            onClick={() => openDirectory('.')}
          >
            <Folder size={13} />
            {t(locale, 'browseWorkspace')}
          </button>
          <button type="button" className="message-action-button" disabled={!workspaceRoot} onClick={() => setShowCreateFile(true)}>
            <Plus size={13} />
            {pickLocale(locale, '新建文件', 'New file')}
          </button>
          <button type="button" className="message-action-button" disabled={!workspaceRoot} onClick={() => setShowCreateFolder(true)}>
            <Folder size={13} />
            {pickLocale(locale, '新建文件夹', 'New folder')}
          </button>
          <button type="button" className="message-action-button" disabled={!workspaceRoot} onClick={() => fileInputRef.current?.click()}>
            <Download size={13} />
            {pickLocale(locale, '上传文件', 'Upload file')}
          </button>
        </div>
      </div>
      <div className={`remote-workspace-layout view-${workspaceView}`}>
      <div className="remote-workspace-explorer">
      <div className="file-browser-card">
        <div className="file-browser-title">
          <span>{currentPath === '.' ? t(locale, 'workspaceRoot') : currentPath}</span>
          {busy && <small>{t(locale, 'syncing')}</small>}
        </div>
        <p className="file-note">{t(locale, 'fileBrowserNote')}</p>
        <label className="file-search-row">
          <Search size={15} />
          <input
            aria-label={pickLocale(locale, '筛选当前目录', 'Filter current directory')}
            placeholder={pickLocale(locale, '筛选文件或路径', 'Filter files or paths')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {parentPath && (
          <button type="button" className="message-action-button" onClick={() => openDirectory(parentPath)}>
            <RotateCcw size={13} />
            {t(locale, 'goParent')}
          </button>
        )}
        {!listResult && <p className="empty">{t(locale, 'browseWorkspaceEmpty')}</p>}
        {listResult && filteredEntries.length === 0 && <p className="empty">{query ? pickLocale(locale, '当前目录没有匹配结果。', 'No matches in this directory.') : t(locale, 'emptyDirectory')}</p>}
        {filteredEntries.map((entry) => {
          const EntryIcon = fileEntryIcon(entry);
          return (
          <div className="file-row" key={entry.path}>
            <button
              type="button"
              className="file-row-main"
              aria-label={entry.kind === 'directory' ? t(locale, 'enterDirectory', { name: entry.name }) : t(locale, 'previewFile', { name: entry.name })}
              onClick={() => (entry.kind === 'directory' ? openDirectory(entry.path) : openFile(entry.path, entry.preview_capability))}
            >
              <EntryIcon size={17} />
              <span>
                <strong>{entry.name}</strong>
                <small>
                  {entry.kind === 'directory'
                    ? pickLocale(locale, '目录', 'Directory')
                    : `${formatFileSize(entry.size_bytes)} · ${previewCapabilityLabel(locale, fileEntryCapability(entry))} · ${formatWhen(entry.modified_at) || entry.path}`}
                </small>
              </span>
            </button>
            <button type="button" className="native-icon-button small" aria-label={t(locale, 'copyEntryPath', { name: entry.name })} onClick={() => onCopyPath(entry.path)}>
              <Copy size={14} />
            </button>
            <button type="button" className="native-icon-button small" aria-label={pickLocale(locale, `查看 ${entry.name} 详情`, `Inspect ${entry.name}`)} onClick={() => openDetailsForEntry(entry)}>
              <MoreHorizontal size={14} />
            </button>
          </div>
          );
        })}
        {listResult?.truncated && <p className="file-note">{t(locale, 'fileListTruncated')}</p>}
        {recentPaths.length > 0 && (
          <div className="file-recent-strip">
            <small>{pickLocale(locale, '最近打开', 'Recent')}</small>
            <div className="file-recent-chips">
              {recentPaths.map((path) => (
                <button key={path} type="button" className="file-recent-chip" onClick={() => openFile(path)}>
                  {path.split('/').pop() || path}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      </div>
      <div className="remote-workspace-preview">
      {readResult ? (
        <div className="file-preview-card">
          <div className="file-preview-head">
            <button
              type="button"
              className="native-icon-button small file-mobile-back"
              aria-label={pickLocale(locale, '返回文件列表', 'Back to files')}
                onClick={onWorkspaceBack}
            >
              <ArrowLeft size={15} />
            </button>
            <span>
              <strong>{readResult.filename || readResult.path}</strong>
              <small>
                {readResult.preview_kind === 'image'
                  ? t(locale, 'imagePreview')
                  : readResult.preview_kind === 'audio'
                    ? pickLocale(locale, '音频预览', 'Audio preview')
                    : readResult.preview_kind === 'video'
                      ? pickLocale(locale, '视频预览', 'Video preview')
                  : readResult.preview_kind === 'text'
                    ? isMarkdownWorkspaceFile(readResult)
                      ? pickLocale(locale, 'Markdown 预览', 'Markdown preview')
                      : t(locale, 'textPreview')
                    : t(locale, 'downloadPreview')}
                {' · '}
                {formatFileSize(readResult.size_bytes)}
                {readResult.truncated ? ` · ${t(locale, 'truncated')}` : ''}
              </small>
            </span>
            <div className="file-toolbar">
              {readResult.preview_kind === 'text' && (
                <button type="button" className="native-icon-button small" aria-label={t(locale, 'copyFileContent')} onClick={() => onCopyText(readResult.text || '')}>
                  <Copy size={14} />
                </button>
              )}
              <button type="button" className="native-icon-button small" aria-label={pickLocale(locale, '打开文件详情', 'Open file details')} onClick={openDetailsForPreview}>
                <MoreHorizontal size={14} />
              </button>
              {isEditableWorkspaceText(readResult) && (
                <button type="button" className="message-action-button" onClick={() => onEdit(readResult)}>
                  <FileText size={13} />
                  {t(locale, 'editTextFile')}
                </button>
              )}
              {readResult.downloadable && (
                <button type="button" className="message-action-button" onClick={() => onDownload(readResult)}>
                  <Download size={13} />
                  {readResult.preview_kind === 'image' ? t(locale, 'downloadOriginal') : t(locale, 'downloadFile')}
                </button>
              )}
            </div>
          </div>
          {readResult.preview_kind === 'image' && imagePreviewUrl && (
            <button type="button" className="file-image-button" onClick={() => setImageLightbox(true)}>
              <img className="file-preview-image" src={imagePreviewUrl} alt={readResult.filename} />
            </button>
          )}
          {(readResult.preview_kind === 'audio' || readResult.preview_kind === 'video') && mediaPreviewUrl && (
            <div className="file-media-preview">
              {readResult.preview_kind === 'audio' ? (
                <audio controls preload="metadata" src={mediaPreviewUrl} />
              ) : (
                <video controls preload="metadata" src={mediaPreviewUrl} />
              )}
            </div>
          )}
          {readResult.preview_kind === 'text' && (
            <>
              {isMarkdownWorkspaceFile(readResult) && (
                <div className="file-preview-mode-tabs" role="tablist" aria-label={pickLocale(locale, 'Markdown 模式切换', 'Markdown mode switch')}>
                  <button type="button" className={markdownPreview ? 'selected' : ''} aria-pressed={markdownPreview} onClick={() => setMarkdownPreview(true)}>
                    {pickLocale(locale, '预览', 'Preview')}
                  </button>
                  <button type="button" className={!markdownPreview ? 'selected' : ''} aria-pressed={!markdownPreview} onClick={() => setMarkdownPreview(false)}>
                    {pickLocale(locale, '源码', 'Source')}
                  </button>
                </div>
              )}
              {previewHeadline && <strong className="file-preview-title">{previewHeadline}</strong>}
              {previewSummary && <small className="file-preview-summary">{previewSummary}</small>}
              {isMarkdownWorkspaceFile(readResult) && markdownPreview ? (
                <div className="file-markdown-preview" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
              ) : (
                <pre>{readResult.text}</pre>
              )}
            </>
          )}
          {readResult.preview_kind === 'download' && <p className="empty">{t(locale, 'nonTextDownload')}</p>}
        </div>
      ) : (
        <div className="file-preview-card remote-workspace-empty-preview">
          <FileText size={24} />
          <strong>{pickLocale(locale, '选择文件查看内容', 'Select a file to preview')}</strong>
          <small>{pickLocale(locale, '图片、Markdown、文本和媒体会在这里打开。', 'Images, Markdown, text, and media open here.')}</small>
        </div>
      )}
      </div>
      </div>
      {attachments && attachments.length > 0 && (
        <div className="mobile-panel-card attached-file-card">
          <strong>{t(locale, 'pendingAttachments')}</strong>
          {attachments.map((attachment, index) => (
            <span key={`${attachment.filename}-${index}`}>
              {attachment.filename}
              <small>{attachment.content_type} · {Math.max(1, Math.round(attachment.size_bytes / 1024))} KB</small>
            </span>
          ))}
        </div>
      )}
      {detailsTarget && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setDetailsTarget(null)}>
          <div className="file-details-sheet" role="dialog" aria-modal="true" aria-label={pickLocale(locale, '文件详情', 'File details')} onClick={(event) => event.stopPropagation()}>
            <div className="file-details-head">
              <div>
                <strong>{detailsTarget.name}</strong>
                <small>{detailsTarget.path}</small>
              </div>
              <button type="button" className="icon-button" onClick={() => setDetailsTarget(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="file-details-grid">
              <span>{pickLocale(locale, '类型', 'Type')}</span>
              <strong>{detailsTarget.kind === 'directory' ? pickLocale(locale, '目录', 'Directory') : previewCapabilityLabel(locale, detailsTarget.previewCapability || 'download')}</strong>
              <span>{pickLocale(locale, '大小', 'Size')}</span>
              <strong>{detailsTarget.sizeBytes != null ? formatFileSize(detailsTarget.sizeBytes) : '-'}</strong>
              <span>{pickLocale(locale, '更新时间', 'Updated')}</span>
              <strong>{formatWhen(detailsTarget.modifiedAt) || '-'}</strong>
            </div>
            <div className="file-toolbar">
              <button type="button" className="message-action-button" onClick={() => onCopyPath(detailsTarget.path)}>
                <Copy size={13} />
                {t(locale, 'copyPath')}
              </button>
              {detailsTarget.kind === 'file' && (
                <button
                  type="button"
                  className="message-action-button"
                  onClick={() => {
                    setDetailsTarget(null);
                    openFile(detailsTarget.path);
                  }}
                >
                  <FileText size={13} />
                  {pickLocale(locale, '打开预览', 'Open preview')}
                </button>
              )}
              <button
                type="button"
                className="message-action-button"
                onClick={() => {
                  setShowRename(true);
                }}
              >
                <MoreHorizontal size={13} />
                {pickLocale(locale, '重命名', 'Rename')}
              </button>
            </div>
          </div>
        </div>
      )}
      {showCreateFile && (
        <div className="dialog-backdrop" role="presentation">
          <form className="file-action-dialog" role="dialog" aria-modal="true" aria-label={pickLocale(locale, '新建文件', 'New file')} onSubmit={handleCreateFileSubmit}>
            <div className="file-details-head">
              <strong>{pickLocale(locale, '新建文件', 'New file')}</strong>
              <button type="button" className="icon-button" onClick={() => setShowCreateFile(false)}>
                <X size={17} />
              </button>
            </div>
            <label>
              {pickLocale(locale, '文件名', 'Filename')}
              <input name="path" autoFocus placeholder="notes.md" />
            </label>
            <label>
              {pickLocale(locale, '初始内容', 'Initial content')}
              <textarea name="text" rows={8} />
            </label>
            <footer>
              <button type="button" className="message-action-button" onClick={() => setShowCreateFile(false)}>
                {t(locale, 'close')}
              </button>
              <button type="submit" className="message-action-button primary-inline-action">
                <Save size={13} />
                {pickLocale(locale, '创建并打开', 'Create and open')}
              </button>
            </footer>
          </form>
        </div>
      )}
      {showCreateFolder && (
        <div className="dialog-backdrop" role="presentation">
          <form className="file-action-dialog" role="dialog" aria-modal="true" aria-label={pickLocale(locale, '新建文件夹', 'New folder')} onSubmit={handleCreateFolderSubmit}>
            <div className="file-details-head">
              <strong>{pickLocale(locale, '新建文件夹', 'New folder')}</strong>
              <button type="button" className="icon-button" onClick={() => setShowCreateFolder(false)}>
                <X size={17} />
              </button>
            </div>
            <label>
              {pickLocale(locale, '文件夹名', 'Folder name')}
              <input name="path" autoFocus placeholder="notes" />
            </label>
            <footer>
              <button type="button" className="message-action-button" onClick={() => setShowCreateFolder(false)}>
                {t(locale, 'close')}
              </button>
              <button type="submit" className="message-action-button primary-inline-action">
                <Folder size={13} />
                {pickLocale(locale, '创建目录', 'Create folder')}
              </button>
            </footer>
          </form>
        </div>
      )}
      {showRename && detailsTarget && (
        <div className="dialog-backdrop" role="presentation">
          <form className="file-action-dialog" role="dialog" aria-modal="true" aria-label={pickLocale(locale, '重命名', 'Rename')} onSubmit={handleRenameSubmit}>
            <div className="file-details-head">
              <strong>{pickLocale(locale, '重命名', 'Rename')}</strong>
              <button type="button" className="icon-button" onClick={() => setShowRename(false)}>
                <X size={17} />
              </button>
            </div>
            <label>
              {pickLocale(locale, '新名称', 'New name')}
              <input name="new_name" autoFocus defaultValue={detailsTarget.name} />
            </label>
            <footer>
              <button type="button" className="message-action-button" onClick={() => setShowRename(false)}>
                {t(locale, 'close')}
              </button>
              <button type="submit" className="message-action-button primary-inline-action">
                <Save size={13} />
                {pickLocale(locale, '确认重命名', 'Rename')}
              </button>
            </footer>
          </form>
        </div>
      )}
      {imageLightbox && imagePreviewUrl && (
        <div className="fulltext-backdrop" role="presentation" onClick={() => setImageLightbox(false)}>
          <div className="file-image-lightbox" role="dialog" aria-modal="true" aria-label={pickLocale(locale, '图片预览', 'Image preview')} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button" onClick={() => setImageLightbox(false)}>
              <X size={18} />
            </button>
            <img src={imagePreviewUrl} alt={readResult?.filename || ''} />
          </div>
        </div>
      )}
    </section>
  );
}

function WorkspaceTextEditorDialog({
  locale,
  state,
  saving,
  onClose,
  onSave,
}: {
  locale: LocaleCode;
  state: FileEditorState;
  saving: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(state.text);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = draft !== state.text;
  const lineCount = Math.max(1, draft.split('\n').length);
  const lineNumbers = useMemo(() => Array.from({ length: lineCount }, (_value, index) => index + 1).join('\n'), [lineCount]);
  const searchMatchCount = useMemo(() => {
    const normalized = search.trim();
    if (!normalized) return 0;
    return draft.split(normalized).length - 1;
  }, [draft, search]);

  useEffect(() => {
    setDraft(state.text);
  }, [state.path, state.text, state.expectedModifiedAt]);

  async function handleCopy() {
    if (await writeTextToClipboard(draft)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(draft);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!dirty || saving) return;
      void onSave(draft);
    }
  }

  function jumpToSearch() {
    if (!search.trim() || !textareaRef.current) return;
    const index = draft.indexOf(search);
    if (index < 0) return;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(index, index + search.length);
  }

  return createPortal(
    <div className="fulltext-backdrop" role="presentation">
      <form className="file-editor-dialog" role="dialog" aria-modal="true" aria-label={t(locale, 'fileEditor')} onSubmit={handleSave}>
        <header>
          <span>
            <strong>{t(locale, 'fileEditor')}</strong>
            <small>{state.path}</small>
          </span>
          <button className="icon-button" type="button" aria-label={t(locale, 'closeFileEditor')} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="file-editor-meta">
          <span>{state.filename}</span>
          <small>{t(locale, 'fileEditorCount', { count: String(draft.length) })} · {pickLocale(locale, `${lineCount} 行`, `${lineCount} lines`)}</small>
        </div>
        <div className="file-editor-toolbar">
          <label className="file-search-row compact">
            <Search size={14} />
            <input
              aria-label={pickLocale(locale, '查找当前文件', 'Search in file')}
              placeholder={pickLocale(locale, '查找文本', 'Find text')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button type="button" className="message-action-button" onClick={jumpToSearch} disabled={!search.trim() || searchMatchCount === 0}>
            <Search size={13} />
            {pickLocale(locale, searchMatchCount > 0 ? `${searchMatchCount} 处匹配` : '查找', searchMatchCount > 0 ? `${searchMatchCount} matches` : 'Find')}
          </button>
        </div>
        <div className="file-editor-surface">
          <pre className="file-editor-gutter" aria-hidden="true">{lineNumbers}</pre>
          <textarea
            ref={textareaRef}
            aria-label={t(locale, 'fileEditorInput')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <footer>
          <span className="file-editor-dirty">{dirty ? pickLocale(locale, '有未保存修改', 'Unsaved changes') : pickLocale(locale, '已同步', 'Saved')}</span>
          <button className="message-action-button" type="button" onClick={handleCopy}>
            <Copy size={13} />
            {copied ? t(locale, 'copied') : t(locale, 'copyFileContent')}
          </button>
          <button className="message-action-button" type="button" onClick={onClose}>
            {t(locale, 'close')}
          </button>
          <button className="message-action-button primary-inline-action" type="submit" disabled={!dirty || saving}>
            <Save size={13} />
            {saving ? t(locale, 'saving') : t(locale, 'saveFile')}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function MobileWorkersPane({
  workers,
  jobs,
  providers,
  locale,
  canAdmin,
  onAddWorker,
}: {
  workers: Worker[];
  jobs: Job[];
  providers: ProviderSnapshot[];
  locale: LocaleCode;
  canAdmin: boolean;
  onAddWorker: () => void;
}) {
  const queuedJobs = jobs.filter((job) => job.status === 'queued').length;
  const runningJobs = jobs.filter((job) => job.status === 'running').length;
  return (
    <section className="mobile-panel workers-pane" aria-label={t(locale, 'workersPane')}>
      <div className="mobile-panel-head">
        <div>
          <p>{t(locale, 'workersSummary', { online: workers.filter((worker) => worker.status === 'online').length, total: workers.length, queued: queuedJobs, running: runningJobs })}</p>
          <h2>{t(locale, 'workerDiagnostics')}</h2>
        </div>
        <Cpu size={22} />
      </div>
      {workers.length === 0 && <p className="empty">{t(locale, 'noWorkers')}</p>}
      {workers.map((worker) => {
        const workerProviders = providers.filter((provider) => provider.worker_id === worker.worker_id);
        return (
          <article className="worker-diagnostic-card" key={worker.worker_id}>
            <div className="worker-diagnostic-top">
              <span className={`status-dot ${statusClass(worker.status)}`} />
              <strong>{worker.worker_id}</strong>
              <small>{statusLabel(worker.status, locale)}</small>
            </div>
            <p>{worker.machine_name || worker.os} · {worker.connection_mode || 'private'} · {worker.transport_state || 'polling'}</p>
            <p>{t(locale, 'version', { version: worker.worker_version || 'unknown' })}</p>
            <p>{t(locale, 'backendPrefix')}{worker.reachable_backends.length > 0 ? worker.reachable_backends.map(backendLabel).join(' / ') : t(locale, 'backendMissing')}</p>
            {workerProviders.length > 0 && (
              <div className="worker-provider-strip">
                {workerProviders.map((provider) => (
                  <span key={`${provider.worker_id}-${provider.backend}`}>
                    {backendLabel(provider.backend)} · {statusLabel(provider.status, locale)} · {provider.auth_status}
                  </span>
                ))}
              </div>
            )}
          </article>
        );
      })}
      {canAdmin && (
        <button type="button" className="invite-button" onClick={onAddWorker}>
          {t(locale, 'addWorker')}
        </button>
      )}
    </section>
  );
}

function PreferencesEditor({
  locale,
  preferences,
  options,
  onSave,
  onLocaleChange,
  onThemeModeChange,
}: {
  locale: LocaleCode;
  preferences: UserPreferences;
  options: AgentHubSettings['options'];
  onSave: (values: Partial<UserPreferences>) => Promise<void>;
  onLocaleChange: (value: LocaleCode) => Promise<void>;
  onThemeModeChange: (value: ThemeMode) => Promise<void>;
}) {
  const [draft, setDraft] = useState<UserPreferences>(preferences);
  const [quickReplyText, setQuickReplyText] = useState(preferences.quick_replies.join('\n'));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(preferences);
    setQuickReplyText(preferences.quick_replies.join('\n'));
  }, [preferences]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        voice_mode: draft.voice_mode,
        voice_language: draft.voice_language,
        quick_replies: quickReplyText
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 12),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="editor-panel" onSubmit={handleSave}>
      <div className="control-fields">
        <label>
          {t(locale, 'language')}
          <select
            aria-label={t(locale, 'language')}
            value={draft.locale}
            onChange={(event) => {
              const nextLocale = event.target.value as LocaleCode;
              setDraft((current) => ({ ...current, locale: nextLocale }));
              void onLocaleChange(nextLocale);
            }}
          >
            {options.locales.map((option) => (
              <option value={option.value} key={option.value}>
                {localeLabel(locale, option.value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(locale, 'theme')}
          <select
            aria-label={t(locale, 'theme')}
            value={draft.theme_mode}
            onChange={(event) => {
              const nextTheme = event.target.value as ThemeMode;
              setDraft((current) => ({ ...current, theme_mode: nextTheme }));
              void onThemeModeChange(nextTheme);
            }}
          >
            {options.theme_modes.map((option) => (
              <option value={option.value} key={option.value}>
                {themeModeLabel(locale, option.value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(locale, 'voiceMode')}
          <select
            aria-label={t(locale, 'voiceMode')}
            value={draft.voice_mode}
            onChange={(event) => setDraft((current) => ({ ...current, voice_mode: event.target.value as VoiceMode }))}
          >
            {options.voice_modes.map((option) => (
              <option value={option.value} key={option.value}>
                {voiceModeLabel(locale, option.value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t(locale, 'recognitionLanguage')}
          <select
            aria-label={t(locale, 'recognitionLanguage')}
            value={draft.voice_language}
            onChange={(event) => setDraft((current) => ({ ...current, voice_language: event.target.value }))}
          >
            {options.voice_languages.map((option) => (
              <option value={option.value} key={option.value}>
                {voiceLanguageLabel(locale, option.value)}
              </option>
            ))}
          </select>
        </label>
        <label className="full-width-field">
          {t(locale, 'quickReplies')}
          <textarea
            aria-label={t(locale, 'quickRepliesList')}
            rows={5}
            value={quickReplyText}
            onChange={(event) => setQuickReplyText(event.target.value)}
          />
        </label>
      </div>
      <small>{t(locale, 'preferencesCopy')}</small>
      <button type="submit" disabled={saving}>
        <Check size={16} />
        {saving ? t(locale, 'saving') : t(locale, 'savePreferences')}
      </button>
    </form>
  );
}

function WorkerRuntimeDefaultsEditor({
  locale,
  runtime,
  onSave,
}: {
  locale: LocaleCode;
  runtime: WorkerRuntimeDefaults;
  onSave: (values: Partial<WorkerRuntimeDefaults>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkerRuntimeDefaults>(runtime);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(runtime);
  }, [runtime]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="editor-panel" onSubmit={handleSubmit}>
      <div className="control-fields">
        <label>
          {t(locale, 'maxConcurrentJobs')}
          <input
            aria-label={t(locale, 'maxConcurrentJobs')}
            type="number"
            min={1}
            max={32}
            value={draft.max_concurrent_jobs}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                max_concurrent_jobs: Math.max(1, Number(event.target.value) || 1),
              }))
            }
          />
        </label>
        <label>
          {t(locale, 'pollIntervalSeconds')}
          <input
            aria-label={t(locale, 'pollIntervalSeconds')}
            type="number"
            min={1}
            max={300}
            step={1}
            value={draft.job_poll_interval_seconds}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                job_poll_interval_seconds: Math.max(1, Number(event.target.value) || 1),
              }))
            }
          />
        </label>
        <label>
          {t(locale, 'heartbeatIntervalSeconds')}
          <input
            aria-label={t(locale, 'heartbeatIntervalSeconds')}
            type="number"
            min={1}
            max={300}
            step={1}
            value={draft.heartbeat_interval_seconds}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                heartbeat_interval_seconds: Math.max(1, Number(event.target.value) || 1),
              }))
            }
          />
        </label>
      </div>
      <small>{t(locale, 'workerRuntimeCopy')}</small>
      <button type="submit" disabled={saving}>
        <Check size={16} />
        {saving ? t(locale, 'saving') : t(locale, 'saveWorkerDefaults')}
      </button>
    </form>
  );
}

function MobileMePane({
  user,
  notificationPermission,
  secrets,
  pendingCount,
  workers,
  lastSyncedAt,
  nativeVersion,
  apkUpdates,
  apkUrls,
  locale,
  preferences,
  options,
  workerRuntimeDefaults,
  themeMode,
  canAdmin,
  onLocaleChange,
  onThemeModeChange,
  onVoicePreferenceChange,
  onWorkerRuntimeDefaultsChange,
  onNotificationSetup,
  onRestartNotificationGuard,
  onCheckApkUpdate,
  onDownloadApk,
  onCopyApkUrl,
  onLogout,
}: {
  user: User | null;
  notificationPermission: NotificationState;
  secrets: AgentSecret[];
  pendingCount: number;
  workers: Worker[];
  lastSyncedAt: string;
  nativeVersion: NativeAppVersion | null;
  apkUpdates: ApkUpdateStates;
  apkUrls: Record<AndroidDownloadChannelKey, string>;
  locale: LocaleCode;
  preferences: UserPreferences;
  options: AgentHubSettings['options'];
  workerRuntimeDefaults: WorkerRuntimeDefaults;
  themeMode: ThemeMode;
  canAdmin: boolean;
  onLocaleChange: (value: LocaleCode) => Promise<void>;
  onThemeModeChange: (mode: ThemeMode) => void | Promise<void>;
  onVoicePreferenceChange: (values: Partial<UserPreferences>) => Promise<void>;
  onWorkerRuntimeDefaultsChange: (values: Partial<WorkerRuntimeDefaults>) => Promise<void>;
  onNotificationSetup: () => void;
  onRestartNotificationGuard: () => void;
  onCheckApkUpdate: () => void;
  onDownloadApk: (channel: AndroidDownloadChannelKey) => void;
  onCopyApkUrl: (channel: AndroidDownloadChannelKey) => void;
  onLogout: () => void;
}) {
  const onlineWorkers = workers.filter((worker) => worker.status === 'online').length;
  const workerSummary = workers.length > 0 ? pickLocale(locale, `${onlineWorkers}/${workers.length} 在线`, `${onlineWorkers}/${workers.length} online`) : t(locale, 'noWorkers');
  const notificationLabel = notificationPermission === 'granted' ? t(locale, 'notificationGranted') : notificationPermission === 'denied' ? t(locale, 'notificationDenied') : t(locale, 'notificationUnknown');
  const nativeVersionLabel = nativeVersion
    ? t(locale, 'nativeVersion', { version: `${nativeVersion.name}${nativeVersion.code ? ` (${nativeVersion.code})` : ''}` })
    : t(locale, 'webConsoleEnv');
  const updateLabel = (apkUpdate: ApkUpdateState) =>
    apkUpdate.status === 'checking'
      ? t(locale, 'onlineApkChecking')
      : apkUpdate.status === 'ready'
        ? t(locale, 'onlineApkReady', { detail: `${formatFileSize(apkUpdate.sizeBytes)}${apkUpdate.lastModified ? ` · ${formatWhen(apkUpdate.lastModified)}` : ''}` })
        : apkUpdate.status === 'failed'
          ? t(locale, 'onlineApkFailed', { error: apkUpdate.error ?? '' }).trim()
          : t(locale, 'onlineApkIdle');
  return (
    <section className="mobile-panel me-pane" aria-label={t(locale, 'mePane')}>
      <div className="mobile-panel-head">
        <div>
          <p>{user?.role ?? t(locale, 'anonymous')} · AgentHub</p>
          <h2>{t(locale, 'deviceUpdates')}</h2>
        </div>
        <Smartphone size={22} />
      </div>

      <div className="me-download-channels">
        <div className="me-download-toolbar" role="group" aria-label={pickLocale(locale, 'Android 客户端更新', 'Android client updates')}>
          <span>{pickLocale(locale, 'Android 客户端', 'Android clients')}</span>
          <button type="button" className="message-action-button" onClick={onCheckApkUpdate} disabled={apkUpdates.webview.status === 'checking' || apkUpdates.native.status === 'checking'}>
            <RefreshCw size={13} />
            {apkUpdates.webview.status === 'checking' || apkUpdates.native.status === 'checking' ? t(locale, 'checking') : t(locale, 'checkUpdate')}
          </button>
        </div>

        <div className="mobile-panel-card me-update-card me-native-download-card">
          <div className="me-download-card-head">
            <strong>{pickLocale(locale, '原生 Workbench 客户端', 'Native Workbench client')}</strong>
            <span>{pickLocale(locale, '推荐', 'Recommended')}</span>
          </div>
          <p>{pickLocale(locale, '面向任务、文件和移动 Workbench 的原生体验', 'Native tasks, files, and mobile Workbench experience')}</p>
          <p>{updateLabel(apkUpdates.native)}</p>
          <p className="me-install-note">{pickLocale(locale, '会作为独立 App 安装，可与当前版共存', 'Installs as a separate app and can coexist with the current app')}</p>
          <small>{apkUrls.native}</small>
          <div className="me-action-row">
            <button type="button" className="message-action-button primary-inline-action" onClick={() => onDownloadApk('native')}>
              <Download size={13} />
              {pickLocale(locale, '安装原生版', 'Install native app')}
            </button>
            <button type="button" className="message-action-button" onClick={() => onCopyApkUrl('native')}>
              <Copy size={13} />
              {t(locale, 'copyAddress')}
            </button>
          </div>
        </div>

        <div className="mobile-panel-card me-update-card">
          <div className="me-download-card-head">
            <strong>{pickLocale(locale, '当前 WebView 客户端', 'Current WebView client')}</strong>
            <span>{pickLocale(locale, '兼容版', 'Compatible')}</span>
          </div>
          <p>{nativeVersionLabel}</p>
          <p>{updateLabel(apkUpdates.webview)}</p>
          <small>{apkUrls.webview}</small>
          <div className="me-action-row">
            <button type="button" className="message-action-button" onClick={() => onDownloadApk('webview')}>
              <Download size={13} />
              {pickLocale(locale, '更新当前版', 'Update current app')}
            </button>
            <button type="button" className="message-action-button" onClick={() => onCopyApkUrl('webview')}>
              <Copy size={13} />
              {t(locale, 'copyAddress')}
            </button>
          </div>
        </div>
      </div>

      <div className="mobile-panel-card me-account-card">
        <div className="me-account-head">
          <UserCircle size={28} />
          <div>
            <strong>{user?.email ?? t(locale, 'notLoggedIn')}</strong>
            <p>{t(locale, 'notificationStatus', { status: notificationLabel, count: pendingCount })}</p>
          </div>
        </div>
        <div className="me-action-row">
          <button type="button" className="message-action-button" onClick={onNotificationSetup}>
            <Bell size={13} />
            {t(locale, 'enableNotifications')}
          </button>
          <button type="button" className="message-action-button" onClick={onRestartNotificationGuard}>
            <Activity size={13} />
            {t(locale, 'restartGuard')}
          </button>
        </div>
      </div>

      <div className="mobile-panel-card me-theme-card">
        <strong>{t(locale, 'appearance')}</strong>
        <p>{t(locale, 'appearanceCopy')}</p>
        <div className="theme-toggle" role="group" aria-label={t(locale, 'appearanceMode')}>
          {(['dark', 'light'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={themeMode === mode ? 'selected' : ''}
              aria-pressed={themeMode === mode}
              onClick={() => onThemeModeChange(mode)}
            >
              {themeModeLabel(locale, mode)}
            </button>
          ))}
        </div>
        <PreferencesEditor
          locale={locale}
          preferences={preferences}
          options={options}
          onSave={onVoicePreferenceChange}
          onLocaleChange={onLocaleChange}
          onThemeModeChange={async (mode) => onThemeModeChange(mode)}
        />
      </div>

      {canAdmin && (
        <div className="mobile-panel-card me-theme-card">
          <strong>{t(locale, 'workerDefaultsTitle')}</strong>
          <p>{t(locale, 'workerDefaultsCopy')}</p>
          <WorkerRuntimeDefaultsEditor
            locale={locale}
            runtime={workerRuntimeDefaults}
            onSave={onWorkerRuntimeDefaultsChange}
          />
        </div>
      )}

      <div className="me-status-grid">
        <div className="mobile-panel-card me-metric-card">
          <small>{t(locale, 'workersMetric')}</small>
          <strong>{t(locale, 'workerMetricValue', { summary: workerSummary })}</strong>
          <p>{workers.length > 0 ? workers.map((worker) => worker.machine_name || worker.worker_id).slice(0, 2).join(' / ') : t(locale, 'noWorkerInstall')}</p>
        </div>
        <div className="mobile-panel-card me-metric-card">
          <small>Secrets</small>
          <strong>{pickLocale(locale, `${secrets.length} 个`, `${secrets.length}`)}</strong>
          <p>{secrets.length > 0 ? t(locale, 'secretsMetricCopy') : t(locale, 'secretsEmptyCopy')}</p>
        </div>
        <div className="mobile-panel-card me-metric-card">
          <small>API</small>
          <strong>{t(locale, 'connected')}</strong>
          <p>{lastSyncedAt ? `${t(locale, 'syncing')}：${formatRelative(lastSyncedAt, locale)}` : t(locale, 'waitingFirstSync')}</p>
        </div>
        <div className="mobile-panel-card me-metric-card">
          <small>{t(locale, 'approvalsMetric')}</small>
          <strong>{t(locale, 'countItems', { count: pendingCount })}</strong>
          <p>{pendingCount > 0 ? t(locale, 'handleRequestsInChat') : t(locale, 'noPendingRequests')}</p>
        </div>
      </div>

      <button type="button" className="invite-button" onClick={onLogout}>
        {t(locale, 'logout')}
      </button>
    </section>
  );
}

function SessionLaunchDialog({
  mode,
  draft,
  workers,
  launchWorker,
  provider,
  selectedSession,
  canSubmit,
  onChange,
  onClose,
  onSubmit,
}: {
  mode: LaunchMode;
  draft: SessionLaunchDraft;
  workers: Worker[];
  launchWorker?: Worker;
  provider?: ProviderSnapshot;
  selectedSession?: AgentSession;
  canSubmit: boolean;
  onChange: Dispatch<SetStateAction<SessionLaunchDraft>>;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const backendOptions = workerBackendOptions(launchWorker);
  const workspaceRoots = launchWorker?.workspace_roots ?? [];
  const title = mode === 'fork' ? 'Fork 会话' : '新建会话';
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="launch-dialog" aria-label={title} onSubmit={onSubmit}>
        <div className="dialog-head">
          <div>
            <p>{mode === 'fork' && selectedSession ? sessionTitle(selectedSession) : '选择 worker 和 backend 后启动真实 session'}</p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="launch-grid">
          <label>
            Worker
            <select
              aria-label="Worker"
              value={draft.worker_id}
              onChange={(event) => {
                const worker = workers.find((item) => item.worker_id === event.target.value);
                onChange({
                  ...draft,
                  worker_id: event.target.value,
                  backend: workerBackendOptions(worker)[0]?.toLowerCase() ?? draft.backend,
                  workspace_root: worker?.workspace_roots[0] ?? draft.workspace_root,
                });
              }}
            >
              {workers.length === 0 && <option value="">暂无 worker</option>}
              {workers.map((worker) => (
                <option value={worker.worker_id} key={worker.worker_id}>
                  {worker.worker_id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Backend
            <select
              aria-label="Backend"
              value={draft.backend}
              onChange={(event) => onChange((current) => ({ ...current, backend: event.target.value }))}
            >
              {backendOptions.map((backend) => (
                <option value={backend.toLowerCase()} key={backend}>
                  {backendLabel(backend)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Workspace
            <input
              aria-label="Workspace"
              list="workspace-roots"
              value={draft.workspace_root}
              onChange={(event) => onChange((current) => ({ ...current, workspace_root: event.target.value }))}
            />
            <datalist id="workspace-roots">
              {workspaceRoots.map((root) => (
                <option value={root} key={root} />
              ))}
            </datalist>
          </label>
          <label>
            Namespace
            <input
              aria-label="Namespace"
              value={draft.namespace}
              onChange={(event) => onChange((current) => ({ ...current, namespace: event.target.value }))}
            />
          </label>
          <label>
            标题
            <input
              aria-label="标题"
              value={draft.title}
              onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))}
              placeholder={mode === 'fork' ? 'Fork 后的新会话名' : '可选'}
            />
          </label>
          <label>
            模型
            <select
              aria-label="Launch 模型"
              value={draft.model}
              onChange={(event) => onChange((current) => ({ ...current, model: event.target.value }))}
            >
              <option value="">default</option>
              {provider?.models?.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label ?? model.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            沙箱
            <select
              aria-label="Launch 沙箱"
              value={draft.sandbox_mode}
              onChange={(event) => onChange((current) => ({ ...current, sandbox_mode: event.target.value }))}
            >
              <option value="">default</option>
              {modeOptions(provider, 'sandbox_mode', ['read-only', 'workspace-write', 'danger-full-access']).map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {!isClaudeBackendName(provider?.backend) ? (
            <label>
              审批
              <select
                aria-label="Launch 审批"
                value={draft.approval_mode}
                onChange={(event) => onChange((current) => ({ ...current, approval_mode: event.target.value }))}
              >
                <option value="">default</option>
                {modeOptions(provider, 'approval_mode', ['never', 'on-request', 'on-failure', 'untrusted']).map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <label className="launch-prompt">
          {mode === 'fork' ? 'Fork 目标' : '初始 Prompt'}
          <textarea
            aria-label={mode === 'fork' ? 'Fork 目标' : '初始 Prompt'}
            value={draft.prompt}
            onChange={(event) => onChange((current) => ({ ...current, prompt: event.target.value }))}
            rows={5}
            placeholder={mode === 'fork' ? '说明新 fork 要继续做什么' : '输入新 session 的第一条指令'}
          />
        </label>

        <div className="launch-options">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={draft.yolo}
              onChange={(event) => onChange((current) => ({ ...current, yolo: event.target.checked }))}
            />
            Yolo
          </label>
          <label>
            权限策略
            <select
              aria-label="Launch 权限策略"
              value={draft.permission_mode}
              onChange={(event) => onChange((current) => ({ ...current, permission_mode: event.target.value }))}
            >
              <option value="">default</option>
                {modeOptions(provider, 'permission_mode', ['default', 'auto', 'plan', 'dontAsk', 'bypassPermissions']).map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
            </select>
          </label>
          <label>
            交互桥
            <select
              aria-label="Launch 交互桥"
              value={draft.interaction_bridge}
              onChange={(event) => onChange((current) => ({ ...current, interaction_bridge: event.target.value }))}
            >
              <option value="">default</option>
              {modeOptions(provider, 'interaction_bridge', ['compatibility', 'tmux', 'psmux']).map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            思考
            <select
              aria-label="Launch 思考"
              value={draft.thinking}
              onChange={(event) => onChange((current) => ({ ...current, thinking: event.target.value }))}
            >
              <option value="">default</option>
              <option value="true">on</option>
              <option value="false">off</option>
            </select>
          </label>
        </div>

        <div className="dialog-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={!canSubmit || !draft.worker_id || !draft.workspace_root || !draft.prompt.trim()}>
            {mode === 'fork' ? '创建 Fork' : '创建会话'}
          </button>
        </div>
      </form>
    </div>
  );
}

function IslandConsole({
  user,
  sessions,
  selectedSession,
  selectedId,
  setSelectedId,
  reply,
  setReply,
  notice,
  titleDraft,
  setTitleDraft,
  controlsDraft,
  setControlsDraft,
  replyBlockedReason,
  canReply,
  onRefresh,
  onReply,
  onReplyChange,
  onReplyKeyDown,
  onRename,
  onControls,
  permissions,
  onPermission,
  onOpenFullConsole,
}: {
  user: User | null;
  sessions: AgentSession[];
  selectedSession?: AgentSession;
  selectedId: string | null;
  setSelectedId: (value: string) => void;
  reply: string;
  setReply: (value: string) => void;
  notice: string;
  titleDraft: string;
  setTitleDraft: (value: string) => void;
  controlsDraft: ControlsDraft;
  setControlsDraft: Dispatch<SetStateAction<ControlsDraft>>;
  replyBlockedReason: string;
  canReply: boolean;
  onRefresh: () => Promise<void>;
  onReply: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onReplyChange: (nextValue: string) => void;
  onReplyKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRename: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onControls: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  permissions: AgentPermission[];
  onPermission: (
    permissionId: string,
    action: PermissionAction,
    response?: Record<string, unknown>,
  ) => Promise<void>;
  onOpenFullConsole: () => void;
}) {
  const actionableSessions = sessions
    .filter((session) => ['needs_reply', 'running', 'queued', 'ready'].includes(session.status))
    .slice(0, 5);
  const compactSessions = actionableSessions.length > 0 ? actionableSessions : sessions.slice(0, 5);
  const messages = selectedSession ? latestMessages(selectedSession).slice(-3) : [];

  return (
    <main className="island-shell text-ink bg-paper">
      <header className="island-topbar">
        <div className="brand-row">
          <AgentHubBrandMark size={20} />
          <span>AgentHub Island</span>
        </div>
        <div className="topbar-actions">
          {user && <span className="role-chip">{user.role}</span>}
          <button className="icon-button" title="Refresh" onClick={onRefresh}>
            <RefreshCw size={16} />
          </button>
          <button className="icon-button" onClick={onOpenFullConsole}>
            <TerminalSquare size={16} />
            <span>Open full console</span>
          </button>
        </div>
      </header>

      <section className="island-session-strip" aria-label="Island sessions">
        {compactSessions.map((session) => (
          <button
            key={session.session_id}
            className={`island-session-chip ${session.session_id === selectedId ? 'selected' : ''}`}
            onClick={() => setSelectedId(session.session_id)}
          >
            <span className={`status-dot ${statusClass(session.status)}`} />
            <span>
              <strong>{sessionTitle(session)}</strong>
              <small>{session.backend} · {session.status}</small>
            </span>
          </button>
        ))}
        {compactSessions.length === 0 && <p className="empty">No sessions registered.</p>}
      </section>

      {selectedSession ? (
        <section className="island-detail">
          <div className="island-title-row">
            <div>
              <p>{selectedSession.backend} · {selectedSession.namespace}</p>
              <h1>{sessionTitle(selectedSession)}</h1>
            </div>
            <span className={`state-pill ${statusClass(selectedSession.status)}`}>{selectedSession.status}</span>
          </div>

          <section className="island-activity" aria-label="Activity">
            <strong>{selectedSession.activity_summary || selectedSession.last_message || '当前空闲'}</strong>
            <small>{formatWhen(selectedSession.last_activity_at) || selectedSession.project_name}</small>
          </section>

          <form className="island-reply" onSubmit={onReply}>
            <label htmlFor="island-reply">Quick reply</label>
            <textarea
              id="island-reply"
              aria-label="Quick reply"
              value={reply}
              onChange={(event) => onReplyChange(event.target.value)}
              onKeyDown={onReplyKeyDown}
              rows={3}
              enterKeyHint="enter"
              disabled={!canReply}
            />
            {(replyBlockedReason || notice) && <div className="reply-status">{replyBlockedReason || notice}</div>}
            <div className="reply-actions">
              <button type="submit" disabled={!canReply}>
                <Send size={16} />
                Send
              </button>
            </div>
          </form>

          <section className="island-transcript" aria-label="Recent transcript">
            <span className="timeline-order">最新在下</span>
            {messages.length > 0 ? (
              messages.map((message, index) => (
                <article className="message-line" key={`${String(message.role)}-${index}`}>
                  <strong>{String(message.role ?? 'message')}</strong>
                  <p>{compactText(String(message.text ?? ''), 260)}</p>
                </article>
              ))
            ) : (
              <p>{selectedSession.last_message || selectedSession.activity_summary || '暂无 transcript 摘要'}</p>
            )}
          </section>

          {permissions.length > 0 && (
            <section className="permission-stack" aria-label="Island pending permissions">
              {permissions.map((permission) => (
                <article className="permission-card" key={permission.permission_id}>
                  <div>
                    <strong>{permission.title}</strong>
                    <p>{permission.description || permission.kind}</p>
                  </div>
                  <PermissionActions permission={permission} onPermission={onPermission} compact />
                </article>
              ))}
            </section>
          )}

          <form className="island-rename" onSubmit={onRename}>
            <label>
              Session title
              <input
                aria-label="Island session title"
                name="custom_title"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                disabled={!canOperate(user)}
              />
            </label>
            <button type="submit" disabled={!canOperate(user)}>
              <Save size={15} />
            </button>
          </form>

          <form className="island-controls" onSubmit={onControls}>
            <label>
              Model
              <input
                aria-label="Island model"
                value={controlsDraft.model}
                onChange={(event) => setControlsDraft((current) => ({ ...current, model: event.target.value }))}
                disabled={!canOperate(user)}
              />
            </label>
            <label className="toggle-row">
              <input
                aria-label="Island yolo"
                type="checkbox"
                checked={controlsDraft.yolo}
                onChange={(event) => setControlsDraft((current) => ({ ...current, yolo: event.target.checked }))}
                disabled={!canOperate(user)}
              />
              Yolo
            </label>
            <button type="submit" disabled={!canOperate(user)}>
              <Check size={15} />
              Save
            </button>
          </form>

        </section>
      ) : (
        <div className="empty-detail">Select a session.</div>
      )}
    </main>
  );
}

function PendingInteractionCard({
  permission,
  onPermission,
}: {
  permission: AgentPermission;
  onPermission: (
    permissionId: string,
    action: PermissionAction,
    response?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const planText = permissionPlanText(permission);
  const isPlanExit = permission.kind === 'plan_exit' || interactionKind(permission) === 'codex_plan_exit';
  return (
    <article
      className={`permission-card ${isPlanExit ? 'plan-exit-card' : ''}`}
      data-permission-id={permission.permission_id}
    >
      <div>
        <strong>{permission.title}</strong>
        <p>{permission.description || permission.kind}</p>
        {planText && (
          <details className="timeline-detail plan-exit-detail" open>
            <summary>计划内容</summary>
            <TimelineText text={planText} />
          </details>
        )}
        {permission.detail?.command ? <code>{String(permission.detail.command)}</code> : null}
      </div>
      <PermissionActions permission={permission} onPermission={onPermission} />
    </article>
  );
}

function PermissionActions({
  permission,
  onPermission,
  compact = false,
}: {
  permission: AgentPermission;
  onPermission: (
    permissionId: string,
    action: PermissionAction,
    response?: Record<string, unknown>,
  ) => Promise<void>;
  compact?: boolean;
}) {
  const questions = requestUserInputQuestions(permission);
  if (questions.length > 0) {
    return (
      <QuestionAnswerForm
        questions={questions}
        compact={compact}
        onDeny={() => onPermission(permission.permission_id, 'deny')}
        onSubmit={(response) => void onPermission(permission.permission_id, 'answer', response)}
      />
    );
  }
  const choices = permissionChoices(permission);
  if (choices.length > 0) {
    return (
      <div className="permission-actions choice-actions">
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="primary"
            onClick={() => onPermission(permission.permission_id, 'answer', { choice: choice.id, label: choice.label })}
          >
            {choice.label}
          </button>
        ))}
        {!compact && (
          <button type="button" onClick={() => onPermission(permission.permission_id, 'deny')}>
            暂不处理
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="permission-actions">
      <button type="button" onClick={() => onPermission(permission.permission_id, 'deny')}>
        拒绝
      </button>
      <button className="primary" type="button" onClick={() => onPermission(permission.permission_id, 'allow')}>
        批准
      </button>
    </div>
  );
}

function Panel({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className={`rail-panel ${isOpen ? 'is-open' : ''}`}>
      <button
        type="button"
        className="rail-panel-summary"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span>
          {icon}
          {title}
        </span>
        <ChevronDown size={15} />
      </button>
      <div className="rail-panel-body">
        {children}
      </div>
    </section>
  );
}

function InviteUserDialog({
  draft,
  created,
  onChange,
  onClose,
  onCopy,
  onSubmit,
}: {
  draft: InviteDraft;
  created: InviteCreated | null;
  onChange: Dispatch<SetStateAction<InviteDraft>>;
  onClose: () => void;
  onCopy: (value: string, message: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const inviteLink = created
    ? `${window.location.origin}/invite?token=${encodeURIComponent(created.invite_token)}`
    : '';

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="launch-dialog invite-user-dialog"
        role="dialog"
        aria-label="邀请用户"
        aria-modal="true"
        onSubmit={onSubmit}
      >
        <div className="dialog-head">
          <div>
            <p>创建一次性邀请 token，用户接受后进入当前空间</p>
            <h2>邀请用户</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="launch-grid">
          <label>
            邀请邮箱
            <input
              aria-label="邀请邮箱"
              type="email"
              value={draft.email}
              autoFocus
              onChange={(event) => onChange((current) => ({ ...current, email: event.target.value }))}
              placeholder="teammate@example.com"
              required
            />
          </label>
          <label>
            邀请角色
            <select
              aria-label="邀请角色"
              value={draft.role}
              onChange={(event) =>
                onChange((current) => ({ ...current, role: event.target.value as InviteRole }))
              }
            >
              <option value="operator">operator</option>
              <option value="admin">admin</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <label>
            有效期小时
            <input
              aria-label="有效期小时"
              type="number"
              min="1"
              value={draft.expires_in_hours}
              onChange={(event) =>
                onChange((current) => ({ ...current, expires_in_hours: event.target.value }))
              }
            />
          </label>
        </div>
        {created && (
          <div className="invite-result">
            <strong>{created.email}</strong>
            <small>
              {created.role} · 过期时间 {formatWhen(created.expires_at)}
            </small>
            <code>{created.invite_token}</code>
            <div className="invite-result-actions">
              <button type="button" className="secondary-action" onClick={() => onCopy(created.invite_token, '邀请 token 已复制')}>
                <Copy size={15} />
                复制 token
              </button>
              <button type="button" className="secondary-action" onClick={() => onCopy(inviteLink, '邀请链接已复制')}>
                <Users size={15} />
                复制链接
              </button>
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            关闭
          </button>
          <button type="submit" className="primary-top-action">
            创建邀请
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkerInstallDialog({
  draft,
  enrollment,
  canSubmit,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: WorkerInstallDraft;
  enrollment: WorkerEnrollmentCreated | null;
  canSubmit: boolean;
  onChange: Dispatch<SetStateAction<WorkerInstallDraft>>;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const commands = enrollment ? workerInstallCommands(draft, enrollment) : '';
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="launch-dialog worker-install-dialog" aria-label="添加 Worker" onSubmit={onSubmit}>
        <div className="dialog-head">
          <div>
            <p>生成一次性 enrollment token，并直接给出安装命令</p>
            <h2>添加 Worker</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="launch-grid">
          <label>
            Worker ID
            <input
              aria-label="Worker ID"
              value={draft.worker_id}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  worker_id: event.target.value,
                  label: current.label || event.target.value,
                }))
              }
            />
          </label>
          <label>
            标签
            <input
              aria-label="Worker 标签"
              value={draft.label}
              onChange={(event) => onChange((current) => ({ ...current, label: event.target.value }))}
            />
          </label>
          <label>
            OS
            <select
              aria-label="Worker OS"
              value={draft.os}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  os: event.target.value as WorkerInstallDraft['os'],
                  workspace_roots:
                    event.target.value === 'macos' && ['C:/Work', '/srv/work'].includes(current.workspace_roots.trim())
                      ? ''
                      : current.workspace_roots,
                }))
              }
            >
              <option value="windows">Windows</option>
              <option value="linux">Linux</option>
              <option value="macos">macOS</option>
            </select>
          </label>
          <label>
            连接方式
            <select
              aria-label="Worker 连接方式"
              value={draft.connection_mode}
              onChange={(event) =>
                onChange((current) => ({
                  ...current,
                  connection_mode: event.target.value as ConnectionMode,
                }))
              }
            >
              <option value="private">private</option>
              <option value="public_relay">public_relay</option>
            </select>
          </label>
          <label>
            API URL
            <input
              aria-label="Worker API URL"
              value={draft.api_url}
              onChange={(event) => onChange((current) => ({ ...current, api_url: event.target.value }))}
            />
          </label>
          <label>
            Token 有效期
            <input
              aria-label="Worker token 有效期"
              type="number"
              min={1}
              max={720}
              value={draft.expires_in_hours}
              onChange={(event) => onChange((current) => ({ ...current, expires_in_hours: Number(event.target.value) || 24 }))}
            />
          </label>
          <label className="launch-prompt">
            Workspace Roots
            <textarea
              aria-label="Workspace Roots"
              rows={3}
              value={draft.workspace_roots}
              onChange={(event) => onChange((current) => ({ ...current, workspace_roots: event.target.value }))}
              placeholder="每行一个路径，或用分号分隔"
            />
          </label>
          <label className="launch-prompt">
            Session Roots
            <textarea
              aria-label="Session Roots"
              rows={3}
              value={draft.session_roots}
              onChange={(event) => onChange((current) => ({ ...current, session_roots: event.target.value }))}
              placeholder="可选。默认会自动扫描 .codex/.claude/.kimi/.local/share/opencode"
            />
          </label>
        </div>
        <div className="launch-options worker-backend-options">
          {(['codex', 'claude', 'kimi', 'opencode'] as const).map((backend) => (
            <label className="toggle-row" key={backend}>
              <input
                type="checkbox"
                checked={draft.reachable_backends[backend]}
                onChange={(event) =>
                  onChange((current) => ({
                    ...current,
                    reachable_backends: {
                      ...current.reachable_backends,
                      [backend]: event.target.checked,
                    },
                  }))
                }
              />
              {backendLabel(backend)}
            </label>
          ))}
        </div>
        {enrollment && (
          <div className="worker-install-output">
            <strong>安装命令</strong>
            <p>{workerInstallSummary(draft)}</p>
            <textarea aria-label="安装命令" readOnly rows={10} value={commands} />
            <p>Enrollment token 只在这里显示一次。安装命令会先下载 worker bundle，再把真正的 worker token 落到 `.runtime`，之后重启直接复用。</p>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            关闭
          </button>
          <button
            type="submit"
            disabled={
              !canSubmit
              || !draft.worker_id.trim()
              || !draft.api_url.trim()
              || splitMultiPathInput(draft.workspace_roots).length === 0
              || workerInstallBackends(draft).length === 0
            }
          >
            生成安装命令
          </button>
        </div>
      </form>
    </div>
  );
}

export default App;
