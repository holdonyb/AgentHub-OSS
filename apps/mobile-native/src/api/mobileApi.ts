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
  listTasks(status?: NativeTaskStatus): Promise<NativeListPayload<NativeTaskSummary>>;
  getTask(taskId: string): Promise<NativeTaskDetail>;
  listWorkers(): Promise<NativeListPayload<NativeWorkerSummary>>;
}

export function createMobileApi(baseUrl: string, fetcher?: FetchLike): MobileApi {
  const client = createAgentHubClient({ baseUrl, fetcher });
  return {
    login: (email, password) =>
      client.post<NativeAuthPayload>('/api/auth/login', { email, password }),
    me: () => client.get<NativeAuthPayload>('/api/auth/me'),
    logout: (csrfToken) =>
      client.post<{ ok: boolean }>('/api/auth/logout', {}, { csrfToken }),
    listSessions: () => client.get<NativeListPayload<NativeSessionSummary>>('/api/sessions'),
    listTasks: (status) =>
      client.get<NativeListPayload<NativeTaskSummary>>(
        status ? `/api/tasks?status=${encodeURIComponent(status)}` : '/api/tasks',
      ),
    getTask: (taskId) =>
      client.get<NativeTaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`),
    listWorkers: () => client.get<NativeListPayload<NativeWorkerSummary>>('/api/workers'),
  };
}
