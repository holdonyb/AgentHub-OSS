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
    await api.logout('csrf');

    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://agenthub.example.com/api/auth/me', {
      credentials: 'include',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://agenthub.example.com/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
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

    await api.sendSessionInput('session-1', { prompt: '第一行\n第二行' }, 'csrf-token');
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
        body: JSON.stringify({ prompt: '第一行\n第二行' }),
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
});
