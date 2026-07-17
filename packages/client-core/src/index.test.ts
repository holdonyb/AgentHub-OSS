import { describe, expect, it, vi } from 'vitest';
import { AgentHubApiError, createAgentHubClient, normalizeServerUrl } from './index';

describe('client-core HTTP transport', () => {
  it('normalizes HTTPS and explicitly allowed private HTTP servers', () => {
    expect(normalizeServerUrl(' https://agenthub.example.com/ ')).toBe('https://agenthub.example.com');
    expect(normalizeServerUrl('http://100.64.0.5:43080')).toBeNull();
    expect(normalizeServerUrl('http://100.64.0.5:43080', { allowInsecure: true })).toBe(
      'http://100.64.0.5:43080',
    );
    expect(normalizeServerUrl('file:///tmp/agenthub')).toBeNull();
  });

  it('uses bearer auth without cookie credentials for native clients', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createAgentHubClient({
      baseUrl: 'https://agenthub.example.com/',
      fetcher,
      getBearerToken: async () => 'device-token',
    });

    await expect(client.post<{ ok: boolean }>('/api/test', { value: 1 })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      'https://agenthub.example.com/api/test',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        headers: expect.objectContaining({
          Authorization: 'Bearer device-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ value: 1 }),
      }),
    );
  });

  it('uses cookie credentials and CSRF for the web client', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createAgentHubClient({ fetcher });

    await client.patch('/api/settings', { enabled: true }, { csrfToken: 'csrf-token' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    );
  });

  it('uploads raw bodies without JSON encoding them', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createAgentHubClient({ fetcher });
    const file = new Blob(['remote workspace'], { type: 'text/plain' });

    await expect(
      client.putRaw<{ ok: boolean }>('/api/workspaces/files/transfers/xfr-1/content', file, {
        csrfToken: 'csrf-token',
        headers: { 'Content-Type': 'text/plain' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith(
      '/api/workspaces/files/transfers/xfr-1/content',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'text/plain',
          'X-CSRF-Token': 'csrf-token',
        }),
        body: file,
      }),
    );
  });

  it('resolves the global fetch implementation at request time', async () => {
    const originalFetch = globalThis.fetch;
    const client = createAgentHubClient();
    const replacement = vi.fn(async () =>
      new Response(JSON.stringify({ source: 'replacement' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = replacement;
    try {
      await expect(client.get('/api/runtime-fetch')).resolves.toEqual({ source: 'replacement' });
      expect(replacement).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves the existing web GET request shape', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createAgentHubClient({ fetcher });

    const request = client.get('/api/workers');

    expect(fetcher).toHaveBeenCalledWith('/api/workers', { credentials: 'include' });
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('returns structured API errors and supports empty responses', async () => {
    const responses = [
      new Response(JSON.stringify({ detail: { message: 'Worker offline', code: 'WORKER_OFFLINE' } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(null, { status: 204 }),
    ];
    const client = createAgentHubClient({ fetcher: vi.fn(async () => responses.shift()!) });

    await expect(client.get('/api/fail')).rejects.toMatchObject({
      status: 409,
      code: 'WORKER_OFFLINE',
      message: 'Worker offline',
    });
    await expect(client.get('/api/empty')).resolves.toBeUndefined();
  });
});
