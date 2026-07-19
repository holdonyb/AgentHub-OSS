import { Appearance } from 'react-native';

export type NativeThemeMode = 'dark' | 'light';

export function themePreferencePresentation(mode: NativeThemeMode) {
  return {
    colorScheme: mode,
    statusBar: mode === 'dark' ? 'light' as const : 'dark' as const,
  };
}

export function applyThemePreference(mode: NativeThemeMode): void {
  Appearance.setColorScheme(themePreferencePresentation(mode).colorScheme);
}
