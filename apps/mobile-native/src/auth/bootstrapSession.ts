import { AgentHubApiError } from '@agenthub/client-core';
import { createMobileApi, type MobileApi, type NativeAuthPayload } from '../api/mobileApi';
import type { ServerConfig } from '../config/serverConfig';

export interface ServerConfigLoader {
  load(): Promise<ServerConfig | null>;
}

export interface BootstrapSessionResult {
  route: 'server-setup' | 'login' | 'main';
  config: ServerConfig | null;
  auth: NativeAuthPayload | null;
  error: string | null;
}

export type MobileApiFactory = (serverUrl: string) => MobileApi;

export async function bootstrapSession(
  repository: ServerConfigLoader,
  createApi: MobileApiFactory = createMobileApi,
): Promise<BootstrapSessionResult> {
  const config = await repository.load();
  if (!config) return { route: 'server-setup', config: null, auth: null, error: null };

  try {
    const auth = await createApi(config.serverUrl).me();
    return { route: 'main', config, auth, error: null };
  } catch (error) {
    if (error instanceof AgentHubApiError && error.status === 401) {
      return { route: 'login', config, auth: null, error: null };
    }
    return {
      route: 'login',
      config,
      auth: null,
      error: error instanceof Error ? error.message : '无法连接服务器',
    };
  }
}
