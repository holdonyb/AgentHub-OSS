# Android Download Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish separate WebView-update and native-install Android channels through AgentHub's UI and production download paths.

**Architecture:** Model the two APKs as explicit channel descriptors in the Web console and serve exact APK files through Nginx so missing assets cannot fall through to the SPA. Keep the Android bridge for the compatible WebView update and present the native package as a separate installation.

**Tech Stack:** React, TypeScript, Vitest, static HTML, Nginx, GitHub Release assets, PowerShell/SSH smoke checks.

---

### Task 1: Lock the two-channel Web behavior

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] Write a failing test named `separates the WebView update from the native Android install`. Mock HEAD metadata for both APK paths. Assert that `更新当前版` downloads `agenthub-android-release.apk`, `安装原生版` downloads `agenthub-native-android-release.apk`, and the UI says the native client installs alongside the current client.
- [ ] Run `npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "separates the WebView update from the native Android install"`. Expect failure because the native channel is absent.
- [ ] Replace the single APK constants with channel descriptors containing `path`, `filename`, and `installMode`; track metadata independently.
- [ ] Render two compact cards: `当前 WebView 客户端` with `更新当前版`, and `原生 Workbench 客户端` with `安装原生版` plus `会作为独立 App 安装，可与当前版共存`.
- [ ] Run the focused test, `npm run web:test`, and `npm run web:build`. Expect all pass.

### Task 2: Make self-host download routes fail closed

**Files:**
- Modify: `deploy/nginx/agenthub-selfhost.conf.template`
- Modify: `apps/api/tests/test_selfhost_onboarding_assets.py`
- Create: `scripts/sync-android-release-assets.sh`

- [ ] Add failing assertions requiring exact Nginx locations for both APKs and `SHA256SUMS`, plus a sync script naming all three assets.
- [ ] Run `npm run api:test -- --no-cov apps/api/tests/test_selfhost_onboarding_assets.py -q`. Expect failure.
- [ ] Add exact Nginx routes served from `/opt/agenthub/data/downloads/`, with APK content type, attachment disposition, no-cache policy, and a real 404 for missing files.
- [ ] Add an idempotent release mirror script accepting repository, tag, and destination overrides. Download into a temporary directory, verify both APK hashes against `SHA256SUMS`, then atomically replace only those three destination files.
- [ ] Run the focused API test and `bash -n scripts/sync-android-release-assets.sh`. Expect pass.

### Task 3: Correct the public download and release pages

**Files:**
- Modify: `website/download/index.html`
- Modify: `website/release/index.html`
- Modify: `apps/api/tests/test_selfhost_onboarding_assets.py`

- [ ] Extend website assertions to require `v1.0.0`, both Android filenames, both package IDs, coexistence wording, and published SHA256 values.
- [ ] Run the focused API test. Expect failure on stale `v0.1.1` copy.
- [ ] Update both pages with separate WebView and native cards, `v1.0.0` links, and these hashes:

```text
bd77640e9cffc38cf5ce4728c0ddbe74b06c65d4c6155c793abfe4638137dc50  agenthub-android-release.apk
4ff07d1e2172c1589b610238669e67216efb9cfdfc0ed0adad328b154b3495f7  agenthub-native-android-release.apk
```

- [ ] Run the focused API test. Expect pass.

### Task 4: Integrate and deploy safely

**Files:**
- Modify: `PROJECT_STATUS.md`

- [ ] Run `npm run web:test`, `npm run web:build`, the focused API test, `npm run mobile:test`, and `git diff --check`.
- [ ] Commit, push, open a PR, and wait for CI plus Secret Scan before merging.
- [ ] Before production changes, record the deployed commit and create timestamped database and Web-build backups under `/opt/agenthub-backups/`. Never replace the database.
- [ ] Mirror the `v1.0.0` assets, deploy merged `main`, validate `nginx -t`, and reload Nginx.
- [ ] Verify both APK URLs return `application/vnd.android.package-archive`, both hashes match GitHub Release, `SHA256SUMS` is real text, `/healthz` is OK, and a 390 x 844 browser pass has no horizontal overflow.
- [ ] Record deployment evidence in `PROJECT_STATUS.md` and leave the branch clean.
