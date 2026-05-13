import type { CapacitorConfig } from '@capacitor/cli';

export const DEFAULT_AGENTHUB_MOBILE_SERVER_URL = 'https://agenthub.invalid';

export function resolveAgentHubMobileServerUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const value =
    env.AGENTHUB_MOBILE_SERVER_URL?.trim() ||
    env.AGENTHUB_PUBLIC_BASE_URL?.trim() ||
    DEFAULT_AGENTHUB_MOBILE_SERVER_URL;
  return value.replace(/\/$/, '');
}

const config: CapacitorConfig = {
  appId: 'xin.ifix.agenthub',
  appName: 'AgentHub',
  webDir: '../web/dist',
  bundledWebRuntime: false,
  server: {
    url: resolveAgentHubMobileServerUrl(),
    cleartext: false,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_agenthub',
      iconColor: '#2563eb',
    },
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
