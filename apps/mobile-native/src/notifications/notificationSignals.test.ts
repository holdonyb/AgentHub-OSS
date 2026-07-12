import type { NativeJob, NativePermission } from '../api/mobileApi';
import { notificationSignals } from './notificationSignals';

it('maps pending questions and failed jobs to stable notification ids', () => {
  const permission = {
    permission_id: 'permission-1',
    session_id: 'session-1',
    kind: 'question',
    title: '维护窗口',
    description: '请选择维护窗口',
    status: 'pending',
  } as NativePermission;
  const job = {
    job_id: 'job-1',
    target_session_id: 'session-2',
    status: 'failed',
    error_text: '模型容量不足',
  } as NativeJob;

  expect(notificationSignals([permission], [job])).toEqual([
    {
      id: 'permission:permission-1',
      title: '等待你的选择',
      body: '维护窗口',
      sessionId: 'session-1',
    },
    {
      id: 'job:job-1:failed',
      title: '任务失败',
      body: '模型容量不足',
      sessionId: 'session-2',
    },
  ]);
});
