import type { NativePermission, NativeTimelineItem } from '../api/mobileApi';
import {
  buildQuestionResponse,
  permissionQuestions,
  sortedTimeline,
  timelineAttachments,
} from './sessionDetailPresentation';

describe('native session detail presentation', () => {
  it('sorts timeline entries by creation time and then sequence', () => {
    const items = [
      { seq: 4, created_at: '2026-07-11T10:02:00Z', text: 'third' },
      { seq: 2, created_at: '2026-07-11T10:01:00Z', text: 'second' },
      { seq: 1, created_at: '2026-07-11T10:01:00Z', text: 'first' },
    ] as NativeTimelineItem[];

    expect(sortedTimeline(items).map((item) => item.text)).toEqual(['first', 'second', 'third']);
  });

  it('normalizes multiple request_user_input questions and adds an Other choice', () => {
    const permission = {
      permission_id: 'permission-1',
      session_id: 'session-1',
      worker_id: 'worker-1',
      backend: 'codex',
      kind: 'question',
      title: '制定计划',
      description: '请选择下一步。',
      detail: {
        source: 'codex_request_user_input',
        questions: [
          {
            id: 'maintenance_window',
            header: '维护窗口',
            question: '可以重启吗？',
            options: [
              { label: '今晚可重启', description: '允许维护' },
              { label: '完全不停机', description: '只做保守动作' },
            ],
          },
          {
            id: 'docker_scope',
            header: 'Docker/WSL',
            question: '怎么处理？',
            options: [{ label: '迁到 E 盘' }],
          },
        ],
      },
      actions: {},
      status: 'pending',
      response: {},
      created_at: '2026-07-11T10:00:00Z',
      resolved_at: null,
    } satisfies NativePermission;

    const questions = permissionQuestions(permission);

    expect(questions).toHaveLength(2);
    expect(questions[0]!.options.map((option) => option.label)).toEqual([
      '今晚可重启',
      '完全不停机',
      '其他',
    ]);
    expect(questions[1]!.options.at(-1)).toMatchObject({ freeform: true, label: '其他' });
  });

  it('builds the worker-compatible answer envelope with notes and freeform text', () => {
    const response = buildQuestionResponse(
      {
        maintenance_window: {
          id: 'maintenance_window:1',
          label: '完全不停机',
        },
        docker_scope: {
          id: 'docker_scope:other',
          label: '其他',
          freeform: true,
        },
      },
      { docker_scope: '先迁镜像缓存' },
      '执行前再确认剩余空间',
    );

    expect(response).toEqual({
      answers: {
        maintenance_window: {
          choice: 'maintenance_window:1',
          label: '完全不停机',
        },
        docker_scope: {
          choice: 'docker_scope:other',
          label: '其他：先迁镜像缓存',
          text: '先迁镜像缓存',
        },
      },
      note: '执行前再确认剩余空间',
    });
  });

  it('restores safe attachment metadata from multiple timeline payload shapes', () => {
    const attachments = timelineAttachments({
      session_id: 'session-1',
      seq: 8,
      item_type: 'user_message',
      role: 'user',
      text: '请检查这两个附件。',
      tool_call_id: null,
      tool_name: null,
      status: null,
      payload: {
        input: {
          attachments: [
            { filename: '需求说明.md', content_type: 'text/markdown', size_bytes: 2048, path: 'docs/需求说明.md' },
            { filename: 'screen.png', content_type: 'image/png', size_bytes: 512, uri: 'https://example.com/screen.png' },
            { filename: '', content_type: 'image/png', size_bytes: 2 },
            'not-an-attachment',
          ],
        },
      },
      created_at: '2026-07-19T09:00:00Z',
    } as NativeTimelineItem);

    expect(attachments).toEqual([
      { filename: '需求说明.md', content_type: 'text/markdown', size_bytes: 2048, path: 'docs/需求说明.md', url: null },
      { filename: 'screen.png', content_type: 'image/png', size_bytes: 512, path: null, url: 'https://example.com/screen.png' },
    ]);
  });
});
