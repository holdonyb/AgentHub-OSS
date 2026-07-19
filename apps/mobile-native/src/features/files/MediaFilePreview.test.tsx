import type { ReactElement } from 'react';
import { MediaFilePreview } from './MediaFilePreview';

const mockPlay = jest.fn();
const mockPause = jest.fn();

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: mockPlay, pause: mockPause }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 3, duration: 12 }),
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({ id: 'video-player' }),
  VideoView: () => null,
}));

const { act, create } = jest.requireActual('react-test-renderer') as {
  act(callback: () => void | Promise<void>): void | Promise<void>;
  create(element: ReactElement): {
    root: { findByProps(props: Record<string, unknown>): { props: { onPress(): void } } };
    toJSON(): unknown;
  };
};

function renderedText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join(' ');
  if (!value || typeof value !== 'object') return '';
  return renderedText((value as { children?: unknown }).children).replace(/\s+/g, ' ').trim();
}

it('plays an inline audio file and shows its progress', async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<MediaFilePreview contentType="audio/mpeg" dataBase64="AAAA" kind="audio" />);
    await Promise.resolve();
  });

  expect(renderedText(renderer.toJSON())).toContain('0:03 / 0:12');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: '播放音频' }).props.onPress());
  expect(mockPlay).toHaveBeenCalledTimes(1);
});

it('renders native video controls for an inline video file', async () => {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<MediaFilePreview contentType="video/mp4" dataBase64="AAAA" kind="video" />);
    await Promise.resolve();
  });

  expect(renderer.root.findByProps({ accessibilityLabel: '视频预览' })).toBeTruthy();
});
