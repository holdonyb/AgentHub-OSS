import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors } from '../ui/theme';

export function LoadingScreen() {
  return (
    <View style={styles.screen}>
      <ActivityIndicator color={colors.accent} size="large" />
      <Text style={styles.text}>正在连接 AgentHub</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    flex: 1,
    gap: 14,
    justifyContent: 'center',
  },
  text: {
    color: colors.muted,
    fontSize: 15,
  },
});
