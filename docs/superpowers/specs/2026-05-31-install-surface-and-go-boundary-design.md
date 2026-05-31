# AgentHub Install Surface And Go Boundary Design

## Goal

Reduce AgentHub deployment friction without destabilizing the current control plane. The immediate goal is to make worker install and self-host server bootstrap feel like product install flows instead of source-code setup. A secondary goal is to prepare a future Go control plane migration without starting a second implementation too early.

## Problem Statement

Current deployment is technically workable but operationally heavy:

- server setup still exposes Python venv, Node build, nginx, certbot, and config assembly
- worker onboarding still depends on bundle extraction plus Python runtime quirks on Windows and Linux
- there is no single “official install path” for server versus worker versus clients
- future control-plane complexity is increasing, especially around worker relay, queue recovery, permissions, plan/approval interactions, and native Codex app-server integration

The hard part is not the FastAPI language choice by itself. The main user-facing pain is install surface complexity.

## Non-Goals

This design does not:

- rewrite the current control plane in Go
- replace Python worker runtime logic
- replace nginx / HTTPS reverse proxy with an application-level edge
- redesign the product UI, auth model, or runtime protocol in the same pass
- support every package ecosystem equally on day one

## Recommended Strategy

Use a staged strategy:

1. Keep the current Python/FastAPI server and Python workers.
2. Productize installation and onboarding first.
3. Freeze protocol and state-machine contracts.
4. Only then evaluate a Go control plane migration.

This sequence solves the actual user pain now and avoids maintaining two moving control-plane implementations during a period when the runtime contract is still evolving.

## Decision Summary

### 1. Worker should become npm-installable

Yes. This is the highest-value change.

The worker install surface should move from “download a bundle and manually reason about Python/runtime differences” to “install a CLI wrapper that bootstraps the right bundle and starts the correct runtime”.

Recommended user-facing commands:

```bash
npx agenthub-worker install
npx agenthub-worker enroll
npx agenthub-worker service install
npx agenthub-worker run
```

or:

```bash
npm i -g agenthub-worker
agenthub-worker install
```

The npm package should initially be a launcher/installer layer, not a full worker rewrite. It can:

- download the matching worker bundle
- unpack to a standard path
- write local config
- run enroll
- detect `python`, `py`, or `uv`
- install Scheduled Task or systemd unit
- invoke the current Python worker entrypoint
- later manage updates

This preserves working worker logic while making installation much simpler.

### 2. Server should become easier to install, but not primarily through npm

The server should become easier to install, but npm is not the preferred primary installation surface.

Recommended primary server install surfaces:

- `docker compose` for users who want the simplest stable self-host path
- `curl | bash` wrapper for Linux VM bootstrap
- existing advanced/manual path via `install-selfhost-linux.sh`

Recommended public-facing install paths:

```bash
docker compose up -d
```

and:

```bash
curl -fsSL https://myagenthub.dev/install.sh | bash
```

Server-as-npm would hide some complexity but would not remove the need for:

- Python runtime or a packaged server runtime
- web assets
- reverse proxy and HTTPS
- service management
- data directory management

So the better move is to improve install UX first, not force-fit the server into npm.

### 3. Go migration should target the control plane only

If Go is adopted later, the correct boundary is:

- Go: API server, auth, worker relay, queue/state machine, storage access, audit/event handling
- Python: local worker runtime, session discovery, CLI/tool bridges, platform-specific process orchestration

Worker-side code is tightly coupled to scripting, local process control, provider quirks, and OS-specific runtime discovery. That is not the part that benefits most from a Go rewrite.

## Target Architecture

### Near-Term Runtime Topology

```text
Clients (Web / Android / Windows desktop)
        |
        v
AgentHub Server (FastAPI today)
        |
        +-- auth / cookies / PAT / worker enroll
        +-- session + job + event + memory APIs
        +-- worker relay + queue recovery + approvals
        |
        v
Workers (Python runtime, installed via npm wrapper)
        |
        +-- session discovery
        +-- Codex / Claude / Kimi / OpenCode bridges
        +-- local execution + approval handoff
```

### Future Migration Boundary

```text
Clients
   |
   v
Protocol Contract Layer
   |
   +-- Python control plane today
   +-- Go control plane later
   |
   v
Python workers remain stable
```

The central idea is to freeze the protocol and state-machine contract before any language migration.

## Workstream A: npm Worker Installer

### Scope

Introduce a new npm-distributed CLI that wraps the current worker bundle workflow.

### Responsibilities

The CLI should:

- detect OS and architecture
- fetch the correct worker bundle from:
  - local server download endpoint
  - GitHub Release assets
  - optionally file path / custom URL override
- unpack into a standard install root
- write local worker metadata and config
- perform enrollment
- detect runtime launcher:
  - `python`
  - `py`
  - `uv`
- install or update background service:
  - Windows Scheduled Task
  - Linux systemd
- run one-shot diagnostics

### Recommended package structure

```text
packages/worker-cli/
  package.json
  src/index.ts
  src/commands/install.ts
  src/commands/enroll.ts
  src/commands/run.ts
  src/commands/service.ts
  src/commands/doctor.ts
  src/runtime/bundle-fetch.ts
  src/runtime/python-launcher.ts
  src/runtime/windows-task.ts
  src/runtime/linux-systemd.ts
  src/runtime/config.ts
```

