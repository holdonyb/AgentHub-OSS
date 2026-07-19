import type { ReactElement } from 'react';
import { AgentHubApiError } from '@agenthub/client-core';
import type {
  NativeJob,
  NativeSessionSummary,
  NativeTaskDetail,
  NativeTaskSummary,
  NativeWorkerSummary,
} from '../api/mobileApi';
import { SessionsScreen } from './SessionsScreen';
import { FilesScreen } from './FilesScreen';
import { TasksScreen } from './TasksScreen';
import { WorkersScreen } from './WorkersScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('./useNativeVoiceRecorder', () => ({
  useNativeVoiceRecorder: () => ({
    durationMillis: 0,
    isRecording: false,
    startRecording: jest.fn(async () => undefined),
    stopRecording: jest.fn(async () => null),
  }),
}));

interface TestInstance {
  props: Record<string, unknown>;
  findByProps(props: Record<string, unknown>): TestInstance;
}

interface TestRenderer {
  root: TestInstance;
  toJSON(): unknown;
  unmount(): void;
  update(element: ReactElement): void;
}

interface TestRendererApi {
  act(callback: () => void | Promise<void>): void | Promise<void>;
  create(element: ReactElement): TestRenderer;
}

const { act, create } = jest.requireActual('react-test-renderer') as TestRendererApi;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mountedRenderers: TestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers.splice(0)) renderer.unmount();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function render(element: ReactElement): Promise<TestRenderer> {
  let renderer!: TestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  mountedRenderers.push(renderer);
  return renderer;
}

