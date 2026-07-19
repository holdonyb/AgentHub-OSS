import { DynamicColorIOS, Platform, PlatformColor, type ColorValue } from 'react-native';

function semanticColor(light: string, dark: string, androidResource: string): ColorValue {
  if (Platform.OS === 'ios') return DynamicColorIOS({ light, dark });
  if (Platform.OS === 'android') return PlatformColor(`@color/${androidResource}`);
  return light;
}

export const colors = {
  canvas: semanticColor('#F4F7FA', '#101722', 'agenthub_canvas'),
  surface: semanticColor('#FFFFFF', '#172131', 'agenthub_surface'),
  surfaceMuted: semanticColor('#EAF0F6', '#243247', 'agenthub_surface_muted'),
  text: semanticColor('#111827', '#E7EDF5', 'agenthub_text'),
  muted: semanticColor('#667085', '#A7B3C4', 'agenthub_muted'),
  border: semanticColor('#D4DCE6', '#334258', 'agenthub_border'),
  accent: '#1473E6',
  accentPressed: '#0F5EBE',
  danger: '#B42318',
  success: '#15803D',
} as const;
