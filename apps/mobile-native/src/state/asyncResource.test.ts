import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  finishResourceLoad,
} from './asyncResource';

describe('async resource state', () => {
  it('starts in a loading state and becomes ready with data', () => {
    const initial = createResourceState<string[]>();

    expect(initial).toEqual({ data: null, error: null, loading: true, refreshing: false });
    expect(finishResourceLoad(initial, ['first'])).toEqual({
      data: ['first'],
      error: null,
      loading: false,
      refreshing: false,
    });
  });

  it('keeps current data visible during refresh and exposes a retryable error', () => {
    const ready = finishResourceLoad(createResourceState<string[]>(), ['first']);
    const refreshing = beginResourceLoad(ready);

    expect(refreshing).toEqual({
      data: ['first'],
      error: null,
      loading: false,
      refreshing: true,
    });
    expect(failResourceLoad(refreshing, new Error('network unavailable'))).toEqual({
      data: ['first'],
      error: 'network unavailable',
      loading: false,
      refreshing: false,
    });
  });

  it('uses a stable fallback for non-Error failures', () => {
    expect(failResourceLoad(createResourceState(), null).error).toBe('请求失败，请稍后重试');
  });
});
