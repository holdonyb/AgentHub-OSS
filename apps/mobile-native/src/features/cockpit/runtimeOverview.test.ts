import type {
  NativePermission,
  NativeSessionSummary,
  NativeTaskSummary,
  NativeWorkerSummary,
} from '../../api/mobileApi';
import { projectRuntimeOverview } from './runtimeOverview';

const baseSession: NativeSessionSummary = {
  session_id: 'session-idle',
  title: '空闲会话',
  backend: 'codex',
  worker_id: 'worker-online',
  status: 'ready',
  last_activity_at: '2026-07-19T08:00:00Z',
};

const workers: NativeWorkerSummary[] = [
  {
    worker_id: 'worker-online',
    machine_name: '开发机',
    os: 'windows',
    status: 'online',
    reachable_backends: ['codex'],
    workspace_roots: ['E:/Work'],
    capabilities: {},
    last_heartbeat_at: '2026-07-19T08:01:00Z',
  },
  {
    worker_id: 'worker-offline',
    machine_name: '离线节点',
    os: 'linux',
    status: 'offline',
    reachable_backends: ['claude'],
    workspace_roots: ['/srv/work'],
    capabilities: {},
    last_heartbeat_at: '2026-07-18T08:01:00Z',
  },
];

it('projects attention, working, done, idle and offline lanes in priority order', () => {
  const sessions: NativeSessionSummary[] = [
    baseSession,
    { ...baseSession, session_id: 'session-working', title: '运行任务', status: 'running' },
    {
      ...baseSession,
      session_id: 'session-done',
      title: '已完成任务',
      attention_status: 'unseen',
      attention_reason: 'completion',
    },
    {
      ...baseSession,
      session_id: 'session-offline',
      title: '离线任务',
      worker_id: 'worker-offline',
      status: 'running',
    },
    { ...baseSession, session_id: 'session-attention', title: '等待确认', status: 'needs_reply' },
  ];

  const result = projectRuntimeOverview(sessions, workers, [], []);

  expect(result.items.map((item) => item.lane)).toEqual([
    'attention',
    'working',
    'done',
    'idle',
    'offline',
  ]);
  expect(result.counts).toEqual({ attention: 1, working: 1, done: 1, idle: 1, offline: 1 });
});

it('prioritizes a pending permission and links the matching Workbench task', () => {
  const permission = {
    permission_id: 'permission-1',
    session_id: 'session-idle',
    worker_id: 'worker-online',
    backend: 'codex',
    kind: 'question',
    title: '请选择维护窗口',
    description: '',
    detail: {},
    actions: {},
    status: 'pending',
    response: {},
    created_at: '2026-07-19T08:02:00Z',
    resolved_at: null,
  } satisfies NativePermission;
  const task = {
    task_id: 'task-1',
    title: '维护任务',
    brief_markdown: '',
    success_criteria_markdown: '',
    status: 'needs_approval',
    priority: 100,
    target_worker_id: 'worker-online',
    backend: 'codex',
    workspace_root: 'E:/Work',
    latest_session_id: 'session-idle',
    artifact_count: 0,
    created_at: '2026-07-19T08:00:00Z',
    updated_at: '2026-07-19T08:02:00Z',
  } satisfies NativeTaskSummary;

  const result = projectRuntimeOverview([baseSession], workers, [permission], [task]);

  expect(result.items[0]).toEqual(expect.objectContaining({
    lane: 'attention',
    reason: '等待你选择',
    taskId: 'task-1',
  }));
});
