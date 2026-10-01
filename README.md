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
- 90 days of uptime bars, a filterable event history, and a JSON API
- `/llms.txt` and a CORS-open JSON API, so an agent reads it in one fetch
- One config file, linted before you deploy
- Updates arrive by themselves: a release opens a Dependabot pull request,
  your CI proves it against your config and merges it, and Cloudflare deploys

## Quick start

```sh
npm create uptime my-status && cd my-status
npm install
npx wrangler d1 create uptime     # copy the database_id into wrangler.jsonc
# edit status.yaml, then
npm run lint
```

That directory is your whole status page: `status.yaml`, a three-line
`worker.js`, `wrangler.jsonc`, and a workflow that keeps it up to date.
Everything else comes from the [`@joshghent/uptime`](https://www.npmjs.com/package/@joshghent/uptime)
package.

Push it to a GitHub repository, then connect that repository in the Cloudflare
dashboard under **Workers & Pages → Create → Import a repository**. Leave the
build settings at their defaults. Every push to `main` deploys, and the Worker
creates its own tables on the first request — there is no migration step.

Your page is live at `https://uptime.<your-subdomain>.workers.dev`.

To put it on your own domain, add a route to `wrangler.jsonc` and push —
wrangler creates the DNS record for you, as long as the zone is already in the
same Cloudflare account:

```jsonc
"routes": [{ "pattern": "status.example.com", "custom_domain": true }]
```

Pick a domain none of the monitored apps serve. A status page that shares
infrastructure with the thing it watches goes down at exactly the wrong moment.

## Configuration

Everything lives in `status.yaml`. Change it, push, done. The deploy bundles
it into the Worker, and updates to the package never touch it.

```yaml
title: Acme Status
description: Live availability for everything we run.
link: https://acme.com

retain_days: 7          # raw check results kept; the 90-day bars use rollups
day_down_below: 99.5    # a day is red only below this pass rate; amber above it
day_degraded_below: 99.5  # and amber only when under 99.5% of checks were clean

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
| `version` | int | `1` | Which shape of this file it is. A release that changes the shape upgrades older files in memory, so an update never needs you to edit it |
| `title` | string | `Status` | Page title and header |
| `description` | string | — | Sub-line under the header, and the meta description |
| `link` | URL | — | Where the header logo links; usually your product |
| `retain_days` | int > 0 | `7` | Days of raw check results kept. The 90-day bars read daily rollups, so this only bounds the recent-window alarm rules |
| `day_down_below` | 0–100 | `100` | A day's bar goes red only when its pass rate is below this percentage; failures above it colour the day amber. `100` makes any failed check a red day |
| `day_degraded_below` | 0–100 | `100` | A day's bar goes amber only when the share of its checks that passed in time — not failed, not slower than `degraded_ms` — is below this percentage. `100` makes any single slow or failed check an amber day |
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
`.dev.vars.example`). A missing variable fails the lint with the variable
named, rather than a mystery URL error, and the page says the same if one is
missing in production.

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
| `GET /` | The status page. `?monitor=<id>` filters the event history to one service |
| `GET /api/status` | The same data as JSON, CORS-open |
| `GET \| POST /ping/:id` | Heartbeat receiver |
| `GET /health` | Liveness, the version you are running, and whether the database is up to date |
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
seconds UTC, `state` is `up | degraded | down | unknown`, `uptime` is a fraction
over the days that recorded a check (`observedDays`) or `null` when nothing has
been recorded, `days` always holds `windowDays` entries oldest first, and
`events` is the history the page renders.

## How it works

A cron fires every minute. Each monitor is skipped unless its own `interval` has
elapsed, so the cron frequency is a ceiling, not the check rate.

Every result is written twice: once to `samples`, and once into a per-day
rollup. The alarm rules read the recent samples; the 90-day bars read the
rollups. That keeps the page one indexed query per table no matter how long the
page has been running, and lets raw samples be pruned after `retain_days`.

A day bar is grey if nothing ran. Otherwise it is red when the day's pass rate
is under `day_down_below`, amber when the share of checks that passed in time is
under `day_degraded_below`, and green if neither. Both default to 100, so out of
the box one failed check is a red day and one slow one an amber day. Uptime is `passed / (passed + failed)`
over the days that recorded a check — a monitor you added yesterday reports on
its one day of data, not on 89 days that predate it.

Incidents are rows in `incidents` with a partial unique index, so a monitor can
only ever have one open at a time — no duplicate alerts if a cron overlaps.

The event history is built from both. An incident needs its alarm rule to trip;
a bar goes red on a single failed check and yellow on a single slow one, neither
of which alarms. So the history lists incidents *and* the bad days no incident
covers, which is what makes every colour on the page traceable to a row. It
shows five, expands to the rest in place, and filters to one service.

## Running it locally

In your status page's directory:

```sh
npm run dev       # http://localhost:8787, secrets from .dev.vars
npm run check     # what CI runs on every update: lint, build, boot
```

`npm run dev` will not run the cron on a schedule. Trigger one by hand:

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## Updating

Updates come to you. `.github/dependabot.yml` watches `@joshghent/uptime` and
opens a pull request when a release comes out. `.github/workflows/check.yml`
runs `npm run check` on it — your `status.yaml` validated, the Worker built,
then booted against an empty database and loaded — and merges it when that
passes. Cloudflare deploys `main`, and the new Worker brings the database up to
date itself on its first request.

None of that needs a token, a secret or a setting, and nothing runs on a
schedule of its own, so it does not stop when the repository goes quiet.

Minor and patch releases merge themselves. A major waits for you: its notes in
[CHANGELOG.md](CHANGELOG.md) and on the
[releases page](https://github.com/joshghent/uptime/releases) have a section
marked **Action required** that says what to do. A change to the shape of
`status.yaml` is not one of those — older files keep working.

If a check fails, the pull request stays open with the reason, and the page
keeps running the version it has.

Check what a running page is on:

```sh
curl -s https://status.example.com/health
{"status":"ok","version":"2.0.0","latestMigration":"0002_prune_index.sql","migrationsApplied":true}
```

`/health` answers `503` if the database could not be brought up to date. Point
a monitor at your own `/health` — the example config has one — and the page
tells you through the same alerts as everything else. The version is in the
page footer and in `/api/status` as well.

### Coming from a fork

Before 2.0 a status page was a fork of this repository, updated by merging.
The 2.0.0 entry in [CHANGELOG.md](CHANGELOG.md) has the steps to move one onto
the package; it keeps the same Worker, database and history.

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
`src/tokens.css`, and a "Run your own" section linking back here. Neither is
configurable from `status.yaml` yet; open an issue if you need it to be.

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has
the dev loop for working on the package, the house style, and how migrations,
config changes and releases work. Security
issues go through [SECURITY.md](SECURITY.md), privately, not the issue tracker.

## Licence

MIT.
