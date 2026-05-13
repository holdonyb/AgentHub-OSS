import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyResolvedAndroidHome } from './android-home.mjs';
import { applyResolvedJavaHome } from './java-home.mjs';

const variant = (process.argv[2] || 'debug').toLowerCase();
const allowedVariants = new Set(['debug', 'release']);

if (!allowedVariants.has(variant)) {
  console.error(`Unknown Android build variant: ${variant}. Use "debug" or "release".`);
  process.exit(1);
}

const androidDir = fileURLToPath(new URL('../android', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const gradlewPath = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

if (!existsSync(gradlewPath)) {
  console.error('Android Gradle wrapper not found. Run `npm run mobile:sync` first.');
  process.exit(1);
}

const buildEnv = { ...process.env };
buildEnv.GRADLE_USER_HOME = buildEnv.AGENTHUB_GRADLE_USER_HOME || buildEnv.GRADLE_USER_HOME || join(repoRoot, '.runtime', 'gradle-home');
mkdirSync(buildEnv.GRADLE_USER_HOME, { recursive: true });
console.log(`Using GRADLE_USER_HOME=${buildEnv.GRADLE_USER_HOME}`);

const javaHome = applyResolvedJavaHome(buildEnv);
if (javaHome) {
  console.log(`Using JAVA_HOME=${javaHome}`);
}

const androidHome = applyResolvedAndroidHome(buildEnv);
if (androidHome) {
  console.log(`Using ANDROID_HOME=${androidHome}`);
}

const signed = Boolean(
  buildEnv.AGENTHUB_ANDROID_KEYSTORE_FILE &&
    buildEnv.AGENTHUB_ANDROID_KEYSTORE_PASSWORD &&
    buildEnv.AGENTHUB_ANDROID_KEY_ALIAS &&
    buildEnv.AGENTHUB_ANDROID_KEY_PASSWORD,
);

const signingLabel = signed
  ? ' with AgentHub signing key'
  : variant === 'release'
    ? ' without AgentHub signing key'
    : ' with default debug signing';
console.log(`Building Android ${variant} APK${signingLabel}.`);

const task = variant === 'release' ? 'assembleRelease' : 'assembleDebug';
const result = spawnSync(gradlewPath, [task, '--stacktrace'], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: buildEnv,
});

if (result.error) {
  console.error(`Failed to start Android Gradle wrapper: ${result.error.message}`);
}

process.exit(result.status ?? 1);
