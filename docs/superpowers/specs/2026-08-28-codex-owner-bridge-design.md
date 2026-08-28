# Codex Owner Bridge Design

## Goal

Allow an AgentHub worker to continue a Codex thread that is already owned by Codex Desktop or another app-server process without terminating that process or attempting a second `thread/resume` writer.

## Verified constraints

- Codex Desktop `0.150.0-alpha.8` and standalone Codex `0.150.1` enforce one active rollout writer per thread.
- A second app-server can still call read-only history APIs while the Desktop process owns the writer.
- On Windows, Codex Desktop exposes `CODEX_APP_TOOLS_PIPE_PATH`. Its app-tool catalog includes `send_message_to_thread`.
- An external same-user process successfully invoked `send_message_to_thread` with the target thread as both source and destination. A standalone `0.150.1` app-server then read the completed response written by Desktop `0.150.0-alpha.8`.
- Desktop `wait_threads` reported completion but omitted `latestAssistantMessage` in the tested alpha build. Final text must therefore come from read-only app-server history, not from the Desktop wait payload.

## Chosen architecture

Normal Codex execution remains unchanged. The owner bridge is entered only when native `thread/resume` returns `already has an active writer`.

1. Start a read-only observer app-server and record the target thread's recent turn IDs.
2. On Windows, discover running Codex Desktop app-server processes and extract their app-tools pipe paths dynamically.
3. Query `tools/list`; require `send_message_to_thread` and validate its minimum argument schema.
4. Send the prompt through the Desktop host pipe with the target thread as both source and destination.
5. Poll `thread/turns/list` without resuming until a new matching turn completes, then return its final agent message.
6. If the Desktop bridge is unavailable or incompatible, persist the request with experimental `thread/queue/add` and observe the same read-only history.
7. If neither delivery path is supported, return a clear owner-bridge error. Never kill Codex processes, delete lock files, or retry `thread/resume` in a loop.

## Components

### `codex_owner_bridge.py`

Owns active-writer detection, Desktop process discovery, capability negotiation, delivery selection, queue fallback, and read-only completion polling. It exposes one executor-facing function, `run_codex_owner_turn`.

### `codex_desktop_pipe.mjs`

A narrowly scoped transport helper. It reads one JSON-RPC request from stdin, sends one length-prefixed frame to a supplied Windows named pipe, prints one JSON-RPC response, and exits. It does not choose arbitrary tools or targets.

### Executor integration

The default and native-plan Codex paths call the owner bridge only for the exact active-writer conflict. Existing invalid-thread, missing-rollout, provider-configuration, capacity, attachment, and CLI fallback behavior remains unchanged.

## Version compatibility

Compatibility is capability-based, not strict semver equality:

- Record Desktop and standalone CLI versions for diagnostics.
- Discover the current pipe on every bridge attempt because it changes when Desktop restarts.
- Validate required tool names and required input fields from `tools/list`.
- Permit additive schema changes.
- Pass optional `model` and `thinking` only when the live schema advertises them and accepts the requested value.
- Treat missing methods, invalid schemas, closed pipes, and unsupported history pagination as a recoverable bridge mismatch and try the queue path.

The tested baseline is Desktop `0.150.0-alpha.8` with standalone app-server `0.150.1`. Older versions are not assumed compatible merely because their version string compares lower or higher.

## Error handling

- Desktop process or Node runtime absent: skip Desktop delivery and try queue delivery.
- Pipe closes or tool schema is incompatible: try the next Desktop candidate, then queue.
- Queue API missing: raise `CodexOwnerBridgeUnavailable` with both delivery diagnostics.
- Submitted turn requires attention or exceeds the job timeout: raise a bounded error; do not submit a duplicate prompt.
- Completed turn has no final agent message: report the turn ID and completion state rather than fabricating output.

## Testing

- Unit-test active-writer classification and executor routing.
- Unit-test Desktop command-line pipe extraction and minimum schema negotiation.
- Unit-test same-thread Desktop delivery and read-only result correlation.
- Unit-test queue fallback and its stable AgentHub client message ID.
- Unit-test capability mismatch without CLI resume fallback.
- Run the focused worker test module and an isolated live Desktop bridge smoke test.

## Out of scope

- Reconfiguring Codex Desktop to use the managed app-server daemon.
- Killing or handing off existing Desktop/CLI processes.
- Arbitrary invocation of Desktop app tools.
- Streaming every token from the owner process. Phase one returns the completed final message and preserves existing timeline discovery.
