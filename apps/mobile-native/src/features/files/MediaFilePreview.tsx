import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../../ui/theme';

export function MediaFilePreview({
  kind,
  contentType,
  dataBase64,
  filename = 'preview',
}: {
  kind: 'audio' | 'video';
  contentType: string;
  dataBase64: string;
  filename?: string;
}) {
  const uri = useCachedMediaFile(dataBase64, filename);
  if (!uri) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.muted}>正在准备媒体预览</Text>
      </View>
    );
  }
  return kind === 'audio'
    ? <AudioPreview contentType={contentType} uri={uri} />
    : <VideoPreview uri={uri} />;
}

function AudioPreview({ uri }: { contentType: string; uri: string }) {
  const source = useMemo(() => ({ uri }), [uri]);
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);
  return (
    <View style={styles.audioStage}>
      <View style={styles.mediaIcon}>
        <Ionicons color={colors.accent} name="musical-notes" size={30} />
      </View>
      <Pressable
        accessibilityLabel={status.playing ? '暂停音频' : '播放音频'}
        accessibilityRole="button"
        onPress={() => status.playing ? player.pause() : player.play()}
        style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
      >
        <Ionicons color={colors.surface} name={status.playing ? 'pause' : 'play'} size={21} />
      </Pressable>
      <Text style={styles.progress}>{formatDuration(status.currentTime)} / {formatDuration(status.duration)}</Text>
    </View>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return (
    <View accessibilityLabel="视频预览" style={styles.videoStage}>
      <VideoView contentFit="contain" nativeControls player={player} style={styles.video} />
    </View>
  );
}

function useCachedMediaFile(dataBase64: string, filename: string): string | null {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '_') || 'preview';
    const target = `${FileSystem.cacheDirectory ?? ''}agenthub-${Date.now()}-${safeName}`;
    void FileSystem.writeAsStringAsync(target, dataBase64, {
      encoding: FileSystem.EncodingType.Base64,
    }).then(() => {
      if (active) setUri(target);
    });
    return () => {
      active = false;
      void FileSystem.deleteAsync(target, { idempotent: true }).catch(() => undefined);
    };
  }, [dataBase64, filename]);
  return uri;
}

function formatDuration(value: number | undefined): string {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center' },
  muted: { color: colors.muted, fontSize: 13 },
  audioStage: { alignItems: 'center', flex: 1, gap: 18, justifyContent: 'center' },
  mediaIcon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 7,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  progress: { color: colors.text, fontSize: 14, fontVariant: ['tabular-nums'], fontWeight: '700' },
  videoStage: { backgroundColor: '#05070A', flex: 1, justifyContent: 'center' },
  video: { aspectRatio: 16 / 9, width: '100%' },
  pressed: { opacity: 0.75 },
});
