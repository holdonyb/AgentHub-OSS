import type { ReactElement } from 'react';
import type {
  NativeJob,
  NativePermission,
  NativeSessionSummary,
  NativeTimelineItem,
} from '../api/mobileApi';
import { SessionDetailScreen } from './SessionDetailScreen';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

interface TestInstance {
  props: Record<string, unknown>;
  findByProps(props: Record<string, unknown>): TestInstance;
}

interface TestRenderer {
  root: TestInstance;
  toJSON(): unknown;
  unmount(): void;
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
  title: '修复同步问题',
  backend: 'codex',
  worker_id: 'worker-main',
  status: 'needs_reply',
  last_activity_at: '2026-07-11T12:00:00Z',
  project_name: 'AgentHub',
  workspace_root: 'E:/Work/AgentHub-OSS',
};

const timeline: NativeTimelineItem[] = [
  {
    session_id: 'session-1',
    seq: 2,
    item_type: 'assistant_message',
    role: 'assistant',
    text: '已经定位到同步游标。',
    tool_call_id: null,
    tool_name: null,
    status: 'completed',
    payload: {},
    created_at: '2026-07-11T12:02:00Z',
  },
  {
    session_id: 'session-1',
    seq: 1,
    item_type: 'user_message',
    role: 'user',
    text: '请检查消息同步。',
    tool_call_id: null,
    tool_name: null,
    status: null,
    payload: {},
    created_at: '2026-07-11T12:01:00Z',
  },
];

const questionPermission: NativePermission = {
  permission_id: 'permission-question',
  session_id: 'session-1',
  worker_id: 'worker-main',
  backend: 'codex',
  kind: 'question',
  title: '维护窗口',
  description: '请选择执行范围。',
  detail: {
    source: 'codex_request_user_input',
    questions: [
      {
        id: 'maintenance_window',
        header: '维护窗口',
        question: '接受哪种维护窗口？',
        options: [{ label: '今晚可重启', description: '允许重启' }],
      },
    ],
  },
  actions: {},
  status: 'pending',
  response: {},
  created_at: '2026-07-11T12:03:00Z',
  resolved_at: null,
};

function createDetailApi(overrides: Record<string, unknown> = {}) {
  return {
    getSession: jest.fn(async () => ({ session })),
    getSessionTimeline: jest.fn(async () => ({ items: timeline, has_more: false })),
    listJobs: jest.fn(async () => ({ items: [] as NativeJob[] })),
    listPermissions: jest.fn(async () => ({ items: [] as NativePermission[] })),
    respondPermission: jest.fn(),
    sendSessionInput: jest.fn(),
    terminateSession: jest.fn(),
    ...overrides,
  };
}