function renderPending(element: ReactElement): TestRenderer {
  let renderer!: TestRenderer;
  void act(() => {
    renderer = create(element);
  });
  mountedRenderers.push(renderer);
  return renderer;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderedText(renderer: TestRenderer): string {
  function collect(value: unknown): string[] {
    if (typeof value === 'string' || typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.flatMap(collect);
    if (typeof value !== 'object' || value === null) return [];
    return collect((value as { children?: unknown }).children);
  }
  return collect(renderer.toJSON()).join(' ').replace(/\s+/g, ' ').trim();
}

function press(instance: TestInstance): void {
  const onPress = instance.props.onPress;
  if (typeof onPress !== 'function') throw new Error('Expected a pressable test instance');
  onPress();
}

function changeText(instance: TestInstance, value: string): void {
  const onChangeText = instance.props.onChangeText;
  if (typeof onChangeText !== 'function') throw new Error('Expected a text input test instance');
  onChangeText(value);
}

const session: NativeSessionSummary = {
  session_id: 'session-1',
  title: '修复登录问题',
  backend: 'codex',
  worker_id: 'worker-main',
  status: 'needs_reply',
  last_activity_at: '2026-07-11T11:58:00.000Z',
};

function queuedJob(jobId: string, kind: string): NativeJob {
  return {
    job_id: jobId,
    kind,
    target_session_id: 'session-1',
    worker_id: 'worker-1',
    backend: 'codex',
    status: 'queued',
    error_text: null,
  };
}

const task: NativeTaskSummary = {
  task_id: 'task-1',
  title: '实现原生列表',
  brief_markdown: '接入真实 API 数据。',
  success_criteria_markdown: '- 列表可刷新\n- 错误可重试',
  status: 'working',
  priority: 50,
  target_worker_id: 'worker-main',
  backend: 'codex',
  workspace_root: 'E:/Work/AgentHub-OSS',
  latest_session_id: 'session-1',
  artifact_count: 1,
  updated_at: '2026-07-11T11:55:00.000Z',
  created_at: '2026-07-11T10:00:00.000Z',
};

const taskDetail: NativeTaskDetail = {
  task,
  artifacts: [
    {
      artifact_id: 'artifact-1',
      kind: 'test_result',
      title: '测试结果',
      path: 'reports/mobile-native.txt',
      content_markdown: '全部通过',
      created_at: '2026-07-11T11:56:00.000Z',
    },
  ],
  executions: [
    {
      execution_id: 'execution-1',
      attempt_number: 1,
      kind: 'dispatch',
      status: 'running',
      updated_at: '2026-07-11T11:55:00.000Z',
    },
  ],
};

const worker: NativeWorkerSummary = {
  worker_id: 'worker-main',
  machine_name: '开发工作站',
  os: 'windows',
  status: 'online',
  reachable_backends: ['codex', 'claude'],
  capabilities: { codex: true, claude: true, psmux: true },
  last_heartbeat_at: '2026-07-11T11:59:00.000Z',
};

function createSessionsApi(listSessions: jest.Mock) {
  return {
    getSession: jest.fn(async () => ({ session })),
    getSessionTimeline: jest.fn(async () => ({ items: [], has_more: false })),
    listJobs: jest.fn(async () => ({ items: [] })),
    listPermissions: jest.fn(async () => ({ items: [] })),
    listSessions,
    respondPermission: jest.fn(),
    sendSessionInput: jest.fn(),
    transcribeVoice: jest.fn(),
    terminateSession: jest.fn(),
  };
}

describe('native resource screens', () => {
  it('filters sessions with a native inbox search box and distinguishes empty matches from empty data', async () => {
    const listSessions = jest.fn(async () => ({
      items: [
        session,
        {
          ...session,
          session_id: 'session-2',
          title: '处理 Claude API 报错',
          backend: 'claude',
          worker_id: 'worker-claude',
          project_name: 'CourseAgent',
          workspace_root: 'E:/Work/CourseAgent',
          activity_summary: 'Invalid API key',
          last_message: '请检查 API key',
        },
      ],
    }));
    const renderer = await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
    await settle();

    expect(renderedText(renderer)).toContain('修复登录问题');
    expect(renderedText(renderer)).toContain('处理 Claude API 报错');

    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '搜索会话' }), 'claude');
    });
    expect(renderedText(renderer)).not.toContain('修复登录问题');
    expect(renderedText(renderer)).toContain('处理 Claude API 报错');

    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '搜索会话' }), '不存在的会话');
    });
    expect(renderedText(renderer)).toContain('没有匹配的会话');
    expect(renderedText(renderer)).not.toContain('处理 Claude API 报错');
  });

  it('loads and refreshes sessions without hiding current data', async () => {
    const initialRequest = deferred<{ items: NativeSessionSummary[] }>();
    const refreshRequest = deferred<{ items: NativeSessionSummary[] }>();
    const listSessions = jest
      .fn()
      .mockImplementationOnce(() => initialRequest.promise)
      .mockImplementationOnce(() => refreshRequest.promise);
    const renderer = renderPending(<SessionsScreen api={createSessionsApi(listSessions)} />);

    expect(renderedText(renderer)).toContain('正在加载会话');

    await act(async () => {
      initialRequest.resolve({ items: [session] });
      await initialRequest.promise;
    });
    expect(renderedText(renderer)).toContain('修复登录问题');
    expect(renderedText(renderer)).toContain('codex');
    expect(renderedText(renderer)).toContain('worker-main');
    expect(renderedText(renderer)).toContain('待回复');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '刷新会话' })));
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('修复登录问题');

    await act(async () => {
      refreshRequest.resolve({ items: [{ ...session, title: '登录问题已定位' }] });
      await refreshRequest.promise;
    });
    expect(renderedText(renderer)).toContain('登录问题已定位');
  });

  it('opens a dedicated session detail and returns to the inbox', async () => {
    const api = {
      getSession: jest.fn(async () => ({ session })),
      getSessionTimeline: jest.fn(async () => ({ items: [], has_more: false })),
      listJobs: jest.fn(async () => ({ items: [] })),
      listPermissions: jest.fn(async () => ({ items: [] })),
      listSessions: jest.fn(async () => ({ items: [session] })),
      respondPermission: jest.fn(),
      sendSessionInput: jest.fn(),
      transcribeVoice: jest.fn(),
      terminateSession: jest.fn(),
    };
    const renderer = await render(
      <SessionsScreen api={api} canTerminate csrfToken="csrf-token" />,
    );
    await settle();

    await act(async () => {
      press(renderer.root.findByProps({ accessibilityLabel: '打开会话 修复登录问题' }));
    });
    await settle();

    expect(renderedText(renderer)).toContain('会话详情');
    expect(renderedText(renderer)).toContain('暂无消息');
    expect(api.getSessionTimeline).toHaveBeenCalledWith('session-1');

    await act(async () => {
      press(renderer.root.findByProps({ accessibilityLabel: '返回会话列表' }));
    });
    expect(renderedText(renderer)).toContain('SESSION INBOX');
    expect(renderedText(renderer)).toContain('修复登录问题');
  });

  it('opens a session requested by a native notification', async () => {
    const api = createSessionsApi(jest.fn(async () => ({ items: [session] })));
    const onRequestedSessionHandled = jest.fn();
    const renderer = await render(
      <SessionsScreen
        api={api}
        requestedSessionId="session-1"
        onRequestedSessionHandled={onRequestedSessionHandled}
      />,
    );
    await settle();

    expect(api.getSession).toHaveBeenCalledWith('session-1');
    expect(renderedText(renderer)).toContain('会话详情');
    expect(onRequestedSessionHandled).toHaveBeenCalledWith('session-1');
  });

  it('can reopen the same session for a later notification', async () => {
    const api = createSessionsApi(jest.fn(async () => ({ items: [session] })));
    const props = { api, onRequestedSessionHandled: jest.fn() };
    const renderer = await render(
      <SessionsScreen {...props} requestedSessionId="session-1" />,
    );
    await settle();

    await act(async () => {
      renderer.update(<SessionsScreen {...props} requestedSessionId={null} />);
      press(renderer.root.findByProps({ accessibilityLabel: '返回会话列表' }));
    });
    await act(async () => {
      renderer.update(<SessionsScreen {...props} requestedSessionId="session-1" />);
    });
    await settle();

    expect(props.onRequestedSessionHandled).toHaveBeenCalledTimes(2);
  });

  it('shows session errors, retries, and then renders an empty state', async () => {
    const listSessions = jest
      .fn()
      .mockRejectedValueOnce(new Error('网络不可用'))
      .mockResolvedValueOnce({ items: [] });
    const renderer = await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
    await settle();

    expect(renderedText(renderer)).toContain('会话加载失败');
    expect(renderedText(renderer)).toContain('网络不可用');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '重试加载会话' })));
    await settle();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('暂无会话');
  });

  it('reports an expired API session to the auth route owner', async () => {
    const unauthorized = new AgentHubApiError({
      status: 401,
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
    const listSessions = jest.fn().mockRejectedValue(unauthorized);
    const onRequestError = jest.fn();
    await render(
      <SessionsScreen api={createSessionsApi(listSessions)} onRequestError={onRequestError} />,
    );
    await settle();

    expect(onRequestError).toHaveBeenCalledWith(unauthorized);
  });

  it('filters tasks and retries the selected task detail', async () => {
    const readyTask = { ...task, task_id: 'task-ready', title: '处理验收反馈', status: 'ready_to_review' as const };
    const blockedTask = { ...task, task_id: 'task-blocked', title: '等待用户审批', status: 'needs_approval' as const };
    const listTasks = jest.fn(async () => ({ items: [task, readyTask, blockedTask] }));
    const getTask = jest
      .fn()
      .mockRejectedValueOnce(new Error('详情暂不可用'))
      .mockResolvedValueOnce(taskDetail);
    const renderer = await render(
      <TasksScreen api={{ createTask: jest.fn(), getTask, listTasks, reviewTask: jest.fn() }} />,
    );
    await settle();

    expect(listTasks).toHaveBeenCalledWith(undefined);
    expect(renderedText(renderer)).toContain('任务收件箱');
    expect(renderedText(renderer)).toContain('待验收');
    expect(renderedText(renderer)).toContain('已阻塞');
    expect(renderedText(renderer)).toContain('执行中');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '筛选任务：执行中' })));
    await settle();
    expect(renderedText(renderer)).toContain('实现原生列表');
    expect(renderedText(renderer)).not.toContain('处理验收反馈');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 实现原生列表' })));
    await settle();
    expect(renderedText(renderer)).toContain('任务详情加载失败');
    expect(renderedText(renderer)).toContain('详情暂不可用');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '重试加载任务详情' })));
    await settle();
    expect(renderedText(renderer)).toContain('接入真实 API 数据。');
    expect(renderedText(renderer)).toContain('测试结果');
    expect(renderedText(renderer)).toContain('第 1 次执行');
  });

  it('clears tasks from the previous status when the new filter fails', async () => {
    const listTasks = jest
      .fn()
      .mockResolvedValueOnce({ items: [task] })
      .mockRejectedValueOnce(new Error('任务刷新失败'));
    const getTask = jest.fn();
    const renderer = await render(
      <TasksScreen api={{ createTask: jest.fn(), getTask, listTasks, reviewTask: jest.fn() }} />,
    );
    await settle();
    expect(renderedText(renderer)).toContain('实现原生列表');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '刷新任务' })));
    await settle();

    expect(renderedText(renderer)).toContain('任务刷新失败');
    expect(renderedText(renderer)).toContain('实现原生列表');
  });

  it('creates and dispatches a task from a mobile-first composer', async () => {
    const createdTask = {
      ...task,
      task_id: 'task-created',
      title: '修复消息同步',
      brief_markdown: '详情页应自动同步最终消息。',
      success_criteria_markdown: '- 无需退出详情页',
      status: 'queued' as const,
    };
    const listTasks = jest.fn(async () => ({ items: [] }));
    const createTask = jest.fn(async () => ({ task: createdTask }));
    const getTask = jest.fn(async () => ({ ...taskDetail, task: createdTask }));
    const reviewTask = jest.fn();
    const renderer = await render(
      <TasksScreen
        api={{ createTask, getTask, listTasks, reviewTask }}
        canOperate
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '新建任务' })));
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '任务标题' }), '修复消息同步');
      changeText(renderer.root.findByProps({ accessibilityLabel: '任务说明' }), '详情页应自动同步最终消息。');
      changeText(renderer.root.findByProps({ accessibilityLabel: '验收标准' }), '- 无需退出详情页');
      changeText(renderer.root.findByProps({ accessibilityLabel: '目标节点' }), 'worker-main');
      changeText(renderer.root.findByProps({ accessibilityLabel: '工作目录' }), 'E:/Work/AgentHub-OSS');
      changeText(renderer.root.findByProps({ accessibilityLabel: '相关路径' }), 'apps/mobile-native\napps/api');
    });
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '创建并派发任务' })));
    await settle();

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '修复消息同步',
        brief_markdown: '详情页应自动同步最终消息。',
        success_criteria_markdown: '- 无需退出详情页',
        target_worker_id: 'worker-main',
        backend: 'codex',
        workspace_root: 'E:/Work/AgentHub-OSS',
        relevant_paths: ['apps/mobile-native', 'apps/api'],
        submit: true,
      }),
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('修复消息同步');
    expect(renderedText(renderer)).toContain('详情页应自动同步最终消息。');
  });

  it('accepts or requests changes from a ready-to-review task detail', async () => {
    const reviewableTask = { ...task, status: 'ready_to_review' as const };
    const listTasks = jest.fn(async () => ({ items: [reviewableTask] }));
    const getTask = jest.fn(async () => ({ ...taskDetail, task: reviewableTask }));
    const reviewTask = jest.fn(async () => ({ task: { ...reviewableTask, status: 'accepted' as const } }));
    const createTask = jest.fn();
    const onOpenFile = jest.fn();
    const renderer = await render(
      <TasksScreen
        api={{ createTask, getTask, listTasks, reviewTask }}
        canOperate
        csrfToken="csrf-token"
        onOpenFile={onOpenFile}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 实现原生列表' })));
    await settle();
    expect(renderedText(renderer)).toContain('通过验收');
    expect(renderedText(renderer)).toContain('退回修改');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开产物文件 测试结果' })));
    expect(onOpenFile).toHaveBeenCalledWith({ sessionId: 'session-1', path: 'reports/mobile-native.txt' });

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '通过验收' })));
    await settle();

    expect(reviewTask).toHaveBeenCalledWith(
      'task-1',
      { action: 'accept', note_markdown: '' },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('已完成');
  });

  it('shows worker online state and opens provider readiness for the selected node', async () => {
    const listWorkers = jest.fn(async () => ({ items: [worker] }));
    const listProviderSnapshots = jest.fn(async () => ({
      items: [{
        worker_id: 'worker-main',
        backend: 'codex',
        status: 'ready',
        auth_status: 'ready',
        models: [{ id: 'gpt-5.4' }],
        modes: [{ id: 'plan', label: '计划' }],
        features: { image_input: true },
        diagnostics: {},
        fetched_at: '2026-07-19T00:00:00Z',
        updated_at: '2026-07-19T00:00:00Z',
      }],
    }));
    const renderer = await render(<WorkersScreen api={{ listProviderSnapshots, listWorkers }} />);
    await settle();

    expect(renderedText(renderer)).toContain('开发工作站');
    expect(renderedText(renderer)).toContain('在线');
    expect(renderedText(renderer)).toContain('codex');
    expect(renderedText(renderer)).toContain('claude');
    expect(renderedText(renderer)).toContain('psmux');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看节点 开发工作站' })));
    await settle();
    expect(renderedText(renderer)).toContain('Provider 状态');
    expect(renderedText(renderer)).toContain('gpt-5.4');
    expect(renderedText(renderer)).toContain('已就绪');
  });

  it('browses, reads, edits, and saves workspace text files', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const readSessionFile = jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') }));
    const writeSessionFile = jest.fn(async () => ({ job: queuedJob('write-job', 'file_write') }));
    const getSessionSync = jest
      .fn()
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'list-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: '.',
            workspace_root: 'E:/Work/AgentHub-OSS',
            entries: [
              { name: 'src', path: 'src', kind: 'directory', preview_capability: 'directory' },
              {
                name: 'README.md',
                path: 'README.md',
                kind: 'file',
                preview_capability: 'markdown',
                is_editable: true,
                size_bytes: 64,
              },
            ],
          }),
        }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'read-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: 'README.md',
            filename: 'README.md',
            content_type: 'text/markdown',
            size_bytes: 64,
            truncated: false,
            modified_at: '2026-07-12T00:00:00Z',
            preview_kind: 'text',
            text: '# AgentHub\n原始内容',
          }),
        }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'write-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: 'README.md',
            filename: 'README.md',
            content_type: 'text/markdown',
            size_bytes: 70,
            truncated: false,
            modified_at: '2026-07-12T00:01:00Z',
            preview_kind: 'text',
            text: '# AgentHub\n更新内容',
          }),
        }],
        has_more: false,
      });
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getSessionSync,
          listSessionFiles,
          listSessions,
          mkdirSessionDirectory: jest.fn(),
          readSessionFile,
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile,
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    expect(renderedText(renderer)).toContain('README.md');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 README.md' })));
    await settle();
    expect(renderedText(renderer)).toContain('原始内容');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '编辑文件' })));
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '文件内容' }), '# AgentHub\n更新内容');
    });
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '保存文件' })));
    await settle();

    expect(writeSessionFile).toHaveBeenCalledWith(
      'session-1',
      {
        path: 'README.md',
        text: '# AgentHub\n更新内容',
        expected_modified_at: '2026-07-12T00:00:00Z',
      },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('更新内容');
  });

  it('opens a requested local file target directly from a session path', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const readSessionFile = jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') }));
    const writeSessionFile = jest.fn(async () => ({ job: queuedJob('write-job', 'file_write') }));
    const getSessionSync = jest
      .fn()
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'list-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: '.',
            workspace_root: 'E:/Work/AgentHub-OSS',
            entries: [],
          }),
        }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'read-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: 'README.md',
            filename: 'README.md',
            content_type: 'text/markdown',
            size_bytes: 64,
            truncated: false,
            modified_at: '2026-07-18T00:00:00Z',
            preview_kind: 'text',
            text: '# AgentHub\n来自消息跳转',
          }),
        }],
        has_more: false,
      });

    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getSessionSync,
          listSessionFiles,
          listSessions,
          mkdirSessionDirectory: jest.fn(),
          readSessionFile,
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile,
        }}
        canEdit
        csrfToken="csrf-token"
        requestedTarget={{ sessionId: 'session-1', path: 'E:/Work/AgentHub-OSS/README.md' }}
      />,
    );
    await settle();
    await settle();
    await settle();

    expect(readSessionFile).toHaveBeenCalledWith(
      'session-1',
      { path: 'README.md', max_bytes: 5_000_000 },
      'csrf-token',
    );
  });

  it('creates a workspace file through the selected session instead of an unrestricted device path', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const createSessionFile = jest.fn(async () => ({ job: queuedJob('create-job', 'file_create') }));
    const getSessionSync = jest
      .fn()
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'list-job',
          status: 'succeeded',
          result_text: JSON.stringify({ path: '.', entries: [] }),
        }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{ job_id: 'create-job', status: 'succeeded', result_text: '{}' }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'list-job',
          status: 'succeeded',
          result_text: JSON.stringify({ path: '.', entries: [{ name: 'notes.md', path: 'notes.md', kind: 'file' }] }),
        }],
        has_more: false,
      });
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile,
          getSessionSync,
          listSessionFiles,
          listSessions,
          mkdirSessionDirectory: jest.fn(),
          readSessionFile: jest.fn(),
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '文件操作' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '新建文本文件' })));
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '新文件路径' }), 'notes.md');
      changeText(renderer.root.findByProps({ accessibilityLabel: '新文件内容' }), '# Mobile notes');
    });
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '确认创建文件' })));
    await settle();

    expect(createSessionFile).toHaveBeenCalledWith(
      'session-1',
      { path: 'notes.md', text: '# Mobile notes', overwrite: false },
      'csrf-token',
    );
  });
});
