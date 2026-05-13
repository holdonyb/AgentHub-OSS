# AgentHub Android APK

This is a Capacitor Android wrapper for an AgentHub console.

The public APK uses an unconfigured placeholder URL by default and asks for a server address on first launch. Preconfigured builds can set:

```text
AGENTHUB_MOBILE_SERVER_URL=https://agenthub.example.com
AGENTHUB_PUBLIC_BASE_URL=https://agenthub.example.com
```

Build APKs with:

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

To keep upgrades installable without uninstalling the existing app, use the same signing key for every build:

```text
AGENTHUB_ANDROID_KEYSTORE_FILE
AGENTHUB_ANDROID_KEYSTORE_PASSWORD
AGENTHUB_ANDROID_KEY_ALIAS
AGENTHUB_ANDROID_KEY_PASSWORD
```
