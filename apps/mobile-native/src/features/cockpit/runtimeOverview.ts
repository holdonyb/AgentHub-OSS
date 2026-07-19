import type {
  NativePermission,
  NativeSessionSummary,
  NativeTaskSummary,
  NativeWorkerSummary,
} from '../../api/mobileApi';
import { parseApiDate } from '../../screens/resourcePresentation';

export type RuntimeOverviewLane = 'attention' | 'working' | 'done' | 'idle' | 'offline';

export interface RuntimeOverviewItem {
  session: NativeSessionSummary;
  lane: RuntimeOverviewLane;
  reason: string;
  workerName: string;
  taskId: string | null;
  stateUpdatedAt: string | null;
}

export interface RuntimeOverviewProjection {
  items: RuntimeOverviewItem[];
  counts: Record<RuntimeOverviewLane, number>;
}

const laneOrder: Record<RuntimeOverviewLane, number> = {
  attention: 0,
  working: 1,
  done: 2,
  idle: 3,
  offline: 4,
};

function timestamp(value: string | null | undefined): number {
  return parseApiDate(value)?.getTime() ?? 0;
}

export function projectRuntimeOverview(
  sessions: NativeSessionSummary[],
  workers: NativeWorkerSummary[],
  permissions: NativePermission[],
  tasks: NativeTaskSummary[],
): RuntimeOverviewProjection {
  const workersById = new Map(workers.map((worker) => [worker.worker_id, worker]));
  const taskBySession = new Map(
    tasks
      .filter((task) => task.latest_session_id)
      .map((task) => [task.latest_session_id as string, task.task_id]),
  );
  const permissionBySession = new Map<string, NativePermission>();
  for (const permission of permissions) {
    if (permission.status !== 'pending') continue;
    const current = permissionBySession.get(permission.session_id);
    if (!current || timestamp(permission.created_at) > timestamp(current.created_at)) {
      permissionBySession.set(permission.session_id, permission);
    }
  }

  const items = sessions
    .filter((session) => !session.archived_at)
    .map((session): RuntimeOverviewItem => {
      const worker = workersById.get(session.worker_id);
      const permission = permissionBySession.get(session.session_id);
      const stateUpdatedAt = session.execution_status_observed_at
        ?? session.last_activity_at
        ?? session.updated_at
        ?? null;
      const base = {
        session,
        workerName: worker?.machine_name || session.worker_id,
        taskId: taskBySession.get(session.session_id) ?? null,
        stateUpdatedAt,
      };
      if (permission) {
        return {
          ...base,
          lane: 'attention',
          reason: permission.kind === 'question' ? '等待你选择' : '等待你审批',
          stateUpdatedAt: permission.created_at,
        };
      }
      if (session.status === 'needs_reply' || session.execution_status === 'waiting_input') {
        return { ...base, lane: 'attention', reason: '等待你回复' };
      }
      if (session.attention_status === 'unseen' && session.attention_reason !== 'completion') {
        return {
          ...base,
          lane: 'attention',
          reason: session.attention_reason === 'failure' ? '失败，等待查看' : '有新进展',
        };
      }
      if (!worker || worker.status === 'offline') {
        return { ...base, lane: 'offline', reason: worker ? '节点已离线' : '节点不可用' };
      }
      if (session.status === 'queued' || session.execution_status === 'queued') {
        return { ...base, lane: 'working', reason: '已进入队列' };
      }
      if (session.status === 'running' || session.execution_status === 'running') {
        return { ...base, lane: 'working', reason: '正在执行' };
      }
      if (session.attention_status === 'unseen' && session.attention_reason === 'completion') {
        return { ...base, lane: 'done', reason: '已完成，等待查看' };
      }
      if (session.status === 'failed' || session.execution_status === 'failed') {
        return { ...base, lane: 'done', reason: '执行失败' };
      }
      return {
        ...base,
        lane: 'idle',
        reason: session.status === 'terminated' ? '会话已结束' : '等待任务',
      };
    })
    .sort((left, right) => {
      const laneDifference = laneOrder[left.lane] - laneOrder[right.lane];
      if (laneDifference !== 0) return laneDifference;
      const activityDifference = timestamp(right.stateUpdatedAt) - timestamp(left.stateUpdatedAt);
      if (activityDifference !== 0) return activityDifference;
      return left.session.session_id.localeCompare(right.session.session_id);
    });

  const counts: RuntimeOverviewProjection['counts'] = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0,
    offline: 0,
  };
  for (const item of items) counts[item.lane] += 1;
  return { items, counts };
}