### Product rules

- The npm package must not duplicate core worker business logic on day one.
- The npm package is an installer and launcher layer around current worker bundles.
- The CLI should expose clean diagnostics when Python/`uv` is missing.
- The CLI should prefer cached worker tokens after enrollment.

### Success criteria

- Windows user can install a worker with a single npm-based command
- Linux user can install a worker with a single npm-based command
- no manual bundle unpack is required for common cases
- `uv` fallback becomes first-class instead of being a docs-only escape hatch

## Workstream B: Server Install UX

### Scope

Reduce server install complexity without changing control-plane implementation language.

### Official install modes

Three modes should remain visible and documented:

1. `docker compose`
2. Linux VM bootstrap script
3. local development mode

Everything else becomes secondary/internal.

### Deliverables

#### 1. Docker-first self-host path

Provide an official `docker-compose.selfhost.yml` path that:

- runs API
- serves built web assets
- persists SQLite or mounted database path
- supports reverse proxy integration
- supports simple `.env` configuration

This path is likely the fastest way to make self-host feel approachable.

#### 2. Public installer wrapper

Add a stable install wrapper:

```bash
curl -fsSL https://myagenthub.dev/install.sh | bash
```

This wrapper should:

- download or clone a release/server package
- collect or read minimal config
- call the existing installer with correct defaults
- print next-step commands clearly

#### 3. Install mode docs reduction

Current docs are useful but still broad. The user should be able to choose one of three install surfaces quickly:

- “I have a Linux VM”
- “I want to run locally”
- “I want Docker”

### Success criteria

- first-time operator can choose an install path within one minute
- first-time operator can stand up the server without reading multiple scattered docs
- future release assets clearly map to server / worker / client roles

## Workstream C: Protocol Freeze Before Go

### Scope

Define and lock the control-plane contract before considering implementation replacement.

### Contract surfaces to freeze

- worker enroll
- worker heartbeat
- worker claim / complete / fail
- session input / terminate
- events and audit payload shape
- memory query / extract
- auth and PAT behavior
- CSRF and cookie rules
- session/job/worker state transitions

### Recommended artifacts

1. Generated OpenAPI snapshot
2. Explicit protocol notes for worker relay
3. Black-box contract tests
4. State-machine conformance tests

### Test direction

Create tests that validate behavior only, not implementation details:

- request/response schemas
- status codes
- state transitions
- idempotency behavior
- permission boundaries

These tests should pass against:

- current FastAPI implementation
- future Go implementation

## Workstream D: Internal Server Refactor Before Any Go Port

### Scope

Make the current server easier to port by separating concerns.

### Required layers

#### Transport layer

FastAPI routers and request wiring only.

#### Application layer

Business orchestration:

- auth workflows
- worker relay orchestration
- job queue operations
- approval / permission state handling
- session transition rules

#### Persistence layer

SQLAlchemy models plus focused repository operations.

#### Protocol layer

Shared request/response schema definitions and state-machine enums.

### Why this matters

If business rules stay embedded in routers and framework-specific dependencies, a Go rewrite becomes a full logic reimplementation. If those rules are explicit and tested, a Go rewrite becomes a transport and persistence reimplementation under an existing contract.

## Release And Packaging Impact

The public release surface should be re-framed by install role:

- server install package or docker compose bundle
- worker installer package
- Android client
- Windows desktop client
- checksums and manifest

That is more understandable than treating everything as “repo + scripts + artifacts”.

## Risks

### Risk 1: npm worker wrapper becomes a second worker implementation

Mitigation:

- keep it thin
- use current Python worker as the runtime
- do not duplicate session discovery or execution logic

### Risk 2: Docker path increases maintenance burden

Mitigation:

- keep Compose focused on self-host defaults
- do not add extra optional services in v1 unless required

### Risk 3: Go rewrite starts before protocol is stable

Mitigation:

- explicitly block Go implementation work until contract tests exist
- treat protocol freeze as a gate, not a nice-to-have

### Risk 4: install UX changes drift from release assets

Mitigation:

- make release assets and docs part of the same release gate
- test install flows from release artifacts, not from source checkout only

## Recommended Implementation Order

### Phase 1

1. Build `agenthub-worker` CLI wrapper
2. Make `uv` / `python` / `py` detection first-class
3. Update docs to make npm worker install the recommended path

### Phase 2

4. Add official Docker self-host path
5. Add `install.sh` bootstrap wrapper for Linux VM
6. Reduce docs to clear install mode entrypoints

### Phase 3

7. Freeze worker relay and auth protocol contracts
8. Add black-box conformance tests
9. Separate application logic from FastAPI transport layer

### Phase 4

10. Re-evaluate a Go control plane spike
11. Prototype only the server, not workers
12. Compare migration cost against then-current Python implementation

## Recommendation

Do not start with a Go rewrite.

Start with:

- npm-installable worker
- productized server install UX
- protocol freeze and contract tests

If those three are done and deployment still feels too heavy, then a Go control plane migration becomes much more defensible and much safer.
