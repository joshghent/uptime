# Security policy

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub's private reporting — the **Security** tab on this repository, then
**Report a vulnerability**. If that is unavailable to you, contact the
maintainer through the address on their GitHub profile.

Include what you found, how to reproduce it, and what an attacker gets. A first
response should come within a week.

## Supported versions

The latest release. This is a self-hosted page you deploy from your own fork:
fixes ship as a new release, and you take them by merging.

## What is in scope

The code in this repository, and the way a default deployment is configured:

- The heartbeat receiver `/ping/:id` and its token check
- Anything reaching the page's HTML or JSON without escaping
- Secret handling — `${VAR}` interpolation, `.dev.vars`, wrangler secrets
- Config parsing, including a `status.yaml` written by someone else

Out of scope: Cloudflare's own platform (report those to Cloudflare), and the
availability of whatever you happen to be monitoring.

## Notes for anyone running this

- `/` and `/api/status` are public and CORS-open by design. Monitor names,
  descriptions and incident reasons are shown to anyone who visits, and an
  incident reason can carry part of an upstream error message. Keep anything
  private out of a monitor's `name` and `description`.
- `/health` reports the version you are running. If you would rather it did
  not, put the page behind Cloudflare Access.
- Heartbeat tokens travel in the URL when sent as `?token=`, which means they
  land in logs. Prefer the `Authorization: Bearer` header, and give each
  heartbeat its own token.
- Never commit `.dev.vars`. Secrets belong in `wrangler secret put`.
