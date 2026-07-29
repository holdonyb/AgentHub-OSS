import type { ReactElement } from 'react';
import * as Clipboard from 'expo-clipboard';
import type {
  NativeJob,
  NativePermission,
  NativeSessionSummary,
  NativeTimelineItem,
} from '../api/mobileApi';
import { SessionDetailScreen } from './SessionDetailScreen';
import { pickSessionImage } from './nativeImagePicker';
import { pickSessionFile } from './nativeSessionFilePicker';
import { useNativeVoiceRecorder } from './useNativeVoiceRecorder';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children, ...props }: Record<string, unknown>) => React.createElement(View, props, children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
  };
});
jest.mock('./nativeImagePicker', () => ({ pickSessionImage: jest.fn() }));
jest.mock('./nativeSessionFilePicker', () => ({ pickSessionFile: jest.fn() }));
jest.mock('./useNativeVoiceRecorder', () => ({ useNativeVoiceRecorder: jest.fn() }));

interface TestInstance {
  props: any;
  findByProps(props: Record<string, unknown>): TestInstance;
  findAllByProps(props: Record<string, unknown>): TestInstance[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

beforeEach(() => {
  jest.mocked(useNativeVoiceRecorder).mockReturnValue({
    durationMillis: 0,
    isRecording: false,
    startRecording: jest.fn(async () => undefined),
    stopRecording: jest.fn(async () => null),
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

const markdownTimeline: NativeTimelineItem[] = [
  {
    session_id: 'session-1',
    seq: 3,
    item_type: 'assistant_message',
    role: 'assistant',
    text: '# 计划\n\n- 第一步\n- 第二步\n\n[E:/Work/AgentHub-OSS/README.md](E:/Work/AgentHub-OSS/README.md)',
    tool_call_id: null,
    tool_name: null,
    status: 'completed',
    payload: {},
    created_at: '2026-07-11T12:03:00Z',
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
    renameSession: jest.fn(),
    forkSession: jest.fn(),
    askSessionBtw: jest.fn(),
    updateSessionControls: jest.fn(),
    archiveSession: jest.fn(),
    unarchiveSession: jest.fn(),
    listProviderSnapshots: jest.fn(async () => ({ items: [] })),
    transcribeVoice: jest.fn(),
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

  it('opens a full reader for long assistant messages and only exposes markdown mode for markdown content', async () => {
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({ items: markdownTimeline, has_more: false })),
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

    expect(renderedText(renderer)).toContain('全文阅读');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '全文阅读' })));
    await settle();

    expect(renderedText(renderer)).toContain('原文');
    expect(renderedText(renderer)).toContain('Markdown');
    expect(renderedText(renderer)).not.toContain('# 计划');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: 'Markdown' })));
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Markdown 内容' }).length).toBeGreaterThan(0);
    expect(renderedText(renderer)).toContain('计划');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '原文' })));
    expect(renderedText(renderer)).toContain('# 计划');
  });

  it('searches the loaded conversation without leaving the session', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );

    await settle();
    await act(async () => {
      press(renderer.root.findByProps({ accessibilityLabel: '搜索会话消息' }));
    });
    await act(async () => {
      changeText(renderer.root.findByProps({ accessibilityLabel: '消息搜索关键词' }), '同步游标');
    });

    expect(renderedText(renderer)).toContain('1 条匹配');
    expect(renderedText(renderer)).toContain('已经定位到同步游标。');
    expect(renderedText(renderer)).not.toContain('请检查消息同步。');
  });

  it('keeps polling a needs-reply session until its delayed transcript arrives', async () => {
    jest.useFakeTimers();
    try {
      const delayedItem = { ...timeline[0]!, text: '审批消息已经同步到详情。' };
      const getSessionTimeline = jest
        .fn()
        .mockResolvedValueOnce({ items: [], has_more: false })
        .mockResolvedValueOnce({ items: [delayedItem], has_more: false });
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

      expect(renderedText(renderer)).not.toContain('审批消息已经同步到详情。');
      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(getSessionTimeline).toHaveBeenCalledTimes(2);
      expect(renderedText(renderer)).toContain('审批消息已经同步到详情。');
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows persisted attachment metadata on a sent user message and opens local attachment paths', async () => {
    const attachmentTimeline: NativeTimelineItem[] = [{
      ...timeline[1]!,
      payload: {
        input: {
          attachments: [
            { filename: '需求说明.md', content_type: 'text/markdown', size_bytes: 2048, path: 'docs/需求说明.md' },
            { filename: '截图.png', content_type: 'image/png', size_bytes: 512, uri: 'https://example.com/screen.png' },
          ],
        },
      },
    }];
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({ items: attachmentTimeline, has_more: false })),
    });
    const onOpenFile = jest.fn();
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        onOpenFile={onOpenFile}
        session={session}
      />,
    );
    await settle();

    expect(renderedText(renderer)).toContain('附件 2');
    expect(renderedText(renderer)).toContain('需求说明.md');
    expect(renderedText(renderer)).toContain('截图.png');
    expect(renderer.root.findByProps({ accessibilityLabel: '附件 需求说明.md' })).toBeDefined();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '附件 需求说明.md' })));
    expect(onOpenFile).toHaveBeenCalledWith('session-1', 'docs/需求说明.md');
  });

  it('supports inline expand, collapse, and copy for long assistant messages', async () => {
    const longMessage = '第一段总结。'.repeat(30);
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({
        items: [{
          session_id: 'session-1',
          seq: 4,
          item_type: 'assistant_message',
          role: 'assistant',
          text: longMessage,
          tool_call_id: null,
          tool_name: null,
          status: 'completed',
          payload: {},
          created_at: '2026-07-11T12:04:00Z',
        }],
        has_more: false,
      })),
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

    expect(renderedText(renderer)).toContain('展开全文');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '展开全文' })));
    await settle();
    expect(renderedText(renderer)).toContain('收起');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '复制全文' })));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(longMessage);

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '收起全文' })));
    await settle();
    expect(renderedText(renderer)).toContain('展开全文');
  });

  it('opens local file links from a timeline message', async () => {
    const onOpenFile = jest.fn();
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({ items: markdownTimeline, has_more: false })),
    });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        onOpenFile={onOpenFile}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 README.md' })));
    expect(onOpenFile).toHaveBeenCalledWith('session-1', 'E:/Work/AgentHub-OSS/README.md');
  });

  it('opens a Linux worker path from a plain timeline message', async () => {
    const onOpenFile = jest.fn();
    const linuxTimeline: NativeTimelineItem[] = [{
      session_id: 'session-1',
      seq: 4,
      item_type: 'assistant_message',
      role: 'assistant',
      text: '报告已生成：/srv/agenthub/reports/weekly-summary.md。',
      tool_call_id: null,
      tool_name: null,
      status: 'completed',
      payload: {},
      created_at: '2026-07-19T10:00:00Z',
    }];
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({ items: linuxTimeline, has_more: false })),
    });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        onOpenFile={onOpenFile}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开文件 weekly-summary.md' })));
    expect(onOpenFile).toHaveBeenCalledWith('session-1', '/srv/agenthub/reports/weekly-summary.md');
  });

  it('does not expose a markdown reader tab for completed tool output cards', async () => {
    const toolTimeline: NativeTimelineItem[] = [
      {
        session_id: 'session-1',
        seq: 3,
        item_type: 'tool_call',
        role: 'tool',
        text: '',
        tool_call_id: 'tool-1',
        tool_name: 'shell_command',
        status: 'completed',
        payload: {
          summary: 'Exit code: 0',
          output: 'build finished',
        },
        created_at: '2026-07-11T12:03:00Z',
      },
    ];
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({ items: toolTimeline, has_more: false })),
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

    expect(renderedText(renderer)).toContain('shell_command');
    expect(() => renderer.root.findByProps({ accessibilityLabel: 'Markdown' })).toThrow();
  });

  it('keeps completed tool output collapsed until the user asks to inspect it', async () => {
    const toolTimeline: NativeTimelineItem[] = [
      {
        session_id: 'session-1',
        seq: 3,
        item_type: 'tool_call',
        role: 'tool',
        text: '',
        tool_call_id: 'tool-1',
        tool_name: 'shell_command',
        status: 'completed',
        payload: {
          summary: 'Exit code: 0',
          output: 'build finished',
        },
        created_at: '2026-07-11T12:03:00Z',
      },
    ];
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({ items: toolTimeline, has_more: false })),
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

    expect(renderedText(renderer)).toContain('Exit code: 0');
    expect(renderedText(renderer)).not.toContain('build finished');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '查看工具输出' })));
    expect(renderedText(renderer)).toContain('build finished');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '收起工具输出' })));
    expect(renderedText(renderer)).not.toContain('build finished');
  });

  it('opens long tool output in the full-screen reader and lets the user copy it', async () => {
    const output = `first line\n${'diagnostic output '.repeat(20)}`;
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({
        items: [{
          session_id: 'session-1',
          seq: 4,
          item_type: 'tool_call',
          role: 'tool',
          text: '',
          tool_call_id: 'tool-2',
          tool_name: 'shell_command',
          status: 'completed',
          payload: { summary: 'Exit code: 0', output },
          created_at: '2026-07-11T12:04:00Z',
        }],
        has_more: false,
      })),
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

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '全文阅读工具输出' })));
    expect(renderedText(renderer)).toContain('工具输出');
    expect(renderedText(renderer)).toContain('diagnostic output');
    expect(() => renderer.root.findByProps({ accessibilityLabel: 'Markdown' })).toThrow();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '复制阅读内容' })));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(output.trim());
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
      { prompt: '第一行\n第二行', reply_mode: 'direct' },
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

  it('sends reply mode and quick replies from the native composer', async () => {
    const queuedJob = {
      job_id: 'job-plan',
      kind: 'session_input',
      target_session_id: 'session-1',
      worker_id: 'worker-main',
      backend: 'codex',
      status: 'queued',
      error_text: null,
    } as NativeJob;
    const api = createDetailApi({
      sendSessionInput: jest.fn(async () => ({ job: queuedJob })),
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

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '展开回复选项' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '切换到计划模式' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '快捷回复 继续' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '发送回复' })));
    await settle();

    expect(api.sendSessionInput).toHaveBeenCalledWith(
      'session-1',
      { prompt: '继续', reply_mode: 'plan' },
      'csrf-token',
    );
  });

  it('selects an image and sends it without requiring prompt text', async () => {
    const queuedJob = {
      job_id: 'job-image',
      kind: 'session_input',
      target_session_id: 'session-1',
      worker_id: 'worker-main',
      backend: 'codex',
      status: 'queued',
      error_text: null,
    } as NativeJob;
    jest.mocked(pickSessionImage).mockResolvedValue({
      filename: 'screen.png',
      content_type: 'image/png',
      data_base64: 'aW1hZ2U=',
      preview_uri: 'file:///screen.png',
      size_bytes: 5,
    });
    const api = createDetailApi({
      sendSessionInput: jest.fn(async () => ({ job: queuedJob })),
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

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '添加附件' })));
    expect(renderedText(renderer)).toContain('选择图片');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择图片附件' })));
    await settle();
    expect(renderedText(renderer)).toContain('screen.png');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '发送回复' })));
    await settle();
    expect(api.sendSessionInput).toHaveBeenCalledWith(
      'session-1',
      {
        prompt: '',
        reply_mode: 'direct',
        attachments: [{ filename: 'screen.png', content_type: 'image/png', data_base64: 'aW1hZ2U=' }],
      },
      'csrf-token',
    );
  });

  it('selects a document and sends it through the same attachment envelope', async () => {
    const queuedJob = {
      job_id: 'job-file',
      kind: 'session_input',
      target_session_id: 'session-1',
      worker_id: 'worker-main',
      backend: 'codex',
      status: 'queued',
      error_text: null,
    } as NativeJob;
    jest.mocked(pickSessionFile).mockResolvedValue({
      filename: '需求说明.md',
      content_type: 'text/markdown',
      data_base64: 'c2FtcGxl',
      preview_uri: 'file:///requirements.md',
      size_bytes: 6,
    });
    const api = createDetailApi({
      sendSessionInput: jest.fn(async () => ({ job: queuedJob })),
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

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '添加附件' })));
    expect(renderedText(renderer)).toContain('选择文件');
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择文件附件' })));
    await settle();
    expect(renderedText(renderer)).toContain('需求说明.md');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '发送回复' })));
    await settle();
    expect(api.sendSessionInput).toHaveBeenCalledWith(
      'session-1',
      {
        prompt: '',
        reply_mode: 'direct',
        attachments: [{ filename: '需求说明.md', content_type: 'text/markdown', data_base64: 'c2FtcGxl' }],
      },
      'csrf-token',
    );
  });

  it('renders persisted markdown and attachment metadata from the session timeline', async () => {
    const api = createDetailApi({
      getSessionTimeline: jest.fn(async () => ({
        has_more: false,
        items: [
          {
            session_id: 'session-1',
            seq: 12,
            item_type: 'assistant_message',
            role: 'assistant',
            text: '## 处理结果\n\n已生成 **报告**：[打开报告](/srv/work/report.md)',
            tool_call_id: null,
            tool_name: null,
            status: 'completed',
            payload: {},
            created_at: '2026-07-19T10:00:00Z',
          },
          {
            session_id: 'session-1',
            seq: 13,
            item_type: 'user_message',
            role: 'user',
            text: '请处理附件',
            tool_call_id: null,
            tool_name: null,
            status: 'completed',
            payload: {
              attachments: [
                { filename: '需求说明.md', content_type: 'text/markdown', size_bytes: 4096 },
              ],
            },
            created_at: '2026-07-19T10:01:00Z',
          },
        ],
      })),
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

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Markdown 内容' })).not.toHaveLength(0);
    expect(renderedText(renderer)).toContain('需求说明.md');
    expect(renderedText(renderer)).toContain('4 KB');
  });

  it('stops a native recording, transcribes it, and appends the text to the composer', async () => {
    const stopRecording = jest.fn(async () => ({
      filename: 'voice.m4a',
      content_type: 'audio/mp4',
      data_base64: 'YXVkaW8=',
      duration_ms: 1600,
      chunk_count: 1,
    }));
    jest.mocked(useNativeVoiceRecorder).mockReturnValue({
      durationMillis: 1600,
      isRecording: true,
      startRecording: jest.fn(async () => undefined),
      stopRecording,
    });
    const transcribeVoice = jest.fn(async () => ({
      text: '识别后的文字',
      diagnostics: { input_bytes: 5 },
    }));
    const api = createDetailApi({ transcribeVoice });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
        voiceLanguage="en-US"
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '停止录音并识别' })));
    await settle();

    expect(stopRecording).toHaveBeenCalled();
    expect(transcribeVoice).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'voice.m4a', language: 'en-US' }),
      'csrf-token',
    );
    expect(renderer.root.findByProps({ accessibilityLabel: '回复内容' }).props.value).toBe('识别后的文字');
  });

  it('does not reserve composer height twice below the timeline', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    const timeline = renderer.root.findByProps({ accessibilityLabel: '会话消息列表' });
    const style = timeline.props.contentContainerStyle;
    const styles = Array.isArray(style) ? style : [style];
    const paddingBottom = styles
      .filter(Boolean)
      .reduce((result, entry) => {
        if (typeof entry?.paddingBottom === 'number') return Math.max(result, entry.paddingBottom);
        return result;
      }, 0);

    expect(paddingBottom).toBeLessThanOrEqual(24);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '会话消息底部留白' })).toHaveLength(0);
  });

  it('does not show a jump button before the reader scrolls away from the bottom', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    const timeline = renderer.root.findByProps({ accessibilityLabel: '会话消息列表' });
    await act(async () => timeline.props.onContentSizeChange?.(320, 960));
    await settle();

    expect(renderer.root.findAllByProps({ accessibilityLabel: '回到底部' })).toHaveLength(0);
  });

  it('wires a timeline scroll handler for jump-to-latest behavior', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    const timeline = renderer.root.findByProps({ accessibilityLabel: '会话消息列表' });
    const onScroll = timeline.props.onScroll;
    expect(typeof onScroll).toBe('function');
    expect(onScroll as ((event: unknown) => void) | undefined).toBeDefined();
  });

  it('uses scroll hysteresis so the jump button does not flash near the bottom', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    const timeline = renderer.root.findByProps({ accessibilityLabel: '会话消息列表' });
    const scroll = async (offsetY: number) => {
      await act(async () => timeline.props.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: offsetY },
          contentSize: { height: 1_000, width: 320 },
          layoutMeasurement: { height: 400, width: 320 },
        },
      }));
      await settle();
    };

    await scroll(440);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '回到底部' }).length).toBeGreaterThan(0);

    await scroll(510);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '回到底部' }).length).toBeGreaterThan(0);

    await scroll(560);
    expect(renderer.root.findAllByProps({ accessibilityLabel: '回到底部' })).toHaveLength(0);
  });

  it('renders account quick replies instead of a hardcoded list', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        quickReplies={['继续推进', '换个方案']}
        session={session}
      />,
    );
    await settle();

    expect(renderer.root.findAllByProps({ accessibilityLabel: '快捷回复 继续推进' })).toHaveLength(0);
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '展开回复选项' })));
    expect(renderer.root.findByProps({ accessibilityLabel: '快捷回复 继续推进' })).toBeTruthy();
    expect(renderer.root.findByProps({ accessibilityLabel: '快捷回复 换个方案' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ accessibilityLabel: '快捷回复 Implement the plan' })).toHaveLength(0);
  });

  it('does not expose completed as raw internal status copy', async () => {
    const renderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    expect(renderedText(renderer)).not.toContain('completed');
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

  it('highlights and acknowledges the exact approval opened from a notification', async () => {
    const onFocusedPermissionHandled = jest.fn();
    const api = createDetailApi({
      listPermissions: jest.fn(async () => ({ items: [questionPermission] })),
    });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canTerminate
        csrfToken="csrf-token"
        focusedPermissionId="permission-question"
        onBack={jest.fn()}
        onFocusedPermissionHandled={onFocusedPermissionHandled}
        session={session}
      />,
    );

    await settle();

    expect(renderer.root.findByProps({ accessibilityLabel: '通知定位：维护窗口' })).toBeTruthy();
    expect(onFocusedPermissionHandled).toHaveBeenCalledWith('permission-question');
  });

  it('explains why a viewer or archived session cannot accept replies', async () => {
    const viewerRenderer = await render(
      <SessionDetailScreen
        api={createDetailApi()}
        canOperate={false}
        canTerminate={false}
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();
    expect(renderedText(viewerRenderer)).toContain('当前账户只有查看权限');
    expect(viewerRenderer.root.findByProps({ accessibilityLabel: '回复内容' }).props.editable).toBe(false);

    const archivedRenderer = await render(
      <SessionDetailScreen
        api={createDetailApi({ getSession: jest.fn(async () => ({ session: { ...session, archived_at: '2026-07-19T01:00:00Z' } })) })}
        canOperate
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={{ ...session, archived_at: '2026-07-19T01:00:00Z' }}
      />,
    );
    await settle();
    expect(renderedText(archivedRenderer)).toContain('会话已归档，恢复后才能回复');
  });

  it('lets an operator rename, fork, ask BTW, and archive a session through CSRF-protected actions', async () => {
    const renamed = { ...session, title: '同步问题已定位' };
    const renameSession = jest.fn(async () => ({ session: renamed }));
    const forkSession = jest.fn(async () => ({ job: { job_id: 'fork-1' } }));
    const askSessionBtw = jest.fn(async () => ({ job: { job_id: 'btw-1' } }));
    const archiveSession = jest.fn(async () => ({ session: { ...renamed, archived_at: '2026-07-19T00:00:00Z' } }));
    const api = createDetailApi({ archiveSession, askSessionBtw, forkSession, renameSession });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canOperate
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话操作' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '重命名会话' })));
    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: '会话名称' }), '同步问题已定位'));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '保存会话名称' })));
    await settle();
    expect(renameSession).toHaveBeenCalledWith('session-1', '同步问题已定位', 'csrf-token');
    expect(renderedText(renderer)).toContain('同步问题已定位');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话操作' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: 'Fork 会话' })));
    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: 'Fork 提示词' }), '改用另一条实现路径'));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '提交 Fork' })));
    await settle();
    expect(forkSession).toHaveBeenCalledWith('session-1', { prompt: '改用另一条实现路径' }, 'csrf-token');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话操作' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: 'BTW 提问' })));
    await act(async () => changeText(renderer.root.findByProps({ accessibilityLabel: 'BTW 提示词' }), '这个设计是否还有风险？'));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '提交 BTW' })));
    await settle();
    expect(askSessionBtw).toHaveBeenCalledWith('session-1', { prompt: '这个设计是否还有风险？' }, 'csrf-token');

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话操作' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '归档会话' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '确认归档会话' })));
    await settle();
    expect(archiveSession).toHaveBeenCalledWith('session-1', 'csrf-token');
    expect(renderedText(renderer)).toContain('已归档');
  });

  it('updates runtime controls from provider-reported options', async () => {
    const updateSessionControls = jest.fn(async (_sessionId: string, controls: Record<string, unknown>) => ({
      session: {
        ...session,
        controls,
      },
    }));
    const api = createDetailApi({
      listProviderSnapshots: jest.fn(async () => ({
        items: [{
          worker_id: 'worker-main',
          backend: 'codex',
          status: 'ready',
          auth_status: 'ready',
          models: [{ id: 'gpt-5.6', label: 'GPT-5.6' }],
          modes: [
            { kind: 'sandbox_mode', id: 'workspace-write' },
            { kind: 'sandbox_mode', id: 'danger-full-access' },
            { kind: 'approval_mode', id: 'never' },
            { kind: 'approval_mode', id: 'on-request' },
            { kind: 'permission_mode', id: 'default' },
            { kind: 'permission_mode', id: 'bypassPermissions' },
            { kind: 'interaction_bridge', id: 'compatibility' },
            { kind: 'interaction_bridge', id: 'tmux' },
          ],
          features: {},
          diagnostics: {},
          fetched_at: '2026-07-19T00:00:00Z',
          updated_at: '2026-07-19T00:00:00Z',
        }],
      })),
      updateSessionControls,
    });
    const renderer = await render(
      <SessionDetailScreen
        api={api}
        canOperate
        canTerminate
        csrfToken="csrf-token"
        onBack={jest.fn()}
        session={session}
      />,
    );
    await settle();

    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '打开会话操作' })));
    await settle();
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择模型 GPT-5.6' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择沙箱 danger-full-access' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择审批 never' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择权限策略 bypassPermissions' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '选择交互桥 tmux' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '切换 Yolo' })));
    await act(async () => press(renderer.root.findByProps({ accessibilityLabel: '保存运行控制' })));
    await settle();

    expect(updateSessionControls).toHaveBeenCalledWith('session-1', {
      model: 'gpt-5.6',
      sandbox_mode: 'danger-full-access',
      approval_mode: 'never',
      permission_mode: 'bypassPermissions',
      interaction_bridge: 'tmux',
      yolo: true,
    }, 'csrf-token');
    expect(renderedText(renderer)).toContain('运行控制已更新');
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
