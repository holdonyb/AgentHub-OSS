import { parseQuickReplies, quickRepliesText, workerDefaultsText } from './settingsPresentation';

describe('native settings presentation', () => {
  it('summarizes worker defaults without exposing raw JSON', () => {
    expect(workerDefaultsText({
      max_concurrent_jobs: 2,
      job_poll_interval_seconds: 5,
      heartbeat_interval_seconds: 15,
    })).toBe('并发任务 2 · 任务轮询 5 秒 · 心跳 15 秒');
  });

  it('normalizes newline-separated quick replies for account preferences', () => {
    expect(parseQuickReplies('继续推进\n 换个方案 \n继续推进\n')).toEqual(['继续推进', '换个方案']);
    expect(quickRepliesText(['继续推进', '换个方案'])).toBe('继续推进\n换个方案');
  });

  it('rejects quick reply drafts that exceed server limits', () => {
    expect(() => parseQuickReplies(Array.from({ length: 13 }, (_, index) => `回复 ${index}`).join('\n')))
      .toThrow('快捷回复最多 12 条');
    expect(() => parseQuickReplies('x'.repeat(81))).toThrow('每条快捷回复最多 80 个字符');
  });
});
