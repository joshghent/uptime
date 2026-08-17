# Contributing

Bug reports, config-format papercuts and small focused pull requests are all
welcome. If a change is large or reshapes how the page works, open an issue
first — it is cheaper to disagree about an idea than about a diff.

## Getting set up

```sh
git clone https://github.com/joshghent/uptime && cd uptime
pnpm install
pnpm run db:migrate:local   # create the local tables
pnpm dev                    # http://localhost:8787
```

The first command that needs one creates `status.yaml` and `.dev.vars` from the
`*.example` files. `status.yaml` is not tracked here — see below.

Before pushing:

```sh
pnpm lint   # typecheck + config lint
pnpm test   # vitest, running inside workerd against real D1
```

`pnpm dev` does not run the cron on a schedule. Trigger one by hand:

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## What this repository does and does not contain

`status.yaml` is deliberately absent. It belongs to whoever runs the page, and
keeping it out of upstream is what stops a fork's monitors from colliding with
an update. Changes to the shipped defaults go in `status.example.yaml`; CI fails
if `status.yaml` is ever committed here.

The same applies to the placeholders in `wrangler.jsonc` — `database_id` and the
commented-out `routes` entry are per-deployment and must stay generic.

## House style

- Small functions, obvious names. Boring beats clever.
- Comments explain *why*, not what. The existing ones are the reference.
- Let errors reach the one handler in `src/index.ts` rather than swallowing them.
- No new dependency without a reason that survives being said out loud.
- Nothing unindexed in the cron path. It runs 1,440 times a day against tables
  that grow all day, and `test/query-plan.test.ts` fails if a plan degrades.

## Migrations

Add a numbered file to `migrations/`, then update `LATEST_MIGRATION` in
`src/version.ts` — `test/migrations.test.ts` fails if you forget. That constant
is how a running Worker knows whether its database is up to date.

Migrations must be additive. Someone will deploy the new code minutes before
they apply the migration, and a `DROP` in that window takes their page down.

Anything an operator has to do by hand goes in the CHANGELOG under **Action
required**.

## Releasing

For maintainers:

1. Bump `version` in `package.json`.
2. Add the section to `CHANGELOG.md`, headed `## <version> — <YYYY-MM-DD>`.
3. `git tag v<version> && git push --tags`.

The release workflow re-runs the checks, refuses a tag that disagrees with
`package.json`, and publishes the CHANGELOG section as the release notes. Forks
pick it up through their own sync PR.

Upstream deploys nothing. This repository is the template; the maintainer's own
status page runs from a fork like everyone else's, which is also what keeps the
update path honest.
