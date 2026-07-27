# Quiet Cockpit Implementation Plan

1. Add interaction tests for collapsed session filters and the overview/control inspector switch.
2. Add desktop-only style contract tests for dense rows, hover actions, constrained transcript width, and focused composer disclosure.
3. Introduce local UI state for session filter disclosure and inspector mode; keep mobile behavior unchanged.
4. Move secondary session actions into a desktop overflow menu while retaining the existing mobile menu.
5. Group the existing control panels into the inspector control view without changing their forms or API handlers.
6. Add desktop-scoped CSS for compact chrome, list rows, document-style messages, contextual inspector panels, and composer focus states.
7. Run focused tests, then the full Web test and production build.
8. Verify desktop and phone viewports with browser screenshots, fix visual regressions, and run `git diff --check`.
9. Commit only the scoped files, push the feature branch, open a PR, and deploy after CI passes.
