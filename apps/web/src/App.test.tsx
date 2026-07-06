import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { mergeTimelineItems, parseApiDate } from './App';
import type { MessageRenderKind } from './messageRenderPreview';

const capacitorApp = vi.hoisted(() => ({
  addListener: vi.fn(),
  exitApp: vi.fn(),
}));

const nativeNotifications = vi.hoisted(() => ({
  notifyNativePendingPermission: vi.fn().mockResolvedValue('unsupported'),
  notifyNativeStatus: vi.fn().mockResolvedValue('unsupported'),
  requestNativeNotificationPermission: vi.fn().mockResolvedValue('unsupported'),
  listenForNativeNotificationActions: vi.fn().mockResolvedValue(() => undefined),
}));

const voiceStreaming = vi.hoisted(() => ({
  startStreamingVoice: vi.fn(),
}));

const messageRenderPreview = vi.hoisted(() => ({
  detectMessageRenderKind: vi.fn((text?: string | null): MessageRenderKind => (text?.trim() ? 'markdown' : 'plain')),
  renderMarkdownPreview: vi.fn((text: string) => text),
}));

vi.mock('@capacitor/app', () => ({ App: capacitorApp }));
vi.mock('./nativeNotifications', () => nativeNotifications);
vi.mock('./voiceStreaming', () => voiceStreaming);
vi.mock('./messageRenderPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./messageRenderPreview')>();
  messageRenderPreview.detectMessageRenderKind.mockImplementation(actual.detectMessageRenderKind);
  messageRenderPreview.renderMarkdownPreview.mockImplementation(actual.renderMarkdownPreview);
  return {
    ...actual,
    detectMessageRenderKind: messageRenderPreview.detectMessageRenderKind,
    renderMarkdownPreview: messageRenderPreview.renderMarkdownPreview,
  };
});

const sessionPayload = {
  items: [
    {
      session_id: 'sess-1',
      backend: 'codex',
      worker_id: 'win-main',
      workspace_root: 'E:/work/AgentHub',
      project_name: 'AgentHub',
      namespace: 'default',
      mode: 'direct_reply',
      runtime_session_ref: 'codex/sess-1',
      status: 'needs_reply',
      title: 'Codex - AgentHub',
      display_title: '修复移动控制台',
      custom_title: null,
      activity_summary: '等你回复：确认标题和摘要',
      last_activity_at: '2026-04-26T10:00:00Z',
      last_role: 'assistant',
      controls: { model: 'gpt-5.2' },
      last_message: '<script>alert("xss")</script>',
      metadata: {},
      runtime_metadata: {},
    },
  ],
};

const secondSession = {
  ...sessionPayload.items[0],
  session_id: 'sess-2',
  runtime_session_ref: 'codex/sess-2',
  status: 'running',
  title: 'Codex - AgentHub sync',
  display_title: '同步状态验证',
  activity_summary: '列表里已经看到最新摘要',
  last_activity_at: '2026-04-26T10:05:00Z',
  last_message: '列表最新消息',
};

const twoSessionPayload = {
  items: [sessionPayload.items[0], secondSession],
};

const timelinePayload = {
  next_after_seq: 2,
  next_after_cursor: '2026-04-26T10:00:00Z|2',
  items: [
    {
      session_id: 'sess-1',
      seq: 1,
      item_type: 'user_message',
      role: 'user',
      text: '继续修复标题',
      created_at: '2026-04-26T09:59:00Z',
    },
    {
      session_id: 'sess-1',
      seq: 2,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '<script>alert("xss")</script>',
      created_at: '2026-04-26T10:00:00Z',
    },
  ],
};

const outOfOrderTimelinePayload = {
  next_after_seq: 31891,
  next_after_cursor: '2026-05-15T13:19:13Z|31891',
  items: [
    {
      session_id: 'sess-1',
      seq: 31865,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '我还要再查一处边界',
      created_at: '2026-05-15T13:13:56Z',
    },
    {
      session_id: 'sess-1',
      seq: 31890,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '这个回归测试现在过了',
      created_at: '2026-05-15T13:19:13Z',
    },
    {
      session_id: 'sess-1',
      seq: 31891,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '这个回归测试现在过了',
      created_at: '2026-05-15T13:19:13.500Z',
    },
    {
      session_id: 'sess-1',
      seq: 32008,
      item_type: 'user_message',
      role: 'user',
      text: '根本没修好，整个顺序都乱了',
      created_at: '2026-05-15T12:38:25Z',
    },
  ],
};

const repeatedPromptTimelinePayload = {
  items: [
    {
      session_id: 'sess-1',
      seq: 1,
      item_type: 'user_message',
      role: 'user',
      text: '继续',
      created_at: '2026-04-25T10:00:00Z',
    },
    {
      session_id: 'sess-1',
      seq: 2,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '旧回复',
      created_at: '2026-04-25T10:01:00Z',
    },
  ],
};

const secondTimelinePayload = (text: string) => ({
  items: [
    {
      session_id: 'sess-2',
      seq: 1,
      item_type: 'assistant_message',
      role: 'assistant',
      text,
      created_at: '2026-04-26T10:05:00Z',
    },
  ],
});

const providersPayload = {
  items: [
    {
      worker_id: 'win-main',
      backend: 'codex',
      status: 'ready',
      auth_status: 'ready',
      models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
      modes: [
        { id: 'workspace-write', label: 'workspace-write', kind: 'sandbox_mode' },
        { id: 'danger-full-access', label: 'danger-full-access', kind: 'sandbox_mode' },
      ],
      features: {
        yolo: true,
        interaction_bridge: 'native',
        request_user_input: true,
        plan_exit: true,
      },
      diagnostics: {},
      fetched_at: '2026-04-26T10:00:00Z',
      updated_at: '2026-04-26T10:00:00Z',
    },
    {
      worker_id: 'win-main',
      backend: 'claude',
      status: 'ready',
      auth_status: 'unknown',
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      modes: [{ id: 'plan', label: 'plan', kind: 'permission_mode' }],
      features: {
        permission_mode: true,
        interaction_bridge: 'compatibility',
        plan_result_choices: true,
        native_runtime_prompts: false,
      },
      diagnostics: {},
      fetched_at: '2026-04-26T10:00:00Z',
      updated_at: '2026-04-26T10:00:00Z',
    },
    {
      worker_id: 'win-main',
      backend: 'kimi',
      status: 'ready',
      auth_status: 'ready',
      models: [{ id: 'kimi-k2.5', label: 'Kimi K2.5' }],
      modes: [{ id: 'thinking', label: 'thinking', kind: 'thinking' }],
      features: {
        yolo: true,
        interaction_bridge: 'compatibility',
        plan_result_choices: true,
        native_runtime_prompts: false,
        structured_protocols: ['acp', 'wire'],
      },
      diagnostics: {},
      fetched_at: '2026-04-26T10:00:00Z',
      updated_at: '2026-04-26T10:00:00Z',
    },
    {
      worker_id: 'win-main',
      backend: 'opencode',
      status: 'ready',
      auth_status: 'auth_required',
      models: [{ id: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4' }],
      modes: [
        { id: 'plan', label: 'Plan', kind: 'reply_mode' },
        { id: 'build', label: 'build', kind: 'agent' },
      ],
      features: {
        agent: true,
        attach: true,
        interaction_bridge: 'compatibility',
        plan_result_choices: true,
        native_runtime_prompts: false,
        attachments: true,
      },
      diagnostics: {},
      fetched_at: '2026-04-26T10:00:00Z',
      updated_at: '2026-04-26T10:00:00Z',
    },
  ],
};

const settingsPayload = {
  preferences: {
    locale: 'zh-CN',
    theme_mode: 'light',
    voice_mode: 'standard',
    voice_language: 'zh-CN',
    quick_replies: ['继续', '不对，重新来', '等等'],
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
    max_voice_audio_bytes: 12 * 1024 * 1024,
  },
};

const workersPayload = {
  items: [
    {
      worker_id: 'win-main',
      machine_name: 'DevBox',
      os: 'windows',
      reachable_backends: ['codex', 'claude', 'kimi', 'opencode'],
      workspace_roots: ['E:/work/AgentHub'],
      capabilities: { codex: true, claude: true, kimi: true, opencode: true },
      status: 'online',
      last_heartbeat_at: '2026-04-26T10:00:00Z',
      runtime_settings: {
        max_concurrent_jobs: 2,
        job_poll_interval_seconds: 5,
        heartbeat_interval_seconds: 30,
      },
    },
  ],
};

const syncStatusPayload = {
  sessions_digest: 'sessions-v1',
  workers_digest: 'workers-v1',
  jobs_digest: 'jobs-v1',
  schedules_digest: 'schedules-v1',
  providers_digest: 'providers-v1',
  permissions_digest: 'permissions-v1',
  selected_timeline_digest: 'timeline-sess-1-v1',
  selected_session_id: 'sess-1',
  archived: false,
};

const inboxSyncPayload = {
  archived: false,
  cursor: '2026-04-26T10:00:00Z|sess-1',
  items: [],
  removed_session_ids: [],
};

const permissionSyncPayload = {
  cursor: '2026-04-26T10:00:00Z|perm-1',
  items: [],
};

const sessionSyncPayload = {
  session: sessionPayload.items[0],
  items: [],
  jobs: [],
  next_after_seq: 2,
  has_more: false,
};

const virtualCockpitSessionPayload = {
  ...sessionPayload.items[0],
  session_id: 'autopilot-cockpit-2026-06-13',
  worker_id: 'vm-openaitest',
  workspace_root: 'E:/Work',
  runtime_session_ref: 'autopilot-cockpit-2026-06-13',
  runtime_metadata: {
    source: 'autopilot_cockpit',
    date: '2026-06-13',
  },
};

const virtualCockpitSessionSyncPayload = {
  session: virtualCockpitSessionPayload,
  items: [],
  jobs: [],
  next_after_seq: 2,
  has_more: false,
};

const permissionsPayload = {
  items: [
    {
      permission_id: 'perm-1',
      session_id: 'sess-1',
      worker_id: 'win-main',
      backend: 'codex',
      kind: 'tool',
      title: '允许执行 pytest',
      description: 'Codex 请求执行测试命令',
      detail: { command: 'pytest' },
      actions: { allow: true, deny: true },
      status: 'pending',
      created_at: '2026-04-26T10:00:00Z',
      resolved_at: null,
    },
  ],
};

const urlProbePrompt =
  '请检查这个 HTTP 链接：\n' +
  'http://example.com/a/b?x=1&next=https%3A%2F%2Fagenthub.example.com%2Fcb%3Fa%3D1#frag\n' +
  '以及 HTTPS 链接：https://agenthub.example.com/path?q=http%3A%2F%2Fnested.local%2Fa%3Fb%3D1&ok=true';

const choicePermissionsPayload = {
  items: [
    {
      permission_id: 'perm-choice-1',
      session_id: 'sess-1',
      worker_id: 'win-main',
      backend: 'codex',
      kind: 'question',
      title: '选择下一步执行方式',
      description: 'Codex 请求你选择一个方案',
      detail: {},
      actions: { choices: [{ id: 'plan', label: '先列计划' }, { id: 'execute', label: '直接执行' }] },
      status: 'pending',
      created_at: '2026-04-26T10:00:00Z',
      resolved_at: null,
    },
  ],
};

const planExitPermissionsPayload = {
  items: [
    {
      permission_id: 'perm-plan-exit-1',
      session_id: 'sess-1',
      worker_id: 'win-main',
      backend: 'codex',
      kind: 'plan_exit',
      title: '计划已生成',
      description: '选择下一步，AgentHub 会投递到当前 Codex session。',
      detail: {
        source: 'codex_plan_exit',
        plan_text: '<proposed_plan>\n计划：\n1. 建 interaction bus\n2. 接 Codex plan exit\n</proposed_plan>',
      },
      actions: {
        choices: [
          { id: 'implement', label: '执行计划' },
          { id: 'clear_context_implement', label: '清空上下文并执行' },
          { id: 'keep_planning', label: '继续规划' },
          { id: 'cancel', label: '暂不处理' },
        ],
      },
      status: 'pending',
      created_at: '2026-04-26T10:00:00Z',
      resolved_at: null,
    },
  ],
};

const multiQuestionPermissionsPayload = {
  items: [
    {
      permission_id: 'perm-multi-1',
      session_id: 'sess-1',
      worker_id: 'win-main',
      backend: 'codex',
      kind: 'question',
      title: '维护窗口',
      description: '为了把 C 盘真正稳定下来，你接受哪种维护窗口？',
      detail: {
        source: 'codex_request_user_input',
        questions: [
          {
            header: '维护窗口',
            id: 'maintenance_window',
            question: '为了把 C 盘真正稳定下来，你接受哪种维护窗口？',
            options: [
              { label: '今晚可重启 (Recommended)', description: '允许关闭应用、重启、管理员清理。' },
              { label: '只允许关应用', description: '可以关闭 Cursor、Docker、浏览器等，但不安排重启。' },
            ],
          },
          {
            header: 'Docker/WSL',
            id: 'docker_scope',
            question: 'Docker/WSL 这块要怎么处理？',
            options: [
              { label: '迁到 E 盘 (Recommended)', description: '把高占用容器数据纳入计划。' },
              { label: '先不动 Docker', description: '只清缓存和系统项。' },
            ],
          },
        ],
      },
      actions: { choices: [] },
      status: 'pending',
      created_at: '2026-04-26T10:00:00Z',
      resolved_at: null,
    },
  ],
};

const noisyTimelinePayload = {
  items: [
    ...timelinePayload.items,
    {
      session_id: 'sess-1',
      seq: 3,
      item_type: 'tool_call',
      role: 'system',
      tool_name: 'shell_command',
      text: 'very noisy command output that should not be in the focused message stream',
      created_at: '2026-04-26T10:00:30Z',
    },
    {
      session_id: 'sess-1',
      seq: 4,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '工具结果已经折叠，继续看重点消息',
      created_at: '2026-04-26T10:01:00Z',
    },
  ],
};

const requestUserInputTimelinePayload = {
  items: [
    ...timelinePayload.items,
    {
      session_id: 'sess-1',
      seq: 3,
      item_type: 'tool_call',
      role: 'assistant',
      tool_name: 'request_user_input',
      text:
        '调用工具: request_user_input\n{"questions":[{"header":"维护窗口","id":"maintenance_window","question":"为了把 C 盘真正稳定下来，你接受哪种维护窗口？","options":[{"label":"今晚可重启 (Recommended)","description":"允许关闭应用、重启、管理员清理。"},{"label":"只允许关应用","description":"可以关闭 Cursor、Docker、浏览器等，但不安排重启。"}]},{"header":"Docker/WSL","id":"docker_scope","question":"Docker/WSL 这块要怎么处理？","options":[{"label":"迁到 E 盘 (Recommended)","description":"把高占用容器数据纳入计划。"},{"label":"先不动 Docker","description":"只清缓存和系统项。"}]}]}',
      created_at: '2026-04-26T10:00:30Z',
    },
  ],
};

const completedCommandJob = {
  job_id: 'job-codex-command',
  kind: 'session_input',
  target_session_id: 'sess-1',
  worker_id: 'win-main',
  backend: 'codex',
  workspace_root: 'E:/work/AgentHub',
  namespace: 'default',
  priority: 100,
  status: 'succeeded',
  payload: { prompt: '继续执行' },
  result_text: "executed: codex -C E:/work exec resume sess-1 '继续执行'",
  error_text: null,
  created_at: '2026-04-26T10:01:00Z',
  updated_at: '2026-04-26T10:02:00Z',
};

const failedContextJob = {
  ...completedCommandJob,
  job_id: 'job-context-full',
  status: 'failed',
  result_text: null,
  error_text: "codex exited 1: ERROR: Codex ran out of room in the model's context window.",
  updated_at: '2026-04-26T10:03:00Z',
};

const failedInterruptedJob = {
  ...completedCommandJob,
  job_id: 'job-interrupted',
  status: 'failed',
  result_text: null,
  error_text:
    'codex exited 4294967295: OpenAI Codex v0.128.0\n--------\nexec\nGet-Content apps/web/src/App.tsx',
  updated_at: '2026-04-26T10:04:00Z',
};

const failedBalanceJob = {
  ...completedCommandJob,
  job_id: 'job-balance',
  status: 'failed',
  result_text: null,
  error_text:
    'codex exited 1: ERROR: unexpected status 403 Forbidden: {"code":"INSUFFICIENT_BALANCE","message":"账户余额不足"}, url: http://127.0.0.1:15721/v1/responses',
  updated_at: '2026-04-26T10:05:00Z',
};

const failedInvalidKeyJob = {
  ...completedCommandJob,
  job_id: 'job-invalid-key',
  status: 'failed',
  result_text: null,
  error_text:
    'codex app-server error: unexpected status 401 Unauthorized: Incorrect API key provided: sk-xxx. auth error code: invalid_api_key',
  updated_at: '2026-04-26T10:06:00Z',
};

const failedStaleReleasedJob = {
  ...completedCommandJob,
  job_id: 'job-stale-released',
  status: 'failed',
  result_text: null,
  error_text: 'Worker job timed out after 3660 seconds and was released to unblock queued input.',
  updated_at: '2026-04-26T10:07:00Z',
};

const runningLongJob = {
  ...completedCommandJob,
  job_id: 'job-running-long',
  status: 'running',
  result_text: null,
  error_text: null,
  payload: { prompt: '长任务', timeout_seconds: 3600 },
  updated_at: '2026-04-26T10:08:00Z',
};

const queuedInputJob = {
  ...completedCommandJob,
  job_id: 'job-queued-input',
  status: 'queued',
  result_text: null,
  error_text: null,
  payload: { prompt: '这条消息还在排队，不应该刷新后消失', defer_until_session_ready: true },
  queue_reason: 'waiting_for_session_idle',
  queue_reason_text: '等待当前会话空闲后自动执行',
  created_at: '2026-04-26T10:09:00Z',
  updated_at: '2026-04-26T10:09:00Z',
};

const completedFileListJob = {
  ...completedCommandJob,
  job_id: 'job-file-list',
  kind: 'file_list',
  payload: { path: '.' },
  result_text: JSON.stringify({
    path: '.',
    workspace_root: 'E:/work/AgentHub',
    entries: [
      { name: 'src', path: 'src', kind: 'directory', size_bytes: null, modified_at: '2026-04-26T10:01:00Z' },
      { name: 'README.md', path: 'README.md', kind: 'file', size_bytes: 2048, modified_at: '2026-04-26T10:02:00Z' },
    ],
    truncated: false,
  }),
  updated_at: '2026-04-26T10:10:00Z',
};

const completedFileReadJob = {
  ...completedCommandJob,
  job_id: 'job-file-read',
  kind: 'file_read',
  payload: { path: 'README.md', max_bytes: 200000 },
  result_text: JSON.stringify({
    path: 'README.md',
    filename: 'README.md',
    content_type: 'text/plain',
    size_bytes: 128,
    truncated: false,
    modified_at: '2026-04-26T10:11:00Z',
    text: '# AgentHub\n\nNative mobile file preview.',
  }),
  updated_at: '2026-04-26T10:11:00Z',
};

const completedFileWriteJob = {
  ...completedCommandJob,
  job_id: 'job-file-write',
  kind: 'file_write',
  payload: { path: 'README.md', text: '# AgentHub\n\nEdited on mobile.\n', expected_modified_at: '2026-04-26T10:11:00Z' },
  result_text: JSON.stringify({
    path: 'README.md',
    filename: 'README.md',
    content_type: 'text/plain',
    size_bytes: 29,
    truncated: false,
    preview_kind: 'text',
    downloadable: true,
    modified_at: '2026-04-26T10:14:00Z',
    text: '# AgentHub\n\nEdited on mobile.\n',
  }),
  updated_at: '2026-04-26T10:14:00Z',
};

const nestedFileListJob = {
  ...completedCommandJob,
  job_id: 'job-file-list-src',
  kind: 'file_list',
  payload: { path: 'src' },
  result_text: JSON.stringify({
    path: 'src',
    workspace_root: 'E:/work/AgentHub',
    entries: [
      { name: 'docs', path: 'src/docs', kind: 'directory', size_bytes: null, modified_at: '2026-04-26T10:12:00Z' },
      { name: 'diagram.png', path: 'src/diagram.png', kind: 'file', size_bytes: 68, modified_at: '2026-04-26T10:12:30Z' },
    ],
    truncated: false,
  }),
  updated_at: '2026-04-26T10:12:30Z',
};

const imageFileReadJob = {
  ...completedCommandJob,
  job_id: 'job-file-read-image',
  kind: 'file_read',
  payload: { path: 'src/diagram.png', max_bytes: 5000000 },
  result_text: JSON.stringify({
    path: 'src/diagram.png',
    filename: 'diagram.png',
    content_type: 'image/png',
    size_bytes: 68,
    truncated: false,
    preview_kind: 'image',
    downloadable: true,
    data_base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  }),
  updated_at: '2026-04-26T10:13:00Z',
};

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as Response;
}

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(response(payload, status));
}

