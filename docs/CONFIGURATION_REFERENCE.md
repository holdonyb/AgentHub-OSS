# AgentHub Configuration Reference

This document is the operator-facing reference for self-hosted AgentHub. Use it with:

- [docs/SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md)
- [docs/TAILSCALE_PRIVATE_MODE.md](TAILSCALE_PRIVATE_MODE.md)
- [docs/SELF_HOST_TROUBLESHOOTING.md](SELF_HOST_TROUBLESHOOTING.md)

## Deployment Shapes

AgentHub supports three primary install modes:

### 1. Local laptop server

Use this when you only want to run AgentHub on your own workstation.

- Run API and Web on the same laptop or desktop.
- Use `http://localhost:43073` or a LAN/Tailscale URL.
- Good for one-user private control and local testing.

### 2. Docker self-host mode

Use this when you want one reproducible compose stack on a single host.

- Run the official `docker compose` stack from `deploy/docker-compose.selfhost.yml`.
- Good for local labs, Tailscale-only installs, and operators who prefer containers.
- Default entry is `http://localhost:8080` unless you front it with your own reverse proxy.

### 3. Self-hosted VM with public relay

Use this when you have a VM plus a domain.

- VM runs API, Web, and downloadable worker bundles.
- Browser, Android, and desktop connect to your HTTPS domain.
- Workers connect over outbound HTTPS in `public_relay` mode.

### Network overlay: Tailscale private mode

Use this when your VM, laptop, Android phone, and workers are in the same tailnet.

- AgentHub server URL can be a Tailscale DNS name or Tailscale IP.
- Workers use `ConnectionMode private`.
- This is the preferred private deployment shape when you do not want public worker traffic.

See also:

- [docs/LOCAL_SERVER_MODE.md](LOCAL_SERVER_MODE.md)
- [docs/DOCKER_SELFHOST_MODE.md](DOCKER_SELFHOST_MODE.md)
- [docs/SELF_HOST_QUICKSTART.md](SELF_HOST_QUICKSTART.md)

## Core Server Settings

Minimum required settings:

```env
AGENTHUB_DATABASE_URL=sqlite+pysqlite:///./agenthub.db
AGENTHUB_BOOTSTRAP_TOKEN=change-me-on-first-start
AGENTHUB_SECRET_ENCRYPTION_KEY=change-me-generate-a-stable-random-secret
AGENTHUB_COOKIE_SECURE=true
```

Recommended HTTPS deployment settings:

```env
AGENTHUB_COOKIE_SECURE=true
AGENTHUB_CORS_ORIGINS=https://agenthub.example.com
```

## Claude Interaction Bridge

Claude now supports two execution styles inside AgentHub:

- `compatibility`: existing `claude -p` non-interactive path
- `tmux`: non-official interactive bridge for Linux workers, using `tmux` + transcript sync
- `psmux`: non-official interactive bridge for Windows workers, using `psmux` + transcript sync

Server and client behavior:

- the session controls panel can persist `interaction_bridge`
- the launch modal can set `interaction_bridge` for new Claude sessions
- the worker still falls back to the compatibility path when the selected bridge is unavailable

Worker-side default:

```env
AGENTHUB_CLAUDE_INTERACTIVE_BRIDGE=1
```

Notes:

- `AGENTHUB_CLAUDE_INTERACTIVE_BRIDGE=1` maps to `tmux` on Linux and `psmux` on Windows
- current bridge coverage is existing-session reply, session start, session fork, and `/btw`
- Linux workers need both `tmux` and `claude` installed for the bridge to be useful
- Windows workers need both `psmux` and `claude` installed for the bridge to be useful

## Voice ASR Provider Selection

AgentHub voice transcription is configurable. Set:

```env
AGENTHUB_VOICE_ASR_PROVIDER=doubao
```

Supported providers today:

- `doubao`
- `openai`

`openai` means OpenAI or any OpenAI-compatible endpoint that implements `POST /audio/transcriptions`.

Voice transcription and the voice assistant are separate:

- transcription turns microphone audio into text
- the voice assistant takes that text, reads AgentHub session context, and may call allowlisted AgentHub tools

If no voice credentials are configured, normal Web/App/worker usage still works.

## Doubao ASR Configuration

Doubao is the current provider that supports both:

- upload transcription
- streaming auth for live voice capture

Example:

```env
AGENTHUB_VOICE_ASR_PROVIDER=doubao
AGENTHUB_DOUBAO_ASR_API_KEY=
AGENTHUB_DOUBAO_ASR_APP_KEY=
AGENTHUB_DOUBAO_ASR_ACCESS_KEY=
AGENTHUB_DOUBAO_ASR_ENDPOINT=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
AGENTHUB_DOUBAO_ASR_RESOURCE_ID=volc.seedasr.auc
AGENTHUB_DOUBAO_ASR_STS_ENDPOINT=https://openspeech.bytedance.com/api/v1/sts/token
AGENTHUB_DOUBAO_STREAM_ASR_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
AGENTHUB_DOUBAO_STREAM_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
AGENTHUB_DOUBAO_STREAM_TOKEN_DURATION_SECONDS=300
```

Notes:

- If `AGENTHUB_DOUBAO_ASR_API_KEY` is empty, AgentHub falls back to `AGENTHUB_DOUBAO_ASR_APP_KEY` + `AGENTHUB_DOUBAO_ASR_ACCESS_KEY`.
- Streaming voice capture requires the Doubao streaming credentials above.

