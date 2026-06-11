# Public Website Deployment

This page covers the public root-domain website for the open-source AgentHub repo. It is separate from your self-hosted control plane.

## Recommended split

- `myagenthub.dev`: static website and release entry
- `www.myagenthub.dev`: redirect to `myagenthub.dev`
- `docs.myagenthub.dev`: redirect to GitHub docs
- `app.myagenthub.dev`: placeholder page for the future hosted surface
- `myagenthub.dev/release/`: versioned public release notes and checksum handoff
- `myagenthub.dev/press/`: public press kit with channel-ready launch copy and screenshot links
- `canary.myagenthub.dev`: your disposable Ubuntu self-host smoke environment

Do not point `canary` at the same machine as the public website if you want self-host smoke results to mean anything.

## Files

- static website source: `website/`
- nginx template: `deploy/nginx/agenthub-website.conf.template`
- deployment script: `scripts/deploy-website.sh`

## Expected prerequisites

- Debian/Ubuntu host with nginx already installed
- TLS certificates already present under `/etc/letsencrypt/live/<domain>/`
- root or sudo access

## Deploy

```bash
sudo bash scripts/deploy-website.sh \
  --domain myagenthub.dev \
  --site-root /var/www/agenthub-site \
  --github-repo YOUR_ORG/AgentHub-OSS
```

What it does:

- copies `website/` and selected brand/docs assets into `/var/www/agenthub-site`
- publishes `install.sh` at `https://<domain>/install.sh`
- renders `agenthub-website.conf`
- enables the nginx site
- reloads nginx after `nginx -t`

## Verify

```bash
curl -I https://myagenthub.dev
curl -I https://www.myagenthub.dev
curl -I https://docs.myagenthub.dev
curl -I https://app.myagenthub.dev
```

Expected:

- root website returns `200`
- `www` redirects to the root domain
- `docs` redirects to GitHub docs
- `app` returns a placeholder page, not a broken login

## Updating content

Edit:

- `website/index.html`
- `website/download/index.html`
- `website/press/index.html`
- `website/app/index.html`
- `website/release/index.html`
- `website/styles.css`

Then run the same deploy script again.
