# AgentHub OSS Release

`AgentHub-OSS` is now the only product trunk.

There is no private-to-public export step anymore. Product code lands here first, is reviewed here, and releases from here. The private side is a thin `AgentHub-overlay` repo for deploy scripts, secret-handling conventions, and private strategy docs.

## Repo Roles

- `AgentHub-OSS`: product code, tests, public docs, release assets
- `AgentHub-overlay`: private deploy scripts, env examples, private planning docs

Do not reintroduce an export flow that rewrites this repo from a private source tree.

## Release Flow

1. Land product changes on a feature branch in `AgentHub-OSS`.
2. Run the public validation gates:
   - `python scripts/audit-public-export.py --root .`
   - `npm run api:test`
   - `npm run web:test`
   - `npm run web:build`
   - `npm run desktop:test`
   - `npm run mobile:test`
3. Merge to `main` through a pull request.
4. Release from `main`:
   - GitHub Release
   - website `/release/`
   - website `/download/`
   - worker package if version changed

## Audit Gate

Install the local pre-commit hook:

```powershell
.\scripts\install-hooks.ps1
```

The hook and CI both run:

```powershell
python .\scripts\audit-public-export.py --root .
```

The audit is now an entry gate for OSS work, not an export-stage cleanup tool.

## Overlay Use

Use the overlay repo only for:

- VM deploy scripts
- traffic monitor scripts
- APK publish helpers
- private docs such as rotation and strategy notes

Overlay must not contain product code.

## Validation

Minimum release checks:

```powershell
python .\scripts\audit-public-export.py --root .
npm run web:build
git diff --check
```
