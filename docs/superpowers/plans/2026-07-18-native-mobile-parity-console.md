# Native Mobile Parity Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the React Native AgentHub app up to parity for the core mobile session-control loop: searchable inbox, richer session detail, full reader with Markdown, reply modes plus quick replies, structured tool cards, and session-to-files handoff.

**Architecture:** Keep the current native app as a real React Native surface, not a WebView clone. Add native-specific presentation helpers around the existing API contract, and only extract shared parsing into shared modules when it is platform-agnostic.

**Tech Stack:** React Native, Expo, TypeScript, Jest, react-test-renderer, existing AgentHub mobile-native API layer.

---

### Task 1: Lock the Spec and Surface Map

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-native-mobile-parity-console-design.md`
- Create: `docs/superpowers/plans/2026-07-18-native-mobile-parity-console.md`
- Inspect: `apps/mobile-native/src/screens/SessionsScreen.tsx`
- Inspect: `apps/mobile-native/src/screens/SessionDetailScreen.tsx`
- Inspect: `apps/mobile-native/src/screens/FilesScreen.tsx`

- [ ] **Step 1: Re-read the native screen entry points before changing tests**

Run: `rg -n "export function (SessionsScreen|SessionDetailScreen|FilesScreen)" apps/mobile-native/src/screens`
Expected: one match per screen so the implementation starts from the real entry points

- [ ] **Step 2: Confirm the current worktree baseline is clean**

Run: `git status --short --branch`
Expected: `## feature/native-mobile-parity-console...origin/main`

- [ ] **Step 3: Keep the spec and plan aligned with the selected scope**

Run: `rg -n "searchable inbox|full reader|reply mode|quick replies|tool output|file references" docs/superpowers/specs/2026-07-18-native-mobile-parity-console-design.md`
Expected: all core scope items present before code starts

### Task 2: Write Failing Inbox Search Tests

**Files:**
- Modify: `apps/mobile-native/src/screens/resourceScreens.test.tsx`
- Modify: `apps/mobile-native/src/screens/SessionsScreen.tsx`

- [ ] **Step 1: Add a failing test for native session search**

Add a test that renders `SessionsScreen` with multiple sessions, types into a new `搜索会话` field, and expects non-matching cards to disappear while the zero-match empty state appears when appropriate.

- [ ] **Step 2: Run only the new native resource screen test and watch it fail**

Run: `npm --workspace @agenthub/mobile-native run test -- resourceScreens.test.tsx --runInBand`
Expected: FAIL because `SessionsScreen` does not yet render a searchable input or filter list rows

- [ ] **Step 3: Implement the minimal search UI and local filtering**

Update `SessionsScreen.tsx` to:
- add a controlled `TextInput` with accessibility label `搜索会话`
- filter the in-memory session list by title, backend, worker, project, workspace, summary, and last message
- distinguish "no sessions yet" from "no search matches"

- [ ] **Step 4: Re-run the same test until it passes**

Run: `npm --workspace @agenthub/mobile-native run test -- resourceScreens.test.tsx --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/mobile-native/src/screens/resourceScreens.test.tsx apps/mobile-native/src/screens/SessionsScreen.tsx
git commit -m "feat: add native session inbox search"
```

### Task 3: Write Failing Full Reader and Markdown Tests

**Files:**
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.test.tsx`
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.tsx`
- Create or modify: `apps/mobile-native/src/screens/sessionTimelinePresentation.ts`

- [ ] **Step 1: Add failing tests for full reader actions**

Add tests that:
- open `全文阅读` from a long assistant message
- verify `复制全文` is exposed
- verify a `Markdown` tab appears only when the content is Markdown-like
- verify tool-only content does not show Markdown mode

- [ ] **Step 2: Run the detail-screen test file and watch the new assertions fail**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: FAIL because the current detail screen has no full reader and no Markdown gating

- [ ] **Step 3: Implement a native full-reader modal and Markdown detection helper**

Add a helper module for:
- truncation thresholds
- Markdown detection
- reader mode eligibility

Then update `SessionDetailScreen.tsx` so long messages expose:
- `展开全文`
- `复制全文`
- `全文阅读`

and the modal exposes:
- `原文`
- `Markdown` when allowed
- close control

- [ ] **Step 4: Re-run the detail-screen tests**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/mobile-native/src/screens/SessionDetailScreen.test.tsx apps/mobile-native/src/screens/SessionDetailScreen.tsx apps/mobile-native/src/screens/sessionTimelinePresentation.ts
git commit -m "feat: add native full reader and markdown preview"
```

### Task 4: Write Failing Composer Mode and Quick Reply Tests

**Files:**
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.test.tsx`
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.tsx`
- Modify: `apps/mobile-native/src/api/mobileApi.ts`

- [ ] **Step 1: Add tests that assert reply mode and quick replies affect the send payload**

The tests should cover:
- switching to `计划`
- tapping a quick reply chip
- sending with `reply_mode: "plan"`

- [ ] **Step 2: Run the detail tests and confirm the new cases fail**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: FAIL because the current composer has no reply-mode controls or quick replies

- [ ] **Step 3: Implement native composer parity**

Update `SessionDetailScreen.tsx` to add:
- compact reply-mode chips
- quick reply chips
- clear disabled-state logic

Ensure `sendSessionInput()` sends the selected `reply_mode`.

- [ ] **Step 4: Re-run the detail tests**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/mobile-native/src/screens/SessionDetailScreen.test.tsx apps/mobile-native/src/screens/SessionDetailScreen.tsx apps/mobile-native/src/api/mobileApi.ts
git commit -m "feat: add native composer reply modes"
```

