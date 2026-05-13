import { describe, expect, it } from 'vitest';
import { resolveJavaHome } from './scripts/java-home.mjs';

describe('local JDK resolver', () => {
  it('prefers an existing JAVA_HOME', () => {
    const javaHome = resolveJavaHome({
      env: { JAVA_HOME: 'D:/Java/jdk-21' },
      existsSync: (path: string) => path === 'D:/Java/jdk-21/bin/java.exe',
      platform: 'win32',
    });

    expect(javaHome).toBe('D:/Java/jdk-21');
  });

  it('detects the E drive JDK when JAVA_HOME is missing', () => {
    const javaHome = resolveJavaHome({
      env: {},
      existsSync: (path: string) => path === 'E:/Tools/jdk-17.0.18+8/bin/java.exe',
      platform: 'win32',
      candidates: ['E:/Tools/jdk-17.0.18+8'],
    });

    expect(javaHome).toBe('E:/Tools/jdk-17.0.18+8');
  });

  it('prefers Android Studio JBR 21 over older E drive JDKs by default', () => {
    const javaHome = resolveJavaHome({
      env: {},
      existsSync: (path: string) =>
        path === 'E:/Tools/jdk-17.0.18+8/bin/java.exe' ||
        path === 'E:/Program Files/Android/Android Studio/jbr/bin/java.exe',
      platform: 'win32',
    });

    expect(javaHome).toBe('E:/Program Files/Android/Android Studio/jbr');
  });

  it('detects Android Studio JBR from the default C drive install path', () => {
    const javaHome = resolveJavaHome({
      env: {},
      existsSync: (path: string) => path === 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe',
      platform: 'win32',
    });

    expect(javaHome).toBe('C:/Program Files/Android/Android Studio/jbr');
  });
});
