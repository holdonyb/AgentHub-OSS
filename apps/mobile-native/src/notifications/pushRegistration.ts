import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { AgentHubApiError } from '@agenthub/client-core';
import type { MobileApi } from '../api/mobileApi';

const DEVICE_ID_KEY = 'agenthub.pushDeviceId.v1';

type PushRegistrationApi = Pick<MobileApi, 'upsertPushDevice' | 'revokePushDevice'>;

function expoProjectId(): string | null {
  const easProjectId = Constants.easConfig?.projectId;
  if (typeof easProjectId === 'string' && easProjectId.trim()) return easProjectId.trim();
  const configuredProjectId = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof configuredProjectId === 'string' && configuredProjectId.trim()
    ? configuredProjectId.trim()
    : null;
}

function createDeviceId(platform: 'android' | 'ios'): string {
  const random = Math.random().toString(36).slice(2, 14);
  return `agenthub-${platform}-${Date.now().toString(36)}-${random}`;
}

async function getOrCreateDeviceId(platform: 'android' | 'ios'): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const deviceId = createDeviceId(platform);
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export async function registerCurrentPushDevice(
  api: PushRegistrationApi,
  csrfToken: string,
): Promise<boolean> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
  if (!(await Notifications.getPermissionsAsync()).granted) return false;
  const projectId = expoProjectId();
  if (!projectId) return false;

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  if (!token.data) return false;
  const registration = {
    platform: Platform.OS,
    transport: 'expo' as const,
    push_token: token.data,
    app_version: Constants.expoConfig?.version ?? '',
  };
  let deviceId = await getOrCreateDeviceId(Platform.OS);
  try {
    await api.upsertPushDevice(
      {
        device_id: deviceId,
        ...registration,
      },
      csrfToken,
    );
  } catch (error) {
    if (!(error instanceof AgentHubApiError) || error.status !== 409) throw error;
    deviceId = createDeviceId(Platform.OS);
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
    await api.upsertPushDevice(
      {
        device_id: deviceId,
        ...registration,
      },
      csrfToken,
    );
  }
  return true;
}

export async function revokeCurrentPushDevice(
  api: PushRegistrationApi,
  csrfToken: string,
): Promise<boolean> {
  const deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!deviceId) return false;
  const result = await api.revokePushDevice(deviceId, csrfToken);
  return result.revoked;
}

export async function currentPushDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_ID_KEY);
}
