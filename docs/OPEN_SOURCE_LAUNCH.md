# Open Source Launch

This document is the release and launch checklist for the first public AgentHub OSS drop.

## Positioning

Lead with one sentence:

> AgentHub is a self-hosted control plane for managing Codex, Claude, Kimi, and other local agent sessions across your own machines, with phone and desktop access.

Keep the public story anchored in:

- self-hosted
- Tailscale-first
- local machine can be the server
- Docker mode
- phone can control local agent sessions

## Supported surface for v0.1

Official first-party support:

- Web self-host
- Android APK
- Windows desktop
- Windows/Linux/macOS worker bundles

Not first-party in this release:

- iOS
- macOS desktop

README should say this clearly and link to `CONTRIBUTING.md` for platform contribution prompts.

## Release assets

Expected GitHub Release assets:

- `agenthub-android-release.apk`
- `agenthub-desktop-windows-*.zip` or equivalent Windows package
- `agenthub-worker-windows.zip`
- `agenthub-worker-linux.tar.gz`
- `SHA256SUMS`

## Screenshot shot list

Use real product screenshots, not mock data placeholders.

Minimum set:

1. session inbox on desktop Web
2. mobile conversation view on Android
3. worker enrollment / worker status
4. approval or plan interaction UI
5. settings or self-host configuration surface

## Demo video

Keep the first video short. Thirty to sixty seconds is enough.

Suggested script:

1. open AgentHub on your own machine
2. show local or Tailscale server URL
3. open Android app
4. open one session
5. send a reply from phone
6. show worker execution landing back in the session

The goal is proof, not polish.

## Launch channels

Recommended order:

1. GitHub repo + tagged Release
2. X / Chinese developer communities / friend groups
3. Hacker News
4. Product Hunt later, after visuals and install flow are tighter

## README requirements

Homepage must answer four questions immediately:

1. What is AgentHub
2. Who is it for
3. Can I run it without a VM
4. What should I download first

Public release surfaces should stay aligned:

- `README.md` / `README.en.md`
- `https://myagenthub.dev/download/`
- `https://myagenthub.dev/release/`
- `https://myagenthub.dev/press/`
- the current GitHub Release body

Channel-ready wording lives in `docs/LAUNCH_COPY.md`. Treat that file as the source of truth for short post variants, HN seed text, and friend-group copy.

## Short announcement seed

Use this as a base for HN, X, or community posts:

> Open sourced AgentHub. It is a self-hosted control plane for Codex, Claude, Kimi, and other local agent sessions. You can run it on your own machine, through Docker mode, or on a VM, use Tailscale for private access, and control local sessions from Web, Android, or Windows desktop.

Adjust channel tone, but keep the claims narrow and verifiable.
