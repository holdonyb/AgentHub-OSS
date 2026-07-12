# agenthub-worker

`agenthub-worker` is the publishable npm entrypoint for installing and diagnosing AgentHub workers.

It does not replace the existing Python worker runtime. It downloads the published worker bundle, extracts it, and calls the existing platform installer.

## Commands

```bash
npx agenthub-worker doctor
```

```bash
npx agenthub-worker install \
  --api-url https://agenthub.example.com \
  --enrollment-token ahe_worker_enroll_xxx \
  --platform linux \
  --worker-id build-vm-01 \
  --workspace-root /srv/work
```

macOS example (a workspace root is required):

```bash
npx agenthub-worker install \
  --api-url https://agenthub.example.com \
  --enrollment-token ahe_worker_enroll_xxx \
  --platform macos \
  --worker-id macbook-pro-01 \
  --workspace-root "$HOME/Work"
```

Windows example:

```powershell
npx agenthub-worker install `
  --api-url https://agenthub.example.com `
  --enrollment-token ahe_worker_enroll_xxx `
  --platform windows `
  --worker-id office-pc-01 `
  --workspace-root E:/Work `
  --start-at-logon
```

## Notes

- `doctor` checks whether the current machine exposes the shell tools the wrapper expects.
- `install` supports Windows, Linux, and macOS and reuses the platform installer from the worker bundle.
- Every downloaded bundle is checked against the SHA256 value in `worker-bundles-manifest.json` before extraction.
- Default install roots are durable per-worker directories; macOS uses `~/Library/Application Support/AgentHub/workers/<worker-id>`.
- When `python` or `py` are not on `PATH`, the underlying installer now falls back to `uv` bootstrap when available.

See [macOS Worker](../../docs/MACOS_WORKER.md) for LaunchAgent lifecycle and troubleshooting commands.
