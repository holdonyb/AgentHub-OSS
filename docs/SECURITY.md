# AgentHub Security Model

AgentHub is designed as a private control plane that may have a public Web/API entry through frpc, but should still be operated as Tailscale-first infrastructure.

## Roles

| Role | Permissions |
| --- | --- |
| `viewer` | Read sessions, jobs, events, memory, and worker status |
| `operator` | Viewer permissions plus session input, permission responses, allowed job creation, and memory writes |
| `admin` | Operator permissions plus worker management and invites |
| `owner` | Admin permissions plus owner bootstrap, user/token control, and dangerous operations |
| worker token | Worker APIs only: private `/api/internal/*` or public relay `/api/worker/*`, always bound to one `space_id + worker_id` |

## Auth

- First startup uses `AGENTHUB_BOOTSTRAP_TOKEN` to create the first `owner`.
- Passwords are stored with Argon2id via `argon2-cffi`.
- Web sessions use `agenthub_session`, an httpOnly cookie.
- Cookie-auth mutations require `X-CSRF-Token`, matching the session's stored token hash.
- Personal access tokens are returned once and stored only as SHA-256 hashes.
- Worker tokens are stored only as hashes and are bound to `space_id + worker_id`.
- Public relay enrollment tokens are stored only as hashes, expire, and are scoped to one `space_id`.
- API secrets are encrypted at rest with `AGENTHUB_SECRET_ENCRYPTION_KEY`; Web clients receive metadata only, and workers can resolve only explicitly referenced secret names for their own space.

## Public Exposure Rules

frpc may expose only the reverse-proxied HTTPS Web/API entry.

Do not expose:

- SQLite/PostgreSQL ports
- worker internal-only ports
- legacy worker registration or heartbeat endpoints on public HTTPS
- SSH/RDP
- direct Uvicorn without HTTPS reverse proxy

The reverse proxy must set:

- HTTPS only
- HSTS
- request body size limits
- rate limits for login, token, and job paths
- forwarded headers
- access logs

## Threat Controls

| Threat | Control |
| --- | --- |
| Public login brute force | rate limit, audit events |
| Stolen user token | hash at rest, revoke API, audit |
| Stolen worker token | worker-only scope, worker_id binding |
| Leaked API secret | encrypted storage, metadata-only Web API, worker-scoped resolve endpoint |
| Cross-tenant worker access | worker token bound to `space_id + worker_id`, all resource queries filtered by active space |
| CSRF on Web actions | SameSite cookie plus CSRF header |
| XSS in transcript | React text rendering, no raw HTML |
| Prompt/job injection | no arbitrary shell job, white-listed job kinds |
| Worker impersonation | per-worker token plus space-scoped enrollment token |
| Permission spoofing | permission request/resolve endpoints require worker token and worker/session binding |
| Replay completion | job must be `running` and worker-bound |
| Offline worker routing | offline worker claim returns no job |
| frpc overexposure | reverse proxy only, documented allowlist |

## Android APK

The v1 APK is a thin WebView wrapper for your configured AgentHub HTTPS console, for example `https://agenthub.example.com`.
It must not embed API keys, worker tokens, bootstrap tokens, or user credentials.

The APK can be hosted publicly because it contains only the console URL, but it should be treated as a convenience build:

- access is still controlled by AgentHub login
- publish a SHA-256 checksum when sharing the file
- keep one stable AgentHub upload key so Android can upgrade the app without uninstalling
- keep `.jks`, `.keystore`, and signing passwords out of git; use local environment variables or GitHub Actions secrets
- rotate the owner password if it is ever shared outside the trusted admin channel

## Current Limits

- Rate limiting is in-memory. Use proxy-level rate limits in production.
- SQLite is the default. Use PostgreSQL before multi-user or high-concurrency operation.
- Transcript storage is not end-to-end encrypted.
- Fine-grained per-project ACL is not implemented.
- Public relay is still polling-first. Long-lived relay transport is a later step.
