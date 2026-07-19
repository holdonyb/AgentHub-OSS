# Native Mobile Complete Console V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn the Android React Native client into a complete phone-first AgentHub control console for sessions, files, tasks, workers, notifications and settings.

**Architecture:** Preserve the existing React Native app and API client, then split oversized screen concerns into feature-local presentation and action components. Existing FastAPI endpoints remain authoritative for mutations; native code submits typed requests and reconciles worker jobs, permissions and notification records.

**Tech Stack:** Expo/React Native, TypeScript, React Navigation, Jest/react-test-renderer, existing @agenthub/client-core, FastAPI session/workspace/task/settings routes.

---

### Task 1: Establish a parity acceptance contract

**Files:**
- Create: apps/mobile-native/src/features/parity/mobileParityFixtures.ts
- Create: apps/mobile-native/src/features/parity/mobileParity.test.tsx
- Modify: apps/mobile-native/src/api/mobileApi.test.ts

- [ ] **Step 1: Create realistic fixtures**

Create two online workers, Codex/Claude/Kimi capabilities, sessions in needs_reply/running/ready states, one request_user_input permission, long Markdown/tool output, and a task artifact with a workspace file path.

- [ ] **Step 2: Add failing five-tab workflow tests**

Assert that every tab exposes at least one actionable user operation, and that the fixture user can find a session, open a file, review a task and reach notification/settings state.

- [ ] **Step 3: Run red test**

Run: npm --workspace @agenthub/mobile-native run test -- mobileParity.test.tsx --runInBand

Expected: failure documents current missing user-visible workflows.

- [ ] **Step 4: Commit**

Run: git add apps/mobile-native/src/features/parity apps/mobile-native/src/api/mobileApi.test.ts
Run: git commit -m "test: define native mobile console parity contract"

### Task 2: Expose every existing mobile-safe API operation

**Files:**
- Modify: apps/mobile-native/src/api/mobileApi.ts
- Modify: apps/mobile-native/src/api/mobileApi.test.ts
- Inspect: apps/api/app/routers/sessions.py
- Inspect: apps/api/app/routers/workspace_files.py
- Inspect: apps/api/app/routers/settings.py

- [ ] **Step 1: Add red transport assertions**

Cover CSRF and payload shape for session file upload/create/mkdir/rename, settings/preferences and notification read/dismiss. Separately test the public GitHub latest-release metadata request and its fallback download URL. Each file mutation must include a session ID and retain its worker workspace scope.

- [ ] **Step 2: Add typed wrappers**

Add explicit payload and result types plus methods createSessionFile, mkdirSessionFile, renameSessionFile, uploadSessionFile, getSettings, patchPreferences and dismissNotification. Add a small release metadata helper that reads the public GitHub latest-release endpoint and falls back to the stable latest APK URL. Do not add generic any-typed endpoint access.

- [ ] **Step 3: Verify**

Run: npm --workspace @agenthub/mobile-native run test -- mobileApi.test.ts --runInBand

Expected: API contract tests pass.

- [ ] **Step 4: Commit**

Run: git add apps/mobile-native/src/api/mobileApi.ts apps/mobile-native/src/api/mobileApi.test.ts
Run: git commit -m "feat: expose mobile control API operations"

### Task 3: Complete the session inbox and conversation control flow

**Files:**
- Create: apps/mobile-native/src/features/sessions/SessionFilters.tsx
- Create: apps/mobile-native/src/features/sessions/TimelineCard.tsx
- Create: apps/mobile-native/src/features/sessions/MessageReader.tsx
- Create: apps/mobile-native/src/features/sessions/ReplyComposer.tsx
- Modify: apps/mobile-native/src/screens/SessionsScreen.tsx
- Modify: apps/mobile-native/src/screens/SessionDetailScreen.tsx
- Modify: apps/mobile-native/src/screens/SessionDetailScreen.test.tsx
- Modify: apps/mobile-native/src/screens/resourceScreens.test.tsx

- [ ] **Step 1: Add red interaction tests**

