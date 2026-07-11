import { createAgentHubClient, type FetchLike } from '@agenthub/client-core';

export interface NativeUser {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  created_at?: string;
}

export interface NativeAuthPayload {
  user: NativeUser;
  csrf_token: string;
  space?: {
    space_id: string;
    name: string;
    slug: string;
    mode: string;
    role?: string | null;
  } | null;
}

export interface MobileApi {
  login(email: string, password: string): Promise<NativeAuthPayload>;
  me(): Promise<NativeAuthPayload>;
  logout(csrfToken: string): Promise<{ ok: boolean }>;
}

export function createMobileApi(baseUrl: string, fetcher?: FetchLike): MobileApi {
  const client = createAgentHubClient({ baseUrl, fetcher });
  return {
    login: (email, password) =>
      client.post<NativeAuthPayload>('/api/auth/login', { email, password }),
    me: () => client.get<NativeAuthPayload>('/api/auth/me'),
    logout: (csrfToken) =>
      client.post<{ ok: boolean }>('/api/auth/logout', {}, { csrfToken }),
  };
}
