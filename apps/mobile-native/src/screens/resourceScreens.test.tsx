import type { ReactElement } from 'react';
import { AgentHubApiError } from '@agenthub/client-core';
import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';
import type {
  NativeJob,
  NativeSettings,
  NativeSessionSummary,
  NativeTaskDetail,
  NativeTaskSummary,
  NativeWorkerSummary,
} from '../api/mobileApi';
import { SessionsScreen } from './SessionsScreen';
import { FilesScreen } from './FilesScreen';
import { TasksScreen } from './TasksScreen';
import { WorkersScreen } from './WorkersScreen';
import { pickSessionFile } from './nativeSessionFilePicker';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ pause: jest.fn(), play: jest.fn(), seekTo: jest.fn() }),
  useAudioPlayerStatus: () => ({ currentTime: 0, duration: 0, playing: false }),
}));
jest.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({}) }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: jest.fn(async () => undefined),
  downloadAsync: jest.fn(async () => ({ uri: 'file:///cache/download', status: 200, headers: {} })),
  writeAsStringAsync: jest.fn(async () => undefined),
  EncodingType: { Base64: 'base64' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
}));
jest.mock('./nativeSessionFilePicker', () => ({ pickSessionFile: jest.fn() }));
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
  findAllByProps(props: Record<string, unknown>): TestInstance[];
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
  activity_summary: '等待你回复：请确认新的修复方案',
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
  workspace_roots: ['E:/Work/AgentHub-OSS'],
  capabilities: { codex: true, claude: true, psmux: true },
  last_heartbeat_at: '2026-07-11T11:59:00.000Z',
  runtime_settings: {
    max_concurrent_jobs: 3,
    job_poll_interval_seconds: 4,
    heartbeat_interval_seconds: 12,
  },
};

function createTasksApi(overrides: Record<string, unknown> = {}) {
  return {
    createTask: jest.fn(),
    getTask: jest.fn(),
    listTasks: jest.fn(async () => ({ items: [] as NativeTaskSummary[] })),
    listWorkers: jest.fn(async () => ({ items: [worker] })),
    listProviderSnapshots: jest.fn(async () => ({ items: [] })),
    reviewTask: jest.fn(),
    ...overrides,
  };
}

function nativeSettings(overrides: Partial<NativeSettings['preferences']> = {}): NativeSettings {
  return {
    preferences: {
      locale: 'zh-CN',
      theme_mode: 'light',
      voice_mode: 'streaming',
      voice_language: 'zh-CN',
      quick_replies: ['继续', '不对，重新来'],
      ...overrides,
    },
    worker_runtime_defaults: {
      max_concurrent_jobs: 2,
      job_poll_interval_seconds: 5,
      heartbeat_interval_seconds: 15,
    },
    options: {},
    limits: {},
  };
}

function createSessionsApi(listSessions: jest.Mock, overrides: Record<string, unknown> = {}) {
  return {
    getSession: jest.fn(async () => ({ session })),
    getSessionTimeline: jest.fn(async () => ({ items: [], has_more: false })),
    getSettings: jest.fn(async () => nativeSettings()),
    listJobs: jest.fn(async () => ({ items: [] })),
    listPermissions: jest.fn(async () => ({ items: [] })),
    listTasks: jest.fn(async () => ({ items: [] })),
    listSessions,
    respondPermission: jest.fn(),
    sendSessionInput: jest.fn(),
    forkSession: jest.fn(),
    askSessionBtw: jest.fn(),
    renameSession: jest.fn(),
    updateSessionControls: jest.fn(),
    archiveSession: jest.fn(),
    unarchiveSession: jest.fn(),
    startSession: jest.fn(),
    listWorkers: jest.fn(async () => ({ items: [worker] })),
    listProviderSnapshots: jest.fn(async () => ({ items: [] })),
    transcribeVoice: jest.fn(),
    terminateSession: jest.fn(),
    ...overrides,
  };
}

