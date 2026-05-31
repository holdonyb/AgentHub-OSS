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

## Trusted Publishing

`@agenthub/worker` should publish through npm Trusted Publishing, not a long-lived token.

Configure the trusted publisher on npmjs.com with:

```text
Provider: GitHub Actions
Organization or user: holdonyb
Repository: AgentHub-OSS
Workflow filename: npm-worker-publish.yml
Allowed actions: npm publish
```

The workflow grants `id-token: write`, uses Node 24, and lets npm exchange the GitHub Actions OIDC identity for a short-lived publish credential.

Do not add `NPM_TOKEN` unless this project deliberately falls back to token-based publishing.

The publish command is `npm publish --access public` because scoped npm packages default to restricted/private access on first publish unless public access is explicit.

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
