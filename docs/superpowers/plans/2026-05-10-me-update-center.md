# AgentHub Me Update Center Plan

## Goal

Turn the mobile `Me` tab into a useful device and update center so the user can check the production APK, download the latest build from inside the app, verify notifications, and see key diagnostics without leaving AgentHub.

## Scope

1. Web mobile `Me` pane:
   - Show signed-in account, role, pending approval count, secret count, worker health, API sync status.
   - Show native APK version when the Android bridge is available.
   - Add `检查更新`, `下载最新 APK`, `复制 APK 地址`, and notification guard actions.

2. Android APK bridge:
   - Expose `appVersionName()` and `appVersionCode()` to WebView JavaScript.
   - Expose `downloadLatestApk(url, filename)` using Android `DownloadManager`.
   - Bump APK version for this delivery.

3. Verification:
   - Add Web tests for update center behavior and Android bridge download call.
   - Add Android CI tests for bridge methods, DownloadManager usage, and version bump.
   - Run web/mobile tests and debug APK build before PR/deploy.
