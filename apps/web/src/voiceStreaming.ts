import { LabASR } from 'byted-ailab-speech-sdk';

// Android WebView can leave stopRecord hanging without firing SDK close/error callbacks.
const STOP_FALLBACK_MS = 1500;
const RECONNECT_BASE_MS = 450;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 2;
const RAW_NATIVE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
const PROCESSED_BROWSER_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface VoiceStreamAuthPayload {
  url: string;
  auth: Record<string, string>;
  config: {
    user: {
      uid: string;
    };
    audio: {
      format: string;
      rate: number;
      bits: number;
      channel: number;
    };
    request: {
      model_name: string;
      show_utterances?: boolean;
      enable_itn?: boolean;
      enable_punc?: boolean;
      enable_ddc?: boolean;
    };
  };
  expires_in_seconds: number;
}

export interface StreamingVoiceController {
  stop: () => void;
}

type LabAsrClient = ReturnType<typeof LabASR> & {
  startRecord: (
    options?: Record<string, unknown>,
    onRecord?: (recordResult: Blob) => void | Promise<void>,
  ) => Promise<void>;
};

export interface StartStreamingVoiceOptions {
  auth: VoiceStreamAuthPayload;
  mediaConstraints?: MediaStreamConstraints;
  onStart?: () => void;
  onPartialText?: (text: string, fullData: unknown) => void;
  onAudioChunk?: (chunk: Blob) => void;
  onRecovering?: (attempt: number) => void;
  onClose?: () => void;
  onError?: () => void;
  maxReconnectAttempts?: number;
}

function hasNativeAndroidAudioBridge() {
  const bridge = (globalThis as typeof globalThis & {
    AgentHubAndroid?: { microphonePermissionState?: () => string };
  }).AgentHubAndroid;
  return typeof bridge?.microphonePermissionState === 'function';
}

function defaultStreamingVoiceMediaConstraints(): MediaStreamConstraints {
  return {
    audio: {
      ...(hasNativeAndroidAudioBridge() ? RAW_NATIVE_AUDIO_CONSTRAINTS : PROCESSED_BROWSER_AUDIO_CONSTRAINTS),
    },
  };
}

function buildStreamingUrl(url: string, auth: Record<string, string>) {
  const params = new URLSearchParams();
  Object.entries(auth).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return `${url}?${params.toString()}`;
}

function mergeVoiceConstraints(requested: MediaStreamConstraints | undefined): MediaStreamConstraints {
  const baseAudioConstraints = {
    ...((defaultStreamingVoiceMediaConstraints().audio ?? {}) as MediaTrackConstraints),
  };
  const requestedAudio = requested?.audio;
  if (requestedAudio && typeof requestedAudio === 'object' && !Array.isArray(requestedAudio)) {
    return {
      ...(requested ?? {}),
      audio: {
        ...baseAudioConstraints,
        ...requestedAudio,
      },
    };
  }
  return {
    ...(requested ?? {}),
    audio: {
      ...baseAudioConstraints,
    },
  };
}

export async function startStreamingVoice(options: StartStreamingVoiceOptions): Promise<StreamingVoiceController> {
  let mediaStream: MediaStream | null = null;
  let client: LabAsrClient | null = null;
  let finished = false;
  let stopping = false;
  let reconnectAttempts = 0;
  let stopFallbackTimer: number | null = null;
  let reconnectTimer: number | null = null;
  const mediaDevices = navigator.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
  const maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

  const clearStopFallback = () => {
    if (stopFallbackTimer !== null) {
      window.clearTimeout(stopFallbackTimer);
      stopFallbackTimer = null;
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const stopTracks = () => {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  };

  const finalClose = () => {
    if (finished) return;
    finished = true;
    clearStopFallback();
    clearReconnectTimer();
    stopTracks();
    options.onClose?.();
  };

  const finalError = () => {
    if (finished) return;
    finished = true;
    clearStopFallback();
    clearReconnectTimer();
    stopTracks();
    options.onError?.();
  };

  if (!originalGetUserMedia) {
    throw new Error('Current environment does not support microphone recording');
  }

  const scheduleReconnect = () => {
    if (finished || stopping || reconnectAttempts >= maxReconnectAttempts) return false;
    reconnectAttempts += 1;
    clearStopFallback();
    stopTracks();
    options.onRecovering?.(reconnectAttempts);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void startClient().catch(() => finalError());
    }, RECONNECT_BASE_MS * reconnectAttempts);
    return true;
  };

  const finishClose = () => {
    if (!stopping && scheduleReconnect()) return;
    finalClose();
  };

  const finishError = () => {
    if (!stopping && scheduleReconnect()) return;
    finalError();
  };

  async function startClient() {
    if (finished || stopping) return;
    client = LabASR({
      onMessage: (text: string, fullData: unknown) => options.onPartialText?.(text, fullData),
      onStart: () => options.onStart?.(),
      onClose: () => finishClose(),
      onError: () => finishError(),
    }) as LabAsrClient;

    client.connect({
      url: buildStreamingUrl(options.auth.url, options.auth.auth),
      config: options.auth.config,
    });

    const patchedGetUserMedia: typeof navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await originalGetUserMedia(mergeVoiceConstraints(args[0]));
      mediaStream = stream;
      return stream;
    };

    mediaDevices.getUserMedia = patchedGetUserMedia;
    try {
      await client.startRecord({}, async (recordResult: Blob) => {
        if (recordResult.size > 0) options.onAudioChunk?.(recordResult);
      });
    } catch (error) {
      stopTracks();
      throw error;
    } finally {
      mediaDevices.getUserMedia = originalGetUserMedia;
    }
  }

  await startClient();

  return {
    stop: () => {
      if (finished) return;
      stopping = true;
      clearReconnectTimer();
      clearStopFallback();
      stopFallbackTimer = window.setTimeout(() => {
        finalClose();
      }, STOP_FALLBACK_MS);
      try {
        client?.stopRecord();
      } catch {
        finalClose();
      }
    },
  };
}