Cover visible search, backend/status/worker filters, empty state, full reader, Markdown rendering, code copy, expandable tool output, direct/plan sends, quick replies, continuation after completed session, structured user choice submission and refresh merging a new assistant item.

- [ ] **Step 2: Implement local inbox filtering**

Keep fetched sessions as the source of truth. Add compact filters so search/filter/refresh preserve selected session and never need an additional backend list query.

- [ ] **Step 3: Extract typed timeline rendering**

Move card rendering from SessionDetailScreen into TimelineCard and MessageReader. Render Markdown safely, collapse completed raw telemetry, retain running/failed visibility, and pass recognized workspace paths to Files handoff.

- [ ] **Step 4: Extract contextual reply composer**

Keep direct/plan, quick replies, image and voice input in one compact component. Preserve drafts per session and give completed sessions an explicit continuation action. When input is unavailable, explain the capability reason instead of showing inert controls.

- [ ] **Step 5: Verify**

Run: npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx resourceScreens.test.tsx mobileParity.test.tsx --runInBand

Expected: session control scenarios pass.

- [ ] **Step 6: Commit**

Run: git add apps/mobile-native/src/features/sessions apps/mobile-native/src/screens/SessionsScreen.tsx apps/mobile-native/src/screens/SessionDetailScreen.tsx apps/mobile-native/src/screens/SessionDetailScreen.test.tsx apps/mobile-native/src/screens/resourceScreens.test.tsx
Run: git commit -m "feat: complete native session control flow"

### Task 4: Turn Files into a usable remote workspace browser

**Files:**
- Create: apps/mobile-native/src/features/files/FileBreadcrumb.tsx
- Create: apps/mobile-native/src/features/files/FileActionsSheet.tsx
- Create: apps/mobile-native/src/features/files/FilePreview.tsx
- Modify: apps/mobile-native/src/screens/FilesScreen.tsx
- Modify: apps/mobile-native/src/screens/resourceScreens.test.tsx
- Modify: apps/mobile-native/src/screens/nativeImagePicker.ts

- [ ] **Step 1: Add red file workflow tests**

Cover workspace switching, current-tree search, breadcrumb navigation, recent file selection, preview type, text save, create file, create folder, rename and one-file upload. Assert viewer sees no mutation controls.

- [ ] **Step 2: Implement browser state**

Represent selected session, directory, query, recent paths and preview in feature-local state. Bound large files to transfer/download; use declared preview capability for text, Markdown, image, audio and video.

- [ ] **Step 3: Implement mutation action sheet**

Create/folder/rename/upload submit typed worker jobs, expose queued/running/failed state, and refresh only the affected directory when complete.

- [ ] **Step 4: Verify**

Run: npm --workspace @agenthub/mobile-native run test -- resourceScreens.test.tsx mobileParity.test.tsx --runInBand

Expected: browse, preview, edit and mutation tests pass.

- [ ] **Step 5: Commit**

Run: git add apps/mobile-native/src/features/files apps/mobile-native/src/screens/FilesScreen.tsx apps/mobile-native/src/screens/resourceScreens.test.tsx apps/mobile-native/src/screens/nativeImagePicker.ts
Run: git commit -m "feat: complete native remote workspace controls"

### Task 5: Make task review and worker readiness useful on a phone

**Files:**
- Create: apps/mobile-native/src/features/tasks/TaskArtifactList.tsx
- Create: apps/mobile-native/src/features/workers/WorkerDetailSheet.tsx
- Modify: apps/mobile-native/src/screens/TasksScreen.tsx
- Modify: apps/mobile-native/src/screens/WorkersScreen.tsx
- Modify: apps/mobile-native/src/screens/resourceScreens.test.tsx

- [ ] **Step 1: Add red tests**

Cover task search/status filter, Markdown brief/criteria, artifact-to-Files handoff, accept/reject/request-changes/archive/restore role gating, worker details, workspace roots and unavailable backend explanation.

- [ ] **Step 2: Implement task review surface**

Render task information and artifacts using the same reader primitives; preserve role gate and route every review mutation through reviewTask.

- [ ] **Step 3: Implement worker detail sheet**

