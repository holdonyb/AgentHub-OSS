import { AgentHubApiError } from '@agenthub/client-core';
import type { MobileApi, NativeAuthPayload } from '../api/mobileApi';
import type { ServerConfig } from '../config/serverConfig';
import { bootstrapSession } from './bootstrapSession';

const config: ServerConfig = {
  serverUrl: 'https://agenthub.example.com',
  allowPrivateHttp: false,
};

const authPayload: NativeAuthPayload = {
  user: { id: 'user-1', email: 'owner@example.com', role: 'owner' },
  csrf_token: 'csrf',
};

function apiWithMe(me: MobileApi['me']): MobileApi {
  return {
    me,
    login: jest.fn(),
    logout: jest.fn(),
  };
}

describe('bootstrapSession', () => {
  it('routes first launch to server setup without creating an API client', async () => {
    const createApi = jest.fn();

    await expect(bootstrapSession({ load: async () => null }, createApi)).resolves.toEqual({
      route: 'server-setup',
      config: null,
      auth: null,
      error: null,
    });
    expect(createApi).not.toHaveBeenCalled();
  });

  it('routes SecureStore failures to setup with a visible error', async () => {
    const createApi = jest.fn();

    await expect(
      bootstrapSession(
        { load: async () => Promise.reject(new Error('Secure storage unavailable')) },
        createApi,
      ),
    ).resolves.toEqual({
      route: 'server-setup',
      config: null,
      auth: null,
      error: 'Secure storage unavailable',
    });
    expect(createApi).not.toHaveBeenCalled();
  });

  it('restores an authenticated cookie session', async () => {
    const createApi = jest.fn(() => apiWithMe(async () => authPayload));

    await expect(bootstrapSession({ load: async () => config }, createApi)).resolves.toEqual({
      route: 'main',
      config,
      auth: authPayload,
      error: null,
    });
  });

  it('routes expired sessions to login without hiding the configured server', async () => {
    const unauthorized = new AgentHubApiError({
      status: 401,
      code: 'AUTH_REQUIRED',
      message: 'Authentication required',
    });
    const createApi = jest.fn(() => apiWithMe(async () => Promise.reject(unauthorized)));

    await expect(bootstrapSession({ load: async () => config }, createApi)).resolves.toEqual({
      route: 'login',
      config,
      auth: null,
      error: null,
    });
  });

  it('keeps connection failures visible on the login route', async () => {
    const createApi = jest.fn(() => apiWithMe(async () => Promise.reject(new Error('Network request failed'))));

    await expect(bootstrapSession({ load: async () => config }, createApi)).resolves.toEqual({
      route: 'login',
      config,
      auth: null,
      error: 'Network request failed',
    });
  });
});
