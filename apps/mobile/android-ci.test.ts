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
    expect(workflow).toContain('base64 --decode');
    expect(workflow).toContain('npm run mobile:build:release');
    expect(workflow).toContain('app-debug.apk');
    expect(buildGradle).toContain('signingConfigs');
    expect(buildGradle).toContain('AGENTHUB_ANDROID_KEYSTORE_FILE');
    expect(buildGradle).toContain('versionCode 10');
    expect(buildGradle).toContain('versionName "1.9"');
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
    expect(mainActivity).toContain('microphonePermissionState');
    expect(mainActivity).toContain('requestMicrophonePermission');
    expect(mainActivity).toContain('startNotificationService');
    expect(mainActivity).toContain('stopNotificationService');
    expect(mainActivity).toContain('setServerBaseUrl');
    expect(mainActivity).toContain('appVersionName');
    expect(mainActivity).toContain('appVersionCode');
    expect(mainActivity).toContain('downloadLatestApk');
    expect(mainActivity).toContain('copyTextToClipboard');
    expect(mainActivity).toContain('copyText(String text)');
    expect(mainActivity).toContain('DownloadManager');
    expect(mainActivity).toContain('application/vnd.android.package-archive');
    expect(mainActivity).toContain('error.getMessage()');
    expect(mainActivity).toContain('bridge.reload()');
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
    expect(service).toContain('/api/sync/permissions');
    expect(service).toContain('/api/sync/inbox');
    expect(service).toContain('serverBaseUrl()');
    expect(service).toContain('agenthub-app-config');
    expect(service).toContain('pendingPermissionSessionsById');
    expect(service).toContain('withCursor');
    expect(service).toContain('CookieManager.getInstance().getCookie');
    expect(service).toContain('START_STICKY');
    expect(capacitorSettings).toContain("include ':capacitor-local-notifications'");
    expect(capacitorSettings).toContain("include ':capacitor-app'");
  });
});

describe('OSS packaging workflow', () => {
  it('builds workspace packages through npm workspaces so release builds find root binaries', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    );

    expect(packageJson.scripts['web:build']).toContain('--workspace @agenthub/web');
    expect(packageJson.scripts['mobile:build:release']).toContain('--workspace @agenthub/mobile');
  });

  it('keeps public release automation and self-host smoke checked in', () => {
    const releaseWorkflow = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf-8',
    );
    const smokeWorkflow = readFileSync(
      new URL('../../.github/workflows/selfhost-smoke.yml', import.meta.url),
      'utf-8',
    );
    const smokeScript = readFileSync(
      new URL('../../scripts/smoke-selfhost-vm.sh', import.meta.url),
      'utf-8',
    );

    expect(releaseWorkflow).toContain('workflow_dispatch');
    expect(releaseWorkflow).toContain('agenthub-android-apk');
    expect(releaseWorkflow).toContain('actions/upload-artifact@v4');
    expect(releaseWorkflow).toContain('agenthub-android-release.apk');
    expect(releaseWorkflow).toContain('softprops/action-gh-release@v2');
    expect(smokeWorkflow).toContain('SELFHOST_SMOKE_OK');
    expect(smokeWorkflow).toContain('run_worker_smoke');
    expect(smokeScript).toContain('scripts/install-selfhost-linux.sh');
    expect(smokeScript).toContain('scripts/check-selfhost.sh');
  });
});
