import { validateServerUrl, type ServerConfig } from './serverConfig';

export interface SecureKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const SERVER_CONFIG_KEY = 'agenthub.server-config.v1';

export class ServerConfigRepository {
  constructor(private readonly storage: SecureKeyValueStore) {}

  async load(): Promise<ServerConfig | null> {
    const stored = await this.storage.getItem(SERVER_CONFIG_KEY);
    if (!stored) return null;

    try {
      const candidate = JSON.parse(stored) as Partial<ServerConfig>;
      if (typeof candidate.serverUrl !== 'string' || typeof candidate.allowPrivateHttp !== 'boolean') {
        throw new Error('Invalid stored server configuration');
      }
      const result = validateServerUrl(candidate.serverUrl, {
        allowPrivateHttp: candidate.allowPrivateHttp,
      });
      if (!result.ok) throw new Error(result.reason);
      return { serverUrl: result.url, allowPrivateHttp: candidate.allowPrivateHttp };
    } catch {
      await this.storage.deleteItem(SERVER_CONFIG_KEY);
      return null;
    }
  }

  async save(config: ServerConfig): Promise<ServerConfig> {
    const result = validateServerUrl(config.serverUrl, {
      allowPrivateHttp: config.allowPrivateHttp,
    });
    if (!result.ok) throw new Error(result.reason);
    const normalized = { serverUrl: result.url, allowPrivateHttp: config.allowPrivateHttp };
    await this.storage.setItem(SERVER_CONFIG_KEY, JSON.stringify(normalized));
    return normalized;
  }

  async clear(): Promise<void> {
    await this.storage.deleteItem(SERVER_CONFIG_KEY);
  }
}
