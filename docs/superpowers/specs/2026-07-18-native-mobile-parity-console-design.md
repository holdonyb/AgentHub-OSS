# Native Mobile Parity Console Design

## Goal

Bring the React Native AgentHub client from a basic inbox/detail shell to a real mobile console that covers the high-frequency session workflows already available on Web.

The first-class mobile user must be able to search sessions, inspect long messages safely, switch between plain text and Markdown when appropriate, use reply modes and quick replies, understand structured tool and approval output, and jump from session output into the remote file workspace without leaving the app in a broken state.

## Product boundary

This is not a wholesale Web-to-native port.

The native client keeps its current strengths:

- fast startup
- native navigation and gesture behavior
- native notifications
- lightweight session/file control from the phone

The native client does not try to mirror every Web settings panel, every admin affordance, or every desktop-density control. It must, however, stop dropping core conversation capabilities that users already rely on in Web.

## Problem statement

The current React Native surface has three structural gaps:

1. `SessionsScreen` is a thin list with no search or fast narrowing, which makes the inbox unusable once the account has real history.
2. `SessionDetailScreen` renders every timeline item as plain text, so long answers, Markdown output, tool output, and structured approval prompts lose both meaning and usability.
3. The composer is reduced to text/image/voice send, while the Web client already exposes reply modes, quick replies, and richer context for what kind of reply will be sent.

This mismatch makes the native app feel fast but incomplete. The missing pieces are not optional polish. They are part of the real session control loop.

## Recommended approach

Use a shared capability and rendering contract, but implement native-first presentation.

That means:

- reuse protocol and parsing logic where the semantics are shared
- keep rendering and interaction native to React Native
- move repeated message interpretation helpers into shared or native-local presentation modules rather than copying chunks from the Web monolith

This is preferable to both alternatives:

- embedding more WebView surface would erase the native performance and navigation gains
- directly cloning the Web DOM structure in React Native would create a second monolith that drifts immediately

## Functional scope

### 1. Session inbox parity

Add a native inbox search field that filters by:

- title
- backend
- worker id
- project name
- workspace root
- activity summary
- last message

The list remains card-based, but filtering must be instant and local on the fetched dataset. Empty and zero-match states must be explicit.

### 2. Session detail message actions

Each timeline row gains explicit actions based on content:

- expand full text
- copy full text
- open a full reader

The full reader is a real native modal, not just a larger inline block. It supports:

- original text tab
- Markdown tab when the content is detected as Markdown-capable
- scrollable long content
- copy

Tool-only rows and approval rows must not expose fake Markdown tabs.

### 3. Structured timeline cards

Timeline rendering is upgraded from a single plain text card to typed cards:

- user message
- assistant message
- tool call
- reasoning
- goal
- todo
- error
- compaction

The important rule is information hierarchy:

- user and assistant text stay readable first
- tool metadata is collapsed by default once completed
- running/failed tool state stays obvious
- approval and question cards remain interactive and do not get flattened into transcript noise

This is the core lesson to borrow from `opencode-ios-client`: typed content should render as typed content, not be collapsed into one text blob.

### 4. Native composer parity

The composer must support the same high-frequency controls users already use on Web:

- reply mode: `direct` / `plan`
- voice mode indicator where relevant
- quick replies
- better disabled-state reasoning

Native presentation should stay compact:

- a small mode strip above the input
- horizontally scrollable quick reply chips
- no giant two-row command wall

The selected reply mode is sent through the existing `reply_mode` field instead of inventing a second protocol.

### 5. File and workspace deep-linking

When a session message or full-reader view contains a local workspace file reference, the native app should be able to hand that path to the existing Files workspace and open the preview/editor path instead of leaving it as dead text.

This only applies to safe local-path references that resolve within the worker workspace model already supported by AgentHub. External URLs keep normal link behavior.

### 6. Sync and refresh correctness

Native session detail should not require the user to leave and re-enter the conversation to see the final assistant message.

For this slice:

- keep current polling/reload behavior
- add an explicit detail-view refresh reconciliation path
- make scroll-to-bottom conditional so refresh does not feel broken

This is not a full transport rewrite. It is a correctness pass on the existing mobile sync loop.

## Information architecture

### Inbox

```text
header
search
optional backend/status chips
session cards
```

### Detail

```text
header
session meta
permissions
timeline
sticky composer
```

### Full reader

```text
title
actions
original / markdown tabs when valid
scrolling content
```

### Files handoff

```text
session detail or full reader -> open file path -> Files workspace preview/editor
```

## Data and interface changes

Prefer no new backend API for the first pass.

The existing native API already carries enough surface for:

- session summaries
- timeline items
- permissions
- jobs
- file read/list/write
- reply mode on send

The first-pass implementation should therefore be client-heavy:

- add native presentation helpers for message kind, Markdown detection, truncation, and link extraction
- only introduce shared helpers in `packages/client-core` if both Web and native can use them without DOM coupling

## Testing strategy

Follow TDD and cover behavior where the regression risk is real:

- `SessionsScreen` search and empty-state transitions
- `SessionDetailScreen` full reader and Markdown gating
- quick reply and reply mode send payloads
- tool card collapsed/expanded behavior
- file deep-link handoff into `FilesScreen`
- detail refresh showing newly completed assistant content without leaving the screen

Validation must include:

- `npm run mobile-native:test`
- `npm run mobile-native:typecheck`
- targeted `web:test` only if shared helpers change

If Android build time is acceptable after code is green, also run:

- `npm run mobile-native:build:android:debug`

## Non-goals for this slice

- full desktop/workbench parity inside native
- native source-control UI
- arbitrary code editing across the whole project tree
- replacing the current server notification pipeline
- reproducing every Web settings section in native
- iPad-specific three-column redesign beyond preserving responsive behavior

## Acceptance

- Native inbox can search real historical sessions quickly.
- Long assistant messages can be copied and opened in a full reader.
- Markdown content renders in a dedicated reader tab when valid.
- Tool output no longer appears only as flattened text.
- The composer exposes reply mode and quick replies, and sends the correct payload.
- Local workspace file references can open the Files workspace instead of staying dead text.
- A completed reply appears in detail after refresh/sync without forcing the user back to the inbox.
