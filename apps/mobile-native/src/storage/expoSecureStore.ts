import * as SecureStore from 'expo-secure-store';
import type { SecureKeyValueStore } from '../config/serverConfigRepository';

export const expoSecureStore: SecureKeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};
