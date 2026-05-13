# Public-Safe Reconstruction Prompt

This file is meant to be shareable publicly.

It does **not** expose private infrastructure, domains, SSH details, secrets, or internal operational assumptions.
It is a clean-room prompt for recreating an equivalent system from scratch.

## Can The Current Repo Be Open-Sourced Directly?

Not cleanly, not yet.

Reasons:

- The project still contains environment-specific defaults, production URLs, and deployment assumptions that should be scrubbed first.
- Some client configs and docs still reference a personal production deployment rather than a neutral public template.
- The packaging and install flow is now usable, but the repo is still organized as a private working monorepo rather than a polished OSS distribution.
- A proper public release should add a license, neutral branding, example configs, demo-safe defaults, and a full secret/config audit.

So the safer public artifact right now is:

- a reconstruction prompt
- architecture notes
- public-safe deployment expectations

## How To Use This File

Give the prompt below to an LLM coding agent or a capable engineering team.

The goal is **not** to clone a private repo.
The goal is to build an original, equivalent system with the same product shape and operational behavior.
This file should drive an implementation that is terminal-operable, deployment-friendly, and explicit about failure modes.

---

## Prompt

You are a senior full-stack engineer.

Build an original, clean-room implementation of a private-to-multi-tenant control plane for remote AI agent sessions across multiple machines.

Do **not** assume access to any private repository.
Do **not** copy proprietary branding, domains, hardcoded production URLs, deployment keys, or environment-specific scripts.
Everything must be configurable and safe to publish.

### Working Style

Build this like a real product that another engineer must operate later from a terminal.

Requirements:

- keep the repo deployable throughout development
- implement in vertical slices rather than disconnected stubs
- use checked-in scripts for repeatable operations
- prefer explicit command surfaces over tribal knowledge
- document exact commands, expected outputs, and failure recovery steps
- keep local-dev workflows and production-deploy workflows separate
- make private-network transport optional rather than architecturally required

### Recommended Delivery Order

Implement in this order unless there is a strong reason to change it:

1. monorepo skeleton, env loading, shared models, and basic API/web boot
2. auth, spaces, RBAC, and database schema boundaries
3. worker registration, worker tokens, worker list, and heartbeat
4. job queue, session records, timeline publishing, and provider snapshots
5. private worker mode end to end
6. Add Worker UI plus one-time enrollment token flow
7. worker bundle build pipeline for Windows and Linux
8. worker installers and persistent service registration
9. public relay mode with strict route separation
10. deploy scripts, smoke tests, and operator docs
11. hardening, test coverage, and OSS cleanup

Each phase should end in a usable checkpoint, not just partially connected code.

### Product Goal

Build a system that lets a user:

- run AI coding agents on multiple worker machines
- view and manage those sessions from a web console
- route jobs to specific workers
- support both private-network workers and public outbound relay workers
- install workers without cloning the full application repo onto every target machine

### Core Product Shape

The system should have these parts:

1. API control plane
2. Web console
3. Worker runtime for Windows
4. Worker runtime for Linux
5. Shared protocol models
6. Deployment assets
7. Installable worker bundles

### Preferred Stack

Use this stack unless there is a strong reason to change it:

- FastAPI for the API
- React + TypeScript for the web console
- Python for worker runtimes
- SQLite for local/dev, PostgreSQL-ready schema design for serious multi-user use

### Terminal And Script Expectations

Assume the recreated project will be operated mainly from terminals.

Requirements:

- Linux and macOS docs should use `bash`
- Windows docs should use `PowerShell`, not `cmd.exe`
- do not mix shell syntaxes within the same install path
- every major workflow should have a checked-in script entrypoint
- scripts should be idempotent when practical
- scripts should fail fast and emit actionable errors
- docs should show exact commands, not vague placeholders

For shell quality:

- bash scripts should use `set -euo pipefail`
- PowerShell scripts should set `$ErrorActionPreference = "Stop"`
- paths with spaces must be quoted correctly
- installers must validate prerequisites before mutating the system

The final project should expose clear command surfaces or equivalent task runners for:

- local API dev
- local web dev
- database bootstrap or migrations
- bundle build
- Windows worker install
- Linux worker install
- deploy
- smoke test
- log inspection or health check

If you use `make`, `just`, `npm scripts`, or Python task runners, keep them thin wrappers over checked-in scripts rather than hiding logic in CI only.

