# Native Mobile Complete Console V2 Design

## Decision

The Android React Native client becomes the phone-first control console for AgentHub. It is not a WebView copy and does not need desktop-density administration, but every common control loop must complete inside the app: find the right session, read and act on its real output, answer an approval, send the correct kind of reply, inspect or edit a workspace file, review an Autopilot task, understand a worker's readiness, and manage device notification and connection settings.

The previous native-parity slice is retained as a foundation, but its narrow acceptance scope is superseded. A control that only exists in a hidden code path, or is present without a discoverable mobile affordance, does not count as parity.

## Product Contract

### Session Inbox

The inbox exposes an always-visible search affordance, status/backend/worker filters, a clear active-filter summary, and a stable empty state. Session cards show meaningful status, worker, project and the most recent actionable context. Search, filters and pull-to-refresh operate on the same data set and never erase the current selection.

### Conversation and Approvals

The detail view uses typed cards rather than a flat transcript. Assistant text, user text, goals, reasoning, tool output, errors, compaction and pending interactions have distinct hierarchy. Long content always has a discoverable full-reader action; Markdown is rendered, code blocks and local file paths are actionable, and raw tool telemetry is collapsed by default.

Reply controls are contextual. Direct/plan selection, quick replies, attachment and voice actions remain available whenever a reply is allowed. A completed session still offers a deliberate continuation action; a non-replyable session explains why instead of rendering inert controls. Pending questions and approvals appear at the point where the user can act, including multi-question selection and optional notes.

### Files

Files are a workspace browser, not a bare root-directory listing. Users can switch workspace, search the current tree, navigate with a breadcrumb, return to recent files, preview Markdown/images/audio/video, and open an editor for safe text files. Operators can create a file or folder, rename, upload one file, and save a text edit. Every remote operation remains scoped to the selected worker and workspace root and displays queued/running/failed completion state.

### Tasks and Workers

Tasks expose their brief, success criteria, execution status and artifacts in a readable mobile detail. Artifacts that point at workspace files hand off to Files. Review, request-changes, archive and restore are available only when the current role permits them. Worker cards expose backend readiness, workspace roots, last heartbeat and the provider/runtime state needed to explain why a selected backend cannot run.

### My, Notifications and Updates

The My tab is a settings surface rather than a logout page: account/space, server, native app version, update availability, notification inbox/permission state, appearance preference and safe server switching are visible. Notifications are recorded as a real inbox, can be marked read/dismissed, and route to the relevant session or task. The app does not pretend to self-update; it opens the correct latest native APK release when a newer version is available.

## Architecture

Keep all data access in apps/mobile-native/src/api/mobileApi.ts and extend it with strongly typed wrappers around existing server endpoints. Screen components are decomposed by feature rather than allowing SessionDetailScreen.tsx, FilesScreen.tsx and TasksScreen.tsx to become catch-all files.

    navigation/MainTabs
      -> features/sessions
      -> features/files
      -> features/tasks
      -> features/notifications
      -> features/settings

The implementation keeps React Native navigation and native notification delivery. It reuses Web semantics and API contracts, but not Web layout or the large App.tsx component.

## Interaction Rules

- Bottom tabs remain 会话, 任务, 文件, 节点 and 我的.
- Each screen owns one scrolling region. Sticky controls live outside it and never cover the last message or file action.
- Secondary information is hidden behind a disclosure or action sheet; primary actions remain visible without horizontal scrolling.
- Native controls use the same labels and API meanings as Web when they represent the same operation.
- viewer remains read-only; unavailable actions are hidden or explained, never sent optimistically.

## Data Boundaries

No worker gets unrestricted filesystem access. File paths are submitted through existing worker- and workspace-scoped endpoints. File previews remain bounded; large assets use the existing transfer/download flow instead of loading whole files into application memory. Secrets remain redacted in previews and are never included in application logs or notification bodies.

## Verification

The V2 acceptance suite covers each end-to-end mobile operation:

1. Find a real session by search and filter, open it, refresh it and see newly arrived content.
2. Read/copy/render a long Markdown answer, expand a tool result and open a referenced workspace file.
3. Send direct and plan replies, use a quick reply, submit an image/voice payload and answer a structured approval.
4. Browse, search, preview, edit, create, rename and upload a workspace file while preserving worker/root scope.
5. Create/review a task and open a task artifact in Files.
6. View worker/provider readiness, read/dismiss a notification and open the affected session.
7. Inspect current version and open the release/update route without exposing credentials.

Release gates are npm run mobile:native:test, npm run mobile:native:typecheck, an Android release build, and Android-emulator smoke across the five tabs.

