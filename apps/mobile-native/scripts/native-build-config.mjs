export const ANDROID_SIGNING_ENVIRONMENT = [
  'AGENTHUB_ANDROID_KEYSTORE_FILE',
  'AGENTHUB_ANDROID_KEYSTORE_PASSWORD',
  'AGENTHUB_ANDROID_KEY_ALIAS',
  'AGENTHUB_ANDROID_KEY_PASSWORD',
];

export function missingAndroidSigningEnvironment(env = process.env) {
  return ANDROID_SIGNING_ENVIRONMENT.filter((name) => !String(env[name] || '').trim());
}

export function androidGradleExecutable(platform = process.platform) {
  return platform === 'win32' ? 'gradlew.bat' : './gradlew';
}

export function executable(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.cmd` : name;
}

export function nativeSpawnOptions(platform = process.platform) {
  return platform === 'win32' ? { shell: true } : {};
}
