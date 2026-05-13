import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Android APK GitHub Actions workflow', () => {
  it('uses JDK 21 for Capacitor Android builds', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/android-apk.yml', import.meta.url),
      'utf-8',
    );

    expect(workflow).toContain("java-version: '21'");
  });

  it('requires a persistent signing key for APK artifacts', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/android-apk.yml', import.meta.url),
      'utf-8',
    );
    const buildGradle = readFileSync(
      new URL('android/app/build.gradle', import.meta.url),
      'utf-8',
    );

    expect(workflow).toContain('AGENTHUB_ANDROID_KEYSTORE_BASE64');
    expect(workflow).toContain('AGENTHUB_PUBLIC_BASE_URL');
    expect(workflow).toContain('base64 --decode');
    expect(workflow).toContain('npm run mobile:build:release');
    expect(workflow).not.toContain('Publish debug APK to production downloads');
    expect(workflow).not.toMatch(/AGENTHUB_DEPLOY_/);
    expect(workflow).toContain('apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
    expect(workflow).toContain('apps/mobile/android/app/build/outputs/apk/release/app-release.apk');
    expect(buildGradle).toContain('signingConfigs');
    expect(buildGradle).toContain('AGENTHUB_ANDROID_KEYSTORE_FILE');
    expect(buildGradle).toContain('AGENTHUB_MOBILE_SERVER_URL');
    expect(buildGradle).toContain('AGENTHUB_PUBLIC_BASE_URL');
    expect(buildGradle).toContain('buildFeatures');
    expect(buildGradle).toContain('buildConfig true');
    expect(buildGradle).toContain('buildConfigField "String", "AGENTHUB_SERVER_URL"');
    expect(buildGradle).toContain('versionCode 9');
    expect(buildGradle).toContain('versionName "1.8"');
    expect(buildGradle).toContain('debug {');
    expect(buildGradle).toContain('release {');
    expect(buildGradle.match(/signingConfig signingConfigs\.agenthub/g)?.length).toBe(2);
  });

  it('packages native notifications and microphone runtime permissions', () => {
    const mobilePackage = JSON.parse(
      readFileSync(new URL('package.json', import.meta.url), 'utf-8'),
    );
    const webPackage = JSON.parse(
      readFileSync(new URL('../web/package.json', import.meta.url), 'utf-8'),
    );
    const manifest = readFileSync(
      new URL('android/app/src/main/AndroidManifest.xml', import.meta.url),
      'utf-8',
    );
    const mainActivity = readFileSync(
      new URL('android/app/src/main/java/xin/ifix/agenthub/MainActivity.java', import.meta.url),
      'utf-8',
    );
    const serviceUrl = new URL('android/app/src/main/java/xin/ifix/agenthub/AgentHubNotificationService.java', import.meta.url);
    const service = existsSync(serviceUrl) ? readFileSync(serviceUrl, 'utf-8') : '';
    const capacitorSettings = readFileSync(
      new URL('android/capacitor.settings.gradle', import.meta.url),
      'utf-8',
    );

    expect(mobilePackage.dependencies['@capacitor/local-notifications']).toBeDefined();
    expect(mobilePackage.dependencies['@capacitor/app']).toBeDefined();
    expect(webPackage.dependencies['@capacitor/local-notifications']).toBeDefined();
    expect(webPackage.dependencies['@capacitor/app']).toBeDefined();
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_DATA_SYNC');
    expect(manifest).toContain('AgentHubNotificationService');
    expect(manifest).toContain('android:foregroundServiceType="dataSync"');
    expect(manifest).toContain('android.permission.RECORD_AUDIO');
    expect(manifest).toContain('android.permission.MODIFY_AUDIO_SETTINGS');
    expect(manifest).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    expect(mainActivity).toContain('AgentHubWebChromeClient');
    expect(mainActivity).toContain('PermissionRequest.RESOURCE_AUDIO_CAPTURE');
    expect(mainActivity).toContain('request.grant(request.getResources())');
    expect(mainActivity).toContain('@JavascriptInterface');
    expect(mainActivity).toContain('AgentHubAndroidBridge');
    expect(mainActivity).toContain('SharedPreferences');
    expect(mainActivity).toContain('AlertDialog');
    expect(mainActivity).toContain('PREF_SERVER_URL');
    expect(mainActivity).toContain('configuredServerUrl');
    expect(mainActivity).toContain('showServerSetup');
    expect(mainActivity).toContain('saveServerUrl');
    expect(mainActivity).toContain('clearServerUrl');
    expect(mainActivity).toContain('currentServerUrl');
    expect(mainActivity).toContain('setServerUrl');
    expect(mainActivity).toContain('microphonePermissionState');
    expect(mainActivity).toContain('requestMicrophonePermission');
    expect(mainActivity).toContain('startNotificationService');
    expect(mainActivity).toContain('stopNotificationService');
    expect(mainActivity).toContain('appVersionName');
    expect(mainActivity).toContain('appVersionCode');
    expect(mainActivity).toContain('downloadLatestApk');
    expect(mainActivity).toContain('DownloadManager');
    expect(mainActivity).toContain('application/vnd.android.package-archive');
    expect(mainActivity).toContain('error.getMessage()');
    expect(mainActivity).toContain('bridge.getWebView().loadUrl(serverUrl)');
    expect(mainActivity).not.toContain('OnBackPressedCallback');
    expect(mainActivity).not.toContain('getOnBackPressedDispatcher().addCallback');
    expect(mainActivity).not.toContain('AgentHubHandleAndroidBack');
    expect(mainActivity).toContain('WindowInsetsCompat.Type.systemBars()');
    expect(mainActivity).toContain('WindowInsetsCompat.Type.displayCutout()');
    expect(mainActivity).toContain('setOnApplyWindowInsetsListener');
    expect(mainActivity).toContain('createAgentHubNotificationChannel');
    expect(mainActivity).toContain('agenthub-approvals-v2');
    expect(mainActivity).toContain('NotificationManager.IMPORTANCE_HIGH');
    expect(mainActivity).toContain('RingtoneManager.TYPE_NOTIFICATION');
    expect(service).toContain('startForeground');
    expect(service).toContain('/api/permissions');
    expect(service).toContain('/api/sessions');
    expect(service).toContain('/api/jobs');
    expect(service).toContain('PREF_NOTIFIED_JOBS');
    expect(service).toContain('notifyFailedJobs');
    expect(service).toContain('AgentHub 作业失败');
    expect(service).toContain('BuildConfig.AGENTHUB_SERVER_URL');
    expect(service).toContain('currentServerUrl');
    expect(service).toContain('CLIENT_PREFS_NAME');
    expect(service).toContain('agenthub.invalid');
    expect(service).toContain('CookieManager.getInstance().getCookie');
    expect(service).toContain('START_STICKY');
    expect(capacitorSettings).toContain("include ':capacitor-local-notifications'");
    expect(capacitorSettings).toContain("include ':capacitor-app'");
  });
});

