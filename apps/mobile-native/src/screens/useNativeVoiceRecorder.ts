import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import type { NativeVoiceTranscribeInput } from '../api/mobileApi';

const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    sampleRate: 16_000,
    audioSource: 'voice_recognition',
    maxFileSize: MAX_AUDIO_BYTES,
  },
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    sampleRate: 16_000,
  },
};

export interface NativeVoiceRecorderState {
  durationMillis: number;
  isRecording: boolean;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Omit<NativeVoiceTranscribeInput, 'language'> | null>;
}

export function useNativeVoiceRecorder(): NativeVoiceRecorderState {
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS);
  const state = useAudioRecorderState(recorder, 100);

  async function startRecording() {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error('需要麦克风权限才能使用语音输入');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function stopRecording() {
    if (!state.isRecording) return null;
    const durationMillis = Math.max(0, Math.round(state.durationMillis));
    try {
      await recorder.stop();
      if (!recorder.uri) throw new Error('没有生成有效录音');
      const file = new File(recorder.uri);
      if ((file.size ?? 0) > MAX_AUDIO_BYTES) throw new Error('录音超过 12 MB，请分段录制');
      const dataBase64 = await file.base64();
      if (!dataBase64) throw new Error('没有生成有效录音');
      return {
        filename: 'voice.m4a',
        content_type: 'audio/mp4',
        data_base64: dataBase64,
        duration_ms: durationMillis,
        chunk_count: 1,
      };
    } finally {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    }
  }

  return {
    durationMillis: state.durationMillis,
    isRecording: state.isRecording,
    startRecording,
    stopRecording,
  };
}
