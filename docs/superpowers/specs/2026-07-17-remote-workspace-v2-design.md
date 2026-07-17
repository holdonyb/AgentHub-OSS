# Remote Workspace v2 Design

## Goal

Turn AgentHub Files into a secure remote work surface that works without SSH and adapts progressively from phone to tablet, foldable, and desktop.

The user must be able to select a worker and workspace, browse files, inspect generated images and documents, make bounded text edits, and save safely without first opening an agent session.

## Product model

Files use this hierarchy:

```text
Worker -> Workspace -> Directory -> File
```

Sessions may deep-link into a file, but a session is not the owner of the file browser. During the compatibility phase, AgentHub may use a representative session on the selected worker/workspace to submit legacy file jobs. This is an implementation detail and must not appear in the UI.

## Adaptive interaction

### Phone and folded cover screen

Use a single navigation stack:

```text
workspace picker -> file list -> preview -> editor/conflict
```

Only one primary surface is visible. Opening a file replaces the list. Back returns to the preserved directory, search query, scroll position, and recent-file state.

### Tablet and unfolded foldable

Use list-detail when sufficient width is available:

```text
workspace/files | preview/editor
```

The detail pane can be empty, previewing, editing, or resolving a conflict. The layout responds to available container width rather than user agent or device model.

### Desktop

Use three progressive regions when width permits:

```text
worker/workspace rail | files | preview/editor
```

Workbench and Session remain separate product modes. Files is a top-level workspace, not a panel inside Session.

## First delivery slice

1. Add an explicit worker and workspace selector to Files.
2. Resolve a compatible session for the selected worker/workspace only at the legacy API boundary.
3. Keep Files state independent from the currently selected chat session.
4. Introduce an explorer/detail view state.
5. Render explorer-only on compact widths and list-detail on regular widths.
6. Keep the existing editor, Markdown, image, audio, video, upload, create, rename, and conflict-safe write behavior.

This slice deliberately preserves the existing job protocol so UI and navigation can ship independently from the data-plane migration.

## Streaming data plane

The target file transport is ephemeral:

1. An authorized user requests a short-lived file ticket for a worker, workspace, path, operation, and byte range.
2. The control plane validates RBAC, workspace ownership, path scope, worker status, size limits, and operation.
3. The worker receives the ticket over its outbound authenticated channel.
4. File bytes stream between worker and client through the relay, or directly when an authenticated direct path exists.
5. SQLite stores ticket metadata, audit state, hashes, and byte counts, never the file body.

The current v2 delivery uses transfer tickets for image, audio, video, download, and upload bodies. Those reads support HTTP-style ranges, while text and Markdown preview/edit continue through bounded legacy file jobs. Text writes use the worker-reported modified time as the conflict token and fail closed when that token is stale.

Thumbnail derivatives and composite revisions derived from size, modified time, and content hash are future hardening. They are not required for the first transfer-ticket rollout.

## Security and privacy

- Resolve every path against a registered workspace root and reject traversal and symlink escape.
- Bind tickets to user, worker, workspace, operation, path, and expiry.
- Make tickets single-use where possible and short-lived in all cases.
- Do not log file bodies or secrets.
- Treat `.env`, credential files, and private-key suffixes covered by the built-in policy as protected files: masked by default, explicit reveal, no timeline persistence. Operator-configurable sensitive globs are a future extension.
- Keep Web/WebView responses private and `no-store`; dedicated native-client temporary caches with TTL and clear controls are future work.
- Enforce preview and upload byte limits plus transfer expiry. A dedicated concurrent-transfer limiter is future operational hardening.
- Remove expired transfer bodies and crash-left partial files through a periodic server maintenance pass; request-time cleanup remains a fallback.

## Compatibility and rollout

- Existing workers continue using file jobs during the compatibility window.
- The Web and Android WebView clients use tickets when the selected worker advertises support and fall back to jobs when it does not.
- File bodies already present in historical jobs are not migrated automatically. A later retention job prunes completed file job payloads/results after a configurable TTL.
- The server and Windows, Linux, and macOS workers negotiate `file_transfer_v2` explicitly. React Native continues using the bounded session-file API until native transfer support is added.

## Acceptance

- A user can open Files before opening any session and select any online worker/workspace they are authorized to use.
- Phone navigation never renders the file list and preview as two long stacked cards.
- Tablet and unfolded foldable render list-detail without duplicating state.
- Browser and Android back return through preview and explorer before leaving the app.
- Unsaved text survives pane changes and background refresh.
- New binary preview, download, and upload bodies avoid Job payloads when `file_transfer_v2` is available. Bounded text and Markdown bodies remain in compatibility jobs and are lazily pruned after their configured TTL.
- Large files are read in bounded chunks and media supports ranges.

## Follow-up hardening

- Generate bounded image thumbnails before fetching full-resolution originals.
- Add composite content revisions for stronger text-edit conflict detection.
- Add `file_transfer_v2` support to the React Native client and native temporary-cache controls.
- Add operator-configurable protected-file globs and explicit concurrent-transfer limits.
