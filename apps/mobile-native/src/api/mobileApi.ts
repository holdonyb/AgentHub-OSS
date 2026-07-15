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

export interface NativeSessionSummary {
  session_id: string;
  title: string;
  backend: string;
  worker_id: string;
  status: NativeSessionStatus;
  last_activity_at: string | null;
  project_name?: string;
  workspace_root?: string;
  namespace?: string;
  activity_summary?: string;
  last_message?: string;
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
  data_base64?: string;
  text?: string;
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
  reachable_backends: string[];
  capabilities: Record<string, unknown>;
  status: NativeWorkerStatus;
  last_heartbeat_at: string | null;
}

export interface NativeListPayload<T> {
  items: T[];
}

export interface MobileApi {
  login(email: string, password: string): Promise<NativeAuthPayload>;
  me(): Promise<NativeAuthPayload>;
  logout(csrfToken: string): Promise<{ ok: boolean }>;
  listSessions(): Promise<NativeListPayload<NativeSessionSummary>>;
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
  listNotifications(): Promise<NativeListPayload<NativeNotificationRecord>>;
  markNotificationDelivered(
    notificationId: string,
    csrfToken: string,
  ): Promise<NativeNotificationTransitionPayload>;
  markNotificationRead(
    notificationId: string,
    csrfToken: string,
  ): Promise<NativeNotificationTransitionPayload>;
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
  listSessionFiles(
    sessionId: string,
    payload: { path: string },
    csrfToken: string,
  ): Promise<{ job: NativeJob }>;
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
  listTasks(status?: NativeTaskStatus): Promise<NativeListPayload<NativeTaskSummary>>;
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
}

export function createMobileApi(baseUrl: string, fetcher?: FetchLike): MobileApi {
  const client = createAgentHubClient({ baseUrl, fetcher });
  const sessionPath = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;
  return {
    login: (email, password) =>
      client.post<NativeAuthPayload>('/api/auth/login', { email, password }),
    me: () => client.get<NativeAuthPayload>('/api/auth/me'),
    logout: (csrfToken) =>
      client.post<{ ok: boolean }>('/api/auth/logout', {}, { csrfToken }),
    listSessions: () => client.get<NativeListPayload<NativeSessionSummary>>('/api/sessions'),
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
    listSessionFiles: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/list`, payload, { csrfToken }),
    readSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/read`, payload, { csrfToken }),
    writeSessionFile: (sessionId, payload, csrfToken) =>
      client.post<{ job: NativeJob }>(`${sessionPath(sessionId)}/files/write`, payload, { csrfToken }),
    listTasks: (status) =>
      client.get<NativeListPayload<NativeTaskSummary>>(
        status ? `/api/tasks?status=${encodeURIComponent(status)}` : '/api/tasks',
      ),
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
  };
}
