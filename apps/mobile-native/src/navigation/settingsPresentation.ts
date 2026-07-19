import type { NativeWorkerRuntimeDefaults } from '../api/mobileApi';

export function workerDefaultsText(defaults: NativeWorkerRuntimeDefaults): string {
  return [
    `并发任务 ${defaults.max_concurrent_jobs}`,
    `任务轮询 ${defaults.job_poll_interval_seconds} 秒`,
    `心跳 ${defaults.heartbeat_interval_seconds} 秒`,
  ].join(' · ');
}

export function quickRepliesText(replies: string[]): string {
  return replies.join('\n');
}

export function parseQuickReplies(value: string): string[] {
  const replies = [...new Set(value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))];
  if (replies.length > 12) throw new Error('快捷回复最多 12 条');
  if (replies.some((item) => item.length > 80)) throw new Error('每条快捷回复最多 80 个字符');
  return replies;
}
