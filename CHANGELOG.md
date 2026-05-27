# Changelog

## Unreleased

## v0.1.1 - 2026-05-27

- Added the public root-domain website, nginx deployment template, and deployment script for `myagenthub.dev`, `www`, `docs`, and `app`.
- Promoted the self-host smoke flow from raw IP precheck to live `canary.myagenthub.dev` HTTPS verification with worker bundle checks.
- Hardened the Ubuntu self-host installer by skipping unnecessary Electron and Playwright binary downloads during server-only installs.
- Documented the Windows worker fallback path for hosts that already have real session data but only expose `uv`, not a usable `python` or `py` launcher.
- Fixed the Android native clipboard web test to wait for the asynchronous copied state before asserting the success label.

## v0.1.0 - 2026-05-24

- First public OSS release of AgentHub.
- Added Android first-launch server setup before login.
- Added Windows desktop client packaging and worker bundles for self-host installs.
- Added architecture diagrams, self-host onboarding, and Tailscale/private-mode docs.
