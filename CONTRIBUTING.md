# Contributing

AgentHub is a self-hosted agent control plane. Keep changes small, tested, and explicit about security boundaries.

## Public release scope

The current public support matrix is intentionally conservative:

- Web self-host deployment
- Android APK client
- Windows desktop client
- Windows and Linux worker bundles

Not currently supported as first-party release targets:

- iOS
- macOS

These platforms are welcome as community contributions, but they should land as focused, reviewable PRs with clear build, signing, and configuration boundaries.

## Development

```powershell
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python -m pip install -r apps/api/requirements.txt
npm install
```

Run focused checks before opening a pull request:

```powershell
npm run api:test
npm run web:test
npm run desktop:test
npm run mobile:test
```

If you change release packaging or platform support, also review:

```powershell
Get-Content README.md
Get-Content docs/DEPLOYMENT.md
Get-Content docs/OSS_RELEASE.md
Get-Content .github/workflows/release.yml
```

## Security-sensitive changes

Call out changes that affect auth, worker tokens, enrollment tokens, provider secrets, cookies, CSRF, public relay, or mobile/desktop local storage.

Do not commit local databases, logs, worker token caches, signing keys, `.env`, or generated release artifacts.

## Platform contributions

If you want to add a new client platform, start by keeping the public release model intact:

- server URL must stay configurable
- provider/API keys must stay server-side or in runtime configuration, not hardcoded into the client
- release assets must be documented in `README.md`
- build and release workflow changes must be explicit
- unsupported platform work must not break Web, Android, Windows, or worker bundles

### Suggested prompt for an iOS contribution

Use this as a starting prompt for yourself or another agent:

```text
Add first-party iOS support to AgentHub-OSS without changing the existing self-host product boundary.

Constraints:
- Keep AgentHub self-host first.
- Treat iOS as a thin client for the existing web/API surface, not a new backend product.
- Server URL must be configurable on first launch and overridable for self-host users.
- Do not hardcode any maintainer-specific domain, token, or private infrastructure detail.
- Keep voice optional. If a feature depends on provider credentials, document the configuration path instead of embedding secrets.
- Preserve the current public release matrix: Web, Android, Windows desktop, and worker bundles must keep working.

Deliverables:
- iOS client project and bootstrap instructions
- README and CONTRIBUTING updates
- release workflow updates if iOS artifacts are published
- tests or validation notes for the new client boundary

Before finishing:
- explain signing assumptions
- list which parts remain manual
- confirm what asset name would appear in GitHub Releases
```

### Suggested prompt for a macOS contribution

```text
Add macOS desktop support to AgentHub-OSS as a configurable self-host client, without baking in any maintainer-specific environment.

Constraints:
- Follow the existing desktop client behavior where possible.
- Keep the server URL configurable.
- Do not assume a single hosted domain.
- Do not introduce private deployment scripts or secrets into the public repo.
- Keep release automation readable and narrowly scoped.

Deliverables:
- macOS desktop packaging path
- release asset naming
- README, DEPLOYMENT, and CONTRIBUTING updates
- validation steps for local build and release build

Before finishing:
- describe code-signing expectations
- note what can ship unsigned vs what requires Apple-specific setup
- confirm the change does not regress Windows packaging
```

## Configuration-first rule

When in doubt, prefer a configurable public implementation over a maintainer-specific fork.

Good examples:

- configurable server URL
- configurable voice provider
- configurable release asset naming
- environment-driven signing inputs

Bad examples:

- hardcoded production domains
- hardcoded personal paths
- hardcoded private provider credentials
- a second long-lived code fork just to carry environment-specific defaults
