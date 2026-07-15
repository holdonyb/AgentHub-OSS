# AgentHub Native Mobile

`apps/mobile-native` is the React Native client for AgentHub 1.0. It uses Expo 57 with Continuous Native Generation (CNG), so generated `android/` and `ios/` projects are not committed.

Current supported scope:

- first-launch self-host server configuration
- HTTPS validation with an explicit localhost/Tailscale HTTP development switch
- server configuration stored through `expo-secure-store`
- cookie-session login, restore check, logout, and server switching through `@agenthub/client-core`
- authenticated tab shell for Sessions, Tasks, Files, Workers, and Profile
- API-backed session inbox with status, worker/backend metadata, last activity, selection, and refresh
- dedicated session detail with chronological timeline, older-history paging, multiline replies, and queued/running/failed delivery state
- pending approval and `request_user_input` handling with multi-question choices, freeform answers, notes, and duplicate-submit protection
- owner/admin session termination with explicit confirmation and visible API errors
- API-backed task inbox with status filters and task detail for briefs, criteria, artifacts, and executions
- task dispatch, review, approval, rework, and artifact inspection
- API-backed worker list with online state, heartbeat, and reported capabilities
- workspace file browsing, text editing, image/media preview, folder creation, rename, and upload
- image attachments and native voice dictation in session replies
- server-ledger-backed approval/session notifications, per-device Expo Push registration, cold-start
  notification taps, session deep links, and read state
- loading, empty, error, retry, and refresh states across the API-backed lists

The existing Capacitor app under `apps/mobile` remains available as the compatibility Android client while the 1.0 release also produces React Native APK and AAB artifacts. The React Native client is the forward-looking cross-platform surface.

The notification ledger is authoritative across Web and mobile clients. When the app is built with an EAS project id and the server enables Expo Push, each signed-in installation registers a separate device delivery channel. Web read/delivery state does not consume phone delivery. The in-app notification inbox and foreground local-notification fallback remain available when push is not configured.

## Background Push

Create or link an Expo project, then build the native app with its project id:

```bash
export EXPO_PUBLIC_EAS_PROJECT_ID=your-eas-project-id
npm run mobile:native:prebuild
```

Enable the server dispatcher separately:

```env
AGENTHUB_EXPO_PUSH_ENABLED=true
AGENTHUB_EXPO_PUSH_ACCESS_TOKEN=
```

`AGENTHUB_EXPO_PUSH_ACCESS_TOKEN` is only required when the Expo project enables push access-token security. Device push tokens are stored server-side, redacted from API responses, and cleared when the user logs out or changes server. Notification title and body pass through Expo's push service; operators who require a fully private transport should leave this feature disabled and use the inbox/foreground fallback.

An EAS project id is build-time configuration. Changing it requires rebuilding the APK/IPA. Background delivery must be verified on a physical device; Expo Go and simulators are not release evidence.

Android release builds require the four `AGENTHUB_ANDROID_*` signing variables documented by the release workflow. iOS currently has source and CI support through an unsigned Simulator build. A signed IPA, real-device smoke, and App Store distribution still require Apple signing and provisioning outside this repository.

The generated Android manifest allows cleartext transport so runtime-configured Tailscale addresses can work; application validation still rejects public HTTP origins. iOS limits its transport exception to local networking and `*.ts.net`.

## Requirements

- Node.js 20.19.4 or newer
- Android Studio for Android native builds
- macOS with Xcode for iOS native builds

## Commands

```bash
npm run mobile:native:test
npm run mobile:native:typecheck
npm run mobile:native:start
npm run mobile:native:prebuild
npm run mobile:native:build:android:debug
npm run mobile:native:build:android
npm run mobile:native:build:ios
```

`prebuild` regenerates native projects locally. Do not commit those generated directories.
