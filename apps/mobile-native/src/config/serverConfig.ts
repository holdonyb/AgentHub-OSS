import { normalizeServerUrl } from '@agenthub/client-core';

export type ServerUrlValidationReason =
  | 'required'
  | 'invalid_url'
  | 'origin_only'
  | 'https_required'
  | 'private_http_only';

export type ServerUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: ServerUrlValidationReason };

export interface ServerUrlValidationOptions {
  allowPrivateHttp?: boolean;
}

function ipv4Parts(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const values = parts.map((part) => Number(part));
  if (values.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return values;
}

function isTailscaleIpv4(hostname: string): boolean {
  const parts = ipv4Parts(hostname);
  if (!parts) return false;
  const first = parts[0];
  const second = parts[1];
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

function isPrivateDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.endsWith('.ts.net') ||
    normalized.startsWith('fd7a:115c:a1e0:') ||
    isTailscaleIpv4(normalized)
  );
}

export function validateServerUrl(
  value: string,
  options: ServerUrlValidationOptions = {},
): ServerUrlValidationResult {
  const raw = value.trim();
  if (!raw) return { ok: false, reason: 'required' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    return { ok: false, reason: 'origin_only' };
  }

  if (parsed.protocol === 'http:') {
    if (!options.allowPrivateHttp) return { ok: false, reason: 'https_required' };
    if (!isPrivateDevelopmentHost(parsed.hostname)) {
      return { ok: false, reason: 'private_http_only' };
    }
  } else if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_url' };
  }

  const normalized = normalizeServerUrl(raw, { allowInsecure: parsed.protocol === 'http:' });
  return normalized ? { ok: true, url: normalized } : { ok: false, reason: 'invalid_url' };
}

export interface ServerConfig {
  serverUrl: string;
  allowPrivateHttp: boolean;
}