### Task 5: Write Failing Structured Tool Card Tests

**Files:**
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.test.tsx`
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.tsx`
- Create or modify: `apps/mobile-native/src/screens/sessionTimelinePresentation.ts`

- [ ] **Step 1: Add failing tests for tool cards and collapsed metadata**

Add tests that render a `tool_call` timeline item and assert:
- a typed `工具` card appears
- running state is visible inline
- completed metadata is hidden until expand

- [ ] **Step 2: Run the detail tests and confirm failure**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: FAIL because tool items are still rendered as flat text

- [ ] **Step 3: Implement typed timeline rendering**

Add timeline presentation helpers and update `SessionDetailScreen.tsx` so:
- user/assistant/tool/error cards have distinct rendering
- tool payload details can be expanded/collapsed
- timeline text remains selectable where useful

- [ ] **Step 4: Re-run the detail tests**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/mobile-native/src/screens/SessionDetailScreen.test.tsx apps/mobile-native/src/screens/SessionDetailScreen.tsx apps/mobile-native/src/screens/sessionTimelinePresentation.ts
git commit -m "feat: add typed native timeline cards"
```

### Task 6: Write Failing Session-to-Files Handoff Tests

**Files:**
- Modify: `apps/mobile-native/src/screens/resourceScreens.test.tsx`
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.tsx`
- Modify: `apps/mobile-native/src/screens/FilesScreen.tsx`
- Modify: `apps/mobile-native/src/App.tsx` or the native navigation container entry if that owns tab handoff state

- [ ] **Step 1: Add a failing test for opening a workspace path from session output**

The test should assert that tapping a recognized local file link from session detail routes to the Files workspace and opens the preview path.

- [ ] **Step 2: Run the native resource-screen tests and confirm failure**

Run: `npm --workspace @agenthub/mobile-native run test -- resourceScreens.test.tsx --runInBand`
Expected: FAIL because session output currently has no file-link handoff

- [ ] **Step 3: Implement the handoff state**

Update the native app so a recognized local workspace path from the session view can:
- select the Files tab
- pass the target file path
- open preview/editor on arrival

- [ ] **Step 4: Re-run the resource-screen tests**

Run: `npm --workspace @agenthub/mobile-native run test -- resourceScreens.test.tsx --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/mobile-native/src/screens/resourceScreens.test.tsx apps/mobile-native/src/screens/SessionDetailScreen.tsx apps/mobile-native/src/screens/FilesScreen.tsx apps/mobile-native/src/App.tsx
git commit -m "feat: open workspace files from native session output"
```

### Task 7: Refresh Correctness and Regression Pass

**Files:**
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.test.tsx`
- Modify: `apps/mobile-native/src/screens/SessionDetailScreen.tsx`

- [ ] **Step 1: Add a failing regression test for completed assistant content appearing after detail refresh**

The test should model a session whose job status and latest timeline update arrive after the initial render, and verify the user does not need to leave the screen.

- [ ] **Step 2: Run the detail tests and confirm the new case fails**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: FAIL because the current screen can require re-entry to fully reflect updated content

- [ ] **Step 3: Tighten the detail refresh reconciliation logic**

Update `SessionDetailScreen.tsx` so:
- reload merges updated timeline items reliably
- scroll-to-bottom behavior is conditional and not destructive
- newer assistant messages are visible after refresh

- [ ] **Step 4: Re-run the detail tests**

Run: `npm --workspace @agenthub/mobile-native run test -- SessionDetailScreen.test.tsx --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/mobile-native/src/screens/SessionDetailScreen.test.tsx apps/mobile-native/src/screens/SessionDetailScreen.tsx
git commit -m "fix: reconcile native detail refresh updates"
```

### Task 8: Full Validation and Build Confidence

**Files:**
- Inspect only unless fixes are needed

- [ ] **Step 1: Run the full native test suite**

Run: `npm run mobile-native:test`
Expected: PASS

- [ ] **Step 2: Run native type checking**

Run: `npm run mobile-native:typecheck`
Expected: PASS

- [ ] **Step 3: Run Web tests if shared helpers changed**

Run: `npm run web:test`
Expected: PASS or not needed if native-only code changed

- [ ] **Step 4: Run a native Android debug build**

Run: `npm run mobile-native:build:android:debug`
Expected: successful debug APK build

- [ ] **Step 5: Check whitespace and patch hygiene**

Run: `git diff --check`
Expected: no output

- [ ] **Step 6: Commit any final validation fixes**

Run:
```bash
git add -A
git commit -m "test: validate native mobile parity console"
```
