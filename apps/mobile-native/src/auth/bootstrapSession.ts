import { AgentHubApiError } from '@agenthub/client-core';
import { createMobileApi, type MobileApi, type NativeAuthPayload } from '../api/mobileApi';
import type { ServerConfig } from '../config/serverConfig';
import { resolveAuthRoute, type AuthRoute } from './authRoute';

export interface ServerConfigLoader {
  load(): Promise<ServerConfig | null>;
}

export interface BootstrapSessionResult {
  route: AuthRoute;
  config: ServerConfig | null;
  auth: NativeAuthPayload | null;
  error: string | null;
}

export type MobileApiFactory = (serverUrl: string) => Pick<MobileApi, 'me'>;

export async function bootstrapSession(
  repository: ServerConfigLoader,
  createApi: MobileApiFactory = createMobileApi,
): Promise<BootstrapSessionResult> {
  let config: ServerConfig | null;
  try {
    config = await repository.load();
  } catch (error) {
    return {
      route: 'server-setup',
      config: null,
      auth: null,
      error: error instanceof Error ? error.message : '无法读取设备安全存储',
    };
  }
  if (!config) {
    return {
      route: resolveAuthRoute({ configuration: 'missing', authentication: 'unknown' }),
      config: null,
      auth: null,
      error: null,
    };
  }

  try {
    const auth = await createApi(config.serverUrl).me();
    return {
      route: resolveAuthRoute({ configuration: 'ready', authentication: 'signed-in' }),
      config,
      auth,
      error: null,
    };
  } catch (error) {
    if (error instanceof AgentHubApiError && error.status === 401) {
      return {
        route: resolveAuthRoute({ configuration: 'ready', authentication: 'signed-out' }),
        config,
        auth: null,
        error: null,
      };
    }
    return {
      route: resolveAuthRoute({ configuration: 'ready', authentication: 'signed-out' }),
      config,
      auth: null,
      error: error instanceof Error ? error.message : '无法连接服务器',
    };
  }
}
