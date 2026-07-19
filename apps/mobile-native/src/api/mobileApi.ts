import { createAgentHubClient, type FetchLike } from '@agenthub/client-core';

export interface NativeUser {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  created_at?: string;
}

export interface NativeAuthPayload {
  user: NativeUser;
  csrf_token: string;
  space?: {
    space_id: string;
    name: string;
    slug: string;
    mode: string;
    role?: string | null;
  } | null;
}

export type NativeSessionStatus =
  | 'ready'
  | 'queued'
  | 'running'
  | 'needs_reply'
  | 'failed'
  | 'terminated';

export interface NativeSessionControls {
  model?: string;
  approval_mode?: string;
  sandbox_mode?: string;
  permission_mode?: string;
  interaction_bridge?: string;
  yolo?: boolean;
  thinking?: boolean;
  agent?: string;
  extra_workspace_dirs?: string[];
  secret_refs?: string[];
  secret_environment?: string;
  secret_namespace?: string;
}

export interface NativeSessionSummary {
  session_id: string;
  title: string;
  backend: string;
  worker_id: string;
  status: NativeSessionStatus;
  last_activity_at: string | null;
  updated_at?: string | null;
  execution_status?: 'unknown' | 'idle' | 'queued' | 'running' | 'waiting_input' | 'failed' | 'terminated';
  execution_status_observed_at?: string | null;
  attention_status?: 'none' | 'unseen' | 'seen';
  attention_reason?: '' | 'completion' | 'approval' | 'failure';
  project_name?: string;
  workspace_root?: string;
  namespace?: string;
  latest_session_id?: string | null;
  activity_summary?: string;
  last_message?: string;
  controls?: NativeSessionControls;
  runtime_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  archived_at?: string | null;
}

export interface NativeSessionStartInput {
  worker_id: string;
  backend: string;
  workspace_root: string;
  project_name?: string;
  namespace?: string;
  prompt: string;
  title?: string;
  controls?: NativeSessionControls;
}

export interface NativeSessionForkInput {
  worker_id?: string;
  backend?: string;
  workspace_root?: string;
  project_name?: string;
  namespace?: string;
  prompt: string;
  title?: string;
  controls?: NativeSessionControls;
}

export interface NativeSessionBtwInput {
  prompt: string;
  title?: string;
  controls?: NativeSessionControls;
}

