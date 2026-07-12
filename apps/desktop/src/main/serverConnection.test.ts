import { describe, expect, it, vi } from 'vitest';
import { probeAgentHubServer, resolveHealthUrl } from './serverConnection';

describe('AgentHub desktop server connection', () => {
  it('probes the control-plane health endpoint at the configured origin', () => {
    expect(resolveHealthUrl('https://agenthub.example.com/console')).toBe(
      'https://agenthub.example.com/healthz',
    );
    expect(resolveHealthUrl('http://100.99.254.119:8019')).toBe(
      'http://100.99.254.119:8019/healthz',
    );
  });

  it('accepts a healthy AgentHub response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(probeAgentHubServer('https://agenthub.example.com', fetchImpl)).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://agenthub.example.com/healthz',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
  });

  it('returns an actionable error for an unhealthy or unreachable server', async () => {
    const unhealthy = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const unreachable = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    await expect(probeAgentHubServer('https://agenthub.example.com', unhealthy)).resolves.toEqual({
      ok: false,
      error: '服务器健康检查失败（HTTP 503）',
    });
    await expect(probeAgentHubServer('https://agenthub.example.com', unreachable)).resolves.toEqual({
      ok: false,
      error: '无法连接服务器，请检查地址、网络和 HTTPS 证书',
    });
  });
});
