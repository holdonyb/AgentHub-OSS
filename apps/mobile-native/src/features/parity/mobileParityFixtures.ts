import type {
  MobileApi,
  NativeNotificationRecord,
  NativePermission,
  NativeProviderSnapshot,
  NativeSessionSummary,
  NativeSettings,
  NativeTaskDetail,
  NativeTimelineItem,
  NativeWorkerSummary,
  NativeWorkspaceFileReadResult,
} from '../../api/mobileApi';
import type { NativeTabKey } from '../../navigation/tabDefinitions';

const worker: NativeWorkerSummary = {
  worker_id: 'workstation-main',
  machine_name: 'Main workstation',
  os: 'windows',
  status: 'online',
  reachable_backends: ['codex', 'claude', 'kimi'],
  workspace_roots: ['E:/Work/AgentHub-OSS'],
  capabilities: { codex: true, claude: true, kimi: true, file_transfer_v2: true },
  last_heartbeat_at: '2026-07-19T12:00:00',
};

const sessions: NativeSessionSummary[] = [
  {
    session_id: 'session-codex-review',
    title: 'Review native mobile parity',
    backend: 'codex',
    worker_id: worker.worker_id,
    workspace_root: worker.workspace_roots?.[0],
    project_name: 'AgentHub-OSS',
    status: 'needs_reply',
    activity_summary: 'Waiting for approval: choose the release scope',
    last_message: 'Choose the release scope before publishing.',
    last_activity_at: '2026-07-19T12:01:00',
    updated_at: '2026-07-19T12:02:00',
  },
  {
    session_id: 'session-claude-running',
    title: 'Claude worker diagnostics',
    backend: 'claude',
    worker_id: worker.worker_id,
    workspace_root: worker.workspace_roots?.[0],
    project_name: 'AgentHub-OSS',
    status: 'running',
    activity_summary: 'Running worker discovery checks',
    last_activity_at: '2026-07-19T12:03:00',
    updated_at: '2026-07-19T12:03:00',
  },
  {
    session_id: 'session-kimi-ready',
    title: 'Kimi release notes',
    backend: 'kimi',
    worker_id: worker.worker_id,
    workspace_root: worker.workspace_roots?.[0],
    project_name: 'AgentHub-OSS',
    status: 'ready',
    activity_summary: 'Release notes are ready',
    last_activity_at: '2026-07-19T11:50:00',
    updated_at: '2026-07-19T11:50:00',
  },
];

const permission: NativePermission = {
  permission_id: 'permission-release-scope',
  session_id: sessions[0]!.session_id,
  worker_id: worker.worker_id,
  backend: 'codex',
  kind: 'question',
  title: 'Release scope',
  description: 'Choose what to publish in this release.',
  detail: {
    questions: [
      {
        id: 'scope',
        header: 'Scope',
        question: 'Which release scope should be used?',
        options: [
          { id: 'native', label: 'Native app', description: 'Publish the native APK.' },
          { id: 'all', label: 'All clients', description: 'Publish every client.' },
        ],
      },
    ],
  },
  actions: { answer: true, deny: true },
  status: 'pending',
  response: {},
  created_at: '2026-07-19T12:02:00',
  resolved_at: null,
};

const timeline: NativeTimelineItem[] = [
  {
    session_id: sessions[0]!.session_id,
    seq: 1,
    item_type: 'assistant_message',
    role: 'assistant',
    text: '# Native parity\n\nReview `docs/releases/native.md` before publishing.',
    tool_call_id: null,
    tool_name: null,
    status: 'completed',
    payload: {},
    created_at: '2026-07-19T12:01:00',
  },
];

const taskDetail: NativeTaskDetail = {
  task: {
    task_id: 'task-native-release',
    title: 'Verify native release',
    brief_markdown: 'Run the **native** release gates.',
    success_criteria_markdown: '- Tests pass\n- APK is signed',
    status: 'ready_to_review',
    priority: 80,
    target_worker_id: worker.worker_id,
    backend: 'codex',
    workspace_root: worker.workspace_roots?.[0] ?? null,
    latest_session_id: sessions[0]!.session_id,
    artifact_count: 1,
    created_at: '2026-07-19T11:00:00',
    updated_at: '2026-07-19T12:04:00',
  },
  artifacts: [
    {
      artifact_id: 'artifact-release-notes',
      kind: 'document',
      title: 'Native release notes',
      path: 'docs/releases/native.md',
      content_markdown: 'All native release checks passed.',
      created_at: '2026-07-19T12:04:00',
    },
  ],
  executions: [],
};

const file: NativeWorkspaceFileReadResult = {
  path: 'docs/releases/native.md',
  filename: 'native.md',
  content_type: 'text/markdown',
  size_bytes: 58,
  truncated: false,
  preview_kind: 'text',
  downloadable: true,
  is_editable: true,
  text: '# Native release\n\nAll native release checks passed.',
};

const notification: NativeNotificationRecord = {
  notification_id: 'notification-release-scope',
  notification_type: 'approval',
  source_type: 'permission',
  source_id: permission.permission_id,
  session_id: sessions[0]!.session_id,
  title: permission.title,
  body: permission.description,
  severity: 'warning',
  status: 'pending',
  created_at: permission.created_at,
  updated_at: permission.created_at,
  delivered_at: null,
  read_at: null,
  acknowledged_at: null,
  dismissed_at: null,
};

const settings: NativeSettings = {
  preferences: {
    locale: 'zh-CN',
    theme_mode: 'light',
    voice_mode: 'streaming',
    voice_language: 'zh-CN',
    quick_replies: ['继续', '不对，重新来', '先给结论'],
  },
  worker_runtime_defaults: {
    max_concurrent_jobs: 2,
    job_poll_interval_seconds: 5,
    heartbeat_interval_seconds: 15,
  },
  options: {},
  limits: {},
};

const providers: NativeProviderSnapshot[] = ['codex', 'claude', 'kimi'].map((backend) => ({
  worker_id: worker.worker_id,
  backend,
  status: 'ready',
  auth_status: 'ready',
  models: [{ id: `${backend}-default`, label: `${backend} default` }],
  modes: [],
  features: {},
  diagnostics: {},
  fetched_at: '2026-07-19T12:00:00',
  updated_at: '2026-07-19T12:00:00',
}));

export const mobileParityFixture = {
  workers: [worker],
  providers,
  sessions,
  permissions: [permission],
  timeline,
  taskDetail,
  file,
  notifications: [notification],
  settings,
};

export const mobileParityOperations = {
  sessions: ['listSessions', 'getSessionTimeline', 'sendSessionInput', 'respondPermission'],
  tasks: ['listTasks', 'getTask', 'reviewTask'],
  files: ['listSessionFiles', 'readSessionFile', 'writeSessionFile', 'uploadSessionFile'],
  workers: ['listWorkers', 'listProviderSnapshots', 'loginProvider', 'logoutProvider'],
  me: ['listNotifications', 'markNotificationRead', 'dismissNotification', 'getSettings', 'patchPreferences'],
} as const satisfies Record<NativeTabKey, readonly (keyof MobileApi)[]>;