## OpenAI Whisper Configuration

Use this when you want upload transcription through OpenAI or an OpenAI-compatible provider.

Example:

```env
AGENTHUB_VOICE_ASR_PROVIDER=openai
OPENAI_API_KEY=sk-xxxx
AGENTHUB_OPENAI_ASR_BASE_URL=https://api.openai.com/v1
AGENTHUB_OPENAI_ASR_MODEL=whisper-1
```

Equivalent explicit form:

```env
AGENTHUB_OPENAI_ASR_API_KEY=sk-xxxx
AGENTHUB_OPENAI_ASR_BASE_URL=https://api.openai.com/v1
AGENTHUB_OPENAI_ASR_MODEL=whisper-1
```

Common variants:

- OpenAI hosted:
  - `AGENTHUB_OPENAI_ASR_BASE_URL=https://api.openai.com/v1`
  - `AGENTHUB_OPENAI_ASR_MODEL=whisper-1`
- OpenAI-compatible proxy:
  - `AGENTHUB_OPENAI_ASR_BASE_URL=https://your-proxy.example.com/v1`
  - `AGENTHUB_OPENAI_ASR_MODEL=whisper-1`

Notes:

- `openai` currently supports upload transcription only.
- live streaming auth is not available in `openai` mode yet.

## Voice Assistant Provider

The full voice assistant uses an AgentHub-managed, server-side OpenAI-compatible chat endpoint. Browser and Android clients never receive the provider key.

Example:

```env
AGENTHUB_VOICE_AGENT_PROVIDER=agenthub
AGENTHUB_VOICE_AGENT_API_KEY=sk-xxxx
AGENTHUB_VOICE_AGENT_BASE_URL=https://api.openai.com/v1
AGENTHUB_VOICE_AGENT_MODEL=gpt-4.1-mini
AGENTHUB_VOICE_AGENT_TIMEOUT_SECONDS=30
```

You may also set `OPENAI_API_KEY` or `AGENTHUB_OPENAI_API_KEY`; `AGENTHUB_VOICE_AGENT_API_KEY` wins when present.

The V1 voice assistant is deliberately constrained. It can only call these AgentHub tools:

- read the selected session state
- send input to the selected session
- answer a pending approval / user choice
- create a `/btw` sidecar question

It cannot run shell commands directly, edit files directly, read arbitrary secrets, or bypass AgentHub RBAC.

Client behavior:

- Web and Android share the same UI.
- `听写` mode writes recognized text into the composer.
- `助手` mode sends recognized text to `/api/voice/turn`; the server-side voice agent decides which allowlisted AgentHub tool to call.
- Web uses browser `speechSynthesis` for local spoken feedback when available; text feedback is always shown.

## Session Attachments

Current attachment limits:

```env
AGENTHUB_MAX_SESSION_ATTACHMENTS=5
AGENTHUB_MAX_SESSION_ATTACHMENT_BYTES=8388608
AGENTHUB_MAX_VOICE_AUDIO_BYTES=12582912
```

Increase these only if:

- your reverse proxy body limit is also raised
- your VM memory and disk budget are large enough

## Secrets vs Environment Variables

Use the right path for the right kind of secret:

### Server environment variables

Use `.env` or systemd environment for:

- `AGENTHUB_BOOTSTRAP_TOKEN`
- `AGENTHUB_SECRET_ENCRYPTION_KEY`
- `AGENTHUB_VOICE_ASR_PROVIDER`
- Doubao server ASR credentials
- `OPENAI_API_KEY` or `AGENTHUB_OPENAI_ASR_API_KEY`

These are server-runtime secrets. They should not be stored in Git.

### AgentHub Secrets UI

Use Web console secrets for:

- worker-side provider login material
- project API keys referenced by jobs
- namespace/environment-scoped application secrets

This path is better when you need:

- `test` vs `prod` separation
- different spaces or namespaces
- worker secret references without hardcoding values into chat

## Environment Separation

A practical first setup is:

- `local`: laptop development
- `test`: staging VM or test space
- `prod`: production VM or production space

For server envs:

```env
AGENTHUB_ENVIRONMENT=production
```

For the local laptop server preset, the default local addresses are:

- `http://localhost:43073` for Web/UI
- `http://127.0.0.1:43080` for the API

For secrets in AgentHub UI:

- choose `test` for test APIs
- choose `prod` for real production APIs

## Worker Connection Modes

The Add Worker flow emits different install commands depending on connection mode:

- `public_relay`: worker connects over outbound HTTPS to `/api/worker/*`
- `private`: worker connects through Tailscale/private routing

Pick `public_relay` when:

- worker machine is outside your tailnet
- you want the easiest self-host setup

Pick `private` when:

- laptop, VM, and phone are already on Tailscale
- you want the smallest public attack surface

## Validation Checklist

After changing config:

1. Open `/healthz`
2. Log in to the Web console
3. Create or reuse a worker enrollment
4. Confirm worker heartbeat shows `online`
5. Send one session input
6. Test one voice transcription
7. If using Doubao streaming, test `/api/voice/stream-auth`

Use:

```bash
bash scripts/check-selfhost.sh --base-url https://agenthub.example.com --expect-public-relay
```
