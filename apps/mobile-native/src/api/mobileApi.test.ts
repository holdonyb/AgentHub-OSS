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
});
