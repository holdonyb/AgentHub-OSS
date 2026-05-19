import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkState = vi.hoisted(() => {
  let handlers: Record<string, (() => void) | ((text: string, fullData: unknown) => void)> = {};
  let stopRecord = vi.fn();
  let connect = vi.fn();
  let startRecord = vi.fn();
  return {
    reset() {
      handlers = {};
      stopRecord = vi.fn();
      connect = vi.fn();
      startRecord = vi.fn(async () => {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        (handlers.onStart as (() => void) | undefined)?.();
      });
    },
    setNoCloseStop() {
      stopRecord = vi.fn();
    },
    setCloseOnStop() {
      stopRecord = vi.fn(() => {
        (handlers.onClose as (() => void) | undefined)?.();
      });
    },
    getStopRecord() {
      return stopRecord;
    },
    getConnect() {
      return connect;
    },
    labAsr(params: Record<string, unknown>) {
      handlers = params as typeof handlers;
      return {
        connect,
        startRecord,
        stopRecord,
      };
    },
  };
});

vi.mock('byted-ailab-speech-sdk', () => ({
  LabASR: (params: Record<string, unknown>) => sdkState.labAsr(params),
}));

import { startStreamingVoice } from './voiceStreaming';

describe('voiceStreaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sdkState.reset();
  });

  it('force-finishes stop when the SDK never emits close', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    sdkState.setNoCloseStop();
    const onClose = vi.fn();

    const controller = await startStreamingVoice({
      auth: {
        url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
        auth: {
          api_resource_id: 'volc.bigasr.sauc.duration',
          api_app_key: 'app-key',
          api_access_key: 'Jwt; token-123',
        },
        config: {
          user: { uid: 'user-1' },
          audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
          request: { model_name: 'bigmodel' },
        },
        expires_in_seconds: 300,
      },
      onClose,
    });

    controller.stop();
    expect(sdkState.getStopRecord()).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not double-finish when the SDK closes normally', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    sdkState.setCloseOnStop();
    const onClose = vi.fn();

    const controller = await startStreamingVoice({
      auth: {
        url: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
        auth: {
          api_resource_id: 'volc.bigasr.sauc.duration',
          api_app_key: 'app-key',
          api_access_key: 'Jwt; token-123',
        },
        config: {
          user: { uid: 'user-1' },
          audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
          request: { model_name: 'bigmodel' },
        },
        expires_in_seconds: 300,
      },
      onClose,
    });

    controller.stop();
    vi.advanceTimersByTime(1500);

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
