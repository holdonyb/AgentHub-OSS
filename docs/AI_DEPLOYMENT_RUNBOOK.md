# AI Deployment Runbook

Use this when another agent, contractor, or operator should deploy AgentHub quickly without rediscovering the setup model.

## Goal

Give the deployer one structured input file, then have them:

1. validate the input
2. choose the correct deployment mode
3. produce exact install commands
4. run the install
5. run smoke checks
6. hand back owner creation and worker onboarding steps

## Input Contract

Start from:

```text
docs/DEPLOYMENT_BRIEF.example.json
```

The deployer should fill or confirm:

- `mode`
  - `public_relay`
  - `tailscale_private`
  - `local_laptop`
- repository URL and branch
- server host/domain/install root
- whether the voice provider is enabled and which provider to use
- whether Windows/Linux/macOS workers are expected

## Validation Tool

Run:

```powershell
python scripts/render-deployment-brief.py --brief docs/DEPLOYMENT_BRIEF.example.json
```

The script prints:

- missing fields
- mode summary
- exact install command
- next validation command
- worker onboarding notes

If fields are missing, the script exits non-zero and lists the missing fields explicitly.

## Mode Rules

### public_relay

Use when:

- the server has a public DNS name
- workers can reach the server over outbound HTTPS
- you want the easiest self-host path

Required fields:

- `server.domain`
- `server.install_root`
- `server.admin_email`

### tailscale_private

Use when:

- server, workers, phone, and desktop are all in the same tailnet
- you want the smallest public attack surface

Required fields:

- `server.domain`
- `server.install_root`

`server.admin_email` is optional because `--skip-certbot` is the normal first step here.

### local_laptop

Use when:

- the user only wants a local control plane on one workstation
- no VM is required yet

Required fields:

- no public domain is required

## Voice provider

Voice is optional.

If the brief uses:

- `"provider": "none"`: deployment still works, voice features are simply unavailable
- `"provider": "doubao"`: server env must include the Doubao ASR values
- `"provider": "openai"`: server env must include `OPENAI_API_KEY` or `AGENTHUB_OPENAI_ASR_API_KEY`

This means missing voice credentials should not block a normal self-host install unless the operator explicitly wants voice.

## Recommended Agent Output

After reading the brief, the deploying agent should return:

1. deployment mode
2. exact install command
3. exact smoke command
4. owner creation URL
5. Add Worker / worker bundle next step
6. any missing fields still required

## Fast Rule

If the deployer is missing critical information, they should ask only for the missing fields, not restart the whole design discussion.
