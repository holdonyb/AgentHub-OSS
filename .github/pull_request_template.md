## Summary

- What changed?
- Why was it needed?

## Validation

- [ ] `npm run api:test`
- [ ] `npm run web:test`
- [ ] `npm run web:build`
- [ ] `npm run desktop:test`
- [ ] `npm run mobile:test`
- [ ] Other focused verification:

## Risk

- [ ] Auth / session / worker token boundary changed
- [ ] Release packaging or client bootstrap changed
- [ ] Self-host / Tailscale docs changed
- [ ] No known production-facing risk beyond the scope above

## Notes for reviewers

- Config remains environment-driven; no maintainer-specific domains, secrets, or private infra details were introduced.
