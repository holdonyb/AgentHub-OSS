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

export async function loadAndApplyThemePreference(
  load: () => Promise<NativeThemeMode>,
): Promise<boolean> {
  try {
    applyThemePreference(await load());
    return true;
  } catch {
    return false;
  }
}