export interface NativeTimelineItem {
  session_id: string;
  seq: number;
  item_type:
    | 'user_message'
    | 'assistant_message'
    | 'reasoning'
    | 'tool_call'
    | 'todo'
    | 'goal'
    | 'error'
    | 'compaction';
  role: 'user' | 'assistant' | 'system' | 'tool' | null;
  text: string;
  tool_call_id: string | null;
  tool_name: string | null;
  status: 'started' | 'running' | 'completed' | 'failed' | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export type NativePermissionAction = 'allow' | 'deny' | 'answer' | 'edit_and_allow';

export interface NativePermission {
  permission_id: string;
  session_id: string;
  worker_id: string;
  backend: string;
  kind:
    | 'tool'
    | 'tool_approval'
    | 'command_approval'
    | 'plan'
    | 'plan_exit'
    | 'question'
    | 'mode'
    | 'other';
  title: string;
  description: string;
  detail: Record<string, unknown>;
  actions: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'answered' | 'expired';
  response: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
}

export interface NativeJob {
  job_id: string;
  kind: string;
  target_session_id: string | null;
  worker_id: string | null;
  backend: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  queue_reason?: string | null;
  queue_reason_text?: string | null;
  error_text: string | null;
  result_text?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface NativeNotificationRecord {
  notification_id: string;
  notification_type: 'approval' | 'completion' | 'failure' | string;
  source_type: string;
  source_id: string;
  session_id: string | null;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error' | string;
  status: 'pending' | 'delivered' | 'read' | 'acknowledged' | 'dismissed' | 'superseded';
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  read_at: string | null;
  acknowledged_at: string | null;
  dismissed_at: string | null;
}

export interface NativeNotificationTransitionPayload {
  notification: NativeNotificationRecord;
  claimed: boolean;
}

export interface NativeSessionAttachmentInput {
  filename: string;
  content_type: string;
  data_base64: string;
}

export interface NativeVoiceTranscribeInput {
  filename: string;
  content_type: string;
  data_base64: string;
  language?: string;
  duration_ms?: number;
  chunk_count?: number;
}

export interface NativeVoiceTranscribePayload {
  text: string;
  diagnostics: Record<string, unknown>;
}

export interface NativeTimelinePayload {
  items: NativeTimelineItem[];
  has_more: boolean;
  next_after_seq?: number;
  next_after_cursor?: string;
}

export interface NativeSessionSyncPayload {
  session: NativeSessionSummary;
  items: NativeTimelineItem[];
  jobs: NativeJob[];
  next_after_seq?: number;
  next_after_cursor?: string;
  has_more: boolean;
}

export type NativeWorkspacePreviewCapability =
  | 'directory'
  | 'text'
  | 'markdown'
  | 'image'
  | 'audio'
  | 'video'
  | 'download';

export interface NativeWorkspaceFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  content_type?: string | null;
  extension?: string | null;
  preview_capability?: NativeWorkspacePreviewCapability;
  is_editable?: boolean;
  size_bytes?: number | null;
  modified_at?: string | null;
}

export interface NativeWorkspaceFileListResult {
  path: string;
  workspace_root?: string;
  entries: NativeWorkspaceFileEntry[];
  truncated?: boolean;
}

export interface NativeWorkspaceFileReadResult {
  path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  truncated: boolean;
  modified_at?: string | null;
  preview_kind?: 'text' | 'image' | 'audio' | 'video' | 'download';
  downloadable?: boolean;
  is_editable?: boolean;
  data_base64?: string;
  text?: string;
}

export interface NativeWorkspaceFileTransfer {
  transfer_id: string;
  worker_id: string;
  workspace_root: string;
  path: string;
  direction: 'download' | 'upload';
  status: 'queued' | 'uploading' | 'awaiting_upload' | 'ready' | 'failed' | 'expired';
  filename: string;
  content_type: string;
  size_bytes: number | null;
  sha256: string;
  expires_at: string;
  content_url: string;
}

export interface NativeWorkspaceFileDownloadTicket {
  download_url: string;
  expires_at: number;
}

export interface NativeWorkspaceTargetInput {
  worker_id: string;
  workspace_root: string;
}

export interface NativeTimelinePageOptions {
  beforeCreatedAt?: string;
  beforeSeq?: number;
  limit?: number;
}

export type NativeTaskStatus =
  | 'draft'
  | 'queued'
  | 'working'
  | 'blocked'
  | 'needs_approval'
  | 'ready_to_review'
  | 'accepted'
  | 'rejected'
  | 'archived'
  | 'cancelled'
  | 'failed';

export interface NativeTaskSummary {
  task_id: string;
  title: string;
  brief_markdown: string;
  success_criteria_markdown: string;
  status: NativeTaskStatus;
  priority: number;
  target_worker_id: string | null;
  backend: string | null;
  workspace_root: string | null;
  latest_session_id?: string | null;
  artifact_count: number;
  created_at: string;
  updated_at: string;
}

export interface NativeTaskArtifact {
  artifact_id: string;
  kind: string;
  title: string;
  path: string | null;
  content_markdown: string | null;
  created_at: string;
}

export interface NativeTaskExecution {
  execution_id: string;
  attempt_number: number;
  kind: string;
  status: string;
  updated_at: string;
}

export interface NativeTaskDetail {
  task: NativeTaskSummary;
  artifacts: NativeTaskArtifact[];
  executions: NativeTaskExecution[];
}

export type NativeTaskTemplateKey =
  | 'fix_bug'
  | 'implement_feature'
  | 'code_review'
  | 'release_assistant';

export type NativeTaskAuthorityPreset = 'read_only' | 'code_fix' | 'feature' | 'review_only';

export type NativeTaskReviewAction =
  | 'accept'
  | 'reject'
  | 'archive'
  | 'restore'
  | 'request_changes';

export interface NativeTaskCreateInput {
  title: string;
  brief_markdown: string;
  success_criteria_markdown: string;
  target_worker_id: string | null;
  backend: string | null;
  workspace_root: string | null;
  namespace: string;
  priority: number;
  template_key: NativeTaskTemplateKey;
  authority_preset: NativeTaskAuthorityPreset;
  relevant_paths: string[];
  submit: boolean;
}

export interface NativeTaskReviewInput {
  action: NativeTaskReviewAction;
  note_markdown: string;
}

export interface NativeTaskMutationPayload {
  task: NativeTaskSummary;
  job?: NativeJob;
}

export type NativeWorkerStatus = 'registered' | 'online' | 'degraded' | 'offline';

export interface NativeWorkerSummary {
  worker_id: string;
  machine_name: string;
  os: string;
  connection_mode?: string;
  transport_state?: string;
  worker_version?: string | null;
  reachable_backends: string[];
  workspace_roots?: string[];
  capabilities: Record<string, unknown>;
  status: NativeWorkerStatus;
  last_heartbeat_at: string | null;
  runtime_settings?: NativeWorkerRuntimeDefaults;
}

export interface NativeUserPreferences {
  locale: 'zh-CN' | 'zh-TW' | 'en-US';
  theme_mode: 'dark' | 'light';
  voice_mode: 'streaming' | 'standard';
  voice_language: string;
  quick_replies: string[];
}

export interface NativeWorkerRuntimeDefaults {
  max_concurrent_jobs: number;
  job_poll_interval_seconds: number;
  heartbeat_interval_seconds: number;
}

export interface NativeSettings {
  preferences: NativeUserPreferences;
  worker_runtime_defaults: NativeWorkerRuntimeDefaults;
  options: Record<string, unknown>;
  limits: Record<string, unknown>;
}

export interface NativeProviderSnapshot {
  worker_id: string;
  backend: string;
  status: 'ready' | 'loading' | 'unavailable' | 'error' | string;
  auth_status: 'ready' | 'auth_required' | 'handoff_required' | 'unknown' | string;
  models: Array<Record<string, unknown>>;
  modes: Array<Record<string, unknown>>;
  features: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  fetched_at: string;
  updated_at: string;
}

export interface NativeReleaseMetadata {
  version: string | null;
  publishedAt: string | null;
  releaseUrl: string;
  downloadUrl: string;
  source: 'github' | 'fallback';
}

export const NATIVE_ANDROID_APK_URL =
  'https://github.com/holdonyb/AgentHub-OSS/releases/latest/download/agenthub-native-android-release.apk';
export const AGENTHUB_LATEST_RELEASE_URL =
  'https://github.com/holdonyb/AgentHub-OSS/releases/latest';
const AGENTHUB_GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/holdonyb/AgentHub-OSS/releases/latest';

interface GitHubReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function releaseFallback(): NativeReleaseMetadata {
  return {
    version: null,
    publishedAt: null,
    releaseUrl: AGENTHUB_LATEST_RELEASE_URL,
    downloadUrl: NATIVE_ANDROID_APK_URL,
    source: 'fallback',
  };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function getLatestReleaseMetadata(fetcher?: FetchLike): Promise<NativeReleaseMetadata> {
  const request: FetchLike = fetcher ?? ((input, init) => globalThis.fetch(input, init));
  try {
    const response = await request(AGENTHUB_GITHUB_LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return releaseFallback();
    const payload = await response.json() as GitHubReleasePayload;
    const assets = Array.isArray(payload.assets) ? payload.assets as GitHubReleaseAsset[] : [];
    const nativeApk = assets.find((asset) => asset.name === 'agenthub-native-android-release.apk');
    const downloadUrl = asNonEmptyString(nativeApk?.browser_download_url);
    if (!downloadUrl) return releaseFallback();
    return {
      version: asNonEmptyString(payload.tag_name),
      publishedAt: asNonEmptyString(payload.published_at),
      releaseUrl: asNonEmptyString(payload.html_url) ?? AGENTHUB_LATEST_RELEASE_URL,
      downloadUrl,
      source: 'github',
    };
  } catch {
    return releaseFallback();
  }
}

export interface NativePushDeviceInput {
  device_id: string;
  platform: 'android' | 'ios';
  transport: 'expo';
  push_token: string;
  app_version: string;
}

export interface NativePushDevice {
  device_id: string;
  platform: 'android' | 'ios';
  transport: 'expo';
  app_version: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface NativeListPayload<T> {
  items: T[];
}

export interface MobileApi {
  login(email: string, password: string): Promise<NativeAuthPayload>;
  me(): Promise<NativeAuthPayload>;
  logout(csrfToken: string, deviceId?: string): Promise<{ ok: boolean }>;
  listSessions(input?: { archived?: boolean }): Promise<NativeListPayload<NativeSessionSummary>>;
  startSession(payload: NativeSessionStartInput, csrfToken: string): Promise<{ job: NativeJob }>;
  getSession(sessionId: string): Promise<{ session: NativeSessionSummary }>;
  getSessionTimeline(
    sessionId: string,
    options?: NativeTimelinePageOptions,
  ): Promise<NativeTimelinePayload>;
  getSessionSync(sessionId: string): Promise<NativeSessionSyncPayload>;
  listPermissions(
    sessionId?: string,
    status?: NativePermission['status'],
  ): Promise<NativeListPayload<NativePermission>>;
  listJobs(): Promise<NativeListPayload<NativeJob>>;
  getJob(jobId: string): Promise<{ job: NativeJob }>;
  listNotifications(): Promise<NativeListPayload<NativeNotificationRecord>>;
  markNotificationDelivered(
    notificationId: string,
    csrfToken: string,
  ): Promise<NativeNotificationTransitionPayload>;
  markNotificationRead(
    notificationId: string,
    csrfToken: string,
  ): Promise<NativeNotificationTransitionPayload>;
  markAllNotificationsRead(csrfToken: string): Promise<{ updated: number }>;
  dismissNotification(
    notificationId: string,
    csrfToken: string,
  ): Promise<NativeNotificationTransitionPayload>;
  upsertPushDevice(
    payload: NativePushDeviceInput,
    csrfToken: string,
  ): Promise<{ device: NativePushDevice }>;
  revokePushDevice(deviceId: string, csrfToken: string): Promise<{ revoked: boolean }>;
  sendSessionInput(
    sessionId: string,
    payload: {
      prompt: string;
      reply_mode?: 'direct' | 'plan';
      attachments?: NativeSessionAttachmentInput[];
    },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  transcribeVoice(
    payload: NativeVoiceTranscribeInput,
    csrfToken: string,
  ): Promise<NativeVoiceTranscribePayload>;
  respondPermission(
    permissionId: string,
    action: NativePermissionAction,
    response: Record<string, unknown>,
    csrfToken: string,
  ): Promise<{ permission: NativePermission }>;
  terminateSession(
    sessionId: string,
    csrfToken: string,
  ): Promise<{ session: NativeSessionSummary }>;
  forkSession(
    sessionId: string,
    payload: NativeSessionForkInput,
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  askSessionBtw(
    sessionId: string,
    payload: NativeSessionBtwInput,
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  renameSession(
    sessionId: string,
    title: string,
    csrfToken: string,
  ): Promise<{ session: NativeSessionSummary }>;
  updateSessionControls(
    sessionId: string,
    controls: NativeSessionControls,
    csrfToken: string,
  ): Promise<{ session: NativeSessionSummary }>;
  archiveSession(sessionId: string, csrfToken: string): Promise<{ session: NativeSessionSummary }>;
  unarchiveSession(sessionId: string, csrfToken: string): Promise<{ session: NativeSessionSummary }>;
  listSessionFiles(
    sessionId: string,
    payload: { path: string },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  searchSessionFiles(
    sessionId: string,
    payload: { path: string; query: string; max_results?: number; include_hidden?: boolean },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  createWorkspaceFileTransfer(
    payload: { worker_id: string; workspace_root: string; path: string; reveal_sensitive?: boolean },
    csrfToken: string,
  ): Promise<{ transfer: NativeWorkspaceFileTransfer; job: NativeJob }>;
  getWorkspaceFileTransfer(transferId: string): Promise<{ transfer: NativeWorkspaceFileTransfer }>;
  createWorkspaceFileDownloadTicket(
    transferId: string,
    csrfToken: string,
  ): Promise<NativeWorkspaceFileDownloadTicket>;
  readSessionFile(
    sessionId: string,
    payload: { path: string; max_bytes?: number },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  writeSessionFile(
    sessionId: string,
    payload: { path: string; text: string; expected_modified_at?: string | null },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  uploadSessionFile(
    sessionId: string,
    payload: {
      path: string;
      filename: string;
      content_type: string;
      data_base64: string;
      overwrite: boolean;
    },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  createSessionFile(
    sessionId: string,
    payload: { path: string; text: string; overwrite: boolean },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  mkdirSessionDirectory(
    sessionId: string,
    payload: { path: string },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  renameSessionFile(
    sessionId: string,
    payload: { path: string; new_path: string; expected_modified_at?: string | null },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  listWorkspaceFiles(
    payload: NativeWorkspaceTargetInput & { path: string },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  searchWorkspaceFiles(
    payload: NativeWorkspaceTargetInput & { path: string; query: string; max_results: number; include_hidden: boolean },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  readWorkspaceFile(
    payload: NativeWorkspaceTargetInput & { path: string; max_bytes: number; reveal_sensitive?: boolean },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  writeWorkspaceFile(
    payload: NativeWorkspaceTargetInput & { path: string; text: string; expected_modified_at?: string | null },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  uploadWorkspaceFile(
    payload: NativeWorkspaceTargetInput & { path: string; filename: string; content_type: string; data_base64: string; overwrite: boolean },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  createWorkspaceFile(
    payload: NativeWorkspaceTargetInput & { path: string; text: string; overwrite: boolean },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  mkdirWorkspaceDirectory(
    payload: NativeWorkspaceTargetInput & { path: string },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  renameWorkspaceFile(
    payload: NativeWorkspaceTargetInput & { path: string; new_path: string; expected_modified_at?: string | null },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
  listTasks(status?: NativeTaskStatus, archived?: boolean): Promise<NativeListPayload<NativeTaskSummary>>;
  getTask(taskId: string): Promise<NativeTaskDetail>;
  createTask(
    payload: NativeTaskCreateInput,
    csrfToken: string,
  ): Promise<NativeTaskMutationPayload>;
  reviewTask(
    taskId: string,
    payload: NativeTaskReviewInput,
    csrfToken: string,
  ): Promise<NativeTaskMutationPayload>;
  listWorkers(): Promise<NativeListPayload<NativeWorkerSummary>>;
  listProviderSnapshots(): Promise<NativeListPayload<NativeProviderSnapshot>>;
  loginProvider(workerId: string, backend: string, csrfToken: string): Promise<{ job: NativeJob }>;
  logoutProvider(workerId: string, backend: string, csrfToken: string): Promise<{ job: NativeJob }>;
  getSettings(): Promise<NativeSettings>;
  patchPreferences(
    payload: Partial<NativeUserPreferences>,
    csrfToken: string,
  ): Promise<{ preferences: NativeUserPreferences }>;
  getLatestRelease(): Promise<NativeReleaseMetadata>;
}

export function createMobileApi(baseUrl: string, fetcher?: FetchLike): MobileApi {
  const client = createAgentHubClient({ baseUrl, fetcher });
  const sessionPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;
  const absoluteServerUrl = (path: string) => new URL(path, `${new URL(baseUrl).origin}/`).toString();
  return {
    login: (email, password) =>
      client.post<NativeAuthPayload>('/api/auth/login', { email, password }),
    me: () => client.get<NativeAuthPayload>('/api/auth/me'),
    logout: (csrfToken, deviceId) =>
      client.post<{ ok: boolean }>(
        '/api/auth/logout',
        deviceId ? { device_id: deviceId } : {},
        { csrfToken },
      ),
    listSessions: (input) =>
      client.get<NativeListPayload<NativeSessionSummary>>(input?.archived ? '/api/sessions?archived=true' : '/api/sessions'),
    startSession: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/sessions/start', payload, { csrfToken }),
    getSession: (sessionId) =>
      client.get<{ session: NativeSessionSummary }>(sessionPath(sessionId)),
    getSessionTimeline: (sessionId, options = {}) => {
      const query = [
        `limit=${encodeURIComponent(String(options.limit ?? 100))}`,
        ...(options.beforeCreatedAt
          ? [`before_created_at=${encodeURIComponent(options.beforeCreatedAt)}`]
          : []),
        ...(typeof options.beforeSeq === 'number'
          ? [`before_seq=${encodeURIComponent(String(options.beforeSeq))}`]
          : []),
      ].join('&');
      return client.get<NativeTimelinePayload>(`${sessionPath(sessionId)}/timeline?${query}`);
    },
    getSessionSync: (sessionId) =>
      client.get<NativeSessionSyncPayload>(
        `/api/sync/session/${encodeURIComponent(sessionId)}?limit=200`,
      ),
    listPermissions: (sessionId, status = 'pending') =>
      client.get<NativeListPayload<NativePermission>>(
        `/api/permissions?status=${encodeURIComponent(status)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''}`,
      ),
    listJobs: () => client.get<NativeListPayload<NativeJob>>('/api/jobs?limit=200'),
    getJob: (jobId) => client.get<{ job: NativeJob }>(`/api/jobs/${encodeURIComponent(jobId)}`),
    listNotifications: () =>
      client.get<NativeListPayload<NativeNotificationRecord>>('/api/notifications?limit=200'),
    markNotificationDelivered: (notificationId, csrfToken) =>
      client.post<NativeNotificationTransitionPayload>(
        `/api/notifications/${encodeURIComponent(notificationId)}/delivered`,
        {},
        { csrfToken },
      ),
    markNotificationRead: (notificationId, csrfToken) =>
      client.post<NativeNotificationTransitionPayload>(
        `/api/notifications/${encodeURIComponent(notificationId)}/read`,
        {},
        { csrfToken },
      ),
    markAllNotificationsRead: (csrfToken) =>
      client.post<{ updated: number }>('/api/notifications/read-all', {}, { csrfToken }),
    dismissNotification: (notificationId, csrfToken) =>
      client.post<NativeNotificationTransitionPayload>(
        `/api/notifications/${encodeURIComponent(notificationId)}/dismiss`,
        {},
        { csrfToken },
      ),
    upsertPushDevice: (payload, csrfToken) =>
      client.post<{ device: NativePushDevice }>('/api/push/devices', payload, { csrfToken }),
    revokePushDevice: (deviceId, csrfToken) =>
      client.delete<{ revoked: boolean }>(
        `/api/push/devices/${encodeURIComponent(deviceId)}`,
        { csrfToken },
      ),
    sendSessionInput: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/input`, payload, { csrfToken }),
    transcribeVoice: (payload, csrfToken) =>
      client.post<NativeVoiceTranscribePayload>('/api/voice/transcribe', payload, { csrfToken }),
    respondPermission: (permissionId, action, response, csrfToken) =>
      client.post<{ permission: NativePermission }>(
        `/api/permissions/${encodeURIComponent(permissionId)}/respond`,
        { action, response },
        { csrfToken },
      ),
    terminateSession: (sessionId, csrfToken) =>
      client.post<{ session: NativeSessionSummary }>(
        `${sessionPath(sessionId)}/terminate`,
        {},
        { csrfToken },
      ),
    forkSession: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/fork`, payload, { csrfToken }),
    askSessionBtw: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/btw`, payload, { csrfToken }),
    renameSession: (sessionId, title, csrfToken) =>
      client.post<{ session: NativeSessionSummary }>(
        `${sessionPath(sessionId)}/rename`,
        { custom_title: title },
        { csrfToken },
      ),
    updateSessionControls: (sessionId, controls, csrfToken) =>
      client.patch<{ session: NativeSessionSummary }>(
        `${sessionPath(sessionId)}/controls`,
        controls,
        { csrfToken },
      ),
    archiveSession: (sessionId, csrfToken) =>
      client.post<{ session: NativeSessionSummary }>(`${sessionPath(sessionId)}/archive`, {}, { csrfToken }),
    unarchiveSession: (sessionId, csrfToken) =>
      client.post<{ session: NativeSessionSummary }>(`${sessionPath(sessionId)}/unarchive`, {}, { csrfToken }),
    listSessionFiles: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/list`, payload, { csrfToken }),
    searchSessionFiles: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/search`, payload, { csrfToken }),
    createWorkspaceFileTransfer: (payload, csrfToken) =>
      client.post<{ transfer: NativeWorkspaceFileTransfer; job: NativeJob }>(
        '/api/workspaces/files/transfers',
        payload,
        { csrfToken },
      ),
    getWorkspaceFileTransfer: (transferId) =>
      client.get<{ transfer: NativeWorkspaceFileTransfer }>(
        `/api/workspaces/files/transfers/${encodeURIComponent(transferId)}`,
      ),
    createWorkspaceFileDownloadTicket: async (transferId, csrfToken) => {
      const ticket = await client.post<NativeWorkspaceFileDownloadTicket>(
        `/api/workspaces/files/transfers/${encodeURIComponent(transferId)}/download-ticket`,
        {},
        { csrfToken },
      );
      return { ...ticket, download_url: absoluteServerUrl(ticket.download_url) };
    },
    readSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/read`, payload, { csrfToken }),
    writeSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/write`, payload, { csrfToken }),
    uploadSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/upload`, payload, { csrfToken }),
    createSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/create`, payload, { csrfToken }),
    mkdirSessionDirectory: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/mkdir`, payload, { csrfToken }),
    renameSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/rename`, payload, { csrfToken }),
    listWorkspaceFiles: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/list', payload, { csrfToken }),
    searchWorkspaceFiles: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/search', payload, { csrfToken }),
    readWorkspaceFile: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/read', payload, { csrfToken }),
    writeWorkspaceFile: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/write', payload, { csrfToken }),
    uploadWorkspaceFile: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/upload', payload, { csrfToken }),
    createWorkspaceFile: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/create', payload, { csrfToken }),
    mkdirWorkspaceDirectory: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/mkdir', payload, { csrfToken }),
    renameWorkspaceFile: (payload, csrfToken) =>
      client.post<{ job: NativeJob }>('/api/workspaces/files/rename', payload, { csrfToken }),
    listTasks: (status, archived = false) => {
      const query = [
        ...(status ? [`status=${encodeURIComponent(status)}`] : []),
        ...(archived ? ['archived=true'] : []),
      ];
      return client.get<NativeListPayload<NativeTaskSummary>>(
        `/api/tasks${query.length > 0 ? `?${query.join('&')}` : ''}`,
      );
    },
    getTask: (taskId) =>
      client.get<NativeTaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`),
    createTask: (payload, csrfToken) =>
      client.post<NativeTaskMutationPayload>('/api/tasks', payload, { csrfToken }),
    reviewTask: (taskId, payload, csrfToken) =>
      client.post<NativeTaskMutationPayload>(
        `/api/tasks/${encodeURIComponent(taskId)}/review`,
        payload,
        { csrfToken },
      ),
    listWorkers: () => client.get<NativeListPayload<NativeWorkerSummary>>('/api/workers'),
    listProviderSnapshots: () => client.get<NativeListPayload<NativeProviderSnapshot>>('/api/providers'),
    loginProvider: (workerId, backend, csrfToken) =>
      client.post<{ job: NativeJob }>(
        `/api/providers/${encodeURIComponent(workerId)}/${encodeURIComponent(backend)}/login`,
        {},
        { csrfToken },
      ),
    logoutProvider: (workerId, backend, csrfToken) =>
      client.post<{ job: NativeJob }>(
        `/api/providers/${encodeURIComponent(workerId)}/${encodeURIComponent(backend)}/logout`,
        {},
        { csrfToken },
      ),
    getSettings: () => client.get<NativeSettings>('/api/settings'),
    patchPreferences: (payload, csrfToken) =>
      client.patch<{ preferences: NativeUserPreferences }>('/api/settings/preferences', payload, { csrfToken }),
    getLatestRelease: () => getLatestReleaseMetadata(fetcher),
  };
}
