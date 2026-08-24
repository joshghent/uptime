# Changelog

Every release has a section here, and the release workflow publishes it as the
GitHub Release notes. **Action required** means an update needs something from
you beyond merging — a migration, a config change, a new secret.

Versions are semver against what an operator sees: a major means your config,
your database or your deploy needs a hand.

## 1.2.0 — 2026-08-24

No action required. Merge and deploy; there is no migration and no config
change.

### Added

- **Event history.** The section that was "Incident history" now lists the days
  behind every coloured bar, not just the incidents. A bar goes red on a single
  failed check and amber on a single slow one, and neither has to meet
  `failures_before_alarm` — so a page could show a week of red and amber with an
  empty incident list and no way to find out what happened. Days an incident
  already covers are not listed twice.
- The history shows five entries and expands to the rest in place, and filters
  to one service with `?monitor=<id>`. Both are plain HTML — no client
  JavaScript, and a filtered view has a URL you can send someone.
- `/api/status` gained `events` (the same history, newest first, capped at 50
  rows per monitor) and `monitors[].observedDays`.

### Fixed

- A monitor's uptime read `99.98% uptime` under a "90 days ago … Today" scale
  even when it had two days of data. The figure itself never counted the empty
  days — it is `passed / (passed + failed)` and always was — but nothing on the
  page said what it was measured over. It now reads `99.98% over 2 days`, and
  the API says so as `observedDays`.

## 1.1.1 — 2026-08-19

**Action required if you use the sync workflow.** It now needs a `SYNC_TOKEN`
secret — a fine-grained PAT scoped to your fork with Contents, Pull requests and
Workflows set to read and write. Without one it cannot carry an update that
changes a workflow file, which this release does.

### Fixed

- The sync workflow could not push any update that touched
  `.github/workflows/`. GitHub refuses that push from the built-in Actions
  token, and no `permissions:` scope grants it, so every release that changed a
  workflow would have failed on every fork. It uses `SYNC_TOKEN` when present
  and explains itself when the push is refused. Merging by hand was never
  affected: `git fetch upstream && git merge upstream/main`.

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

### Fixed

- The sync workflow reported success when it could not open the pull request,
  so a sync that never ran looked exactly like a sync with nothing to do. Only
  an already-open PR is treated as benign now; anything else fails the job with
  the real error. Note that "Allow GitHub Actions to create and approve pull
  requests" is enforced at the account level as well as the repository level,
  and the account setting wins.
- Pinned `nanoid` past GHSA-mwcw-c2x4-8c55 with a pnpm override. It arrives
  through vite and postcss, so it is dev-only and never reaches the deployed
  Worker, and dependabot cannot bump a transitive pnpm dependency by itself.

## 1.0.0 — 2026-08-07

First release. HTTP and heartbeat monitors, ntfy and webhook alerts, 90 days of
uptime bars, a JSON API and `/llms.txt`, all from one YAML file on Cloudflare
Workers and D1.
