# AgentHub Android APK

This is a thin Capacitor Android wrapper for AgentHub.

On first launch, the APK asks for your AgentHub server URL before opening the login screen.

Supported first-launch targets:

```text
https://agenthub.example.com
https://agenthub.tailnet-name.ts.net
http://100.x.y.z:8019
http://192.168.x.y:8019
```

Public internet hosts must use HTTPS. Plain HTTP is only accepted for localhost, LAN, and Tailscale-style private addresses.

Build APKs through GitHub Actions or locally with an Android SDK:

```powershell
npm run web:build
npm run mobile:build:debug
npm run mobile:build:release
```

APK outputs:

```text
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

To keep phone updates installable without uninstalling the existing app, debug and release builds can both use the same AgentHub signing key. Provide these environment variables before building:

```text
AGENTHUB_ANDROID_KEYSTORE_FILE
AGENTHUB_ANDROID_KEYSTORE_PASSWORD
AGENTHUB_ANDROID_KEY_ALIAS
AGENTHUB_ANDROID_KEY_PASSWORD
```

GitHub Actions reads the same values from repository secrets, with the keystore stored as `AGENTHUB_ANDROID_KEYSTORE_BASE64`.

The public release flow publishes Android assets when you cut a version tag that matches `v*`. Download the packaged APK from the matching GitHub Release.

Publish your signed debug APK to your own download path:

```powershell
npm run mobile:build:debug
```
