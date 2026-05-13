# Contributing

AgentHub is a self-hosted agent control plane. Keep changes small, tested, and explicit about security boundaries.

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

## Security-sensitive changes

Call out changes that affect auth, worker tokens, enrollment tokens, provider secrets, cookies, CSRF, public relay, or mobile/desktop local storage.

Do not commit local databases, logs, worker token caches, signing keys, `.env`, or generated release artifacts.
