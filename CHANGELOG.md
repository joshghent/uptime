# Changelog

Every release has a section here, and the release workflow publishes it as the
GitHub Release notes. **Action required** means an update needs something from
you beyond merging — a migration, a config change, a new secret.

Versions are semver against what an operator sees: a major means your config,
your database or your deploy needs a hand.

## 1.1.0 — 2026-08-17

An update path. Until now a fork carried a permanent diff against upstream and
had no way to tell whether its schema matched its code.

**Action required, once.** Your monitors move out of this repository's history
and into your fork's:

```sh
git fetch upstream && git merge upstream/main
# `git status` now shows status.yaml as untracked. It is yours — commit it.
git add status.yaml && git commit -m "Keep my monitors"
```

If you deploy with Cloudflare Workers Builds rather than Actions, set its
deploy command to `pnpm run deploy` so migrations are applied before the code
that needs them.

### Added

- `/health` returns JSON: the version, the newest migration, and whether it has
  been applied. It answers `503` when the database is behind, so pointing one
  monitor at your own `/health` turns a forgotten migration into an ordinary
  incident with an ordinary alert.
- The version appears in the page footer and in `/api/status`.
- `.github/workflows/upstream-sync.yml` opens a weekly PR bringing your fork up
  to date. Your CI runs on it before you merge.
- `.github/workflows/release.yml` publishes a GitHub Release from a `v*` tag,
  refusing a tag that disagrees with `package.json`.
- Dependabot, issue and PR templates, CONTRIBUTING, SECURITY and a code of
  conduct.

### Changed

- `status.yaml` is no longer tracked upstream. `status.example.yaml` is the
  template; the copy you edit is yours, so a merge from upstream can never
  conflict with your monitors. `pnpm dev`, `test`, `lint:config` and `deploy`
  create it on first run.
- `wrangler.jsonc` ships placeholders instead of one deployment's real domain
  and database id.
- `pnpm run deploy` applies migrations before deploying, rather than leaving
  them to be remembered.
- `/health` used to return `ok\n` as plain text. A check asserting the body
  contains `ok` still passes; one comparing the whole body exactly does not.

## 1.0.0 — 2026-08-07

First release. HTTP and heartbeat monitors, ntfy and webhook alerts, 90 days of
uptime bars, a JSON API and `/llms.txt`, all from one YAML file on Cloudflare
Workers and D1.
