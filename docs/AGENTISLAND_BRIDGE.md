# AgentIsland Bridge

AgentHub v1 does not modify `E:/work/AgentIsland`.

AgentIsland is treated as a reference and future bridge target for:

- Windows session discovery patterns
- PSMUX handoff detection
- direct reply availability
- desktop-local file and process constraints

Bridge rule for v1:

- read-only reference access is allowed during development
- no imports from AgentIsland runtime code
- no writes to AgentIsland files
- no shared mutable state

Future bridge shape:

```text
AgentIsland local session state
        |
read-only adapter
        |
AgentHub Windows worker
        |
AgentHub API session/job/event protocol
```

The bridge should emit AgentHub `Session` objects and capability metadata only. It should not expose arbitrary shell execution or raw local filesystem browsing.

