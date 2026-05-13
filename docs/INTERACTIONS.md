# AgentHub Interactions

AgentHub treats provider-native prompts as actionable interactions, not plain chat text. This keeps phone/Web control usable when Codex, Claude, or Kimi asks the user to choose, approve, continue planning, or provide extra context.

## Interaction Shape

The current implementation stores interactions in the existing `agent_permissions` table and keeps `/api/permissions` compatible. `/api/interactions` is an alias for the same records and should be used by newer clients.

Important fields:

- `permission_id`: stable interaction identifier.
- `session_id`, `worker_id`, `backend`: routing and authorization boundary.
- `kind`: `question`, `plan_exit`, `command_approval`, `tool_approval`, or legacy kinds.
- `detail.source`: provider-specific source, such as `codex_request_user_input` or `codex_plan_exit`.
- `detail.thread_id`, `detail.turn_id`, `detail.item_id`, `detail.server_request_id`: provider request identity when available.
- `actions.choices`: selectable actions shown by Web/App.
- `status`: `pending`, `answered`, `allowed`, `denied`, or `expired`.
- `response`: user response payload.

## Supported Flows

### Codex `request_user_input`

Codex app-server emits `item/tool/requestUserInput`. The worker creates a `question` interaction with grouped questions and options. Web/App submit:

```json
{
  "action": "answer",
  "response": {
    "answers": {
      "question_id": {
        "choice": "question_id:0",
        "label": "Selected label",
        "text": "Optional freeform text"
      }
    }
  }
}
```

The worker responds to Codex with:

```json
{
  "answers": {
    "question_id": {
      "answers": ["Selected label or freeform text"]
    }
  }
}
```

For `其他` / `other`, AgentHub sends the raw freeform text back to Codex instead of the display label.

### Codex Plan Exit

When a native Codex plan turn completes, the API creates a `plan_exit` interaction. Choices:

- `implement`: enqueue a direct continuation with `Implement the plan.`
- `clear_context_implement`: enqueue a direct continuation with `Clear context and implement the plan.`
- `keep_planning`: enqueue another native plan turn with the user's note.
- `cancel`: resolve without creating a continuation job.

The plan text is stored in `detail.plan_text` and displayed at the top of the session thread.

### Codex Approvals

The worker handles Codex app-server approval requests:

- `item/commandExecution/requestApproval`
- `execCommandApproval`
- `item/fileChange/requestApproval`
- `applyPatchApproval`
- `item/permissions/requestApproval`

These become `command_approval` or `tool_approval` interactions. The response decision is mapped to Codex-compatible values:

- `approved`
- `approved_for_session`
- `denied`
- `abort`

## Client Rules

- Show pending interactions above the transcript as the single primary action surface.
- Keep timeline tool-call previews read-only unless they can be matched to an active interaction.
- Use `permission_id` / `interaction_id` for notification de-duplication.
- A resolved interaction must not submit again.
- If an interaction is resolved after the provider turn has timed out, the API may enqueue a continuation job and the UI should show that as a normal queued job.

## Provider Notes

Provider snapshots publish `features.interaction_bridge` so clients can show what is safe to do remotely:

- `codex`: `native`. `codex app-server` exposes structured `request_user_input`, plan-exit, and approval requests, so AgentHub can render and answer those interactions inside Web/App.
- `claude`: `compatibility`. AgentHub supports plan-result continuation choices after a non-interactive turn, but native runtime prompts from Claude TUI are not bridged yet. The intended bridge is `--output-format stream-json` plus `--input-format stream-json`.
- `kimi`: `compatibility`. AgentHub supports plan-result continuation choices after a non-interactive turn. Installed Kimi exposes `acp` and `wire` entry points, but AgentHub does not yet consume those native structured protocols for runtime prompts.

Compatibility mode must be labeled in clients. It must not imply that an in-flight Claude/Kimi native prompt can already be answered from AgentHub.
