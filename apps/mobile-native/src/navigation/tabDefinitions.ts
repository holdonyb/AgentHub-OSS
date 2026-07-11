export type NativeTabKey = 'sessions' | 'tasks' | 'files' | 'workers' | 'me';

export interface NativeTabDefinition {
  key: NativeTabKey;
  label: string;
  icon: string;
  ownsHeader: boolean;
}

export const nativeTabs: readonly NativeTabDefinition[] = [
  { key: 'sessions', label: '会话', icon: 'chatbubble-ellipses-outline', ownsHeader: true },
  { key: 'tasks', label: '任务', icon: 'play-circle-outline', ownsHeader: false },
  { key: 'files', label: '文件', icon: 'folder-outline', ownsHeader: false },
  { key: 'workers', label: '节点', icon: 'hardware-chip-outline', ownsHeader: false },
  { key: 'me', label: '我的', icon: 'person-circle-outline', ownsHeader: false },
];
