import { LabASR } from 'byted-ailab-speech-sdk';

// Android WebView can leave stopRecord hanging without firing SDK close/error callbacks.
const STOP_FALLBACK_MS = 1500;

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

export interface StartStreamingVoiceOptions {
  auth: VoiceStreamAuthPayload;
  onStart?: () => void;
  onPartialText?: (text: string, fullData: unknown) => void;
  onClose?: () => void;
  onError?: () => void;
}

function buildStreamingUrl(url: string, auth: Record<string, string>) {
  const params = new URLSearchParams();
  Object.entries(auth).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return `${url}?${params.toString()}`;
}

export async function startStreamingVoice(options: StartStreamingVoiceOptions): Promise<StreamingVoiceController> {
  let mediaStream: MediaStream | null = null;
  let finished = false;
  let stopFallbackTimer: number | null = null;
  const mediaDevices = navigator.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);

  const clearStopFallback = () => {
    if (stopFallbackTimer !== null) {
      window.clearTimeout(stopFallbackTimer);
      stopFallbackTimer = null;
    }
  };

  const stopTracks = () => {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  };

  const finishClose = () => {
    if (finished) return;
    finished = true;
    clearStopFallback();
    stopTracks();
    options.onClose?.();
  };

  const finishError = () => {
    if (finished) return;
    finished = true;
    clearStopFallback();
    stopTracks();
    options.onError?.();
  };

  const client = LabASR({
    onMessage: (text: string, fullData: unknown) => options.onPartialText?.(text, fullData),
    onStart: () => options.onStart?.(),
    onClose: () => finishClose(),
    onError: () => finishError(),
  });

  client.connect({
    url: buildStreamingUrl(options.auth.url, options.auth.auth),
    config: options.auth.config,
  });

  if (!originalGetUserMedia) {
    throw new Error('Current environment does not support microphone recording');
  }

  const patchedGetUserMedia: typeof navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await originalGetUserMedia(...args);
    mediaStream = stream;
    return stream;
  };

  mediaDevices.getUserMedia = patchedGetUserMedia;
  try {
    await client.startRecord();
  } catch (error) {
    stopTracks();
    throw error;
  } finally {
    mediaDevices.getUserMedia = originalGetUserMedia;
  }

  return {
    stop: () => {
      if (finished) return;
      clearStopFallback();
      stopFallbackTimer = window.setTimeout(() => {
        finishClose();
      }, STOP_FALLBACK_MS);
      try {
        client.stopRecord();
      } catch {
        finishClose();
      }
    },
  };
}
