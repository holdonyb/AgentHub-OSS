import {
  Activity,
  Archive,
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
import { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { App as CapacitorApp } from '@capacitor/app';
import type {
  AgentPermission,
  AgentSession,
  AgentTimelineItem,
  ConnectionMode,
  Event,
  Job,
  ProviderSnapshot,
  Role,
  Schedule,
  User,
  Worker,
} from '@agenthub/protocol';
import { apiGet, apiPatch, apiPost } from './api';
import {
  listenForNativeNotificationActions,
  notifyNativePendingPermission,
  notifyNativeStatus,
  requestNativeNotificationPermission,
} from './nativeNotifications';
import { startStreamingVoice, type StreamingVoiceController, type VoiceStreamAuthPayload } from './voiceStreaming';

type LoadState = 'loading' | 'ready' | 'login' | 'error';
type MobilePane = 'sessions' | 'thread' | 'controls' | 'files' | 'workers' | 'me';
type ProviderFilter = 'all' | 'codex' | 'claude' | 'kimi';
type SessionArchiveView = 'active' | 'archived';
type TimelineFilter = 'focus' | 'all' | 'messages' | 'tools' | 'events';
type ReplyMode = 'direct' | 'plan';
type PermissionAction = 'allow' | 'deny' | 'answer';
type NotificationState = NotificationPermission | 'unsupported';
type LaunchMode = 'none' | 'start' | 'fork';
type NativeMicrophoneState = 'granted' | 'denied' | 'unavailable';
type ApkUpdateStatus = 'idle' | 'checking' | 'ready' | 'failed';
type ThemeMode = 'dark' | 'light';
type VoiceInputMode = 'standard' | 'streaming';
type CapacitorBackButtonEvent = { canGoBack?: boolean };

const mobilePanes = ['sessions', 'thread', 'controls', 'files', 'workers', 'me'] as const;
const MAX_VOICE_AUDIO_BYTES = 12 * 1024 * 1024;
const AGENTHUB_TRUNCATION_MARKER = '[AgentHub truncated this item]';
const APK_DOWNLOAD_PATH = '/downloads/agenthub-debug.apk';
const APK_DOWNLOAD_FILENAME = 'agenthub-debug.apk';
const THEME_STORAGE_KEY = 'agenthub.theme';
const VOICE_INPUT_MODE_STORAGE_KEY = 'agenthub.voiceInputMode';
const NOTIFICATION_READ_STORAGE_KEY = 'agenthub.notifications.read';
const MOBILE_HISTORY_STATE = 'agenthub-mobile';

declare global {
  interface Window {
    AgentHubAndroid?: {
      microphonePermissionState?: () => string;
      requestMicrophonePermission?: () => boolean;
      startNotificationService?: () => boolean;
      stopNotificationService?: () => boolean;
      setServerBaseUrl?: (url: string) => boolean;
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

interface ControlsDraft {
  model: string;
  sandbox_mode: string;
  approval_mode: string;
  permission_mode: string;
  agent: string;
  yolo: boolean;
  thinking: string;
  secret_refs: string;
  secret_environment: string;
  secret_namespace: string;
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

interface NotificationInboxItem {
  id: string;
  title: string;
  body: string;
  createdAt?: string | null;
  sessionId?: string | null;
  permissionId?: string | null;
}

interface MobileHistoryState {
  agenthub: typeof MOBILE_HISTORY_STATE;
  mobilePane: MobilePane;
  selectedId: string | null;
  notificationInboxOpen: boolean;
  launchMode: LaunchMode;
  workerInstallOpen: boolean;
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
  has_more: boolean;
}

interface PermissionSyncPayload {
  cursor: string;
  items: AgentPermission[];
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
}

const slashCommandOptions: SlashCommandOption[] = [
  {
    command: '/goal',
    title: '目标模式',
    description: '让 Codex/Claude 围绕一个目标持续推进。',
    insertText: '/goal ',
    backends: ['codex', 'claude'],
  },
  {
    command: '/btw',
    title: '旁路提问',
    description: '基于当前 session 提问，但不写入原后端 session。',
    insertText: '/btw ',
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
  preview_kind?: 'text' | 'image' | 'download';
  downloadable?: boolean;
  data_base64?: string;
  text?: string;
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
  os: 'windows' | 'linux';
  connection_mode: ConnectionMode;
  workspace_roots: string;
  session_roots: string;
  reachable_backends: {
    codex: boolean;
    claude: boolean;
    kimi: boolean;
  };
  expires_in_hours: number;
  api_url: string;
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
  agent: '',
  yolo: false,
  thinking: '',
  secret_refs: '',
  secret_environment: '',
  secret_namespace: '',
};

const defaultSecretDraft: SecretDraft = {
  name: '',
  value: '',
  namespace: 'default',
  environment: 'default',
  description: '',
};

const providerFilters: { id: ProviderFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'kimi', label: 'Kimi' },
];

const timelineFilterLabels: Record<TimelineFilter, string> = {
  focus: '重点',
  all: '全部',
  messages: '消息',
  tools: '工具',
  events: '事件',
};

const OPTIMISTIC_TIMELINE_SEQ_BASE = 1_000_000_000;
const TIMELINE_PROMPT_MATCH_WINDOW_MS = 10 * 60 * 1000;
const TIMELINE_DISPLAY_DUPLICATE_WINDOW_MS = 2_000;

const replyModeLabels: Record<ReplyMode, string> = {
  direct: '直接',
  plan: '计划',
};

const fullAccessControls = {
  sandbox_mode: 'danger-full-access',
  approval_mode: 'never',
  permission_mode: 'bypassPermissions',
  yolo: true,
};

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
  },
  expires_in_hours: 24,
  api_url: '',
};

function emptyLaunchDraft(worker?: Worker, session?: AgentSession): SessionLaunchDraft {
  const controls = session ? controlsFromSession(session) : emptyControls;
  const backend = session?.backend ?? worker?.reachable_backends.find((item) => ['codex', 'claude', 'kimi'].includes(item.toLowerCase())) ?? 'codex';
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
    approval_mode: controls.approval_mode,
    permission_mode: controls.permission_mode,
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
  const archive = os === 'windows' ? 'agenthub-worker-windows.zip' : 'agenthub-worker-linux.tar.gz';
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
      )} ${modeArg} -InstallRoot $workerRoot ${workspaceArg}${sessionArg ? ` ${sessionArg}` : ''} ${startArg}`,
      `Remove-Item -LiteralPath $bundleDir -Recurse -Force -ErrorAction SilentlyContinue`,
      `Remove-Item -LiteralPath $bundleZip -Force -ErrorAction SilentlyContinue`,
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
    `sudo bash "$bundle_dir/agenthub-worker/scripts/install-linux-worker.sh" --api-url ${quoteSingleShell(draft.api_url.trim())} --enrollment-token ${quoteSingleShell(enrollment.enrollment_token)} --worker-id ${quoteSingleShell(draft.worker_id.trim())} --connection-mode ${draft.connection_mode} --install-root "$worker_root" --service-name ${quoteSingleShell(serviceName)}${workspaceArgs ? ` ${workspaceArgs}` : ''}${sessionArgs ? ` ${sessionArgs}` : ''}`,
    `rm -rf "$bundle_dir" "$bundle_tar"`,
  ].join('\n');
}

function workerInstallSummary(draft: WorkerInstallDraft) {
  const backends = workerInstallBackends(draft);
  return `${draft.os} · ${draft.connection_mode === 'public_relay' ? '公网 relay' : '私网'} · ${backends.length > 0 ? backends.join(', ') : '未选 backend'}`;
}

function controlsFromLaunchDraft(draft: SessionLaunchDraft) {
  const controls: Record<string, string | boolean> = {};
  if (draft.model.trim()) controls.model = draft.model.trim();
  if (draft.sandbox_mode) controls.sandbox_mode = draft.sandbox_mode;
  if (draft.approval_mode) controls.approval_mode = draft.approval_mode;
  if (draft.permission_mode) controls.permission_mode = draft.permission_mode;
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
  const values = worker?.reachable_backends ?? ['codex', 'claude', 'kimi'];
  return values.filter((backend) => ['codex', 'claude', 'kimi'].includes(backend.toLowerCase()));
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

function statusClass(status: string) {
  if (['needs_reply'].includes(status)) return 'status-approval';
  if (['running', 'queued'].includes(status)) return 'status-running';
  if (['degraded'].includes(status)) return 'status-warning';
  if (['online', 'succeeded'].includes(status)) return 'status-success';
  if (['ready', 'terminated', 'archived'].includes(status)) return 'status-idle';
  if (['offline', 'failed'].includes(status)) return 'status-failed';
  return 'status-idle';
}

function canAdmin(user: User | null) {
  return user ? roleRank[user.role] >= roleRank.admin : false;
}

function canOperate(user: User | null) {
  return user ? roleRank[user.role] >= roleRank.operator : false;
}

function workerSupportsBackend(worker: Worker | undefined, session: AgentSession | null) {
  if (!worker || !session) return true;
  return worker.reachable_backends.some((backend) => backend.toLowerCase() === session.backend.toLowerCase());
}

function backendLabel(value: string) {
  const labels: Record<string, string> = { codex: 'Codex', claude: 'Claude', kimi: 'Kimi' };
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
  return {
    model: valueFromControls(controls, 'model'),
    sandbox_mode: valueFromControls(controls, 'sandbox_mode'),
    approval_mode: valueFromControls(controls, 'approval_mode'),
    permission_mode: valueFromControls(controls, 'permission_mode'),
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

function latestMessages(session: AgentSession) {
  const messages = session.runtime_metadata?.messages;
  return Array.isArray(messages) ? messages.slice(-8) : [];
}

function timelineFallback(session: AgentSession): AgentTimelineItem[] {
  return latestMessages(session).map((message, index) => ({
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
  if (loadedTimeline && usefulTimelineItems(loadedTimeline).length > 0) return loadedTimeline;
  const fallback = timelineFallback(session);
  return fallback.length > 0 ? fallback : loadedTimeline ?? [];
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

function availableSlashCommands(value: string, session: AgentSession | null) {
  const query = slashQuery(value);
  if (query === null) return [];
  const backend = session?.backend.toLowerCase();
  return slashCommandOptions.filter((option) => {
    if (option.backends && backend && !option.backends.includes(backend)) return false;
    const normalized = option.command.slice(1).toLowerCase();
    return normalized.startsWith(query);
  });
}

function providerFeatureText(provider: ProviderSnapshot | undefined, key: string) {
  const value = provider?.features?.[key];
  return typeof value === 'string' ? value : '';
}

function providerInteractionSummary(provider: ProviderSnapshot | undefined) {
  const bridge = providerFeatureText(provider, 'interaction_bridge');
  if (bridge === 'native') {
    return '原生交互：Plan/选项/审批可在 AgentHub 内处理';
  }
  if (bridge === 'compatibility') {
    return '兼容交互：计划后的选择可处理，运行中原生提问需本机或后续桥接';
  }
  return '交互能力未上报';
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

function sandboxSummary(session?: AgentSession | null) {
  if (!session) return '权限未选择';
  const controls = session.controls ?? {};
  const backend = session.backend.toLowerCase();
  const sandbox = optionText(controls.sandbox_mode) || 'default';
  const approval = optionText(controls.approval_mode) || 'default';
  const permission = optionText(controls.permission_mode) || approval;
  if (controls.yolo === true || sandbox === 'danger-full-access' || permission === 'bypassPermissions') {
    return '全权限';
  }
  if (backend === 'claude' && permission === 'plan') return 'Claude 计划模式';
  if (backend === 'claude') return `权限 ${permission}`;
  if (backend === 'kimi') return controls.yolo === true ? 'Kimi yolo' : 'Kimi default';
  return `${sandbox} / ${approval}`;
}

function quoteCliArg(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function localResumeCommand(session: AgentSession) {
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
  return `${backend} resume ${sessionId}`;
}

function localResumeHint(session: AgentSession) {
  if (session.backend.toLowerCase() === 'codex') {
    return 'AgentHub 新建的 Codex 会话来自 codex exec，普通 resume 列表默认可能隐藏它，所以这里固定带 --all 和 --include-non-interactive。';
  }
  return '在对应 worker 本机运行这条命令，打开同一个后端会话。';
}

function replyModeHint(mode: ReplyMode, session?: AgentSession | null, provider?: ProviderSnapshot) {
  if (mode === 'plan' && session?.backend.toLowerCase() === 'codex') {
    return 'Codex 原生 Plan；沙箱按当前控制设置，需要选择时会弹出卡片';
  }
  if (mode === 'plan') return `计划模式；${providerInteractionSummary(provider)}`;
  const status = session?.status;
  if (status === 'running' || status === 'queued') return '当前会话忙，发送后会排队到当前作业后执行';
  return session ? `当前 ${sandboxSummary(session)}` : '';
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

function syncNativeServerBaseUrl() {
  try {
    if (typeof window === 'undefined') return false;
    return window.AgentHubAndroid?.setServerBaseUrl?.(window.location.origin) === true;
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

function apkDownloadUrl() {
  if (typeof window === 'undefined') return APK_DOWNLOAD_PATH;
  return new URL(APK_DOWNLOAD_PATH, window.location.origin).toString();
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

function initialVoiceInputMode(): VoiceInputMode {
  try {
    return localStorage.getItem(VOICE_INPUT_MODE_STORAGE_KEY) === 'streaming' ? 'streaming' : 'standard';
  } catch {
    return 'standard';
  }
}

function readStoredNotificationIds() {
  try {
    const raw = localStorage.getItem(NOTIFICATION_READ_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set<string>();
  }
}

function persistNotificationIds(ids: Set<string>) {
  try {
    localStorage.setItem(NOTIFICATION_READ_STORAGE_KEY, JSON.stringify([...ids]));
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
    left.workerInstallOpen === right.workerInstallOpen
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

function formatRelative(value?: string | null) {
  const parsed = parseApiDate(value);
  if (!parsed) return '';
  const delta = Date.now() - parsed.getTime();
  const minutes = Math.max(1, Math.round(delta / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
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

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    ready: '空闲',
    queued: '排队中',
    running: '运行中',
    needs_reply: '等待审批',
    failed: '失败',
    terminated: '已结束',
    online: '在线',
    degraded: '降级',
    offline: '离线',
    succeeded: '成功',
  };
  return labels[status] ?? status;
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

function fileListResult(jobs: Job[]) {
  const result = parseJobResult<WorkspaceFileListResult>(latestCompletedJob(jobs, 'file_list'));
  if (!result || !Array.isArray(result.entries)) return null;
  return result;
}

function fileReadResult(jobs: Job[]) {
  const result = parseJobResult<WorkspaceFileReadResult>(latestCompletedJob(jobs, 'file_read'));
  if (!result || typeof result.path !== 'string' || typeof result.filename !== 'string') return null;
  return {
    ...result,
    preview_kind: result.preview_kind ?? 'text',
    downloadable: Boolean(result.downloadable),
    text: typeof result.text === 'string' ? result.text : '',
  };
}

function fileJobBusy(jobs: Job[]) {
  return jobs.some((job) => ['file_list', 'file_read'].includes(job.kind) && ['queued', 'running'].includes(job.status));
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

function mergeTimelineItems(existing: AgentTimelineItem[], incoming: AgentTimelineItem[]) {
  const bySeq = new Map<number, AgentTimelineItem>();
  [...existing, ...incoming].forEach((item) => {
    bySeq.set(timelineSeq(item), item);
  });
  return sortTimelineItemsByCreatedAt(Array.from(bySeq.values()));
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

function TimelineText({ text }: { text?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const { value, wasTruncated } = timelineTextState(text);
  const shouldCollapse = value.length > 640 || value.split('\n').length > 8;
  const displayText = shouldCollapse && !expanded ? compactText(value, 640) : value;
  const hasText = Boolean(value.trim());
  const copyText = async () => {
    if (!hasText) return;
    if (await writeTextToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
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
        <pre>{value || '暂无输出'}</pre>
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

function App() {
  const isIslandView = new URLSearchParams(window.location.search).get('view') === 'island';
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [sessions, setSessions] = useState<AgentSession[]>([]);
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
  const [sessionArchiveView, setSessionArchiveView] = useState<SessionArchiveView>('active');
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>('focus');
  const [replyMode, setReplyMode] = useState<ReplyMode>('direct');
  const [mobilePane, setMobilePane] = useState<MobilePane>('sessions');
  const [mobileSessionActionsOpen, setMobileSessionActionsOpen] = useState(false);
  const [statusDetailsOpen, setStatusDetailsOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => initialThemeMode());
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>(() => initialVoiceInputMode());
  const [lastSyncedAt, setLastSyncedAt] = useState('');
  const [notificationPermission, setNotificationPermission] = useState<NotificationState>(() => notificationState());
  const [nativeVersion] = useState<NativeAppVersion | null>(() => nativeAppVersion());
  const [apkUpdate, setApkUpdate] = useState<ApkUpdateState>({ status: 'idle' });
  const [notificationInboxOpen, setNotificationInboxOpen] = useState(false);
  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() => readStoredNotificationIds());
  const [dismissedPermissionToastIds, setDismissedPermissionToastIds] = useState<Set<string>>(() => new Set());
  const [focusedPermissionId, setFocusedPermissionId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [isTitleDirty, setIsTitleDirty] = useState(false);
  const [controlsDraft, setControlsDraft] = useState<ControlsDraft>(emptyControls);
  const [isControlsDirty, setIsControlsDirty] = useState(false);
  const controlsDirtyRef = useRef(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>('none');
  const [launchDraft, setLaunchDraft] = useState<SessionLaunchDraft>(() => emptyLaunchDraft());
  const [workerInstallOpen, setWorkerInstallOpen] = useState(false);
  const [workerInstallDraft, setWorkerInstallDraft] = useState<WorkerInstallDraft>(() =>
    normalizeWorkerInstallDraft(window.location.origin, []),
  );
  const [workerEnrollment, setWorkerEnrollment] = useState<WorkerEnrollmentCreated | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const hydratedDraftSessionIdRef = useRef<string | null>(null);
  const mobilePaneRef = useRef<MobilePane>('sessions');
  const notificationInboxOpenRef = useRef(false);
  const launchModeRef = useRef<LaunchMode>('none');
  const workerInstallOpenRef = useRef(false);
  const applyingMobileHistoryRef = useRef(false);
  const mobileHistoryDepthRef = useRef(0);
  const timelineLoadingRef = useRef<Set<string>>(new Set());
  const notifiedPermissionIds = useRef<Set<string>>(new Set());
  const notifiedNeedsReplySessionKeys = useRef<Map<string, string>>(new Map());
  const needsReplyNotificationsPrimed = useRef(false);
  const replyAttachmentsRef = useRef<ReplyAttachment[]>([]);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inboxCursorRef = useRef<Record<SessionArchiveView, string>>({ active: '', archived: '' });
  const permissionCursorRef = useRef('');
  const sessionAfterSeqRef = useRef<Record<string, number>>({});
  const transcriptRef = useRef<HTMLElement | null>(null);
  const transcriptSessionRef = useRef<string | null>(null);
  const shouldScrollTranscriptToBottomRef = useRef(false);
  const preserveTranscriptScrollRef = useRef<{
    sessionId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const pendingOptimisticTimelineRef = useRef<Record<string, AgentTimelineItem[]>>({});
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
  const streamingVoiceStopWaitersRef = useRef<Array<() => void>>([]);
  const [scheduleDraft, setScheduleDraft] = useState({
    name: 'Health check',
    job_kind: 'health_check',
    interval_seconds: 300,
    target_worker_id: '',
  });
  const [secretDraft, setSecretDraft] = useState<SecretDraft>(defaultSecretDraft);

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

  const selectedSession = useMemo(
    () =>
      sessions.find((session) => session.session_id === selectedId) ??
      filteredSessions[0] ??
      sessions[0],
    [filteredSessions, selectedId, sessions],
  );

  function updateControlsDraft(updater: ControlsDraft | ((current: ControlsDraft) => ControlsDraft)) {
    controlsDirtyRef.current = true;
    setIsControlsDirty(true);
    setControlsDraft((current) => (typeof updater === 'function' ? updater(current) : updater));
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
  const replyBlockedReason =
    selectedSession && !workerSupportsBackend(selectedWorker, selectedSession)
      ? `当前 worker 不支持 ${backendLabel(selectedSession.backend)}`
      : '';
  const canReply = Boolean(selectedSession && canOperate(user) && !replyBlockedReason);
  const canSendReply = canReply && !isTranscribing && !isPreparingAttachment;
  const visibleSlashCommands = useMemo(
    () => (canReply && replyAttachments.length === 0 ? availableSlashCommands(reply, selectedSession) : []),
    [canReply, reply, replyAttachments.length, selectedSession],
  );
  const isRefreshNotice = notice.includes('后台刷新') || notice.startsWith('刷新失败');
  const visibleReplyStatus =
    replyBlockedReason || (notice && !isRefreshNotice && !notice.includes('会话等待回复') ? notice : '');
  const selectedJobs = selectedSession
    ? jobs
        .filter((job) => job.target_session_id === selectedSession.session_id)
        .sort((left, right) => jobTime(right) - jobTime(left))
    : [];
  const selectedTimelineWithJobs = useMemo(
    () => mergeTimelineItems(selectedTimeline, jobTimelineItems(selectedSession, selectedJobs, selectedTimeline)),
    [selectedSession, selectedJobs, selectedTimeline],
  );
  const notificationItems = useMemo(() => notificationItemsFromState(permissions, jobs), [permissions, jobs]);
  const unreadNotificationCount = notificationItems.filter((item) => !readNotificationIds.has(item.id)).length;
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
    return (Object.keys(timelineFilterLabels) as TimelineFilter[])
      .map((id) => ({ id, label: timelineFilterLabels[id], count: counts[id] }))
      .filter((filter) => filter.id === 'all' || filter.id === 'focus' || filter.count > 0);
  }, [displayTimeline]);
  const visibleTimeline = useMemo(
    () => displayTimeline.filter((item) => timelineMatchesFilter(item, timelineFilter)),
    [displayTimeline, timelineFilter],
  );
  const onlineWorkers = workers.filter((worker) => worker.status === 'online').length;

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
  }, [selectedSession?.session_id, selectedPermissions.length, timelineFilter, visibleTimeline.length]);

  useEffect(() => {
    if (selectedIdRef.current && sessions.some((session) => session.session_id === selectedIdRef.current)) return;
    const nextSelectedId = filteredSessions[0]?.session_id ?? sessions[0]?.session_id ?? null;
    if (nextSelectedId === selectedIdRef.current) return;
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
  }, [filteredSessions, sessions]);

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
    mobileHistoryDepthRef.current = state.depth;
    setSelectedId(state.selectedId);
    setMobilePane(state.mobilePane);
    setNotificationInboxOpen(state.notificationInboxOpen);
    setLaunchMode(state.launchMode);
    setWorkerInstallOpen(state.workerInstallOpen);
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

  function alertNewPendingPermissions(nextPermissions: AgentPermission[]) {
    const pending = nextPermissions.filter((permission) => permission.status === 'pending');
    const firstUnseen = pending.find((permission) => !notifiedPermissionIds.current.has(permission.permission_id));
    pending.forEach((permission) => notifiedPermissionIds.current.add(permission.permission_id));
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
    const activeKeys = new Map(waitingSessions.map((session) => [session.session_id, needsReplyNotificationKey(session)]));
    Array.from(notifiedNeedsReplySessionKeys.current.keys()).forEach((sessionId) => {
      if (!activeKeys.has(sessionId)) notifiedNeedsReplySessionKeys.current.delete(sessionId);
    });
    if (!needsReplyNotificationsPrimed.current) {
      activeKeys.forEach((key, sessionId) => notifiedNeedsReplySessionKeys.current.set(sessionId, key));
      needsReplyNotificationsPrimed.current = true;
      return;
    }
    const firstUnseen = waitingSessions.find(
      (session) => notifiedNeedsReplySessionKeys.current.get(session.session_id) !== activeKeys.get(session.session_id),
    );
    activeKeys.forEach((key, sessionId) => notifiedNeedsReplySessionKeys.current.set(sessionId, key));
    if (firstUnseen) {
      void notifyNeedsReplySession(firstUnseen, waitingSessions.length);
    }
  }

  async function loadTimelineForSession(sessionId: string, options: { force?: boolean } = {}) {
    if (!options.force && timelineBySession[sessionId]) return;
    if (timelineLoadingRef.current.has(sessionId)) return;
    timelineLoadingRef.current.add(sessionId);
    try {
      const payload = await apiGet<TimelinePayload>(`/api/sessions/${sessionId}/timeline`);
      const merged = mergeServerTimeline(sessionId, timelineBySession[sessionId] ?? [], payload.items);
      setTimelineBySession((current) => ({
        ...current,
        [sessionId]: mergeServerTimeline(sessionId, current[sessionId] ?? [], payload.items),
      }));
      setTimelineHasOlder((current) => (sessionId in current ? current : { ...current, [sessionId]: Boolean(payload.has_more) }));
      sessionAfterSeqRef.current[sessionId] = Math.max(0, ...merged.map((item) => Number(item.seq) || 0));
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

  function mergeSessionList(current: AgentSession[], incoming: AgentSession[], removedSessionIds: string[]) {
    const next = new Map(current.map((session) => [session.session_id, session]));
    removedSessionIds.forEach((sessionId) => next.delete(sessionId));
    incoming.forEach((session) => next.set(session.session_id, session));
    return Array.from(next.values());
  }

  function mergePermissions(current: AgentPermission[], incoming: AgentPermission[]) {
    const next = new Map(current.map((permission) => [permission.permission_id, permission]));
    incoming.forEach((permission) => next.set(permission.permission_id, permission));
    return Array.from(next.values());
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
    if (payload.items.length === 0 && payload.removed_session_ids.length === 0) return;
    const merged = mergeSessionList(sessions, payload.items, payload.removed_session_ids);
    if (archiveView === 'active') {
      alertNewNeedsReplySessions(merged, permissions);
    }
    setSessions((current) => mergeSessionList(current, payload.items, payload.removed_session_ids));
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
      alertNewPendingPermissions(next);
      return next;
    });
  }

  async function loadSessionDelta(sessionId: string) {
    const afterSeq = sessionAfterSeqRef.current[sessionId] ?? 0;
    const params = new URLSearchParams();
    if (afterSeq > 0) params.set('after_seq', String(afterSeq));
    const payload = await apiGet<SessionSyncPayload>(`/api/sync/session/${sessionId}?${params.toString()}`);
    setSessions((current) => mergeSessionList(current, [payload.session], []));
    setJobs((current) => replaceSessionJobs(current, sessionId, payload.jobs));
    if (payload.items.length > 0) {
      setTimelineBySession((current) => ({
        ...current,
        [sessionId]: mergeServerTimeline(sessionId, current[sessionId] ?? [], payload.items),
      }));
    }
    sessionAfterSeqRef.current[sessionId] = payload.next_after_seq;
    return payload;
  }

  async function loadData(
    nextCsrf?: string,
    nextUser: User | null = user,
    archiveView: SessionArchiveView = sessionArchiveView,
    options: { background?: boolean } = {},
  ) {
    const sessionsPath = archiveView === 'archived' ? '/api/sessions?archived=true' : '/api/sessions';
    const [sessionPayload, workerPayload, jobPayload, eventPayload, schedulePayload, providerPayload, permissionPayload] = await Promise.all([
      apiGet<{ items: AgentSession[] }>(sessionsPath),
      apiGet<{ items: Worker[] }>('/api/workers'),
      apiGet<{ items: Job[] }>('/api/jobs'),
      options.background ? Promise.resolve({ items: events }) : apiGet<{ items: Event[] }>('/api/events'),
      apiGet<{ items: Schedule[] }>('/api/schedules'),
      apiGet<{ items: ProviderSnapshot[] }>('/api/providers'),
      apiGet<{ items: AgentPermission[] }>('/api/permissions'),
    ]);
    const secretItems = options.background ? secrets : await loadSecretItems(nextUser);
    const activeSelectedId = selectedIdRef.current;
    const activeSelectedExists = activeSelectedId
      ? sessionPayload.items.some((session) => session.session_id === activeSelectedId)
      : false;
    const nextSelectedId = activeSelectedExists ? activeSelectedId : sessionPayload.items[0]?.session_id ?? null;
    const timelinePayload = nextSelectedId
      ? await apiGet<TimelinePayload>(`/api/sessions/${nextSelectedId}/timeline`)
      : { items: [] };
    setSessions(sessionPayload.items);
    setWorkers(workerPayload.items);
    setJobs(jobPayload.items);
    setEvents(eventPayload.items);
    setSchedules(schedulePayload.items);
    setProviders(providerPayload.items);
    setPermissions(permissionPayload.items);
    setSecrets(secretItems);
    alertNewPendingPermissions(permissionPayload.items);
    if (archiveView === 'active') {
      alertNewNeedsReplySessions(sessionPayload.items, permissionPayload.items);
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
    if (nextSelectedId) {
      sessionAfterSeqRef.current[nextSelectedId] = Math.max(0, ...timelinePayload.items.map((item) => Number(item.seq) || 0));
      setTimelineBySession((current) => ({
        ...current,
        [nextSelectedId]: mergeServerTimeline(nextSelectedId, current[nextSelectedId] ?? [], timelinePayload.items),
      }));
      setTimelineHasOlder((current) => (
        nextSelectedId in current ? current : { ...current, [nextSelectedId]: Boolean(timelinePayload.has_more) }
      ));
    }
    if (nextCsrf) setCsrfToken(nextCsrf);
  }

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setMobileSessionActionsOpen(false);
    setStatusDetailsOpen(false);
    setComposerExpanded(false);
  }, [selectedId]);

  useEffect(() => {
    mobilePaneRef.current = mobilePane;
  }, [mobilePane]);

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
      localStorage.setItem(VOICE_INPUT_MODE_STORAGE_KEY, voiceInputMode);
    } catch {
      // Ignore storage failures in embedded WebViews.
    }
  }, [voiceInputMode]);

  useEffect(() => {
    let active = true;
    apiGet<AuthPayload>('/api/auth/me')
      .then(async (payload) => {
        if (!active) return;
        setUser(payload.user);
        setCsrfToken(payload.csrf_token);
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
  }, [focusedPermissionId, mobilePane, selectedSession?.session_id, selectedPermissions.length, visibleTimeline.length]);

  useEffect(() => {
    syncNativeServerBaseUrl();
  }, []);

  useEffect(() => {
    if (loadState === 'ready') startNativeNotificationService();
  }, [loadState]);

  useEffect(() => {
    if (loadState !== 'ready') return undefined;
    let stopped = false;
    let inFlight = false;

    const syncNow = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        await loadInboxDelta(sessionArchiveView);
        await loadPermissionDelta();
        if (selectedIdRef.current) {
          await loadSessionDelta(selectedIdRef.current);
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
    setUser(payload.user);
    setCsrfToken(payload.csrf_token);
    await loadData(payload.csrf_token);
    setLoadState('ready');
  }

  async function handleRefresh() {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setNotice('正在后台刷新，当前会话不会被切换');
    try {
      await loadData();
      setNotice('后台刷新完成');
    } catch (error) {
      setNotice(`刷新失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  async function switchSessionArchiveView(view: SessionArchiveView) {
    if (view === sessionArchiveView) return;
    setSessionArchiveView(view);
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

  async function handleArchiveSession(archive: boolean) {
    if (!selectedSession || !canOperate(user)) return;
    const action = archive ? 'archive' : 'unarchive';
    try {
      await apiPost<{ session: AgentSession }>(
        `/api/sessions/${selectedSession.session_id}/${action}`,
        {},
        csrfToken,
      );
      selectedIdRef.current = null;
      setSelectedId(null);
      setNotice(archive ? '会话已归档' : '会话已恢复');
      await loadData(undefined, user, sessionArchiveView);
    } catch (error) {
      setNotice(`${archive ? '归档' : '恢复'}失败：${error instanceof Error ? error.message : '未知错误'}`);
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
    if (mode === 'fork') {
      await apiPost<{ job: Job }>(`/api/sessions/${selectedSession.session_id}/fork`, payload, csrfToken);
      setNotice('Fork 已入队');
    } else {
      await apiPost<{ job: Job }>('/api/sessions/start', payload, csrfToken);
      setNotice('新建会话已入队');
    }
    setReply('');
    await loadData();
  }

  function providerBackendFromSlashArgument(argument: string) {
    const backend = argument.trim().toLowerCase();
    if (!backend) return selectedSession?.backend ?? '';
    if (['codex', 'claude', 'kimi'].includes(backend)) return backend;
    setNotice('用法：/login、/logout，或指定 /login codex、/logout claude、/login kimi');
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
    setApkUpdate({ status: 'checking' });
    try {
      const url = apkDownloadUrl();
      let response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) {
        response = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
        });
      }
      if (!response.ok) throw new Error(String(response.status));
      setApkUpdate({
        status: 'ready',
        sizeBytes: apkSizeFromHeaders(response.headers),
        lastModified: response.headers.get('last-modified') ?? undefined,
      });
      setNotice('已检查最新 APK');
    } catch (error) {
      setApkUpdate({ status: 'failed', error: errorMessage(error) });
      setNotice(`检查 APK 失败：${errorMessage(error)}`);
    }
  }

  function handleDownloadLatestApk() {
    const url = apkDownloadUrl();
    const result = nativeDownloadLatestApk(url, APK_DOWNLOAD_FILENAME);
    if (result.startsWith('enqueued:')) {
      setNotice('APK 下载已开始，完成后点系统通知安装');
      return;
    }
    if (result.startsWith('failed:')) {
      window.open(url, '_blank', 'noopener,noreferrer');
      setNotice(`原生下载启动失败，已打开 APK 下载地址：${result.replace(/^failed:/, '')}`);
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
      persistNotificationIds(next);
      return next;
    });
  }

  function handleMarkAllNotificationsRead() {
    markNotificationIdsRead(notificationItems.map((item) => item.id));
  }

  function handleOpenNotificationItem(item: NotificationInboxItem) {
    markNotificationIdsRead([item.id]);
    closeNotificationInbox();
    if (item.permissionId) {
      const permission = pendingPermissions.find((candidate) => candidate.permission_id === item.permissionId) ?? null;
      handleOpenPendingPermission(permission);
      return;
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
    navigateMobilePane(pane, sessionId);
    void loadTimelineForSession(sessionId, { force: true }).catch(() => setNotice('会话详情同步失败，稍后会自动重试'));
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
      setReplyAttachmentsSafely([...current, ...nextAttachments]);
      setNotice(options?.pasted ? `已粘贴 ${nextAttachments.length} 张图片` : `已附加 ${nextAttachments.length} 个文件`);
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

  function resolveStreamingVoiceStopWaiters() {
    const waiters = streamingVoiceStopWaitersRef.current.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  async function stopStreamingVoiceRecording(options?: { commit?: boolean; notice?: string }) {
    if (!isRecording || voiceInputMode !== 'streaming') return;
    const controller = streamingVoiceControllerRef.current;
    streamingVoiceShouldCommitRef.current = options?.commit ?? true;
    if (!controller) {
      finalizeStreamingVoice();
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
      setNotice('正在识别语音；你可以继续输入，结果会追加到当前输入末尾');
      const payload = await apiPost<{ text: string }>(
        '/api/voice/transcribe',
        {
          filename: contentType.includes('mp4') ? 'voice.m4a' : 'voice.webm',
          content_type: audioBlob.type || 'audio/webm',
          data_base64: arrayBufferToBase64(await audioBlob.arrayBuffer()),
          language: 'zh-CN',
          duration_ms: durationMs,
          chunk_count: chunks.length,
        },
        csrfToken,
      );
      const text = payload.text.trim();
      if (!text) {
        setNotice('没有识别到文字');
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

  async function fetchVoiceStreamAuth() {
    return apiPost<VoiceStreamAuthResponse>('/api/voice/stream-auth', {}, csrfToken);
  }

  function finalizeStreamingVoice() {
    if (streamingVoiceStopHandledRef.current) return;
    streamingVoiceStopHandledRef.current = true;
    setIsRecording(false);
    streamingVoiceControllerRef.current = null;
    const text = streamingVoiceLastTextRef.current.trim();
    const shouldCommit = streamingVoiceShouldCommitRef.current;
    streamingVoiceShouldCommitRef.current = false;
    resetStreamingVoiceComposerState();
    resolveStreamingVoiceStopWaiters();
    if (!shouldCommit) return;
    if (!text) {
      setNotice('没有识别到文字');
      return;
    }
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    streamingVoiceBaseReplyRef.current = reply.trim() ? `${reply.trimEnd()}\n` : '';
    streamingVoiceShouldCommitRef.current = false;
    streamingVoiceStopHandledRef.current = false;
    try {
      const auth = await fetchVoiceStreamAuth();
      const controller = await startStreamingVoice({
        auth,
        onStart: () => {
          setIsRecording(true);
          setNotice('正在流式识别语音');
        },
        onPartialText: (text) => {
          const normalized = String(text || '').trim();
          applyStreamingVoicePartial(normalized);
          if (normalized) setNotice('正在流式识别语音');
        },
        onClose: () => {
          finalizeStreamingVoice();
        },
        onError: () => {
          setIsRecording(false);
          streamingVoiceControllerRef.current = null;
          streamingVoiceShouldCommitRef.current = false;
          resetStreamingVoiceComposerState();
          resolveStreamingVoiceStopWaiters();
          setNotice('流式语音连接中断，请重试；如仍失败可切到标准模式。');
        },
      });
      streamingVoiceControllerRef.current = controller;
      setNotice('正在流式识别语音');
    } catch (error) {
      streamingVoiceControllerRef.current = null;
      resetStreamingVoiceComposerState();
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
      if (voiceInputMode === 'streaming') {
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
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    return latestPayload?.jobs.find((job) => job.job_id === jobId) ?? null;
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
    let response: { job: Job };
    try {
      response = await apiPost<{ job: Job }>(
        `/api/sessions/${selectedSession.session_id}/input`,
        inputPayload,
        csrfToken,
      );
    } catch (error) {
      discardOptimisticUserMessage(selectedSession.session_id, optimisticItem);
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
    setReply('');
    setReplyAttachmentsSafely([]);
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

  async function handleFileList(path = '.') {
    if (!selectedSession || !canOperate(user)) return;
    try {
      const response = await apiPost<{ job: Job }>(
        `/api/sessions/${selectedSession.session_id}/files/list`,
        { path },
        csrfToken,
      );
      setNotice(path === '.' ? '正在同步 workspace 文件列表' : `正在打开 ${path}`);
      const finished = await waitForSessionJobCompletion(selectedSession.session_id, response.job.job_id);
      if (finished?.status === 'failed') {
        setNotice(`文件列表失败：${finished.error_text || '未知错误'}`);
        return;
      }
      if (!finished || ['queued', 'running'].includes(finished.status)) {
        setNotice('文件列表已入队，稍后自动同步');
        return;
      }
      setNotice(path === '.' ? 'workspace 文件列表已更新' : `${path} 已展开`);
    } catch (error) {
      setNotice(`文件列表失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async function handleFileRead(path: string) {
    if (!selectedSession || !canOperate(user)) return;
    try {
      const response = await apiPost<{ job: Job }>(
        `/api/sessions/${selectedSession.session_id}/files/read`,
        { path, max_bytes: 5_000_000 },
        csrfToken,
      );
      setNotice(`正在读取 ${path}`);
      const finished = await waitForSessionJobCompletion(selectedSession.session_id, response.job.job_id, { attempts: 20, delayMs: 300 });
      if (finished?.status === 'failed') {
        setNotice(`文件预览失败：${finished.error_text || '未知错误'}`);
        return;
      }
      if (!finished || ['queued', 'running'].includes(finished.status)) {
        setNotice(`文件读取已入队：${path}`);
        return;
      }
      setNotice(`文件已就绪：${path}`);
    } catch (error) {
      setNotice(`文件预览失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  function handleDownloadWorkspaceFile(file: WorkspaceFileReadResult) {
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
    const payload: Record<string, string | boolean | string[] | null> = {};
    if (controlsDraft.model.trim()) payload.model = controlsDraft.model.trim();
    if (controlsDraft.sandbox_mode) payload.sandbox_mode = controlsDraft.sandbox_mode;
    if (controlsDraft.approval_mode) payload.approval_mode = controlsDraft.approval_mode;
    if (controlsDraft.permission_mode) payload.permission_mode = controlsDraft.permission_mode;
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
    const response = await apiPatch<{ session: AgentSession }>(
      `/api/sessions/${selectedSession.session_id}/controls`,
      fullAccessControls,
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
            <Shield size={24} />
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
    <main className={`app-shell theme-${themeMode} text-ink bg-paper`}>
      <header className="topbar">
        <div className="brand-row">
          <button
            className="icon-button mobile-only topbar-menu-button"
            type="button"
            aria-label="打开会话列表"
            title="打开会话列表"
            onClick={handleOpenSessionList}
          >
            <Menu size={20} />
          </button>
          <TerminalSquare size={22} />
          <span>AgentHub</span>
        </div>
        <div className="mobile-worker-signal">
          <span className="status-dot status-good" />
          节点 {onlineWorkers}/{workers.length} · 自动同步
        </div>
        <div className="topbar-actions">
          <button className="icon-button primary-top-action" type="button" onClick={openStartSession} disabled={!canOperate(user)}>
            <Plus size={17} />
            <span>新建会话</span>
          </button>
          <span className="sync-chip">
            {isRefreshing ? '同步中' : `自动同步 ${lastSyncedAt ? formatRelative(lastSyncedAt) : '准备中'}`}
          </span>
          {user && <span className="role-chip">{user.role}</span>}
          <button
            className="icon-button theme-switch-button"
            type="button"
            title={themeMode === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
            aria-label={themeMode === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
            onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {themeMode === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            <span>{themeMode === 'dark' ? '浅色' : '深色'}</span>
          </button>
          <button
            className={`icon-button refresh-button ${isRefreshing ? 'refreshing' : ''}`}
            type="button"
            title="Refresh"
            aria-label={isRefreshing ? '刷新中' : '刷新'}
            aria-busy={isRefreshing}
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={isRefreshing ? 'spin-icon' : ''} size={17} />
            <span>{isRefreshing ? '刷新中' : '刷新'}</span>
          </button>
          <button
            className={`icon-button notification-button ${unreadNotificationCount > 0 ? 'has-alert' : ''}`}
            title="通知"
            type="button"
            aria-label={
              notificationItems.length > 0
                ? `打开待处理通知 inbox，${unreadNotificationCount} 条未读`
                : `通知${notificationPermission === 'granted' ? '已开启' : ''}`
            }
            onClick={handleTopbarBellClick}
          >
            <Bell size={17} />
            {unreadNotificationCount > 0 && <span className="notification-badge">{unreadNotificationCount}</span>}
          </button>
          <button className="icon-button" type="button" onClick={handleLogout}>
            <LogOut size={17} />
            退出登录
          </button>
        </div>
      </header>

      {notificationInboxOpen && (
        <NotificationInbox
          items={notificationItems}
          readIds={readNotificationIds}
          onOpenItem={handleOpenNotificationItem}
          onMarkAllRead={handleMarkAllNotificationsRead}
          onClose={closeNotificationInbox}
        />
      )}

      {visiblePendingPermission && (
        <div className="notification-toast" role="group" aria-label="审批待处理通知">
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

      <section className={`workspace mobile-pane-${mobilePane}`}>
        <aside className="session-list" aria-label="Sessions">
          <div className="section-heading">
            <h1>
              {sessionArchiveView === 'archived' ? '会话归档' : '会话收件箱'}
              <span className="session-count-inline">{filteredSessions.length} 个</span>
            </h1>
          </div>
          <div className="session-view-tabs" role="group" aria-label="会话视图">
            <button
              type="button"
              className={sessionArchiveView === 'active' ? 'selected' : ''}
              onClick={() => void switchSessionArchiveView('active')}
            >
              收件箱
            </button>
            <button
              type="button"
              className={sessionArchiveView === 'archived' ? 'selected' : ''}
              onClick={() => void switchSessionArchiveView('archived')}
            >
              归档
            </button>
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              aria-label="搜索会话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话、项目或内容"
            />
            {query && (
              <button
                type="button"
                className="search-clear-button"
                aria-label="清空搜索"
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <div className="provider-filter" aria-label="Provider filters">
            {providerFilters.map((filter) => (
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
            <span>排序：最近活动</span>
            <SlidersHorizontal size={15} />
          </div>
          {filteredSessions.length === 0 && (
            <p className="empty">{sessionArchiveView === 'archived' ? '暂无归档会话。' : '暂无会话。'}</p>
          )}
          {filteredSessions.map((session) => (
            <button
              key={session.session_id}
              className={`session-row ${session.session_id === selectedSession?.session_id ? 'selected' : ''}`}
              onClick={() => openSession(session.session_id)}
            >
              <span className={`status-dot ${statusClass(session.status)}`} />
              <span className="session-row-body">
                <span className="session-row-top">
                  <strong>{sessionTitle(session)}</strong>
                  <span className={`mini-state ${statusClass(session.status)}`}>{statusLabel(session.status)}</span>
                </span>
                <span className="session-row-meta">
                  <span className="backend-mark">
                    <TerminalSquare size={14} />
                    {backendLabel(session.backend)}
                  </span>
                  <span>{session.project_name} / {session.namespace}</span>
                  <small>{formatRelative(session.last_activity_at) || formatWhen(session.last_activity_at)}</small>
                </span>
                <span className="session-row-bottom">
                  <small>{agentOpsActivitySummary(session.activity_summary || session.last_message, session.status)}</small>
                </span>
              </span>
            </button>
          ))}
        </aside>

        <section className="thread-pane">
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
                    aria-label={statusDetailsOpen ? '收起会话状态' : '展开会话状态'}
                    aria-expanded={statusDetailsOpen}
                    onClick={() => setStatusDetailsOpen((open) => !open)}
                  >
                    <span className={`state-pill ${statusClass(selectedSession.status)}`}>
                      {statusLabel(selectedSession.status)}
                    </span>
                    <span>{backendLabel(selectedSession.backend)}</span>
                    <span>{selectedSession.worker_id}</span>
                    <span>{sandboxSummary(selectedSession)}</span>
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
                    控制
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
                    aria-label={sessionArchiveView === 'archived' ? '恢复会话' : '归档会话'}
                    title={sessionArchiveView === 'archived' ? '恢复会话' : '归档会话'}
                    onClick={() => void handleArchiveSession(sessionArchiveView !== 'archived')}
                    disabled={!canOperate(user)}
                  >
                    {sessionArchiveView === 'archived' ? <RotateCcw size={16} /> : <Archive size={16} />}
                    {sessionArchiveView === 'archived' ? '恢复' : '归档'}
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
                          {sessionArchiveView === 'archived' ? '恢复' : '归档'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <section className="message-block" aria-label="Transcript" ref={transcriptRef}>
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
                              <TimelineText text={message.text} />
                            </details>
                          ) : (
                            <>
                              <TimelineText text={message.text} />
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

              <form
                className={`reply-box ${isTranscribing ? 'is-transcribing' : ''} ${composerExpanded ? 'is-expanded' : ''}`}
                onSubmit={handleReply}
              >
                <label className="reply-title" htmlFor="reply">回复当前会话</label>
                <div className="reply-mode-tabs" role="group" aria-label="回复模式">
                  {(Object.keys(replyModeLabels) as ReplyMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={replyMode === mode ? 'selected' : ''}
                      aria-pressed={replyMode === mode}
                      onClick={() => setReplyMode(mode)}
                    >
                      {replyModeLabels[mode]}
                    </button>
                  ))}
                  <span className="reply-mode-hint">{replyModeHint(replyMode, selectedSession, selectedProvider)}</span>
                </div>
                <textarea
                  id="reply"
              ref={replyTextareaRef}
              aria-label="回复当前会话"
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
                          <small>{option.description}</small>
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
                <div className="voice-mode-toggle" role="group" aria-label="语音输入模式">
                  <button
                    type="button"
                    className={voiceInputMode === 'streaming' ? 'selected' : ''}
                    aria-pressed={voiceInputMode === 'streaming'}
                    onClick={() => setVoiceInputMode('streaming')}
                    disabled={isRecording}
                  >
                    流式
                  </button>
                  <button
                    type="button"
                    className={voiceInputMode === 'standard' ? 'selected' : ''}
                    aria-pressed={voiceInputMode === 'standard'}
                    onClick={() => setVoiceInputMode('standard')}
                    disabled={isRecording}
                  >
                    标准
                  </button>
                </div>
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
                    title={isRecording ? '停止录音' : isTranscribing ? '正在识别语音' : voiceInputMode === 'streaming' ? '流式语音输入' : '标准语音输入'}
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
              </form>
            </>
          ) : (
            <div className="empty-detail">Select a session.</div>
          )}
        </section>

        <aside className="ops-rail" aria-label="Controls">
          <h2 className="rail-title">会话控制</h2>
          {selectedSession && (
            <>
              <section className="inspector-overview" aria-label="当前会话概览">
                <span className={`state-pill ${statusClass(selectedSession.status)}`}>
                  {statusLabel(selectedSession.status)}
                </span>
                <div>
                  <strong>{agentOpsTaskHeadline(selectedSession)}</strong>
                  <p>{agentOpsTaskSummary(selectedSession)}</p>
                </div>
              </section>

              <Panel title="本机恢复" icon={<TerminalSquare size={16} />} defaultOpen={false}>
                <div className="local-resume-panel">
                  <p>{localResumeHint(selectedSession)}</p>
                  <code>{localResumeCommand(selectedSession)}</code>
                  <small>
                    Workspace: {selectedSession.workspace_root || 'default'} · Runtime: {selectedSession.runtime_session_ref || selectedSession.session_id}
                  </small>
                </div>
              </Panel>

              <Panel title="模型与工具" icon={<Bot size={16} />} defaultOpen={false}>
                <form className="editor-panel" onSubmit={handleControls}>
                  <div className="control-summary">
                    <span>
                      <Shield size={15} />
                      当前权限：{sandboxSummary(selectedSession)}
                    </span>
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={handleApplyFullAccessControls}
                      disabled={!canOperate(user)}
                    >
                      应用全权限
                    </button>
                  </div>
                  <div className="control-fields">
                    <label>
                      模型
                      <select
                        aria-label="模型"
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
                      沙箱
                      <select
                        aria-label="沙箱"
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
                    <label>
                      审批
                      <select
                        aria-label="审批"
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
                    <label>
                      权限策略
                      <select
                        aria-label="权限策略"
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
                      执行器
                      <input
                        aria-label="执行器"
                        value={controlsDraft.agent}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, agent: event.target.value }))}
                        placeholder="codex exec / kimi -p"
                        disabled={!canOperate(user)}
                      />
                    </label>
                    <label>
                      思考
                      <select
                        aria-label="思考"
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
                      Secret 环境
                      <input
                        aria-label="Secret 环境"
                        value={controlsDraft.secret_environment}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, secret_environment: event.target.value }))}
                        placeholder="default / test / prod"
                        disabled={!canOperate(user)}
                      />
                    </label>
                    <label>
                      Secret 命名空间
                      <input
                        aria-label="Secret 命名空间"
                        value={controlsDraft.secret_namespace}
                        onChange={(event) => updateControlsDraft((current) => ({ ...current, secret_namespace: event.target.value }))}
                        placeholder="default"
                        disabled={!canOperate(user)}
                      />
                    </label>
                  </div>
                  <label className="secret-ref-field">
                    Secret 引用
                    <textarea
                      aria-label="Secret 引用"
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
                    自动确认 <small>YOLO</small>
                  </label>
                  <button type="submit" disabled={!canOperate(user)}>
                    <Check size={16} />
                    保存控制
                  </button>
                </form>
              </Panel>

              <Panel title="重命名" icon={<Save size={16} />} defaultOpen={false}>
                <form className="editor-panel" onSubmit={handleRename}>
                  <label>
                    会话标题
                    <input
                      aria-label="会话标题"
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
                    保存标题
                  </button>
                </form>
              </Panel>
            </>
          )}

          <Panel title="Provider 状态" icon={<TerminalSquare size={16} />} defaultOpen={false}>
            {providers.length > 0 ? (
              providers.map((provider) => (
                <div className="provider-row" key={`${provider.worker_id}-${provider.backend}`}>
                  <div>
                    <strong>{backendLabel(provider.backend)}</strong>
                    <small>
                      {provider.worker_id} · {statusLabel(provider.status)} · {provider.auth_status ?? 'unknown'}
                    </small>
                    <span className="provider-interaction">{providerInteractionSummary(provider)}</span>
                  </div>
                  {canAdmin(user) && (
                    <div className="provider-actions">
                      <button type="button" onClick={() => handleProviderAuth(provider.worker_id, provider.backend, 'login')}>
                        登录
                      </button>
                      <button type="button" onClick={() => handleProviderAuth(provider.worker_id, provider.backend, 'logout')}>
                        {backendLabel(provider.backend)} 退出
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="empty">暂无 Provider 快照。</p>
            )}
          </Panel>

          {canAdmin(user) && (
            <Panel title="Secrets" icon={<Lock size={16} />} defaultOpen={false}>
              <form className="secret-form" onSubmit={handleSecretSubmit}>
                <div className="control-fields">
                  <label>
                    Secret 名称
                    <input
                      aria-label="Secret 名称"
                      value={secretDraft.name}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, name: event.target.value }))}
                      placeholder="OPENAI_API_KEY"
                    />
                  </label>
                  <label>
                    Secret 环境配置
                    <input
                      aria-label="Secret 环境配置"
                      value={secretDraft.environment}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, environment: event.target.value }))}
                      placeholder="default / test / prod"
                    />
                  </label>
                  <label>
                    Secret 命名空间配置
                    <input
                      aria-label="Secret 命名空间配置"
                      value={secretDraft.namespace}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, namespace: event.target.value }))}
                      placeholder="default"
                    />
                  </label>
                  <label>
                    Secret 值
                    <input
                      aria-label="Secret 值"
                      type="password"
                      value={secretDraft.value}
                      onChange={(event) => setSecretDraft((current) => ({ ...current, value: event.target.value }))}
                      placeholder="只保存，不显示"
                    />
                  </label>
                </div>
                <label className="secret-ref-field">
                  描述
                  <input
                    aria-label="Secret 描述"
                    value={secretDraft.description}
                    onChange={(event) => setSecretDraft((current) => ({ ...current, description: event.target.value }))}
                    placeholder="例如：prod OpenAI-compatible key"
                  />
                </label>
                <button type="submit">保存 Secret</button>
              </form>
              <div className="secret-list" aria-label="Secrets list">
                {secrets.length === 0 && <p className="empty">暂无 Secret。保存后在会话控制里引用名称。</p>}
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

          <Panel title="节点健康" icon={<Activity size={16} />} defaultOpen={false}>
            {(selectedWorker ? [selectedWorker] : workers).map((worker) => (
              <div className="rail-row" key={worker.worker_id}>
                <span className={`status-dot ${statusClass(worker.status)}`} />
                <span>{worker.worker_id}</span>
                <small>{statusLabel(worker.status)}</small>
              </div>
            ))}
            {workers.length === 0 && <p className="empty">暂无在线节点。</p>}
            {canAdmin(user) && (
              <button type="button" onClick={openWorkerInstall}>
                添加 Worker
              </button>
            )}
          </Panel>
          {selectedJobs.length > 0 && (
            <Panel title="当前作业" icon={<TerminalSquare size={16} />}>
              {selectedJobs.slice(0, 4).map((job) => {
                const hint = jobStatusHint(job);
                return (
                  <details className="job-row" key={job.job_id} open={job.status === 'running' || job.status === 'queued'}>
                    <summary>
                      <span className={`status-dot ${statusClass(job.status)}`} />
                      <span>{job.kind}</span>
                      <small>{statusLabel(job.status)}</small>
                    </summary>
                    {hint && <p className="job-hint">{hint}</p>}
                    {job.error_text ? (
                      <p className="job-error">{failureSummary(job.error_text)}</p>
                    ) : job.result_text ? (
                      <p className="job-result">{jobResultSummary(job.result_text)}</p>
                    ) : (
                      <p className="empty">等待 worker 处理。</p>
                    )}
                    {(job.error_text || job.result_text) && (
                      <details className="raw-detail">
                        <summary>原始输出</summary>
                        <code>{job.error_text || job.result_text}</code>
                      </details>
                    )}
                  </details>
                );
              })}
            </Panel>
          )}
          {schedules.length > 0 || canAdmin(user) ? (
          <Panel title="计划任务" icon={<CalendarClock size={16} />} defaultOpen={false}>
            {schedules.slice(0, 6).map((schedule) => (
              <div className="event-row" key={schedule.schedule_id}>
                <span>{schedule.name}</span>
                <small>{schedule.enabled ? 'enabled' : 'disabled'} · {schedule.job_kind}</small>
              </div>
            ))}
            {schedules.length === 0 && <p className="empty">暂无计划任务。</p>}
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
                <button type="submit">创建计划</button>
              </form>
            )}
          </Panel>
          ) : null}
          {events.length > 0 && (
          <Panel title="审计事件" icon={<Lock size={16} />} defaultOpen={false}>
            {events.slice(0, 6).map((event) => (
              <div className="event-row" key={event.event_id}>
                <span>{event.event_type}</span>
                <small>{event.actor_type}:{event.actor_id}</small>
              </div>
            ))}
          </Panel>
          )}
          {canAdmin(user) && <button className="invite-button">邀请用户</button>}
        </aside>

        {mobilePane === 'files' && (
          <MobileFilesPane
            session={selectedSession}
            jobs={selectedJobs}
            attachments={replyAttachments}
            onCopyPath={(value) => void copyTextToClipboard(value, 'file path 已复制')}
            onCopyText={(value) => void copyTextToClipboard(value, '文件内容已复制')}
            onDownload={handleDownloadWorkspaceFile}
            onList={(path) => void handleFileList(path)}
            onRead={(path) => void handleFileRead(path)}
          />
        )}
        {mobilePane === 'workers' && (
          <MobileWorkersPane
            workers={workers}
            jobs={jobs}
            providers={providers}
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
            apkUpdate={apkUpdate}
            apkUrl={apkDownloadUrl()}
            themeMode={themeMode}
            onThemeModeChange={setThemeMode}
            onNotificationSetup={() => void handleNotificationSetup()}
            onRestartNotificationGuard={handleRestartNotificationGuard}
            onCheckApkUpdate={() => void handleCheckApkUpdate()}
            onDownloadLatestApk={handleDownloadLatestApk}
            onCopyApkUrl={() => void copyTextToClipboard(apkDownloadUrl(), 'APK 地址已复制')}
            onLogout={handleLogout}
          />
        )}
      </section>

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

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button type="button" className={mobilePane === 'sessions' ? 'selected' : ''} onClick={showSessionList}>
          <MessageCircle size={18} />
          会话
        </button>
        <button type="button" className={mobilePane === 'thread' ? 'selected' : ''} onClick={() => navigateMobilePane('thread')}>
          <Play size={18} />
          对话
        </button>
        <button type="button" className={mobilePane === 'files' ? 'selected' : ''} onClick={() => navigateMobilePane('files')}>
          <Folder size={18} />
          文件
        </button>
        <button type="button" className={mobilePane === 'workers' ? 'selected' : ''} onClick={() => navigateMobilePane('workers')}>
          <Cpu size={18} />
          节点
        </button>
        <button
          type="button"
          className={mobilePane === 'me' ? 'selected' : ''}
          onClick={() => navigateMobilePane('me')}
        >
          <UserCircle size={18} />
          我的
        </button>
      </nav>
    </main>
  );
}

function NotificationInbox({
  items,
  readIds,
  onOpenItem,
  onMarkAllRead,
  onClose,
}: {
  items: NotificationInboxItem[];
  readIds: Set<string>;
  onOpenItem: (item: NotificationInboxItem) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
}) {
  const unreadCount = items.filter((item) => !readIds.has(item.id)).length;
  return (
    <section className="notification-inbox" role="dialog" aria-label="通知 inbox">
      <header>
        <div>
          <p>{unreadCount > 0 ? `${unreadCount} 条未读` : '全部已读'}</p>
          <h2>通知</h2>
        </div>
        <button type="button" className="native-icon-button" aria-label="关闭通知 inbox" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="notification-inbox-actions">
        <button type="button" className="message-action-button" onClick={onMarkAllRead} disabled={items.length === 0}>
          <Check size={13} />
          全部标为已读
        </button>
      </div>
      <div className="notification-inbox-list">
        {items.length === 0 && <p className="empty">暂无通知。需要审批、选择或作业失败时会出现在这里。</p>}
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
              <em>{unread ? '未读' : '已读'}</em>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MobileFilesPane({
  session,
  jobs,
  attachments,
  onCopyPath,
  onCopyText,
  onDownload,
  onList,
  onRead,
}: {
  session?: AgentSession | null;
  jobs: Job[];
  attachments?: ReplyAttachment[];
  onCopyPath: (value: string) => void;
  onCopyText: (value: string) => void;
  onDownload: (file: WorkspaceFileReadResult) => void;
  onList: (path: string) => void;
  onRead: (path: string) => void;
}) {
  const workspaceRoot = session?.workspace_root || '';
  const listResult = fileListResult(jobs);
  const readResult = fileReadResult(jobs);
  const busy = fileJobBusy(jobs);
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
  return (
    <section className="mobile-panel files-pane" aria-label="文件">
      <div className="mobile-panel-head">
        <div>
          <p>{session ? sessionTitle(session) : '当前没有会话'}</p>
          <h2>文件浏览器</h2>
        </div>
        <button type="button" className={`native-icon-button ${busy ? 'loading' : ''}`} disabled={!session} onClick={() => onList(currentPath)}>
          <RefreshCw size={18} />
        </button>
      </div>
      <div className="file-context-card">
        <span>Workspace</span>
        <code>{workspaceRoot || '未绑定 workspace'}</code>
        <div className="file-toolbar">
          <button
            type="button"
            className="message-action-button"
            aria-label="复制 file path"
            disabled={!workspaceRoot}
            onClick={() => onCopyPath(workspaceRoot)}
          >
            <Copy size={13} />
            复制路径
          </button>
          <button type="button" className="message-action-button" disabled={!session} onClick={() => onList('.')}>
            <Folder size={13} />
            浏览 workspace
          </button>
        </div>
      </div>
      <div className="file-browser-card">
        <div className="file-browser-title">
          <span>{currentPath === '.' ? 'Workspace root' : currentPath}</span>
          {busy && <small>同步中</small>}
        </div>
        {parentPath && (
          <button type="button" className="message-action-button" onClick={() => onList(parentPath)}>
            <RotateCcw size={13} />
            返回上一级
          </button>
        )}
        {!listResult && <p className="empty">点“浏览 workspace”后，worker 会返回只读文件列表。</p>}
        {listResult && listResult.entries.length === 0 && <p className="empty">这个目录是空的。</p>}
        {listResult?.entries.map((entry) => (
          <div className="file-row" key={entry.path}>
            <button
              type="button"
              className="file-row-main"
              aria-label={entry.kind === 'directory' ? `进入 ${entry.name}` : `预览 ${entry.name}`}
              onClick={() => (entry.kind === 'directory' ? onList(entry.path) : onRead(entry.path))}
            >
              {entry.kind === 'directory' ? <Folder size={17} /> : <FileText size={17} />}
              <span>
                <strong>{entry.name}</strong>
                <small>{entry.kind === 'directory' ? '目录' : `${formatFileSize(entry.size_bytes)} · ${formatWhen(entry.modified_at) || entry.path}`}</small>
              </span>
            </button>
            <button type="button" className="native-icon-button small" aria-label={`复制 ${entry.name} 路径`} onClick={() => onCopyPath(entry.path)}>
              <Copy size={14} />
            </button>
          </div>
        ))}
        {listResult?.truncated && <p className="file-note">已显示前 300 项，请进入更深目录继续浏览。</p>}
      </div>
      {readResult && (
        <div className="file-preview-card">
          <div className="file-preview-head">
            <span>
              <strong>{readResult.filename || readResult.path}</strong>
              <small>{formatFileSize(readResult.size_bytes)}{readResult.truncated ? ' · 已截断' : ''}</small>
            </span>
            <div className="file-toolbar">
              {readResult.preview_kind === 'text' && (
                <button type="button" className="native-icon-button small" aria-label="复制文件内容" onClick={() => onCopyText(readResult.text || '')}>
                  <Copy size={14} />
                </button>
              )}
              {readResult.downloadable && (
                <button type="button" className="message-action-button" onClick={() => onDownload(readResult)}>
                  <Download size={13} />
                  下载文件
                </button>
              )}
            </div>
          </div>
          {readResult.preview_kind === 'image' && imagePreviewUrl && <img className="file-preview-image" src={imagePreviewUrl} alt={readResult.filename} />}
          {readResult.preview_kind === 'text' && (
            <>
              {previewHeadline && <strong className="file-preview-title">{previewHeadline}</strong>}
              {previewSummary && <small className="file-preview-summary">{previewSummary}</small>}
              <pre>{readResult.text}</pre>
            </>
          )}
          {readResult.preview_kind === 'download' && <p className="empty">这个文件不是纯文本，先下载到本地查看更稳。</p>}
        </div>
      )}
      {attachments && attachments.length > 0 && (
        <div className="mobile-panel-card attached-file-card">
          <strong>待发送附件</strong>
          {attachments.map((attachment, index) => (
            <span key={`${attachment.filename}-${index}`}>
              {attachment.filename}
              <small>{attachment.content_type} · {Math.max(1, Math.round(attachment.size_bytes / 1024))} KB</small>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function MobileWorkersPane({
  workers,
  jobs,
  providers,
  canAdmin,
  onAddWorker,
}: {
  workers: Worker[];
  jobs: Job[];
  providers: ProviderSnapshot[];
  canAdmin: boolean;
  onAddWorker: () => void;
}) {
  const queuedJobs = jobs.filter((job) => job.status === 'queued').length;
  const runningJobs = jobs.filter((job) => job.status === 'running').length;
  return (
    <section className="mobile-panel workers-pane" aria-label="节点">
      <div className="mobile-panel-head">
        <div>
          <p>在线 {workers.filter((worker) => worker.status === 'online').length}/{workers.length} · 排队 {queuedJobs} · 运行 {runningJobs}</p>
          <h2>节点诊断</h2>
        </div>
        <Cpu size={22} />
      </div>
      {workers.length === 0 && <p className="empty">暂无节点。先添加本机或远端 worker。</p>}
      {workers.map((worker) => {
        const workerProviders = providers.filter((provider) => provider.worker_id === worker.worker_id);
        return (
          <article className="worker-diagnostic-card" key={worker.worker_id}>
            <div className="worker-diagnostic-top">
              <span className={`status-dot ${statusClass(worker.status)}`} />
              <strong>{worker.worker_id}</strong>
              <small>{statusLabel(worker.status)}</small>
            </div>
            <p>{worker.machine_name || worker.os} · {worker.connection_mode || 'private'} · {worker.transport_state || 'polling'}</p>
            <p>版本 {worker.worker_version || 'unknown'}</p>
            <p>Backend：{worker.reachable_backends.length > 0 ? worker.reachable_backends.map(backendLabel).join(' / ') : '未发现'}</p>
            {workerProviders.length > 0 && (
              <div className="worker-provider-strip">
                {workerProviders.map((provider) => (
                  <span key={`${provider.worker_id}-${provider.backend}`}>
                    {backendLabel(provider.backend)} · {statusLabel(provider.status)} · {provider.auth_status}
                  </span>
                ))}
              </div>
            )}
          </article>
        );
      })}
      {canAdmin && (
        <button type="button" className="invite-button" onClick={onAddWorker}>
          添加 Worker
        </button>
      )}
    </section>
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
  apkUpdate,
  apkUrl,
  themeMode,
  onThemeModeChange,
  onNotificationSetup,
  onRestartNotificationGuard,
  onCheckApkUpdate,
  onDownloadLatestApk,
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
  apkUpdate: ApkUpdateState;
  apkUrl: string;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  onNotificationSetup: () => void;
  onRestartNotificationGuard: () => void;
  onCheckApkUpdate: () => void;
  onDownloadLatestApk: () => void;
  onCopyApkUrl: () => void;
  onLogout: () => void;
}) {
  const onlineWorkers = workers.filter((worker) => worker.status === 'online').length;
  const workerSummary = workers.length > 0 ? `${onlineWorkers}/${workers.length} 在线` : '暂无节点';
  const notificationLabel = notificationPermission === 'granted' ? '已开启' : notificationPermission === 'denied' ? '已拒绝' : '未开启';
  const nativeVersionLabel = nativeVersion
    ? `当前 APK：${nativeVersion.name}${nativeVersion.code ? ` (${nativeVersion.code})` : ''}`
    : '当前环境：Web 控制台';
  const updateLabel =
    apkUpdate.status === 'checking'
      ? '线上 APK：检查中'
      : apkUpdate.status === 'ready'
        ? `线上 APK：${formatFileSize(apkUpdate.sizeBytes)}${apkUpdate.lastModified ? ` · ${formatWhen(apkUpdate.lastModified)}` : ''}`
        : apkUpdate.status === 'failed'
          ? `线上 APK：检查失败 ${apkUpdate.error ?? ''}`.trim()
          : '线上 APK：尚未检查';
  return (
    <section className="mobile-panel me-pane" aria-label="我的">
      <div className="mobile-panel-head">
        <div>
          <p>{user?.role ?? 'anonymous'} · AgentHub</p>
          <h2>设备与更新</h2>
        </div>
        <Smartphone size={22} />
      </div>

      <div className="mobile-panel-card me-update-card">
        <div>
          <strong>{nativeVersionLabel}</strong>
          <p>{updateLabel}</p>
          <small>{apkUrl}</small>
        </div>
        <div className="me-action-row">
          <button type="button" className="message-action-button" onClick={onCheckApkUpdate} disabled={apkUpdate.status === 'checking'}>
            <RefreshCw size={13} />
            {apkUpdate.status === 'checking' ? '检查中' : '检查更新'}
          </button>
          <button type="button" className="message-action-button primary-inline-action" onClick={onDownloadLatestApk}>
            <Download size={13} />
            下载最新 APK
          </button>
          <button type="button" className="message-action-button" onClick={onCopyApkUrl}>
            <Copy size={13} />
            复制地址
          </button>
        </div>
      </div>

      <div className="mobile-panel-card me-account-card">
        <div className="me-account-head">
          <UserCircle size={28} />
          <div>
            <strong>{user?.email ?? '未登录'}</strong>
            <p>通知：{notificationLabel} · 待处理 {pendingCount}</p>
          </div>
        </div>
        <div className="me-action-row">
          <button type="button" className="message-action-button" onClick={onNotificationSetup}>
            <Bell size={13} />
            开启通知
          </button>
          <button type="button" className="message-action-button" onClick={onRestartNotificationGuard}>
            <Activity size={13} />
            重启守护
          </button>
        </div>
      </div>

      <div className="mobile-panel-card me-theme-card">
        <strong>外观</strong>
        <p>手机端可以在深色和浅色之间切换，设置会保存在当前设备。</p>
        <div className="theme-toggle" role="group" aria-label="外观模式">
          {(['dark', 'light'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={themeMode === mode ? 'selected' : ''}
              aria-pressed={themeMode === mode}
              onClick={() => onThemeModeChange(mode)}
            >
              {mode === 'dark' ? '深色' : '浅色'}
            </button>
          ))}
        </div>
      </div>

      <div className="me-status-grid">
        <div className="mobile-panel-card me-metric-card">
          <small>节点</small>
          <strong>节点：{workerSummary}</strong>
          <p>{workers.length > 0 ? workers.map((worker) => worker.machine_name || worker.worker_id).slice(0, 2).join(' / ') : '先在电脑安装本地 worker'}</p>
        </div>
        <div className="mobile-panel-card me-metric-card">
          <small>Secrets</small>
          <strong>{secrets.length} 个</strong>
          <p>{secrets.length > 0 ? '会话控制里可引用，值不会显示在聊天里' : 'API key 应放到 Secrets，不要直接发进聊天'}</p>
        </div>
        <div className="mobile-panel-card me-metric-card">
          <small>API</small>
          <strong>已连接</strong>
          <p>{lastSyncedAt ? `同步：${formatRelative(lastSyncedAt)}` : '等待首次同步'}</p>
        </div>
        <div className="mobile-panel-card me-metric-card">
          <small>审批</small>
          <strong>{pendingCount} 条</strong>
          <p>{pendingCount > 0 ? '回到 Chat 处理用户选择和审批' : '暂无等待你处理的请求'}</p>
        </div>
      </div>

      <button type="button" className="invite-button" onClick={onLogout}>
        退出登录
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
          <TerminalSquare size={20} />
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
    <details className="rail-panel" open={isOpen} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary aria-expanded={isOpen}>
        <span>
          {icon}
          {title}
        </span>
        <ChevronDown size={15} />
      </summary>
      <div className="rail-panel-body">{children}</div>
    </details>
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
                }))
              }
            >
              <option value="windows">Windows</option>
              <option value="linux">Linux</option>
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
              placeholder="可选。默认会自动扫描 .codex/.claude/.kimi"
            />
          </label>
        </div>
        <div className="launch-options worker-backend-options">
          {(['codex', 'claude', 'kimi'] as const).map((backend) => (
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
            disabled={!canSubmit || !draft.worker_id.trim() || !draft.api_url.trim() || workerInstallBackends(draft).length === 0}
          >
            生成安装命令
          </button>
        </div>
      </form>
    </div>
  );
}

export default App;
