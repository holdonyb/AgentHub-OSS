# Docker self-host mode

Use this mode when you want AgentHub on one machine, but you do not want to install Python, Node.js, nginx, or systemd directly on that host.

This is the recommended path when:

- you already use Docker and want the smallest reproducible setup
- you do not need built-in HTTPS termination inside AgentHub itself
- you are fine exposing AgentHub through `http://localhost:8080`, a LAN IP, a Tailscale address, or your own reverse proxy

This mode is separate from:

- [LOCAL_SERVER_MODE.md](LOCAL_SERVER_MODE.md) for direct host installs
- [SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md) for the VM path with nginx + certbot

## What Docker mode includes

The official compose stack gives you:

- one API container
- one nginx container that serves the built Web console
- same-origin `/api` proxying
- downloadable worker bundles at `/downloads/workers/*`

It does not include:

- automatic Let's Encrypt
- public-domain HTTPS termination
- external database or object storage

For public internet access, put Docker mode behind your own reverse proxy or switch to the VM path.

## Quick start

1. Create `.env` from `.env.example`.
2. Set at least these values:

```env
AGENTHUB_DATABASE_URL=sqlite+pysqlite:////var/lib/agenthub/agenthub.db
AGENTHUB_BOOTSTRAP_TOKEN=change-me-on-first-start
AGENTHUB_SECRET_ENCRYPTION_KEY=replace-with-a-stable-random-secret
AGENTHUB_PUBLIC_BASE_URL=http://localhost:8080
AGENTHUB_COOKIE_SECURE=false
AGENTHUB_CORS_ORIGINS=http://localhost:8080
```

3. Start the stack:

```bash
docker compose -f deploy/docker-compose.selfhost.yml up -d --build
```

4. Open:

```text
http://localhost:8080
```

5. Create the first owner with `AGENTHUB_BOOTSTRAP_TOKEN`.

## Common variants

### Tailscale / private URL

If Docker mode is only for your own machines, set:

```env
AGENTHUB_PUBLIC_BASE_URL=http://100.x.y.z:8080
AGENTHUB_CORS_ORIGINS=http://100.x.y.z:8080
AGENTHUB_COOKIE_SECURE=false
```

If you front it with HTTPS on a tailnet DNS name or reverse proxy, switch `AGENTHUB_PUBLIC_BASE_URL` to `https://...` and set `AGENTHUB_COOKIE_SECURE=true`.

`AGENTHUB_CORS_ORIGINS` accepts either a single origin string like `http://localhost:8080` or a JSON array if you need multiple origins.

### Public reverse proxy

If another proxy terminates HTTPS in front of Docker mode:

- publish only the proxy to the public internet
- keep the compose stack on private ports
- point the proxy at the `web` container

## Validation

After `docker compose` is up:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/downloads/workers/worker-bundles-manifest.json
```

Then:

1. log in
2. add a worker
3. run one `health_check` or one short session reply

## When to use VM mode instead

Switch to [SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md) when you need:

- automatic certbot and nginx provisioning
- a public HTTPS domain from the start
- a more conventional always-on Linux server shape
