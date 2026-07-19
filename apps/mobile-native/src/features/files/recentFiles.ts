import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'agenthub.recentWorkspaceFiles.v1';
const MAX_RECENT_FILES = 20;

export interface RecentWorkspaceFile {
  sessionId: string;
  path: string;
  filename: string;
  openedAt: number;
}

function isRecentFile(value: unknown): value is RecentWorkspaceFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RecentWorkspaceFile>;
  return Boolean(
    candidate.sessionId?.trim()
      && candidate.path?.trim()
      && candidate.filename?.trim()
      && typeof candidate.openedAt === 'number'
      && Number.isFinite(candidate.openedAt),
  );
}

export async function loadRecentFiles(): Promise<RecentWorkspaceFile[]> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isRecentFile).sort((left, right) => right.openedAt - left.openedAt).slice(0, MAX_RECENT_FILES)
      : [];
  } catch {
    return [];
  }
}

export async function addRecentFile(file: RecentWorkspaceFile): Promise<RecentWorkspaceFile[]> {
  const current = await loadRecentFiles();
  const next = [
    file,
    ...current.filter((item) => !(item.sessionId === file.sessionId && item.path === file.path)),
  ].slice(0, MAX_RECENT_FILES);
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(next));
  return next;
}