### Primary Use Cases

1. A single user runs a private deployment and controls their own workers.
2. A hosted deployment supports multiple isolated tenants.
3. A worker can connect through a private network.
4. A worker can also connect through a public relay path using outbound HTTPS only.
5. A user can install a worker through a generated one-time command instead of manually cloning the whole repo.

### Non-Negotiable Requirements

#### Multi-Tenant Isolation

Implement `spaces` as the main isolation boundary.

Requirements:

- users can belong to one or more spaces
- every user-facing query is filtered by active `space_id`
- workers, sessions, jobs, permissions, timeline items, events, providers, memories, schedules, tokens, and invites are space-scoped
- worker tokens are bound to `space_id + worker_id`
- enrollment tokens are short-lived and scoped to one space

#### Worker Connection Modes

Support two worker modes:

- `private`
- `public_relay`

Private mode:

- worker talks to a private API URL
- internal worker routes can remain private

Public relay mode:

- worker only makes outbound HTTPS requests
- public worker endpoints live under a dedicated namespace such as `/api/worker/*`
- internal worker endpoints such as `/api/internal/*` must stay blocked from the public edge

#### Worker Install UX

The system must provide an Add Worker flow that:

- selects OS: Windows or Linux
- selects connection mode: private or public relay
- generates a one-time enrollment token
- produces a copyable install command
- installs from a downloadable worker bundle
- does not require cloning the full repo on the target worker machine

Windows install requirements:

- downloadable ZIP bundle
- bootstrap once
- persist worker token locally
- register a Scheduled Task
- support startup at boot

Linux install requirements:

- downloadable tarball bundle
- bootstrap once
- persist worker token locally
- render a systemd unit
- enable the service

The installer flows must also document the exact terminal commands an operator will run.

Examples of the operator experience you should support:

- copy a one-line PowerShell install command from the web UI and run it on Windows
- copy a one-line shell install command from the web UI and run it on Linux
- inspect whether enrollment succeeded without reading source code
- restart or repair the worker service without reinstalling everything

#### Session Model

The control plane should manage agent sessions with:

- canonical session rows
- timeline items
- provider snapshots
- permission requests and responses
- job queue for starting sessions, replying, forking, provider auth tasks, and discovery tasks

The worker runtime should be able to:

- poll for jobs
- publish discovered sessions
- publish timelines
- publish provider capability snapshots
- request permissions
- resolve permissions

### Backends

Support the concept of multiple local agent providers, at minimum:

- Codex
- Claude
- Kimi

Requirements:

- discover whether each provider exists on the worker
- report auth state and capabilities
- store provider snapshots in the control plane
- allow the UI to target a worker/backend pair when starting or continuing a session

### Security Requirements

Implement:

- password hashing with Argon2id
- cookie auth for browser sessions
- CSRF protection for cookie-auth mutations
- hashed personal access tokens
- hashed worker tokens
- hashed enrollment tokens
- role-based access control
- audit events for sensitive actions
- rate limiting for login and mutation-heavy routes

Do not:

- expose internal worker APIs publicly
- embed secrets in desktop/mobile/web clients
- hardcode production domains
- assume direct shell job execution from untrusted users

Treat worker enrollment and heartbeat as security-sensitive control paths, not convenience endpoints.

### Required API Surface

You do not need to use these exact routes, but the product should support equivalent behavior:

- auth bootstrap/login/session
- worker list/register/enrollment
- worker public relay enroll/heartbeat/claim/complete/fail
- session create/list/get/input/fork/rename/update controls
- timeline publish/list
- permissions request/list/respond/get
- provider snapshot publish/list
- job queue create/list/claim/complete/fail
- event list
- memory write/query
- schedule create/list/update/delete

### Required Frontend Features

Web console should support:

- login
- session inbox
- session detail timeline
- reply box with direct reply and plan mode
- worker list
- Add Worker dialog
- provider status view
- permission approval UI
- job/event visibility

The Add Worker dialog must generate commands that:

- download the worker bundle from the deployment
- install the worker
- use an enrollment token
- configure workspace roots and optional session roots

### Deployment Requirements

Include checked-in deploy assets instead of doc-only snippets:

- nginx public template
- nginx private or loopback listener template
- systemd API unit template
- systemd Linux worker unit template
- optional frpc example config

Provide a deploy script that:

