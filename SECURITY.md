# Security Policy

AgentHub controls local coding agents and can route prompts, approvals, worker jobs, and provider secrets. Treat every deployment as security-sensitive infrastructure.

## Supported versions

Security fixes target the latest tagged release and `main`.

## Reporting

Do not file public issues for vulnerabilities. Use a private security advisory or contact the maintainers privately.

## Default boundaries

- Web sessions use httpOnly cookies and CSRF protection.
- Worker tokens are scoped to worker APIs.
- Provider/API secrets must stay out of chat messages and git.
- Desktop and Android clients store only the configured AgentHub server URL locally.
- Public reverse proxies should expose Web/API only; never expose databases, SSH, worker-local services, or raw internal worker ports.

See `docs/SECURITY.md` for the detailed model.
