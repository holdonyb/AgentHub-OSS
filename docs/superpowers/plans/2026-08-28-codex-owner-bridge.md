# Codex Owner Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continue active-writer Codex threads through their current owner without exiting Desktop or retrying a conflicting resume.

**Architecture:** Add a Windows Desktop app-tools transport and a Python owner-routing layer. Delivery uses Desktop `send_message_to_thread` when live capability negotiation succeeds, otherwise Codex `thread/queue/add`; both paths recover the final response through read-only turn history.

**Tech Stack:** Python 3.11+, Node.js 20 named-pipe transport, Codex app-server JSON-RPC, pytest.

---

### Task 1: Active-writer routing contract

**Files:**
- Create: `workers/shared/agenthub_worker/codex_owner_bridge.py`
- Modify: `workers/shared/agenthub_worker/executor.py`
- Test: `apps/api/tests/test_worker_executor.py`

- [ ] Add failing tests proving the exact `already has an active writer` error routes to `run_codex_owner_turn` for default and plan modes and never invokes CLI resume.
- [ ] Run the focused tests and verify they fail because the owner bridge functions do not exist.
- [ ] Implement `is_codex_active_writer_error` and the minimal executor catch ordering.
- [ ] Run the focused tests and verify they pass.

### Task 2: Desktop capability negotiation and transport

**Files:**
- Create: `workers/shared/agenthub_worker/codex_desktop_pipe.mjs`
- Modify: `workers/shared/agenthub_worker/codex_owner_bridge.py`
- Test: `apps/api/tests/test_worker_executor.py`

- [ ] Add failing tests for encoded pipe extraction, required `send_message_to_thread` fields, additive schema compatibility, and incompatible/missing capabilities.
- [ ] Run the tests and verify expected assertion failures.
- [ ] Implement Windows Desktop process discovery, JSON-unescaping, Node helper invocation, framed response validation, and minimum live-schema checks.
- [ ] Run the focused tests and verify they pass.

### Task 3: Read-only result recovery

**Files:**
- Modify: `workers/shared/agenthub_worker/codex_owner_bridge.py`
- Test: `apps/api/tests/test_worker_executor.py`

- [ ] Add failing tests that establish a baseline turn set, deliver to the same target/source thread, ignore old turns, and return only the completed new turn's final agent message.
- [ ] Run the tests and verify they fail because polling is absent.
- [ ] Implement `thread/turns/list` polling with `thread/read(includeTurns=true)` compatibility fallback and bounded timeout handling.
- [ ] Run the focused tests and verify they pass.

### Task 4: Queue fallback

**Files:**
- Modify: `workers/shared/agenthub_worker/codex_owner_bridge.py`
- Test: `apps/api/tests/test_worker_executor.py`

- [ ] Add failing tests proving a Desktop capability failure calls `thread/queue/add`, uses `agenthub:<job_id>` as `clientUserMessageId`, and returns the correlated completed turn.
- [ ] Run the tests and verify the queue behavior is missing.
- [ ] Implement durable queue submission and reuse the read-only observer.
- [ ] Run the focused tests and verify they pass.

### Task 5: Verification and documentation

**Files:**
- Modify: `PROJECT_STATUS.md` only if the feature branch becomes the durable project handoff.

- [ ] Run `pytest apps/api/tests/test_worker_executor.py -q` with the project virtual environment and confirm zero failures.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Run an isolated live Desktop smoke: fork a disposable task, submit a unique marker through the external bridge, read it through `thread/turns/list(itemsView=full)`, and archive the disposable task.
- [ ] Confirm the original Desktop app-server PID remains alive and no AgentHub stdio app-server is left behind.
