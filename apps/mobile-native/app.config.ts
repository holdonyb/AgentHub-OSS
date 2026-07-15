import type { ExpoConfig } from 'expo/config';
import appJson from './app.json';

type PushBuildEnvironment = Record<string, string | undefined>;

export function buildAppConfig(environment: PushBuildEnvironment): ExpoConfig {
  const projectId = (
    environment.EXPO_PUBLIC_EAS_PROJECT_ID
    ?? environment.EAS_PROJECT_ID
    ?? ''
  ).trim();
  if (!projectId) return { ...appJson.expo } as ExpoConfig;
  return {
    ...appJson.expo,
    extra: {
      eas: { projectId },
    },
  } as ExpoConfig;
}

export default (): ExpoConfig => buildAppConfig(process.env);
