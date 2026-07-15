# Runtime Cockpit Implementation Plan

## Objective

Ship an attention-first cockpit that summarizes every active agent session across workers and opens the existing Session surface without introducing a second runtime or status authority.

## 1. Deterministic State Projection

Files:

- `apps/web/src/runtimeCockpit.ts`
- `apps/web/src/runtimeCockpit.test.ts`

Steps:

1. Add failing tests for attention priority, offline workers, active execution, unseen completion, idle fallback, archived exclusion, and deterministic ordering.
2. Implement a pure projection over `AgentSession`, `Worker`, and pending `AgentPermission` records.
3. Return lane counts, product-facing reason keys, source timestamps, and stable item identity.
4. Run the focused unit test until green.

## 2. Cockpit Product Surface

Files:

- `apps/web/src/RuntimeCockpit.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`

Steps:

1. Add `cockpit` to the persisted application mode.
2. Render lane filters, compact runtime rows, worker/backend/project metadata, reason, and relative activity time.
3. Open the existing Session thread when a runtime row is selected.
4. Preserve Workbench and Session behavior, including attention acknowledgement and timeline refresh.
5. Add interaction tests for mode switching and session selection.

## 3. Responsive Visual System

Files:

- `apps/web/src/styles.css`
- `apps/web/src/styles.test.ts`
- `apps/web/src/mobile-layout.test.ts`

Steps:

1. Add restrained light/dark cockpit surfaces using existing design tokens.
2. Keep lane controls horizontally scrollable on narrow screens without page overflow.
3. Guarantee at least 44px row and control targets.
4. Keep keyboard focus visible and use semantic buttons for every selectable runtime.
5. Add static layout guards for containment and touch sizing.

## 4. Verification And Delivery

Steps:

1. Run focused cockpit tests, full Web tests, and production build.
2. Run Playwright at desktop and `390x844`, checking screenshots for hierarchy, contrast, scrolling, and overlap.
3. Run API, React Native, compatibility Android, desktop, release version, public export audit, and `git diff --check` before merge.
4. Commit by concern, push the feature branch, and open a PR.
5. Merge only after CI is green. Deploy only the merged `main` commit with the safe overlay deployment wrapper and preserved production database.

## Explicit Non-Goals

- Browser terminal or arbitrary shell execution
- Terminal pane management
- Agent-executable socket APIs
- Replacing Session or Workbench
- Parsing transcript prose to infer state when protocol fields are available
