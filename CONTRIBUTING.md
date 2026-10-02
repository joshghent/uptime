# Contributing

Bug reports, config-format papercuts and small focused pull requests are all
welcome. If a change is large or reshapes how the page works, open an issue
first — it is cheaper to disagree about an idea than about a diff.

## Getting set up

```sh
git clone https://github.com/joshghent/uptime && cd uptime
pnpm install
pnpm dev                    # http://localhost:8787
```

`pnpm dev` runs `dev/worker.ts`: the Worker built from `createWorker` around
`template/status.yaml`, the same way a deployment builds its own. It creates
its tables on the first request. The first command that needs one creates
`.dev.vars` from `template/.dev.vars.example`.

Before pushing:

```sh
pnpm lint            # typecheck + config lint
pnpm test            # vitest, running inside workerd against real D1
pnpm test:template   # pack the packages, start a deployment, run its check
```

`pnpm dev` does not run the cron on a schedule. Trigger one by hand:

```sh
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## How the repository is laid out

- `src/` is the package: `createWorker` and the `uptime` command. `pnpm build`
  bundles it into `dist/`, which is what npm gets.
- `migrations/` is bundled into the Worker, which applies it itself.
- `template/` is a whole deployment, copied by `npm create uptime`. Its
  `status.yaml` is also the example config this repository develops and tests
  against, so a change to the shipped defaults goes there.
- `packages/create-uptime/` is the `npm create uptime` shim.

A deployment's own repository holds only `template/`'s files, and they never
update after it is created. Anything that has to change with a release belongs
in the package, not the template.

## House style

- Small functions, obvious names. Boring beats clever.
- Comments explain *why*, not what. The existing ones are the reference.
- Let errors reach the one handler in `src/index.ts` rather than swallowing them.
- No new dependency without a reason that survives being said out loud.
- Nothing unindexed in the cron path. It runs 1,440 times a day against tables
  that grow all day, and `test/query-plan.test.ts` fails if a plan degrades.

## Migrations

Add a numbered file to `migrations/`, then add it to `MIGRATIONS` in
`src/migrate.ts` — `test/migrations.test.ts` fails if you forget. The Worker
bundles that list and applies whatever is missing on first use, so an update
that adds a migration needs nothing from the people running it.

Migrations must be additive. Isolates still running the old code keep serving
for a while after the new one has migrated, and a `DROP` in that window takes
their page down. Keep each one to plain statements separated by `;`, with no
`;` or `--` inside a string: the Worker splits them without a SQL parser.

## Changing status.yaml

Updates reach deployments without anyone editing their config, so a change to
the file's shape must not break the file they already have:

- Adding an optional key is always fine.
- Renaming, restructuring or changing the meaning of a key bumps
  `CONFIG_VERSION` in `src/config.ts` and adds an upgrader to `UPGRADES` that
  rewrites the previous version into the new one. Test it against a file in
  the old shape.
- Removing something with no automatic replacement is a major release.

Anything an operator has to do by hand goes in the CHANGELOG under **Action
required**.

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please).
Pull requests are squash-merged, and the title becomes the commit it reads, so
titles follow [Conventional Commits](https://www.conventionalcommits.org) — a
check enforces it:

| Title | Release |
|---|---|
| `fix: …` | patch |
| `feat: …` | minor |
| `feat!: …` | major |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:` | none |

Every merge to `main` updates a release pull request that bumps both packages
— `create-uptime` and its exact pin on `@joshghent/uptime` move together — and
writes `CHANGELOG.md`. Merging it tags the release, publishes the GitHub
Release, re-runs every check and publishes both packages to npm. Every
deployment's Dependabot then opens a pull request for it, and merges it if it
is not a major.

So semver is a promise about deployments: a minor or patch must work with no
one looking. Anything that needs a human is `feat!:` (or `fix!:`), with the
steps written in the pull request body after `BREAKING CHANGE:` — that text
becomes the release notes people read before they update.

Upstream deploys nothing. The maintainer's own status page is a deployment of
the package like everyone else's, which is also what keeps the update path
honest.
