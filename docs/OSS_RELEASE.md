# AgentHub OSS Release

Use this flow when you want to refresh the public `AgentHub-OSS` repo from the private source tree without leaking private deployment details.

## Source and Target

- private source repo: `E:\Work\AgentHub`
- isolated export worktree: use the current feature branch or `origin/main`
- public target repo: `E:\Work\AgentHub-OSS`

## Export Command

From the private repo:

```powershell
.\scripts\export-oss.ps1 -TargetRoot E:\Work\AgentHub-OSS
```

What the export does:

- preserves the target `.git`
- clears old tracked content
- copies the source tree with `robocopy`
- excludes obvious private runtime directories
- excludes private deploy helper scripts
- preserves OSS-specific files already curated in `AgentHub-OSS`
- runs `scripts/audit-public-export.py`

## Preserved OSS Files

The export keeps the public-facing versions of:

- `README.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `CODE_OF_CONDUCT.md`
- `LICENSE`
- `PROVENANCE.md`
- `SECURITY.md`
- `.github/workflows/ci.yml`
- `.github/workflows/android-apk.yml`
- `.github/workflows/secret-scan.yml`

These files are intentionally treated as OSS overlay files instead of being overwritten blindly from the private repo.

## Audit

Run audit manually if needed:

```powershell
python .\scripts\audit-public-export.py --root E:\Work\AgentHub-OSS
```

The audit blocks common leaks such as:

- a private production domain literal
- a maintainer-specific handle literal
- private deploy env names
- private publish or deploy script names

## Recommended Release Loop

1. update private `main`
2. verify tests on the private repo
3. export into `AgentHub-OSS`
4. run audit
5. run public CI and build checks in `AgentHub-OSS`
6. review diff in `AgentHub-OSS`
7. push public repo and tag release

## Validation

Minimum checks after export:

```powershell
git -C E:\Work\AgentHub-OSS status --short
python E:\Work\AgentHub-OSS\scripts\audit-public-export.py --root E:\Work\AgentHub-OSS
npm --prefix E:\Work\AgentHub-OSS run web:build
```
