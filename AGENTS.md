# AHFix Agent Notes

## Scope

This repo contains both:

- the Capacitor/WebView mobile client under `apps/mobile`
- the React Native / Expo native client under `apps/mobile-native`

Do not treat them as the same artifact. A fix in one does not validate the other.

## Native Mobile Release Guardrails

The React Native client has a proven failure mode from July 2026:

- package `dev.myagenthub.mobile` version `1.0.3` crashed on launch on Android
- real-device logcat showed:
  - `SoLoaderDSONotFoundError`
  - missing `libhermestooling.so`
- the shipped APK contained `libjsc.so`
- runtime still entered `HermesInstance`

This was a JS-engine / runtime-path mismatch, not a session, API, or UI bug.

Rules:

1. Treat `apps/mobile-native/app.json` as the release authority for native runtime flags.
2. For AgentHub 1.0.x, keep Android native runtime conservative:
   - explicit single JS engine
   - no unvalidated new-architecture rollout
3. Expo `prebuild` can regenerate `android/gradle.properties` with runtime flags that disagree with `app.json`.
   - Never assume `app.json` alone is enough.
   - After every `expo prebuild --clean`, verify the generated `android/gradle.properties`.
   - If generated `newArchEnabled` / `hermesEnabled` do not match the intended release runtime, fix that in the build script, not by hand-editing generated files and hoping it sticks.
3. Release validation must include:
   - native unit tests
   - native typecheck
   - built APK runtime verification
   - at least one real-device cold-start smoke before calling the APK good
4. If a user reports "open -> immediately stops running", pull logcat before touching UI code.
5. If the installed APK behavior and repo code disagree, verify the actual shipped asset first. Do not assume the website APK matches the current branch.
6. If CI produces a green APK but the app still crashes on device, compare three layers explicitly:
   - Expo config (`app.json` / `app.config.ts`)
   - generated Android project (`android/gradle.properties`, `app/build.gradle`)
   - shipped APK contents (`libjsc.so`, `libhermes.so`, `libhermestooling.so`)
   Root cause lives in the first layer where they diverge.

## Build Reality

`apps/mobile-native` uses Expo CNG / prebuild. The generated `android/` project is build output, not durable product source of truth.

That means:

- reading `android/` can help diagnose generated state
- but release reasoning must start from `app.json`, build scripts, and the actual APK that shipped

## Immediate Native Regression Checklist

When Android native launch regresses:

1. `adb shell dumpsys package dev.myagenthub.mobile`
2. `adb logcat -c`
3. launch app
4. `adb logcat -d | findstr /i "AndroidRuntime FATAL dev.myagenthub.mobile Hermes SoLoader"`
5. inspect APK libs for `libjsc.so`, `libhermes.so`, `libhermestooling.so`
6. compare shipped APK contents against `apps/mobile-native/app.json`

## Release Regression Lessons

The July 2026 native regression exposed a specific process failure:

- Expo config resolved to `newArchEnabled=false` / `jsEngine=jsc`
- `expo prebuild` still regenerated `android/gradle.properties` with `newArchEnabled=true` and `hermesEnabled=true`
- the final shipped APK therefore did not match the repo-level intent

Rules added from this incident:

1. Do not treat `app.json` or `app.config.ts` as sufficient release evidence.
2. After every native `expo prebuild`, verify generated `android/gradle.properties` before Gradle build starts.
3. Release scripts must enforce the generated Android runtime flags, not only declare them.
4. Release scripts must validate the final APK contents (`libjsc.so` / `libhermes.so` / `libhermestooling.so`) before publishing.
5. If website download, GitHub release, and installed-device version disagree, trust the built artifact inspection first, then reconcile distribution.

## Public Download Drift Guardrails

July 2026 exposed another failure mode:

- GitHub latest release already moved to `v1.0.7`
- Web/App code already pointed to `/downloads/agenthub-native-android-release.apk`
- live `agenthub.ifix.xin/downloads/*` still served the July 24 APKs

That is not a UI bug. It is a distribution split between:

1. GitHub Release assets
2. live server `data/downloads`
3. the user-installed package

Rules:

1. Treat GitHub Release publication and live `/downloads/*` publication as separate steps unless automation explicitly links them.
2. If a public node should mirror GitHub latest release assets, make deploy run `scripts/sync-android-release-assets.sh` before web build sync.
3. Do not assume tagging `vX.Y.Z` changes the files currently served by `https://<host>/downloads/*`.
4. When a user reports "I downloaded the latest APK but it is still old", verify:
   - GitHub latest release tag
   - live `/downloads/*` `Last-Modified` and size
   - installed package version on device
5. If those three do not match, fix distribution first, then debug app behavior.
