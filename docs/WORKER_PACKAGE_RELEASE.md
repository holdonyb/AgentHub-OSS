# Worker Package Release

This page defines how `@agenthub/worker` is versioned and published.

## Current rule

For now, the worker package keeps the same version as the repo root package.

That means:

- root `package.json`
- `packages/worker-cli/package.json`

must stay on the same version as the repo until AgentHub has a reason to version the worker independently.

## Release trigger

The worker package publish workflow is:

- `.github/workflows/npm-worker-publish.yml`

It supports:

- manual `workflow_dispatch`
- tag push with the `worker-v` prefix

Example tag:

```text
worker-v0.1.1
```

## Required secret

GitHub Actions needs:

```text
NPM_TOKEN
```

with publish access for the target npm scope.

## Verification before publish

Run locally:

```bash
node scripts/check-worker-package-version.mjs
npm run worker:cli:test
```

For a tag-based release:

```bash
node scripts/check-worker-package-version.mjs --tag worker-v0.1.1
```

## Publish rule

Do not publish a worker package version that diverges from the repo version unless the versioning strategy is explicitly changed.

Today the intended rule is simple:

> `@agenthub/worker` should use the same version as the repo.
