import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { formatLastActivity } from '../../screens/resourcePresentation';
import { colors } from '../../ui/theme';
import type { RuntimeOverviewItem, RuntimeOverviewLane, RuntimeOverviewProjection } from './runtimeOverview';

type RuntimeFilter = 'all' | RuntimeOverviewLane;

const lanes: RuntimeOverviewLane[] = ['attention', 'working', 'done', 'idle', 'offline'];
const laneLabels: Record<RuntimeOverviewLane, string> = {
  attention: '需要处理',
  working: '运行中',
  done: '已完成',
  idle: '空闲',
  offline: '离线',
};
const laneIcons: Record<RuntimeOverviewLane, string> = {
  attention: 'notifications-outline',
  working: 'play-circle-outline',
  done: 'checkmark-circle-outline',
  idle: 'time-outline',
  offline: 'cloud-offline-outline',
};

export function RuntimeOverview({
  projection,
  loading,
  refreshing,
  error,
  onRefresh,
  onOpenSession,
  onOpenTask,
}: {
  projection: RuntimeOverviewProjection;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh(): void;
  onOpenSession(item: RuntimeOverviewItem): void;
  onOpenTask(taskId: string): void;
}) {
  const [filter, setFilter] = useState<RuntimeFilter>('all');
  const visibleItems = useMemo(
    () => filter === 'all' ? projection.items : projection.items.filter((item) => item.lane === filter),
    [filter, projection.items],
  );
  const availableLanes = lanes.filter((lane) => projection.counts[lane] > 0);

  return (
    <View style={styles.screen}>
      <View style={styles.summary}>
        <View>
          <Text style={styles.summaryEyebrow}>运行总览</Text>
          <Text style={styles.summaryTitle}>需要处理 {projection.counts.attention}</Text>
        </View>
        <Text style={styles.summaryMeta}>运行中 {projection.counts.working} · 已完成 {projection.counts.done}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.filters} horizontal showsHorizontalScrollIndicator={false}>
        <FilterChip count={projection.items.length} label="全部" onPress={() => setFilter('all')} selected={filter === 'all'} />
        {availableLanes.map((lane) => (
          <FilterChip count={projection.counts[lane]} key={lane} label={laneLabels[lane]} onPress={() => setFilter(lane)} selected={filter === lane} />
        ))}
      </ScrollView>
      {error ? (
        <Pressable accessibilityLabel="重试运行总览" accessibilityRole="button" onPress={onRefresh} style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.retryText}>重试</Text>
        </Pressable>
      ) : null}
      <FlatList
        contentContainerStyle={styles.list}
        data={visibleItems}
        keyExtractor={(item) => item.session.session_id}
        ListEmptyComponent={<Text style={styles.empty}>{loading ? '正在加载运行状态' : '当前分组暂无会话'}</Text>}
        refreshControl={<RefreshControl colors={[colors.accent]} onRefresh={onRefresh} refreshing={refreshing} tintColor={colors.accent} />}
        renderItem={({ item }) => (
          <View style={[styles.card, styles[`card_${item.lane}`]]}>
            <Pressable
              accessibilityLabel={`从总览打开会话 ${item.session.title}`}
              accessibilityRole="button"
              onPress={() => onOpenSession(item)}
              style={({ pressed }) => [styles.cardMain, pressed && styles.pressed]}
            >
              <Ionicons color={laneColor(item.lane)} name={laneIcons[item.lane] as never} size={21} />
              <View style={styles.cardCopy}>
                <View style={styles.cardTitleRow}>
                  <Text numberOfLines={2} style={styles.cardTitle}>{item.session.title}</Text>
                  <Text style={[styles.reason, { color: laneColor(item.lane) }]}>{item.reason}</Text>
                </View>
                <Text numberOfLines={1} style={styles.metadata}>
                  {item.session.backend} · {item.workerName} · {item.session.project_name || item.session.namespace || 'default'}
                </Text>
                {item.session.activity_summary || item.session.last_message ? (
                  <Text numberOfLines={2} style={styles.summaryText}>{item.session.activity_summary || item.session.last_message}</Text>
                ) : null}
                <Text style={styles.time}>{formatLastActivity(item.stateUpdatedAt)}</Text>
              </View>
            </Pressable>
            {item.taskId ? (
              <Pressable accessibilityLabel={`打开关联任务 ${item.session.title}`} accessibilityRole="button" onPress={() => onOpenTask(item.taskId!)} style={({ pressed }) => [styles.taskButton, pressed && styles.pressed]}>
                <Ionicons color={colors.accent} name="open-outline" size={18} />
              </Pressable>
            ) : null}
          </View>
        )}
      />
    </View>
  );
}

function FilterChip({ label, count, selected, onPress }: { label: string; count: number; selected: boolean; onPress(): void }) {
  return (
    <Pressable accessibilityLabel={`筛选运行总览 ${label}`} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.filterChip, selected && styles.filterChipSelected]}>
      <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{label} {count}</Text>
    </Pressable>
  );
}

function laneColor(lane: RuntimeOverviewLane): ColorValue {
  if (lane === 'attention') return '#7C3AED';
  if (lane === 'working') return '#C2410C';
  if (lane === 'done') return colors.success;
  if (lane === 'offline') return colors.danger;
  return colors.muted;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  summary: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  summaryEyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800' },
  summaryTitle: { color: colors.text, fontSize: 20, fontWeight: '800', marginTop: 2 },
  summaryMeta: { color: colors.muted, fontSize: 12, paddingBottom: 2 },
  filters: { gap: 8, paddingBottom: 12, paddingHorizontal: 16 },
  filterChip: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 999, borderWidth: 1, minHeight: 38, justifyContent: 'center', paddingHorizontal: 13 },
  filterChipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  filterTextSelected: { color: colors.surface },
  list: { gap: 10, paddingBottom: 28, paddingHorizontal: 16 },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderLeftWidth: 3, borderRadius: 7, borderWidth: 1, flexDirection: 'row' },
  card_attention: { borderLeftColor: '#7C3AED' },
  card_working: { borderLeftColor: '#C2410C' },
  card_done: { borderLeftColor: colors.success },
  card_idle: { borderLeftColor: colors.muted },
  card_offline: { borderLeftColor: colors.danger },
  cardMain: { alignItems: 'flex-start', flex: 1, flexDirection: 'row', gap: 11, padding: 14 },
  cardCopy: { flex: 1, gap: 6 },
  cardTitleRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 9, justifyContent: 'space-between' },
  cardTitle: { color: colors.text, flex: 1, fontSize: 15, fontWeight: '800', lineHeight: 21 },
  reason: { fontSize: 12, fontWeight: '800' },
  metadata: { color: colors.muted, fontSize: 12 },
  summaryText: { color: colors.text, fontSize: 13, lineHeight: 18 },
  time: { color: colors.muted, fontSize: 11 },
  taskButton: { alignItems: 'center', borderLeftColor: colors.border, borderLeftWidth: 1, justifyContent: 'center', minWidth: 46 },
  errorBanner: { backgroundColor: '#FEF3F2', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10, marginHorizontal: 16, padding: 10 },
  errorText: { color: colors.danger, flex: 1, fontSize: 12 },
  retryText: { color: colors.danger, fontSize: 12, fontWeight: '800' },
  empty: { color: colors.muted, paddingTop: 36, textAlign: 'center' },
  pressed: { opacity: 0.72 },
});