Open worker details from a card and show heartbeat, OS, backends, workspace roots and provider/runtime capability messages instead of unreadable badge-only data.

- [ ] **Step 4: Verify and commit**

Run: npm --workspace @agenthub/mobile-native run test -- resourceScreens.test.tsx mobileParity.test.tsx --runInBand
Run: git add apps/mobile-native/src/features/tasks apps/mobile-native/src/features/workers apps/mobile-native/src/screens/TasksScreen.tsx apps/mobile-native/src/screens/WorkersScreen.tsx apps/mobile-native/src/screens/resourceScreens.test.tsx
Run: git commit -m "feat: add native task review and worker details"

### Task 6: Replace My with notification inbox and real settings

**Files:**
- Create: apps/mobile-native/src/features/notifications/NotificationInbox.tsx
- Create: apps/mobile-native/src/features/settings/SettingsScreen.tsx
- Create: apps/mobile-native/src/features/settings/SettingsScreen.test.tsx
- Modify: apps/mobile-native/src/navigation/MainTabs.tsx
- Modify: apps/mobile-native/src/App.tsx
- Modify: apps/mobile-native/src/notifications/notificationLedger.test.ts

- [ ] **Step 1: Add red notification/settings tests**

Cover notification grouping/count, read/dismiss, deep linking to session/task, version display, latest-release action, server display/change confirmation, notification permission state and server-backed theme preference.

- [ ] **Step 2: Implement notification inbox**

List notification records, mark a notification read only once it is opened, let users dismiss stale records, and route notification targets through MainTabs state.

- [ ] **Step 3: Implement SettingsScreen**

Show account/space/server/app version, notification state, appearance control, release action and safe server switch. The update action opens the GitHub latest native APK release; it must not claim in-place Android package replacement.

- [ ] **Step 4: Verify and commit**

Run: npm --workspace @agenthub/mobile-native run test -- notificationLedger.test.ts SettingsScreen.test.tsx mobileParity.test.tsx --runInBand
Run: git add apps/mobile-native/src/features/notifications apps/mobile-native/src/features/settings apps/mobile-native/src/navigation/MainTabs.tsx apps/mobile-native/src/App.tsx apps/mobile-native/src/notifications/notificationLedger.test.ts
Run: git commit -m "feat: add native notification inbox and settings"

### Task 7: Verify visual safety and release the APK

**Files:**
- Modify: apps/mobile-native/src/ui/theme.ts
- Modify: apps/mobile-native/README.md
- Modify: docs/TESTING.md
- Create: docs/releases/1.0.2-native-mobile-console.md

- [ ] **Step 1: Add narrow-viewport tests**

Verify bottom tab safety, one scrolling region per screen, composer clearance and action-sheet accessibility labels.

- [ ] **Step 2: Tune native design tokens only after behavior tests pass**

Keep the existing light direction, standardize canvas/surface/border/disabled/semantic colors and spacing, and ensure selected state never becomes unreadable white.

- [ ] **Step 3: Run complete release gates**

Run: npm run mobile:native:test
Run: npm run mobile:native:typecheck
Run: npm run mobile:native:build:android:release
Run: git diff --check

Expected: all gates pass, an Android release APK exists and diff check emits no errors.

- [ ] **Step 4: Perform emulator smoke**

Verify session search, full reader, direct/plan reply, structured approval, workspace preview/edit, task review, worker detail, notification routing and settings/update action. Record sanitized results in docs/releases/1.0.2-native-mobile-console.md.

- [ ] **Step 5: Commit evidence**

Run: git add apps/mobile-native/src/ui/theme.ts apps/mobile-native/README.md docs/TESTING.md docs/releases/1.0.2-native-mobile-console.md
Run: git commit -m "test: verify native mobile complete console"

## Plan Self-Review

- Every end-user control loop in the V2 design has an implementation task and a focused test.
- All mutations map to existing scoped server endpoints; no arbitrary file or shell access is introduced.
- In-app APK replacement and desktop-density administration remain intentionally out of scope, while phone-first control loops are complete.
