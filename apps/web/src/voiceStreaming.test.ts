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
    emitError() {
      (handlers.onError as (() => void) | undefined)?.();
    },
    emitClose() {
      (handlers.onClose as (() => void) | undefined)?.();
    },
    getStartRecord() {
      return startRecord;
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
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
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
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1500);

    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses processed browser audio constraints when no native Android shell is present', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
      },
    });
    sdkState.setNoCloseStop();

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
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    controller.stop();
    vi.advanceTimersByTime(1500);
  });

  it('forwards raw SDK record chunks so callers can fall back after weak streaming recognition', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    sdkState.setCloseOnStop();
    const onAudioChunk = vi.fn();

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
      onAudioChunk,
    });

    const recordChunk = sdkState.getStartRecord().mock.calls[0]?.[1];
    expect(typeof recordChunk).toBe('function');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    await recordChunk(blob);

    expect(onAudioChunk).toHaveBeenCalledWith(blob);

    controller.stop();
    vi.advanceTimersByTime(1500);
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

  it('reconnects after a transient SDK error without ending the active recording', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });
    const onClose = vi.fn();
    const onError = vi.fn();
    const onRecovering = vi.fn();

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
      onError,
      onRecovering,
      maxReconnectAttempts: 1,
    });

    expect(sdkState.getStartRecord()).toHaveBeenCalledTimes(1);
    sdkState.emitError();

    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onRecovering).toHaveBeenCalledWith(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(450);

    expect(sdkState.getConnect()).toHaveBeenCalledTimes(2);
    expect(sdkState.getStartRecord()).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();

    controller.stop();
    vi.advanceTimersByTime(1500);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
