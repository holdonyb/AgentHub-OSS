import * as SecureStore from 'expo-secure-store';
import { addRecentFile, loadRecentFiles } from './recentFiles';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
});

it('keeps the newest unique workspace files first', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify([
    { sessionId: 'session-1', path: 'README.md', filename: 'README.md', openedAt: 1 },
    { sessionId: 'session-1', path: 'docs/plan.md', filename: 'plan.md', openedAt: 2 },
  ]));

  const items = await addRecentFile({
    sessionId: 'session-1',
    path: 'README.md',
    filename: 'README.md',
    openedAt: 3,
  });

  expect(items.map((item) => item.path)).toEqual(['README.md', 'docs/plan.md']);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    'agenthub.recentWorkspaceFiles.v1',
    JSON.stringify(items),
  );
});

it('ignores invalid persisted recent file records', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(JSON.stringify([
    { sessionId: 'session-1', path: 'README.md', filename: 'README.md', openedAt: 1 },
    { sessionId: '', path: 'bad.md', filename: 'bad.md', openedAt: 2 },
    null,
  ]));

  await expect(loadRecentFiles()).resolves.toEqual([
    { sessionId: 'session-1', path: 'README.md', filename: 'README.md', openedAt: 1 },
  ]);
});
