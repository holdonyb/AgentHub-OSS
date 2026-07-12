export type ServerProbeResult = { ok: true } | { ok: false; error: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function resolveHealthUrl(serverUrl: string): string {
  return new URL('/healthz', serverUrl).toString();
}

export async function probeAgentHubServer(
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 8_000,
): Promise<ServerProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(resolveHealthUrl(serverUrl), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, error: `服务器健康检查失败（HTTP ${response.status}）` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: '无法连接服务器，请检查地址、网络和 HTTPS 证书' };
  } finally {
    clearTimeout(timeout);
  }
}
