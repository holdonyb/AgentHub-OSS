import { existsSync as nodeExistsSync } from 'node:fs';

const WINDOWS_CANDIDATES = [
  'E:/Program Files/Android/Android Studio/jbr',
  'C:/Program Files/Android/Android Studio/jbr',
  'E:/Tools/jdk-17.0.18+8',
  'E:/Android/tools/jdk17_tmp/extract/jdk-17.0.18+8',
  'E:/.gradle/jdks/eclipse_adoptium-17-amd64-windows.2',
  'C:/Program Files/Eclipse Adoptium/jdk-17',
  'C:/Program Files/Java/jdk-17',
];

function javaExecutable(javaHome, platform) {
  const normalized = javaHome.replace(/\\/g, '/').replace(/\/$/, '');
  const executable = platform === 'win32' ? 'java.exe' : 'java';
  return `${normalized}/bin/${executable}`;
}

export function resolveJavaHome({
  env = process.env,
  existsSync = nodeExistsSync,
  platform = process.platform,
  candidates = WINDOWS_CANDIDATES,
} = {}) {
  const envJavaHome = typeof env.JAVA_HOME === 'string' ? env.JAVA_HOME.trim() : '';
  if (envJavaHome && existsSync(javaExecutable(envJavaHome, platform))) {
    return envJavaHome.replace(/\\/g, '/').replace(/\/$/, '');
  }

  for (const candidate of candidates) {
    if (existsSync(javaExecutable(candidate, platform))) {
      return candidate.replace(/\\/g, '/').replace(/\/$/, '');
    }
  }

  return null;
}

export function applyResolvedJavaHome(env = process.env) {
  const javaHome = resolveJavaHome({ env });
  if (!javaHome) return null;
  env.JAVA_HOME = javaHome;
  const separator = process.platform === 'win32' ? ';' : ':';
  const javaBin = `${javaHome}/bin`;
  const currentPath = env.PATH || env.Path || '';
  env.PATH = currentPath ? `${javaBin}${separator}${currentPath}` : javaBin;
  return javaHome;
}
