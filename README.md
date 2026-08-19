# uptime

[![CI](https://github.com/joshghent/uptime/actions/workflows/ci.yml/badge.svg)](https://github.com/joshghent/uptime/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/joshghent/uptime?sort=semver)](https://github.com/joshghent/uptime/releases)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

A status page that runs on Cloudflare Workers and D1. Your monitors live in one
YAML file, checked by a cron, rendered as a single server-side page.

Free on Cloudflare's free tier for a handful of monitors. No dashboard to click
through, no per-monitor pricing, no vendor holding your incident history.

- HTTP/HTTPS checks with status, body and latency assertions
- Heartbeat monitors: your cron pings *us*, and a missed ping is an incident
- Alerts to [ntfy](https://ntfy.sh) and any webhook, globally or per monitor
- 90 days of uptime bars, incident history, and a JSON API
- `/llms.txt` and a CORS-open JSON API, so an agent reads it in one fetch
- One config file, linted before you deploy

## Quick start

Fork this repository first, then clone your fork — updates arrive as a pull
request against it, and your config lives there.

```sh
git clone https://github.com/<you>/uptime && cd uptime
pnpm install
pnpm setup                             # creates status.yaml and .dev.vars

npx wrangler d1 create uptime          # copy the database_id into wrangler.jsonc
pnpm run db:migrate                    # create the tables

# edit status.yaml, then
pnpm lint:config
pnpm run deploy

git add status.yaml && git commit -m "My monitors"   # your fork owns this file
```

Your page is live at `https://uptime.<your-subdomain>.workers.dev`.

To put it on your own domain, add a route to `wrangler.jsonc` and deploy again —
wrangler creates the DNS record for you, as long as the zone is already in the
same Cloudflare account:

```jsonc
"routes": [{ "pattern": "status.example.com", "custom_domain": true }]
```

Pick a domain none of the monitored apps serve. A status page that shares
infrastructure with the thing it watches goes down at exactly the wrong moment.

> `pnpm deploy` is a built-in pnpm command. Use `pnpm run deploy`.

## Configuration

Everything lives in `status.yaml`. Change it, deploy, done.

That file is yours: this repository ships
[`status.example.yaml`](status.example.yaml) as the template and does not track
the copy you edit, so pulling an update can never collide with your monitors.
Commit it to your fork — the deploy bundles it.

```yaml
title: Acme Status
description: Live availability for everything we run.
link: https://acme.com

retain_days: 7          # raw check results kept; the 90-day bars use rollups

defaults:               # inherited by every monitor
  interval: 1m
  timeout: 10s
  expect_status: 2xx
  failures_before_alarm: 2

notify:
  ntfy: ${NTFY_URL}

monitors:
  - name: Website
    url: https://acme.com

  - name: API
    url: https://api.acme.com/health
    expect_status: [200]
    expect_body: '"status":"ok"'
    degraded_ms: 800
    failing_for: 5m

  - name: Nightly backup
    type: heartbeat
    period: 24h
    grace: 1h
```

### Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `title` | string | `Status` | Page title and header |
| `description` | string | — | Sub-line under the header, and the meta description |
| `link` | URL | — | Where the header logo links; usually your product |
| `retain_days` | int > 0 | `7` | Days of raw check results kept. The 90-day bars read daily rollups, so this only bounds the recent-window alarm rules |
| `defaults` | map | `{}` | Inherited by every monitor |
| `notify` | map | — | Where alerts go |
| `monitors` | list | — | At least one required |

Unknown keys are rejected rather than ignored, at every level — a typo is a
lint failure, not a setting that silently does nothing.

`defaults` takes `interval`, `timeout`, `expect_status`,
`failures_before_alarm`, `failing_for` and `degraded_ms`. Each means what it
means on a monitor, and a monitor that sets the key wins. `expect_status` only
reaches HTTP monitors.

### Monitor options

| Key | Applies to | Default | Meaning |
|---|---|---|---|
| `name` | both | — | Required. Shown on the card |
| `id` | both | slug of `name` | Stable key used in the database, the JSON and `/ping/:id`. Lowercase `a-z`, `0-9` and `-`, unique. Change it and the monitor's history starts over |
| `description` | both | — | Sub-line on the card |
| `type` | both | `http` | `http` or `heartbeat` |
| `interval` | both | `60s` | How often to check. On a heartbeat this is how often its freshness is re-evaluated, not how often you have to ping — that is `period` |
| `timeout` | both | `10s` | Request timeout. Only bites on HTTP |
| `failures_before_alarm` | both | `2` | Consecutive failures that open an incident |
| `failing_for` | both | — | Failure streak duration that opens an incident |
| `degraded_ms` | both | — | Slower than this and a passing check counts as degraded, not down. Only bites on HTTP |
| `notify` | both | inherits global | `ntfy` and/or `webhook` for this monitor, per target |
| `url` | http | — | Required. What to request |
| `method` | http | `GET` | Any HTTP method; upper-cased for you |
| `headers` | http | — | Request headers |
| `body` | http | — | Request body |
| `expect_status` | http | `2xx` | `200`, `[200, 204]`, or a class like `2xx` |
| `expect_body` | http | — | Substring the response body must contain. Only set it when you need it — it forces the body to be read, which counts toward latency |
| `period` | heartbeat | — | Required. How often the job is expected to ping |
| `grace` | heartbeat | `0` | Extra slack on top of `period` before a missing ping counts |
| `token` | heartbeat | — | Required on the ping if set. Use `${VAR}` |

Durations are `500ms`, `30s`, `5m`, `24h`, `2d`, or a bare number of seconds.

Redirects are followed. Latency is measured after the body is read.

### Alarm rules

`failures_before_alarm` and `failing_for` answer different questions: "how many
in a row" and "for how long". Set one, or set both and the first to trip wins.
Setting only `failing_for` removes the count default, so a duration rule is not
pre-empted by two quick failures.

Between the first failure and the alarm a monitor shows as **Degraded** rather
than green, so a wobble is visible before it becomes an incident.

### Secrets

Any `${VAR}` in `status.yaml` is replaced from the Worker's environment:

```sh
npx wrangler secret put NTFY_URL
```

For local development put the same names in `.dev.vars` (copy
`.dev.vars.example`). A missing variable fails the lint and the deploy with the
variable named, rather than a mystery URL error.

## Heartbeat monitors

For things that run on a schedule and have nothing to poll — cron jobs, backups,
queue workers. The job calls your status page when it finishes:

```sh
curl -fsS "https://uptime.example.workers.dev/ping/repowarden-daily-scan?token=$HEARTBEAT_TOKEN"
```

The token can also go in an `Authorization: Bearer` header. If no ping arrives
within `period + grace`, an incident opens like any other failure.

A heartbeat that has never been pinged records nothing and never alerts, so you
can add one before the job is wired up. The first ping starts the clock — after
that, silence is a failure. A one-off test ping counts, so do not send one until
the job really is sending them.

Ping last, after the job's work, and only on success. A run that throws then
never pings, and the missing ping is what raises the alert.

## Notifications

Both targets fire when an incident opens and again when it resolves.

```yaml
notify:
  ntfy: https://ntfy.sh/my-topic
  webhook:
    url: https://hooks.example/incoming
    headers:
      authorization: Bearer ${WEBHOOK_TOKEN}
```

The webhook receives:

```json
{
  "monitor": "api",
  "name": "API",
  "event": "down",
  "reason": "unexpected status 503",
  "at": "2026-08-07T12:34:56.000Z"
}
```

A notification that fails is logged; it never blocks a check from recording.

## Endpoints

| Path | What |
|---|---|
| `GET /` | The status page |
| `GET /api/status` | The same data as JSON, CORS-open |
| `GET \| POST /ping/:id` | Heartbeat receiver |
| `GET /health` | Liveness, the version you are running, and whether the database is migrated |
| `GET /llms.txt` | The whole reference — endpoints, JSON shape, every config key — as plain text |

### For agents

`/api/status` is the machine-readable status: same data as the page, same
query, CORS-open. `/llms.txt` describes it and the config format in one fetch,
so an agent never has to scrape the HTML or read this repo. Both are linked
from the footer of every page.

```sh
curl -s https://status.example.com/llms.txt
curl -s https://status.example.com/api/status | jq '.monitors[] | {id, state, uptime}'
```

The JSON shape is documented in [`llms.txt`](llms.txt) — timestamps are Unix
seconds UTC, `state` is `up | degraded | down | unknown`, `uptime` is a
fraction over `windowDays` or `null` when nothing has been recorded, and `days`
always holds `windowDays` entries oldest first.

## How it works

A cron fires every minute. Each monitor is skipped unless its own `interval` has
elapsed, so the cron frequency is a ceiling, not the check rate.

Every result is written twice: once to `samples`, and once into a per-day
rollup. The alarm rules read the recent samples; the 90-day bars read the
rollups. That keeps the page one indexed query per table no matter how long the
page has been running, and lets raw samples be pruned after `retain_days`.

A day bar is red if any check failed that day, yellow if any was degraded, green
if all passed, and grey if nothing ran. Uptime is `passed / (passed + failed)`
across the window.

Incidents are rows in `incidents` with a partial unique index, so a monitor can
only ever have one open at a time — no duplicate alerts if a cron overlaps.

## Development

```sh
pnpm run db:migrate:local   # create the local tables
pnpm dev                    # http://localhost:8787
pnpm test                   # vitest, running inside workerd against real D1
pnpm lint                   # typecheck + config lint
```

`pnpm dev` will not run the cron on a schedule. Trigger one by hand:

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## Deploying

`pnpm run deploy` applies migrations and then deploys, in that order, so the
schema is never behind the code that reads it.

Cloudflare Workers Builds deploys on every push to `main` once the repo is
connected. Set its deploy command to `pnpm run deploy` rather than the default
`npx wrangler deploy`, so migrations travel with the code.

To deploy from GitHub Actions instead, set the repo variable
`DEPLOY_VIA_ACTIONS` to `true`, add a `CLOUDFLARE_API_TOKEN` secret, and turn
Workers Builds off so the two don't race. That job migrates before deploying
too.

If a migration is ever missed, `/health` answers `503` and says which one is
outstanding. Point a monitor at your own `/health` — the shipped example config
has one — and the page tells you through the same alerts as everything else.

## Updating

Releases are tagged and published on the
[releases page](https://github.com/joshghent/uptime/releases), with notes taken
from [CHANGELOG.md](CHANGELOG.md). Anything you have to do by hand is under
**Action required**, so read that before merging.

Point your fork at upstream once:

```sh
git remote add upstream https://github.com/joshghent/uptime.git
```

Then, whenever you want the update:

```sh
git fetch upstream
git merge upstream/main
pnpm lint && pnpm test
git push            # your deploy runs
```

Your `status.yaml` and the `database_id` in `wrangler.jsonc` are the only files
you have changed, and upstream does not touch either, so the merge is normally
a fast-forward with nothing to resolve.

Prefer it to come to you? [`upstream-sync.yml`](.github/workflows/upstream-sync.yml)
is already in your fork. Enable Actions on your fork and give it a token: a
[fine-grained PAT](https://github.com/settings/personal-access-tokens) scoped to
that fork with **Contents**, **Pull requests** and **Workflows** set to read and
write, stored as a `SYNC_TOKEN` secret (`gh secret set SYNC_TOKEN`). The token
is required rather than a convenience — GitHub refuses to let the built-in
Actions token push a change to any file under `.github/workflows/`, and updates
here do change workflows. Then it opens a "Sync from upstream" PR every Monday. Your CI runs against your own
config on that PR, so you see it green before you merge — and merging is what
deploys. Run it on demand from the Actions tab any time.

Check what a running page is on:

```sh
curl -s https://status.example.com/health
{"status":"ok","version":"1.1.0","latestMigration":"0002_prune_index.sql","migrationsApplied":true}
```

The version is in the page footer and in `/api/status` as well.

## How fast you hear about it

Detection time is `interval x failures_before_alarm`. The shipped config runs
every monitor at `1m` with two consecutive failures, so an outage alerts about
two minutes in. One minute is Cloudflare's cron floor, so that is the fastest
this design goes. Alarming on a single failure halves it and pages you for
every transient blip; that trade is yours to make.

The notification itself is sent inside the same cron invocation that opens the
incident, so there is no further delay once the threshold trips.

## Cost

Every check is two D1 writes. Seven monitors at a one-minute interval is about
20,000 writes a day against a free-tier allowance of 100,000, and roughly
65,000 rows read against an allowance of 5,000,000.

Keep it that way by never putting an unindexed query in the cron path. Two
queries there run 1,440 times a day against a table that grows all day, so a
sequential scan is the one mistake that turns a free status page into a bill.
`test/query-plan.test.ts` asserts the plans and fails if an index is lost.

## Branding

The page uses the Turbo Technologies design tokens, vendored in
`src/tokens.css`. To rebrand a fork, replace that file with your own tokens —
`src/app.css` only ever references the semantic `--tt-color-*` names, so nothing
else needs touching.

The "Run your own" section links back here via one `REPO` constant at the top of
`src/page.ts`. Point it at your fork, or delete the section.

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has
the dev loop, the house style, and how migrations and releases work. Security
issues go through [SECURITY.md](SECURITY.md), privately, not the issue tracker.

## Licence

MIT.
