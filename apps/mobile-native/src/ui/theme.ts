import { DynamicColorIOS, Platform, PlatformColor, type ColorValue } from 'react-native';

function semanticColor(light: string, dark: string, androidAttribute: string): ColorValue {
  if (Platform.OS === 'ios') return DynamicColorIOS({ light, dark });
  if (Platform.OS === 'android') return PlatformColor(androidAttribute);
  return light;
}

export const colors = {
  canvas: semanticColor('#F4F7FA', '#101722', '?attr/colorBackground'),
  surface: semanticColor('#FFFFFF', '#172131', '?attr/colorBackgroundFloating'),
  surfaceMuted: semanticColor('#EAF0F6', '#243247', '?attr/colorControlHighlight'),
  text: semanticColor('#111827', '#E7EDF5', '?attr/textColorPrimary'),
  muted: semanticColor('#667085', '#A7B3C4', '?attr/textColorSecondary'),
  border: semanticColor('#D4DCE6', '#334258', '?attr/colorControlNormal'),
  accent: '#1473E6',
  accentPressed: '#0F5EBE',
  danger: '#B42318',
  success: '#15803D',
} as const;
