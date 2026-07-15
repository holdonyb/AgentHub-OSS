import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { AgentHubApiError } from '@agenthub/client-core';
import type { MobileApi } from '../api/mobileApi';
import {
  currentPushDeviceId,
  registerCurrentPushDevice,
  revokeCurrentPushDevice,
} from './pushRegistration';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    easConfig: { projectId: 'project-123' },
    expoConfig: { version: '1.0.0', extra: { eas: { projectId: 'fallback-project' } } },
  },
}));

const api = {
  upsertPushDevice: jest.fn(),
  revokePushDevice: jest.fn(),
} as unknown as MobileApi;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as never);
  jest.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
    type: 'expo',
    data: 'ExponentPushToken[private-token]',
  } as never);
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  jest.mocked(SecureStore.setItemAsync).mockResolvedValue();
  jest.mocked(api.upsertPushDevice).mockResolvedValue({ device: {} as never });
  jest.mocked(api.revokePushDevice).mockResolvedValue({ revoked: true });
  (Constants.easConfig as { projectId?: string } | null) = { projectId: 'project-123' };
});

it('does not request a token when notification permission is disabled', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as never);

  await expect(registerCurrentPushDevice(api, 'csrf-token')).resolves.toBe(false);

  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(api.upsertPushDevice).not.toHaveBeenCalled();
});

it('does not request a token when the Expo project id is absent', async () => {
  (Constants.easConfig as { projectId?: string } | null) = null;
  (Constants.expoConfig as { version?: string; extra?: Record<string, unknown> } | null) = {
    version: '1.0.0',
    extra: {},
  };

  await expect(registerCurrentPushDevice(api, 'csrf-token')).resolves.toBe(false);

  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(api.upsertPushDevice).not.toHaveBeenCalled();
});

it('stores a stable device id and registers the Expo token without returning it', async () => {
  await expect(registerCurrentPushDevice(api, 'csrf-token')).resolves.toBe(true);

  expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-123' });
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    'agenthub.pushDeviceId.v1',
    expect.stringMatching(/^agenthub-(android|ios)-/),
  );
  expect(api.upsertPushDevice).toHaveBeenCalledWith(
    expect.objectContaining({
      device_id: expect.stringMatching(/^agenthub-(android|ios)-/),
      platform: expect.stringMatching(/^(android|ios)$/),
      transport: 'expo',
      push_token: 'ExponentPushToken[private-token]',
      app_version: '1.0.0',
    }),
    'csrf-token',
  );
});

it('reuses the stored device id and revokes it before logout', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue('agenthub-android-existing');

  await registerCurrentPushDevice(api, 'csrf-token');
  await expect(currentPushDeviceId()).resolves.toBe('agenthub-android-existing');
  await expect(revokeCurrentPushDevice(api, 'csrf-token')).resolves.toBe(true);

  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(api.upsertPushDevice).toHaveBeenCalledWith(
    expect.objectContaining({ device_id: 'agenthub-android-existing' }),
    'csrf-token',
  );
  expect(api.revokePushDevice).toHaveBeenCalledWith('agenthub-android-existing', 'csrf-token');
});

it('rotates a device id once when it belongs to another account', async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue('agenthub-android-previous-account');
  jest.mocked(api.upsertPushDevice)
    .mockRejectedValueOnce(new AgentHubApiError({ status: 409, message: 'device already belongs to another user' }))
    .mockResolvedValueOnce({ device: {} as never });

  await expect(registerCurrentPushDevice(api, 'csrf-token')).resolves.toBe(true);

  expect(api.upsertPushDevice).toHaveBeenCalledTimes(2);
  expect(api.upsertPushDevice).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ device_id: 'agenthub-android-previous-account' }),
    'csrf-token',
  );
  expect(api.upsertPushDevice).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      device_id: expect.stringMatching(/^agenthub-(android|ios)-/),
    }),
    'csrf-token',
  );
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    'agenthub.pushDeviceId.v1',
    expect.not.stringMatching(/previous-account/),
  );
});
