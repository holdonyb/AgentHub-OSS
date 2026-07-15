import type { ExpoConfig } from 'expo/config';
import appJson from './app.json';

type PushBuildEnvironment = Record<string, string | undefined>;

export function buildAppConfig(environment: PushBuildEnvironment): ExpoConfig {
  const projectId = (
    environment.EXPO_PUBLIC_EAS_PROJECT_ID
    ?? environment.EAS_PROJECT_ID
    ?? ''
  ).trim();
  const googleServicesFile = (environment.GOOGLE_SERVICES_JSON ?? '').trim();
  return {
    ...appJson.expo,
    ...(projectId ? {
      extra: {
        eas: { projectId },
      },
    } : {}),
    ...(googleServicesFile ? {
      android: {
        ...appJson.expo.android,
        googleServicesFile,
      },
    } : {}),
  } as ExpoConfig;
}

export default (): ExpoConfig => buildAppConfig(process.env);
