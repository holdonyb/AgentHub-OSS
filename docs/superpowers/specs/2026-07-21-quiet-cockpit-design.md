# Quiet Cockpit Desktop Design

## Goal

Make the desktop session console feel like a focused agent work surface instead of an admin dashboard. The transcript is the primary object; navigation and controls remain available without competing with it.

## Principles

1. **One dominant surface.** The selected conversation owns the visual center and the widest column.
2. **Progressive disclosure.** Search, backend filters, bulk actions, advanced controls, voice modes, and quick replies appear when requested or when the composer is active.
3. **Context over configuration.** The right inspector opens on a concise session overview. Runtime and provider configuration live behind a `Controls` view.
4. **Quiet repetition.** Session rows and messages use separators and tonal selection instead of nested cards and permanent action bars.
5. **Mobile stability.** Desktop refinements are scoped above 1100px unless behavior must be shared. The existing native and WebView mobile flows remain intact.

## Desktop Information Architecture

### Top bar

- Keep the product identity, the three primary work modes, create, refresh, notifications, and workspace access.
- De-emphasize sync, role, appearance, and logout controls.
- Use compact icon actions rather than several equal-weight text buttons.

### Session inbox

- Keep the inbox/archive switch and search.
- Collapse provider filters, sorting, and bulk selection behind one `Filter sessions` disclosure.
- Render rows as a dense list with one title, one metadata line, one excerpt, and one status signal.

### Conversation

- Keep title, status, transcript, approvals, and composer in the primary reading path.
- Put fork/archive and other secondary session actions behind an overflow menu.
- Show message copy/full-text actions on hover or keyboard focus.
- Keep tool payloads collapsed by default.

### Composer

- Show mode, text input, attachment, microphone, expand, and send by default.
- Reveal voice configuration and suggested replies while the composer is focused, expanded, recording, or transcribing.
- Keep the compact state visually attached to the transcript without becoming a large control card.

### Inspector

- Default to `Overview`: state, worker, current activity, pending interaction, and local resume.
- `Controls` contains worker runtime, models, permissions, provider status, secrets, health, jobs, schedules, and audit tools.
- `Files` opens the existing remote workspace rather than adding a fourth permanent desktop column.

## Non-goals

- No API or persistence changes.
- No removal of existing controls.
- No redesign of the native React Native client in this change.
- No change to session, job, permission, or notification behavior.

## Acceptance Criteria

- Desktop session filters and advanced inspector controls are collapsed by default and keyboard accessible.
- The transcript has more usable width and fewer permanently visible controls.
- Secondary message and composer controls remain discoverable on focus.
- Existing mobile layout contracts and session workflows continue to pass.
- Desktop light and dark screenshots show no overflow, clipped text, or mixed-theme surfaces.