- updates the target branch
- installs API dependencies
- installs Node dependencies
- builds the web app
- builds worker bundles
- copies downloads into the web-served directory
- validates nginx
- restarts services
- runs health checks
- optionally runs public smoke checks

Also provide operator-facing docs for:

- first deploy
- upgrade deploy
- rollback strategy
- rebuilding worker bundles after code changes
- rotating enrollment or worker tokens
- validating public relay connectivity

### Bundle Requirements

Build downloadable worker bundles that contain only what the worker needs:

- shared protocol models
- shared worker runtime code
- OS-specific worker entrypoint
- OS-specific installer
- minimal Python requirements

Do not ship:

- personal configs
- secrets
- unrelated monorepo applications
- cached bytecode if avoidable

### Testing Requirements

Include tests for:

- tenant isolation
- worker enrollment
- public relay authorization
- worker bootstrap and token persistence
- session discovery path handling
- generated install commands in the web UI
- deploy workflow references
- worker bundle generation

Also test at least one operator path end to end:

- generate install command
- install worker from bundle
- worker enrolls
- worker heartbeats
- worker appears online in the UI

### Open-Source Readiness Requirements

Make the recreated project public-safe by default:

- use neutral example domains like `agenthub.example.com`
- keep all real infra values in environment variables
- add a proper OSS license
- add `.env.example`
- avoid any personal endpoint in source defaults
- document how to replace branding and domains

### Deliverables

Produce:

1. a working monorepo
2. API server
3. web console
4. Windows worker
5. Linux worker
6. worker bundle builder
7. deploy scripts
8. deployment templates
9. tests
10. documentation

The documentation must include:

- local development quickstart
- production deployment guide
- Windows worker install guide
- Linux worker install guide
- public relay architecture note
- troubleshooting guide
- command reference

### Acceptance Criteria

A build is acceptable only if:

- a fresh deployment can serve the web UI and API
- a Windows worker can be installed from a generated bundle command
- a Linux worker can be installed from a generated bundle command
- both workers can appear online in the UI
- public relay workers can connect without inbound ports on the worker machine
- invalid public enrollment is rejected
- public access to internal worker routes is rejected
- tenant A cannot see tenant B resources
- an operator can follow the docs without guessing hidden terminal steps
- a failed worker install has a documented recovery path
- logs and health endpoints are sufficient to debug first-deploy issues

### Common Pitfalls To Avoid

Design against these failure modes explicitly:

- assuming the worker machine will clone the full monorepo
- mixing private worker routes and public relay routes behind the same trust boundary
- storing raw worker or enrollment tokens instead of hashed forms
- binding Scheduled Task startup to user logon when the intended behavior is boot-time service
- using Windows path assumptions that break on spaces, drive-letter changes, or non-admin shells
- relying on one provider's session file layout as if all agent CLIs behave the same way
- generating install commands that omit where logs, config, and persisted tokens will live
- making installers non-idempotent so reruns corrupt or duplicate state
- skipping bundle versioning so operators cannot tell what is installed
- deploying API changes without publishing matching worker bundles
- coupling public relay to a specific VPN product instead of outbound HTTPS as the core transport
- leaving operators with manual, undocumented recovery steps after enrollment or service failures

### Troubleshooting Expectations

The final docs should contain concrete recovery guidance for at least these cases:

- enrollment token expired
- worker token persisted but server-side registration revoked
- worker cannot reach API
- worker reaches API but never appears online
- provider CLI installed but not detected
- service starts at logon instead of at boot
- bundle built successfully but not downloadable from the deployment
- public relay path works locally but is blocked by proxy, TLS, or reverse-proxy rules

For each case, document:

- the symptom
- the exact terminal command to inspect state
- the likely cause
- the recovery action

### Implementation Style

Be pragmatic, production-minded, and explicit.

- prefer clear schemas
- prefer stable install flow over fancy packaging
- keep domain-specific values configurable
- keep architecture modular enough for later OSS cleanup
- write docs like this will be published

If any requirement conflicts, prioritize:

1. security
2. tenant isolation
3. clean install flow
4. deployability
5. developer convenience

---

## Suggested Share Text

If you want to share this publicly, use a short intro like:

> This is a clean-room reconstruction prompt for building a multi-worker AI control plane with private-network and public-relay workers. It intentionally avoids private repo details and production-specific infrastructure.
