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
- `install` reuses the existing PowerShell or bash installer from the worker bundle.
- When `python` or `py` are not on `PATH`, the underlying installer now falls back to `uv` bootstrap when available.
