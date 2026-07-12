import { Image, StyleSheet, Text, View, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import { colors } from './theme';

export function BrandHeader({ subtitle }: { subtitle: string }) {
  return (
    <View style={styles.header}>
      <Image source={require('../../assets/icon.png')} style={styles.logo} />
      <View style={styles.copy}>
        <Text style={styles.name}>AgentHub</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create<{
  header: ViewStyle;
  logo: ImageStyle;
  copy: ViewStyle;
  name: TextStyle;
  subtitle: TextStyle;
}>({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  logo: {
    borderRadius: 14,
    height: 54,
    width: 54,
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  name: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
});
