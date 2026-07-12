# Android Download Channels Design

## Goal

Expose both Android clients through `agenthub.ifix.xin` without presenting the native client as an in-place update for the existing WebView client.

## Product Contract

AgentHub currently ships two Android applications:

| Channel | Package ID | Purpose | Upgrade behavior |
| --- | --- | --- | --- |
| WebView | `xin.ifix.agenthub` | Existing production client and background notification shell | May update an installed WebView client when signed with the existing key |
| Native | `dev.myagenthub.mobile` | Mobile-first Workbench, tasks, files, sessions, and workers | Installs alongside the WebView client; it is not an in-place update |

The UI must use the labels `更新当前版` and `安装原生版`. It must not describe the native package as an update to the WebView package.

## Public Paths

- `/downloads/agenthub-android-release.apk`: current WebView release
- `/downloads/agenthub-native-android-release.apk`: native Android release
- `/downloads/SHA256SUMS`: checksums for the mirrored release assets

The server must return `application/vnd.android.package-archive` for both APK paths. Missing files must fail instead of falling back to the Web SPA.

## Web Console

The mobile `我的` update area will show two separate cards:

1. Current WebView client: check metadata and download an in-place-compatible package.
2. Native client: show the Workbench-focused description and install as a separate app.

Each card exposes file size, last-modified time, direct download, and copy-link actions. The Native card explicitly says it can coexist with the current app and requires server configuration plus login on first launch.

## Release Mirroring

Deployment copies the two APKs and `SHA256SUMS` from the GitHub `v1.0.0` release into the production download directory. Nginx serves exact file locations so an unknown APK path cannot return `index.html` with status 200.

## Validation

- Web tests cover channel labels, URLs, and native-install wording.
- Android shell tests continue to verify WebView update behavior.
- HEAD and GET checks verify content type, non-HTML bodies, size, and SHA256.
- A 390 x 844 browser pass verifies both download actions remain visible without horizontal overflow.

## Non-goals

- Replacing the WebView package with the native package.
- Migrating WebView local storage or cookies into the native client.
- Publishing either package through an app store.
