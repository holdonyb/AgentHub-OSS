import type { FetchLike } from '@agenthub/client-core';
import { createMobileApi } from './mobileApi';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

describe('mobile API', () => {
  it('logs in through client-core using the configured server origin', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse({
        user: { id: 'user-1', email: 'owner@example.com', role: 'owner' },
        csrf_token: 'csrf',
      }),
    );
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await expect(api.login('owner@example.com', 'correct-password')).resolves.toMatchObject({
      user: { id: 'user-1', email: 'owner@example.com' },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://agenthub.example.com/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ email: 'owner@example.com', password: 'correct-password' }),
      }),
    );
  });

  it('checks and closes the native cookie session through the same transport', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        jsonResponse({ user: { id: 'user-1', email: 'owner@example.com', role: 'owner' }, csrf_token: 'csrf' }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.me();
    await api.logout('csrf', 'phone-install-1');

    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://agenthub.example.com/api/auth/me', {
      credentials: 'include',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ device_id: 'phone-install-1' }),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf' }),
      }),
    );
  });

  it('loads sessions and workers through client-core', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ session_id: 'session-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ worker_id: 'worker-1' }] }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await expect(api.listSessions()).resolves.toEqual({ items: [{ session_id: 'session-1' }] });
    await expect(api.listWorkers()).resolves.toEqual({ items: [{ worker_id: 'worker-1' }] });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/sessions',
      { credentials: 'include' },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/workers',
      { credentials: 'include' },
    );
  });

  it('loads and transitions the authoritative notification ledger', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ notification_id: 'notice/1', status: 'pending' }] }))
      .mockResolvedValueOnce(jsonResponse({ claimed: true, notification: { notification_id: 'notice/1', status: 'delivered' } }))
      .mockResolvedValueOnce(jsonResponse({ claimed: false, notification: { notification_id: 'notice/1', status: 'read' } }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.listNotifications();
    await api.markNotificationDelivered('notice/1', 'csrf-token');
    await api.markNotificationRead('notice/1', 'csrf-token');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/notifications?limit=200',
      { credentials: 'include' },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/notifications/notice%2F1/delivered',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://agenthub.example.com/api/notifications/notice%2F1/read',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });

  it('registers and revokes a push device with CSRF protection', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ device: { device_id: 'phone-install-1', enabled: true } }))
      .mockResolvedValueOnce(jsonResponse({ revoked: true }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);
    const payload = {
      device_id: 'phone-install-1',
      platform: 'android' as const,
      transport: 'expo' as const,
      push_token: 'ExponentPushToken[private-token]',
      app_version: '1.0.0',
    };

    await api.upsertPushDevice(payload, 'csrf-token');
    await api.revokePushDevice('phone-install-1', 'csrf-token');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/push/devices',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/push/devices/phone-install-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });

  it('filters tasks by status and loads the selected task detail', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ task_id: 'task-1', status: 'working' }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          task: { task_id: 'task-1', status: 'working' },
          artifacts: [],
          executions: [],
        }),
      );
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.listTasks('working');
    await api.getTask('task-1');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/tasks?status=working',
      { credentials: 'include' },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/tasks/task-1',
      { credentials: 'include' },
    );
  });

  it('creates and reviews tasks with CSRF protection', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(
        jsonResponse({ task: { task_id: 'task-1', status: 'queued' }, job: { job_id: 'job-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ task: { task_id: 'task-1', status: 'accepted' } }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);
    const createPayload = {
      title: '修复同步',
      brief_markdown: '修复详情页消息同步。',
      success_criteria_markdown: '- 无需退出详情页即可看到最终消息',
      target_worker_id: 'worker-main',
      backend: 'codex',
      workspace_root: 'E:/Work/AgentHub-OSS',
      namespace: 'default',
      priority: 100,
      template_key: 'fix_bug' as const,
      authority_preset: 'code_fix' as const,
      relevant_paths: ['apps/mobile-native'],
      submit: true,
    };

    await api.createTask(createPayload, 'csrf-token');
    await api.reviewTask('task/1', { action: 'accept', note_markdown: '' }, 'csrf-token');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(createPayload),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/tasks/task%2F1/review',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'accept', note_markdown: '' }),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });

  it('submits workspace file jobs and reads their session sync state', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ job: { job_id: 'list-job', status: 'queued' } }))
      .mockResolvedValueOnce(jsonResponse({ job: { job_id: 'read-job', status: 'queued' } }))
      .mockResolvedValueOnce(jsonResponse({ job: { job_id: 'write-job', status: 'queued' } }))
      .mockResolvedValueOnce(
        jsonResponse({ session: { session_id: 'session/1' }, items: [], jobs: [], has_more: false }),
      );
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.listSessionFiles('session/1', { path: 'src' }, 'csrf-token');
    await api.readSessionFile('session/1', { path: 'src/App.tsx', max_bytes: 5000000 }, 'csrf-token');
    await api.writeSessionFile(
      'session/1',
      { path: 'src/App.tsx', text: 'export default App;', expected_modified_at: '2026-07-12T00:00:00Z' },
      'csrf-token',
    );
    await api.getSessionSync('session/1');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/sessions/session%2F1/files/list',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'src' }),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/sessions/session%2F1/files/read',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://agenthub.example.com/api/sessions/session%2F1/files/write',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      'https://agenthub.example.com/api/sync/session/session%2F1?limit=200',
      { credentials: 'include' },
    );
  });

  it('loads a session thread and its pending interactions through encoded paths', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ session: { session_id: 'session/1' } }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ seq: 1, text: 'hello' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ permission_id: 'permission-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ job_id: 'job-1' }] }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.getSession('session/1');
    await api.getSessionTimeline('session/1');
    await api.listPermissions('session/1', 'pending');
    await api.listJobs();

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/sessions/session%2F1',
      { credentials: 'include' },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/sessions/session%2F1/timeline?limit=100',
      { credentials: 'include' },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://agenthub.example.com/api/permissions?status=pending&session_id=session%2F1',
      { credentials: 'include' },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      'https://agenthub.example.com/api/jobs?limit=200',
      { credentials: 'include' },
    );
  });

  it('loads all pending interactions for the native notification guard', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse({ items: [] }),
    );
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.listPermissions(undefined, 'pending');

    expect(fetcher).toHaveBeenCalledWith(
      'https://agenthub.example.com/api/permissions?status=pending',
      { credentials: 'include' },
    );
  });

  it('loads older timeline pages with a stable created-at and sequence cursor', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse({ items: [], has_more: false }),
    );
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.getSessionTimeline('session/1', {
      beforeCreatedAt: '2026-07-11T10:01:00Z',
      beforeSeq: 12,
      limit: 50,
    });

    expect(fetcher).toHaveBeenCalledWith(
      'https://agenthub.example.com/api/sessions/session%2F1/timeline?limit=50&before_created_at=2026-07-11T10%3A01%3A00Z&before_seq=12',
      { credentials: 'include' },
    );
  });

  it('sends replies, resolves interactions, and terminates with CSRF protection', async () => {
    const fetcher = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValueOnce(jsonResponse({ job: { job_id: 'job-1', status: 'queued' } }))
      .mockResolvedValueOnce(jsonResponse({ permission: { permission_id: 'permission-1', status: 'answered' } }))
      .mockResolvedValueOnce(jsonResponse({ session: { session_id: 'session-1', status: 'terminated' } }));
    const api = createMobileApi('https://agenthub.example.com', fetcher);

    await api.sendSessionInput(
      'session-1',
      {
        prompt: '第一行\n第二行',
        attachments: [{ filename: 'screen.png', content_type: 'image/png', data_base64: 'aW1hZ2U=' }],
      },
      'csrf-token',
    );
    await api.respondPermission(
      'permission-1',
      'answer',
      { answers: { direction: { choice: 'direction:0', label: '先做 UI' } } },
      'csrf-token',
    );
    await api.terminateSession('session-1', 'csrf-token');

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://agenthub.example.com/api/sessions/session-1/input',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: '第一行\n第二行',
          attachments: [{ filename: 'screen.png', content_type: 'image/png', data_base64: 'aW1hZ2U=' }],
        }),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/permissions/permission-1/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'answer',
          response: { answers: { direction: { choice: 'direction:0', label: '先做 UI' } } },
        }),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://agenthub.example.com/api/sessions/session-1/terminate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });

  it('submits native audio for server-side transcription', async () => {
    const fetcher = jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(async () =>
      jsonResponse({ text: '识别后的文字', diagnostics: { input_bytes: 12 } }),
    );
    const api = createMobileApi('https://agenthub.example.com', fetcher);
    const payload = {
      filename: 'voice.m4a',
      content_type: 'audio/mp4',
      data_base64: 'YXVkaW8=',
      duration_ms: 1600,
      chunk_count: 1,
      language: 'zh-CN',
    };

    await api.transcribeVoice(payload, 'csrf-token');

    expect(fetcher).toHaveBeenCalledWith(
      'https://agenthub.example.com/api/voice/transcribe',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });
});
