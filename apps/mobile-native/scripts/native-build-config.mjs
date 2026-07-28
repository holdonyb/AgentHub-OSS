import fs from 'node:fs';
import path from 'node:path';

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

export function expectedAndroidRuntimeConfig(appRoot) {
  const appJsonPath = path.join(appRoot, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const expo = appJson.expo ?? {};
  const engine = String(expo.jsEngine || 'hermes').trim().toLowerCase();
  return {
    newArchEnabled: Boolean(expo.newArchEnabled),
    hermesEnabled: engine === 'hermes',
  };
}

function replaceProperty(source, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const nextLine = `${key}=${value}`;
  if (pattern.test(source)) {
    return source.replace(pattern, nextLine);
  }
  return `${source.trimEnd()}\n${nextLine}\n`;
}

export function enforceAndroidRuntimeConfig(appRoot, config = { newArchEnabled: false, hermesEnabled: false }) {
  const gradlePropertiesPath = path.join(appRoot, 'android', 'gradle.properties');
  if (!fs.existsSync(gradlePropertiesPath)) {
    throw new Error(`gradle.properties not found: ${gradlePropertiesPath}`);
  }

  let source = fs.readFileSync(gradlePropertiesPath, 'utf8');
  source = replaceProperty(source, 'newArchEnabled', config.newArchEnabled ? 'true' : 'false');
  source = replaceProperty(source, 'hermesEnabled', config.hermesEnabled ? 'true' : 'false');
  fs.writeFileSync(gradlePropertiesPath, source, 'utf8');
}
