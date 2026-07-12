import type { NativeJob, NativePermission } from '../api/mobileApi';
import type { NativeNotificationSignal } from './nativeNotifications';

function concise(value: string | null | undefined, fallback: string): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

export function notificationSignals(
  permissions: NativePermission[],
  jobs: NativeJob[],
): NativeNotificationSignal[] {
  const pending = permissions
    .filter((permission) => permission.status === 'pending')
    .map((permission) => ({
      id: `permission:${permission.permission_id}`,
      title: permission.kind === 'question' ? '等待你的选择' : '等待审批',
      body: concise(permission.title || permission.description, 'Agent 正在等待你处理'),
      sessionId: permission.session_id,
    }));
  const failures = jobs
    .filter((job) => job.status === 'failed')
    .map((job) => ({
      id: `job:${job.job_id}:failed`,
      title: '任务失败',
      body: concise(job.error_text, '打开 AgentHub 查看失败原因'),
      sessionId: job.target_session_id,
    }));
  return [...pending, ...failures];
}
