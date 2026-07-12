import type { ReactElement } from 'react';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useNativeVoiceRecorder, type NativeVoiceRecorderState } from './useNativeVoiceRecorder';

jest.mock('expo-audio', () => ({
  RecordingPresets: {
    HIGH_QUALITY: {
      extension: '.m4a',
      sampleRate: 44_100,
      numberOfChannels: 2,
      bitRate: 128_000,
      android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
      ios: { audioQuality: 127, outputFormat: 'mpeg4aac' },
      web: { mimeType: 'audio/webm' },
    },
  },
  requestRecordingPermissionsAsync: jest.fn(),
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ File: jest.fn() }));

const { act, create } = jest.requireActual('react-test-renderer') as {
  act(callback: () => void | Promise<void>): void | Promise<void>;
  create(element: ReactElement): { unmount(): void };
};

const recorder = {
  prepareToRecordAsync: jest.fn(async () => undefined),
  record: jest.fn(),
  stop: jest.fn(async () => undefined),
  uri: 'file:///voice.m4a',
};
let currentHook: NativeVoiceRecorderState;

function Probe() {
  currentHook = useNativeVoiceRecorder();
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useAudioRecorder).mockReturnValue(recorder as never);
  jest.mocked(useAudioRecorderState).mockReturnValue({
    isRecording: false,
    durationMillis: 0,
  } as never);
  jest.mocked(requestRecordingPermissionsAsync).mockResolvedValue({ granted: true } as never);
  jest.mocked(setAudioModeAsync).mockResolvedValue(undefined);
  jest.mocked(File).mockImplementation(() => ({
    size: 5,
    base64: jest.fn(async () => 'YXVkaW8='),
  }) as never);
});

async function renderHook() {
  let renderer!: { unmount(): void };
  await act(async () => {
    renderer = create(<Probe />);
  });
  return renderer;
}

it('requests microphone access and prepares the native recorder', async () => {
  const renderer = await renderHook();
  await currentHook.startRecording();

  expect(setAudioModeAsync).toHaveBeenCalledWith({ allowsRecording: true, playsInSilentMode: true });
  expect(recorder.prepareToRecordAsync).toHaveBeenCalled();
  expect(recorder.record).toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

it('reads a completed recording and restores playback audio mode', async () => {
  jest.mocked(useAudioRecorderState).mockReturnValue({
    isRecording: true,
    durationMillis: 1650,
  } as never);
  const renderer = await renderHook();

  await expect(currentHook.stopRecording()).resolves.toEqual({
    filename: 'voice.m4a',
    content_type: 'audio/mp4',
    data_base64: 'YXVkaW8=',
    duration_ms: 1650,
    chunk_count: 1,
  });
  expect(recorder.stop).toHaveBeenCalled();
  expect(setAudioModeAsync).toHaveBeenLastCalledWith({ allowsRecording: false, playsInSilentMode: true });
  await act(async () => renderer.unmount());
});

it('does not prepare the recorder when microphone permission is denied', async () => {
  jest.mocked(requestRecordingPermissionsAsync).mockResolvedValue({ granted: false } as never);
  const renderer = await renderHook();
  await expect(currentHook.startRecording()).rejects.toThrow('需要麦克风权限');
  expect(recorder.prepareToRecordAsync).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
