import { version } from "../package.json";

/**
 * What this deployment is running, reported on `/health` and `/api/status`.
 * Comes from package.json so there is one number to bump, and the release
 * workflow refuses to publish a tag that disagrees with it.
 */
export const VERSION: string = version;

/**
 * The newest migration in `migrations/`. The Worker checks that this one has
 * been applied, because the failure it guards against is silent: a release can
 * add a migration, deploy fine, and only fall over later when the new column is
 * read. `test/migrations.test.ts` fails if this drifts from the directory.
 *
 * Checking one name rather than a count keeps a fork with its own extra
 * migrations from looking behind.
 */
export const LATEST_MIGRATION = "0002_prune_index.sql";