describe('Public release workflow', () => {
  it('builds workspace packages through npm workspaces so remote builds find root binaries', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    );
    const desktopPackage = JSON.parse(
      readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf-8'),
    );

    expect(packageJson.scripts['web:build']).toContain('--workspace @agenthub/web');
    expect(packageJson.scripts['mobile:build:release']).toContain('--workspace @agenthub/mobile');
    expect(packageJson.scripts['desktop:package:win']).toContain('--workspace @agenthub/desktop');
    expect(desktopPackage.scripts['package:win']).toContain('node scripts/package-win.mjs');
    expect(desktopPackage.devDependencies['electron-builder']).toBeDefined();
  });

  it('builds public release assets without private SSH deploy secrets', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf-8',
    );

    expect(workflow).toContain("tags:");
    expect(workflow).toContain('runs-on: windows-latest');
    expect(workflow).toContain('npm run desktop:package:win');
    expect(workflow).toContain('npm run mobile:build:release');
    expect(workflow).toContain("python scripts/build-worker-bundle.py --output-root dist/release/workers");
    expect(workflow).toContain('actions/download-artifact@v4');
    expect(workflow).toContain('agenthub-desktop-windows');
    expect(workflow).toContain('agenthub-android-apk');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('softprops/action-gh-release');
    expect(workflow).not.toMatch(/AGENTHUB_DEPLOY_/);
  });
});
