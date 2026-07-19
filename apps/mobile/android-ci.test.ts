import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Android APK GitHub Actions workflow', () => {
  it('uses JDK 21 for Capacitor Android builds', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/android-apk.yml', import.meta.url),
      'utf-8',
    );
    const ciWorkflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf-8',
    );

    expect(workflow).toContain("java-version: '21'");
    expect(ciWorkflow).toContain("java-version: '21'");
    expect(ciWorkflow).toContain('npm run mobile:native:build:android:debug');
  });

  it('requires a persistent signing key for APK artifacts', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/android-apk.yml', import.meta.url),
      'utf-8',
    );
    const releaseWorkflow = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf-8',
    );
    const buildGradle = readFileSync(
      new URL('android/app/build.gradle', import.meta.url),
      'utf-8',
    );

    expect(workflow).toContain('AGENTHUB_ANDROID_KEYSTORE_BASE64');
    expect(workflow).toContain('base64 --decode');
    expect(workflow).toContain('npm run mobile:build:release');
    expect(workflow).toContain('Build signed debug APK');
    expect(workflow).toContain('Upload signed APKs');
    expect(workflow).toContain('npm run mobile:native:test');
    expect(workflow).toContain('npm run mobile:native:typecheck');
    expect(workflow).toContain('npm run mobile:native:build:android');
    expect(workflow).toContain('apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk');
    expect(workflow).toContain('apps/mobile-native/android/app/build/outputs/apk/release/app-release.apk');
    expect(workflow).toContain('apps/mobile-native/android/app/build/outputs/bundle/release/app-release.aab');
    expect(releaseWorkflow).toContain("name: Release");
    expect(releaseWorkflow).toContain('AGENTHUB_ANDROID_KEYSTORE_BASE64');
    expect(releaseWorkflow).toContain('Decode Android signing key');
    expect(releaseWorkflow).toContain('agenthub-android-release.apk');
    expect(releaseWorkflow).toContain('npm run mobile:native:test');
    expect(releaseWorkflow).toContain('npm run mobile:native:typecheck');
    expect(releaseWorkflow).toContain('npm run mobile:native:build:android');
    expect(releaseWorkflow).toContain('agenthub-native-android-release.apk');
    expect(releaseWorkflow).toContain('agenthub-native-android-release.aab');
    expect(buildGradle).toContain('signingConfigs');
    expect(buildGradle).toContain('AGENTHUB_ANDROID_KEYSTORE_FILE');
    expect(buildGradle).toContain('versionCode 19');
    expect(buildGradle).toContain('versionName "1.0.1"');
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
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    expect(manifest).toContain('android:roundIcon="@mipmap/ic_launcher_round"');
    expect(mainActivity).toContain('AgentHubWebChromeClient');
    expect(mainActivity).toContain('PermissionRequest.RESOURCE_AUDIO_CAPTURE');
    expect(mainActivity).toContain('request.grant(request.getResources())');
    expect(mainActivity).toContain('@JavascriptInterface');
    expect(mainActivity).toContain('AgentHubAndroidBridge');
    expect(mainActivity).toContain('CookieManager.getInstance()');
    expect(mainActivity).toContain('setAcceptCookie(true)');
    expect(mainActivity).toContain('setAcceptThirdPartyCookies');
    expect(mainActivity).toContain('configureWebViewCookies');
    expect(mainActivity).toContain('microphonePermissionState');
    expect(mainActivity).toContain('requestMicrophonePermission');
    expect(mainActivity).toContain('startNotificationService');
    expect(mainActivity).toContain('stopNotificationService');
    expect(mainActivity).toContain('flushCookies');
    expect(mainActivity).toContain('appVersionName');
    expect(mainActivity).toContain('appVersionCode');
    expect(mainActivity).toContain('downloadLatestApk');
    expect(mainActivity).toContain('copyTextToClipboard');
    expect(mainActivity).toContain('copyText(String text)');
    expect(mainActivity).toContain('configuredServerUrl');
    expect(mainActivity).toContain('openServerSetup');
    expect(mainActivity).toContain('ServerSetupActivity');
    expect(mainActivity).toContain('AgentHubServerConfig.loadServerUrl');
    expect(mainActivity).toContain('DownloadManager');
    expect(mainActivity).toContain('application/vnd.android.package-archive');
    expect(mainActivity).toContain('error.getMessage()');
    expect(mainActivity).toContain('bridge.getWebView().loadUrl(configuredUrl)');
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
    expect(service).toContain('/api/notifications');
    expect(service).toContain('/delivered');
    expect(service).toContain('X-CSRF-Token');
    expect(service).toContain('claimed');
    expect(service).toContain('pollNotificationLedger');
    expect(service).toContain('HTTP_NOT_FOUND');
    expect(service).toContain('/api/sync/permissions');
    expect(service).toContain('/api/sync/inbox');
    expect(service).toContain('pendingPermissionSessionsById');
    expect(service).toContain('withCursor');
    expect(service).toContain('CookieManager.getInstance().getCookie');
    expect(service).toContain('START_STICKY');
    expect(service).not.toContain('https://agenthub.example.com');
    expect(manifest).toContain('ServerSetupActivity');
    expect(capacitorSettings).toContain("include ':capacitor-local-notifications'");
    expect(capacitorSettings).toContain("include ':capacitor-app'");
  });

  it('uses the shared AgentHub brand icon for Android launchers', () => {
    const launcher = readFileSync(
      new URL('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', import.meta.url),
      'utf-8',
    );
    const foreground = readFileSync(
      new URL('android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml', import.meta.url),
      'utf-8',
    );
    const notificationIcon = readFileSync(
      new URL('android/app/src/main/res/drawable/ic_stat_agenthub.xml', import.meta.url),
      'utf-8',
    );
    const webFavicon = readFileSync(new URL('../web/public/favicon.svg', import.meta.url), 'utf-8');

    expect(launcher).toContain('@drawable/ic_launcher_background');
    expect(launcher).toContain('@drawable/ic_launcher_foreground');
    expect(launcher).not.toContain('@mipmap/ic_launcher_foreground');
    expect(foreground).toContain('#67C4FF');
    expect(foreground).toContain('#50B2FF');
    expect(foreground).toContain('M42.38,34.30');
    expect(foreground).not.toContain('M36.70,24.68');
    expect(notificationIcon).toContain('M8.16,5.48');
    expect(webFavicon).toContain('<title>AgentHub</title>');
    expect(webFavicon).toContain('#79D1FF');
    expect(webFavicon).toContain('#3EA5FF');
    expect(webFavicon).toContain('rotate(-45 512 512)');
    expect(webFavicon).not.toContain('agenthub-icon-mask');
  });
});

describe('Production deploy workflow', () => {
  it('builds workspace packages through npm workspaces so remote builds find root binaries', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    );

    expect(packageJson.scripts['web:build']).toContain('--workspace @agenthub/web');
    expect(packageJson.scripts['mobile:build:release']).toContain('--workspace @agenthub/mobile');
  });
});