describe('native session detail', () => {
  it('loads the real timeline in chronological order and supports retry and back navigation', async () => {
    const getSessionTimeline = jest
      .fn()
      .mockRejectedValueOnce(new Error('时间线暂不可用'))
      .mockResolvedValueOnce({ items: timeline, has_more: false });
    const api = createDetailApi({ getSessionTimeline });
    const onBack = jest.fn();
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={onBack}
        session={session}
      />,
    );
    await settle();

    expect(renderedText(renderer)).toContain('会话详情加载失败');
    expect(renderedText(renderer)).toContain('时间线暂不可用');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '重试加载会话详情' })));
    await settle();

    const text = renderedText(renderer);
    expect(text.indexOf('请检查消息同步。')).toBeLessThan(text.indexOf('已经定位到同步游标。'));
    expect(
      renderer.root.findByProps({ accessibilityLabel: '会话详情安全区域' }).props.edges,
    ).toEqual(['top', 'bottom']);
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '返回会话列表' })));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('loads older timeline pages instead of silently truncating long sessions', async () => {
    const olderItem = {
      ...timeline[1]!,
      seq: 0,
      text: '更早的消息',
      created_at: '2026-07-11T11:59:00Z',
    };
    const getSessionTimeline = jest
      .fn()
      .mockResolvedValueOnce({ items: timeline, has_more: true })
      .mockResolvedValueOnce({ items: [olderItem], has_more: false });
    const api = createDetailApi({ getSessionTimeline });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '加载更早消息' })));
    await settle();

    expect(getSessionTimeline).toHaveBeenLastCalledWith('session-1', {
      beforeCreatedAt: '2026-07-11T12:01:00Z',
      beforeSeq: 1,
      limit: 100,
    });
    expect(renderedText(renderer)).toContain('更早的消息');
    expect(() => renderer.root.findByProps({ accessibilityLabel: '加载更早消息' })).toThrow();
  });

  it('preserves multiline replies and exposes sending, queued, running, and failed states', async () => {
    const sendRequest = deferred<{ job: NativeJob }>();
    let jobs: NativeJob[] = [];
    const api = createDetailApi({
      listJobs: jest.fn(async () => ({ items: jobs })),
      sendSessionInput: jest.fn(() => sendRequest.promise),
    });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '回复内容' }), '第一行\n第二行');
    });
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '发送回复' })));
    expect(renderedText(renderer)).toContain('正在发送');
    expect(renderer.root.findByProps({ accessibilityLabel: '回复状态' }).props.accessibilityLiveRegion).toBe('polite');

    const queuedJob = {
      job_id: 'job-reply',
      kind: 'session_input',
      target_session_id: 'session-1',
      worker_id: 'worker-main',
      backend: 'codex',
      status: 'queued',
      error_text: null,
    } as NativeJob;
    jobs = [queuedJob];
    await act(async () => {
      sendRequest.resolve({ job: queuedJob });
      await sendRequest.promise;
    });
    await settle();

    expect(api.sendSessionInput).toHaveBeenCalledWith(
      'session-1',
      { prompt: '第一行\n第二行' },
      'csrf-token',
    );
    expect(renderedText(renderer)).toContain('排队中');

    jobs = [{ ...queuedJob, status: 'running' }];
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '刷新会话详情' })));
    await settle();
    expect(renderedText(renderer)).toContain('运行中');

    jobs = [{ ...queuedJob, status: 'failed', error_text: '模型容量不足' }];
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '刷新会话详情' })));
    await settle();
    expect(renderedText(renderer)).toContain('失败：模型容量不足');
  });

  it('recovers the latest reply status when a detail screen is reopened', async () => {
    const failedJob = {
      job_id: 'job-existing',
      kind: 'session_input',
      target_session_id: 'session-1',
      worker_id: 'worker-main',
      backend: 'codex',
      status: 'failed',
      error_text: 'Selected model is at capacity',
      created_at: '2026-07-11T12:04:00Z',
    } as NativeJob;
    const api = createDetailApi({ listJobs: jest.fn(async () => ({ items: [failedJob] })) });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    expect(renderedText(renderer)).toContain('失败：Selected model is at capacity');
  });

  it('submits request_user_input freeform answers once and can reject an approval', async () => {
    const approval: NativePermission = {
      ...questionPermission,
      permission_id: 'permission-approval',
      kind: 'command_approval',
      title: '批准执行命令',
      description: 'npm test',
      detail: {},
      actions: {},
    };
    let permissions = [questionPermission, approval];
    const responseRequest = deferred<{ permission: NativePermission }>();
    const respondPermission = jest.fn(() => responseRequest.promise);
    const api = createDetailApi({
      listPermissions: jest.fn(async () => ({ items: permissions })),
      respondPermission,
    });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择 维护窗口：其他' })));
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '维护窗口 的其他内容' }), '只关闭 Docker');
      changeText(renderer.root.findByProps({ accessibilityLabel: '维护窗口 的补充说明' }), '执行前先保存工作区');
    });
    const submit = renderer.root.findByProps({ accessibilityLabel: '提交 维护窗口 的选择' });
    await act(async () => {
      press(submit);
      press(submit);
    });

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith(
      'permission-question',
      'answer',
      {
        answers: {
          maintenance_window: {
            choice: 'maintenance_window:other',
            label: '其他：只关闭 Docker',
            text: '只关闭 Docker',
          },
        },
        note: '执行前先保存工作区',
      },
      'csrf-token',
    );

    permissions = [approval];
    await act(async () => {
      responseRequest.resolve({ permission: { ...questionPermission, status: 'answered' } });
      await responseRequest.promise;
    });
    await settle();

    const denyRequest = Promise.resolve({ permission: { ...approval, status: 'denied' as const } });
    respondPermission.mockImplementationOnce(() => denyRequest);
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '拒绝 批准执行命令' })));
    await settle();
    expect(respondPermission).toHaveBeenLastCalledWith(
      'permission-approval',
      'deny',
      {},
      'csrf-token',
    );
  });

  it('requires a second confirmation before termination and keeps API errors visible', async () => {
    const terminateSession = jest.fn().mockRejectedValue(new Error('只有管理员可以终止会话'));
    const api = createDetailApi({ terminateSession });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '终止会话' })));
    expect(terminateSession).not.toHaveBeenCalled();
    expect(renderedText(renderer)).toContain('终止后不能继续发送消息');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '确认终止会话' })));
    await settle();

    expect(terminateSession).toHaveBeenCalledWith('session-1', 'csrf-token');
    expect(renderedText(renderer)).toContain('只有管理员可以终止会话');
    expect(renderer.root.findByProps({ accessibilityLabel: '终止会话错误' }).props.accessibilityRole).toBe('alert');
  });

  it('keeps a successfully resolved permission hidden when the follow-up refresh fails', async () => {
    const listPermissions = jest
      .fn()
      .mockResolvedValueOnce({ items: [questionPermission] })
      .mockRejectedValueOnce(new Error('刷新暂时失败'));
    const respondPermission = jest.fn(async () => ({
      permission: { ...questionPermission, status: 'answered' as const },
    }));
    const api = createDetailApi({ listPermissions, respondPermission });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择 维护窗口：今晚可重启' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '提交 维护窗口 的选择' })));
    await settle();

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(renderedText(renderer)).toContain('刷新暂时失败');
    expect(() => renderer.root.findByProps({ accessibilityLabel: '提交 维护窗口 的选择' })).toThrow();
  });
});
