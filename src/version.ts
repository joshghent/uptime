import { version } from "../package.json";
import { MIGRATIONS } from "./migrate.ts";

/**
 * What this deployment is running, reported on `/health` and `/api/status`.
 * Comes from package.json so there is one number to bump, and the release
 * workflow refuses to publish a tag that disagrees with it.
 */
export const VERSION: string = version;

/**
 * The newest migration the Worker ships. `/health` checks that this one has
 * been applied: the Worker applies it on first use, and if that failed the
 * page should say so rather than fall over later when a new column is read.
 */
export const LATEST_MIGRATION: string = MIGRATIONS[MIGRATIONS.length - 1]!.name;
