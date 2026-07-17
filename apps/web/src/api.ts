import { createAgentHubClient } from '@agenthub/client-core';

const client = createAgentHubClient();

export function apiGet<T>(url: string): Promise<T> {
  return client.get<T>(url);
}

export function apiPost<T>(url: string, body: unknown, csrfToken?: string): Promise<T> {
  return client.post<T>(url, body, { csrfToken });
}

export function apiPatch<T>(url: string, body: unknown, csrfToken?: string): Promise<T> {
  return client.patch<T>(url, body, { csrfToken });
}

export function apiPutRaw<T>(url: string, body: BodyInit, contentType: string, csrfToken?: string): Promise<T> {
  return client.putRaw<T>(url, body, {
    csrfToken,
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
  });
}
