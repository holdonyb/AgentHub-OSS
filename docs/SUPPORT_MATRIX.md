# Support Matrix

Status labels:

- `stable`: expected to work for normal self-host usage
- `beta`: usable, still being hardened
- `experimental`: available but provider/runtime behavior may change

| Area | Status | Notes |
| --- | --- | --- |
| API control plane | stable | Auth, sessions, workers, jobs, events, memory, enrollments |
| Web console | stable | Primary operating surface |
| Windows worker | stable | Local Codex/Claude/Kimi discovery and job polling |
| Linux worker | stable | tmux/cloud VM oriented worker path |
| Desktop client | beta | First-launch server configuration and island window |
| Android client | beta | WebView shell, native microphone, native notifications |
| Codex interactions | beta | Deepest current support for timeline, approvals, plan-style controls, and image attachments |
| Claude interactions | experimental | Compatibility layer exists; native runtime prompts are still being expanded |
| Kimi interactions | experimental | Compatibility layer exists; structured interaction coverage is still being expanded |
| Public relay | beta | Polling-first worker relay; long-lived transport is future work |
| SaaS multi-tenant hosting | experimental | Self-host is the supported v0.1 path |
