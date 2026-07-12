import { resolveAuthRoute } from './authRoute';

describe('resolveAuthRoute', () => {
  it('keeps the launch screen visible while configuration is loading', () => {
    expect(resolveAuthRoute({ configuration: 'loading', authentication: 'unknown' })).toBe('loading');
  });

  it('routes first launch to server setup', () => {
    expect(resolveAuthRoute({ configuration: 'missing', authentication: 'unknown' })).toBe('server-setup');
  });

  it('waits while an existing server session is checked', () => {
    expect(resolveAuthRoute({ configuration: 'ready', authentication: 'checking' })).toBe('loading');
  });

  it('routes signed-out users to login', () => {
    expect(resolveAuthRoute({ configuration: 'ready', authentication: 'signed-out' })).toBe('login');
  });

  it('routes signed-in users to the native tab shell', () => {
    expect(resolveAuthRoute({ configuration: 'ready', authentication: 'signed-in' })).toBe('main');
  });
});
