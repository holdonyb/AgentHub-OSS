# Worker Installer And Server Install UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class npm worker installer, close the current `uv` bootstrap gap in worker install scripts, and expose a simpler Linux server install entrypoint without changing the current FastAPI/Python control-plane architecture.

**Architecture:** Keep the existing Python worker bundles and shell/PowerShell installers as the source of truth. Add a new Node workspace package `@agenthub/worker` that downloads a published bundle, extracts it to a temp directory, and invokes the existing platform installer with normalized arguments. Add a thin `scripts/install.sh` wrapper for Linux self-host installs and wire the public website deploy to publish that installer directly.

**Tech Stack:** Node.js ESM, npm workspaces, Vitest, PowerShell, bash, Python worker bundles, existing FastAPI test suite.

---

### Task 1: Add the implementation surface map

**Files:**
- Create: `packages/worker-cli/package.json`
- Create: `packages/worker-cli/src/cli.mjs`
- Create: `packages/worker-cli/src/install.mjs`
- Create: `packages/worker-cli/src/doctor.mjs`
- Create: `packages/worker-cli/src/lib/args.mjs`
- Create: `packages/worker-cli/src/lib/bundle.mjs`
- Create: `packages/worker-cli/src/lib/platform.mjs`
- Create: `packages/worker-cli/src/lib/run-installer.mjs`
- Create: `packages/worker-cli/tests/worker-cli.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the new workspace before code exists**

Update the root workspace list and add a focused test script for the new package:

```json
{
  "scripts": {
    "worker:cli:test": "npm --workspace @agenthub/worker run test -- --run"
  },
  "workspaces": [
    "apps/web",
    "apps/mobile",
    "apps/desktop",
    "packages/protocol",
    "packages/worker-cli"
  ]
}
```

- [ ] **Step 2: Create the npm package manifest**

Use a plain ESM package with a `bin` entry and Vitest:

```json
{
  "name": "@agenthub/worker",
  "version": "0.1.1",
  "type": "module",
  "bin": {
    "agenthub-worker": "./src/cli.mjs"
  },
  "scripts": {
    "test": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 3: Add a failing CLI test first**

Write a test that proves the package can:

```js
import { describe, expect, it } from "vitest";
import { buildInstallPlan } from "../src/install.mjs";

describe("buildInstallPlan", () => {
  it("derives manifest and bundle URLs from apiUrl", () => {
    const plan = buildInstallPlan({
      apiUrl: "https://agenthub.example.com",
      enrollmentToken: "token",
      platform: "linux",
    });

    expect(plan.manifestUrl).toBe("https://agenthub.example.com/downloads/workers/worker-bundles-manifest.json");
    expect(plan.archiveName).toBe("agenthub-worker-linux.tar.gz");
    expect(plan.bundleUrl).toBe("https://agenthub.example.com/downloads/workers/agenthub-worker-linux.tar.gz");
  });
});
```

- [ ] **Step 4: Run the package test and confirm failure**

Run:

```powershell
npm run worker:cli:test
```

Expected: fail because `packages/worker-cli/src/install.mjs` does not exist yet.

- [ ] **Step 5: Commit the workspace scaffold after the first green pass**

```bash
git add package.json packages/worker-cli
git commit -m "feat: scaffold npm worker installer package"
```

### Task 2: Implement the npm worker installer around the existing bundle flow

**Files:**
- Modify: `packages/worker-cli/src/cli.mjs`
- Modify: `packages/worker-cli/src/install.mjs`
- Modify: `packages/worker-cli/src/lib/args.mjs`
- Modify: `packages/worker-cli/src/lib/bundle.mjs`
- Modify: `packages/worker-cli/src/lib/platform.mjs`
- Modify: `packages/worker-cli/src/lib/run-installer.mjs`
- Test: `packages/worker-cli/tests/worker-cli.test.mjs`

- [ ] **Step 1: Define the CLI surface**

Implement exactly two subcommands now:

```text
agenthub-worker install [options]
agenthub-worker doctor
```

Use `install` options that map cleanly to existing installer capabilities:

```text
--api-url
--enrollment-token
--worker-id
--connection-mode
--install-root
--workspace-root
--session-root
--worker-manifest-url
--worker-bundle-url
--disable-auto-update
--skip-bootstrap
--start-at-boot
--start-at-logon
--service-name
--platform
```

- [ ] **Step 2: Implement install-plan resolution**

Create `buildInstallPlan()` so it:

```js
export function buildInstallPlan(options) {
  const platform = normalizePlatform(options.platform);
  const apiUrl = (options.apiUrl || "").replace(/\/+$/, "");
  const manifestUrl =
    options.workerManifestUrl ||
    `${apiUrl}/downloads/workers/worker-bundles-manifest.json`;
  const archiveName =
    platform === "windows" ? "agenthub-worker-windows.zip" : "agenthub-worker-linux.tar.gz";
  const bundleUrl =
    options.workerBundleUrl ||
    new URL(archiveName, `${manifestUrl.replace(/[^/]+$/, "")}`).toString();
  return { platform, manifestUrl, bundleUrl, archiveName };
}
```

- [ ] **Step 3: Implement bundle download and extract**

In `bundle.mjs`, support:

```js
export async function prepareBundle({ bundleUrl, archiveName, platform }) {
  // fetch archive to temp dir
  // unzip/tar it into temp dir
  // assert tempDir/agenthub-worker exists
  // return { bundleRoot, tempRoot }
}
```

Windows can use PowerShell `Expand-Archive`; Linux/macOS can use `tar -xzf`. Keep this package dependency-free.

- [ ] **Step 4: Invoke the existing platform installer**

In `run-installer.mjs`, call:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <bundle>/scripts/install-windows-worker.ps1 ...
bash <bundle>/scripts/install-linux-worker.sh ...
```

Map Node CLI flags to the existing installer syntax rather than inventing a new worker runtime path.

- [ ] **Step 5: Add doctor output**

`doctor` should report:

- detected platform
- whether `powershell.exe` or `bash` is available
- whether `python`, `py`, or `uv` is present
- whether the current machine is supported by the installer

Keep it text-first; no JSON output in this phase.

- [ ] **Step 6: Run targeted tests**

Run:

```powershell
npm run worker:cli:test
```

Expected: pass.

- [ ] **Step 7: Commit the npm installer**

```bash
git add package.json packages/worker-cli
git commit -m "feat: add npm worker installer wrapper"
```

### Task 3: Add first-class `uv` bootstrap support to existing worker installers

**Files:**
- Modify: `scripts/install-windows-worker.ps1`
- Modify: `scripts/install-linux-worker.sh`
- Test: `apps/api/tests/test_worker_bundle_assets.py`

- [ ] **Step 1: Add a failing asset-level test**

Extend `test_worker_scripts_wire_auto_update_configuration()` with assertions that look for `uv` in both installers:

```python
assert "Get-Command uv" in install_windows
assert "command -v uv" in install_linux
```

- [ ] **Step 2: Run the targeted API test and confirm failure**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_worker_bundle_assets.py -q
```

Expected: fail on missing `uv` support strings.

- [ ] **Step 3: Implement Windows `uv` fallback**

Update `Resolve-PythonBootstrap` to return one of:

```powershell
@($py.Source, "-3")
@($python.Source)
@($uv.Source, "python")
```

and keep the rest of the venv/bootstrap flow unchanged.

- [ ] **Step 4: Implement Linux `uv` fallback**

Update `resolve_python_bootstrap()` to prefer:

```bash
python3
python
py -3
uv python
```

Use the resolved launcher for `-m venv` bootstrap only. Do not rewrite the steady-state service execution path.

- [ ] **Step 5: Re-run the worker bundle test**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_worker_bundle_assets.py -q
```

Expected: pass.

- [ ] **Step 6: Commit the installer hardening**

```bash
git add scripts/install-windows-worker.ps1 scripts/install-linux-worker.sh apps/api/tests/test_worker_bundle_assets.py
git commit -m "fix: support uv bootstrap in worker installers"
```

### Task 4: Add a simpler Linux server install entrypoint

**Files:**
- Create: `scripts/install.sh`
- Modify: `scripts/deploy-website.sh`
- Modify: `docs/WEBSITE_DEPLOYMENT.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `apps/api/tests/test_selfhost_onboarding_assets.py`

- [ ] **Step 1: Add a thin wrapper script**

Create `scripts/install.sh` as:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$repo_root/scripts/install-selfhost-linux.sh" "$@"
```

- [ ] **Step 2: Publish the wrapper with the website deploy**

Update `scripts/deploy-website.sh` so it also copies:

```bash
cp "$source_root/scripts/install.sh" "$site_root/install.sh"
chmod +x "$site_root/install.sh"
```

- [ ] **Step 3: Document the new public entry**

Update docs to show:

```bash
curl -fsSL https://myagenthub.dev/install.sh | bash -s -- --domain agenthub.example.com --install-root /opt/agenthub --admin-email you@example.com
```

Keep the existing direct `scripts/install-selfhost-linux.sh` path documented as the repo-local option.

- [ ] **Step 4: Add onboarding assertions first**

Extend `test_selfhost_onboarding_assets_are_present_and_linked()` and `test_selfhost_docs_cover_from_empty_vm_to_worker_smoke()` so they require:

```python
"scripts/install.sh"
"install.sh | bash"
"https://myagenthub.dev/install.sh"
```

- [ ] **Step 5: Run the onboarding asset test**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_selfhost_onboarding_assets.py -q
```

Expected: pass.

- [ ] **Step 6: Commit the install UX docs and wrapper**

```bash
git add scripts/install.sh scripts/deploy-website.sh README.md README.en.md docs/WEBSITE_DEPLOYMENT.md apps/api/tests/test_selfhost_onboarding_assets.py
git commit -m "feat: add single-entry server install wrapper"
```

### Task 5: Run the focused verification suite and document the shipped surface

**Files:**
- Modify: `PROJECT_STATUS.md`

- [ ] **Step 1: Update project status**

Record that the repo now exposes:

- `@agenthub/worker` npm installer
- first-class `uv` fallback in bundle installers
- `scripts/install.sh` public Linux entrypoint

- [ ] **Step 2: Run the focused verification suite**

Run:

```powershell
npm run worker:cli:test
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_worker_bundle_assets.py -q
.\.venv\Scripts\python.exe -m pytest apps/api/tests/test_selfhost_onboarding_assets.py -q
```

Then run:

```powershell
git diff --check
```

Expected: all tests pass and no diff formatting errors appear.

- [ ] **Step 3: Commit status updates**

```bash
git add PROJECT_STATUS.md
git commit -m "docs: record install surface improvements"
```

## Self-Review

- Spec coverage: this plan implements the first-phase scope from the design doc only; Go contract freezing remains intentionally out of scope for this implementation round.
- Placeholder scan: no `TODO`, `TBD`, or vague “add error handling” language remains.
- Type consistency: `@agenthub/worker`, `buildInstallPlan()`, `scripts/install.sh`, and the `uv` bootstrap behavior are named consistently across tasks.

Plan complete and saved to `docs/superpowers/plans/2026-05-31-worker-installer-and-server-install-ux.md`. This round is already user-approved for execution, so continue inline with the first task set.