function headResponse(headers: Record<string, string>, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as Response);
}

describe('AgentHub console', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('confirm', vi.fn(() => true));
    nativeNotifications.notifyNativePendingPermission.mockResolvedValue('unsupported');
    nativeNotifications.notifyNativeStatus.mockResolvedValue('unsupported');
    nativeNotifications.requestNativeNotificationPermission.mockResolvedValue('unsupported');
    nativeNotifications.listenForNativeNotificationActions.mockResolvedValue(() => undefined);
    capacitorApp.addListener.mockResolvedValue({ remove: vi.fn() });
    capacitorApp.exitApp.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/settings')) return jsonResponse(settingsPayload);
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(permissionsPayload);
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) return jsonResponse(sessionSyncPayload);
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-login' });
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.reply_mode === 'plan') {
          expect(body).toEqual({ prompt: '优化消息流', reply_mode: 'plan' });
        } else if (body.attachments?.[0]?.filename === 'screen.png') {
          expect(body.prompt).toBe('看一下图片');
          expect(body.attachments[0]).toMatchObject({
            filename: 'screen.png',
            content_type: 'image/png',
            data_base64: 'AQID',
          });
        } else if (body.prompt === urlProbePrompt) {
          expect(body).toEqual({ prompt: urlProbePrompt });
        } else if (body.prompt === '第一行\n第二行') {
          expect(body).toEqual({ prompt: '第一行\n第二行' });
        } else {
          expect(body).toEqual({ prompt: '继续执行' });
        }
        return jsonResponse({ job: { job_id: 'job-1', status: 'queued' } });
      }
      if (url.endsWith('/api/voice/transcribe')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.content_type).toContain('audio/');
        return jsonResponse({ text: '语音转文字结果' });
      }
      if (url.endsWith('/api/settings/preferences')) {
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...settingsPayload,
          preferences: {
            ...settingsPayload.preferences,
            ...body,
          },
        });
      }
      if (url.endsWith('/api/settings/worker-runtime')) {
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...settingsPayload,
          worker_runtime_defaults: {
            ...settingsPayload.worker_runtime_defaults,
            ...body,
          },
        });
      }
      if (url.endsWith('/api/sessions/sess-1/rename')) {
        return jsonResponse({ session: { ...sessionPayload.items[0], display_title: '新的会话名', custom_title: '新的会话名' } });
      }
      if (url.endsWith('/api/sessions/sess-1/controls')) {
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (
          body.sandbox_mode === 'danger-full-access' &&
          body.approval_mode === 'never' &&
          body.permission_mode === 'bypassPermissions'
        ) {
          return jsonResponse({
            session: {
              ...sessionPayload.items[0],
              controls: { ...sessionPayload.items[0].controls, ...body },
            },
          });
        }
        return jsonResponse({
          session: {
            ...sessionPayload.items[0],
            controls: { ...sessionPayload.items[0].controls, ...body },
          },
        });
      }
      if (url.endsWith('/api/permissions/perm-1/respond')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ action: 'allow', response: {} }));
        return jsonResponse({ permission: { ...permissionsPayload.items[0], status: 'allowed' } });
      }
      if (url.endsWith('/api/permissions/perm-choice-1/respond')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ action: 'answer', response: { choice: 'plan', label: '先列计划' } }));
        return jsonResponse({ permission: { ...choicePermissionsPayload.items[0], status: 'answered' } });
      }
      if (url.endsWith('/api/invites')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
          email: 'teammate@example.com',
          role: 'operator',
          expires_in_hours: 168,
        });
        return jsonResponse({
          invite_id: 'invite-1',
          invite_token: 'ahi_invite_123',
          email: 'teammate@example.com',
          role: 'operator',
          expires_at: '2026-04-27T10:00:00Z',
        });
      }
      return jsonResponse({}, 404);
    }));
  });

  afterEach(() => {
    cleanup();
    delete window.AgentHubAndroid;
    window.history.pushState({}, '', '/');
    vi.unstubAllGlobals();
  });

  it('flushes Android WebView cookies after login before loading the console', async () => {
    const flushCookies = vi.fn(() => true);
    window.AgentHubAndroid = { flushCookies };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) return jsonResponse({}, 401);
      if (url.endsWith('/api/auth/login')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-login' });
      }
      if (url.endsWith('/api/settings')) return jsonResponse(settingsPayload);
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));

    await waitFor(() => expect(flushCookies).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
  });

  it('loads the session inbox, escapes message text, and sends a reply job', async () => {
    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索会话、项目或内容')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '全部' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kimi' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OpenCode' })).toBeInTheDocument();
    expect(screen.queryByText('sess-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));

    expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
    expect(screen.getByText('继续修复标题')).toBeInTheDocument();
    expect(screen.getAllByText('等你回复：确认标题和摘要').length).toBeGreaterThan(0);
    expect(document.querySelector('script')).toBeNull();

    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '继续执行' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/input',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(within(screen.getByLabelText('Transcript')).getByText('继续执行')).toBeInTheDocument();
  });

  it('does not keep the first screen loading while audit events are slow', async () => {
    const defaultFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/events')) return new Promise<Response>(() => undefined);
      return defaultFetch(input, init);
    }));

    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
  });

  it('inserts account quick replies into the composer', async () => {
    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.click(screen.getByRole('button', { name: '不对，重新来' }));
    expect(replyBox).toHaveValue('不对，重新来');

    fireEvent.click(screen.getByRole('button', { name: '等等' }));
    expect(replyBox).toHaveValue('不对，重新来\n等等');
  });

  it('saves editable quick replies in account preferences', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /界面与偏好/ }));
    const editor = screen.getByLabelText('快捷回复列表');
    fireEvent.change(editor, { target: { value: '继续\n先等一下\n不对，重新来' } });
    fireEvent.click(screen.getByRole('button', { name: /保存偏好/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/settings/preferences',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            voice_mode: 'standard',
            voice_language: 'zh-CN',
            quick_replies: ['继续', '先等一下', '不对，重新来'],
          }),
        }),
      );
    });
  });

  it('scrolls the transcript to the latest message from the composer area', async () => {
    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(transcript);

    const scrollButton = await screen.findByRole('button', { name: '滚动到最新消息' });
    fireEvent.click(scrollButton);

    expect(transcript.scrollTop).toBe(1200);
  });

  it('keeps the transcript pinned to the bottom when a synced reply arrives', async () => {
    const counters = { inboxDelta: 0, sessionDelta: 0 };
    let scrollHeight = 600;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              last_message: timelinePayload.items[1].text,
              activity_summary: timelinePayload.items[1].text,
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse(workersPayload);
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/inbox')) {
        counters.inboxDelta += 1;
        if (counters.inboxDelta < 2) return jsonResponse(inboxSyncPayload);
        return jsonResponse({
          ...inboxSyncPayload,
          cursor: '2026-04-26T10:02:00Z|sess-1',
          items: [{ ...sessionPayload.items[0], status: 'needs_reply', last_activity_at: '2026-04-26T10:02:00Z' }],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        counters.sessionDelta += 1;
        if (counters.sessionDelta < 2) return jsonResponse(sessionSyncPayload);
        scrollHeight = 780;
        return jsonResponse({
          ...sessionSyncPayload,
          session: { ...sessionPayload.items[0], status: 'needs_reply', last_activity_at: '2026-04-26T10:02:00Z' },
          items: [
            {
              session_id: 'sess-1',
              seq: 3,
              item_type: 'assistant_message',
              role: 'assistant',
              text: '底部保持跟随的新回复',
              created_at: '2026-04-26T10:02:00Z',
            },
          ],
          next_after_seq: 3,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, writable: true, value: 300 });
    fireEvent.scroll(transcript);

    fireEvent.focus(window);
    await waitFor(() => expect(counters.inboxDelta).toBeGreaterThanOrEqual(1));

    fireEvent.focus(window);
    await waitFor(() => {
      expect(counters.inboxDelta).toBeGreaterThanOrEqual(2);
      expect(counters.sessionDelta).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('底部保持跟随的新回复')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Transcript').scrollTop).toBe(780));
  });

  it('renders the transcript from older to newer so replies stay near the composer', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();

    const transcript = screen.getByLabelText('Transcript');
    await waitFor(() => {
      expect(transcript.querySelectorAll('.message-line')).toHaveLength(2);
    });
    const lines = Array.from(transcript.querySelectorAll('.message-line'));

    expect(transcript).toHaveTextContent('最新在下');
    expect(lines[0]).toHaveTextContent('继续修复标题');
    expect(lines[1]).toHaveTextContent('<script>alert("xss")</script>');
  });

  it('sorts transcript rows by created time and hides adjacent duplicate assistant echoes', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(outOfOrderTimelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();

    const transcript = screen.getByLabelText('Transcript');
    await waitFor(() => {
      expect(transcript.querySelectorAll('.message-line')).toHaveLength(3);
    });
    const lines = Array.from(transcript.querySelectorAll('.message-line'));

    expect(lines[0]).toHaveTextContent('根本没修好，整个顺序都乱了');
    expect(lines[1]).toHaveTextContent('我还要再查一处边界');
    expect(lines[2]).toHaveTextContent('这个回归测试现在过了');
    expect(within(transcript).getAllByText('这个回归测试现在过了')).toHaveLength(1);
  });

  it('keeps compact mobile chrome controllable through status, action, and composer toggles', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();

    const replyForm = document.querySelector('.reply-box');
    expect(replyForm).toHaveClass('is-compact');

    fireEvent.focus(screen.getByLabelText('回复当前会话'));
    await waitFor(() => expect(replyForm).not.toHaveClass('is-compact'));
    fireEvent.blur(screen.getByLabelText('回复当前会话'));
    await waitFor(() => expect(replyForm).toHaveClass('is-compact'));

    const transcript = screen.getByLabelText('Transcript') as HTMLElement;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 320 },
      scrollTop: { configurable: true, value: 360 },
    });
    fireEvent.scroll(transcript);
    await waitFor(() => expect(document.querySelector('.thread-pane')).toHaveClass('is-reading'));

    const statusToggle = screen.getByRole('button', { name: '展开会话状态' });
    expect(statusToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(statusToggle);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '收起会话状态' })).toHaveAttribute('aria-expanded', 'true'),
    );

    expect(replyForm).not.toHaveClass('is-expanded');
    fireEvent.click(screen.getByRole('button', { name: '展开输入框' }));
    expect(replyForm).toHaveClass('is-expanded');
    expect(screen.getByRole('button', { name: '收起输入框' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }));
    const mobileMenu = screen.getByRole('menu', { name: '更多会话操作' });
    expect(within(mobileMenu).getByRole('menuitem', { name: /Fork/ })).toBeInTheDocument();
    expect(within(mobileMenu).getByRole('menuitem', { name: /归档/ })).toBeInTheDocument();
  });

  it('collapses the empty mobile composer when the user starts browsing the transcript', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();

    const replyForm = document.querySelector('.reply-box');
    const replyInput = screen.getByLabelText('回复当前会话');
    fireEvent.focus(replyInput);
    await waitFor(() => expect(replyForm).not.toHaveClass('is-compact'));

    const transcript = screen.getByLabelText('Transcript') as HTMLElement;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 320 },
      scrollTop: { configurable: true, value: 260 },
    });
    fireEvent.scroll(transcript);

    await waitFor(() => expect(replyForm).toHaveClass('is-compact'));
  });

  it('keeps the mobile composer open while browsing when a draft exists', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();

    const replyForm = document.querySelector('.reply-box');
    const replyInput = screen.getByLabelText('回复当前会话');
    fireEvent.focus(replyInput);
    fireEvent.change(replyInput, { target: { value: '先别收起这个草稿' } });
    await waitFor(() => expect(replyForm).not.toHaveClass('is-compact'));

    const transcript = screen.getByLabelText('Transcript') as HTMLElement;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 320 },
      scrollTop: { configurable: true, value: 260 },
    });
    fireEvent.scroll(transcript);

    expect(replyInput).toHaveValue('先别收起这个草稿');
    expect(replyForm).not.toHaveClass('is-compact');
  });

  it('shows provider interaction support boundaries in the provider panel', async () => {
    render(<App />);

    expect(await screen.findByText('Provider 状态')).toBeInTheDocument();
    expect(screen.getByText('原生交互：Plan/选项/审批可在 AgentHub 内处理')).toBeInTheDocument();
    expect(screen.getAllByText('兼容交互：计划后的选择可处理，运行中原生提问需本机或后续桥接')).toHaveLength(3);
  });

  it('lets admins save worker runtime settings from the rail panel', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers') && (!init || init.method === undefined)) return jsonResponse(workersPayload);
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/workers/win-main/runtime-settings')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
          max_concurrent_jobs: 4,
          job_poll_interval_seconds: 9,
          heartbeat_interval_seconds: 45,
        });
        return jsonResponse({
          worker: {
            ...workersPayload.items[0],
            runtime_settings: {
              max_concurrent_jobs: 4,
              job_poll_interval_seconds: 9,
              heartbeat_interval_seconds: 45,
            },
          },
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const runtimeToggle = screen.getByRole('button', { name: /Worker 运行参数/ });
    const runtimePanel = runtimeToggle.closest('.rail-panel') as HTMLElement;
    expect(runtimePanel).not.toHaveClass('is-open');
    fireEvent.click(runtimeToggle);
    await waitFor(() => expect(runtimePanel).toHaveClass('is-open'));

    fireEvent.change(within(runtimePanel).getByLabelText('Worker 最大并发'), { target: { value: '4' } });
    fireEvent.change(within(runtimePanel).getByLabelText('Worker job 轮询秒数'), { target: { value: '9' } });
    fireEvent.change(within(runtimePanel).getByLabelText('Worker 心跳秒数'), { target: { value: '45' } });
    fireEvent.click(within(runtimePanel).getByRole('button', { name: /保存 Worker 参数/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/workers/win-main/runtime-settings',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    expect(await screen.findByText(/Worker 运行参数已保存：win-main/)).toBeInTheDocument();
  });

  it('lets admins create an invite from the control rail', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '邀请用户' }));

    const dialog = await screen.findByRole('dialog', { name: '邀请用户' });
    fireEvent.change(within(dialog).getByLabelText('邀请邮箱'), {
      target: { value: 'teammate@example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('邀请角色'), {
      target: { value: 'operator' },
    });
    fireEvent.change(within(dialog).getByLabelText('有效期小时'), {
      target: { value: '168' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建邀请' }));

    expect(await within(dialog).findByText('ahi_invite_123')).toBeInTheDocument();
    expect(within(dialog).getByText('teammate@example.com')).toBeInTheDocument();
  });

  it('keeps the mobile session count inline and clears search with one tap', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(twoSessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const searchInput = await screen.findByLabelText('搜索会话');
    const heading = screen.getByRole('heading', { name: /会话收件箱/ });
    expect(within(heading).getByText('2 个')).toBeInTheDocument();
    expect(document.querySelector('.section-heading > span')).toBeNull();

    fireEvent.change(searchInput, { target: { value: '同步' } });
    expect(screen.getByRole('button', { name: '清空搜索' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /修复移动控制台/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(searchInput).toHaveValue('');
    expect(screen.getByRole('button', { name: /修复移动控制台/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /同步状态验证/ })).toBeInTheDocument();
  });

  it('presents raw command output as an Agent Ops task summary instead of a log-heavy card', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              status: 'running',
              display_title: '课程开发Agent',
              activity_summary:
                '正在执行：工具结果: Exit code: 1 Wall time: 0.9 seconds Output: traceback line one traceback line two',
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const card = await screen.findByRole('button', { name: /课程开发Agent/ });
    expect(within(card).getByText(/执行失败/)).toBeInTheDocument();
    expect(within(card).queryByText(/Exit code/i)).toBeNull();
    expect(within(card).queryByText(/Wall time/i)).toBeNull();
    await screen.findByRole('heading', { name: '课程开发Agent' });
    const statusStrip = document.querySelector('.thread-status-strip');
    expect(statusStrip).toBeInTheDocument();
    expect(statusStrip?.textContent).toContain('运行中');
    expect(screen.getAllByText(/执行失败/).length).toBeGreaterThan(0);
  });

  it('archives sessions out of the inbox and restores them from the archive view', async () => {
    let activeSessions = [sessionPayload.items[0]];
    let archivedSessions: Array<typeof sessionPayload.items[number] & { archived_at: string | null }> = [];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions?archived=true')) return jsonResponse({ items: archivedSessions });
      if (url.endsWith('/api/sessions')) return jsonResponse({ items: activeSessions });
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/archive')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        const archived = { ...sessionPayload.items[0], archived_at: '2026-05-14T10:00:00Z' };
        activeSessions = [];
        archivedSessions = [archived];
        return jsonResponse({ session: archived });
      }
      if (url.endsWith('/api/sessions/sess-1/unarchive')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        activeSessions = [sessionPayload.items[0]];
        archivedSessions = [];
        return jsonResponse({ session: { ...sessionPayload.items[0], archived_at: null } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const activeSessionRow = await screen.findByRole('button', { name: /修复移动控制台/ });
    const activeSessionShell = activeSessionRow.closest('.session-row-shell') as HTMLElement;
    expect(within(activeSessionShell).queryByRole('button', { name: '从列表归档会话' })).toBeNull();
    fireEvent.pointerDown(activeSessionRow, { pointerType: 'touch', clientX: 320, clientY: 40 });
    fireEvent.pointerUp(activeSessionRow, { pointerType: 'touch', clientX: 220, clientY: 42 });
    fireEvent.click(await within(activeSessionShell).findByRole('button', { name: '从列表归档会话' }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/archive', expect.any(Object)));
    expect(window.confirm).toHaveBeenCalledWith('确认归档这个会话？');
    expect(await screen.findByText('暂无会话。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^归档$/ }));
    const archivedSessionRow = await screen.findByRole('button', { name: /修复移动控制台/ });
    const archivedSessionShell = archivedSessionRow.closest('.session-row-shell') as HTMLElement;
    expect(within(archivedSessionShell).queryByRole('button', { name: '从列表恢复会话' })).toBeNull();
    fireEvent.pointerDown(archivedSessionRow, { pointerType: 'touch', clientX: 320, clientY: 40 });
    fireEvent.pointerUp(archivedSessionRow, { pointerType: 'touch', clientX: 220, clientY: 42 });
    fireEvent.click(await within(archivedSessionShell).findByRole('button', { name: '从列表恢复会话' }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/unarchive', expect.any(Object)));
    expect(window.confirm).toHaveBeenCalledWith('确认恢复这个会话？');
    fireEvent.click(screen.getByRole('button', { name: /^收件箱$/ }));
    expect(await screen.findByRole('button', { name: /修复移动控制台/ })).toBeInTheDocument();
  }, 10000);

  it('archives multiple visible sessions from the session list with confirmation', async () => {
    let activeSessions = [...twoSessionPayload.items];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse({ items: activeSessions });
      if (url.endsWith('/api/sessions?archived=true')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/archive')) {
        activeSessions = activeSessions.filter((session) => session.session_id !== 'sess-1');
        return jsonResponse({ session: { ...twoSessionPayload.items[0], archived_at: '2026-05-14T10:00:00Z' } });
      }
      if (url.endsWith('/api/sessions/sess-2/archive')) {
        activeSessions = activeSessions.filter((session) => session.session_id !== 'sess-2');
        return jsonResponse({ session: { ...twoSessionPayload.items[1], archived_at: '2026-05-14T10:01:00Z' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: /修复移动控制台/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批量选择' }));
    fireEvent.click(screen.getByRole('button', { name: '选择会话：修复移动控制台' }));
    fireEvent.click(screen.getByRole('button', { name: '选择会话：同步状态验证' }));
    fireEvent.click(screen.getByRole('button', { name: '归档选中' }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/archive', expect.any(Object)));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-2/archive', expect.any(Object)));
    expect(window.confirm).toHaveBeenCalledWith('确认归档选中的 2 个会话？');
    expect(await screen.findByText('暂无会话。')).toBeInTheDocument();
  }, 10000);

  it('shows slash commands and inserts the goal command template', async () => {
    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '/' } });

    expect(await screen.findByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /\/goal/ }));

    expect(replyBox).toHaveValue('/goal ');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
  });

  it('accepts the first slash command with Enter instead of sending a slash prompt', async () => {
    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '/go' } });
    fireEvent.keyDown(replyBox, { key: 'Enter', code: 'Enter' });

    expect(replyBox).toHaveValue('/goal ');
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url).endsWith('/api/sessions/sess-1/input')),
    ).toBeFalsy();
  });

  it('runs immediate slash commands from the command palette', async () => {
    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '/' } });
    fireEvent.click(await screen.findByRole('option', { name: /\/new/ }));

    expect(await screen.findByRole('heading', { name: '新建会话' })).toBeInTheDocument();
    expect(replyBox).toHaveValue('');
  });

  it('creates new and forked sessions from slash command arguments', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'DevBox',
              os: 'windows',
              reachable_backends: ['codex', 'claude', 'kimi'],
              workspace_roots: ['E:/work/AgentHub'],
              capabilities: { codex: true, claude: true, kimi: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/start')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
          worker_id: 'win-main',
          backend: 'codex',
          workspace_root: 'E:/work/AgentHub',
          prompt: '从 slash 命令创建会话',
        });
        return jsonResponse({ job: { job_id: 'job-start-slash', kind: 'session_start', status: 'queued' } });
      }
      if (url.endsWith('/api/sessions/sess-1/fork')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
          worker_id: 'win-main',
          backend: 'codex',
          workspace_root: 'E:/work/AgentHub',
          prompt: '从 slash 命令 fork 一条线',
        });
        return jsonResponse({ job: { job_id: 'job-fork-slash', kind: 'session_fork', status: 'queued' } });
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        throw new Error('slash launch commands must not use normal session input');
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '/new 从 slash 命令创建会话' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/start', expect.any(Object)));
    expect(replyBox).toHaveValue('');

    fireEvent.change(replyBox, { target: { value: '/fork 从 slash 命令 fork 一条线' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/fork', expect.any(Object)));
    expect(replyBox).toHaveValue('');
  }, 10000);

  it('creates provider auth jobs from login and logout slash commands', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'DevBox',
              os: 'windows',
              reachable_backends: ['codex', 'claude', 'kimi'],
              workspace_roots: ['E:/work/AgentHub'],
              capabilities: { codex: true, claude: true, kimi: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/providers/win-main/codex/login')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({ job: { job_id: 'job-provider-login', kind: 'provider_login', status: 'queued' } });
      }
      if (url.endsWith('/api/providers/win-main/codex/logout')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({ job: { job_id: 'job-provider-logout', kind: 'provider_logout', status: 'queued' } });
      }
      if (url.endsWith('/api/auth/logout')) {
        throw new Error('/logout slash command must not sign out of AgentHub');
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '/login' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/providers/win-main/codex/login', expect.any(Object)));
    expect(replyBox).toHaveValue('');

    fireEvent.change(replyBox, { target: { value: '/logout' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/providers/win-main/codex/logout', expect.any(Object)));
    expect(replyBox).toHaveValue('');
  }, 10000);

  it('keeps a submitted reply when the post succeeds but the follow-up refresh fails', async () => {
    let jobsFetchCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) {
        jobsFetchCount += 1;
        if (jobsFetchCount > 1) return jsonResponse({ detail: { message: 'refresh failed' } }, 500);
        return jsonResponse({ items: [] });
      }
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(permissionsPayload);
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({ job: { job_id: 'job-refresh-failed', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '刷新失败也不能丢' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/input',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(screen.getAllByText('刷新失败也不能丢').length).toBeGreaterThan(0);
    expect(screen.queryByText(/发送失败/)).toBeNull();
  });

  it('keeps Enter for newlines and sends replies with Ctrl+Enter', async () => {
    render(<App />);

    const replyBox = await screen.findByLabelText('回复当前会话');
    fireEvent.change(replyBox, { target: { value: '第一行' } });
    fireEvent.keyDown(replyBox, { key: 'Enter', code: 'Enter' });
    fireEvent.change(replyBox, { target: { value: '第一行\n第二行' } });

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      '/api/sessions/sess-1/input',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.keyDown(replyBox, { key: 'Enter', code: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/input',
        expect.objectContaining({
          body: JSON.stringify({ prompt: '第一行\n第二行' }),
          method: 'POST',
        }),
      );
    });
  });

  it('generates a worker enrollment and install command from the add worker dialog', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({
          user: { email: 'owner@example.com', role: 'owner' },
          csrf_token: 'csrf-1',
          space: { space_id: 'space-1', name: 'Default Space', slug: 'default-space', mode: 'private', role: 'owner' },
        });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'MainPC',
              os: 'windows',
              connection_mode: 'private',
              transport_state: 'polling',
              reachable_backends: ['codex', 'claude'],
              workspace_roots: ['C:/Work'],
              capabilities: { codex: true, claude: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/worker-enrollments')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
          label: 'win-office-01',
          expires_in_hours: 24,
        });
        return jsonResponse({
          enrollment_id: 'wen-1',
          space_id: 'space-1',
          label: 'win-office-01',
          created_at: '2026-04-26T10:00:00Z',
          expires_at: '2026-04-27T10:00:00Z',
          enrollment_token: 'ahe_test_token',
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加 Worker' }));
    fireEvent.change(screen.getByLabelText('Worker ID'), { target: { value: 'win-office-01' } });
    fireEvent.change(screen.getByLabelText('Worker 标签'), { target: { value: 'win-office-01' } });
    fireEvent.change(screen.getByLabelText('Worker API URL'), { target: { value: 'https://agenthub.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '生成安装命令' }));

    const installCommand = (await screen.findByLabelText('安装命令')) as HTMLTextAreaElement;
    expect(installCommand.value).toContain('/downloads/workers/agenthub-worker-windows.zip');
    expect(installCommand.value).toContain('C:\\ProgramData\\AgentHub\\workers\\win-office-01');
    expect(installCommand.value).toContain("agenthub-worker\\scripts\\install-windows-worker.ps1");
    expect(installCommand.value).toContain('ahe_test_token');
    expect(installCommand.value).toContain('-StartAtBoot');
    expect(installCommand.value).toContain('-MaxConcurrentJobs 2');
    expect(installCommand.value).toContain('-JobPollSeconds 5');
    expect(installCommand.value).toContain('-HeartbeatSeconds 30');
  });

  it('shows background refresh state without moving the active session after navigation', async () => {
    let sessionFetchCount = 0;
    let resolveRefreshSessions: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        sessionFetchCount += 1;
        if (sessionFetchCount === 1) return jsonResponse(twoSessionPayload);
        return new Promise((resolve) => {
          resolveRefreshSessions = () => resolve(response(twoSessionPayload));
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-2/timeline')) return jsonResponse(secondTimelinePayload('第二会话最新详情'));
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    expect(await screen.findByText(/正在后台刷新/)).toBeInTheDocument();
    expect(document.querySelector('.global-status-toast')).toHaveTextContent('正在后台刷新');

    fireEvent.click(screen.getByRole('button', { name: /同步状态验证/ }));
    expect(await screen.findByRole('heading', { name: '同步状态验证' })).toBeInTheDocument();
    expect(await screen.findByText('第二会话最新详情')).toBeInTheDocument();

    resolveRefreshSessions?.();
    await waitFor(() => expect(screen.getByRole('heading', { name: '同步状态验证' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: '修复移动控制台' })).not.toBeInTheDocument();
    expect(await screen.findByText(/后台刷新完成/)).toBeInTheDocument();
  });

  it('keeps the transcript pinned when manual refresh loads a newer selected timeline', async () => {
    let timelineFetches = 0;
    let scrollHeight = 600;
    const refreshedTimeline = {
      next_after_seq: 3,
      next_after_cursor: '2026-04-26T10:04:00Z|3',
      items: [
        ...timelinePayload.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '手动刷新补到的新回复',
          created_at: '2026-04-26T10:04:00Z',
        },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              last_message: timelineFetches > 1 ? '手动刷新补到的新回复' : sessionPayload.items[0].last_message,
              last_activity_at: timelineFetches > 1 ? '2026-04-26T10:04:00Z' : sessionPayload.items[0].last_activity_at,
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        if (timelineFetches > 1) scrollHeight = 900;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : timelinePayload);
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, writable: true, value: 300 });
    fireEvent.scroll(transcript);

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));

    expect(await within(transcript).findByText('手动刷新补到的新回复')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Transcript').scrollTop).toBe(900));
  });

  it('keeps a queued optimistic reply visible across refresh until the worker timeline catches up', async () => {
    let sessionFetchCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        sessionFetchCount += 1;
        if (sessionFetchCount === 1) return jsonResponse(sessionPayload);
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              status: 'queued',
              activity_summary: '消息已排队，等待当前作业完成',
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ prompt: '刷新后也别丢' });
        return jsonResponse({ job: { job_id: 'job-queued-1', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '刷新后也别丢' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    expect(await screen.findByText('刷新后也别丢')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));

    expect(await screen.findByText(/后台刷新完成/)).toBeInTheDocument();
    expect(screen.getByText('刷新后也别丢')).toBeInTheDocument();
  });

  it('keeps a repeated queued prompt visible instead of matching it to old transcript text', async () => {
    let inputCreated = false;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              status: inputCreated ? 'queued' : 'needs_reply',
              activity_summary: inputCreated ? '消息已排队，等待当前作业完成' : sessionPayload.items[0].activity_summary,
              last_activity_at: inputCreated ? '2026-04-26T10:09:00Z' : sessionPayload.items[0].last_activity_at,
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) {
        return jsonResponse({
          items: inputCreated
            ? [
                {
                  ...queuedInputJob,
                  job_id: 'job-repeat-queued',
                  payload: { prompt: '继续', defer_until_session_ready: true },
                },
              ]
            : [],
        });
      }
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(repeatedPromptTimelinePayload);
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ prompt: '继续' });
        inputCreated = true;
        return jsonResponse({ job: { job_id: 'job-repeat-queued', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('旧回复')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(within(transcript).getAllByText('继续')).toHaveLength(2);
    });
    expect(within(transcript).getByText('旧回复')).toBeInTheDocument();
  });

  it('replaces the optimistic repeated prompt once the server timeline catches up', async () => {
    let inputCreated = false;
    let timelineFetches = 0;
    const caughtUpTimelinePayload = {
      items: [
        ...repeatedPromptTimelinePayload.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'user_message',
          role: 'user',
          text: '继续',
          payload: { job_id: 'job-repeat-queued', source: 'session_input' },
          created_at: '2026-04-26T10:09:00Z',
        },
      ],
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              status: inputCreated ? 'queued' : 'needs_reply',
              last_activity_at: inputCreated ? '2026-04-26T10:09:00Z' : sessionPayload.items[0].last_activity_at,
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 1 ? caughtUpTimelinePayload : repeatedPromptTimelinePayload);
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ prompt: '继续' });
        inputCreated = true;
        return jsonResponse({ job: { job_id: 'job-repeat-queued', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('旧回复')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '继续' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(within(transcript).getAllByText('继续')).toHaveLength(2);
    });
  });

  it('renders queued session input jobs in the message stream after a page refresh', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              status: 'queued',
              activity_summary: '消息已排队，等待当前作业完成',
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [queuedInputJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('这条消息还在排队，不应该刷新后消失')).toBeInTheDocument();
    expect(within(transcript).getByText(/排队中/)).toBeInTheDocument();
    expect(screen.getByText('等待当前会话空闲后自动执行')).toBeInTheDocument();
  });

  it('keeps failed job diagnostics out of the transcript when real timeline messages exist', async () => {
    const oldFailedJob = {
      ...failedInvalidKeyJob,
      payload: { prompt: '旧的失败发送不应该盖住真实对话' },
      created_at: '2026-04-26T09:00:00Z',
      updated_at: '2026-04-26T09:00:00Z',
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [oldFailedJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('<script>alert("xss")</script>')).toBeInTheDocument();
    expect(within(transcript).queryByText('旧的失败发送不应该盖住真实对话')).toBeNull();
  });

  it('falls back to session runtime messages when the detail timeline has no transcript', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              last_message: '列表摘要不是完整回复',
              runtime_metadata: {
                messages: [
                  {
                    role: 'assistant',
                    kind: 'assistant_message',
                    text: '缓存里的完整回复应该在详情里显示',
                    created_at: '2026-04-26T10:00:00Z',
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse({ items: [], has_more: false });
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('缓存里的完整回复应该在详情里显示')).toBeInTheDocument();
  });

  it('reloads a session timeline when the user opens it again', async () => {
    let secondTimelineVersion = '第二会话旧详情';
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(twoSessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-2/timeline')) return jsonResponse(secondTimelinePayload(secondTimelineVersion));
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /同步状态验证/ }));
    expect(await screen.findByText('第二会话旧详情')).toBeInTheDocument();

    secondTimelineVersion = '第二会话刷新后的详情';
    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    fireEvent.click(screen.getByRole('button', { name: /同步状态验证/ }));

    expect(await screen.findByText('第二会话刷新后的详情')).toBeInTheDocument();
  });

  it('creates, forks, manages provider auth, and logs out from visible controls', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'DevBox',
              os: 'windows',
              reachable_backends: ['codex', 'claude', 'kimi'],
              workspace_roots: ['E:/work/AgentHub'],
              capabilities: { codex: true, claude: true, kimi: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/start')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
          worker_id: 'win-main',
          backend: 'codex',
          workspace_root: 'E:/work/AgentHub',
          prompt: '创建一个新的 Codex 会话',
        });
        return jsonResponse({ job: { job_id: 'job-start', kind: 'session_start', status: 'queued' } });
      }
      if (url.endsWith('/api/sessions/sess-1/fork')) {
        expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
          prompt: '从这里 fork 继续 UI',
          backend: 'codex',
          worker_id: 'win-main',
        });
        return jsonResponse({ job: { job_id: 'job-fork', kind: 'session_fork', status: 'queued' } });
      }
      if (url.endsWith('/api/providers/win-main/codex/logout')) {
        return jsonResponse({ job: { job_id: 'job-provider-logout', kind: 'provider_logout', status: 'queued' } });
      }
      if (url.endsWith('/api/auth/logout')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({ ok: true });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }));
    fireEvent.change(screen.getByLabelText('初始 Prompt'), { target: { value: '创建一个新的 Codex 会话' } });
    fireEvent.click(screen.getByRole('button', { name: '创建会话' }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/start', expect.any(Object)));

    fireEvent.click(screen.getByRole('button', { name: /Fork/ }));
    fireEvent.change(screen.getByLabelText('Fork 目标'), { target: { value: '从这里 fork 继续 UI' } });
    fireEvent.click(screen.getByRole('button', { name: '创建 Fork' }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/fork', expect.any(Object)));

    fireEvent.click(screen.getByRole('button', { name: /Codex 退出/ }));
    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/providers/win-main/codex/logout', expect.any(Object)),
    );

    fireEvent.click(screen.getByRole('button', { name: /退出登录/ }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/logout', expect.any(Object)));
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
  }, 10000);

  it('sends Claude launch requests with the selected interaction bridge', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'DevBox',
              os: 'windows',
              reachable_backends: ['codex', 'claude', 'kimi'],
              workspace_roots: ['E:/work/AgentHub'],
              capabilities: { codex: true, claude: true, kimi: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/start')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
          worker_id: 'win-main',
          backend: 'claude',
          workspace_root: 'E:/work/AgentHub',
          prompt: '创建一个新的 Claude 会话',
          controls: {
            interaction_bridge: 'tmux',
          },
        });
        return jsonResponse({ job: { job_id: 'job-start-claude', kind: 'session_start', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /新建会话/ }));
    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Launch 交互桥'), { target: { value: 'tmux' } });
    fireEvent.change(screen.getByLabelText('初始 Prompt'), { target: { value: '创建一个新的 Claude 会话' } });
    fireEvent.click(screen.getByRole('button', { name: '创建会话' }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/start', expect.any(Object)));
  }, 10000);

  it('stops the current session input from visible controls', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [{ ...sessionPayload.items[0], status: 'running', activity_summary: '正在执行：长任务' }],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs') && (!init || init.method === undefined)) {
        return jsonResponse({ items: [runningLongJob] });
      }
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/jobs/job-running-long/cancel')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({
          job: {
            ...runningLongJob,
            status: 'cancelled',
            error_text: 'Cancelled by usr_owner',
          },
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /停止当前任务/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/jobs/job-running-long/cancel', expect.objectContaining({ method: 'POST' }));
    });
    expect(await screen.findByText('当前任务已停止')).toBeInTheDocument();
  });

  it('queues a BTW side question from the reply composer without sending session input', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/btw')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ prompt: '顺便分析 secrets 方案' });
        return jsonResponse({ job: { job_id: 'job-btw', kind: 'session_btw', status: 'queued' } });
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        throw new Error('BTW must not use normal session input');
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '/btw 顺便分析 secrets 方案' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/btw', expect.objectContaining({ method: 'POST' }));
    });
    expect(await screen.findByText(/BTW 旁路问题已入队/)).toBeInTheDocument();
  });

  it('lets admins save secrets and reference them from session controls without rendering values', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/secrets') && init?.method !== 'POST') {
        return jsonResponse({
          items: [
            {
              secret_id: 'sec-1',
              name: 'OPENAI_API_KEY',
              namespace: 'default',
              environment: 'prod',
              description: 'prod key',
              has_value: true,
              created_at: '2026-05-09T10:00:00Z',
              updated_at: '2026-05-09T10:00:00Z',
              revoked_at: null,
            },
          ],
        });
      }
      if (url.endsWith('/api/secrets') && init?.method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({
          name: 'KIMI_API_KEY',
          value: 'kimi-secret',
          namespace: 'agenthub',
          environment: 'test',
          description: '测试 Kimi',
        });
        return jsonResponse({
          secret: {
            secret_id: 'sec-2',
            name: 'KIMI_API_KEY',
            namespace: 'agenthub',
            environment: 'test',
            description: '测试 Kimi',
            has_value: true,
            created_at: '2026-05-09T10:01:00Z',
            updated_at: '2026-05-09T10:01:00Z',
            revoked_at: null,
          },
        });
      }
      if (url.endsWith('/api/sessions/sess-1/controls')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.secret_refs).toEqual(['KIMI_API_KEY']);
        expect(body.secret_environment).toBe('test');
        expect(body.secret_namespace).toBe('agenthub');
        return jsonResponse({
          session: {
            ...sessionPayload.items[0],
            controls: {
              ...sessionPayload.items[0].controls,
              secret_refs: ['KIMI_API_KEY'],
              secret_environment: 'test',
              secret_namespace: 'agenthub',
            },
          },
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('Secrets')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.queryByText('kimi-secret')).toBeNull();

    fireEvent.change(screen.getByLabelText('Secret 名称'), { target: { value: 'kimi_api_key' } });
    fireEvent.change(screen.getByLabelText('Secret 环境配置'), { target: { value: 'test' } });
    fireEvent.change(screen.getByLabelText('Secret 命名空间配置'), { target: { value: 'agenthub' } });
    fireEvent.change(screen.getByLabelText('Secret 值'), { target: { value: 'kimi-secret' } });
    fireEvent.change(screen.getByLabelText('Secret 描述'), { target: { value: '测试 Kimi' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Secret' }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/secrets', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText('KIMI_API_KEY')).toBeInTheDocument();
    expect(screen.queryByText('kimi-secret')).toBeNull();

    fireEvent.change(screen.getByLabelText('Secret 环境'), { target: { value: 'test' } });
    fireEvent.change(screen.getByLabelText('Secret 命名空间'), { target: { value: 'agenthub' } });
    fireEvent.change(screen.getByLabelText('Secret 引用'), { target: { value: 'kimi_api_key' } });
    fireEvent.click(screen.getByRole('button', { name: /保存控制/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/sess-1/controls', expect.objectContaining({ method: 'PATCH' }));
    });
  });

  it('keeps the reply composer compact without exposing low-value command output', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              activity_summary:
                '这是一段很长的活动摘要，用来模拟真实 Codex session 里连续工具调用之后的页面标题区域。它不应该把 transcript 挤到几乎看不见。',
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [completedCommandJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    expect(document.querySelector('.thread-status-strip')).toBeInTheDocument();
    expect(document.querySelector('.task-summary-card')).toBeNull();
    expect(document.querySelector('.session-meta')).toBeNull();
    expect(screen.getByRole('button', { name: /模型与工具/ }).closest('.rail-panel')).not.toHaveClass('is-open');
    expect(screen.getByRole('button', { name: /Provider 状态/ }).closest('.rail-panel')).not.toHaveClass('is-open');

    const replyBox = document.querySelector('.reply-box');
    const transcript = document.querySelector('.message-block');
    expect(replyBox).toBeInTheDocument();
    expect(transcript).toBeInTheDocument();
    expect(
      Array.from(document.querySelector('.thread-pane')?.children ?? []).indexOf(replyBox as Element),
    ).toBeGreaterThan(Array.from(document.querySelector('.thread-pane')?.children ?? []).indexOf(transcript as Element));

    const jobSummary = document.querySelector('.job-result')?.textContent ?? '';
    expect(jobSummary).toContain('已送达 Codex');
    expect(jobSummary).not.toContain('executed: codex');
  });

  it('lets collapsed control panels expand and stay open across refresh renders', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const modelToggle = screen.getByRole('button', { name: /模型与工具/ });
    const modelPanel = modelToggle.closest('.rail-panel') as HTMLElement;
    expect(modelPanel).not.toHaveClass('is-open');

    fireEvent.click(modelToggle);
    await waitFor(() => expect(modelPanel).toHaveClass('is-open'));
    expect(within(modelPanel).getByLabelText('模型')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    await waitFor(() => expect(modelPanel).toHaveClass('is-open'));
  });

  it('defaults to a focused message stream and folds noisy tool output behind the tools filter', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(noisyTimelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('工具结果已经折叠，继续看重点消息')).toBeInTheDocument();
    expect(document.querySelector('.timeline-tabs button.selected')?.textContent).toContain('重点');
    expect(screen.queryByText(/very noisy command output/)).toBeNull();

    fireEvent.click(within(document.querySelector('.timeline-tabs') as HTMLElement).getByRole('button', { name: /工具/ }));
    expect(await screen.findByText('shell_command')).toBeInTheDocument();
    expect(screen.getByText(/very noisy command output/)).toBeInTheDocument();
  });

  it('does not clamp the visible message stream to 16 items', async () => {
    const longTimelinePayload = {
      items: Array.from({ length: 24 }, (_, index) => ({
        session_id: 'sess-1',
        seq: index + 1,
        item_type: index % 2 === 0 ? 'user_message' : 'assistant_message',
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `历史消息 ${index + 1}`,
        created_at: `2026-04-26T10:${String(index).padStart(2, '0')}:00Z`,
      })),
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(longTimelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('历史消息 24')).toBeInTheDocument();
    expect(screen.getByText('历史消息 1')).toBeInTheDocument();
    expect(document.querySelector('.timeline-tabs button.selected')?.textContent).toContain('24');
  });

  it('lets long transcript messages expand, copy, and open in a fulltext reader', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const longText = `长回复开头 ${'这是一段需要默认折叠但允许复制的内容。'.repeat(80)} 长回复结尾`;
    const truncatedText = `${'工具输出需要保持边界。'.repeat(90)}\n\n[AgentHub truncated this item]`;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'assistant_message',
              role: 'assistant',
              text: longText,
              created_at: '2026-04-26T10:00:00Z',
            },
            {
              session_id: 'sess-1',
              seq: 2,
              item_type: 'tool_call',
              role: 'tool',
              text: truncatedText,
              tool_name: 'shell_command',
              created_at: '2026-04-26T10:01:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText(/长回复开头/)).toBeInTheDocument();
    expect(screen.queryByText(/长回复结尾/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
    expect(screen.getByText(/长回复结尾/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(longText));
    expect(await screen.findByText('已复制')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '全文阅读' }));
    const dialog = await screen.findByRole('dialog', { name: '全文阅读' });
    expect(within(dialog).getByText(/长回复结尾/)).toBeInTheDocument();
    expect(document.body.lastElementChild).toHaveClass('fulltext-backdrop');
    expect(screen.getByLabelText('Transcript').contains(dialog)).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭全文阅读' }));
    expect(screen.queryByRole('dialog', { name: '全文阅读' })).toBeNull();

    fireEvent.click(within(document.querySelector('.timeline-tabs') as HTMLElement).getByRole('button', { name: /工具/ }));
    expect(screen.getByText('内容已截断')).toBeInTheDocument();
    expect(screen.queryByText('[AgentHub truncated this item]')).toBeNull();
  });

  it('defers markdown preview rendering for collapsed long transcript messages until full reader opens', async () => {
    const longMarkdown = [
      '# 性能基线',
      '',
      ...Array.from({ length: 80 }, (_, index) => `- 第 ${index + 1} 条长消息用于验证 WebView 不预渲染隐藏 Markdown`),
    ].join('\n');
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'assistant_message',
              role: 'assistant',
              text: longMarkdown,
              created_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const performanceMessage = (await screen.findByText(/性能基线/)).closest('.message-line') as HTMLElement;
    expect(performanceMessage).toBeTruthy();
    expect(messageRenderPreview.renderMarkdownPreview).not.toHaveBeenCalled();

    fireEvent.click(within(performanceMessage).getByRole('button', { name: '全文阅读' }));
    await screen.findByRole('dialog', { name: '全文阅读' });
    expect(messageRenderPreview.renderMarkdownPreview).toHaveBeenCalledTimes(1);
  });

  it('defers markdown kind detection for collapsed long transcript messages until full reader opens', async () => {
    const longMarkdown = [
      '# 性能基线',
      '',
      ...Array.from({ length: 80 }, (_, index) => `- 第 ${index + 1} 条长消息用于验证 WebView 不扫描隐藏 Markdown`),
    ].join('\n');
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'assistant_message',
              role: 'assistant',
              text: longMarkdown,
              created_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const performanceMessage = (await screen.findByText(/性能基线/)).closest('.message-line') as HTMLElement;
    expect(performanceMessage).toBeTruthy();
    expect(messageRenderPreview.detectMessageRenderKind).not.toHaveBeenCalled();

    fireEvent.click(within(performanceMessage).getByRole('button', { name: '全文阅读' }));
    await waitFor(() => expect(messageRenderPreview.detectMessageRenderKind).toHaveBeenCalled());
  });

  it('uses the Android native clipboard bridge when browser clipboard is unavailable', async () => {
    const nativeCopyText = vi.fn().mockReturnValue(true);
    (window as unknown as { AgentHubAndroid?: { copyText?: (value: string) => boolean } }).AgentHubAndroid = {
      copyText: nativeCopyText,
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    const longText = `移动端复制全文 ${'这段内容需要通过 Android 原生剪贴板复制。'.repeat(40)} 复制结束`;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              last_message: longText,
              activity_summary: longText,
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'assistant_message',
              role: 'assistant',
              text: longText,
              created_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(await within(transcript).findByText(/移动端复制全文/)).toBeInTheDocument();
    fireEvent.click(within(transcript).getByRole('button', { name: '复制全文' }));
    await waitFor(() => expect(nativeCopyText).toHaveBeenCalledWith(longText));
    expect(await screen.findByText('已复制')).toBeInTheDocument();
    delete (window as unknown as { AgentHubAndroid?: unknown }).AgentHubAndroid;
  });

  it('shows html preview only for assistant messages in full reader', async () => {
    const htmlText = '<div style="color:red"><h1>Report</h1><p>Hello</p></div>';
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              last_message: htmlText,
              activity_summary: htmlText,
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'assistant_message',
              role: 'assistant',
              text: htmlText,
              created_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const sessionTitles = await screen.findAllByText('修复移动控制台');
    fireEvent.click(sessionTitles[0]);
    const transcript = await screen.findByLabelText('Transcript');
    await within(transcript).findByText(/Report/);
    fireEvent.click(within(transcript).getByRole('button', { name: '全文阅读' }));
    const dialog = await screen.findByRole('dialog', { name: '全文阅读' });
    expect(within(dialog).getByRole('tab', { name: 'HTML' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: '运行' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: '原文' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Markdown' })).toBeInTheDocument();
  });

  it('does not let optimistic timeline seq break later incremental session sync', async () => {
    let timelineFetchCount = 0;
    const sessionDeltaUrls: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        if (timelineFetchCount === 0) return jsonResponse(sessionPayload);
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '真正同步回来的最终回复',
              last_activity_at: '2026-04-26T10:03:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetchCount += 1;
        return jsonResponse(timelinePayload);
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ prompt: '刷新期间别丢消息' });
        return jsonResponse({ job: { job_id: 'job-sticky-optimistic', status: 'queued' } });
      }
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:03:00Z|sess-1',
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '真正同步回来的最终回复',
              last_activity_at: '2026-04-26T10:03:00Z',
            },
          ],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        sessionDeltaUrls.push(url);
        if (url.includes('after_seq=2')) {
          return jsonResponse({
            ...sessionSyncPayload,
            session: {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '真正同步回来的最终回复',
              last_activity_at: '2026-04-26T10:03:00Z',
            },
            items: [
              {
                session_id: 'sess-1',
                seq: 3,
                item_type: 'assistant_message',
                role: 'assistant',
                text: '真正同步回来的最终回复',
                created_at: '2026-04-26T10:03:00Z',
              },
            ],
            next_after_seq: 3,
          });
        }
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            status: 'needs_reply',
            last_message: '真正同步回来的最终回复',
            last_activity_at: '2026-04-26T10:03:00Z',
          },
          items: [],
          next_after_seq: 3,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '刷新期间别丢消息' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(await screen.findByText('刷新期间别丢消息')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    await screen.findByText(/后台刷新完成/);

    fireEvent.focus(window);

    expect(await screen.findByText('真正同步回来的最终回复')).toBeInTheDocument();
    expect(sessionDeltaUrls.some((url) => url.includes('after_seq=2'))).toBe(true);
  });

  it('opens workspace markdown links from the full reader in the file workbench', async () => {
    const linkedPath = '2026-06-18-trade-discipline-and-analysis.md';
    const linkedFileReadJob = {
      ...completedCommandJob,
      job_id: 'job-file-read-linked-plan',
      kind: 'file_read',
      payload: { path: linkedPath, max_bytes: 5000000 },
      result_text: JSON.stringify({
        path: linkedPath,
        filename: linkedPath,
        content_type: 'text/markdown',
        size_bytes: 96,
        truncated: false,
        modified_at: '2026-06-18T09:10:00Z',
        preview_kind: 'text',
        downloadable: true,
        text: '# 交易纪律计划\n\n从会话里的计划链接直接打开。',
      }),
      updated_at: '2026-06-18T09:10:00Z',
    };
    let currentJobs = [completedFileListJob];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: currentJobs });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'assistant_message',
              role: 'assistant',
              text: `计划已经写好并提交了：\n\n- 计划文件：[${linkedPath}](${linkedPath})\n- 提交：\`9a1e54c docs: add trade discipline plan\``,
              created_at: '2026-06-18T09:10:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/sessions/sess-1/files/read')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ path: linkedPath, max_bytes: 5000000 }));
        currentJobs = [linkedFileReadJob, ...currentJobs];
        return jsonResponse({ job: { ...linkedFileReadJob, status: 'queued', result_text: null } });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) return jsonResponse({ ...sessionSyncPayload, jobs: currentJobs });
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全文阅读' }));
    const dialog = await screen.findByRole('dialog', { name: '全文阅读' });
    fireEvent.click(within(dialog).getByRole('link', { name: linkedPath }));

    expect(await screen.findByRole('heading', { name: '文件浏览器' })).toBeInTheDocument();
    expect(await screen.findByText('交易纪律计划')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '全文阅读' })).toBeNull();
  });

  it('does not show html or markdown preview tabs for tool content', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        return jsonResponse({
          items: [
            {
              session_id: 'sess-1',
              seq: 1,
              item_type: 'tool_call',
              role: 'assistant',
              tool_name: 'observer',
              text: '<div><p>tool result</p></div>',
              created_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const sessionTitles = await screen.findAllByText('修复移动控制台');
    fireEvent.click(sessionTitles[0]);
    await waitFor(() => expect(document.querySelector('.timeline-tabs')).not.toBeNull());
    fireEvent.click(within(document.querySelector('.timeline-tabs') as HTMLElement).getByRole('button', { name: /工具/ }));
    fireEvent.click(screen.getByRole('button', { name: '全文阅读' }));
    const dialog = await screen.findByRole('dialog', { name: '全文阅读' });
    expect(within(dialog).queryByRole('tab', { name: 'HTML' })).toBeNull();
    expect(within(dialog).queryByRole('tab', { name: 'Markdown' })).toBeNull();
  });

  it('loads older transcript history without replacing the current page', async () => {
    const firstPage = {
      has_more: true,
      items: [
        {
          session_id: 'sess-1',
          seq: 10,
          item_type: 'user_message',
          role: 'user',
          text: '当前消息 10',
          created_at: '2026-04-26T10:10:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 11,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '当前消息 11',
          created_at: '2026-04-26T10:11:00Z',
        },
      ],
    };
    const olderPage = {
      has_more: false,
      items: [
        {
          session_id: 'sess-1',
          seq: 8,
          item_type: 'user_message',
          role: 'user',
          text: '更早消息 8',
          created_at: '2026-04-26T10:08:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 9,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '更早消息 9',
          created_at: '2026-04-26T10:09:00Z',
        },
      ],
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(firstPage);
      if (
        url.endsWith(
          '/api/sessions/sess-1/timeline?before_created_at=2026-04-26T10%3A10%3A00Z&before_seq=10&limit=100',
        )
      ) {
        return jsonResponse(olderPage);
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('当前消息 11')).toBeInTheDocument();
    const currentMessage = screen.getByText('当前消息 11').closest('.message-line');
    const loadOlderButton = screen.getByRole('button', { name: /加载更早历史/ });
    expect(currentMessage).toBeTruthy();
    expect(loadOlderButton.compareDocumentPosition(currentMessage!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(loadOlderButton);

    expect(await screen.findByText('更早消息 8')).toBeInTheDocument();
    expect(screen.getByText('当前消息 11')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /加载更早历史/ })).toBeNull();
  });

  it('shows codex context exhaustion as an actionable failure', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [failedContextJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话控制')).toBeInTheDocument();
    expect(screen.getByText('该 Codex 会话上下文已满，需要新开会话或压缩历史后再继续')).toBeInTheDocument();
  });

  it('shows the exact local Codex resume command for AgentHub-created sessions', async () => {
    render(<App />);

    expect(await screen.findByText('本机恢复')).toBeInTheDocument();
    expect(screen.getByText('codex resume --all --include-non-interactive -C "E:/work/AgentHub" "sess-1"')).toBeInTheDocument();
    expect(screen.getByText(/AgentHub 新建的 Codex 会话/)).toBeInTheDocument();
  });

  it('does not show a fake local resume command for virtual autopilot cockpit sessions', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse({ items: [virtualCockpitSessionPayload] });
      if (url.endsWith('/api/workers')) return jsonResponse(workersPayload);
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/autopilot-cockpit-2026-06-13/timeline')) return jsonResponse({ items: [], has_more: false });
      if (url.includes('/api/sync/status')) {
        return jsonResponse({
          ...syncStatusPayload,
          selected_session_id: 'autopilot-cockpit-2026-06-13',
          selected_timeline_digest: 'timeline-autopilot-v1',
        });
      }
      if (url.includes('/api/sync/session/autopilot-cockpit-2026-06-13')) return jsonResponse(virtualCockpitSessionSyncPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('本机恢复')).toBeInTheDocument();
    expect(screen.getByText('这是 AgentHub 驾驶舱生成的合成会话，不对应本机 Codex CLI 历史，不能直接用 codex resume 打开。')).toBeInTheDocument();
    expect(screen.queryByText(/codex resume --all --include-non-interactive/)).toBeNull();
    expect(screen.getByText('Source: autopilot_cockpit · Runtime: autopilot-cockpit-2026-06-13')).toBeInTheDocument();
  });

  it('summarizes interrupted Codex jobs without exposing raw progress as the primary error', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [failedInterruptedJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话控制')).toBeInTheDocument();
    const primaryError = document.querySelector('.job-error')?.textContent ?? '';
    expect(primaryError).toContain('任务超时或被中断');
    expect(primaryError).not.toContain('OpenAI Codex');
  });

  it('explains provider balance and API key failures as actionable errors', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [failedBalanceJob, failedInvalidKeyJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话控制')).toBeInTheDocument();
    const errors = Array.from(document.querySelectorAll('.job-error')).map((node) => node.textContent ?? '');
    expect(errors.join('\n')).toContain('Codex API 余额不足');
    expect(errors.join('\n')).toContain('Codex API Key 无效');
  });

  it('explains stale released and running jobs without hiding why input is waiting', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [runningLongJob, failedStaleReleasedJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话控制')).toBeInTheDocument();
    expect(screen.getByText('Worker 超时或失联，系统已释放后续排队输入')).toBeInTheDocument();
    expect(screen.getByText(/运行中，超时上限 60 分钟/)).toBeInTheDocument();
    expect(screen.getByText(/超过上限后系统会释放后续输入/)).toBeInTheDocument();
  });

  it('blocks replies when the selected worker cannot run the session backend', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'VM',
              os: 'linux',
              reachable_backends: ['tmux'],
              workspace_roots: ['/opt/work'],
              capabilities: { tmux: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('当前 worker 不支持 Codex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /发送/ })).toBeDisabled();
  });

  it('renders pending permission cards and resolves them with csrf', async () => {
    render(<App />);

    expect(await screen.findByText('会话控制')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('允许执行 pytest').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /批准/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/permissions/perm-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('refreshes sessions immediately after resolving a permission', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getAllByText('允许执行 pytest').length).toBeGreaterThan(0));
    const sessionFetchCountBefore = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/api/sessions')).length;
    fireEvent.click(screen.getByRole('button', { name: /批准/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/permissions/perm-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    await waitFor(() => {
      const sessionFetchCountAfter = vi
        .mocked(globalThis.fetch)
        .mock.calls.filter(([url]) => String(url).endsWith('/api/sessions')).length;
      expect(sessionFetchCountAfter).toBeGreaterThan(sessionFetchCountBefore);
    });
  });

  it('surfaces pending approvals as a tappable alert and browser notification', async () => {
    const notification = vi.fn();
    vi.stubGlobal(
      'Notification',
      Object.assign(notification, {
        permission: 'granted',
        requestPermission: vi.fn(),
      }),
    );

    render(<App />);

    const alert = await screen.findByRole('button', { name: /1 个审批待处理/ });
    expect(alert).toHaveTextContent('允许执行 pytest');
    await waitFor(() => {
      expect(notification).toHaveBeenCalledWith(
        'AgentHub 需要你处理审批',
        expect.objectContaining({ body: expect.stringContaining('允许执行 pytest'), tag: 'perm-1' }),
      );
    });

    fireEvent.click(alert);
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread'));
    expect(document.querySelector('.message-block .thread-interactions')).toBeTruthy();
    expect(screen.getAllByText('允许执行 pytest').length).toBeGreaterThan(0);
  });

  it('lets users dismiss the blocking pending approval toast while keeping the bell entry', async () => {
    render(<App />);

    const alert = await screen.findByRole('button', { name: /1 个审批待处理/ });
    expect(alert).toHaveTextContent('允许执行 pytest');

    fireEvent.click(screen.getByRole('button', { name: '收起审批提示' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /1 个审批待处理/ })).toBeNull();
    });
    expect(screen.getByRole('button', { name: /打开待处理通知/ })).toBeInTheDocument();
  });

  it('opens the session list from the mobile topbar menu button', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '控制' }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-controls');

    fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }));

    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-sessions');
  });

  it('wraps the mobile create-session label so compact topbar styles can hide it', async () => {
    render(<App />);

    const createButton = await screen.findByRole('button', { name: /新建会话/ });

    expect(createButton).toHaveClass('primary-top-action');
    expect(createButton.querySelector('span')).toHaveTextContent('新建会话');
  });

  it('maps browser and Android back navigation to the mobile pane stack', async () => {
    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');

    window.history.back();
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-sessions'));

    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');
    fireEvent.click(screen.getByRole('button', { name: '控制' }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-controls');

    window.history.back();
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread'));
  });

  it('collapses back to the session-list root before opening a new session branch', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(twoSessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(permissionsPayload);
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-2/timeline')) return jsonResponse(secondTimelinePayload('切到另一个会话'));
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /同步状态验证/ }));
    await waitFor(() => expect(window.history.state?.depth).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: '打开会话列表' }));
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-sessions'));
    await waitFor(() => expect(window.history.state?.depth).toBe(0));

    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread'));
    expect(window.history.state?.depth).toBe(1);

    window.history.back();
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-sessions'));
    expect(window.history.state?.depth).toBe(0);
  });

  it('exposes an Android native back handler that consumes in-app mobile history first', async () => {
    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');
    await waitFor(() => expect(window.history.state?.depth).toBe(1));

    const handleAndroidBack = () =>
      (window as typeof window & { AgentHubHandleAndroidBack?: () => boolean }).AgentHubHandleAndroidBack?.();

    expect(handleAndroidBack()).toBe(true);
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-sessions'));
    expect(handleAndroidBack()).toBe(false);
  });

  it('handles Capacitor Android backButton events before exiting the APK', async () => {
    render(<App />);

    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    await waitFor(() => expect(capacitorApp.addListener).toHaveBeenCalledWith('backButton', expect.any(Function)));
    const backHandler = capacitorApp.addListener.mock.calls
      .filter(([event]) => event === 'backButton')
      .at(-1)?.[1] as
      | ((event: { canGoBack: boolean }) => void)
      | undefined;
    expect(backHandler).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');

    backHandler?.({ canGoBack: false });
    await waitFor(() => expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-sessions'));
    expect(capacitorApp.exitApp).not.toHaveBeenCalled();

    backHandler?.({ canGoBack: false });
    expect(capacitorApp.exitApp).toHaveBeenCalled();
  });

  it('closes the notification inbox before Android back leaves the active pane', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /1 个审批待处理/ });
    fireEvent.click(screen.getByRole('button', { name: /修复移动控制台/ }));
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');
    fireEvent.click(screen.getByRole('button', { name: /打开待处理通知/ }));
    expect(await screen.findByRole('dialog', { name: '通知 inbox' })).toBeInTheDocument();

    window.history.back();

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '通知 inbox' })).toBeNull());
    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');
  });

  it('opens a notification inbox from the topbar bell and navigates to the selected item', async () => {
    nativeNotifications.requestNativeNotificationPermission.mockResolvedValue('granted');
    render(<App />);

    await screen.findByRole('button', { name: /1 个审批待处理/ });
    fireEvent.click(screen.getByRole('button', { name: /打开待处理通知/ }));

    const inbox = await screen.findByRole('dialog', { name: '通知 inbox' });
    expect(inbox).toBeInTheDocument();
    expect(within(inbox).getByText('未读')).toBeInTheDocument();
    expect(within(inbox).getByRole('button', { name: /允许执行 pytest/ })).toBeInTheDocument();

    fireEvent.click(within(inbox).getByRole('button', { name: /允许执行 pytest/ }));

    expect(document.querySelector('.workspace')?.className).toContain('mobile-pane-thread');
    expect(document.querySelector('.message-block .thread-interactions')).toBeTruthy();
    expect(screen.getAllByText('允许执行 pytest').length).toBeGreaterThan(0);
    expect(nativeNotifications.requestNativeNotificationPermission).not.toHaveBeenCalled();
  });

  it('marks notification inbox items as read without losing navigation history', async () => {
    render(<App />);

    await screen.findByRole('button', { name: /1 个审批待处理/ });
    fireEvent.click(screen.getByRole('button', { name: /打开待处理通知/ }));
    const inbox = await screen.findByRole('dialog', { name: '通知 inbox' });

    fireEvent.click(screen.getByRole('button', { name: '全部标为已读' }));
    expect(localStorage.getItem('agenthub.notifications.read')).toContain('permission:perm-1');
    expect(within(inbox).getByText('已读')).toBeInTheDocument();
  });

  it('uses Android native notifications for pending approvals when the APK plugin is available', async () => {
    nativeNotifications.notifyNativePendingPermission.mockResolvedValue('scheduled');
    const notification = vi.fn();
    vi.stubGlobal(
      'Notification',
      Object.assign(notification, {
        permission: 'granted',
        requestPermission: vi.fn(),
      }),
    );

    render(<App />);

    await screen.findByRole('button', { name: /1 个审批待处理/ });
    await waitFor(() => {
      expect(nativeNotifications.notifyNativePendingPermission).toHaveBeenCalledWith({
        permissionId: 'perm-1',
        sessionId: 'sess-1',
        count: 1,
        title: 'AgentHub 需要你处理审批',
        body: '允许执行 pytest',
      });
    });
    expect(notification).not.toHaveBeenCalled();
  });

  it('uses Android native notifications when a session newly becomes waiting for reply without a pending approval', async () => {
    let sessionFetchCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        sessionFetchCount += 1;
        if (sessionFetchCount === 1) {
          return jsonResponse({
            items: [
              {
                ...sessionPayload.items[0],
                status: 'running',
                activity_summary: '正在执行：等待 worker',
              },
            ],
          });
        }
        return jsonResponse(sessionPayload);
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    nativeNotifications.notifyNativeStatus.mockResolvedValue('scheduled');

    render(<App />);

    await screen.findByRole('heading', { name: '修复移动控制台' });
    expect(nativeNotifications.notifyNativeStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));

    await waitFor(() => {
      expect(nativeNotifications.notifyNativeStatus).toHaveBeenCalledWith({
        id: 'session:sess-1:2026-04-26T10:00:00Z',
        sessionId: 'sess-1',
        title: 'AgentHub 会话等待回复',
        body: '修复移动控制台：等你回复：确认标题和摘要',
      });
    });
  });

  it('requests browser notification permission from the bell action', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), {
        permission: 'default',
        requestPermission,
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /通知/ }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalled());
    expect(await screen.findByText(/浏览器通知已开启/)).toBeInTheDocument();
  });

  it('requests Android notification permission from the bell action when running in the APK', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    nativeNotifications.requestNativeNotificationPermission.mockResolvedValue('granted');
    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), {
        permission: 'default',
        requestPermission,
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /通知/ }));

    await waitFor(() => expect(nativeNotifications.requestNativeNotificationPermission).toHaveBeenCalled());
    expect(nativeNotifications.notifyNativeStatus).toHaveBeenCalledWith({
      id: 'setup-check',
      title: 'AgentHub 通知已开启',
      body: '之后需要你审批或选择时会在通知栏和锁屏提醒。',
    });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(await screen.findByText(/安卓系统通知已开启/)).toBeInTheDocument();
  });

  it('renames sessions from the detail pane', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const titleInput = screen.getByLabelText('会话标题') as HTMLInputElement;
    await waitFor(() => expect(titleInput).toHaveValue('修复移动控制台'));
    fireEvent.change(titleInput, { target: { value: '新的会话名' } });
    await waitFor(() => expect(titleInput).toHaveValue('新的会话名'));
    fireEvent.submit(titleInput.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/rename',
        expect.objectContaining({
          body: JSON.stringify({ custom_title: '新的会话名' }),
          method: 'POST',
        }),
      );
    });
  });

  it('updates session controls from the detail pane', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByLabelText('模型')).getByText('GPT-5.4')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-5.4' } });
    fireEvent.change(screen.getByLabelText('沙箱'), { target: { value: 'danger-full-access' } });
    fireEvent.change(screen.getByLabelText('交互桥'), { target: { value: 'tmux' } });
    fireEvent.click(screen.getByLabelText('Yolo'));
    await waitFor(() => expect(screen.getByLabelText('模型')).toHaveValue('gpt-5.4'));
    await waitFor(() => expect(screen.getByLabelText('沙箱')).toHaveValue('danger-full-access'));
    await waitFor(() => expect(screen.getByLabelText('交互桥')).toHaveValue('tmux'));
    fireEvent.click(screen.getByRole('button', { name: /保存控制/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(
          ([url, init]) =>
            url === '/api/sessions/sess-1/controls' &&
            (init as RequestInit | undefined)?.method === 'PATCH',
        );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toMatchObject({
        model: 'gpt-5.4',
        sandbox_mode: 'danger-full-access',
        interaction_bridge: 'tmux',
        yolo: true,
      });
    });
  });

  it('applies a full-access codex control preset in one action', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /应用全权限/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/controls',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            sandbox_mode: 'danger-full-access',
            approval_mode: 'never',
            permission_mode: 'bypassPermissions',
            yolo: true,
          }),
        }),
      );
    });
    expect(await screen.findByText(/已切换为全权限/)).toBeInTheDocument();
  });

  it('sends plan replies as a backend-managed mode instead of prompt wrapping', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '计划' }));
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '优化消息流' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      expect(call?.[1]?.method).toBe('POST');
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toEqual({ prompt: '优化消息流', reply_mode: 'plan' });
    });
  });

  it('keeps the reply composer icon-only while preserving multiline replies', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '换行' })).not.toBeInTheDocument();
    expect(screen.queryByText('图片')).not.toBeInTheDocument();
    expect(screen.queryByText('语音')).not.toBeInTheDocument();
    expect(screen.queryByText('发送')).not.toBeInTheDocument();

    const replyInput = screen.getByLabelText('回复当前会话');
    fireEvent.change(replyInput, { target: { value: '第一行\n第二行' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toEqual({ prompt: '第一行\n第二行' });
    });
  });

  it('uses AgentHub-specific mobile navigation with real Files Workers and Me panes', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'MainPC',
              os: 'windows',
              worker_version: '527e7b0',
              connection_mode: 'private',
              transport_state: 'polling',
              reachable_backends: ['codex', 'claude', 'kimi'],
              workspace_roots: ['E:/work/AgentHub'],
              capabilities: { codex: true, claude: true, kimi: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [queuedInputJob] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const mobileNav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    expect(within(mobileNav).getByRole('button', { name: '会话' })).toBeInTheDocument();
    expect(within(mobileNav).getByRole('button', { name: '对话' })).toBeInTheDocument();
    expect(within(mobileNav).getByRole('button', { name: '文件' })).toBeInTheDocument();
    expect(within(mobileNav).getByRole('button', { name: '节点' })).toBeInTheDocument();
    expect(within(mobileNav).getByRole('button', { name: '我的' })).toBeInTheDocument();

    fireEvent.click(within(mobileNav).getByRole('button', { name: '文件' }));
    expect(await screen.findByRole('heading', { name: '文件浏览器' })).toBeInTheDocument();
    expect(screen.getByText('E:/work/AgentHub')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制 file path' })).toBeInTheDocument();

    fireEvent.click(within(mobileNav).getByRole('button', { name: '节点' }));
    expect(await screen.findByRole('heading', { name: '节点诊断' })).toBeInTheDocument();
    const workersPane = screen.getByLabelText('节点');
    expect(within(workersPane).getByText('win-main')).toBeInTheDocument();
    expect(within(workersPane).getByText(/527e7b0/)).toBeInTheDocument();
    expect(within(workersPane).getByText(/排队 1/)).toBeInTheDocument();

    fireEvent.click(within(mobileNav).getByRole('button', { name: '我的' }));
    expect(await screen.findByRole('heading', { name: '设备与更新' })).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText(/节点：1\/1 在线/)).toBeInTheDocument();
  });

  it('checks and downloads the production APK from the mobile Me update center', async () => {
    const downloadLatestApk = vi.fn().mockReturnValue('enqueued:42');
    vi.stubGlobal('AgentHubAndroid', {
      appVersionName: () => '1.4',
      appVersionCode: () => 5,
      downloadLatestApk,
      startNotificationService: () => true,
    });
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) {
        return jsonResponse({
          items: [
            {
              worker_id: 'win-main',
              machine_name: 'MainPC',
              os: 'windows',
              worker_version: '527e7b0',
              connection_mode: 'private',
              transport_state: 'polling',
              reachable_backends: ['codex', 'claude', 'kimi'],
              workspace_roots: ['E:/work/AgentHub'],
              capabilities: { codex: true, claude: true, kimi: true },
              status: 'online',
              last_heartbeat_at: '2026-04-26T10:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/downloads/agenthub-android-release.apk') && init?.method === 'HEAD') {
        return headResponse({
          'content-length': '4193987',
          'last-modified': 'Sun, 10 May 2026 06:23:42 GMT',
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我的/ }));
    expect(await screen.findByRole('heading', { name: '设备与更新' })).toBeInTheDocument();
    expect(screen.getByText(/当前 APK：1\.4 \(5\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
    expect(await within(screen.getByLabelText('我的')).findByText(/线上 APK：4\.0 MB/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下载最新 APK' }));
    await waitFor(() => {
      expect(downloadLatestApk).toHaveBeenCalledWith(expect.stringMatching(/\/downloads\/agenthub-android-release\.apk$/), 'agenthub-android-release.apk');
    });
    expect(await screen.findByText(/APK 下载已开始/)).toBeInTheDocument();
  });

  it('falls back to ranged GET metadata when APK HEAD checks are blocked', async () => {
    vi.stubGlobal('AgentHubAndroid', {
      appVersionName: () => '1.4',
      appVersionCode: () => 5,
      downloadLatestApk: () => 'enqueued:42',
      startNotificationService: () => true,
    });
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/downloads/agenthub-android-release.apk') && init?.method === 'HEAD') {
        return headResponse({}, 405);
      }
      if (url.endsWith('/downloads/agenthub-android-release.apk') && init?.method === 'GET') {
        expect(init.headers).toMatchObject({ Range: 'bytes=0-0' });
        return headResponse({
          'content-length': '1',
          'content-range': 'bytes 0-0/4193987',
          'last-modified': 'Sun, 10 May 2026 06:23:42 GMT',
        }, 206);
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我的/ }));
    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }));

    expect(await within(screen.getByLabelText('我的')).findByText(/线上 APK：4\.0 MB/)).toBeInTheDocument();
  });

  it('falls back to the direct APK URL when Android DownloadManager cannot enqueue the update', async () => {
    const downloadLatestApk = vi.fn().mockReturnValue('failed:SecurityException:download blocked');
    const open = vi.fn();
    vi.stubGlobal('AgentHubAndroid', {
      appVersionName: () => '1.4',
      appVersionCode: () => 5,
      downloadLatestApk,
      startNotificationService: () => true,
    });
    vi.stubGlobal('open', open);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我的/ }));
    expect(await screen.findByRole('heading', { name: '设备与更新' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下载最新 APK' }));

    await waitFor(() => {
      expect(downloadLatestApk).toHaveBeenCalledWith(expect.stringMatching(/\/downloads\/agenthub-android-release\.apk$/), 'agenthub-android-release.apk');
      expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/downloads\/agenthub-android-release\.apk$/), '_blank', 'noopener,noreferrer');
    });
    expect(await screen.findByText(/原生下载启动失败，已打开 APK 下载地址/)).toBeInTheDocument();
  });

  it('lets users switch the mobile appearance from the Me pane', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我的/ }));

    expect(await screen.findByRole('heading', { name: '设备与更新' })).toBeInTheDocument();
    expect(document.querySelector('.app-shell')?.className).toContain('theme-light');

    fireEvent.click(screen.getByRole('button', { name: '深色' }));
    expect(document.querySelector('.app-shell')?.className).toContain('theme-dark');
    expect(localStorage.getItem('agenthub.theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: '浅色' }));
    expect(document.querySelector('.app-shell')?.className).toContain('theme-light');
    expect(localStorage.getItem('agenthub.theme')).toBe('light');
  });

  it('shows visible settings controls and lets users switch locale from the Me pane', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我的/ }));

    const mePane = await screen.findByLabelText('我的');
    expect(within(mePane).getByRole('heading', { name: '设备与更新' })).toBeInTheDocument();
    fireEvent.change(within(mePane).getAllByRole('combobox', { name: '界面语言' })[0], { target: { value: 'en-US' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Me' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Workers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Device & Updates' })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('agenthub.locale')).toBe('en-US'));

    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(await screen.findByText('Inbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search sessions, projects, or content')).toBeInTheDocument();
    expect(screen.getByText('Sort: recent activity')).toBeInTheDocument();
    expect(screen.queryByText('收件箱')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Workers' }));
    expect(await screen.findByRole('heading', { name: 'Worker Diagnostics' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(await screen.findByRole('heading', { name: 'File Browser' })).toBeInTheDocument();
    expect(screen.getByText('Workspace root')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    const englishMePane = await screen.findByLabelText('Me');
    fireEvent.change(within(englishMePane).getAllByRole('combobox', { name: 'Language' })[0], { target: { value: 'zh-TW' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '會話' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '我的' })).toBeInTheDocument();
    });
    expect(await screen.findByRole('heading', { name: '設備與更新' })).toBeInTheDocument();
    expect(within(await screen.findByLabelText('我的')).getAllByRole('combobox', { name: '界面語言' })[0]).toHaveValue(
      'zh-TW',
    );
    await waitFor(() => expect(localStorage.getItem('agenthub.locale')).toBe('zh-TW'));
  });

  it('lets admins save worker runtime defaults from the mobile settings pane', async () => {
    let runtimePatch: Record<string, unknown> | null = null;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/settings')) return jsonResponse(settingsPayload);
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/settings/worker-runtime')) {
        runtimePatch = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...settingsPayload,
          worker_runtime_defaults: {
            ...settingsPayload.worker_runtime_defaults,
            ...runtimePatch,
          },
        });
      }
      throw new Error(`Unhandled request: ${url}`);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /我的/ }));
    const mePane = await screen.findByLabelText('我的');
    fireEvent.change(within(mePane).getAllByRole('spinbutton', { name: '最大并发' })[0], { target: { value: '4' } });
    fireEvent.change(within(mePane).getAllByRole('spinbutton', { name: '拉取间隔(秒)' })[0], { target: { value: '9' } });
    fireEvent.change(within(mePane).getAllByRole('spinbutton', { name: '心跳间隔(秒)' })[0], { target: { value: '45' } });
    fireEvent.click(within(mePane).getAllByRole('button', { name: '保存 Worker 默认' })[0]);

    await waitFor(() => {
      expect(runtimePatch).toEqual({
        max_concurrent_jobs: 4,
        job_poll_interval_seconds: 9,
        heartbeat_interval_seconds: 45,
      });
    });
  });

  it('exposes a desktop theme switch in the top bar', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    expect(document.querySelector('.app-shell')?.className).toContain('theme-light');

    fireEvent.click(screen.getByRole('button', { name: '切换为深色模式' }));
    expect(document.querySelector('.app-shell')?.className).toContain('theme-dark');
    expect(localStorage.getItem('agenthub.theme')).toBe('dark');
  });

  it('browses nested workspace folders and previews downloadable files from the mobile Files pane', async () => {
    let currentJobs = [completedFileReadJob, completedFileListJob];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: currentJobs });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/files/list')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ path: 'src' }));
        currentJobs = [nestedFileListJob, ...currentJobs];
        return jsonResponse({ job: { ...nestedFileListJob, status: 'queued', result_text: null } });
      }
      if (url.endsWith('/api/sessions/sess-1/files/read')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ path: 'src/diagram.png', max_bytes: 5000000 }));
        currentJobs = [imageFileReadJob, ...currentJobs];
        return jsonResponse({ job: { ...imageFileReadJob, status: 'queued', result_text: null } });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({ ...sessionSyncPayload, jobs: currentJobs });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /文件/ }));

    expect(await screen.findByRole('heading', { name: '文件浏览器' })).toBeInTheDocument();
    expect(screen.getAllByText('README.md').length).toBeGreaterThan(0);
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('# AgentHub')).toBeInTheDocument();
    expect(screen.getAllByText('Native mobile file preview.').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '进入 src' }));
    expect(await screen.findByText('diagram.png')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '预览 diagram.png' }));
    expect(await screen.findByAltText('diagram.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载原图' })).toBeInTheDocument();
  });

  it('edits and saves a text file from the mobile Files pane', async () => {
    let currentJobs = [completedFileReadJob, completedFileListJob];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: currentJobs });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/files/write')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(
          JSON.stringify({
            path: 'README.md',
            text: '# AgentHub\n\nEdited on mobile.\n',
            expected_modified_at: '2026-04-26T10:11:00Z',
          }),
        );
        currentJobs = [completedFileWriteJob, ...currentJobs];
        return jsonResponse({ job: { ...completedFileWriteJob, status: 'queued', result_text: null } });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({ ...sessionSyncPayload, jobs: currentJobs });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /文件/ }));
    expect(await screen.findByRole('heading', { name: '文件浏览器' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑文本' }));
    expect(await screen.findByRole('dialog', { name: '文件编辑器' })).toBeInTheDocument();

    const editor = screen.getByLabelText('编辑文件内容');
    fireEvent.change(editor, { target: { value: '# AgentHub\n\nEdited on mobile.\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文件' }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url], index) => index > 0 && String(url).endsWith('/api/sessions/sess-1/files/write'));
      expect(call).toBeTruthy();
      expect(screen.getAllByText('Edited on mobile.').length).toBeGreaterThan(0);
    });
  });

  it('creates folders, renames files, and previews audio from the mobile Files pane', async () => {
    const initialListJob = {
      ...completedCommandJob,
      job_id: 'job-file-list-initial-workbench',
      kind: 'file_list',
      payload: { path: '.' },
      result_text: JSON.stringify({
        path: '.',
        workspace_root: 'E:/work/AgentHub',
        entries: [
          { name: 'README.md', path: 'README.md', kind: 'file', size_bytes: 2048, modified_at: '2026-04-26T10:02:00Z' },
          { name: 'voice.mp3', path: 'voice.mp3', kind: 'file', size_bytes: 4096, modified_at: '2026-04-26T10:03:00Z', preview_capability: 'audio' },
        ],
        truncated: false,
      }),
      updated_at: '2026-04-26T10:10:00Z',
    };
    const refreshedListJob = {
      ...completedCommandJob,
      job_id: 'job-file-list-refreshed-workbench',
      kind: 'file_list',
      payload: { path: '.' },
      result_text: JSON.stringify({
        path: '.',
        workspace_root: 'E:/work/AgentHub',
        entries: [
          { name: 'notes', path: 'notes', kind: 'directory', size_bytes: null, modified_at: '2026-04-26T10:15:00Z' },
          { name: 'GUIDE.md', path: 'GUIDE.md', kind: 'file', size_bytes: 2048, modified_at: '2026-04-26T10:16:00Z', preview_capability: 'markdown', is_editable: true },
          { name: 'voice.mp3', path: 'voice.mp3', kind: 'file', size_bytes: 4096, modified_at: '2026-04-26T10:03:00Z', preview_capability: 'audio' },
        ],
        truncated: false,
      }),
      updated_at: '2026-04-26T10:16:00Z',
    };
    const createdFolderJob = {
      ...completedCommandJob,
      job_id: 'job-file-mkdir-notes',
      kind: 'file_mkdir',
      payload: { path: 'notes' },
      result_text: JSON.stringify({
        path: 'notes',
        kind: 'directory',
        modified_at: '2026-04-26T10:15:00Z',
      }),
      updated_at: '2026-04-26T10:15:00Z',
    };
    const renamedFileJob = {
      ...completedCommandJob,
      job_id: 'job-file-rename-guide',
      kind: 'file_rename',
      payload: { path: 'README.md', new_path: 'GUIDE.md', expected_modified_at: '2026-04-26T10:11:00Z' },
      result_text: JSON.stringify({
        previous_path: 'README.md',
        path: 'GUIDE.md',
        filename: 'GUIDE.md',
        kind: 'file',
        content_type: 'text/plain',
        modified_at: '2026-04-26T10:16:00Z',
        preview_capability: 'markdown',
        is_editable: true,
      }),
      updated_at: '2026-04-26T10:16:00Z',
    };
    const renamedFileReadJob = {
      ...completedCommandJob,
      job_id: 'job-file-read-guide',
      kind: 'file_read',
      payload: { path: 'GUIDE.md', max_bytes: 5000000 },
      result_text: JSON.stringify({
        path: 'GUIDE.md',
        filename: 'GUIDE.md',
        content_type: 'text/plain',
        size_bytes: 128,
        truncated: false,
        modified_at: '2026-04-26T10:16:00Z',
        preview_kind: 'text',
        downloadable: true,
        text: '# Guide\n\nRenamed from README.',
      }),
      updated_at: '2026-04-26T10:16:00Z',
    };
    const audioReadJob = {
      ...completedCommandJob,
      job_id: 'job-file-read-audio',
      kind: 'file_read',
      payload: { path: 'voice.mp3', max_bytes: 5000000 },
      result_text: JSON.stringify({
        path: 'voice.mp3',
        filename: 'voice.mp3',
        content_type: 'audio/mpeg',
        size_bytes: 4096,
        truncated: false,
        preview_kind: 'audio',
        downloadable: true,
        data_base64: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//uQxAADBzQgAABEVVVVVVVVVVVVVVVVVQ==',
      }),
      updated_at: '2026-04-26T10:17:00Z',
    };

    let currentJobs = [completedFileReadJob, initialListJob];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: currentJobs });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/secrets')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/files/mkdir')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ path: 'notes' }));
        currentJobs = [createdFolderJob, refreshedListJob, ...currentJobs];
        return jsonResponse({ job: { ...createdFolderJob, status: 'queued', result_text: null } });
      }
      if (url.endsWith('/api/sessions/sess-1/files/list')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ path: '.' }));
        currentJobs = [refreshedListJob, ...currentJobs];
        return jsonResponse({ job: { ...refreshedListJob, status: 'queued', result_text: null } });
      }
      if (url.endsWith('/api/sessions/sess-1/files/rename')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(
          JSON.stringify({
            path: 'README.md',
            new_path: 'GUIDE.md',
            expected_modified_at: '2026-04-26T10:11:00Z',
          }),
        );
        currentJobs = [renamedFileJob, refreshedListJob, ...currentJobs];
        return jsonResponse({ job: { ...renamedFileJob, status: 'queued', result_text: null } });
      }
      if (url.endsWith('/api/sessions/sess-1/files/read')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.path === 'GUIDE.md') {
          currentJobs = [renamedFileReadJob, ...currentJobs];
          return jsonResponse({ job: { ...renamedFileReadJob, status: 'queued', result_text: null } });
        }
        if (body.path === 'voice.mp3') {
          currentJobs = [audioReadJob, ...currentJobs];
          return jsonResponse({ job: { ...audioReadJob, status: 'queued', result_text: null } });
        }
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({ ...sessionSyncPayload, jobs: currentJobs });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /文件/ }));
    expect(await screen.findByRole('heading', { name: '文件浏览器' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    const createFolderDialog = await screen.findByRole('dialog', { name: '新建文件夹' });
    fireEvent.change(within(createFolderDialog).getByRole('textbox', { name: '文件夹名' }), { target: { value: 'notes' } });
    fireEvent.click(within(createFolderDialog).getByRole('button', { name: '创建目录' }));
    expect(await screen.findByText('notes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开文件详情' }));
    const detailsDialog = await screen.findByRole('dialog', { name: '文件详情' });
    fireEvent.click(within(detailsDialog).getByRole('button', { name: '重命名' }));
    const renameDialog = await screen.findByRole('dialog', { name: '重命名' });
    fireEvent.change(within(renameDialog).getByRole('textbox', { name: '新名称' }), { target: { value: 'GUIDE.md' } });
    fireEvent.click(within(renameDialog).getByRole('button', { name: '确认重命名' }));
    expect(await screen.findByText('GUIDE.md')).toBeInTheDocument();
    expect((await screen.findAllByText('Renamed from README.')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '预览 voice.mp3' }));
    await waitFor(() => {
      expect(document.querySelector('.file-media-preview audio')).not.toBeNull();
    });
    expect(screen.getByRole('button', { name: '下载文件' })).toBeInTheDocument();
  });

  it('sends a generic file attachment with the next reply', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const file = new File(['hello api'], 'config.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('上传附件'), { target: { files: [file] } });

    expect(await screen.findByText('config.txt')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '用这个配置测试' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url], index) => index > 0 && String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toMatchObject({
        filename: 'config.txt',
        content_type: 'text/plain',
        data_base64: 'aGVsbG8gYXBp',
      });
    });
  });

  it('sends multiple uploaded images with the next reply', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
    const secondFile = new File([new Uint8Array([4, 5])], 'detail.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传图片'), { target: { files: [file, secondFile] } });

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    expect(await screen.findByText('detail.png')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '看一下图片' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url], index) => index > 0 && String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
      expect(body.attachments).toHaveLength(2);
      expect(body.attachments[0]).toMatchObject({
        filename: 'screen.png',
        content_type: 'image/png',
        data_base64: 'AQID',
      });
      expect(body.attachments[1]).toMatchObject({
        filename: 'detail.png',
        content_type: 'image/png',
        data_base64: 'BAU=',
      });
    });
  });

  it('attaches a pasted clipboard image with the next reply', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('回复当前会话'), {
      clipboardData: {
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        getData: () => '',
      },
    });

    expect(await screen.findByText('pasted-image-1.png')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '看一下粘贴的图片' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url], index) => index > 0 && String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toMatchObject({
        filename: 'pasted-image-1.png',
        content_type: 'image/png',
        data_base64: 'AQID',
      });
    });
  });

  it('deduplicates clipboard image attachments when browsers expose both items and files', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const filesEntry = new File([new Uint8Array([1, 2, 3])], 'duplicate.png', { type: 'image/png' });
    const itemsEntry = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' });
    fireEvent.paste(screen.getByLabelText('回复当前会话'), {
      clipboardData: {
        files: [filesEntry],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => itemsEntry }],
        getData: () => '',
      },
    });

    expect(await screen.findByText('duplicate.png')).toBeInTheDocument();
    expect(screen.queryAllByText('duplicate.png')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '看一下重复粘贴' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url], index) => index > 0 && String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
      expect(body.attachments).toHaveLength(1);
    });
  });

  it('infers image mime type from the filename when the picker omits it', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/input')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toMatchObject({
          prompt: '',
          attachments: [{ filename: 'screen.png', content_type: 'image/png', data_base64: 'AQID' }],
        });
        return jsonResponse({ job: { job_id: 'job-image-mime-1', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png');
    fireEvent.change(screen.getByLabelText('上传图片'), { target: { files: [file] } });

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/input',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('merges uploaded image optimistic replies with the server timeline after refresh', async () => {
    let timelineFetchCount = 0;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetchCount += 1;
        if (timelineFetchCount === 1) return jsonResponse(timelinePayload);
        return jsonResponse({
          items: [
            ...timelinePayload.items,
            {
              session_id: 'sess-1',
              seq: 3,
              item_type: 'user_message',
              role: 'user',
              text: '看一下图片',
              payload: {
                source: 'session_input',
                job_id: 'job-image-1',
                attachments: [{ filename: 'screen.png', content_type: 'image/png', size_bytes: 3 }],
              },
              created_at: '2026-04-26T10:01:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        expect(JSON.parse(String(init?.body ?? '{}'))).toMatchObject({
          prompt: '看一下图片',
          attachments: [{ filename: 'screen.png', content_type: 'image/png', data_base64: 'AQID' }],
        });
        return jsonResponse({ job: { job_id: 'job-image-1', status: 'queued' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传图片'), { target: { files: [file] } });
    expect(await screen.findByText('screen.png')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '看一下图片' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => expect(screen.getByText(/已入队|已排队/)).toBeInTheDocument());
    const transcript = screen.getByLabelText('Transcript');
    await waitFor(() => {
      expect(within(transcript).getAllByText('看一下图片')).toHaveLength(1);
      expect(within(transcript).getByText('screen.png')).toBeInTheDocument();
    });
  });

  it('waits for image preparation before allowing the next reply to send', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], 'slow-screen.png', { type: 'image/png' });
    let resolveArrayBuffer: ((buffer: ArrayBuffer) => void) | undefined;
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(
      new Promise<ArrayBuffer>((resolve) => {
        resolveArrayBuffer = resolve;
      }),
    );

    fireEvent.change(screen.getByLabelText('上传图片'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '看一下这张图' } });

    const sendButton = screen.getByRole('button', { name: /发送/ });
    expect(sendButton).toBeDisabled();
    expect(screen.getByText(/正在处理图片/)).toBeInTheDocument();

    fireEvent.click(sendButton);
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url).endsWith('/api/sessions/sess-1/input')),
    ).toBeFalsy();

    resolveArrayBuffer?.(new Uint8Array([1, 2, 3]).buffer);

    expect(await screen.findByText('slow-screen.png')).toBeInTheDocument();
    await waitFor(() => expect(sendButton).toBeEnabled());

    fireEvent.click(sendButton);

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url], index) => index > 0 && String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.[1]?.body ?? '{}'));
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]).toMatchObject({
        filename: 'slow-screen.png',
        content_type: 'image/png',
        data_base64: 'AQID',
      });
    });
  });

  it('keeps loaded older history and pagination state across a background refresh', async () => {
    const firstPage = {
      items: [
        {
          session_id: 'sess-1',
          seq: 10,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '当前消息 10',
          created_at: '2026-04-26T10:10:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 11,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '当前消息 11',
          created_at: '2026-04-26T10:11:00Z',
        },
      ],
      has_more: true,
    };
    const olderPage = {
      items: [
        {
          session_id: 'sess-1',
          seq: 8,
          item_type: 'user_message',
          role: 'user',
          text: '更早消息 8',
          created_at: '2026-04-26T10:08:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 9,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '更早消息 9',
          created_at: '2026-04-26T10:09:00Z',
        },
      ],
      has_more: false,
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.includes('/api/sessions/sess-1/timeline?before_created_at=') && url.includes('before_seq=10')) {
        return jsonResponse(olderPage);
      }
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(firstPage);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('当前消息 11')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /加载更早历史/ }));

    expect(await screen.findByText('更早消息 8')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /加载更早历史/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));

    await waitFor(() => expect(screen.getByText(/后台刷新完成/)).toBeInTheDocument());
    expect(screen.getByText('更早消息 8')).toBeInTheDocument();
    expect(screen.getByText('当前消息 11')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /加载更早历史/ })).toBeNull();
  });

  it('preserves unsaved title and control drafts during refresh', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        return jsonResponse({
          items: [
            {
              ...sessionPayload.items[0],
              controls: { model: 'gpt-5.2' },
            },
          ],
        });
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const titleInput = (await screen.findByLabelText('会话标题')) as HTMLInputElement;
    const modelSelect = (await screen.findByLabelText('模型')) as HTMLSelectElement;

    fireEvent.change(titleInput, { target: { value: '还没保存的新标题' } });
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.4' } });
    expect(titleInput).toHaveValue('还没保存的新标题');
    expect(modelSelect).toHaveValue('gpt-5.4');

    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));

    await waitFor(() => expect(screen.getByText(/后台刷新完成/)).toBeInTheDocument());
    expect(titleInput).toHaveValue('还没保存的新标题');
    expect(modelSelect).toHaveValue('gpt-5.4');
  });

  it('records voice, keeps typed text editable during transcription, and appends the result', async () => {
    let resolveVoice: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/transcribe')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return new Promise((resolve) => {
          resolveVoice = () => resolve(response({ text: '语音转文字结果' }));
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {}
      start() {}
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    expect(await screen.findByText(/追加到当前输入末尾/)).toBeInTheDocument();
    expect(screen.queryByText('识别中')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '手动输入' } });
    expect(screen.getByRole('button', { name: /发送/ })).toBeDisabled();

    resolveVoice?.();

    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('手动输入\n语音转文字结果'));
    expect(screen.getByRole('button', { name: /发送/ })).toBeEnabled();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('records voice in assistant mode and sends the transcript to the voice turn endpoint', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/transcribe')) {
        return jsonResponse({ text: '帮我继续推进这个任务' });
      }
      if (url.endsWith('/api/voice/turn')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({
          session_id: 'sess-1',
          utterance: '帮我继续推进这个任务',
          source: 'web',
        });
        return jsonResponse({
          spoken_text: '已发送给当前会话。',
          status: 'ok',
          actions: [{ tool: 'send_session_input', status: 'ok', job: { job_id: 'job-voice', status: 'queued' } }],
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) return jsonResponse(sessionSyncPayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '助手' }));
    fireEvent.click(screen.getByRole('button', { name: '语音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    await waitFor(() => expect(screen.getByText('已发送给当前会话。')).toBeInTheDocument());
    expect(screen.getByLabelText('回复当前会话')).toHaveValue('');
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/voice/turn', expect.objectContaining({ method: 'POST' }));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('starts true streaming voice mode from Doubao auth and appends the final transcript on stop', async () => {
    let stopStreaming: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/stream-auth')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({
          url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
          auth: {
            api_resource_id: 'volc.bigasr.sauc.duration',
            api_app_key: 'app-key',
            api_access_key: 'Jwt; token-123',
          },
          config: {
            user: { uid: 'owner@example.com' },
            audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
            request: { model_name: 'bigmodel', show_utterances: true },
          },
          expires_in_seconds: 300,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    voiceStreaming.startStreamingVoice.mockImplementation(async ({ onStart, onPartialText, onClose }) => {
      onStart?.();
      onPartialText?.('第一段', { result: { text: '第一段' } });
      stopStreaming = () => {
        onPartialText?.('第一段 第二段', { result: { text: '第一段 第二段' } });
        onClose?.();
      };
      return {
        stop: () => stopStreaming?.(),
      };
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流式' }));
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('第一段'));
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '手动输入\n第一段' } });
    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('手动输入\n第一段 第二段'));
    expect(voiceStreaming.startStreamingVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
        }),
      }),
    );
  });

  it('keeps manual edits during streaming voice and appends only the new suffix', async () => {
    let stopStreaming: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/stream-auth')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return jsonResponse({
          url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
          auth: {
            api_resource_id: 'volc.bigasr.sauc.duration',
            api_app_key: 'app-key',
            api_access_key: 'Jwt; token-123',
          },
          config: {
            user: { uid: 'owner@example.com' },
            audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
            request: { model_name: 'bigmodel', show_utterances: true },
          },
          expires_in_seconds: 300,
        });
      }
      return jsonResponse({}, 404);
    });
    voiceStreaming.startStreamingVoice.mockImplementation(async ({ onStart, onPartialText, onClose }) => {
      onStart?.();
      onPartialText?.('第一段', { result: { text: '第一段' } });
      stopStreaming = () => {
        onPartialText?.('第一段 第二段', { result: { text: '第一段 第二段' } });
        onClose?.();
      };
      return { stop: () => stopStreaming?.() };
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流式' }));
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('第一段'));
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: '第一段X' } });
    fireEvent.click(screen.getByRole('button', { name: '停止' }));

    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('第一段X 第二段'));
  });

  it('stops streaming voice before sending and submits the final transcript once', async () => {
    let stopStreaming: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/stream-auth')) {
        return jsonResponse({
          url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
          auth: {
            api_resource_id: 'volc.bigasr.sauc.duration',
            api_app_key: 'app-key',
            api_access_key: 'Jwt; token-123',
          },
          config: {
            user: { uid: 'owner@example.com' },
            audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
            request: { model_name: 'bigmodel', show_utterances: true },
          },
          expires_in_seconds: 300,
        });
      }
      if (url.endsWith('/api/sessions/sess-1/input')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ prompt: '第一段 第二段' });
        return jsonResponse({ job: { job_id: 'job-stream-send', status: 'queued' } });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) return jsonResponse(sessionSyncPayload);
      return jsonResponse({}, 404);
    });
    voiceStreaming.startStreamingVoice.mockImplementation(async ({ onStart, onPartialText, onClose }) => {
      onStart?.();
      onPartialText?.('第一段', { result: { text: '第一段' } });
      stopStreaming = () => {
        onPartialText?.('第一段 第二段', { result: { text: '第一段 第二段' } });
        onClose?.();
      };
      return { stop: () => stopStreaming?.() };
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '流式' }));
    fireEvent.click(screen.getByRole('button', { name: '语音' }));
    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('第一段'));

    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/input',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(screen.getByLabelText('回复当前会话')).toHaveValue('');
  });

  it('does not enqueue native fast state refresh just by opening a codex session', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    const fastRefreshCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/api/sessions/sess-1/fast/refresh'));
    expect(fastRefreshCalls).toHaveLength(0);
  });

  it('refreshes native fast state through selected session delta without a heavy session reload', async () => {
    const counters = {
      sessions: 0,
      fastRefresh: 0,
      sessionDelta: 0,
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/settings')) return jsonResponse(settingsPayload);
      if (url.endsWith('/api/sessions')) {
        counters.sessions += 1;
        return jsonResponse(sessionPayload);
      }
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/fast/refresh')) {
        counters.fastRefresh += 1;
        return jsonResponse({
          job: { job_id: 'job-fast-refresh', kind: 'session_fast_state_refresh', status: 'queued' },
          session: sessionPayload.items[0],
        });
      }
      if (url.includes('/api/sync/session/sess-1')) {
        counters.sessionDelta += 1;
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            runtime_metadata: {
              fast_mode: {
                state: 'disabled',
                supported: true,
                observed_at: '2026-04-26T10:02:00Z',
              },
            },
          },
          jobs: [{ job_id: 'job-fast-refresh', kind: 'session_fast_state_refresh', status: 'succeeded' }],
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /模型与工具/ }));
    fireEvent.click(await screen.findByRole('button', { name: '同步快速状态' }));

    await waitFor(() => {
      expect(counters.fastRefresh).toBe(1);
      expect(counters.sessionDelta).toBeGreaterThanOrEqual(1);
    });
    expect(counters.sessions).toBe(1);
    await waitFor(() => expect(screen.getAllByText(/快速已关/).length).toBeGreaterThan(0));
  });

  it('does not render an extra fast hint line when the codex session is simply not in /fast', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    expect(screen.queryByText('当前不是 /fast')).not.toBeInTheDocument();
    expect(screen.queryByText('当前状态读不到，但可以强制切换一次')).not.toBeInTheDocument();
  });

  it('marks native fast mode unavailable when refresh fails because the thread cannot be resumed', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/settings')) return jsonResponse(settingsPayload);
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/sessions/sess-1/fast/refresh')) {
        return jsonResponse({
          job: { job_id: 'job-fast-refresh-fail', kind: 'session_fast_state_refresh', status: 'queued' },
          session: sessionPayload.items[0],
        });
      }
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          jobs: [
            {
              job_id: 'job-fast-refresh-fail',
              kind: 'session_fast_state_refresh',
              status: 'failed',
              error_text: "codex app-server thread/resume failed: {'code': -32600, 'message': 'thread not found'}",
            },
          ],
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /模型与工具/ }));
    fireEvent.click(await screen.findByRole('button', { name: '同步快速状态' }));

    await waitFor(() => expect(screen.getAllByText(/快速不可用/).length).toBeGreaterThan(0));
    expect(screen.queryByText('当前状态读不到，但可以强制切换一次')).not.toBeInTheDocument();
  });

  it('polls per-session delta endpoints and skips heavy refreshes on idle sync', async () => {
    const counters = {
      sessions: 0,
      workers: 0,
      jobs: 0,
      schedules: 0,
      providers: 0,
      permissions: 0,
      timeline: 0,
      inboxDelta: 0,
      permissionDelta: 0,
      sessionDelta: 0,
    };
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) {
        counters.sessions += 1;
        return jsonResponse(sessionPayload);
      }
      if (url.endsWith('/api/workers')) {
        counters.workers += 1;
        return jsonResponse({ items: [] });
      }
      if (url.endsWith('/api/jobs')) {
        counters.jobs += 1;
        return jsonResponse({ items: [] });
      }
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) {
        counters.schedules += 1;
        return jsonResponse({ items: [] });
      }
      if (url.endsWith('/api/providers')) {
        counters.providers += 1;
        return jsonResponse(providersPayload);
      }
      if (url.endsWith('/api/permissions')) {
        counters.permissions += 1;
        return jsonResponse({ items: [] });
      }
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        counters.timeline += 1;
        return jsonResponse(timelinePayload);
      }
      if (url.includes('/api/sync/inbox')) {
        counters.inboxDelta += 1;
        if (counters.inboxDelta < 2) return jsonResponse(inboxSyncPayload);
        return jsonResponse({
          ...inboxSyncPayload,
          cursor: '2026-04-26T10:02:00Z|sess-1',
          items: [{ ...sessionPayload.items[0], status: 'needs_reply', last_activity_at: '2026-04-26T10:02:00Z' }],
        });
      }
      if (url.includes('/api/sync/permissions')) {
        counters.permissionDelta += 1;
        return jsonResponse(permissionSyncPayload);
      }
      if (url.includes('/api/sync/session/sess-1')) {
        counters.sessionDelta += 1;
        if (counters.sessionDelta < 2) return jsonResponse(sessionSyncPayload);
        return jsonResponse({
          ...sessionSyncPayload,
          session: { ...sessionPayload.items[0], status: 'needs_reply', last_activity_at: '2026-04-26T10:02:00Z' },
          items: [
            {
              session_id: 'sess-1',
              seq: 3,
              item_type: 'assistant_message',
              role: 'assistant',
              text: '增量同步到了新回复',
              created_at: '2026-04-26T10:02:00Z',
            },
          ],
          next_after_seq: 3,
        });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    expect(counters.sessions).toBe(1);
    expect(counters.timeline).toBe(1);
    expect(counters.inboxDelta).toBe(0);

    fireEvent.focus(window);
    await waitFor(() => expect(counters.inboxDelta).toBeGreaterThanOrEqual(1));
    expect(counters.sessions).toBe(1);
    expect(counters.jobs).toBe(1);
    expect(counters.permissions).toBe(1);
    expect(counters.timeline).toBe(1);

    fireEvent.focus(window);
    await waitFor(() => {
      expect(counters.inboxDelta).toBeGreaterThanOrEqual(2);
      expect(counters.sessionDelta).toBeGreaterThanOrEqual(2);
    });
    expect(counters.sessions).toBe(1);
    expect(counters.timeline).toBe(1);
    expect(counters.providers).toBe(1);
    expect(screen.getByText('增量同步到了新回复')).toBeInTheDocument();
  });

  it('falls back to a full timeline refresh when session summary changes but delta items stay empty', async () => {
    let timelineFetches = 0;
    const staleTimeline = {
      items: [
        {
          session_id: 'sess-1',
          seq: 1,
          item_type: 'user_message',
          role: 'user',
          text: '先看看',
          created_at: '2026-04-26T10:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:01:00Z',
        },
      ],
    };
    const refreshedTimeline = {
      items: [
        staleTimeline.items[0],
        {
          ...staleTimeline.items[1],
          text: '最终回复已经到了',
          created_at: '2026-04-26T10:03:00Z',
        },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : staleTimeline);
      }
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:03:00Z|sess-1',
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '最终回复已经到了',
              last_activity_at: '2026-04-26T10:03:00Z',
            },
          ],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            status: 'needs_reply',
            last_message: '最终回复已经到了',
            last_activity_at: '2026-04-26T10:03:00Z',
          },
          items: [],
          next_after_seq: 2,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('最终回复已经到了')).toBeInTheDocument();
    expect(timelineFetches).toBeGreaterThan(1);
  });

  it('shows session metadata fallback when the selected timeline is stale after sync', async () => {
    const staleTimeline = {
      items: [
        {
          session_id: 'sess-1',
          seq: 1,
          item_type: 'user_message',
          role: 'user',
          text: '先看看',
          created_at: '2026-04-26T10:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:01:00Z',
        },
      ],
      next_after_seq: 2,
      next_after_cursor: '2026-04-26T10:01:00Z|2',
    };
    const syncedSession = {
      ...sessionPayload.items[0],
      status: 'needs_reply',
      last_message: '最终回复已经到了',
      last_activity_at: '2026-04-26T10:04:00Z',
      runtime_metadata: {
        messages: [
          {
            session_id: 'sess-1',
            seq: 99,
            role: 'assistant',
            kind: 'assistant_message',
            text: '最终回复已经到了',
            created_at: '2026-04-26T10:04:00Z',
          },
        ],
      },
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(staleTimeline);
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:04:00Z|sess-1',
          items: [syncedSession],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          session: syncedSession,
          items: [],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:01:00Z|2',
          has_more: false,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('最终回复已经到了')).toBeInTheDocument();
  });

  it('shows session metadata fallback when the summary changes at the same timestamp as the stale timeline', async () => {
    const staleTimeline = {
      items: [
        {
          session_id: 'sess-1',
          seq: 1,
          item_type: 'user_message',
          role: 'user',
          text: '先看看',
          created_at: '2026-04-26T10:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:01:00Z',
        },
      ],
      next_after_seq: 2,
      next_after_cursor: '2026-04-26T10:01:00Z|2',
    };
    const syncedSession = {
      ...sessionPayload.items[0],
      status: 'needs_reply',
      last_message: '最终回复已经到了',
      last_activity_at: '2026-04-26T10:01:00Z',
      runtime_metadata: {},
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(staleTimeline);
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:01:00Z|sess-1',
          items: [syncedSession],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          session: syncedSession,
          items: [],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:01:00Z|2',
          has_more: false,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('最终回复已经到了')).toBeInTheDocument();
  });

  it('shows session metadata fallback when newer tool activity makes the stale timeline look current', async () => {
    const staleTimeline = {
      items: [
        {
          session_id: 'sess-1',
          seq: 1,
          item_type: 'user_message',
          role: 'user',
          text: '先看看',
          created_at: '2026-04-26T10:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:01:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'tool_call',
          role: 'system',
          text: '后台执行中',
          created_at: '2026-04-26T10:06:00Z',
        },
      ],
      next_after_seq: 3,
      next_after_cursor: '2026-04-26T10:06:00Z|3',
    };
    const syncedSession = {
      ...sessionPayload.items[0],
      status: 'needs_reply',
      last_message: '最终回复已经到了',
      last_activity_at: '2026-04-26T10:04:00Z',
      runtime_metadata: {
        messages: [
          {
            session_id: 'sess-1',
            seq: 99,
            role: 'assistant',
            kind: 'assistant_message',
            text: '最终回复已经到了',
            created_at: '2026-04-26T10:04:00Z',
          },
        ],
      },
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(staleTimeline);
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:04:00Z|sess-1',
          items: [syncedSession],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          session: syncedSession,
          items: [],
          next_after_seq: 3,
          next_after_cursor: '2026-04-26T10:06:00Z|3',
          has_more: false,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('最终回复已经到了')).toBeInTheDocument();
  });

  it('falls back to a full timeline refresh when summary changes but delta only contains non-message activity', async () => {
    let timelineFetches = 0;
    const staleTimeline = {
      items: [
        {
          session_id: 'sess-1',
          seq: 1,
          item_type: 'user_message',
          role: 'user',
          text: '继续看看',
          created_at: '2026-04-26T10:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:01:00Z',
        },
      ],
      next_after_seq: 2,
      next_after_cursor: '2026-04-26T10:01:00Z|2',
    };
    const refreshedTimeline = {
      items: [
        ...staleTimeline.items,
        {
          session_id: 'sess-1',
          seq: 4,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '最终回复已经到了',
          created_at: '2026-04-26T10:04:00Z',
        },
      ],
      next_after_seq: 4,
      next_after_cursor: '2026-04-26T10:04:00Z|4',
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : staleTimeline);
      }
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:04:00Z|sess-1',
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '最终回复已经到了',
              last_activity_at: '2026-04-26T10:04:00Z',
            },
          ],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            status: 'needs_reply',
            last_message: '最终回复已经到了',
            last_activity_at: '2026-04-26T10:04:00Z',
          },
          items: [
            {
              session_id: 'sess-1',
              seq: 3,
              item_type: 'tool_result',
              role: 'tool',
              text: '[tool_result] 状态已更新',
              created_at: '2026-04-26T10:03:00Z',
            },
          ],
          next_after_seq: 3,
          next_after_cursor: '2026-04-26T10:03:00Z|3',
          has_more: false,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('最终回复已经到了')).toBeInTheDocument();
    expect(timelineFetches).toBeGreaterThan(1);
  });

  it('refreshes the selected timeline when only the list activity summary changes', async () => {
    let timelineFetches = 0;
    let inboxFetches = 0;
    let sessionDeltaFetches = 0;
    const staleTimeline = {
      items: [
        {
          session_id: 'sess-1',
          seq: 1,
          item_type: 'user_message',
          role: 'user',
          text: '继续看看',
          created_at: '2026-04-26T10:00:00Z',
          updated_at: '2026-04-26T10:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:01:00Z',
          updated_at: '2026-04-26T10:01:00Z',
        },
      ],
      next_after_seq: 2,
      next_after_cursor: '2026-04-26T10:01:00Z|2',
    };
    const refreshedTimeline = {
      items: [
        ...staleTimeline.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '最终回复已经到了',
          created_at: '2026-04-26T10:01:00Z',
          updated_at: '2026-04-26T10:01:30Z',
        },
      ],
      next_after_seq: 3,
      next_after_cursor: '2026-04-26T10:01:30Z|3',
    };
    const syncedSession = {
      ...sessionPayload.items[0],
      status: sessionPayload.items[0].status,
      last_message: '处理中',
      activity_summary: '等你回复：最终回复已经到了',
      last_activity_at: sessionPayload.items[0].last_activity_at,
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 2 ? refreshedTimeline : staleTimeline);
      }
      if (url.includes('/api/sync/inbox')) {
        inboxFetches += 1;
        return jsonResponse({
          cursor: '2026-04-26T10:01:00Z|sess-1',
          items: inboxFetches > 1 ? [syncedSession] : [],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        sessionDeltaFetches += 1;
        return jsonResponse({
          ...sessionSyncPayload,
          session: sessionDeltaFetches > 1 ? syncedSession : sessionPayload.items[0],
          items: [],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:01:00Z|2',
          has_more: false,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);
    await waitFor(() => expect(timelineFetches).toBe(2));
    expect(within(transcript).queryByText('最终回复已经到了')).toBeNull();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('最终回复已经到了')).toBeInTheDocument();
    expect(timelineFetches).toBeGreaterThan(2);
  });

  it('uses timeline cursors so same-seq thread updates arrive without leaving the session', async () => {
    let timelineFetches = 0;
    const sessionDeltaUrls: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelinePayload);
      }
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:03:00Z|sess-1',
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '同一条消息后来补全了',
              last_activity_at: '2026-04-26T10:03:00Z',
            },
          ],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        sessionDeltaUrls.push(url);
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            status: 'needs_reply',
            last_message: '同一条消息后来补全了',
            last_activity_at: '2026-04-26T10:03:00Z',
          },
          items: [
            {
              session_id: 'sess-1',
              seq: 2,
              item_type: 'assistant_message',
              role: 'assistant',
              text: '同一条消息后来补全了',
              created_at: '2026-04-26T10:00:00Z',
            },
          ],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:03:00Z|2',
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('<script>alert("xss")</script>')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('同一条消息后来补全了')).toBeInTheDocument();
    expect(timelineFetches).toBe(1);
    expect(sessionDeltaUrls.some((url) => decodeURIComponent(url).includes('cursor=2026-04-26T10:00:00Z|2'))).toBe(true);
  });

  it('derives a timeline cursor when preserved local inputs make seq order non-chronological', async () => {
    const nonChronologicalTimeline = {
      next_after_seq: 10,
      items: [
        {
          session_id: 'sess-1',
          seq: 2,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '处理中',
          created_at: '2026-04-26T10:00:00Z',
          updated_at: '2026-04-26T11:00:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 10,
          item_type: 'user_message',
          role: 'user',
          text: '旧的本地输入',
          created_at: '2026-04-26T09:00:00Z',
          updated_at: '2026-04-26T11:00:00Z',
        },
      ],
    };
    const sessionDeltaUrls: string[] = [];

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(nonChronologicalTimeline);
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T11:05:00Z|sess-1',
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '非单调 seq 后补回来的最终回复',
              last_activity_at: '2026-04-26T10:05:00Z',
            },
          ],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        sessionDeltaUrls.push(url);
        const decoded = decodeURIComponent(url);
        if (!decoded.includes('cursor=2026-04-26T11:00:00Z|10')) {
          return jsonResponse({
            ...sessionSyncPayload,
            items: [],
            next_after_seq: 10,
            has_more: false,
          });
        }
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            status: 'needs_reply',
            last_message: '非单调 seq 后补回来的最终回复',
            last_activity_at: '2026-04-26T10:05:00Z',
          },
          items: [
            {
              session_id: 'sess-1',
              seq: 2,
              item_type: 'assistant_message',
              role: 'assistant',
              text: '非单调 seq 后补回来的最终回复',
              created_at: '2026-04-26T10:05:00Z',
              updated_at: '2026-04-26T11:05:00Z',
            },
          ],
          next_after_seq: 10,
          next_after_cursor: '2026-04-26T11:05:00Z|2',
          has_more: false,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('处理中')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('非单调 seq 后补回来的最终回复')).toBeInTheDocument();
    expect(sessionDeltaUrls.some((url) => decodeURIComponent(url).includes('cursor=2026-04-26T11:00:00Z|10'))).toBe(true);
  });

  it('continues paginated session delta sync so replace publishes do not hide the latest message', async () => {
    const sessionDeltaUrls: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/inbox')) {
        return jsonResponse({
          cursor: '2026-04-26T10:04:00Z|sess-1',
          items: [
            {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '第二页才有的最终消息',
              last_activity_at: '2026-04-26T10:04:00Z',
            },
          ],
          removed_session_ids: [],
        });
      }
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        sessionDeltaUrls.push(url);
        const decoded = decodeURIComponent(url);
        if (decoded.includes('cursor=2026-04-26T10:03:00Z|200')) {
          return jsonResponse({
            ...sessionSyncPayload,
            session: {
              ...sessionPayload.items[0],
              status: 'needs_reply',
              last_message: '第二页才有的最终消息',
              last_activity_at: '2026-04-26T10:04:00Z',
            },
            items: [
              {
                session_id: 'sess-1',
                seq: 301,
                item_type: 'assistant_message',
                role: 'assistant',
                text: '第二页才有的最终消息',
                created_at: '2026-04-26T10:04:00Z',
              },
            ],
            next_after_seq: 301,
            next_after_cursor: '2026-04-26T10:04:00Z|301',
            has_more: false,
          });
        }
        return jsonResponse({
          ...sessionSyncPayload,
          session: {
            ...sessionPayload.items[0],
            status: 'needs_reply',
            last_message: '第二页才有的最终消息',
            last_activity_at: '2026-04-26T10:04:00Z',
          },
          items: [
            {
              session_id: 'sess-1',
              seq: 200,
              item_type: 'assistant_message',
              role: 'assistant',
              text: '第一页只有旧的中间消息',
              created_at: '2026-04-26T10:03:00Z',
            },
          ],
          next_after_seq: 200,
          next_after_cursor: '2026-04-26T10:03:00Z|200',
          has_more: true,
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('<script>alert("xss")</script>')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('第二页才有的最终消息')).toBeInTheDocument();
    expect(sessionDeltaUrls).toHaveLength(2);
    expect(sessionDeltaUrls.some((url) => decodeURIComponent(url).includes('cursor=2026-04-26T10:03:00Z|200'))).toBe(true);
  });

  it('refreshes the selected timeline when its sync digest changes even if delta is empty', async () => {
    let timelineFetches = 0;
    let statusFetches = 0;
    const refreshedTimeline = {
      next_after_seq: 3,
      next_after_cursor: '2026-04-26T10:04:00Z|3',
      items: [
        ...timelinePayload.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'assistant_message',
          role: 'assistant',
          text: 'digest 发现的新回复',
          created_at: '2026-04-26T10:04:00Z',
        },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : timelinePayload);
      }
      if (url.includes('/api/sync/status')) {
        statusFetches += 1;
        return jsonResponse({
          ...syncStatusPayload,
          selected_timeline_digest: statusFetches > 1 ? 'timeline-sess-1-v2' : 'timeline-sess-1-v1',
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          items: [],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:00:00Z|2',
          has_more: false,
        });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('<script>alert("xss")</script>')).toBeInTheDocument();

    fireEvent.focus(window);
    await waitFor(() => expect(statusFetches).toBe(1));
    fireEvent.focus(window);

    expect(await within(transcript).findByText('digest 发现的新回复')).toBeInTheDocument();
    expect(statusFetches).toBeGreaterThanOrEqual(2);
    expect(timelineFetches).toBeGreaterThan(1);
  });

  it('keeps the transcript pinned when digest refresh loads the latest reply', async () => {
    let timelineFetches = 0;
    let statusFetches = 0;
    let scrollHeight = 600;
    const refreshedTimeline = {
      next_after_seq: 3,
      next_after_cursor: '2026-04-26T10:04:00Z|3',
      items: [
        ...timelinePayload.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'assistant_message',
          role: 'assistant',
          text: 'digest 强刷补到的底部回复',
          created_at: '2026-04-26T10:04:00Z',
        },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        if (timelineFetches > 1) scrollHeight = 900;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : timelinePayload);
      }
      if (url.includes('/api/sync/status')) {
        statusFetches += 1;
        return jsonResponse({
          ...syncStatusPayload,
          selected_timeline_digest: statusFetches > 1 ? 'timeline-sess-1-v2' : 'timeline-sess-1-v1',
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          items: [],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:00:00Z|2',
          has_more: false,
        });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(transcript, 'scrollTop', { configurable: true, writable: true, value: 300 });
    fireEvent.scroll(transcript);

    fireEvent.focus(window);
    await waitFor(() => expect(statusFetches).toBe(1));
    fireEvent.focus(window);

    expect(await within(transcript).findByText('digest 强刷补到的底部回复')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Transcript').scrollTop).toBe(900));
    expect(timelineFetches).toBeGreaterThan(1);
  });

  it('refreshes the selected timeline when its sync digest changes even if delta has non-final items', async () => {
    let timelineFetches = 0;
    const refreshedTimeline = {
      next_after_seq: 4,
      next_after_cursor: '2026-04-26T10:04:00Z|4',
      items: [
        ...timelinePayload.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'tool_call',
          role: 'system',
          text: '工具结果：处理中',
          created_at: '2026-04-26T10:03:00Z',
        },
        {
          session_id: 'sess-1',
          seq: 4,
          item_type: 'assistant_message',
          role: 'assistant',
          text: 'digest 补回来的最终回复',
          created_at: '2026-04-26T10:04:00Z',
        },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : timelinePayload);
      }
      if (url.includes('/api/sync/status')) {
        return jsonResponse({
          ...syncStatusPayload,
          selected_timeline_digest: 'timeline-sess-1-v2',
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          items: [
            {
              session_id: 'sess-1',
              seq: 3,
              item_type: 'tool_call',
              role: 'system',
              text: '工具结果：处理中',
              created_at: '2026-04-26T10:03:00Z',
            },
          ],
          next_after_seq: 3,
          next_after_cursor: '2026-04-26T10:03:00Z|3',
          has_more: false,
        });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('<script>alert("xss")</script>')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('digest 补回来的最终回复')).toBeInTheDocument();
    expect(timelineFetches).toBeGreaterThan(1);
  });

  it('refreshes an already loaded selected timeline on the first digest check', async () => {
    let timelineFetches = 0;
    const refreshedTimeline = {
      next_after_seq: 3,
      next_after_cursor: '2026-04-26T10:04:00Z|3',
      items: [
        ...timelinePayload.items,
        {
          session_id: 'sess-1',
          seq: 3,
          item_type: 'assistant_message',
          role: 'assistant',
          text: '第一次 digest 检查补回来的回复',
          created_at: '2026-04-26T10:04:00Z',
        },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) {
        timelineFetches += 1;
        return jsonResponse(timelineFetches > 1 ? refreshedTimeline : timelinePayload);
      }
      if (url.includes('/api/sync/status')) {
        return jsonResponse({
          ...syncStatusPayload,
          selected_timeline_digest: 'timeline-sess-1-current',
        });
      }
      if (url.includes('/api/sync/inbox')) return jsonResponse(inboxSyncPayload);
      if (url.includes('/api/sync/permissions')) return jsonResponse(permissionSyncPayload);
      if (url.includes('/api/sync/session/sess-1')) {
        return jsonResponse({
          ...sessionSyncPayload,
          items: [],
          next_after_seq: 2,
          next_after_cursor: '2026-04-26T10:00:00Z|2',
          has_more: false,
        });
      }
      return jsonResponse({}, 404);
    });

    render(<App />);

    const transcript = await screen.findByLabelText('Transcript');
    expect(within(transcript).getByText('<script>alert("xss")</script>')).toBeInTheDocument();

    fireEvent.focus(window);

    expect(await within(transcript).findByText('第一次 digest 检查补回来的回复')).toBeInTheDocument();
    expect(timelineFetches).toBeGreaterThan(1);
  });

  it('flushes recorder data before stop so Android WebView does not lose the final audio chunk', async () => {
    let resolveVoice: (() => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/transcribe')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.data_base64).toBe('BAU=');
        expect(body.chunk_count).toBe(1);
        expect(body.duration_ms).toEqual(expect.any(Number));
        return new Promise((resolve) => {
          resolveVoice = () => resolve(response({ text: '补齐最后一段' }));
        });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    let requestDataCalls = 0;
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      mimeType = 'audio/webm';
      start() {}
      requestData() {
        requestDataCalls += 1;
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
      }
      stop() {
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    expect(requestDataCalls).toBe(1);
    expect(await screen.findByText(/追加到当前输入末尾/)).toBeInTheDocument();

    resolveVoice?.();

    await waitFor(() => expect(screen.getByLabelText('回复当前会话')).toHaveValue('补齐最后一段'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('explains long voice upload network failures instead of showing raw fetch errors', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/transcribe')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {}
      start() {}
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    expect(await screen.findByText(/语音上传失败/)).toBeInTheDocument();
    expect(screen.getByText(/分段录音/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('explains silent browser recordings with a microphone-specific notice', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/voice/transcribe')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        return Promise.reject(new Error('Doubao ASR query status: 20000003: [Normal silence audio] Handle response: no valid speech in audio'));
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {}
      start() {}
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    expect(await screen.findByText(/静音、音量太小/)).toBeInTheDocument();
    expect(screen.getByText(/系统默认输入设备/)).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('starts voice recording with default recorder options when no MIME type is supported', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => false;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      mimeType = '';
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        if (options?.mimeType) throw new Error(`unsupported mime: ${options.mimeType}`);
      }
      start() {}
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    expect(await screen.findByRole('button', { name: '停止' })).toBeEnabled();
  });

  it('uses processed browser audio constraints for standard web recording', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it('reports recorder setup errors separately from microphone permission errors', async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    class MockMediaRecorder {
      static isTypeSupported = () => true;
      constructor() {
        throw Object.assign(new Error('Android WebView recorder refused'), { name: 'SecurityError' });
      }
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    expect(await screen.findByText(/录音初始化失败/)).toBeInTheDocument();
    expect(screen.queryByText(/麦克风权限未开启/)).not.toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled();
  });

  it('asks the Android shell for microphone permission before opening WebView audio capture', async () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('MediaRecorder', class MockMediaRecorder {});
    const requestMicrophonePermission = vi.fn().mockReturnValue(false);
    vi.stubGlobal('AgentHubAndroid', {
      microphonePermissionState: () => 'denied',
      requestMicrophonePermission,
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    expect(await screen.findByText(/已向安卓请求麦克风权限/)).toBeInTheDocument();
    expect(requestMicrophonePermission).toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('shows WebView denial details when Android microphone permission is already granted', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(
      Object.assign(new Error('Permission denied by WebView'), { name: 'NotAllowedError' }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('MediaRecorder', class MockMediaRecorder {});
    vi.stubGlobal('AgentHubAndroid', {
      microphonePermissionState: () => 'granted',
      requestMicrophonePermission: () => true,
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    expect(await screen.findByText(/App 权限已开启/)).toBeInTheDocument();
    expect(screen.getByText(/Permission denied by WebView/)).toBeInTheDocument();
  });

  it('shows a stable microphone permission notice when Android denies recording', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('MediaRecorder', class MockMediaRecorder {});

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '语音' }));

    expect(await screen.findByText(/麦克风权限未开启/)).toBeInTheDocument();
    expect(screen.getByText(/系统设置/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '语音' })).toBeEnabled();
  });

  it('keeps long status notices out of the compact reply action row', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });
    nativeNotifications.requestNativeNotificationPermission.mockResolvedValue('denied');
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /通知/ }));

    expect(await screen.findByText(/安卓系统通知被拒绝/)).toBeInTheDocument();
    expect(document.querySelector('.reply-box .reply-status')).toHaveTextContent('安卓系统通知被拒绝');
    expect(document.querySelector('.reply-box .reply-actions > span')).toBeNull();
  });

  it('sends http urls as plain JSON text without stripping query strings or fragments', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复当前会话'), { target: { value: urlProbePrompt } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      const call = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(([url]) => String(url).endsWith('/api/sessions/sess-1/input'));
      expect(call).toBeTruthy();
      expect(call?.[1]?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(call?.[1]?.body ?? '{}'))).toEqual({ prompt: urlProbePrompt });
    });
  });

  it('renders question choices and answers with the selected option', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(choicePermissionsPayload);
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/permissions/perm-choice-1/respond')) {
        expect(init?.body).toBe(JSON.stringify({ action: 'answer', response: { choice: 'plan', label: '先列计划' } }));
        return jsonResponse({ permission: { ...choicePermissionsPayload.items[0], status: 'answered' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    await waitFor(() => expect(screen.getAllByText('选择下一步执行方式').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: '先列计划' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/permissions/perm-choice-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('renders request_user_input as grouped questions and submits all selected answers', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(multiQuestionPermissionsPayload);
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/permissions/perm-multi-1/respond')) {
        expect(init?.body).toBe(
          JSON.stringify({
            action: 'answer',
            response: {
              answers: {
                maintenance_window: {
                  choice: 'maintenance_window:1',
                  label: '只允许关应用',
                },
                docker_scope: {
                  choice: 'docker_scope:0',
                  label: '迁到 E 盘 (Recommended)',
                },
              },
            },
          }),
        );
        return jsonResponse({ permission: { ...multiQuestionPermissionsPayload.items[0], status: 'answered' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByText('Docker/WSL')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '只允许关应用' }));
    fireEvent.click(screen.getByRole('button', { name: '迁到 E 盘 (Recommended)' }));
    fireEvent.click(screen.getByRole('button', { name: '提交选择' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/permissions/perm-multi-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('pins plan-exit interactions above the transcript and submits the selected action', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(planExitPermissionsPayload);
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.endsWith('/api/permissions/perm-plan-exit-1/respond')) {
        expect(init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-1' });
        expect(init?.body).toBe(JSON.stringify({ action: 'answer', response: { choice: 'implement', label: '执行计划' } }));
        return jsonResponse({ permission: { ...planExitPermissionsPayload.items[0], status: 'answered' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    const active = screen.getByLabelText('当前待处理交互');
    expect(within(active).getByText('计划已生成')).toBeInTheDocument();
    expect(within(active).getByText(/建 interaction bus/)).toBeInTheDocument();
    expect(within(active).queryByText(/proposed_plan/)).not.toBeInTheDocument();

    const transcript = screen.getByLabelText('Transcript');
    expect(transcript.contains(active)).toBe(true);

    fireEvent.click(within(active).getByRole('button', { name: '执行计划' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/permissions/perm-plan-exit-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('renders request_user_input tool calls as readable grouped questions instead of raw JSON', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(requestUserInputTimelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    await screen.findByRole('heading', { name: '修复移动控制台' });
    fireEvent.click(within(document.querySelector('.timeline-tabs') as HTMLElement).getByRole('button', { name: /工具/ }));
    expect(await screen.findByText('维护窗口')).toBeInTheDocument();
    expect(screen.getByText('Docker/WSL')).toBeInTheDocument();
    expect(screen.getByText('迁到 E 盘 (Recommended)')).toBeInTheDocument();
    expect(screen.getByText(/这是历史记录，当前没有可处理交互/)).toBeInTheDocument();
    expect(screen.queryByText(/"questions"/)).toBeNull();
  });

  it('lets pending request_user_input cards in the message stream submit answers including the freeform option', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf-1' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse(multiQuestionPermissionsPayload);
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(requestUserInputTimelinePayload);
      if (url.endsWith('/api/permissions/perm-multi-1/respond')) {
        expect(init?.body).toBe(
          JSON.stringify({
            action: 'answer',
            response: {
              answers: {
                maintenance_window: {
                  choice: 'maintenance_window:1',
                  label: '只允许关应用',
                },
                docker_scope: {
                  choice: 'docker_scope:0',
                  label: '迁到 E 盘 (Recommended)',
                },
              },
            },
          }),
        );
        return jsonResponse({ permission: { ...multiQuestionPermissionsPayload.items[0], status: 'answered' } });
      }
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);

    let timelineCard: HTMLElement | null = null;
    await waitFor(() => {
      timelineCard = document.querySelector<HTMLElement>('.request-input-detail');
      expect(timelineCard).toBeTruthy();
    });
    if (!timelineCard) throw new Error('request_user_input timeline card not found');
    const card = within(timelineCard);
    expect(card.getAllByRole('button', { name: '其他' }).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(card.getByRole('button', { name: '只允许关应用' }));
    fireEvent.click(card.getByRole('button', { name: '迁到 E 盘 (Recommended)' }));
    fireEvent.click(card.getByRole('button', { name: '提交选择' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/permissions/perm-multi-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('hides admin controls from viewers', async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) {
        return jsonResponse({ user: { email: 'viewer@example.com', role: 'viewer' }, csrf_token: 'csrf-viewer' });
      }
      if (url.endsWith('/api/sessions')) return jsonResponse(sessionPayload);
      if (url.endsWith('/api/workers')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/jobs')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/events')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/schedules')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/providers')) return jsonResponse(providersPayload);
      if (url.endsWith('/api/permissions')) return jsonResponse({ items: [] });
      if (url.endsWith('/api/sessions/sess-1/timeline')) return jsonResponse(timelinePayload);
      if (url.includes('/api/sync/status')) return jsonResponse(syncStatusPayload);
      return jsonResponse({}, 404);
    });

    render(<App />);
    expect(await screen.findByText('会话收件箱')).toBeInTheDocument();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(screen.queryByText('邀请用户')).toBeNull();
  });

  it('renders a compact island view that can operate a session without exposing raw ids', async () => {
    const showMain = vi.fn();
    vi.stubGlobal('agentHubDesktop', { showMain });
    window.history.pushState({}, '', '/?view=island');

    render(<App />);

    expect(await screen.findByText('AgentHub Island')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '修复移动控制台' })).toBeInTheDocument();
    expect(screen.queryByText('sess-1')).toBeNull();
    expect(screen.getByText('等你回复：确认标题和摘要')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Quick reply'), { target: { value: '继续执行' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/sessions/sess-1/input',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /Open full console/ }));
    expect(showMain).toHaveBeenCalledTimes(1);
  });

  it('parses naive API timestamps as UTC instead of local browser time', () => {
    expect(parseApiDate('2026-04-27 16:58:30.534179')?.toISOString()).toBe('2026-04-27T16:58:30.534Z');
    expect(parseApiDate('2026-04-27T16:58:30.534179')?.toISOString()).toBe('2026-04-27T16:58:30.534Z');
    expect(parseApiDate('2026-04-27T16:58:30.534Z')?.toISOString()).toBe('2026-04-27T16:58:30.534Z');
    expect(parseApiDate('2026-04-28T00:58:30+08:00')?.toISOString()).toBe('2026-04-27T16:58:30.000Z');
  });

  it('keeps newer same-seq timeline items when a stale response arrives later', () => {
    const stale = {
      session_id: 'sess-1',
      seq: 2,
      item_type: 'assistant_message' as const,
      role: 'assistant' as const,
      text: '处理中',
      tool_call_id: null,
      tool_name: null,
      status: null,
      payload: {},
      created_at: '2026-04-26T10:01:00Z',
      updated_at: '2026-04-26T10:01:00Z',
    };
    const newer = {
      ...stale,
      text: '最终回复已经到了',
      updated_at: '2026-04-26T10:04:00Z',
    };

    expect(mergeTimelineItems([newer], [stale]).find((item) => item.seq === 2)?.text).toBe('最终回复已经到了');
    expect(mergeTimelineItems([stale], [newer]).find((item) => item.seq === 2)?.text).toBe('最终回复已经到了');
  });
});