describe('native resource screens', () => {
  it('loads account composer preferences before opening a session', async () => {
    const listSessions = jest.fn(async () => ({ items: [session] }));
    const api = createSessionsApi(listSessions, {
      getSettings: jest.fn(async () => nativeSettings({
        quick_replies: ['继续推进', '换个方案'],
        voice_language: 'en-US',
      })),
    });
    const renderer = await render(<SessionsScreen api={api} />);
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话 修复登录问题' })));
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '展开回复选项' })));
    expect(renderer.root.findByProps({ accessibilityLabel: '快捷回复 继续推进' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ accessibilityLabel: '快捷回复 Implement the plan' })).toHaveLength(0);
  });

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

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话搜索' })));
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

  it('filters sessions by status and worker without hiding the backend filter', async () => {
    const listSessions = jest.fn(async () => ({
      items: [
        session,
        {
          ...session,
          session_id: 'session-2',
          title: 'Claude 后台任务',
          backend: 'claude',
          worker_id: 'worker-claude',
          status: 'running' as const,
        },
      ],
    }));
    const renderer = await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话筛选' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '筛选状态 运行中' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '筛选节点 worker-claude' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '完成会话筛选' })));

    expect(renderedText(renderer)).not.toContain('修复登录问题');
    expect(renderedText(renderer)).toContain('Claude 后台任务');
    expect(renderedText(renderer)).toContain('已筛选 2 项');
    expect(renderer.root.findAllByProps({ accessibilityLabel: '筛选后端 claude' })).toHaveLength(0);
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话筛选' })));
    expect(renderer.root.findByProps({ accessibilityLabel: '筛选后端 claude' })).toBeTruthy();
  });

  it('makes an active backend filter visible and lets the user clear every filter at once', async () => {
    const listSessions = jest.fn(async () => ({
      items: [
        session,
        {
          ...session,
          session_id: 'session-2',
          title: 'Claude 后台任务',
          backend: 'claude',
          worker_id: 'worker-claude',
          status: 'running' as const,
        },
      ],
    }));
    const renderer = await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话筛选' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '筛选后端 claude' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '完成会话筛选' })));

    expect(renderedText(renderer)).toContain('已筛选 1 项');
    expect(renderedText(renderer)).not.toContain('修复登录问题');
    expect(renderedText(renderer)).toContain('Claude 后台任务');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话筛选' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '重置会话筛选' })));

    expect(renderedText(renderer)).toContain('修复登录问题');
    expect(renderedText(renderer)).toContain('Claude 后台任务');
  });

  it('shows an attention-first runtime overview and opens its existing session', async () => {
    const listSessions = jest.fn(async () => ({ items: [session] }));
    const api = createSessionsApi(listSessions, {
      listPermissions: jest.fn(async () => ({
        items: [{
          permission_id: 'permission-1',
          session_id: 'session-1',
          worker_id: 'worker-main',
          backend: 'codex',
          kind: 'question',
          title: '请选择执行方式',
          description: '',
          detail: {},
          actions: {},
          status: 'pending',
          response: {},
          created_at: '2026-07-19T08:00:00Z',
          resolved_at: null,
        }],
      })),
      listTasks: jest.fn(async () => ({ items: [] })),
    });
    const renderer = await render(<SessionsScreen api={api} />);
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看运行总览' })));
    await settle();

    expect(renderedText(renderer)).toContain('需要处理 1');
    expect(renderedText(renderer)).toContain('等待你选择');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '从总览打开会话 修复登录问题' })));
    await settle();
    expect(renderedText(renderer)).toContain('会话详情');
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

  it('refreshes the session inbox periodically so newly discovered sessions appear without leaving the tab', async () => {
    jest.useFakeTimers();
    try {
      const listSessions = jest
        .fn()
        .mockResolvedValueOnce({ items: [session] })
        .mockResolvedValueOnce({
          items: [
            session,
            {
              ...session,
              session_id: 'session-new',
              title: '刚刚发现的新会话',
              status: 'ready',
              last_activity_at: '2026-07-19T08:00:00',
            },
          ],
        });
      const renderer = await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
      await settle();

      expect(renderedText(renderer)).not.toContain('刚刚发现的新会话');
      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(listSessions).toHaveBeenCalledTimes(2);
      expect(renderedText(renderer)).toContain('刚刚发现的新会话');
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshes the session inbox immediately after the app returns to the foreground', async () => {
    let appStateListener: ((state: string) => void) | null = null;
    const remove = jest.fn();
    const appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
      if (event === 'change') appStateListener = listener as (state: string) => void;
      return { remove };
    });
    try {
      const listSessions = jest.fn(async () => ({ items: [session] }));
      await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
      await settle();

      await act(async () => {
        appStateListener?.('background');
        appStateListener?.('active');
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(listSessions).toHaveBeenCalledTimes(2);
    } finally {
      appStateSpy.mockRestore();
    }
  });

  it('opens a dedicated session detail and returns to the inbox', async () => {
    const api = createSessionsApi(jest.fn(async () => ({ items: [session] })));
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
    expect(renderedText(renderer)).toContain('会话');
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

  it('switches between inbox and archived sessions and filters by backend while showing activity summaries', async () => {
    const listSessions = jest.fn(async (input?: { archived?: boolean }) => {
      if (input?.archived) {
        return {
          items: [{
            ...session,
            session_id: 'session-archived',
            title: '历史 Claude 会话',
            backend: 'claude',
            worker_id: 'worker-claude',
            archived_at: '2026-07-10T00:00:00Z',
            activity_summary: '历史归档摘要',
          }],
        };
      }
      return {
        items: [
          session,
          {
            ...session,
            session_id: 'session-2',
            title: '处理 Claude API 报错',
            backend: 'claude',
            worker_id: 'worker-claude',
            activity_summary: 'Invalid API key',
          },
        ],
      };
    });

    const renderer = await render(<SessionsScreen api={createSessionsApi(listSessions)} />);
    await settle();

    expect(renderedText(renderer)).toContain('等待你回复：请确认新的修复方案');
    expect(renderedText(renderer)).toContain('Invalid API key');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话筛选' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '筛选后端 claude' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '完成会话筛选' })));
    expect(renderedText(renderer)).toContain('处理 Claude API 报错');
    expect(renderedText(renderer)).not.toContain('修复登录问题');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看归档会话' })));
    await settle();

    expect(listSessions).toHaveBeenLastCalledWith({ archived: true });
    expect(renderedText(renderer)).toContain('历史 Claude 会话');
    expect(renderedText(renderer)).toContain('历史归档摘要');
  });

  it('keeps search and backend filters out of the default session viewport', async () => {
    const renderer = await render(
      <SessionsScreen api={createSessionsApi(jest.fn(async () => ({ items: [session] })))} canOperate csrfToken="csrf-token" />,
    );
    await settle();

    expect(renderer.root.findAllByProps({ accessibilityLabel: '搜索会话' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '筛选后端 codex' })).toHaveLength(0);

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话搜索' })));
    expect(renderer.root.findByProps({ accessibilityLabel: '搜索会话' })).toBeTruthy();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话筛选' })));
    expect(renderer.root.findByProps({ accessibilityLabel: '筛选后端 codex' })).toBeTruthy();
  });

  it('batch archives selected sessions only after explicit confirmation', async () => {
    const secondSession = {
      ...session,
      session_id: 'session-2',
      title: '整理发布记录',
    };
    const archiveSession = jest.fn(async (sessionId: string) => ({
      session: { ...(sessionId === session.session_id ? session : secondSession), archived_at: '2026-07-19T10:00:00Z' },
    }));
    const listSessions = jest.fn(async () => ({ items: [session, secondSession] }));
    const renderer = await render(
      <SessionsScreen
        api={createSessionsApi(listSessions, { archiveSession })}
        canOperate
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '批量选择会话' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择会话 修复登录问题' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择会话 整理发布记录' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '归档所选会话' })));

    expect(renderedText(renderer)).toContain('确认归档 2 个会话');
    expect(archiveSession).not.toHaveBeenCalled();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '确认归档 2 个会话' })));
    await settle();

    expect(archiveSession).toHaveBeenCalledWith('session-1', 'csrf-token');
    expect(archiveSession).toHaveBeenCalledWith('session-2', 'csrf-token');
  });

  it('creates sessions only with the selected worker capabilities and provider-reported model', async () => {
    const startSession = jest.fn(async () => ({ job: queuedJob('session-start', 'session_start') }));
    const listProviderSnapshots = jest.fn(async () => ({
      items: [{
        worker_id: 'worker-main',
        backend: 'codex',
        status: 'ready',
        auth_status: 'ready',
        models: [{ id: 'gpt-5.6', label: 'GPT-5.6' }],
        modes: [
          { id: 'workspace-write', label: 'workspace-write', kind: 'sandbox_mode' },
          { id: 'danger-full-access', label: 'danger-full-access', kind: 'sandbox_mode' },
          { id: 'on-request', label: 'on-request', kind: 'approval_mode' },
          { id: 'never', label: 'never', kind: 'approval_mode' },
        ],
        features: { yolo: true },
        diagnostics: {},
        fetched_at: '2026-07-19T00:00:00Z',
        updated_at: '2026-07-19T00:00:00Z',
      }],
    }));
    const renderer = await render(
      <SessionsScreen
        api={createSessionsApi(
          jest.fn(async () => ({ items: [session] })),
          { listProviderSnapshots, startSession },
        )}
        canOperate
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '新建会话' })));
    await settle();
    expect(renderedText(renderer)).toContain('开发工作站');
    expect(renderedText(renderer)).toContain('GPT-5.6');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择模型 GPT-5.6' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择沙箱 danger-full-access' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择审批 never' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '启用 YOLO' })));
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '会话命名空间' }), 'release');
      changeText(renderer.root.findByProps({ accessibilityLabel: '初始提示词' }), '检查原生端控制能力。');
    });
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '创建会话' })));
    await settle();

    expect(startSession).toHaveBeenCalledWith({
      worker_id: 'worker-main',
      backend: 'codex',
      workspace_root: 'E:/Work/AgentHub-OSS',
      namespace: 'release',
      prompt: '检查原生端控制能力。',
      controls: {
        model: 'gpt-5.6',
        sandbox_mode: 'danger-full-access',
        approval_mode: 'never',
        yolo: true,
      },
    }, 'csrf-token');
    expect(renderedText(renderer)).toContain('创建请求已排队');
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
      <TasksScreen api={createTasksApi({ getTask, listTasks })} />,
    );
    await settle();

    expect(listTasks).toHaveBeenCalledWith(undefined);
    expect(renderedText(renderer)).toContain('任务收件箱');
    expect(renderedText(renderer)).toContain('待验收');
    expect(renderedText(renderer)).toContain('已阻塞');
    expect(renderedText(renderer)).toContain('执行中');

    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: '搜索任务' }), '审批'));
    expect(renderedText(renderer)).toContain('等待用户审批');
    expect(renderedText(renderer)).not.toContain('实现原生列表');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '清空任务搜索' })));
    await settle();
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

  it('discovers archived tasks and restores them from the task inbox', async () => {
    const archivedTask = {
      ...task,
      task_id: 'task-archived',
      title: '已归档的移动端任务',
      status: 'archived' as const,
      archived_at: '2026-07-18T12:00:00Z',
    };
    const listTasks = jest.fn(async (_status?: NativeTaskSummary['status'], archived?: boolean) => ({
      items: archived ? [archivedTask] : [task],
    }));
    const getTask = jest.fn(async () => ({ ...taskDetail, task: archivedTask }));
    const reviewTask = jest.fn(async () => ({
      task: { ...archivedTask, status: 'draft' as const, archived_at: null },
    }));
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({ getTask, listTasks, reviewTask })}
        canOperate
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '筛选任务：已归档' })));
    await settle();
    expect(renderedText(renderer)).toContain('已归档的移动端任务');
    expect(renderedText(renderer)).not.toContain('实现原生列表');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 已归档的移动端任务' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '恢复任务' })));
    await settle();

    expect(reviewTask).toHaveBeenCalledWith(
      'task-archived',
      { action: 'restore', note_markdown: '' },
      'csrf-token',
    );
  });

  it('renders task briefs, acceptance criteria, and artifact bodies as Markdown', async () => {
    const artifact = taskDetail.artifacts[0]!;
    const markdownDetail: NativeTaskDetail = {
      ...taskDetail,
      task: {
        ...task,
        brief_markdown: '接入 **真实 API** 数据。',
        success_criteria_markdown: '- 列表可刷新\n- 支持 `重试`',
      },
      artifacts: [{
        ...artifact,
        content_markdown: '**全部通过**\n- 原生回归通过',
      }],
    };
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({
          getTask: jest.fn(async () => markdownDetail),
          listTasks: jest.fn(async () => ({ items: [markdownDetail.task] })),
        })}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 实现原生列表' })));
    await settle();

    expect(renderedText(renderer)).toContain('接入 真实 API 数据。');
    expect(renderedText(renderer)).toContain('支持 重试');
    expect(renderedText(renderer)).toContain('全部通过');
    expect(renderedText(renderer)).toContain('原生回归通过');
    expect(renderedText(renderer)).not.toContain('**真实 API**');
    expect(renderedText(renderer)).not.toContain('`重试`');
  });

  it('clears tasks from the previous status when the new filter fails', async () => {
    let activeCalls = 0;
    const listTasks = jest.fn(async (_status?: NativeTaskSummary['status'], archived?: boolean) => {
      if (archived) return { items: [] };
      activeCalls += 1;
      if (activeCalls === 1) return { items: [task] };
      throw new Error('任务刷新失败');
    });
    const getTask = jest.fn();
    const renderer = await render(
      <TasksScreen api={createTasksApi({ getTask, listTasks })} />,
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
    const listWorkers = jest.fn(async () => ({
      items: [
        worker,
        {
          ...worker,
          worker_id: 'worker-offline',
          machine_name: '离线节点',
          status: 'offline' as const,
          reachable_backends: ['kimi'],
          workspace_roots: ['E:/Offline'],
        },
      ],
    }));
    const listProviderSnapshots = jest.fn(async () => ({
      items: [
        {
          worker_id: 'worker-main',
          backend: 'codex',
          status: 'ready',
          auth_status: 'ready',
          models: [{ id: 'gpt-5.6' }],
          modes: [],
          features: {},
          diagnostics: {},
          fetched_at: '2026-07-19T00:00:00Z',
          updated_at: '2026-07-19T00:00:00Z',
        },
        {
          worker_id: 'worker-main',
          backend: 'claude',
          status: 'ready',
          auth_status: 'ready',
          models: [{ id: 'sonnet-4.5' }],
          modes: [],
          features: {},
          diagnostics: {},
          fetched_at: '2026-07-19T00:00:00Z',
          updated_at: '2026-07-19T00:00:00Z',
        },
      ],
    }));
    const reviewTask = jest.fn();
    const renderer = await render(
      <TasksScreen
        api={{ createTask, getTask, listTasks, listProviderSnapshots, listWorkers, reviewTask }}
        canOperate
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '新建任务' })));
    await settle();
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '任务标题' }), '修复消息同步');
      changeText(renderer.root.findByProps({ accessibilityLabel: '任务说明' }), '详情页应自动同步最终消息。');
      changeText(renderer.root.findByProps({ accessibilityLabel: '验收标准' }), '- 无需退出详情页');
      changeText(renderer.root.findByProps({ accessibilityLabel: '相关路径' }), 'apps/mobile-native\napps/api');
    });
    expect(renderedText(renderer)).toContain('开发工作站');
    expect(renderedText(renderer)).toContain('Codex');
    expect(renderedText(renderer)).toContain('Claude');
    expect(renderedText(renderer)).toContain('E:/Work/AgentHub-OSS');
    expect(renderedText(renderer)).not.toContain('离线节点');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择任务模板 修复问题' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择任务后端 Claude' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '创建并派发任务' })));
    await settle();

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '修复消息同步',
        brief_markdown: '详情页应自动同步最终消息。',
        success_criteria_markdown: '- 无需退出详情页',
        target_worker_id: 'worker-main',
        backend: 'claude',
        workspace_root: 'E:/Work/AgentHub-OSS',
        template_key: 'fix_bug',
        relevant_paths: ['apps/mobile-native', 'apps/api'],
        submit: true,
      }),
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('修复消息同步');
    expect(renderedText(renderer)).toContain('详情页应自动同步最终消息。');
  });

  it('opens a task requested by a native notification', async () => {
    const getTask = jest.fn(async () => taskDetail);
    const onRequestedTaskHandled = jest.fn();
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({ getTask })}
        onRequestedTaskHandled={onRequestedTaskHandled}
        requestedTaskId="task-1"
      />,
    );
    await settle();

    expect(getTask).toHaveBeenCalledWith('task-1');
    expect(renderedText(renderer)).toContain('任务详情');
    expect(onRequestedTaskHandled).toHaveBeenCalledWith('task-1');
  });

  it('accepts or requests changes from a ready-to-review task detail', async () => {
    const reviewableTask = { ...task, status: 'ready_to_review' as const };
    const listTasks = jest.fn(async () => ({ items: [reviewableTask] }));
    const getTask = jest.fn(async () => ({ ...taskDetail, task: reviewableTask }));
    const reviewTask = jest.fn(async () => ({ task: { ...reviewableTask, status: 'accepted' as const } }));
    const onOpenFile = jest.fn();
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({ getTask, listTasks, reviewTask })}
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

  it('rejects a ready-to-review task from native task detail', async () => {
    const reviewableTask = { ...task, status: 'ready_to_review' as const };
    const reviewTask = jest.fn(async () => ({ task: { ...reviewableTask, status: 'rejected' as const } }));
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({
          getTask: jest.fn(async () => ({ ...taskDetail, task: reviewableTask })),
          listTasks: jest.fn(async () => ({ items: [reviewableTask] })),
          reviewTask,
        })}
        canOperate
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 实现原生列表' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '拒绝任务' })));
    await settle();

    expect(reviewTask).toHaveBeenCalledWith(
      'task-1',
      { action: 'reject', note_markdown: '' },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('已拒绝');
  });

  it('hides task review mutations from viewers', async () => {
    const reviewableTask = { ...task, status: 'ready_to_review' as const };
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({
          getTask: jest.fn(async () => ({ ...taskDetail, task: reviewableTask })),
          listTasks: jest.fn(async () => ({ items: [reviewableTask] })),
        })}
        canOperate={false}
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 实现原生列表' })));
    await settle();

    expect(renderer.root.findAllByProps({ accessibilityLabel: '通过验收' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '拒绝任务' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '退回修改' })).toHaveLength(0);
  });

  it('opens local markdown links from task detail through the originating session workspace', async () => {
    const onOpenFile = jest.fn();
    const detailWithLink: NativeTaskDetail = {
      ...taskDetail,
      task: {
        ...task,
        brief_markdown: '[查看计划](docs/plan.md)',
      },
    };
    const renderer = await render(
      <TasksScreen
        api={createTasksApi({
          getTask: jest.fn(async () => detailWithLink),
          listTasks: jest.fn(async () => ({ items: [detailWithLink.task] })),
        })}
        onOpenFile={onOpenFile}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看任务 实现原生列表' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '链接 查看计划' })));

    expect(onOpenFile).toHaveBeenCalledWith({ sessionId: 'session-1', path: 'docs/plan.md' });
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
    expect(renderedText(renderer)).toContain('运行参数');
    expect(renderedText(renderer)).toContain('并发任务 3');
    expect(renderedText(renderer)).toContain('任务轮询 4 秒');
    expect(renderedText(renderer)).toContain('心跳 12 秒');
  });

  it('lets an admin queue provider login from the selected node', async () => {
    const listWorkers = jest.fn(async () => ({ items: [worker] }));
    const listProviderSnapshots = jest.fn(async () => ({
      items: [{
        worker_id: 'worker-main',
        backend: 'claude',
        status: 'unavailable',
        auth_status: 'auth_required',
        models: [],
        modes: [],
        features: {},
        diagnostics: { message: '需要登录' },
        fetched_at: '2026-07-19T00:00:00Z',
        updated_at: '2026-07-19T00:00:00Z',
      }],
    }));
    const loginProvider = jest.fn(async () => ({ job: queuedJob('provider-login', 'provider_login') }));
    const renderer = await render(
      <WorkersScreen
        api={{ listProviderSnapshots, listWorkers, loginProvider, logoutProvider: jest.fn() }}
        canManage
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看节点 开发工作站' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '登录 claude' })));
    await settle();

    expect(loginProvider).toHaveBeenCalledWith('worker-main', 'claude', 'csrf-token');
    expect(renderedText(renderer)).toContain('claude 登录任务已排队');
  });

  it('lets an admin queue provider logout from the selected node', async () => {
    const listWorkers = jest.fn(async () => ({ items: [worker] }));
    const listProviderSnapshots = jest.fn(async () => ({
      items: [{
        worker_id: 'worker-main',
        backend: 'claude',
        status: 'ready',
        auth_status: 'ready',
        models: [{ id: 'sonnet-4.5' }],
        modes: [],
        features: {},
        diagnostics: {},
        fetched_at: '2026-07-19T00:00:00Z',
        updated_at: '2026-07-19T00:00:00Z',
      }],
    }));
    const logoutProvider = jest.fn(async () => ({ job: queuedJob('provider-logout', 'provider_logout') }));
    const renderer = await render(
      <WorkersScreen
        api={{ listProviderSnapshots, listWorkers, loginProvider: jest.fn(), logoutProvider }}
        canManage
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看节点 开发工作站' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '退出 claude' })));
    await settle();

    expect(logoutProvider).toHaveBeenCalledWith('worker-main', 'claude', 'csrf-token');
    expect(renderedText(renderer)).toContain('claude 退出任务已排队');
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
            text: '# AgentHub\n**原始内容**',
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
    expect(renderedText(renderer)).not.toContain('# AgentHub');
    expect(renderedText(renderer)).not.toContain('**原始内容**');

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

  it('creates a folder in the selected session workspace', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const mkdirSessionDirectory = jest.fn(async () => ({ job: queuedJob('mkdir-job', 'file_mkdir') }));
    const getSessionSync = jest
      .fn()
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{ job_id: 'list-job', status: 'succeeded', result_text: JSON.stringify({ path: '.', entries: [] }) }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{ job_id: 'mkdir-job', status: 'succeeded', result_text: '{}' }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{ job_id: 'list-job', status: 'succeeded', result_text: JSON.stringify({ path: '.', entries: [{ name: 'reports', path: 'reports', kind: 'directory' }] }) }],
        has_more: false,
      });
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getSessionSync,
          listSessionFiles: jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') })),
          listSessions: jest.fn(async () => ({ items: [workspaceSession] })),
          mkdirSessionDirectory,
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
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '新建文件夹' })));
    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: '新目录路径' }), 'reports'));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '确认创建目录' })));
    await settle();

    expect(mkdirSessionDirectory).toHaveBeenCalledWith('session-1', { path: 'reports' }, 'csrf-token');
  });

  it('renames a file in the selected session workspace', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const renameSessionFile = jest.fn(async () => ({ job: queuedJob('rename-job', 'file_rename') }));
    const listResult = JSON.stringify({
      path: '.',
      entries: [{ name: 'draft.md', path: 'draft.md', kind: 'file', preview_capability: 'markdown', is_editable: true }],
    });
    const getSessionSync = jest
      .fn()
      .mockResolvedValueOnce({ session: workspaceSession, items: [], jobs: [{ job_id: 'list-job', status: 'succeeded', result_text: listResult }], has_more: false })
      .mockResolvedValueOnce({ session: workspaceSession, items: [], jobs: [{ job_id: 'rename-job', status: 'succeeded', result_text: '{}' }], has_more: false })
      .mockResolvedValueOnce({ session: workspaceSession, items: [], jobs: [{ job_id: 'list-job', status: 'succeeded', result_text: listResult }], has_more: false });
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getSessionSync,
          listSessionFiles: jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') })),
          listSessions: jest.fn(async () => ({ items: [workspaceSession] })),
          mkdirSessionDirectory: jest.fn(),
          readSessionFile: jest.fn(),
          renameSessionFile,
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '重命名 draft.md' })));
    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: '新文件路径' }), 'final.md'));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '确认重命名' })));
    await settle();

    expect(renameSessionFile).toHaveBeenCalledWith(
      'session-1',
      { path: 'draft.md', new_path: 'final.md' },
      'csrf-token',
    );
  });

  it('hides workspace mutations from viewers', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getSessionSync: jest.fn(async () => ({
            session: workspaceSession,
            items: [],
            jobs: [{
              ...queuedJob('list-job', 'file_list'),
              status: 'succeeded' as const,
              result_text: JSON.stringify({ path: '.', entries: [{ name: 'README.md', path: 'README.md', kind: 'file' }] }),
            }],
            has_more: false,
          })),
          listSessionFiles: jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') })),
          listSessions: jest.fn(async () => ({ items: [workspaceSession] })),
          mkdirSessionDirectory: jest.fn(),
          readSessionFile: jest.fn(),
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        canEdit={false}
        csrfToken="csrf-token"
      />,
    );
    await settle();

    expect(renderer.root.findAllByProps({ accessibilityLabel: '文件操作' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '重命名 README.md' })).toHaveLength(0);
  });

  it('browses a registered worker workspace even when it has no session', async () => {
    const listWorkspaceFiles = jest.fn(async () => ({ job: queuedJob('direct-list', 'file_list') }));
    const readWorkspaceFile = jest.fn(async () => ({ job: queuedJob('direct-read', 'file_read') }));
    const getJob = jest
      .fn()
      .mockResolvedValueOnce({
        job: {
          job_id: 'direct-list',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: '.',
            workspace_root: 'E:/Work/AgentHub-OSS',
            entries: [{ name: 'README.md', path: 'README.md', kind: 'file', preview_capability: 'markdown', is_editable: true }],
          }),
        },
      })
      .mockResolvedValueOnce({
        job: {
          job_id: 'direct-read',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: 'README.md',
            filename: 'README.md',
            content_type: 'text/markdown',
            size_bytes: 20,
            truncated: false,
            preview_kind: 'text',
            downloadable: true,
            text: '# Direct workspace',
          }),
        },
      });
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getJob,
          getSessionSync: jest.fn(),
          listSessionFiles: jest.fn(),
          listSessions: jest.fn(async () => ({ items: [] })),
          listWorkers: jest.fn(async () => ({ items: [worker] })),
          listWorkspaceFiles,
          mkdirSessionDirectory: jest.fn(),
          readSessionFile: jest.fn(),
          readWorkspaceFile,
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    expect(renderedText(renderer)).toContain('开发工作站');
    expect(renderedText(renderer)).toContain('README.md');
    expect(listWorkspaceFiles).toHaveBeenCalledWith(
      { worker_id: 'worker-main', workspace_root: 'E:/Work/AgentHub-OSS', path: '.' },
      'csrf-token',
    );

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 README.md' })));
    await settle();
    expect(readWorkspaceFile).toHaveBeenCalledWith(
      { worker_id: 'worker-main', workspace_root: 'E:/Work/AgentHub-OSS', path: 'README.md', max_bytes: 5_000_000 },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('Direct workspace');
  });

  it('does not offer editing when the worker marks a file preview read-only', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
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
            entries: [{ name: 'generated.log', path: 'generated.log', kind: 'file', preview_capability: 'text', is_editable: false }],
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
            path: 'generated.log',
            filename: 'generated.log',
            content_type: 'text/plain',
            size_bytes: 10,
            truncated: false,
            preview_kind: 'text',
            is_editable: false,
            text: 'read only',
          }),
        }],
        has_more: false,
      });
    const renderer = await render(
      <FilesScreen
        api={{
          createSessionFile: jest.fn(),
          getSessionSync,
          listSessionFiles: jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') })),
          listSessions: jest.fn(async () => ({ items: [workspaceSession] })),
          mkdirSessionDirectory: jest.fn(),
          readSessionFile: jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') })),
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 generated.log' })));
    await settle();

    expect(() => renderer.root.findByProps({ accessibilityLabel: '编辑文件' })).toThrow();
    expect(renderedText(renderer)).toContain('read only');
  });

  it('searches the whole selected workspace and opens a matching nested file', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const searchSessionFiles = jest.fn(async () => ({ job: queuedJob('search-job', 'file_search') }));
    const readSessionFile = jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') }));
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
        jobs: [{
          job_id: 'search-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: '.',
            query: 'release',
            entries: [{
              name: 'release-notes.md',
              path: 'docs/release-notes.md',
              kind: 'file',
              preview_capability: 'markdown',
              is_editable: true,
            }],
            truncated: false,
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
            path: 'docs/release-notes.md',
            filename: 'release-notes.md',
            content_type: 'text/markdown',
            size_bytes: 30,
            truncated: false,
            preview_kind: 'text',
            text: '# Release notes',
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
          searchSessionFiles,
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: '搜索当前目录文件' }), 'release'));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '搜索整个工作区' })));
    await settle();

    expect(searchSessionFiles).toHaveBeenCalledWith(
      'session-1',
      { path: '.', query: 'release', max_results: 100, include_hidden: false },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('docs/release-notes.md');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 release-notes.md' })));
    await settle();
    expect(readSessionFile).toHaveBeenCalledWith(
      'session-1',
      { path: 'docs/release-notes.md', max_bytes: 5_000_000 },
      'csrf-token',
    );
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

  it('offers recently opened files for the selected workspace session', async () => {
    const SecureStore = jest.requireMock('expo-secure-store') as {
      getItemAsync: jest.Mock;
      setItemAsync: jest.Mock;
    };
    SecureStore.getItemAsync.mockImplementation(async (key: string) => (
      key === 'agenthub.recentWorkspaceFiles.v1'
        ? JSON.stringify([{ sessionId: 'session-1', path: 'docs/plan.md', filename: 'plan.md', openedAt: 3 }])
        : null
    ));
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const readSessionFile = jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') }));
    const getSessionSync = jest
      .fn()
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{ job_id: 'list-job', status: 'succeeded', result_text: JSON.stringify({ path: '.', entries: [] }) }],
        has_more: false,
      })
      .mockResolvedValueOnce({
        session: workspaceSession,
        items: [],
        jobs: [{
          job_id: 'read-job',
          status: 'succeeded',
          result_text: JSON.stringify({
            path: 'docs/plan.md',
            filename: 'plan.md',
            content_type: 'text/markdown',
            size_bytes: 12,
            truncated: false,
            preview_kind: 'text',
            text: '# Plan',
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
          listSessions: jest.fn(async () => ({ items: [workspaceSession] })),
          mkdirSessionDirectory: jest.fn(),
          readSessionFile,
          renameSessionFile: jest.fn(),
          uploadSessionFile: jest.fn(),
          writeSessionFile: jest.fn(),
        }}
        csrfToken="csrf-token"
      />,
    );
    await settle();

    expect(renderedText(renderer)).toContain('最近文件');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开最近文件 plan.md' })));
    await settle();

    expect(readSessionFile).toHaveBeenCalledWith(
      'session-1',
      { path: 'docs/plan.md', max_bytes: 5_000_000 },
      'csrf-token',
    );
  });

  it('toggles markdown preview back to raw text and copies the current file body', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const readSessionFile = jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') }));
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
              { name: 'README.md', path: 'README.md', kind: 'file', preview_capability: 'markdown', is_editable: true, size_bytes: 64 },
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
            modified_at: '2026-07-18T00:00:00Z',
            preview_kind: 'text',
            text: '# AgentHub\n\n- 第一项',
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
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 README.md' })));
    await settle();

    expect(renderedText(renderer)).toContain('Markdown');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '原文预览' })));
    expect(renderedText(renderer)).toContain('# AgentHub');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '复制文件内容' })));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('# AgentHub\n\n- 第一项');
  });

  it('opens local markdown links from a file preview inside the same workspace session', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const readSessionFile = jest.fn(async () => ({ job: queuedJob('read-job', 'file_read') }));
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
            entries: [{ name: 'README.md', path: 'README.md', kind: 'file', preview_capability: 'markdown', is_editable: true, size_bytes: 64 }],
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
            path: 'docs/README.md',
            filename: 'README.md',
            content_type: 'text/markdown',
            size_bytes: 64,
            truncated: false,
            modified_at: '2026-07-18T00:00:00Z',
            preview_kind: 'text',
            text: '[需求说明](../notes/spec.md)',
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
            path: 'notes/spec.md',
            filename: 'spec.md',
            content_type: 'text/markdown',
            size_bytes: 42,
            truncated: false,
            modified_at: '2026-07-18T00:01:00Z',
            preview_kind: 'text',
            text: '# 规范',
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
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 README.md' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '链接 需求说明' })));
    await settle();

    expect(readSessionFile).toHaveBeenLastCalledWith(
      'session-1',
      { path: 'notes/spec.md', max_bytes: 5_000_000 },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('规范');
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

  it('uploads a document to the current workspace directory through the selected session', async () => {
    const workspaceSession = { ...session, workspace_root: 'E:/Work/AgentHub-OSS' };
    const listSessions = jest.fn(async () => ({ items: [workspaceSession] }));
    const listSessionFiles = jest.fn(async () => ({ job: queuedJob('list-job', 'file_list') }));
    const uploadSessionFile = jest.fn(async () => ({ job: queuedJob('upload-job', 'file_upload') }));
    jest.mocked(pickSessionFile).mockResolvedValue({
      filename: 'notes.md',
      content_type: 'text/markdown',
      data_base64: 'c2FtcGxl',
      preview_uri: 'file:///notes.md',
      size_bytes: 6,
    });
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
        jobs: [{ job_id: 'upload-job', status: 'succeeded', result_text: '{}' }],
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
          createSessionFile: jest.fn(),
          getSessionSync,
          listSessionFiles,
          listSessions,
          mkdirSessionDirectory: jest.fn(),
          readSessionFile: jest.fn(),
          renameSessionFile: jest.fn(),
          uploadSessionFile,
          writeSessionFile: jest.fn(),
        }}
        canEdit
        csrfToken="csrf-token"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '文件操作' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '上传文件到当前目录' })));
    await settle();

    expect(uploadSessionFile).toHaveBeenCalledWith(
      'session-1',
      {
        path: '.',
        filename: 'notes.md',
        content_type: 'text/markdown',
        data_base64: 'c2FtcGxl',
        overwrite: false,
      },
      'csrf-token',
    );
  });
});
