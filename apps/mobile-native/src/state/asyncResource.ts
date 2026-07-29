import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncResourceState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
}

export interface AsyncResourceOptions {
  onError?(error: unknown): void;
  resetKey?: unknown;
}

export interface ResourceLoadOptions {
  silent?: boolean;
}

export function createResourceState<T>(): AsyncResourceState<T> {
  return { data: null, error: null, loading: true, refreshing: false };
}

export function beginResourceLoad<T>(
  state: AsyncResourceState<T>,
  options: ResourceLoadOptions = {},
): AsyncResourceState<T> {
  return {
    ...state,
    error: null,
    loading: state.data === null,
    refreshing: state.data !== null && !options.silent,
  };
}

export function finishResourceLoad<T>(
  state: AsyncResourceState<T>,
  data: T,
): AsyncResourceState<T> {
  return { ...state, data, error: null, loading: false, refreshing: false };
}

export function failResourceLoad<T>(
  state: AsyncResourceState<T>,
  error: unknown,
): AsyncResourceState<T> {
  return {
    ...state,
    error: error instanceof Error ? error.message : '请求失败，请稍后重试',
    loading: false,
    refreshing: false,
  };
}

export function useAsyncResource<T>(
  loader: () => Promise<T>,
  options: AsyncResourceOptions = {},
) {
  const [state, setState] = useState<AsyncResourceState<T>>(createResourceState);
  const requestId = useRef(0);
  const onErrorRef = useRef(options.onError);
  const previousResetKey = useRef(options.resetKey);
  onErrorRef.current = options.onError;

  const runLoad = useCallback(async (reset: boolean, loadOptions: ResourceLoadOptions = {}) => {
    const currentRequestId = requestId.current + 1;
    requestId.current = currentRequestId;
    setState((current) => reset ? createResourceState<T>() : beginResourceLoad(current, loadOptions));
    try {
      const data = await loader();
      if (requestId.current === currentRequestId) {
        setState((current) => finishResourceLoad(current, data));
      }
    } catch (error) {
      onErrorRef.current?.(error);
      if (requestId.current === currentRequestId) {
        setState((current) => failResourceLoad(current, error));
      }
    }
  }, [loader]);

  const reload = useCallback(() => runLoad(false), [runLoad]);
  const reloadSilently = useCallback(() => runLoad(false, { silent: true }), [runLoad]);

  useEffect(() => {
    const reset = !Object.is(previousResetKey.current, options.resetKey);
    previousResetKey.current = options.resetKey;
    void runLoad(reset);
    return () => {
      requestId.current += 1;
    };
  }, [options.resetKey, runLoad]);

  return { ...state, reload, reloadSilently };
}
