# Changelog

Every release has a section here, and the release workflow publishes it as the
GitHub Release notes. **Action required** means an update needs something from
you beyond merging.

Versions are semver against what an operator sees. Minor and patch releases
merge into your status page by themselves once its check passes, so they never
need a hand; migrations and changes to the shape of `status.yaml` are handled
for you. A major waits for you, and says what to do.

## 2.1.0 — 2026-10-01

No action required. This merges into your status page by itself.

### Added

- `day_degraded_below` does for amber what `day_down_below` does for red: a
  day's bar is amber only when the share of its checks that passed in time —
  not failed, not slower than `degraded_ms` — falls below it. The default,
  `100`, keeps today's colours. Set `day_degraded_below: 99.5` and a day with
  one slow response or one stray failure out of 1,440 stays green, while a
  day with a real slowdown still turns amber. The event history follows the
  colours, so a day left green lists nothing.
- The README shows the page.

### Fixed

- A new status page no longer reports five high-severity vulnerabilities on
  `npm install`. They came from the local-development tooling in wrangler
  4.119.0 and never reached the deployed Worker; wrangler is now 4.146.0.
  Releases now fail if a fresh install has any high-severity advisory.
- A release that stops partway through publishing can be finished by
  re-running it.

## 2.0.0 — 2026-10-01

uptime is now an npm package, `@joshghent/uptime`, instead of a repository you
fork. A status page is a repository of its own with four files in it —
`status.yaml`, a three-line `worker.js`, `wrangler.jsonc` and a workflow — and
updates reach it as Dependabot pull requests that prove themselves against your
config and merge themselves. No token, no secret, no merging upstream.

**Action required if you run a fork.** Move it onto the package once; after
that there is nothing to do for minor and patch releases. It keeps the same
Worker, the same database and the same history, and the same repository, so
Cloudflare Workers Builds stays connected. In your fork:

```sh
git switch -c move-to-package

# Keep your monitors, drop everything else.
git rm -rq . && git checkout HEAD -- status.yaml

# Bring in the template, then put your status.yaml back over its example.
npm create uptime@2 ../uptime-template
cp -r ../uptime-template/. . && rm -rf ../uptime-template
git checkout HEAD -- status.yaml
```

Then copy three things from your old `wrangler.jsonc` (`git show
HEAD:wrangler.jsonc`) into the new one: your `database_id`, your `routes` if
you set one, and your `name` if you changed it from `uptime`. A different name
deploys a different Worker.

```sh
npm install
npm run check        # your config, the build, and the Worker booted locally
git add -A && git commit -m "Move onto @joshghent/uptime"
```

Open that as a pull request and merge it; Workers Builds deploys it as usual.

- If you set the Workers Builds deploy command to `pnpm run deploy` for 1.1.0,
  set it back to the default, `npx wrangler deploy`. Migrations no longer run
  there.
- The database needs nothing. Its `d1_migrations` table already lists both
  migrations, and the Worker reads the same table.
- Delete the `SYNC_TOKEN` secret and the token behind it, and the `upstream`
  remote if you added one.

### Added

- `createWorker(source)`, the whole Worker around the text of a `status.yaml`.
- The Worker applies its own migrations, on the first request or cron run in
  each isolate, into wrangler's own `d1_migrations` table. A release that adds
  a migration needs nothing from you.
- `status.yaml` takes a `version:` (missing means 1). A release that changes
  the shape of the file upgrades older ones in memory, so an update never needs
  your config edited.
- The `uptime` command: `uptime lint`, `uptime check` (lint, a dry-run build,
  then the Worker booted against an empty local database and its page and
  `/health` loaded) and `uptime init`. `npm create uptime` runs `uptime init`.
- A template deployment with a Dependabot config and a workflow that runs
  `uptime check` on every pull request and merges minor and patch updates of
  the package when it passes.
- Releases publish both packages to npm, with provenance.

### Changed

- `/health` answers `503` when the Worker could not bring the database up to
  date, rather than when a migration was not run by hand.
- `status.example.yaml` is now `template/status.yaml`, and `pnpm lint:config`
  in a status page is `npm run lint`.

### Removed

- The upstream sync workflow and its `SYNC_TOKEN`, the Actions deploy job and
  `DEPLOY_VIA_ACTIONS`, and the `deploy` and `db:*` scripts. `wrangler d1
  migrations apply` still works against a deployment's database, but nothing
  needs it.

## 1.3.0 — 2026-09-30

No action required. Merge and deploy; there is no migration, and the new
setting defaults to today's behaviour.

### Added

- **`day_down_below`.** A day's bar goes red only when its pass rate falls below
  this percentage; failures above it colour the day amber, and the event
  history lists it as degraded rather than an outage. At one check a minute a
  single dropped request is 0.07% of the day, and it painted the same red as an
  hour offline. Defaults to `100`, which keeps the old rule — set it (99.5 is a
  sensible start) to opt in.

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
