export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ServerUrlOptions {
  allowInsecure?: boolean;
}

export interface RequestOptions {
  csrfToken?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface AgentHubClientOptions {
  baseUrl?: string;
  fetcher?: FetchLike;
  getBearerToken?: () => string | null | undefined | Promise<string | null | undefined>;
}

export class AgentHubApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: unknown;

  constructor({ status, code, message, detail }: { status: number; code?: string | null; message: string; detail?: unknown }) {
    super(message);
    this.name = 'AgentHubApiError';
    this.status = status;
    this.code = code ?? null;
    this.detail = detail;
  }
}

export function normalizeServerUrl(value: string | null | undefined, options: ServerUrlOptions = {}): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(options.allowInsecure && url.protocol === 'http:')) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function endpointUrl(baseUrl: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('AgentHub API paths must be root-relative');
  }
  return baseUrl ? `${baseUrl}${path}` : path;
}

async function errorFromResponse(response: Response): Promise<AgentHubApiError> {
  const payload = await response.json().catch(() => null) as
    | { detail?: { message?: unknown; code?: unknown } | string; message?: unknown; code?: unknown }
    | null;
  const detail = payload?.detail;
  const message =
    (typeof detail === 'object' && detail && typeof detail.message === 'string' && detail.message) ||
    (typeof detail === 'string' && detail) ||
    (typeof payload?.message === 'string' && payload.message) ||
    `${response.status}`;
  const code =
    (typeof detail === 'object' && detail && typeof detail.code === 'string' && detail.code) ||
    (typeof payload?.code === 'string' && payload.code) ||
    null;
  return new AgentHubApiError({ status: response.status, code, message, detail: payload });
}

export function createAgentHubClient(options: AgentHubClientOptions = {}) {
  const normalizedBaseUrl = options.baseUrl
    ? normalizeServerUrl(options.baseUrl, { allowInsecure: true })
    : null;
  if (options.baseUrl && !normalizedBaseUrl) throw new Error('Invalid AgentHub server URL');
  const baseUrl = normalizedBaseUrl ?? '';

  async function request<T>(method: string, path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<T> {
    const token = await options.getBearerToken?.();
    const headers: Record<string, string> = { ...requestOptions.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (requestOptions.csrfToken) headers['X-CSRF-Token'] = requestOptions.csrfToken;
    const response = await (options.fetcher ?? globalThis.fetch)(endpointUrl(baseUrl, path), {
      method,
      credentials: options.getBearerToken ? 'omit' : 'include',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestOptions.signal,
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  return {
    get: <T>(path: string, requestOptions?: RequestOptions) => request<T>('GET', path, undefined, requestOptions),
    post: <T>(path: string, body: unknown, requestOptions?: RequestOptions) => request<T>('POST', path, body, requestOptions),
    patch: <T>(path: string, body: unknown, requestOptions?: RequestOptions) => request<T>('PATCH', path, body, requestOptions),
    delete: <T>(path: string, requestOptions?: RequestOptions) => request<T>('DELETE', path, undefined, requestOptions),
  };
}
