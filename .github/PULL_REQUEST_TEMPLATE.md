<!-- Title this pull request as a conventional commit — `fix: …`, `feat: …`,
`feat!: …` for a breaking change, or `chore:`/`docs:`/`ci:` for no release.
It becomes the squash commit, which decides the next version. -->

## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Checks

- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm test:template` passes, if the package or template changed

## Does anyone running this have to do something?

<!-- Minor and patch releases merge into every deployment with nobody looking.
Migrations and status.yaml shape changes are handled for them (see
CONTRIBUTING). If this needs anything else — a new secret, a wrangler.jsonc
change — it is a major: title the PR `feat!:` or `fix!:`, and put the steps in
the squash commit body after `BREAKING CHANGE:`. That becomes the release
notes. If not, delete this section. -->
