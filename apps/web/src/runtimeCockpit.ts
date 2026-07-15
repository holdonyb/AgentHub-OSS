import type { AgentPermission, AgentSession, AgentTask, Worker } from '@agenthub/protocol';

export type RuntimeCockpitLane = 'attention' | 'working' | 'done' | 'idle' | 'offline';

export type RuntimeCockpitReason =
  | 'pending_permission'
  | 'needs_reply'
  | 'unseen_failure'
  | 'unseen_attention'
  | 'worker_missing'
  | 'worker_offline'
  | 'execution_queued'
  | 'execution_running'
  | 'unseen_completion'
  | 'session_failed'
  | 'session_terminated'
  | 'session_idle';

export interface RuntimeCockpitItem {
  sessionId: string;
  backend: string;
  workerId: string;
  workerName: string;
  projectName: string;
  workspaceRoot: string;
  title: string;
  summary: string;
  lane: RuntimeCockpitLane;
  reason: RuntimeCockpitReason;
  stateUpdatedAt: string | null;
  lastActivityAt: string | null;
  permissionId: string | null;
  taskId: string | null;
}

export interface RuntimeCockpitProjection {
  items: RuntimeCockpitItem[];
  counts: Record<RuntimeCockpitLane, number>;
}

const laneOrder: Record<RuntimeCockpitLane, number> = {
  attention: 0,
  working: 1,
  done: 2,
  idle: 3,
  offline: 4,
};

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metadataString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sessionTaskId(session: AgentSession): string | null {
  return metadataString(session.runtime_metadata, 'task_id') ?? metadataString(session.metadata, 'task_id');
}

function projectSession(
  session: AgentSession,
  worker: Worker | undefined,
  pendingPermission: AgentPermission | undefined,
  linkedTaskId: string | null,
): RuntimeCockpitItem {
  const lastActivityAt = session.last_activity_at ?? session.updated_at ?? null;
  const base = {
    sessionId: session.session_id,
    backend: session.backend,
    workerId: session.worker_id,
    workerName: worker?.machine_name || session.worker_id,
    projectName: session.project_name || session.namespace || 'default',
    workspaceRoot: session.workspace_root,
    title: session.display_title || session.title || session.heuristic_title || session.session_id,
    summary: session.activity_summary || session.last_message || '',
    lastActivityAt,
    permissionId: pendingPermission?.permission_id ?? null,
    taskId: sessionTaskId(session) ?? linkedTaskId,
  };

  if (pendingPermission) {
    return {
      ...base,
      lane: 'attention',
      reason: 'pending_permission',
      stateUpdatedAt: pendingPermission.created_at,
    };
  }
  if (session.status === 'needs_reply' || session.execution_status === 'waiting_input') {
    return {
      ...base,
      lane: 'attention',
      reason: 'needs_reply',
      stateUpdatedAt: session.attention_changed_at ?? session.execution_status_observed_at ?? lastActivityAt,
    };
  }
  if (session.attention_status === 'unseen' && session.attention_reason !== 'completion') {
    return {
      ...base,
      lane: 'attention',
      reason: session.attention_reason === 'failure' ? 'unseen_failure' : 'unseen_attention',
      stateUpdatedAt: session.attention_changed_at ?? lastActivityAt,
    };
  }
  if (!worker) {
    return { ...base, lane: 'offline', reason: 'worker_missing', stateUpdatedAt: lastActivityAt };
  }
  if (worker.status === 'offline') {
    return {
      ...base,
      lane: 'offline',
      reason: 'worker_offline',
      stateUpdatedAt: worker.last_heartbeat_at ?? lastActivityAt,
    };
  }
  if (session.execution_status === 'queued' || session.status === 'queued') {
    return {
      ...base,
      lane: 'working',
      reason: 'execution_queued',
      stateUpdatedAt: session.execution_status_observed_at ?? lastActivityAt,
    };
  }
  if (session.execution_status === 'running' || session.status === 'running') {
    return {
      ...base,
      lane: 'working',
      reason: 'execution_running',
      stateUpdatedAt: session.execution_status_observed_at ?? lastActivityAt,
    };
  }
  if (session.attention_status === 'unseen' && session.attention_reason === 'completion') {
    return {
      ...base,
      lane: 'done',
      reason: 'unseen_completion',
      stateUpdatedAt: session.attention_changed_at ?? lastActivityAt,
    };
  }
  if (session.status === 'failed' || session.execution_status === 'failed') {
    return {
      ...base,
      lane: 'done',
      reason: 'session_failed',
      stateUpdatedAt: session.execution_status_observed_at ?? lastActivityAt,
    };
  }
  if (session.status === 'terminated' || session.execution_status === 'terminated') {
    return {
      ...base,
      lane: 'idle',
      reason: 'session_terminated',
      stateUpdatedAt: session.execution_status_observed_at ?? lastActivityAt,
    };
  }
  return { ...base, lane: 'idle', reason: 'session_idle', stateUpdatedAt: lastActivityAt };
}

export function projectRuntimeCockpit(
  sessions: AgentSession[],
  workers: Worker[],
  permissions: AgentPermission[],
  tasks: AgentTask[] = [],
): RuntimeCockpitProjection {
  const workersById = new Map(workers.map((worker) => [worker.worker_id, worker]));
  const taskBySession = new Map(
    tasks
      .filter((task) => task.latest_session_id)
      .map((task) => [task.latest_session_id as string, task.task_id]),
  );
  const permissionBySession = new Map<string, AgentPermission>();
  for (const permission of permissions) {
    if (permission.status !== 'pending') continue;
    const current = permissionBySession.get(permission.session_id);
    if (!current || timestamp(permission.created_at) > timestamp(current.created_at)) {
      permissionBySession.set(permission.session_id, permission);
    }
  }

  const items = sessions
    .filter((session) => !session.archived_at)
    .map((session) =>
      projectSession(
        session,
        workersById.get(session.worker_id),
        permissionBySession.get(session.session_id),
        taskBySession.get(session.session_id) ?? null,
      ),
    )
    .sort((left, right) => {
      const laneDifference = laneOrder[left.lane] - laneOrder[right.lane];
      if (laneDifference !== 0) return laneDifference;
      const activityDifference = timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt);
      if (activityDifference !== 0) return activityDifference;
      return left.sessionId.localeCompare(right.sessionId);
    });

  const counts: Record<RuntimeCockpitLane, number> = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0,
    offline: 0,
  };
  for (const item of items) counts[item.lane] += 1;

  return { items, counts };
}
