# Worker Package Release

This page defines how `agenthub-worker` is versioned and published.

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
worker-v0.1.3
```

## Publish auth

The worker package can publish in two modes:

- preferred steady state: npm Trusted Publishing
- fallback path: npm automation token through `NPM_TOKEN`

Trusted Publishing configuration on npmjs.com:

```text
Provider: GitHub Actions
Organization or user: holdonyb
Repository: AgentHub-OSS
Workflow filename: npm-worker-publish.yml
Allowed actions: npm publish
```

The workflow grants `id-token: write`, uses Node 24, and lets npm exchange the GitHub Actions OIDC identity for a short-lived publish credential once the package is configured as a trusted publisher.

If `NPM_TOKEN` is present, the workflow uses the token path. If `NPM_TOKEN` is absent, it falls back to Trusted Publishing automatically.
The workflow reads `NPM_TOKEN` through a job-level env var and branches on `env.NODE_AUTH_TOKEN`, not `secrets.*` directly inside step conditions, so plain `main` pushes do not fail at workflow parse time.

Use the token path for first publish, emergency fallback, or until npm Trusted Publishing is configured for the package.

The publish command is `npm publish --access public` because scoped npm packages default to restricted/private access on first publish unless public access is explicit.

## Verification before publish

Run locally:

```bash
node scripts/check-worker-package-version.mjs
npm run worker:cli:test
```

For a tag-based release:

```bash
node scripts/check-worker-package-version.mjs --tag worker-v0.1.3
```

## Publish rule

Do not publish a worker package version that diverges from the repo version unless the versioning strategy is explicitly changed.

Today the intended rule is simple:

> `agenthub-worker` should use the same version as the repo.
