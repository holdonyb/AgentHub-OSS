# Message Fulltext Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let AgentHub users read and copy complete long messages while keeping the default mobile transcript compact.

**Architecture:** Keep the default transcript folded in the Web UI, add per-message actions for expand/copy/fullscreen reading, and make the worker publish longer user/assistant/reasoning text while keeping tool/error payloads bounded. Mark still-truncated text explicitly so users know when the UI is not showing the full source.

**Tech Stack:** React + TypeScript + Vitest for Web, Python worker runtime + pytest for worker publish trimming.

---

### Task 1: Web Message Actions

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing Web test**

Add a test that renders a long assistant message and verifies:
- default transcript shows a compact preview;
- clicking `展开全文` reveals the full text;
- clicking `复制全文` writes the original full text to `navigator.clipboard`;
- clicking `全文阅读` opens a dialog with the full text;
- a message ending with worker truncation marker shows `内容已截断`.

Run: `npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "long transcript messages"`
Expected: FAIL because copy/fullscreen/truncation actions are not implemented.

- [ ] **Step 2: Implement minimal UI behavior**

Update `TimelineText` to keep local `expanded`, `copied`, and `viewerOpen` state. Render actions only when text is non-empty. Preserve escaped text rendering via normal React text nodes. Use `navigator.clipboard.writeText(value)` when available, and show a short `已复制` state after success. Add a `role="dialog"` fullscreen reader with close button.

- [ ] **Step 3: Verify Web test passes**

Run: `npm --workspace @agenthub/web run test -- --run src/App.test.tsx -t "long transcript messages"`
Expected: PASS.

### Task 2: Worker Publish Limits

**Files:**
- Modify: `workers/shared/agenthub_worker/runtime.py`
- Test: `apps/api/tests/test_worker_runtime.py`

- [ ] **Step 1: Write the failing worker test**

Add a test proving user/assistant/reasoning timeline text keeps more than 1200 characters, while tool calls stay bounded and truncated with a visible marker.

Run: `npm run api:test -- apps/api/tests/test_worker_runtime.py -q`
Expected: FAIL because all timeline item text is currently capped at 1200.

- [ ] **Step 2: Implement typed truncation**

Introduce `MAX_CONVERSATION_MESSAGE_CHARS = 20000`, `MAX_TOOL_MESSAGE_CHARS = 1200`, and `TRUNCATION_MARKER = "\n\n[AgentHub truncated this item]"`. Use the larger cap for `user_message`, `assistant_message`, and `reasoning`; keep tool/error/todo/compaction at the smaller cap. Preserve the existing discovery payload byte cap.

- [ ] **Step 3: Verify worker tests pass**

Run: `npm run api:test -- apps/api/tests/test_worker_runtime.py -q`
Expected: PASS.

### Task 3: Full Verification and Shipping

**Files:**
- No additional production files.

- [ ] **Step 1: Run focused and full verification**

Run:
- `npm run api:test`
- `npm run web:test`
- `npm run web:build`
- `npm run mobile:test`
- `npm run mobile:build:debug`
- `git diff --check`

- [ ] **Step 2: Commit, PR, CI, deploy**

Commit the feature branch, push it, create a PR, wait for CI, merge, then verify production `/healthz` and APK download freshness.

### Self-Review

- Spec coverage: covers default folding, full read mode, copy, explicit truncation marker, and worker limits.
- Placeholder scan: no TODO/TBD placeholders.
- Type consistency: Web actions stay inside `TimelineText`; worker constants are referenced only by runtime tests and runtime trimming.
