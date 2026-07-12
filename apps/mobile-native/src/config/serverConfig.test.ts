import { validateServerUrl } from './serverConfig';

describe('validateServerUrl', () => {
  it('accepts HTTPS origins and removes the trailing slash', () => {
    expect(validateServerUrl(' https://agenthub.example.com/ ')).toEqual({
      ok: true,
      url: 'https://agenthub.example.com',
    });
  });

  it('requires the explicit development switch for HTTP', () => {
    expect(validateServerUrl('http://localhost:43073')).toEqual({
      ok: false,
      reason: 'https_required',
    });
  });

  it.each([
    'http://localhost:43073',
    'http://127.0.0.1:43073',
    'http://100.64.12.34:43073',
    'http://worker.tail1234.ts.net:43073',
    'http://[fd7a:115c:a1e0::42]:43073',
  ])('allows localhost and Tailscale HTTP with the development switch: %s', (url) => {
    expect(validateServerUrl(url, { allowPrivateHttp: true })).toEqual({
      ok: true,
      url,
    });
  });

  it('does not turn the development switch into arbitrary public HTTP', () => {
    expect(validateServerUrl('http://agenthub.example.com', { allowPrivateHttp: true })).toEqual({
      ok: false,
      reason: 'private_http_only',
    });
  });

  it.each([
    'https://agenthub.example.com/control',
    'https://user:password@agenthub.example.com',
    'https://agenthub.example.com?token=secret',
    'not-a-url',
  ])('rejects non-origin server addresses: %s', (url) => {
    expect(validateServerUrl(url).ok).toBe(false);
  });
});
