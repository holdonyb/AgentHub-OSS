# AgentHub Android APK

This is a thin Capacitor Android wrapper for the hosted AgentHub console.

The APK loads:

```text
https://agenthub.example.com
```

Example hosted APK path:

```text
https://agenthub.example.com/downloads/agenthub-debug.apk
```

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
