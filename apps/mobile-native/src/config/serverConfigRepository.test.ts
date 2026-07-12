import { ServerConfigRepository, type SecureKeyValueStore } from './serverConfigRepository';

class MemorySecureStore implements SecureKeyValueStore {
  values = new Map<string, string>();

  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  async deleteItem(key: string) {
    this.values.delete(key);
  }
}

describe('ServerConfigRepository', () => {
  it('persists and restores a validated server configuration', async () => {
    const storage = new MemorySecureStore();
    const repository = new ServerConfigRepository(storage);

    await repository.save({
      serverUrl: 'http://100.64.12.34:43073',
      allowPrivateHttp: true,
    });

    await expect(repository.load()).resolves.toEqual({
      serverUrl: 'http://100.64.12.34:43073',
      allowPrivateHttp: true,
    });
  });

  it('rejects invalid configuration before writing SecureStore', async () => {
    const storage = new MemorySecureStore();
    const repository = new ServerConfigRepository(storage);

    await expect(
      repository.save({ serverUrl: 'http://agenthub.example.com', allowPrivateHttp: true }),
    ).rejects.toThrow('private_http_only');
    expect(storage.values.size).toBe(0);
  });

  it('ignores corrupt or obsolete SecureStore values', async () => {
    const storage = new MemorySecureStore();
    storage.values.set('agenthub.server-config.v1', '{bad json');
    const repository = new ServerConfigRepository(storage);

    await expect(repository.load()).resolves.toBeNull();
    expect(storage.values.has('agenthub.server-config.v1')).toBe(false);
  });

  it('clears the persisted configuration', async () => {
    const storage = new MemorySecureStore();
    const repository = new ServerConfigRepository(storage);
    await repository.save({ serverUrl: 'https://agenthub.example.com', allowPrivateHttp: false });

    await repository.clear();

    await expect(repository.load()).resolves.toBeNull();
  });
});
