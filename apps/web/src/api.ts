export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(url: string, body: unknown, csrfToken?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.detail?.message ?? `${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function apiPatch<T>(url: string, body: unknown, csrfToken?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, {
    method: 'PATCH',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.detail?.message ?? `${response.status}`);
  }
  return response.json() as Promise<T>;
}
