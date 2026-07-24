import type {
  NativeSessionSummary,
  NativeSessionStatus,
  NativeTaskStatus,
  NativeWorkerStatus,
} from '../api/mobileApi';

const sessionStatusLabels: Record<NativeSessionStatus, string> = {
  ready: '就绪',
  queued: '排队中',
  running: '运行中',
  needs_reply: '待回复',
  failed: '失败',
  terminated: '已结束',
};

const taskStatusLabels: Record<NativeTaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  working: '执行中',
  blocked: '受阻',
  needs_approval: '待审批',
  ready_to_review: '待验收',
  accepted: '已完成',
  rejected: '已拒绝',
  archived: '已归档',
  cancelled: '已取消',
  failed: '失败',
};

const workerStatusLabels: Record<NativeWorkerStatus, string> = {
  registered: '已注册',
  online: '在线',
  degraded: '异常',
  offline: '离线',
};

export function sessionStatusLabel(status: NativeSessionStatus): string {
  return sessionStatusLabels[status];
}

export function taskStatusLabel(status: NativeTaskStatus): string {
  return taskStatusLabels[status];
}

export function workerStatusLabel(status: NativeWorkerStatus): string {
  return workerStatusLabels[status];
}

export function parseApiDate(value?: string | number | null): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T').replace(/\.(\d{3})\d+/, '.$1');
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const hasTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(normalized);
  const parsed = new Date(hasTime && !hasExplicitTimezone ? `${normalized}Z` : normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatLastActivity(value: string | null, now = new Date()): string {
  const date = parseApiDate(value);
  if (!date) return '暂无活动';
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (elapsedSeconds < 60) return '刚刚';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} 天前`;
  return date.toISOString().slice(0, 10);
}

export function sessionActivityAt(session: NativeSessionSummary): string | null {
  const lastActivity = parseApiDate(session.last_activity_at);
  const updatedAt = parseApiDate(session.updated_at);
  if (lastActivity) return session.last_activity_at;
  return updatedAt ? session.updated_at ?? null : null;
}

export function sortSessionsByRecentActivity(
  sessions: NativeSessionSummary[],
): NativeSessionSummary[] {
  return [...sessions].sort((left, right) => {
    const rightTime = parseApiDate(sessionActivityAt(right))?.getTime() ?? 0;
    const leftTime = parseApiDate(sessionActivityAt(left))?.getTime() ?? 0;
    return rightTime - leftTime || right.session_id.localeCompare(left.session_id);
  });
}

export function workerCapabilityLabels(
  reachableBackends: string[],
  capabilities: Record<string, unknown>,
): string[] {
  const labels = [...reachableBackends];
  const seen = new Set(labels);
  for (const [name, enabled] of Object.entries(capabilities)) {
    if (enabled === true && !seen.has(name)) {
      labels.push(name);
      seen.add(name);
    }
  }
  return labels;
}
