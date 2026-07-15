export type Role = 'owner' | 'admin' | 'operator' | 'viewer';
export type ConnectionMode = 'private' | 'public_relay';

export type JobKind =
  | 'session_input'
  | 'session_start'
  | 'session_fork'
  | 'session_btw'
  | 'session_discovery'
  | 'observer'
  | 'reflector'
  | 'memory_extract'
  | 'health_check'
  | 'provider_login'
  | 'provider_logout'
  | 'file_list'
  | 'file_read'
  | 'file_write'
  | 'file_upload'
  | 'file_create'
  | 'file_mkdir'
  | 'file_rename';

export interface User {
  id?: string;
  email: string;
  role: Role;
}

export interface Worker {
  space_id?: string | null;
  worker_id: string;
  machine_name: string;
  os: string;
  connection_mode?: ConnectionMode;
  transport_state?: string;
  worker_version?: string | null;
  reachable_backends: string[];
  workspace_roots: string[];
  capabilities: Record<string, unknown>;
  status: 'registered' | 'online' | 'degraded' | 'offline';
  last_heartbeat_at: string | null;
  runtime_settings: WorkerRuntimeSettings;
}

export interface WorkerRuntimeSettings {
  max_concurrent_jobs: number;
  job_poll_interval_seconds: number;
  heartbeat_interval_seconds: number;
}

export interface AgentSession {
  session_id: string;
  backend: string;
  worker_id: string;
  workspace_root: string;
  project_name: string;
  namespace: string;
  mode: string;
  runtime_session_ref: string;
  status: 'ready' | 'queued' | 'running' | 'needs_reply' | 'failed' | 'terminated';
  execution_status?: 'unknown' | 'idle' | 'queued' | 'running' | 'waiting_input' | 'failed' | 'terminated';
  execution_status_source?: string;
  execution_status_seq?: number;
  execution_status_observed_at?: string | null;
  attention_status?: 'none' | 'unseen' | 'seen';
  attention_reason?: '' | 'completion' | 'approval' | 'failure';
  attention_revision?: number;
  attention_changed_at?: string | null;
  title: string;
  display_title: string;
  custom_title: string | null;
  heuristic_title: string;
  llm_title: string | null;
  activity_summary: string;
  last_message: string;
  last_activity_at: string | null;
  last_role: string;
  controls: Record<string, unknown>;
  runtime_metadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  archived_at: string | null;
  updated_at?: string;
}

export interface AgentTimelineItem {
  session_id: string;
  seq: number;
  item_type: 'user_message' | 'assistant_message' | 'reasoning' | 'tool_call' | 'todo' | 'goal' | 'error' | 'compaction';
  role: 'user' | 'assistant' | 'system' | 'tool' | null;
  text: string;
  tool_call_id: string | null;
  tool_name: string | null;
  status: 'started' | 'running' | 'completed' | 'failed' | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export interface AgentPermission {
  permission_id: string;
  session_id: string;
  worker_id: string;
  backend: string;
  kind: 'tool' | 'tool_approval' | 'command_approval' | 'plan' | 'plan_exit' | 'question' | 'mode' | 'other';
  title: string;
  description: string;
  detail: Record<string, unknown>;
  actions: Record<string, unknown>;
  status: 'pending' | 'allowed' | 'denied' | 'answered' | 'expired';
  response: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
}

export interface NotificationRecord {
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

export interface ProviderSnapshot {
  worker_id: string;
  backend: string;
  status: 'ready' | 'loading' | 'unavailable' | 'error';
  auth_status: 'ready' | 'auth_required' | 'handoff_required' | 'unknown';
  models: Array<{ id: string; label?: string } & Record<string, unknown>>;
  modes: Array<{ id: string; label?: string; kind?: string } & Record<string, unknown>>;
  features: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  fetched_at: string;
  updated_at: string;
}

export interface Schedule {
  schedule_id: string;
  name: string;
  job_kind: JobKind;
  enabled: boolean;
  interval_seconds: number;
  target_worker_id: string | null;
  backend: string | null;
  namespace: string;
  payload: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  job_id: string;
  kind: JobKind;
  target_session_id: string | null;
  worker_id: string | null;
  backend: string | null;
  workspace_root: string | null;
  namespace: string;
  priority: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  queue_reason?: string | null;
  queue_reason_text?: string | null;
  payload: Record<string, unknown>;
  result_text: string | null;
  error_text: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Event {
  event_id: string;
  actor_type: string;
  actor_id: string;
  source_type: string;
  source_id: string;
  event_type: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  payload: Record<string, unknown>;
  created_at: string;
}

export type TaskStatus =
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

export type ArtifactKind =
  | 'report'
  | 'diff'
  | 'test_result'
  | 'screenshot'
  | 'log'
  | 'document'
  | 'patch'
  | 'build_output'
  | 'review_note';

export type TaskTemplateKey = 'fix_bug' | 'implement_feature' | 'code_review' | 'release_assistant';
export type TaskAuthorityPreset = 'read_only' | 'code_fix' | 'feature' | 'review_only';

export interface TaskAuthorityBoundary {
  read_paths: string[];
  write_paths: string[];
  runtime_controls: Record<string, unknown>;
  enforcement: {
    runtime_controls: 'mapped';
    command_level: 'declared_only';
  };
}

export interface TaskWorkspaceConfig {
  schema_version: 1;
  task_id: string;
  relative_path: string;
  title: string;
  brief_markdown: string;
  success_criteria_markdown: string;
  template_key: TaskTemplateKey;
  authority_preset: TaskAuthorityPreset;
  relevant_paths: string[];
  attempt_number: number;
  review_note: string;
  authority: TaskAuthorityBoundary;
}

export interface AgentTask {
  task_id: string;
  space_id: string | null;
  title: string;
  brief_markdown: string;
  success_criteria_markdown: string;
  status: TaskStatus;
  priority: number;
  target_worker_id: string | null;
  backend: string | null;
  workspace_root: string | null;
  namespace: string;
  latest_job_id: string | null;
  latest_session_id: string | null;
  artifact_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  archived_at: string | null;
  metadata: Record<string, unknown>;
}

export interface AgentTaskExecution {
  execution_id: string;
  task_id: string;
  job_id: string | null;
  session_id: string | null;
  attempt_number: number;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentArtifact {
  artifact_id: string;
  task_id: string;
  kind: ArtifactKind;
  title: string;
  path: string | null;
  content_markdown: string | null;
  mime_type: string | null;
  created_by: 'agent' | 'human' | 'system';
  created_at: string;
  version: number;
}
